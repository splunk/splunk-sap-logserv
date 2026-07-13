import React, { useCallback, useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { useThemeMode } from '../state/ThemeModeProvider';
import { ACCENT_PALETTE, ColorTokens, ThemeMode } from '../styles/magneticTokens';
import { useTimeRange } from '../state/TimeRangeProvider';
import {
    AUDIT_CATEGORIES,
    AuditCategoryName,
    AuditQueryFilters,
    AuditRow,
    queryAuditLog,
} from '../utils/auditQuery';

/** Client-side pagination — Splunk fetches up to `filters.limit` rows;
 *  the viewer pages through them PAGE_SIZE at a time. Build 137 / s024. */
const PAGE_SIZE = 25;

/**
 * AuditLogViewer — read-only browser of the `ai_assistant_audit`
 * Splunk index. Rendered inside the Settings page's "Audit Log" tab.
 * Build 95 / session 022.
 *
 * Filters: time range preset, category multi-select, user contains,
 * result limit. The component runs a single oneshot search per filter
 * change (debounced via the form's submit / Apply button); rows are
 * rendered into a sortable table with per-row expand → full JSON view.
 *
 * Tamper-resistance disclaimer: the viewer surfaces what the index
 * holds at query time. A host-root admin who tampered with the bucket
 * between the audit write and this read returns tampered data without
 * warning. The header note links to the recommended forwarder
 * mitigation. See SESSION-MEMORY-022.md for the full threat-model
 * discussion.
 *
 * No mutating REST calls. The component cannot edit, delete, or
 * inject events into the index — the only outbound is read-only
 * `services/search/jobs/oneshot`.
 */

// ─── styled primitives ────────────────────────────────────────────────────

const FilterBar = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: ${logservTheme.spacing.md};
    align-items: end;
    padding: ${logservTheme.spacing.md} 0;
    margin-bottom: ${logservTheme.spacing.md};
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
`;

const FilterCell = styled.label`
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: ${logservTheme.fontSize.body};
    color: ${logservTheme.colors.textMuted};
`;

const FilterControl = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const Select = styled.select`
    background: ${logservTheme.colors.panelBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    padding: 6px 8px;
    font-size: ${logservTheme.fontSize.body};
    font-family: inherit;
    height: 32px;
`;

const TextInput = styled.input`
    background: ${logservTheme.colors.panelBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    padding: 6px 8px;
    font-size: ${logservTheme.fontSize.body};
    font-family: inherit;
    height: 32px;
`;

const Button = styled.button<{ $variant?: 'primary' | 'subtle' }>`
    background: ${(p) =>
        p.$variant === 'primary'
            ? logservTheme.colors.panelBorder
            : 'transparent'};
    color: ${(p) =>
        p.$variant === 'primary' ? '#fff' : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$variant === 'primary'
                ? logservTheme.colors.panelBorder
                : logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    padding: 6px 14px;
    font-size: ${logservTheme.fontSize.body};
    font-family: inherit;
    cursor: pointer;
    height: 32px;
    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const CategoryGrid = styled.div`
    /* Build 154 — switched from CSS Grid (equal-width cells) to flex-wrap
     * so each chip sizes to its own content and the GAP between chips is
     * uniform regardless of label length. Grid was producing uneven visual
     * spacing because short labels (e.g. local_only) left empty space at
     * the end of their cell while long labels (e.g.
     * user_prompt_jailbreak_flag) filled their cell edge-to-edge.
     * Flex with consistent gap → consistent perceived buffering. */
    display: flex;
    flex-wrap: wrap;
    gap: 10px 18px;
    padding: 6px 0;
    font-size: ${logservTheme.fontSize.body};
`;

const CategoryCheckbox = styled.label`
    display: flex;
    align-items: center;
    gap: 6px;
    color: ${logservTheme.colors.textActive};
    cursor: pointer;
    & code {
        background: ${logservTheme.colors.panelBackground};
        padding: 1px 5px;
        border-radius: 2px;
        font-size: 11px;
    }
`;

const Disclaimer = styled.div`
    /* Magnetic warning-banner treatment (Phase 4 / build 258): sentiment
       tint fill + strong left border. */
    background: ${logservTheme.colors.warningTint};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-left: 3px solid ${logservTheme.colors.orange};
    padding: ${logservTheme.spacing.md};
    margin-bottom: ${logservTheme.spacing.md};
    font-size: ${logservTheme.fontSize.body};
    color: ${logservTheme.colors.textActive};
    line-height: 1.5;
    & strong {
        color: ${logservTheme.colors.orange};
    }
    & p {
        margin: 0 0 8px 0;
        &:last-child {
            margin-bottom: 0;
        }
    }
    & code {
        background: rgba(255, 255, 255, 0.04);
        padding: 1px 5px;
        border-radius: 2px;
        font-size: 12px;
    }
`;

const ResultStatus = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    margin-bottom: ${logservTheme.spacing.sm};
`;

/**
 * Pagination footer rendered below the audit-event table when row count
 * exceeds PAGE_SIZE. Build 137 / session 024.
 */
const PaginationFooter = styled.div`
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.sm} 0;
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};

    & > span {
        margin-right: auto;
    }
`;

const ErrorBanner = styled.div`
    background: ${logservTheme.colors.negativeTint};
    border: 1px solid ${logservTheme.colors.red};
    color: ${logservTheme.colors.red};
    padding: ${logservTheme.spacing.md};
    border-radius: 3px;
    margin-bottom: ${logservTheme.spacing.md};
    font-size: ${logservTheme.fontSize.body};
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
    font-size: ${logservTheme.fontSize.body};
    color: ${logservTheme.colors.textActive};
    & th {
        text-align: left;
        font-weight: 600;
        background: ${logservTheme.colors.tableHeaderBackground};
        color: ${logservTheme.colors.textActive};
        padding: 8px 10px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
        position: sticky;
        top: 0;
        z-index: 1;
    }
    & td {
        padding: 8px 10px;
        border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
        vertical-align: top;
    }
    & tr:nth-child(odd) td {
        background: ${logservTheme.colors.tableRowOdd};
    }
    & tr.expanded td {
        background: rgba(8, 119, 166, 0.08);
    }
    & code {
        background: rgba(255, 255, 255, 0.04);
        padding: 1px 5px;
        border-radius: 2px;
        font-size: 11px;
    }
`;

/* Build 152 — gradient + selected-state aware. Same component used by:
 *   - the filter chip row (with $selected prop driving dim/bright state)
 *   - the per-row category cell in the table (no $selected → always full bright)
 *
 * When $selected is `false`, the chip dims and desaturates so the user can
 * see at a glance which categories they've toggled on. When $selected is
 * `true`, a subtle outer ring + drop shadow lifts the chip slightly. When
 * $selected is undefined (table cell), neither dim nor ring applies. */
const CategoryChip = styled.span<{ $color: string; $selected?: boolean }>`
    /* Flat Magnetic tag (Phase 4 / build 258 — replaces the 3-stop gradient
     * chips + the dim/saturate unchecked hack): selected/table-cell = accent
     * FILL with light text; unselected filter chip = OUTLINE (transparent
     * fill, accent border + text). Accent comes from the mode-resolved
     * dataviz palette via chipColorForCategory. Constant 1px border in all
     * states so toggling never shifts layout. */
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 2px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    border: 1px solid ${(p) => p.$color};
    transition: background 150ms ease-out, color 150ms ease-out, box-shadow 150ms ease-out;

    ${(p) => p.$selected === false
        ? `
        background: transparent;
        color: ${p.$color};
    `
        : `
        background: ${p.$color};
        color: ${logservTheme.colors.inverseText};
    `}

    ${(p) => p.$selected === true && `
        box-shadow: 0 0 0 2px ${logservTheme.colors.focusRing};
    `}
`;

const ExpandButton = styled.button`
    background: transparent;
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    color: ${logservTheme.colors.textMuted};
    border-radius: 2px;
    cursor: pointer;
    width: 22px;
    height: 22px;
    font-size: 14px;
    line-height: 1;
    padding: 0;
    &:hover {
        color: ${logservTheme.colors.textActive};
        border-color: ${logservTheme.colors.panelBorder};
    }
`;

const JsonBlock = styled.pre`
    background: ${logservTheme.colors.pageBackground};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: 3px;
    padding: 10px;
    font-size: 11px;
    line-height: 1.45;
    color: ${logservTheme.colors.textActive};
    margin: 4px 0 0 0;
    max-height: 360px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
`;

// ─── category gradient map ───────────────────────────────────────────────
//
// Build 152 — replaced flat solid colors with subtle 3-stop linear gradients.
// Mirrors the privacy / severity story while giving each of the 12 categories
// its own visual identity (the previous flat palette had 5 categories sharing
// the same red and 3 falling back to gray).
//
// Hue family by concern level:
//   teal       — local-only, no vendor egress (lowest concern)
//   slate-blue — informational acceptances / opt-ins
//   amber/gold — vendor_tier1 schema-only egress (low concern)
//   orange     — vendor_tier2 / elevation (medium — aggregated metadata)
//   purple     — operational integrity (forwarder failure)
//   rose       — usage caps (rate limit, spend cap)
//   burgundy   — DoS heuristic (session tool cap)
//   red        — write-SPL block + jailbreak (highest security concern)
//
// Each gradient's mid-stop sits around 35-45 % luminance so #fff text stays
// readable. The text-shadow on CategoryChip provides extra anti-aliasing
// against the lighter top-left corner of the gradient.
/** Category -> flat accent color (Phase 4 / build 258). The 11 ordered
 *  categories map onto the mode-resolved Magnetic dataviz accent palette
 *  a-k; `user_prompt_jailbreak_flag` gets the sentiment red (a security
 *  flag outranks a chart accent); anything unknown falls back to dormant
 *  gray. Replaces the legacy 12x 3-stop gradient table. */
const CATEGORY_ACCENT_ORDER = [
    'local_only',
    'ai_assistant_enable_acceptance',
    'forwarder_disabled_acceptance',
    'vendor_tier1',
    'vendor_tier2',
    'vendor_tier2_elevation',
    'audit_forwarder_failure',
    'rate_limited_prompt',
    'daily_spend_cap_hit',
    'session_tool_cap_hit',
    'security_blocked_spl',
];

const chipColorForCategory = (cat: string, tokens: ColorTokens, mode: ThemeMode): string => {
    if (cat === 'user_prompt_jailbreak_flag') return tokens.red;
    const idx = CATEGORY_ACCENT_ORDER.indexOf(cat);
    if (idx >= 0) return ACCENT_PALETTE[mode][idx];
    return tokens.dormant;
};

// ─── per-category highlight string ───────────────────────────────────────
//
// One short summary string per row showing the most actionable field(s)
// for the SOC analyst at-a-glance. Full JSON is in the row-expand view.
const renderHighlight = (row: AuditRow): string => {
    switch (row.category) {
        case 'local_only':
            return `prompt=${row.promptId ?? ''}, rows=${row.rowCount ?? '?'}, ${row.executionMs ?? '?'}ms`;
        case 'vendor_tier1': {
            const cost = typeof row.vendorCostEstimateUsd === 'number'
                ? `$${row.vendorCostEstimateUsd.toFixed(4)}`
                : `${row.vendorCostEstimateUsd ?? '?'}`;
            const redact = typeof row.tier2RedactionsApplied === 'number'
                ? row.tier2RedactionsApplied
                : (row.tier2RedactionsApplied ?? 0);
            return `${row.provider ?? '?'}/${row.model ?? '?'}, turns=${row.turnCount ?? '?'}, in=${row.inputTokens ?? '?'} out=${row.outputTokens ?? '?'}, cost=${cost}, redactions=${redact}`;
        }
        case 'vendor_tier2':
            return `${row.provider ?? '?'}/${row.model ?? '?'}, kind=${row.aggregateKind ?? '?'}, dc=${row.distinctValueCount ?? '?'}, approved=${row.userApproved ?? '?'}`;
        case 'vendor_tier2_elevation':
            return `${row.previousTier ?? '?'} → ${row.newTier ?? '?'}, provider=${row.provider ?? '?'}`;
        case 'security_blocked_spl':
            return `operator=${row.operator ?? '?'}`;
        case 'rate_limited_prompt':
            return `threshold=${row.threshold ?? '?'}, count=${row.countInWindow ?? '?'}, retry=${row.secondsUntilNextSlot ?? '?'}s`;
        case 'user_prompt_jailbreak_flag': {
            const groups = Array.isArray(row.matchedGroups)
                ? row.matchedGroups.join(',')
                : String(row.matchedGroups ?? '');
            return `groups=[${groups}], len=${row.promptLength ?? '?'}`;
        }
        case 'session_tool_cap_hit':
            return `cap=${row.cap ?? '?'}, attempted=${row.attemptedCount ?? '?'}, tool=${row.toolName ?? '?'}`;
        case 'daily_spend_cap_hit':
            return `cap=$${row.capUsd ?? '?'}, spent=$${row.spentTodayUsd ?? '?'}`;
        case 'model_discovery':
            return `provider=${row.provider ?? '?'}, trigger=${row.trigger ?? '?'}, models=${row.modelCount ?? '?'}, ok=${row.ok ?? '?'}${row.error ? `, error=${String(row.error).slice(0, 60)}` : ''}`;
        default:
            return '';
    }
};

const formatTime = (iso: string): string => {
    if (!iso) return '';
    // Splunk returns _time as ISO 8601 with timezone offset. Render with
    // the local browser timezone so admins see times in their own zone.
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch (_e) {
        return iso;
    }
};

/* TIME_RANGE_OPTIONS removed in build 137 / session 024 — global TimeRange
 * picker (NavigationBar) is now the source of truth for earliest/latest. */

const LIMIT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 50, label: '50 rows' },
    { value: 100, label: '100 rows' },
    { value: 250, label: '250 rows' },
    { value: 500, label: '500 rows' },
];

// ─── component ───────────────────────────────────────────────────────────

const AuditLogViewer: React.FC = () => {
    // Build 137 / session 024: dropped the local "Time range" Select. The
    // global TimeRange picker in the navigation bar (top of every page) is
    // now the single source of truth for the search window. earliest+latest
    // get spread into AuditQueryFilters whenever runSearch fires.
    const { timeRange } = useTimeRange();
    // Phase 4 / build 258 — accent colors are literal hex (Surface 2).
    const { tokens, mode } = useThemeMode();

    const [filters, setFilters] = useState<AuditQueryFilters>(() => ({
        earliest: '-7d',
        latest: 'now',
        categories: [],
        userContains: '',
        limit: 100,
    }));
    const [draftFilters, setDraftFilters] = useState<AuditQueryFilters>(() => ({
        earliest: '-7d',
        latest: 'now',
        categories: [],
        userContains: '',
        limit: 100,
    }));
    const [rows, setRows] = useState<AuditRow[]>([]);
    const [error, setError] = useState<string>('');
    const [loading, setLoading] = useState<boolean>(true);
    const [lastRefresh, setLastRefresh] = useState<number>(0);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    /** Client-side pagination state — current page index (0-based). Resets
     *  to 0 whenever a fresh row set arrives. */
    const [currentPage, setCurrentPage] = useState<number>(0);

    const runSearch = useCallback(async (f: AuditQueryFilters): Promise<void> => {
        // Inject the global TimeRange's earliest/latest at dispatch time —
        // overrides whatever's in `f.earliest`/`f.latest` so the global
        // picker is always authoritative. (filters' earliest/latest still
        // exist in state for shape-completeness but are no longer wired to
        // any UI input.)
        const effective: AuditQueryFilters = {
            ...f,
            earliest: timeRange.earliest,
            latest: timeRange.latest,
        };
        setLoading(true);
        setError('');
        const result = await queryAuditLog(effective);
        if (result.error) {
            setError(result.error);
            setRows([]);
        } else {
            setRows(result.rows);
        }
        setLoading(false);
        setLastRefresh(Date.now());
        setExpanded(new Set());
    }, [timeRange.earliest, timeRange.latest]);

    // Auto-run on mount AND on every change to the global TimeRange picker.
    // Build 137 / session 024: replaced the previous mount-only effect; the
    // global picker is now the user-visible "I want to re-search" trigger,
    // alongside the manual Apply button.
    useEffect(() => {
        runSearch(filters);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeRange.earliest, timeRange.latest]);

    // Reset to page 1 whenever a fresh row set arrives — searching for
    // different filters should always start at the top.
    useEffect(() => {
        setCurrentPage(0);
    }, [rows]);

    const handleApply = useCallback((): void => {
        setFilters(draftFilters);
        runSearch(draftFilters);
    }, [draftFilters, runSearch]);

    const handleRefresh = useCallback((): void => {
        runSearch(filters);
    }, [filters, runSearch]);

    const handleResetFilters = useCallback((): void => {
        const reset: AuditQueryFilters = {
            // earliest/latest are placeholders — runSearch overrides with
            // the global timeRange. Keeping fields populated for shape.
            earliest: '-7d',
            latest: 'now',
            categories: [],
            userContains: '',
            limit: 100,
        };
        setDraftFilters(reset);
        setFilters(reset);
        runSearch(reset);
    }, [runSearch]);

    const toggleCategory = useCallback((cat: AuditCategoryName): void => {
        setDraftFilters((prev) => ({
            ...prev,
            categories: prev.categories.includes(cat)
                ? prev.categories.filter((c) => c !== cat)
                : [...prev.categories, cat],
        }));
    }, []);

    const toggleExpanded = useCallback((idx: number): void => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    }, []);

    const lastRefreshLabel = useMemo(
        () => (lastRefresh > 0 ? new Date(lastRefresh).toLocaleTimeString() : '—'),
        [lastRefresh],
    );

    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const pagedRows = useMemo(
        () => rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
        [rows, currentPage],
    );

    const rowCountLabel = useMemo(() => {
        if (loading) return 'Loading…';
        if (rows.length === 0) {
            // Build 137 / session 024: time range is now driven by the
            // global picker, so the empty-state hint points there.
            return 'No events match the current filters. Widen the time range with the picker at the top of the page, or remove category / user filters.';
        }
        const at = rows.length === filters.limit ? ' (fetch cap reached — raise "Result limit" to see more)' : '';
        const start = currentPage * PAGE_SIZE + 1;
        const end = Math.min(rows.length, (currentPage + 1) * PAGE_SIZE);
        return `Showing ${start}-${end} of ${rows.length} event${rows.length === 1 ? '' : 's'}${at}, refreshed ${lastRefreshLabel}`;
    }, [loading, rows.length, filters.limit, currentPage, lastRefreshLabel]);

    return (
        <div>
            <Disclaimer>
                <p>
                    <strong>Read-only viewer.</strong> This panel queries
                    the audit index (resolved via the{' '}
                    <code>sap_logserv_audit_idx_macro</code> macro,
                    default <code>ai_assistant_audit</code>) through{' '}
                    <code>services/search/jobs/oneshot</code>. It cannot
                    modify, delete, or inject audit events.
                </p>
                <p>
                    <strong>Tamper-resistance caveat.</strong> A host
                    administrator with <code>splunk</code> or <code>root</code>{' '}
                    access on this Splunk instance can stop the daemon and
                    edit bucket files directly. The events you see here
                    reflect whatever the index holds <em>at query time</em> —
                    not what was originally written. For tamper-evident audit:
                    forward this index to a separate destination via{' '}
                    <code>outputs.conf</code> (a remote indexer, an HEC
                    endpoint owned by a different admin team, or S3 with
                    Object Lock). An admin must then compromise both systems
                    to tamper invisibly.
                </p>
            </Disclaimer>

            <FilterBar>
                {/* Local "Time range" Select removed in build 137 / session
                 * 024 — global TimeRange picker in the navigation bar is
                 * now the only time control. The audit search re-runs
                 * automatically when it changes. */}
                <FilterCell>
                    User contains
                    <TextInput
                        type="text"
                        value={draftFilters.userContains}
                        placeholder="(any user)"
                        onChange={(e) =>
                            setDraftFilters((p) => ({
                                ...p,
                                userContains: e.target.value,
                            }))
                        }
                    />
                </FilterCell>

                <FilterCell>
                    Result limit
                    <Select
                        value={String(draftFilters.limit)}
                        onChange={(e) =>
                            setDraftFilters((p) => ({
                                ...p,
                                limit: Number(e.target.value) || 100,
                            }))
                        }
                    >
                        {LIMIT_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </Select>
                </FilterCell>

                <FilterControl>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Button
                            type="button"
                            $variant="primary"
                            onClick={handleApply}
                            disabled={loading}
                        >
                            Apply
                        </Button>
                        <Button type="button" onClick={handleRefresh} disabled={loading}>
                            Refresh
                        </Button>
                        <Button type="button" onClick={handleResetFilters} disabled={loading}>
                            Reset
                        </Button>
                    </div>
                </FilterControl>
            </FilterBar>

            <FilterCell style={{ marginBottom: logservTheme.spacing.md }}>
                Categories ({draftFilters.categories.length === 0
                    ? 'all included — click chips to narrow'
                    : `${draftFilters.categories.length} selected`})
                <CategoryGrid>
                    {AUDIT_CATEGORIES.map((cat) => {
                        const isSelected = draftFilters.categories.includes(cat);
                        return (
                            <CategoryCheckbox key={cat}>
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleCategory(cat)}
                                />
                                <CategoryChip
                                    $color={chipColorForCategory(cat, tokens, mode)}
                                    $selected={isSelected}
                                >
                                    {cat}
                                </CategoryChip>
                            </CategoryCheckbox>
                        );
                    })}
                </CategoryGrid>
            </FilterCell>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            <ResultStatus>{rowCountLabel}</ResultStatus>

            {rows.length > 0 && (
                <Table>
                    <thead>
                        <tr>
                            <th style={{ width: 22 }} aria-label="Expand row" />
                            <th style={{ width: 170 }}>Time</th>
                            <th style={{ width: 170 }}>Category</th>
                            <th style={{ width: 110 }}>User</th>
                            <th style={{ width: 130 }}>Session</th>
                            <th>Highlight</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pagedRows.map((row, pageIdx) => {
                            // Translate page-relative idx → absolute idx so
                            // expand state survives pagination.
                            const idx = currentPage * PAGE_SIZE + pageIdx;
                            const isOpen = expanded.has(idx);
                            return (
                                <React.Fragment key={`${row._time}-${idx}`}>
                                    <tr className={isOpen ? 'expanded' : ''}>
                                        <td>
                                            <ExpandButton
                                                type="button"
                                                onClick={() => toggleExpanded(idx)}
                                                aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                                            >
                                                {isOpen ? '−' : '+'}
                                            </ExpandButton>
                                        </td>
                                        <td>{formatTime(row._time)}</td>
                                        <td>
                                            <CategoryChip $color={chipColorForCategory(row.category, tokens, mode)}>
                                                {row.category}
                                            </CategoryChip>
                                        </td>
                                        <td>{(row.user as string) || '—'}</td>
                                        <td title={(row.sessionId as string) || ''}>
                                            <code>
                                                {typeof row.sessionId === 'string'
                                                    ? row.sessionId.slice(0, 12) + (row.sessionId.length > 12 ? '…' : '')
                                                    : '—'}
                                            </code>
                                        </td>
                                        <td>{renderHighlight(row)}</td>
                                    </tr>
                                    {isOpen && (
                                        <tr className="expanded">
                                            <td />
                                            <td colSpan={5}>
                                                <JsonBlock>{JSON.stringify(row, null, 2)}</JsonBlock>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </Table>
            )}

            {rows.length > PAGE_SIZE && (
                <PaginationFooter>
                    <span>{`Page ${currentPage + 1} of ${totalPages}`}</span>
                    <Button
                        type="button"
                        onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                        disabled={currentPage === 0}
                    >
                        ← Previous
                    </Button>
                    <Button
                        type="button"
                        onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={currentPage >= totalPages - 1}
                    >
                        Next →
                    </Button>
                </PaginationFooter>
            )}
        </div>
    );
};

export default AuditLogViewer;
