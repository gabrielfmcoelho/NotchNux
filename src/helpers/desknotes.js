// Post-it notes pinned to the desktop.
//
// One 180x180 card per pinned note, inserted directly above the wallpaper
// (Main.layoutManager._backgroundGroup) in its parent, the same layer
// wptransition.js uses: on the wallpaper, under every window. Dragging uses
// plain press/motion/release handlers (no Clutter.DragAction) so it behaves
// the same on GNOME 46-51; the position is saved only on release. A note that
// ends up outside every monitor's work area (dragged off, monitor unplugged)
// is pulled back inside the primary monitor's work area on the next layout.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { NOTE_COLORS } from './productivity.js';
import { logError } from './log.js';

const SIZE = 180;
const CASCADE = 24;
const MARGIN = 24;
const DRAG_THRESHOLD = 4;
const DOUBLE_CLICK_MS = 400;

function cardStyle(color) {
    let hex = NOTE_COLORS[color] ?? NOTE_COLORS.yellow;
    let n = parseInt(hex.slice(1), 16);
    return `background-color: rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0.85); `
        + 'border-radius: 12px; padding: 14px; '
        + 'box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);';
}

export class DeskNotes {
    constructor(store, { onOpen } = {}) {
        this._store = store;
        this._onOpen = onOpen ?? (() => {});
        this._cards = new Map();   // id -> { actor, label, color, placed }
        this._drag = null;
        this._lastPress = { id: null, time: 0 };
        this._destroyed = false;

        this._unsub = store.subscribe(kind => {
            if (kind === 'notes')
                this.sync();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this.sync());
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncVisible());
        this.sync();
    }

    _workAreas() {
        let areas = [];
        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            areas.push(Main.layoutManager.getWorkAreaForMonitor(i));
        return areas;
    }

    _primaryArea() {
        return Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    }

    _clampTo(area, x, y) {
        return [
            Math.round(Math.min(Math.max(x, area.x), area.x + area.width - SIZE)),
            Math.round(Math.min(Math.max(y, area.y), area.y + area.height - SIZE)),
        ];
    }

    // True when the card lies fully inside some monitor's work area.
    _inside(x, y) {
        return this._workAreas().some(a =>
            x >= a.x && y >= a.y && x + SIZE <= a.x + a.width && y + SIZE <= a.y + a.height);
    }

    _create(note) {
        let label = new St.Label({ style: 'color: #1c1c1e; font-size: 13px;', x_expand: true, y_expand: true });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        label.clutter_text.set_single_line_mode(false);
        let actor = new St.BoxLayout({
            reactive: true, track_hover: true, width: SIZE, height: SIZE,
            style: cardStyle(note.color),
        });
        actor.add_child(label);
        actor.connect('button-press-event', (a, ev) => this._onPress(note.id, a, ev));
        actor.connect('motion-event', (a, ev) => this._onMotion(note.id, ev));
        actor.connect('button-release-event', (a, ev) => this._onRelease(note.id, ev));
        actor.connect('destroy', () => {
            if (this._drag?.id === note.id)
                this._endDrag();
        });

        let group = Main.layoutManager._backgroundGroup;
        let parent = group?.get_parent() ?? Main.layoutManager.uiGroup;
        if (group && group.get_parent())
            parent.insert_child_above(actor, group);
        else
            parent.add_child(actor);
        return { actor, label, color: note.color, placed: false };
    }

    sync() {
        if (this._destroyed)
            return;
        let pinned = this._store.notes.filter(n => n.pinned);
        let ids = new Set(pinned.map(n => n.id));

        for (let [id, card] of [...this._cards]) {
            if (!ids.has(id)) {
                if (this._drag?.id === id)
                    this._endDrag();
                card.actor.destroy();
                this._cards.delete(id);
            }
        }

        for (let note of pinned) {
            let card = this._cards.get(note.id);
            if (!card) {
                card = this._create(note);
                this._cards.set(note.id, card);
            }
            card.label.set_text(note.text);
            if (card.color !== note.color) {
                card.color = note.color;
                card.actor.set_style(cardStyle(note.color));
            }
            if (this._drag?.id === note.id)
                continue;
            this._place(note, card);
        }
        this._syncVisible();
    }

    _place(note, card) {
        let x, y;
        if (note.pos) {
            x = note.pos.x; y = note.pos.y;
            if (!this._inside(x, y))
                [x, y] = this._clampTo(this._primaryArea(), x, y);
        } else {
            // Cascade from the primary work area's top-right corner, 24 px
            // per note already placed.
            let a = this._primaryArea();
            let slot = 0;
            for (let [id, c] of this._cards) {
                if (id !== note.id && c.placed)
                    slot++;
            }
            [x, y] = this._clampTo(a, a.x + a.width - SIZE - MARGIN - slot * CASCADE, a.y + MARGIN + slot * CASCADE);
        }
        card.actor.set_position(x, y);
        card.placed = true;
        if (!note.pos || note.pos.x !== x || note.pos.y !== y)
            this._store.moveNote(note.id, x, y);
    }

    // The background group is covered by the lock screen, but hide the cards
    // too so nothing can show through on the lock/unlock transitions.
    _syncVisible() {
        let show = !Main.sessionMode.isLocked;
        for (let { actor } of this._cards.values())
            actor.visible = show;
    }

    // ---------------------------------------------------------------- drag

    _onPress(id, actor, ev) {
        if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        let [px, py] = ev.get_coords();
        let [ax, ay] = actor.get_position();
        this._endDrag();
        this._drag = { id, actor, dx: px - ax, dy: py - ay, sx: px, sy: py, moved: false, grab: null };
        try {
            this._drag.grab = global.stage.grab(actor);
        } catch (e) {
            // The implicit pointer grab still delivers motion and release.
            this._drag.grab = null;
        }
        return Clutter.EVENT_STOP;
    }

    _onMotion(id, ev) {
        let d = this._drag;
        if (!d || d.id !== id)
            return Clutter.EVENT_PROPAGATE;
        let [px, py] = ev.get_coords();
        if (!d.moved) {
            if (Math.hypot(px - d.sx, py - d.sy) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            d.moved = true;
        }
        d.actor.set_position(Math.round(px - d.dx), Math.round(py - d.dy));
        return Clutter.EVENT_STOP;
    }

    _onRelease(id, ev) {
        let d = this._drag;
        if (!d || d.id !== id || ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (d.moved) {
            let [px, py] = ev.get_coords();
            // Monitor under the pointer (plain geometry; no Mtk rect needed).
            let idx = Main.layoutManager.monitors.findIndex(m =>
                px >= m.x && py >= m.y && px < m.x + m.width && py < m.y + m.height);
            if (idx < 0)
                idx = Main.layoutManager.primaryIndex;
            let [cx, cy] = this._clampTo(Main.layoutManager.getWorkAreaForMonitor(idx),
                px - d.dx, py - d.dy);
            d.actor.set_position(cx, cy);
            this._endDrag();
            this._store.moveNote(id, cx, cy);
            this._lastPress = { id: null, time: 0 };
        } else {
            this._endDrag();
            let now = ev.get_time?.() || Date.now();
            if (this._lastPress.id === id && now - this._lastPress.time <= DOUBLE_CLICK_MS) {
                this._lastPress = { id: null, time: 0 };
                try { this._onOpen(id); } catch (e) { logError('desknotes open', e); }
            } else {
                this._lastPress = { id, time: now };
            }
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        let d = this._drag;
        this._drag = null;
        if (d?.grab) {
            try { d.grab.dismiss(); } catch (e) { /* already gone */ }
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._endDrag();
        this._unsub?.();
        this._unsub = null;
        if (this._monitorsId)
            Main.layoutManager.disconnect(this._monitorsId);
        if (this._sessionId)
            Main.sessionMode.disconnect(this._sessionId);
        this._monitorsId = this._sessionId = 0;
        for (let { actor } of this._cards.values())
            actor.destroy();
        this._cards.clear();
    }
}
