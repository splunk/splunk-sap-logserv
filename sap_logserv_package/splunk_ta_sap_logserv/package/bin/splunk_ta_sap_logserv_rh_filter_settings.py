"""
SAP LogServ TA - Custom REST Handler for Filter Settings

This module is referenced by globalConfig.json as the restHandlerModule for the
filter_settings Configuration tab.  It extends the standard UCC
AdminExternalHandler to:

1. Validate the submitted values before anything is saved: Include Sources and
   Exclude Sources on EVERY save (their values are written into a conf file
   whether or not filtering is on), every posted value for line breaks and
   other control characters on EVERY save, the folder patterns and Days in
   the Past when filtering is enabled, plus a dry run of the generators
2. Save filter settings to splunk_ta_sap_logserv_settings.conf (default UCC behaviour)
3. Generate index-time filter stanzas in local/transforms.conf and local/props.conf
   (folder includes / excludes, source includes / excludes, time filter) from
   the settings as saved: each posted field, and the stored value of any
   field the request did not post (a REST or CLI save may post only some)
4. Trigger a conf reload so changes take effect without restart (single-instance)
5. Check for uncovered supported log types and log warnings
6. Clear or update the system message banner from the upgrade check

The generated filter conf files use marker comments so they can be safely
regenerated without disturbing other local/ customisations.
"""

import os
import sys
import json
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
from splunktaucclib.rest_handler.error import RestError

import splunk.rest as rest
import splunk.admin as admin

from splunk_ta_sap_logserv_filter_utils import (
    APP_NAME,
    SETTINGS_CONF,
    FILTER_STANZA,
    SYSTEM_MESSAGE_NAME,
    CLOUD_PROVIDER_MARKER_START,
    CLOUD_PROVIDER_MARKER_END,
    SOURCE_FIELD_MAX_LEN,
    SOURCE_FIELD_UI_PATTERN,
    discover_supported_types,
    find_uncovered_types,
    is_pass_all_include,
    parse_comma_patterns,
    parse_source_patterns,
    validate_patterns,
    validate_source_field,
    generate_transforms_stanzas,
    generate_props_filter_lines,
    write_local_conf,
    write_local_conf_section,
    update_local_stanza,
    get_app_path,
    get_ta_version,
    is_deployment_server,
    ensure_deployment_app_synced,
    mirror_to_deployment_apps,
    ensure_serverclass,
)

# Valid cloud_provider dropdown values (must match globalConfig.json).
VALID_CLOUD_PROVIDERS = ('aws', 'azure', 'gcp', 'not_set')

# The Filters-tab fields, in form order, with their labels (for messages) and
# the value used when a save neither posts a field nor finds it stored (the
# defaults this handler has always used).
FILTER_FIELDS = (
    'filter_enabled', 'include_filters', 'exclude_filters',
    'include_sources', 'exclude_sources', 'days_in_past',
)
FILTER_FIELD_LABELS = {
    'filter_enabled': 'Enable Filtering',
    'include_filters': 'Include Filters',
    'exclude_filters': 'Exclude Filters',
    'include_sources': 'Include Sources',
    'exclude_sources': 'Exclude Sources',
    'days_in_past': 'Days in the Past',
}
FILTER_FIELD_DEFAULTS = {
    'filter_enabled': '0',
    'include_filters': '',
    'exclude_filters': '',
    'include_sources': '',
    'exclude_sources': '',
    'days_in_past': '7',
}

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
        'include_sources',
        required=False,
        encrypted=False,
        default='',
        validator=validator.AllOf(
            validator.String(min_len=0, max_len=SOURCE_FIELD_MAX_LEN),
            validator.Pattern(SOURCE_FIELD_UI_PATTERN),
        ),
    ),
    field.RestField(
        'exclude_sources',
        required=False,
        encrypted=False,
        default='',
        validator=validator.AllOf(
            validator.String(min_len=0, max_len=SOURCE_FIELD_MAX_LEN),
            validator.Pattern(SOURCE_FIELD_UI_PATTERN),
        ),
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
    2. Generates (or removes) filter stanzas - folder includes / excludes,
       source includes / excludes, time filter - in ``local/transforms.conf``
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
        is blocked and the user sees an error message in the UI.  Include
        Sources and Exclude Sources are validated on EVERY save, also with
        filtering disabled: the value is written into the settings conf
        either way (on the 403 fallback by a plain filesystem write), so a
        quote, backslash or line break must never get that far.  For the
        same reason every posted value is checked for line breaks and other
        control characters (and a trailing backslash, a conf line
        continuation) on every save.  The folder patterns and Days in the
        Past are validated when filtering is enabled, as before.

        The filter block is built from the settings as saved: each field the
        request posts, and for a field it does not post (a REST or CLI save
        may post only some) the value stored in the settings conf, which the
        save leaves unchanged.  The Filters form posts every field.

        This single handler serves BOTH configuration tabs (the UCC
        MultipleModel settings endpoint uses one handler class for all
        tabs).  The Cloud Provider tab is dispatched first via an early
        return; everything below is the Filters logic.
        """
        # --- Cloud Provider tab dispatch (additive; Filters path unchanged) ---
        if 'cloud_provider' in self.callerArgs.data:
            return self._handle_cloud_provider_edit(confInfo)

        # Validate before saving: the source fields as posted (grammar and
        # conf safety), then every posted value (conf safety).
        include_sources_val = self._posted('include_sources')
        exclude_sources_val = self._posted('exclude_sources')

        errors = self._validate_source_inputs(include_sources_val, exclude_sources_val)
        if errors:
            raise admin.ArgValidationException(errors)

        errors = self._validate_posted_values()
        if errors:
            raise admin.ArgValidationException(errors)

        # The settings the filter block is generated from (posted, else stored)
        settings = self._effective_filter_settings()
        filter_enabled = settings['filter_enabled'] == '1'
        include_val = settings['include_filters']

        if filter_enabled:
            errors = self._validate_filter_inputs(include_val, settings)
            if errors:
                raise admin.ArgValidationException(errors)

        # Perform the default save (writes to settings conf)
        self._safe_super_handle_edit(confInfo)

        # Generate from the values as saved
        try:
            exclude_str = settings['exclude_filters']
            days_in_past = settings['days_in_past']

            include_patterns = parse_comma_patterns(include_val)
            exclude_patterns = parse_comma_patterns(exclude_str)
            include_sources = parse_source_patterns(settings['include_sources'])
            exclude_sources = parse_source_patterns(settings['exclude_sources'])

            logger.info(
                f'Filter settings saved: enabled={filter_enabled}, '
                f'include={include_patterns}, exclude={exclude_patterns}, '
                f'include_sources={include_sources}, '
                f'exclude_sources={exclude_sources}, '
                f'days_in_past={days_in_past}'
            )

            # Generate filter configurations
            self._generate_filter_configs(
                filter_enabled, include_patterns, exclude_patterns, days_in_past,
                include_sources=include_sources,
                exclude_sources=exclude_sources,
            )

            # Check for uncovered types
            self._check_uncovered_types(filter_enabled, include_patterns)

        except admin.ArgValidationException:
            raise  # Re-raise validation errors
        except Exception as e:
            logger.error(f'Error generating filter configs: {e}', exc_info=True)

    # -----------------------------------------------------------------
    # Settings persistence (with Splunk Cloud Victoria fallback)
    # -----------------------------------------------------------------

    def _safe_super_handle_edit(self, confInfo):
        """Run splunktaucclib's default settings-conf persist; on a 403,
        fall back to a filesystem persist.

        On Splunk Cloud Victoria, sc_subadmin (the customer's effective top
        admin role) lacks ``admin_all_objects``, which splunkd's REST
        framework requires for ``configs/conf-*`` writes. splunktaucclib's
        ``AdminExternalHandler.handleEdit`` does exactly such a REST write
        and raises ``RestError[403]`` ("This operation is forbidden"),
        aborting the save before any of our config generation runs. We catch
        that and persist the submitted field values straight to
        ``local/<settings>.conf`` via the filesystem instead — the handler
        process writes files without going through the REST capability gate.
        The functional config (``transforms.conf``) is likewise written via
        the filesystem downstream, so the whole save then completes. The
        normal path (Splunk Enterprise, or any role with admin_all_objects)
        is unchanged.
        """
        try:
            AdminExternalHandler.handleEdit(self, confInfo)
        except RestError as e:
            msg = str(e)
            if '403' in msg or 'forbidden' in msg.lower():
                logger.warning(
                    'splunktaucclib settings persist returned 403 (Splunk '
                    'Cloud Victoria sc_subadmin without admin_all_objects); '
                    'falling back to a filesystem persist. Detail: %s', e
                )
                self._persist_settings_filesystem(confInfo)
            else:
                raise

    def _persist_settings_filesystem(self, confInfo):
        """Filesystem fallback persist of the current tab's settings stanza.

        Writes every submitted field into the settings conf stanza on disk
        and populates ``confInfo`` so the UI reflects the saved values. Used
        only when the REST persist is forbidden (see
        ``_safe_super_handle_edit``).
        """
        stanza = getattr(self.callerArgs, 'id', None)
        if not stanza:
            stanza = ('cloud_provider_settings'
                      if 'cloud_provider' in self.callerArgs.data
                      else 'filter_settings')

        values = {key: self._get_arg(key, '') for key in self.callerArgs.data}

        update_local_stanza(get_app_path(), f'{APP_NAME}_settings', stanza, values)

        for k, v in values.items():
            confInfo[stanza][k] = v

        # Best-effort conf reload so the REST layer sees the on-disk change.
        try:
            rest.simpleRequest(
                f'/servicesNS/nobody/{APP_NAME}/configs/'
                f'conf-{APP_NAME}_settings/_reload',
                sessionKey=self.getSessionKey(),
                method='POST',
            )
        except Exception:
            pass

        logger.info(
            'Settings stanza [%s] persisted via filesystem fallback.', stanza
        )

    # -----------------------------------------------------------------
    # Cloud Provider tab
    # -----------------------------------------------------------------

    def _handle_cloud_provider_edit(self, confInfo):
        """
        Handle a save from the Cloud Provider configuration tab.

        Persists the dropdown value (default UCC save), then writes (or
        removes) a ``local/transforms.conf`` override of the
        ``[logserv_set_cloud_provider]`` stanza inside the CLOUD_PROVIDER
        marker block.  When a provider is selected, the override makes the
        otherwise no-op stamp transform stamp ``cloud_provider::<value>``
        on every routed event.  "Not set" removes the override, reverting
        to the no-op shipped in default/transforms.conf.

        The props.conf reference (TRANSFORMS-51-cloud_provider) is static
        in default/ and never touched here — so there is no interaction
        with the Filters tab's local/props.conf block.
        """
        # Normalize + validate the dropdown value
        cloud_provider = self._get_arg('cloud_provider', 'not_set').strip().lower()
        if cloud_provider not in VALID_CLOUD_PROVIDERS:
            raise admin.ArgValidationException(
                f'cloud_provider must be one of: {", ".join(VALID_CLOUD_PROVIDERS)}'
            )

        # Perform the default save (writes to [cloud_provider_settings] stanza)
        self._safe_super_handle_edit(confInfo)

        try:
            logger.info(f'Cloud Provider setting saved: cloud_provider={cloud_provider}')
            self._generate_cloud_provider_config(cloud_provider)
        except Exception as e:
            logger.error(f'Error generating cloud_provider config: {e}', exc_info=True)

    def _generate_cloud_provider_config(self, cloud_provider):
        """
        Write or clear the cloud_provider stamp override in local/transforms.conf.

        On a deployment server the change is also mirrored to
        deployment-apps/ (via the shared filter mirroring helper) so it is
        staged for the next Deploy to Forwarders push.
        """
        app_path = get_app_path()

        if cloud_provider in ('aws', 'azure', 'gcp'):
            content = (
                '[logserv_set_cloud_provider]\n'
                'REGEX = .\n'
                f'FORMAT = cloud_provider::{cloud_provider}\n'
                'WRITE_META = true\n'
            )
            write_local_conf_section(
                app_path, 'transforms', content,
                CLOUD_PROVIDER_MARKER_START, CLOUD_PROVIDER_MARKER_END,
            )
            logger.info(
                f'Generated cloud_provider override: stamping '
                f'cloud_provider={cloud_provider} on all sap_logserv_logs events'
            )
        else:  # not_set
            write_local_conf_section(
                app_path, 'transforms', '',
                CLOUD_PROVIDER_MARKER_START, CLOUD_PROVIDER_MARKER_END,
            )
            logger.info(
                'cloud_provider set to "not_set" — removed override; '
                'no Data-TA cloud_provider stamp will be applied'
            )

        # Reuse the filter handler's deployment-server mirroring + conf reload
        self._mirror_if_deployment_server(app_path)
        self._reload_confs()

    def _validate_source_inputs(self, include_sources_val, exclude_sources_val):
        """
        Validate Include Sources and Exclude Sources (grammar and conf
        safety).  Runs on every Filters save, whether filtering is enabled
        or not, on the values the request posts (``None`` = not posted: the
        stored value is not rewritten; with filtering enabled the generators'
        dry run re-validates it).

        Returns:
            str or None: Error message naming the field and the entry if
            validation fails, None if valid.
        """
        for value, field_name in (
            (include_sources_val, 'Include Sources'),
            (exclude_sources_val, 'Exclude Sources'),
        ):
            is_valid, error = validate_source_field(value, field_name)
            if not is_valid:
                return error
        return None

    def _validate_filter_inputs(self, include_str, settings):
        """
        Validate include and exclude filter patterns, Days in the Past, the
        Include Sources / Include Filters combination, and finally dry-run
        both generators so that any value they would refuse (for example an
        entry whose rule would be too long, or an invalid stored value of a
        field the request did not post) blocks the save instead of failing
        after it.  Called only when filtering is enabled.

        Args:
            include_str: The Include Filters value.
            settings: The effective Filters settings
                (:meth:`_effective_filter_settings`).

        Returns:
            str or None: Error message if validation fails, None if valid.
        """
        exclude_str = settings['exclude_filters']
        days_str = settings['days_in_past']

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
            except (ValueError, TypeError, OverflowError):
                return (
                    'Days in the Past must be a number between 0 and 3650.'
                )

        # Include Sources only adds events back through the include gate; with
        # a pass-all Include Filters there is no gate, so it would do nothing.
        include_sources = parse_source_patterns(settings['include_sources'])
        exclude_sources = parse_source_patterns(settings['exclude_sources'])
        if include_sources and is_pass_all_include(include_patterns):
            return (
                'Include Sources has no effect while Include Filters keeps every '
                'log type (it contains */* or *): everything is already kept. '
                'Narrow Include Filters (e.g., linux/*, hana/*) or clear '
                'Include Sources.'
            )

        # Dry run: the generators re-validate every entry and refuse what they
        # cannot turn into a REGEX - refuse it here, before anything is saved.
        try:
            generate_transforms_stanzas(
                include_patterns,
                parse_comma_patterns(exclude_str),
                days_str,
                include_sources=include_sources,
                exclude_sources=exclude_sources,
            )
        except ValueError as e:
            return str(e)

        return None

    def _posted(self, name):
        """
        The value this request posts for ``name``, as the settings save
        stores it (an emptied field is ``''``: splunktaucclib saves
        ``value[0]`` or ``''``), or ``None`` when the request does not post
        the field at all - the save then leaves its stored value unchanged.
        """
        if name not in self.callerArgs.data:
            return None
        val = self.callerArgs.data.get(name)
        if isinstance(val, (list, tuple)):
            val = val[0] if val else None
        return val if val else ''

    def _validate_posted_values(self):
        """
        Conf safety of every value the request posts: each one is written
        into the settings conf (on the 403 fallback by a plain filesystem
        write, see :meth:`_persist_settings_filesystem`), so none may carry
        a line break or any other control character, or end with a
        backslash (a conf line continuation).  Runs on every Filters save,
        whether filtering is enabled or not.

        Returns:
            str or None: Error message naming the field, None if valid.
        """
        names = list(FILTER_FIELDS) + sorted(
            name for name in self.callerArgs.data if name not in FILTER_FIELDS
        )
        for name in names:
            value = self._posted(name)
            if value is None:
                continue
            text = value if isinstance(value, str) else str(value)
            label = FILTER_FIELD_LABELS.get(name, name)
            for ch in text:
                if ord(ch) < 32 or ord(ch) == 127:
                    return (
                        f'{label}: the value contains a control character '
                        f'({ascii(ch)[1:-1]}). Line breaks, tabs and other '
                        f'control characters are not allowed.'
                    )
            if text.endswith('\\'):
                return f'{label}: the value must not end with a backslash.'
        return None

    def _stored_filter_settings(self):
        """
        The stored ``[filter_settings]`` values (field -> text), read through
        splunkd as the daily refresh reads them.

        Returns:
            dict or None: ``{}`` when the stanza does not exist yet, ``None``
            when it cannot be read.
        """
        session_key = self.getSessionKey()
        if not session_key:
            return None
        try:
            response, content = rest.simpleRequest(
                f'/servicesNS/nobody/{APP_NAME}/configs/conf-{SETTINGS_CONF}/{FILTER_STANZA}',
                sessionKey=session_key,
                getargs={'output_mode': 'json'},
                method='GET',
            )
        except Exception as e:
            if getattr(e, 'statusCode', None) == 404:
                return {}
            logger.warning(f'Could not read the stored filter settings: {e}')
            return None
        if response.status == 404:
            return {}
        if response.status != 200:
            logger.warning(
                f'Could not read the stored filter settings: HTTP {response.status}'
            )
            return None
        try:
            entries = json.loads(content).get('entry', [])
            stored = (entries[0].get('content') or {}) if entries else {}
        except Exception as e:
            logger.warning(f'Could not parse the stored filter settings: {e}')
            return None
        out = {}
        for name in FILTER_FIELDS:
            if name not in stored:
                continue
            value = stored[name]
            if isinstance(value, bool):
                value = '1' if value else '0'
            out[name] = '' if value is None else str(value)
        return out

    def _effective_filter_settings(self):
        """
        The Filters settings as they stand after this save: each field the
        request posts (:meth:`_posted`), else its stored value
        (:meth:`_stored_filter_settings`, read only when a field is missing
        - the Filters form posts every field), else FILTER_FIELD_DEFAULTS.

        Returns:
            dict: field -> text, for every name in FILTER_FIELDS.
        """
        posted = dict((name, self._posted(name)) for name in FILTER_FIELDS)
        missing = [name for name in FILTER_FIELDS if posted[name] is None]
        stored = {}
        if missing:
            stored = self._stored_filter_settings()
            if stored is None:
                logger.warning(
                    f'This Filters save does not post {", ".join(missing)} and '
                    f'the stored values could not be read; the filter rules '
                    f'are generated with their defaults instead.'
                )
                stored = {}
        settings = {}
        for name in FILTER_FIELDS:
            value = posted[name]
            if value is None:
                value = stored.get(name, FILTER_FIELD_DEFAULTS[name])
            settings[name] = value
        return settings

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
        self, filter_enabled, include_patterns, exclude_patterns, days_in_past,
        include_sources=None, exclude_sources=None,
    ):
        """
        Generate (or clear) the filter transforms and props in local/.

        Both generators run before either file is written, so a refused
        value (ValueError) leaves the previous block in place.

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

        # transforms.conf (include gate + source includes + time filter +
        # folder and source excludes) and props.conf (TRANSFORMS-00-filter)
        transforms_content = generate_transforms_stanzas(
            include_patterns, exclude_patterns, days_in_past,
            include_sources=include_sources,
            exclude_sources=exclude_sources,
        )
        props_content = generate_props_filter_lines(
            include_patterns, exclude_patterns, days_in_past, filter_enabled,
            include_sources=include_sources,
            exclude_sources=exclude_sources,
        )
        write_local_conf(app_path, 'transforms', transforms_content)
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

        # If filtering is disabled or include is pass-all, clear any warning
        if not filter_enabled or is_pass_all_include(include_patterns):
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
#
# IMPORTANT: this module is NEVER run as __main__ — the restmap handlerfile is
# the UCC-generated splunk_ta_sap_logserv_rh_settings.py, which IMPORTS
# FilterSettingsHandler from here and registers it against a MultipleModel
# covering BOTH configuration tabs (filter_settings + cloud_provider_settings).
#
# The module-level `endpoint = SingleModel(..., config_name='filter_settings')`
# above only knows the Filters model. If this handle() ran at import time it
# would dispatch the request against that filter-only SingleModel BEFORE the
# generated rh_settings.py's MultipleModel runs — causing
# "Argument cloud_provider is not supported by this handler" on Cloud Provider
# tab saves. Guarding with __main__ makes this a no-op on import, so the
# generated MultipleModel (which knows both tabs) is the sole dispatcher.
if __name__ == '__main__':
    admin_external.handle(
        endpoint,
        handler=FilterSettingsHandler,
    )
