import React, { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import Table from '@splunk/react-ui/Table';
import { logservTheme } from '../styles/logservTheme';
import PanelLoading from './PanelLoading';

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
 */

export interface ColumnDef<TRow = Record<string, unknown>> {
    key: string;
    label: ReactNode;
    /** Optional custom cell renderer. Receives the raw value and the full row. */
    render?: (value: unknown, row: TRow) => ReactNode;
    /** Width hint (e.g., "120px" or "20%"). */
    width?: string;
    /** Right-align numeric columns. */
    align?: 'left' | 'right' | 'center';
    /** Disable sort on this column. Defaults to true (sortable). */
    sortable?: boolean;
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

    & thead th {
        background: ${logservTheme.colors.tableHeaderBackground} !important;
        color: ${logservTheme.colors.textActive} !important;
        font-size: ${logservTheme.fontSize.small};
        font-weight: ${logservTheme.fontWeight.semibold};
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    }

    & tbody td {
        color: ${logservTheme.colors.textDefault};
        font-size: ${logservTheme.fontSize.body};
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
        background: transparent !important;
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
           every row reads as interactive (cursor: pointer + hover wash).
           Build 157 / session 027 task 4. */
        & tbody tr {
            cursor: pointer;
            transition: background-color 80ms ease-out;
        }
        & tbody tr:hover td {
            background: ${logservTheme.colors.hoverBackground} !important;
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

    &:hover {
        color: ${logservTheme.colors.cyanLight};
    }
`;

const SortIndicator = styled.span<{ $dir: SortDir }>`
    font-size: 10px;
    color: ${(p) => (p.$dir === 'none' ? logservTheme.colors.textMuted : logservTheme.colors.cyanLight)};
    opacity: ${(p) => (p.$dir === 'none' ? 0.4 : 1)};
    line-height: 1;
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
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textActive};
    padding: 2px 8px;
    cursor: pointer;
    border-radius: 2px;
    font-size: 12px;
    line-height: 1.4;
    min-width: 24px;
    font-family: inherit;

    &:hover:not(:disabled) {
        background: ${logservTheme.colors.hoverBackground};
        border-color: ${logservTheme.colors.panelBorder};
        color: ${logservTheme.colors.cyanLight};
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
        return <StatusLine>{emptyMessage}</StatusLine>;
    }

    const showPagination = !paginationDisabled && totalRows > pageSize;
    const startIdx = safePage * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalRows);

    return (
        <Wrapper $zebra={zebra} $clickableRows={!!onRowClick} ref={wrapperRef}>
            <Table headType="fixed" stripeRows={false}>
                <Table.Head>
                    {columns.map((col) => {
                        const isSortable = col.sortable !== false;
                        const isActive = sortKey === col.key && sortDir !== 'none';
                        const dir: SortDir = isActive ? sortDir : 'none';
                        const indicator = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '▴▾';

                        return (
                            <Table.HeadCell
                                key={col.key}
                                style={col.width ? { width: col.width } : undefined}
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
                                        <span>{col.label}</span>
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
                                const content = col.render
                                    ? col.render(raw, row)
                                    : raw === null || typeof raw === 'undefined'
                                    ? ''
                                    : String(raw);
                                return (
                                    <Table.Cell
                                        key={col.key}
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
