import { username as splunkUsername } from '@splunk/splunk-utils/config';
import { DEFAULT_PANEL_LAYOUT, type PanelLayoutState, type SavedLayout, type ViewportState } from './types';

/**
 * Per-user layout persistence — v2 (build 120 / session 024 path A.4).
 *
 * Backend:
 *   - PRIMARY: Splunk KV Store collection `logserv_topology_layouts`
 *     (cross-browser per user, multiple named layouts).
 *   - LOCAL CACHE: browser localStorage stores the currently-active layout
 *     so synchronous mount renders with saved positions before the async
 *     KV Store fetch resolves. Saves and explicit Loads update both.
 *
 * Schema versioning of the SavedLayout blob (lives on disk in localStorage
 * cache + as `nodes_json` / `panels_json` strings inside KV Store records):
 *   - v1: nodes only (build 105 / session 023 prototype). Read-compat only.
 *   - v2: nodes + panels (build 106 / session 023). Read-compat only.
 *   - v3: nodes + panels + layoutName (build 120 / session 024). Read-compat only.
 *   - v4: + viewport, enabledTypes, selectedNodeId, rightTabId, snapMode
 *         (build 169 / session 028 — current). All v4 fields are optional
 *         on read so v3 records load fine with the new fields undefined.
 *
 * KV Store record schema (collections.conf `logserv_topology_layouts`):
 *   _key, username, layout_name, layout_name_slug, saved_at, version,
 *   nodes_json, panels_json, viewport_json, enabled_types_json,
 *   selected_node_id, right_tab_id, snap_mode
 *
 * One-time legacy localStorage migration: on first call to
 * `migrateLegacyLocalStorageLayout()`, if KV Store has zero records for this
 * user AND localStorage has a v1/v2 entry, copy it into KV Store as a layout
 * named "Default". Gated by a per-user `kvstore_migrated.<user>` flag.
 *
 * Username read failure falls back to 'anonymous' (same behavior as v1).
 * KV Store unreachable falls back to localStorage-only mode silently.
 */

const LOCAL_STORAGE_KEY_PREFIX = 'logserv.topology.layout.';
const LOCAL_STORAGE_MIGRATED_KEY = 'logserv.topology.kvstore_migrated.';

const APP_NAMESPACE = 'splunk_app_sap_logserv';
const COLLECTION = 'logserv_topology_layouts';
const KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${COLLECTION}`;

const safeUser = (): string => {
    try {
        const u = (splunkUsername as unknown as string) || '';
        return u.length > 0 ? u : 'anonymous';
    } catch (_e) {
        return 'anonymous';
    }
};

const localStorageKey = (): string => `${LOCAL_STORAGE_KEY_PREFIX}${safeUser()}`;
const migratedFlagKey = (): string => `${LOCAL_STORAGE_MIGRATED_KEY}${safeUser()}`;

/** Convert a free-text layout name to a URL/key-safe slug.
 *  - lowercase
 *  - non-alphanumerics -> '-'
 *  - collapse runs of '-' (regex character class already does this implicitly via greedy +)
 *  - trim leading/trailing '-'
 *  - cap at 40 chars (so the full _key 'username::slug' stays well under
 *    typical KV Store key length budgets — username can be ~30 chars + 2
 *    + 40 slug = under 75 chars). */
export const slugifyLayoutName = (name: string): string => {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
};

const recordKey = (slug: string): string => `${safeUser()}::${slug}`;

// ---- CSRF / auth helpers (mirror telemetryConfApi pattern) ----

const readCsrfToken = (): string => {
    const m = (`; ${document.cookie}`).match(
        /; splunkweb_csrf_token_\d+=([^;]+)/,
    );
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

// ---- LocalStorage cache (sync, fast-path for mount) ----

interface RawLegacyV1 {
    version: 1;
    savedAt: string;
    nodes: { id: string; x: number; y: number }[];
}

interface RawLegacyV2 {
    version: 2;
    savedAt: string;
    nodes: { id: string; x: number; y: number }[];
    panels: PanelLayoutState;
}

const isV1 = (raw: unknown): raw is RawLegacyV1 =>
    !!raw && typeof raw === 'object' && (raw as { version?: number }).version === 1
    && Array.isArray((raw as { nodes?: unknown }).nodes);

const isV2 = (raw: unknown): raw is RawLegacyV2 =>
    !!raw && typeof raw === 'object' && (raw as { version?: number }).version === 2
    && Array.isArray((raw as { nodes?: unknown }).nodes)
    && !!(raw as { panels?: unknown }).panels;

interface RawLegacyV3 {
    version: 3;
    savedAt: string;
    layoutName?: string;
    nodes: { id: string; x: number; y: number }[];
    panels: PanelLayoutState;
}

const isV3 = (raw: unknown): raw is RawLegacyV3 =>
    !!raw && typeof raw === 'object' && (raw as { version?: number }).version === 3
    && Array.isArray((raw as { nodes?: unknown }).nodes)
    && !!(raw as { panels?: unknown }).panels;

const isV4 = (raw: unknown): raw is SavedLayout =>
    !!raw && typeof raw === 'object' && (raw as { version?: number }).version === 4
    && Array.isArray((raw as { nodes?: unknown }).nodes)
    && !!(raw as { panels?: unknown }).panels;

/** Type guard for the optional ViewportState read from the wire. Splunk
 *  returns numbers as strings sometimes — coerce defensively. */
const parseViewport = (raw: unknown): ViewportState | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { x?: unknown; y?: unknown; zoom?: unknown };
    const x = Number(r.x);
    const y = Number(r.y);
    const zoom = Number(r.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return undefined;
    return { x, y, zoom };
};

/** Synchronously read the cached active layout from localStorage. Used at
 *  component mount so the graph renders saved positions immediately rather
 *  than waiting for the KV Store async fetch. Migrates v1/v2/v3 reads to
 *  the v4 in-memory shape with the new fields undefined. */
export const loadCachedLayout = (): SavedLayout | null => {
    try {
        const raw = window.localStorage.getItem(localStorageKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (isV4(parsed)) return parsed;
        if (isV3(parsed)) {
            return {
                version: 4,
                savedAt: parsed.savedAt,
                layoutName: parsed.layoutName,
                nodes: parsed.nodes,
                panels: parsed.panels,
            };
        }
        if (isV2(parsed)) {
            return {
                version: 4,
                savedAt: parsed.savedAt,
                nodes: parsed.nodes,
                panels: parsed.panels,
            };
        }
        if (isV1(parsed)) {
            return {
                version: 4,
                savedAt: parsed.savedAt,
                nodes: parsed.nodes,
                panels: { ...DEFAULT_PANEL_LAYOUT },
            };
        }
        return null;
    } catch (_e) {
        return null;
    }
};

const writeCachedLayout = (layout: SavedLayout): void => {
    try {
        window.localStorage.setItem(localStorageKey(), JSON.stringify(layout));
    } catch (_e) {
        /* ignore */
    }
};

const clearCachedLayout = (): void => {
    try {
        window.localStorage.removeItem(localStorageKey());
    } catch (_e) {
        /* ignore */
    }
};

/** Clear the cached active layout (used by Reset). Does NOT touch KV Store —
 *  named layouts persist; only the local mount-time cache is cleared. */
export const clearCachedActiveLayout = (): void => {
    clearCachedLayout();
};

// ---- KV Store I/O ----

export interface LayoutSummary {
    slug: string;
    name: string;
    savedAt: string;
}

export interface SavePayload {
    nodes: { id: string; x: number; y: number }[];
    panels: PanelLayoutState;
    /* All v4 fields are optional in the payload — caller can omit any
     * subset and they roundtrip through KV Store as `undefined` →
     * absent JSON / empty string → undefined on read. */
    viewport?: ViewportState;
    enabledTypes?: string[];
    selectedNodeId?: string | null;
    rightTabId?: string;
    snapMode?: boolean;
}

interface KvStoreRecord {
    _key: string;
    username: string;
    layout_name: string;
    layout_name_slug: string;
    saved_at: string;
    version: number;
    nodes_json: string;
    panels_json: string;
    /* v4 — all optional. Splunk KV Store omits unset fields from the
     * record entirely, so reads must defend against `undefined`. */
    viewport_json?: string;
    enabled_types_json?: string;
    selected_node_id?: string;
    right_tab_id?: string;
    snap_mode?: number;
}

/** Defensive JSON.parse helper — returns undefined on any failure or
 *  empty input. Used for the v4 optional fields read off the KV Store. */
const safeParseJson = <T>(raw: string | undefined | null): T | undefined => {
    if (!raw || typeof raw !== 'string' || raw.length === 0) return undefined;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
};

const recordToSavedLayout = (rec: KvStoreRecord): SavedLayout => {
    const viewport = parseViewport(safeParseJson<unknown>(rec.viewport_json));
    const enabledTypes = safeParseJson<unknown>(rec.enabled_types_json);
    return {
        version: 4,
        savedAt: rec.saved_at,
        layoutName: rec.layout_name,
        nodes: JSON.parse(rec.nodes_json) as { id: string; x: number; y: number }[],
        panels: JSON.parse(rec.panels_json) as PanelLayoutState,
        viewport,
        enabledTypes: Array.isArray(enabledTypes)
            ? enabledTypes.filter((t): t is string => typeof t === 'string')
            : undefined,
        selectedNodeId:
            typeof rec.selected_node_id === 'string' && rec.selected_node_id.length > 0
                ? rec.selected_node_id
                : undefined,
        rightTabId:
            typeof rec.right_tab_id === 'string' && rec.right_tab_id.length > 0
                ? rec.right_tab_id
                : undefined,
        snapMode:
            typeof rec.snap_mode === 'number'
                ? rec.snap_mode === 1
                : undefined,
    };
};

const recordToSummary = (rec: KvStoreRecord): LayoutSummary => ({
    slug: rec.layout_name_slug,
    name: rec.layout_name,
    savedAt: rec.saved_at,
});

/** List all saved layouts for the current user, sorted by saved_at desc.
 *  Returns [] on KV Store failure (graceful degrade — caller renders empty state). */
export const listLayouts = async (): Promise<LayoutSummary[]> => {
    try {
        const u = safeUser();
        const query = encodeURIComponent(JSON.stringify({ username: u }));
        const sort = encodeURIComponent('-saved_at');
        const url = `${KV_BASE}?query=${query}&sort=${sort}&output_mode=json`;
        const resp = await fetch(url, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) return [];
        const records = (await resp.json()) as KvStoreRecord[];
        return records.map(recordToSummary);
    } catch (_e) {
        return [];
    }
};

/** Load a single layout by slug. Returns null on failure. Updates the local
 *  cache so next mount renders this layout immediately. */
export const loadLayoutBySlug = async (slug: string): Promise<SavedLayout | null> => {
    if (!slug) return null;
    try {
        const url = `${KV_BASE}/${encodeURIComponent(recordKey(slug))}?output_mode=json`;
        const resp = await fetch(url, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) return null;
        const record = (await resp.json()) as KvStoreRecord;
        const layout = recordToSavedLayout(record);
        writeCachedLayout(layout);
        return layout;
    } catch (_e) {
        return null;
    }
};

/** Save (create or overwrite) a layout under the given user-visible name.
 *  Two-step write: PUT to /<key> first (idempotent overwrite); on 404
 *  (record doesn't yet exist), fall back to a collection-level POST that
 *  creates a new record at the supplied _key. Mirrors the layout to the
 *  local cache. */
export const saveLayoutNamed = async (
    layoutName: string,
    payload: SavePayload,
): Promise<{ ok: true; slug: string } | { ok: false; reason: string }> => {
    const trimmed = layoutName.trim();
    if (!trimmed) return { ok: false, reason: 'Layout name required.' };
    const slug = slugifyLayoutName(trimmed);
    if (!slug) return { ok: false, reason: 'Layout name must contain at least one alphanumeric character.' };

    const u = safeUser();
    const key = recordKey(slug);
    const layout: SavedLayout = {
        version: 4,
        savedAt: new Date().toISOString(),
        layoutName: trimmed,
        nodes: payload.nodes.map((n) => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y) })),
        panels: { ...payload.panels },
        viewport: payload.viewport,
        enabledTypes: payload.enabledTypes,
        selectedNodeId: payload.selectedNodeId,
        rightTabId: payload.rightTabId,
        snapMode: payload.snapMode,
    };
    const record: KvStoreRecord = {
        _key: key,
        username: u,
        layout_name: trimmed,
        layout_name_slug: slug,
        saved_at: layout.savedAt,
        version: 4,
        nodes_json: JSON.stringify(layout.nodes),
        panels_json: JSON.stringify(layout.panels),
        // v4 fields — only include keys whose values are defined so the
        // KV Store record stays minimal for layouts that don't yet have
        // every field populated (e.g. a v3 record being re-saved).
        ...(layout.viewport ? { viewport_json: JSON.stringify(layout.viewport) } : {}),
        ...(layout.enabledTypes
            ? { enabled_types_json: JSON.stringify(layout.enabledTypes) }
            : {}),
        ...(typeof layout.selectedNodeId === 'string'
            ? { selected_node_id: layout.selectedNodeId }
            : {}),
        ...(typeof layout.rightTabId === 'string'
            ? { right_tab_id: layout.rightTabId }
            : {}),
        ...(typeof layout.snapMode === 'boolean'
            ? { snap_mode: layout.snapMode ? 1 : 0 }
            : {}),
    };

    try {
        // Try POST to /<key> first — Splunk KV Store accepts this as
        // create-or-overwrite for the targeted record.
        let resp = await fetch(`${KV_BASE}/${encodeURIComponent(key)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body: JSON.stringify(record),
        });
        if (resp.status === 404) {
            // Record doesn't exist yet — create via collection-level POST.
            resp = await fetch(KV_BASE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body: JSON.stringify(record),
            });
        }
        if (!resp.ok) {
            return { ok: false, reason: `KV Store write failed: HTTP ${resp.status}` };
        }
        writeCachedLayout(layout);
        return { ok: true, slug };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
};

/** Delete a layout by slug from KV Store. Does NOT touch the local cache —
 *  the caller can clear the cache separately if the deleted layout was the
 *  currently-active one. */
export const deleteLayout = async (slug: string): Promise<boolean> => {
    if (!slug) return false;
    try {
        const url = `${KV_BASE}/${encodeURIComponent(recordKey(slug))}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
        });
        return resp.ok;
    } catch (_e) {
        return false;
    }
};

/** Migrate the legacy single localStorage layout to KV Store under the name
 *  "Default" — runs once per user (gated by a separate flag). Idempotent;
 *  silently skips if there's nothing to migrate or KV Store already has
 *  records for this user. Best-effort: any error is swallowed so the UI
 *  isn't blocked on migration. */
export const migrateLegacyLocalStorageLayout = async (): Promise<void> => {
    try {
        const flagKey = migratedFlagKey();
        if (window.localStorage.getItem(flagKey) === 'true') return;
        const cached = loadCachedLayout();
        if (!cached) {
            window.localStorage.setItem(flagKey, 'true');
            return;
        }
        // If KV Store already has any layouts for this user, skip migration.
        const existing = await listLayouts();
        if (existing.length > 0) {
            window.localStorage.setItem(flagKey, 'true');
            return;
        }
        await saveLayoutNamed('Default', { nodes: cached.nodes, panels: cached.panels });
        window.localStorage.setItem(flagKey, 'true');
    } catch (_e) {
        /* migration is best-effort — never block the UI */
    }
};

/** Exported for the toolbar's "saved at" indicator. */
export const getCurrentUsername = (): string => safeUser();
