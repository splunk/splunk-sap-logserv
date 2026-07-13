"""
gcp_notifications.py - Parse GCS object notifications from Pub/Sub messages.

The GCP twin of azure_eventgrid.py. GCS bucket notifications (created via
`gcloud storage buckets notifications create --payload-format=json`) publish
one Pub/Sub message per object event with the essentials in ATTRIBUTES
(eventType / bucketId / objectId / objectGeneration) and the full JSON_API_V1
object resource base64'd in `data`. We prefer the attributes and fall back to
the payload for tolerance.
"""

from __future__ import annotations

import base64
import json

EVENT_OBJECT_FINALIZE = "OBJECT_FINALIZE"


class ObjectEvent:
    """One GCS object event extracted from a received Pub/Sub message."""

    __slots__ = (
        "ack_id", "message_id", "delivery_attempt", "event_type",
        "bucket", "object_id", "generation", "publish_time",
    )

    def __init__(self, ack_id, message_id, delivery_attempt, event_type,
                 bucket, object_id, generation, publish_time):
        self.ack_id = ack_id
        self.message_id = message_id
        self.delivery_attempt = delivery_attempt
        self.event_type = event_type
        self.bucket = bucket
        self.object_id = object_id
        self.generation = generation
        self.publish_time = publish_time

    @property
    def dedup_key(self):
        """Per-object-version key: bucket + name + generation (GCS bumps the
        generation on every overwrite, so re-uploads re-ingest)."""
        return "%s/%s#%s" % (self.bucket, self.object_id, self.generation)

    @property
    def gs_url(self):
        return "gs://%s/%s" % (self.bucket, self.object_id)


def parse_received_message(rm):
    """receivedMessage dict (from subscriptions:pull) -> ObjectEvent or None.

    Never raises on malformed input; the caller treats None as noise.
    """
    try:
        ack_id = rm.get("ackId")
        msg = rm.get("message") or {}
        attrs = msg.get("attributes") or {}
        event_type = attrs.get("eventType")
        bucket = attrs.get("bucketId")
        object_id = attrs.get("objectId")
        generation = attrs.get("objectGeneration")
        if not (bucket and object_id):
            # Fall back to the JSON_API_V1 payload in data.
            try:
                payload = json.loads(
                    base64.b64decode(msg.get("data") or b"").decode("utf-8")
                )
                bucket = bucket or payload.get("bucket")
                object_id = object_id or payload.get("name")
                generation = generation or payload.get("generation")
            except (ValueError, TypeError):
                pass
        if not (ack_id and bucket and object_id):
            return None
        return ObjectEvent(
            ack_id=ack_id,
            message_id=msg.get("messageId") or "",
            delivery_attempt=int(rm.get("deliveryAttempt") or 1),
            event_type=event_type or "",
            bucket=bucket,
            object_id=object_id,
            generation=str(generation or ""),
            publish_time=msg.get("publishTime") or "",
        )
    except Exception:  # noqa: BLE001  tolerant by design
        return None


def is_object_finalize(event):
    """Only OBJECT_FINALIZE (new object / new generation) triggers ingest.
    Delete/metadata/archive events are noise for this input."""
    return event.event_type == EVENT_OBJECT_FINALIZE


def is_relevant_object_event(object_path, include_filters=None,
                             exclude_filters=None):
    """Mirror of the Azure TA's is_relevant_blob_event (and SAP's own
    consumer): the LogServ object path is `logserv/<clz_dir>/<clz_subdir>/...`,
    so the `logserv` substring is a hard requirement; include/exclude are
    optional case-insensitive substring lists. Only a cheap pre-filter --
    the canonical clz allow/deny policy lives in the Data TA's
    Configuration -> Filters tab.
    """
    if not object_path:
        return False
    path = object_path.lower()
    if "logserv" not in path:
        return False
    excludes = _norm_filters(exclude_filters)
    if excludes and any(ex in path for ex in excludes):
        return False
    includes = _norm_filters(include_filters)
    if includes and not any(inc in path for inc in includes):
        return False
    return True


def _norm_filters(filters):
    """Comma-separated string (or list) -> list of lowered non-empty terms."""
    if not filters:
        return []
    if isinstance(filters, str):
        parts = filters.split(",")
    else:
        parts = list(filters)
    return [p.strip().lower() for p in parts if p and p.strip()]
