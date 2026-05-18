"""
SAP LogServ TA - Deployment Server Push REST Endpoint

Custom REST endpoint that provides:
- GET:  Returns deployment server status (used by the UCC hook to decide
        whether to show the "Deploy to Forwarders" button).
- POST: Triggers a deployment server reload for this app via the Splunk
        REST API to distribute filter configurations to heavy forwarders.

This endpoint is registered in ``restmap.conf`` and requires the
``edit_deployment_server`` capability.
"""

import json
import logging
import os
import sys

# Persistent handlers don't get import_declare_test, so we must add
# the app's bin/ and lib/ directories to sys.path manually.
_app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _sub in ('bin', 'lib'):
    _path = os.path.join(_app_dir, _sub)
    if _path not in sys.path:
        sys.path.insert(0, _path)

from splunk.persistconn.application import PersistentServerConnectionApplication
import splunk.rest as rest

from splunk_ta_sap_logserv_filter_utils import (
    APP_NAME,
    SERVERCLASS_NAME,
    is_deployment_server,
)

logger = logging.getLogger(APP_NAME)


class DeploymentPushHandler(PersistentServerConnectionApplication):
    """
    REST handler for deployment server push operations.

    ``GET /services/splunk_ta_sap_logserv/deployment_push``
        Returns JSON with ``is_deployment_server`` boolean.

    ``POST /services/splunk_ta_sap_logserv/deployment_push``
        Triggers a deployment server reload for this app and returns
        the result.
    """

    def __init__(self, command_line, command_arg):
        super().__init__()

    def handle(self, in_string):
        """Route to GET or POST handler based on method."""
        try:
            request = json.loads(in_string)
            method = request.get('method', 'GET').upper()
            session_key = request.get('session', {}).get('authtoken')

            if not session_key:
                return self._error(401, 'No session key provided')

            if method == 'GET':
                return self._handle_get(session_key)
            elif method == 'POST':
                return self._handle_post(session_key)
            else:
                return self._error(405, f'Method {method} not allowed')

        except Exception as e:
            logger.error(f'DeploymentPushHandler error: {e}', exc_info=True)
            return self._error(500, str(e))

    def _handle_get(self, session_key):
        """
        Return deployment server status and server class info.

        The UCC hook calls this on page load to decide whether to render
        the "Deploy to Forwarders" button and show server class guidance.
        """
        ds = is_deployment_server(session_key)
        result = {'is_deployment_server': ds}

        if ds:
            result['serverclass'] = self._get_serverclass_status(session_key)

        return self._ok(result)

    def _get_serverclass_status(self, session_key):
        """
        Check the status of the SAP LogServ server class.

        Returns:
            dict: ``{'exists': bool, 'disabled': bool, 'has_clients': bool}``
        """
        try:
            response, content = rest.simpleRequest(
                f'/services/deployment/server/serverclasses/{SERVERCLASS_NAME}',
                sessionKey=session_key,
                method='GET',
                getargs={'output_mode': 'json'},
            )
            if response.status == 200:
                data = json.loads(content)
                entry = data.get('entry', [{}])[0].get('content', {})
                disabled = entry.get('disabled', 'false')
                # Check for any client targeting (whitelist/machineTypesFilter)
                whitelist = entry.get('whitelist.0', '')
                machine_filter = entry.get('machineTypesFilter', '')
                has_clients = bool(whitelist or machine_filter)
                return {
                    'exists': True,
                    'disabled': str(disabled).lower() in ('true', '1'),
                    'has_clients': has_clients,
                }
        except Exception:
            pass

        return {'exists': False, 'disabled': True, 'has_clients': False}

    def _handle_post(self, session_key):
        """
        Trigger a deployment server reload.

        Calls ``POST /services/deployment/server/config/_reload``
        to reload all server class configurations and distribute the
        current app content (including staged filter configs in
        ``deployment-apps/``) to all deployment clients.
        """
        if not is_deployment_server(session_key):
            return self._error(400, 'This instance is not a deployment server')

        try:
            endpoint = '/services/deployment/server/config/_reload'
            response, content = rest.simpleRequest(
                endpoint,
                sessionKey=session_key,
                method='POST',
            )

            if response.status in (200, 201):
                logger.info(
                    f'Deployment reload triggered successfully via {endpoint}'
                )
                return self._ok({
                    'success': True,
                    'message': (
                        'Deployment reload initiated. Filter configurations '
                        'will be distributed to heavy forwarders on their '
                        'next phone-home interval. Monitor the Forwarder '
                        'Management page for deployment status.'
                    ),
                })
            else:
                error_msg = f'HTTP {response.status}: {content}'
                logger.error(f'Deployment reload failed: {error_msg}')
                return self._error(500, f'Deployment reload failed: {error_msg}')

        except Exception as e:
            logger.error(f'Failed to trigger deployment reload: {e}')
            return self._error(500, f'Deployment reload failed: {e}')

    @staticmethod
    def _ok(payload):
        """Return a 200 JSON response."""
        return {
            'status': 200,
            'payload': json.dumps(payload),
            'headers': {'Content-Type': 'application/json'},
        }

    @staticmethod
    def _error(status, message):
        """Return an error JSON response."""
        return {
            'status': status,
            'payload': json.dumps({'error': message}),
            'headers': {'Content-Type': 'application/json'},
        }
