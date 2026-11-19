/**
 * The decisions of the host name editor, Settings > Host Names (App build 400):
 * what Save and Import write, the capacity checks, the inline form checks, the
 * list's filter and order, and the texts the editor shows for them.
 * components/HostAliasPanel.tsx renders the page and does the reads and writes
 * (through utils/hostAliasApi.ts); every choice of WHAT to write is made here.
 *
 * The rules:
 *  - one row per derived key is the one the dashboards use: a row stored under
 *    its own key first, then the later write (winsOver / effectiveRows, the
 *    order buildAliasIndex uses). Rows of one key that tie on that order and
 *    give different names are a conflict, which buildAliasIndex settles with NO
 *    name (conflictedKeys names those keys; effectiveRows still returns one of
 *    the tied rows, the one ranksBefore takes first, so no choice the editor
 *    makes depends on the order the rows were read in);
 *  - every write goes to the host's DERIVED key, and batch_save replaces a row
 *    stored under that key whole: the row of the same host there, or a row of
 *    ANOTHER host written outside the editor under it (Save and Import ask
 *    before either and name it; that write adds no row);
 *  - Save of a host another row already names keeps that row's description
 *    when the form leaves the description empty, as Import keeps a stored
 *    description;
 *  - Import MERGES (planImport): a host not in the table is added; a host whose
 *    name differs, or whose file description is not empty and differs, is
 *    changed, and so is a host whose rows conflict; an empty description in the
 *    file keeps the stored one; the rest is not written. An import never deletes
 *    a row;
 *  - capacity counts the STORED rows, valid or not (TableState): a row the
 *    editor cannot show (sanitizeAliasRow refuses it) still takes one of the
 *    MAX_ROWS places the App reads, and nothing can be added after a read that
 *    stopped at MAX_ROWS. A new row is a write to a key no stored row holds: an
 *    add, an import's write of a host whose row in effect is stored under a key
 *    its host value does not give (written outside the editor: the write goes
 *    to the host's own key, a new row, and the old row stays, as an import
 *    deletes nothing), and a Save that writes a host value under a key no row
 *    holds (an edit that moves a row writes the new row before it deletes the
 *    old one).
 *
 * GATE-SAFE MODULE: it imports only ./hostAlias (pure itself); no React, no
 * network, no DOM, and nothing runs at import time.
 * utils/hostAlias.consistency-test.ts loads it directly (section E).
 */
import {
    AliasCsvResult,
    HostAliasRow,
    MAX_ALIAS_LEN,
    MAX_DESC_LEN,
    MAX_MATCH_LEN,
    MAX_ROWS,
    buildAliasIndex,
    hasForbiddenChars,
    hasVisibleChar,
    isDeletableKey,
    keyForMatchValue,
    parseIp,
    resolveAlias,
    sanitizeAliasRow,
} from './hostAlias';

/** The largest import the editor reads: a file's size, or a pasted text's length. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** The most rows a preview list or a message list shows before "and N more". */
export const LISTED_ROWS = 100;

/** A count as the editor writes it: 5,000. */
export const fmtCount = (n: number): string => n.toLocaleString('en-US');

/** A file size: "2.0 MB" from 1 MB up, else whole KB rounded up. */
export const fmtSize = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

/* ------------------------------------------------------------------ */
/* The table as read                                                   */
/* ------------------------------------------------------------------ */

/** What the editor knows of the table after a read (readAllHostAliases). */
export interface TableState {
    /** The valid rows read (sanitizeAliasRow). */
    rows: ReadonlyArray<HostAliasRow>;
    /** False when more than MAX_ROWS rows are stored. */
    complete: boolean;
    /** The stored rows read, valid or not (at most MAX_ROWS). */
    storedCount: number;
    /** Those of them sanitizeAliasRow refuses: stored, but not in `rows`. */
    invalidCount: number;
}

/** The rows the table holds against MAX_ROWS: every stored row read, valid or not. */
export const storedTotal = (table: TableState): number =>
    Math.max(table.storedCount, table.rows.length + table.invalidCount);

/** True when no host can be added: the read stopped at MAX_ROWS, or the stored
 *  rows (valid or not) already fill it. */
export const isTableFull = (table: TableState): boolean => !table.complete || storedTotal(table) >= MAX_ROWS;

/** "N of 5,000", N the stored rows; with rows the editor cannot show, how many and
 *  where they can be removed. */
export const countLineText = (table: TableState): string => {
    const base = `${fmtCount(storedTotal(table))} of ${fmtCount(MAX_ROWS)}`;
    const m = table.invalidCount;
    if (m <= 0) {
        return base;
    }
    return m === 1
        ? `${base} (1 stored row cannot be shown here; remove it with the KV Store REST API)`
        : `${base} (${fmtCount(m)} stored rows cannot be shown here; remove them with the KV Store REST API)`;
};

/* ------------------------------------------------------------------ */
/* Keys and the row in effect                                          */
/* ------------------------------------------------------------------ */

/** The derived key: the one matching and upserts use. */
export const keyOf = ({ _key: key }: HostAliasRow): string => key;

/** The key the row is stored under: the one a delete must use. */
export const storedKeyOf = (row: HostAliasRow): string => (row.stored_key !== undefined ? row.stored_key : keyOf(row));

/** True when `a` is the row the dashboards use over `b` for one key: a row
 *  stored under its own key first, then the later write (buildAliasIndex).
 *  False both ways is a tie: the same rank and the same (or no) updated_at.
 *  A tie between different names is a conflict (conflictedKeys). */
export const winsOver = (a: HostAliasRow, b: HostAliasRow): boolean => {
    const ca = a.stored_key === undefined ? 1 : 0;
    const cb = b.stored_key === undefined ? 1 : 0;
    if (ca !== cb) {
        return ca > cb;
    }
    return (a.updated_at || 0) > (b.updated_at || 0);
};

/** Plain code-unit order of two strings (no locale, so no browser setting changes it). */
const compareUnits = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
};

/**
 * True when the editor takes `a` before `b` among rows of one derived key: the
 * row the dashboards use first (winsOver: a row stored under its own key, then
 * the later write), and between rows that tie on that, the one stored under the
 * smaller key (storedKeyOf, plain code-unit order), then the smaller host value,
 * name, description and updated_by. Every choice of one row among tied rows
 * (effectiveRows, so planSave's row in effect, planImport's and the export's)
 * goes through it, so it never depends on the order the server returned the
 * rows in (readAllKvRows asks for no sort): the same rows in any order give the
 * same row. It decides nothing the dashboards show: buildAliasIndex gives tied
 * rows with different names no name at all.
 */
export const ranksBefore = (a: HostAliasRow, b: HostAliasRow): boolean => {
    if (winsOver(a, b)) {
        return true;
    }
    if (winsOver(b, a)) {
        return false;
    }
    const order =
        compareUnits(storedKeyOf(a), storedKeyOf(b)) ||
        compareUnits(a.match_value, b.match_value) ||
        compareUnits(a.alias, b.alias) ||
        compareUnits(a.description || '', b.description || '') ||
        compareUnits(a.updated_by || '', b.updated_by || '');
    return order < 0;
};

/** One row per derived key: the one the dashboards use. Among tied rows the one
 *  ranksBefore takes first is kept (the one stored under the smallest key), and
 *  the keys come in plain code-unit order, so the same rows in any order give
 *  the same Map. When the tied rows give different names the dashboards use none
 *  of them (conflictedKeys names such keys). */
export const effectiveRows = (rows: ReadonlyArray<HostAliasRow>): Map<string, HostAliasRow> => {
    const best = new Map<string, HostAliasRow>();
    rows.forEach((row) => {
        const key = keyOf(row);
        const prev = best.get(key);
        if (prev === undefined || ranksBefore(row, prev)) {
            best.set(key, row);
        }
    });
    const out = new Map<string, HostAliasRow>();
    Array.from(best.keys())
        .sort(compareUnits)
        .forEach((key) => {
            out.set(key, best.get(key) as HostAliasRow);
        });
    return out;
};

/**
 * The derived keys whose rows conflict: the rows of the key that rank first
 * (winsOver: a row stored under its own key, then the later write) tie and give
 * different names, so the dashboards show that host NO name. Taken from
 * buildAliasIndex itself (a key it gives no name although a valid row has it),
 * so it is the dashboards' rule exactly. Only rows written outside the editor
 * can conflict: two rows cannot both be stored under the one derived key.
 */
export const conflictedKeys = (rows: ReadonlyArray<HostAliasRow>): Set<string> => {
    const index = buildAliasIndex(rows);
    const out = new Set<string>();
    rows.forEach((row) => {
        const clean = sanitizeAliasRow(row);
        const key = clean !== null ? keyOf(clean) : null;
        if (key !== null && !index.exact.has(key)) {
            out.add(key);
        }
    });
    return out;
};

/** The names the first-ranked rows of `key` give (the rows that tie), distinct
 *  and sorted: for a conflicted key, the names that disagree. */
const tiedAliases = (rows: ReadonlyArray<HostAliasRow>, key: string): string[] => {
    let top: HostAliasRow[] = [];
    rows.forEach((r) => {
        if (keyOf(r) !== key) {
            return;
        }
        if (top.length === 0 || winsOver(r, top[0])) {
            top = [r];
        } else if (!winsOver(top[0], r)) {
            top.push(r);
        }
    });
    return Array.from(new Set(top.map((r) => r.alias))).sort();
};

/**
 * The name the host value of `row` shows on the dashboards once `row` is
 * deleted, or null for none: resolveAlias over buildAliasIndex built from the
 * other rows (the rows not stored under the key `row` is stored under). Another
 * row of the same host, a short entry that covers a full name (rule c) or full
 * names that cover a short one (rule d) can still give it a name.
 */
export const nameAfterDelete = (rows: ReadonlyArray<HostAliasRow>, row: HostAliasRow): string | null => {
    const gone = storedKeyOf(row);
    return resolveAlias(buildAliasIndex(rows.filter((r) => storedKeyOf(r) !== gone)), row.match_value);
};

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

export type SortBy = 'alias' | 'host';

/** The rows shown: those whose name, host value or description holds `filter`
 *  (any letter case), by name then host (or host then name), natural order. */
export const listRows = (
    rows: ReadonlyArray<HostAliasRow>,
    filter: string,
    sortBy: SortBy,
    sortDir: number,
): HostAliasRow[] => {
    const q = filter.trim().toLowerCase();
    const list =
        q === ''
            ? rows.slice()
            : rows.filter(
                  (r) =>
                      r.alias.toLowerCase().indexOf(q) !== -1 ||
                      r.match_value.toLowerCase().indexOf(q) !== -1 ||
                      (r.description || '').toLowerCase().indexOf(q) !== -1,
              );
    const cmp = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
    list.sort((a, b) => {
        const first = sortBy === 'alias' ? cmp(a.alias, b.alias) : cmp(a.match_value, b.match_value);
        const second = sortBy === 'alias' ? cmp(a.match_value, b.match_value) : cmp(a.alias, b.alias);
        return (first || second) * sortDir;
    });
    return list;
};

/* ------------------------------------------------------------------ */
/* Add and edit                                                        */
/* ------------------------------------------------------------------ */

/** The form's error for a host value isAliasableValue refuses: every rule it
 *  applies (no IP address in the text: AppInspect reads the bundle). */
export const NOT_A_HOST_TEXT =
    'Not a host name or an IP address. A host name holds letters, digits, dots, hyphens and ' +
    'underscores, starts with a letter, a digit or an underscore, and has a letter or a digit in ' +
    'every part between dots (app01, app01.example.com); a value of only digits and dots must be ' +
    'an IPv4 address. An IP address is an IPv4 or IPv6 address, without brackets or a zone id. ' +
    'No URL, port, space, slash or placeholder such as (none).';

export const FORBIDDEN_TEXT = 'Holds a control character, a line break, a direction mark or an invisible character.';

/** The problem of an alias or a description, or null (the rules of sanitizeAliasRow). */
export const textProblem = (v: string, maxLen: number): string | null => {
    if (v.length > maxLen) {
        return `At most ${maxLen} characters (this has ${v.length}).`;
    }
    if (hasForbiddenChars(v)) {
        return FORBIDDEN_TEXT;
    }
    if (v.indexOf('<') !== -1 || v.indexOf('>') !== -1) {
        return 'Cannot hold < or >.';
    }
    return null;
};

export interface FormCheck {
    host: string | null;
    alias: string | null;
    description: string | null;
    /** The row to write: non-null only when every field is valid. */
    row: HostAliasRow | null;
    /** What the host value matches, once it is valid. */
    covers: string | null;
}

/** The inline checks of the add / edit form, field by field. */
export const checkForm = (hostIn: string, aliasIn: string, descIn: string): FormCheck => {
    const host = hostIn.trim();
    const alias = aliasIn.trim();
    const description = descIn.trim();
    let hostError: string | null = null;
    if (host === '') {
        hostError = 'Enter the host value as the data shows it: a host name, a short name or an IP address.';
    } else if (host.length > MAX_MATCH_LEN) {
        hostError = `At most ${MAX_MATCH_LEN} characters (this has ${host.length}).`;
    } else if (hasForbiddenChars(host)) {
        hostError = FORBIDDEN_TEXT;
    } else if (keyForMatchValue(host) === null) {
        hostError = NOT_A_HOST_TEXT;
    }
    let aliasError: string | null = null;
    if (alias === '') {
        aliasError = 'Enter the name to show.';
    } else {
        aliasError = textProblem(alias, MAX_ALIAS_LEN);
        if (aliasError === null && !hasVisibleChar(alias)) {
            aliasError = 'Needs at least one character that shows.';
        }
    }
    const descError = description === '' ? null : textProblem(description, MAX_DESC_LEN);
    let row: HostAliasRow | null = null;
    if (hostError === null && aliasError === null && descError === null) {
        row = sanitizeAliasRow({ match_value: host, alias, description });
        if (row === null) {
            hostError = 'This entry is not valid.';
        }
    }
    let covers: string | null = null;
    const key = hostError === null ? keyForMatchValue(host) : null;
    if (key !== null) {
        const dot = key.indexOf('.');
        if (parseIp(key) !== null) {
            covers = `Matches the IP address ${key} only.`;
        } else if (dot === -1) {
            covers =
                `Matches ${key} and its fully qualified names (${key}.example.com and the like), ` +
                'in any letter case.';
        } else {
            covers =
                `Matches ${key} in any letter case. The short name ${key.slice(0, dot)} gets this name ` +
                'too, unless another entry gives it a different one.';
        }
    }
    return { host: hostError, alias: aliasError, description: descError, row, covers };
};

/** What Save does with a valid form row. */
export type SavePlan =
    | { kind: 'unchanged' }
    | { kind: 'full'; message: string }
    | {
          kind: 'write';
          /** The row to write: the form's row, except that when the write replaces
           *  another row of the same host and the form's description is empty, it
           *  carries that row's description (as Import keeps a stored one). */
          row: HostAliasRow;
          /** Ask this first: another row already names the host (or its rows give
           *  it different names), or the write replaces a row of another host
           *  stored under its key. null: nothing to ask. */
          confirmText: string | null;
          /** After the write, delete the edited row stored under this key (the edit
           *  moved it to another key); null: delete nothing. */
          removeStoredKey: string | null;
      };

/**
 * Save of `row` (checkForm's row), `editing` the row being edited or null for an
 * add. The write goes to the host's derived key (`row._key`).
 *
 * Unchanged: an edit that changes nothing.
 *
 * Full: a write that adds a row - its key held by no stored row (an add of a
 * host no row names, an add of a host whose rows are all stored under other
 * keys, written outside this page, which stay, or an edit that writes the new
 * row before it removes the old one) - while isTableFull (storedTotal + 1 would
 * pass MAX_ROWS, or the read stopped at MAX_ROWS).
 *
 * Otherwise write, after a confirmation when:
 *  - another row already gives the host a name (`existing`, the one in effect
 *    among them, ranksBefore): it is replaced. When that row is stored under
 *    another key and the write adds a row, the question says so: the old row
 *    stays, as in planImport's rekeyed rows. When the host's rows conflict
 *    (conflictedKeys over the table's rows: the dashboards show it no name),
 *    the question names no one of them as its name: it lists the names the
 *    tied rows give and says that the write, under the host's own key, is the
 *    one the dashboards then use, and that those rows stay. When the form's
 *    description is empty and the write lands on a row other than the edited
 *    one, the written row keeps `existing`'s description (no extra question);
 *  - a row of ANOTHER host, written outside this page, is stored under the key
 *    the write uses: batch_save replaces it whole, so that host loses the row.
 * An edit that changes the host's key then deletes the old row (removeStoredKey),
 * so the host never has no name in between.
 */
export const planSave = (row: HostAliasRow, editing: HostAliasRow | null, table: TableState): SavePlan => {
    const key = keyOf(row);
    const oldStoredKey = editing !== null ? storedKeyOf(editing) : null;
    if (
        editing !== null &&
        oldStoredKey === key &&
        editing.match_value === row.match_value &&
        editing.alias === row.alias &&
        (editing.description || '') === (row.description || '')
    ) {
        return { kind: 'unchanged' };
    }
    const others = table.rows.filter((r) => keyOf(r) === key && storedKeyOf(r) !== oldStoredKey);
    const existing = others.length > 0 ? effectiveRows(others).get(key) : undefined;
    // A row of another host stored under this key (written outside this page): the write replaces it.
    const displaced = table.rows.find(
        (r) => storedKeyOf(r) === key && keyOf(r) !== key && storedKeyOf(r) !== oldStoredKey,
    );
    // A write to a key no stored row holds adds a row (the edited row counts: an edit in place adds none).
    const addsRow = !table.rows.some((r) => storedKeyOf(r) === key);
    // An edit that moves the row to another key removes the old row after the write.
    const removeStoredKey = editing !== null && oldStoredKey !== null && oldStoredKey !== key ? oldStoredKey : null;
    if (addsRow && isTableFull(table)) {
        const held = table.complete ? fmtCount(storedTotal(table)) : `more than ${fmtCount(MAX_ROWS)}`;
        const base = `The table already holds ${held} rows, the most it can hold.`;
        let message = `${base} Delete a row before adding a host.`;
        if (editing !== null && removeStoredKey !== null) {
            message = isDeletableKey(removeStoredKey)
                ? `${base} Saving writes ${row.match_value} under its own key, a new row, before the entry for ` +
                  `${editing.match_value} is removed. Delete a row first.`
                : `${base} Saving writes ${row.match_value} under its own key, a new row, and the entry for ` +
                  `${editing.match_value} stays: its key cannot be deleted from this page. Delete a row first.`;
        } else if (existing !== undefined) {
            message =
                `${base} The host ${existing.match_value} has a row written outside this page: saving writes ` +
                'the name under its own key, a new row, and the old one stays. Delete a row first.';
        }
        return { kind: 'full', message };
    }
    const parts: string[] = [];
    // The host's rows tie and give different names, so the dashboards show none: name no one of them as its name.
    if (existing !== undefined && conflictedKeys(table.rows).has(key)) {
        // The edited row, when it is one of the host's rows, is removed after the write (said below): the others stay.
        const ownEdit = editing !== null && keyOf(editing) === key && removeStoredKey !== null;
        let stays = 'those rows stay';
        if (ownEdit) {
            stays = others.length === 1 ? 'its other row stays' : 'its other rows stay';
        }
        parts.push(
            `The host ${row.match_value} has rows written outside this page that give it different names ` +
                `(${tiedAliases(table.rows, key).join(' / ')}), so the dashboards use none of them. Saving writes the ` +
                `name "${row.alias}" under the host's own key, which the dashboards then use, while ${stays}. Save it?`,
        );
    } else if (existing !== undefined) {
        parts.push(
            `The host ${existing.match_value} already has the name "${existing.alias}". ` +
                `Replace it with "${row.alias}"?`,
        );
        if (addsRow && existing.stored_key !== undefined) {
            parts.push(
                "The new name is written under the host's own key, a new row, and the row written outside " +
                    'this page stays.',
            );
        }
    }
    if (displaced !== undefined) {
        const what =
            `the entry for ${displaced.match_value}, named "${displaced.alias}", which was written outside this ` +
            `page under the key ${key}`;
        parts.push(
            existing === undefined
                ? `Saving ${row.match_value} replaces ${what}. Replace it?`
                : `Saving also replaces ${what}.`,
        );
    }
    // Said only when the old row is removed (an edit under the same key removes nothing).
    if (parts.length > 0 && editing !== null && removeStoredKey !== null) {
        parts.push(`The entry for ${editing.match_value} is then removed.`);
    }
    // The description of the row replaced, when the form leaves it empty: the write lands on a row other than
    // the edited one (an add, or an edit that moves the row), so an empty form field is no choice to clear it.
    const keepDescription =
        existing !== undefined &&
        (editing === null || oldStoredKey !== key) &&
        (row.description || '') === '' &&
        (existing.description || '') !== '';
    const toWrite: HostAliasRow = keepDescription ? { ...row, description: existing.description } : row;
    return { kind: 'write', row: toWrite, confirmText: parts.length > 0 ? parts.join(' ') : null, removeStoredKey };
};

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/** Why a pasted text cannot be previewed, or null. */
export const importTextProblem = (text: string): string | null => {
    if (text.length > MAX_IMPORT_BYTES) {
        return 'The text is larger than 2 MB. Split it into smaller files.';
    }
    if (text.trim() === '') {
        return 'Choose a CSV file or paste its text first.';
    }
    return null;
};

/** Why a chosen file is not read, or null. */
export const importFileProblem = (name: string, size: number): string | null =>
    size > MAX_IMPORT_BYTES ? `${name} is ${fmtSize(size)}; a file can be at most 2 MB.` : null;

/** A host whose name an import changes. */
export interface ImportRename {
    /** The host value as the file gives it (the value the row is written with). */
    host: string;
    /** The name the dashboards show for the host now; '' when its rows
     *  conflict (conflictAliases), as they then show none. */
    oldAlias: string;
    newAlias: string;
    /** Only for a host whose rows conflict (conflictedKeys): the names its tied
     *  rows give, sorted. */
    conflictAliases?: string[];
}

/** A row of ANOTHER host that an import's write replaces: written outside this
 *  page under the key of a host in the file, so batch_save replaces it whole. */
export interface ImportReplace {
    /** The host value as the file gives it (the row written under `key`). */
    host: string;
    newAlias: string;
    /** The key both rows are stored under: the file host's derived key. */
    key: string;
    /** The replaced row's host value and name. */
    oldHost: string;
    oldAlias: string;
}

export interface ImportPlan {
    /** The rows Import writes: the added and the changed ones, in file order. */
    toWrite: HostAliasRow[];
    /** Hosts added: written as a new row (not counting the ones in `replaced`). */
    added: number;
    /** Hosts whose name differs, or whose rows conflict (the dashboards show
     *  them no name, and the import gives them one). */
    renamed: number;
    /** Hosts whose name is the same but whose description differs. */
    describedOnly: number;
    unchanged: number;
    /** The rows added, in file order. */
    adds: HostAliasRow[];
    /** The hosts whose name changes, in file order. */
    renames: ImportRename[];
    /** Of the rows written for hosts already in the table, those whose row in
     *  effect is stored under a key its host value does not give (written outside
     *  the editor): each is written under the host's own key, a NEW row, and the
     *  old row stays (an import deletes nothing). Counted in the capacity check. */
    rekeyed: number;
    /** Of the rows written, those whose key holds a row of ANOTHER host, written
     *  outside the editor: the write replaces that row (and adds none), so that
     *  host loses it. Not in `added` or `rekeyed`; a changed host is counted under
     *  renamed or describedOnly as well. Import asks first (importConfirmText). */
    replaced: number;
    /** Those replaced rows, in file order. */
    replaces: ImportReplace[];
    /** Why nothing can be imported although the file is valid, or null. */
    capacityError: string | null;
}

/** "1 host", "2 hosts". */
const hostsText = (n: number): string => (n === 1 ? '1 host' : `${fmtCount(n)} hosts`);

/** "1 row", "2 rows". */
const rowsText = (n: number): string => (n === 1 ? '1 row' : `${fmtCount(n)} rows`);

/** The capacity errors' note on the rekeyed rows (ImportPlan.rekeyed). */
const rekeyedText = (n: number): string =>
    n === 1
        ? '1 host in the file has a row written outside this page: the import writes it under its own key, ' +
          'a new row, and the old one stays.'
        : `${fmtCount(n)} hosts in the file have a row written outside this page: the import writes each under ` +
          'its own key, a new row, and the old one stays.';

/** What planImport decides for one parsed row, before it counts. */
interface ImportStep {
    p: HostAliasRow;
    key: string;
    /** The row in effect for the host (effectiveRows), if any. */
    stored: HostAliasRow | undefined;
    /** add: no row names the host; rename / described: written as a change;
     *  unchanged: not written; rewrite: unchanged, but the row in effect is one
     *  another write of this import replaces, so the host is written under its
     *  own key to keep its name (counted as an add). */
    kind: 'add' | 'rename' | 'described' | 'unchanged' | 'rewrite';
    /** The row written (kinds other than unchanged). */
    write: HostAliasRow | null;
}

/**
 * Compare the parsed rows with the table. A host not in the table is added; a
 * host whose name differs, or whose file description is not empty and differs,
 * is changed (an empty description in the file keeps the stored one); a host
 * whose rows conflict (conflictedKeys: the dashboards show it no name) is
 * changed too, written under its own key; the rest are unchanged and not
 * written. Capacity: no new row after a read that stopped at MAX_ROWS, and the
 * stored rows (valid or not) plus the new rows at most MAX_ROWS. The new rows
 * are the adds and the rekeyed writes (ImportPlan.rekeyed).
 *
 * A write whose key holds a row of ANOTHER host (written outside the editor
 * under a key that is not its own) replaces that row: it is counted in
 * `replaced` and named in `replaces`, adds no row, and is no add. When that
 * replaced row is the row in effect of a host the file gives unchanged, the
 * host is written under its own key as well (an add), so it keeps its name; a
 * row that write replaces in turn is named, and not followed further.
 *
 * One known over-count, left as it is (it errs on the safe side and is rare): a
 * host's own key may be held by a stored row that sanitizeAliasRow refuses
 * (counted in TableState.invalidCount, not in its rows), while the row in effect
 * is a valid one under a foreign key. The write to the host's own key then
 * replaces that refused document and adds no row, yet the plan counts it as a
 * rekeyed new row, and the capacity message says a new row is written and the
 * old one stays.
 */
export const planImport = (parsedRows: ReadonlyArray<HostAliasRow>, table: TableState): ImportPlan => {
    const current = effectiveRows(table.rows);
    const conflicts = conflictedKeys(table.rows);
    /** The row stored under each key (KV keys are unique). */
    const storedUnder = new Map<string, HostAliasRow>();
    table.rows.forEach((r) => {
        storedUnder.set(storedKeyOf(r), r);
    });
    /** The row of another host a write under `key` replaces, if any. */
    const displacedBy = (key: string): HostAliasRow | undefined => {
        const holder = storedUnder.get(key);
        return holder !== undefined && keyOf(holder) !== key ? holder : undefined;
    };
    const plan: ImportPlan = {
        toWrite: [],
        added: 0,
        renamed: 0,
        describedOnly: 0,
        unchanged: 0,
        adds: [],
        renames: [],
        rekeyed: 0,
        replaced: 0,
        replaces: [],
        capacityError: null,
    };
    const steps: ImportStep[] = parsedRows.map((p) => {
        const key = keyOf(p);
        const stored = current.get(key);
        const fileDesc = p.description || '';
        if (stored === undefined) {
            const add: HostAliasRow = { _key: key, match_value: p.match_value, alias: p.alias, description: fileDesc };
            return { p, key, stored, kind: 'add', write: add };
        }
        const conflict = conflicts.has(key);
        // On a conflict the description of a row of the host that gives the file's name, if one does: of several,
        // the one ranksBefore takes first (effectiveRows), so the order the rows were read in does not choose it.
        const named = conflict ? effectiveRows(table.rows.filter((r) => keyOf(r) === key && r.alias === p.alias)) : null;
        const source = (named !== null ? named.get(key) : undefined) || stored;
        const storedDesc = source.description || '';
        const write: HostAliasRow = {
            _key: key,
            match_value: p.match_value,
            alias: p.alias,
            description: fileDesc !== '' ? fileDesc : storedDesc,
        };
        if (conflict || stored.alias !== p.alias) {
            return { p, key, stored, kind: 'rename', write };
        }
        if (fileDesc !== '' && fileDesc !== storedDesc) {
            return { p, key, stored, kind: 'described', write };
        }
        return { p, key, stored, kind: 'unchanged', write: null };
    });
    // The stored keys of the rows of other hosts the writes replace.
    const replacedKeys = new Set<string>();
    steps.forEach((s) => {
        const d = s.write !== null ? displacedBy(s.key) : undefined;
        if (d !== undefined) {
            replacedKeys.add(storedKeyOf(d));
        }
    });
    // A host the file gives unchanged whose row in effect one of those writes replaces: written under its own key.
    const settled: ImportStep[] = steps.map((s) => {
        if (s.kind !== 'unchanged' || s.stored === undefined || !replacedKeys.has(storedKeyOf(s.stored))) {
            return s;
        }
        const description = s.p.description || s.stored.description || '';
        const write: HostAliasRow = { _key: s.key, match_value: s.p.match_value, alias: s.p.alias, description };
        return { ...s, kind: 'rewrite', write };
    });
    settled.forEach(({ p, key, stored, kind, write }) => {
        if (kind === 'unchanged' || write === null) {
            plan.unchanged += 1;
            return;
        }
        plan.toWrite.push(write);
        const d = displacedBy(key);
        if (d !== undefined) {
            plan.replaced += 1;
            plan.replaces.push({
                host: p.match_value,
                newAlias: p.alias,
                key,
                oldHost: d.match_value,
                oldAlias: d.alias,
            });
        }
        if (kind === 'add' || kind === 'rewrite') {
            // A write under a key another host's row holds replaces that row: no new row, so no add.
            if (d === undefined) {
                plan.added += 1;
                plan.adds.push(write);
            }
            return;
        }
        if (kind === 'rename') {
            plan.renamed += 1;
            if (conflicts.has(key)) {
                const conflictAliases = tiedAliases(table.rows, key);
                plan.renames.push({ host: p.match_value, oldAlias: '', newAlias: p.alias, conflictAliases });
            } else {
                const oldAlias = stored !== undefined ? stored.alias : '';
                plan.renames.push({ host: p.match_value, oldAlias, newAlias: p.alias });
            }
        } else {
            plan.describedOnly += 1;
        }
        // The row in effect is stored under another key, so no row of this host is stored under this one: the
        // write adds a row, and the old one stays (unless a row of another host holds the key: then it is replaced).
        if (stored !== undefined && stored.stored_key !== undefined && d === undefined) {
            plan.rekeyed += 1;
        }
    });
    const held = storedTotal(table);
    const newRows = plan.added + plan.rekeyed;
    if (newRows > 0 && !table.complete) {
        plan.capacityError =
            plan.rekeyed === 0
                ? `The table already holds more than ${fmtCount(MAX_ROWS)} rows, so no host can be added. ` +
                  'Delete rows first; changes to hosts already in the table can be imported once the file adds none.'
                : `The table already holds more than ${fmtCount(MAX_ROWS)} rows, so no row can be added. ` +
                  `${rekeyedText(plan.rekeyed)} Delete rows first.`;
    } else if (held + newRows > MAX_ROWS) {
        const adds = plan.rekeyed === 0 ? hostsText(plan.added) : rowsText(newRows);
        const note = plan.rekeyed === 0 ? '' : ` ${rekeyedText(plan.rekeyed)}`;
        plan.capacityError =
            `The file adds ${adds} to the ${fmtCount(held)} rows stored in the table; ` +
            `the table holds at most ${fmtCount(MAX_ROWS)}.${note}`;
    }
    return plan;
};

/** True when Import stays off: no preview, a refused line, a capacity error or
 *  nothing to write. */
export const isImportBlocked = (parsed: AliasCsvResult | null, plan: ImportPlan | null): boolean =>
    parsed === null ||
    plan === null ||
    parsed.errors.length > 0 ||
    plan.capacityError !== null ||
    plan.toWrite.length === 0;

/** The preview's lines of the names an import changes: "host: old name -> new name";
 *  for a host whose rows conflict, "host: no name (its rows give A / B) -> new name". */
export const renameLines = (plan: ImportPlan): string[] =>
    plan.renames.map((r) =>
        r.conflictAliases !== undefined
            ? `${r.host}: no name (its rows give ${r.conflictAliases.join(' / ')}) -> ${r.newAlias}`
            : `${r.host}: ${r.oldAlias} -> ${r.newAlias}`,
    );

/** The preview's lines of the hosts an import adds: "host: name". */
export const addLines = (plan: ImportPlan): string[] => plan.adds.map((r) => `${r.match_value}: ${r.alias}`);

/** The preview's lines of the rows of other hosts an import replaces:
 *  "host: name, replacing other host: its name (key key)". */
export const replaceLines = (plan: ImportPlan): string[] =>
    plan.replaces.map((r) => `${r.host}: ${r.newAlias}, replacing ${r.oldHost}: ${r.oldAlias} (key ${r.key})`);

/** The first `max` lines, and how many are left out. */
export const firstLines = (lines: ReadonlyArray<string>, max = LISTED_ROWS): { lines: string[]; more: number } => ({
    lines: lines.slice(0, max),
    more: Math.max(0, lines.length - max),
});

/** The last line of a shortened list. */
export const moreText = (more: number): string => `and ${fmtCount(more)} more`;

/** The most replaced rows importConfirmText names before "and N more". */
const REPLACES_IN_QUESTION = 5;

/** The question's sentence on the rows of other hosts an import replaces, naming
 *  the first REPLACES_IN_QUESTION: "host (name), stored under the key key". */
const replacedText = (plan: ImportPlan): string => {
    const named = plan.replaces
        .slice(0, REPLACES_IN_QUESTION)
        .map((r) => `${r.oldHost} ("${r.oldAlias}"), stored under the key ${r.key}`);
    const more = plan.replaces.length - named.length;
    const list = `${named.join('; ')}${more > 0 ? `; ${moreText(more)}` : ''}`;
    return plan.replaced === 1
        ? `1 row written outside this page under the key of a host in the file is replaced: ${list}.`
        : `${fmtCount(plan.replaced)} rows written outside this page under the keys of hosts in the file are ` +
              `replaced: ${list}.`;
};

/** The question Import asks before it changes names or replaces rows of other
 *  hosts (ImportPlan.replaced, named), or null when it does neither. */
export const importConfirmText = (plan: ImportPlan): string | null => {
    const parts: string[] = [];
    if (plan.renamed > 0) {
        const what = plan.renamed === 1 ? '1 name will' : `${fmtCount(plan.renamed)} names will`;
        parts.push(`${what} change.`);
    }
    if (plan.replaced > 0) {
        parts.push(replacedText(plan));
    }
    return parts.length > 0 ? `${parts.join(' ')} This cannot be undone. Import?` : null;
};

/** A batch_save request that did not confirm all of its rows (hostAliasApi's
 *  HostAliasChunkFailure, by shape). */
export interface ChunkFailure {
    /** Index of the chunk's first row in the list written. */
    from: number;
    /** Index after its last row. */
    to: number;
    message: string;
}

/** One failed batch of an import, in words. */
export const describeFailure = (f: ChunkFailure, written: ReadonlyArray<HostAliasRow>): string => {
    const first = written[f.from];
    const last = written[f.to - 1];
    const span = first && last ? ` (${first.match_value} to ${last.match_value})` : '';
    return `Rows ${fmtCount(f.from + 1)}-${fmtCount(f.to)} of ${fmtCount(written.length)}${span}: ${f.message}`;
};
