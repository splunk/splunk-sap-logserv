import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { useGlobalRefresh } from '../state/GlobalRefreshProvider';
import { useHostAliasStatus } from '../state/HostAliasProvider';
import { triggerDownload } from '../utils/download';
import { DOCS_HOST_NAMES } from '../utils/docsLinks';
import {
    AliasCsvResult,
    HostAliasRow,
    MAX_ALIAS_LEN,
    MAX_DESC_LEN,
    MAX_MATCH_LEN,
    MAX_ROWS,
    isDeletableKey,
    isoOfEpoch,
    parseAliasCsv,
    toAliasCsv,
} from '../utils/hostAlias';
import { HostAliasRead, deleteHostAlias, readAllHostAliases, upsertHostAliases } from '../utils/hostAliasApi';
import {
    LISTED_ROWS,
    SavePlan,
    SortBy,
    TableState,
    addLines,
    checkForm,
    conflictedKeys,
    countLineText,
    describeFailure,
    effectiveRows,
    firstLines,
    fmtCount,
    importConfirmText,
    importFileProblem,
    importTextProblem,
    isImportBlocked,
    keyOf,
    listRows,
    moreText,
    nameAfterDelete,
    planImport,
    planSave,
    renameLines,
    replaceLines,
    storedKeyOf,
} from '../utils/hostAliasEditor';

/**
 * HostAliasPanel - Settings > Host Names, the editor of the customer's own
 * names for hosts (App build 400).
 *
 * Mounted ONLY by dashboards/AIAssistantSettings.tsx, below its admin gate
 * (kvAcl.consistency-test K5p); the collection itself accepts writes only from
 * the admin tier (metadata/default.meta), so the gate is a convenience, not the
 * boundary. Every read and write goes through utils/hostAliasApi.ts; this file
 * never builds a KV URL or calls fetch. What to write is decided by the pure
 * utils/hostAliasEditor.ts (gate-tested in hostAlias.consistency-test, section
 * E); this file renders and asks.
 *
 * What it does:
 *  - reads the whole table (readAllHostAliases) and shows "N of 5,000", N the
 *    stored rows, with the rows it cannot show (invalidCount) named next to it
 *    ("unknown of 5,000" after a failed read), and a warning when more rows are
 *    stored than are read (`complete` false);
 *  - lists the rows (filter by name, host or description; sort by name or host)
 *    with Edit and Delete per row; Delete asks first, saying what the host value
 *    then shows (nameAfterDelete), and refuses a row whose stored key
 *    isDeletableKey refuses (a row written outside the App);
 *  - adds and edits one row, validated inline (checkForm); saving a host value
 *    another row already holds replaces that row's name after a confirmation
 *    naming both; an edit that changes the host value writes the new row first
 *    and then deletes the old one, so the host never has no name in between
 *    (planSave, whose row is the one written: with an empty description it keeps
 *    the replaced row's); a write that adds a row is refused while the stored
 *    rows fill MAX_ROWS;
 *  - imports a CSV (file or pasted text, at most 2 MB): parseAliasCsv, a
 *    preview with every error and its line, the counts, the names that change
 *    ("host: old -> new"), the hosts added and the rows of other hosts the
 *    import replaces (the first 100 of each), and Import only when the file has
 *    no error; Import asks first when a name changes or a row of another host is
 *    replaced (importConfirmText). Import MERGES (planImport): it upserts the
 *    added and changed rows and never deletes one (no replace-all: deleting
 *    first would leave every viewer an empty table mid-import). An empty
 *    description in the file keeps the stored one; a file with only the header
 *    says it holds no rows;
 *  - exports the table as host_aliases.csv (toAliasCsv, the import format),
 *    with a byte order mark in front so a spreadsheet opens it as UTF-8
 *    (parseAliasCsv drops the mark on import);
 *  - marks the rows of a host whose rows give different names with no rule to
 *    settle them (conflictedKeys): the dashboards use none of those rows, so the
 *    host shows no name unless another entry covers it.
 * Right before a Save or an Import writes, it reads the table again and plans
 * again over what it read: when that plan, or the row being edited, differs from
 * what the page showed, it writes nothing, shows the table as read and says
 * what the write would now do, so another admin's change is never replaced
 * unseen. Right before a Delete it reads the table again too: when the row the
 * question named is gone or changed, or the host value would now show another
 * name than the question said (deleteStoppedText), it deletes nothing, shows the
 * table as read and says what changed. After every write it reads the table
 * again and calls the provider's reload(), so the dashboards pick the change up.
 * It reads the list again on the nav-bar Refresh (the global refresh nonce) and
 * when a read of the provider's starts while this page is not reading, and reads
 * the provider's status (useHostAliasStatus) to say when this tab's dashboards
 * could not read the table.
 *
 * Display only: nothing here goes into a search, a rollup or the AI Assistant.
 */

const PAGE_ROWS = 100;
const EXPORT_FILE = 'host_aliases.csv';
/** U+FEFF, the byte order mark, written in front of the export: Excel on Windows
 *  opens a CSV without it in the legacy code page and garbles every non-ASCII
 *  name. parseAliasCsv drops it on import. */
const EXPORT_BOM = '\uFEFF';
const NOTICE_MS = 8000;

/* ------------------------------------------------------------------ */
/* Display helpers (the decisions are in utils/hostAliasEditor.ts)     */
/* ------------------------------------------------------------------ */

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Epoch seconds as local "YYYY-MM-DD HH:MM", '' when absent. */
const fmtWhen = (sec: number | undefined): string => {
    if (!sec) {
        return '';
    }
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) {
        return '';
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
        d.getMinutes(),
    )}`;
};

/** A row whose stored `_key` its host value does not give (sanitizeAliasRow's stored_key). */
const OUTSIDE_TEXT =
    'This row was written outside this page under a key its host value does not give. ' +
    'Saving it here stores it under its own key and removes the old row.';

/** A row isDeletableKey refuses: only a row written outside the App can be one.
 *  Every reason it refuses a key, in its order. */
const NOT_DELETABLE_TEXT =
    'This row was written outside this page under a key this page does not send in a delete: ' +
    'a key that holds a slash, a backslash or a percent sign (a delete with one could address ' +
    'the whole table), a question mark, a number sign or a semicolon, or a control, direction ' +
    'or invisible character; a key of only dots or blanks; or a key longer than 1,024 ' +
    'characters. Remove the row with the KV Store REST API.';

/** The rows of a host that conflictedKeys names: the dashboards use none of them.
 *  The host can still show a name another entry gives it (resolveAlias: a short
 *  entry covers its full names, full entries can name their short value). */
const CONFLICT_NOTE = 'rows give different names; the dashboards use none of them';

const CONFLICT_TEXT =
    'Two or more rows written outside this page give this host different names. None is stored ' +
    'under the key its host value gives, and the latest of them carry the same time of change (or ' +
    'none), so no rule picks one: the dashboards use none of them, so the host shows no name unless ' +
    'another entry covers it (a short-name entry covers its full names, for example); edit one of ' +
    "them and save it: this page stores it under the host's own key, and the dashboards use that row.";

/** What Save and Import say when the table read right before the write differs
 *  from the one the page showed: nothing was written. */
const TABLE_CHANGED_TEXT = 'the host name table changed after this page read it.';

/** A plan as text, to compare the plan the page showed with the one over the
 *  table read right before the write (the plans hold only text, numbers and rows). */
const planText = (plan: unknown): string => JSON.stringify(plan);

/** True when two rows show the same: host value, name and description. */
const sameEntry = (a: HostAliasRow, b: HostAliasRow): boolean =>
    a.match_value === b.match_value && a.alias === b.alias && (a.description || '') === (b.description || '');

/** Why Save wrote nothing when the plan over the table read right before the
 *  write is not the one the page showed (`asked`: the question the page asked,
 *  or null), and what Save now does. */
const saveStoppedText = (fresh: SavePlan, asked: string | null, button: string): string => {
    const base = `Nothing was saved: ${TABLE_CHANGED_TEXT} The list now shows the table as it is.`;
    if (fresh.kind === 'full') {
        return `${base} ${fresh.message}`;
    }
    if (fresh.kind === 'unchanged') {
        return `${base} It already holds this entry as the form gives it.`;
    }
    if (fresh.confirmText !== null && fresh.confirmText !== asked) {
        return `${base} ${button} now asks first: ${fresh.confirmText}`;
    }
    return `${base} Press ${button} again to save.`;
};

/** The question Delete asks: what the host value shows once the row is gone
 *  (nameAfterDelete), and where. */
const deleteQuestion = (row: HostAliasRow, after: string | null): string =>
    `Delete the name "${row.alias}" for ${row.match_value}? On the dashboards, ${row.match_value} then shows ` +
    `${after !== null ? `as "${after}"` : 'without a name'}: at once in this browser tab, and in other open ` +
    'tabs after their next Refresh. This cannot be undone.';

/** Why Delete deleted nothing when the table read right before the delete is
 *  not the one its question was asked over (`after`: what the question said the
 *  host value then shows), or null when the delete may go on: the row the admin
 *  clicked is still stored under its key, unchanged (sameEntry), and with it gone
 *  the host value shows what the question said (nameAfterDelete over the rows
 *  read). KV Store has no conditional delete, so this narrows the window only. */
const deleteStoppedText = (
    row: HostAliasRow,
    after: string | null,
    freshRows: ReadonlyArray<HostAliasRow>,
): string | null => {
    const key = storedKeyOf(row);
    const now = freshRows.find((r) => storedKeyOf(r) === key);
    const shown = 'The list now shows the table as it is.';
    if (now === undefined) {
        return (
            'Nothing was deleted: the table read right before the delete no longer holds the entry for ' +
            `${row.match_value}. ${shown}`
        );
    }
    const again = 'Press Delete again if you still want to delete it.';
    if (!sameEntry(now, row)) {
        const what =
            now.match_value === row.match_value && now.alias === row.alias
                ? 'only its description differs'
                : `it now gives ${now.match_value} the name "${now.alias}"`;
        return (
            `Nothing was deleted: the entry for ${row.match_value} changed after this page read the table; ` +
            `${what}. ${shown} ${again}`
        );
    }
    const afterNow = nameAfterDelete(freshRows, row);
    if (afterNow !== after) {
        const asText = (name: string | null): string => (name !== null ? `as "${name}"` : 'without a name');
        return (
            `Nothing was deleted: ${TABLE_CHANGED_TEXT} Without this entry, ${row.match_value} would now show ` +
            `${asText(afterNow)} on the dashboards, not ${asText(after)} as the question said. ${shown} ${again}`
        );
    }
    return null;
};

/* ------------------------------------------------------------------ */
/* Styles (the Settings panels' look; hint text 13px, line-height 1.5) */
/* ------------------------------------------------------------------ */

/* NO BACKTICKS IN THESE CSS COMMENTS - a backtick ends the tagged template. */
const Intro = styled.p`
    margin: 0 0 ${logservTheme.spacing.sm};
    color: ${logservTheme.colors.textMuted};
    font-size: 14px;
    line-height: 1.55;
    max-width: 110ch;
`;

const Hint = styled.div`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
    margin-top: 4px;
    max-width: 110ch;
`;

const DocLink = styled.a`
    color: ${logservTheme.colors.cyanAccent};
    text-decoration: underline;
`;

const CountLine = styled.div`
    margin: ${logservTheme.spacing.sm} 0 ${logservTheme.spacing.md};
    color: ${logservTheme.colors.textActive};
    font-size: 14px;
    font-weight: ${logservTheme.fontWeight.semibold};
    font-variant-numeric: tabular-nums;
`;

const SectionHeading = styled.h3`
    margin: ${logservTheme.spacing.lg} 0 ${logservTheme.spacing.sm};
    padding: ${logservTheme.spacing.xs} 0 ${logservTheme.spacing.sm};
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.cyanLight};
    text-transform: uppercase;
    letter-spacing: 1.2px;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const Banner = styled.div<{ $tone: 'warn' | 'good' | 'error' }>`
    padding: ${logservTheme.spacing.sm} ${logservTheme.spacing.md};
    margin-bottom: ${logservTheme.spacing.md};
    border-radius: ${logservTheme.radius.small};
    border: 1px solid
        ${(p) => {
            if (p.$tone === 'warn') {
                return logservTheme.colors.orange;
            }
            return p.$tone === 'error' ? logservTheme.colors.red : logservTheme.colors.teal;
        }};
    background: ${(p) => {
        if (p.$tone === 'warn') {
            return 'rgba(241,129,63,0.12)';
        }
        return p.$tone === 'error' ? 'rgba(220,78,65,0.12)' : 'rgba(0,212,180,0.10)';
    }};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

const FormGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(200px, 1fr));
    gap: ${logservTheme.spacing.md};
    align-items: start;
`;

const FieldLabel = styled.label`
    display: block;
    margin-bottom: 4px;
    color: ${logservTheme.colors.textActive};
    font-size: 14px;
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const FieldError = styled.div`
    color: ${logservTheme.colors.red};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
    margin-top: 4px;
`;

const TextInput = styled.input`
    box-sizing: border-box;
    width: 100%;
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const PasteBox = styled.textarea`
    box-sizing: border-box;
    width: 100%;
    min-height: 120px;
    resize: vertical;
    background: ${logservTheme.colors.tableHeaderBackground};
    color: ${logservTheme.colors.textActive};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
    padding: 6px 10px;
    font-family: ${logservTheme.font.mono};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;

    &:focus {
        outline: none;
        border-color: ${logservTheme.colors.cyanAccent};
    }
`;

const ButtonRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: ${logservTheme.spacing.sm};
    align-items: center;
    margin-top: ${logservTheme.spacing.md};
`;

const Button = styled.button<{ $variant?: 'primary' | 'danger' }>`
    background: ${(p) => {
        if (p.$variant === 'primary') {
            return logservTheme.colors.cyanAccent;
        }
        return p.$variant === 'danger' ? logservTheme.colors.red : 'transparent';
    }};
    color: ${(p) =>
        p.$variant === 'primary' || p.$variant === 'danger'
            ? logservTheme.colors.inverseText
            : logservTheme.colors.textActive};
    border: 1px solid
        ${(p) => {
            if (p.$variant === 'primary') {
                return logservTheme.colors.cyanAccent;
            }
            return p.$variant === 'danger' ? logservTheme.colors.red : logservTheme.colors.panelBorderWeak;
        }};
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

const SmallButton = styled.button<{ $variant?: 'danger' }>`
    background: transparent;
    color: ${(p) => (p.$variant === 'danger' ? logservTheme.colors.red : logservTheme.colors.cyanLight)};
    border: 1px solid
        ${(p) => (p.$variant === 'danger' ? 'rgba(220,78,65,0.5)' : logservTheme.colors.panelBorderWeak)};
    border-radius: ${logservTheme.radius.small};
    padding: 2px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: ${logservTheme.fontSize.body};
    white-space: nowrap;

    &:hover:not(:disabled) {
        opacity: 0.8;
    }

    &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
`;

const Toolbar = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: ${logservTheme.spacing.sm};
    align-items: center;
    margin-bottom: ${logservTheme.spacing.sm};
`;

const FilterInput = styled(TextInput)`
    width: auto;
    flex: 1 1 280px;
    max-width: 480px;
`;

const MutedText = styled.span`
    color: ${logservTheme.colors.textMuted};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

/* The header and each row are separate grids on these tracks, so every track
   must be the same width in both. Build 403: the Edit / Delete column has a
   fixed width. As `auto` (builds 400-402) it was 0 px in the header, whose cell
   is empty, and as wide as the Edit and Delete buttons in a row, so the header's
   fr tracks shared that much more and every heading after Name sat right of
   its column (up to about 105 px at Updated). 120 px holds both buttons at the
   13 px body size (about 109 px in the bundled Inter font). A browser minimum
   font size of 16 px or more makes the buttons wider than 120 px: they then
   reach into the gap before them, and from about 18 px into the Updated cell;
   the headings still line up. */
const ACTIONS_COL = '120px';
const ROW_COLS =
    `minmax(140px, 1.3fr) minmax(170px, 1.6fr) minmax(140px, 1.6fr) minmax(90px, 0.8fr) 132px ${ACTIONS_COL}`;

const TableHead = styled.div`
    display: grid;
    grid-template-columns: ${ROW_COLS};
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: ${logservTheme.spacing.xs} 0;
    border-bottom: 1px solid ${logservTheme.colors.cyanAccent};
    color: ${logservTheme.colors.textMuted};
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const TableRow = styled.div<{ $editing: boolean }>`
    display: grid;
    grid-template-columns: ${ROW_COLS};
    gap: ${logservTheme.spacing.md};
    align-items: center;
    padding: 5px 0;
    border-bottom: 1px solid ${logservTheme.colors.panelBorderWeak};
    background: ${(p) => (p.$editing ? logservTheme.colors.hoverBackground : 'transparent')};
    font-size: ${logservTheme.fontSize.body};

    &:last-child {
        border-bottom: 0;
    }
`;

const Cell = styled.div`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: ${logservTheme.colors.textDefault};
`;

const MutedCell = styled(Cell)`
    color: ${logservTheme.colors.textMuted};
    font-variant-numeric: tabular-nums;
`;

const MonoCell = styled(Cell)`
    font-family: ${logservTheme.font.mono};
`;

const NameCell = styled(Cell)`
    color: ${logservTheme.colors.textActive};
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const SortButton = styled.button`
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;

    &:hover {
        color: ${logservTheme.colors.textActive};
    }
`;

const RowActions = styled.div`
    display: inline-flex;
    gap: 6px;
    justify-content: flex-end;
`;

const OutsideNote = styled.div`
    color: ${logservTheme.colors.orange};
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

/* The rows of a host the dashboards use none of: the error colour, as the field errors. */
const ConflictNote = styled(OutsideNote)`
    color: ${logservTheme.colors.red};
`;

const PreviewBox = styled.div`
    margin-top: ${logservTheme.spacing.md};
    padding: ${logservTheme.spacing.md};
    border: 1px solid ${logservTheme.colors.panelBorderWeak};
    border-radius: ${logservTheme.radius.small};
`;

const Counts = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: ${logservTheme.spacing.lg};
    color: ${logservTheme.colors.textActive};
    font-size: 14px;
    font-variant-numeric: tabular-nums;
`;

const CountValue = styled.strong`
    font-weight: ${logservTheme.fontWeight.semibold};
`;

const MessageList = styled.ul`
    margin: ${logservTheme.spacing.sm} 0 0;
    padding-left: 20px;
    max-height: 240px;
    overflow-y: auto;
    font-size: ${logservTheme.fontSize.body};
    line-height: 1.5;
`;

const ErrorItem = styled.li`
    color: ${logservTheme.colors.red};
`;

const WarnItem = styled.li`
    color: ${logservTheme.colors.orange};
`;

const PlainItem = styled.li`
    color: ${logservTheme.colors.textDefault};
    overflow-wrap: anywhere;
`;

const ListLabel = styled.div`
    margin-top: ${logservTheme.spacing.md};
    color: ${logservTheme.colors.textActive};
    font-size: ${logservTheme.fontSize.body};
    font-weight: ${logservTheme.fontWeight.semibold};
    line-height: 1.5;
`;

const HiddenFileInput = styled.input`
    display: none;
`;

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

type Busy = 'save' | 'delete' | 'import' | null;

interface ImportOutcome {
    total: number;
    written: number;
    failures: string[];
}

const HostAliasPanel: React.FC = () => {
    const { reload, error: dashboardsError, loading: dashboardsLoading } = useHostAliasStatus();
    const { globalRefreshNonce } = useGlobalRefresh();
    const idBase = useId();
    const [rows, setRows] = useState<HostAliasRow[]>([]);
    const [complete, setComplete] = useState<boolean>(true);
    const [storedCount, setStoredCount] = useState<number>(0);
    const [invalidCount, setInvalidCount] = useState<number>(0);
    const [loading, setLoading] = useState<boolean>(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>('');
    const [sortBy, setSortBy] = useState<SortBy>('alias');
    const [sortDir, setSortDir] = useState<number>(1);
    const [limit, setLimit] = useState<number>(PAGE_ROWS);
    const [editing, setEditing] = useState<HostAliasRow | null>(null);
    const [formHost, setFormHost] = useState<string>('');
    const [formAlias, setFormAlias] = useState<string>('');
    const [formDesc, setFormDesc] = useState<string>('');
    const [formTried, setFormTried] = useState<boolean>(false);
    const [busy, setBusy] = useState<Busy>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [opError, setOpError] = useState<string | null>(null);
    const [importText, setImportText] = useState<string>('');
    const [importSource, setImportSource] = useState<string | null>(null);
    const [parsed, setParsed] = useState<AliasCsvResult | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);
    const mountedRef = useRef<boolean>(true);
    const abortRef = useRef<AbortController | null>(null);
    /** True while load() reads: a read of the provider's that starts then needs no second one here. */
    const readingRef = useRef<boolean>(false);
    /** The refresh nonce and the provider's loading flag last seen, to tell a new refresh or read. */
    const seenNonceRef = useRef<number>(globalRefreshNonce);
    const providerLoadingRef = useRef<boolean>(dashboardsLoading);
    const noticeTimerRef = useRef<number | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const formRef = useRef<HTMLFormElement | null>(null);
    const aliasRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (abortRef.current) {
                abortRef.current.abort();
            }
            if (noticeTimerRef.current !== null) {
                window.clearTimeout(noticeTimerRef.current);
            }
        };
    }, []);

    /** Show a table as read: by load(), and by Save, Import and Delete when the
     *  table read right before their write differs from the one shown. */
    const applyRead = useCallback((read: HostAliasRead): void => {
        setRows(read.rows);
        setComplete(read.complete);
        setStoredCount(read.storedCount);
        setInvalidCount(read.invalidCount);
        setLoadError(null);
    }, []);

    /** Read the table. A failed read leaves the list empty and blocks every
     *  write: without the table, a save could replace a name unseen. */
    const load = useCallback(async (): Promise<void> => {
        if (abortRef.current) {
            abortRef.current.abort();
        }
        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        abortRef.current = controller;
        readingRef.current = true;
        setLoading(true);
        try {
            const read = await readAllHostAliases({ signal: controller ? controller.signal : undefined });
            if (!mountedRef.current || (controller && controller.signal.aborted)) {
                return;
            }
            readingRef.current = false;
            applyRead(read);
            setLoading(false);
        } catch (e) {
            if (!mountedRef.current || (controller && controller.signal.aborted)) {
                return;
            }
            readingRef.current = false;
            setRows([]);
            setComplete(true);
            setStoredCount(0);
            setInvalidCount(0);
            setLoadError(errorText(e));
            setLoading(false);
        }
    }, [applyRead]);

    useEffect(() => {
        load();
    }, [load]);

    // The nav-bar Refresh reads the list again (the read on mount covers the nonce the page started with).
    useEffect(() => {
        if (seenNonceRef.current === globalRefreshNonce) {
            return;
        }
        seenNonceRef.current = globalRefreshNonce;
        load();
    }, [globalRefreshNonce, load]);

    // A read of the provider's that starts while this page is not reading (its reload() run from
    // elsewhere): read the list again too. After this page's own writes load() is already reading.
    useEffect(() => {
        const started = dashboardsLoading && !providerLoadingRef.current;
        providerLoadingRef.current = dashboardsLoading;
        if (started && !readingRef.current) {
            load();
        }
    }, [dashboardsLoading, load]);

    const showNotice = useCallback((text: string): void => {
        setNotice(text);
        if (noticeTimerRef.current !== null) {
            window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(() => {
            if (mountedRef.current) {
                setNotice(null);
            }
        }, NOTICE_MS);
    }, []);

    /** After any write: have the dashboards' copy reloaded (the provider is app-wide,
     *  so even when this tab was left mid-write), and read the table again here. */
    const afterWrite = useCallback(async (): Promise<void> => {
        reload();
        if (mountedRef.current) {
            await load();
        }
    }, [load, reload]);

    const canWrite = !loading && loadError === null && busy === null;

    /** The table as read: what the capacity checks count (every stored row, valid or not). */
    const table = useMemo<TableState>(
        () => ({ rows, complete, storedCount, invalidCount }),
        [rows, complete, storedCount, invalidCount],
    );

    /* ---------------- the list ---------------- */

    const shown = useMemo(() => listRows(rows, filter, sortBy, sortDir), [rows, filter, sortBy, sortDir]);

    useEffect(() => {
        setLimit(PAGE_ROWS);
    }, [filter, sortBy, sortDir]);

    const toggleSort = (by: SortBy): void => {
        if (sortBy === by) {
            setSortDir((d) => -d);
        } else {
            setSortBy(by);
            setSortDir(1);
        }
    };

    const ariaSort = (by: SortBy): 'ascending' | 'descending' | 'none' => {
        if (sortBy !== by) {
            return 'none';
        }
        return sortDir === 1 ? 'ascending' : 'descending';
    };

    const sortMark = (by: SortBy): string => {
        if (sortBy !== by) {
            return '';
        }
        return sortDir === 1 ? ' \u2191' : ' \u2193';
    };

    const handleExport = (): void => {
        const csv = toAliasCsv(Array.from(effectiveRows(rows).values()));
        // The byte order mark first, so a spreadsheet opens the file as UTF-8 (EXPORT_BOM).
        triggerDownload(new Blob([EXPORT_BOM, csv], { type: 'text/csv;charset=utf-8' }), EXPORT_FILE);
    };

    /** The hosts whose rows give different names with no rule to settle them. */
    const conflicted = useMemo(() => conflictedKeys(rows), [rows]);

    /* ---------------- add and edit ---------------- */

    const formCheck = useMemo(() => checkForm(formHost, formAlias, formDesc), [formHost, formAlias, formDesc]);

    const resetForm = (): void => {
        setEditing(null);
        setFormHost('');
        setFormAlias('');
        setFormDesc('');
        setFormTried(false);
    };

    const startEdit = (row: HostAliasRow): void => {
        setEditing(row);
        setFormHost(row.match_value);
        setFormAlias(row.alias);
        setFormDesc(row.description || '');
        setFormTried(false);
        setOpError(null);
        if (formRef.current && typeof formRef.current.scrollIntoView === 'function') {
            formRef.current.scrollIntoView({ block: 'nearest' });
        }
        if (aliasRef.current) {
            aliasRef.current.focus();
        }
    };

    const handleSave = async (): Promise<void> => {
        setFormTried(true);
        const { row } = formCheck;
        if (row === null || !canWrite) {
            return;
        }
        const savePlan = planSave(row, editing, table);
        if (savePlan.kind === 'unchanged') {
            showNotice('Nothing changed.');
            resetForm();
            return;
        }
        if (savePlan.kind === 'full') {
            setOpError(savePlan.message);
            return;
        }
        // eslint-disable-next-line no-alert
        if (savePlan.confirmText !== null && !window.confirm(savePlan.confirmText)) {
            return;
        }
        // The plan's row: the form's, or with the replaced row's description when the form leaves it empty.
        const { removeStoredKey, row: toSave } = savePlan;
        setBusy('save');
        setOpError(null);
        setNotice(null);
        // Read the table again right before the write and plan again over it: another admin may have
        // changed it since this page read it. Anything other than what the page showed writes nothing.
        let fresh: HostAliasRead;
        try {
            fresh = await readAllHostAliases();
        } catch (e) {
            if (mountedRef.current) {
                setOpError(
                    `Nothing was saved: the host name table could not be read again before the write (${errorText(e)}).`,
                );
                setBusy(null);
            }
            return;
        }
        const button = editing !== null ? 'Save changes' : 'Add';
        if (editing !== null) {
            const editedKey = storedKeyOf(editing);
            const editedNow = fresh.rows.find((r) => storedKeyOf(r) === editedKey);
            if (editedNow === undefined || !sameEntry(editedNow, editing)) {
                if (mountedRef.current) {
                    applyRead(fresh);
                    // The form keeps what it holds; Save then compares with the entry as it is now.
                    setEditing(editedNow !== undefined ? editedNow : null);
                    setOpError(
                        editedNow !== undefined
                            ? `Nothing was saved: the entry for ${editing.match_value} changed after this page ` +
                                  `read the table; it now gives ${editedNow.match_value} the name "${editedNow.alias}". ` +
                                  `The list now shows the table as it is. Press ${button} again to replace it ` +
                                  'with what the form holds.'
                            : `Nothing was saved: the entry for ${editing.match_value} was deleted after this page ` +
                                  'read the table. The list now shows the table as it is. Press Add to add what ' +
                                  'the form holds.',
                    );
                    setBusy(null);
                }
                return;
            }
        }
        const freshPlan = planSave(row, editing, fresh);
        if (planText(freshPlan) !== planText(savePlan)) {
            if (mountedRef.current) {
                applyRead(fresh);
                setOpError(saveStoppedText(freshPlan, savePlan.confirmText, button));
                setBusy(null);
            }
            return;
        }
        try {
            const result = await upsertHostAliases([toSave]);
            if (result.failures.length > 0) {
                setOpError(`Could not save ${row.match_value}: ${result.failures[0].message}`);
                return;
            }
            let leftOver: string | null = null;
            if (editing !== null && removeStoredKey !== null) {
                if (isDeletableKey(removeStoredKey)) {
                    try {
                        await deleteHostAlias(removeStoredKey);
                    } catch (e) {
                        leftOver = `The old entry for ${editing.match_value} could not be removed: ${errorText(e)}`;
                    }
                } else {
                    leftOver =
                        `The old entry for ${editing.match_value} is stored under a key this page cannot ` +
                        'delete, so it stays in the table.';
                }
            }
            resetForm();
            if (leftOver !== null) {
                setOpError(`Saved: ${row.match_value} is shown as ${row.alias}. ${leftOver}`);
            } else {
                showNotice(`Saved: ${row.match_value} is shown as ${row.alias}.`);
            }
        } catch (e) {
            setOpError(`Could not save ${row.match_value}: ${errorText(e)}`);
        } finally {
            if (mountedRef.current) {
                setBusy(null);
            }
            await afterWrite();
        }
    };

    /* ---------------- delete ---------------- */

    const handleDelete = async (row: HostAliasRow): Promise<void> => {
        const storedKey = storedKeyOf(row);
        if (!isDeletableKey(storedKey) || !canWrite) {
            return;
        }
        // What the host value shows once this row is gone: another entry may still name it (a short
        // entry covers a full name, full entries their short name, another row of the same host).
        const after = nameAfterDelete(rows, row);
        // eslint-disable-next-line no-alert
        const ok = window.confirm(deleteQuestion(row, after));
        if (!ok) {
            return;
        }
        setBusy('delete');
        setOpError(null);
        setNotice(null);
        // Read the table again right before the delete, as Save does before its write: another admin may have
        // changed it since this page read it. When the row the question named is gone or changed, or the host
        // value would now show another name than the question said, delete nothing (deleteStoppedText).
        let fresh: HostAliasRead;
        try {
            fresh = await readAllHostAliases();
        } catch (e) {
            if (mountedRef.current) {
                setOpError(
                    `Nothing was deleted: the host name table could not be read again before the delete (${errorText(e)}).`,
                );
                setBusy(null);
            }
            return;
        }
        const stopped = deleteStoppedText(row, after, fresh.rows);
        if (stopped !== null) {
            if (mountedRef.current) {
                applyRead(fresh);
                setOpError(stopped);
                setBusy(null);
            }
            return;
        }
        try {
            await deleteHostAlias(storedKey);
            if (editing !== null && storedKeyOf(editing) === storedKey) {
                resetForm();
            }
            showNotice(
                `Deleted the name "${row.alias}" for ${row.match_value}; on the dashboards it now shows ` +
                    `${after !== null ? `as "${after}"` : 'without a name'}.`,
            );
        } catch (e) {
            setOpError(`Could not delete the name for ${row.match_value}: ${errorText(e)}`);
        } finally {
            if (mountedRef.current) {
                setBusy(null);
            }
            await afterWrite();
        }
    };

    /* ---------------- import ---------------- */

    const plan = useMemo(() => (parsed !== null ? planImport(parsed.rows, table) : null), [parsed, table]);

    const runPreview = useCallback((text: string): void => {
        setImportOutcome(null);
        const problem = importTextProblem(text);
        if (problem !== null) {
            setParsed(null);
            setImportError(problem);
            return;
        }
        setImportError(null);
        setParsed(parseAliasCsv(text));
    }, []);

    const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const input = e.currentTarget;
        const file = input.files && input.files.length > 0 ? input.files[0] : null;
        // Cleared so that choosing the same file again reads it again.
        input.value = '';
        if (file === null) {
            return;
        }
        setImportOutcome(null);
        const fileProblem = importFileProblem(file.name, file.size);
        if (fileProblem !== null) {
            setParsed(null);
            setImportError(fileProblem);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            if (!mountedRef.current) {
                return;
            }
            const text = typeof reader.result === 'string' ? reader.result : '';
            setImportText(text);
            setImportSource(file.name);
            runPreview(text);
        };
        reader.onerror = () => {
            if (mountedRef.current) {
                setParsed(null);
                setImportError(`Could not read ${file.name}.`);
            }
        };
        reader.readAsText(file);
    };

    const clearImport = (): void => {
        setImportText('');
        setImportSource(null);
        setParsed(null);
        setImportError(null);
        setImportOutcome(null);
    };

    const importBlocked = isImportBlocked(parsed, plan);

    const handleImport = async (): Promise<void> => {
        if (importBlocked || parsed === null || plan === null || !canWrite) {
            return;
        }
        // A name that changes cannot be undone: ask first, as Delete does.
        const question = importConfirmText(plan);
        // eslint-disable-next-line no-alert
        if (question !== null && !window.confirm(question)) {
            return;
        }
        const { toWrite } = plan;
        setBusy('import');
        setImportError(null);
        setImportOutcome(null);
        setOpError(null);
        setNotice(null);
        // Read the table again right before the write and plan the file again over it: when the plan
        // (its rows, counts, lists, question or capacity) is not the one the preview showed, write
        // nothing and show the new preview.
        let fresh: HostAliasRead;
        try {
            fresh = await readAllHostAliases();
        } catch (e) {
            if (mountedRef.current) {
                setImportError(
                    `The import did not run: the host name table could not be read again before the write (${errorText(e)}).`,
                );
                setBusy(null);
            }
            return;
        }
        const freshPlan = planImport(parsed.rows, fresh);
        if (planText(freshPlan) !== planText(plan) || importConfirmText(freshPlan) !== question) {
            if (mountedRef.current) {
                applyRead(fresh);
                setImportError(
                    `Nothing was imported: ${TABLE_CHANGED_TEXT} The list now shows the table as it is, ` +
                        'and the preview below compares the file with it; check the preview, then Import again.',
                );
                setBusy(null);
            }
            return;
        }
        try {
            const result = await upsertHostAliases(toWrite);
            if (mountedRef.current) {
                setImportOutcome({
                    total: toWrite.length,
                    written: result.written,
                    failures: result.failures.map((f) => describeFailure(f, toWrite)),
                });
                if (result.failures.length === 0) {
                    setImportText('');
                    setImportSource(null);
                    setParsed(null);
                }
            }
        } catch (e) {
            if (mountedRef.current) {
                setImportError(`The import did not run: ${errorText(e)}`);
            }
        } finally {
            if (mountedRef.current) {
                setBusy(null);
            }
            await afterWrite();
        }
    };

    /* ---------------- render ---------------- */

    const visible = shown.slice(0, limit);
    const notShown = shown.length - visible.length;
    const showErrors = (field: 'host' | 'alias' | 'description', value: string): string | null =>
        formTried || value.trim() !== '' ? formCheck[field] : null;
    const hostError = showErrors('host', formHost);
    const aliasError = showErrors('alias', formAlias);
    const descError = showErrors('description', formDesc);

    let saveLabel = editing !== null ? 'Save changes' : 'Add';
    if (busy === 'save') {
        saveLabel = 'Saving...';
    }

    const renamedList = firstLines(plan !== null ? renameLines(plan) : []);
    const addedList = firstLines(plan !== null ? addLines(plan) : []);
    const replacedList = firstLines(plan !== null ? replaceLines(plan) : []);

    // After a failed read the count is not known: no "0 of 5,000" beside the error.
    let countText = countLineText(table);
    if (loading && rows.length === 0 && invalidCount === 0) {
        countText = 'Reading the host name table...';
    } else if (loadError !== null) {
        countText = `unknown of ${fmtCount(MAX_ROWS)}`;
    }

    let importLabel = 'Import';
    if (busy === 'import') {
        importLabel = 'Importing...';
    } else if (plan !== null && plan.toWrite.length > 0) {
        importLabel = `Import ${fmtCount(plan.toWrite.length)} ${plan.toWrite.length === 1 ? 'row' : 'rows'}`;
    }

    return (
        <>
            <Intro>
                Give hosts your own names, for example <em>Payroll app server</em> for{' '}
                <code>app01.example.com</code>. Tables, host lists and the Host filter list show the
                name next to the host name; the per-host charts, the Sourcetype Mapping graphs and the
                Host filter button (one host picked) show the name alone. Searches, filters, Open in
                Search, a panel&apos;s CSV download, the AI Assistant and the Data Doctor always use the
                host names from the logs. Every user sees the names; only admins can change them here.
                See the{' '}
                <DocLink href={DOCS_HOST_NAMES} target="_blank" rel="noopener noreferrer">
                    Host Names documentation
                </DocLink>
                .
            </Intro>
            <Hint>
                Matching ignores letter case and a trailing dot. A name entered for a short name (app01)
                also covers its fully qualified names (app01.example.com); one entered for a fully
                qualified name covers that name and, unless another entry says otherwise, its short
                name. An IP address matches only itself. There are no wildcards or ranges. A change
                shows on the dashboards at once; in other open browser tabs, after Refresh.
            </Hint>

            <CountLine>{countText}</CountLine>

            {loadError !== null && (
                <Banner $tone="error">
                    Could not read the host name table: {loadError}. The dashboards show the real host
                    names only until it can be read, and this page cannot change it.{' '}
                    <SmallButton type="button" onClick={() => load()} disabled={loading}>
                        Retry
                    </SmallButton>
                </Banner>
            )}
            {loadError === null && !complete && (
                <Banner $tone="warn">
                    The table holds more than {fmtCount(MAX_ROWS)} rows. Only {fmtCount(MAX_ROWS)} are read, here
                    and on the dashboards, and which ones is not fixed, so some names may not show and
                    the export leaves some out. Delete rows until no more than {fmtCount(MAX_ROWS)} remain;
                    no host can be added until then.
                </Banner>
            )}
            {loadError === null && !loading && dashboardsError !== null && !dashboardsLoading && (
                <Banner $tone="warn">
                    The dashboards in this browser tab could not read the host name table ({dashboardsError}),
                    so they show the host names from the logs. Refresh tries again.
                </Banner>
            )}
            {notice !== null && <Banner $tone="good">{notice}</Banner>}
            {opError !== null && <Banner $tone="error">{opError}</Banner>}

            <SectionHeading>{editing !== null ? 'Edit a host name' : 'Add a host name'}</SectionHeading>
            <form
                ref={formRef}
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    handleSave();
                }}
            >
                <FormGrid>
                    <div>
                        <FieldLabel htmlFor={`${idBase}-host`}>Host value</FieldLabel>
                        <TextInput
                            id={`${idBase}-host`}
                            type="text"
                            value={formHost}
                            maxLength={MAX_MATCH_LEN + 10}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="app01.example.com, app01 or an IP address"
                            onChange={(e) => setFormHost(e.target.value)}
                            disabled={busy !== null}
                        />
                        {hostError !== null ? (
                            <FieldError>{hostError}</FieldError>
                        ) : (
                            <Hint>
                                {formCheck.covers !== null
                                    ? formCheck.covers
                                    : 'As the data shows it: a fully qualified name, a short name or an IP address.'}
                            </Hint>
                        )}
                    </div>
                    <div>
                        <FieldLabel htmlFor={`${idBase}-alias`}>Name</FieldLabel>
                        <TextInput
                            id={`${idBase}-alias`}
                            ref={aliasRef}
                            type="text"
                            value={formAlias}
                            maxLength={MAX_ALIAS_LEN + 10}
                            autoComplete="off"
                            placeholder="Payroll app server"
                            onChange={(e) => setFormAlias(e.target.value)}
                            disabled={busy !== null}
                        />
                        {aliasError !== null ? (
                            <FieldError>{aliasError}</FieldError>
                        ) : (
                            <Hint>{`The name the dashboards show, at most ${MAX_ALIAS_LEN} characters.`}</Hint>
                        )}
                    </div>
                    <div>
                        <FieldLabel htmlFor={`${idBase}-desc`}>Description (optional)</FieldLabel>
                        <TextInput
                            id={`${idBase}-desc`}
                            type="text"
                            value={formDesc}
                            maxLength={MAX_DESC_LEN + 10}
                            autoComplete="off"
                            onChange={(e) => setFormDesc(e.target.value)}
                            disabled={busy !== null}
                        />
                        {descError !== null ? (
                            <FieldError>{descError}</FieldError>
                        ) : (
                            <Hint>
                                {`A note for admins, shown only on this page; at most ${MAX_DESC_LEN} characters. Every role can read it, so keep personal data out of it.`}
                            </Hint>
                        )}
                    </div>
                </FormGrid>
                <ButtonRow>
                    <Button
                        type="submit"
                        $variant="primary"
                        disabled={!canWrite || (formTried && formCheck.row === null)}
                    >
                        {saveLabel}
                    </Button>
                    {(editing !== null || formHost !== '' || formAlias !== '' || formDesc !== '') && (
                        <Button type="button" onClick={resetForm} disabled={busy !== null}>
                            Cancel
                        </Button>
                    )}
                    {editing !== null && <MutedText>{`Editing the entry for ${editing.match_value}.`}</MutedText>}
                </ButtonRow>
            </form>

            <SectionHeading>Host names</SectionHeading>
            <Toolbar>
                <FilterInput
                    type="search"
                    aria-label="Filter the host names"
                    placeholder="Filter by name, host or description"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                {filter.trim() !== '' && <MutedText>{`${fmtCount(shown.length)} matching`}</MutedText>}
                <Button
                    type="button"
                    onClick={handleExport}
                    disabled={loading || loadError !== null}
                    title="Download the table as host_aliases.csv, in the format Import reads, as UTF-8 with a byte order mark so a spreadsheet opens it as UTF-8. With no rows it is an empty template."
                >
                    Export CSV
                </Button>
            </Toolbar>

            {rows.length === 0 && !loading && loadError === null && (
                <Hint>No host names yet. Add one above, or import a CSV file below.</Hint>
            )}
            {rows.length > 0 && shown.length === 0 && <Hint>No host name matches the filter.</Hint>}
            {shown.length > 0 && (
                <div role="table" aria-label="Host names">
                    <TableHead role="row">
                        <div role="columnheader" aria-sort={ariaSort('alias')}>
                            <SortButton type="button" onClick={() => toggleSort('alias')}>
                                {`Name${sortMark('alias')}`}
                            </SortButton>
                        </div>
                        <div role="columnheader" aria-sort={ariaSort('host')}>
                            <SortButton type="button" onClick={() => toggleSort('host')}>
                                {`Host value${sortMark('host')}`}
                            </SortButton>
                        </div>
                        <div role="columnheader">Description</div>
                        <div role="columnheader">Updated by</div>
                        <div role="columnheader">Updated</div>
                        <div role="columnheader" aria-label="Actions" />
                    </TableHead>
                    {visible.map((row) => {
                        const storedKey = storedKeyOf(row);
                        const deletable = isDeletableKey(storedKey);
                        const isEditing = editing !== null && storedKeyOf(editing) === storedKey;
                        return (
                            <TableRow role="row" key={storedKey} $editing={isEditing}>
                                <NameCell role="cell" title={row.alias}>
                                    {row.alias}
                                </NameCell>
                                <div role="cell" style={{ minWidth: 0 }}>
                                    <MonoCell title={row.match_value}>{row.match_value}</MonoCell>
                                    {row.stored_key !== undefined && (
                                        <OutsideNote title={deletable ? OUTSIDE_TEXT : NOT_DELETABLE_TEXT}>
                                            {deletable
                                                ? 'written outside this page'
                                                : 'written outside this page; cannot be deleted here'}
                                        </OutsideNote>
                                    )}
                                    {conflicted.has(keyOf(row)) && (
                                        <ConflictNote title={CONFLICT_TEXT}>{CONFLICT_NOTE}</ConflictNote>
                                    )}
                                </div>
                                <MutedCell role="cell" title={row.description || ''}>
                                    {row.description || ''}
                                </MutedCell>
                                <MutedCell role="cell" title={row.updated_by || ''}>
                                    {row.updated_by || ''}
                                </MutedCell>
                                <MutedCell
                                    role="cell"
                                    title={isoOfEpoch(row.updated_at) || ''}
                                >
                                    {fmtWhen(row.updated_at)}
                                </MutedCell>
                                <RowActions role="cell">
                                    <SmallButton
                                        type="button"
                                        onClick={() => startEdit(row)}
                                        disabled={!canWrite}
                                        aria-label={`Edit the name for ${row.match_value}`}
                                    >
                                        Edit
                                    </SmallButton>
                                    <SmallButton
                                        type="button"
                                        $variant="danger"
                                        onClick={() => handleDelete(row)}
                                        disabled={!canWrite || !deletable}
                                        aria-label={`Delete the name for ${row.match_value}`}
                                        title={deletable ? undefined : NOT_DELETABLE_TEXT}
                                    >
                                        Delete
                                    </SmallButton>
                                </RowActions>
                            </TableRow>
                        );
                    })}
                </div>
            )}
            {notShown > 0 && (
                <ButtonRow>
                    <Button type="button" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
                        {`Show ${fmtCount(Math.min(PAGE_ROWS, notShown))} more`}
                    </Button>
                    <MutedText>{`${fmtCount(notShown)} not shown`}</MutedText>
                </ButtonRow>
            )}

            <SectionHeading>Import from CSV</SectionHeading>
            <Hint>
                The first line is the header <code>host,alias,description</code> (description is
                optional; Export writes the same format), with commas between the columns; save the
                file as CSV UTF-8. Each line adds a host or changes its name; Import never deletes a
                row, an empty description keeps the stored one, and a line that repeats an earlier one
                is skipped. At most {fmtCount(MAX_ROWS)} rows and 2 MB. Preview lists the lines it
                refuses; Import stays off until none is left.
            </Hint>
            <ButtonRow>
                <HiddenFileInput
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={onFileChosen}
                    aria-label="Choose a CSV file"
                />
                <Button
                    type="button"
                    onClick={() => fileRef.current && fileRef.current.click()}
                    disabled={busy !== null}
                >
                    Choose a CSV file...
                </Button>
                {importSource !== null && <MutedText>{`Loaded ${importSource}`}</MutedText>}
            </ButtonRow>
            <div style={{ marginTop: logservTheme.spacing.md }}>
                <FieldLabel htmlFor={`${idBase}-paste`}>Or paste the CSV text</FieldLabel>
                <PasteBox
                    id={`${idBase}-paste`}
                    value={importText}
                    spellCheck={false}
                    placeholder={
                        'host,alias,description\n' +
                        'app01.example.com,Payroll app server,Payroll production\n' +
                        'db01,Payroll database,'
                    }
                    onChange={(e) => {
                        setImportText(e.target.value);
                        setImportSource(null);
                        setParsed(null);
                        setImportError(null);
                        setImportOutcome(null);
                    }}
                    disabled={busy !== null}
                />
            </div>
            <ButtonRow>
                <Button
                    type="button"
                    onClick={() => runPreview(importText)}
                    disabled={busy !== null || importText.trim() === ''}
                >
                    Preview
                </Button>
                {(importText !== '' || parsed !== null || importError !== null) && (
                    <Button type="button" onClick={clearImport} disabled={busy !== null}>
                        Clear
                    </Button>
                )}
            </ButtonRow>
            {importError !== null && (
                <Banner $tone="error" style={{ marginTop: logservTheme.spacing.md }}>
                    {importError}
                </Banner>
            )}

            {parsed !== null && plan !== null && (
                <PreviewBox>
                    <Counts>
                        <span>
                            To add: <CountValue>{fmtCount(plan.added)}</CountValue>
                        </span>
                        <span>
                            To change (name differs): <CountValue>{fmtCount(plan.renamed)}</CountValue>
                        </span>
                        <span>
                            To change (description only): <CountValue>{fmtCount(plan.describedOnly)}</CountValue>
                        </span>
                        <span>
                            Unchanged: <CountValue>{fmtCount(plan.unchanged)}</CountValue>
                        </span>
                        {plan.replaced > 0 && (
                            <span>
                                Rows of other hosts replaced: <CountValue>{fmtCount(plan.replaced)}</CountValue>
                            </span>
                        )}
                        <span>
                            Lines refused: <CountValue>{fmtCount(parsed.errors.length)}</CountValue>
                        </span>
                    </Counts>
                    {parsed.errors.length > 0 && (
                        <>
                            <Hint>
                                Fix these lines in the file, then preview again. Nothing is imported
                                while any line is refused.
                            </Hint>
                            <MessageList>
                                {parsed.errors.slice(0, LISTED_ROWS).map((m) => (
                                    <ErrorItem key={`e-${m.line}-${m.message}`}>
                                        {`Line ${m.line}: ${m.message}`}
                                    </ErrorItem>
                                ))}
                                {parsed.errors.length > LISTED_ROWS && (
                                    <ErrorItem>{moreText(parsed.errors.length - LISTED_ROWS)}</ErrorItem>
                                )}
                            </MessageList>
                        </>
                    )}
                    {parsed.warnings.length > 0 && (
                        <MessageList>
                            {parsed.warnings.slice(0, LISTED_ROWS).map((m) => (
                                <WarnItem key={`w-${m.line}-${m.message}`}>{`Line ${m.line}: ${m.message}`}</WarnItem>
                            ))}
                            {parsed.warnings.length > LISTED_ROWS && (
                                <WarnItem>{moreText(parsed.warnings.length - LISTED_ROWS)}</WarnItem>
                            )}
                        </MessageList>
                    )}
                    {parsed.errors.length === 0 && renamedList.lines.length > 0 && (
                        <>
                            <ListLabel>Names that change</ListLabel>
                            <MessageList>
                                {renamedList.lines.map((ln) => (
                                    <PlainItem key={`r-${ln}`}>{ln}</PlainItem>
                                ))}
                                {renamedList.more > 0 && <PlainItem>{moreText(renamedList.more)}</PlainItem>}
                            </MessageList>
                        </>
                    )}
                    {parsed.errors.length === 0 && addedList.lines.length > 0 && (
                        <>
                            <ListLabel>Hosts to add</ListLabel>
                            <MessageList>
                                {addedList.lines.map((ln) => (
                                    <PlainItem key={`a-${ln}`}>{ln}</PlainItem>
                                ))}
                                {addedList.more > 0 && <PlainItem>{moreText(addedList.more)}</PlainItem>}
                            </MessageList>
                        </>
                    )}
                    {parsed.errors.length === 0 && replacedList.lines.length > 0 && (
                        <>
                            <ListLabel>Rows of other hosts the import replaces</ListLabel>
                            <MessageList>
                                {replacedList.lines.map((ln) => (
                                    <PlainItem key={`p-${ln}`}>{ln}</PlainItem>
                                ))}
                                {replacedList.more > 0 && <PlainItem>{moreText(replacedList.more)}</PlainItem>}
                            </MessageList>
                        </>
                    )}
                    {plan.capacityError !== null && (
                        <Banner $tone="error" style={{ marginTop: logservTheme.spacing.md }}>
                            {plan.capacityError}
                        </Banner>
                    )}
                    {parsed.errors.length === 0 && parsed.rows.length === 0 && (
                        <Hint>The file holds no rows below the header.</Hint>
                    )}
                    {parsed.errors.length === 0 &&
                        parsed.rows.length > 0 &&
                        plan.capacityError === null &&
                        plan.toWrite.length === 0 && (
                            <Hint>Every host in the file already has these names. There is nothing to import.</Hint>
                        )}
                    {/* Only while Import is on: not beside refused lines, a capacity error or nothing to write. */}
                    {!importBlocked && <Hint>Tip: Export CSV first to keep a copy.</Hint>}
                    <ButtonRow>
                        <Button
                            type="button"
                            $variant="primary"
                            onClick={() => handleImport()}
                            disabled={importBlocked || !canWrite}
                        >
                            {importLabel}
                        </Button>
                    </ButtonRow>
                </PreviewBox>
            )}

            {importOutcome !== null && (
                <Banner
                    $tone={importOutcome.failures.length === 0 ? 'good' : 'warn'}
                    style={{ marginTop: logservTheme.spacing.md }}
                >
                    {`Imported: ${fmtCount(importOutcome.written)} of ${fmtCount(importOutcome.total)} rows written.`}
                    {importOutcome.failures.length > 0 && (
                        <MessageList>
                            {importOutcome.failures.map((f) => (
                                <ErrorItem key={f}>{f}</ErrorItem>
                            ))}
                        </MessageList>
                    )}
                    {importOutcome.failures.length > 0 && (
                        <Hint>
                            The rows that failed were not written or not confirmed. The preview above now
                            compares the file with the table as read after the import, so Import again
                            writes only what still differs.
                        </Hint>
                    )}
                </Banner>
            )}
        </>
    );
};

export default HostAliasPanel;
