// Run: gjs -m tests/tasksources-check.js  (exit 1 on the first failure)
// Task sources for the Tasks tab: Local (ProductivityStore) and EDS (Google
// Tasks through the eds worker). The EDS side runs against a fake EdsClient
// with canned answers; no worker, no EDS, temp data dirs only.
import GLib from 'gi://GLib';
import System from 'system';
import { ProductivityStore } from '../src/helpers/productivity.js';
import { LocalTaskSource, EdsTaskSource, taskListChoices, taskListLabel } from '../src/helpers/tasksources.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        System.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const tmp = () => GLib.dir_make_tmp('nnx-tasksrc-XXXXXX');
const path = (d, f) => GLib.build_filenamev([d, f]);
const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);

// Let pending promise jobs and idle sources run.
const flush = () => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// A fake EdsClient: `answers[op]` is a value, an Error (rejects), or
// fn(args) returning either. Every call is recorded.
class FakeClient {
    constructor(answers = {}) {
        this.answers = answers;
        this.calls = [];
        this.resets = 0;
    }

    call(op, args = {}) {
        this.calls.push({ op, args });
        let a = this.answers[op];
        if (typeof a === 'function')
            a = a(args);
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? {});
    }

    reset() {
        this.resets++;
    }

    ops() {
        return this.calls.map(c => c.op);
    }
}

const gtask = (uid, summary, done = false, updated = 1000) => ({ uid, summary, done, due: null, notes: '', updated });

// ---- Step 1: a rejected create rolls back and reports ----
{
    let dir = tmp();
    let client = new FakeClient({ 'tasks.create': new Error('offline'), 'tasks.list': [] });
    let src = new EdsTaskSource(client, 'list-1', path(dir, 'gtask-stars.json'));
    let events = [];
    src.subscribe(ev => events.push(ev ?? null));
    let t = src.add('x');
    ok(!!t, 'add returns the new task');
    eq(src.open.map(x => x.text), ['x'], 'optimistic add shows x');
    eq(client.calls[0], { op: 'tasks.create', args: { source: 'list-1', summary: 'x' } }, 'create call');
    await src.settled();
    eq(src.open, [], 'rolled back after the rejection');
    eq(src.error, 'offline', 'error set');
    eq(src.errorOp, 'add', 'errorOp names the write');
    let failed = events.find(e => e?.failed);
    ok(failed, 'listeners hear about the failure');
    eq([failed.failed.op, failed.failed.text, failed.failed.reason], ['add', 'x', 'offline'], 'failure details');
    src.destroy();
}

// ---- Step 1: a star survives refresh (stars file in a temp dir) ----
{
    let dir = tmp();
    let stars = path(dir, 'gtask-stars.json');
    let client = new FakeClient({ 'tasks.list': [gtask('u1', 'one'), gtask('u2', 'two')] });
    let src = new EdsTaskSource(client, 'list-1', stars);
    await src.refresh();
    eq(src.open.map(x => [x.id, x.text, x.starred]), [['u1', 'one', false], ['u2', 'two', false]], 'listed');
    src.star('u2');
    eq(src.open.map(x => x.id), ['u2', 'u1'], 'starred first');
    eq(JSON.parse(read(stars)), ['u2'], 'stars file written');
    await src.refresh();
    ok(src.open.find(x => x.id === 'u2').starred, 'star survives refresh');
    src.destroy();
    // A new source (next login) reads it back.
    let again = new EdsTaskSource(client, 'list-1', stars);
    await again.refresh();
    ok(again.open.find(x => x.id === 'u2').starred, 'star read back from the file');
    ok(!again.open.find(x => x.id === 'u1').starred, 'other task not starred');
    again.star('u2');
    eq(JSON.parse(read(stars)), [], 'unstar saved');
    again.destroy();
}

// ---- add: a saved task takes the worker's uid; "!" stars it ----
{
    let dir = tmp();
    let stars = path(dir, 'gtask-stars.json');
    let client = new FakeClient({ 'tasks.create': { uid: 'new-1' }, 'tasks.list': [] });
    let src = new EdsTaskSource(client, 'list-1', stars);
    ok(src.add('   ') === null, 'blank add refused');
    ok(src.add('!') === null, 'bare ! refused');
    eq(client.calls.length, 0, 'nothing sent for blank adds');
    let t = src.add('!  call   the bank ');
    eq([t.text, t.starred], ['call the bank', true], 'normalized + starred');
    eq(client.calls[0].args.summary, 'call the bank', 'summary sent without the !');
    await src.settled();
    eq(src.open.map(x => [x.id, x.text, x.starred]), [['new-1', 'call the bank', true]], 'uid adopted, still starred');
    eq(JSON.parse(read(stars)), ['new-1'], 'star stored under the uid');
    eq(src.error, null, 'no error');
    src.destroy();
}

// ---- toggle / rename / remove: optimistic, rolled back on rejection ----
{
    let dir = tmp();
    let client = new FakeClient({
        'tasks.list': [gtask('a', 'alpha'), gtask('b', 'beta'), gtask('c', 'gamma', true, Date.now())],
        'tasks.update': new Error('Google said no'),
        'tasks.delete': new Error('Google said no'),
    });
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    await src.refresh();
    eq(src.done.map(x => x.id), ['c'], 'done list');
    eq(src.doneToday, 1, 'done today from updated time');

    src.toggle('a');
    eq(src.done.map(x => x.id).sort(), ['a', 'c'], 'optimistic toggle');
    eq(client.calls.at(-1), { op: 'tasks.update', args: { source: 'L', uid: 'a', patch: { done: true } } }, 'toggle call');
    await src.settled();
    eq(src.open.map(x => x.id), ['a', 'b'], 'toggle rolled back');
    eq(src.error, 'Google said no', 'toggle error');

    src.rename('b', '  better  beta ');
    eq(src.open.find(x => x.id === 'b').text, 'better beta', 'optimistic rename');
    eq(client.calls.at(-1).args, { source: 'L', uid: 'b', patch: { summary: 'better beta' } }, 'rename call');
    await src.settled();
    eq(src.open.find(x => x.id === 'b').text, 'beta', 'rename rolled back');

    src.remove('a');
    eq(src.open.map(x => x.id), ['b'], 'optimistic remove');
    await src.settled();
    eq(src.open.map(x => x.id), ['a', 'b'], 'remove rolled back in place');
    src.destroy();
}

// ---- Ruling 12: a timed-out write refreshes instead of rolling back ----
{
    let dir = tmp();
    let listed = [gtask('a', 'alpha')];
    let client = new FakeClient({
        'tasks.list': () => listed,
        'tasks.create': () => {
            // The worker did create it, just too late to answer.
            listed = [gtask('a', 'alpha'), gtask('late', 'slow one')];
            return new Error('Google sync: tasks.create timed out');
        },
    });
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    await src.refresh();
    let events = [];
    src.subscribe(ev => events.push(ev ?? null));
    let before = client.calls.length;
    src.add('slow one');
    await src.settled();
    eq(client.ops().slice(before), ['tasks.create', 'refresh', 'tasks.list'], 'timeout → refresh from the worker');
    eq(src.open.map(x => x.id), ['a', 'late'], 'list is what the worker has (no ghost, no loss)');
    ok(/timed out/.test(src.error), 'timeout error kept');
    ok(events.some(e => e?.failed?.op === 'add' && e.failed.timedOut), 'failure reported as timed out');
    src.destroy();
}

// ---- a worker that restarted/exited mid-write: unknown outcome too ----
for (let why of ['Google sync worker restarted', 'Google sync worker exited']) {
    let dir = tmp();
    let listed = [gtask('a', 'alpha')];
    let client = new FakeClient({
        'tasks.list': () => listed,
        'tasks.update': () => {
            listed = [gtask('a', 'alpha', true, Date.now())]; // it did go through
            return new Error(why);
        },
        'tasks.delete': new Error('Google said no'),
    });
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    await src.refresh();
    let events = [];
    src.subscribe(ev => events.push(ev ?? null));
    let before = client.calls.length;
    src.toggle('a');
    await src.settled();
    eq(client.ops().slice(before), ['tasks.update', 'refresh', 'tasks.list'], `${why} → refresh, not rollback`);
    eq(src.done.map(x => x.id), ['a'], `${why}: worker's state kept`);
    eq(src.error, why, `${why}: error kept`);
    ok(events.some(e => e?.failed?.op === 'toggle' && e.failed.timedOut), `${why}: reported as unknown outcome`);
    // An ordinary refusal still rolls back.
    before = client.calls.length;
    src.remove('a');
    await src.settled();
    eq(client.ops().slice(before), ['tasks.delete'], 'plain refusal: no re-list');
    eq(src.done.map(x => x.id), ['a'], 'plain refusal rolled back');
    src.destroy();
}

// ---- refresh: syncs then lists; failures set error; success clears it ----
{
    let dir = tmp();
    let fail = true;
    let client = new FakeClient({
        refresh: () => (fail ? new Error('no network') : {}),
        'tasks.list': [gtask('a', 'alpha')],
    });
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    await src.refresh();
    eq(src.error, 'no network', 'refresh error');
    eq(src.errorOp, 'refresh', 'errorOp refresh');
    eq(src.open.map(x => x.id), ['a'], 'still lists the cached items');
    fail = false;
    await src.refresh();
    eq([src.error, src.errorOp], [null, null], 'error cleared by a good refresh');
    eq(client.calls.filter(c => c.op === 'refresh')[0].args, { source: 'L' }, 'refresh args');
    src.destroy();
}

// ---- clearDone: deletes each done task; a failure re-lists ----
{
    let dir = tmp();
    let deleted = [];
    let client = new FakeClient({
        'tasks.list': [gtask('a', 'alpha'), gtask('d1', 'x', true), gtask('d2', 'y', true)],
        'tasks.delete': args => {
            deleted.push(args.uid);
            return args.uid === 'd2' ? new Error('nope') : {};
        },
    });
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    await src.refresh();
    src.clearDone();
    eq(src.done, [], 'optimistic clear');
    await src.settled();
    eq(deleted.sort(), ['d1', 'd2'], 'each done task deleted');
    eq(client.ops().slice(-2), ['refresh', 'tasks.list'], 'partial failure re-lists');
    eq(src.error, 'nope', 'clear error');
    src.destroy();
}

// ---- a destroyed source ignores late answers ----
{
    let dir = tmp();
    let release;
    let client = new FakeClient();
    client.call = (op, args) => {
        client.calls.push({ op, args });
        return op === 'tasks.create' ? new Promise((r, j) => (release = j)) : Promise.resolve([]);
    };
    let src = new EdsTaskSource(client, 'L', path(dir, 's.json'));
    let heard = 0;
    src.subscribe(() => heard++);
    src.add('x');
    let h = heard;
    src.destroy();
    release(new Error('late'));
    await flush();
    eq(heard, h, 'no notification after destroy');
}

// ---- LocalTaskSource wraps the store unchanged ----
{
    let dir = tmp();
    let store = new ProductivityStore({ dataDir: dir });
    await new Promise(r => {
        if (store.loaded)
            r();
        else
            store.subscribe(k => k === 'loaded' && r());
    });
    let src = new LocalTaskSource(store);
    let heard = 0;
    let off = src.subscribe(() => heard++);
    let t = src.add('!local one');
    ok(t && t.starred && t.text === 'local one', 'local add with !');
    src.add('local two');
    eq(src.open.map(x => x.text), ['local one', 'local two'], 'local open');
    src.toggle(src.open[1].id);
    eq(src.done.map(x => x.text), ['local two'], 'local toggle');
    eq(src.doneToday, 1, 'local doneToday');
    src.rename(t.id, 'renamed');
    src.star(t.id);
    eq([src.open[0].text, src.open[0].starred], ['renamed', false], 'local rename + star');
    src.clearDone();
    eq(src.done, [], 'local clear');
    src.remove(t.id);
    eq(src.open, [], 'local remove');
    ok(heard >= 7, `local changes notify (${heard})`);
    eq(src.error, null, 'local never errors');
    await src.refresh();
    off();
    let h = heard;
    store.addTask('after unsubscribe');
    eq(heard, h, 'unsubscribe works');
    src.destroy();
    store.destroy();
}

// ---- Ruling 13: the list picker ----
{
    let sources = [
        { uid: 's1', name: 'Inova Data', account: 'a@gmail.com', backend: 'gtasks', writable: true, color: null },
        { uid: 's2', name: 'Inova Data', account: 'b@gmail.com', backend: 'gtasks', writable: false, color: null },
        { uid: 's3', name: 'Personal', account: null, backend: 'local', writable: true, color: null },
        { uid: 's4', name: 'Read only', account: 'x', backend: 'caldav', writable: false, color: null },
    ];
    eq(taskListChoices(sources).map(c => [c.id, c.label]), [
        ['local', 'Local'],
        ['s1', 'Inova Data — a@gmail.com'],
        ['s2', 'Inova Data — b@gmail.com'],
        ['s3', 'Personal'],
    ], 'Local first; gtasks or writable; "<list> — <account>"');
    eq(taskListChoices(null).map(c => c.id), ['local'], 'no sources → Local only');
    eq(taskListLabel({ name: 'A', account: 'b' }), 'A — b', 'label');
}

print(`tasksources-check: ${n} checks passed`);
