// Shell side of src/tools/eds-worker.js: Evolution Data Server (Google
// Tasks/Calendar via GNOME Online Accounts) without blocking gnome-shell.
// No actors here, so tests/eds-client-check.js runs it under plain `gjs -m`.
//
// The worker is spawned on the first call and kept running. A worker that
// dies is restarted by the next call, at most MAX_RESTARTS times per
// RESTART_WINDOW_MS; past that every call rejects with STOPPED_MESSAGE until
// reset() (the tab being reopened).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { logDebug } from './log.js';

export const STOPPED_MESSAGE = 'Google sync stopped — reopen the tab to retry';
const CALL_TIMEOUT_MS = 15000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;

const WORKER = Gio.File.new_for_uri(import.meta.url)
    .get_parent().get_parent().get_child('tools').get_child('eds-worker.js').get_path();

export class EdsClient {
    // { available: true } when the worker runs and has ECal, else
    // { available: false, reason }. Options as for the constructor.
    static async probe(opts = {}) {
        let client = new EdsClient(opts);
        try {
            let hello = await client.call('hello');
            return hello?.ecal ? { available: true } : { available: false, reason: 'ECal not installed' };
        } catch (e) {
            return { available: false, reason: e.message };
        } finally {
            client.destroy();
        }
    }

    // argv: the worker command; now(): a clock in ms (tests inject one);
    // timeoutMs: per call.
    constructor({ argv = null, now = () => GLib.get_monotonic_time() / 1000, timeoutMs = CALL_TIMEOUT_MS } = {}) {
        this._argv = argv ?? [GLib.find_program_in_path('gjs') ?? 'gjs', '-m', WORKER];
        this._now = now;
        this._timeoutMs = timeoutMs;
        this._worker = null;
        this._pending = new Map(); // id → { resolve, reject, worker, timer }
        this._nextId = 1;
        this._started = false;
        this._restarts = []; // times (ms) of recent restarts
        this._stopped = false;
        this._destroyed = false;
    }

    // Resolves with the op's result, rejects with an Error (the worker's
    // message, a timeout, an exited worker, or STOPPED_MESSAGE).
    call(op, args = {}) {
        return new Promise((resolve, reject) => {
            if (this._destroyed) {
                reject(new Error('EdsClient destroyed'));
                return;
            }
            let worker;
            try {
                worker = this._ensureWorker();
            } catch (e) {
                reject(e);
                return;
            }
            let id = this._nextId++;
            let entry = { resolve, reject, worker, timer: 0 };
            entry.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                entry.timer = 0;
                this._pending.delete(id);
                worker.wedged = true;
                reject(new Error(`Google sync: ${op} timed out`));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, entry);
            this._write(worker, `${JSON.stringify({ id, op, args })}\n`);
        });
    }

    // Leave the stopped state (the user reopened the tab). A worker stuck on
    // a call that timed out is replaced too.
    reset() {
        this._stopped = false;
        this._restarts = [];
        if (this._worker?.wedged)
            this._kill('Google sync worker restarted');
    }

    destroy() {
        this._destroyed = true;
        this._kill('EdsClient destroyed');
    }

    _ensureWorker() {
        if (this._worker)
            return this._worker;
        if (this._stopped)
            throw new Error(STOPPED_MESSAGE);
        if (this._started) {
            let t = this._now();
            this._restarts = this._restarts.filter(r => t - r < RESTART_WINDOW_MS);
            if (this._restarts.length >= MAX_RESTARTS) {
                this._stopped = true;
                throw new Error(STOPPED_MESSAGE);
            }
            this._restarts.push(t);
        }
        this._started = true;
        // stderr is inherited: the worker's complaints land in the journal.
        let proc = Gio.Subprocess.new(this._argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
        let worker = {
            proc,
            stdin: proc.get_stdin_pipe(),
            stdout: new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() }),
            cancellable: new Gio.Cancellable(),
            writing: Promise.resolve(),
            wedged: false,
        };
        this._worker = worker;
        this._read(worker);
        return worker;
    }

    _read(worker) {
        worker.stdout.read_line_async(GLib.PRIORITY_DEFAULT, worker.cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch (e) {
                if (!worker.cancellable.is_cancelled())
                    this._exited(worker);
                return;
            }
            if (line === null) {
                this._exited(worker);
                return;
            }
            this._onLine(line);
            this._read(worker);
        });
    }

    _onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            logDebug(`eds-worker: ignoring ${line}`);
            return;
        }
        let entry = this._pending.get(msg?.id);
        if (!entry)
            return; // timed out already
        this._pending.delete(msg.id);
        entry.worker.wedged = false;
        if (entry.timer)
            GLib.Source.remove(entry.timer);
        if (msg.ok)
            entry.resolve(msg.result);
        else
            entry.reject(new Error(msg.error ?? 'Google sync failed'));
    }

    // Requests go out in order; partial writes are continued.
    _write(worker, text) {
        let bytes = new TextEncoder().encode(text);
        worker.writing = worker.writing.then(() => new Promise(resolve => {
            let rest = bytes;
            let step = () => worker.stdin.write_bytes_async(new GLib.Bytes(rest), GLib.PRIORITY_DEFAULT,
                worker.cancellable, (s, res) => {
                    try {
                        let n = s.write_bytes_finish(res);
                        rest = rest.subarray(n);
                        if (rest.length > 0) {
                            step();
                            return;
                        }
                    } catch (e) {
                        // Worker gone: its stdout closes and _exited rejects the call.
                    }
                    resolve();
                });
            step();
        }));
    }

    _exited(worker) {
        if (this._worker === worker)
            this._worker = null;
        this._rejectAll(worker, 'Google sync worker exited');
    }

    _kill(why) {
        let worker = this._worker;
        this._worker = null;
        if (worker) {
            worker.cancellable.cancel();
            worker.proc.force_exit();
        }
        this._rejectAll(worker, why);
    }

    // Reject the calls waiting on `worker` (all of them when null).
    _rejectAll(worker, why) {
        for (let [id, entry] of this._pending) {
            if (worker && entry.worker !== worker)
                continue;
            this._pending.delete(id);
            if (entry.timer)
                GLib.Source.remove(entry.timer);
            entry.reject(new Error(why));
        }
    }
}
