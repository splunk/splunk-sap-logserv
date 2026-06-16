import React, { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';

/**
 * Topology Aggregation settings — admin controls for the time-bucketed
 * KV Store that powers the Environment Topology view.
 *
 * Three labelled sections, all rendered inline in one tab body:
 *   Aggregation — enable/disable toggle + last-run timestamp + cron
 *                 schedule (read-only) for the two hourly saved searches
 *                 (logserv_topology_aggregate_nodes + _edges). Toggle
 *                 acts on both in lockstep.
 *   Backfill    — admin-triggered dispatch of the disabled-by-default
 *                 backfill saved searches that fill the last 30 days
 *                 in one pass. Required after first install.
 *   Retention   — display of the retention window (30d) + dangerous
 *                 "Clear all topology data" button with confirm modal.
 *
 * REST surface (all relative to the Splunk Web origin):
 *   GET  /servicesNS/nobody/splunk_app_sap_logserv/saved/searches/<name>?output_mode=json
 *   POST /servicesNS/nobody/splunk_app_sap_logserv/saved/searches/<name>/enable?output_mode=json
 *   POST /servicesNS/nobody/splunk_app_sap_logserv/saved/searches/<name>/disable?output_mode=json
 *   POST /servicesNS/nobody/splunk_app_sap_logserv/saved/searches/<name>/dispatch?output_mode=json
 *   GET  /servicesNS/nobody/splunk_app_sap_logserv/saved/searches/<name>/history?output_mode=json
 *   DELETE /servicesNS/nobody/splunk_app_sap_logserv/storage/collections/data/<collection>?output_mode=json
 *
 * Splunk's CSRF token comes via `X-Splunk-Form-Key` header on POSTs (read
 * from the `splunkweb_csrf_token_<port>` cookie). For GETs, no header
 * needed; the session cookie authenticates.
 *
 * Session 035 / build 188.
 */

const APP = 'splunk_app_sap_logserv';
/* Splunk Web's REST proxy requires the `/en-US/splunkd/__raw/` prefix —
 * direct `/servicesNS/...` URLs hit Splunk Web's rewriter instead of the
 * REST endpoint and return 404. Same pattern as topology/persistence.ts. */
const NS_PREFIX = `/en-US/splunkd/__raw/servicesNS/nobody/${APP}`;

const SAVED_SEARCH_NODES = 'logserv_topology_aggregate_nodes';
const SAVED_SEARCH_EDGES = 'logserv_topology_aggregate_edges';
const SAVED_SEARCH_BACKFILL_NODES = 'logserv_topology_backfill_nodes';
const SAVED_SEARCH_BACKFILL_EDGES = 'logserv_topology_backfill_edges';
const COLLECTION_NODES = 'logserv_topology_nodes';
const COLLECTION_EDGES = 'logserv_topology_edges';

// ─── styled primitives (mirror AIAssistantSettings conventions) ──────────────
const SectionHeading = styled.h3`
    margin: ${logservTheme.spacing.lg} 0 0;
    padding: ${logservTheme.spacing.xs} 0 ${logservTheme.spacing.sm};
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.cyanLight};
    text-transform: uppercase;
    letter-spacing: 1.2px;
    font-size: ${logservTheme.fontSize.small};
    font-weight: ${logservTheme.fontWeight.semibold};
    &:first-child {
        margin-top: 0;
    }
`;

const FieldRow = styled.div`
    display: grid;
    grid-template-columns: 200px 1fr auto;
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: ${logservTheme.spacing.sm} 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    &:last-child {
        border-bottom: 0;
    }
`;

const FieldLabel = styled.label`
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const FieldHint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    margin-top: 2px;
`;

const FieldStatus = styled.div<{ $tone: 'good' | 'absent' | 'error' }>`
    color: ${(p) =>
        p.$tone === 'good'
            ? logservTheme.colors.teal
            : p.$tone === 'error'
            ? logservTheme.colors.red
            : logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.small};
    font-style: italic;
    margin-top: 2px;
`;

const ToggleLabel = styled.label`
    display: inline-flex;
    align-items: center;
    gap: ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    cursor: pointer;
`;

const Button = styled.button<{ $variant?: 'primary' | 'danger' }>`
    background: ${(p) =>
        p.$variant === 'primary'
            ? logservTheme.colors.cyanAccent
            : p.$variant === 'danger'
            ? logservTheme.colors.red
            : 'transparent'};
    color: ${(p) =>
        p.$variant === 'primary' || p.$variant === 'danger'
            ? '#ffffff'
            : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) =>
            p.$variant === 'primary'
                ? logservTheme.colors.cyanAccent
                : p.$variant === 'danger'
                ? logservTheme.colors.red
                : logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 14px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    &:hover:not(:disabled) {
        opacity: 0.85;
    }
    &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

const ReadonlyValue = styled.code`
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.cyanLight};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 8px;
    font-family: monospace;
    font-size: ${logservTheme.fontSize.body};
`;

// ─── helpers ────────────────────────────────────────────────────────────────
/** Read Splunk Web's CSRF token from the cookie store. Splunk sets it as
 *  `splunkweb_csrf_token_<port>` — we don't know the port at compile time,
 *  so scan all cookies for a key starting with that prefix. */
const getCsrfToken = (): string => {
    const cookies = document.cookie.split(';');
    for (const c of cookies) {
        const [k, v] = c.trim().split('=');
        if (k && k.startsWith('splunkweb_csrf_token_') && v) {
            return decodeURIComponent(v);
        }
    }
    return '';
};

interface SavedSearchInfo {
    exists: boolean;
    disabled: boolean;
    cronSchedule: string;
    nextScheduled: string | null;
}

const fetchSavedSearchInfo = async (name: string): Promise<SavedSearchInfo> => {
    try {
        const res = await fetch(`${NS_PREFIX}/saved/searches/${name}?output_mode=json`, {
            credentials: 'same-origin',
        });
        if (!res.ok) {
            return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
        }
        const json = await res.json();
        const entry = json?.entry?.[0];
        if (!entry) {
            return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
        }
        const content = entry.content ?? {};
        return {
            exists: true,
            disabled: content.disabled === true || content.disabled === '1' || content.disabled === 1,
            cronSchedule: content.cron_schedule ?? '',
            nextScheduled: content.next_scheduled_time ?? null,
        };
    } catch {
        return { exists: false, disabled: true, cronSchedule: '', nextScheduled: null };
    }
};

const setSavedSearchEnabled = async (name: string, enabled: boolean): Promise<boolean> => {
    const action = enabled ? 'enable' : 'disable';
    const res = await fetch(`${NS_PREFIX}/saved/searches/${name}/${action}?output_mode=json`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'X-Splunk-Form-Key': getCsrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
        },
    });
    return res.ok;
};

const dispatchSavedSearch = async (name: string): Promise<{ ok: boolean; sid?: string }> => {
    const res = await fetch(`${NS_PREFIX}/saved/searches/${name}/dispatch?output_mode=json`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'X-Splunk-Form-Key': getCsrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
        },
    });
    if (!res.ok) return { ok: false };
    try {
        const json = await res.json();
        const sid = json?.sid ?? json?.entry?.[0]?.content?.sid;
        return { ok: true, sid };
    } catch {
        return { ok: true };
    }
};

interface SearchHistoryEntry {
    sid: string;
    dispatchedAt: number;
    isDone: boolean;
    resultCount: number;
}

const fetchSavedSearchHistory = async (name: string): Promise<SearchHistoryEntry[]> => {
    try {
        const res = await fetch(
            `${NS_PREFIX}/saved/searches/${name}/history?output_mode=json&count=10`,
            { credentials: 'same-origin' },
        );
        if (!res.ok) return [];
        const json = await res.json();
        const entries = json?.entry ?? [];
        return entries.map((e: any) => {
            const c = e.content ?? {};
            return {
                sid: c.sid ?? e.name ?? '',
                dispatchedAt: typeof c.dispatch_time === 'number' ? c.dispatch_time * 1000 : 0,
                isDone: c.isDone === true || c.isDone === '1' || c.isDone === 1,
                resultCount: typeof c.resultCount === 'number' ? c.resultCount : 0,
            } as SearchHistoryEntry;
        });
    } catch {
        return [];
    }
};

const formatTimestamp = (ms: number): string => {
    if (!ms || ms <= 0) return 'never';
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
};

const clearCollection = async (collectionName: string): Promise<boolean> => {
    const res = await fetch(
        `${NS_PREFIX}/storage/collections/data/${collectionName}?output_mode=json`,
        {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: {
                'X-Splunk-Form-Key': getCsrfToken(),
                'X-Requested-With': 'XMLHttpRequest',
            },
        },
    );
    return res.ok;
};

// ─── panel ───────────────────────────────────────────────────────────────────
const TopologySettingsPanel: React.FC = () => {
    const [loading, setLoading] = useState<boolean>(true);
    const [nodesInfo, setNodesInfo] = useState<SavedSearchInfo | null>(null);
    const [edgesInfo, setEdgesInfo] = useState<SavedSearchInfo | null>(null);
    const [lastBackfillNodes, setLastBackfillNodes] = useState<number>(0);
    const [lastBackfillEdges, setLastBackfillEdges] = useState<number>(0);
    const [busy, setBusy] = useState<'idle' | 'toggling' | 'backfilling' | 'clearing'>('idle');
    const [opError, setOpError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        const [n, e, hN, hE] = await Promise.all([
            fetchSavedSearchInfo(SAVED_SEARCH_NODES),
            fetchSavedSearchInfo(SAVED_SEARCH_EDGES),
            fetchSavedSearchHistory(SAVED_SEARCH_BACKFILL_NODES),
            fetchSavedSearchHistory(SAVED_SEARCH_BACKFILL_EDGES),
        ]);
        setNodesInfo(n);
        setEdgesInfo(e);
        setLastBackfillNodes(hN[0]?.dispatchedAt ?? 0);
        setLastBackfillEdges(hE[0]?.dispatchedAt ?? 0);
        setLoading(false);
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    /** Aggregation is "enabled" iff BOTH saved searches are enabled. */
    const aggregationEnabled =
        nodesInfo?.exists && edgesInfo?.exists && !nodesInfo.disabled && !edgesInfo.disabled;

    const handleToggleAggregation = useCallback(async () => {
        if (!nodesInfo || !edgesInfo) return;
        const targetEnabled = !aggregationEnabled;
        setBusy('toggling');
        setOpError(null);
        try {
            const [okN, okE] = await Promise.all([
                setSavedSearchEnabled(SAVED_SEARCH_NODES, targetEnabled),
                setSavedSearchEnabled(SAVED_SEARCH_EDGES, targetEnabled),
            ]);
            if (!okN || !okE) {
                setOpError('Failed to update one or both saved searches. Check admin permissions.');
            } else {
                setNotice(`Topology aggregation ${targetEnabled ? 'enabled' : 'disabled'}.`);
                window.setTimeout(() => setNotice(null), 4000);
            }
            await refresh();
        } finally {
            setBusy('idle');
        }
    }, [nodesInfo, edgesInfo, aggregationEnabled, refresh]);

    const handleBackfill = useCallback(async () => {
        // eslint-disable-next-line no-alert
        if (!window.confirm(
            'Run a 30-day backfill of topology nodes + edges? This dispatches two saved searches that will run for ~5-10 minutes each. Existing buckets are upserted (idempotent), so this is safe to run more than once.',
        )) return;
        setBusy('backfilling');
        setOpError(null);
        try {
            const [n, e] = await Promise.all([
                dispatchSavedSearch(SAVED_SEARCH_BACKFILL_NODES),
                dispatchSavedSearch(SAVED_SEARCH_BACKFILL_EDGES),
            ]);
            if (!n.ok || !e.ok) {
                setOpError('Failed to dispatch one or both backfill searches.');
            } else {
                setNotice(
                    `Backfill dispatched (nodes sid=${n.sid ?? 'unknown'}, edges sid=${e.sid ?? 'unknown'}). Searches run in the background; check Splunk's Job Monitor for progress. KV Store rows will appear as buckets are written.`,
                );
                window.setTimeout(() => setNotice(null), 12000);
            }
            await refresh();
        } finally {
            setBusy('idle');
        }
    }, [refresh]);

    const handleClearAll = useCallback(async () => {
        // eslint-disable-next-line no-alert
        if (!window.confirm(
            'CLEAR ALL TOPOLOGY DATA? This deletes every row in logserv_topology_nodes and logserv_topology_edges. The Environment Topology view will be empty until the next hourly aggregation run (or until the backfill is re-run). This action CANNOT be undone.',
        )) return;
        setBusy('clearing');
        setOpError(null);
        try {
            const [okN, okE] = await Promise.all([
                clearCollection(COLLECTION_NODES),
                clearCollection(COLLECTION_EDGES),
            ]);
            if (!okN || !okE) {
                setOpError('Failed to clear one or both collections.');
            } else {
                setNotice('All topology data cleared. Run a backfill or wait for the hourly aggregation to repopulate.');
                window.setTimeout(() => setNotice(null), 8000);
            }
        } finally {
            setBusy('idle');
        }
    }, []);

    if (loading && !nodesInfo && !edgesInfo) {
        return <FieldStatus $tone="absent">Loading topology aggregation status…</FieldStatus>;
    }

    const lastBackfillMs = Math.max(lastBackfillNodes, lastBackfillEdges);

    return (
        <>
            {notice && <FieldStatus $tone="good">{notice}</FieldStatus>}
            {opError && <FieldStatus $tone="error">{opError}</FieldStatus>}

            <SectionHeading>Aggregation</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Hourly aggregation</FieldLabel>
                    <FieldHint>
                        Master switch for the two scheduled saved searches that
                        populate the topology KV Store every hour
                        (logserv_topology_aggregate_nodes +
                        logserv_topology_aggregate_edges). When off, the
                        Environment Topology view will gradually become stale
                        as new traffic isn't aggregated. Existing data is
                        retained per the Retention setting below.
                    </FieldHint>
                </div>
                <ToggleLabel>
                    <input
                        type="checkbox"
                        checked={Boolean(aggregationEnabled)}
                        onChange={handleToggleAggregation}
                        disabled={busy !== 'idle' || !nodesInfo?.exists || !edgesInfo?.exists}
                    />
                    {aggregationEnabled ? 'Enabled' : 'Disabled'}
                </ToggleLabel>
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Cron schedule</FieldLabel>
                    <FieldHint>
                        Both aggregation searches run at the same cadence:
                        five minutes past every hour, processing the just-
                        completed hour's events. Edit the cron expressions
                        directly in default/savedsearches.conf if needed.
                    </FieldHint>
                </div>
                <ReadonlyValue>{nodesInfo?.cronSchedule || '5 * * * *'}</ReadonlyValue>
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Next scheduled run</FieldLabel>
                    <FieldHint>
                        From Splunk's saved-search dispatch metadata. Updates
                        on the saved search whenever it's re-evaluated.
                    </FieldHint>
                </div>
                <ReadonlyValue>{nodesInfo?.nextScheduled ?? '—'}</ReadonlyValue>
                <span />
            </FieldRow>

            <SectionHeading>Backfill</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>One-time 30-day backfill</FieldLabel>
                    <FieldHint>
                        Required after first install. Dispatches the two
                        backfill saved searches (logserv_topology_backfill_*)
                        which fill the last 30 days of hourly buckets in one
                        pass (~5-10 min each). Idempotent — safe to re-run if
                        the schema changes or a previous run was interrupted.
                        Until the backfill completes, the Environment Topology
                        view shows only the last hour or two of data accreted
                        from the regular hourly aggregation.
                    </FieldHint>
                </div>
                <Button
                    type="button"
                    $variant="primary"
                    onClick={handleBackfill}
                    disabled={busy !== 'idle'}
                >
                    {busy === 'backfilling' ? 'Dispatching…' : 'Run 30-day backfill'}
                </Button>
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Last backfill dispatched</FieldLabel>
                    <FieldHint>
                        Most-recent dispatch of either backfill search. To
                        check completion, view the Splunk Job Monitor or
                        re-run this page after a few minutes — the row count
                        in logserv_topology_nodes / _edges should grow.
                    </FieldHint>
                </div>
                <ReadonlyValue>{formatTimestamp(lastBackfillMs)}</ReadonlyValue>
                <span />
            </FieldRow>

            <SectionHeading>Retention</SectionHeading>
            <FieldRow>
                <div>
                    <FieldLabel>Retention window</FieldLabel>
                    <FieldHint>
                        Bucket rows older than this are deleted by the daily
                        retention saved search (logserv_topology_retention)
                        which runs at 00:30 UTC. Currently hardcoded at 365
                        days — adjust default/savedsearches.conf to change.
                    </FieldHint>
                </div>
                <ReadonlyValue>365 days</ReadonlyValue>
                <span />
            </FieldRow>
            <FieldRow>
                <div>
                    <FieldLabel>Clear all topology data</FieldLabel>
                    <FieldHint>
                        Deletes every row from both topology KV Store
                        collections. Use sparingly — typical use is to
                        wipe a contaminated dataset before re-running the
                        backfill against a corrected schema. The
                        Environment Topology view will be empty until the
                        next hourly aggregation or a backfill repopulates.
                    </FieldHint>
                </div>
                <Button
                    type="button"
                    $variant="danger"
                    onClick={handleClearAll}
                    disabled={busy !== 'idle'}
                >
                    {busy === 'clearing' ? 'Clearing…' : 'Clear all data'}
                </Button>
                <span />
            </FieldRow>
        </>
    );
};

export default TopologySettingsPanel;
