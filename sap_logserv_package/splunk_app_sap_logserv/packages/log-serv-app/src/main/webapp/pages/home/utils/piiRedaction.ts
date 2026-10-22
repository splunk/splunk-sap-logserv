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
 * needs an extra reduction step: replace the value with a tag while
 * keeping the count. Result: the AI still sees "this column has 7
 * distinct values, the top one occurred 12 times", but the value names
 * are opaque tokens like `<redacted-3a1b2c4>` instead of `alice`.
 *
 * The tag (build 377): `<redacted-` + the first 7 hex digits of
 * HMAC-SHA-256(key, value) + `>`. The KEY is the chat session's: 32 random
 * bytes per conversation (`chatTagKey`, by the AI Assistant provider's
 * session id; kept in memory only; a new key when the chat is cleared,
 * `rotateChatTagKey`), which the hook passes as `tagKey`. The key belongs
 * to the conversation, not to the chat panel, so closing and reopening the
 * panel keeps it. So the same value
 * gets the same tag within a chat session - cardinality and frequency
 * survive, and the model can count and compare tags - while tags of
 * different sessions cannot be linked, and nobody without the key can
 * reverse a tag by hashing candidate values (every IPv4 address, short user
 * names, SAP standard users). Without a `tagKey` the module's own random
 * key, made once per page load, is used: there is no unkeyed path. Until
 * build 376 the tag was an unsalted 28-bit FNV-1a hash, which anyone could
 * reverse offline.
 *
 * HMAC is computed synchronously with @noble/hashes (audited, already in
 * the dependency tree): `tier2Summary` is synchronous, and `crypto.subtle`
 * is both asynchronous and missing on plain-HTTP Splunk Web (it needs a
 * secure context). `crypto.getRandomValues`, which makes the key, works in
 * every context.
 *
 * Pattern policy: column-NAME based, not value-content based. Column
 * names like `user`, `src_ip`, `dest_ip`, `email` reliably indicate the
 * value class in Splunk-shaped data. Content-based detection (regex over
 * values) would be brittle and have a different false-positive profile.
 * Hostname is opt-in via `redactHostnames` because Splunk dashboards
 * routinely surface hostnames and admins typically expect them to flow
 * to the AI for triage. Default-secure: PII redaction is ON by default.
 * The App's own field names are also classified one by one
 * (utils/fieldClassification.ts); these patterns are the fallback for
 * every other name.
 *
 * Build 94 (session 022). Companion to:
 *   - `sanitizeAggregateValue` — content-side filter for jailbreak
 *      patterns, role markers, and control characters (build 78, LLM04).
 *   - `<TOOL_RESULT_DATA>` sentinel wrapping (build 78, LLM01).
 *   - Type-system Hidden<T> -> Visible<T> chokepoint via sanitize()
 *     (Phase A, the architectural privacy property of the design).
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

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
    /** Build 377: the key of the redaction tag - the chat session's
     *  (`chatTagKey`). At least TAG_KEY_MIN_BYTES bytes; a missing or
     *  shorter key falls back to the module's own random key. */
    tagKey?: Uint8Array;
}

/** The length of a key `newTagKey` makes. */
export const TAG_KEY_BYTES = 32;

/** The shortest `tagKey` used as given. */
export const TAG_KEY_MIN_BYTES = 16;

/** The hex digits of the HMAC kept in a tag. */
export const TAG_HEX_DIGITS = 7;

/**
 * A new random tag key: TAG_KEY_BYTES bytes from `crypto.getRandomValues`,
 * which every browser provides in every context, plain HTTP included (and
 * Node from 19 on). Where it is missing, a weaker generator fills the key -
 * still keyed, never the unkeyed hash.
 */
export const newTagKey = (): Uint8Array => {
    const key = new Uint8Array(TAG_KEY_BYTES);
    const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto : undefined);
    if (c && typeof c.getRandomValues === 'function') {
        c.getRandomValues(key);
    } else {
        for (let i = 0; i < key.length; i += 1) key[i] = Math.floor(Math.random() * 256);
    }
    return key;
};

/** The key used when a caller passes none: random, made once per page load. */
const MODULE_TAG_KEY: Uint8Array = newTagKey();

/**
 * The tag keys of the chat conversations, by conversation id (the AI
 * Assistant provider's session id, one per browser tab), in memory only.
 * The key belongs to the conversation, not to a hook instance: the side
 * panel unmounts the chat when it closes while the conversation - with the
 * tags already sent to the vendor - lives on in the provider, so a reopened
 * panel must tag the same value the same way.
 */
const CHAT_TAG_KEYS = new Map<string, Uint8Array>();

/** The tag key of a conversation: made on first use, the same on every later call. */
export const chatTagKey = (conversationId: string): Uint8Array => {
    const id = String(conversationId);
    let key = CHAT_TAG_KEYS.get(id);
    if (key === undefined) {
        key = newTagKey();
        CHAT_TAG_KEYS.set(id, key);
    }
    return key;
};

/** A new tag key for a conversation: its chat was cleared, a new chat session begins. */
export const rotateChatTagKey = (conversationId: string): Uint8Array => {
    const key = newTagKey();
    CHAT_TAG_KEYS.set(String(conversationId), key);
    return key;
};

const keyOf = (key?: Uint8Array): Uint8Array =>
    (key instanceof Uint8Array && key.length >= TAG_KEY_MIN_BYTES ? key : MODULE_TAG_KEY);

/** The first `n` hex digits of a byte string. */
const hexDigits = (bytes: Uint8Array, n: number): string => {
    let out = '';
    for (let i = 0; out.length < n && i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
    return out.slice(0, n);
};

/**
 * The redaction tag of a value under a key: `<redacted-` + the first
 * TAG_HEX_DIGITS hex digits of HMAC-SHA-256(key, UTF-8 value) + `>`.
 */
export const redactionTag = (value: string, key?: Uint8Array): string =>
    `<redacted-${hexDigits(hmac(sha256, keyOf(key), value), TAG_HEX_DIGITS)}>`;

/**
 * Column-name patterns that mark the column as carrying named-person /
 * named-host identifiers. Anchored to start-of-name or a separator (`_`,
 * `.`, `:`, `-` or, from build 377, a space) so `src_user`, `os_user`,
 * `user_email`, the dotted CIM and JSON names `Authentication.user`,
 * `All_Traffic.src_ip`, `event.user` and display names such as
 * `"User Name"` or `"Client IP"` all match while `username_count` (which
 * is itself a count column, not a value column) does not.
 *
 * The patterns deliberately do NOT cover free-form text columns like
 * `_raw`, `event`, `message` — those are excluded earlier in
 * `tier2Summary` (it skips columns starting with `_` and skips
 * non-categorical content via the numeric/categorical split). If we
 * ever loosen those filters, this list would need to expand.
 *
 * Build 376 (session 149, round 7): plurals (`new_users`, `client_ips`,
 * `emails`, `hosts` with the hostname opt-in), `remote_addr`-style
 * addresses, and camelCase `...User` / `...UserName` / `...Email`
 * (Windows `TargetUserName`) - the App's own catalog columns that hold
 * identifiers. A count column with such a name (`dc(host) AS
 * affected_hosts`) is told apart by vendorColumnText, not here.
 *
 * Round 8: the separator anchor takes `.`, `:` and `-` as well as `_`
 * (data-model and JSON names), and the CIM `src`, `dest` and `dvc` - bare,
 * plural, `_host`, and after a separator (`fw_src`, `All_Traffic.dest`) -
 * are identifiers by default: the App's own props.conf puts client IP
 * addresses and host names into `src` and `dest`.
 *
 * Build 377: every `*_ip`, `*_addr` and `*_address` and a bare `ip`
 * (`peer_ip`, `local_ip`, `icm_peer_ip`, `remote_address`), `user_name`
 * and `User Name`, a bare `peer`, `dst` (`fw_dst`), and a space as a
 * separator. Security review of build 377: camelCase addresses (Windows
 * `IpAddress`, `IPAddress`, `MacAddress`), `Account Name` with a space,
 * and - with the hostname opt-in - `host_name` / `Host Name` and Windows
 * `WorkstationName` / `HostName` / `ComputerName`.
 */
const PII_PATTERNS_DEFAULT: ReadonlyArray<RegExp> = [
    /(?:^|[_.:\s-])emails?$/i,
    /(?:^|[_.:\s-])user(?:[_\s]?name)?s?$/i,
    /(?:^|[_.:\s-])(?:src|source|client|remote|dest|destination|dvc)_?(?:ip|addr)s?$/i,
    /(?:^|[_.:\s-])(?:ip|addr|address)(?:es|s)?$/i,
    /(?:^|[_.:\s-])(?:src|dest|dst|dvc)(?:_host)?s?$/i,
    /(?:^|[_.:\s-])peers?$/i,
    /(?:^|[_.:\s-])mac(?:_addr)?$/i,
    /(?:^|[_.:\s-])account(?:[_\s]?name)?$/i,
    /[a-z0-9](?:User|UserName|Email)s?$/,
    /(?:^|[a-z0-9])(?:Ip|IP|Mac|MAC)?Address(?:es)?$/,
];

const PII_PATTERNS_HOSTNAMES: ReadonlyArray<RegExp> = [
    /(?:^|[_.:\s-])host(?:[_\s]?name)?s?$/i,
    /(?:^|[a-z0-9])(?:Workstation|Host|Computer|Machine)Names?$/,
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
 * the original value (column not flagged, or empty value) or the tag
 * `<redacted-XXXXXXX>` of the value under `opts.tagKey` (`redactionTag`).
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
    return redactionTag(value, opts.tagKey);
};

/**
 * SS16.6/SS16.8a-29 (build 315) — VALUE-CONTENT redaction for free text, the
 * capability this module deliberately did not have before: the opt-in raw
 * event samples put whole `_raw` strings into a vendor-bound PDF, so the
 * app's PII policy (usernames and emails never leave in clear) has to be
 * applied inside the text, not by column name.
 *
 * Scope is DELIBERATELY narrow: email addresses, and `user=<x>`-shaped
 * assignments (the same column-name family `PII_COLUMN_PATTERNS` flags),
 * replaced with the redaction tag so cardinality survives. Hostnames and
 * IP addresses are NOT touched — they are the envelope evidence the sample
 * exists to show, and the report banner says so in as many words. Credential
 * shapes are handled separately by `scrubPaste` (diagIngestFacts), which the
 * sample path runs FIRST.
 *
 * Build 377: the tags are keyed (`redactionTag`): the caller passes one key
 * per report (utils/diagEvidence.ts makes a new one for each sample
 * collection), so a value keeps one tag within a report and tags cannot be
 * reversed by hashing candidates. Without a key, the module's own random key.
 */
export const redactFreeTextPii = (text: string, key?: Uint8Array): string => {
    /* §20.8a-3 — BOUNDED quantifiers. The unbounded `+` local part is
     * quadratic on any long run of local-part-legal characters with no '@'
     * (measured 12.4 s on a 100 K base64/hex run vs 34 ms bounded), and
     * full-length raw samples now feed this exactly that shape. RFC 5321
     * caps the local part at 64 and the domain at 255, so real addresses
     * redact byte-identically. */
    let out = text.replace(
        /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g,
        (m) => redactionTag(m, key),
    );
    out = out.replace(
        /((?:^|[^A-Za-z0-9_])(?:src_|dest_|target_|auth_|executing_)?user(?:name)?["']?\s*[:=]\s*)(["']?)([^"',;\s]+)\2/gi,
        (_m, prefix: string, q: string, v: string) =>
            `${prefix}${q}${redactionTag(v, key)}${q}`,
    );
    return out;
};
