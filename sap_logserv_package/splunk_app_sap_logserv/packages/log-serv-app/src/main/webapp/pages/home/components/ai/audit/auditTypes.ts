/**
 * Audit event schema for the AI Assistant.
 *
 * Every event the audit writer sends to Splunk conforms to one of these
 * shapes. Indexed in the `_ai_assistant_audit` index (defined in the
 * splunk_idx_sap_logserv app — see Phase A index app changes).
 *
 * Event categorization (mirrors the chat audit modal in §6.5 of the
 * design doc):
 *   - 🟢 local_only       — canned-prompt one-click, no AI vendor call
 *   - 🟡 vendor_tier1     — free-form question to vendor, no event data
 *   - 🟠 vendor_tier2     — vendor + aggregated metadata (admin opt-in)
 *
 * The shape is deliberately flat — Splunk's auto field extraction
 * handles JSON well and analysts shouldn't need nested traversal.
 */

export type AuditCategory =
    | 'local_only'
    | 'vendor_tier1'
    | 'vendor_tier2'
    /** Security event — SPL static-analysis guard rejected an AI-authored
     *  ad-hoc query. Logged so SOC analysts can review the AI's intent
     *  and the blocked operator. Added in build 79 per OWASP LLM06. */
    | 'security_blocked_spl'
    /** Security event — per-user free-form prompt rate limit was hit.
     *  The user's prompt was refused before any vendor call was made.
     *  Added in build 80 per OWASP LLM10 (Unbounded Consumption). */
    | 'rate_limited_prompt'
    /** Privacy event — admin saved the AI Assistant settings with the
     *  privacy tier transitioning FROM not-2 TO 2 (cloud + aggregated
     *  metadata). Recorded so SOC analysts have a durable trail of
     *  every elevation event. Added in build 83 per OWASP LLM02
     *  (Sensitive Information Disclosure) Appendix D recommendation. */
    | 'vendor_tier2_elevation'
    /** Security event — pre-flight pattern analysis of a user prompt
     *  matched one or more known jailbreak / prompt-injection idioms.
     *  Flag-and-proceed semantics: the prompt still flows to the AI
     *  vendor; the audit event gives SOC observability for post-hoc
     *  review. Added in build 87 per OWASP LLM01 (Prompt Injection)
     *  Appendix D recommendation. */
    | 'user_prompt_jailbreak_flag'
    /** Security event — per-chat-session MCP tool dispatch cap was
     *  reached, refusing further tool calls for the current session.
     *  Defense-in-depth above the per-message MAX_TOOL_TURNS limit.
     *  Added in build 88 per OWASP LLM06 (Excessive Agency)
     *  Appendix D recommendation. */
    | 'session_tool_cap_hit'
    /** Security event — per-user daily vendor spend cap was reached,
     *  refusing the prompt before it reaches the AI vendor. Tally
     *  resets at local midnight. Added in build 89 per OWASP LLM10
     *  (Unbounded Consumption — cost half) Appendix D recommendation. */
    | 'daily_spend_cap_hit'
    /** Privacy/integrity event — admin acknowledged the tamper-resistance
     *  disclaimer at Settings save time while leaving the audit
     *  forwarder disabled. Recorded with the admin's user identity and
     *  (via Splunk's auto-stamped source-IP) network address. Build 98
     *  / session 022. */
    | 'forwarder_disabled_acceptance'
    /** Operational event — the audit forwarder attempted to dual-write
     *  this batch to the configured HEC endpoint and failed. The local
     *  index still has the original events; the failure event provides
     *  off-host divergence detection (when the local has events that
     *  the remote does not have, the remote should also have a record
     *  of THIS failure event explaining the gap). Build 98. */
    | 'audit_forwarder_failure'
    /** Privacy/legal event — admin acknowledged the AI Assistant
     *  feature-enablement liability disclaimer at Settings save time
     *  while flipping the master `enabled` toggle on. Recorded with
     *  user identity, network address (Splunk auto-stamp), timestamp,
     *  disclaimer hash, tcVersion, and yes/no choice. Per Splunk's
     *  standard optInVersion pattern — both choices are recorded.
     *  Build 100 / session 022. */
    | 'ai_assistant_enable_acceptance';

export interface AuditEventBase {
    /** ISO-8601 timestamp client-side (Splunk also stamps _time). */
    timestamp: string;
    /** Splunk username from the session that initiated this event. */
    user: string;
    /** Stable per-tab session ID; lets analysts trace a single chat. */
    sessionId: string;
    /** Per-event sequence within the session (monotonic). */
    seq: number;
    category: AuditCategory;
}

export interface LocalOnlyEvent extends AuditEventBase {
    category: 'local_only';
    /** ID of the predefined prompt that ran (e.g., 'sap_basis.failed_auth_last_hour'). */
    promptId: string;
    /** SPL that was executed (Visible — we authored it). */
    spl: string;
    /** Number of rows returned. */
    rowCount: number;
    /** Execution time in ms. */
    executionMs: number;
    /** Whether the search succeeded. */
    ok: boolean;
}

export interface VendorTier1Event extends AuditEventBase {
    category: 'vendor_tier1';
    /** Provider name (e.g., 'anthropic', 'openai', 'bedrock'). */
    provider: string;
    /** Model ID. */
    model: string;
    /** Number of bytes in the outbound payload. */
    outboundBytes: number;
    /** Hash of the outbound payload (SHA-256, hex). */
    outboundSha256: string;
    /** Length of the user's question. */
    promptLength: number;
    /** Number of tools advertised in the request. */
    toolDefCount: number;
    /** Total input tokens consumed across all AI turns in this user
     *  message (vendor-reported). 0 when the provider doesn't report
     *  usage (currently OpenAI/Azure/Bedrock — pending follow-up).
     *  Build 82 / OWASP LLM10 observability. */
    inputTokens: number;
    /** Total output tokens generated. 0 when not reported. */
    outputTokens: number;
    /** Anthropic-only — cumulative tokens served from prompt cache. */
    cachedInputTokens?: number;
    /** Anthropic-only — cumulative tokens written to prompt cache. */
    cacheCreationInputTokens?: number;
    /** Estimated USD spend for this user message (sum across all turns).
     *  Computed locally from `vendorCost.ts` list pricing — vendor
     *  dashboard is the billing truth. 0 when usage isn't reported. */
    vendorCostEstimateUsd: number;
    /** Number of AI turns this user message consumed (1 if Claude
     *  answered without tool use; up to MAX_TOOL_TURNS otherwise). */
    turnCount: number;
    /** Number of categorical values redacted by `tier2Summary`'s PII
     *  redactor across all tool dispatches in this user message.
     *  Always `0` when `tier === 1` (no Tier 2 aggregation runs) or
     *  when the admin has disabled redaction in Settings. SOC analysts
     *  use this to see how often identifier values are being scrubbed
     *  before vendor egress — a non-zero count means PII was found and
     *  successfully blocked. Build 94 (session 022) per OWASP LLM02. */
    tier2RedactionsApplied?: number;
    /** Whether the user had Power Mode enabled when this prompt was
     *  dispatched. When true, the system primer was augmented with the
     *  forced-saved-search-first rule. SOC analysts can pivot on this
     *  field to audit power-user activity separately from normal
     *  free-form prompts. Build 166 / session 028. */
    powerMode?: boolean;
}

export interface VendorTier2Event extends AuditEventBase {
    category: 'vendor_tier2';
    provider: string;
    model: string;
    outboundBytes: number;
    outboundSha256: string;
    /** What aggregated data shape was sent (e.g., 'top_n_hosts'). */
    aggregateKind: string;
    /** Whether the user explicitly approved this elevation. */
    userApproved: boolean;
    /** Number of distinct values in the aggregate. */
    distinctValueCount: number;
}

/**
 * Security event recorded when the SPL static-analysis guard
 * (`utils/splGuard.ts`) rejects an AI-authored `splunk_run_query`
 * dispatch. The query never reaches MCP / Splunk; instead the AI
 * receives a synthetic error result and (typically) re-strategizes.
 *
 * `spl` is captured verbatim for SOC review — it's AI-authored
 * content sent as a tool argument, so it's already on the outbound-
 * safe side of the privacy boundary.
 */
export interface SecurityBlockedSplEvent extends AuditEventBase {
    category: 'security_blocked_spl';
    /** The AI-authored SPL that was blocked. Truncated at 1000 chars. */
    spl: string;
    /** The forbidden operator that triggered the block (lowercase, no `|`). */
    operator: string;
}

/**
 * Security event recorded when the per-user free-form prompt rate
 * limit refused a `sendUserMessage` call. The prompt never reached
 * the AI vendor; the user got an in-chat notice instead.
 *
 * Added in build 80 per OWASP LLM10 (Unbounded Consumption). Logged
 * so SOC analysts can identify users hitting the limit (which may
 * indicate either legitimate heavy use or abuse / runaway script
 * behavior).
 */
export interface RateLimitedPromptEvent extends AuditEventBase {
    category: 'rate_limited_prompt';
    /** The per-hour threshold in effect when the block fired. */
    threshold: number;
    /** Number of prompts the user fired in the rolling 1-hour window
     *  at the moment of the block (always >= threshold). */
    countInWindow: number;
    /** Length in characters of the user's refused prompt. We do NOT
     *  log the prompt text — only its length, for triage. */
    promptLength: number;
    /** Estimated wait time until the user can fire another prompt
     *  (oldest entry in the window expires). Seconds. */
    secondsUntilNextSlot: number;
}

/**
 * Privacy event recorded when the admin Settings page persists a
 * tier change FROM not-2 TO 2 (i.e. an elevation TO Tier 2 — cloud
 * with aggregated metadata).
 *
 * Fired ONCE per save with that transition shape — not on de-elevation
 * (Tier 2 → Tier 1/0 is a privacy improvement; no audit needed) and
 * not on saves where tier was already 2 and stays 2 (no transition).
 *
 * Posted as a one-off event from the Settings page via
 * `AuditWriter.postOneOff`, so it doesn't depend on the chat session
 * having an active AuditWriter instance.
 *
 * Added in build 83 per OWASP LLM02 (Sensitive Information Disclosure)
 * Appendix D recommendation #7.
 */
export interface VendorTier2ElevationEvent extends AuditEventBase {
    category: 'vendor_tier2_elevation';
    /** The tier the admin moved AWAY FROM (0 or 1). */
    previousTier: 0 | 1;
    /** Always 2 by definition. Captured explicitly for query-friendly
     *  audit searches. */
    newTier: 2;
    /** Active provider at the moment of save (e.g. 'anthropic'). Useful
     *  for SOC analysts correlating elevations against vendor traffic. */
    provider: string;
}

/**
 * Security event recorded when the pre-flight pattern analysis of a
 * user prompt matches one or more known jailbreak / prompt-injection
 * idioms. Flag-and-proceed semantics: the prompt still flows to the
 * AI vendor (avoiding regex false-positives blocking legitimate
 * investigative queries). The audit event lets SOC analysts review
 * for unusual patterns post-hoc.
 *
 * The prompt text is NEVER stored — only its SHA-256 hash, length,
 * matched-pattern-group names, and a character-class fingerprint.
 *
 * Added in build 87 per OWASP LLM01 (Prompt Injection) Appendix D
 * recommendation #11.
 */
export interface UserPromptJailbreakFlagEvent extends AuditEventBase {
    category: 'user_prompt_jailbreak_flag';
    /** SHA-256 hex of the user's prompt — for cross-event correlation
     *  without storing the prompt itself. Empty string if crypto.subtle
     *  is unavailable in the browser context (non-HTTPS dev). */
    promptHash: string;
    /** Length of the prompt in characters. */
    promptLength: number;
    /** Pattern-group names that matched (e.g. 'role_redefinition',
     *  'persona_shift', 'system_prompt_leak', 'control_token',
     *  'long_base64_blob'). One prompt can match multiple groups. */
    matchedGroups: string[];
    /** Character-class breakdown — useful for spotting obfuscated
     *  prompts (very low alpha %, very high other %). Percentages sum
     *  to ~100. */
    charClassFingerprint: {
        alpha: number;
        digit: number;
        space: number;
        other: number;
    };
}

/**
 * Security event recorded when the per-chat-session MCP tool dispatch
 * counter reached the configured cap. The current and any subsequent
 * dispatches in the same session are refused; the user receives an
 * in-chat notice explaining the cap and how to reset (clear chat).
 *
 * Defense-in-depth above the per-message `MAX_TOOL_TURNS = 8` limit.
 * A runaway session that repeatedly hits the per-message cap across
 * many user messages would still be bounded by this session-level
 * cap — useful for detecting (and stopping) accidental loops or
 * adversarial automation.
 *
 * Added in build 88 per OWASP LLM06 (Excessive Agency) Appendix D
 * recommendation #12.
 */
export interface SessionToolCapHitEvent extends AuditEventBase {
    category: 'session_tool_cap_hit';
    /** The configured cap that was reached (e.g. 100). */
    cap: number;
    /** The total tool dispatches attempted in the session, including
     *  the one that triggered the refusal. Always > cap. */
    attemptedCount: number;
    /** The tool name the AI was attempting to dispatch when the cap
     *  fired (`splunk_run_saved_search` or `splunk_run_query`). */
    toolName: string;
}

/**
 * Security event recorded when a user's daily vendor spend tally
 * reached the configured cap and a free-form prompt was refused
 * before reaching the AI vendor. Tally resets at local midnight.
 *
 * Companion to `RateLimitedPromptEvent` — that bounds prompt VOLUME
 * per hour, this bounds USD COST per day. Both apply to free-form
 * `sendUserMessage`; predefined-prompt executions don't accumulate
 * spend.
 *
 * The tally is built from the per-turn `vendorCostEstimateUsd`
 * captured in `VendorTier1Event` (build 82 + build 86). It includes
 * vendor-reported tokens converted via `utils/vendorCost.ts` list
 * pricing — list prices, not actual billing, but a tight enough
 * approximation for cap enforcement.
 *
 * Added in build 89 per OWASP LLM10 (Unbounded Consumption) Appendix
 * D recommendation #9.
 */
export interface DailySpendCapHitEvent extends AuditEventBase {
    category: 'daily_spend_cap_hit';
    /** Configured daily cap in USD (e.g. 50.00). */
    capUsd: number;
    /** User's spend tally for today AT THE TIME OF THE BLOCK. Always
     *  >= capUsd. */
    spentTodayUsd: number;
    /** Length of the refused prompt in characters. We do NOT log the
     *  prompt text — only its length, for triage. */
    promptLength: number;
    /** Whole seconds until local midnight (when the tally resets). */
    secondsUntilMidnight: number;
}

/**
 * Acknowledgement event written when the admin saves the Settings page
 * with `audit_forwarder_enabled = false`. The admin is required to
 * tick a checkbox confirming they understand:
 *
 *   - The local `_ai_assistant_audit` index is the only copy of audit
 *     events while the forwarder is disabled.
 *   - A host-root admin can edit bucket files directly, so the index
 *     is not tamper-evident on its own.
 *   - They will not edit, delete, or otherwise tamper with the index.
 *   - This acknowledgement is recorded with their administrator
 *     account name, network address, and timestamp.
 *
 * Network address comes from Splunk's auto-stamped `host` field on the
 * indexed event (the source IP of the receivers/simple POST). The
 * payload below intentionally does NOT include the IP — Splunk's
 * standard ingestion path captures it.
 *
 * Build 98 / session 022. Companion to `AuditForwarderFailureEvent`.
 */
export interface ForwarderDisabledAcceptanceEvent extends AuditEventBase {
    category: 'forwarder_disabled_acceptance';
    /** ISO-8601 timestamp of the admin's interaction (Submit OR Cancel). */
    acceptedAt: string;
    /** SHA-256 hex of the disclaimer text the admin saw, so future
     *  audit reviewers can prove WHICH revision of the disclaimer
     *  was acknowledged. */
    disclaimerHash: string;
    /** Active provider at the moment of save (e.g. 'anthropic'). Useful
     *  for correlating acceptance events with subsequent vendor
     *  traffic. */
    provider: string;
    /** The previous `audit_forwarder_enabled` state — useful for
     *  distinguishing "fresh-install acceptance" (was already false)
     *  from "deliberate disable" (was true, now false). */
    previousEnabledState: boolean;
    /** Version of the disclaimer the admin acknowledged (matches
     *  `optInVersion` in `default/ai_assistant_acks.conf [logserv-ai-assistant-tc]`).
     *  Cross-correlates with the conf state for compliance review.
     *  Build 99 / session 022. */
    tcVersion: number;
    /** Admin's binary acceptance answer — `yes` if Submit, `no` if
     *  Cancel. Per Splunk's optInVersion pattern, both choices are
     *  recorded; the version is bumped on either. Build 99. */
    optInChoice: 'yes' | 'no';
}

/**
 * Operational event recorded when the audit forwarder dual-write to
 * the configured HEC endpoint failed. Local index still has the
 * original events; this event is the off-host divergence signal.
 *
 * Failure modes captured: HTTP non-2xx, network error, CORS rejection,
 * fetch throw. We do NOT retry — retries can amplify a transient
 * outage into a flood. The next batch's success will produce a normal
 * remote record; SOC analysts can use the timestamps + sequence
 * numbers to identify the affected window.
 *
 * To prevent infinite recursion, this event itself is NEVER forwarded
 * — the AuditWriter checks the category before adding to the HEC
 * batch.
 *
 * Build 98 / session 022.
 */
export interface AuditForwarderFailureEvent extends AuditEventBase {
    category: 'audit_forwarder_failure';
    /** Number of events in the batch that failed to forward. */
    batchSize: number;
    /** Reason — "http_<status>", "network_error", "no_token",
     *  "fetch_threw", etc. */
    reason: string;
    /** Destination URL stripped of query string + auth. For triage
     *  without exposing the token. */
    destinationUrl: string;
}

/**
 * AI Assistant feature-enablement liability acknowledgement event.
 * Recorded when the admin saves the Settings page with `enabled = true`
 * and interacts with the legal-liability acknowledgement modal — yes
 * (Submit) or no (Cancel). Per Splunk's optInVersion pattern, both
 * choices are recorded, the version is bumped on either, and bumping
 * `optInVersion` in `default/ai_assistant_acks.conf [logserv-ai-assistant-enable-tc]`
 * forces re-acknowledgement on next save where `enabled = true`.
 *
 * Network address is Splunk-auto-stamped via the `host` field on the
 * indexed event (the source IP of the receivers/simple POST).
 *
 * Distinct category from `forwarder_disabled_acceptance` — both
 * acknowledgements may apply at the same time on a fresh install,
 * but they cover different legal subjects: data egress liability
 * (this event) vs. tamper-resistance of the local audit index
 * (forwarder_disabled_acceptance).
 *
 * Build 100 / session 022.
 */
export interface AiAssistantEnableAcceptanceEvent extends AuditEventBase {
    category: 'ai_assistant_enable_acceptance';
    /** ISO-8601 timestamp of the admin's interaction. */
    acceptedAt: string;
    /** SHA-256 hex of the disclaimer text the admin saw, so future
     *  audit reviewers can prove WHICH revision was acknowledged. */
    disclaimerHash: string;
    /** Active provider at the moment of save (e.g. 'anthropic'). The
     *  liability disclaimer covers all configurable providers, but
     *  cross-correlation with subsequent vendor traffic uses this. */
    provider: string;
    /** Was AI Assistant ENABLED before this save? Distinguishes
     *  fresh-install / first-time-enable from a re-acknowledgement
     *  prompted by a `optInVersion` bump. */
    previousEnabledState: boolean;
    /** Version of the disclaimer the admin acknowledged (matches
     *  `optInVersion` in `default/ai_assistant_acks.conf
     *  [logserv-ai-assistant-enable-tc]`). */
    tcVersion: number;
    /** Admin's binary acceptance answer — `yes` if Submit, `no` if
     *  Cancel. Per Splunk's optInVersion pattern, both choices are
     *  recorded. */
    optInChoice: 'yes' | 'no';
}

export type AuditEvent =
    | LocalOnlyEvent
    | VendorTier1Event
    | VendorTier2Event
    | SecurityBlockedSplEvent
    | RateLimitedPromptEvent
    | VendorTier2ElevationEvent
    | UserPromptJailbreakFlagEvent
    | SessionToolCapHitEvent
    | DailySpendCapHitEvent
    | ForwarderDisabledAcceptanceEvent
    | AuditForwarderFailureEvent
    | AiAssistantEnableAcceptanceEvent;
