"""
gcp_rest.py - Minimal Pub/Sub + GCS REST clients (urllib, Bearer auth).

The GCP twin of azure_storage_rest.py. Same posture: stdlib urllib only, a
small retry loop for transient failures (429/5xx/network), typed errors for
everything else. Tokens come from gcp_auth.TokenMinter (cached); one token
covers both services via a combined scope string.
"""

from __future__ import annotations

import json
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request

PUBSUB_BASE = "https://pubsub.googleapis.com/v1"
GCS_BASE = "https://storage.googleapis.com/storage/v1"
# One token for both data planes this input touches.
SCOPES = (
    "https://www.googleapis.com/auth/pubsub "
    "https://www.googleapis.com/auth/devstorage.read_only"
)

REQUEST_TIMEOUT_SEC = 60
RETRIES = 3
RETRY_SLEEP_BASE_SEC = 0.5
RETRYABLE_STATUS = (429, 500, 502, 503, 504)


class GcpRestError(Exception):
    """REST failure after retries. `.status` is the HTTP code (0 = network)."""

    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


class _RestBase:
    def __init__(self, logger, minter, verify_ssl=True):
        self._logger = logger
        self._minter = minter
        self._ctx = ssl.create_default_context()
        if not verify_ssl:
            self._ctx.check_hostname = False
            self._ctx.verify_mode = ssl.CERT_NONE

    def _request(self, method, url, json_body=None):
        """Issue one authed request with retries. Returns response bytes."""
        data = None
        headers = {"Accept": "application/json"}
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        last_err = "unknown"
        last_status = 0
        for attempt in range(RETRIES):
            headers["Authorization"] = "Bearer " + self._minter.get_token(
                SCOPES
            )
            req = urllib.request.Request(
                url, data=data, headers=dict(headers), method=method,
            )
            try:
                with urllib.request.urlopen(
                    req, timeout=REQUEST_TIMEOUT_SEC, context=self._ctx,
                ) as resp:
                    return resp.read()
            except urllib.error.HTTPError as exc:
                body = b""
                try:
                    body = exc.read()
                except Exception:  # noqa: BLE001
                    pass
                last_status = exc.code
                last_err = "HTTP %s: %s" % (
                    exc.code, body.decode("utf-8", "replace")[:300],
                )
                if exc.code not in RETRYABLE_STATUS:
                    raise GcpRestError(last_err, status=exc.code)
            except (urllib.error.URLError, OSError) as exc:
                last_status = 0
                last_err = "network error: %s" % exc
            if attempt < RETRIES - 1:
                time.sleep(RETRY_SLEEP_BASE_SEC * (2 ** attempt))
        raise GcpRestError(
            "%s %s failed after %d attempts: %s"
            % (method, url.split("?", 1)[0], RETRIES, last_err),
            status=last_status,
        )


class PubSubClient(_RestBase):
    """subscriptions:pull / :acknowledge on an existing subscription."""

    def pull(self, project, subscription, max_messages,
             return_immediately=True):
        url = "%s/projects/%s/subscriptions/%s:pull" % (
            PUBSUB_BASE,
            urllib.parse.quote(project, safe=""),
            urllib.parse.quote(subscription, safe=""),
        )
        body = {"maxMessages": int(max_messages)}
        if return_immediately:
            # Deprecated by Google for streaming consumers, but exactly right
            # for a periodic drain loop: an empty queue returns instantly
            # instead of long-polling into the firing budget. If the field is
            # ever dropped server-side it is simply ignored (falls back to
            # long-poll, still correct).
            body["returnImmediately"] = True
        raw = self._request("POST", url, body)
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError as exc:
            raise GcpRestError("pull returned non-JSON: %s" % exc)
        return payload.get("receivedMessages") or []

    def acknowledge(self, project, subscription, ack_ids):
        if not ack_ids:
            return True
        url = "%s/projects/%s/subscriptions/%s:acknowledge" % (
            PUBSUB_BASE,
            urllib.parse.quote(project, safe=""),
            urllib.parse.quote(subscription, safe=""),
        )
        self._request("POST", url, {"ackIds": list(ack_ids)})
        return True


class GcsClient(_RestBase):
    """Object download via the GCS JSON API (alt=media)."""

    def get_object(self, bucket, object_name, generation=None):
        url = "%s/b/%s/o/%s?alt=media" % (
            GCS_BASE,
            urllib.parse.quote(bucket, safe=""),
            urllib.parse.quote(object_name, safe=""),
        )
        if generation:
            url += "&generation=" + urllib.parse.quote(str(generation), safe="")
        return self._request("GET", url)
