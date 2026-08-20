/**
 * columnCoverage — the §18.8a-1/2 values-free column-coverage side channel.
 *
 * The renderer (DataTable / TraceWaterfall) is the ONLY place that has both the
 * rendered rows and the authoritative displayed column set (`ColumnDef[].key`),
 * so IT reduces the rows to a coverage summary — counts and blank-kinds, never
 * values — and publishes it here keyed by the panel's dispatched SPL, exactly
 * like the §17.1 raw-twin channel. The Diagnose entry points resolve
 * `coverageFor(spl)` at request-build time.
 *
 * WHY VALUES NEVER CROSS THIS CHANNEL (§18.8a-1, review blockers H-F2/W-1):
 * `buildPanelReportModel` serialises the whole facts object into the PDF
 * appendix, the .json twin AND the persisted `logserv_diag_reports` row (a
 * world-readable collection) while the report banner asserts "no raw log
 * events". Carrying row values anywhere the drawer can reach would silently
 * bypass the §7.10 opt-in/redaction/never-persist apparatus. A summary of
 * counts cannot leak what it never contained.
 *
 * React-free on purpose: the build gate's TS loader runs this module and its
 * consistency test.
 */

/** How a blank cell was blank — the four §18.8a-2 kinds (review H-F17/W-11).
 *  All four COUNT as blank; the kind feeds the evidence wording because
 *  absent-key and empty-string have different causes and owners. */
export type BlankKind = 'absent' | 'empty-string' | 'sentinel' | 'empty-multivalue';

export interface ColumnCoverageColumn {
    /** The displayed column key (`ColumnDef.key` — the render truth). */
    key: string;
    /** Rows (of `total`) carrying a real value for this key. */
    populated: number;
    /** Dominant blank kind, present when `populated < total`. */
    blankKind?: BlankKind;
    /** True when the ColumnDef carries a `render` function — a fully-blank
     *  render column may still draw content composed from OTHER fields
     *  (TraceWaterfall's synthetic "Timeline" class), so it is never probed
     *  (§18.8a-2 `derived`). */
    hasRender: boolean;
}

export interface ColumnCoverageSummary {
    columns: ColumnCoverageColumn[];
    /** Rows examined (after the reduction cap). */
    total: number;
    /** True when the renderer had more rows than `COVERAGE_ROW_CAP` — every
     *  blank claim over a capped reduction is graded at most `possible`
     *  (§18.8a-3). */
    capped: boolean;
}

/** §18.8a-2 — the reduction cap. The rows examined are the FIRST N in the
 *  panel's own sort order (usually `| sort -count`-style), i.e. a head-biased
 *  sample, and the verdict wording must say so. */
export const COVERAGE_ROW_CAP = 500;

const SENTINEL = '(none)';

const classifyValue = (v: unknown): BlankKind | null => {
    if (v === null || v === undefined) return 'absent';
    if (Array.isArray(v)) return v.length === 0 ? 'empty-multivalue' : null;
    if (typeof v === 'string') {
        if (v === '') return 'empty-string';
        if (v === SENTINEL) return 'sentinel';
        return null;
    }
    return null; // numbers (including 0), booleans, objects: populated
};

/**
 * Pure reducer: rows × declared columns → the summary. `columns` is the
 * renderer's own column list (key + whether a render fn exists). A key absent
 * from every row is BLANK (`absent`), never skipped — Splunk's JSON omits
 * fields with no value, which is exactly the reported-symptom shape
 * (§18.8a-2, review blocker H-F3).
 */
export const computeColumnCoverage = (
    rows: ReadonlyArray<unknown>,
    columns: ReadonlyArray<{ key: string; hasRender: boolean }>,
): ColumnCoverageSummary => {
    const capped = rows.length > COVERAGE_ROW_CAP;
    const slice = capped ? rows.slice(0, COVERAGE_ROW_CAP) : rows;
    const out: ColumnCoverageColumn[] = columns.map((c) => {
        let populated = 0;
        const kinds: Record<BlankKind, number> = {
            absent: 0,
            'empty-string': 0,
            sentinel: 0,
            'empty-multivalue': 0,
        };
        for (const rowU of slice) {
            const row = (rowU ?? {}) as Record<string, unknown>;
            const kind = classifyValue(row[c.key]);
            if (kind === null) populated += 1;
            else kinds[kind] += 1;
        }
        const col: ColumnCoverageColumn = { key: c.key, populated, hasRender: c.hasRender };
        if (populated < slice.length) {
            let best: BlankKind = 'absent';
            let bestN = -1;
            (Object.keys(kinds) as BlankKind[]).forEach((k) => {
                if (kinds[k] > bestN) {
                    best = k;
                    bestN = kinds[k];
                }
            });
            col.blankKind = best;
        }
        return col;
    });
    return { columns: out, total: slice.length, capped };
};

// ---------------------------------------------------------------------------
// The bounded publish/resolve map (the rawTwin pattern).
// ---------------------------------------------------------------------------

const MAP_CAP = 400;
const map = new Map<string, ColumnCoverageSummary>();

export const recordColumnCoverage = (spl: string, summary: ColumnCoverageSummary): void => {
    if (!spl) return;
    // Re-insert refreshes recency; evict the oldest beyond the cap.
    if (map.has(spl)) map.delete(spl);
    map.set(spl, summary);
    if (map.size > MAP_CAP) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
    }
};

export const coverageFor = (spl: string): ColumnCoverageSummary | null => map.get(spl) ?? null;

export const clearColumnCoverage = (): void => map.clear();

export const coverageCount = (): number => map.size;
