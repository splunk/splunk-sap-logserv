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

const isV5 = (raw: unknown): raw is SavedLayout =>
    !!raw && typeof raw === 'object' && (raw as { version?: number }).version === 5
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
 *  than waiting for the KV Store async fetch.
 *
 *  Session 035 / build 188: schema bumped v4 → v5 (added selectedEdgeId
 *  for the session-036 edge-data right pane). Per user direction, no
 *  backward compat — pre-v5 records are silently wiped on read. Users
 *  re-save once. The unused isV1/isV2/isV3 type guards are retained as
 *  documentation but no longer dispatch into; they may be removed in a
 *  later cleanup. */
export const loadCachedLayout = (): SavedLayout | null => {
    try {
        const raw = window.localStorage.getItem(localStorageKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (isV5(parsed)) return parsed;
        // Pre-v5: wipe and return null. The user re-saves.
        if (isV1(parsed) || isV2(parsed) || isV3(parsed) ||
            // catch any version-tagged blob we don't recognize
            (typeof parsed === 'object' && parsed !== null &&
             typeof (parsed as { version?: unknown }).version === 'number')) {
            window.localStorage.removeItem(localStorageKey());
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
    /* Build 216 / session 036 — layout mode the saved positions were
     * captured under. Used by the Manage Layouts modal to group layouts
     * by Force / Layered / Tree sections so users can pick a default
     * for each mode. Optional for back-compat with pre-215 records;
     * unknown modes (legacy) default to 'force'. */
    layoutMode?: 'force' | 'layered' | 'tree';
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
    /* v5 (build 188 / session 035) — selected edge id for the
     * session-036 edge-data right pane. */
    selectedEdgeId?: string | null;
    /* Build 215 / session 036 — layout algorithm captured at save time.
     * Restored on load so saved positions only apply to the matching
     * mode. */
    layoutMode?: 'force' | 'layered' | 'tree';
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
    /* v5 (build 188 / session 035) — edge selection for the session-036
     * edge-data right pane. Optional. */
    selected_edge_id?: string;
    /* Build 215 / session 036 — layout algorithm at save time. Optional
     * for back-compat with pre-215 records (default 'force' on load). */
    layout_mode?: string;
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

const recordToSavedLayout = (rec: KvStoreRecord): SavedLayout | null => {
    /* Session 035 / build 188 — wipe pre-v5 records on read (no backward
     * compat). Caller treats null as "no saved layout"; user re-saves. */
    if (rec.version !== 5) return null;
    const viewport = parseViewport(safeParseJson<unknown>(rec.viewport_json));
    const enabledTypes = safeParseJson<unknown>(rec.enabled_types_json);
    return {
        version: 5,
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
        selectedEdgeId:
            typeof rec.selected_edge_id === 'string' && rec.selected_edge_id.length > 0
                ? rec.selected_edge_id
                : undefined,
        /* Build 215 — layout mode at save time. Validated against the
         * known modes so a future code path can't smuggle in arbitrary
         * strings. */
        layoutMode:
            rec.layout_mode === 'force' || rec.layout_mode === 'layered' || rec.layout_mode === 'tree'
                ? rec.layout_mode
                : undefined,
    };
};

const recordToSummary = (rec: KvStoreRecord): LayoutSummary => ({
    slug: rec.layout_name_slug,
    name: rec.layout_name,
    savedAt: rec.saved_at,
    layoutMode:
        rec.layout_mode === 'force' || rec.layout_mode === 'layered' || rec.layout_mode === 'tree'
            ? rec.layout_mode
            : undefined,
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

/** Load a single layout by slug. Returns null on failure or pre-v5 record
 *  (no backward compat — session 035 / build 188). Updates the local cache
 *  on successful v5 load so next mount renders this layout immediately. */
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
        if (!layout) return null;
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
        version: 5,
        savedAt: new Date().toISOString(),
        layoutName: trimmed,
        nodes: payload.nodes.map((n) => ({ id: n.id, x: Math.round(n.x), y: Math.round(n.y) })),
        panels: { ...payload.panels },
        viewport: payload.viewport,
        enabledTypes: payload.enabledTypes,
        selectedNodeId: payload.selectedNodeId,
        rightTabId: payload.rightTabId,
        snapMode: payload.snapMode,
        selectedEdgeId: payload.selectedEdgeId,
        layoutMode: payload.layoutMode,
    };
    const record: KvStoreRecord = {
        _key: key,
        username: u,
        layout_name: trimmed,
        layout_name_slug: slug,
        saved_at: layout.savedAt,
        version: 5,
        nodes_json: JSON.stringify(layout.nodes),
        panels_json: JSON.stringify(layout.panels),
        // v4/v5 fields — only include keys whose values are defined so the
        // KV Store record stays minimal for layouts that don't yet have
        // every field populated.
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
        ...(typeof layout.selectedEdgeId === 'string'
            ? { selected_edge_id: layout.selectedEdgeId }
            : {}),
        ...(typeof layout.layoutMode === 'string'
            ? { layout_mode: layout.layoutMode }
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

/* ============================================================================
 * Per-mode default layout (build 216 / session 036, migrated to KV Store
 * in build 226 / session 037 / Path F)
 *
 * Each user can designate one saved layout as the "default" for each of
 * the three layout modes (Force / Layered / Tree). When the user opens
 * the topology view OR switches to a different layout mode, the default
 * for that mode (if set) auto-loads — restoring node positions, viewport,
 * panels, etc. without an explicit Load Layout click.
 *
 * Storage: KV Store collection `logserv_topology_layouts` field
 * `is_default`. Per-user-per-mode at most one record carries `is_default=1`.
 * The writer atomically clears any prior default of the same mode before
 * setting the new one.
 *
 * Cache: localStorage `logserv.topology.defaultLayout.<user>.<mode>`
 * mirrors the chosen slug for synchronous fast-mount reads (the auto-load
 * effect in IntegrationTopology runs against `defaultSlugs` populated from
 * the cache before the async KV Store fetch resolves). On mount the cache
 * is hydrated from KV Store via `fetchDefaultLayoutSlugsFromKvStore()`;
 * pre-build-226 localStorage values stay valid as cache and are written
 * back to KV Store on the first migration pass.
 *
 * Fallback: when no default is set for the active layoutMode, no auto-load
 * fires. The dashboard opens in Force mode (the readPersistedLayoutMode
 * fallback) with the SPL-emitted layout positions.
 * ============================================================================ */

const DEFAULT_LAYOUT_KEY_PREFIX = 'logserv.topology.defaultLayout.';
const DEFAULT_LAYOUT_MIGRATED_KEY_PREFIX = 'logserv.topology.defaultLayout.kvstore_migrated.';
type DefaultLayoutMode = 'force' | 'layered' | 'tree';

const defaultLayoutKey = (mode: DefaultLayoutMode): string =>
    `${DEFAULT_LAYOUT_KEY_PREFIX}${safeUser()}.${mode}`;

const defaultLayoutMigratedFlagKey = (): string =>
    `${DEFAULT_LAYOUT_MIGRATED_KEY_PREFIX}${safeUser()}`;

/** Read the cached default-layout slug for the given mode (synchronous,
 *  localStorage-backed). Used by IntegrationTopology's mount-time state
 *  initializer so the auto-load effect has something to compare against
 *  before the async KV Store fetch resolves. */
export const getDefaultLayoutSlug = (mode: DefaultLayoutMode): string | null => {
    try {
        const raw = window.localStorage.getItem(defaultLayoutKey(mode));
        return raw && raw.length > 0 ? raw : null;
    } catch (_e) {
        return null;
    }
};

/** Write the localStorage cache (synchronous). Async KV Store updates go
 *  through `setDefaultLayoutInKvStore`. Exported for legacy callers + the
 *  IntegrationTopology mount-time hydration effect; new code should call
 *  `setDefaultLayoutInKvStore` which mirrors to the cache automatically. */
export const setDefaultLayoutSlug = (mode: DefaultLayoutMode, slug: string | null): void => {
    try {
        if (slug == null || slug.length === 0) {
            window.localStorage.removeItem(defaultLayoutKey(mode));
        } else {
            window.localStorage.setItem(defaultLayoutKey(mode), slug);
        }
    } catch (_e) {
        /* ignore */
    }
};

/** Read all 3 mode defaults from the localStorage cache (synchronous). */
export const getAllDefaultLayoutSlugs = (): Record<DefaultLayoutMode, string | null> => ({
    force: getDefaultLayoutSlug('force'),
    layered: getDefaultLayoutSlug('layered'),
    tree: getDefaultLayoutSlug('tree'),
});

/* ----------------------------------------------------------------------
 * Per-user per-mode default-layout pointer KV Store collection.
 *
 * Path F design pivot (build 226 / session 037): originally tried to
 * extend `logserv_topology_layouts` with an `is_default` field, but
 * Splunk KV Store treats POST to /<key> as create-or-overwrite (not
 * partial PATCH), so a partial-field write nulled all other fields on
 * the targeted record. Splitting defaults into a separate collection
 * means each row is fully self-contained and POST safely replaces it
 * idempotently.
 *
 * Schema: `{username, layout_mode, layout_slug}` keyed by
 * "<username>::<layout_mode>". Set: POST a fresh record with all 3
 * fields. Clear: DELETE /<key>.
 * ---------------------------------------------------------------------- */

const DEFAULTS_COLLECTION = 'logserv_topology_layout_defaults';
const DEFAULTS_KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${DEFAULTS_COLLECTION}`;

interface DefaultLayoutKvRecord {
    _key: string;
    username: string;
    layout_mode: string;
    layout_slug: string;
}

const defaultLayoutRecordKey = (mode: DefaultLayoutMode): string =>
    `${safeUser()}::${mode}`;

/** Async — fetch the per-mode default-layout slug map from KV Store by
 *  reading the user's rows from `logserv_topology_layout_defaults`.
 *  Returns null entries for modes with no record. Mirrors the result to
 *  the localStorage cache so the next mount picks it up synchronously.
 *  Returns null on KV Store failure (caller falls back to cache). */
export const fetchDefaultLayoutSlugsFromKvStore = async ():
Promise<Record<DefaultLayoutMode, string | null> | null> => {
    try {
        const u = safeUser();
        const query = encodeURIComponent(JSON.stringify({ username: u }));
        const url = `${DEFAULTS_KV_BASE}?query=${query}&output_mode=json`;
        const resp = await fetch(url, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) return null;
        const records = (await resp.json()) as DefaultLayoutKvRecord[];
        const result: Record<DefaultLayoutMode, string | null> = {
            force: null, layered: null, tree: null,
        };
        records.forEach((r) => {
            if (r.layout_mode === 'force' || r.layout_mode === 'layered' || r.layout_mode === 'tree') {
                if (typeof r.layout_slug === 'string' && r.layout_slug.length > 0) {
                    result[r.layout_mode] = r.layout_slug;
                }
            }
        });
        // Mirror to cache.
        (['force', 'layered', 'tree'] as DefaultLayoutMode[]).forEach((m) => {
            setDefaultLayoutSlug(m, result[m]);
        });
        return result;
    } catch (_e) {
        return null;
    }
};

/** Async — set (or clear if `slug == null`) the default-layout slug for
 *  a mode in KV Store. Each row is keyed by "<user>::<mode>", so the
 *  write is idempotent: POST replaces the row, DELETE removes it.
 *  Returns true on success. Mirrors the chosen slug to localStorage
 *  cache on success so the next mount picks it up synchronously. */
export const setDefaultLayoutInKvStore = async (
    mode: DefaultLayoutMode,
    slug: string | null,
): Promise<boolean> => {
    try {
        const key = defaultLayoutRecordKey(mode);
        if (slug == null || slug.length === 0) {
            // Clear: DELETE the row. 404 is fine (already absent).
            const resp = await fetch(`${DEFAULTS_KV_BASE}/${encodeURIComponent(key)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
            });
            if (!resp.ok && resp.status !== 404) return false;
            setDefaultLayoutSlug(mode, null);
            return true;
        }
        // Set: POST a fresh record at /<key> (create-or-overwrite). On
        // 404 (collection-level POST endpoint not used because we want
        // to set the exact _key), fall through to collection-level POST.
        const record: DefaultLayoutKvRecord = {
            _key: key,
            username: safeUser(),
            layout_mode: mode,
            layout_slug: slug,
        };
        let resp = await fetch(`${DEFAULTS_KV_BASE}/${encodeURIComponent(key)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body: JSON.stringify(record),
        });
        if (resp.status === 404) {
            resp = await fetch(DEFAULTS_KV_BASE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body: JSON.stringify(record),
            });
        }
        if (!resp.ok) return false;
        setDefaultLayoutSlug(mode, slug);
        return true;
    } catch (_e) {
        return false;
    }
};

/* ----------------------------------------------------------------------
 * Per-user active layout mode preference KV Store collection.
 *
 * Build 229 / session 037 / Option C follow-on to Path F. The "which
 * layout mode is active on first navigation" preference itself was
 * previously localStorage-only (`logserv.topology.layoutMode`), so a
 * user who picked Tree mode on Chrome would still open in Force on
 * Firefox. This API mirrors the preference to KV Store so it follows
 * the user across browsers.
 *
 * Schema: `{username, layout_mode}` keyed by `<username>` (single row
 * per user). Set: POST a fresh row. Clear: DELETE /<key> (or just
 * leave stale; the reader returns null for absent rows).
 *
 * The localStorage cache (`LAYOUT_MODE_STORAGE_KEY` from
 * IntegrationTopology) stays as the synchronous fast-mount source so
 * the initial render doesn't flicker. The async hydrate effect on
 * mount reads from KV Store + reconciles.
 * ---------------------------------------------------------------------- */

const ACTIVE_MODE_COLLECTION = 'logserv_topology_active_mode';
const ACTIVE_MODE_KV_BASE =
    `/en-US/splunkd/__raw/servicesNS/nobody/${APP_NAMESPACE}` +
    `/storage/collections/data/${ACTIVE_MODE_COLLECTION}`;

const LAYOUT_MODE_LOCAL_STORAGE_KEY = 'logserv.topology.layoutMode';
const ACTIVE_MODE_MIGRATED_KEY_PREFIX = 'logserv.topology.activeMode.kvstore_migrated.';

interface ActiveModeKvRecord {
    _key: string;
    username: string;
    layout_mode: string;
}

const activeModeMigratedFlagKey = (): string =>
    `${ACTIVE_MODE_MIGRATED_KEY_PREFIX}${safeUser()}`;

/** Read the localStorage cache for active mode (synchronous). Returns
 *  null if unset OR localStorage is unavailable. The single source of
 *  truth for the cache key is `LAYOUT_MODE_LOCAL_STORAGE_KEY` here in
 *  persistence.ts; IntegrationTopology's `readPersistedLayoutMode`
 *  reads the same key. */
export const getCachedActiveLayoutMode = (): DefaultLayoutMode | null => {
    try {
        const v = window.localStorage.getItem(LAYOUT_MODE_LOCAL_STORAGE_KEY);
        if (v === 'force' || v === 'layered' || v === 'tree') return v;
    } catch (_e) { /* ignore */ }
    return null;
};

/** Write the localStorage cache. Async write-through to KV Store goes
 *  through `setActiveLayoutModeInKvStore`. */
export const setCachedActiveLayoutMode = (mode: DefaultLayoutMode | null): void => {
    try {
        if (mode == null) {
            window.localStorage.removeItem(LAYOUT_MODE_LOCAL_STORAGE_KEY);
        } else {
            window.localStorage.setItem(LAYOUT_MODE_LOCAL_STORAGE_KEY, mode);
        }
    } catch (_e) { /* ignore */ }
};

/** Async — fetch the active layout mode preference from KV Store.
 *  Returns null if no row exists for the user OR on KV Store failure.
 *  Mirrors the result to localStorage cache as a side effect. */
export const fetchActiveLayoutModeFromKvStore = async (): Promise<DefaultLayoutMode | null> => {
    try {
        const u = safeUser();
        const url = `${ACTIVE_MODE_KV_BASE}/${encodeURIComponent(u)}?output_mode=json`;
        const resp = await fetch(url, {
            credentials: 'same-origin',
            headers: sharedHeaders(),
        });
        if (!resp.ok) {
            // 404 (record absent) is a valid empty state; other failures
            // also fall through to null so the localStorage fast-mount
            // value continues to win.
            return null;
        }
        const record = (await resp.json()) as ActiveModeKvRecord;
        const mode = record.layout_mode;
        if (mode === 'force' || mode === 'layered' || mode === 'tree') {
            setCachedActiveLayoutMode(mode);
            return mode;
        }
        return null;
    } catch (_e) {
        return null;
    }
};

/** Async — write (or clear if `mode == null`) the active layout mode
 *  preference to KV Store + mirror to localStorage cache. POST replaces
 *  the single row; DELETE removes it. Returns true on success, false
 *  on any failure (cache untouched on fail). Build 231 / session 037
 *  added the `null` clear path so the Manage Layouts modal checkbox
 *  can both set and unset the user's explicit default-mode preference. */
export const setActiveLayoutModeInKvStore = async (mode: DefaultLayoutMode | null): Promise<boolean> => {
    try {
        const u = safeUser();
        if (mode == null) {
            const resp = await fetch(`${ACTIVE_MODE_KV_BASE}/${encodeURIComponent(u)}`, {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
            });
            // 404 (row already absent) is a successful clear.
            if (!resp.ok && resp.status !== 404) return false;
            setCachedActiveLayoutMode(null);
            return true;
        }
        const record: ActiveModeKvRecord = {
            _key: u,
            username: u,
            layout_mode: mode,
        };
        let resp = await fetch(`${ACTIVE_MODE_KV_BASE}/${encodeURIComponent(u)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: mutatingHeaders(),
            body: JSON.stringify(record),
        });
        if (resp.status === 404) {
            resp = await fetch(ACTIVE_MODE_KV_BASE, {
                method: 'POST',
                credentials: 'same-origin',
                headers: mutatingHeaders(),
                body: JSON.stringify(record),
            });
        }
        if (!resp.ok) return false;
        setCachedActiveLayoutMode(mode);
        return true;
    } catch (_e) {
        return false;
    }
};

/** Migrate localStorage active-mode value to KV Store on first run.
 *  Idempotent — gated by a per-user `activeMode.kvstore_migrated.<user>`
 *  flag. If KV Store already has a row for this user, skip migration.
 *  Best-effort: failures don't block the UI. */
export const migrateLegacyLocalStorageActiveMode = async (): Promise<void> => {
    try {
        const flagKey = activeModeMigratedFlagKey();
        if (window.localStorage.getItem(flagKey) === 'true') return;
        // If KV Store already has a row for this user, skip migration.
        const remote = await fetchActiveLayoutModeFromKvStore();
        if (remote) {
            window.localStorage.setItem(flagKey, 'true');
            return;
        }
        const cached = getCachedActiveLayoutMode();
        if (cached) {
            await setActiveLayoutModeInKvStore(cached);
        }
        window.localStorage.setItem(flagKey, 'true');
    } catch (_e) { /* ignore */ }
};

/** Migrate localStorage default-layout slugs to KV Store on first run.
 *  Idempotent — gated by a per-user `defaultLayout.kvstore_migrated.<user>`
 *  flag. If KV Store already has any rows in the defaults collection
 *  for this user, skip migration. Best-effort: failures don't block UI. */
export const migrateLegacyLocalStorageDefaultLayouts = async (): Promise<void> => {
    try {
        const flagKey = defaultLayoutMigratedFlagKey();
        if (window.localStorage.getItem(flagKey) === 'true') return;
        // If KV Store already has rows for this user, skip migration.
        const remote = await fetchDefaultLayoutSlugsFromKvStore();
        if (remote && (remote.force || remote.layered || remote.tree)) {
            window.localStorage.setItem(flagKey, 'true');
            return;
        }
        // Validate localStorage entries against existing layouts before
        // writing — avoids carrying forward a stale slug for a layout
        // that's been deleted.
        const cached = getAllDefaultLayoutSlugs();
        const summaries = await listLayouts();
        const modes: DefaultLayoutMode[] = ['force', 'layered', 'tree'];
        for (const m of modes) {
            const slug = cached[m];
            if (slug && summaries.some((s) => s.slug === slug && s.layoutMode === m)) {
                // eslint-disable-next-line no-await-in-loop
                await setDefaultLayoutInKvStore(m, slug);
            }
        }
        window.localStorage.setItem(flagKey, 'true');
    } catch (_e) {
        /* ignore */
    }
};
