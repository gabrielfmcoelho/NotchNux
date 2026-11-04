// Running other programs from inside gnome-shell without blocking it. No
// actors here, so tests/proc-check.js runs it under plain `gjs -m`.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
    proc.communicate_utf8_async(null, null, (p, res) => {
        if (entry.id)
            GLib.Source.remove(entry.id);
        entry.id = 0;
        procs.delete(p);
        let out = null, err = null;
        try {
            [, out, err] = p.communicate_utf8_finish(res);
        } catch (e) {
            // killed, or not UTF-8: both stay null
        }
        done({ out, err, ok: p.get_successful(), timedOut: entry.timedOut, started: true });
    });
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
