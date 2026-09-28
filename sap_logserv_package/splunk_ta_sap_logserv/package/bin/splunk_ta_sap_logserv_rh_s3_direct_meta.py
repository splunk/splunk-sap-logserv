"""
SAP LogServ TA - AWS S3 Direct cloud_provider stamp REST endpoint

    POST /services/splunk_ta_sap_logserv/s3_direct_meta   (form: name=<input name>)

The AWS S3 Direct screen creates Generic S3 inputs through the Splunk Add-on
for AWS's UCC endpoint, which has no _meta field, so the inputs it creates
cannot carry the ``_meta = cloud_provider::aws`` stamp every SQS input on the
fleet has. Measured on splunk-hf-01 in session 136:

- the add-on's native endpoint (data/inputs/aws_s3/<name>) refuses it too:
  HTTP 400 'Argument "_meta" is not supported by this handler.';
- configs/conf-inputs writes it (HTTP 200, and btool shows the line);
- the browser can reach neither: Splunk Web's /splunkd/__raw proxy only
  passes endpoints that some app exposes in web.conf.

So this endpoint writes the stamp into the stanza through configs/conf-inputs,
then disables and re-enables that one input through its native endpoint, so
the input starts again from the stanza as written instead of relying on a
running modular input to notice a conf edit. The screen calls it about a
second after the create, before the input's first scan.

It grants nothing. It accepts only the names the screen generates
(logserv_backfill_<job>_<folder-slug>_<year>), writes only the fixed value
cloud_provider::aws, and calls splunkd with the CALLER's session token, so
splunkd applies the caller's own permissions to every write. An edit of a
stanza that does not exist is refused by splunkd (404); nothing is created.
"""

import json
import logging
import os
import re
import sys
from urllib.parse import parse_qs, quote

# Persistent handlers don't get import_declare_test, so we must add
# the app's bin/ and lib/ directories to sys.path manually.
_app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _sub in ('bin', 'lib'):
    _path = os.path.join(_app_dir, _sub)
    if _path not in sys.path:
        sys.path.insert(0, _path)

from splunk.persistconn.application import PersistentServerConnectionApplication
import splunk
import splunk.rest as rest

from splunk_ta_sap_logserv_filter_utils import APP_NAME

logger = logging.getLogger(APP_NAME)

# The screen's RE_OUR_NAME (logserv_s3_direct.js), without the capture groups.
# testing/s3_direct/test_s3_direct_meta.py checks the two stay equivalent.
# Applied with fullmatch(): in Python, $ also matches before a trailing newline.
RE_OUR_NAME = re.compile(r'^logserv_backfill_[a-z0-9][a-z0-9-]{0,23}_[a-z0-9_]+_[0-9]{4}$')
META_VALUE = 'cloud_provider::aws'
CONF_EP = '/servicesNS/nobody/Splunk_TA_aws/configs/conf-inputs/'
NATIVE_EP = '/servicesNS/nobody/Splunk_TA_aws/data/inputs/aws_s3/'


class S3DirectMetaHandler(PersistentServerConnectionApplication):
    """
    ``POST /services/splunk_ta_sap_logserv/s3_direct_meta`` with ``name``
        Writes ``_meta = cloud_provider::aws`` into that Generic S3 input's
        stanza and restarts the input, as the caller. 200
        ``{"name", "stamped": true}`` on success; otherwise ``{"error"}`` with
        the status splunkd gave (401 / 403 / 404 / ...), or 502 when the stamp
        was written but the restart did not complete; 400 for a name the screen
        would not generate.
    """

    def __init__(self, command_line, command_arg):
        super().__init__()

    def handle(self, in_string):
        try:
            request = json.loads(in_string)
        except Exception:
            return self._error(400, 'Malformed request')

        method = str(request.get('method', 'GET')).upper()
        session_key = (request.get('session') or {}).get('authtoken')
        if not session_key:
            return self._error(401, 'No session key provided')
        if method != 'POST':
            return self._error(405, 'Method {} not allowed'.format(method))

        name = self._arg(request, 'name')
        if not RE_OUR_NAME.fullmatch(name):
            return self._error(400, 'name is not an input the AWS S3 Direct screen creates')

        try:
            status = self._post(CONF_EP + quote('aws_s3://' + name, safe=''), session_key,
                                {'_meta': META_VALUE})
            if status not in (200, 201):
                logger.warning('s3_direct_meta: the stamp on %s was refused (HTTP %s)', name, status)
                return self._error(status if 400 <= status < 600 else 502,
                                   'the stamp was refused (HTTP {})'.format(status))
            status = self._post(NATIVE_EP + quote(name, safe='') + '/disable', session_key)
            if status not in (200, 201):
                logger.warning('s3_direct_meta: stamped %s but could not restart it (disable: HTTP %s)',
                               name, status)
                return self._error(502, 'stamp written, but the input could not be restarted to apply '
                                        'it (HTTP {}); it applies at the next restart'.format(status))
            status = self._post(NATIVE_EP + quote(name, safe='') + '/enable', session_key)
            if status not in (200, 201):
                logger.error('s3_direct_meta: stamped %s, disabled it, and could not enable it again '
                             '(HTTP %s)', name, status)
                return self._error(502, 'stamp written, but the input could not be enabled again '
                                        '(HTTP {}) - it is DISABLED; enable it on this screen'.format(status))
        except Exception as e:
            logger.error('s3_direct_meta: stamping %s failed: %s', name, e, exc_info=True)
            return self._error(500, 'the stamp could not be written; see splunkd.log')

        logger.info('s3_direct_meta: stamped %s with _meta = %s and restarted it', name, META_VALUE)
        return self._ok({'name': name, 'stamped': True})

    @staticmethod
    def _post(path, session_key, postargs=None):
        """One POST as the caller; the status, whether splunkd answered or raised."""
        try:
            response, _content = rest.simpleRequest(
                path,
                sessionKey=session_key,
                method='POST',
                postargs=postargs or {},
                raiseAllErrors=False,
            )
            return int(response.status)
        # simpleRequest raises for these three whatever raiseAllErrors says.
        except splunk.AuthenticationFailed:
            return 401
        except splunk.AuthorizationFailed:
            return 403
        except splunk.ResourceNotFound:
            return 404

    @staticmethod
    def _arg(request, key):
        """One form or query value; the raw payload as a fallback."""
        for source in ('form', 'query'):
            for pair in request.get(source) or []:
                if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[0] == key:
                    return str(pair[1])
        payload = request.get('payload')
        if isinstance(payload, str) and payload:
            values = parse_qs(payload, keep_blank_values=True).get(key)
            if values:
                return values[0]
        return ''

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
