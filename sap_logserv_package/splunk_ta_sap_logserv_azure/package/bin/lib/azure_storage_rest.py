"""
azure_storage_rest.py - Minimal Azure Storage REST client (Queue + Blob).

stdlib ONLY (urllib.request + ssl + xml.etree). No Azure SDK, no
`cryptography`/`cffi`, no native binaries -> nothing for AppInspect Cloud's
AArch64 binary check to flag, and the Data TA tarball stays slim.

Authentication: SAS token pass-through. A SAS *is* the request signature, so
every operation is a plain HTTPS request with the SAS query string appended --
no Shared-Key HMAC signing, no OAuth. (Recipe A from
azure_path_c_design_v0.1_20260623.md. Recipes C/D -- Entra app registration /
managed identity -- would add a small bearer-token helper here; out of scope
for the v1 SAS-primary build.)

Operations:
  - get_queue_messages(account, queue, num_messages, visibility_timeout)
        GET  https://<acct>.queue.core.windows.net/<queue>/messages?...
  - delete_queue_message(account, queue, message_id, pop_receipt)
        DELETE https://<acct>.queue.core.windows.net/<queue>/messages/<id>?popreceipt=...
  - put_queue_message(account, queue, raw_text)   # dead-letter
        POST https://<acct>.queue.core.windows.net/<queue>/messages
  - get_blob(blob_url)
        GET  <blob_url>?<sas>   (blob_url already carries account+container+path)

Retry policy (mirrors lib/hec_client.py):
  - HTTP 5xx OR socket/TLS/connect error  -> retry up to 3x, backoff 1s/2s/4s
  - HTTP 4xx (bad SAS / not found / forbidden) -> no retry; raise immediately
  - HTTP 2xx -> success
"""

from __future__ import annotations

import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


# Retry budget: 3 retries = 4 total attempts. Delays after attempts 1, 2, 3.
RETRY_DELAYS_SEC = (1.0, 2.0, 4.0)

# Per-attempt urlopen timeouts (seconds). Queue ops are tiny; blobs are small
# (LogServ writes ~KB gzip files) but allow more headroom.
QUEUE_TIMEOUT_SEC = 30.0
BLOB_TIMEOUT_SEC = 60.0

# Azure Storage XML responses use no namespace on QueueMessagesList, but be
# defensive: strip any namespace prefix when matching element tags.
_QUEUE_MSG_TAG = "QueueMessage"


class AzureRestError(Exception):
    """Non-retryable client error (4xx) or exhausted-retries failure."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class QueueMessage:
    """One dequeued Storage Queue message."""

    __slots__ = ("message_id", "pop_receipt", "dequeue_count", "text")

    def __init__(self, message_id, pop_receipt, dequeue_count, text):
        self.message_id = message_id
        self.pop_receipt = pop_receipt
        self.dequeue_count = dequeue_count
        self.text = text

    def __repr__(self):
        return (
            "QueueMessage(id={s.message_id!r}, dequeue_count={s.dequeue_count}, "
            "text_len={n})"
        ).format(s=self, n=len(self.text or ""))


class AzureStorageClient:
    """SAS-authenticated Azure Storage REST client (Queue + Blob).

    One instance per modular-input firing; holds no connection pool.
    """

    def __init__(self, logger, sas_token, verify_ssl=True):
        self._logger = logger
        # SAS may be pasted with or without a leading '?'. Normalize to the
        # bare query string (no leading '?').
        self._sas = (sas_token or "").lstrip("?")
        self._ctx = self._tls_context(verify_ssl)

    # ----- public: queue -----

    def get_queue_messages(self, account, queue, num_messages=32,
                           visibility_timeout=300):
        """Dequeue up to `num_messages` (Azure caps at 32) with a visibility
        lease. Returns a list of QueueMessage. Empty list if the queue is empty.
        """
        num_messages = max(1, min(int(num_messages), 32))
        base = "https://{acct}.queue.core.windows.net/{q}/messages".format(
            acct=account, q=queue,
        )
        url = self._append_query(
            base,
            "numofmessages={}&visibilitytimeout={}".format(
                num_messages, int(visibility_timeout),
            ),
        )
        status, body = self._request("GET", url, timeout=QUEUE_TIMEOUT_SEC)
        return self._parse_queue_messages(body)

    def delete_queue_message(self, account, queue, message_id, pop_receipt):
        """Delete a processed message. Call ONLY after its blob's events are
        emitted (delete-on-success -> at-least-once becomes idempotent via the
        blob dedup checkpoint). Returns True on 204.
        """
        base = "https://{acct}.queue.core.windows.net/{q}/messages/{mid}".format(
            acct=account, q=queue, mid=urllib.parse.quote(message_id, safe=""),
        )
        url = self._append_query(
            base, "popreceipt={}".format(urllib.parse.quote(pop_receipt, safe="")),
        )
        status, _ = self._request("DELETE", url, timeout=QUEUE_TIMEOUT_SEC)
        return 200 <= status < 300

    def put_queue_message(self, account, queue, raw_text):
        """Enqueue a raw message body (used for dead-lettering a poison
        message to a separate queue). Azure wraps the body in
        <QueueMessage><MessageText>...</MessageText></QueueMessage>.
        """
        base = "https://{acct}.queue.core.windows.net/{q}/messages".format(
            acct=account, q=queue,
        )
        url = self._append_query(base, "")
        payload = "<QueueMessage><MessageText>{}</MessageText></QueueMessage>".format(
            _xml_escape(raw_text)
        ).encode("utf-8")
        status, _ = self._request(
            "POST", url, data=payload,
            headers={"Content-Type": "application/xml"},
            timeout=QUEUE_TIMEOUT_SEC,
        )
        return 200 <= status < 300

    # ----- public: blob -----

    def get_blob(self, blob_url):
        """GET the blob content (raw bytes, typically gzip). The blob_url comes
        from the Event Grid event's data.url and already includes the account,
        container, and path; we just append the SAS.
        """
        url = self._append_sas(blob_url)
        status, body = self._request("GET", url, timeout=BLOB_TIMEOUT_SEC)
        return body  # raw bytes; caller gunzips

    # ----- request core (retry/backoff) -----

    def _request(self, method, url, data=None, headers=None, timeout=30.0):
        """Issue an HTTPS request with retry on 5xx/network. Returns
        (status, body_bytes). Raises AzureRestError on 4xx or exhausted retries.
        """
        hdrs = dict(headers or {})
        last_status = None
        last_message = ""

        for attempt_idx in range(len(RETRY_DELAYS_SEC) + 1):
            attempt = attempt_idx + 1
            started = time.monotonic()
            try:
                req = urllib.request.Request(
                    url, data=data, headers=hdrs, method=method,
                )
                with urllib.request.urlopen(
                    req, context=self._ctx, timeout=timeout,
                ) as resp:
                    status = resp.status
                    body = resp.read()
                if 200 <= status < 300:
                    return status, body
                # urlopen normally raises HTTPError on >=400, but handle a
                # non-2xx that slips through (e.g. 3xx) defensively.
                last_status = status
                last_message = "HTTP {}".format(status)
                if 400 <= status < 500:
                    raise AzureRestError(
                        "{} {} -> HTTP {} (client error; no retry)".format(
                            method, _scrub(url), status),
                        status=status,
                    )
                self._log_retryable(method, url, attempt, status,
                                    time.monotonic() - started, "")

            except urllib.error.HTTPError as exc:
                last_status = exc.code
                try:
                    err_body = exc.read().decode("utf-8", "replace")[:300]
                except Exception:  # noqa: BLE001
                    err_body = ""
                last_message = "HTTP {} {}".format(exc.code, err_body)
                if 400 <= exc.code < 500:
                    # Bad SAS (403), missing blob/queue (404), malformed (400).
                    # Retrying won't help -> surface immediately.
                    raise AzureRestError(
                        "{} {} -> HTTP {} {}".format(
                            method, _scrub(url), exc.code, err_body),
                        status=exc.code,
                    )
                self._log_retryable(method, url, attempt, exc.code,
                                    time.monotonic() - started, err_body)

            except (urllib.error.URLError, socket.timeout, ssl.SSLError,
                    ConnectionError, OSError) as exc:
                last_status = None
                last_message = "network: {}: {}".format(type(exc).__name__, exc)
                self._log_retryable(method, url, attempt, None,
                                    time.monotonic() - started, str(exc))

            if attempt_idx < len(RETRY_DELAYS_SEC):
                time.sleep(RETRY_DELAYS_SEC[attempt_idx])

        raise AzureRestError(
            "{} {} failed after {} attempts: {}".format(
                method, _scrub(url), len(RETRY_DELAYS_SEC) + 1, last_message),
            status=last_status,
        )

    # ----- helpers -----

    def _append_sas(self, url):
        return self._append_query(url, "")

    def _append_query(self, url, extra):
        """Append `extra` query params + the SAS to `url`, choosing ? or &."""
        parts = [p for p in (extra, self._sas) if p]
        if not parts:
            return url
        joined = "&".join(parts)
        sep = "&" if "?" in url else "?"
        return url + sep + joined

    def _parse_queue_messages(self, body):
        if not body:
            return []
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            self._logger.error("Failed to parse queue XML response: %s", exc)
            return []
        messages = []
        for el in root.iter():
            if _localname(el.tag) != _QUEUE_MSG_TAG:
                continue
            fields = {_localname(c.tag): (c.text or "") for c in el}
            try:
                dequeue_count = int(fields.get("DequeueCount", "0") or "0")
            except ValueError:
                dequeue_count = 0
            messages.append(QueueMessage(
                message_id=fields.get("MessageId", ""),
                pop_receipt=fields.get("PopReceipt", ""),
                dequeue_count=dequeue_count,
                text=fields.get("MessageText", ""),
            ))
        return messages

    def _log_retryable(self, method, url, attempt, status, dur, msg):
        self._logger.warning(
            "Azure %s retryable failure: url=%s attempt=%d dur=%.3fs "
            "status=%s msg=%s",
            method, _scrub(url), attempt, dur,
            status if status is not None else "n/a", msg[:200],
        )

    @staticmethod
    def _tls_context(verify_ssl):
        ctx = ssl.create_default_context()
        if not verify_ssl:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx


def _localname(tag):
    """Strip an XML namespace ('{ns}Local' -> 'Local')."""
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _xml_escape(text):
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _scrub(url):
    """Drop the query string (which carries the SAS signature) before logging."""
    return url.split("?", 1)[0]
