// The Dev tab's pure logic: Docker containers (and, later, ports and
// projects). No actors here, so tests/dev-check.js runs it under plain
// `gjs -m`.

import Gio from 'gi://Gio';
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
// reachable from this computer (bound to 127.0.0.1 / ::1). Ranges
// ("8000-8002->8000-8002/tcp") count each port, MAX_RANGE at most.
const MAX_RANGE = 64;
export function parsePorts(text) {
    let out = new Map();
    for (let m of String(text ?? '').matchAll(/(?:(\[[^\]]*\]|[\d.]+):)?(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(tcp|udp)/g)) {
        let [, host = '', first, last = first, target, proto] = m;
        let local = host === '127.0.0.1' || host === '[::1]';
        for (let i = 0; i <= Math.min(Number(last) - Number(first), MAX_RANGE - 1); i++) {
            let port = Number(first) + i;
            let key = `${port}/${proto}`;
            let prev = out.get(key);
            // Both v4 and v6 published: local only if every binding is.
            out.set(key, { port, target: Number(target) + i, proto, local: prev ? prev.local && local : local });
        }
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
    // quietMs: the die that follows a kill/stop within this long is the stop
    // you asked for (graceful shutdowns can take a while: stop_grace_period).
    constructor({ quietMs = 600000, loopN = 3, loopMs = 120000, muteMs = 300000 } = {}) {
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
        if (ev.action !== 'die')
            return null;
        if (ev.at - c.stoppedAt < this.quietMs) {
            c.stoppedAt = -Infinity;   // that stop is used up
            return null;
        }
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

// Processes that only forward a container's ports (rootless Docker /
// Podman, docker-proxy): stopping one would take every container down, so
// their ports are matched to the container like root's docker-proxy.
const FORWARDERS = new Set(['docker-proxy', 'rootlesskit', 'rootlessport', 'pasta', 'pasta.avx2', 'slirp4netns', 'conmon']);

// What the Ports view lists: this user's processes, and Docker's published
// ports (forwarded by root's docker-proxy or a rootless forwarder, matched
// by port to the container) → { rows: [{ port, local, name, pid, container }], hidden }.
export function portRows(sockets, containers = []) {
    let published = new Map();
    for (let c of containers.filter(c => c.state === 'running')) {
        for (let p of c.ports.filter(p => p.proto === 'tcp'))
            published.set(p.port, { c, local: p.local });
    }
    let rows = [], hidden = 0;
    for (let s of sockets) {
        let forwarder = s.pid === null || FORWARDERS.has(s.name);
        let pub = forwarder ? published.get(s.port) : null;
        if (!forwarder)
            rows.push({ ...s, container: null });
        else if (pub && !rows.some(r => r.container === pub.c.name && r.port === s.port))
            rows.push({ port: s.port, local: pub.local, name: pub.c.name, pid: null, container: pub.c.name });
        else if (!pub)
            hidden++;
    }
    return { rows, hidden };
}

// ---- Projects ----

const WALK_JOBS = 8;

// Folders never worth walking into for repos.
const SKIP_DIRS = new Set(['node_modules', 'venv', 'vendor', '__pycache__', 'site-packages', 'dist', 'build', 'target']);

const enumerate = (dir, attrs) => new Promise(resolve => dir.enumerate_children_async(attrs,
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, null, (d, res) => {
        let iter;
        try {
            iter = d.enumerate_children_finish(res);
        } catch (e) {
            resolve([]);
            return;
        }
        let all = [];
        let next = () => iter.next_files_async(64, GLib.PRIORITY_LOW, null, (it, r) => {
            let infos;
            try {
                infos = it.next_files_finish(r);
            } catch (e) {
                infos = [];
            }
            if (!infos.length) {
                iter.close_async(GLib.PRIORITY_LOW, null, null);
                resolve(all);
                return;
            }
            all.push(...infos);
            next();
        });
        next();
    }));

// Last change time (ms) of a path, 0 when missing.
const mtime = path => new Promise(resolve => Gio.File.new_for_path(path).query_info_async('time::modified',
    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (f, res) => {
        try {
            resolve(f.query_info_finish(res).get_modification_date_time().to_unix() * 1000);
        } catch (e) {
            resolve(0);
        }
    }));

// Git repositories under `roots`, `depth` levels down at most (a repo's own
// folders are searched too: repos nest) → [{ path, root, name, rel, at }],
// most recently used first (newest change to .git's index, HEAD or
// FETCH_HEAD). Hidden folders, symlinks and SKIP_DIRS are skipped. `.git`
// may be a file (a worktree).
export async function findRepos(roots, depth = 3) {
    let repos = [];
    // At most WALK_JOBS folders open at once: each holds a directory fd in
    // gnome-shell until it's read, and a wide tree would open thousands.
    let free = WALK_JOBS, waiting = [];
    let limited = async fn => {
        if (free > 0)
            free--;
        else
            await new Promise(resolve => waiting.push(resolve));
        try {
            return await fn();
        } finally {
            let next = waiting.shift();
            if (next)
                next();
            else
                free++;
        }
    };
    let walk = async (root, path, level) => {
        let infos = await limited(() => enumerate(Gio.File.new_for_path(path), 'standard::name,standard::type'));
        if (infos.some(i => i.get_name() === '.git'))
            repos.push({ path, root });
        if (level >= depth)
            return;
        await Promise.all(infos.filter(i => i.get_file_type() === Gio.FileType.DIRECTORY && !i.get_name().startsWith('.')
            && !SKIP_DIRS.has(i.get_name())).map(i => walk(root, `${path}/${i.get_name()}`, level + 1)));
    };
    await Promise.all([...new Set(roots)].map(r => walk(r.replace(/\/+$/, ''), r.replace(/\/+$/, ''), 0)));
    let seen = new Set();
    repos = repos.filter(r => !seen.has(r.path) && seen.add(r.path));
    await Promise.all(repos.map(async r => {
        let times = await Promise.all(['.git/index', '.git/HEAD', '.git/FETCH_HEAD', '.git'].map(f => mtime(`${r.path}/${f}`)));
        r.at = Math.max(...times);
        r.name = GLib.path_get_basename(r.path);
        // "SEAD/gestor" for ~/Projetos/SEAD/gestor/api-mcp-gestor; '' at the top.
        r.rel = r.path === r.root ? '' : GLib.path_get_dirname(r.path.slice(r.root.length + 1)).replace(/^\.$/, '');
    }));
    return repos.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
}

// `git status --porcelain=v2 --branch` → { branch, ahead, behind, changed,
// upstream } (branch null when detached).
export function parseGitStatus(text) {
    let st = { branch: null, ahead: 0, behind: 0, changed: 0, upstream: false };
    for (let line of String(text ?? '').split('\n')) {
        let m;
        if ((m = line.match(/^# branch\.head (.+)$/)))
            st.branch = m[1] === '(detached)' ? null : m[1];
        else if ((m = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)))
            [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
        else if (line.startsWith('# branch.upstream '))
            st.upstream = true;
        else if (/^[12u?] /.test(line))
            st.changed++;
    }
    return st;
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
