/**
 * Tier 2 PII redaction for `tier2Summary` categorical aggregates.
 *
 * Maps to OWASP LLM02 (Sensitive Information Disclosure) Appendix D
 * recommendation #10. Closes the last open item in the OWASP LLM Top 10
 * compliance backlog.
 *
 * Why this exists.
 * ----------------
 * Tier 2 elevates the privacy posture from "AI sees count + timing only"
 * to "AI sees aggregated metadata" — top-N categorical values per column,
 * numeric stats per column, and time range. The aggregation already
 * preserves customer privacy in the sense that no raw rows cross the
 * wire; the type system enforces that physically (`Hidden<T>` only
 * widens to `Visible<T>` via `sanitize()`). But the categorical top-N
 * names ARE identifiers — usernames, IPs, MAC addresses, account names,
 * email addresses. For customers under regimes that treat those as PII
 * (named-person behavioral profiles, even when pre-aggregated), Tier 2
 * needs an extra reduction step: replace the value with a stable hash
 * tag while keeping the count. Result: the AI still sees "this column
 * has 7 distinct values, the top one occurred 12 times", but the value
 * names are opaque tokens like `<redacted-3a1b2c4>` instead of `alice`.
 *
 * Stability: the hash is deterministic per (string -> string) — the same
 * input always produces the same tag within a session and across sessions.
 * That preserves cardinality + frequency in the AI's view (top-N counts
 * are real counts, not summaries-of-summaries) without leaking the
 * underlying identifier.
 *
 * Pattern policy: column-NAME based, not value-content based. Column
 * names like `user`, `src_ip`, `dest_ip`, `email` reliably indicate the
 * value class in Splunk-shaped data. Content-based detection (regex over
 * values) would be brittle and have a different false-positive profile.
 * Hostname is opt-in via `redactHostnames` because Splunk dashboards
 * routinely surface hostnames and admins typically expect them to flow
 * to the AI for triage. Default-secure: PII redaction is ON by default.
 *
 * Hash function: FNV-1a 32-bit. NOT cryptographic — `tier2Summary` is
 * synchronous and `crypto.subtle` is async. FNV-1a gives ~1 in 4 billion
 * collisions on random text, which is more than enough to disambiguate
 * 10-50 distinct values per column in a top-N aggregate. Truncated to
 * 7 hex chars (~268M combinations) to keep the tag visually short.
 *
 * Build 94 (session 022). Companion to:
 *   - `sanitizeAggregateValue` — content-side filter for jailbreak
 *      patterns, role markers, and control characters (build 78, LLM04).
 *   - `<TOOL_RESULT_DATA>` sentinel wrapping (build 78, LLM01).
 *   - Type-system Hidden<T> -> Visible<T> chokepoint via sanitize()
 *     (Phase A, the architectural privacy property of the design).
 */

/** Configuration for `redactValueIfPII`. Defaults are conservative —
 *  protect the well-known identifier classes; opt-in for hostnames. */
export interface PiiRedactionOptions {
    /** When true (default), the standard PII patterns are active.
     *  When false, the function is a no-op identity function — used
     *  when the admin has turned redaction OFF in Settings. */
    enabled?: boolean;
    /** When true, also redact `host` / `hostname` columns. Default
     *  false — Splunk dashboards routinely show hostnames and most
     *  admins expect them in the AI's view for triage. */
    redactHostnames?: boolean;
}

/**
 * FNV-1a 32-bit hash, returns 7-char lowercase hex.
 *
 * Synchronous (no async crypto subtle), deterministic, collision-rare
 * enough for top-N aggregates. NOT for security-sensitive contexts —
 * a determined attacker could in principle precompute the hash for a
 * dictionary of names and recover identifiers. The point here is
 * privacy hygiene at the AI-vendor boundary, not adversarial blinding.
 *
 * Pads the result to exactly 7 chars so every tag has the same width.
 */
const fnv1a32Hex7 = (s: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        // FNV prime 0x01000193, kept inside 32-bit range via Math.imul.
        h = Math.imul(h, 0x01000193);
    }
    // Force unsigned, then hex with padStart so short hashes still get
    // a 7-char tag (otherwise `<redacted-1f>` looks weird next to
    // `<redacted-3a1b2c4>`).
    const u = h >>> 0;
    return u.toString(16).padStart(8, '0').slice(0, 7);
};

/**
 * Column-name patterns that mark the column as carrying named-person /
 * named-host identifiers. Anchored to start-of-name OR underscore so
 * `src_user`, `os_user`, `user_email` all match while `username_count`
 * (which is itself a count column, not a value column) does not.
 *
 * The patterns deliberately do NOT cover free-form text columns like
 * `_raw`, `event`, `message` — those are excluded earlier in
 * `tier2Summary` (it skips columns starting with `_` and skips
 * non-categorical content via the numeric/categorical split). If we
 * ever loosen those filters, this list would need to expand.
 */
const PII_PATTERNS_DEFAULT: ReadonlyArray<RegExp> = [
    /(?:^|_)email$/i,
    /(?:^|_)user(?:name)?$/i,
    /(?:^|_)(?:src|source|client|remote|dest|destination)_?ip$/i,
    /(?:^|_)mac(?:_addr)?$/i,
    /(?:^|_)account(?:_name)?$/i,
];

const PII_PATTERNS_HOSTNAMES: ReadonlyArray<RegExp> = [
    /(?:^|_)host(?:name)?$/i,
];

/**
 * Returns true if `columnName` matches one of the configured PII
 * patterns. Cheap (no allocation) — call freely.
 */
export const isPiiColumn = (
    columnName: string,
    opts: PiiRedactionOptions = {},
): boolean => {
    if (opts.enabled === false) return false;
    for (const re of PII_PATTERNS_DEFAULT) {
        if (re.test(columnName)) return true;
    }
    if (opts.redactHostnames) {
        for (const re of PII_PATTERNS_HOSTNAMES) {
            if (re.test(columnName)) return true;
        }
    }
    return false;
};

/**
 * Redact `value` if `columnName` matches a PII pattern. Returns either
 * the original value (column not flagged, or empty value) or a stable
 * tag of the form `<redacted-XXXXXXX>` where XXXXXXX is FNV-1a-7-hex
 * of the value.
 *
 * The tag length is fixed at 18 chars (`<redacted-` + 7 + `>`), so
 * tier2Summary's per-line budget math is predictable: if the original
 * value was longer than 18 chars (the typical case for an FQDN or a
 * full email), the tag is shorter; if shorter (a 4-char username), the
 * tag is longer. Net effect on a typical 160-char line is small — a
 * couple of segments may fall off the end of a top-N when redacted.
 *
 * Empty / whitespace-only values pass through unchanged — there's
 * nothing to identify, and a `<redacted-XXXXXXX>` tag for an empty
 * value would be misleading.
 */
export const redactValueIfPII = (
    columnName: string,
    value: string,
    opts: PiiRedactionOptions = {},
): string => {
    if (opts.enabled === false) return value;
    if (!value || value.trim().length === 0) return value;
    if (!isPiiColumn(columnName, opts)) return value;
    return `<redacted-${fnv1a32Hex7(value)}>`;
};
