// The Dev tab's pure logic: Docker containers (and, later, ports and
// projects). No actors here, so tests/dev-check.js runs it under plain
// `gjs -m`.

import GLib from 'gi://GLib';

import { findProgram } from './proc.js';

// ---- Terminal ----

// argv that opens the user's default terminal in `dir` running `cmd` (a
// list), or null without xdg-terminal-exec. `hold` keeps the window open
// after the command ends.
export function terminalArgv(dir, cmd = [], { hold = false } = {}) {
    let bin = findProgram('xdg-terminal-exec');
    if (!bin)
        return null;
    return [bin, `--dir=${dir || GLib.get_home_dir()}`, ...(hold ? ['--hold'] : []), ...(cmd.length ? ['--', ...cmd] : [])];
}

// ---- Docker ----

// "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 8080/tcp" → the published
// ones, one per host port: [{ port, target, proto, local }]. `local`: only
// reachable from this computer (bound to 127.0.0.1 / ::1).
export function parsePorts(text) {
    let out = new Map();
    for (let m of String(text ?? '').matchAll(/(?:(\[[^\]]*\]|[\d.]+):)?(\d+)->(\d+)\/(tcp|udp)/g)) {
        let [, host = '', port, target, proto] = m;
        let local = host === '127.0.0.1' || host === '[::1]';
        let key = `${port}/${proto}`;
        let prev = out.get(key);
        // Both v4 and v6 published: local only if every binding is.
        out.set(key, { port: Number(port), target: Number(target), proto, local: prev ? prev.local && local : local });
    }
    return [...out.values()];
}

// The compose project, from the Labels string. Never split it on ",":
// com.docker.compose.project.config_files holds commas itself.
function composeProject(labels) {
    return String(labels ?? '').match(/(?:^|,)com\.docker\.compose\.project=([^,]*)/)?.[1] ?? '';
}

// `docker ps -a --format '{{json .}}'` (one JSON object per line) →
// [{ id, name, image, state, status, exitCode, project, ports }].
export function parseDockerPs(text) {
    let out = [];
    for (let line of String(text ?? '').split('\n')) {
        let c;
        try {
            c = JSON.parse(line);
        } catch (e) {
            continue;
        }
        if (!c?.ID)
            continue;
        let exit = String(c.Status ?? '').match(/^Exited \((-?\d+)\)/);
        out.push({
            id: c.ID, name: String(c.Names ?? '').split(',')[0], image: c.Image ?? '', state: c.State ?? '',
            status: c.Status ?? '', exitCode: exit ? Number(exit[1]) : null,
            project: composeProject(c.Labels), ports: parsePorts(c.Ports),
        });
    }
    return out;
}

// "Exited (1) 5 minutes ago" → did it exit within the last day? Docker only
// gives the age in words: seconds, minutes, "About an hour", "N hours" are
// recent; days, weeks and months aren't.
export function exitedRecently(status) {
    let age = String(status ?? '').match(/^Exited \(-?\d+\) (.+) ago$/)?.[1];
    if (!age)
        return false;
    if (/second|minute|About an hour/.test(age))
        return true;
    let hours = age.match(/^(\d+) hours?$/);
    return !!hours && Number(hours[1]) < 24;
}

// What the list shows: running, restarting and paused containers, and those
// that exited with an error in the last day. Clean exits, never-started
// ones and old crashes (a reboot's exit 255 from weeks ago) are noise.
export function visibleContainers(list) {
    return list.filter(c => ['running', 'restarting', 'paused', 'dead'].includes(c.state)
        || (c.state === 'exited' && c.exitCode && exitedRecently(c.status)));
}

// [[project, containers]], projects by name, loose containers ('') last;
// inside a project, by name.
export function groupByProject(list) {
    let groups = new Map();
    for (let c of [...list].sort((a, b) => a.name.localeCompare(b.name)))
        groups.set(c.project, [...groups.get(c.project) ?? [], c]);
    return [...groups].sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b));
}

// One line of `docker events --format '{{json .}}'` → { action, id, name,
// exitCode, at (ms) }, or null.
export function parseDockerEvent(line) {
    let e;
    try {
        e = JSON.parse(line);
    } catch (err) {
        return null;
    }
    let action = e?.Action ?? e?.status;
    let id = e?.Actor?.ID ?? e?.id;
    if (typeof action !== 'string' || !id)
        return null;
    let attrs = e.Actor?.Attributes ?? {};
    let code = attrs.exitCode !== undefined ? Number(attrs.exitCode) : null;
    let at = e.timeNano ? Math.round(e.timeNano / 1e6) : (e.time ?? 0) * 1000;
    return { action, id, name: attrs.name ?? id.slice(0, 12), exitCode: Number.isFinite(code) ? code : null, at };
}

// Turns container events into alerts: a container that dies with an error
// (not one you stopped) → { kind: 'exited', name, exitCode }; dying again
// soon after is quiet until the `loopN`th death within `loopMs` →
// { kind: 'loop', name, count }; then quiet until it has stayed up for
// `muteMs` (alerts only replace each other while showing, so a crash loop
// would otherwise alert forever). At most two alerts per crash loop.
export class CrashTracker {
    constructor({ quietMs = 15000, loopN = 3, loopMs = 120000, muteMs = 300000 } = {}) {
        Object.assign(this, { quietMs, loopN, loopMs, muteMs });
        this._c = new Map();   // id → { stoppedAt, dies: [ms], mutedUntil }
    }

    add(ev) {
        if (ev.action === 'destroy') {
            this._c.delete(ev.id);
            return null;
        }
        let c = this._c.get(ev.id) ?? { stoppedAt: -Infinity, dies: [], mutedUntil: 0 };
        this._c.set(ev.id, c);
        if (ev.action === 'kill' || ev.action === 'stop') {
            c.stoppedAt = ev.at;
            return null;
        }
        if (ev.action !== 'die' || ev.at - c.stoppedAt < this.quietMs)
            return null;
        if (ev.at < c.mutedUntil) {
            c.mutedUntil = ev.at + this.muteMs;   // still looping: stay quiet
            return null;
        }
        c.dies = [...c.dies.filter(t => ev.at - t < this.loopMs), ev.at];
        if (c.dies.length >= this.loopN) {
            c.dies = [];
            c.mutedUntil = ev.at + this.muteMs;
            return { kind: 'loop', name: ev.name, count: this.loopN };
        }
        return ev.exitCode && c.dies.length === 1 ? { kind: 'exited', name: ev.name, exitCode: ev.exitCode } : null;
    }
}

// ---- Ports ----

// Bound to this computer only (vs. every interface / the network).
const isLocalHost = host => /^(127\.|\[?::1\]?$|localhost$)/.test(host);

// `ss -ltnpH` → [{ port, local, name, pid }], one per port and process
// (IPv4 and IPv6 bindings merged; local only if every binding is). Sockets
// of other users (root's docker-proxy, cups) come without name or pid.
export function parseSs(text) {
    let out = new Map();
    for (let line of String(text ?? '').split('\n')) {
        let cols = line.trim().split(/\s+/);
        if (cols[0] !== 'LISTEN' || cols.length < 5)
            continue;
        let m = cols[3].match(/^(.*):(\d+)$/);
        if (!m)
            continue;
        let host = m[1].replace(/%.*$/, '');   // 127.0.0.53%lo
        let proc = line.match(/users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/);
        let row = { port: Number(m[2]), local: isLocalHost(host), name: proc?.[1] ?? '', pid: proc ? Number(proc[2]) : null };
        let key = `${row.port}/${row.pid}`;
        let prev = out.get(key);
        out.set(key, prev ? { ...prev, local: prev.local && row.local } : row);
    }
    return [...out.values()].sort((a, b) => a.port - b.port);
}

// What the Ports view lists: this user's processes, and Docker's published
// ports (root's docker-proxy, so no process: matched by port to the
// container) → { rows: [{ port, local, name, pid, container }], hidden }.
export function portRows(sockets, containers = []) {
    let published = new Map();
    for (let c of containers.filter(c => c.state === 'running')) {
        for (let p of c.ports.filter(p => p.proto === 'tcp'))
            published.set(p.port, { c, local: p.local });
    }
    let rows = [], hidden = 0;
    for (let s of sockets) {
        let pub = s.pid === null ? published.get(s.port) : null;
        if (s.pid !== null)
            rows.push({ ...s, container: null });
        else if (pub && !rows.some(r => r.container === pub.c.name && r.port === s.port))
            rows.push({ port: s.port, local: pub.local, name: pub.c.name, pid: null, container: pub.c.name });
        else if (!pub)
            hidden++;
    }
    return { rows, hidden };
}

// What a failed docker command said, in a line.
export function dockerError(r) {
    if (!r.started)
        return 'Docker isn’t installed';
    let text = String(r.err ?? '');
    if (/permission denied/i.test(text))
        return 'No permission to use Docker (add yourself to the docker group)';
    if (/Cannot connect to the Docker daemon|Is the docker daemon running/i.test(text))
        return 'Docker isn’t running';
    return text.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? (r.timedOut ? 'Docker took too long' : 'Docker failed');
}
