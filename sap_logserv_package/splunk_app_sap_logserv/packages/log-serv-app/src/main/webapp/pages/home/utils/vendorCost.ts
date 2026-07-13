/**
 * vendorCost — per-token list pricing for AI vendor models.
 *
 * Used by the audit pipeline (LLM10 observability) to compute a
 * `vendorCostEstimateUsd` field per assistant turn. Estimates only —
 * actual billing is the vendor dashboard's truth.
 *
 * Numbers are USD-per-million-tokens, taken from public list pricing
 * pages; refreshed session 079 / build 275 (July 2026). Update as
 * vendors revise.
 *
 * Cache pricing (Anthropic only):
 *   - `cachedInput` (cache HIT) — typically ~10% of base input rate
 *   - `cacheCreation` (cache WRITE) — typically ~125% of base input rate
 *   When a model entry omits these, callers fall back to the base
 *   `input` rate for both fields.
 *
 * The `unknown` model entry is the safe fallback: zero cost when the
 * model id isn't in the table. Better to under-report than over-report
 * a fake cost the customer might budget against.
 *
 * DYNAMIC MODEL DISCOVERY (session 079): the model picker can now show
 * vendor-DISCOVERED ids beyond this table. That deliberately does NOT
 * change this module — lookup stays exact-id keyed with NO prefix
 * matching or price guessing. A discovered model with no entry here
 * gets a $0 estimate in the token-usage audit event (honest "cost
 * unknown"), never a prefix-guessed wrong number. Admins standardizing
 * on a discovered model can add its entry here (or ask us to) in the
 * next release.
 */

export interface ModelPricing {
    /** USD per 1M input tokens. */
    input: number;
    /** USD per 1M output tokens. */
    output: number;
    /** USD per 1M cached input tokens (Anthropic prompt-cache reads). */
    cachedInput?: number;
    /** USD per 1M cache-creation input tokens (Anthropic prompt-cache writes). */
    cacheCreation?: number;
}

/**
 * Model id → pricing. Add entries here as new models ship. Lookup uses
 * the exact model id (no prefix matching) so ambiguous strings like
 * `claude-opus` (without version) get the `unknown` zero-cost fallback
 * rather than a stale price.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
    // Anthropic — Claude 4.x/5 families. List pricing refreshed session
    // 079 (July 2026): Opus-tier is $5/$25 (the earlier $15/$75 entry
    // for opus-4-7 was stale), Sonnet-tier $3/$15, Haiku 4.5 $1/$5.
    // Both the dated and undated Haiku ids are listed since discovery
    // can surface either form.
    'claude-opus-4-8': { input: 5.0, output: 25.0, cachedInput: 0.5, cacheCreation: 6.25 },
    'claude-opus-4-7': { input: 5.0, output: 25.0, cachedInput: 0.5, cacheCreation: 6.25 },
    'claude-opus-4-6': { input: 5.0, output: 25.0, cachedInput: 0.5, cacheCreation: 6.25 },
    'claude-sonnet-5': { input: 3.0, output: 15.0, cachedInput: 0.3, cacheCreation: 3.75 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, cachedInput: 0.3, cacheCreation: 3.75 },
    'claude-haiku-4-5': { input: 1.0, output: 5.0, cachedInput: 0.1, cacheCreation: 1.25 },
    'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cachedInput: 0.1, cacheCreation: 1.25 },

    // OpenAI — list pricing per https://openai.com/api/pricing/ as of
    // session 079 (July 2026). Cache fields omitted; OpenAI's
    // cached_input pricing arrives in a different field shape
    // (prompt_tokens_details) not yet captured by OpenAIProvider. When
    // that's added, populate cachedInput here at the published
    // cached-input rate (typically ~50% of base for gpt-4o, lower for
    // o-series).
    'gpt-5.1': { input: 1.25, output: 10.0 },
    'gpt-5': { input: 1.25, output: 10.0 },
    'gpt-4o': { input: 2.5, output: 10.0 },
    'gpt-4o-2024-11-20': { input: 2.5, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    o1: { input: 15.0, output: 60.0 },
    o3: { input: 2.0, output: 8.0 }, // June-2025 price cut (was 15/60)

    // AWS Bedrock — Anthropic Claude on Bedrock. Bedrock typically
    // matches Anthropic direct pricing for Claude. Cache fields omitted
    // until BedrockProvider exposes them (currently the
    // anthropicEventTranslator captures cache_read / cache_creation but
    // those flow through to the audit event and could be priced — left
    // as future work since the bedrock-runtime pricing for cache tiers
    // varies by region and isn't published as a single SKU).
    'anthropic.claude-opus-4-8-v1:0': { input: 5.0, output: 25.0 },
    'anthropic.claude-opus-4-7-v1:0': { input: 5.0, output: 25.0 },
    'anthropic.claude-sonnet-5-v1:0': { input: 3.0, output: 15.0 },
    'anthropic.claude-sonnet-4-6-v1:0': { input: 3.0, output: 15.0 },
    'anthropic.claude-haiku-4-5-v1:0': { input: 1.0, output: 5.0 },

    // Azure OpenAI — model id is the admin-defined deployment name (e.g.
    // "gpt-4o-prod"), so static pricing entries can't be predeclared.
    // To get cost reporting on Azure, the admin should add a
    // `<deployment-name>: { input: ..., output: ... }` entry here that
    // matches their Azure tier pricing. Without an entry the audit log
    // records correct token counts but $0 cost (zero-fallback).

    // Mock provider — deliberately zero so smoke tests don't accumulate
    // fake spend in the audit log.
    'mock-fast': { input: 0, output: 0 },
});

const ZERO_PRICING: ModelPricing = { input: 0, output: 0 };

/**
 * Compute the vendor cost estimate (USD) for one assistant turn,
 * given the model id and the per-turn token counts.
 *
 * Returns 0 (not undefined) when the model is unknown, so the audit
 * event always carries a finite number — easier to filter in Splunk
 * (`vendorCostEstimateUsd > 0`) than `WHERE isnotnull(...)`.
 */
export const estimateTurnCostUsd = (
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cachedInputTokens: number = 0,
    cacheCreationInputTokens: number = 0,
): number => {
    const p = MODEL_PRICING[modelId] ?? ZERO_PRICING;
    // Subtract cache-categorized tokens from base input so they aren't
    // double-billed. Anthropic's API contract: `input_tokens` is the
    // count of tokens NOT served by the cache; cache reads + creations
    // are reported separately and additively.
    const baseInputCost = (inputTokens / 1_000_000) * p.input;
    const outputCost = (outputTokens / 1_000_000) * p.output;
    const cachedCost = (cachedInputTokens / 1_000_000) * (p.cachedInput ?? p.input);
    const creationCost = (cacheCreationInputTokens / 1_000_000) * (p.cacheCreation ?? p.input);
    const total = baseInputCost + outputCost + cachedCost + creationCost;
    // Round to 6 decimal places (sub-cent precision; finer granularity
    // doesn't survive any real billing reconciliation).
    return Math.round(total * 1_000_000) / 1_000_000;
};
