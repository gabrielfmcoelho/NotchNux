// Self-check for src/tools/eds-worker.js through src/helpers/eds.js.
// Run: tests/eds-check.sh — never directly. It creates a temporary local task
// list through SourceRegistry, so it only runs against the private registry
// that eds-check.sh starts (private bus and XDG dirs); otherwise it refuses.
// Exits non-zero on the first failure.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

let ECal, EDataServer;
try {
    ECal = (await import('gi://ECal?version=2.0')).default;
    EDataServer = (await import('gi://EDataServer?version=1.2')).default;
} catch (e) {
    print('SKIP: ECal not installed');
    System.exit(0);
}

const realConfig = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
if (GLib.getenv('NNX_EDS_PRIVATE') !== '1' || !GLib.getenv('XDG_CONFIG_HOME') ||
    GLib.getenv('XDG_CONFIG_HOME') === realConfig ||
    !(GLib.getenv('DBUS_SESSION_BUS_ADDRESS') ?? '').includes('/nnx-eds-')) {
    printerr('eds-check: refusing to run outside tests/eds-check.sh (it would write to your real calendars)');
    System.exit(2);
}

const { EdsClient } = await import('../src/helpers/eds.js');
const { run } = await import('../src/helpers/proc.js');
const WORKER = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('src').get_child('tools').get_child('eds-worker.js').get_path();

let n = 0;
function ok(cond, what) {
    if (!cond) {
        print(`FAIL: ${what}`);
        System.exit(1);
    }
    n++;
}

// A temporary local task list, removed at the end.
function makeSource(registry) {
    let source = EDataServer.Source.new(null, null);
    // Same parent as the built-in "Personal" list ("On This Computer").
    source.set_parent(registry.ref_builtin_task_list().get_parent());
    source.set_display_name(`nnx-test-${new Gio.Credentials().get_unix_pid()}`);
    source.get_extension(EDataServer.SOURCE_EXTENSION_TASK_LIST).set_backend_name('local');
    registry.commit_source_sync(source, null);
    // The registry exports it asynchronously; wait until it is listed.
    let uid = source.get_uid();
    let deadline = GLib.get_monotonic_time() + 10e6;
    while (!registry.ref_source(uid) && GLib.get_monotonic_time() < deadline) {
        if (!GLib.MainContext.default().iteration(false))
            GLib.usleep(50000);
    }
    if (!registry.ref_source(uid))
        throw new Error('the test list never appeared in the registry');
    return uid;
}

const CALENDAR_BUS_NAME = 'org.gnome.evolution.dataserver.Calendar8';
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => resolve() ?? GLib.SOURCE_REMOVE));

function hasOwner(name) {
    let [owned] = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'NameHasOwner', new GLib.Variant('(s)', [name]), null, Gio.DBusCallFlags.NONE, -1, null).deepUnpack();
    return owned;
}

async function waitOwner(want) {
    for (let i = 0; i < 100 && hasOwner(CALENDAR_BUS_NAME) !== want; i++)
        await sleep(100);
    return hasOwner(CALENDAR_BUS_NAME) === want;
}

// Kill the wrapper's calendar factory (and its backend subprocesses), start
// a new one, and record its PID so eds-check.sh's cleanup stops it.
async function restartFactory() {
    let pidfile = GLib.getenv('NNX_EDS_PIDFILE');
    let lines = new TextDecoder().decode(GLib.file_get_contents(pidfile)[1]).split('\n').filter(Boolean);
    let name = GLib.path_get_basename(GLib.getenv('NNX_EDS_FACTORY'));
    let pid = lines.filter(l => l.startsWith(`${name} `)).pop()?.split(' ')[1];
    ok(pid, 'factory PID known');
    await new Promise(resolve => run(['sh', '-c', 'kill $(pgrep -P "$0") "$0"', pid], {}, resolve));
    ok(await waitOwner(false), 'factory gone');
    let proc = Gio.Subprocess.new([GLib.getenv('NNX_EDS_FACTORY')],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    let out = Gio.File.new_for_path(pidfile).append_to(Gio.FileCreateFlags.NONE, null);
    out.write_all(new TextEncoder().encode(`${name} ${proc.get_identifier()}\n`), null);
    out.close(null);
    ok(await waitOwner(true), 'factory restarted');
}

async function main(client, uid) {
    let probe = await EdsClient.probe();
    ok(probe.available === true, `probe: ${JSON.stringify(probe)}`);

    ok((await client.call('hello')).ecal === true, 'hello → ecal');

    let { tasks, calendars } = await client.call('sources');
    ok(Array.isArray(calendars), 'sources has calendars');
    let mine = tasks.find(s => s.uid === uid);
    ok(mine && mine.backend === 'local' && mine.writable === true && mine.name.startsWith('nnx-test-'),
        `sources lists the test list: ${JSON.stringify(mine)}`);
    ok('color' in mine && 'account' in mine, 'Source has color and account');
    let birthdays = calendars.find(s => s.backend === 'contacts');
    ok(!birthdays || birthdays.writable === false, `contacts calendars are read-only: ${JSON.stringify(birthdays)}`);

    let created = await client.call('tasks.create', { source: uid, summary: 'buy milk', due: '2026-11-20' });
    ok(typeof created.uid === 'string' && created.uid, 'create returns a uid');

    let list = await client.call('tasks.list', { source: uid });
    let t = list.find(x => x.uid === created.uid);
    ok(t && t.done === false && t.summary === 'buy milk' && t.due === '2026-11-20',
        `list contains it, not done: ${JSON.stringify(t)}`);
    ok(t.notes === '' && typeof t.updated === 'number', 'notes and updated');

    ok(JSON.stringify(await client.call('tasks.update', { source: uid, uid: created.uid, patch: { done: true } })) === '{}',
        'update returns {}');
    t = (await client.call('tasks.list', { source: uid })).find(x => x.uid === created.uid);
    ok(t && t.done === true, `after update done: true: ${JSON.stringify(t)}`);

    await client.call('tasks.update', { source: uid, uid: created.uid,
        patch: { done: false, summary: 'buy oat milk', due: null, notes: 'two cartons' } });
    t = (await client.call('tasks.list', { source: uid })).find(x => x.uid === created.uid);
    ok(t && t.done === false && t.summary === 'buy oat milk' && t.due === null && t.notes === 'two cartons',
        `patch summary/due/notes, undone: ${JSON.stringify(t)}`);

    ok(JSON.stringify(await client.call('refresh', { source: uid })) === '{}', 'refresh returns {}');
    mine = (await client.call('sources')).tasks.find(s => s.uid === uid);
    ok(mine?.writable === true, 'still writable once connected (is_readonly)');

    // EDS dies under the worker: the cached client is dropped after the
    // failing call (or reconnects on its own), so a later call works again.
    await restartFactory();
    let first = await client.call('tasks.list', { source: uid }).then(l => l, e => e);
    let again = await client.call('tasks.list', { source: uid }).then(l => l, e => e);
    ok(Array.isArray(again) && again.some(x => x.uid === created.uid),
        `list works again after the factory restarted: first=${first} again=${again}`);

    ok(JSON.stringify(await client.call('tasks.delete', { source: uid, uid: created.uid })) === '{}',
        'delete returns {}');
    list = await client.call('tasks.list', { source: uid });
    ok(!list.some(x => x.uid === created.uid), 'after delete the uid is absent');

    let err = await client.call('no.such.op').then(() => null, e => e);
    ok(err && /unknown op/.test(err.message), `unknown op is rejected: ${err}`);
    err = await client.call('tasks.list', { source: 'no-such-source' }).then(() => null, e => e);
    ok(err, 'unknown source is rejected');

    // On stdin EOF the worker exits cleanly, even after using EDS (gjs used
    // to segfault at exit with EDS objects alive).
    let r = await new Promise(resolve => run(['sh', '-c',
        `printf '%s\\n' '{"id":1,"op":"sources"}' '{"id":2,"op":"tasks.list","args":{"source":"${uid}"}}' | gjs -m "$0"`,
        WORKER], { timeoutS: 60 }, resolve));
    ok(r.ok && r.out.split('\n').filter(Boolean).length === 2, `worker exits 0 on EOF: ${JSON.stringify(r)}`);
}

let registry = EDataServer.SourceRegistry.new_sync(null);
let uid = makeSource(registry);
let client = new EdsClient();
let status = 0;
// Top-level await, not loop.run(): gjs runs the main loop while the module
// awaits, and a nested loop inside module evaluation starves promise jobs.
try {
    await main(client, uid);
    print(`eds-check: ${n} checks passed`);
} catch (e) {
    print(`FAIL: ${e}\n${e.stack}`);
    status = 1;
} finally {
    client.destroy();
    try {
        registry.ref_source(uid)?.remove_sync(null);
    } catch (e) {
        printerr(`eds-check: could not remove the test list: ${e.message}`);
    }
}
// gjs segfaults at exit while EDS objects are alive (exit 139 would hide the
// result): drop them and collect first.
// Let the client's cancelled reads finish first, or GC meets their callbacks.
while (GLib.MainContext.default().iteration(false))
    ;
registry = null;
System.gc();
System.exit(status);
