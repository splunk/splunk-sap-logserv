/**
 * ABAP work process trace components (dev_w* lines): the letter that starts a
 * line (props.conf [sap:abap:workprocess] EXTRACT-wp_category) and its name
 * (EVAL-wp_category_name).
 *
 * Build 380: the names follow SAP's trace-component list (SAP Help "Trace
 * Components", SAP Note 112); O and V, which no public list names, are named
 * from their lines (program buffer / PXA setup, ABAP coverage analyzer).
 *
 * The Host Role Activity rollup stores the letter (metric abap_wp, so a later
 * change to a name cannot change a stored key). A panel that reads the rollup
 * gets no search-time fields, so it names the letter with the same case() the
 * sourcetype's EVAL uses; wpCategory.consistency-test holds the two equal.
 */

export const WP_CATEGORY_NAMES: ReadonlyArray<readonly [string, string]> = [
    ['A', 'A = ABAP Processor'],
    ['B', 'B = Database Interface'],
    ['C', 'C = Database (DBSL)'],
    ['D', 'D = Diag Processor'],
    ['E', 'E = Enqueue (Lock Mgmt)'],
    ['G', 'G = Language Support'],
    ['H', 'H = ICF (HTTP)'],
    ['I', 'I = IPC (Semaphores/Shm)'],
    ['J', 'J = VM Container'],
    ['L', 'L = Background (Batch)'],
    ['M', 'M = Task Handler'],
    ['N', 'N = Security (SNC/SSF)'],
    ['O', 'O = Program Buffer (PXA)'],
    ['P', 'P = Paging'],
    ['R', 'R = Rolling'],
    ['S', 'S = Spool / Print'],
    ['T', 'T = Debug System'],
    ['V', 'V = Coverage Analyzer'],
    ['W', 'W = WebGUI (ITS)'],
    ['X', 'X = Extended Memory'],
    ['Y', 'Y = Dynpro / Screen'],
];

/**
 * `eval <to>=case(<from>=="A", "A = ABAP Processor", ..., 1=1, <from> . " = Other")`:
 * props.conf's EVAL-wp_category_name as an SPL command, for rows that carry the
 * letter in `from`.
 */
export const wpCategoryNameEval = (from: string, to: string): string =>
    `eval ${to}=case(${WP_CATEGORY_NAMES.map(([k, v]) => `${from}=="${k}", "${v}"`).join(', ')}, 1=1, ${from} . " = Other")`;
