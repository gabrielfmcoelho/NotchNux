// Running other programs from inside gnome-shell without blocking it. No
// actors here, so tests/proc-check.js runs it under plain `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { logDebug } from './log.js';

// The program's path, or null. gnome-shell's PATH may lack ~/.local/bin.
export function findProgram(name) {
    let local = `${GLib.get_home_dir()}/.local/bin/${name}`;
    return GLib.find_program_in_path(name) ?? (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null);
}

// Run argv and call done({ out, err, ok, timedOut, started }) once: out and
// err are its stdout and stderr (null if unreadable), ok its exit status,
// started false when it couldn't even start (err says why). `env` (a list of
// NAME=value) replaces the environment when given. After timeoutS it gets
// SIGTERM, SIGKILL 5 s later. `procs` (a Map) tracks it so killAll() can
// stop it; callers check their own "destroyed" state in done.
export function run(argv, { cwd = null, env = null, timeoutS = 30, procs = new Map() } = {}, done) {
    let launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_cwd(cwd || GLib.get_home_dir());
    if (env?.length)
        launcher.set_environ(env);
    let proc;
    try {
        proc = launcher.spawnv(argv);
    } catch (e) {
        done({ out: null, err: e.message, ok: false, timedOut: false, started: false });
        return;
    }
    let entry = { id: 0, timedOut: false };
    procs.set(proc, entry);
    entry.id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutS, () => {
        entry.timedOut = true;
        proc.send_signal(15);
        entry.id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            entry.id = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    });
    proc.communicate_async(null, null, (p, res) => {
        if (entry.id)
            GLib.Source.remove(entry.id);
        entry.id = 0;
        procs.delete(p);
        let out = null, err = null;
        try {
            // Bytes, decoded each on its own: a stray non-UTF-8 byte becomes
            // U+FFFD instead of losing both streams.
            let [, o, e] = p.communicate_finish(res);
            [out, err] = [o, e].map(b => (b ? new TextDecoder().decode(b.toArray()) : ''));
        } catch (e) {
            // killed: both stay null
        }
        done({ out, err, ok: p.get_successful(), timedOut: entry.timedOut, started: true });
    });
}

// Spawn argv and hand each complete record (stdout text up to `sep`) to
// onRecord as it arrives; onEnd() once stdout closes (the process died),
// unless stop() came first. → { stop() }, or null when it can't start (not
// installed). Restarting is the caller's call.
export function watchRecords(argv, sep, onRecord, onEnd = null) {
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        return null;
    }
    let cancellable = new Gio.Cancellable();
    let stream = proc.get_stdout_pipe();
    let decoder = new TextDecoder();
    let sepBytes = new TextEncoder().encode(sep);
    // Raw bytes until a full record arrives: GJS's TextDecoder has no
    // streaming mode, and the separators are ASCII, so decoding whole
    // records never splits a multi-byte character.
    let buf = new Uint8Array(0);
    let read = () => stream.read_bytes_async(65536, GLib.PRIORITY_LOW, cancellable, (s, res) => {
        let bytes;
        try {
            bytes = s.read_bytes_finish(res);
        } catch (e) {
            return; // cancelled
        }
        if (bytes.get_size() === 0) {
            onEnd?.();
            return;
        }
        let chunk = bytes.toArray();
        let merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
        let idx;
        while ((idx = indexOfBytes(buf, sepBytes)) >= 0) {
            let record = decoder.decode(buf.subarray(0, idx + sepBytes.length - 1));
            buf = buf.slice(idx + sepBytes.length);
            try {
                onRecord(record);
            } catch (e) {
                logDebug(`${argv[0]} watcher: ${e.message}`);
            }
        }
        read();
    });
    read();
    return {
        stop() {
            cancellable.cancel();
            proc.force_exit();
        },
    };
}

// Index of the byte sequence `seq` in `arr`, or -1.
function indexOfBytes(arr, seq) {
    let first = seq[0];
    for (let i = arr.indexOf(first); i >= 0 && i <= arr.length - seq.length; i = arr.indexOf(first, i + 1)) {
        let k = 1;
        while (k < seq.length && arr[i + k] === seq[k]) k++;
        if (k === seq.length) return i;
    }
    return -1;
}

// Stop everything run() started with this `procs` Map (disable()).
export function killAll(procs) {
    for (let [proc, entry] of procs) {
        if (entry.id)
            GLib.Source.remove(entry.id);
        entry.id = 0;
        proc.force_exit();
    }
    procs.clear();
}
