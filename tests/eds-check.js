// Self-check for src/tools/eds-worker.js through src/helpers/eds.js.
// Run: tests/eds-check.sh — never directly. It creates a temporary local task
// list through SourceRegistry, so it only runs against the private registry
// that eds-check.sh starts (private bus and XDG dirs); otherwise it refuses.
// Exits non-zero on the first failure.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

let ECal, EDataServer, ICalGLib;
try {
    ECal = (await import('gi://ECal?version=2.0')).default;
    EDataServer = (await import('gi://EDataServer?version=1.2')).default;
    ICalGLib = (await import('gi://ICalGLib?version=3.0')).default;
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

const { EdsClient, splitEventId } = await import('../src/helpers/eds.js');
const { run } = await import('../src/helpers/proc.js');
const WORKER = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('src').get_child('tools').get_child('eds-worker.js').get_path();

let n = 0;
// A failure throws, so the test sources are still removed (and exiting here
// with EDS objects alive would segfault).
function ok(cond, what) {
    if (!cond)
        throw new Error(what);
    n++;
}

// A temporary local task list (or calendar), removed at the end.
function makeSource(registry, kind = 'tasks') {
    let source = EDataServer.Source.new(null, null);
    let tasks = kind === 'tasks';
    // Same parent as the built-in "Personal" list ("On This Computer").
    source.set_parent((tasks ? registry.ref_builtin_task_list() : registry.ref_builtin_calendar()).get_parent());
    source.set_display_name(`nnx-test-${new Gio.Credentials().get_unix_pid()}`);
    source.get_extension(tasks ? EDataServer.SOURCE_EXTENSION_TASK_LIST : EDataServer.SOURCE_EXTENSION_CALENDAR)
        .set_backend_name('local');
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

// ---- Calendar events (Task 4) -------------------------------------------

const pad2 = v => String(v).padStart(2, '0');
// 'YYYY-MM-DDTHH:MM:SS±HH:MM' in this machine's zone, as the notch sends it.
function localIso(d) {
    let off = -d.getTimezoneOffset();
    let sign = off < 0 ? '-' : '+';
    off = Math.abs(off);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00` +
        `${sign}${pad2(Math.floor(off / 60))}:${pad2(off % 60)}`;
}
const dayIso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const UTC = () => ICalGLib.Timezone.get_utc_timezone();
// Seconds since the epoch of an ICalGLib.Time, in its own zone (UTC if none).
const sec = (t, zone = null) => t.as_timet_with_zone(t.get_timezone() ?? zone ?? UTC());
// …of an ECal.ComponentDateTime: its TZID resolved through the calendar.
function secOf(cdt) {
    let tzid = cdt.get_tzid();
    let zone = null;
    if (tzid && tzid !== 'UTC') {
        let r = reader.get_timezone_sync(tzid, null);
        zone = Array.isArray(r) ? r[r.length - 1] : r;
    }
    return sec(cdt.get_value(), zone);
}

// org.gnome.Shell.CalendarServer on the private bus (eds-check.sh starts it):
// keeps every event it announced, by id.
class CalServer {
    constructor() {
        this.events = new Map(); // id → [id, summary, start, end, attrs]
        this._ids = [
            Gio.DBus.session.signal_subscribe('org.gnome.Shell.CalendarServer', 'org.gnome.Shell.CalendarServer',
                'EventsAddedOrUpdated', '/org/gnome/Shell/CalendarServer', null, Gio.DBusSignalFlags.NONE,
                (c, s, p, i, sig, params) => {
                    for (let ev of params.deep_unpack()[0])
                        this.events.set(ev[0], ev);
                }),
            Gio.DBus.session.signal_subscribe('org.gnome.Shell.CalendarServer', 'org.gnome.Shell.CalendarServer',
                'EventsRemoved', '/org/gnome/Shell/CalendarServer', null, Gio.DBusSignalFlags.NONE,
                (c, s, p, i, sig, params) => {
                    for (let id of params.deep_unpack()[0])
                        this.events.delete(id);
                }),
        ];
        let now = Math.floor(Date.now() / 1000);
        Gio.DBus.session.call_sync('org.gnome.Shell.CalendarServer', '/org/gnome/Shell/CalendarServer',
            'org.gnome.Shell.CalendarServer', 'SetTimeRange',
            new GLib.Variant('(xxb)', [now - 3 * 86400, now + 40 * 86400, true]), null, Gio.DBusCallFlags.NONE, -1, null);
    }

    // The ids announced for event `uid`, once `pred(ids)` holds (10 s max).
    async idsOf(uid, pred = ids => ids.length > 0) {
        let get = () => [...this.events.keys()].filter(id => id.split('\n')[1] === uid).sort();
        for (let i = 0; i < 100 && !pred(get()); i++)
            await sleep(100);
        return get();
    }

    destroy() {
        for (let id of this._ids)
            Gio.DBus.session.signal_unsubscribe(id);
        this._ids = [];
    }
}
let calServer = null;
let reader = null; // the test's own client on the temp calendar

// The component(s) stored for `uid` (master first).
function stored(uid) {
    let [, comps] = reader.get_object_list_as_comps_sync(`(uid? "${uid}")`, null);
    return comps.sort((a, b) => !!a.get_recurid() - !!b.get_recurid());
}

// Summaries of the occurrences of `uid` in the next days, by start (s).
function occurrences(uid) {
    let out = [];
    let now = Math.floor(Date.now() / 1000);
    reader.generate_instances_for_uid_sync(uid, now - 3 * 86400, now + 40 * 86400, null, (ical, start) => {
        out.push([sec(start), ical.get_summary() ?? '']);
        return true;
    });
    return out.sort((a, b) => a[0] - b[0]);
}

async function events(client, registry, cal) {
    // splitEventId, on the shape gnome-shell-calendar-server emits (observed
    // on the private bus: "<source>\n<uid>\n<rid>", rid empty unless the
    // event recurs, then a UTC date-time like 20261109T130000Z).
    let eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok(eq(splitEventId('src-1\nuid-1\n'), { source: 'src-1', uid: 'uid-1', rid: '' }), 'splitEventId: no rid');
    ok(eq(splitEventId('src-1\nuid-1\n20261109T130000Z'), { source: 'src-1', uid: 'uid-1', rid: '20261109T130000Z' }),
        'splitEventId: a recurrence id');
    ok(eq(splitEventId('src-1\nuid@x\ny\n'), { source: 'src-1', uid: 'uid@x\ny', rid: '' }), 'splitEventId: newline in the uid');
    ok(splitEventId('') === null && splitEventId('just-one') === null && splitEventId(null) === null,
        'splitEventId: not an event id → null');

    // Writability from connected clients (Ruling 14).
    let { calendars } = await client.call('sources', { connect: true });
    let mine = calendars.find(s => s.uid === cal);
    ok(mine?.writable === true && mine.backend === 'local', `sources {connect} lists the test calendar writable: ${JSON.stringify(mine)}`);
    let birthdays = calendars.find(s => s.backend === 'contacts');
    ok(!birthdays || birthdays.writable === false, `contacts calendar read-only once connected: ${JSON.stringify(birthdays)}`);

    reader = ECal.Client.connect_sync(registry.ref_source(cal), ECal.ClientSourceType.EVENTS, 1, null);
    if (GLib.getenv('NNX_EDS_CALSERVER') === '1')
        calServer = new CalServer();
    const tzid = GLib.TimeZone.new_local().get_identifier();

    // A 30-minute event today at 15:00 local.
    let at = new Date();
    at.setHours(15, 0, 0, 0);
    let to = new Date(at.getTime() + 30 * 60000);
    let created = await client.call('events.create', { source: cal, summary: 'dentist', start: localIso(at),
        end: localIso(to), allDay: false, location: 'Rua 1', tzid });
    ok(typeof created?.uid === 'string' && created.uid, `events.create returns a uid: ${JSON.stringify(created)}`);
    let [comp] = stored(created.uid);
    let start = comp?.get_dtstart();
    ok(comp && comp.get_summary().get_value() === 'dentist' && comp.get_location() === 'Rua 1',
        'the event is stored with its summary and location');
    ok(secOf(start) === at.getTime() / 1000 && secOf(comp.get_dtend()) === to.getTime() / 1000,
        `stored at 15:00–15:30 local: ${start.get_value().as_ical_string()}`);
    ok(start.get_value().get_hour() === 15 && (start.get_tzid() ?? '').endsWith(tzid),
        `in the local zone (${tzid}), not UTC: ${start.get_tzid()} ${start.get_value().as_ical_string()}`);

    if (calServer) {
        let [id] = await calServer.idsOf(created.uid);
        print(`eds-check: observed CalendarServer id ${JSON.stringify(id)}`);
        ok(eq(splitEventId(id), { source: cal, uid: created.uid, rid: '' }), `CalendarServer id splits: ${JSON.stringify(id)}`);
        ok(calServer.events.get(id)[2] === at.getTime() / 1000, 'CalendarServer has it at 15:00');
    }

    // Update: summary, then the time.
    ok(JSON.stringify(await client.call('events.update', { source: cal, uid: created.uid, patch: { summary: 'dentist (moved)' } })) === '{}',
        'events.update returns {}');
    [comp] = stored(created.uid);
    ok(comp.get_summary().get_value() === 'dentist (moved)' && comp.get_location() === 'Rua 1' &&
        secOf(comp.get_dtstart()) === at.getTime() / 1000, 'summary patched, the rest kept');
    let at2 = new Date(at.getTime() + 3600000), to2 = new Date(at2.getTime() + 45 * 60000);
    await client.call('events.update', { source: cal, uid: created.uid, rid: '',
        patch: { start: localIso(at2), end: localIso(to2), allDay: false, location: '', tzid } });
    [comp] = stored(created.uid);
    ok(secOf(comp.get_dtstart()) === at2.getTime() / 1000 && secOf(comp.get_dtend()) === to2.getTime() / 1000 &&
        !comp.get_location(), `time patched to 16:00–16:45, location cleared: ${comp.get_dtstart().get_value().as_ical_string()}`);

    // All-day: DATE values, exclusive end (the next day).
    let day = new Date(at);
    day.setDate(day.getDate() + 2);
    let next = new Date(day);
    next.setDate(next.getDate() + 1);
    let allDay = await client.call('events.create', { source: cal, summary: 'holiday', start: dayIso(day), end: dayIso(next), allDay: true, tzid });
    [comp] = stored(allDay.uid);
    let s = comp.get_dtstart().get_value(), e = comp.get_dtend().get_value();
    ok(s.is_date() && e.is_date() && s.as_ical_string() === dayIso(day).replace(/-/g, '') &&
        e.as_ical_string() === dayIso(next).replace(/-/g, ''), `all-day: DATE ${s.as_ical_string()} → ${e.as_ical_string()}`);
    if (calServer) {
        let [id] = await calServer.idsOf(allDay.uid);
        let ev = calServer.events.get(id);
        print(`eds-check: CalendarServer all-day event: ${JSON.stringify([ev[2], ev[3], Object.keys(ev[4])])}`);
    }

    // Bad input is refused, nothing written.
    let err = await client.call('events.create', { source: cal, summary: 'x', start: localIso(to), end: localIso(at), allDay: false, tzid })
        .then(() => null, x => x);
    ok(err && /end/.test(err.message), `end before start is refused: ${err}`);
    err = await client.call('events.create', { source: cal, summary: 'x', start: 'tomorrow', end: 'later', allDay: false, tzid })
        .then(() => null, x => x);
    ok(err, 'a malformed time is refused');

    // A daily event, three times from today 10:00 (made here: the notch
    // doesn't create recurring events).
    let master = ECal.Component.new();
    master.set_new_vtype(ECal.ComponentVType.EVENT);
    master.set_summary(ECal.ComponentText.new('standup', null));
    let zone = ICalGLib.Timezone.get_builtin_timezone(tzid) ?? ICalGLib.Timezone.get_utc_timezone();
    let t = ICalGLib.Time.new_null_time();
    t.set_date(at.getFullYear(), at.getMonth() + 1, at.getDate());
    t.set_time(10, 0, 0);
    t.set_timezone(zone);
    let tEnd = t.clone();
    tEnd.adjust(0, 0, 15, 0);
    master.set_dtstart(ECal.ComponentDateTime.new(t, zone.get_tzid()));
    master.set_dtend(ECal.ComponentDateTime.new(tEnd, zone.get_tzid()));
    master.get_icalcomponent().add_property(ICalGLib.Property.new_rrule(ICalGLib.Recurrence.new_from_string('FREQ=DAILY;COUNT=3')));
    if (zone !== ICalGLib.Timezone.get_utc_timezone())
        reader.add_timezone_sync(zone, null);
    let [, daily] = reader.create_object_sync(master.get_icalcomponent(), ECal.OperationFlags.NONE, null);
    ok(occurrences(daily).length === 3, 'the daily event has three occurrences');

    // Recurrence ids as the CalendarServer gives them (else as EDS builds them).
    let rids;
    if (calServer) {
        rids = (await calServer.idsOf(daily, ids => ids.length === 3)).map(id => splitEventId(id).rid);
        print(`eds-check: observed recurring ids' rids ${JSON.stringify(rids)}`);
        ok(rids.length === 3 && rids.every(r => /^\d{8}T\d{6}Z$/.test(r)), `three UTC recurrence ids: ${JSON.stringify(rids)}`);
    } else {
        rids = occurrences(daily).map(([st]) => ICalGLib.Time.new_from_timet_with_zone(st, false, ICalGLib.Timezone.get_utc_timezone()).as_ical_string());
    }

    // Edit one occurrence (THIS): only it changes.
    await client.call('events.update', { source: cal, uid: daily, rid: rids[1], patch: { summary: 'standup (late)' } });
    let occ = occurrences(daily);
    ok(occ.map(o => o[1]).join() === 'standup,standup (late),standup', `update THIS changes one occurrence: ${JSON.stringify(occ)}`);

    // Delete one occurrence (all: false): the others remain.
    ok(JSON.stringify(await client.call('events.delete', { source: cal, uid: daily, rid: rids[2], all: false })) === '{}',
        'events.delete returns {}');
    occ = occurrences(daily);
    ok(occ.map(o => o[1]).join() === 'standup,standup (late)', `delete THIS removes one occurrence: ${JSON.stringify(occ)}`);

    // Delete all (from an occurrence): none remain.
    await client.call('events.delete', { source: cal, uid: daily, rid: rids[0], all: true });
    ok(stored(daily).length === 0, 'delete ALL removes the series');

    // A plain event: delete without a rid.
    await client.call('events.delete', { source: cal, uid: created.uid, rid: '', all: false });
    ok(stored(created.uid).length === 0, 'delete a single event');
    if (calServer) {
        let ids = await calServer.idsOf(created.uid, l => l.length === 0);
        ok(ids.length === 0, 'CalendarServer announces the removal');
    }

    // Read-only calendars refuse writes in the worker too.
    if (birthdays) {
        err = await client.call('events.create', { source: birthdays.uid, summary: 'x', start: dayIso(day), end: dayIso(next), allDay: true })
            .then(() => null, x => x);
        ok(err, `create on a read-only calendar is refused: ${err}`);
    }
    reader = null;
}

let registry = EDataServer.SourceRegistry.new_sync(null);
let uid = makeSource(registry);
let calUid = makeSource(registry, 'events');
let client = new EdsClient();
let status = 0;
// Top-level await, not loop.run(): gjs runs the main loop while the module
// awaits, and a nested loop inside module evaluation starves promise jobs.
try {
    // Events first: main() restarts the calendar factory, which the calendar
    // server doesn't recover from.
    await events(client, registry, calUid);
    await main(client, uid);
    print(`eds-check: ${n} checks passed`);
} catch (e) {
    print(`FAIL: ${e}\n${e.stack}`);
    status = 1;
} finally {
    client.destroy();
    calServer?.destroy();
    calServer = null;
    for (let u of [uid, calUid]) {
        try {
            registry.ref_source(u)?.remove_sync(null);
        } catch (e) {
            printerr(`eds-check: could not remove a test source: ${e.message}`);
        }
    }
}
// gjs segfaults at exit while EDS objects are alive (exit 139 would hide the
// result): drop them and collect first.
// Let the client's cancelled reads finish first, or GC meets their callbacks.
while (GLib.MainContext.default().iteration(false))
    ;
reader = null;
registry = null;
System.gc();
System.exit(status);
