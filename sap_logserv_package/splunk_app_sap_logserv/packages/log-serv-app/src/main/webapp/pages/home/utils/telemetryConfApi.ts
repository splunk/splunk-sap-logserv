/**
 * telemetryConfApi — read + write the per-app acknowledgement state for
 * AI Assistant legal modals.
 *
 * Storage (session 042 / Option D — split between conf-file + KV Store):
 *
 *   OPERATOR-CONTROLLED `optInVersion` lives in `default/ai_assistant_acks.conf`
 *   (read-only via the standard `configs/conf-ai_assistant_acks` REST endpoint
 *   in `default` namespace). Operators bump this value to force everyone to
 *   re-acknowledge after a disclaimer text change. Reads only — the app
 *   never writes to optInVersion.
 *
 *   USER-CONTROLLED acknowledgement state (optInVersionAcknowledged,
 *   optInChoice, optInChoiceAt) lives in the KV Store collection
 *   `logserv_ai_assistant_acks`, one row per stanza name. KV Store
 *   endpoints are gated only by the collection-level metadata ACL — no
 *   `admin_all_objects` capability requirement — so sc_subadmin users on
 *   locked-down Splunk Cloud Victoria deployments can save without the
 *   capability escalation that `/configs/conf-X/` writes require.
 *
 *   FALLBACK: pre-migration installs wrote everything (including the
 *   user-controlled fields) into `local/ai_assistant_acks.conf`. The
 *   reader tries KV Store first, then conf-file-local. The
 *   `migrateConfFileAcksToKvStore()` helper copies any pre-migration
 *   ack into KV Store on first load so users don't get re-prompted.
 *
 * Renamed from `default/telemetry.conf` in build 123 / session 024
 * path A.12. File name `telemetryConfApi.ts` preserved for stable
 * imports — only the storage backend changed.
 *
 * Two stanzas currently managed:
 *
 *   * `logserv-ai-assistant-tc` — the AI Assistant audit-log integrity
 *     acknowledgement (build 99). Triggered on Settings save with
 *     `audit_forwarder_enabled=false`.
 *   * `logserv-ai-assistant-enable-tc` — the AI Assistant feature-
 *     enablement liability acknowledgement (build 100). Triggered on
 *     Settings save when `enabled=true` and the current version of
 *     this T&C has not yet been acknowledged. This is the legal-
 *     liability waiver covering data egress to the configured LLM.
 *
 * Build 240 / session 042. Prior to build 240 this module wrote to
 * `configs/conf-ai_assistant_acks` — see git history for the conf-file
 * implementation.
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const CONF_NAME = 'ai_assistant_acks';

// Conf-file reader for optInVersion (operator-managed) + legacy local/
// fallback for the user-controlled fields. Reads only.
const CONF_NS_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/configs/conf-${CONF_NAME}`;

// KV Store row for the user-controlled acknowledgement state.
const COLLECTION = 'logserv_ai_assistant_acks';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;

const confStanzaUrl = (stanza: string): string =>
    `${CONF_NS_BASE}/${encodeURIComponent(stanza)}`;
const kvRowUrl = (stanza: string): string =>
    `${KV_BASE}/${encodeURIComponent(stanza)}`;

/** The audit-forwarder integrity T&C stanza (build 99). */
export const STANZA_FORWARDER_TC = 'logserv-ai-assistant-tc';
/** The AI Assistant feature-enablement liability T&C stanza (build 100). */
export const STANZA_ENABLE_TC = 'logserv-ai-assistant-enable-tc';

export type OptInChoice = 'yes' | 'no';

export interface TcAcknowledgementState {
    /** Current declared version from default + any local override. */
    optInVersion: number;
    /** Last version the admin interacted with (Submit OR Cancel).
     *  0 means never acknowledged — modal must show on save. */
    optInVersionAcknowledged: number;
    /** Admin's most recent yes/no answer. Empty string if never
     *  acknowledged. */
    optInChoice: OptInChoice | '';
    /** ISO timestamp of the most recent interaction, or empty. */
    optInChoiceAt: string;
}

const DEFAULT_STATE: TcAcknowledgementState = {
    optInVersion: 1,
    optInVersionAcknowledged: 0,
    optInChoice: '',
    optInChoiceAt: '',
};

const readCsrfToken = (): string => {
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
    return m ? decodeURIComponent(m[1]) : '';
};

const buildSharedHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
});

const buildKvMutatingHeaders = (): Record<string, string> => ({
    ...buildSharedHeaders(),
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

/** Parse the optInChoice field tolerant of all the forms Splunk's
 *  conf-stanza writer + KV Store can produce. Splunk's conf-stanza writer
 *  coerces `yes` → `'1'`, `no` → `'0'`; KV Store passes strings through
 *  intact. */
const parseChoice = (raw: unknown): OptInChoice | '' => {
    if (typeof raw !== 'string') return '';
    if (raw === 'yes' || raw === '1' || raw === 'true') return 'yes';
    if (raw === 'no' || raw === '0' || raw === 'false') return 'no';
    return '';
};

/** Parse optInVersion from the conf-file's content block. Number-coerce
 *  defensively; bad values fall back to 1. */
const parseOptInVersion = (raw: Record<string, unknown> | undefined): number => {
    const n = Number(raw?.optInVersion);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_STATE.optInVersion;
};

/** Read the conf-file stanza's content block. Returns undefined on any
 *  REST failure — caller treats that as "use defaults". */
const readConfStanza = async (
    stanza: string,
): Promise<Record<string, unknown> | undefined> => {
    try {
        const resp = await fetch(`${confStanzaUrl(stanza)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (!resp.ok) return undefined;
        const data = await resp.json();
        return data?.entry?.[0]?.content as
            | Record<string, unknown>
            | undefined;
    } catch {
        return undefined;
    }
};

interface KvAckRecord {
    _key: string;
    /** snake_case wire field names per KV Store collection schema. */
    opt_in_version_acknowledged?: number;
    opt_in_choice?: string;
    opt_in_choice_at?: string;
    /** opt_in_version is mirrored to the KV Store row on every write
     *  for auditability — it's still authoritative from the conf-file
     *  reader, but storing it here too means a KV Store dump shows the
     *  full state without joining against the conf-file. */
    opt_in_version?: number;
}

/** Read the KV Store row for a stanza. Returns null on 404 (no row),
 *  undefined on any other failure. */
const readKvAckRow = async (
    stanza: string,
): Promise<KvAckRecord | null | undefined> => {
    try {
        const resp = await fetch(`${kvRowUrl(stanza)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (resp.status === 404) return null;
        if (!resp.ok) return undefined;
        return (await resp.json()) as KvAckRecord;
    } catch {
        return undefined;
    }
};

/**
 * Read the merged stanza state.
 *
 * `optInVersion` is read from the conf-file (operator-managed; stays in
 * conf). User-controlled fields come from the KV Store row, with a
 * fall-through to the conf-file's local/ override for pre-migration
 * installs.
 *
 * Returns `DEFAULT_STATE` on any failure (404, network, parse) so callers
 * can always render — the admin will re-prompt next save and reach a
 * clean acknowledgement state.
 *
 * @param stanza the ai_assistant_acks.conf stanza name to read; use the
 *   `STANZA_*` constants exported from this module.
 */
export const readTcAcknowledgement = async (
    stanza: string,
): Promise<TcAcknowledgementState> => {
    // optInVersion always comes from the conf-file (operator-managed).
    const confContent = await readConfStanza(stanza);
    const optInVersion = parseOptInVersion(confContent);

    // User-controlled fields: try KV Store first, then conf-file local/
    // override (legacy pre-migration), then defaults.
    const kvRow = await readKvAckRow(stanza);
    if (kvRow) {
        const ackNum = Number(kvRow.opt_in_version_acknowledged);
        return {
            optInVersion,
            optInVersionAcknowledged:
                Number.isFinite(ackNum) && ackNum >= 0 ? Math.floor(ackNum) : 0,
            optInChoice: parseChoice(kvRow.opt_in_choice),
            optInChoiceAt:
                typeof kvRow.opt_in_choice_at === 'string' ? kvRow.opt_in_choice_at : '',
        };
    }

    // Fall back to conf-file fields (legacy pre-migration). The conf-file
    // uses camelCase field names (optInVersionAcknowledged etc.) carried
    // over from the previous build's wire format.
    if (confContent) {
        const ackNum = Number(confContent.optInVersionAcknowledged);
        return {
            optInVersion,
            optInVersionAcknowledged:
                Number.isFinite(ackNum) && ackNum >= 0 ? Math.floor(ackNum) : 0,
            optInChoice: parseChoice(confContent.optInChoice),
            optInChoiceAt:
                typeof confContent.optInChoiceAt === 'string'
                    ? confContent.optInChoiceAt
                    : '',
        };
    }

    return { ...DEFAULT_STATE, optInVersion };
};

/** Internal: write the KV Store row. Two-step upsert (POST to /<key>, fall
 *  back to collection-level POST on 404). Replaces the whole row on each
 *  call — caller passes the complete user-controlled state. */
const writeKvAckRow = async (record: KvAckRecord): Promise<void> => {
    const body = JSON.stringify(record);
    let resp = await fetch(kvRowUrl(record._key), {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildKvMutatingHeaders(),
        body,
    });
    if (resp.status === 404) {
        resp = await fetch(KV_BASE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: buildKvMutatingHeaders(),
            body,
        });
    }
    if (!resp.ok) {
        throw new Error(`Acknowledgement KV Store write failed: HTTP ${resp.status}`);
    }
};

/**
 * Write the admin's acknowledgement to KV Store. Per Splunk's
 * optInVersion pattern this is called for BOTH yes and no answers — the
 * boolean choice is recorded in `optInChoice` while the version bump
 * indicates the prompt has been resolved for the current revision.
 *
 * @param stanza the ai_assistant_acks.conf stanza name to write; use the
 *   `STANZA_*` constants exported from this module.
 * @param choice `yes` (admin accepted) or `no` (admin declined)
 * @param version the current `optInVersion` to record as acknowledged
 *   (caller has already read this from the conf-file)
 */
export const writeTcAcknowledgement = async (
    stanza: string,
    choice: OptInChoice,
    version: number,
): Promise<void> => {
    const record: KvAckRecord = {
        _key: stanza,
        opt_in_version: version,
        opt_in_version_acknowledged: version,
        opt_in_choice: choice,
        opt_in_choice_at: new Date().toISOString(),
    };
    await writeKvAckRow(record);
};

/**
 * One-shot migration helper called from AIAssistantProvider on mount.
 * For each known stanza: if no KV Store row exists AND the conf-file has
 * a non-default acknowledgement value (i.e. someone previously wrote to
 * `local/ai_assistant_acks.conf`), copy that value into the KV Store row.
 *
 * Idempotent: subsequent runs find the KV Store row populated and no-op.
 * Best-effort: failures are swallowed so the UI isn't blocked on
 * migration.
 *
 * The two known stanza names are wired in here; if new stanzas get added
 * later, extend `KNOWN_STANZAS` below.
 */
const KNOWN_STANZAS = [STANZA_FORWARDER_TC, STANZA_ENABLE_TC];

export const migrateConfFileAcksToKvStore = async (): Promise<void> => {
    try {
        await Promise.all(
            KNOWN_STANZAS.map(async (stanza) => {
                const existing = await readKvAckRow(stanza);
                if (existing) return; // already migrated
                const confContent = await readConfStanza(stanza);
                if (!confContent) return;
                const ackNum = Number(confContent.optInVersionAcknowledged);
                const choice = parseChoice(confContent.optInChoice);
                // Only migrate when there's actually something to preserve
                // (i.e., a non-zero acknowledged version OR a recorded
                // choice). Skip the default state to avoid populating the
                // KV Store on fresh installs.
                if (!Number.isFinite(ackNum) || ackNum <= 0 || choice === '') return;
                const optInVersion = parseOptInVersion(confContent);
                const record: KvAckRecord = {
                    _key: stanza,
                    opt_in_version: optInVersion,
                    opt_in_version_acknowledged: Math.floor(ackNum),
                    opt_in_choice: choice,
                    opt_in_choice_at:
                        typeof confContent.optInChoiceAt === 'string'
                            ? confContent.optInChoiceAt
                            : '',
                };
                await writeKvAckRow(record);
            }),
        );
    } catch {
        // Migration is best-effort — never block the UI.
    }
};
