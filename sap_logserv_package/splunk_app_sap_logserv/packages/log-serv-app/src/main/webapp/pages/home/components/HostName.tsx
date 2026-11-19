import React from 'react';
import styled from 'styled-components';
import { logservTheme } from '../styles/logservTheme';
import { useHostAlias } from '../state/HostAliasProvider';

/**
 * HostName.tsx - a host value shown with the customer's name for it (App build
 * 400).
 *
 * AliasedHost: ONE line, the name from Settings > Host Names in normal weight,
 * then the raw value in the muted text colour, read as one string: when it does
 * not fit, it is cut at its right end with an ellipsis (build 403), so the raw
 * value gives way first and the name only when the raw value is gone. The
 * tooltip of the whole line is "name - raw value", both in full (in a narrow
 * column the raw value may be cut to nothing on screen). Display only - a
 * click, a filter or a search built from the value must keep using the raw
 * value. Its users: DataTable, for a default cell of a column flagged
 * `hostAlias` that has a name, and Live Activity's partner cell in the topology
 * bottom panel. copyOnOneLine is the copy handler of the line and of a table
 * cell that holds one.
 *
 * HostName (the default export, <HostName value={row.host} />) looks the name up
 * itself and draws an AliasedHost, or the raw value as plain text when there is
 * no name. No code uses it in this build. The other surfaces that show a name
 * format it on their own: text built with the provider's label (subtitles, the
 * host lists), the Linux KPI card's own lookup, the topology side panel's
 * PaneHost and the partner nodes' partnerNameSlot.
 */

/* One line: the name, then the raw value, cut as ONE string at its right end
   (build 403; builds 400-402 cut the name first and kept the raw value). The
   line has two layers in one box:
   - the SIZER (SizeName, SizeRaw: hidden, aria-hidden) gives the line its size
     and nothing else. Its narrowest width is about one character for the name
     (it may break at any character, clamped to one line) plus the raw value on
     one line (capped at 16em), the same as builds 400-402, so a squeezed
     auto-layout table needs no more room for the column than its raw values on
     one line plus one character. Its widest is the whole name (no cap since
     build 403: builds 400-402 capped it at 12em in a table cell) plus the raw
     value (capped at 16em), so where the table has room a name longer than
     about 12em widens the column and the other columns get less. A raw value
     longer than 16em (about 30 characters) is cut even in a wide column, as in
     builds 400-402.
   - the TEXT (Shown) lies over it (absolute, the same box) and draws the name
     and then the raw value as one run of text on one line, which the browser
     cuts at its right end with one ellipsis: the raw value gives way first, and
     the name only once the raw value is gone. A single run is what keeps the
     ellipsis at the end: two boxes side by side either cut the name in the
     middle of the line or, where the second box is narrower than an ellipsis,
     show a sliver of its first letter.
   Measured in headless Edge with the real styles (testing/dev_scripts/
   hostname_layout_403/check_layout.py): the narrowest column is the same as
   build 402's. The ellipsis is drawn in the line's colour, not the muted one,
   also when the cut falls in the raw value (the browser draws it with the
   style of the box it cuts). Download PNG / PDF draw the TEXT layer cut by
   utils/exportCapture.ts (ellipsizeCutTextInClone, the data-export-line rule). */
const Line = styled.span`
    position: relative;
    display: inline-flex;
    align-items: baseline;
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    vertical-align: bottom;
`;

/* The sizer's name: breaks at any character and is clamped to one line, so its
   narrowest width is about one character and it never adds a line. */
const SizeName = styled.span`
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-all;
    font-weight: ${logservTheme.fontWeight.normal};
    visibility: hidden;
`;

/* The sizer's raw value: one line, capped at 16em, after the 6 px gap. */
const SizeRaw = styled.span`
    flex: 1 1 0%;
    min-width: 0;
    max-width: 16em;
    margin-left: 6px;
    overflow: hidden;
    white-space: nowrap;
    visibility: hidden;
`;

/* The text layer: the sizer's box, one line, cut at its right end. */
const Shown = styled.span`
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
`;

const ShownName = styled.span`
    font-weight: ${logservTheme.fontWeight.normal};
`;

/* The separator is text, so a copied cell reads "name - raw value" and a screen
   reader does not run the two together; on screen it is hidden (the usual
   visually-hidden rules, not display: none, which would drop it from copies and
   from the accessibility tree) and the gap is the raw value's margin. */
const Separator = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: pre;
`;

const ShownRaw = styled.span`
    margin-left: 6px;
    color: ${logservTheme.colors.textMuted};
`;

interface AliasedHostProps {
    /** The customer's name. */
    alias: string;
    /** The raw value, as the data has it. */
    raw: string;
}

/** True when (node, offset) is the very start of `cell`: offset 0 of the cell,
 *  or of a node reached from it through first children only. */
const isStartOf = (cell: Element | null, node: Node, offset: number): boolean => {
    if (cell === null || offset !== 0) {
        return false;
    }
    let n: Node = node;
    while (n !== cell) {
        const parent = n.parentNode;
        if (parent === null || parent.firstChild !== n) {
            return false;
        }
        n = parent;
    }
    return true;
};

/* The copy handler of the line, and of a table cell that holds one (DataTable and
   Live Activity attach it to the cell only when the cell shows a name). In builds
   400-402 a browser wrote each item of the line's flex row on a line of its own,
   so a plain copy read "name", " - ", "raw value" on three lines (measured in
   Edge); since build 403 the text layer is one run and copies as one line (the
   hidden sizer adds nothing, measured in Edge), and the handler stays for any
   line break a browser still adds, and for a selection that ends at the next
   cell (below). This handler runs
   only when the browser fires the copy event at the element it is attached to or
   at one inside it. It acts on one range that lies inside the enclosing table cell
   (the line itself outside a table) and writes the selected text without its line
   breaks; or on one range that starts inside the cell and ends at the very start
   of the next cell, and writes the text from the range's start to the end of this
   cell. Any other selection is left to the browser. When the event is fired inside
   the line in such a cell, the line's handler and the cell's both run and write
   the same text. */
export const copyOnOneLine = (e: React.ClipboardEvent<HTMLElement>): void => {
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (!selection || selection.rangeCount !== 1 || !e.clipboardData) {
        return;
    }
    const cell = e.currentTarget.closest('td');
    const box: HTMLElement = cell || e.currentTarget;
    const range = selection.getRangeAt(0);
    let text: string;
    if (box.contains(range.commonAncestorContainer)) {
        text = selection.toString();
    } else if (
        cell !== null &&
        cell.contains(range.startContainer) &&
        isStartOf(cell.nextElementSibling, range.endContainer, range.endOffset)
    ) {
        const inCell = range.cloneRange();
        inCell.setEnd(cell, cell.childNodes.length);
        text = inCell.toString();
    } else {
        return;
    }
    e.clipboardData.setData('text/plain', text.replace(/[\r\n]+/g, ''));
    e.preventDefault();
};

/** The name and the muted raw value on one line; the tooltip names both in full. */
export const AliasedHost: React.FC<AliasedHostProps> = ({ alias, raw }) => {
    // Both layers get the same trimmed texts: a space at the start of the raw value (or at the end of the name) is
    // kept inside the text layer's run but dropped by the sizer's own boxes, so the text would be one space wider
    // than its box and always cut. The tooltip keeps the values as given.
    const name = alias.trim();
    const value = raw.trim();
    return (
        <Line title={`${alias} - ${raw}`} onCopy={copyOnOneLine}>
            <SizeName aria-hidden="true">{name}</SizeName>
            <SizeRaw aria-hidden="true">{value}</SizeRaw>
            <Shown data-export-line="">
                <ShownName data-export-part="name">{name}</ShownName>
                <Separator>{' - '}</Separator>
                <ShownRaw data-export-part="raw">{value}</ShownRaw>
            </Shown>
        </Line>
    );
};

interface HostNameProps {
    /** A raw host value: a host name, a short name or an IP address. */
    value: unknown;
}

const textOf = (value: unknown): string => {
    if (typeof value === 'string') {
        return value;
    }
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
};

/** Not used by any surface in this build (see the header). */
const HostName: React.FC<HostNameProps> = ({ value }) => {
    const { resolve } = useHostAlias();
    const raw = textOf(value);
    const alias = resolve(value);
    return alias === null ? raw : <AliasedHost alias={alias} raw={raw} />;
};

export default HostName;
