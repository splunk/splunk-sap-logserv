"""
SAP LogServ TA - Custom REST Handler for Filter Settings

This module is referenced by globalConfig.json as the restHandlerModule for the
filter_settings Configuration tab.  It extends the standard UCC
AdminExternalHandler to:

1. Save filter settings to splunk_ta_sap_logserv_settings.conf (default UCC behaviour)
2. Generate index-time filter stanzas in local/transforms.conf and local/props.conf
3. Trigger a conf reload so changes take effect without restart (single-instance)
4. Check for uncovered supported log types and log warnings
5. Clear or update the system message banner from the upgrade check

The generated filter conf files use marker comments so they can be safely
regenerated without disturbing other local/ customisations.
"""

import os
import sys
import logging

# UCC import path setup — must come before any splunktaucclib imports
import import_declare_test  # noqa: F401

from splunktaucclib.rest_handler.endpoint import (
    field,
    validator,
    RestModel,
    SingleModel,
)
from splunktaucclib.rest_handler import admin_external
from splunktaucclib.rest_handler.admin_external import AdminExternalHandler

import splunk.rest as rest
import splunk.admin as admin

from splunk_ta_sap_logserv_filter_utils import (
    APP_NAME,
    SYSTEM_MESSAGE_NAME,
    discover_supported_types,
    find_uncovered_types,
    parse_comma_patterns,
    validate_patterns,
    generate_transforms_stanzas,
    generate_props_filter_lines,
    write_local_conf,
    get_app_path,
    get_ta_version,
    is_deployment_server,
    ensure_deployment_app_synced,
    mirror_to_deployment_apps,
    ensure_serverclass,
)

logger = logging.getLogger(APP_NAME)


# ---------------------------------------------------------------------------
# UCC endpoint definition
# ---------------------------------------------------------------------------
# These fields must match the entity definitions in globalConfig.json for
# the filter_settings tab.

fields = [
    field.RestField(
        'filter_enabled',
        required=False,
        encrypted=False,
        default='0',
    ),
    field.RestField(
        'include_filters',
        required=False,
        encrypted=False,
        default='*/*',
        validator=validator.String(min_len=0, max_len=4096),
    ),
    field.RestField(
        'exclude_filters',
        required=False,
        encrypted=False,
        default='',
        validator=validator.String(min_len=0, max_len=4096),
    ),
    field.RestField(
        'days_in_past',
        required=False,
        encrypted=False,
        default='7',
        validator=validator.Number(min_val=0, max_val=3650),
    ),
]

model = RestModel(fields, name=None)

endpoint = SingleModel(
    f'{APP_NAME}_settings',
    model,
    config_name='filter_settings',
)


# ---------------------------------------------------------------------------
# Custom handler
# ---------------------------------------------------------------------------

class FilterSettingsHandler(AdminExternalHandler):
    """
    Custom REST handler that extends the standard UCC settings handler.

    On ``handleEdit`` (settings save), after the default save completes,
    this handler:

    1. Reads the saved filter settings.
    2. Generates (or removes) filter stanzas in ``local/transforms.conf``
       and ``local/props.conf``.
    3. Triggers a conf reload via the Splunk REST API.
    4. Compares the user's include patterns against the annotated supported
       types and logs warnings for any uncovered types.
    5. Updates or clears the system message banner.
    """

    def handleEdit(self, confInfo):
        """
        Intercept the save action to validate and generate filter configurations.

        Validation runs before the save.  If any pattern is invalid, the save
        is blocked and the user sees an error message in the UI.
        """
        # Validate patterns before saving
        filter_enabled = self._get_arg('filter_enabled', '0') == '1'
        include_val = self._get_arg('include_filters', '')
        if filter_enabled:
            errors = self._validate_filter_inputs(include_val)
            if errors:
                raise admin.ArgValidationException(errors)

        # Perform the default save (writes to settings conf)
        AdminExternalHandler.handleEdit(self, confInfo)

        # Read the values that were just saved
        try:
            exclude_str = self._get_arg('exclude_filters', '')
            days_in_past = self._get_arg('days_in_past', '7')

            include_patterns = parse_comma_patterns(include_val)
            exclude_patterns = parse_comma_patterns(exclude_str)

            logger.info(
                f'Filter settings saved: enabled={filter_enabled}, '
                f'include={include_patterns}, exclude={exclude_patterns}, '
                f'days_in_past={days_in_past}'
            )

            # Generate filter configurations
            self._generate_filter_configs(
                filter_enabled, include_patterns, exclude_patterns, days_in_past
            )

            # Check for uncovered types
            self._check_uncovered_types(filter_enabled, include_patterns)

        except admin.ArgValidationException:
            raise  # Re-raise validation errors
        except Exception as e:
            logger.error(f'Error generating filter configs: {e}', exc_info=True)

    def _validate_filter_inputs(self, include_str):
        """
        Validate include and exclude filter patterns.

        Returns:
            str or None: Error message if validation fails, None if valid.
        """
        exclude_str = self._get_arg('exclude_filters', '')
        days_str = self._get_arg('days_in_past', '0')

        # Validate include patterns
        include_patterns = parse_comma_patterns(include_str)
        if not include_patterns:
            return (
                'Include Filters cannot be empty. Use */* to include all '
                'log types, or specify patterns like linux/*, hana/hanaaudit.'
            )

        is_valid, error = validate_patterns(include_patterns, 'Include Filters')
        if not is_valid:
            return error

        # Validate exclude patterns (empty is OK)
        if exclude_str and exclude_str.strip():
            exclude_patterns = parse_comma_patterns(exclude_str)
            if not exclude_patterns:
                return (
                    'Exclude Filters contains only commas or whitespace. '
                    'Either leave the field empty or specify valid patterns '
                    '(e.g., linux/cron, linux/kern).'
                )
            is_valid, error = validate_patterns(exclude_patterns, 'Exclude Filters')
            if not is_valid:
                return error

        # Validate days_in_past is a whole number
        if days_str:
            try:
                days_val = float(days_str)
                if days_val != int(days_val):
                    return (
                        'Days in the Past must be a whole number '
                        '(e.g., 7, 30, 365). Decimal values are not allowed.'
                    )
            except (ValueError, TypeError):
                return (
                    'Days in the Past must be a number between 0 and 3650.'
                )

        return None

    def _get_arg(self, name, default=''):
        """
        Retrieve a submitted argument from the REST request payload.
        """
        # In UCC, callerArgs.data contains lists of values.
        # Empty fields arrive as [None], so we treat None as missing.
        val = self.callerArgs.data.get(name)
        if val:
            result = val[0] if isinstance(val, list) else val
            return result if result is not None else default
        return default

    def _generate_filter_configs(
        self, filter_enabled, include_patterns, exclude_patterns, days_in_past
    ):
        """
        Generate (or clear) the filter transforms and props in local/.

        When running on a deployment server, the generated configs are also
        mirrored to ``etc/deployment-apps/`` so they are staged for the next
        deployment push to forwarder clients.
        """
        app_path = get_app_path()

        if not filter_enabled:
            # Clear any previously generated filter configs
            write_local_conf(app_path, 'transforms', '')
            write_local_conf(app_path, 'props', '')
            logger.info('Filtering disabled — cleared local filter configs')
            self._mirror_if_deployment_server(app_path)
            self._reload_confs()
            return

        # Generate transforms.conf (include gate + exclude filter + time filter)
        transforms_content = generate_transforms_stanzas(
            include_patterns, exclude_patterns, days_in_past
        )
        write_local_conf(app_path, 'transforms', transforms_content)

        # Generate props.conf (TRANSFORMS-00-filter reference)
        props_content = generate_props_filter_lines(
            include_patterns, exclude_patterns, days_in_past, filter_enabled
        )
        write_local_conf(app_path, 'props', props_content)

        logger.info('Generated local filter configs in local/transforms.conf and local/props.conf')
        self._mirror_if_deployment_server(app_path)
        self._reload_confs()

    def _mirror_if_deployment_server(self, app_path):
        """
        If running on a deployment server, ensure the full TA package is
        synced to deployment-apps/ (initial copy or version upgrade),
        ensure a server class exists for forwarder distribution, then
        copy local/ filter configs so they are included in the next push
        to forwarders.
        """
        session_key = self.getSessionKey()
        if not session_key:
            return

        if is_deployment_server(session_key):
            # Ensure full app is present and version-matched
            synced, sync_msg = ensure_deployment_app_synced(app_path)
            if synced:
                logger.info(
                    f'Deployment server — {sync_msg} '
                    f'Use "Deploy to Forwarders" to distribute.'
                )

            # Ensure server class exists (created disabled)
            try:
                created, sc_msg = ensure_serverclass(session_key)
                if created:
                    logger.info(f'Deployment server — {sc_msg}')
            except Exception as e:
                logger.warning(f'Could not ensure server class: {e}')

            # Mirror filter configs (transforms.conf, props.conf)
            result = mirror_to_deployment_apps(app_path)
            if result:
                logger.info(
                    f'Deployment server detected — filter configs staged to '
                    f'{result}. Use "Deploy to Forwarders" to distribute '
                    f'changes to heavy forwarders.'
                )

    def _reload_confs(self):
        """
        Trigger a conf file reload via the Splunk REST API.

        This allows changes to take effect on a single-instance deployment
        without requiring a restart.  In distributed deployments, the admin
        must deploy the local/ configs to the parsing tier separately.

        We reload both the conf layer (configs/conf-*) and the data
        transforms layer (data/transforms/extractions) to ensure the
        index-time parsing pipeline picks up the new definitions.
        """
        session_key = self.getSessionKey()
        if not session_key:
            logger.warning('No session key available; skipping conf reload')
            return

        # Reload conf layer
        for conf_type in ('transforms', 'props'):
            try:
                reload_url = (
                    f'/servicesNS/nobody/{APP_NAME}'
                    f'/configs/conf-{conf_type}/_reload'
                )
                response, content = rest.simpleRequest(
                    reload_url,
                    sessionKey=session_key,
                    method='GET',
                )
                logger.info(f'Reloaded {conf_type}.conf (status={response.status})')
            except Exception as e:
                logger.warning(
                    f'Could not reload {conf_type}.conf: {e}. '
                    f'A Splunk restart may be required for changes to take effect.'
                )

        # Reload the data transforms layer to refresh the index-time pipeline
        for endpoint in (
            '/services/data/transforms/extractions/_reload',
            '/services/data/props/extractions/_reload',
        ):
            try:
                response, content = rest.simpleRequest(
                    endpoint,
                    sessionKey=session_key,
                    method='GET',
                )
                logger.info(f'Reloaded {endpoint} (status={response.status})')
            except Exception as e:
                logger.debug(f'Could not reload {endpoint}: {e}')

    def _check_uncovered_types(self, filter_enabled, include_patterns):
        """
        Compare include patterns against annotated supported types.

        If uncovered types are found, log a warning and update the system
        message banner.  If everything is covered, clear any existing banner.
        """
        session_key = self.getSessionKey()
        if not session_key:
            return

        # If filtering is disabled or include is wildcard, clear any warning
        if not filter_enabled or not include_patterns or include_patterns == ['*/*']:
            self._clear_system_message(session_key)
            return

        app_path = get_app_path()
        supported = discover_supported_types(app_path)
        uncovered = find_uncovered_types(supported, include_patterns)

        if uncovered:
            version = get_ta_version(app_path)
            type_list = ', '.join(sorted(uncovered))
            logger.warning(
                f'Include patterns do not cover {len(uncovered)} supported '
                f'log type(s): {type_list}. These types will be dropped '
                f'before indexing.'
            )
            self._create_system_message(session_key, uncovered, version)
        else:
            self._clear_system_message(session_key)

    def _create_system_message(self, session_key, uncovered, version):
        """
        Create a persistent system message banner visible across all Splunk Web pages.
        """
        type_list = ', '.join(sorted(uncovered))
        message = (
            f'SAP LogServ TA v{version}: Your include filter patterns '
            f'do not cover {len(uncovered)} supported log type(s): '
            f'{type_list}. Open Configuration → Filters in the SAP LogServ '
            f'TA to update your include patterns, or these log types will '
            f'be dropped before indexing.'
        )

        # Remove previous message first
        self._clear_system_message(session_key)

        try:
            rest.simpleRequest(
                '/services/messages',
                sessionKey=session_key,
                method='POST',
                postargs={
                    'name': SYSTEM_MESSAGE_NAME,
                    'value': message,
                    'severity': 'warn',
                },
            )
            logger.info(f'Created system message for {len(uncovered)} uncovered type(s)')
        except Exception as e:
            logger.warning(f'Could not create system message: {e}')

    def _clear_system_message(self, session_key):
        """
        Remove any previously created system message banner.
        """
        try:
            rest.simpleRequest(
                f'/services/messages/{SYSTEM_MESSAGE_NAME}',
                sessionKey=session_key,
                method='DELETE',
            )
        except Exception:
            # Message may not exist — this is fine
            pass


# ---------------------------------------------------------------------------
# UCC handler registration
# ---------------------------------------------------------------------------

admin_external.handle(
    endpoint,
    handler=FilterSettingsHandler,
)
