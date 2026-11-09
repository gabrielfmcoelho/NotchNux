// Run: gjs -m tests/notes-check.js  (exit 1 on the first failure)
// Notes as a list of post-its + notes.md migration. Uses temp data dirs only.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ProductivityStore } from '../src/helpers/productivity.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const tmp = () => GLib.dir_make_tmp('nnx-notes-XXXXXX');
const path = (d, f) => GLib.build_filenamev([d, f]);
const exists = (d, f) => GLib.file_test(path(d, f), GLib.FileTest.EXISTS);
const put = (d, f, s) => GLib.file_set_contents(path(d, f), s);
const read = (d, f) => new TextDecoder().decode(GLib.file_get_contents(path(d, f))[1]);

function spin(ms) {
    let loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    loop.run();
}
function waitLoaded(store) {
    if (store.loaded)
        return;
    let loop = new GLib.MainLoop(null, false);
    let off = store.subscribe(k => { if (k === 'loaded') loop.quit(); });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
    loop.run();
    off();
    ok(store.loaded, 'store loaded');
}
function open(dir) {
    let s = new ProductivityStore({ dataDir: dir });
    waitLoaded(s);
    return s;
}

// ---- migration from notes.md ----
{
    let d = tmp();
    put(d, 'notes.md', 'hello');
    let s = open(d);
    eq(s.notes.length, 1, 'notes.md becomes one note');
    eq([s.notes[0].text, s.notes[0].color, s.notes[0].pinned, s.notes[0].pos], ['hello', 'yellow', false, null], 'migrated note shape');
    ok(exists(d, 'notes.md.bak'), 'notes.md.bak exists');
    ok(!exists(d, 'notes.md'), 'notes.md renamed');
    eq(read(d, 'notes.md.bak'), 'hello', 'bak keeps the text');
    ok(exists(d, 'notes.json'), 'notes.json written immediately');
    s.destroy();
    let s2 = open(d);
    eq(s2.notes.length, 1, 'second run: still one note');
    eq(s2.notes[0].text, 'hello', 'second run: same text');
    s2.destroy();
    // even if notes.md reappears, notes.json wins and nothing duplicates
    put(d, 'notes.md', 'again');
    let s3 = open(d);
    eq(s3.notes.length, 1, 'notes.json present: notes.md ignored');
    s3.destroy();
}
// empty notes.md: no note, still renamed
{
    let d = tmp();
    put(d, 'notes.md', '  \n ');
    let s = open(d);
    eq(s.notes.length, 0, 'empty notes.md gives no note');
    ok(exists(d, 'notes.md.bak') && !exists(d, 'notes.md'), 'empty notes.md still renamed');
    s.destroy();
}
// no files at all
{
    let d = tmp();
    let s = open(d);
    eq(s.notes.length, 0, 'fresh dir: empty');
    s.destroy();
}
// corrupt notes.json
{
    let d = tmp();
    put(d, 'notes.json', '{not json');
    let s = open(d);
    eq(s.notes.length, 0, 'corrupt notes.json gives empty list');
    ok(exists(d, 'notes.json.bak'), 'notes.json.bak exists');
    eq(read(d, 'notes.json.bak'), '{not json', 'bak holds the corrupt content');
    s.destroy();
}
// limits, add/remove/restore
{
    let d = tmp();
    let s = open(d);
    let events = 0;
    s.subscribe(k => { if (k === 'notes') events++; });
    for (let i = 0; i < 50; i++)
        s.addNote(`n${i}`);
    eq(s.notes.length, 50, '50 notes');
    let threw = '';
    try { s.addNote('x'); } catch (e) { threw = e.message; }
    eq(threw, 'TooManyNotes', 'the 51st throws TooManyNotes');
    eq(events, 50, 'one notes event per change');
    let id = s.notes[0].id;
    let text = s.getNote(id).text;
    let removed = s.removeNote(id);
    eq(s.notes.length, 49, 'removed');
    ok(!s.getNote(id), 'getNote gone');
    s.restoreNote(removed);
    eq([s.getNote(id)?.id, s.getNote(id)?.text], [id, text], 'restore gives back id and text');
    s.restoreNote(removed);
    eq(s.notes.length, 50, 'restore of a present id is a no-op');
    s.destroy();
}
// Undo past the cap must survive a reload (loading never drops valid notes)
{
    let d = tmp();
    let s = open(d);
    for (let i = 0; i < 50; i++)
        s.addNote(`n${i}`);
    let removed = s.removeNote(s.notes[0].id);
    s.addNote('replacement');
    s.restoreNote(removed);
    eq(s.notes.length, 51, 'restore ignores the cap');
    s.destroy();
    let s2 = open(d);
    eq(s2.notes.length, 51, 'reload keeps all 51');
    ok(!!s2.getNote(removed.id), 'restored id survives reload');
    s2.destroy();
}
// colors, ordering, updated semantics, clamping
{
    let d = tmp();
    let s = open(d);
    let a = s.addNote('a', 'bogus');
    eq(s.getNote(a).color, 'yellow', 'unknown color in addNote -> yellow');
    s.setNoteColor(a, 'nope');
    eq(s.getNote(a).color, 'yellow', 'unknown color in setNoteColor ignored');
    s.setNoteColor(a, 'purple');
    eq(s.getNote(a).color, 'purple', 'valid color applied');
    spin(15);
    let b = s.addNote('b', 'green');
    eq(s.notes.map(x => x.id), [b, a], 'most recently updated first');
    spin(15);
    s.updateNote(a, 'a2');
    eq(s.notes.map(x => x.id), [a, b], 'update moves it to the front');
    let u = s.getNote(a).updated;
    spin(15);
    s.updateNote(a, 'a2');
    eq(s.getNote(a).updated, u, 'unchanged text does not bump updated');
    s.pinNote(a, true);
    s.moveNote(a, 10.7, 20.2);
    eq([s.getNote(a).pinned, s.getNote(a).pos, s.getNote(a).updated], [true, { x: 11, y: 20 }, u], 'pin/move keep updated, integer pos');
    s.pinNote(a, false);
    eq(s.getNote(a).pinned, false, 'unpin');
    s.updateNote(a, 'x'.repeat(70 * 1024));
    eq(s.getNote(a).text.length, 64 * 1024, 'text cut to 64 KiB');
    // persistence (debounced)
    spin(900);
    let on = JSON.parse(read(d, 'notes.json'));
    eq(on.length, 2, 'notes.json saved');
    let mode = Gio.File.new_for_path(path(d, 'notes.json')).query_info('unix::mode', 0, null).get_attribute_uint32('unix::mode') & 0o777;
    eq(mode, 0o600, 'notes.json is 0600');
    s.destroy();
    let s2 = open(d);
    eq(s2.notes.map(x => x.id), [a, b], 'reload keeps order');
    eq(s2.getNote(b).color, 'green', 'reload keeps color');
    s2.destroy();
    ok(!exists(d, 'notes.md'), 'no notes.md created');
}

print(`notes-check: ${n} checks passed`);
