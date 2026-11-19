import React, { ReactNode, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import Table from '@splunk/react-ui/Table';
import { logservTheme } from '../styles/logservTheme';
import PanelLoading from './PanelLoading';
import EmptyStateHint from './EmptyStateHint';
import { usePanelDiagnostic } from './PanelMeta';
import { AliasedHost, copyOnOneLine } from './HostName';
import { useHostAlias } from '../state/HostAliasProvider';
import { computeColumnCoverage, recordColumnCoverage } from '../utils/columnCoverage';
import { clampWidth, hintPx, panelIdFor, pickWidths, resizeFloor, sameWidths, withOwnWidth } from '../utils/columnWidths';
import {
    DashboardIdContext,
    TableWidthResetContext,
    columnWidthsJustChanged,
    noteColumnWidthChange,
    sharedColumnWidthStore,
} from '../state/ColumnWidthsState';

/**
 * DataTable — wraps @splunk/react-ui/Table with our zebra + cyan-accent
 * defaults and a simple column/row model derived from Splunk search results.
 *
 * Sortable by default: click any column header to cycle asc → desc → none.
 * Numeric values sort numerically when both sides parse as numbers; otherwise
 * locale-aware string compare.
 *
 * Pagination by default: shows `pageSize` rows per page (default 10) with a
 * footer offering prev/next navigation, current-page indicator, and total
 * row count. Pagination only renders if the row count exceeds `pageSize`.
 * Pass `paginationDisabled` to render every row (e.g., for short tables that
 * don't benefit from paging).
 *
 * Resizable columns (build 404): drag the edge of a column heading (or focus
 * it and press the arrow keys; a double-click fits the column to the rows on
 * the page). On a dashboard the widths are remembered in this browser for
 * that panel (utils/columnWidths.ts); the panel header then shows a "Reset
 * column widths" button (FramedPanel). The table keeps the automatic layout
 * it had before: a column never dragged keeps its width hint or its content
 * width, and the table never scrolls sideways, so a dragged column gives way
 * when the panel is too narrow for it.
 */

/* Build 404 — the table stays on the automatic layout it had before. Every
 * HeadCell carries a width once columns are resizable, and the library then
 * puts the table on a fixed layout of width 0 (each column exactly its width,
 * scrolling sideways when they add up to more than the panel); this inline
 * style (Table's public tableStyle prop) puts back the automatic layout at the
 * panel's full width. Measured in Edge at 357 / 600 / 900 / 1300 px: an
 * undragged table's columns are the same widths as in build 403. */
const AUTO_TABLE_LAYOUT: React.CSSProperties = { tableLayout: 'auto', width: '100%', minWidth: '100%' };

/** A column drawn more than this many pixels narrower than its width starts a drag from where it is drawn. */
const DRAWN_NARROWER_PX = 1;

/** Build 406: with other columns holding widths too, a column drawn at less than this share of its width is
 *  taken as squeezed, and a drag on it first sets every such column to the width it is drawn at. */
const OVERSUBSCRIBED_RATIO = 0.75;

/** What a drag or an arrow key noted when it started on a resize handle. */
interface ResizeStart {
    /** The column's key. */
    col: string;
    /** Taken off every width the library asks for (how much narrower than its width the column was drawn). */
    shift: number;
    /** The narrowest width this drag gives the column (utils/columnWidths.ts resizeFloor). */
    floor: number;
    /** Other columns to set to their drawn widths with the first step, or null. */
    others: { [key: string]: number } | null;
}

export interface ColumnDef<TRow = Record<string, unknown>> {
    key: string;
    label: ReactNode;
    /** Optional custom cell renderer. Receives the raw value and the full row. */
    render?: (value: unknown, row: TRow) => ReactNode;
    /** Width hint in pixels (e.g., "120px"). Since build 404 a column the user
     *  has dragged takes its dragged width instead, and a hint that is not in
     *  px (none in the App) counts as no hint. */
    width?: string;
    /** Right-align numeric columns. */
    align?: 'left' | 'right' | 'center';
    /** Disable sort on this column. Defaults to true (sortable). */
    sortable?: boolean;
    /** Build 400: the column holds a host value (a host name, a short name or an IP
     *  address). Where Settings > Host Names gives it a name, the cell shows the name,
     *  then the raw value muted, on one line, with "name - raw value" as the tooltip;
     *  with no name it shows exactly what it shows without the flag. Default cells only: a
     *  column with `render` ignores the flag, and its render function alone decides what
     *  the cell shows (no column in this build renders a name that way). Sorting, row
     *  clicks (onRowClick gets the raw row) and the click-through searches keep the raw
     *  value. Write it AFTER `label`, as in
     *  `{ key: 'host', label: 'Host', hostAlias: true }`: bin/check-diagnostics.js reads
     *  column definitions as `{ key: '...', label: '...'` with nothing between. */
    hostAlias?: boolean;
}

interface DataTableProps<TRow> {
    columns: ColumnDef<TRow>[];
    rows: TRow[] | null;
    loading?: boolean;
    error?: Error | null;
    emptyMessage?: ReactNode;
    onRowClick?: (row: TRow) => void;
    /** Stripe odd rows. Defaults to true. */
    zebra?: boolean;
    /** Initial sort column key. */
    initialSortKey?: string;
    /** Initial sort direction. Defaults to 'asc'. */
    initialSortDir?: 'asc' | 'desc';
    /** Number of rows shown per page. If omitted, the table auto-fits the
     *  number of rows to the available height of its parent FramedPanel
     *  (so two tables in the same row will each fill their stretched panel
     *  with no empty space below the pagination). */
    pageSize?: number;
    /** Disable pagination — render every row. */
    paginationDisabled?: boolean;
}

type SortDir = 'asc' | 'desc' | 'none';

const Wrapper = styled.div<{ $zebra: boolean; $clickableRows: boolean }>`
    /* Re-skin the @splunk/react-ui Table to match our framed-dark-cards palette. */
    & table {
        border-collapse: collapse;
        width: 100%;
    }

    /* Build 346 — THE fix for tables scrolling horizontally in narrow panels.
       Measured on Linux at 1440px with the rail expanded: 4 tables overflowed
       their containers (21 / 218 / 85 / 78 px); with this rule, 0.

       Splunk renders each head cell as th > div(flex) > div(GRID) > span(label),
       and that label span is a GRID ITEM left at the default min-width:auto,
       so it cannot shrink below its content. Because the table is
       table-layout:auto, the width:100% above is only a suggestion and the
       real width is the sum of those header minimums — which is why a table
       of 7-character cells still demanded 378px inside a 357px panel.

       Established by experiment on the live page rather than by reading: rules
       targeting the th, or table-layout:fixed, did NOT fix it (fixed made it
       worse, 3 remaining); min-width:0 on the label span fixed it completely,
       and on its own — overflow:hidden there was not needed.

       Deliberately selected structurally rather than by Splunk's class name
       (HeadInnerStyles__StyledLabel): both work, but a vendor class is a
       vendor internal. If Splunk changes this markup the rule simply stops
       matching and we are back to today's scrollbar — degradation, not
       breakage. */
    & thead th span {
        min-width: 0;
    }

    /* Magnetic table header (§6, build 254): 12px semibold sentence case
       (the old uppercase + letter-spacing dropped), default text color. */
    & thead th {
        background: ${logservTheme.colors.tableHeaderBackground} !important;
        color: ${logservTheme.colors.textDefault} !important;
        font-size: 12px;
        font-weight: ${logservTheme.fontWeight.semibold};
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    }

    & tbody td {
        color: ${logservTheme.colors.textDefault};
        font-size: ${logservTheme.fontSize.body};
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
        background: transparent !important;
        transition: background-color 150ms ease-out;
    }

    /* Magnetic row hover wash — on every table, not just clickable ones. */
    & tbody tr:hover td {
        background: ${logservTheme.colors.hoverBackground} !important;
    }

    ${(p) =>
        p.$zebra
            ? `
        & tbody tr:nth-child(odd) td {
            background: ${logservTheme.colors.tableRowOdd} !important;
        }
    `
            : ''}

    ${(p) =>
        p.$clickableRows
            ? `
        /* Drilldown affordance — when the table has an onRowClick handler,
           rows additionally read as interactive: cursor + interact-accent
           text on hover (the bg wash itself applies to every table above).
           Build 157 / session 027 task 4. */
        & tbody tr {
            cursor: pointer;
        }
        & tbody tr:hover td {
            color: ${logservTheme.colors.cyanLight};
        }
    `
            : ''}
`;

const StatusLine = styled.div`
    padding: ${logservTheme.spacing.lg};
    color: ${logservTheme.colors.textMuted};
    text-align: center;
    font-size: ${logservTheme.fontSize.small};
`;

const ErrorLine = styled(StatusLine)`
    color: ${logservTheme.colors.red};
`;

const SortableHeader = styled.span<{ $align?: 'left' | 'right' | 'center' }>`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
    width: 100%;
    justify-content: ${(p) => (p.$align === 'right' ? 'flex-end' : p.$align === 'center' ? 'center' : 'flex-start')};

    /* Build 346 — keep the sort affordance intact when a header is squeezed.
     * (No backticks in this comment: it sits inside a styled-components
     * tagged template, where one would terminate the literal early.)
     *
     * NOT the fix for the table overflow — that is the min-width:0 rule on
     * the head-cell label in Wrapper above. My first attempt put overflow
     * here and it changed nothing, because THIS element is a child of the
     * grid item, not the grid item itself, and the automatic-minimum rule
     * applies to the item. The live experiment is recorded in Wrapper.
     *
     * What this pair does earn: once the label span CAN shrink, the squeeze
     * has to land somewhere. overflow:hidden plus HeadLabel's ellipsis makes
     * it land on the text, which is recoverable — this element already
     * carries a title attribute with the full label — rather than on the
     * sort arrows, which are not. */
    min-width: 0;
    overflow: hidden;

    &:hover {
        color: ${logservTheme.colors.cyanLight};
    }
`;

/* The header's text. Shrinks and ellipsises so the SORT ARROWS never get
 * squeezed out — losing a character of a label is recoverable (the title
 * tooltip has it in full); losing the sort affordance is not. */
const HeadLabel = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const SortIndicator = styled.span<{ $dir: SortDir }>`
    font-size: 10px;
    color: ${(p) => (p.$dir === 'none' ? logservTheme.colors.textMuted : logservTheme.colors.cyanLight)};
    opacity: ${(p) => (p.$dir === 'none' ? 0.4 : 1)};
    line-height: 1;
    /* Never absorb the squeeze — the label does. */
    flex: 0 0 auto;
`;

const PaginationFooter = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textDefault};
    font-size: ${logservTheme.fontSize.small};
    border-top: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const PageButtons = styled.div`
    display: flex;
    align-items: center;
    gap: ${logservTheme.spacing.xs};
`;

const PageBtn = styled.button`
    /* Magnetic outline-button grammar (§6, build 254): 4px radius, 150ms
       transitions, focus ring token. */
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textActive};
    padding: 2px 8px;
    cursor: pointer;
    border-radius: ${logservTheme.radius.medium};
    font-size: 12px;
    line-height: 1.4;
    min-width: 24px;
    font-family: inherit;
    transition: background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.panelBorder};
        color: ${logservTheme.colors.cyanLight};
    }

    &:focus-visible {
        outline: 2px solid ${logservTheme.colors.focusRing};
        outline-offset: 1px;
    }

    &:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }
`;

const PageIndicator = styled.span`
    color: ${logservTheme.colors.textMuted};
    padding: 0 ${logservTheme.spacing.sm};
    font-feature-settings: 'tnum' 1;
`;

const RowCount = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-feature-settings: 'tnum' 1;
`;

const compareValues = (a: unknown, b: unknown): number => {
    // Treat null/undefined as smallest
    const aNullish = a === null || typeof a === 'undefined' || a === '';
    const bNullish = b === null || typeof b === 'undefined' || b === '';
    if (aNullish && bNullish) return 0;
    if (aNullish) return -1;
    if (bNullish) return 1;

    // Try numeric compare first (handles "1,234" + "1.5" + "12 ms"-prefix-stripped numbers)
    const aStr = String(a).replace(/,/g, '').trim();
    const bStr = String(b).replace(/,/g, '').trim();
    const aNum = parseFloat(aStr);
    const bNum = parseFloat(bStr);
    const aLooksNum = !Number.isNaN(aNum) && /^-?\d/.test(aStr);
    const bLooksNum = !Number.isNaN(bNum) && /^-?\d/.test(bStr);
    if (aLooksNum && bLooksNum) {
        return aNum - bNum;
    }

    // Fallback: locale-aware string compare
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

/** Default fallback page size when no prop is given AND auto-fit measurement
 *  hasn't completed yet (e.g., on the first render before the ResizeObserver
 *  has fired). Stays small so the table never renders absurdly tall by mistake. */
const DEFAULT_PAGE_SIZE = 10;

/** Walk up from `el` until we hit the nearest FramedPanel root (a `<section>`
 *  styled element). Returns null if not inside a FramedPanel. */
const findFramedPanelRoot = (el: HTMLElement | null): HTMLElement | null => {
    let cur = el;
    while (cur && cur.tagName.toLowerCase() !== 'section') {
        cur = cur.parentElement;
    }
    return cur;
};

function DataTable<TRow extends Record<string, unknown>>({
    columns,
    rows,
    loading = false,
    error = null,
    emptyMessage = 'No data',
    onRowClick,
    zebra = true,
    initialSortKey,
    initialSortDir = 'asc',
    pageSize: pageSizeProp,
    paginationDisabled = false,
}: DataTableProps<TRow>): React.ReactElement {
    const [sortKey, setSortKey] = useState<string | null>(initialSortKey ?? null);
    const [sortDir, setSortDir] = useState<SortDir>(initialSortKey ? initialSortDir : 'none');
    const [page, setPage] = useState<number>(0);
    // Build 400: the customer's host names, for the columns flagged hostAlias.
    const { resolve: resolveHostAlias } = useHostAlias();

    /* §18.8a-2 — publish the values-free column-coverage summary. This is the
     * ONLY place that has both the rendered rows and the authoritative
     * displayed set (ColumnDef.key), and the rows it reduces are exactly the
     * rows it renders (derived-array call sites included). The panel's SPL
     * comes from the enclosing FramedPanel's diagnostic context; row VALUES
     * never cross the channel. */
    const diagCtx = usePanelDiagnostic();
    const diagSpl = diagCtx?.spl;
    useEffect(() => {
        if (!diagSpl || !rows) return;
        recordColumnCoverage(
            diagSpl,
            computeColumnCoverage(
                rows,
                columns.map((c) => ({ key: c.key, hasRender: !!c.render })),
            ),
        );
    }, [diagSpl, rows, columns]);

    /* Build 404 — the widths the user dragged. A table on a dashboard panel
     * with a title keeps them in this browser (the shared store, keyed by the
     * dashboard and the panel title); any other table (the AI Assistant's
     * results) keeps them in memory until it unmounts. Only the widths of the
     * columns the table has now are read. */
    const dashboardId = useContext(DashboardIdContext);
    const panelId = panelIdFor(dashboardId, diagCtx?.title);
    const columnKeySig = columns.map((c) => c.key).join('\n');
    const columnKeys = useMemo(() => (columnKeySig === '' ? [] : columnKeySig.split('\n')), [columnKeySig]);
    const widthStore = sharedColumnWidthStore();
    const [storedWidths, setStoredWidths] = useState<{ [col: string]: number }>(() =>
        widthStore.get(panelId, columnKeys),
    );
    const [memWidths, setMemWidths] = useState<{ [col: string]: number }>({});
    useEffect(() => {
        const sync = (): void => {
            const next = widthStore.get(panelId, columnKeys);
            setStoredWidths((prev) => (sameWidths(prev, next) ? prev : next));
        };
        sync();
        return widthStore.subscribe(sync);
    }, [widthStore, panelId, columnKeys]);
    const widths = panelId !== null ? storedWidths : pickWidths(memWidths, columnKeys);
    /* The library starts a drag or an arrow-key step from a column's width
     * prop, but on the automatic layout a column can be drawn narrower than
     * that (dragged past what the panel allows, a narrower window than when it
     * was dragged, a px hint in a narrow panel), and the edge would then not
     * move for the first part of the drag. So when a drag or an arrow key
     * starts on a resize handle, note how much narrower the column is drawn,
     * and take that off every width the drag asks for. A double-click (fit to
     * content) asks for an absolute width and is taken as it is.
     *
     * Build 406: (1) a mouse drag is noted once, at its start: a key or another
     * mouse button pressed while it runs changes nothing; (2) a column drawn
     * narrower than WIDTH_MIN keeps its drawn width as its floor for that drag
     * (resizeFloor), so its edge does not jump out on the first pixel; (3) when
     * other columns have widths too and the table is drawn well under what the
     * widths ask for, the drag first sets every such column to the width it is
     * drawn at, then moves its own from there. */
    const resizeStartRef = useRef<ResizeStart | null>(null);
    const mouseDragRef = useRef<boolean>(false);
    const endMouseDragRef = useRef<(() => void) | null>(null);
    useEffect(
        () => () => {
            if (endMouseDragRef.current) {
                endMouseDragRef.current();
            }
        },
        [],
    );
    const noteResizeStart = (e: React.SyntheticEvent): void => {
        if (mouseDragRef.current) {
            return; // a mouse drag is running: it keeps the start it noted
        }
        const native = e.nativeEvent as MouseEvent & KeyboardEvent;
        const byMouse = e.type === 'mousedown';
        if (byMouse ? native.button !== 0 : native.key !== 'ArrowLeft' && native.key !== 'ArrowRight') {
            return; // not a press the library resizes on
        }
        resizeStartRef.current = null;
        const target = e.target as Element | null;
        const handle = target && typeof target.closest === 'function' ? target.closest('[data-test="resize"]') : null;
        const th = handle ? handle.closest('th') : null;
        if (!th || !th.parentElement) {
            return;
        }
        const ths = Array.prototype.slice.call(th.parentElement.children) as Element[];
        const col = columns[ths.indexOf(th)];
        if (!col) {
            return;
        }
        const propOf = (c: ColumnDef<TRow>): number | undefined =>
            Object.prototype.hasOwnProperty.call(widths, c.key) ? widths[c.key] : hintPx(c.width);
        const drawn = th.getBoundingClientRect().width;
        const start: ResizeStart = { col: col.key, shift: 0, floor: resizeFloor(drawn), others: null };
        resizeStartRef.current = start;
        if (byMouse) {
            mouseDragRef.current = true;
            const end = (): void => {
                mouseDragRef.current = false;
                endMouseDragRef.current = null;
                document.removeEventListener('mouseup', end, true);
                window.removeEventListener('blur', end);
            };
            endMouseDragRef.current = end;
            document.addEventListener('mouseup', end, true);
            window.addEventListener('blur', end);
        }
        const prop = propOf(col);
        if (prop === undefined) {
            return; // an 'auto' width: the library starts from the drawn width itself
        }
        const narrower = prop - drawn;
        if (narrower <= DRAWN_NARROWER_PX) {
            return;
        }
        // The shift alone is exact only when no other column has a width: the
        // column then gets whatever room is left, whatever its own width.
        const othersAuto = columns.every((c) => c === col || propOf(c) === undefined);
        if (othersAuto) {
            start.shift = narrower;
            return;
        }
        // Other columns have widths too, and the browser shares the shortfall
        // among them all. While the columns are drawn close to their widths the
        // library's width is right as it is (measured in Edge: the edge follows
        // from the first pixel). Drawn well under them (one column dragged far
        // past what the panel allows), a step of the pointer moved the edge by
        // a small fraction of it. Then every column with a width is set to the
        // width it is drawn at, and this one moves from there.
        if (drawn >= prop * OVERSUBSCRIBED_RATIO) {
            return;
        }
        const others: { [key: string]: number } = Object.create(null);
        columns.forEach((c, i) => {
            const p = propOf(c);
            const el = ths[i];
            if (c === col || p === undefined || !el) {
                return;
            }
            const w = el.getBoundingClientRect().width;
            if (Math.abs(p - w) > DRAWN_NARROWER_PX) {
                const v = clampWidth(w, resizeFloor(w));
                if (v !== null) {
                    others[c.key] = v;
                }
            }
        });
        start.shift = narrower;
        start.others = others;
    };
    const handleResizeColumn = useCallback(
        (event: unknown, data: { columnId?: string; width: number }) => {
            const col = data.columnId;
            if (!col || columnKeys.indexOf(col) === -1) {
                return;
            }
            const fit = !!event && (event as { type?: string }).type === 'dblclick';
            const noted = resizeStartRef.current;
            const start = !fit && noted && noted.col === col ? noted : null;
            const width = clampWidth(data.width - (start ? start.shift : 0), start ? start.floor : undefined);
            if (width === null) {
                return;
            }
            // The other columns go to their drawn widths once, with the first step.
            const next: { [key: string]: number } = Object.create(null);
            if (start && start.others) {
                const others = start.others;
                Object.keys(others).forEach((k) => {
                    if (columnKeys.indexOf(k) !== -1) {
                        next[k] = others[k];
                    }
                });
                start.others = null;
            }
            next[col] = width;
            noteColumnWidthChange();
            if (panelId !== null) {
                widthStore.setMany(panelId, next, columnKeys);
            } else {
                setMemWidths((prev) => {
                    let out = prev;
                    Object.keys(next).forEach((k) => {
                        if (out[k] !== next[k]) {
                            out = withOwnWidth(out, k, next[k]);
                        }
                    });
                    return out;
                });
            }
        },
        [widthStore, panelId, columnKeys],
    );
    const resetWidths = useCallback(() => {
        noteColumnWidthChange();
        if (panelId !== null) {
            widthStore.reset(panelId);
        }
        setMemWidths({});
    }, [widthStore, panelId]);
    // Build 404: one DOM id per heading, unique on the page (the library would
    // otherwise use the bare column key, repeated across tables).
    const headIdBase = useId();
    // Tell the enclosing FramedPanel whether to show its reset button for this table.
    const customized = Object.keys(widths).length > 0;
    const widthReset = useContext(TableWidthResetContext);
    const resetTokenRef = useRef<object>({});
    useEffect(() => {
        if (!widthReset) {
            return undefined;
        }
        const token = resetTokenRef.current;
        widthReset.set(token, customized ? resetWidths : null);
        return () => widthReset.set(token, null);
    }, [widthReset, customized, resetWidths]);

    // Auto-fit page size: computed from parent FramedPanel's available height.
    // Only used when `pageSize` prop is omitted — explicit prop wins.
    //
    // Stability rules (added 2026-04-27 to fix "lack of data when traversing"):
    //  * Measure ONCE after the first non-empty render, then lock until the
    //    panel's outer height changes by more than `PANEL_HEIGHT_REMEASURE_PX`.
    //  * Always sample row height from the FIRST page's rows so the figure
    //    doesn't drift when the user navigates to a page with shorter
    //    content (e.g., the partial last page) — that previously caused
    //    pageSize to grow mid-session, which both rearranged the user's
    //    current view and broke the "go back to page 1 = original page 1"
    //    contract because page N now meant rows [N*newSize..(N+1)*newSize]
    //    instead of [N*oldSize..(N+1)*oldSize].
    //  * The auto-fit dep list deliberately excludes `rows` so a streaming
    //    search re-emit (same data, new array reference) does not re-trigger
    //    the measurement and bounce the user back to page 0.
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [autoPageSize, setAutoPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const lastMeasuredPanelHeightRef = useRef<number>(0);
    const PANEL_HEIGHT_REMEASURE_PX = 30;
    // Ref-held imperative measure() so both the ResizeObserver effect AND the
    // first-render trampoline can fire it. Without this, measure() lived only
    // in the observer effect's closure and the trampoline was a no-op when
    // the panel's outer height didn't change between "no data" and "data
    // arrived" (which happens whenever a sibling FramedPanel in the same
    // PanelGrid pins the row height first — observed on Cross-Stack Auth
    // where the SAP table only got 10 rows in a panel that fit 15).
    const measureRef = useRef<() => void>(() => {});

    useLayoutEffect(() => {
        if (typeof pageSizeProp === 'number' || paginationDisabled) return undefined;
        const wrapper = wrapperRef.current;
        if (!wrapper) return undefined;

        const panelRoot = findFramedPanelRoot(wrapper.parentElement);
        if (!panelRoot) return undefined;

        // measure() runs synchronously now (no rAF). Earlier the rAF was
        // there to wait for layout to settle, but that meant rapid effect
        // re-runs (each cleaning up the previous frameId) could cancel
        // every rAF before it fired — auto-fit measurement never actually
        // happened. useLayoutEffect already runs after DOM commit, so
        // getBoundingClientRect inside the effect returns stable values.
        const measure = (): void => {
            const tbody = wrapper.querySelector('tbody');
            const thead = wrapper.querySelector('thead');
            if (!tbody || !thead) return;

            const dataRows = tbody.querySelectorAll('tr');
            if (dataRows.length === 0) return;

            const panelHeight = panelRoot.clientHeight;

            // Build 406: a height change that follows a column width change (in this
            // table or in any other: a narrower column wraps its rows and makes
            // the whole grid row taller) never changes a page size already measured.
            if (lastMeasuredPanelHeightRef.current > 0 && columnWidthsJustChanged()) {
                return;
            }

            // Skip re-measure if we already have a value and the panel
            // hasn't grown/shrunk meaningfully. Without this, the
            // observer fires every time the user changes pages (because
            // the row content changes its layout pass slightly), and
            // each fire could shift `autoPageSize` and corrupt the
            // user's current view.
            if (
                lastMeasuredPanelHeightRef.current > 0 &&
                Math.abs(panelHeight - lastMeasuredPanelHeightRef.current) < PANEL_HEIGHT_REMEASURE_PX
            ) {
                return;
            }

            // Average row height — covers cases where some rows wrap to
            // multiple lines (e.g., long signature text in Windows auth).
            let totalRowHeight = 0;
            dataRows.forEach((r) => {
                totalRowHeight += (r as HTMLElement).getBoundingClientRect().height;
            });
            const avgRowHeight = totalRowHeight / dataRows.length;
            if (avgRowHeight < 8) return;

            // Inner height of the FramedPanel (after its own padding)
            const panelStyle = window.getComputedStyle(panelRoot);
            const panelPadTop = parseFloat(panelStyle.paddingTop) || 0;
            const panelPadBottom = parseFloat(panelStyle.paddingBottom) || 0;
            const panelInnerHeight = panelHeight - panelPadTop - panelPadBottom;

            // FramedPanel header (title + subtitle)
            const panelHeader = panelRoot.querySelector('header');
            const panelHeaderHeight = panelHeader
                ? (panelHeader as HTMLElement).getBoundingClientRect().height
                : 0;
            const panelHeaderMargin = panelHeader
                ? parseFloat(window.getComputedStyle(panelHeader).marginBottom) || 0
                : 0;

            // Table chrome (thead) and pagination footer
            const tableHeaderHeight = (thead as HTMLElement).getBoundingClientRect().height;
            const footer = wrapper.querySelector('[data-pagination-footer]');
            // Footer may or may not be visible depending on row count; reserve
            // space for it so toggling pagination on/off doesn't bounce the layout.
            const footerHeight = footer
                ? (footer as HTMLElement).getBoundingClientRect().height
                : 36;

            const available =
                panelInnerHeight - panelHeaderHeight - panelHeaderMargin - tableHeaderHeight - footerHeight;
            if (available <= 0) return;

            const fitRows = Math.max(1, Math.floor(available / avgRowHeight));
            lastMeasuredPanelHeightRef.current = panelHeight;
            setAutoPageSize((prev) => (prev === fitRows ? prev : fitRows));
        };

        // Publish the imperative measure() so the data-arrived trampoline
        // can invoke it directly when the ResizeObserver wouldn't fire on
        // its own.
        measureRef.current = measure;
        measure();

        // Settled-layout polling: when a sibling panel in PanelGrid2 pins
        // our height (CSS Grid row equalize), the pin can happen seconds
        // AFTER our first measure — well after the ResizeObserver would
        // have fired its initial callback, and the observer can miss the
        // grow event entirely depending on sibling render timing. Poll
        // every 250 ms for up to 6 seconds. Stop early once we see four
        // consecutive identical heights (~1 second of layout stability).
        // Each poll is cheap: the early-return inside measure() makes a
        // no-op for unchanged heights.
        const POLL_INTERVAL_MS = 250;
        const POLL_MAX_TICKS = 24; // 24 * 250 ms = 6 seconds
        const POLL_STABLE_TICKS = 4;
        let pollTicks = 0;
        let pollLastH = -1;
        let pollStableCount = 0;
        const pollId = window.setInterval(() => {
            pollTicks += 1;
            const curH = panelRoot.clientHeight;
            if (curH === pollLastH) {
                pollStableCount += 1;
            } else {
                pollStableCount = 0;
                pollLastH = curH;
            }
            measure();
            if (pollStableCount >= POLL_STABLE_TICKS || pollTicks >= POLL_MAX_TICKS) {
                window.clearInterval(pollId);
            }
        }, POLL_INTERVAL_MS);

        const observer = new ResizeObserver(measure);
        observer.observe(panelRoot);

        return () => {
            window.clearInterval(pollId);
            observer.disconnect();
            measureRef.current = () => {};
        };
        // `rows` intentionally NOT in deps directly: a streaming-search
        // re-emit (rows reference changes, content unchanged) must not
        // retrigger setup. But we DO need to re-run when the table
        // wrapper first mounts — without this, the conditional rendering
        // path (`loading + empty rows` → just <StatusLine>Loading…</StatusLine>)
        // means the wrapper div doesn't exist at first mount, so
        // wrapperRef.current is null, the early-return at line 264 fires,
        // and measureRef.current never gets published. The boolean
        // `hasRowsForRender` only flips on the no-rows ↔ has-rows
        // transition, not on every streaming emit, so it triggers the
        // setup exactly once when needed.
    }, [pageSizeProp, paginationDisabled, !!(rows && rows.length > 0)]);

    // First-render measurement trampoline: when data first arrives we need to
    // run measure() once even though `rows` isn't in the auto-fit effect's
    // deps. This effect fires only on the *transition* from "no data" to
    // "has data" — repeated streaming emits with the same shape don't
    // retrigger it.
    const hadDataRef = useRef<boolean>(false);
    useLayoutEffect(() => {
        if (typeof pageSizeProp === 'number' || paginationDisabled) return;
        const hasData = !!(rows && rows.length > 0);
        if (hasData && !hadDataRef.current) {
            hadDataRef.current = true;
            // Reset the cached panel height so the imperative measure
            // below treats this as a "first measurement" and runs through
            // the full computation.
            lastMeasuredPanelHeightRef.current = 0;
            // Invoke the auto-fit measure directly. We can't rely on the
            // ResizeObserver here: when a sibling panel has already pinned
            // this panel's height (PanelGrid2 equal-height behavior), our
            // panel's outer dimensions don't change between "no data" and
            // "data arrived", so the observer never fires. Without this
            // direct call, autoPageSize would stay at DEFAULT_PAGE_SIZE
            // for the whole session.
            //
            // Microtask + rAF chain: queueMicrotask waits for React's
            // commit phase to flush so the new tbody rows are in the DOM,
            // then rAF waits one paint so getBoundingClientRect inside
            // measure() sees stable, post-layout sizes.
            queueMicrotask(() => {
                window.requestAnimationFrame(() => {
                    measureRef.current();
                });
            });
        }
        if (!hasData) hadDataRef.current = false;
    }, [rows, pageSizeProp, paginationDisabled]);

    // Build 404: a width change does not re-measure the auto-fit page size. A
    // re-measure after each resize ratcheted two tables in one grid row taller
    // with every drag and Reset (measured in Edge), and never gave fewer rows:
    // the page size stays as measured above, as in build 403. Build 406: nor
    // does the panel-height observer above, for a height a width change caused.

    // Build 404: the library names each resize handle "Resize " plus the
    // heading's children, which here are an element ("Resize [object Object]").
    // Name it after the column instead. Runs after every render; an unchanged
    // label is left alone.
    useLayoutEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) {
            return;
        }
        wrapper.querySelectorAll('thead th').forEach((th, i) => {
            const handle = th.querySelector('[data-test="resize"]');
            const col = columns[i];
            if (!handle || !col) {
                return;
            }
            const label = `Resize ${typeof col.label === 'string' ? col.label : col.key}`;
            if (handle.getAttribute('aria-label') !== label) {
                handle.setAttribute('aria-label', label);
            }
        });
    });

    const pageSize = typeof pageSizeProp === 'number' ? pageSizeProp : autoPageSize;

    const handleSort = (key: string) => {
        if (sortKey !== key) {
            setSortKey(key);
            setSortDir('asc');
            return;
        }
        // Cycle: asc → desc → none
        if (sortDir === 'asc') setSortDir('desc');
        else if (sortDir === 'desc') {
            setSortDir('none');
            setSortKey(null);
        } else {
            setSortDir('asc');
        }
    };

    const sortedRows = useMemo(() => {
        if (!rows) return null;
        if (!sortKey || sortDir === 'none') return rows;
        const copy = [...rows];
        copy.sort((a, b) => {
            const cmp = compareValues(a[sortKey], b[sortKey]);
            return sortDir === 'asc' ? cmp : -cmp;
        });
        return copy;
    }, [rows, sortKey, sortDir]);

    const totalRows = sortedRows?.length ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    // Clamp current page if data shrunk (e.g., after re-sort or new search).
    // The Math.max(0, page) guard also catches the case where `page` somehow
    // dropped below zero (shouldn't happen but defensive).
    const safePage = Math.min(Math.max(0, page), totalPages - 1);

    // Reset page on sort change (a re-sort makes the current page meaningless)
    // and on substantive data change (different total count or first-row
    // identity). A streaming-search re-emit with the same shape is a no-op,
    // so the user's current page is preserved across incremental result
    // updates from the same query.
    const lastDataSignatureRef = useRef<string>('');
    useEffect(() => {
        if (!rows) {
            lastDataSignatureRef.current = '';
            return;
        }
        // Cheap signature: row count + first row's first column value.
        // Sufficient to distinguish "different result set" from "same set
        // re-emitted with new array reference by streaming search".
        const firstRow = rows[0];
        const firstSig = firstRow ? Object.values(firstRow)[0] : '';
        const sig = `${rows.length}|${String(firstSig)}`;
        if (sig !== lastDataSignatureRef.current) {
            lastDataSignatureRef.current = sig;
            setPage(0);
        }
    }, [rows]);

    useEffect(() => {
        setPage(0);
    }, [sortKey, sortDir]);

    const visibleRows = useMemo(() => {
        if (!sortedRows) return null;
        if (paginationDisabled) return sortedRows;
        const start = safePage * pageSize;
        return sortedRows.slice(start, start + pageSize);
    }, [sortedRows, safePage, pageSize, paginationDisabled]);

    if (error) {
        return <ErrorLine>{error.message || 'Search failed'}</ErrorLine>;
    }
    if (loading && (!rows || rows.length === 0)) {
        return <PanelLoading />;
    }
    if (!visibleRows || visibleRows.length === 0) {
        // Session 093 — append the "why is this empty" statement. DataTable is
        // handed only rows/loading/error, so EmptyStateHint reads the enclosing
        // FramedPanel's PanelDiagnosticContext (every table call site already
        // passes `search={…}` for the toolbar). Renders nothing when there is
        // nothing honest to say, which is the common case.
        return (
            <StatusLine>
                {emptyMessage}
                <EmptyStateHint />
            </StatusLine>
        );
    }

    const showPagination = !paginationDisabled && totalRows > pageSize;
    const startIdx = safePage * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalRows);

    return (
        <Wrapper
            $zebra={zebra}
            $clickableRows={!!onRowClick}
            ref={wrapperRef}
            onMouseDownCapture={noteResizeStart}
            onKeyDownCapture={noteResizeStart}
        >
            <Table
                headType="fixed"
                stripeRows={false}
                onRequestResizeColumn={handleResizeColumn}
                tableStyle={AUTO_TABLE_LAYOUT}
            >
                <Table.Head>
                    {columns.map((col, colIndex) => {
                        const isSortable = col.sortable !== false;
                        const isActive = sortKey === col.key && sortDir !== 'none';
                        const dir: SortDir = isActive ? sortDir : 'none';
                        const indicator = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '▴▾';

                        // Build 404: every heading has a width, which the
                        // library needs before a drag can start: the dragged
                        // width, else the px hint, else 'auto' (content width).
                        // The library's width replaces any style width.
                        return (
                            <Table.HeadCell
                                key={col.key}
                                id={`${headIdBase}-h${colIndex}`}
                                columnId={col.key}
                                width={widths[col.key] ?? hintPx(col.width) ?? 'auto'}
                            >
                                {isSortable ? (
                                    <SortableHeader
                                        $align={col.align}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleSort(col.key)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleSort(col.key);
                                            }
                                        }}
                                        title={`Sort by ${typeof col.label === 'string' ? col.label : col.key}`}
                                    >
                                        <HeadLabel>{col.label}</HeadLabel>
                                        <SortIndicator $dir={dir} aria-hidden="true">
                                            {indicator}
                                        </SortIndicator>
                                    </SortableHeader>
                                ) : (
                                    col.label
                                )}
                            </Table.HeadCell>
                        );
                    })}
                </Table.Head>
                <Table.Body>
                    {visibleRows.map((row, rowIndex) => (
                        <Table.Row
                            // eslint-disable-next-line react/no-array-index-key
                            key={`row-${startIdx + rowIndex}`}
                            onClick={onRowClick ? () => onRowClick(row) : undefined}
                        >
                            {columns.map((col) => {
                                const raw = row[col.key];
                                const alias = col.hostAlias && !col.render ? resolveHostAlias(raw) : null;
                                let content: ReactNode = col.render
                                    ? col.render(raw, row)
                                    : raw === null || typeof raw === 'undefined'
                                    ? ''
                                    : String(raw);
                                // Build 400: a name only for a flagged default cell whose value has one
                                // (resolveHostAlias gives null for null / undefined / non-host values).
                                // The line is cut at its right end: the raw value gives way before the name.
                                if (alias !== null) {
                                    content = <AliasedHost alias={alias} raw={String(raw)} />;
                                }
                                return (
                                    <Table.Cell
                                        key={col.key}
                                        // Build 400: "name - raw value" over the whole cell, its padding too (a
                                        // narrow column may cut the raw value to nothing on screen, and the name
                                        // too when the column is narrower than the name), and the line's
                                        // copy handler on the cell as well (HostName.tsx copyOnOneLine).
                                        title={alias !== null ? `${alias} - ${String(raw)}` : undefined}
                                        onCopy={alias !== null ? copyOnOneLine : undefined}
                                        style={
                                            col.align === 'right'
                                                ? { textAlign: 'right' }
                                                : col.align === 'center'
                                                ? { textAlign: 'center' }
                                                : undefined
                                        }
                                    >
                                        {content}
                                    </Table.Cell>
                                );
                            })}
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table>
            {showPagination && (
                <PaginationFooter data-pagination-footer>
                    <RowCount>
                        {(startIdx + 1).toLocaleString()}–{endIdx.toLocaleString()} of {totalRows.toLocaleString()}
                    </RowCount>
                    <PageButtons>
                        <PageBtn
                            type="button"
                            onClick={() => setPage(0)}
                            disabled={safePage === 0}
                            aria-label="First page"
                        >
                            «
                        </PageBtn>
                        <PageBtn
                            type="button"
                            // Base off `safePage`, not the raw `page` state — if
                            // the data shrunk and `page` is stale-high, raw
                            // `p - 1` would do nothing visible until `p` falls
                            // back below `totalPages - 1`.
                            onClick={() => setPage(Math.max(0, safePage - 1))}
                            disabled={safePage === 0}
                            aria-label="Previous page"
                        >
                            ‹
                        </PageBtn>
                        <PageIndicator>
                            Page {safePage + 1} of {totalPages}
                        </PageIndicator>
                        <PageBtn
                            type="button"
                            onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                            disabled={safePage >= totalPages - 1}
                            aria-label="Next page"
                        >
                            ›
                        </PageBtn>
                        <PageBtn
                            type="button"
                            onClick={() => setPage(totalPages - 1)}
                            disabled={safePage >= totalPages - 1}
                            aria-label="Last page"
                        >
                            »
                        </PageBtn>
                    </PageButtons>
                </PaginationFooter>
            )}
        </Wrapper>
    );
}

export default DataTable;
