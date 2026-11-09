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
// One JSON object per line; requests are handled one at a time, in order.
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
function describeSources(kind) {
    let extName = extFor(kind);
    return getRegistry().list_enabled(extName).map(source => {
        let ext = source.get_extension(extName);
        let backend = ext.get_backend_name() ?? null;
        let client = clients.get(`${kind}:${source.get_uid()}`);
        return {
            uid: source.get_uid(),
            name: source.get_display_name(),
            account: accountOf(source),
            backend,
            writable: !READONLY_BACKENDS.has(backend) && (client ? !client.is_readonly() : source.get_writable()),
            color: ext.get_color() || null,
        };
    });
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

function refresh({ source, kind = 'tasks' }) {
    let client = getClient(source, kind);
    if (client.check_refresh_supported())
        client.refresh_sync(null);
    return {};
}

const OPS = {
    hello: () => ({ ecal: !!ECal }),
    sources: () => ({
        tasks: describeSources('tasks'),
        calendars: describeSources('events'),
    }),
    'tasks.list': listTasks,
    'tasks.create': createTask,
    'tasks.update': updateTask,
    'tasks.delete': deleteTask,
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

function handle(line) {
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
        return { id, ok: true, result: fn(req.args ?? {}) ?? null };
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
        if (line.trim()) {
            try {
                stdout.write_all(encoder.encode(`${JSON.stringify(handle(line))}\n`), null);
                stdout.flush(null);
            } catch (e) { // EPIPE: the shell is gone
                done();
                return;
            }
        }
        readNext(done);
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
