// Where the Tasks tab (and Home's tasks card) get their tasks from: the local
// ProductivityStore (tasks.json, the default) or one Google Tasks list reached
// through Evolution Data Server (helpers/eds.js → tools/eds-worker.js).
//
// Both sources expose the same interface and the local task shape
// { id, text, done, starred, created, doneAt }:
//   open, done, doneToday, error, errorOp, kind
//   add(text) → the new task | null, toggle(id), star(id), rename(id, text),
//   remove(id), clearDone(), refresh() → Promise, settled() → Promise,
//   subscribe(cb) → unsubscribe, destroy()
// `cb(event)` gets no argument for a plain change, or { failed: { op, reason,
// text, timedOut } } when a Google write didn't go through (`timedOut`: its
// outcome is unknown — a timeout or the worker restarting/exiting).
//
// No shell imports here: prefs.js uses taskListChoices() too, and the tests
// run it under plain `gjs -m`.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { readTextAsync, writeText } from './productivity.js';
import { logError } from './log.js';

const MAX_TASK_LEN = 200; // as ProductivityStore
const MAX_STARS = 2000;

// "  !call   the bank " → { text: 'call the bank', starred: true }, or null.
function parseNewTask(text) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_LEN);
    let starred = text.startsWith('!');
    if (starred)
        text = text.slice(1).trim();
    return text ? { text, starred } : null;
}

const cleanText = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TASK_LEN);

function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function countDoneToday(done) {
    let key = todayKey();
    return done.filter(t => t.doneAt && todayKey(new Date(t.doneAt)) === key).length;
}

// A write whose outcome is unknown: EdsClient gave up waiting ("… timed
// out"; the worker may still carry it out) or the worker went away while it
// was in flight ("Google sync worker restarted" / "… exited"; it may have
// been done just before). Such writes re-list instead of rolling back.
export const outcomeUnknown = e => /timed out$|^Google sync worker (restarted|exited)$/.test(e?.message ?? '');

// The worker doesn't know the picked list any more: its Google account was
// removed, or the list was deleted on the web.
export const listGone = e => /^unknown source /.test(e?.message ?? '');
export const LIST_GONE = 'This list is gone — pick another list';

// The first refresh failing (at login: offline, the accounts service not up
// yet) is tried once more after this long.
export const FIRST_RETRY_S = 30;

// "<list> — <account>": two Google accounts often share list names.
export function taskListLabel(source) {
    return source.account ? `${source.name} — ${source.account}` : source.name;
}

// The lists a user can pick for the Tasks tab: Local first, then every Google
// Tasks list and any other writable task list, from the worker's `sources`
// answer (its `tasks` array).
export function taskListChoices(sources) {
    let lists = (Array.isArray(sources) ? sources : [])
        .filter(s => s && typeof s.uid === 'string' && (s.backend === 'gtasks' || s.writable));
    return [{ id: 'local', label: 'Local' }, ...lists.map(s => ({ id: s.uid, label: taskListLabel(s) }))];
}

export class LocalTaskSource {
    constructor(store) {
        this._store = store;
        this._listeners = new Set();
        // Not 'loaded': the notch re-renders every productivity tab for it.
        this._unsub = store.subscribe(kind => {
            if (kind === 'tasks')
                this._notify();
        });
    }

    get kind() {
        return 'local';
    }

    get open() {
        return this._store.openTasks;
    }

    get done() {
        return this._store.doneTasks;
    }

    get doneToday() {
        return this._store.doneToday;
    }

    get error() {
        return null;
    }

    get errorOp() {
        return null;
    }

    add(text) {
        return this._store.addTask(text);
    }

    toggle(id) {
        this._store.toggleTask(id);
    }

    star(id) {
        this._store.toggleStar(id);
    }

    rename(id, text) {
        this._store.renameTask(id, text);
    }

    remove(id) {
        this._store.removeTask(id);
    }

    clearDone() {
        this._store.clearDone();
    }

    refresh() {
        return Promise.resolve();
    }

    settled() {
        return Promise.resolve();
    }

    subscribe(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _notify() {
        for (let cb of this._listeners) {
            try {
                cb();
            } catch (e) {
                logError('task source listener failed', e);
            }
        }
    }

    destroy() {
        this._unsub?.();
        this._unsub = null;
        this._listeners.clear();
    }
}

// One EDS task list. Changes show at once and go to the worker; a rejected
// write is undone (only that change: other edits made meanwhile stay), sets
// `error` and tells listeners. A timed-out write re-lists from the worker
// instead, since it may have gone through after all. Stars are ours only
// (Google Tasks has none): a uid list in `starsPath`. A list the worker no
// longer knows (listGone) is dropped: no tasks, `gone`, LIST_GONE as the
// error, and no writes until a refresh finds it again.
// `timeout(seconds, fn)` / `clearTimeout(id)`: the first-refresh retry's
// timer (tests inject one).
export class EdsTaskSource {
    constructor(client, sourceUid, starsPath, {
        timeout = (secs, fn) => GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secs, fn),
        clearTimeout = id => GLib.Source.remove(id),
    } = {}) {
        this._timeout = timeout;
        this._clearTimeout = clearTimeout;
        this._retryId = 0;
        this._refreshedOnce = false;
        this._gone = false;
        this._client = client;
        this._source = sourceUid;
        this._starsPath = starsPath;
        this._tasks = [];
        this._stars = new Set();
        this._error = null;
        this._errorOp = null; // 'refresh' or the write that failed
        this._listeners = new Set();
        this._inflight = new Set();
        this._writeGen = 0;
        this._refreshing = null;
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._starsReady = new Promise(resolve => {
            readTextAsync(starsPath, this._cancellable, text => {
                try {
                    let list = JSON.parse(text ?? '[]');
                    if (Array.isArray(list)) {
                        for (let uid of list.filter(u => typeof u === 'string'))
                            this._stars.add(uid);
                    }
                } catch (e) {
                    logError(`${starsPath} is unreadable; starting without stars`, e);
                }
                for (let t of this._tasks)
                    t.starred = this._stars.has(t.id);
                resolve();
            });
        });
    }

    get kind() {
        return 'eds';
    }

    get sourceUid() {
        return this._source;
    }

    get gone() {
        return this._gone;
    }

    // The list went away: forget its tasks, say so.
    _markGone(op) {
        this._gone = true;
        this._tasks = [];
        this._error = LIST_GONE;
        this._errorOp = op;
    }

    // Open tasks: starred first, then in the list's own order.
    get open() {
        return this._tasks.filter(t => !t.done).sort((a, b) => b.starred - a.starred);
    }

    get done() {
        return this._tasks.filter(t => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    }

    get doneToday() {
        return countDoneToday(this._tasks.filter(t => t.done));
    }

    get error() {
        return this._error;
    }

    get errorOp() {
        return this._error ? this._errorOp : null;
    }

    subscribe(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _notify(event) {
        if (this._destroyed)
            return;
        for (let cb of this._listeners) {
            try {
                cb(event);
            } catch (e) {
                logError('task source listener failed', e);
            }
        }
    }

    _task(id) {
        return this._tasks.find(t => t.id === id && !t.pending) ?? null;
    }

    _fromWorker(g) {
        let updated = Number(g.updated) || 0;
        return {
            id: g.uid,
            text: String(g.summary ?? ''),
            done: !!g.done,
            starred: this._stars.has(g.uid),
            created: updated,
            doneAt: g.done ? updated || Date.now() : null,
            due: g.due ?? null,
            notes: g.notes ?? '',
        };
    }

    _saveStars() {
        writeText(this._starsPath, JSON.stringify([...this._stars].slice(-MAX_STARS)));
    }

    // Resolves once the list (and our stars) are current. Concurrent calls
    // share one round trip.
    refresh() {
        if (this._destroyed)
            return Promise.resolve();
        this._refreshing ??= this._refresh().finally(() => {
            this._refreshing = null;
        });
        return this._refreshing;
    }

    async _refresh() {
        await this._starsReady;
        let err = null;
        // Ask the backend to sync with Google, then read what it has (its
        // cache when offline).
        try {
            await this._client.call('refresh', { source: this._source });
        } catch (e) {
            err = e;
        }
        for (let attempt = 0; attempt < 3 && !this._destroyed; attempt++) {
            let gen = this._writeGen;
            let list;
            try {
                list = await this._client.call('tasks.list', { source: this._source });
            } catch (e) {
                err = e;
                break;
            }
            // A write started while this list was in flight may be missing
            // from it; the worker answers in order, so asking again sees it.
            if (gen !== this._writeGen && attempt < 2)
                continue;
            let pending = this._tasks.filter(t => t.pending);
            this._tasks = [...(Array.isArray(list) ? list : []).map(g => this._fromWorker(g)), ...pending];
            break;
        }
        if (this._destroyed)
            return;
        if (err && listGone(err)) {
            this._markGone('refresh');
        } else {
            this._error = err ? err.message ?? String(err) : null;
            this._errorOp = 'refresh';
            if (!err)
                this._gone = false;
        }
        // Only the first: later failures wait for the periodic re-sync.
        if (!this._refreshedOnce) {
            this._refreshedOnce = true;
            if (err) {
                this._retryId = this._timeout(FIRST_RETRY_S, () => {
                    this._retryId = 0;
                    this.refresh();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        this._notify();
    }

    // Wait for every write in flight (tests).
    async settled() {
        while (this._inflight.size)
            await Promise.allSettled([...this._inflight]);
        await this._refreshing;
    }

    // Send one change. `onOk(result)` runs on success, `undo()` on a rejection
    // that isn't a timeout. `info` describes the change for listeners.
    _write(op, args, { onOk = null, undo = null, info = {} } = {}) {
        this._writeGen++;
        let p = this._client.call(op, { source: this._source, ...args }).then(result => {
            if (this._destroyed)
                return;
            onOk?.(result);
            this._error = null;
            this._notify();
        }, async e => {
            if (this._destroyed)
                return;
            let reason = e?.message ?? String(e);
            let timedOut = outcomeUnknown(e);
            if (listGone(e)) {
                this._markGone(info.op);
                this._notify({ failed: { op: info.op, reason: LIST_GONE, text: info.text ?? null, timedOut: false } });
                return;
            }
            if (timedOut) {
                // Unknown outcome: show whatever the worker ends up with.
                this._tasks = this._tasks.filter(t => !(info.tempId && t.id === info.tempId));
                await this.refresh();
                if (this._destroyed)
                    return;
            } else {
                undo?.();
            }
            this._error = reason;
            this._errorOp = info.op;
            this._notify({ failed: { op: info.op, reason, text: info.text ?? null, timedOut } });
        });
        this._inflight.add(p);
        p.finally(() => this._inflight.delete(p));
        return p;
    }

    add(text) {
        let parsed = parseNewTask(text);
        if (!parsed || this._gone)
            return null;
        let task = {
            id: `pending:${GLib.uuid_string_random()}`, text: parsed.text, done: false, starred: parsed.starred,
            created: Date.now(), doneAt: null, due: null, notes: '', pending: true,
        };
        this._tasks.push(task);
        this._notify();
        this._write('tasks.create', { summary: parsed.text }, {
            info: { op: 'add', text: String(text ?? '').trim(), tempId: task.id },
            onOk: res => {
                task.pending = false;
                if (typeof res?.uid === 'string')
                    task.id = res.uid;
                if (task.starred && !task.id.startsWith('pending:')) {
                    this._stars.add(task.id);
                    this._saveStars();
                }
            },
            undo: () => {
                this._tasks = this._tasks.filter(t => t !== task);
            },
        });
        return task;
    }

    toggle(id) {
        let t = this._task(id);
        if (!t)
            return;
        let prev = { done: t.done, doneAt: t.doneAt };
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        this._notify();
        this._write('tasks.update', { uid: id, patch: { done: t.done } }, {
            info: { op: 'toggle' },
            undo: () => {
                let cur = this._task(id);
                if (cur)
                    Object.assign(cur, prev);
            },
        });
    }

    // Local only: nothing to send.
    star(id) {
        let t = this._task(id);
        if (!t)
            return;
        t.starred = !t.starred;
        if (t.starred)
            this._stars.add(id);
        else
            this._stars.delete(id);
        this._saveStars();
        this._notify();
    }

    rename(id, text) {
        let t = this._task(id);
        text = cleanText(text);
        if (!t || !text || text === t.text)
            return;
        let prev = t.text;
        t.text = text;
        this._notify();
        this._write('tasks.update', { uid: id, patch: { summary: text } }, {
            info: { op: 'rename' },
            undo: () => {
                let cur = this._task(id);
                if (cur)
                    cur.text = prev;
            },
        });
    }

    remove(id) {
        let t = this._task(id);
        if (!t)
            return;
        let index = this._tasks.indexOf(t);
        this._tasks.splice(index, 1);
        this._notify();
        this._write('tasks.delete', { uid: id }, {
            info: { op: 'remove' },
            onOk: () => {
                if (this._stars.delete(id))
                    this._saveStars();
            },
            undo: () => {
                if (!this._tasks.some(x => x.id === id))
                    this._tasks.splice(Math.min(index, this._tasks.length), 0, t);
            },
        });
    }

    // One delete per done task. Some may go through and others not, so any
    // failure re-lists instead of guessing.
    clearDone() {
        let gone = this._tasks.filter(t => t.done && !t.pending);
        if (!gone.length)
            return;
        this._tasks = this._tasks.filter(t => !gone.includes(t));
        this._notify();
        this._writeGen++;
        let p = Promise.allSettled(gone.map(t => this._client.call('tasks.delete', { source: this._source, uid: t.id })))
            .then(async results => {
                if (this._destroyed)
                    return;
                let failed = results.find(r => r.status === 'rejected');
                let starsChanged = false;
                results.forEach((r, i) => {
                    if (r.status === 'fulfilled')
                        starsChanged = this._stars.delete(gone[i].id) || starsChanged;
                });
                if (starsChanged)
                    this._saveStars();
                if (!failed) {
                    this._error = null;
                    this._notify();
                    return;
                }
                await this.refresh();
                if (this._destroyed)
                    return;
                let reason = failed.reason?.message ?? String(failed.reason);
                this._error = reason;
                this._errorOp = 'clear';
                this._notify({ failed: { op: 'clear', reason, text: null, timedOut: outcomeUnknown(failed.reason) } });
            });
        this._inflight.add(p);
        p.finally(() => this._inflight.delete(p));
    }

    destroy() {
        this._destroyed = true;
        if (this._retryId) {
            this._clearTimeout(this._retryId);
            this._retryId = 0;
        }
        this._cancellable.cancel();
        this._listeners.clear();
    }
}
