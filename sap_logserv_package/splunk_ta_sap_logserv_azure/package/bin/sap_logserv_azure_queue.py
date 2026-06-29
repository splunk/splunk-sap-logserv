"""
sap_logserv_azure_queue.py - Azure Storage Queue consumer modular input.

The Azure twin of Splunk_TA_aws's "SQS-Based S3" input. SAP's LogServ-on-Azure
collector writes gzip'd NDJSON blobs and an Event Grid
`Microsoft.Storage.BlobCreated` subscription drops a notification onto a Storage
Queue. This input consumes that queue, fetches each named blob, and emits its
NDJSON lines via the native modular-input EventWriter -- so the events flow
through THIS Heavy Forwarder's index-time pipeline and the Data TA's existing
`transforms.conf` routing (clz_dir/clz_subdir -> per-source sourcetypes), the
Configuration -> Filters nullQueue filtering, the `_time` drop, and the
`splunk_solution`/`cloud_provider` WRITE_META stamping all apply UNCHANGED --
provided the events carry `sourcetype = sap_logserv_logs` (the per-instance
`event_sourcetype` default).

This input ships in its OWN add-on (`splunk_ta_sap_logserv_azure`), installed
per-HF, separate from the DS-managed Data TA -- the same arrangement the AWS
SQS-S3 input has in `Splunk_TA_aws`. Design:
azure_input_split_ta_design_v0.1_20260624.md (the split);
azure_path_c_design_v0.1_20260623.md (the original queue consumer).

Emit path is EventWriter, NOT HEC: that's what keeps it symmetric with the AWS
SQS-S3 input and reuses everything downstream of `sourcetype=sap_logserv_logs`.

cloud_provider attribution: the generated inputs.conf `[sap_logserv_azure_queue]`
stanza carries `_meta = cloud_provider::azure` (injected by
additional_packaging.py), so every event from this input kind is tagged with
the indexed `cloud_provider=azure` field -- per-input attribution that works
even when one HF ingests both AWS and Azure into the same index. (Same proven
pattern session 045 used on the Splunk Add-on for Microsoft Cloud Services
`mscs_storage_blob://` stanza.)

Per firing (every `interval` seconds):
  1. Resolve config + the SAS credential (encrypted passwords.conf).
  2. Drain the queue (bounded by a firing time budget + max_blobs_per_fire):
       a. GET up to batch_size messages with a visibility lease.
       b. Per message:
            - poison guard: DequeueCount > poison_threshold -> dead-letter/drop
            - parse Event Grid / CloudEvents body (base64-or-raw tolerant)
            - keep BlobCreated events whose subject passes is_relevant_blob_event
            - per relevant blob: dedup-skip OR fetch -> gunzip -> split NDJSON
              -> EventWriter per line -> record dedup
            - delete the message ONLY on full success (delete-on-success +
              blob dedup = idempotent under at-least-once redelivery)
  3. Flush the dedup checkpoint; log a summary.
"""

import import_declare_test  # noqa: F401  UCC bootstrap; resolves lib/ paths

import gzip
import json
import os
import sys
import time
from datetime import datetime, timezone

from splunklib import modularinput as smi

from solnlib.credentials import CredentialManager
from solnlib import log as solnlog

from lib.azure_storage_rest import AzureStorageClient, AzureRestError
from lib.azure_eventgrid import (
    parse_message, is_blob_created, is_relevant_blob_event,
)
from lib.azure_checkpoint import DedupCheckpoint


APP_NAME = "splunk_ta_sap_logserv_azure"
INPUT_SERVICE = "sap_logserv_azure_queue"
# Sourcetype emitted by this input -- HARD-CODED to sap_logserv_logs (identical
# to what Splunk_TA_aws emits for S3 ingest). The Data TA's props.conf
# [sap_logserv_logs] + transforms.conf route/filter/stamp from here, so it must
# never vary; the value is NOT read from the input stanza. The Input screen shows
# `event_sourcetype` as a fixed, non-editable single-option field (globalConfig)
# purely for transparency. [session 070]
DEFAULT_SOURCETYPE = "sap_logserv_logs"
DEFAULT_INDEX = "sap_logserv_logs"

# Hard ceiling on per-firing wall-clock so a backlog drain can't run past the
# next scheduled firing. Capped, and never more than ~90% of the interval.
FIRING_BUDGET_CAP_SEC = 240.0


class AZURE_QUEUE_INPUT(smi.Script):
    """Modular input class. Name mirrors UCC's auto-generated stub."""

    def __init__(self):
        super().__init__()
        self._logger = solnlog.Logs().get_logger("{}_queue".format(APP_NAME))

    # ----- Splunk modular input contract -----

    def get_scheme(self):
        scheme = smi.Scheme("sap_logserv_azure_queue")
        scheme.description = (
            "Consumes Azure Storage Queue blob-created notifications, fetches "
            "each SAP LogServ blob, and emits its NDJSON for index-time routing."
        )
        scheme.use_external_validation = True
        scheme.streaming_mode_xml = True
        scheme.use_single_instance = False
        # NOTE: do NOT declare "index" here. `index` (like host/source/
        # sourcetype) is a reserved modular-input argument handled specially by
        # Splunk; declaring it via get_scheme introspection blocks the whole
        # input from registering ("Endpoint argument 'index' is an internal
        # argument ... should not be defined via introspection"). The globalConfig
        # `index` field still drives the UI + writes `index = ...` to the stanza,
        # and _run_input reads it via cfg.get("index") with a sap_logserv_logs
        # fallback. `event_sourcetype` is a non-reserved field, so it IS declared
        # below (it is applied programmatically on the EventWriter, NOT via the
        # reserved `sourcetype` stanza key).
        for arg_name, required in (
            ("name", True),
            ("account_name", True),
            ("queue_name", True),
            ("sas_token", True),
            ("event_sourcetype", False),
            ("batch_size", False),
            ("visibility_timeout", False),
            ("max_blobs_per_fire", False),
            ("poison_threshold", False),
            ("include_filters", False),
            ("exclude_filters", False),
            ("dead_letter_queue", False),
            ("verify_ssl", False),
        ):
            scheme.add_argument(smi.Argument(arg_name, required_on_create=required))
        return scheme

    def validate_input(self, definition):
        # Field-level validators live in globalConfig.json; UCC enforces them.
        return

    def stream_events(self, inputs, ew):
        session_key = inputs.metadata.get("session_key", "")
        checkpoint_dir = inputs.metadata.get("checkpoint_dir") or "."
        for input_name, cfg in inputs.inputs.items():
            try:
                self._run_input(input_name, cfg, session_key, checkpoint_dir, ew)
            except Exception as exc:  # noqa: BLE001
                self._logger.exception("Input '%s' failed: %s", input_name, exc)

    # ----- per-input lifecycle -----

    def _run_input(self, input_name, cfg, session_key, checkpoint_dir, ew):
        short_name = input_name.split("//", 1)[-1]
        self._logger.info("Input '%s' firing", short_name)

        account = (cfg.get("account_name") or "").strip()
        queue = (cfg.get("queue_name") or "").strip()
        if not account or not queue:
            self._logger.error(
                "Input '%s': account_name/queue_name empty; skipping", short_name,
            )
            return

        index = (cfg.get("index") or DEFAULT_INDEX).strip() or DEFAULT_INDEX
        # Hard-coded, NOT read from cfg: the sourcetype must always be
        # sap_logserv_logs (see DEFAULT_SOURCETYPE note). The globalConfig
        # `event_sourcetype` field is locked to this value and display-only.
        sourcetype = DEFAULT_SOURCETYPE
        verify_ssl = self._parse_bool(cfg.get("verify_ssl", "1"))
        batch_size = self._parse_int(cfg.get("batch_size"), 32, 1, 32)
        visibility_timeout = self._parse_int(
            cfg.get("visibility_timeout"), 300, 30, 604800,
        )
        max_blobs = self._parse_int(cfg.get("max_blobs_per_fire"), 500, 1, 100000)
        poison_threshold = self._parse_int(cfg.get("poison_threshold"), 5, 1, 100)
        interval_sec = self._parse_float(cfg.get("interval"), 60.0)
        includes = cfg.get("include_filters") or ""
        excludes = cfg.get("exclude_filters") or ""
        dlq = (cfg.get("dead_letter_queue") or "").strip()

        sas = self._get_sas_token(short_name, session_key)
        if not sas:
            self._logger.error(
                "Input '%s': SAS token not found in passwords.conf; skipping",
                short_name,
            )
            return

        client = AzureStorageClient(self._logger, sas, verify_ssl=verify_ssl)

        now_epoch = datetime.now(timezone.utc).timestamp()
        dedup = DedupCheckpoint(
            path=self._dedup_path(checkpoint_dir, short_name),
            logger=self._logger,
            now_epoch=now_epoch,
        )

        budget = min(FIRING_BUDGET_CAP_SEC, max(5.0, interval_sec * 0.9))
        deadline = time.monotonic() + budget

        stats = {
            "messages": 0, "blobs": 0, "events": 0, "dups": 0,
            "deleted": 0, "left": 0, "poison": 0, "noise": 0,
        }

        try:
            while time.monotonic() < deadline and stats["blobs"] < max_blobs:
                try:
                    msgs = client.get_queue_messages(
                        account, queue,
                        num_messages=batch_size,
                        visibility_timeout=visibility_timeout,
                    )
                except AzureRestError as exc:
                    # 403 here usually means the SAS lacks Queue process/delete
                    # perms (or is expired) -- a hard config error. Surface it
                    # and stop this firing; nothing to drain.
                    self._logger.error(
                        "Input '%s': queue read failed (%s); aborting firing",
                        short_name, exc,
                    )
                    break
                if not msgs:
                    break  # queue drained
                for msg in msgs:
                    if time.monotonic() >= deadline or stats["blobs"] >= max_blobs:
                        break
                    self._handle_message(
                        client, account, queue, dlq, msg, dedup, ew,
                        short_name, index, sourcetype, includes, excludes,
                        poison_threshold, stats,
                    )
        finally:
            dedup.flush()

        self._logger.info(
            "Input '%s' done: messages=%d blobs=%d events=%d dups=%d "
            "deleted=%d left=%d poison=%d noise=%d",
            short_name, stats["messages"], stats["blobs"], stats["events"],
            stats["dups"], stats["deleted"], stats["left"], stats["poison"],
            stats["noise"],
        )

    # ----- per-message handling -----

    def _handle_message(self, client, account, queue, dlq, msg, dedup, ew,
                        short_name, index, sourcetype, includes, excludes,
                        poison_threshold, stats):
        stats["messages"] += 1

        # 1. Poison guard: a message redelivered too many times is dropped
        #    (dead-lettered if a DLQ is configured) so a permanently-bad blob
        #    can't loop forever (Storage Queue has no native DLQ).
        if msg.dequeue_count > poison_threshold:
            self._logger.error(
                "Input '%s': poison message id=%s dequeue_count=%d > %d; "
                "%s", short_name, msg.message_id, msg.dequeue_count,
                poison_threshold,
                "moving to dead-letter queue" if dlq else "dropping",
            )
            if dlq:
                try:
                    client.put_queue_message(account, dlq, msg.text)
                except AzureRestError as exc:
                    self._logger.error(
                        "Input '%s': dead-letter enqueue failed (%s); dropping "
                        "anyway", short_name, exc,
                    )
            self._delete(client, account, queue, msg, short_name, stats)
            stats["poison"] += 1
            return

        # 2. Parse the Event Grid / CloudEvents body.
        events = parse_message(msg.text)
        if not events:
            self._logger.warning(
                "Input '%s': unparseable message id=%s (len=%d); deleting as "
                "noise", short_name, msg.message_id, len(msg.text or ""),
            )
            self._delete(client, account, queue, msg, short_name, stats)
            stats["noise"] += 1
            return

        relevant = [
            e for e in events
            if is_blob_created(e) and is_relevant_blob_event(e.subject, includes, excludes)
        ]
        if not relevant:
            # Not a LogServ blob-created event (or filtered out). On a
            # dedicated LogServ queue this is unexpected noise; delete it so it
            # doesn't redeliver forever.
            self._delete(client, account, queue, msg, short_name, stats)
            stats["noise"] += 1
            return

        # 3. Ingest each relevant blob. If any blob hits a transient/retryable
        #    failure, LEAVE the message (don't delete) so it redelivers; the
        #    dedup checkpoint makes the already-ingested blobs in this message
        #    no-ops on the retry.
        leave = False
        for ev in relevant:
            outcome = self._ingest_blob(client, ev, dedup, ew, short_name,
                                        index, sourcetype, stats)
            if outcome == "leave":
                leave = True
                break  # stop; redeliver the whole message

        if leave:
            stats["left"] += 1
            return  # do NOT delete -> visibility timeout re-exposes it

        self._delete(client, account, queue, msg, short_name, stats)

    def _ingest_blob(self, client, ev, dedup, ew, short_name, index,
                     sourcetype, stats):
        """Fetch one blob and emit its NDJSON. Returns 'done' or 'leave'."""
        key = ev.dedup_key
        if dedup.seen(key):
            stats["dups"] += 1
            self._logger.debug(
                "Input '%s': blob already ingested (dedup); skipping %s",
                short_name, _scrub(ev.blob_url),
            )
            return "done"

        if not ev.blob_url:
            self._logger.warning(
                "Input '%s': blob event has no data.url (subject=%s); skipping",
                short_name, ev.subject,
            )
            return "done"

        try:
            raw = client.get_blob(ev.blob_url)
        except AzureRestError as exc:
            if exc.status == 404:
                # Blob deleted before we fetched it -> nothing to ingest; let
                # the message delete (don't block the queue on a gone blob).
                self._logger.warning(
                    "Input '%s': blob 404 (gone) %s; skipping",
                    short_name, _scrub(ev.blob_url),
                )
                return "done"
            if exc.status in (401, 403):
                # SAS lacks Blob-read or is expired -- THE queue-only-SAS case.
                # Hard config error: log loudly and leave the message so it
                # reprocesses once the credential is fixed.
                self._logger.error(
                    "Input '%s': blob read forbidden (HTTP %s) for %s -- the "
                    "SAS likely lacks Blob-read permission or has expired; "
                    "leaving message for retry",
                    short_name, exc.status, _scrub(ev.blob_url),
                )
                return "leave"
            # 5xx / exhausted retries -> transient; leave for redelivery.
            self._logger.warning(
                "Input '%s': blob fetch failed (%s) for %s; leaving for retry",
                short_name, exc, _scrub(ev.blob_url),
            )
            return "leave"

        content = self._decompress(raw)
        if content is None:
            self._logger.warning(
                "Input '%s': blob decode failed for %s; skipping",
                short_name, _scrub(ev.blob_url),
            )
            return "done"

        emitted = self._emit_lines(ew, content, ev.blob_url, index,
                                   sourcetype, short_name)
        dedup.record(key)
        stats["blobs"] += 1
        stats["events"] += emitted
        self._logger.info(
            "Input '%s': ingested %d events from %s",
            short_name, emitted, _scrub(ev.blob_url),
        )
        return "done"

    def _emit_lines(self, ew, content, blob_url, index, sourcetype,
                    short_name):
        """Emit one EventWriter event per non-empty NDJSON line.

        Each line is the verbatim LogServ JSON envelope -- the same payload the
        AWS S3 ingest delivers. `sourcetype` defaults to sap_logserv_logs (the
        per-instance `event_sourcetype` field) so the Data TA's index-time
        props/transforms (TIME_PREFIX, KV_MODE=json, clz_dir/clz_subdir routing)
        apply; an override bypasses that routing. `source` is set to the blob
        URL; note the Data TA's extract_source overrides the searchable `source`
        from the envelope's own field (same as AWS), so cloud attribution rides
        the stanza-level `_meta = cloud_provider::azure`, not `source`.
        """
        emitted = 0
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            event = smi.Event(
                data=line,
                source=blob_url,
                sourcetype=sourcetype,
                index=index,
            )
            ew.write_event(event)
            emitted += 1
        return emitted

    def _delete(self, client, account, queue, msg, short_name, stats):
        try:
            if client.delete_queue_message(account, queue, msg.message_id,
                                           msg.pop_receipt):
                stats["deleted"] += 1
            else:
                self._logger.warning(
                    "Input '%s': delete returned non-2xx for message id=%s",
                    short_name, msg.message_id,
                )
        except AzureRestError as exc:
            # A 404 on delete means the pop receipt expired (the visibility
            # lease lapsed) -- the message will redelivery; dedup covers it.
            self._logger.warning(
                "Input '%s': delete failed for message id=%s (%s)",
                short_name, msg.message_id, exc,
            )

    # ----- helpers -----

    @staticmethod
    def _decompress(raw):
        """gunzip the blob; fall back to plain utf-8 (mirrors SAP's
        log_processor.py which tries gzip then plaintext)."""
        try:
            return gzip.decompress(raw).decode("utf-8")
        except (OSError, EOFError):
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                return None

    def _get_sas_token(self, short_name, session_key):
        """Read the encrypted sas_token from passwords.conf.
        UCC realm: __REST_CREDENTIAL__#<app>#data/inputs/<service>
        """
        if not session_key:
            self._logger.error("No session_key available for credential fetch")
            return None
        try:
            realm = "__REST_CREDENTIAL__#{}#data/inputs/{}".format(
                APP_NAME, INPUT_SERVICE,
            )
            cm = CredentialManager(session_key, APP_NAME, realm=realm)
            blob = cm.get_password(short_name)
            if not blob:
                return None
            secrets = json.loads(blob)
            return secrets.get("sas_token") or None
        except Exception as exc:  # noqa: BLE001
            self._logger.error(
                "Credential fetch failed for '%s': %s", short_name, exc,
            )
            return None

    @staticmethod
    def _dedup_path(checkpoint_dir, short_name):
        return os.path.join(checkpoint_dir, short_name + ".dedup.json")

    @staticmethod
    def _parse_bool(value):
        return str(value).strip().lower() in ("1", "true", "yes", "on")

    @staticmethod
    def _parse_int(value, default, lo, hi):
        try:
            n = int(str(value).strip())
        except (ValueError, TypeError, AttributeError):
            return default
        return max(lo, min(n, hi))

    @staticmethod
    def _parse_float(value, default):
        try:
            return float(str(value).strip())
        except (ValueError, TypeError, AttributeError):
            return default


def _scrub(url):
    """Drop the query string (SAS signature) before logging a blob URL."""
    return (url or "").split("?", 1)[0]


if __name__ == "__main__":
    exit_code = AZURE_QUEUE_INPUT().run(sys.argv)
    sys.exit(exit_code)
