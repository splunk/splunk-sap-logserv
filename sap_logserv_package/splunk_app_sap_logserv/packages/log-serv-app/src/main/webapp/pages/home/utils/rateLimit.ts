/**
 * rateLimit — per-user free-form prompt rate limiter for the AI Assistant.
 *
 * Mitigates OWASP LLM10 (Unbounded Consumption). One user firing prompts
 * in a tight loop (manually or via a runaway script) can rack up
 * meaningful vendor cost AND exhaust the customer's API quota for
 * every other user. This module enforces a configurable rolling
 * 1-hour window per Splunk username.
 *
 * Storage: `localStorage.logserv.aiAssistant.rateLimit.<sanitizedUser>`
 * holds a JSON array of unix-millisecond timestamps. Pruned on every
 * read so the array never grows unbounded across sessions.
 *
 * Caveats (acknowledged):
 *   - localStorage is per-browser, not per-user across browsers.
 *     A user with two browsers / two devices could double the limit.
 *     Server-side enforcement (via Splunk audit log query) is a
 *     follow-up — current design assumes good-faith users + a
 *     defense-in-depth threshold above the legitimate use rate.
 *   - localStorage is clearable by the user. The audit event still
 *     fires on every block, so SOC analysts see the attempt even if
 *     the user clears state and retries.
 *   - Predefined-prompt (Browse prompts) executions are NOT counted —
 *     they bypass the AI vendor entirely and are bounded by Splunk's
 *     own search-quota controls.
 *
 * Added in build 80 / session 019.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

const storageKeyFor = (user: string): string => {
    // Sanitize the username for safe localStorage key construction.
    // Splunk usernames are typically ASCII but can contain `@`, `.`,
    // hyphens. We allow alphanumeric, dot, hyphen, underscore, @ and
    // replace anything else with `_`.
    const safe = user.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 80) || 'anonymous';
    return `logserv.aiAssistant.rateLimit.${safe}`;
};

interface ReadResult {
    timestamps: number[];
    storageError: boolean;
}

/** Read + prune the user's window. Returns the pruned array AND a flag
 *  indicating whether storage was unreachable (private browsing /
 *  storage quota exceeded / disabled). When storage is unreachable
 *  we fail OPEN — better to allow a prompt than to lock a user out
 *  of the assistant entirely because of a browser-side issue. */
const readWindow = (user: string): ReadResult => {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(storageKeyFor(user));
    } catch {
        return { timestamps: [], storageError: true };
    }
    if (raw === null) return { timestamps: [], storageError: false };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Corrupt entry — treat as empty
        return { timestamps: [], storageError: false };
    }
    if (!Array.isArray(parsed)) return { timestamps: [], storageError: false };
    const cutoff = Date.now() - WINDOW_MS;
    const fresh: number[] = [];
    for (const v of parsed) {
        if (typeof v === 'number' && Number.isFinite(v) && v > cutoff) {
            fresh.push(v);
        }
    }
    return { timestamps: fresh, storageError: false };
};

/** Write the pruned window back. Silent no-op on storage failure. */
const writeWindow = (user: string, timestamps: number[]): void => {
    try {
        window.localStorage.setItem(
            storageKeyFor(user),
            JSON.stringify(timestamps),
        );
    } catch { /* private browsing / quota — fail silent */ }
};

export interface RateLimitDecision {
    /** True if the prompt is allowed to proceed. */
    allowed: boolean;
    /** Threshold in effect (echoed back from input). */
    threshold: number;
    /** Number of prompts in the rolling window AT THE TIME OF THE
     *  CHECK (excluding the current one). */
    countInWindow: number;
    /** Whole seconds until the oldest entry in the window expires —
     *  meaningful only when `allowed === false`. */
    secondsUntilNextSlot: number;
    /** Free-form message suitable for a chat system_notice when
     *  blocked. Empty string when allowed. */
    message: string;
}

/**
 * Decide whether a free-form prompt is allowed to proceed for the given
 * user under the given per-hour threshold.
 *
 *   - threshold === 0 → unlimited (always allowed; no recording).
 *   - threshold > 0    → enforce rolling 1-hour window. If allowed,
 *                        records the current timestamp; if blocked,
 *                        does NOT record (so a flurry of blocked
 *                        attempts doesn't push the window forward).
 *
 * Pure-ish: reads + writes localStorage as a side effect. Idempotent
 * within a single Date.now() tick.
 */
export const checkAndRecordPrompt = (
    user: string,
    threshold: number,
): RateLimitDecision => {
    if (!Number.isFinite(threshold) || threshold <= 0) {
        return {
            allowed: true,
            threshold: 0,
            countInWindow: 0,
            secondsUntilNextSlot: 0,
            message: '',
        };
    }

    const { timestamps } = readWindow(user);
    const count = timestamps.length;

    if (count >= threshold) {
        const oldest = Math.min(...timestamps);
        const expiresAt = oldest + WINDOW_MS;
        const secondsUntilNextSlot = Math.max(
            0,
            Math.ceil((expiresAt - Date.now()) / 1000),
        );
        const minutes = Math.ceil(secondsUntilNextSlot / 60);
        const wait =
            minutes >= 60
                ? `${Math.ceil(minutes / 60)}h`
                : minutes >= 2
                  ? `${minutes} minutes`
                  : `${secondsUntilNextSlot} seconds`;
        return {
            allowed: false,
            threshold,
            countInWindow: count,
            secondsUntilNextSlot,
            message:
                `Rate limit reached: ${count} free-form prompts in the last hour ` +
                `(threshold: ${threshold}/hour). Wait approximately ${wait} for ` +
                `the oldest prompt to age out, or ask an admin to raise ` +
                `\`rate_limit_per_hour\` in the AI Assistant settings.`,
        };
    }

    // Allowed — record the current timestamp.
    timestamps.push(Date.now());
    writeWindow(user, timestamps);
    return {
        allowed: true,
        threshold,
        countInWindow: count + 1,
        secondsUntilNextSlot: 0,
        message: '',
    };
};

/** Test-only — clear a user's window. Useful for smoke tests and the
 *  admin UI's "reset my counter" affordance (deferred to a future build). */
export const clearWindow = (user: string): void => {
    try {
        window.localStorage.removeItem(storageKeyFor(user));
    } catch { /* fail silent */ }
};
