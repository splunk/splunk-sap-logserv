"""
sap_logserv_gcp_pubsub.py - GCP Pub/Sub GCS-notification consumer modular input.

The GCP twin of Splunk_TA_aws's "SQS-Based S3" input and of this solution's
own `sap_logserv_azure_queue`. SAP's LogServ-on-GCP lane writes gzip'd NDJSON
objects to a GCS bucket whose OBJECT_FINALIZE notifications land on a Pub/Sub
subscription. This input drains that subscription, fetches each named object,
and emits its NDJSON lines via the native modular-input EventWriter -- so the
events flow through THIS Heavy Forwarder's index-time pipeline and the Data
TA's existing `transforms.conf` routing (clz_dir/clz_subdir -> per-source
sourcetypes), the Configuration -> Filters nullQueue filtering, the `_time`
drop, and the `splunk_solution`/`cloud_provider` WRITE_META stamping all apply
UNCHANGED -- provided the events carry `sourcetype = sap_logserv_logs`.

Why not the Splunk Add-on for GCP (Splunkbase 3088)? Its v5.x "Cloud Pub/Sub
Based Bucket" input is the same architecture but has NO gzip support -- a
LogServ `.json.gz` object dies with `UnicodeDecodeError ... byte 0x8b`
(validated 2026-07-05, gcp_support_plan_v0.1_20260704.md section 2a). This
input's fetch path gunzips (with a plaintext fallback), mirroring the Azure
TA and SAP's own sap-ecs-gcp-log-forwarder.

This input ships in its OWN add-on (`splunk_ta_sap_logserv_gcp`), installed
per-HF, separate from the DS-managed Data TA -- the same arrangement as the
AWS and Azure tiers.

Auth: a Google service-account JSON key (paste into the input; encrypted by
UCC into passwords.conf). lib/gcp_auth.py mints OAuth2 tokens from it with a
pure-stdlib RS256 implementation -- no google-auth/cryptography (compiled
wheels fail AppInspect Cloud's AArch64 checks), no vendored third-party code.
Required roles (grant on the SAP-managed resources): `roles/pubsub.subscriber`
on the subscription + `roles/storage.objectViewer` on the bucket. (Unlike
add-on 3088, this input never calls GetSubscription, so no pubsub.viewer.)

cloud_provider attribution: the generated inputs.conf `[sap_logserv_gcp_pubsub]`
stanza carries `_meta = cloud_provider::gcp` (injected by
additional_packaging.py) -- per-input attribution that works even when one HF
ingests AWS + Azure + GCP into the same index.

Per firing (every `interval` seconds):
  1. Resolve config + the service-account key (encrypted passwords.conf).
  2. Drain the subscription (bounded by a firing time budget + max_objects):
       a. :pull up to batch_size messages (returnImmediately, ack deadline is
          the subscription's own setting; 300s+ recommended).
       b. Per message:
            - poison guard: deliveryAttempt > poison_threshold -> ack + drop
              (deliveryAttempt is only reported when the subscription has a
              dead-letter policy; WITH one, Pub/Sub dead-letters natively and
              this guard is belt-and-suspenders)
            - parse the GCS notification (attributes-first, payload fallback)
            - keep OBJECT_FINALIZE events whose path passes
              is_relevant_object_event
            - per relevant object: dedup-skip OR fetch -> gunzip -> split
              NDJSON -> EventWriter per line -> record dedup
            - ack the message ONLY on full success (ack-on-success + object
              dedup = idempotent under at-least-once redelivery)
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

from lib.gcp_auth import TokenMinter, GcpAuthError
from lib.gcp_rest import PubSubClient, GcsClient, GcpRestError
from lib.gcp_notifications import (
    parse_received_message, is_object_finalize, is_relevant_object_event,
)
from lib.gcp_checkpoint import DedupCheckpoint


APP_NAME = "splunk_ta_sap_logserv_gcp"
INPUT_SERVICE = "sap_logserv_gcp_pubsub"
# Sourcetype emitted by this input -- HARD-CODED to sap_logserv_logs (identical
# to what Splunk_TA_aws emits for S3 ingest and the Azure TA for Blob ingest).
# The Data TA's props.conf [sap_logserv_logs] + transforms.conf route/filter/
# stamp from here, so it must never vary; the value is NOT read from the input
# stanza. The Input screen shows `event_sourcetype` as a fixed, non-editable
# field (globalConfig) purely for transparency.
DEFAULT_SOURCETYPE = "sap_logserv_logs"
DEFAULT_INDEX = "sap_logserv_logs"

# Hard ceiling on per-firing wall-clock so a backlog drain can't run past the
# next scheduled firing. Capped, and never more than ~90% of the interval.
FIRING_BUDGET_CAP_SEC = 240.0


class GCP_PUBSUB_INPUT(smi.Script):
    """Modular input class. Name mirrors UCC's auto-generated stub."""

    def __init__(self):
        super().__init__()
        self._logger = solnlog.Logs().get_logger("{}_pubsub".format(APP_NAME))

    # ----- Splunk modular input contract -----

    def get_scheme(self):
        scheme = smi.Scheme("sap_logserv_gcp_pubsub")
        scheme.description = (
            "Consumes GCS object-created notifications from a Pub/Sub "
            "subscription, fetches each SAP LogServ object, and emits its "
            "NDJSON for index-time routing."
        )
        scheme.use_external_validation = True
        scheme.streaming_mode_xml = True
        scheme.use_single_instance = False
        # NOTE: do NOT declare "index" here. `index` (like host/source/
        # sourcetype) is a reserved modular-input argument handled specially by
        # Splunk; declaring it via get_scheme introspection blocks the whole
        # input from registering. The globalConfig `index` field still drives
        # the UI + writes `index = ...` to the stanza, and _run_input reads it
        # via cfg.get("index"). `event_sourcetype` is a non-reserved field, so
        # it IS declared below (applied programmatically on the EventWriter,
        # NOT via the reserved `sourcetype` stanza key).
        for arg_name, required in (
            ("name", True),
            ("project_id", True),
            ("subscription_name", True),
            ("service_account_key", True),
            ("event_sourcetype", False),
            ("batch_size", False),
            ("max_objects_per_fire", False),
            ("poison_threshold", False),
            ("include_filters", False),
            ("exclude_filters", False),
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

        project = (cfg.get("project_id") or "").strip()
        subscription = (cfg.get("subscription_name") or "").strip()
        if not project or not subscription:
            self._logger.error(
                "Input '%s': project_id/subscription_name empty; skipping",
                short_name,
            )
            return

        index = (cfg.get("index") or DEFAULT_INDEX).strip() or DEFAULT_INDEX
        # Hard-coded, NOT read from cfg: the sourcetype must always be
        # sap_logserv_logs (see DEFAULT_SOURCETYPE note).
        sourcetype = DEFAULT_SOURCETYPE
        verify_ssl = self._parse_bool(cfg.get("verify_ssl", "1"))
        batch_size = self._parse_int(cfg.get("batch_size"), 10, 1, 1000)
        max_objects = self._parse_int(
            cfg.get("max_objects_per_fire"), 500, 1, 100000,
        )
        poison_threshold = self._parse_int(cfg.get("poison_threshold"), 5, 1, 100)
        interval_sec = self._parse_float(cfg.get("interval"), 60.0)
        includes = cfg.get("include_filters") or ""
        excludes = cfg.get("exclude_filters") or ""

        key_json = self._get_service_account_key(short_name, session_key)
        if not key_json:
            self._logger.error(
                "Input '%s': service-account key not found in passwords.conf; "
                "skipping", short_name,
            )
            return

        try:
            minter = TokenMinter(key_json, self._logger, verify_ssl=verify_ssl)
        except GcpAuthError as exc:
            self._logger.error(
                "Input '%s': service-account key unusable (%s); skipping",
                short_name, exc,
            )
            return
        pubsub = PubSubClient(self._logger, minter, verify_ssl=verify_ssl)
        gcs = GcsClient(self._logger, minter, verify_ssl=verify_ssl)

        now_epoch = datetime.now(timezone.utc).timestamp()
        dedup = DedupCheckpoint(
            path=self._dedup_path(checkpoint_dir, short_name),
            logger=self._logger,
            now_epoch=now_epoch,
        )

        budget = min(FIRING_BUDGET_CAP_SEC, max(5.0, interval_sec * 0.9))
        deadline = time.monotonic() + budget

        stats = {
            "messages": 0, "objects": 0, "events": 0, "dups": 0,
            "acked": 0, "left": 0, "poison": 0, "noise": 0,
        }

        try:
            while time.monotonic() < deadline and stats["objects"] < max_objects:
                try:
                    msgs = pubsub.pull(project, subscription, batch_size)
                except GcpRestError as exc:
                    # 403 here means the SA lacks pubsub.subscriptions.consume
                    # on the subscription (or the key was revoked) -- a hard
                    # config error. Surface it and stop this firing.
                    self._logger.error(
                        "Input '%s': subscription pull failed (%s); aborting "
                        "firing", short_name, exc,
                    )
                    break
                except GcpAuthError as exc:
                    self._logger.error(
                        "Input '%s': token minting failed (%s); aborting "
                        "firing", short_name, exc,
                    )
                    break
                if not msgs:
                    break  # subscription drained
                acks = []
                for rm in msgs:
                    if time.monotonic() >= deadline or stats["objects"] >= max_objects:
                        break
                    ack_id = self._handle_message(
                        gcs, rm, dedup, ew, short_name, index, sourcetype,
                        includes, excludes, poison_threshold, stats,
                    )
                    if ack_id:
                        acks.append(ack_id)
                if acks:
                    try:
                        pubsub.acknowledge(project, subscription, acks)
                        stats["acked"] += len(acks)
                    except GcpRestError as exc:
                        # Failed ack -> messages redeliver; dedup makes the
                        # retry a no-op. Log and continue.
                        self._logger.warning(
                            "Input '%s': acknowledge failed for %d message(s) "
                            "(%s); they will redeliver", short_name, len(acks),
                            exc,
                        )
        finally:
            dedup.flush()

        self._logger.info(
            "Input '%s' done: messages=%d objects=%d events=%d dups=%d "
            "acked=%d left=%d poison=%d noise=%d",
            short_name, stats["messages"], stats["objects"], stats["events"],
            stats["dups"], stats["acked"], stats["left"], stats["poison"],
            stats["noise"],
        )

    # ----- per-message handling -----

    def _handle_message(self, gcs, rm, dedup, ew, short_name, index,
                        sourcetype, includes, excludes, poison_threshold,
                        stats):
        """Process one received message. Returns its ackId to acknowledge it,
        or None to leave it for redelivery."""
        stats["messages"] += 1

        ev = parse_received_message(rm)
        if ev is None:
            self._logger.warning(
                "Input '%s': unparseable Pub/Sub message; acking as noise",
                short_name,
            )
            stats["noise"] += 1
            return (rm.get("ackId") or None)

        # Poison guard: deliveryAttempt is only populated when the
        # subscription has a dead-letter policy (in which case Pub/Sub
        # dead-letters natively after max attempts); this guard is a local
        # backstop so a permanently-bad object can't loop forever.
        if ev.delivery_attempt > poison_threshold:
            self._logger.error(
                "Input '%s': poison message id=%s deliveryAttempt=%d > %d; "
                "acking + dropping (obj=%s)", short_name, ev.message_id,
                ev.delivery_attempt, poison_threshold, ev.gs_url,
            )
            stats["poison"] += 1
            return ev.ack_id

        if not is_object_finalize(ev) or not is_relevant_object_event(
            ev.object_id, includes, excludes,
        ):
            # Delete/metadata events, non-LogServ paths, or filtered out. On a
            # dedicated LogServ subscription this is unexpected noise; ack it
            # so it doesn't redeliver forever.
            stats["noise"] += 1
            return ev.ack_id

        outcome = self._ingest_object(gcs, ev, dedup, ew, short_name, index,
                                      sourcetype, stats)
        if outcome == "leave":
            stats["left"] += 1
            return None  # do NOT ack -> ack deadline re-exposes it

        return ev.ack_id

    def _ingest_object(self, gcs, ev, dedup, ew, short_name, index,
                       sourcetype, stats):
        """Fetch one object and emit its NDJSON. Returns 'done' or 'leave'."""
        key = ev.dedup_key
        if dedup.seen(key):
            stats["dups"] += 1
            self._logger.debug(
                "Input '%s': object already ingested (dedup); skipping %s",
                short_name, ev.gs_url,
            )
            return "done"

        try:
            raw = gcs.get_object(ev.bucket, ev.object_id, ev.generation)
        except GcpRestError as exc:
            if exc.status == 404:
                # Object (or that generation) deleted before we fetched it ->
                # nothing to ingest; ack (don't block the subscription on a
                # gone object).
                self._logger.warning(
                    "Input '%s': object 404 (gone) %s; skipping",
                    short_name, ev.gs_url,
                )
                return "done"
            if exc.status in (401, 403):
                # SA lacks storage.objectViewer on the bucket, or the key was
                # revoked -- a hard config error. Log loudly and leave the
                # message so it reprocesses once the credential is fixed.
                self._logger.error(
                    "Input '%s': object read forbidden (HTTP %s) for %s -- "
                    "the service account likely lacks storage.objectViewer "
                    "on the bucket; leaving message for retry",
                    short_name, exc.status, ev.gs_url,
                )
                return "leave"
            # 5xx / exhausted retries -> transient; leave for redelivery.
            self._logger.warning(
                "Input '%s': object fetch failed (%s) for %s; leaving for "
                "retry", short_name, exc, ev.gs_url,
            )
            return "leave"
        except GcpAuthError as exc:
            self._logger.error(
                "Input '%s': token minting failed mid-drain (%s); leaving "
                "message for retry", short_name, exc,
            )
            return "leave"

        content = self._decompress(raw)
        if content is None:
            self._logger.warning(
                "Input '%s': object decode failed for %s; skipping",
                short_name, ev.gs_url,
            )
            return "done"

        emitted = self._emit_lines(ew, content, ev.gs_url, index, sourcetype)
        dedup.record(key)
        stats["objects"] += 1
        stats["events"] += emitted
        self._logger.info(
            "Input '%s': ingested %d events from %s",
            short_name, emitted, ev.gs_url,
        )
        return "done"

    def _emit_lines(self, ew, content, gs_url, index, sourcetype):
        """Emit one EventWriter event per non-empty NDJSON line.

        Each line is the verbatim LogServ JSON envelope -- the same payload
        the AWS S3 / Azure Blob ingest delivers. `sourcetype` is
        sap_logserv_logs so the Data TA's index-time props/transforms
        (TIME_PREFIX, KV_MODE=json, clz_dir/clz_subdir routing) apply.
        `source` is set to the gs:// URL; the Data TA's extract_source
        overrides the searchable `source` from the envelope's own field (same
        as AWS/Azure), so cloud attribution rides the stanza-level
        `_meta = cloud_provider::gcp`, not `source`.
        """
        emitted = 0
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            event = smi.Event(
                data=line,
                source=gs_url,
                sourcetype=sourcetype,
                index=index,
            )
            ew.write_event(event)
            emitted += 1
        return emitted

    # ----- helpers -----

    @staticmethod
    def _decompress(raw):
        """gunzip the object; fall back to plain utf-8 (mirrors SAP's
        forwarder, which tries gzip magic bytes then plaintext)."""
        try:
            return gzip.decompress(raw).decode("utf-8")
        except (OSError, EOFError):
            try:
                return raw.decode("utf-8")
            except UnicodeDecodeError:
                return None

    def _get_service_account_key(self, short_name, session_key):
        """Read the encrypted service_account_key from passwords.conf.
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
            return secrets.get("service_account_key") or None
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


if __name__ == "__main__":
    exit_code = GCP_PUBSUB_INPUT().run(sys.argv)
    sys.exit(exit_code)
