// Live activities API: scripts and apps push a progress bar or message into
// the pill over D-Bus (io.github.notchnux). Methods mixed into the NotchNux
// actor, like tabs/keyboard.js.
//
// Text is only ever shown with set_text (no markup). Limits live in
// helpers/activities.js; this file is the bus plumbing and the pill wiring.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { logError } from '../helpers/log.js';
import { ActivityTable } from '../helpers/activities.js';
import { accentHex } from '../helpers/widgets.js';

const BUS_NAME = 'io.github.notchnux';
const OBJECT_PATH = '/io/github/notchnux/Activities';
const ERR = 'io.github.notchnux.Error';

// Update: an empty title or body, or a progress of KEEP_PROGRESS (-2), keeps
// the old value. A progress of -1 (or any other negative) clears the bar.
const KEEP_PROGRESS = -2;

const XML = `
<node>
  <interface name="io.github.notchnux.Activities">
    <method name="Show">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="s" name="icon" direction="in"/>
      <arg type="d" name="progress" direction="in"/>
      <arg type="u" name="timeout" direction="in"/>
      <arg type="s" name="id" direction="out"/>
    </method>
    <method name="Update">
      <arg type="s" name="id" direction="in"/>
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="d" name="progress" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
    <method name="End">
      <arg type="s" name="id" direction="in"/>
      <arg type="b" name="ok" direction="out"/>
    </method>
  </interface>
</node>`;

const ActivityFeatures = {
    _initActivities() {
        this._actTable = null;
        this._actExport = null;
        this._actOwnId = 0;
        this._actWatches = new Map();  // sender -> {watchId, ids:Set}
        this._actTimers = new Map();   // id -> GLib source id
        this._syncActivityApi();
    },

    _syncActivityApi() {
        let on = this._config?.isFeatureEnabled('activityApi') ?? true;
        if (on && !this._actExport && !this._destroyed)
            this._startActivityApi();
        else if (!on)
            this._stopActivityApi();
    },

    _startActivityApi() {
        try {
            this._actTable = new ActivityTable({ now: () => GLib.get_monotonic_time() / 1000 });
            let conn = Gio.DBus.session;
            this._actExport = Gio.DBusExportedObject.wrapJSObject(XML, {
                ShowAsync: (p, inv) => this._actCall(inv, () => this._actShow(inv, p)),
                UpdateAsync: (p, inv) => this._actCall(inv, () => this._actUpdate(p)),
                EndAsync: (p, inv) => this._actCall(inv, () => this._actEnd(p)),
            });
            this._actExport.export(conn, OBJECT_PATH);
            this._actOwnId = Gio.bus_own_name_on_connection(conn, BUS_NAME,
                Gio.BusNameOwnerFlags.NONE, null,
                () => logError(`live activities API off: ${BUS_NAME} is taken or unavailable`));
        } catch (e) {
            logError('live activities API unavailable', e);
            this._stopActivityApi();
        }
    },

    _stopActivityApi() {
        try {
            if (this._actOwnId) Gio.bus_unown_name(this._actOwnId);
        } catch (e) { /* bus gone */ }
        this._actOwnId = 0;
        try {
            this._actExport?.unexport();
        } catch (e) { /* not exported */ }
        this._actExport = null;
        for (let id of [...(this._actTimers?.keys() ?? [])])
            this._actEndId(id, !this._destroyed);
        for (let w of this._actWatches?.values() ?? [])
            Gio.bus_unwatch_name(w.watchId);
        this._actWatches?.clear();
        this._actTable = null;
    },

    _destroyActivities() {
        this._stopActivityApi();
    },

    // Run `fn` (returns a GVariant) and reply; table errors become D-Bus errors.
    _actCall(inv, fn) {
        try {
            inv.return_value(fn());
        } catch (e) {
            let m = e?.message;
            if (m === 'RateLimited')
                inv.return_dbus_error(`${ERR}.RateLimited`, 'Too many calls');
            else if (m === 'TooMany')
                inv.return_dbus_error(`${ERR}.TooMany`, 'Too many live activities');
            else {
                logError('live activity call failed', e);
                inv.return_dbus_error(`${ERR}.Failed`, 'Internal error');
            }
        }
    },

    _actShow(inv, [title, body, icon, progress, timeout]) {
        let sender = inv.get_sender();
        let id = this._actTable.show(sender, { title, body, icon, progress, timeout });
        this._actWatch(sender, id);
        this._actPush(id);
        return new GLib.Variant('(s)', [id]);
    },

    _actUpdate([id, title, body, progress]) {
        let f = {};
        if (title) f.title = title;
        if (body) f.body = body;
        if (progress !== KEEP_PROGRESS) f.progress = progress;
        let ok = this._actTable?.update(id, f) ?? false;
        if (ok) this._actPush(id);
        return new GLib.Variant('(b)', [ok]);
    },

    _actEnd([id]) {
        let ok = this._actTable?.get(id) != null;
        if (ok) this._actEndId(id);
        return new GLib.Variant('(b)', [ok]);
    },

    // (Re)paint the pill alert and restart the expiry timer.
    _actPush(id) {
        let a = this._actTable?.get(id);
        if (!a) return;
        this._pushAlert({ kind: `act:${id}`, icon: a.icon, title: a.title, value: a.body,
            level: a.level, color: accentHex(), ms: a.ms });
        let old = this._actTimers.get(id);
        if (old) GLib.Source.remove(old);
        this._actTimers.set(id, GLib.timeout_add(GLib.PRIORITY_DEFAULT, a.ms, () => {
            this._actTimers.delete(id);
            // The alert's own timer takes the visible bar down.
            this._actEndId(id, false);
            return GLib.SOURCE_REMOVE;
        }));
    },

    // End one activity: table, timer, pill, sender watch.
    _actEndId(id, dismissVisible = true) {
        let sender = this._actTable?.get(id)?.sender;
        this._actTable?.end(id);
        let t = this._actTimers.get(id);
        if (t) GLib.Source.remove(t);
        this._actTimers.delete(id);
        let kind = `act:${id}`;
        if (this._alerts?.current?.kind === kind) {
            if (dismissVisible) this._dismissAlert();
        } else {
            this._alerts?.dropKind(kind);
        }
        let w = sender && this._actWatches.get(sender);
        if (w) {
            w.ids.delete(id);
            if (w.ids.size === 0) {
                Gio.bus_unwatch_name(w.watchId);
                this._actWatches.delete(sender);
            }
        }
    },

    // A crashed script must not leave a bar up: end its activities when it
    // drops off the bus.
    _actWatch(sender, id) {
        let w = this._actWatches.get(sender);
        if (!w) {
            w = { watchId: 0, ids: new Set() };
            this._actWatches.set(sender, w);
            w.watchId = Gio.bus_watch_name_on_connection(Gio.DBus.session, sender,
                Gio.BusNameWatcherFlags.NONE, null, () => this._actSenderGone(sender));
        }
        w.ids.add(id);
    },

    _actSenderGone(sender) {
        let ids = this._actTable?.endSender(sender) ?? [];
        for (let id of ids) {
            let t = this._actTimers.get(id);
            if (t) GLib.Source.remove(t);
            this._actTimers.delete(id);
            if (this._alerts?.current?.kind === `act:${id}`) this._dismissAlert();
            else this._alerts?.dropKind(`act:${id}`);
        }
        let w = this._actWatches.get(sender);
        if (w) {
            Gio.bus_unwatch_name(w.watchId);
            this._actWatches.delete(sender);
        }
    },
};

export function installActivities(proto) {
    for (let [name, fn] of Object.entries(ActivityFeatures))
        proto[name] = fn;
}
