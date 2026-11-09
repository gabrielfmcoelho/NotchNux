// The Inova Data rabbit companion at the pill's left edge: a sprite on a strip
// of dot grass. Behaviour comes from companion-brain.js; this only plays it.
//
// Frames are symbolic SVGs from tools/rabbit-rig (recoloured by CSS). An act
// steps them at 12 fps while the hop arc tweens at the display rate. Between
// acts nothing runs but one timer: a resting pill costs no redraws.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { diffEvents, strongest, restAct, ambient, rank, REACTION_ACT } from './companion-brain.js';

const DIR = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('rabbit');
const SPEC = JSON.parse(new TextDecoder().decode(DIR.get_child('acts.json').load_contents(null)[1]));
const FRAME_MS = Math.round(1000 / SPEC.fps);
const FRAME_NAMES = [...new Set(Object.values(SPEC.acts).flatMap(a => a.frames))];

const W = 36, H = 30, GROUND = 26;   // zone size; feet line (clear of the pill's rounded bottom)
const SPRITE = 32;                   // icon box; the drawn rabbit is ~22 px tall
const AWAY_MS = 10 * 60 * 1000;

export const RabbitCompanion = GObject.registerClass(
class RabbitCompanion extends St.Widget {
    // getState(): { focus, music, low, charging, hour, calm } from the notch.
    _init(getState) {
        super._init({ style_class: 'nn-pill-rabbit-zone', width: W, height: H, y_align: Clutter.ActorAlign.CENTER });
        this._getState = getState;
        this._claude = { mood: 'idle', fresh: 0, color: null };
        this._away = false;
        this._state = null;
        this._act = null;          // { name, rank }
        this._stepId = 0;
        this._ambientId = 0;
        this._scroll = 0;
        this._bend = false;
        this._pending = null;      // a reaction that came while hidden

        this._grass = new St.DrawingArea({ width: W, height: H });
        this._grass.connect('repaint', area => this._drawGrass(area));
        this.add_child(this._grass);

        // Every frame is an icon kept mapped at opacity 0, so its texture loads
        // up front; showing a frame flips opacity. Swapping one icon's gicon (or
        // un-hiding a hidden one) loads asynchronously and played blank frames.
        // Clutter skips painting fully transparent actors.
        this._sprite = new St.Widget({ style_class: 'nn-pill-rabbit', width: SPRITE, height: SPRITE });
        this._sprite.set_position((W - SPRITE) / 2, GROUND - SPRITE + 3);
        this._frames = new Map(FRAME_NAMES.map(n => [n, new St.Icon({
            gicon: new Gio.FileIcon({ file: DIR.get_child(n) }), icon_size: SPRITE, opacity: 0 })]));
        for (let f of this._frames.values())
            this._sprite.add_child(f);
        this._shown = null;
        this._show(SPEC.acts.sit.frames[0]);
        this.add_child(this._sprite);

        // Away = no input for 10 minutes (sleeps); input again wakes it with a stretch.
        this._idleMon = global.backend.get_core_idle_monitor();
        this._idleWatch = this._idleMon.add_idle_watch(AWAY_MS, () => {
            this._away = true;
            this.update();
            this._activeWatch = this._idleMon.add_user_active_watch(() => {
                this._activeWatch = 0;
                this._away = false;
                this.update();
            });
        });

        this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._cut();          // dashboard open or pill hidden: stop mid-act
            } else if (this._pending) {
                let ev = this._pending;   // e.g. Claude finished while the dashboard was open
                this._pending = null;
                this.react(ev);
                return;
            }
            this._scheduleAmbient();
        });
        this.connect('destroy', () => {
            this._cut();
            this._clearAmbient();
            for (let id of [this._idleWatch, this._activeWatch])
                if (id)
                    this._idleMon.remove_watch(id);
        });
        this.update();
        this._settle();
    }

    _show(name) {
        if (this._shown === name)
            return;
        if (this._shown)
            this._frames.get(this._shown).opacity = 0;
        this._frames.get(name).opacity = 255;
        this._shown = name;
    }

    // From the Claude sync: mood (idle/working/waiting), how many sessions
    // finished unseen, and the mood colour (the matching pill dot's).
    setClaude(mood, fresh, color) {
        this._claude = { mood, fresh, color };
        this.update();
    }

    // Something the notch saw: re-read the state, react to what changed.
    update() {
        let next = { ...this._getState(), mood: this._claude.mood, fresh: this._claude.fresh, away: this._away };
        let prev = this._state ?? next;
        this._state = next;
        this._sprite.set_style(this._claude.color ? `color: ${this._claude.color};` : null);
        let ev = strongest(diffEvents(prev, next));
        if (ev)
            this.react(ev);
        else if (restAct(prev) !== restAct(next) || prev.mood !== next.mood || prev.calm !== next.calm ||
                 prev.focus !== next.focus || prev.music !== next.music) {
            if (this._act)
                this._scheduleAmbient();
            else
                this._settle();   // new rest pose (sleep, flop, tired) and timer
        }
    }

    // A one-off reaction (also called directly for notifications).
    react(event) {
        if (!this._canMove()) {
            if (this.visible && St.Settings.get().enable_animations)
                this._pending = strongest([this._pending, event].filter(Boolean));
            return;
        }
        if (this._act && rank(event) > this._act.rank)
            return;   // a stronger reaction is playing
        this._play(REACTION_ACT[event], rank(event));
    }

    _canMove() {
        return this.mapped && this.visible && St.Settings.get().enable_animations;
    }

    _play(name, r = Infinity) {
        this._cut();
        this._clearAmbient();
        if (!this._canMove()) {
            this._scheduleAmbient();
            return;
        }
        let a = SPEC.acts[name];
        this._act = { name, rank: r };
        let i = 0;
        let step = () => {
            let y = a.y[i];
            let landed = y === 0 && i > 0 && a.y[i - 1] < 0;
            this._show(a.frames[i]);
            this._sprite.ease({ translation_y: y, duration: FRAME_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            if (name === 'run' || landed !== this._bend) {
                this._scroll += name === 'run' ? 2 : 0;
                this._bend = landed;
                this._grass.queue_repaint();
            }
            i++;
            if (i < a.frames.length)
                return GLib.SOURCE_CONTINUE;
            this._stepId = 0;
            this._act = null;
            this._settle();
            return GLib.SOURCE_REMOVE;
        };
        step();
        if (this._act)   // more than one frame
            this._stepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step);
    }

    // Stop any act and snap to the rest pose.
    _cut() {
        if (this._stepId)
            GLib.source_remove(this._stepId);
        this._stepId = 0;
        this._act = null;
        this._settle();
    }

    _settle() {
        this._sprite.remove_transition('translation_y');
        this._sprite.translation_y = 0;
        this._show(SPEC.acts[restAct(this._state ?? { mood: 'idle', focus: 'idle', hour: 12 })].frames.at(-1));
        if (this._bend) {
            this._bend = false;
            this._grass.queue_repaint();
        }
        if (!this._stepId)
            this._scheduleAmbient();
    }

    _clearAmbient() {
        if (this._ambientId)
            GLib.source_remove(this._ambientId);
        this._ambientId = 0;
    }

    _scheduleAmbient() {
        this._clearAmbient();
        if (this._act || !this._state || !this.mapped)
            return;
        let next = ambient(this._state, Math.random());
        if (!next)
            return;   // sleeping, tired, flopped or calm: no timer at all
        this._ambientId = GLib.timeout_add(GLib.PRIORITY_LOW, next.delay, () => {
            this._ambientId = 0;
            this._play(next.act);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Dot grass, the wallpaper's style: a wavy row of fading dots under the feet.
    _drawGrass(area) {
        let cr = area.get_context();
        let s = this._scroll;
        for (let x = 1; x < W; x += 3) {
            let xx = x - (s % 3);
            let y = GROUND + 0.5 + 0.8 * Math.sin(xx / 5 + s / 4);
            let edge = Math.min(1, xx / 8, (W - xx) / 8);   // fade at both ends
            let a = Math.max(0, edge) * (0.25 + 0.25 * (0.5 + 0.5 * Math.sin(xx / 9)));
            cr.setSourceRGBA(0.75, 0.74, 0.8, a);
            let lean = this._bend && Math.abs(xx - W / 2) < 9 ? Math.sign(xx - W / 2) : 0;
            cr.rectangle(xx + lean, y - (lean ? 1 : 0), 1, 1);
            cr.fill();
        }
        cr.$dispose();
    }
});
