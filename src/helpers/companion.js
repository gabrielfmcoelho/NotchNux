// The companion at the pill's left edge: one animal (rabbit, cat or fox, chosen
// in Preferences) living on a strip of dot grass. Behaviour comes from
// companion-brain.js; this plays it and draws the world.
//
// Frames are symbolic SVGs from tools/rabbit-rig (recoloured by CSS). An act
// steps them at 12 fps while the hop arc tweens at the display rate. Between
// acts it breathes (one frame swap every 0.8 s) and waits for its next move.
// The meadow is 60 px while you are busy and 120 px while it has a life to
// live; the pill follows. Rain, snow and night repaint the grass at most once
// a second, and only while idle and on screen.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    diffEvents, strongest, restAct, ambient, breathing, rank, REACTION_ACT, meadow, wantsMushroom, sheltering, facing,
    isIdle, cleanSpecies,
} from './companion-brain.js';
import { accentHex } from './widgets.js';

const ROOT = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('companions');
const COMPACT = 60, WIDE = 120, H = 30, GROUND = 26;   // meadow widths; feet line (clear of the pill's rounded bottom)
const SPRITE = 32;                                     // icon box; the drawn animal is ~22 px tall
const PROP = 24;                                       // prop icon box, ground at its y=22
const AWAY_MS = 10 * 60 * 1000;
const NARROW_HOLD_MS = 30 * 1000;                      // wait before giving the width back
const WORLD_MS = 1000;                                 // rain / fireflies repaint
const PET_AGAIN_MS = 1500;                             // a second click this soon opens the dashboard
const PROPS = ['mushroom', 'bit', 'flower-bud', 'flower', 'leaf', 'drop', 'flake'];
const FOODS = ['whole', 'half', 'stub'];

function rgb(hex) {
    let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex) ?? ['', 'aa', 'aa', 'ff'];
    return [1, 2, 3].map(i => parseInt(m[i], 16) / 255);
}

export const Companion = GObject.registerClass(
class Companion extends St.Widget {
    // getState(): see companion-brain.js. onWidth(): the pill re-measures.
    // onMemory(key, value): remember a day key or a count in the config.
    _init(getState, { species = 'rabbit', onWidth = null, onMemory = null } = {}) {
        super._init({ style_class: 'nn-pill-rabbit-zone', width: COMPACT, height: H, y_align: Clutter.ActorAlign.CENTER,
            reactive: true });
        this._getState = getState;
        this._onWidth = onWidth;
        this._onMemory = onMemory;
        this._claude = { mood: 'idle', fresh: 0, color: null };
        this._away = false;
        this._state = null;
        this._act = null;          // { name, rank }
        this._queue = [];          // the rest of a sequence
        this._stepId = 0;
        this._ambientId = 0;
        this._narrowId = 0;
        this._worldId = 0;
        this._scroll = 0;
        this._bend = false;
        this._dust = false;
        this._pending = null;      // a reaction that came while hidden
        this._breathId = 0;
        this._inBreath = false;
        this._facing = 1;          // 1 faces right (toward the clock), -1 left
        this._xTarget = null;      // where a hop lands
        this._lastPet = 0;
        this._drops = [];          // [{x, y}] rain or snow
        this._flies = [];          // [{x, y}] fireflies at night
        this._flower = null;       // 'bud' | 'open'

        this._grass = new St.DrawingArea({ width: COMPACT, height: H });
        this._grass.connect('repaint', area => this._drawGrass(area));
        this.add_child(this._grass);

        // Props (food, mushroom, leaf…) sit on the grass in their own box.
        this._props = new St.Widget({ width: PROP, height: PROP, visible: false });
        this._props.set_position(0, GROUND - PROP + 2);
        this.add_child(this._props);
        this._propShown = null;

        this._sprite = new St.Widget({ style_class: 'nn-pill-rabbit', width: SPRITE, height: SPRITE });
        this._sprite.set_position(0, GROUND - SPRITE + 3);
        this._sprite.set_pivot_point(0.5, 1);                 // turns about its feet
        this._sprite.translation_x = (COMPACT - SPRITE) / 2;  // where it sits in the meadow
        this.add_child(this._sprite);
        this._frames = new Map();
        this._propIcons = new Map();
        this._loadSpecies(cleanSpecies(species));

        // Away = no input for 10 minutes (sleeps); input again wakes it.
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

        // A click pets it; a second click right after opens the dashboard as usual.
        this.connect('button-press-event', (a, e) => this._onPress(e.get_button()));

        this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._cut();          // pill hidden: stop mid-act
                this._syncWorld();
            } else if (this._pending) {
                let ev = this._pending;   // e.g. Claude finished while hidden
                this._pending = null;
                this.react(ev);
                return;
            }
            this._scheduleAmbient();
            this._syncWorld();
        });
        this.connect('destroy', () => {
            this._cut();
            this._clearAmbient();
            for (let id of [this._narrowId, this._worldId])
                if (id)
                    GLib.source_remove(id);
            this._narrowId = this._worldId = 0;
            for (let id of [this._idleWatch, this._activeWatch])
                if (id)
                    this._idleMon.remove_watch(id);
        });
        this.update();
        this._settle();
    }

    // A left click pets it and is swallowed; another within PET_AGAIN_MS goes
    // through to the pill (opens the dashboard), as do other buttons.
    _onPress(button) {
        if (button !== 1 || !this._canMove())
            return Clutter.EVENT_PROPAGATE;
        let now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastPet < PET_AGAIN_MS)
            return Clutter.EVENT_PROPAGATE;
        this._lastPet = now;
        this._onMemory?.('pets', 1);
        this.react('pet');
        return Clutter.EVENT_STOP;
    }

    get species() {
        return this._species;
    }

    // Every frame is an icon kept mapped at opacity 0, so its texture loads up
    // front; showing a frame flips opacity. Swapping one icon's gicon (or
    // un-hiding a hidden one) loads asynchronously and played blank frames.
    // Clutter skips painting fully transparent actors.
    _loadSpecies(name) {
        this._species = name;
        let dir = ROOT.get_child(name);
        this._spec = JSON.parse(new TextDecoder().decode(dir.get_child('acts.json').load_contents(null)[1]));
        this._frameMs = Math.round(1000 / this._spec.fps);
        for (let f of this._frames.values())
            f.destroy();
        this._frames.clear();
        this._shown = null;
        for (let n of new Set(Object.values(this._spec.acts).flatMap(a => a.frames))) {
            let icon = new St.Icon({ gicon: new Gio.FileIcon({ file: dir.get_child(n) }), icon_size: SPRITE, opacity: 0 });
            this._frames.set(n, icon);
            this._sprite.add_child(icon);
        }
        for (let p of this._propIcons.values())
            p.destroy();
        this._propIcons.clear();
        this._propShown = null;
        for (let n of [...PROPS.map(p => `prop-${p}`), ...FOODS.map(f => `food-${f}`)]) {
            let icon = new St.Icon({ gicon: new Gio.FileIcon({ file: dir.get_child(`${n}-symbolic.svg`) }), icon_size: PROP, opacity: 0 });
            this._propIcons.set(n, icon);
            this._props.add_child(icon);
        }
    }

    // Change the animal: the old one hops off to the right, the new one hops
    // in from the left.
    setSpecies(name) {
        name = cleanSpecies(name);
        if (name === this._species)
            return;
        let swap = () => {
            this._loadSpecies(name);
            this._sprite.translation_x = -SPRITE + 4;
            this._face(1);
            this._settle();
            this._play([{ act: 'hop', to: (this.width - SPRITE) / 2 }], rank('wake'));
        };
        if (!this._canMove()) {
            swap();
            return;
        }
        this._play([{ act: 'hop', to: this.width - 6 }], rank('wake'), swap);
    }

    // The act's frames, with the earpiece while music plays when it has them.
    _acts(name) {
        return (this._state?.music && this._spec.acts[`${name}@music`]) || this._spec.acts[name];
    }

    _show(name) {
        if (this._shown === name)
            return;
        if (this._shown)
            this._frames.get(this._shown).opacity = 0;
        this._frames.get(name).opacity = 255;
        this._shown = name;
    }

    // Show one prop (or food state) on the grass at x, or hide them all.
    _prop(name, x = null) {
        if (this._propShown)
            this._propIcons.get(this._propShown).opacity = 0;
        this._propShown = name;
        this._props.visible = !!name;
        if (!name)
            return;
        this._propIcons.get(name).opacity = 255;
        if (x !== null)
            this._props.set_x(Math.max(0, Math.min(this.width - PROP, Math.round(x))));
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
        this.set_style(`success-color: ${accentHex()};`);   // LEDs, earpiece, props' accent parts
        this._sprite.set_style(this._claude.color ? `color: ${this._claude.color};` : null);
        this._syncMeadow();
        this._syncWorld();
        this._syncFlower(prev, next);
        let ev = strongest(diffEvents(prev, next));
        if (ev)
            this.react(ev);
        else if (restAct(prev) !== restAct(next) || prev.mood !== next.mood || prev.calm !== next.calm ||
                 prev.focus !== next.focus || prev.music !== next.music || prev.unread !== next.unread ||
                 sheltering(prev) !== sheltering(next)) {
            if (this._act)
                this._scheduleAmbient();
            else
                this._settle();   // new rest pose (sleep, flop, tired) and timer
        }
    }

    // A one-off reaction (the notch also calls this for notifications, calendar
    // heads-ups and track changes).
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

    // ---- the meadow's width ----

    _syncMeadow() {
        let want = meadow(this._state) === 'wide' ? WIDE : COMPACT;
        if (want > this.width) {
            this._clearNarrow();
            this._setWidth(want);
        } else if (want < this.width && !this._narrowId) {
            // give the width back only once things have stayed quiet a while
            this._narrowId = GLib.timeout_add(GLib.PRIORITY_LOW, NARROW_HOLD_MS, () => {
                this._narrowId = 0;
                if (meadow(this._state) === 'wide')
                    return GLib.SOURCE_REMOVE;
                let inside = COMPACT - SPRITE - 2;
                if (this._sprite.translation_x > inside && this._canMove() && !this._act)
                    this._play([{ act: 'hop', to: inside - 4 }], Infinity, () => this._setWidth(COMPACT));
                else
                    this._setWidth(COMPACT);
                return GLib.SOURCE_REMOVE;
            });
        } else if (want === this.width) {
            this._clearNarrow();
        }
    }

    _clearNarrow() {
        if (this._narrowId)
            GLib.source_remove(this._narrowId);
        this._narrowId = 0;
    }

    _setWidth(w) {
        if (w === this.width)
            return;
        this.width = w;
        this._grass.width = w;
        let max = w - SPRITE;
        if (this._sprite.translation_x > max)
            this._sprite.translation_x = max;
        if (this._propShown && this._props.x > w - PROP)
            this._props.set_x(w - PROP);
        this._grass.queue_repaint();
        this._onWidth?.();
    }

    // ---- acts ----

    // Play an act: a frame act name, a composite ('wander', 'turn', 'twostep',
    // 'chase', 'eat', 'snack'), or a list of items { act, to?, onStart? }.
    _play(what, r = Infinity, onDone = null) {
        this._cut();
        this._clearAmbient();
        if (!this._canMove()) {
            this._scheduleAmbient();
            return;
        }
        let items = Array.isArray(what) ? what.map(i => (typeof i === 'string' ? { act: i } : i)) : this._expand(what);
        if (!items.length) {
            this._scheduleAmbient();
            return;
        }
        this._queue = items;
        this._onDone = onDone;
        this._act = { name: items[0].act, rank: r };
        this._runNext();
    }

    // Composite acts become sequences of frame acts with travel and callbacks.
    _expand(name) {
        let x = this._sprite.translation_x;
        let max = this.width - SPRITE;
        let st = this._state ?? {};
        switch (name) {
        case 'turn':
            this._face(-this._facing);
            return [{ act: 'look' }];
        case 'wander':
            return [{ act: 'hop', to: this._wanderTarget() }];
        case 'twostep': {
            let step = Math.min(8, x, max - x);
            return [{ act: 'hop', to: x - step }, { act: 'hop', to: x + step }];
        }
        case 'chase': {
            // a data bit skips along the grass; it hops after it twice, then sniffs where it was
            let b1 = this._farSpot(), b2 = Math.max(0, Math.min(max, b1 + (b1 > x ? 12 : -12)));
            return [
                { act: 'look', onStart: () => this._prop('prop-bit', b1 + 4) },
                { act: 'hop', to: b1 - 6 * Math.sign(b1 - x || 1), onStart: () => this._face(Math.sign(b1 - x) || 1) },
                { act: 'hop', to: b2 - 6 * Math.sign(b2 - b1 || 1), onStart: () => this._prop('prop-bit', b2 + 4) },
                { act: 'sniff', onStart: () => this._prop(null) },
            ];
        }
        case 'eat':
        case 'snack': {
            // food lands at the far side (a snack right here), it hops over and eats it in bites
            let fx = name === 'eat' ? this._farSpot() : x + (this._facing > 0 ? 18 : -10);
            fx = Math.max(0, Math.min(this.width - PROP, fx));
            let stand = Math.max(0, Math.min(max, fx + (fx > x ? -14 : 14)));
            let bites = name === 'eat' ? ['whole', 'half', 'stub'] : ['half', 'stub'];
            let items = [{ act: 'look', onStart: () => {
                this._prop('food-whole', fx);
                if (name === 'eat')
                    this._onMemory?.('lastFed', st.dayKey);
            } }];
            if (name === 'eat')
                items.push({ act: 'hop', to: stand, onStart: () => this._face(fx > x ? 1 : -1) });
            for (let b of bites)
                items.push({ act: 'nibble', onStart: () => this._prop(`food-${b}`, fx) });
            items.push({ act: 'groom', onStart: () => this._prop(null) });
            return items;
        }
        default:
            return this._spec.acts[name] ? [{ act: name }] : [];
        }
    }

    _runNext() {
        let item = this._queue.shift();
        if (!item) {
            this._act = null;
            let done = this._onDone;
            this._onDone = null;
            this._settle();
            done?.();
            return;
        }
        this._act = { name: item.act, rank: this._act?.rank ?? Infinity };
        item.onStart?.();
        let dx = 0;
        if (item.to !== undefined) {
            this._xTarget = Math.max(0, Math.min(this.width - SPRITE, Math.round(item.to)));
            dx = this._xTarget - this._sprite.translation_x;
            if (dx)
                this._face(Math.sign(dx));
        }
        let a = this._acts(item.act);
        let airborne = a.y.filter(y => y < 0).length || 1;
        let i = 0;
        let step = () => {
            let y = a.y[i];
            let landed = y === 0 && i > 0 && a.y[i - 1] < 0;
            this._show(a.frames[i]);
            this._sprite.ease({ translation_y: y, duration: this._frameMs, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            if (dx && y < 0)   // travel only while in the air: no sliding feet
                this._sprite.ease({ translation_x: this._sprite.translation_x + dx / airborne, duration: this._frameMs,
                    mode: Clutter.AnimationMode.LINEAR });
            let dust = item.act === 'dig' && i % 2 === 1;
            if (item.act === 'run' || landed !== this._bend || dust !== this._dust) {
                this._scroll += item.act === 'run' ? 2 : 0;
                this._bend = landed;
                this._dust = dust;
                this._grass.queue_repaint();
            }
            i++;
            if (i < a.frames.length)
                return GLib.SOURCE_CONTINUE;
            this._stepId = 0;
            if (this._xTarget !== null) {
                this._sprite.remove_transition('translation_x');
                this._sprite.translation_x = this._xTarget;
                this._xTarget = null;
            }
            this._runNext();
            return GLib.SOURCE_REMOVE;
        };
        step();
        if (i < a.frames.length)
            this._stepId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._frameMs, step);
    }

    // A spot on the other side of the meadow from where it stands.
    _farSpot() {
        let max = this.width - SPRITE, x = this._sprite.translation_x;
        return x < max / 2 ? max - 2 - Math.round(Math.random() * 6) : 2 + Math.round(Math.random() * 6);
    }

    // A spot at least 10 px away, inside the meadow.
    _wanderTarget() {
        let max = this.width - SPRITE, x = this._sprite.translation_x;
        let t = Math.random() * max;
        if (Math.abs(t - x) < 10)
            t = x < max / 2 ? max - Math.random() * 6 : Math.random() * 6;
        return Math.round(t);
    }

    _face(dir) {
        this._facing = dir;
        this._sprite.scale_x = dir;
    }

    // Stop any act and snap to the rest pose.
    _cut() {
        if (this._stepId)
            GLib.source_remove(this._stepId);
        this._stepId = 0;
        this._act = null;
        this._queue = [];
        this._onDone = null;
        if (this._propShown && this._propShown !== 'prop-leaf' && !this._propShown.startsWith('prop-flower') && this._propShown !== 'prop-mushroom')
            this._prop(null);   // a meal or a chase that was cut
        this._settle();
    }

    _settle() {
        this._sprite.remove_transition('translation_y');
        this._sprite.translation_y = 0;
        if (this._xTarget !== null) {   // cut mid-hop: land where it was heading
            this._sprite.remove_transition('translation_x');
            this._sprite.translation_x = this._xTarget;
            this._xTarget = null;
        }
        this._inBreath = false;
        let st = this._state ?? { mood: 'idle', focus: 'idle' };
        let f = facing(st);
        if (f && f !== this._facing)
            this._face(f);
        this._show(this._acts(restAct(st)).frames.at(-1));
        if (this._bend || this._dust) {
            this._bend = this._dust = false;
            this._grass.queue_repaint();
        }
        this._syncShelter();
        if (!this._stepId)
            this._scheduleAmbient();
    }

    // Clears the idle timers: the next move and the breath.
    _clearAmbient() {
        for (let id of [this._ambientId, this._breathId])
            if (id)
                GLib.source_remove(id);
        this._ambientId = this._breathId = 0;
    }

    _scheduleAmbient() {
        this._clearAmbient();
        if (this._act || !this._state || !this.mapped)
            return;
        this._startBreath();
        if (wantsMushroom(this._state) && this._propShown === null) {
            this._prop('prop-mushroom', this._farSpot() + 4);
            this._onMemory?.('lastMushroom', this._state.dayKey);
        } else if (this._propShown === 'prop-mushroom' && !isIdle(this._state)) {
            this._prop(null);
        }
        let next = ambient(this._state, Math.random());
        if (!next)
            return;   // sleeping, tired, flopped or calm: no next move
        this._ambientId = GLib.timeout_add(GLib.PRIORITY_LOW, next.delay, () => {
            this._ambientId = 0;
            this._play(next.act);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Alternate the rest frame with its in-breath frame.
    _startBreath() {
        let b = breathing(this._state);
        if (!b || !St.Settings.get().enable_animations)
            return;
        let rest = this._acts(restAct(this._state)).frames.at(-1);
        let inhale = this._acts(b.act).frames[0];
        this._breathId = GLib.timeout_add(GLib.PRIORITY_LOW, b.ms / 2, () => {
            this._inBreath = !this._inBreath;
            this._show(this._inBreath ? inhale : rest);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- the world: shelter, flower, rain, night ----

    // In rain or snow it sits under a leaf; the chase/meal props take priority while they run.
    _syncShelter() {
        let st = this._state;
        if (!st)
            return;
        if (sheltering(st) && !this._act) {
            if (this._propShown !== 'prop-leaf')
                this._prop('prop-leaf', this._sprite.translation_x + 4);
        } else if (this._propShown === 'prop-leaf') {
            this._prop(null);
        }
    }

    // A bud grows at the meadow's edge during focus; it opens when the session ends.
    _syncFlower(prev, next) {
        if (next.focus === 'focus' && prev.focus !== 'focus') {
            this._flower = 'bud';
            this._prop('prop-flower-bud', this.width - PROP);
        } else if (prev.focus === 'focus' && next.focus !== 'focus' && this._flower === 'bud') {
            this._flower = 'open';
            this._prop('prop-flower', this.width - PROP);
        } else if (this._flower && this._propShown === null && isIdle(next)) {
            this._prop(this._flower === 'bud' ? 'prop-flower-bud' : 'prop-flower', this.width - PROP);
        }
    }

    // Rain, snow and fireflies move once a second, only while idle and on screen.
    _syncWorld() {
        let st = this._state;
        let want = !!st && this.mapped && this.visible && isIdle(st) && (st.rain || st.snow || st.night);
        if (want && !this._worldId) {
            this._worldId = GLib.timeout_add(GLib.PRIORITY_LOW, WORLD_MS, () => {
                this._tickWorld();
                return GLib.SOURCE_CONTINUE;
            });
            this._tickWorld();
        } else if (!want && this._worldId) {
            GLib.source_remove(this._worldId);
            this._worldId = 0;
            this._drops = [];
            this._flies = [];
            this._grass.queue_repaint();
        }
    }

    _tickWorld() {
        let st = this._state, w = this.width;
        if (st.rain || st.snow) {
            if (this._drops.length < 4)
                this._drops.push({ x: Math.random() * w, y: 0 });
            for (let d of this._drops)
                d.y += st.snow ? 5 : 9;
            this._drops = this._drops.filter(d => d.y < GROUND);
        } else {
            this._drops = [];
        }
        if (st.night) {
            if (this._flies.length < 2)
                this._flies.push({ x: Math.random() * w, y: 8 + Math.random() * 12 });
            for (let f of this._flies) {
                f.x = (f.x + (Math.random() - 0.5) * 6 + w) % w;
                f.y = Math.max(4, Math.min(GROUND - 4, f.y + (Math.random() - 0.5) * 4));
            }
        } else {
            this._flies = [];
        }
        this._grass.queue_repaint();
    }

    // Dot grass in the wallpaper's style, with short blades; night dims it,
    // wind and landings lean it, rain and snow fall through it.
    _drawGrass(area) {
        let cr = area.get_context();
        let st = this._state ?? {};
        let w = this.width, s = this._scroll;
        let dim = st.night ? 0.7 : 1;
        let feet = this._sprite.translation_x + SPRITE / 2;
        let wind = (st.wind ?? 0) > 20 ? 1 : 0;
        for (let x = 1; x < w; x += 3) {
            let xx = x - (s % 3);
            let y = GROUND + 0.5 + 0.8 * Math.sin(xx / 5 + s / 4);
            let edge = Math.min(1, xx / 8, (w - xx) / 8);   // fade at both ends
            let a = Math.max(0, edge) * (0.25 + 0.25 * (0.5 + 0.5 * Math.sin(xx / 9))) * dim;
            cr.setSourceRGBA(0.75, 0.74, 0.8, a);
            let lean = this._bend && Math.abs(xx - feet) < 9 ? Math.sign(xx - feet) : wind;
            cr.rectangle(xx + lean, y - (lean ? 1 : 0), 1, 1);
            cr.fill();
            // a blade every 5 px, 2-3 px tall, not under the feet
            if (x % 5 === 1 && Math.abs(xx - feet) > 6) {
                let h = 2 + ((x * 7) % 2);
                cr.setSourceRGBA(0.75, 0.74, 0.8, 0.6 * Math.max(0, edge) * dim);
                cr.rectangle(xx + lean, GROUND - h, 1, h);
                cr.fill();
            }
        }
        if (this._dust) {
            cr.setSourceRGBA(0.75, 0.74, 0.8, 0.7);
            let px = feet + this._facing * 9;
            cr.rectangle(px, GROUND - 5, 1, 1);
            cr.rectangle(px + 2 * this._facing, GROUND - 3, 1, 1);
            cr.fill();
        }
        for (let d of this._drops) {
            cr.setSourceRGBA(0.75, 0.74, 0.8, 0.55);
            if (st.snow)
                cr.rectangle(d.x, d.y, 2, 2);
            else
                cr.rectangle(d.x, d.y, 1, 3);
            cr.fill();
        }
        if (this._flies.length) {
            let [r, g, b] = rgb(accentHex());
            cr.setSourceRGBA(r, g, b, 0.8);
            for (let f of this._flies) {
                cr.rectangle(f.x, f.y, 1, 1);
                cr.fill();
            }
        }
        cr.$dispose();
    }
});
