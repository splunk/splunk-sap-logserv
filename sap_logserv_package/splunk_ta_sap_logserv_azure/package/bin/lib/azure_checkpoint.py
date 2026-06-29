"""
azure_checkpoint.py - Blob dedup checkpoint sidecar.

Storage Queue delivery is at-least-once: a message can be redelivered if the
visibility timeout expires before we delete it, or if the input process dies
after emitting a blob's events but before deleting the message. Without dedup,
that redelivery re-ingests the blob -> duplicate events.

This sidecar records the per-blob-version key (blob URL + ETag) of every blob
we've successfully ingested. Before fetching a blob we check `seen()`; after
emitting we `record()`. Redelivery of an already-ingested blob is then a no-op
(we still delete the message).

Persistence: a JSON sidecar `{key: last_seen_epoch}` under the modular input's
checkpoint dir, pruned by TTL and a max-entry cap so it can't grow unbounded.
Single-instance file checkpoint is fine for v1; multi-HF horizontal scaling
would swap this for a KV Store collection (design doc section 8/10).
"""

from __future__ import annotations

import json
import os


class DedupCheckpoint:
    """Bounded, TTL-pruned set of ingested blob keys, backed by a JSON file."""

    def __init__(self, path, logger, now_epoch, ttl_seconds=7 * 86400,
                 max_entries=50000):
        self._path = path
        self._logger = logger
        self._now = float(now_epoch)
        self._ttl = float(ttl_seconds)
        self._max_entries = int(max_entries)
        self._entries = self._load()
        self._dirty = False

    def seen(self, key):
        return key in self._entries

    def record(self, key):
        self._entries[key] = self._now
        self._dirty = True

    def flush(self):
        """Prune expired/overflow entries and write the sidecar if changed."""
        if not self._dirty:
            return
        self._prune()
        tmp = self._path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self._path), exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._entries, f, separators=(",", ":"))
            os.replace(tmp, self._path)
            self._dirty = False
        except OSError as exc:
            self._logger.error(
                "Dedup checkpoint write failed at %s: %s", self._path, exc,
            )
            try:
                os.remove(tmp)
            except OSError:
                pass

    # ----- internals -----

    def _load(self):
        if not os.path.isfile(self._path):
            return {}
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {str(k): float(v) for k, v in data.items()}
        except (OSError, ValueError, TypeError) as exc:
            self._logger.warning(
                "Dedup checkpoint read failed at %s (%s); starting fresh",
                self._path, exc,
            )
        return {}

    def _prune(self):
        # Drop entries older than the TTL.
        cutoff = self._now - self._ttl
        self._entries = {
            k: ts for k, ts in self._entries.items() if ts >= cutoff
        }
        # Cap total size: keep the most-recently-seen max_entries.
        if len(self._entries) > self._max_entries:
            kept = sorted(
                self._entries.items(), key=lambda kv: kv[1], reverse=True,
            )[: self._max_entries]
            self._entries = dict(kept)
