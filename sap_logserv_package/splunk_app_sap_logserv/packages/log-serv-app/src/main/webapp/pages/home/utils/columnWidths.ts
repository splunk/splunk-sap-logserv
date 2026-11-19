/**
 * columnWidths.ts - the per-browser store of the table column widths a user drags (build 404).
 *
 * Every table panel (components/DataTable.tsx) lets the user drag a column's edge. The widths dragged on a dashboard
 * panel are remembered in this browser, per user: one localStorage entry, `logserv.tableColumnWidths.v1.<user>`,
 * holding { p: { <panelId>: { w: { <column key>: <px> }, t: <epoch seconds of the last change> } } }. Only dragged
 * columns are stored; a column never dragged keeps its width hint or its automatic width. A panel is
 * `d:<dashboard id>|<panel title>` (unique across the dashboards); a table with no dashboard or no title (the AI
 * Assistant's result tables) is resizable but keeps its widths in memory only.
 *
 * Safe by construction: every storage read and write is caught and skipped on error (private windows, blocked
 * storage, quota), what is read is validated (own properties only, no __proto__ / constructor / prototype keys,
 * finite whole pixels clamped to WIDTH_FLOOR..WIDTH_MAX, string keys within their caps), widths of columns a panel no
 * longer has are dropped on that panel's next change, and the entry is capped (MAX_PANELS panels, the least recently
 * changed evicted first, MAX_COLUMNS columns a panel, MAX_BYTES bytes in all). Writes are debounced (the resize
 * callback fires on every mouse move) and merge with what another tab wrote in the meantime: the store re-reads the
 * entry and replaces only the panels this tab changed.
 *
 * No React and no Splunk modules here, so the gate can run it (utils/columnWidths.consistency-test.ts).
 */

/** The narrowest width a drag or an arrow key gives a column (but see resizeFloor). */
export const WIDTH_MIN = 40;
/** The narrowest width the store keeps: the library's own drag floor. Below WIDTH_MIN only for a column that was
 *  already drawn narrower than WIDTH_MIN when its drag began (build 406). */
export const WIDTH_FLOOR = 16;
export const WIDTH_MAX = 2000;
export const MAX_PANELS = 150;
export const MAX_COLUMNS = 64;
export const MAX_COL_KEY = 128;
export const MAX_PANEL_ID = 256;
export const MAX_BYTES = 64 * 1024;
export const WRITE_DELAY_MS = 300;
const KEY_PREFIX = 'logserv.tableColumnWidths.v1.';
const BAD_KEYS = ['__proto__', 'constructor', 'prototype'];

export interface PanelWidths {
    /** Column key -> width in whole pixels. */
    w: { [col: string]: number };
    /** Epoch seconds of the last change, for least-recently-changed eviction. */
    t: number;
}

export interface WidthStore {
    p: { [panelId: string]: PanelWidths };
}

/** The minimal Storage this module uses (window.localStorage, or a fake in the tests). */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** The localStorage key of a user's widths. */
export const storageKey = (user: string | null | undefined): string =>
    KEY_PREFIX + (typeof user === 'string' && user !== '' ? user : 'anonymous');

/** A dashboard panel's id, or null when the table is not on a dashboard or its panel has no title. */
export const panelIdFor = (dashboardId: string | null | undefined, title: string | null | undefined): string | null => {
    if (typeof dashboardId !== 'string' || dashboardId === '' || typeof title !== 'string') {
        return null;
    }
    const t = title.replace(/\s+/g, ' ').trim();
    if (t === '') {
        return null;
    }
    const id = `d:${dashboardId}|${t}`;
    return id.length <= MAX_PANEL_ID ? id : null;
};

/** A width in whole pixels within min..WIDTH_MAX (min is WIDTH_MIN unless given, and never under WIDTH_FLOOR), or
 *  null when it is not a finite number. */
export const clampWidth = (width: unknown, min: number = WIDTH_MIN): number | null => {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
        return null;
    }
    const floor = typeof min === 'number' && Number.isFinite(min) ? Math.max(WIDTH_FLOOR, Math.round(min)) : WIDTH_MIN;
    return Math.min(WIDTH_MAX, Math.max(floor, Math.round(width)));
};
/**
 * The narrowest width a drag that starts on a column drawn `drawn` pixels wide may give it (build 406): WIDTH_MIN,
 * or the drawn width when the column is already narrower than that, so its edge does not jump out to WIDTH_MIN on
 * the first pixel of the drag. Such a column can be widened, and narrowed back to where it started, not further.
 */
export const resizeFloor = (drawn: unknown): number => {
    if (typeof drawn !== 'number' || !Number.isFinite(drawn) || drawn >= WIDTH_MIN) {
        return WIDTH_MIN;
    }
    return Math.max(WIDTH_FLOOR, Math.floor(drawn));
};

const goodKey = (k: string, max: number): boolean => k !== '' && k.length <= max && BAD_KEYS.indexOf(k) === -1;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const emptyStore = (): WidthStore => ({ p: Object.create(null) });

/** Parse what the storage held; anything malformed is left out (never throws). */
export const parseStore = (raw: string | null | undefined): WidthStore => {
    const out = emptyStore();
    if (typeof raw !== 'string' || raw === '') {
        return out;
    }
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        return out;
    }
    if (!isPlainObject(data) || !isPlainObject(data.p)) {
        return out;
    }
    const panels = data.p;
    Object.keys(panels).forEach((pid) => {
        if (!Object.prototype.hasOwnProperty.call(panels, pid) || !goodKey(pid, MAX_PANEL_ID)) {
            return;
        }
        const entry = panels[pid];
        if (!isPlainObject(entry) || !isPlainObject(entry.w)) {
            return;
        }
        const widths = entry.w;
        const w: { [col: string]: number } = Object.create(null);
        let n = 0;
        Object.keys(widths).forEach((col) => {
            if (n >= MAX_COLUMNS || !Object.prototype.hasOwnProperty.call(widths, col) || !goodKey(col, MAX_COL_KEY)) {
                return;
            }
            const v = clampWidth(widths[col], WIDTH_FLOOR);
            if (v !== null) {
                w[col] = v;
                n += 1;
            }
        });
        if (n > 0) {
            const t = typeof entry.t === 'number' && Number.isFinite(entry.t) ? Math.floor(entry.t) : 0;
            out.p[pid] = { w, t };
        }
    });
    return out;
};

/** The widths stored for a panel, limited to the columns it has now. */
export const panelWidths = (store: WidthStore, panelId: string | null, columnKeys: string[]): { [col: string]: number } => {
    // No prototype: a column keyed like an Object member (constructor, toString, __proto__ - possible in the AI
    // Assistant's result tables) must read as "no width", never as an inherited function or object.
    const out: { [col: string]: number } = Object.create(null);
    if (panelId === null) {
        return out;
    }
    const entry = store.p[panelId];
    if (!entry) {
        return out;
    }
    columnKeys.forEach((col) => {
        if (Object.prototype.hasOwnProperty.call(entry.w, col)) {
            out[col] = entry.w[col];
        }
    });
    return out;
};

/** Keep the store within its caps: the least recently changed panels go first. Returns a new store. */
export const enforceCaps = (store: WidthStore): WidthStore => {
    // Newest first; equal times in id order, so the result does not depend on the key order read.
    const byId = (a: string, b: string): number => {
        if (a === b) {
            return 0;
        }
        return a < b ? -1 : 1;
    };
    const ids = Object.keys(store.p).sort((a, b) => store.p[b].t - store.p[a].t || byId(a, b));
    const out = emptyStore();
    ids.slice(0, MAX_PANELS).forEach((pid) => {
        out.p[pid] = store.p[pid];
    });
    let kept = ids.slice(0, MAX_PANELS);
    while (kept.length > 0 && JSON.stringify(out).length > MAX_BYTES) {
        const oldest = kept[kept.length - 1];
        delete out.p[oldest];
        kept = kept.slice(0, -1);
    }
    return out;
};

/** The store with one column's width set for a panel (stale columns of that panel dropped). Returns a new store. */
export const withWidth = (
    store: WidthStore,
    panelId: string,
    col: string,
    width: number,
    nowSec: number,
    columnKeys: string[],
): WidthStore => {
    // The caller applies the drag's own floor (clampWidth, resizeFloor); the store keeps anything from WIDTH_FLOOR up.
    const v = clampWidth(width, WIDTH_FLOOR);
    if (v === null || !goodKey(col, MAX_COL_KEY) || !goodKey(panelId, MAX_PANEL_ID)) {
        return store;
    }
    const prev = store.p[panelId];
    if (prev && prev.w[col] === v) {
        return store;
    }
    const w: { [c: string]: number } = Object.create(null);
    if (prev) {
        Object.keys(prev.w).forEach((c) => {
            if (columnKeys.indexOf(c) !== -1) {
                w[c] = prev.w[c];
            }
        });
    }
    w[col] = v;
    const out = emptyStore();
    Object.keys(store.p).forEach((pid) => {
        out.p[pid] = store.p[pid];
    });
    out.p[panelId] = { w, t: nowSec };
    return enforceCaps(out);
};

/** The store without a panel. Returns a new store. */
export const withoutPanel = (store: WidthStore, panelId: string): WidthStore => {
    const out = emptyStore();
    Object.keys(store.p).forEach((pid) => {
        if (pid !== panelId) {
            out.p[pid] = store.p[pid];
        }
    });
    return out;
};

/** Read a user's store from storage; an unreadable storage reads as empty. */
export const readStore = (storage: StorageLike | null, key: string): WidthStore => {
    if (!storage) {
        return emptyStore();
    }
    try {
        return parseStore(storage.getItem(key));
    } catch (err) {
        return emptyStore();
    }
};

/** Write a user's store (an empty one removes the entry). False when the storage refused it. */
export const writeStore = (storage: StorageLike | null, key: string, store: WidthStore): boolean => {
    if (!storage) {
        return false;
    }
    try {
        if (Object.keys(store.p).length === 0) {
            storage.removeItem(key);
        } else {
            storage.setItem(key, JSON.stringify(store));
        }
        return true;
    } catch (err) {
        return false;
    }
};

type Listener = () => void;

/**
 * A user's widths, shared by every table on the page: a change in one table (or a reset from the panel header)
 * reaches the others at once, and the storage is written once, WRITE_DELAY_MS after the last change.
 */
export class ColumnWidthStore {
    private mem: WidthStore;

    private dirty: { [panelId: string]: true } = Object.create(null);

    private timer: ReturnType<typeof setTimeout> | null = null;

    private listeners: Listener[] = [];

    private readonly storage: StorageLike | null;

    private readonly key: string;

    private readonly nowSec: () => number;

    constructor(storage: StorageLike | null, key: string, nowSec?: () => number) {
        this.storage = storage;
        this.key = key;
        this.nowSec = nowSec || (() => Math.floor(Date.now() / 1000));
        this.mem = readStore(storage, key);
    }

    /** The widths stored for a panel, limited to its current columns. */
    get(panelId: string | null, columnKeys: string[]): { [col: string]: number } {
        return panelWidths(this.mem, panelId, columnKeys);
    }

    /** True when the panel has a stored width for one of its current columns. */
    has(panelId: string | null, columnKeys: string[]): boolean {
        return Object.keys(this.get(panelId, columnKeys)).length > 0;
    }

    set(panelId: string, col: string, width: number, columnKeys: string[]): void {
        const next = withWidth(this.mem, panelId, col, width, this.nowSec(), columnKeys);
        if (next === this.mem) {
            return;
        }
        this.mem = next;
        this.dirty[panelId] = true;
        this.schedule();
        this.notify();
    }

    /** Several columns of one panel at once: one write and one notification (build 406). */
    setMany(panelId: string, widths: { [col: string]: number }, columnKeys: string[]): void {
        let next = this.mem;
        const now = this.nowSec();
        Object.keys(widths).forEach((col) => {
            if (Object.prototype.hasOwnProperty.call(widths, col)) {
                next = withWidth(next, panelId, col, widths[col], now, columnKeys);
            }
        });
        if (next === this.mem) {
            return;
        }
        this.mem = next;
        this.dirty[panelId] = true;
        this.schedule();
        this.notify();
    }
    reset(panelId: string): void {
        if (!this.mem.p[panelId]) {
            return;
        }
        this.mem = withoutPanel(this.mem, panelId);
        this.dirty[panelId] = true;
        this.schedule();
        this.notify();
    }

    subscribe(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter((l) => l !== listener);
        };
    }

    /**
     * Write now: re-read what the storage holds (another tab may have written), replace the panels this tab changed,
     * and write that. This tab keeps its own widths: another tab's changes show here on the next page load, and a
     * storage that cannot be read or written never drops a width this tab has.
     */
    flush(): boolean {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const changed = Object.keys(this.dirty);
        if (changed.length === 0) {
            return true;
        }
        let disk = readStore(this.storage, this.key);
        changed.forEach((pid) => {
            disk = withoutPanel(disk, pid);
            if (this.mem.p[pid]) {
                disk.p[pid] = this.mem.p[pid];
            }
        });
        disk = enforceCaps(disk);
        const ok = writeStore(this.storage, this.key, disk);
        this.dirty = Object.create(null);
        return ok;
    }

    private schedule(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, WRITE_DELAY_MS);
    }

    private notify(): void {
        this.listeners.slice().forEach((l) => {
            try {
                l();
            } catch (err) {
                // a listener's error must not stop the others
            }
        });
    }
}

/** The browser's localStorage, or null where it cannot be reached. */
export const browserStorage = (): StorageLike | null => {
    try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    } catch (err) {
        return null;
    }
};

/** The same widths with one column set, as a new map without a prototype (the in-memory widths of a table). */
export const withOwnWidth = (widths: { [col: string]: number }, col: string, width: number): { [col: string]: number } => {
    const out: { [col: string]: number } = Object.create(null);
    Object.keys(widths).forEach((k) => {
        out[k] = widths[k];
    });
    out[col] = width;
    return out;
};

/** Keep only the widths of the given columns, in their order. */
export const pickWidths = (widths: { [col: string]: number }, columnKeys: string[]): { [col: string]: number } => {
    // No prototype, as in panelWidths.
    const out: { [col: string]: number } = Object.create(null);
    columnKeys.forEach((col) => {
        if (Object.prototype.hasOwnProperty.call(widths, col)) {
            out[col] = widths[col];
        }
    });
    return out;
};

/** True when two width maps hold the same columns at the same widths. */
export const sameWidths = (a: { [col: string]: number }, b: { [col: string]: number }): boolean => {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
};

/** A '120px' width hint as a number of pixels, or undefined. */
export const hintPx = (width: string | undefined): number | undefined => {
    const m = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(width || '');
    return m ? Number(m[1]) : undefined;
};
