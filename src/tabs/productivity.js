// Home, Tasks, Focus and Notes tabs, plus the focus timer's live activity in
// the collapsed pill.
//
// These are methods mixed into the NotchNux actor (see installProductivity at
// the bottom), so they share its helpers: _mount(), _invalidateTab(),
// _makeTypable(), _switchTab(), the accent, the stores. Each tab keeps a small
// `_xxxUi` handle so data changes patch the visible actors in place instead of
// rebuilding the tab.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';


import { ProductivityStore, FOCUS_PRESETS, NOTE_COLORS, DATA_DIR, fmtCountdown } from '../helpers/productivity.js';
import { LocalTaskSource, EdsTaskSource, taskListChoices } from '../helpers/tasksources.js';
import { EdsClient } from '../helpers/eds.js';
import { FocusRing, AlbumArtDisc, BREAK_GREEN, accentHex, accentRgbStr } from '../helpers/widgets.js';
import { addPressFeedback } from '../helpers/motion.js';
import { fmt } from '../helpers/format.js';
import { VERTICAL, HORIZONTAL } from '../helpers/compat.js';
import { logError } from '../helpers/log.js';
import { SYS } from './ledge.js';

const NOTE_CARD_H = 120;
const NOTE_TEXT_H = 64;

function rgba(hex, a) {
    let n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// "just now", "5 min ago", "2 h ago", "3 d ago".
function noteAgo(ms) {
    let s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

const HOME_TASKS = 4;
// A Google list re-syncs this often while the Tasks tab is on screen.
const TASKS_REFRESH_S = 300;

function label(text, styleClass, props = {}) {
    let l = new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function iconButton(iconName, styleClass, onClick, accessibleName = null) {
    let b = new St.Button({ style_class: styleClass, can_focus: true, reactive: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: accessibleName ?? '' });
    b.set_child(new St.Icon({ icon_name: iconName, icon_size: 14 }));
    b.connect('clicked', onClick);
    addPressFeedback(b);
    return b;
}

function card(styleClass = '') {
    return new St.BoxLayout({ style_class: `nook-card ${styleClass}`.trim(), ...VERTICAL, x_expand: true });
}

function eyebrow(text) {
    return new St.Label({ text, style_class: 'nook-card-eyebrow', y_align: Clutter.ActorAlign.CENTER });
}

// "45m" / "1h 15m".
function fmtMinutes(min) {
    if (min < 60) return `${min}m`;
    let h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

export const ProductivityTabs = {
    // ------------------------------------------------------------ lifecycle

    _initProductivity() {
        this._prod = new ProductivityStore();
        this._prodUnsub = this._prod.subscribe(kind => this._onProductivityChanged(kind));
        this._syncTaskSource();
        this._buildPillFocus();
        this._syncPillFocus();
        this._syncFocusDnd();
    },

    _destroyProductivity() {
        this._stopTasksRefresh();
        this._taskSourceUnsub?.();
        this._taskSourceUnsub = null;
        this._taskSource?.destroy();
        this._taskSource = null;
        this._taskSourceKey = null;
        this._edsClient?.destroy();
        this._edsClient = null;
        this._prodUnsub?.();
        // Hand Do Not Disturb back if we set it. If a session is still running
        // when we're re-enabled (e.g. after unlocking) it is re-applied then.
        if (this._prod?.dndByUs) {
            this._notificationSettings().set_boolean('show-banners', true);
            this._prod.setDndByUs(false);
        }
        this._prod?.destroy();
        this._prod = null;
    },

    _onProductivityChanged(kind) {
        if (this._destroyed)
            return;
        switch (kind) {
        case 'tick':
            this._tickPillFocus();
            if (this.isExpanded && this._activeTab === 'focus')
                this._focusUi?.update();
            else if (this.isExpanded && this._activeTab === 'home')
                this._homeUi?.updateFocus();
            break;
        case 'focus':
            this._syncPillFocus();
            this._syncFocusDnd();
            if (this._invalidateTab('focus', 'home')) {
                if (this._activeTab === 'focus') this._focusUi?.update();
                else this._homeUi?.updateFocus();
            }
            break;
        case 'focus-done':
        case 'break-done':
            this._onFocusPhaseDone(kind);
            break;
        case 'stopwatch':
        case 'sw-tick':
            this._onStopwatchChanged(kind);
            break;
        case 'loaded': {
            // Saved tasks/notes/focus arrived (read async after enable).
            this._syncPillFocus();
            this._syncFocusDnd();
            let tabs = ['home', 'tasks', 'focus', 'notes'];
            for (let tab of tabs)
                this._markTabDirty(tab);
            if (this.isExpanded && tabs.includes(this._activeTab))
                this._showActiveTab();
            break;
        }
        case 'notes':
            // Edits made by the Notes editor itself don't refresh it, and
            // nothing re-renders under the user's caret.
            if (this._notesSelf || !this._notesUi)
                break;
            this._markTabDirty('notes');
            if (this._notesUi.openId) {
                // Deleted elsewhere: back to the board. Never re-created.
                if (!this._prod.getNote(this._notesUi.openId)) {
                    if (this.isExpanded && this._activeTab === 'notes')
                        this._notesUi.render();
                    else
                        this._notesUi.openId = this._notesOpenId = null;
                    break;
                }
                // Not under the user's caret: it stays dirty and re-renders
                // the next time the tab is shown.
                if (global.stage.get_key_focus() === this._notesUi.entry?.clutter_text)
                    break;
            }
            if (this.isExpanded && this._activeTab === 'notes')
                this._showActiveTab();
            break;
        // 'tasks' arrives through the task source (_onTaskSourceChanged).
        }
    },

    // ------------------------------------------------------------ task source

    // The Tasks tab and Home's card read this._taskSource: the local store,
    // or the picked Google list while the googleTasks feature is on. Run on
    // init and whenever the feature or the picked list changes. The EDS
    // worker is never started with the feature off.
    _syncTaskSource() {
        if (this._destroyed || !this._prod)
            return;
        let google = this._config.isFeatureEnabled('googleTasks');
        let uid = google ? this._config.tasksSource : 'local';
        let key = uid === 'local' ? 'local' : `eds:${uid}`;
        if (!this._taskSource || key !== this._taskSourceKey) {
            this._taskSourceUnsub?.();
            this._taskSource?.destroy();
            if (key === 'local') {
                this._taskSource = new LocalTaskSource(this._prod);
            } else {
                this._edsClient ??= new EdsClient();
                this._taskSource = new EdsTaskSource(this._edsClient, uid,
                    GLib.build_filenamev([DATA_DIR, 'gtask-stars.json']));
            }
            this._taskSourceKey = key;
            this._taskSourceUnsub = this._taskSource.subscribe(ev => this._onTaskSourceChanged(ev));
            if (key !== 'local')
                this._taskSource.refresh();
        }
        if (!google) {
            this._stopTasksRefresh();
            this._edsClient?.destroy();
            this._edsClient = null;
            this._taskLists = null;
        }
        this._tasksPickerOpen = false;
        if (this._invalidateTab('tasks', 'home'))
            this._renderActiveTab();
        if (google && this.isExpanded && this._activeTab === 'tasks')
            this._tasksTabShown();
    },

    _onTaskSourceChanged(ev) {
        if (this._destroyed)
            return;
        if (ev?.failed)
            this._onTaskWriteFailed(ev.failed);
        if (this._invalidateTab('tasks', 'home')) {
            if (this._activeTab === 'tasks') this._tasksUi?.fill();
            else this._homeUi?.fillTasks();
        }
    },

    // A Google write was refused (already undone) or timed out (re-listed).
    // The island alert waits while the dashboard is open, so the Tasks
    // header shows the error inline too.
    _onTaskWriteFailed(f) {
        this._pushAlert({ kind: 'gtasks', icon: 'dialog-warning-symbolic', color: SYS.red,
            title: "Couldn't save to Google", value: f.reason });
        // A refused add puts the typed text back to retry. Not after a
        // timeout: the task may exist after all.
        if (f.op !== 'add' || !f.text || f.timedOut)
            return;
        let entries = this._taskAddOrigin === 'home'
            ? [this._homeUi?.taskEntry, this._tasksUi?.entry]
            : [this._tasksUi?.entry, this._homeUi?.taskEntry];
        let entry = entries.find(e => e && !e.get_text());
        entry?.set_text(f.text);
    },

    // Tasks tab on screen: retry a stopped or wedged worker, re-sync, and
    // keep re-syncing every few minutes while it stays open.
    _tasksTabShown() {
        if (!this._config.isFeatureEnabled('googleTasks'))
            return;
        this._edsClient?.reset();
        this._taskSource?.refresh();
        this._loadTaskLists();
        if (!this._tasksRefreshId && this._taskSource?.kind === 'eds') {
            this._tasksRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, TASKS_REFRESH_S, () => {
                this._taskSource?.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }
    },

    _leaveTasksTab() {
        this._tasksPickerOpen = false;
        this._stopTasksRefresh();
    },

    _stopTasksRefresh() {
        if (this._tasksRefreshId) {
            GLib.Source.remove(this._tasksRefreshId);
            this._tasksRefreshId = 0;
        }
    },

    // The picker's choices (Local + the Google/writable task lists).
    _loadTaskLists() {
        if (this._taskListsLoading || !this._config.isFeatureEnabled('googleTasks'))
            return;
        this._edsClient ??= new EdsClient();
        this._taskListsLoading = true;
        this._edsClient.call('sources').then(res => {
            this._taskLists = taskListChoices(res?.tasks);
        }, e => {
            logError('listing task lists failed', e);
        }).finally(() => {
            this._taskListsLoading = false;
            if (!this._destroyed)
                this._tasksUi?.fill();
        });
    },

    _pickTaskList(id) {
        this._tasksPickerOpen = false;
        if (id !== this._config.tasksSource)
            this._writeConfig(c => c.setTasksSource(id));
        this._syncTaskSource();
        this._tasksUi?.fill();
    },

    // Open a tab, expanding the notch if needed.
    _openTab(tab) {
        if (!this._tabOrder.includes(tab))
            return;
        this._switchTab(tab);
        if (!this.isExpanded)
            this.expand();
    },

    // ------------------------------------------------------------ pill

    // The pill's live activity: a tiny ring + countdown while a focus or break
    // session exists. It takes the music zone's place (one activity at a time,
    // like a phone's dynamic island) and opens the Focus tab when clicked.
    _buildPillFocus() {
        this._pillFocusBox = new St.Button({
            style_class: 'notchnux-pill-focus', reactive: true, can_focus: false,
            y_align: Clutter.ActorAlign.CENTER, visible: false });
        let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        this._pillFocusRing = new FocusRing(16, 3);
        this._pillFocusLabel = new St.Label({ style_class: 'notchnux-pill-focus-time', y_align: Clutter.ActorAlign.CENTER });
        row.add_child(this._pillFocusRing);
        row.add_child(this._pillFocusLabel);
        this._pillFocusBox.set_child(row);
        this._pillFocusBox.connect('clicked', () => this._openTab('focus'));
        this._pill.insert_child_at_index(this._pillFocusBox, 0);
    },

    _syncPillFocus() {
        if (!this._pillFocusBox)
            return;
        let active = this._prod.focusActive;
        let changed = active !== this._pillFocusBox.visible;
        this._pillFocusBox.visible = active;
        this._tickPillFocus();
        if (changed) {
            // Music (and the stopwatch) yield to the timer, and come back after.
            this._syncPillStopwatch?.();
            this._refreshLive();
            if (!this.isExpanded)
                this._applyPillWidth();
        }
    },

    _tickPillFocus() {
        if (!this._pillFocusBox?.visible)
            return;
        let f = this._prod.focus;
        let color = f.phase === 'break' ? BREAK_GREEN : null;
        this._pillFocusRing.set(f.progress, color, !f.running);
        this._pillFocusLabel.set_text(fmtCountdown(f.remainingMs));
        this._pillFocusLabel.set_style(`color: ${f.phase === 'break' ? '#5bdb9e' : accentHex()};`);
    },

    // ------------------------------------------------------------ focus ↔ DND

    // While a focus session runs with "silence" on, turn on Do Not Disturb —
    // and only ever undo a DND that we turned on ourselves.
    _syncFocusDnd() {
        if (!this._prod)
            return;
        let f = this._prod.focus;
        let settings = this._notificationSettings();
        let want = f.phase === 'focus' && f.running && f.silence;
        if (want && !this._prod.dndByUs && settings.get_boolean('show-banners')) {
            settings.set_boolean('show-banners', false);
            this._prod.setDndByUs(true);
        } else if (!want && this._prod.dndByUs) {
            settings.set_boolean('show-banners', true);
            this._prod.setDndByUs(false);
        }
    },

    _onFocusPhaseDone(kind) {
        this._syncPillFocus();
        this._syncFocusDnd();
        try {
            global.display.get_sound_player().play_from_theme('complete',
                kind === 'focus-done' ? 'Focus session complete' : 'Break over', null);
        } catch (e) {}
        if (this.isExpanded) {
            if (this._activeTab === 'focus') this._focusUi?.update();
            else if (this._activeTab === 'home') this._homeUi?.updateFocus();
            this._markTabDirty('focus');
            this._markTabDirty('home');
            return;
        }
        this._markTabDirty('focus');
        this._markTabDirty('home');
        let f = this._prod.focus;
        let [title, body, actions] = kind === 'focus-done'
            ? ['Focus session complete',
                `${f.sessionsToday} today · ${fmtMinutes(f.focusMinToday)} focused. Take a breather?`,
                [{ label: 'Start break', callback: () => this._prod.startBreak() },
                    { label: 'Not now', callback: () => {} }]]
            : ['Break’s over', 'Ready for another round?',
                [{ label: 'Start focus', callback: () => this._prod.startFocus() },
                    { label: 'Later', callback: () => {} }]];
        // A pseudo-notification: clicking the banner body opens the Focus tab.
        this._showNotificationPeek(title, body, new Gio.ThemedIcon({ name: 'alarm-symbolic' }),
            { activate: () => this._openTab('focus') }, actions);
    },

    // ------------------------------------------------------------ Home

    _renderHomeTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-home', ...VERTICAL, x_expand: true });

        // Greeting + weather chip.
        let now = new Date();
        let hour = now.getHours();
        let greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        let head = new St.BoxLayout({ style_class: 'nook-home-head', x_expand: true });
        let titles = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titles.add_child(label(greeting, 'nook-home-greeting'));
        titles.add_child(label(fmt(now, { weekday: 'long', month: 'long', day: 'numeric' }), 'nook-home-date'));
        head.add_child(titles);
        let w = this._weather.weatherData;
        if (w.loaded) {
            let chip = new St.Button({ style_class: 'nook-home-weather', y_align: Clutter.ActorAlign.CENTER, can_focus: true });
            let row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
            row.add_child(new St.Icon({ icon_name: w.icon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER }));
            row.add_child(label(w.temp, 'nook-home-weather-temp'));
            chip.set_child(row);
            chip.connect('clicked', () => this._switchTab('weather'));
            addPressFeedback(chip);
            head.add_child(chip);
        }
        panel.add_child(head);

        let grid = new St.BoxLayout({ style_class: 'nook-home-grid', x_expand: true });
        let left = new St.BoxLayout({ style_class: 'nook-home-col', ...VERTICAL, x_expand: true });
        let right = new St.BoxLayout({ style_class: 'nook-home-col nook-home-side', ...VERTICAL });
        grid.add_child(left);
        grid.add_child(right);
        panel.add_child(grid);

        left.add_child(this._buildHomeAgenda());
        let tasks = this._buildHomeTasks();
        left.add_child(tasks.card);
        let focus = this._buildHomeFocus();
        right.add_child(focus.card);
        let media = this._buildHomeMedia();
        right.add_child(media.card);

        this._mount(panel);
        this._homeUi = {
            fillTasks: tasks.fill,
            taskEntry: tasks.entry,
            updateFocus: focus.update,
            updateMedia: media.update,
        };
        tasks.fill();
        focus.update();
        media.update(this._mpris.getActiveTrackInfo());
    },

    _refreshHomeTab() {
        this._homeUi?.fillTasks();
        this._homeUi?.updateFocus();
        this._homeUi?.updateMedia(this._mpris.getActiveTrackInfo());
    },

    // Next timed event today ("Up next"), or the rest of the day's count.
    _buildHomeAgenda() {
        let c = new St.Button({ style_class: 'nook-card nook-home-agenda', x_expand: true, can_focus: true });
        let box = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        c.set_child(box);
        c.connect('clicked', () => this._switchTab('calendar'));
        addPressFeedback(c, 0.98);

        let now = new Date();
        let dayEnd = new Date(now);
        dayEnd.setHours(24, 0, 0, 0);
        let upcoming = [...this._calendarServerEvents.values()]
            .filter(ev => !ev.allDay && ev.end > now && ev.start < dayEnd)
            .sort((a, b) => a.start - b.start);
        let next = upcoming[0];

        let head = new St.BoxLayout({ x_expand: true });
        let eb = eyebrow(next && next.start <= now ? 'NOW' : 'UP NEXT');
        eb.x_expand = true;
        head.add_child(eb);
        if (upcoming.length > 1)
            head.add_child(label(`+${upcoming.length - 1} more today`, 'nook-card-meta'));
        box.add_child(head);

        if (!next) {
            box.add_child(label('Nothing else today', 'nook-home-agenda-title nook-dim'));
            box.add_child(label('Your calendar is clear.', 'nook-home-agenda-sub'));
            return c;
        }
        let row = new St.BoxLayout({ style_class: 'nook-home-agenda-row', x_expand: true });
        let bar = new St.Widget({ style_class: 'nook-home-agenda-bar' });
        bar.set_style(`background-color: ${accentHex()};`);
        row.add_child(bar);
        let text = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        text.add_child(label(next.title, 'nook-home-agenda-title'));
        let mins = Math.round((next.start - now) / 60000);
        let when = next.start <= now ? `until ${fmt(next.end, { hour: 'numeric', minute: '2-digit' })}`
            : mins < 60 ? `in ${mins} min` : `at ${fmt(next.start, { hour: 'numeric', minute: '2-digit' })}`;
        text.add_child(label(next.location ? `${when} · ${next.location}` : when, 'nook-home-agenda-sub'));
        row.add_child(text);
        box.add_child(row);
        return c;
    },

    _buildHomeTasks() {
        let c = card('nook-home-tasks');
        let head = new St.BoxLayout({ x_expand: true });
        let eb = eyebrow('TASKS');
        eb.x_expand = true;
        head.add_child(eb);
        let count = label('', 'nook-card-meta');
        head.add_child(count);
        c.add_child(head);

        let list = new St.BoxLayout({ style_class: 'nook-home-task-list', ...VERTICAL, x_expand: true });
        c.add_child(list);

        let entry = new St.Entry({ style_class: 'nook-input nook-input-compact', hint_text: 'Add a task…',
            can_focus: true, x_expand: true });
        this._makeTypable(entry);
        entry.clutter_text.connect('activate', () => {
            this._taskAddOrigin = 'home';
            if (this._taskSource.add(entry.get_text()))
                entry.set_text('');
        });
        c.add_child(entry);

        let fill = () => {
            list.destroy_all_children();
            let open = this._taskSource.open;
            count.set_text(open.length ? `${open.length} open` : `${this._taskSource.doneToday} done today`);
            if (open.length === 0) {
                list.add_child(label('Nothing on your list. Nice.', 'nook-home-empty'));
                return;
            }
            for (let t of open.slice(0, HOME_TASKS))
                list.add_child(this._buildTaskRow(t, { compact: true }));
            if (open.length > HOME_TASKS) {
                let more = new St.Button({ style_class: 'nook-link', x_align: Clutter.ActorAlign.START, can_focus: true,
                    label: `${open.length - HOME_TASKS} more in Tasks →` });
                more.connect('clicked', () => this._switchTab('tasks'));
                list.add_child(more);
            }
        };
        return { card: c, fill, entry };
    },

    _buildHomeFocus() {
        let c = new St.BoxLayout({ style_class: 'nook-card nook-home-focus', ...HORIZONTAL, x_expand: true });
        let ringStack = new St.Widget({ layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER });
        let ring = new FocusRing(58, 5);
        ringStack.add_child(ring);
        let time = new St.Label({ style_class: 'nook-home-focus-time', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        ringStack.add_child(time);
        c.add_child(ringStack);

        let side = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let phase = eyebrow('FOCUS');
        side.add_child(phase);
        let action = new St.Button({ style_class: 'nook-pill-btn', x_align: Clutter.ActorAlign.START, can_focus: true });
        let actionLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        action.set_child(actionLabel);
        action.connect('clicked', () => this._prod.toggleFocus());
        addPressFeedback(action);
        side.add_child(action);
        let stats = label('', 'nook-card-meta');
        side.add_child(stats);
        c.add_child(side);

        let update = () => {
            let f = this._prod.focus;
            let breakTime = f.phase === 'break';
            ring.set(f.phase === 'idle' ? 0 : f.progress, breakTime ? BREAK_GREEN : null, f.phase !== 'idle' && !f.running);
            time.set_text(fmtCountdown(f.remainingMs));
            phase.set_text(f.phase === 'idle' ? `FOCUS · ${f.presetMin}M` : breakTime ? 'BREAK' : f.running ? 'FOCUSING' : 'PAUSED');
            actionLabel.set_text(f.phase === 'idle' ? 'Start' : f.running ? 'Pause' : 'Resume');
            action.set_style(f.phase === 'idle' || !f.running ? `background-color: ${accentHex()}; color: #0d0d10;` : null);
            stats.set_text(f.sessionsToday ? `${f.sessionsToday} done · ${fmtMinutes(f.focusMinToday)}` : 'None yet today');
        };
        return { card: c, update };
    },

    _buildHomeMedia() {
        let c = card('nook-home-media');
        let row = new St.BoxLayout({ x_expand: true });
        let art = new AlbumArtDisc(38);
        art.y_align = Clutter.ActorAlign.CENTER;
        let artBox = new St.Bin({ style_class: 'nook-home-art', y_align: Clutter.ActorAlign.CENTER });
        artBox.set_child(art);
        row.add_child(artBox);
        let text = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        let title = label('', 'nook-home-media-title');
        let artist = label('', 'nook-home-media-artist');
        text.add_child(title);
        text.add_child(artist);
        row.add_child(text);
        c.add_child(row);

        let controls = new St.BoxLayout({ style_class: 'nook-home-media-controls', x_align: Clutter.ActorAlign.CENTER });
        let prev = iconButton('media-skip-backward-symbolic', 'nook-mini-btn', () => this._mpris.previous(), 'Previous');
        let play = iconButton('media-playback-start-symbolic', 'nook-mini-btn nook-mini-btn-primary', () => this._mpris.playPause(), 'Play/Pause');
        let next = iconButton('media-skip-forward-symbolic', 'nook-mini-btn', () => this._mpris.next(), 'Next');
        controls.add_child(prev);
        controls.add_child(play);
        controls.add_child(next);
        c.add_child(controls);

        let artUrl = null;
        let update = info => {
            let playing = info.status === 'Playing';
            title.set_text(String(info.hasMedia ? info.title : 'Nothing playing'));
            artist.set_text(String(info.hasMedia ? info.artist : ''));
            artist.visible = info.hasMedia;
            play.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            play.set_style(`background-color: ${accentHex()};`);
            for (let b of [prev, play, next])
                b.reactive = info.hasMedia;
            controls.opacity = info.hasMedia ? 255 : 110;
            if (info.albumArt !== artUrl) {
                artUrl = info.albumArt;
                art.setArtPath(null);
                this._loadAlbumArt(info.albumArt, art);
            }
        };
        return { card: c, update };
    },

    // ------------------------------------------------------------ Tasks

    // One task row: check circle · text (click to edit) · star · delete.
    _buildTaskRow(task, { compact = false } = {}) {
        let row = new St.BoxLayout({
            style_class: `nook-task-row${compact ? ' nook-task-row-compact' : ''}${task.done ? ' nook-task-done' : ''}`,
            x_expand: true, reactive: true, track_hover: true });
        // Still being saved to Google: shown, but nothing to act on yet.
        if (task.pending)
            row.opacity = 150;

        let check = new St.Button({ style_class: 'nook-task-check', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: task.done ? 'Mark as not done' : 'Mark as done' });
        check.set_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 12 }));
        if (task.done)
            check.set_style(`background-color: ${accentHex()}; border-color: ${accentHex()};`);
        check.connect('clicked', () => {
            // Fill the circle and fade the row, then commit (which re-fills
            // the list without this row).
            check.set_style(`background-color: ${accentHex()}; border-color: ${accentHex()};`);
            check.child.opacity = 255;
            row.ease({
                opacity: 0, translation_x: 14, duration: 220, delay: 120,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => this._taskSource.toggle(task.id),
            });
        });
        addPressFeedback(check, 0.88);
        row.add_child(check);

        let text = new St.Label({ style_class: 'nook-task-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: !compact });
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        let escaped = GLib.markup_escape_text(task.text, -1);
        text.clutter_text.set_markup(task.done ? `<s>${escaped}</s>` : escaped);
        row.add_child(text);

        if (compact) {
            if (task.starred) {
                let star = new St.Icon({ icon_name: 'starred-symbolic', icon_size: 12, style_class: 'nook-task-star-on', y_align: Clutter.ActorAlign.CENTER });
                star.set_style(`color: ${accentHex()};`);
                row.add_child(star);
            }
            return row;
        }

        // Click the text to edit it in place; Enter saves, Escape cancels.
        if (!task.done) {
            text.connect('button-release-event', () => {
                let edit = new St.Entry({ style_class: 'nook-input nook-task-edit', text: task.text, x_expand: true, can_focus: true });
                let done = save => {
                    if (save) this._taskSource.rename(task.id, edit.get_text());
                    else this._tasksUi?.fill();
                };
                edit.clutter_text.connect('activate', () => done(true));
                // Connected before _makeTypable's handler, which stops Esc.
                edit.clutter_text.connect('key-press-event', (a, ev) => {
                    if (ev.get_key_symbol() === Clutter.KEY_Escape) { done(false); return Clutter.EVENT_STOP; }
                    return Clutter.EVENT_PROPAGATE;
                });
                this._makeTypable(edit);
                row.replace_child(text, edit);
                edit.clutter_text.grab_key_focus();
                this._grabKeyboard(edit.clutter_text);
                return Clutter.EVENT_STOP;
            });
        }

        let star = iconButton(task.starred ? 'starred-symbolic' : 'non-starred-symbolic',
            `nook-task-action${task.starred ? ' nook-task-star-on' : ''}`, () => this._taskSource.star(task.id), 'Star');
        if (task.starred)
            star.set_style(`color: ${accentHex()};`);
        let del = iconButton('window-close-symbolic', 'nook-task-action nook-task-delete', () => {
            row.ease({ opacity: 0, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._taskSource.remove(task.id) });
        }, 'Delete');
        // Secondary actions surface on hover so the list reads clean.
        let actions = new St.BoxLayout({ style_class: 'nook-task-actions', y_align: Clutter.ActorAlign.CENTER });
        actions.add_child(star);
        actions.add_child(del);
        actions.opacity = task.starred ? 255 : 0;
        del.opacity = 0;
        row.connect('notify::hover', () => {
            actions.ease({ opacity: row.hover || task.starred ? 255 : 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            del.ease({ opacity: row.hover ? 255 : 0, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        });
        row.add_child(actions);
        return row;
    },

    _renderTasksTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-tasks', ...VERTICAL, x_expand: true });
        this._tasksView ??= 'open';

        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        let title = label('Tasks', 'nook-section-title');
        head.add_child(title);
        let badge = new St.Bin({ style_class: 'nook-count-badge', y_align: Clutter.ActorAlign.CENTER });
        badge.set_style(`background-color: ${accentHex()};`);
        let badgeLabel = new St.Label();
        badge.set_child(badgeLabel);
        head.add_child(badge);

        // Google Tasks on: which list (a drop-down below the header) and a
        // re-sync button.
        let google = this._config.isFeatureEnabled('googleTasks');
        let pickerLabel = null, pickerList = null, refresh = null, errorLabel = null;
        if (google) {
            let picker = new St.Button({ style_class: 'nook-clear-btn nook-task-source', can_focus: true,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Task list' });
            let pickerRow = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
            pickerLabel = label('', 'nook-task-source-label');
            pickerRow.add_child(pickerLabel);
            pickerRow.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
            picker.set_child(pickerRow);
            picker.connect('clicked', () => {
                this._tasksPickerOpen = !this._tasksPickerOpen;
                if (this._tasksPickerOpen)
                    this._loadTaskLists();
                this._tasksUi?.fill();
            });
            head.add_child(picker);
        }
        head.add_child(new St.Widget({ x_expand: true }));

        // Open / Done segmented switch.
        let seg = new St.BoxLayout({ style_class: 'nook-segmented', y_align: Clutter.ActorAlign.CENTER });
        let segBtns = {};
        for (let [id, text] of [['open', 'Open'], ['done', 'Done']]) {
            let b = new St.Button({ style_class: 'nook-segment', label: text, can_focus: true });
            b.connect('clicked', () => {
                this._tasksView = id;
                this._tasksUi?.fill();
            });
            seg.add_child(b);
            segBtns[id] = b;
        }
        head.add_child(seg);
        let clear = new St.Button({ style_class: 'nook-clear-btn', label: 'Clear', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        clear.connect('clicked', () => this._taskSource.clearDone());
        head.add_child(clear);
        if (google) {
            refresh = iconButton('view-refresh-symbolic', 'nook-task-action nook-task-refresh', () => {
                this._edsClient?.reset();
                this._taskSource.refresh();
                this._loadTaskLists();
            }, 'Sync with Google');
            head.add_child(refresh);
        }
        panel.add_child(head);

        if (google) {
            pickerList = new St.BoxLayout({ style_class: 'nook-task-picker', ...VERTICAL, x_expand: true, visible: false });
            panel.add_child(pickerList);
            errorLabel = label('', 'nook-task-error', { visible: false });
            panel.add_child(errorLabel);
        }

        // Rebuild the list choices: Local + the lists the worker reported,
        // plus the saved one if it isn't among them (yet).
        let fillPicker = () => {
            let current = this._taskSource.kind === 'eds' ? this._taskSource.sourceUid : 'local';
            let choices = [...(this._taskLists ?? taskListChoices(null))];
            if (!choices.some(c => c.id === current))
                choices.push({ id: current, label: this._taskLists ? 'Saved list (not found)' : 'Google list' });
            pickerLabel.set_text(choices.find(c => c.id === current).label);
            pickerList.visible = !!this._tasksPickerOpen;
            pickerList.destroy_all_children();
            if (!pickerList.visible)
                return;
            for (let c of choices) {
                let b = new St.Button({ style_class: `nook-task-picker-item${c.id === current ? ' nook-task-picker-item-active' : ''}`,
                    can_focus: true, x_expand: true, x_align: Clutter.ActorAlign.FILL });
                b.set_child(label(c.label, 'nook-task-picker-label', { x_expand: true }));
                b.connect('clicked', () => this._pickTaskList(c.id));
                pickerList.add_child(b);
            }
            if (this._taskListsLoading && !this._taskLists)
                pickerList.add_child(label('Looking for your lists…', 'nook-card-meta nook-task-picker-note'));
        };

        // Quick add. A leading "!" stars the task.
        let addRow = new St.BoxLayout({ style_class: 'nook-task-add', x_expand: true });
        let entry = new St.Entry({ style_class: 'nook-input', hint_text: 'Add a task — start with ! to star it',
            can_focus: true, x_expand: true });
        this._makeTypable(entry);
        let add = () => {
            this._taskAddOrigin = 'tasks';
            if (this._taskSource.add(entry.get_text())) {
                entry.set_text('');
                this._tasksView = 'open';
            }
        };
        entry.clutter_text.connect('activate', add);
        addRow.add_child(entry);
        let addBtn = iconButton('list-add-symbolic', 'nook-add-btn', add, 'Add task');
        addBtn.set_style(`background-color: ${accentHex()};`);
        addRow.add_child(addBtn);
        panel.add_child(addRow);

        let scroll = new St.ScrollView({ style_class: 'nook-task-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let list = new St.BoxLayout({ style_class: 'nook-task-list', ...VERTICAL, x_expand: true });
        scroll.set_child(list);
        panel.add_child(scroll);

        let footer = label('', 'nook-card-meta nook-task-footer');
        panel.add_child(footer);

        let fill = () => {
            let open = this._taskSource.open;
            let done = this._taskSource.done;
            let view = this._tasksView;
            if (google) {
                fillPicker();
                refresh.visible = this._taskSource.kind === 'eds';
                let err = this._taskSource.error;
                errorLabel.visible = !!err;
                if (err)
                    errorLabel.set_text(`${this._taskSource.errorOp === 'refresh' ? "Couldn't reach Google" : "Couldn't save to Google"} — ${err}`);
            }
            badgeLabel.set_text(String(open.length));
            badge.visible = open.length > 0;
            for (let [id, b] of Object.entries(segBtns)) {
                if (id === view) b.add_style_class_name('nook-segment-active');
                else b.remove_style_class_name('nook-segment-active');
            }
            clear.visible = view === 'done' && done.length > 0;
            list.destroy_all_children();
            let items = view === 'open' ? open : done;
            if (items.length === 0) {
                let empty = new St.BoxLayout({ style_class: 'nook-empty', ...VERTICAL, x_expand: true });
                let ic = new St.Icon({ icon_name: view === 'open' ? 'checkbox-checked-symbolic' : 'task-due-symbolic',
                    icon_size: 26, style_class: 'nook-empty-icon', x_align: Clutter.ActorAlign.CENTER });
                ic.set_style(`color: rgba(${accentRgbStr()}, 0.8);`);
                empty.add_child(ic);
                empty.add_child(new St.Label({ text: view === 'open' ? 'All clear' : 'Nothing completed yet',
                    style_class: 'nook-empty-title', x_align: Clutter.ActorAlign.CENTER }));
                empty.add_child(new St.Label({ text: view === 'open' ? 'Add something above to get started.' : 'Ticked-off tasks land here.',
                    style_class: 'nook-empty-sub', x_align: Clutter.ActorAlign.CENTER }));
                list.add_child(empty);
            } else {
                for (let t of items)
                    list.add_child(this._buildTaskRow(t));
            }
            footer.set_text(view === 'open'
                ? `${this._taskSource.doneToday} done today · click a task to edit`
                : `${done.length} completed`);
            if (this.isExpanded && this._activeTab === 'tasks')
                this._resizeToContent();
        };
        this._mount(panel);
        this._tasksUi = { fill, entry };
        fill();
    },

    // ------------------------------------------------------------ Focus

    _renderFocusTab() {
        this._swUi = null;
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-focus', ...VERTICAL, x_expand: true });

        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(this._buildFocusModeSwitch());
        let phase = new St.Label({ style_class: 'nook-phase-chip', y_align: Clutter.ActorAlign.CENTER });
        phase.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        head.add_child(phase);
        head.add_child(new St.Widget({ x_expand: true }));
        let silence = new St.Button({ style_class: 'nook-chip', can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        let silenceRow = new St.BoxLayout();
        silenceRow.add_child(new St.Icon({ icon_name: 'notifications-disabled-symbolic', icon_size: 13, y_align: Clutter.ActorAlign.CENTER }));
        silenceRow.add_child(new St.Label({ text: 'Silence alerts', y_align: Clutter.ActorAlign.CENTER }));
        silence.set_child(silenceRow);
        silence.connect('clicked', () => this._prod.setSilence(!this._prod.focus.silence));
        addPressFeedback(silence);
        head.add_child(silence);
        panel.add_child(head);

        // The big ring with the countdown over it.
        let body = new St.BoxLayout({ style_class: 'nook-focus-body', x_expand: true });
        let ringStack = new St.Widget({ layout_manager: new Clutter.BinLayout() });
        let ring = new FocusRing(168, 11);
        ringStack.add_child(ring);
        let center = new St.BoxLayout({ ...VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        let time = new St.Label({ style_class: 'nook-focus-time', x_align: Clutter.ActorAlign.CENTER });
        let sub = new St.Label({ style_class: 'nook-focus-sub', x_align: Clutter.ActorAlign.CENTER });
        center.add_child(time);
        center.add_child(sub);
        ringStack.add_child(center);
        body.add_child(ringStack);

        // Right column: presets, controls, today's stats.
        let side = new St.BoxLayout({ style_class: 'nook-focus-side', ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        side.add_child(eyebrow('LENGTH'));
        let presets = new St.BoxLayout({ style_class: 'nook-chip-row' });
        let presetBtns = {};
        for (let min of FOCUS_PRESETS) {
            let b = new St.Button({ style_class: 'nook-chip', label: `${min} min`, can_focus: true });
            b.connect('clicked', () => this._prod.setPreset(min));
            addPressFeedback(b);
            presets.add_child(b);
            presetBtns[min] = b;
        }
        side.add_child(presets);

        let controls = new St.BoxLayout({ style_class: 'nook-focus-controls' });
        let reset = iconButton('view-refresh-symbolic', 'nook-round-btn', () => this._prod.resetFocus(), 'Reset');
        let main = new St.Button({ style_class: 'nook-focus-main', can_focus: true });
        let mainRow = new St.BoxLayout({ x_align: Clutter.ActorAlign.CENTER });
        let mainIcon = new St.Icon({ icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        let mainLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        mainRow.add_child(mainIcon);
        mainRow.add_child(mainLabel);
        main.set_child(mainRow);
        main.connect('clicked', () => this._prod.toggleFocus());
        addPressFeedback(main);
        let skip = iconButton('media-skip-forward-symbolic', 'nook-round-btn', () => this._prod.skipFocus(), 'Skip');
        controls.add_child(reset);
        controls.add_child(main);
        controls.add_child(skip);
        side.add_child(controls);

        let stats = new St.BoxLayout({ style_class: 'nook-focus-stats' });
        let dots = new St.BoxLayout({ style_class: 'nook-cycle-dots', y_align: Clutter.ActorAlign.CENTER });
        let dotActors = [];
        for (let i = 0; i < 4; i++) {
            let d = new St.Widget({ style_class: 'nook-cycle-dot' });
            dots.add_child(d);
            dotActors.push(d);
        }
        stats.add_child(dots);
        let statsLabel = label('', 'nook-card-meta');
        stats.add_child(statsLabel);
        side.add_child(stats);
        body.add_child(side);
        panel.add_child(body);

        let update = () => {
            let f = this._prod.focus;
            let breakTime = f.phase === 'break';
            let accent = breakTime ? '#5bdb9e' : accentHex();
            ring.set(f.phase === 'idle' ? 0 : f.progress, breakTime ? BREAK_GREEN : null, f.phase !== 'idle' && !f.running);
            time.set_text(fmtCountdown(f.remainingMs));
            sub.set_text(f.phase === 'idle' ? 'ready when you are' : !f.running ? 'paused'
                : breakTime ? 'stretch, breathe' : `of ${Math.round(f.durationMs / 60000)} min`);
            phase.set_text(f.phase === 'idle' ? 'READY' : breakTime ? 'BREAK' : 'FOCUS');
            phase.set_style(`color: ${accent}; background-color: ${breakTime ? 'rgba(91, 219, 158, 0.14)' : `rgba(${accentRgbStr()}, 0.14)`};`);
            silence.set_style(f.silence ? `color: ${accentHex()}; border-color: rgba(${accentRgbStr()}, 0.45);` : null);
            for (let [min, b] of Object.entries(presetBtns)) {
                let on = Number(min) === f.presetMin;
                b.set_style(on ? `background-color: rgba(${accentRgbStr()}, 0.20); border-color: rgba(${accentRgbStr()}, 0.5); color: #fff;` : null);
                b.reactive = f.phase === 'idle';
                b.opacity = f.phase === 'idle' || on ? 255 : 110;
            }
            mainIcon.icon_name = f.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            mainLabel.set_text(f.phase === 'idle' ? 'Start focus' : f.running ? 'Pause' : 'Resume');
            main.set_style(`background-color: ${accent};`);
            reset.reactive = f.phase !== 'idle';
            reset.opacity = f.phase !== 'idle' ? 255 : 90;
            skip.reactive = f.phase !== 'idle';
            skip.opacity = f.phase !== 'idle' ? 255 : 90;
            let cycle = (this._prod._focus.cycle ?? 0) % 4;
            dotActors.forEach((d, i) => d.set_style(i < cycle ? `background-color: ${accentHex()};` : null));
            statsLabel.set_text(f.sessionsToday
                ? `${f.sessionsToday} session${f.sessionsToday === 1 ? '' : 's'} · ${fmtMinutes(f.focusMinToday)} today`
                : 'Long break after 4 sessions');
        };
        this._mount(panel);
        this._focusUi = { update };
        update();
    },

    _refreshFocusTab() {
        this._focusUi?.update();
    },

    // ------------------------------------------------------------ Notes

    _renderNotesTab() {
        let panel = new St.BoxLayout({ style_class: 'notchnux-panel nook-notes', ...VERTICAL, x_expand: true });
        let ui = { openId: null, entry: null };
        this._notesUi = ui;
        // Every store write the board itself makes is wrapped in this, so the
        // 'notes' event it triggers does not rebuild what it just built.
        let own = fn => {
            this._notesSelf = true;
            try {
                return fn();
            } finally {
                this._notesSelf = false;
            }
        };
        let body = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_expand: true });
        panel.add_child(body);

        // Pure render of the board; never touches the keyboard grab, so the
        // timer and event paths can use it from a hidden tab.
        ui.render = () => {
            ui.openId = this._notesOpenId = null;
            ui.entry = null;
            body.destroy_all_children();
            this._fillNotesBoard(body, ui, own);
        };
        // The user left the editor (Back, Esc, Delete): drop an empty note and
        // hand the keyboard back unless a keyboard-opened dashboard keeps it.
        ui.showBoard = () => {
            if (ui.openId) {
                let n = this._prod.getNote(ui.openId);
                if (n && !n.text.trim())
                    own(() => this._prod.removeNote(n.id));
            }
            let focus = global.stage.get_key_focus();
            if (focus && focus === ui.entry?.clutter_text)
                global.stage.set_key_focus(null);
            ui.render();
            this._queueKeyboardRelease();
        };
        // The editor binds to this note id once; it survives a re-render of
        // the tab through _notesOpenId.
        ui.showEditor = id => {
            if (!this._prod.getNote(id)) {
                ui.render();
                return;
            }
            ui.openId = this._notesOpenId = id;
            body.destroy_all_children();
            this._fillNotesEditor(body, ui, own, id);
        };

        if (this._notesOpenId && this._prod.getNote(this._notesOpenId))
            ui.showEditor(this._notesOpenId);
        else
            ui.render();
        this._mount(panel);
    },

    // Expand the notch on the Notes tab with this note open (desktop post-it
    // double-click). Reuses the board's own showEditor path.
    _openNoteInEditor(id) {
        if (!this._prod?.getNote(id))
            return;
        this._notesOpenId = id;
        if (!this.isExpanded)
            this.expand();
        this._switchTab('notes');
        this._notesUi?.showEditor(id);
    },

    // Esc with the editor open leaves it for the board. True when handled.
    _notesEscape() {
        let ui = this._notesUi;
        if (this._activeTab !== 'notes' || !ui?.openId)
            return false;
        ui.showBoard();
        return true;
    },

    // Only the latest deletion is undoable. It lives here, not in an actor,
    // so a re-render of the board keeps showing the bar until it times out.
    _notesSetUndo(note) {
        this._notesClearUndo();
        let u = { note, id: 0 };
        u.id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            u.id = 0;
            if (this._destroyed || this._notesUndo !== u)
                return GLib.SOURCE_REMOVE;
            this._notesUndo = null;
            this._markTabDirty('notes');
            if (this._notesUi && !this._notesUi.openId && this.isExpanded && this._activeTab === 'notes')
                this._notesUi.render();
            return GLib.SOURCE_REMOVE;
        });
        this._notesUndo = u;
    },

    // Put a button/label's text back after 1.5 s; dies with the actor.
    _notesRevert(actor, original) {
        if (actor._revertId)
            GLib.Source.remove(actor._revertId);
        actor._revertId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            actor._revertId = 0;
            if (!this._destroyed) {
                if (actor.set_text) actor.set_text(original);
                else actor.label = original;
            }
            return GLib.SOURCE_REMOVE;
        });
        actor.connect('destroy', () => {
            if (actor._revertId) {
                GLib.Source.remove(actor._revertId);
                actor._revertId = 0;
            }
        });
    },

    _notesClearUndo() {
        if (this._notesUndo?.id)
            GLib.Source.remove(this._notesUndo.id);
        this._notesUndo = null;
    },

    // Leaving the tab (switch or collapse) with an empty note open drops it.
    _leaveNotesTab() {
        let ui = this._notesUi;
        if (!ui?.openId)
            return;
        let n = this._prod.getNote(ui.openId);
        if (n && !n.text.trim()) {
            this._notesSelf = true;
            try {
                this._prod.removeNote(n.id);
            } finally {
                this._notesSelf = false;
            }
        }
        if (!this._prod.getNote(ui.openId)) {
            ui.openId = this._notesOpenId = null;
            this._markTabDirty('notes');
        }
    },

    _fillNotesBoard(body, ui, own) {
        let notes = this._prod.notes;
        let head = new St.BoxLayout({ style_class: 'nook-section-head', x_expand: true });
        head.add_child(label('Notes', 'nook-section-title'));
        head.add_child(label(`${notes.length}`, 'nook-card-meta nook-notes-status'));
        body.add_child(head);
        if (this._notesUndo) {
            let bar = new St.BoxLayout({ style_class: 'nook-postit-undo', x_expand: true });
            bar.add_child(label('Note deleted', 'nook-card-meta'));
            bar.add_child(new St.Widget({ x_expand: true }));
            let undo = new St.Button({ style_class: 'nook-clear-btn', label: 'Undo', can_focus: true });
            undo.connect('clicked', () => {
                let note = this._notesUndo?.note;
                this._notesClearUndo();
                if (note)
                    this._prod.restoreNote(note);
                this._notesUi?.render();
            });
            bar.add_child(undo);
            body.add_child(bar);
        }

        let scroll = new St.ScrollView({ style_class: 'nook-postit-scroll', x_expand: true });
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let layout = new Clutter.GridLayout({ column_homogeneous: true, column_spacing: 8, row_spacing: 8 });
        let grid = new St.Widget({ layout_manager: layout, x_expand: true });

        let cards = notes.map(n => {
            let btn = new St.Button({ style_class: `nook-postit nook-postit-${n.color}`, can_focus: true,
                x_expand: true, reactive: true });
            btn.set_height(NOTE_CARD_H);
            let box = new St.BoxLayout({ ...VERTICAL, x_expand: true });
            let lines = n.text.split('\n').slice(0, 4).join('\n');
            let t = label(lines.trim() ? lines : 'Empty note', 'nook-postit-text');
            if (!lines.trim())
                t.add_style_class_name('nook-postit-empty');
            t.clutter_text.line_wrap = true;
            t.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            t.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            t.set_height(NOTE_TEXT_H);
            box.add_child(t);
            box.add_child(new St.Widget({ y_expand: true }));
            box.add_child(label(`edited ${noteAgo(n.updated)}`, 'nook-card-meta nook-postit-age'));
            btn.set_child(box);
            let id = n.id;
            btn.connect('clicked', () => this._notesUi?.showEditor(id));
            return btn;
        });

        let add = new St.Button({ style_class: 'nook-postit nook-postit-add', can_focus: true, x_expand: true,
            reactive: true });
        add.set_height(NOTE_CARD_H);
        let addLabel = label('+', 'nook-postit-plus', { x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        add.set_child(addLabel);
        add.connect('clicked', () => {
            let id;
            try {
                id = own(() => this._prod.addNote('', 'yellow'));
            } catch (e) {
                if (e.message !== 'TooManyNotes') {
                    logError(e, 'notes: add failed');
                    return;
                }
                addLabel.set_text('50 max');
                this._notesRevert(addLabel, '+');
                return;
            }
            this._notesUi?.showEditor(id);
        });
        cards.push(add);

        cards.forEach((c, i) => layout.attach(c, i % 2, Math.floor(i / 2), 1, 1));
        let wrap = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        wrap.add_child(grid);
        scroll.set_child(wrap);
        body.add_child(scroll);
    },

    _fillNotesEditor(body, ui, own, id) {
        let note = () => this._prod.getNote(id);
        let hex = () => NOTE_COLORS[note()?.color] ?? NOTE_COLORS.yellow;
        let scroll = new St.ScrollView({ style_class: 'nook-postit-edit', x_expand: true });

        let head = new St.BoxLayout({ style_class: 'nook-section-head nook-postit-bar', x_expand: true });
        head.add_child(iconButton('go-previous-symbolic', 'nook-clear-btn', () => ui.showBoard(), 'Back to notes'));
        let dots = new Map();
        let paint = () => {
            for (let [c, d] of dots) {
                if (c === note()?.color) d.add_style_class_name('nook-postit-dot-on');
                else d.remove_style_class_name('nook-postit-dot-on');
            }
            scroll.set_style(`background-color: ${rgba(hex(), 0.22)}; border-left: 3px solid ${hex()};`);
        };
        for (let c of Object.keys(NOTE_COLORS)) {
            let d = new St.Button({ style_class: 'nook-postit-dot', can_focus: true, reactive: true });
            d.set_style(`background-color: ${NOTE_COLORS[c]};`);
            d.accessible_name = `${c} note`;
            d.connect('clicked', () => {
                own(() => this._prod.setNoteColor(id, c));
                paint();
            });
            dots.set(c, d);
            head.add_child(d);
        }
        head.add_child(new St.Widget({ x_expand: true }));
        let pin = new St.Button({ style_class: 'nook-clear-btn nook-postit-pin', label: 'Pin to desktop',
            toggle_mode: true, can_focus: true, checked: !!note()?.pinned });
        pin.connect('clicked', () => own(() => this._prod.pinNote(id, pin.checked)));
        head.add_child(pin);
        let copy = new St.Button({ style_class: 'nook-clear-btn', label: 'Copy', can_focus: true });
        copy.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, note()?.text ?? '');
            copy.label = 'Copied';
            this._notesRevert(copy, 'Copy');
        });
        head.add_child(copy);
        let del = new St.Button({ style_class: 'nook-clear-btn nook-danger', label: 'Delete', can_focus: true });
        del.connect('clicked', () => {
            let removed = own(() => this._prod.removeNote(id));
            if (removed)
                this._notesSetUndo(removed);
            ui.showBoard();
        });
        head.add_child(del);
        body.add_child(head);

        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_overlay_scrollbars(true);
        let entry = new St.Entry({ style_class: 'nook-notes-entry', hint_text: 'Jot something down… it saves as you type.',
            can_focus: true, x_expand: true, text: note()?.text ?? '' });
        let text = entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // Connected before _makeTypable's handler, which stops Esc.
        text.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            ui.showBoard();
            return Clutter.EVENT_STOP;
        });
        this._makeTypable(entry);
        ui.entry = entry;
        let wrap = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        wrap.add_child(entry);
        scroll.set_child(wrap);
        body.add_child(scroll);

        let footer = label('', 'nook-card-meta');
        body.add_child(footer);
        let words = () => {
            let t = entry.get_text().trim();
            let n = t ? t.split(/\s+/).length : 0;
            footer.set_text(`${n} word${n === 1 ? '' : 's'} · saved on this computer only`);
        };
        words();
        paint();

        text.connect('text-changed', () => {
            if (note()) {
                try {
                    own(() => this._prod.updateNote(id, entry.get_text()));
                } catch (e) {
                    logError(e, 'notes editor save failed');
                }
            }
            words();
        });
        // Keep the caret in view as the note grows past the scroll area.
        text.connect('cursor-changed', () => {
            let adj = scroll.get_vadjustment();
            let [ok, , y, lineH] = text.position_to_coords(text.get_cursor_position());
            if (!ok || !adj) return;
            if (y < adj.value)
                adj.value = y;
            else if (y + lineH > adj.value + adj.page_size)
                adj.value = y + lineH - adj.page_size + 8;
        });
        if (!note()?.text)
            text.grab_key_focus();
    },
};

export function installProductivity(proto) {
    for (let [name, fn] of Object.entries(ProductivityTabs))
        proto[name] = fn;
}
