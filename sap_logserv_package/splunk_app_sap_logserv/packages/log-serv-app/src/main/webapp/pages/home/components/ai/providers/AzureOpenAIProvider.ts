import { OpenAIProvider, OpenAIProviderOptions } from './OpenAIProvider';
import { AIProvider, ConfigValidation, ModelDescriptor, PrivacyPosture } from './AIProvider';
import { readSecret, requireSecret } from './credentials';

/**
 * AzureOpenAIProvider — minimal diff from OpenAIProvider.
 *
 * Same wire format as OpenAI direct, but:
 *   - URL is `<resource_url>/openai/deployments/<deployment>/chat/completions?api-version=<v>`
 *   - Auth header is `api-key: <key>` (not `Authorization: Bearer ...`)
 *   - Models are exposed as **deployments** (admin-named); the model
 *     string in our requests is the deployment name, not a vendor model id
 *   - Privacy posture: Azure has platform-level zero-retention by default
 *     (different defaults from direct OpenAI)
 *
 * Credentials read from passwords.conf:
 *   - realm `logserv_ai_assistant_azure_openai`, name `api_key`         — required
 *   - realm `logserv_ai_assistant_azure_openai`, name `resource_url`    — required
 *     (e.g., https://my-resource.openai.azure.com)
 *   - realm `logserv_ai_assistant_azure_openai`, name `api_version`     — optional (default 2024-10-01-preview)
 *   - realm `logserv_ai_assistant_azure_openai`, name `deployments`     — optional comma-separated list
 *     (admin-readable label for model picker; falls back to a single
 *      "default" deployment if absent)
 */

const PROVIDER_NAME = 'azure_openai';
const DEFAULT_API_VERSION = '2024-10-01-preview';

const DEFAULT_POSTURE: PrivacyPosture = {
    noTraining: true,
    zeroRetention: true, // Azure default; admin can disable abuse-monitoring opt-out
    abuseLoggingDays: 0,
    notes:
        'Azure OpenAI Service. Platform-level zero data retention enabled by default; ' +
        'no Anthropic-style addendum required. Confirm Microsoft enterprise contract specifics.',
};

const DEFAULT_DEPLOYMENT_LABEL = 'default';

export interface AzureOpenAIProviderOptions extends Omit<OpenAIProviderOptions, 'apiUrl' | 'providerNameOverride'> {
    /** Override resource URL — defaults to passwords.conf `resource_url`. */
    resourceUrl?: string;
    /** Override API version — defaults to passwords.conf `api_version` or `2024-10-01-preview`. */
    apiVersion?: string;
    /** Override deployments list — defaults to passwords.conf `deployments` or a single "default". */
    deployments?: ReadonlyArray<string>;
}

export class AzureOpenAIProvider implements AIProvider {
    readonly name = PROVIDER_NAME;
    readonly label = 'Azure OpenAI Service';
    private readonly _models: ModelDescriptor[];
    readonly privacyPosture: PrivacyPosture;

    private readonly resourceUrlOverride?: string;
    private readonly apiVersionOverride?: string;
    private readonly fetchImpl: typeof fetch;
    private readonly opts: AzureOpenAIProviderOptions;

    private cachedResourceUrl: string | null = null;
    private cachedApiVersion: string | null = null;

    constructor(opts: AzureOpenAIProviderOptions = {}) {
        this.opts = opts;
        this.privacyPosture = opts.privacyPosture ?? DEFAULT_POSTURE;
        this.resourceUrlOverride = opts.resourceUrl;
        this.apiVersionOverride = opts.apiVersion;
        this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));

        // For models: each "deployment" name is the model id from our
        // perspective. Phase G's admin UI lets the admin name them; in
        // Phase D we surface either the constructor override or fall
        // back to a single "default" entry. The actual list is fetched
        // lazily by validateConfig if not provided.
        const deployments = opts.deployments ?? [DEFAULT_DEPLOYMENT_LABEL];
        this._models = deployments.map((d) => ({
            id: d,
            label: `Azure deployment: ${d}`,
            contextWindow: 128_000,
            supportsTools: true,
        }));
    }

    get models(): ReadonlyArray<ModelDescriptor> {
        return this._models;
    }

    private async getResourceUrl(): Promise<string> {
        if (this.resourceUrlOverride) return this.resourceUrlOverride;
        if (this.cachedResourceUrl) return this.cachedResourceUrl;
        // Two credential names are accepted: `resource_url` (the name
        // this provider documented since Phase D) and `endpoint` (the
        // name the Settings → Provider Credentials panel actually
        // stores under). Reading both fixes the long-standing mismatch
        // where a Settings-page-configured Azure resource was invisible
        // to the provider. Session 079 / build 276.
        const url =
            (await readSecret(PROVIDER_NAME, 'resource_url')) ??
            (await readSecret(PROVIDER_NAME, 'endpoint'));
        if (!url) {
            throw new Error(
                'Azure OpenAI resource URL not set. Save the "Endpoint URL" under ' +
                    'Settings → AI Assistant → Provider Credentials → Azure OpenAI ' +
                    '(or set realm=logserv_ai_assistant_azure_openai name=resource_url via REST).',
            );
        }
        // Normalize: strip trailing slash for safe concatenation later.
        this.cachedResourceUrl = url.replace(/\/$/, '');
        return this.cachedResourceUrl;
    }

    private async getApiVersion(): Promise<string> {
        if (this.apiVersionOverride) return this.apiVersionOverride;
        if (this.cachedApiVersion) return this.cachedApiVersion;
        const v = await readSecret(PROVIDER_NAME, 'api_version');
        this.cachedApiVersion = v ?? DEFAULT_API_VERSION;
        return this.cachedApiVersion;
    }

    async stream(streamOpts: import('./AIProvider').StreamOptions): Promise<void> {
        let baseUrl: string;
        let apiVersion: string;
        try {
            baseUrl = await this.getResourceUrl();
            apiVersion = await this.getApiVersion();
        } catch (err) {
            streamOpts.onChunk({
                type: 'error',
                error: {
                    code: 'config_missing',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
            return;
        }
        const deployment = streamOpts.model;
        const apiUrl = `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

        // Use OpenAIProvider's stream() impl with custom URL + Azure auth header.
        // Azure uses `api-key: <key>` instead of `Authorization: Bearer <key>`,
        // so we wrap the default fetch to rewrite the header on the fly.
        const azureFetch: typeof fetch = async (input, init) => {
            const headers = new Headers(init?.headers ?? {});
            const auth = headers.get('Authorization');
            if (auth && auth.startsWith('Bearer ')) {
                headers.delete('Authorization');
                headers.set('api-key', auth.substring('Bearer '.length));
            }
            return this.fetchImpl(input, { ...init, headers });
        };

        const inner = new OpenAIProvider({
            ...this.opts,
            providerNameOverride: PROVIDER_NAME,
            apiUrl,
            fetchImpl: azureFetch,
            modelsOverride: this._models,
            privacyPosture: this.privacyPosture,
        });
        await inner.stream(streamOpts);
    }

    /**
     * Model discovery — Azure's list is the admin's DEPLOYMENTS (the
     * deployment name is our model id), which can't be known statically.
     * Best-effort 3-step chain, each step individually degradable
     * (session 079 / build 276):
     *   1. GET {resource}/openai/v1/models        (modern v1 surface)
     *   2. GET {resource}/openai/deployments?api-version=… (legacy list)
     *   3. the admin's stored deployment CSV (`deployments` secret, or
     *      the Settings page's singular `deployment` field) — never
     *      worse than the pre-discovery behavior.
     */
    async listModels(): Promise<ReadonlyArray<ModelDescriptor>> {
        const apiKey = await requireSecret(PROVIDER_NAME, 'api_key');
        const baseUrl = await this.getResourceUrl();
        const toDescriptor = (id: string): ModelDescriptor => ({
            id,
            label: `Azure deployment: ${id}`,
            contextWindow: 128_000,
            supportsTools: true,
        });
        const parseIds = (json: unknown): string[] => {
            const data = (json as { data?: Array<{ id?: string; name?: string }> })?.data;
            if (!Array.isArray(data)) return [];
            return data
                .map((m) => (typeof m?.id === 'string' && m.id ? m.id : m?.name))
                .filter((x): x is string => typeof x === 'string' && x.length > 0);
        };
        // Step 1 — modern v1 surface.
        try {
            const resp = await this.fetchImpl(`${baseUrl}/openai/v1/models`, {
                method: 'GET',
                headers: { 'api-key': apiKey },
            });
            if (resp.status === 401 || resp.status === 403) {
                throw new Error(`Azure OpenAI key rejected (HTTP ${resp.status}) on model list.`);
            }
            if (resp.ok) {
                const ids = parseIds(await resp.json());
                if (ids.length > 0) return ids.map(toDescriptor);
            }
        } catch (err) {
            // 401/403 is a hard config error worth surfacing; anything
            // else (404 — endpoint absent on this api surface, network)
            // falls through to step 2.
            if (err instanceof Error && /rejected/.test(err.message)) throw err;
        }
        // Step 2 — legacy data-plane deployments list.
        try {
            const apiVersion = await this.getApiVersion();
            const resp = await this.fetchImpl(
                `${baseUrl}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`,
                { method: 'GET', headers: { 'api-key': apiKey } },
            );
            if (resp.ok) {
                const ids = parseIds(await resp.json());
                if (ids.length > 0) return ids.map(toDescriptor);
            }
        } catch (_e) {
            // fall through to step 3
        }
        // Step 3 — admin-stored deployment CSV (both field spellings).
        const csv =
            (await readSecret(PROVIDER_NAME, 'deployments')) ??
            (await readSecret(PROVIDER_NAME, 'deployment'));
        if (csv) {
            const ids = csv
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            if (ids.length > 0) return ids.map(toDescriptor);
        }
        throw new Error(
            'Azure OpenAI deployment list unavailable: the resource exposes neither ' +
                '/openai/v1/models nor /openai/deployments to this key, and no ' +
                'deployment name is stored under Provider Credentials.',
        );
    }

    async validateConfig(): Promise<ConfigValidation> {
        let baseUrl: string;
        let apiVersion: string;
        let apiKey: string | null;
        try {
            baseUrl = await this.getResourceUrl();
            apiVersion = await this.getApiVersion();
            apiKey = await readSecret(PROVIDER_NAME, 'api_key');
        } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (!apiKey) {
            return {
                ok: false,
                reason:
                    'Azure OpenAI api_key not set. Configure via Splunk REST: ' +
                    `POST /services/storage/passwords realm=logserv_ai_assistant_${PROVIDER_NAME} name=api_key password=<key>`,
            };
        }
        // Cheap probe: list deployments. Endpoint exists on every Azure
        // OpenAI resource and returns 200 + JSON when the key is valid.
        try {
            const url = `${baseUrl}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
            const response = await this.fetchImpl(url, {
                method: 'GET',
                headers: { 'api-key': apiKey },
            });
            if (response.status === 401 || response.status === 403) {
                return { ok: false, reason: `Azure OpenAI key rejected (HTTP ${response.status}).` };
            }
            if (!response.ok) {
                return { ok: false, reason: `Azure OpenAI returned HTTP ${response.status} on validate.` };
            }
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `Azure OpenAI unreachable: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}
