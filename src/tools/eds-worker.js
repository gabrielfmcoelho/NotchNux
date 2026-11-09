// Out-of-process Evolution Data Server access for NotchNux.
//
// Google Tasks/Calendar reach us through GNOME Online Accounts + EDS, never
// our own OAuth. EDS calls are synchronous and can block for seconds (network,
// backend start-up), so they run here, in a long-lived `gjs -m eds-worker.js`
// that src/helpers/eds.js (EdsClient) talks to over stdin/stdout:
//
//   request  {"id":n,"op":"…","args":{…}}
//   response {"id":n,"ok":true,"result":…} | {"id":n,"ok":false,"error":"…"}
//
// One JSON object per line; requests are handled one at a time, in order (an
// async op finishes before the next request is read).
// Ops live in the OPS table below — add new ones there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import System from 'system';

let ECal = null, EDataServer = null, ICalGLib = null;
try {
    ECal = (await import('gi://ECal?version=2.0')).default;
    EDataServer = (await import('gi://EDataServer?version=1.2')).default;
    ICalGLib = (await import('gi://ICalGLib?version=3.0')).default;
} catch (e) {
    ECal = null; // hello reports {ecal: false}; every other op fails
}

// Backends whose ESource says writable but that take no items (Birthdays &
// Anniversaries is generated from contacts).
const READONLY_BACKENDS = new Set(['contacts']);
// connect_sync's wait_for_connected_seconds. Google task lists always wait the
// full time (30 → ~30 s, 3 → 3 s) and 0 waits forever, while items come from
// the local cache right after connecting. So: short, and paid once per source
// because clients are cached for the worker's lifetime.
const CONNECT_WAIT_S = 1;

let registry = null;
const clients = new Map(); // `${kind}:${uid}` → ECal.Client

function needEcal() {
    if (!ECal)
        throw new Error('ECal not installed');
}

function getRegistry() {
    needEcal();
    registry ??= EDataServer.SourceRegistry.new_sync(null);
    return registry;
}

// The connected client for source `uid`, cached. `kind` is 'tasks' or 'events'.
function getClient(uid, kind = 'tasks') {
    let key = `${kind}:${uid}`;
    let client = clients.get(key);
    if (client)
        return client;
    if (typeof uid !== 'string' || !uid)
        throw new Error('missing source');
    let source = getRegistry().ref_source(uid);
    if (!source || !source.has_extension(extFor(kind)))
        throw new Error(`unknown source ${uid}`);
    let type = kind === 'tasks' ? ECal.ClientSourceType.TASKS : ECal.ClientSourceType.EVENTS;
    client = ECal.Client.connect_sync(source, type, CONNECT_WAIT_S, null);
    clients.set(key, client);
    return client;
}

// A client for changing items: refuses read-only lists (holiday calendars,
// Birthdays) before EDS does it with a less helpful error.
function getWritableClient(uid, kind = 'tasks') {
    let client = getClient(uid, kind);
    if (client.is_readonly() || READONLY_BACKENDS.has(backendOf(client.get_source(), kind)))
        throw new Error('this list is read-only');
    return client;
}

const extFor = kind => (kind === 'tasks' ? EDataServer.SOURCE_EXTENSION_TASK_LIST : EDataServer.SOURCE_EXTENSION_CALENDAR);
const backendOf = (source, kind) => source.get_extension(extFor(kind)).get_backend_name() ?? null;

// The account a source belongs to: its collection's identity (the Google
// address for Online Accounts sources) or its parent's name, else null.
function accountOf(source) {
    let reg = getRegistry();
    let collection = reg.find_extension(source, EDataServer.SOURCE_EXTENSION_COLLECTION);
    if (collection) {
        let identity = collection.get_extension(EDataServer.SOURCE_EXTENSION_COLLECTION).get_identity();
        return identity || collection.get_display_name();
    }
    let parentUid = source.get_parent();
    let parent = parentUid ? reg.ref_source(parentUid) : null;
    return parent?.get_display_name() ?? null;
}

// `writable`: get_writable() is true even for Google's holiday calendars and
// Birthdays, so a source we already connected answers with !is_readonly();
// otherwise get_writable() minus READONLY_BACKENDS (mutating ops re-check on
// connect via getWritableClient). Not connecting here keeps `sources` fast.
// `tried`: the sources sources({connect}) tried to connect; one that failed
// is reported read-only (nothing can be written to it right now).
function describeSources(kind, tried = null) {
    let extName = extFor(kind);
    return getRegistry().list_enabled(extName).map(source => {
        let ext = source.get_extension(extName);
        let backend = ext.get_backend_name() ?? null;
        let client = clients.get(`${kind}:${source.get_uid()}`);
        let writable = client ? !client.is_readonly() : !tried?.has(source.get_uid()) && source.get_writable();
        return {
            uid: source.get_uid(),
            name: source.get_display_name(),
            account: accountOf(source),
            backend,
            writable: !READONLY_BACKENDS.has(backend) && writable,
            color: ext.get_color() || null,
        };
    });
}

function connectAsync(source, kind) {
    let type = kind === 'tasks' ? ECal.ClientSourceType.TASKS : ECal.ClientSourceType.EVENTS;
    return new Promise((resolve, reject) => {
        ECal.Client.connect(source, type, CONNECT_WAIT_S, null, (o, res) => {
            try {
                resolve(ECal.Client.connect_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// {connect: true}: connect every calendar first (all at once, so about
// CONNECT_WAIT_S in total; clients stay cached) so that `writable` comes from
// is_readonly(), the only accurate answer for Google's read-only calendars.
async function sources({ connect = false } = {}) {
    let tried = null;
    if (connect) {
        tried = new Set();
        let pending = getRegistry().list_enabled(extFor('events')).filter(source =>
            !READONLY_BACKENDS.has(backendOf(source, 'events')) && !clients.has(`events:${source.get_uid()}`));
        await Promise.all(pending.map(async source => {
            let uid = source.get_uid();
            tried.add(uid);
            try {
                clients.set(`events:${uid}`, await connectAsync(source, 'events'));
            } catch (e) {
                printerr(`eds-worker: connecting ${uid}: ${e.message}`);
            }
        }));
    }
    return { tasks: describeSources('tasks'), calendars: describeSources('events', tried) };
}

const pad = v => String(v).padStart(2, '0');
const utc = () => ICalGLib.Timezone.get_utc_timezone();

// ICalGLib.Time ↔ 'YYYY-MM-DD'.
function dateString(t) {
    if (!t || t.is_null_time() || !t.is_valid_time())
        return null;
    return `${t.get_year()}-${pad(t.get_month())}-${pad(t.get_day())}`;
}

function dateTime(str) {
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str ?? '');
    if (!m)
        throw new Error(`bad date ${str}`);
    let t = ICalGLib.Time.new_null_time();
    t.set_date(Number(m[1]), Number(m[2]), Number(m[3]));
    t.set_is_date(true);
    return ECal.ComponentDateTime.new(t, null);
}

const msOf = t => (t && !t.is_null_time() ? t.as_timet_with_zone(utc()) * 1000 : 0);

function taskOf(comp) {
    let summary = comp.get_summary()?.get_value() ?? '';
    let notes = comp.get_descriptions().map(d => d.get_value() ?? '').join('\n');
    return {
        uid: comp.get_uid(),
        summary,
        done: comp.get_status() === ICalGLib.PropertyStatus.COMPLETED,
        due: dateString(comp.get_due()?.get_value()),
        notes,
        updated: msOf(comp.get_last_modified()) || msOf(comp.get_created()) || msOf(comp.get_dtstamp()),
    };
}

function setDone(comp, done) {
    if (done) {
        comp.set_status(ICalGLib.PropertyStatus.COMPLETED);
        comp.set_completed(ICalGLib.Time.new_current_with_zone(utc()));
        comp.set_percent_complete(100);
    } else {
        comp.set_status(ICalGLib.PropertyStatus.NEEDSACTION);
        comp.set_completed(null);
        comp.set_percent_complete(-1);
    }
}

function touch(comp) {
    comp.set_last_modified(ICalGLib.Time.new_current_with_zone(utc()));
}

function listTasks({ source }) {
    let [, comps] = getClient(source).get_object_list_as_comps_sync('#t', null);
    // Recurring tasks can come back as master + detached instances: one per uid.
    let byUid = new Map();
    for (let comp of comps) {
        let uid = comp.get_uid();
        if (!byUid.has(uid) || !comp.get_recurid())
            byUid.set(uid, comp);
    }
    return [...byUid.values()].map(taskOf);
}

function createTask({ source, summary, due = null }) {
    if (typeof summary !== 'string')
        throw new Error('missing summary');
    let comp = ECal.Component.new();
    comp.set_new_vtype(ECal.ComponentVType.TODO); // also sets a fresh UID
    comp.set_summary(ECal.ComponentText.new(summary, null));
    setDone(comp, false);
    if (due)
        comp.set_due(dateTime(due));
    touch(comp);
    let [, uid] = getWritableClient(source).create_object_sync(comp.get_icalcomponent(), ECal.OperationFlags.NONE, null);
    return { uid: uid ?? comp.get_uid() };
}

function updateTask({ source, uid, patch = {} }) {
    let client = getWritableClient(source);
    let [, ical] = client.get_object_sync(uid, null, null);
    let comp = ECal.Component.new_from_icalcomponent(ical);
    if (!comp)
        throw new Error(`not a task: ${uid}`);
    if ('summary' in patch)
        comp.set_summary(ECal.ComponentText.new(patch.summary ?? '', null));
    if ('done' in patch)
        setDone(comp, !!patch.done);
    if ('due' in patch)
        comp.set_due(patch.due ? dateTime(patch.due) : null);
    if ('notes' in patch)
        comp.set_descriptions(patch.notes ? [ECal.ComponentText.new(patch.notes, null)] : []);
    touch(comp);
    client.modify_object_sync(comp.get_icalcomponent(), ECal.ObjModType.THIS, ECal.OperationFlags.NONE, null);
    return {};
}

function deleteTask({ source, uid }) {
    getWritableClient(source).remove_object_sync(uid, null, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null);
    return {};
}

// ---- Events ----
// Times arrive as the notch sends them: 'YYYY-MM-DD' for all-day events (the
// end exclusive: the next day), else local ISO 'YYYY-MM-DDTHH:MM[:SS]±HH:MM'
// plus `tzid`, the shell's zone (GLib.TimeZone.new_local().get_identifier()).
// Timed values keep their wall-clock time in that zone, so the event stays at
// 15:00 local across DST; a zone libical doesn't know falls back to the
// instant (from the offset) in UTC.

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/;

function zoneFor(tzid) {
    if (typeof tzid !== 'string' || !tzid || tzid === 'UTC')
        return null;
    return ICalGLib.Timezone.get_builtin_timezone(tzid) ?? null;
}

function whenOf(str, allDay, zone) {
    if (allDay)
        return dateTime(str);
    let m = ISO_TIME.exec(str ?? '');
    if (!m)
        throw new Error(`bad time ${str}`);
    let [y, mo, d, h, mi, s] = m.slice(1, 7).map(v => Number(v ?? 0));
    if (zone) {
        let t = ICalGLib.Time.new_null_time();
        t.set_date(y, mo, d);
        t.set_time(h, mi, s);
        t.set_timezone(zone);
        return ECal.ComponentDateTime.new(t, zone.get_tzid());
    }
    if (!m[7])
        throw new Error(`no time zone in ${str}`);
    let offMin = 0;
    if (m[7] !== 'Z') {
        let digits = m[7].slice(1).replace(':', '');
        offMin = (m[7][0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    }
    let secs = Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - offMin * 60;
    return ECal.ComponentDateTime.new(ICalGLib.Time.new_from_timet_with_zone(secs, false, utc()), null);
}

// Parsed and checked before any client is touched: a failed op evicts the
// source's cached client, and bad input shouldn't cost a reconnect.
function parseTimes({ start, end, allDay = false, tzid = null }) {
    let zone = allDay ? null : zoneFor(tzid);
    let dtstart = whenOf(start, !!allDay, zone);
    let dtend = whenOf(end, !!allDay, zone);
    if (dtstart.get_value().compare(dtend.get_value()) >= 0)
        throw new Error('the end must be after the start');
    return { dtstart, dtend, zone };
}

function setTimes(comp, client, { dtstart, dtend, zone }) {
    // The backend needs the VTIMEZONE behind a TZID.
    if (zone)
        client.add_timezone_sync(zone, null);
    comp.set_dtstart(dtstart);
    comp.set_dtend(dtend);
}

function cleanSummary(summary) {
    if (typeof summary !== 'string' || !summary.trim())
        throw new Error('missing title');
    return summary.trim();
}

function createEvent({ source, summary, start, end, allDay = false, location = null, tzid = null }) {
    summary = cleanSummary(summary);
    let times = parseTimes({ start, end, allDay, tzid });
    let client = getWritableClient(source, 'events');
    let comp = ECal.Component.new();
    comp.set_new_vtype(ECal.ComponentVType.EVENT); // also sets a fresh UID
    comp.set_summary(ECal.ComponentText.new(summary, null));
    setTimes(comp, client, times);
    if (location)
        comp.set_location(String(location));
    touch(comp);
    let [, uid] = client.create_object_sync(comp.get_icalcomponent(), ECal.OperationFlags.NONE, null);
    return { uid: uid ?? comp.get_uid() };
}

// The event, or with `rid` that one occurrence (built from the series when
// it was never changed on its own).
function eventComponent(client, uid, rid) {
    let [, ical] = client.get_object_sync(uid, rid || null, null);
    if (rid && !ical.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY))
        ical = ECal.util_construct_instance(ical, ICalGLib.Time.new_from_string(rid));
    let comp = ical ? ECal.Component.new_from_icalcomponent(ical) : null;
    if (!comp || comp.get_vtype() !== ECal.ComponentVType.EVENT)
        throw new Error(`not an event: ${uid}`);
    return comp;
}

// patch: { summary?, location?, start?, end?, allDay?, tzid? }, start and end
// together. A recurring event changes this occurrence only (THIS).
function updateEvent({ source, uid, rid = null, patch = {} }) {
    let summary = 'summary' in patch ? cleanSummary(patch.summary) : null;
    let times = 'start' in patch || 'end' in patch ? parseTimes(patch) : null;
    let client = getWritableClient(source, 'events');
    let comp = eventComponent(client, uid, rid);
    if (summary !== null)
        comp.set_summary(ECal.ComponentText.new(summary, null));
    if ('location' in patch)
        comp.set_location(patch.location ? String(patch.location) : null);
    if (times)
        setTimes(comp, client, times);
    touch(comp);
    client.modify_object_sync(comp.get_icalcomponent(), ECal.ObjModType.THIS, ECal.OperationFlags.NONE, null);
    return {};
}

// `all`: the whole series; else only the occurrence `rid` (no rid: the event).
function deleteEvent({ source, uid, rid = null, all = false }) {
    let client = getWritableClient(source, 'events');
    if (all || !rid)
        client.remove_object_sync(uid, null, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null);
    else
        client.remove_object_sync(uid, rid, ECal.ObjModType.THIS, ECal.OperationFlags.NONE, null);
    return {};
}

function refresh({ source, kind = 'tasks' }) {
    let client = getClient(source, kind);
    if (client.check_refresh_supported())
        client.refresh_sync(null);
    return {};
}

const OPS = {
    hello: () => ({ ecal: !!ECal }),
    sources,
    'tasks.list': listTasks,
    'tasks.create': createTask,
    'tasks.update': updateTask,
    'tasks.delete': deleteTask,
    'events.create': createEvent,
    'events.update': updateEvent,
    'events.delete': deleteEvent,
    refresh,
};

// Forget the cached clients for a source. Any failed op on a source evicts
// them: a client whose backend died (EDS restarted, the factory crashed, a
// bad first connect) otherwise fails every call for the worker's lifetime.
// Reconnecting costs CONNECT_WAIT_S on the next call.
function evict(uid) {
    clients.delete(`tasks:${uid}`);
    clients.delete(`events:${uid}`);
}

// Ops may be async (sources {connect}); the next request waits for them.
async function handle(line) {
    let id = null;
    let req = null;
    try {
        req = JSON.parse(line);
        id = req.id ?? null;
        let fn = Object.hasOwn(OPS, req.op) ? OPS[req.op] : null;
        if (!fn)
            throw new Error(`unknown op ${req.op}`);
        if (req.op !== 'hello')
            needEcal();
        return { id, ok: true, result: (await fn(req.args ?? {})) ?? null };
    } catch (e) {
        if (typeof req?.args?.source === 'string')
            evict(req.args.source);
        return { id, ok: false, error: e.message ?? String(e) };
    }
}

// stdout via a raw stream, flushed per line (print() is block-buffered on a pipe).
const stdout = new GioUnix.OutputStream({ fd: 1, close_fd: false });
const stdin = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
const encoder = new TextEncoder();

function readNext(done) {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
        let line;
        try {
            [line] = s.read_line_finish_utf8(res);
        } catch (e) {
            printerr(`eds-worker: ${e.message}`);
            done();
            return;
        }
        if (line === null) { // EOF: the shell closed our stdin
            done();
            return;
        }
        if (!line.trim()) {
            readNext(done);
            return;
        }
        handle(line).then(response => {
            try {
                stdout.write_all(encoder.encode(`${JSON.stringify(response)}\n`), null);
                stdout.flush(null);
            } catch (e) { // EPIPE: the shell is gone
                done();
                return;
            }
            readNext(done);
        });
    });
}
// gjs keeps its main loop running while this module awaits (a nested
// loop.run() here would starve promise jobs).
await new Promise(readNext);
// gjs segfaults at exit while EDS objects are still alive: drop them first.
clients.clear();
registry = null;
System.gc();
System.exit(0);
