/**
 * telemetryConfApi — read + write the per-app acknowledgement state
 * tracked in `ai_assistant_acks.conf` via the standard
 * `configs/conf-ai_assistant_acks` REST endpoint.
 *
 * Renamed from `telemetry.conf` in build 123 / session 024 path A.12 —
 * the original choice (using Splunk's own telemetry.conf) matched
 * Splunk's instrumentation-framework UX pattern, but failed
 * AppInspect precert (the rule reserves telemetry.conf for the
 * splunk_instrumentation app and forbids third-party stanzas). The
 * file name on this module is preserved (telemetryConfApi.ts) for
 * stable imports — only the `CONF_NAME` constant changed.
 *
 * Each stanza tracks ONE legal-acknowledgement subject. The fields
 * within a stanza follow Splunk's optInVersion pattern verbatim:
 *
 *   * `optInVersion` — current required acknowledgement version
 *     (declared in `default/ai_assistant_acks.conf`, bumped by
 *     operators when the disclaimer text changes).
 *   * `optInVersionAcknowledged` — last version the admin interacted
 *     with (lives in `local/ai_assistant_acks.conf`).
 *   * `optInChoice` — `yes` or `no`, the admin's binary answer.
 *   * `optInChoiceAt` — ISO timestamp of the interaction.
 *
 * Per Splunk's optInVersion pattern, ANY interaction with the modal
 * (yes OR no) bumps `optInVersionAcknowledged` to current.
 *
 * The app currently uses two stanzas, both managed by this module:
 *
 *   * `logserv-ai-assistant-tc` — the AI Assistant audit-log
 *     integrity acknowledgement (build 99). Triggered on Settings
 *     save with `audit_forwarder_enabled=false`.
 *   * `logserv-ai-assistant-enable-tc` — the AI Assistant feature-
 *     enablement liability acknowledgement (build 100). Triggered on
 *     Settings save when `enabled=true` and the current version of
 *     this T&C has not yet been acknowledged. This is the legal-
 *     liability waiver covering data egress to the configured LLM.
 *
 * Adding a new stanza is now a one-line constant + a new modal
 * component; the API takes stanza name as parameter.
 *
 * Auth: same Splunk Web cookie + CSRF + X-Requested-With pattern as
 * the other conf editors. Writing to `configs/conf-ai_assistant_acks`
 * requires admin role (`admin_all_objects` capability) — Splunk
 * enforces this server-side, so non-admin callers receive 403 and
 * we surface the error to the UI.
 *
 * Build 99 / session 022 (initial). Build 100 (multi-stanza).
 * Build 123 / session 024 (renamed conf for AppInspect compliance).
 */

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const CONF_NAME = 'ai_assistant_acks';
const NS_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/configs/conf-${CONF_NAME}`;

/** The audit-forwarder integrity T&C stanza (build 99). */
export const STANZA_FORWARDER_TC = 'logserv-ai-assistant-tc';
/** The AI Assistant feature-enablement liability T&C stanza (build 100). */
export const STANZA_ENABLE_TC = 'logserv-ai-assistant-enable-tc';

const stanzaUrl = (stanza: string): string =>
    `${NS_BASE}/${encodeURIComponent(stanza)}`;

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

const buildMutatingHeaders = (): Record<string, string> => ({
    ...buildSharedHeaders(),
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Splunk-Form-Key': readCsrfToken(),
});

const parseRawContent = (
    raw: Record<string, unknown> | undefined,
): TcAcknowledgementState => {
    const r = raw ?? {};
    const verNum = Number(r.optInVersion);
    const ackNum = Number(r.optInVersionAcknowledged);
    // Splunk's conf-stanza writer coerces values that look like booleans
    // (`yes` → `'1'`, `no` → `'0'`). Accept both forms when reading so
    // a conf written with `optInChoice=yes` still parses back as 'yes'.
    let choice: OptInChoice | '' = '';
    if (typeof r.optInChoice === 'string') {
        if (r.optInChoice === 'yes' || r.optInChoice === '1' || r.optInChoice === 'true') {
            choice = 'yes';
        } else if (r.optInChoice === 'no' || r.optInChoice === '0' || r.optInChoice === 'false') {
            choice = 'no';
        }
    }
    return {
        optInVersion: Number.isFinite(verNum) && verNum > 0 ? Math.floor(verNum) : DEFAULT_STATE.optInVersion,
        optInVersionAcknowledged: Number.isFinite(ackNum) && ackNum >= 0
            ? Math.floor(ackNum)
            : 0,
        optInChoice: choice,
        optInChoiceAt:
            typeof r.optInChoiceAt === 'string' ? r.optInChoiceAt : '',
    };
};

/**
 * Read the merged stanza state. Returns `DEFAULT_STATE` on any
 * failure (404, network, parse) so callers can always render — the
 * admin will re-prompt next save and reach a clean acknowledgement
 * state.
 *
 * @param stanza the ai_assistant_acks.conf stanza name to read; use the
 *   `STANZA_*` constants exported from this module.
 */
export const readTcAcknowledgement = async (
    stanza: string,
): Promise<TcAcknowledgementState> => {
    try {
        const resp = await fetch(`${stanzaUrl(stanza)}?output_mode=json`, {
            credentials: 'same-origin',
            headers: buildSharedHeaders(),
        });
        if (!resp.ok) return { ...DEFAULT_STATE };
        const data = await resp.json();
        const content = data?.entry?.[0]?.content as
            | Record<string, unknown>
            | undefined;
        return parseRawContent(content);
    } catch (_e) {
        return { ...DEFAULT_STATE };
    }
};

/**
 * Write the admin's acknowledgement to `local/ai_assistant_acks.conf` via
 * the standard Splunk REST endpoint. Per Splunk's optInVersion
 * pattern this is called for BOTH yes and no answers — the boolean
 * choice is recorded in `optInChoice` while the version bump
 * indicates the prompt has been resolved for the current revision.
 *
 * @param stanza the ai_assistant_acks.conf stanza name to write; use the
 *   `STANZA_*` constants exported from this module.
 * @param choice `yes` (admin accepted) or `no` (admin declined)
 * @param version the current `optInVersion` to record as acknowledged
 *   (caller has already read this from default + any local override)
 */
export const writeTcAcknowledgement = async (
    stanza: string,
    choice: OptInChoice,
    version: number,
): Promise<void> => {
    const params = new URLSearchParams();
    params.set('optInVersionAcknowledged', String(version));
    params.set('optInChoice', choice);
    params.set('optInChoiceAt', new Date().toISOString());
    const resp = await fetch(stanzaUrl(stanza), {
        method: 'POST',
        credentials: 'same-origin',
        headers: buildMutatingHeaders(),
        body: params.toString(),
    });
    if (!resp.ok) {
        throw new Error(`Acknowledgement conf write failed: HTTP ${resp.status}`);
    }
};
