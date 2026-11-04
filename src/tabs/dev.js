// Dev tab: the containers and servers on this computer.
//
//   Containers  Docker containers grouped by compose project: running,
//               restarting, paused, and those that exited with an error. A row
//               opens its logs in a terminal; its buttons restart it and stop
//               or start it; its port chips open http://localhost:PORT.
//   Ports       What listens on a TCP port: this user's processes (with the
//               folder they run in) and Docker's published ports. A row opens
//               http://localhost:PORT; stop asks once, then ends it.
//   Projects    The git repos in the folders set in Preferences, most recently
//               used first, with branch, changes and ahead/behind. A row opens
//               it in the editor; buttons open a terminal or Claude Code there.
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
    terminalLaunch, parseDockerPs, visibleContainers, groupByProject, parseDockerEvent, CrashTracker, dockerError,
    parseSs, portRows, findRepos, parseGitStatus,
} from '../helpers/dev.js';
import { claudeBinary } from '../helpers/claude.js';
import { addPressFeedback } from '../helpers/motion.js';
import { logError } from '../helpers/log.js';
import { SYS, iconBtn } from './ledge.js';
import { text, dot, scrolled } from './claude.js';

const DEV_VIEWS = [['containers', 'Containers'], ['ports', 'Ports'], ['projects', 'Projects']];
const RELOAD_S = { containers: 30, ports: 5, projects: 60 };   // re-read an open view at most this often
const PROJECTS_SHOWN = 20;   // newest repos listed (and git-status'd)
const GIT_JOBS = 4;          // git status runs at once
const EVENT_DEBOUNCE_MS = 300;
const WATCH_RETRY_MAX_S = 60;
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
            projects: { list: null, status: new Map(), error: '', loading: false, at: 0, gen: 0 },
            updateId: 0, portsId: 0,
            busy: new Set(),       // container names with an action running
        };
        this._syncDevWatch();
    },

    _destroyDev() {
        let d = this._dev;
        d.watch?.stop();
        d.watch = null;
        for (let id of ['restartId', 'debounceId', 'updateId', 'portsId']) {
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
                // Daemon restarted or stopped: retry soon, then every minute
                // (a `docker events` that exits at once costs one spawn).
                if (this._destroyed)
                    return;
                d.restarts++;
                d.restartId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.min(5 * d.restarts, WATCH_RETRY_MAX_S), () => {
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
        // The open list follows (one re-read per burst of events); a closed
        // tab re-reads when it opens.
        if (!d.tabOpen) {
            d.containers.at = 0;
            return;
        }
        if (d.debounceId)
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
        else if (id === 'projects')
            this._loadProjects();
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
        this._updateProjects(ui.projects);
    },

    // Coalesce a burst of results (git status per repo) into one update.
    _queueDevUpdate() {
        let d = this._dev;
        if (d.updateId)
            return;
        d.updateId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            d.updateId = 0;
            this._updateDevTab();
            return GLib.SOURCE_REMOVE;
        });
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
            let chip = new St.Button({ style_class: 'nn-dev-chip', label: `:${p.port}`, can_focus: true,
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
            if (d.portsId)
                GLib.Source.remove(d.portsId);
            d.portsId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                d.portsId = 0;
                this._loadPorts();
                return GLib.SOURCE_REMOVE;
            });
        });
    },

    // ================================================================ projects

    // Preferences changed the folders: forget what was found.
    _onDevRootsChanged() {
        let st = this._dev.projects;
        st.gen++;   // a scan still running is for the old folders
        Object.assign(st, { list: null, at: 0 });
        st.status.clear();
        if (this._dev.tabOpen && this._devView === 'projects')
            this._loadProjects();
        this._updateDevTab();
    },

    async _loadProjects() {
        let st = this._dev.projects;
        if (st.loading)
            return;
        st.loading = true;
        let gen = st.gen;
        let roots = this._config.devProjectRoots;
        let list = [];
        try {
            list = roots.length ? await findRepos(roots) : [];
        } catch (e) {
            logError('Looking for git repositories', e);
        }
        st.loading = false;
        if (this._destroyed)
            return;
        if (gen !== st.gen) {
            if (this._dev.tabOpen && this._devView === 'projects')
                this._loadProjects();
            return;
        }
        Object.assign(st, { list, at: Date.now() });
        this._updateDevTab();
        this._loadGitStatus(list.slice(0, PROJECTS_SHOWN));
    },

    // `git status` for each shown repo, GIT_JOBS at a time. --no-optional-locks:
    // never take the index lock (a commit running in a terminal could fail).
    // core.fsmonitor=false: a repo's own .git/config can name a program for
    // git status to run; a folder nobody opened mustn't run anything.
    // ponytail: clean/smudge filters a repo configures can still run on a
    // stat-dirty file, as with any shell prompt that shows git status.
    _loadGitStatus(repos) {
        let d = this._dev;
        let git = findProgram('git');
        if (!git)
            return;
        let queue = [...repos];
        let next = () => {
            let r = queue.shift();
            if (!r || this._destroyed)
                return;
            run([git, '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', r.path, 'status', '--porcelain=v2', '--branch'],
                { timeoutS: 10, procs: d.procs }, res => {
                    if (this._destroyed)
                        return;
                    if (res.ok)
                        d.projects.status.set(r.path, parseGitStatus(res.out));
                    this._queueDevUpdate();
                    next();
                });
        };
        for (let i = 0; i < GIT_JOBS; i++)
            next();
    },

    _updateProjects(ui) {
        let st = this._dev.projects;
        let roots = this._config.devProjectRoots;
        let shown = (st.list ?? []).slice(0, PROJECTS_SHOWN);
        let sig = JSON.stringify([roots, st.list === null, st.list?.length, shown.map(r => [r.path, st.status.get(r.path)])]);
        if (sig === ui.sig)
            return;
        ui.sig = sig;
        let more = (st.list?.length ?? 0) - shown.length;
        ui.meta.set_text(!roots.length || st.list === null ? ''
            : [`${st.list.length} ${st.list.length === 1 ? 'repo' : 'repos'}, latest first`, more > 0 && `${more} older not shown`]
                .filter(Boolean).join(' · '));
        ui.list.destroy_all_children();
        if (!roots.length) {
            let empty = this._devEmpty('folder-symbolic', 'Choose your project folders in Preferences');
            let open = new St.Button({ style_class: 'nook-clear-btn', label: 'Open Preferences', can_focus: true,
                x_align: Clutter.ActorAlign.CENTER });
            open.connect('clicked', () => {
                this._collapseImmediately();
                this.extension.openPreferences();
            });
            empty.add_child(open);
            ui.list.add_child(empty);
        } else if (!shown.length) {
            ui.list.add_child(this._devEmpty('folder-symbolic',
                st.list === null ? 'Looking for repositories…' : 'No git repositories in those folders'));
        } else {
            for (let r of shown)
                ui.list.add_child(this._buildProjectRow(r, st.status.get(r.path)));
        }
        this._resizeDevTab();
    },

    // [name / parent · branch   3 changed  ↑2 ↓1] [terminal] [claude]; the
    // row opens it in the editor (or the file manager without one).
    _buildProjectRow(r, gs) {
        let line = new St.BoxLayout({ style_class: 'nn-claude-session', x_expand: true });
        let btn = new St.Button({ style_class: 'nn-claude-row', x_expand: true, can_focus: true,
            accessible_name: `Open ${r.name}` });
        let row = new St.BoxLayout({ x_expand: true });
        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'nn-claude-col' });
        col.add_child(text(r.name, 'nn-claude-name'));
        let meta = [r.rel, gs && (gs.branch ?? 'detached')].filter(Boolean).join(' · ');
        if (meta)
            col.add_child(text(meta, 'nook-card-meta'));
        row.add_child(col);
        if (gs?.changed)
            row.add_child(text(`${gs.changed} changed`, 'nn-claude-state', { style: `color: ${SYS.orange};` }));
        let ab = [gs?.ahead && `↑${gs.ahead}`, gs?.behind && `↓${gs.behind}`].filter(Boolean).join(' ');
        if (ab)
            row.add_child(text(ab, 'nn-claude-state', { style: `color: ${SYS.blue};` }));
        btn.set_child(row);
        btn.connect('clicked', () => {
            if (!this._openInEditor([r.path]))
                this._openUrl(Gio.File.new_for_path(r.path).get_uri());
        });
        addPressFeedback(btn);
        line.add_child(btn);
        line.add_child(iconBtn('utilities-terminal-symbolic', 'nook-mini-btn', () => this._openTerminal(r.path),
            `Open a terminal in ${r.name}`));
        let claude = claudeBinary();
        if (claude) {
            let c = new St.Button({ style_class: 'nn-dev-chip', label: 'claude', can_focus: true,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: `Start Claude Code in ${r.name}` });
            c.connect('clicked', () => this._openTerminal(r.path, [claude]));
            addPressFeedback(c);
            line.add_child(c);
        }
        return line;
    },

    // ================================================================ launching

    // Open the terminal picked in Preferences in `dir` running `cmd`.
    _openTerminal(dir, cmd = [], opts = {}) {
        let how = terminalLaunch(this._config.devTerminal, dir, cmd, opts);
        if (!how) {
            logError('No terminal launcher (xdg-terminal-exec) found');
            return;
        }
        this._collapseImmediately();
        if (how.argv) {
            try {
                Gio.Subprocess.new(how.argv, Gio.SubprocessFlags.NONE);
            } catch (e) {
                logError('Couldn’t open a terminal', e);
            }
            return;
        }
        if (!how.file) {
            this._openUrl(how.uri);
            return;
        }
        // Warp runs a command from a Tab Config file: write it, then open it.
        let file = Gio.File.new_for_path(how.file);
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (e) {
            // already there
        }
        file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(how.text)), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    logError('Couldn’t write the Warp tab config', e);
                    return;
                }
                if (!this._destroyed)
                    this._openUrl(how.uri);
            });
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
