Splunk TA for SAP LogServ (splunk_ta_sap_logserv)
=================================================

Part of Splunk for SAP LogServ. This add-on reads SAP LogServ deliveries
(NDJSON envelopes, sourcetype sap_logserv_logs) at index time: it sets each
event's host, source and folder fields (clz_dir, clz_subdir), routes the event
to its own sourcetype, applies the optional Include / Exclude filters, and
keeps only the original log line as the event text. It also defines the
sap_logserv_logs and logserv_ai_assistant_audit indexes.

Where to install: the heavy forwarders that collect LogServ data and the
deployment server that manages them, or a single Splunk instance together with
the Splunk App for SAP LogServ. We strongly recommend against installing it on
a search head, Splunk Cloud included: the Splunk App for SAP LogServ covers
that tier, and running ingest there adds load to the tier your users search
on. It is not blocked - on a search head that runs the inputs itself it works
as it does on a heavy forwarder.

Configuration: Splunk Web > Apps > Splunk TA for SAP LogServ > Configuration.
Third-party software: THIRD-PARTY-NOTICES.md. Licence: LICENSES/.
