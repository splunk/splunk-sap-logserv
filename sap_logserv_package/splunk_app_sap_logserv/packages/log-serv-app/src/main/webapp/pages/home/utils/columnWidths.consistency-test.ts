/**
 * Build-time consistency test: resizable table columns and the widths each browser remembers (build 404; the
 * drag start, the floor, the squeezed table and the quiet page size of build 406).
 *
 * Every DataTable's columns can be dragged wider or narrower. On a dashboard the dragged widths are kept in this
 * browser per user, per panel (utils/columnWidths.ts, one localStorage entry), and the panel header shows a "Reset
 * column widths" button while a table in it has any (components/FramedPanel.tsx). Tables off the dashboards (the AI
 * Assistant's results) keep their widths in memory only.
 *
 * What it pins:
 *  - W1 the storage key and the panel ids (dashboard id + panel title, whitespace collapsed, null without either);
 *  - W2 widths are whole pixels within 40..2000 (a drag's own floor from 16 up, build 406), anything else is refused;
 *  - W3 what is read from storage is validated: junk JSON, the wrong shapes, __proto__ / constructor / prototype keys,
 *    oversized keys, non-numbers and inherited properties are left out, and nothing read can pollute Object.prototype;
 *  - W4 the caps: 150 panels (the least recently changed go first), 64 columns a panel, 64 KB in all;
 *  - W5 setting a width drops the panel's widths of columns it no longer has; reset removes the panel;
 *  - W6 the store: one write after a burst of changes, the write merges with what another tab wrote meanwhile, an
 *    empty store removes the entry, a storage that throws or is missing is survived, listeners are told;
 *  - W7 width hints: '160px' is 160, anything not in px counts as no hint;
 *  - W8 the wiring in DataTable, FramedPanel, DashboardLayout and state/ColumnWidthsState (the automatic table layout,
 *    every heading with a width, the App's own sort span rather than the library's onSort, the reset button);
 *    Build 406: the W8 patterns read the source with its comments taken out (codeOf), so a pin cannot be met by a
 *    comment; the hooks' dependency lists are pinned;
 *  - W9 every dashboard table sits in a panel with a literal title, unique on its dashboard, so no two panels share
 *    the remembered widths; the AI Assistant's tables are not on a dashboard.
 */
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
declare const process: { stderr: { write(s: string): void }; exit(code: number): never };

const fs = require('fs');
const path = require('path');
const cw = require('./columnWidths');

const HOME = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail: string): void => {
    checks += 1;
    if (!ok) {
        failures += 1;
        process.stderr.write(`FAIL ${label}: ${detail}\n`);
    }
};
const show = (v: unknown): string => JSON.stringify(v);
const codeOf = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** A fake localStorage; `fail` makes the next calls throw. */
class FakeStorage {
    data: { [k: string]: string } = {};

    fail = false;

    sets = 0;

    getItem(k: string): string | null {
        if (this.fail) throw new Error('blocked');
        return Object.prototype.hasOwnProperty.call(this.data, k) ? this.data[k] : null;
    }

    setItem(k: string, v: string): void {
        if (this.fail) throw new Error('QuotaExceededError');
        this.sets += 1;
        this.data[k] = String(v);
    }

    removeItem(k: string): void {
        if (this.fail) throw new Error('blocked');
        delete this.data[k];
    }
}

// W1
check('W1 storage key per user', cw.storageKey('alice') === 'logserv.tableColumnWidths.v1.alice', cw.storageKey('alice'));
check('W1 storage key with no user', cw.storageKey('') === 'logserv.tableColumnWidths.v1.anonymous'
    && cw.storageKey(undefined) === 'logserv.tableColumnWidths.v1.anonymous', cw.storageKey(''));
check('W1 panel id', cw.panelIdFor('platform-host-details', '  Top   Hosts \n') === 'd:platform-host-details|Top Hosts',
    String(cw.panelIdFor('platform-host-details', '  Top   Hosts \n')));
check('W1 no panel id without a dashboard or a title',
    cw.panelIdFor(null, 'T') === null && cw.panelIdFor('', 'T') === null && cw.panelIdFor('d', undefined) === null
    && cw.panelIdFor('d', '   ') === null, 'expected null');
check('W1 an over-long panel id is refused', cw.panelIdFor('d', 'x'.repeat(300)) === null, 'expected null');

// W2
check('W2 clamp', cw.clampWidth(10) === 40 && cw.clampWidth(5000) === 2000 && cw.clampWidth(120.6) === 121
    && cw.clampWidth(40) === 40 && cw.clampWidth(2000) === 2000, show([cw.clampWidth(10), cw.clampWidth(5000)]));
check('W2 a floor of its own: from 16 up, never under 16, the default 40 for a floor that is no number',
    cw.clampWidth(10, 16) === 16 && cw.clampWidth(31.6, 16) === 32 && cw.clampWidth(5, 3) === 16 && cw.clampWidth(30, 32) === 32
    && cw.clampWidth(10, NaN) === 40 && cw.clampWidth(5000, 16) === 2000 && cw.clampWidth('30', 16) === null
    && cw.WIDTH_FLOOR === 16 && cw.WIDTH_MIN === 40 && cw.WIDTH_MAX === 2000,
    show([cw.clampWidth(10, 16), cw.clampWidth(31.6, 16), cw.clampWidth(5, 3), cw.clampWidth(30, 32), cw.clampWidth(10, NaN)]));
check('W2 a drag\'s floor: 40, or where the column is drawn when that is narrower (rounded down, never under 16)',
    cw.resizeFloor(120) === 40 && cw.resizeFloor(40) === 40 && cw.resizeFloor(39.9) === 39 && cw.resizeFloor(27.5) === 27
    && cw.resizeFloor(32) === 32 && cw.resizeFloor(3) === 16 && cw.resizeFloor(NaN) === 40 && cw.resizeFloor(undefined) === 40
    && cw.resizeFloor('30') === 40 && cw.resizeFloor(-5) === 16,
    show([cw.resizeFloor(120), cw.resizeFloor(39.9), cw.resizeFloor(27.5), cw.resizeFloor(3), cw.resizeFloor(NaN)]));
check('W2 non-numbers refused', cw.clampWidth(NaN) === null && cw.clampWidth(Infinity) === null
    && cw.clampWidth('120') === null && cw.clampWidth(null) === null && cw.clampWidth(undefined) === null, 'expected null');

// W3
const emptyKeys = (s: any): number => Object.keys(s.p).length;
check('W3 junk reads as empty', ['', 'nope', '[]', 'null', '{"p":[]}', '{"p":5}', '{}', '{"p":{"a":[1]}}']
    .every((raw) => emptyKeys(cw.parseStore(raw)) === 0) && emptyKeys(cw.parseStore(null)) === 0, 'junk accepted');
const protoRaw = '{"p":{"__proto__":{"w":{"x":100},"t":1},"constructor":{"w":{"x":100},"t":1},'
    + '"d:a|b":{"w":{"__proto__":120,"prototype":120,"ok":130},"t":5}}}';
const parsed = cw.parseStore(protoRaw);
check('W3 __proto__ / constructor / prototype keys are left out',
    show(Object.keys(parsed.p)) === show(['d:a|b']) && show(Object.keys(parsed.p['d:a|b'].w)) === show(['ok']),
    show(parsed));
check('W3 nothing read reaches Object.prototype', ({} as any).w === undefined && ({} as any).x === undefined
    && ({} as any).ok === undefined, 'prototype polluted');
const mixed = cw.parseStore(JSON.stringify({ p: { 'd:a|b': { w: { a: '120', b: 9, c: 99999, d: null, e: 77.4 }, t: 'x' },
    ['k'.repeat(300)]: { w: { a: 100 }, t: 1 }, 'd:c|d': { w: { ['c'.repeat(129)]: 100 }, t: 1 } } }));
check('W3 values clamped, strings and nulls dropped, bad times read as 0',
    show(mixed.p['d:a|b']) === show({ w: { b: 16, c: 2000, e: 77 }, t: 0 }), show(mixed.p['d:a|b']));
check('W3 a stored width under 40 is kept (a column that was already drawn narrower), a panel with no widths object is left out',
    show(cw.parseStore('{"p":{"d:a|b":{"w":{"x":28},"t":3},"d:c|d":{"t":5},"d:e|f":{"w":null,"t":5},"d:g|h":{"w":{},"t":5}}}').p)
    === show({ 'd:a|b': { w: { x: 28 }, t: 3 } }), 'parseStore');
check('W3 over-long panel ids and column keys dropped (and a panel left with none)', show(Object.keys(mixed.p)) === show(['d:a|b']),
    show(Object.keys(mixed.p)));
const manyCols: { [k: string]: number } = {};
for (let i = 0; i < 80; i += 1) manyCols[`c${i}`] = 100;
check('W3 at most 64 columns read a panel',
    Object.keys(cw.parseStore(JSON.stringify({ p: { 'd:a|b': { w: manyCols, t: 1 } } })).p['d:a|b'].w).length === 64,
    'cap not applied');

// W4
let big: any = { p: {} };
for (let i = 0; i < 160; i += 1) big.p[`d:x|p${i}`] = { w: { a: 100 }, t: i };
big = cw.enforceCaps(big);
const kept = Object.keys(big.p);
check('W4 at most 150 panels, the least recently changed go', kept.length === 150 && kept.indexOf('d:x|p0') === -1
    && kept.indexOf('d:x|p9') === -1 && kept.indexOf('d:x|p10') !== -1 && kept.indexOf('d:x|p159') !== -1,
    show([kept.length, kept.slice(-3)]));
let wide: any = { p: {} };
for (let i = 0; i < 150; i += 1) {
    const w: { [k: string]: number } = {};
    for (let j = 0; j < 60; j += 1) w[`column_${j}_${'z'.repeat(20)}`] = 100 + j;
    wide.p[`d:x|panel ${i}`] = { w, t: 1000 + i };
}
wide = cw.enforceCaps(wide);
check('W4 at most 64 KB in all, the oldest panels go first', JSON.stringify(wide).length <= cw.MAX_BYTES
    && Object.keys(wide.p).length > 0 && Object.prototype.hasOwnProperty.call(wide.p, 'd:x|panel 149')
    && !Object.prototype.hasOwnProperty.call(wide.p, 'd:x|panel 0'), show([JSON.stringify(wide).length, Object.keys(wide.p).length]));

// W5
const base = cw.parseStore(JSON.stringify({ p: { 'd:a|b': { w: { gone: 100, host: 150 }, t: 1 }, 'd:a|c': { w: { x: 90 }, t: 2 } } }));
const set1 = cw.withWidth(base, 'd:a|b', 'sid', 210.4, 50, ['host', 'sid']);
check('W5 a set drops the panel\'s stale columns and keeps the others', show(set1.p['d:a|b']) === show({ w: { host: 150, sid: 210 }, t: 50 })
    && show(set1.p['d:a|c']) === show({ w: { x: 90 }, t: 2 }), show(set1));
check('W5 the stored copy is not changed in place', show(base.p['d:a|b'].w) === show({ gone: 100, host: 150 }), show(base.p['d:a|b']));
check('W5 an unchanged width or a bad key changes nothing', cw.withWidth(set1, 'd:a|b', 'sid', 210, 99, ['host', 'sid']) === set1
    && cw.withWidth(set1, 'd:a|b', '__proto__', 100, 99, ['__proto__']) === set1
    && cw.withWidth(set1, 'd:a|b', 'sid', NaN, 99, ['sid']) === set1, 'expected the same store');
check('W5 widths are read only for the columns a table has now', show(cw.panelWidths(set1, 'd:a|b', ['sid', 'other'])) === show({ sid: 210 })
    && show(cw.panelWidths(set1, null, ['sid'])) === show({}), show(cw.panelWidths(set1, 'd:a|b', ['sid', 'other'])));
check('W5 reset removes the panel only', show(Object.keys(cw.withoutPanel(set1, 'd:a|b').p)) === show(['d:a|c']), 'reset wrong');

// W6
const KEY = cw.storageKey('alice');
const disk = new FakeStorage();
let t = 1000;
const store = new cw.ColumnWidthStore(disk, KEY, () => t);
let told = 0;
const unsubscribe = store.subscribe(() => { told += 1; });
store.set('d:a|b', 'host', 150, ['host', 'sid']);
store.set('d:a|b', 'host', 151, ['host', 'sid']);
store.set('d:a|b', 'host', 152, ['host', 'sid']);
check('W6 a burst of changes is not written at once', disk.sets === 0 && told === 3, show([disk.sets, told]));
// another tab writes a different panel meanwhile
disk.setItem(KEY, JSON.stringify({ p: { 'd:z|other': { w: { q: 300 }, t: 900 } } }));
disk.sets = 0;
check('W6 one write when flushed', store.flush() === true && disk.sets === 1, show(disk.sets));
const onDisk = cw.parseStore(disk.data[KEY]);
check('W6 the write keeps the other tab\'s panel and this tab\'s change', show(onDisk.p['d:a|b']) === show({ w: { host: 152 }, t: 1000 })
    && show(onDisk.p['d:z|other']) === show({ w: { q: 300 }, t: 900 }), show(onDisk));
check('W6 this tab keeps its own widths: another tab\'s panel shows on the next load, and nothing is announced',
    show(store.get('d:a|b', ['host', 'sid'])) === show({ host: 152 }) && show(store.get('d:z|other', ['q'])) === show({})
    && store.has('d:a|b', ['host']) && !store.has('d:a|b', ['sid']) && told === 3, show([store.get('d:z|other', ['q']), told]));
t = 1100;
store.reset('d:a|b');
store.reset('d:a|b');
check('W6 a reset tells the listeners once and keeps the other tab\'s panel', told === 4 && store.flush() === true
    && show(Object.keys(cw.parseStore(disk.data[KEY]).p)) === show(['d:z|other']), show([told, disk.data[KEY]]));
const reloaded = new cw.ColumnWidthStore(disk, KEY, () => t);
check('W6 a new page reads the other tab\'s panel', show(reloaded.get('d:z|other', ['q'])) === show({ q: 300 }), 'not read');
reloaded.reset('d:z|other');
reloaded.flush();
check('W6 an empty store removes the entry', !Object.prototype.hasOwnProperty.call(disk.data, KEY), show(disk.data));
unsubscribe();
store.set('d:a|b', 'sid', 99, ['sid']);
check('W6 an unsubscribed listener is not told', told === 4, show(told));
store.flush();
// a write clears the set of changed panels: a later write for another panel leaves alone a panel another tab changed since
disk.setItem(KEY, JSON.stringify({ p: { 'd:a|b': { w: { sid: 400 }, t: 1001 } } }));
store.set('d:a|c', 'x', 90, ['x']);
store.flush();
const afterDirty = cw.parseStore(disk.data[KEY]);
check('W6 a write replaces only the panels changed since the last write',
    show(afterDirty.p['d:a|b'].w) === show({ sid: 400 }) && show(afterDirty.p['d:a|c'].w) === show({ x: 90 }), show(afterDirty));
disk.fail = true;
const nothingPending = store.flush();
store.set('d:a|b', 'sid', 77, ['sid']);
check('W6 a storage that throws is survived', nothingPending === true && store.flush() === false
    && show(store.get('d:a|b', ['sid'])) === show({ sid: 77 }) && show(store.get('d:a|c', ['x'])) === show({ x: 90 }),
    show([store.get('d:a|b', ['sid']), store.get('d:a|c', ['x'])]));
const blocked = new cw.ColumnWidthStore(disk, KEY);
blocked.set('d:a|b', 'sid', 120, ['sid']);
check('W6 a store read from a storage that throws starts empty and still works', show(blocked.get('d:a|b', ['sid'])) === show({ sid: 120 })
    && blocked.flush() === false, show(blocked.get('d:a|b', ['sid'])));
blocked.set('d:a|c', 'x', 60, ['x']);
blocked.flush();
check('W6 with a storage that throws, a later write keeps the other panels\' widths in memory',
    show(blocked.get('d:a|b', ['sid'])) === show({ sid: 120 }) && show(blocked.get('d:a|c', ['x'])) === show({ x: 60 }),
    show(blocked.get('d:a|b', ['sid'])));
disk.fail = false;
const none = new cw.ColumnWidthStore(null, KEY);
none.set('d:a|b', 'sid', 130, ['sid']);
none.flush();
none.set('d:a|c', 'x', 70, ['x']);
check('W6 no storage at all: widths still work in memory, across writes', show(none.get('d:a|b', ['sid'])) === show({ sid: 130 })
    && none.flush() === false && show(none.get('d:a|b', ['sid'])) === show({ sid: 130 })
    && show(none.get('d:a|c', ['x'])) === show({ x: 70 }), 'no-storage store lost a width');
const loud = new cw.ColumnWidthStore(new FakeStorage(), KEY);
let after = 0;
loud.subscribe(() => { throw new Error('listener'); });
loud.subscribe(() => { after += 1; });
loud.set('d:a|b', 'x', 100, ['x']);
loud.flush();
check('W6 a listener that throws does not stop the others', after === 1, show(after));
// the caps hold at a write: another tab holds 150 panels, this tab adds one
const full = new FakeStorage();
const fullStore: { [k: string]: any } = { p: {} };
for (let i = 0; i < 150; i += 1) fullStore.p[`d:x|p${i}`] = { w: { a: 100 }, t: 1000 + i };
const capped = new cw.ColumnWidthStore(full, KEY, () => 5000);
full.setItem(KEY, JSON.stringify(fullStore));
capped.set('d:new|n', 'a', 120, ['a']);
capped.flush();
const cappedDisk = cw.parseStore(full.data[KEY]);
check('W6 the caps hold when merging with another tab\'s panels', Object.keys(cappedDisk.p).length === 150
    && !!cappedDisk.p['d:new|n'] && !!cappedDisk.p['d:x|p149'] && !cappedDisk.p['d:x|p0'], show(Object.keys(cappedDisk.p).length));
// the debounce, on a fake clock (the store looks setTimeout up each time it calls it)
const g: any = (Function('return this'))();
const realSetTimeout = g.setTimeout;
const realClearTimeout = g.clearTimeout;
let now = 0;
let nextId = 1;
let timers: { id: number; at: number; fn: () => void }[] = [];
try {
    g.setTimeout = (fn: () => void, ms: number) => {
        const id = nextId;
        nextId += 1;
        timers.push({ id, at: now + ms, fn });
        return id;
    };
    g.clearTimeout = (id: number) => {
        timers = timers.filter((x) => x.id !== id);
    };
    const advance = (ms: number): void => {
        now += ms;
        timers.filter((x) => x.at <= now).sort((x, y) => x.at - y.at).forEach((x) => {
            timers = timers.filter((y) => y.id !== x.id);
            x.fn();
        });
    };
    const slow = new FakeStorage();
    const deb = new cw.ColumnWidthStore(slow, KEY, () => 1);
    deb.set('d:a|b', 'h', 100, ['h']);
    advance(50);
    deb.set('d:a|b', 'h', 110, ['h']);
    advance(50);
    deb.set('d:a|b', 'h', 120, ['h']);
    advance(cw.WRITE_DELAY_MS - 1);
    const before = slow.sets;
    advance(1);
    const at = slow.sets;
    advance(2000);
    check('W6 one write, WRITE_DELAY_MS after the last change', cw.WRITE_DELAY_MS === 300 && before === 0 && at === 1 && slow.sets === 1
        && timers.length === 0 && show(cw.parseStore(slow.data[KEY]).p['d:a|b'].w) === show({ h: 120 }), show([before, at, slow.sets]));
} finally {
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
}
check('W6 pick and compare', show(cw.pickWidths({ a: 1, b: 2 }, ['b', 'c'])) === show({ b: 2 })
    && cw.sameWidths({ a: 1, b: 2 }, { b: 2, a: 1 }) && !cw.sameWidths({ a: 1 }, { a: 2 }) && !cw.sameWidths({ a: 1 }, { a: 1, b: 2 }),
    'pick or compare wrong');
// a column keyed like an Object member (possible in the AI Assistant's result tables) reads as no width
const protoCols = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
const pickedProto = cw.pickWidths({}, protoCols);
const storedProto = cw.panelWidths(set1, 'd:a|b', protoCols);
check('W6 Object member names read as no width', protoCols.every((c) => pickedProto[c] === undefined && storedProto[c] === undefined)
    && Object.getPrototypeOf(pickedProto) === null && Object.getPrototypeOf(storedProto) === null
    && Object.getPrototypeOf(cw.panelWidths(set1, null, protoCols)) === null, 'an inherited member read as a width');
const ownProto = cw.withOwnWidth(cw.withOwnWidth({}, 'constructor', 150), '__proto__', 120);
check('W6 Object member names hold a width of their own in memory', Object.getPrototypeOf(ownProto) === null
    && ownProto.constructor === 150 && Object.prototype.hasOwnProperty.call(ownProto, '__proto__')
    && cw.pickWidths(ownProto, ['constructor']).constructor === 150 && ({} as any).constructor === Object, show(Object.keys(ownProto)));
const protoStore = new cw.ColumnWidthStore(null, KEY);
protoStore.set('d:a|b', 'constructor', 140, ['__proto__', 'constructor']);
protoStore.set('d:a|b', '__proto__', 140, ['__proto__', 'constructor']);
const protoGot = protoStore.get('d:a|b', ['__proto__', 'constructor']);
check('W6 the store refuses Object member names as column names and reads them as no width', Object.keys(protoGot).length === 0
    && protoGot.constructor === undefined && Object.getPrototypeOf(protoGot) === null, show(Object.keys(protoGot)));

{
    const fs6 = new FakeStorage();
    const st6 = new cw.ColumnWidthStore(fs6, 'k6', () => 70);
    let told = 0;
    st6.subscribe(() => { told += 1; });
    st6.setMany('d:a|b', { host: 150, sid: 28, gone: 90, count: 5000 }, ['host', 'sid', 'count']);
    check('W6 several columns at once: one notification, each clamped to 16..2000, a column the panel lacks is dropped by the next set',
        told === 1 && show(st6.get('d:a|b', ['host', 'sid', 'count'])) === show({ host: 150, sid: 28, count: 2000 }),
        show([told, st6.get('d:a|b', ['host', 'sid', 'count', 'gone'])]));
    st6.setMany('d:a|b', { host: 150, sid: 28 }, ['host', 'sid', 'count']);
    check('W6 an unchanged set tells nobody', told === 1, String(told));
    st6.setMany('d:a|b', {}, ['host']);
    check('W6 an empty set changes nothing', told === 1 && show(st6.get('d:a|b', ['host'])) === show({ host: 150 }), String(told));
    check('W6 it is written once', st6.flush() === true && fs6.sets === 1
        && show(JSON.parse(fs6.data.k6).p['d:a|b'].w) === show({ host: 150, sid: 28, count: 2000 }), show(fs6.data));
}

// W7
check('W7 px hints', cw.hintPx('160px') === 160 && cw.hintPx(' 90px ') === 90 && cw.hintPx('20%') === undefined
    && cw.hintPx(undefined) === undefined && cw.hintPx('auto') === undefined, show([cw.hintPx('160px'), cw.hintPx('20%')]));

// W8
const dtCode = codeOf(read(path.join(HOME, 'components/DataTable.tsx')));
check('W8 the table keeps the automatic layout at full width',
    /const AUTO_TABLE_LAYOUT: React\.CSSProperties = \{ tableLayout: 'auto', width: '100%', minWidth: '100%' \};/.test(dtCode)
    && /<Table\s+headType="fixed"\s+stripeRows=\{false\}\s+onRequestResizeColumn=\{handleResizeColumn\}\s+tableStyle=\{AUTO_TABLE_LAYOUT\}\s*>/.test(dtCode)
    && (dtCode.match(/<Table[\s>]/g) || []).length === 1, 'the one Table must take onRequestResizeColumn and tableStyle');
check('W8 every heading has a DOM id unique on the page, a column id and a width (dragged, else the px hint, else auto)',
    /<Table\.HeadCell\s+key=\{col\.key\}\s+id=\{`\$\{headIdBase\}-h\$\{colIndex\}`\}\s+columnId=\{col\.key\}\s+width=\{widths\[col\.key\] \?\? hintPx\(col\.width\) \?\? 'auto'\}\s*>/.test(dtCode)
    && /const headIdBase = useId\(\);/.test(dtCode) && /\{columns\.map\(\(col, colIndex\) => \{/.test(dtCode),
    'HeadCell must take the unique id, columnId and the width chain');
check('W8 no library sort, fill layout or reordering (a drag ending in a heading would sort)',
    !/\bonSort=|resizableFillLayout|onRequestMoveColumn/.test(dtCode), 'found onSort / resizableFillLayout / onRequestMoveColumn');
check('W8 the App\'s own sort span is still the heading', /<SortableHeader[\s\S]{0,600}onClick=\{\(\) => handleSort\(col\.key\)\}/.test(dtCode),
    'SortableHeader onClick handleSort must stay');
check('W8 a dragged width is kept only for a column the table has, less the noted shift, down to the noted floor',
    /if \(!col \|\| columnKeys\.indexOf\(col\) === -1\) \{\s*return;\s*\}\s*const fit = !!event && \(event as \{ type\?: string \}\)\.type === 'dblclick';\s*const noted = resizeStartRef\.current;\s*const start = !fit && noted && noted\.col === col \? noted : null;\s*const width = clampWidth\(data\.width - \(start \? start\.shift : 0\), start \? start\.floor : undefined\);\s*if \(width === null\) \{\s*return;/.test(dtCode),
    'handleResizeColumn must check the column, take off the shift (not for a double-click fit) and clamp to the floor');
check('W8 a mouse press or an arrow key on a resize handle notes the start; nothing else does, and nothing while a mouse drag runs',
    /onMouseDownCapture=\{noteResizeStart\}\s*onKeyDownCapture=\{noteResizeStart\}/.test(dtCode)
    && /const noteResizeStart = \(e: React\.SyntheticEvent\): void => \{\s*if \(mouseDragRef\.current\) \{\s*return;\s*\}\s*const native = e\.nativeEvent as MouseEvent & KeyboardEvent;\s*const byMouse = e\.type === 'mousedown';\s*if \(byMouse \? native\.button !== 0 : native\.key !== 'ArrowLeft' && native\.key !== 'ArrowRight'\) \{\s*return;\s*\}\s*resizeStartRef\.current = null;/.test(dtCode)
    && /target\.closest\('\[data-test="resize"\]'\)/.test(dtCode) && /^const DRAWN_NARROWER_PX = 1;$/m.test(dtCode)
    && /const th = handle \? handle\.closest\('th'\) : null;/.test(dtCode)
    && /const ths = Array\.prototype\.slice\.call\(th\.parentElement\.children\) as Element\[\];\s*const col = columns\[ths\.indexOf\(th\)\];/.test(dtCode)
    && /const propOf = \(c: ColumnDef<TRow>\): number \| undefined =>\s*Object\.prototype\.hasOwnProperty\.call\(widths, c\.key\) \? widths\[c\.key\] : hintPx\(c\.width\);/.test(dtCode)
    && /const drawn = th\.getBoundingClientRect\(\)\.width;\s*const start: ResizeStart = \{ col: col\.key, shift: 0, floor: resizeFloor\(drawn\), others: null \};\s*resizeStartRef\.current = start;/.test(dtCode),
    'noteResizeStart wiring');
check('W8 a mouse drag is held from its press to the next mouse-up (or the window losing focus), and released on unmount',
    /if \(byMouse\) \{\s*mouseDragRef\.current = true;\s*const end = \(\): void => \{\s*mouseDragRef\.current = false;\s*endMouseDragRef\.current = null;\s*document\.removeEventListener\('mouseup', end, true\);\s*window\.removeEventListener\('blur', end\);\s*\};\s*endMouseDragRef\.current = end;\s*document\.addEventListener\('mouseup', end, true\);\s*window\.addEventListener\('blur', end\);\s*\}/.test(dtCode)
    && /useEffect\(\s*\(\) => \(\) => \{\s*if \(endMouseDragRef\.current\) \{\s*endMouseDragRef\.current\(\);\s*\}\s*\},\s*\[\],\s*\);/.test(dtCode),
    'mouse drag hold');
check('W8 an auto column, or one drawn at its width, takes no shift; with every other column auto the shift is how much narrower it is drawn',
    /const prop = propOf\(col\);\s*if \(prop === undefined\) \{\s*return;\s*\}\s*const narrower = prop - drawn;\s*if \(narrower <= DRAWN_NARROWER_PX\) \{\s*return;\s*\}\s*const othersAuto = columns\.every\(\(c\) => c === col \|\| propOf\(c\) === undefined\);\s*if \(othersAuto\) \{\s*start\.shift = narrower;\s*return;\s*\}/.test(dtCode),
    'othersAuto shift');
check('W8 with other widths: nothing while the column is drawn at 75% of its width or more; under that, every column with a width goes to its drawn width with the first step',
    /^const OVERSUBSCRIBED_RATIO = 0\.75;$/m.test(dtCode)
    && /if \(drawn >= prop \* OVERSUBSCRIBED_RATIO\) \{\s*return;\s*\}\s*const others: \{ \[key: string\]: number \} = Object\.create\(null\);\s*columns\.forEach\(\(c, i\) => \{\s*const p = propOf\(c\);\s*const el = ths\[i\];\s*if \(c === col \|\| p === undefined \|\| !el\) \{\s*return;\s*\}\s*const w = el\.getBoundingClientRect\(\)\.width;\s*if \(Math\.abs\(p - w\) > DRAWN_NARROWER_PX\) \{\s*const v = clampWidth\(w, resizeFloor\(w\)\);\s*if \(v !== null\) \{\s*others\[c\.key\] = v;\s*\}\s*\}\s*\}\);\s*start\.shift = narrower;\s*start\.others = others;/.test(dtCode)
    && /if \(start && start\.others\) \{\s*const others = start\.others;\s*Object\.keys\(others\)\.forEach\(\(k\) => \{\s*if \(columnKeys\.indexOf\(k\) !== -1\) \{\s*next\[k\] = others\[k\];\s*\}\s*\}\);\s*start\.others = null;\s*\}\s*next\[col\] = width;/.test(dtCode),
    'squeezed table');
check('W8 a drag on a dashboard panel is stored in one write, elsewhere kept in memory in a map without a prototype',
    /const next: \{ \[key: string\]: number \} = Object\.create\(null\);/.test(dtCode)
    && /noteColumnWidthChange\(\);\s*if \(panelId !== null\) \{\s*widthStore\.setMany\(panelId, next, columnKeys\);\s*\} else \{\s*setMemWidths\(\(prev\) => \{\s*let out = prev;\s*Object\.keys\(next\)\.forEach\(\(k\) => \{\s*if \(out\[k\] !== next\[k\]\) \{\s*out = withOwnWidth\(out, k, next\[k\]\);\s*\}\s*\}\);\s*return out;\s*\}\);\s*\}/.test(dtCode),
    'store write');
check('W8 no page size is re-fitted to a height change that follows a column width change, in any table',
    /const panelHeight = panelRoot\.clientHeight;\s*if \(lastMeasuredPanelHeightRef\.current > 0 && columnWidthsJustChanged\(\)\) \{\s*return;\s*\}/.test(dtCode)
    && /const resetWidths = useCallback\(\(\) => \{\s*noteColumnWidthChange\(\);/.test(dtCode)
    && (dtCode.match(/noteColumnWidthChange\(\)/g) || []).length === 2,
    'quiet page size');
check('W8 the hooks\' dependency lists',
    /\},\s*\[widthStore, panelId, columnKeys\],\s*\);\s*const resetWidths = useCallback\(/.test(dtCode)
    && /setMemWidths\(\{\}\);\s*\}, \[widthStore, panelId\]\);/.test(dtCode)
    && /return widthStore\.subscribe\(sync\);\s*\}, \[widthStore, panelId, columnKeys\]\);/.test(dtCode)
    && /return \(\) => widthReset\.set\(token, null\);\s*\}, \[widthReset, customized, resetWidths\]\);/.test(dtCode)
    && /const columnKeys = useMemo\(\(\) => \(columnKeySig === '' \? \[\] : columnKeySig\.split\('\\n'\)\), \[columnKeySig\]\);/.test(dtCode),
    'dependency lists');
check('W8 the panel id is the dashboard and the panel title', /const panelId = panelIdFor\(dashboardId, diagCtx\?\.title\);/.test(dtCode)
    && /const dashboardId = useContext\(DashboardIdContext\);/.test(dtCode), 'panelId wiring');
check('W8 widths: stored on a dashboard panel, in memory elsewhere',
    /const widths = panelId !== null \? storedWidths : pickWidths\(memWidths, columnKeys\);/.test(dtCode), 'widths wiring');
check('W8 the table registers its reset with its panel only while it has dragged widths',
    /widthReset\.set\(token, customized \? resetWidths : null\);\s*return \(\) => widthReset\.set\(token, null\);/.test(dtCode),
    'TableWidthResetContext wiring');
check('W8 a width change does not re-measure the page size (a re-measure ratcheted two tables in a row taller)',
    !/widthSig|REMEASURE_AFTER_RESIZE/.test(dtCode) && (dtCode.match(/lastMeasuredPanelHeightRef\.current = 0;/g) || []).length === 1,
    'only the first-data trampoline may reset the measured height');
check('W8 the reset registry is one stable object (a new one each change would loop a table with widths)',
    /useMemo<TableWidthReset>\([\s\S]*?\}\),\s*\[\],\s*\);/.test(codeOf(read(path.join(HOME, 'components/FramedPanel.tsx')))), 'tableWidthReset memo deps must be []');
check('W8 each table unsubscribes from the store', /sync\(\);\s*return widthStore\.subscribe\(sync\);/.test(dtCode), 'subscribe cleanup');
check('W8 an unchanged read leaves the widths state alone', /setStoredWidths\(\(prev\) => \(sameWidths\(prev, next\) \? prev : next\)\)/.test(dtCode), 'sameWidths guard');
check('W8 a table reads the stored widths of the columns it has, at mount and on every store change',
    /useState<\{ \[col: string\]: number \}>\(\(\) =>\s*widthStore\.get\(panelId, columnKeys\),\s*\);/.test(dtCode)
    && /const next = widthStore\.get\(panelId, columnKeys\);/.test(dtCode), 'store read');
check('W8 the reset button follows the widths', /const customized = Object\.keys\(widths\)\.length > 0;/.test(dtCode), 'customized');
check('W8 reset clears the in-memory widths too', /widthStore\.reset\(panelId\);\s*\}\s*setMemWidths\(\{\}\);/.test(dtCode), 'memWidths reset');
check('W8 each resize handle is named after its column', /const label = `Resize \$\{typeof col\.label === 'string' \? col\.label : col\.key\}`;/.test(dtCode)
    && /querySelector\('\[data-test="resize"\]'\)/.test(dtCode), 'aria-label patch');
check('W8 no inline width style on a heading any more (the library width replaces it)', !/style=\{col\.width/.test(dtCode), 'style width found');
const fp = codeOf(read(path.join(HOME, 'components/FramedPanel.tsx')));
check('W8 FramedPanel provides the reset registry around the panel',
    /<PanelFillContext\.Provider value=\{requestFill\}>\s*<TableWidthResetContext\.Provider value=\{tableWidthReset\}>\s*<Root/.test(fp)
    && /<\/Root>\s*<\/TableWidthResetContext\.Provider>\s*<\/PanelFillContext\.Provider>/.test(fp), 'provider placement');
check('W8 the reset button: only while a table has widths, named, and it does not reach the panel\'s own click',
    /widthResets\.length > 0 \? \(\s*<ResetWidthsBtn\s+type="button"\s+title="Reset column widths"\s+aria-label="Reset column widths"\s+onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);[\s\S]{0,800}?widthResets\.forEach\(\(entry\) => entry\.reset\(\)\);/.test(fp)
    && /actions \|\| showToolbar \|\| widthResetButton \?/.test(fp), 'reset button wiring');
check('W8 after a reset by Enter or Space only, focus moves to the panel\'s first resize handle, or to the panel itself when it has none (never to another button)',
    /const byKeyboard = e\.detail === 0 && document\.activeElement === btn;\s*const panel = btn\.closest\('section'\);\s*widthResets\.forEach\(\(entry\) => entry\.reset\(\)\);\s*if \(byKeyboard && panel\) \{\s*const handle = panel\.querySelector<HTMLElement>\('\[data-test="resize"\]'\);\s*if \(handle\) \{\s*handle\.focus\(\);/.test(fp)
    && /handle\.focus\(\);\s*\} else \{\s*if \(!panel\.hasAttribute\('tabindex'\)\) \{\s*panel\.setAttribute\('tabindex', '-1'\);\s*\}\s*panel\.focus\(\{ preventScroll: true \}\);\s*\}\s*\}\s*\}\}/.test(fp)
    && (fp.match(/\.focus\(/g) || []).length === 2
    && !/others\[0\]\.focus|querySelectorAll\('button/.test(fp), 'focus hand-off');
check('W8 the registry setter changes nothing when nothing changed',
    /if \(entry && entry\.reset === reset\) \{\s*return prev;/.test(fp) && /return entry \? prev\.filter\(\(e\) => e\.token !== token\) : prev;/.test(fp),
    'setter must return prev unchanged');
const dl = codeOf(read(path.join(HOME, 'components/DashboardLayout.tsx')));
check('W8 DashboardLayout provides the dashboard id to its panels',
    /<DashboardIdContext\.Provider value=\{dashboardId\}>\{children\}<\/DashboardIdContext\.Provider>/.test(dl)
    && /const dashboardId = dashboardIdFromPath\(location\.pathname\);/.test(dl), 'DashboardIdContext wiring');
const st = codeOf(read(path.join(HOME, 'state/ColumnWidthsState.ts')));
check('W8 one store per signed-in user', /new ColumnWidthStore\(browserStorage\(\), storageKey\(splunkUsername\)\)/.test(st)
    && /^import \{ username as splunkUsername \} from '@splunk\/splunk-utils\/config';$/m.test(st), 'store wiring');
check('W8 a pending write is made when the page is hidden or left',
    /window\.addEventListener\('pagehide', \(\) => \{\s*store\.flush\(\);/.test(st)
    && /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'hidden'\) \{\s*store\.flush\(\);/.test(st), 'pagehide / visibilitychange flush');
check('W8 one shared store for the page, made once',
    /^let shared: ColumnWidthStore \| null = null;$/m.test(st)
    && /export const sharedColumnWidthStore = \(\): ColumnWidthStore => \{\s*if \(shared === null\) \{\s*const store = new ColumnWidthStore\(/.test(st)
    && /shared = store;/.test(st) && /\}\s*return shared;\s*\};/.test(st) && (st.match(/new ColumnWidthStore\(/g) || []).length === 1, 'shared store');
check('W8 the quiet time after a width change is 400 ms, from the last change of any table',
    /^let lastWidthChangeMs = 0;$/m.test(st) && /^export const WIDTH_CHANGE_QUIET_MS = 400;$/m.test(st)
    && /export const noteColumnWidthChange = \(\): void => \{\s*lastWidthChangeMs = Date\.now\(\);\s*\};/.test(st)
    && /export const columnWidthsJustChanged = \(\): boolean => Date\.now\(\) - lastWidthChangeMs < WIDTH_CHANGE_QUIET_MS;/.test(st), 'quiet time');
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).reduce((acc: string[], d: any) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return acc.concat(walk(p));
    return /\.(ts|tsx)$/.test(d.name) && !/consistency-test/.test(d.name) ? acc.concat([p]) : acc;
}, []);
const rel = (p: string): string => path.relative(HOME, p).split(path.sep).join('/');
const ALL = walk(HOME);
const keyUsers = ALL.filter((p: string) => read(p).indexOf('tableColumnWidths') !== -1).map(rel);
check('W8 only utils/columnWidths.ts names the storage key', show(keyUsers) === show(['utils/columnWidths.ts']), show(keyUsers));
const storeUsers = ALL.filter((p: string) => /\b(ColumnWidthStore|sharedColumnWidthStore)\b/.test(codeOf(read(p)))).map(rel).sort();
check('W8 the store is used by DataTable and its state module only',
    show(storeUsers) === show(['components/DataTable.tsx', 'state/ColumnWidthsState.ts', 'utils/columnWidths.ts']), show(storeUsers));

// W9
const DASH = path.join(HOME, 'dashboards');
const problems: string[] = [];
let tables = 0;
fs.readdirSync(DASH).filter((f: string) => /\.tsx$/.test(f)).forEach((f: string) => {
    const s = read(path.join(DASH, f));
    const seen: { [title: string]: number } = {};
    let i = s.indexOf('<DataTable');
    while (i !== -1) {
        tables += 1;
        const open = Math.max(s.lastIndexOf('<FramedPanel', i), s.lastIndexOf('<ConditionalPanel', i));
        const m = open === -1 ? null : /\btitle="([^"]*)"/.exec(s.slice(open, i));
        if (!m) {
            problems.push(`${f}: a table at ${i} has no panel with a literal title`);
        } else if (seen[m[1]] !== undefined && seen[m[1]] !== open) {
            problems.push(`${f}: two panels titled "${m[1]}"`);
        } else {
            seen[m[1]] = open;
        }
        i = s.indexOf('<DataTable', i + 1);
    }
});
check('W9 every dashboard table is in a panel with a literal title, unique on its dashboard', problems.length === 0 && tables >= 90,
    show([tables, problems]));
const aiTableFiles = ALL.filter((p: string) => /<DataTable\b/.test(read(p)) && !/^dashboards\//.test(rel(p))
    && !/styled\.table/.test(read(p))).map(rel);
check('W9 the only tables off the dashboards are the AI Assistant\'s results', show(aiTableFiles) === show(['components/ai/chat/ToolResultPanel.tsx']),
    show(aiTableFiles));
const toolResultImporters = ALL.filter((p: string) => /from '[^']*\/ToolResultPanel'/.test(read(p))).map(rel);
check('W9 the AI result tables are rendered by the AI Assistant only (outside DashboardLayout, so in memory only)',
    toolResultImporters.length > 0 && toolResultImporters.every((f: string) => /^components\/ai\//.test(f)), show(toolResultImporters));

if (failures > 0) {
    process.stderr.write(`columnWidths.consistency-test: ${failures} of ${checks} checks FAILED\n`);
    process.exit(1);
}
// eslint-disable-next-line no-console
console.log(`columnWidths.consistency-test: ${checks} checks passed`);
