/**
 * modelDiscovery — dynamic AI model discovery plumbing (session 079 / build 275).
 *
 * The per-provider model lists shipped in the App are static curated
 * baselines (`provider.models`) that go stale a model-generation at a
 * time. This module keeps the list the user picks from current without
 * an App release:
 *
 *   1. `provider.listModels()` (optional per provider) fetches the
 *      vendor's OWN model-listing API — browser-side, with the stored
 *      credential, exactly the trust envelope of the existing
 *      `validateConfig` probe. Metadata only; no message content, no
 *      event data, nothing through `buildOutboundPayload`.
 *   2. The discovered rows are SANITIZED (id/label allowlists — the KV
 *      collection is world-writable, so sanitize on write AND on read)
 *      and cached in KV Store collection `logserv_ai_models`, one row
 *      per provider (`_key = <provider name>`).
 *   3. `mergeModels(baseline, discovered)` produces the `effectiveModels`
 *      list consumed by the Settings default-model dropdown and the
 *      chat panel's model picker: shipped baseline first (stable order,
 *      curated labels), discovered-only entries appended. Baseline
 *      entries the vendor no longer returns are KEPT — an admin's saved
 *      `default_model` may point at one, and a bogus id simply 404s at
 *      stream time. The static floor guarantees the picker never goes
 *      empty when discovery is off, failing, or unsupported.
 *
 * Refresh triggers (all fire-and-forget; failures NEVER block chat):
 *   - Settings → General "Refresh model list" button (`settings_refresh`)
 *   - Successful provider credential save (`credential_save`)
 *   - Lazy 24h TTL on chat-panel mount (`ttl`; skips the mock provider,
 *     at most one attempt per provider per page load)
 *
 * Governance: the `model_discovery_enabled` admin setting (default ON)
 * gates every trigger; each refresh writes a `model_discovery` audit
 * event (who, provider, count, duration, ok/error).
 *
 * No pricing is guessed for discovered models — `utils/vendorCost.ts`
 * stays exact-id keyed and unknown ids report $0 (explicit unknown).
 */

import { AIProvider, ModelDescriptor } from './providers/AIProvider';
import { AuditWriter } from './audit/auditWriter';
import { ModelDiscoveryEvent, ModelDiscoveryTrigger } from './audit/auditTypes';
import { TEMPLATES_ONLY } from '../../buildFlags';

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const COLLECTION = 'logserv_ai_models';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;

/** Discovered lists older than this are considered stale by the lazy
 *  chat-panel-mount trigger. 24 hours — model launches are a
 *  months-cadence event; a day of staleness is immaterial. */
export const MODEL_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Hard cap on stored descriptors per provider — a poisoned or absurd
 *  vendor response can't balloon the KV row / the picker. */
const MAX_DISCOVERED_MODELS = 100;

// ─── KV row shape ──────────────────────────────────────────────────────────

export interface ModelCacheRow {
    /** Provider name the row belongs to (mirrors `_key`). */
    provider: string;
    /** Sanitized discovered descriptors (parsed from `models_json`). */
    models: ModelDescriptor[];
    /** Epoch seconds of the last SUCCESSFUL fetch (0 = never). */
    fetchedAt: number;
    /** Splunk username that triggered the last write. */
    fetchedBy: string;
    /** Last failure string ('' when the last fetch succeeded). A failed
     *  refresh keeps the prior models/fetchedAt (last-good) and only
     *  updates this field, so the Settings status can show both "N
     *  models · discovered Xh ago" AND the newest error. */
    error: string;
}

// ─── sanitizers (defense-in-depth, session-036 sticky #8) ─────────────────

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/** Allowlist-sanitize a vendor/KV model id. Returns null on reject. */
export const sanitizeModelId = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    if (!MODEL_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
};

/** Strip control characters, collapse whitespace, cap at 80 chars.
 *  Falls back to the (already-sanitized) id when nothing survives. */
export const sanitizeModelLabel = (label: unknown, fallback: string): string => {
    if (typeof label !== 'string') return fallback;
    const cleaned = label
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return cleaned.length > 0 ? cleaned : fallback;
};

// ─── metadata overlay ──────────────────────────────────────────────────────
//
// contextWindow / supportsTools for discovered ids the vendor list
// doesn't describe. Prefix-keyed, first match wins (longest/most-specific
// prefixes first). contextWindow is informational-only per the
// ModelDescriptor contract, so a conservative wrong guess is harmless.

interface OverlayEntry {
    prefix: string;
    contextWindow: number;
    supportsTools: boolean;
}

const METADATA_OVERLAY: ReadonlyArray<OverlayEntry> = [
    // Anthropic direct
    { prefix: 'claude-fable-5', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-mythos', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-opus-4-8', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-opus-4-7', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-opus-4-6', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-sonnet-5', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-sonnet-4-6', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'claude-haiku', contextWindow: 200_000, supportsTools: true },
    { prefix: 'claude-', contextWindow: 200_000, supportsTools: true },
    // Claude on Bedrock (both the bare and versioned id forms)
    { prefix: 'anthropic.claude-opus-4-8', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'anthropic.claude-sonnet-5', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'anthropic.claude-', contextWindow: 200_000, supportsTools: true },
    // OpenAI
    { prefix: 'gpt-5', contextWindow: 400_000, supportsTools: true },
    { prefix: 'gpt-4.1', contextWindow: 1_000_000, supportsTools: true },
    { prefix: 'gpt-4o', contextWindow: 128_000, supportsTools: true },
    { prefix: 'gpt-', contextWindow: 128_000, supportsTools: true },
    { prefix: 'chatgpt-', contextWindow: 128_000, supportsTools: true },
    { prefix: 'o1', contextWindow: 200_000, supportsTools: true },
    { prefix: 'o3', contextWindow: 200_000, supportsTools: true },
    { prefix: 'o4', contextWindow: 200_000, supportsTools: true },
];

const DEFAULT_OVERLAY: Omit<OverlayEntry, 'prefix'> = {
    contextWindow: 128_000,
    supportsTools: true,
};

const overlayFor = (id: string): Omit<OverlayEntry, 'prefix'> => {
    for (const entry of METADATA_OVERLAY) {
        if (id.startsWith(entry.prefix)) {
            return { contextWindow: entry.contextWindow, supportsTools: entry.supportsTools };
        }
    }
    return DEFAULT_OVERLAY;
};

/**
 * Sanitize an untrusted descriptor array (vendor response OR KV row —
 * the collection ACL is `write : [ * ]`, so rows are re-sanitized on
 * every read, not just on write). Rejects rows whose id fails the
 * allowlist; dedupes by id; enriches missing/invalid contextWindow and
 * supportsTools from the overlay.
 */
export const sanitizeDescriptors = (raw: unknown): ModelDescriptor[] => {
    if (!Array.isArray(raw)) return [];
    const out: ModelDescriptor[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (out.length >= MAX_DISCOVERED_MODELS) break;
        const rec = item as Partial<ModelDescriptor> | null | undefined;
        const id = sanitizeModelId(rec?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const overlay = overlayFor(id);
        const contextWindow =
            typeof rec?.contextWindow === 'number' &&
            Number.isFinite(rec.contextWindow) &&
            rec.contextWindow > 0
                ? Math.floor(rec.contextWindow)
                : overlay.contextWindow;
        out.push({
            id,
            label: sanitizeModelLabel(rec?.label, id),
            contextWindow,
            supportsTools:
                typeof rec?.supportsTools === 'boolean'
                    ? rec.supportsTools
                    : overlay.supportsTools,
        });
    }
    return out;
};

// ─── merge ─────────────────────────────────────────────────────────────────

/**
 * effectiveModels = baseline ∪ discovered. Pure function.
 *
 * Shipped baseline first (stable order, curated labels win on id
 * collision); discovered-only entries appended in discovery order
 * (providers return newest-first). Baseline entries the vendor no
 * longer lists are kept — fail-safe for saved default_model values.
 */
export const mergeModels = (
    baseline: ReadonlyArray<ModelDescriptor>,
    discovered: ReadonlyArray<ModelDescriptor>,
): ModelDescriptor[] => {
    const out: ModelDescriptor[] = [...baseline];
    const seen = new Set(baseline.map((m) => m.id));
    for (const d of discovered) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        out.push(d);
    }
    return out;
};

// ─── KV Store client (mirrors utils/aiConfigApi.ts conventions) ────────────

const readCsrfToken = (): string => {
    const m = `; ${document.cookie}`.match(/; splunkweb_csrf_token_\d+=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
};

const sharedHeaders = (): Record<string, string> => ({
    'X-Requested-With': 'XMLHttpRequest',
});

const mutatingHeaders = (): Record<string, string> => ({
    ...sharedHeaders(),
    'Content-Type': 'application/json',
    'X-Splunk-Form-Key': readCsrfToken(),
});

/**
 * Read the cached discovered-model row for a provider.
 *
 * Three-state return (same convention as aiConfigApi.readKvStoreRow):
 *   ModelCacheRow — row exists (models re-sanitized on read)
 *   null          — row absent (never discovered / collection fresh)
 *   undefined     — transient REST failure (caller should NOT treat as
 *                   "absent"; e.g. the TTL trigger skips rather than
 *                   hammering the vendor on a KV hiccup)
 */
export const readModelCacheRow = async (
    providerName: string,
): Promise<ModelCacheRow | null | undefined> => {
    try {
        const resp = await fetch(
            `${KV_BASE}/${encodeURIComponent(providerName)}?output_mode=json`,
            { credentials: 'same-origin', headers: sharedHeaders() },
        );
        if (resp.status === 404) return null;
        if (!resp.ok) return undefined;
        const record = (await resp.json()) as Record<string, unknown>;
        let parsedModels: unknown = [];
        try {
            parsedModels =
                typeof record.models_json === 'string' && record.models_json.length > 0
                    ? JSON.parse(record.models_json)
                    : [];
        } catch {
            parsedModels = [];
        }
        const fetchedAtNum = Number(record.fetched_at);
        return {
            provider: providerName,
            models: sanitizeDescriptors(parsedModels),
            fetchedAt: Number.isFinite(fetchedAtNum) && fetchedAtNum > 0 ? fetchedAtNum : 0,
            fetchedBy: typeof record.fetched_by === 'string' ? record.fetched_by : '',
            error: typeof record.error === 'string' ? record.error : '',
        };
    } catch {
        return undefined;
    }
};

/** Upsert the full row (KV Store POST to /<key> replaces the entire
 *  record — always write every field). 404 → collection-level create. */
const writeModelCacheRow = async (row: ModelCacheRow): Promise<void> => {
    const record = {
        _key: row.provider,
        provider: row.provider,
        models_json: JSON.stringify(row.models),
        fetched_at: row.fetchedAt,
        fetched_by: row.fetchedBy,
        error: row.error,
    };
    const body = JSON.stringify(record);
    let resp = await fetch(`${KV_BASE}/${encodeURIComponent(row.provider)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: mutatingHeaders(),
        body,
    });
    if (resp.status === 404) {
        resp = await fetch(KV_BASE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body,
        });
    }
    if (!resp.ok) {
        throw new Error(`KV Store write failed: HTTP ${resp.status}`);
    }
};

// ─── refresh orchestration ─────────────────────────────────────────────────

export interface ModelDiscoveryOutcome {
    ok: boolean;
    /** Sanitized discovered list (empty on failure). */
    models: ModelDescriptor[];
    /** Failure string ('' on success). Safe for UI display. */
    error: string;
    durationMs: number;
}

/**
 * Run one discovery fetch for a provider: listModels() → sanitize →
 * upsert the KV row → post the `model_discovery` audit event.
 *
 * Failure semantics: the last-good models/fetchedAt on the row are
 * preserved; only `error` updates. The caller's merge therefore keeps
 * serving last-good ∪ baseline — a failed refresh can never shrink or
 * break the picker.
 */
export const refreshProviderModels = async (
    provider: AIProvider,
    username: string,
    trigger: ModelDiscoveryTrigger,
): Promise<ModelDiscoveryOutcome> => {
    /* Templates-only builds (the v0.0.6 public line) make NO vendor
     * model-listing calls: every trigger funnels through here, so this
     * single compile-time gate makes discovery fully inert — no fetch,
     * no KV write, no audit event. The Settings UI rows are hidden
     * behind the same flag in AIAssistantSettings.tsx. DCE'd away
     * entirely in full-LLM builds (TEMPLATES_ONLY === false). */
    if (TEMPLATES_ONLY) {
        return {
            ok: false,
            models: [],
            error: 'Model discovery is unavailable in templates-only builds.',
            durationMs: 0,
        };
    }
    const startedMs = Date.now();
    let models: ModelDescriptor[] = [];
    let ok = false;
    let error = '';

    if (typeof provider.listModels !== 'function') {
        error = `Provider "${provider.name}" does not support model discovery.`;
    } else {
        try {
            const raw = await provider.listModels();
            models = sanitizeDescriptors(raw);
            ok = true;
        } catch (err) {
            error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        }
    }
    const durationMs = Date.now() - startedMs;

    // Cache upsert — best-effort; a KV write failure must not break the
    // in-memory result path (the caller still gets the fresh list).
    try {
        if (ok) {
            await writeModelCacheRow({
                provider: provider.name,
                models,
                fetchedAt: Math.floor(Date.now() / 1000),
                fetchedBy: username || 'unknown',
                error: '',
            });
        } else {
            const prior = await readModelCacheRow(provider.name);
            await writeModelCacheRow({
                provider: provider.name,
                models: prior && prior.models ? prior.models : [],
                fetchedAt: prior ? prior.fetchedAt : 0,
                fetchedBy: username || 'unknown',
                error,
            });
        }
    } catch {
        // swallow — cache is an optimization, not a dependency
    }

    // Audit (LLM governance observability). One-off post — independent
    // of any chat session's AuditWriter batch state.
    const event: ModelDiscoveryEvent = {
        timestamp: new Date().toISOString(),
        user: username || 'unknown',
        sessionId: `discovery-${Date.now().toString(36)}`,
        seq: 1,
        category: 'model_discovery',
        provider: provider.name,
        trigger,
        ok,
        modelCount: models.length,
        durationMs,
        ...(error ? { error } : {}),
    };
    void AuditWriter.postOneOff(event);

    return { ok, models, error, durationMs };
};

// ─── lazy TTL trigger (chat-panel mount) ───────────────────────────────────

/** At most one TTL-triggered fetch per provider per page load — a
 *  vendor outage or a permanently-failing key can't turn every panel
 *  open into a fetch storm. */
const ttlAttemptedThisPageLoad = new Set<string>();

/** Test-only reset hook for the once-per-page-load guard. */
export const resetTtlAttemptGuard = (): void => {
    ttlAttemptedThisPageLoad.clear();
};

/**
 * Background TTL refresh: fires only when the cached row is absent,
 * stale (> 24h), or last errored. Skips the mock provider (nothing to
 * discover; the Settings button remains the mock's manual exercise
 * path). Returns the fresh discovered list when a refresh ran and
 * succeeded, else null (caller keeps current state).
 */
export const maybeRefreshModelsTtl = async (
    provider: AIProvider,
    username: string,
): Promise<ModelDescriptor[] | null> => {
    if (TEMPLATES_ONLY) return null; // no discovery in templates-only builds
    if (provider.name === 'mock') return null;
    if (typeof provider.listModels !== 'function') return null;
    if (ttlAttemptedThisPageLoad.has(provider.name)) return null;
    ttlAttemptedThisPageLoad.add(provider.name);

    const row = await readModelCacheRow(provider.name);
    if (row === undefined) return null; // KV hiccup — don't hit the vendor blind
    if (row && row.error === '') {
        const ageSeconds = Math.floor(Date.now() / 1000) - row.fetchedAt;
        if (ageSeconds < MODEL_CACHE_TTL_SECONDS) return null; // fresh enough
    }

    const outcome = await refreshProviderModels(provider, username, 'ttl');
    return outcome.ok ? outcome.models : null;
};
