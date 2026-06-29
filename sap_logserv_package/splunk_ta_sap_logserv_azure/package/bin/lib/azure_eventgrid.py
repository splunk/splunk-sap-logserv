"""
azure_eventgrid.py - Parse Azure Event Grid blob-created notifications.

A Storage Queue fed by an Event Grid `Microsoft.Storage.BlobCreated`
subscription delivers one event per message (occasionally a batch). This
module turns a raw queue MessageText into normalized blob-created records and
ports SAP's `is_relevant_blob_event` path filter
(sap-ecs-azure-log-forwarder/queue_consumer.py).

Tolerates, in any combination:
  - base64-encoded OR raw-JSON message bodies (the Event Grid -> Storage Queue
    encoding setting varies per subscription),
  - a single event object OR a JSON array of events,
  - the EventGridEvent schema (`eventType`, `data.url`) OR CloudEvents 1.0
    (`type`, `data.url`).
"""

from __future__ import annotations

import base64
import binascii
import json


BLOB_CREATED_EVENT_TYPE = "Microsoft.Storage.BlobCreated"


class BlobEvent:
    """A normalized blob-created notification."""

    __slots__ = ("event_type", "subject", "blob_url", "etag")

    def __init__(self, event_type, subject, blob_url, etag):
        self.event_type = event_type
        self.subject = subject
        self.blob_url = blob_url
        self.etag = etag

    @property
    def dedup_key(self):
        """Stable per-blob-version identity for idempotency under redelivery."""
        return "{}|{}".format(self.blob_url or self.subject or "", self.etag or "")

    def __repr__(self):
        return (
            "BlobEvent(type={s.event_type!r}, url={s.blob_url!r}, "
            "etag={s.etag!r})"
        ).format(s=self)


def parse_message(message_text):
    """Decode + parse a queue MessageText into a list of BlobEvent.

    Returns [] when the body can't be decoded/parsed (caller logs + drops).
    Non-blob-created entries are still returned (with their event_type) so the
    caller can decide to delete them; use is_blob_created() to filter.
    """
    obj = _decode(message_text)
    if obj is None:
        return []
    raw_events = obj if isinstance(obj, list) else [obj]
    events = []
    for raw in raw_events:
        if not isinstance(raw, dict):
            continue
        ev = _normalize(raw)
        if ev is not None:
            events.append(ev)
    return events


def is_blob_created(event):
    return event.event_type == BLOB_CREATED_EVENT_TYPE


def is_relevant_blob_event(subject, include_filters=None, exclude_filters=None):
    """Port of SAP's queue_consumer.is_relevant_blob_event.

    A LogServ blob path is `<container>/logserv/<clz_dir>/<clz_subdir>/...`, so
    the `logserv` substring is a hard requirement (and filters out Azure
    Functions runtime noise). include/exclude are optional case-insensitive
    substring lists applied to the subject. This is only a cheap *pre-filter*
    to avoid downloading irrelevant blobs; the canonical clz_dir/clz_subdir
    allow/deny policy lives downstream in the Data TA Configuration -> Filters
    tab (one source of truth).
    """
    if not subject:
        return False
    subj = subject.lower()
    if "azure-webjobs-hosts" in subj:
        return False
    if "logserv" not in subj:
        return False
    excludes = _norm_filters(exclude_filters)
    if excludes and any(ex in subj for ex in excludes):
        return False
    includes = _norm_filters(include_filters)
    if includes and not any(inc in subj for inc in includes):
        return False
    return True


# ----- internals -----

def _decode(message_text):
    """Return the parsed JSON object (dict or list), or None.

    Try raw JSON first; if that fails, try base64 -> JSON. Storage Queue
    messages from Event Grid are commonly base64-encoded, but not always.
    """
    if message_text is None:
        return None
    text = message_text.strip()
    if not text:
        return None
    # 1. raw JSON
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        pass
    # 2. base64 -> JSON
    try:
        decoded = base64.b64decode(text, validate=False).decode("utf-8")
        return json.loads(decoded)
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
        return None


def _normalize(raw):
    """Map an EventGridEvent or CloudEvents dict to a BlobEvent.

    EventGridEvent: {"eventType": "...", "subject": "...", "data": {"url": "...", "eTag": "..."}}
    CloudEvents 1.0: {"type": "...", "subject": "...", "data": {"url": "...", "eTag": "..."}}
    """
    event_type = raw.get("eventType") or raw.get("type") or ""
    subject = raw.get("subject") or ""
    data = raw.get("data") or {}
    if not isinstance(data, dict):
        data = {}
    blob_url = data.get("url") or ""
    # eTag casing differs across schema versions; accept both.
    etag = data.get("eTag") or data.get("etag") or ""
    if not event_type and not subject and not blob_url:
        return None
    return BlobEvent(event_type=event_type, subject=subject,
                     blob_url=blob_url, etag=etag)


def _norm_filters(value):
    """Accept a list[str] or a comma-separated string; return lowercased list."""
    if not value:
        return []
    if isinstance(value, str):
        items = value.split(",")
    else:
        items = list(value)
    return [s.strip().lower() for s in items if s and s.strip()]
