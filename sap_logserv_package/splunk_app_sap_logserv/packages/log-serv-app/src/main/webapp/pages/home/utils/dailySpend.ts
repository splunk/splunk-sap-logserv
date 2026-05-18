/**
 * dailySpend — per-user daily AI vendor spend tally for the AI Assistant.
 *
 * Mitigates OWASP LLM10 (Unbounded Consumption) — the cost half. While
 * the rate limit (rateLimit.ts) caps prompt VOLUME per hour, this caps
 * per-day USD SPEND across all of a user's prompts (which matters for
 * Opus-4.7-grade models where one large investigative prompt can cost
 * a dollar or more in tokens).
 *
 * Builds on the per-turn `vendorCostEstimateUsd` captured by the audit
 * pipeline (build 82 for Anthropic + Mock; build 86 for OpenAI + Azure
 * + Bedrock).
 *
 * Storage: `localStorage.logserv.aiAssistant.dailySpend.<sanitizedUser>`
 * holds JSON `{ date: 'YYYY-MM-DD', spentUsd: number }`. The date field
 * is in the user's LOCAL timezone (calendar day) — auto-resets when the
 * stored date doesn't match today.
 *
 * Caveats (acknowledged):
 *   - localStorage is per-browser, not per-user across browsers. A user
 *     with two browsers / two devices could double the cap. Server-side
 *     enforcement via Splunk audit log query is a follow-up.
 *   - localStorage is clearable. The audit event still fires on every
 *     block, so SOC analysts see the attempt even if state is cleared.
 *   - Cost is recorded AFTER the prompt completes. A user can therefore
 *     go 1 prompt OVER cap before being locked out — the prompt that
 *     pushed them over still counts. Subsequent prompts are refused
 *     until the next local-calendar-day rollover.
 *   - Predefined-prompt (Browse prompts) executions don't accumulate
 *     spend (they bypass the AI vendor entirely).
 *
 * Added in build 89 / session 020.
 */

const storageKeyFor = (user: string): string => {
    const safe = user.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 80) || 'anonymous';
    return `logserv.aiAssistant.dailySpend.${safe}`;
};

/** YYYY-MM-DD in the browser's local timezone. */
const todayDateString = (): string => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
};

interface DailyTally {
    date: string;
    spentUsd: number;
}

/** Read the stored tally for `user`. Returns a fresh-zero tally for
 *  today when the stored entry is missing, malformed, or for a prior
 *  date (auto-resets on calendar rollover). */
const readTally = (user: string): DailyTally => {
    const today = todayDateString();
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(storageKeyFor(user));
    } catch {
        return { date: today, spentUsd: 0 };
    }
    if (raw === null) return { date: today, spentUsd: 0 };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { date: today, spentUsd: 0 };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { date: today, spentUsd: 0 };
    }
    const obj = parsed as { date?: unknown; spentUsd?: unknown };
    if (typeof obj.date !== 'string' || obj.date !== today) {
        return { date: today, spentUsd: 0 };
    }
    const spent = typeof obj.spentUsd === 'number' && Number.isFinite(obj.spentUsd)
        ? Math.max(0, obj.spentUsd)
        : 0;
    return { date: today, spentUsd: spent };
};

const writeTally = (user: string, tally: DailyTally): void => {
    try {
        window.localStorage.setItem(storageKeyFor(user), JSON.stringify(tally));
    } catch { /* private browsing / quota — fail silent */ }
};

export interface DailySpendDecision {
    /** True if the prompt is allowed to proceed. */
    allowed: boolean;
    /** Cap in USD (echoed back from input). */
    capUsd: number;
    /** Total spend tally for today AT THE TIME OF THE CHECK. */
    spentTodayUsd: number;
    /** Whole seconds until local-midnight (when the tally resets). */
    secondsUntilMidnight: number;
    /** Free-form message suitable for an in-chat system_notice when
     *  blocked. Empty when allowed. */
    message: string;
}

const computeSecondsUntilMidnight = (): number => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
};

/**
 * Decide whether a free-form prompt is allowed to proceed for the given
 * user under the given per-day USD cap.
 *
 *   - capUsd <= 0   → unlimited (always allowed; no recording).
 *   - capUsd > 0    → allowed if `spentToday < cap`. Does NOT record
 *                     the prompt's cost — that happens via
 *                     `recordSpend` after the vendor call completes
 *                     and the actual cost is known.
 */
export const checkDailySpend = (
    user: string,
    capUsd: number,
): DailySpendDecision => {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
        return {
            allowed: true,
            capUsd: 0,
            spentTodayUsd: 0,
            secondsUntilMidnight: 0,
            message: '',
        };
    }
    const tally = readTally(user);
    if (tally.spentUsd >= capUsd) {
        const secondsUntilMidnight = computeSecondsUntilMidnight();
        const hours = Math.ceil(secondsUntilMidnight / 3600);
        const wait = hours >= 2 ? `${hours} hours` : `${Math.ceil(secondsUntilMidnight / 60)} minutes`;
        return {
            allowed: false,
            capUsd,
            spentTodayUsd: tally.spentUsd,
            secondsUntilMidnight,
            message:
                `Daily AI spend cap reached: $${tally.spentUsd.toFixed(4)} of ` +
                `$${capUsd.toFixed(2)} cap. Resets at local midnight (about ` +
                `${wait}), or ask an admin to raise ` +
                `\`daily_spend_cap_usd\` in the AI Assistant settings.`,
        };
    }
    return {
        allowed: true,
        capUsd,
        spentTodayUsd: tally.spentUsd,
        secondsUntilMidnight: 0,
        message: '',
    };
};

/**
 * Record a vendor cost against the user's daily tally. Call once per
 * `vendor_tier1` audit event with the same `vendorCostEstimateUsd` value.
 *
 * Idempotent within a Date.now() tick is NOT guaranteed — caller should
 * ensure they invoke this exactly once per completed prompt.
 *
 * costUsd values that aren't finite or are non-positive are ignored
 * (the vendorCostEstimateUsd can be 0 for the Mock provider or for
 * unpriced models — recording 0 is harmless, recording NaN/-Inf would
 * corrupt the tally).
 */
export const recordSpend = (user: string, costUsd: number): void => {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const current = readTally(user);
    writeTally(user, {
        date: current.date,
        spentUsd: current.spentUsd + costUsd,
    });
};

/** Test-only — clear a user's daily tally. Useful for smoke tests and
 *  the admin UI's "reset my spend" affordance (deferred to future). */
export const clearTally = (user: string): void => {
    try {
        window.localStorage.removeItem(storageKeyFor(user));
    } catch { /* fail silent */ }
};
