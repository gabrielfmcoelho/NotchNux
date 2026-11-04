// Dev tab: the containers and servers on this computer.
//
//   Containers  Docker containers grouped by compose project: running,
//               restarting, paused, and those that exited with an error. A row
//               opens its logs in a terminal; its buttons restart it and stop
//               or start it; its port chips open http://localhost:PORT.
//   Ports       What listens on a TCP port: this user's processes (with the
//               folder they run in) and Docker's published ports. A row opens
//               http://localhost:PORT; stop asks once, then ends it.
//
// While the tab is enabled, `docker events` runs in the background (it only
// prints when a container starts, dies or stops), so a container that
// crashes, or keeps restarting, raises an alert in the notch. Lists are only
// read while the tab is open.
//
// Methods mixed into the NotchNux actor, like tabs/claude.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import { run, killAll, watchRecords, findProgram } from '../helpers/proc.js';
import {
    terminalArgv, parseDockerPs, visibleContainers, groupByProject, parseDockerEvent, CrashTracker, dockerError,
    parseSs, portRows,
} from '../helpers/dev.js';
import { addPressFeedback } from '../helpers/motion.js';
import { logError } from '../helpers/log.js';
import { SYS, iconBtn } from './ledge.js';
import { text, dot, scrolled } from './claude.js';

const DEV_VIEWS = [['containers', 'Containers'], ['ports', 'Ports']];
const RELOAD_S = { containers: 30, ports: 5 };   // re-read an open view at most this often
const EVENT_DEBOUNCE_MS = 300;
const ALERT_MS = 5000;
const DOCKER_EVENTS = ['start', 'die', 'kill', 'stop', 'destroy'];
const STATE_COLOR = { running: SYS.green, restarting: SYS.orange, paused: SYS.yellow };

const DevFeatures = {
    _initDev() {
        this._dev = {
            docker: findProgram('docker'),
            procs: new Map(),
            tracker: new CrashTracker(),
            watch: null, restarts: 0, restartId: 0, debounceId: 0,
            tabOpen: false,
            containers: { list: null, error: '', loading: false, at: 0 },
            ports: { list: null, error: '', loading: false, at: 0 },
            busy: new Set(),       // container names with an action running
        };
        this._syncDevWatch();
    },

    _destroyDev() {
        let d = this._dev;
        d.watch?.stop();
        d.watch = null;
        for (let id of ['restartId', 'debounceId']) {
            if (d[id])
                GLib.Source.remove(d[id]);
            d[id] = 0;
        }
        killAll(d.procs);
    },

    // ================================================================ docker events

    // `docker events` runs while the Dev tab is enabled (like the clipboard
    // watcher), restarting with backoff when the daemon restarts.
    _syncDevWatch() {
        let d = this._dev;
        let want = !this._destroyed && this._tabOrder.includes('dev') && !!d.docker;
        if (want && !d.watch && !d.restartId) {
            let argv = [d.docker, 'events', '--filter', 'type=container',
                ...DOCKER_EVENTS.flatMap(e => ['--filter', `event=${e}`]), '--format', '{{json .}}'];
            let watch = watchRecords(argv, '\n', line => {
                d.restarts = 0;
                this._onDockerEvent(line);
            }, () => {
                if (d.watch !== watch)
                    return;
                d.watch = null;
                // Daemon restarted, or Docker unusable: a few tries, then give up.
                if (d.restarts >= 5 || this._destroyed)
                    return;
                d.restarts++;
                d.restartId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5 * d.restarts, () => {
                    d.restartId = 0;
                    this._syncDevWatch();
                    return GLib.SOURCE_REMOVE;
                });
            });
            d.watch = watch;
        } else if (!want) {
            d.watch?.stop();
            d.watch = null;
            if (d.restartId)
                GLib.Source.remove(d.restartId);
            d.restartId = 0;
        }
    },

    _onDockerEvent(line) {
        let d = this._dev;
        let ev = parseDockerEvent(line);
        if (!ev)
            return;
        let alert = d.tracker.add(ev);
        if (alert) {
            let loop = alert.kind === 'loop';
            let color = loop ? SYS.orange : SYS.red;
            this._pushAlert({ kind: `docker:${alert.name}`, icon: loop ? 'view-refresh-symbolic' : 'dialog-warning-symbolic',
                color, title: alert.name, value: loop ? 'keeps restarting' : `exited (${alert.exitCode})`,
                valueColor: color, ms: ALERT_MS, onClick: () => this._openDevView('containers') });
        }
        // The open list follows (one re-read per burst of events).
        if (!d.tabOpen || d.debounceId)
            return;
        d.debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, EVENT_DEBOUNCE_MS, () => {
            d.debounceId = 0;
            this._loadContainers();
            return GLib.SOURCE_REMOVE;
        });
    },

    // ================================================================ tab

    _renderDevTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nn-claude nn-dev', vertical: true, x_expand: true });
        let seg = new St.BoxLayout({ style_class: 'nook-segmented', x_align: Clutter.ActorAlign.START });
        let segBtns = {};
        for (let [id, label] of DEV_VIEWS) {
            let b = new St.Button({ style_class: 'nook-segment', label, can_focus: true });
            b.connect('clicked', () => this._openDevView(id));
            seg.add_child(b);
            segBtns[id] = b;
        }
        panel.add_child(seg);

        let views = {};
        let ui = { segBtns, views };
        for (let [id] of DEV_VIEWS) {
            let view = new St.BoxLayout({ vertical: true, x_expand: true });
            let head = new St.BoxLayout({ style_class: 'nn-claude-head', x_expand: true });
            let meta = text('', 'nook-card-meta', { x_expand: true });
            head.add_child(meta);
            let refresh = iconBtn('view-refresh-symbolic', 'nook-mini-btn', () => this._loadDevView(id, true), 'Refresh');
            head.add_child(refresh);
            view.add_child(head);
            let list = new St.BoxLayout({ style_class: 'nn-claude-list', vertical: true, x_expand: true });
            view.add_child(scrolled(list));
            panel.add_child(view);
            views[id] = view;
            ui[id] = { meta, list, sig: null };
        }
        this._mount(panel);
        this._devUi = ui;
        this._devTabShown();
    },

    _devTabShown() {
        this._dev.tabOpen = true;
        this._loadDevView(this._devView ??= 'containers');
        this._updateDevTab();
    },

    _leaveDevTab() {
        this._dev.tabOpen = false;
    },

    // Every 3 s while the Dev tab is on screen (_startSystemRefresh).
    _devTick() {
        this._loadDevView(this._devView);
    },

    _openDevView(id) {
        this._devView = id;
        if (this._activeTab !== 'dev' || !this.isExpanded) {
            this._openTab('dev');
            return;
        }
        this._loadDevView(id);
        this._updateDevTab();
        this._resizeDevTab();
    },

    _resizeDevTab() {
        if (this.isExpanded && this._activeTab === 'dev' && !this._presenting)
            this._resizeToContent();
    },

    // Re-read a view once it's older than RELOAD_S (or now, when `force`).
    _loadDevView(id, force = false) {
        let st = this._dev[id];
        if (!st || st.loading || (!force && Date.now() - st.at < RELOAD_S[id] * 1000))
            return;
        if (id === 'containers')
            this._loadContainers();
        else if (id === 'ports')
            this._loadPorts();
    },

    _loadContainers() {
        let d = this._dev;
        let st = d.containers;
        if (st.loading)
            return;
        if (!d.docker) {
            Object.assign(st, { list: null, error: 'Docker isn’t installed', at: Date.now() });
            this._updateDevTab();
            return;
        }
        st.loading = true;
        run([d.docker, 'ps', '-a', '--format', '{{json .}}'], { timeoutS: 10, procs: d.procs }, r => {
            st.loading = false;
            if (this._destroyed)
                return;
            st.at = Date.now();
            st.list = r.ok ? parseDockerPs(r.out) : null;
            st.error = r.ok ? '' : dockerError(r);
            this._updateDevTab();
        });
    },

    _updateDevTab() {
        let ui = this._devUi;
        if (!ui || this._destroyed)
            return;
        let view = this._devView ??= 'containers';
        for (let [id, b] of Object.entries(ui.segBtns)) {
            if (id === view)
                b.add_style_class_name('nook-segment-active');
            else
                b.remove_style_class_name('nook-segment-active');
            ui.views[id].visible = id === view;
        }
        this._updateContainers(ui.containers);
        this._updatePorts(ui.ports);
    },

    _updateContainers(ui) {
        let d = this._dev;
        let st = d.containers;
        let shown = st.list ? visibleContainers(st.list) : [];
        let sig = JSON.stringify([st.error, st.list === null,
            shown.map(c => [c.id, c.state, c.status, c.ports, d.busy.has(c.name)])]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        let running = shown.filter(c => c.state === 'running').length;
        let trouble = shown.length - running;
        ui.meta.set_text(st.list === null ? '' : [`${running} running`, trouble && `${trouble} need a look`,
            `${st.list.length - shown.length} stopped`].filter(Boolean).join(' · '));
        ui.list.destroy_all_children();
        if (st.error || (st.list && !shown.length) || st.list === null) {
            ui.list.add_child(this._devEmpty('system-run-symbolic',
                st.error || (st.list === null ? 'Reading containers…' : 'No containers running')));
        } else {
            for (let [project, cs] of groupByProject(shown)) {
                ui.list.add_child(text(project || 'Other containers', 'nook-card-eyebrow nn-claude-group'));
                for (let c of cs)
                    ui.list.add_child(this._buildContainerRow(c));
            }
        }
        this._resizeDevTab();
    },

    _devEmpty(icon, message) {
        let empty = new St.BoxLayout({ style_class: 'nook-empty', vertical: true, x_expand: true });
        empty.add_child(new St.Icon({ icon_name: icon, icon_size: 22, style_class: 'nook-dim',
            x_align: Clutter.ActorAlign.CENTER }));
        empty.add_child(new St.Label({ text: message, style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
        return empty;
    },

    // [● name / image · status] [:port …] [↻] [■ or ▶]; the row opens its logs.
    _buildContainerRow(c) {
        let d = this._dev;
        let busy = d.busy.has(c.name);
        let up = c.state === 'running' || c.state === 'restarting' || c.state === 'paused';
        let color = STATE_COLOR[c.state] ?? SYS.red;
        let line = new St.BoxLayout({ style_class: 'nn-claude-session', x_expand: true });
        if (busy)
            line.opacity = 128;
        let btn = new St.Button({ style_class: 'nn-claude-row', x_expand: true, can_focus: true, reactive: !busy,
            accessible_name: `Logs of ${c.name}` });
        let row = new St.BoxLayout({ x_expand: true });
        row.add_child(dot(color));
        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'nn-claude-col' });
        col.add_child(text(c.name, 'nn-claude-name'));
        col.add_child(text(`${c.image} · ${c.status}`, 'nook-card-meta'));
        row.add_child(col);
        btn.set_child(row);
        btn.connect('clicked', () => this._openTerminal(null, [d.docker, 'logs', '-f', '--tail', '200', c.name], { hold: true }));
        addPressFeedback(btn);
        line.add_child(btn);
        for (let p of c.state === 'running' ? c.ports.slice(0, 2) : []) {
            let chip = new St.Button({ style_class: 'nook-mini-btn nn-dev-chip', label: `:${p.port}`, can_focus: true,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: `Open http://localhost:${p.port}` });
            chip.connect('clicked', () => this._openUrl(`http://localhost:${p.port}`));
            line.add_child(chip);
        }
        let act = (icon, args, name) => {
            let b = iconBtn(icon, 'nook-mini-btn', () => this._dockerAction(c.name, args), name);
            b.reactive = !busy;
            line.add_child(b);
        };
        act('view-refresh-symbolic', ['restart', c.name], `Restart ${c.name}`);
        if (up)
            act('media-playback-stop-symbolic', ['stop', c.name], `Stop ${c.name}`);
        else
            act('media-playback-start-symbolic', ['start', c.name], `Start ${c.name}`);
        return line;
    },

    _dockerAction(name, args) {
        let d = this._dev;
        if (d.busy.has(name))
            return;
        d.busy.add(name);
        this._updateDevTab();
        run([d.docker, ...args], { timeoutS: 60, procs: d.procs }, r => {
            d.busy.delete(name);
            if (this._destroyed)
                return;
            if (!r.ok)
                this._pushAlert({ kind: `docker:${name}`, icon: 'dialog-warning-symbolic', color: SYS.red, title: name,
                    value: `${args[0]} failed: ${dockerError(r)}`, valueColor: SYS.red, ms: ALERT_MS });
            this._loadContainers();
            if (this._devView === 'ports')
                this._loadPorts();
        });
    },

    // ================================================================ ports

    _loadPorts() {
        let d = this._dev;
        let st = d.ports;
        if (st.loading)
            return;
        let ss = findProgram('ss');
        if (!ss) {
            Object.assign(st, { list: null, error: 'ss (iproute2) isn’t installed', at: Date.now() });
            this._updateDevTab();
            return;
        }
        // Published container ports are matched against the container list.
        if (d.docker && Date.now() - d.containers.at > RELOAD_S.containers * 1000)
            this._loadContainers();
        st.loading = true;
        run([ss, '-ltnpH'], { timeoutS: 5, procs: d.procs }, r => {
            st.loading = false;
            if (this._destroyed)
                return;
            st.at = Date.now();
            st.list = r.ok ? parseSs(r.out) : null;
            st.error = r.ok ? '' : (r.err?.trim() || 'ss failed');
            this._updateDevTab();
        });
    },

    _updatePorts(ui) {
        let d = this._dev;
        let st = d.ports;
        let { rows, hidden } = st.list ? portRows(st.list, d.containers.list ?? []) : { rows: [], hidden: 0 };
        let sig = JSON.stringify([st.error, st.list === null, rows, hidden, [...d.busy]]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        ui.meta.set_text(st.list === null ? '' : [`${rows.length} listening`,
            hidden && `${hidden} system ${hidden === 1 ? 'port' : 'ports'} hidden`].filter(Boolean).join(' · '));
        ui.list.destroy_all_children();
        if (st.error || !rows.length) {
            ui.list.add_child(this._devEmpty('network-server-symbolic',
                st.error || (st.list === null ? 'Reading ports…' : 'Nothing of yours is listening')));
        } else {
            for (let r of rows)
                ui.list.add_child(this._buildPortRow(r));
        }
        this._resizeDevTab();
    },

    // [:8000  uvicorn / dlhsead-api  local] [■]; the row opens it in the browser.
    _buildPortRow(r) {
        let busy = this._dev.busy.has(r.container ?? `pid:${r.pid}`);
        let line = new St.BoxLayout({ style_class: 'nn-claude-session', x_expand: true });
        if (busy)
            line.opacity = 128;
        let btn = new St.Button({ style_class: 'nn-claude-row', x_expand: true, can_focus: true, reactive: !busy,
            accessible_name: `Open http://localhost:${r.port}` });
        let row = new St.BoxLayout({ x_expand: true });
        row.add_child(text(`:${r.port}`, 'nn-dev-port'));
        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'nn-claude-col' });
        col.add_child(text(r.name, 'nn-claude-name'));
        let where = r.container ? 'Docker container' : this._procFolder(r.pid);
        if (where)
            col.add_child(text(where, 'nook-card-meta'));
        row.add_child(col);
        row.add_child(text(r.local ? 'local' : 'network', 'nn-claude-state',
            { style: `color: ${r.local ? 'rgba(255, 255, 255, 0.5)' : SYS.orange};` }));
        btn.set_child(row);
        btn.connect('clicked', () => this._openUrl(`http://localhost:${r.port}`));
        addPressFeedback(btn);
        line.add_child(btn);
        let stop = iconBtn('media-playback-stop-symbolic', 'nook-mini-btn',
            () => this._armOrRun(stop, () => this._stopPort(r), { label: 'Stop?', icon: 'media-playback-stop-symbolic' }),
            `Stop ${r.name}`);
        stop.reactive = !busy;
        line.add_child(stop);
        return line;
    },

    // The folder a process runs in, as "~/…" (its own, so readable).
    _procFolder(pid) {
        try {
            let dir = GLib.file_read_link(`/proc/${pid}/cwd`);
            let home = GLib.get_home_dir();
            return dir === home ? '~' : dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
        } catch (e) {
            return '';
        }
    },

    // A container: docker stop. A process of ours: SIGTERM, then re-read.
    _stopPort(r) {
        if (r.container) {
            this._dockerAction(r.container, ['stop', r.container]);
            return;
        }
        let d = this._dev;
        let key = `pid:${r.pid}`;
        d.busy.add(key);
        this._updateDevTab();
        run(['kill', '-TERM', String(r.pid)], { timeoutS: 5, procs: d.procs }, () => {
            d.busy.delete(key);
            if (this._destroyed)
                return;
            // Give it a moment to close its socket.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                if (!this._destroyed)
                    this._loadPorts();
                return GLib.SOURCE_REMOVE;
            });
        });
    },

    // ================================================================ launching

    // Open the default terminal in `dir` running `cmd`.
    _openTerminal(dir, cmd = [], opts = {}) {
        let argv = terminalArgv(dir, cmd, opts);
        if (!argv) {
            logError('No terminal launcher (xdg-terminal-exec) found');
            return;
        }
        this._collapseImmediately();
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
        } catch (e) {
            logError('Couldn’t open a terminal', e);
        }
    },

    _openUrl(url) {
        this._collapseImmediately();
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (e) {
            logError(`Couldn’t open ${url}`, e);
        }
    },
};

export function installDev(proto) {
    for (let [name, fn] of Object.entries(DevFeatures))
        proto[name] = fn;
}
