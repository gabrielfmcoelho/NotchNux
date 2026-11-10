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
    isIdle, cleanSpecies, napLength, NAPS, waitTick, splitHops, HOUSE_DEFAULT,
} from './companion-brain.js';
import { CACHE_ROOT, ensureOutfit, outfitKey } from './companion-outfit.js';
import { accentHex } from './widgets.js';

const ROOT = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('companions');
// Base sizes at 1x: meadow widths, zone height, feet line (clear of the pill's
// rounded bottom), the icon box (the drawn animal is ~22 px tall) and the prop
// box (ground at its y=22). The Pet tab's yard runs the same player at 2x.
const BASE = { compact: 60, wide: 120, h: 30, ground: 26, sprite: 32, prop: 24 };
const AWAY_MS = 10 * 60 * 1000;
const NARROW_HOLD_MS = 30 * 1000;                      // wait before giving the width back
const WORLD_MS = 1000;                                 // rain / fireflies repaint
const PET_AGAIN_MS = 1500;                             // a second click this soon opens the dashboard
const PROPS = ['mushroom', 'bit', 'flower-bud', 'flower', 'leaf', 'drop', 'flake'];
// What a finished composite means to the needs (companion-brain NEED_EFFECTS)
const EVENT_OF = { eat: 'meal', meal: 'meal', snack: 'snack', treat: 'treat', pet: 'pet', groom: 'groom', dig: 'dig', chase: 'play', twostep: 'play' };
const FOODS = ['whole', 'half', 'stub'];
const FLOWERS_MAX = 12;                                // planted flowers drawn in the yard
const HOP_MAX = BASE.wide - BASE.sprite;               // the pill's longest hop; longer trips take several
const FADE_MS = 250;                                   // leaving the pill, arriving in the yard
const SWAP_POLL_MS = 20;                               // a new outfit's frames: are they loaded yet?
const SWAP_MAX_MS = 5000;                              // frames that never load: give up on them
// The yard's houses: back, front and door light per style, in a 150-unit box whose
// units are the frames' (135-unit box); ground at y = 100 in both. houses.json:
// door = the x where the lying frame's centre goes, roof = the y of the roof's top.
const HOUSE_DIR = ROOT.get_child('houses');
const HOUSES = JSON.parse(new TextDecoder().decode(HOUSE_DIR.get_child('houses.json').load_contents(null)[1]));
const [HBX, HBY, HBW] = HOUSES.box;
const FRAME = { x: -20, y: -31, w: 135, mid: 47.5 };   // the rig's frame box and the animal's centre
const Z_ROOM = 20;                                     // the yard's grass reaches this far above it: z's over a tall roof
const Z_TOP = -14;                                     // the z's highest pixel in the yard: under the tab row above it

function rgb(hex) {
    let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex) ?? ['', 'aa', 'aa', 'ff'];
    return [1, 2, 3].map(i => parseInt(m[i], 16) / 255);
}

export const Companion = GObject.registerClass(
class Companion extends St.Widget {
    // getState(): see companion-brain.js. onWidth(): the pill re-measures.
    // onMemory(key, value): remember a day key or a count in the config.
    // scale 2 is the Pet tab's yard; mirror: the pill's Companion to follow (one
    // brain, one life: the yard replays its acts and never starts its own).
    // onEvent(name): something it did (meal, snack, pet, groom, dig, play, napEnd).
    // worn: the outfit it starts in (a mirror starts in its pill's).
    _init(getState, { species = 'rabbit', worn = null, onWidth = null, onMemory = null, onEvent = null, scale = 1, mirror = null } = {}) {
        super._init({ style_class: 'nn-pill-rabbit-zone', width: BASE.compact * scale, height: BASE.h * scale,
            y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._k = scale;
        this._cw = BASE.compact * scale;
        this._ww = BASE.wide * scale;
        this._h = BASE.h * scale;
        this._g = BASE.ground * scale;
        this._s = BASE.sprite * scale;
        this._p = BASE.prop * scale;
        this._getState = getState;
        this._onWidth = onWidth;
        this._onMemory = onMemory;
        this._onEvent = onEvent;
        this._mirror = mirror;
        this._mirrors = [];
        this._playing = null;      // the composite or routine being played, for onEvent
        this._zPhase = 0;
        // starts dressed, so its first frames are never the bare animal
        let w = mirror?._worn ?? worn;
        this._worn = { head: w?.head ?? null, neck: w?.neck ?? null, back: w?.back ?? null };
        this._minX = 0;            // the yard's house takes the left end
        this._houseStyle = null;   // the yard's house on show
        this._inHouse = false;     // lying in its doorway, the door lit
        this._houseId = 0;         // the walk to the door, after the settle that asked for it
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
        this._flowers = 0;         // planted flowers (the yard draws them)
        this._out = false;         // away in the Pet tab's yard: unseen on the pill
        this._waitSince = 0;       // a Claude wait being timed (see waitTick)
        this._nap = false;         // a lively short sleep
        this._napId = 0;
        this._swapId = 0;          // a new outfit's frames loading behind the shown ones
        this._next = null;         // those frames (a Map like _frames)

        this._grass = new St.DrawingArea({ width: this._cw, height: this._h });
        this._grass.connect('repaint', area => this._drawGrass(area));
        this.add_child(this._grass);

        // Props (food, mushroom, leaf…) sit on the grass in their own box.
        this._props = new St.Widget({ width: this._p, height: this._p, visible: false });
        this._props.set_position(0, this._g - this._p + 2);
        this.add_child(this._props);
        this._propShown = null;

        // the yard's house (the yard only): the back under the animal, the front and
        // the door light over it, sized so a house unit is a frame unit; grounds aligned.
        // Added before the sprite so it loads ahead of the animal's hundreds of frames.
        let spriteY = this._g - this._s + 3;
        if (scale > 1) {
            this._houseSize = Math.round(this._s * HBW / FRAME.w);
            this._houseU = this._houseSize / HBW;   // px per house unit
            [this._houseBack, this._houseFront, this._houseLight] = ['back', 'front', 'light'].map(part => {
                let icon = new St.Icon({ style_class: part === 'light' ? '' : 'nn-pet-house', icon_size: this._houseSize, opacity: part === 'light' ? 0 : 255 });
                icon.set_position(2 * scale, spriteY - Math.round((FRAME.y - HBY) * this._houseU));
                return icon;
            });
            this.add_child(this._houseBack);
        }

        this._sprite = new St.Widget({ style_class: 'nn-pill-rabbit', width: this._s, height: this._s });
        this._sprite.set_position(0, spriteY);
        this._sprite.set_pivot_point(0.5, 1);                 // turns about its feet
        this._sprite.translation_x = (this._cw - this._s) / 2;  // where it sits in the meadow
        this.add_child(this._sprite);
        this._frames = new Map();
        this._propIcons = new Map();
        // in the yard the house takes the left end: the animal lives (and lands) to its right
        this._minX = scale > 1 ? this._houseSize + 6 * scale : 0;
        if (scale > 1) {
            this.add_child(this._houseFront);
            this.add_child(this._houseLight);
            this._sprite.translation_x = Math.round((this._minX + this._cw - this._s) / 2);
            this.setHouse(HOUSE_DEFAULT[cleanSpecies(species)]);
        }
        this._loadSpecies(cleanSpecies(species));

        // Away = no input for 10 minutes (sleeps); input again wakes it. (The yard follows the pill's.)
        this._idleMon = mirror ? null : global.backend.get_core_idle_monitor();
        this._idleWatch = mirror ? 0 : this._idleMon.add_idle_watch(AWAY_MS, () => {
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
            this._gone = true;
            this._cut();
            this._clearAmbient();
            for (let id of [this._narrowId, this._worldId, this._napId, this._swapId, this._houseId])
                if (id)
                    GLib.source_remove(id);
            this._narrowId = this._worldId = this._napId = this._swapId = this._houseId = 0;
            for (let id of [this._idleWatch, this._activeWatch])
                if (id)
                    this._idleMon.remove_watch(id);
            if (this._mirror)
                this._mirror._mirrors = this._mirror._mirrors.filter(m => m !== this);
        });
        if (mirror) {
            mirror._mirrors.push(this);
            this._away = mirror._away;
            this._claude = mirror._claude;
        }
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
    // The frames come from the species folder, or with clothes on from an
    // outfit folder composed from them (companion-outfit.js).
    _loadSpecies(name) {
        this._species = name;
        let dir = ROOT.get_child(name);
        let read = f => JSON.parse(new TextDecoder().decode(dir.get_child(f).load_contents(null)[1]));
        this._spec = read('acts.json');
        try {
            this._lib = read('wear.json');
        } catch (e) {
            this._lib = null;   // no clothes for this animal: it goes bare
        }
        this._frameMs = Math.round(1000 / this._spec.fps);
        this._dropNext();
        for (let f of this._frames.values())
            f.destroy();
        this._wantKey = outfitKey(name, this._worn, this._lib?.version);
        this._outfitDir = this._ensureOutfit();
        this._frames = this._frameSet(this._outfitDir);
        this._shown = this._shownIcon = null;
        for (let p of this._propIcons.values())
            p.destroy();
        this._propIcons.clear();
        this._propShown = null;
        for (let n of [...PROPS.map(p => `prop-${p}`), ...FOODS.map(f => `food-${f}`)]) {
            let icon = new St.Icon({ gicon: new Gio.FileIcon({ file: dir.get_child(`${n}-symbolic.svg`) }), icon_size: this._p, opacity: 0 });
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
            this._sprite.translation_x = -this._s + 4;
            this._face(1);
            this._settle();
            this._play([{ act: 'hop', to: (this._mw - this._s) / 2 }], rank('wake'));
        };
        if (!this._canMove()) {
            swap();
            return;
        }
        this._play([{ act: 'hop', to: this._mw - 6 }], rank('wake'), swap);
    }

    // The act's frames, with the earpiece while music plays when it has them.
    _acts(name) {
        return (this._state?.music && this._spec.acts[`${name}@music`]) || this._spec.acts[name];
    }

    // While a new outfit loads, a frame shows from it once loaded, else from the old set.
    _show(name) {
        let next = this._next?.get(name);
        let icon = next?.get_first_child()?.get_content() ? next : this._frames.get(name);
        this._shown = name;
        if (icon === this._shownIcon)
            return;
        if (this._shownIcon)
            this._shownIcon.opacity = 0;
        icon.opacity = 255;
        this._shownIcon = icon;
    }

    // The species' frames, or an outfit folder composed from them (the folder path).
    _ensureOutfit() {
        return ensureOutfit({ srcDir: ROOT.get_child(this._species).get_path(), cacheRoot: CACHE_ROOT,
            species: this._species, worn: this._worn, spec: this._spec, lib: this._lib });
    }

    // One icon per frame from a folder, under the sprite at opacity 0.
    _frameSet(path) {
        let frames = new Map();
        for (let n of new Set(Object.values(this._spec.acts).flatMap(a => a.frames))) {
            let icon = new St.Icon({ gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(`${path}/${n}`) }), icon_size: this._s, opacity: 0 });
            frames.set(n, icon);
            this._sprite.add_child(icon);
        }
        return frames;
    }

    _dropNext() {
        if (this._swapId)
            GLib.source_remove(this._swapId);
        this._swapId = 0;
        let next = this._next;
        this._next = null;
        if (next && this._shown)
            this._show(this._shown);   // back on the old set before the new one goes
        for (let f of next?.values() ?? [])
            f.destroy();
    }

    // How many planted flowers the yard shows.
    setFlowers(n) {
        if (n === this._flowers)
            return;
        this._flowers = n;
        this._grass.queue_repaint();
    }

    // The Pet tab's yard came on screen (or left it): the animal is there, not
    // here. Awake, it hops off the pill's left edge and later back in, and
    // comes out of its house in the yard (the one spot that does not move while
    // the dashboard is still growing); asleep, it is just gone or back.
    // While out the pill plays everything unseen: it is what the yard mirrors.
    setOut(out) {
        if (this._gone || this._k > 1 || out === this._out)
            return;
        let hop = this._canMove() && restAct(this._state ?? {}) !== 'sleep';
        if (out && hop) {
            this._play([{ act: 'hop', to: 0 }], rank('wake'));
            this._sprite.ease({ opacity: 0, duration: FADE_MS, delay: FADE_MS / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            for (let m of this._mirrors) {
                m._sprite.translation_x = m._doorX;
                m._play([{ act: 'hop', to: m._minX + m._s }], rank('wake'));
                m._sprite.opacity = 0;   // (after _play: its settle shows the sprite)
                m._sprite.ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            }
        }
        this._out = out;   // after the hop off began: _settle hides it once that ends or is cut
        if (!out && hop) {
            this._sprite.translation_x = -this._s + 4;
            this._face(1);
            this._play([{ act: 'hop', to: (this._mw - this._s) / 2 }], rank('wake'));
            this._sprite.opacity = 0;
            this._sprite.ease({ opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        } else if (!hop) {
            this._settle();
        }
        this._grass.queue_repaint();
    }

    // The meadow's width for everything it does. The pill's is the actor's own
    // (fixed) width; the yard's is what it was last laid out at, because an
    // actor's `width` falls back to its natural size while a relayout is pending
    // (every frame swap queues one), and the yard's natural size is not its real one.
    get _mw() {
        return this._k > 1 ? this._ww : this.width;
    }

    // The yard is as wide as the Pet tab makes it: the grass is given the whole
    // width as part of the layout itself (the pill's meadow keeps its two widths).
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        if (this._k <= 1)
            return;
        this._cw = this._ww = box.get_width();
        let room = Z_ROOM * this._k;
        this._grass.allocate(new Clutter.ActorBox({ x1: 0, y1: -room, x2: box.get_width(), y2: this._h }));
    }

    // Away in the yard, the pill shows no act's prop (food, the chased bit, the
    // rain leaf); a focus flower stays: it is the meadow's, not the animal's.
    _syncProps() {
        this._props.opacity = this._out && !this._propShown?.startsWith('prop-flower') ? 0 : 255;
    }

    // What it wears: { head, neck, back } item ids (or null). Called on every
    // store change, so it does nothing unless the outfit itself changed. The new
    // outfit's frames load behind the shown ones and take over once loaded.
    setWear(worn) {
        this._worn = { head: worn?.head ?? null, neck: worn?.neck ?? null, back: worn?.back ?? null };
        let key = outfitKey(this._species, this._worn, this._lib?.version);
        if (key !== this._wantKey) {
            this._wantKey = key;
            this._dropNext();   // a newer outfit wins over one still loading
            let dir = this._ensureOutfit();
            if (dir !== this._outfitDir)
                this._swapTo(dir);
        }
        for (let m of this._mirrors)   // after composing: the yard finds the folder made
            m.setWear(this._worn);
    }

    // Measured headless (Step 1 of the wardrobe plan): an icon's texture child gets
    // its content in the same main-loop turn its picture becomes paintable (painted
    // cells matched loaded ones exactly). 144 fresh frames took ~450 ms, twice that
    // with the yard open, so the old set stays under the new one until every new
    // frame has content (_show picks per frame); SWAP_MAX_MS only for files that never load.
    _swapTo(dir) {
        let next = this._frameSet(dir);
        let t0 = GLib.get_monotonic_time();
        this._next = next;
        this._swapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SWAP_POLL_MS, () => {
            let ready = [...next.values()].every(f => f.get_first_child()?.get_content());
            if (!ready && GLib.get_monotonic_time() - t0 < SWAP_MAX_MS * 1000) {
                if (this._shown)
                    this._show(this._shown);   // the frame on show, once its new icon loaded
                return GLib.SOURCE_CONTINUE;
            }
            this._swapId = 0;
            let old = this._frames;
            this._frames = next;
            this._next = null;
            this._outfitDir = dir;
            if (this._shown)
                this._show(this._shown);
            for (let f of old.values())
                f.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Show one prop (or food state) on the grass at x, or hide them all.
    _prop(name, x = null) {
        if (this._propShown)
            this._propIcons.get(this._propShown).opacity = 0;
        this._propShown = name;
        this._props.visible = !!name;
        this._syncProps();
        if (!name)
            return;
        this._propIcons.get(name).opacity = 255;
        if (x !== null)
            this._props.set_x(Math.max(this._k > 1 ? this._minX : 0, Math.min(this._mw - this._p, Math.round(x))));   // (never behind the yard's house)
    }

    // From the Claude sync: mood (idle/working/waiting), how many sessions
    // finished unseen, and the mood colour (the matching pill dot's).
    setClaude(mood, fresh, color) {
        this._claude = { mood, fresh, color };
        this.update();
        for (let m of this._mirrors) {
            m._claude = this._claude;
            m.update();
        }
    }

    // Something the notch saw: re-read the state, react to what changed.
    update() {
        if (this._mirror)
            this._away = this._mirror._away;
        for (let m of this._mirrors)
            m.update();
        let next = { ...this._getState(), mood: this._claude.mood, fresh: this._claude.fresh, away: this._away, nap: this._nap };
        if (this._nap && (!isIdle(next) || !next.lively))
            this._endNap(false);   // something came up: wake without the stretch
        next.nap = this._nap;
        let prev = this._state ?? next;
        this._state = next;
        if (!this._mirror) {
            let missed;
            [this._waitSince, missed] = waitTick(this._waitSince, next.mood === 'waiting', Date.now());
            if (missed)
                this._onEvent?.('missed');
            if (next.rain && !prev.rain)   // (the store counts it once a day)
                this._onEvent?.('rain');
        }
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
        if (!this._mirror && ['focusdone', 'finished', 'wake', 'dayStart'].includes(event))
            this._onEvent?.(event);   // earns a treat / a seed; the tab greets you back
        this._play(REACTION_ACT[event], rank(event));
    }

    _canMove() {
        return this.mapped && this.visible && St.Settings.get().enable_animations;
    }

    // ---- the meadow's width ----

    _syncMeadow() {
        if (this._k > 1)
            return;   // the yard's width is the tab's (vfunc_allocate)
        let want = meadow(this._state) === 'wide' ? this._ww : this._cw;
        if (want > this.width) {
            this._clearNarrow();
            this._setWidth(want);
        } else if (want < this.width && !this._narrowId) {
            // give the width back only once things have stayed quiet a while
            this._narrowId = GLib.timeout_add(GLib.PRIORITY_LOW, NARROW_HOLD_MS, () => {
                this._narrowId = 0;
                if (meadow(this._state) === 'wide')
                    return GLib.SOURCE_REMOVE;
                let inside = this._cw - this._s - 2;
                if (this._sprite.translation_x > inside && this._canMove() && !this._act)
                    this._play([{ act: 'hop', to: inside - 4 }], Infinity, () => this._setWidth(this._cw));
                else
                    this._setWidth(this._cw);
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
        let max = w - this._s;
        if (this._sprite.translation_x > max)
            this._sprite.translation_x = max;
        if (this._sprite.translation_x < this._minX)
            this._sprite.translation_x = this._minX;
        if (this._propShown && this._props.x > w - this._p)
            this._props.set_x(w - this._p);
        this._grass.queue_repaint();
        this._onWidth?.();
    }

    // ---- acts ----

    // Play an act: a frame act name, a composite ('wander', 'turn', 'twostep',
    // 'chase', 'eat', 'snack'), or a list of items { act, to?, onStart? }.
    // min: the leftmost spot it may land (the yard's door is left of _minX).
    _play(what, r = Infinity, onDone = null, min = this._minX) {
        this._cut();
        this._clearAmbient();
        if (!this._canMove()) {
            this._scheduleAmbient();
            return;
        }
        for (let m of this._mirrors)
            m._play(what, r);
        this._playing = typeof what === 'string' ? what.split(':')[0] : null;
        let items = Array.isArray(what) ? what.flatMap(i => (typeof i === 'string' ? this._expand(i) : [i])) : this._expand(what);
        this._floor = min;
        items = splitHops(items, this._sprite.translation_x, min, this._mw - this._s, HOP_MAX * this._k);
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
    _expand(step) {
        let [name, param] = step.split(':');
        let x = this._sprite.translation_x;
        let max = this._mw - this._s;
        let st = this._state ?? {};
        switch (name) {
        case 'turn':
            this._face(-this._facing);
            return [{ act: 'look' }];
        case 'wander':
            return this._wanderSteps(param ?? 'hop', x, max);
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
        case 'nap':
            // a doze (sitting, eyes shut), a nap or a deep sleep (lying down, fireflies);
            // then it stretches awake. Anything that needs it cuts the nap short.
            this._nap = param in NAPS ? param : 'nap';
            this._napId = GLib.timeout_add(GLib.PRIORITY_LOW, napLength(this._nap, Math.random()), () => {
                this._napId = 0;
                this._endNap(true);
                return GLib.SOURCE_REMOVE;
            });
            this.update();
            return [];
        case 'seek':   // hungry: hops to the far side and sniffs around for food
            return [{ act: 'hop', to: this._farSpot() }, { act: 'sniff' }, { act: 'look' }];
        case 'eat':
        case 'meal':
        case 'treat':
        case 'snack': {
            // food lands at the far side (a snack right here), it hops over and eats it in bites;
            // 'meal' is the lively version of lunch, which leaves the once-a-day memory alone
            let far = name !== 'snack' && name !== 'treat';
            let fx = far ? this._farSpot() : x + (this._facing > 0 ? 18 : -10);
            fx = Math.max(0, Math.min(this._mw - this._p, fx));
            let stand = Math.max(0, Math.min(max, fx + (fx > x ? -14 : 14)));
            let bites = far ? ['whole', 'half', 'stub'] : name === 'treat' ? ['stub'] : ['half', 'stub'];
            let items = [{ act: 'look', onStart: () => {
                this._prop('food-whole', fx);
                if (name === 'eat')
                    this._onMemory?.('lastFed', st.dayKey);
            } }];
            if (far)
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
            let done = this._onDone, played = this._playing;
            this._onDone = null;
            this._playing = null;
            this._settle();
            done?.();
            if (!this._mirror && played && EVENT_OF[played])
                this._onEvent?.(EVENT_OF[played]);
            return;
        }
        this._act = { name: item.act, rank: this._act?.rank ?? Infinity };
        if (this._inHouse) {   // up and out: the light goes off
            this._inHouse = false;
            this._houseLight.opacity = 0;
        }
        item.onStart?.();
        let dx = 0;
        if (item.to !== undefined) {
            this._xTarget = Math.max(this._floor, Math.min(this._mw - this._s, Math.round(item.to)));
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

    // Wandering styles, as hop steps. Every target stays inside the meadow.
    _wanderSteps(style, x, max) {
        let min = this._minX;
        let clamp = v => Math.max(min, Math.min(max, Math.round(v)));
        let dir = x < (min + max) / 2 ? 1 : -1;   // toward the far side
        switch (style) {
        case 'patrol':   // edge to edge
            return [{ act: 'hop', to: clamp(dir > 0 ? max - 1 : min + 1) }];
        case 'explore': {   // three short hops one way, then a sniff
            let step = Math.max(6, Math.min(12, Math.abs((dir > 0 ? max - x : x) / 3)));
            return [1, 2, 3].map(i => ({ act: 'hop', to: clamp(x + dir * step * i) })).concat([{ act: 'sniff' }]);
        }
        case 'zigzag': {   // small hops side to side
            let step = Math.min(7, x, max - x) || 4;
            return [{ act: 'hop', to: clamp(x - step) }, { act: 'hop', to: clamp(x + step) }, { act: 'hop', to: clamp(x - step) }, { act: 'hop', to: clamp(x) }];
        }
        case 'cautious': {   // hop, sniff, hop
            let t = this._wanderTarget();
            return [{ act: 'hop', to: clamp((x + t) / 2) }, { act: 'sniff' }, { act: 'hop', to: clamp(t) }];
        }
        default:
            return [{ act: 'hop', to: this._wanderTarget() }];
        }
    }

    // End a lively nap: with a stretch when it wakes by itself.
    _endNap(stretch) {
        if (this._napId)
            GLib.source_remove(this._napId);
        this._napId = 0;
        if (!this._nap)
            return;
        let was = this._nap;
        this._nap = false;
        if (this._state)
            this._state.nap = false;
        this._syncWorld();
        if (was === 'deep' && !this._mirror)
            this._onEvent?.('napEnd');
        if (stretch && this._canMove())
            this._play('stretch');
        else
            this._settle();
    }

    // A spot on the other side of the meadow from where it stands.
    _farSpot() {
        let min = this._minX, max = this._mw - this._s, x = this._sprite.translation_x;
        return x < (min + max) / 2 ? max - 2 - Math.round(Math.random() * 6) : min + 2 + Math.round(Math.random() * 6);
    }

    // A spot at least 10 px away, inside the meadow.
    _wanderTarget() {
        let min = this._minX, max = this._mw - this._s, x = this._sprite.translation_x;
        let t = min + Math.random() * (max - min);
        if (Math.abs(t - x) < 10)
            t = x < (min + max) / 2 ? max - Math.random() * 6 : min + Math.random() * 6;
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
        this._syncHouse(restAct(st));
        if (this._k <= 1)   // out in the Pet tab's yard: it does not show on the pill
            this._sprite.opacity = this._out ? 0 : 255;
        this._syncProps();
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
        if (this._mirror)
            return;   // the pill's companion decides; this one only breathes between its moves
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
            this._play(next.routine ? next.steps : next.act);
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

    // The yard's house: one of HOUSE_STYLES. Its door is where the lying animal goes.
    setHouse(style) {
        if (this._k <= 1 || style === this._houseStyle || !HOUSES.styles[style])
            return;
        this._houseStyle = style;
        for (let [icon, part] of [[this._houseBack, 'back'], [this._houseFront, 'front'], [this._houseLight, 'light']])
            icon.gicon = new Gio.FileIcon({ file: HOUSE_DIR.get_child(`house-${style}-${part}-symbolic.svg`) });
        this._doorX = Math.round(this._houseBack.x + (HOUSES.styles[style].door - HBX) * this._houseU - (FRAME.mid - FRAME.x) * this._s / FRAME.w);
        if (this._inHouse)
            this._sprite.translation_x = this._doorX;
        this._grass.queue_repaint();   // the z's rise from its roof
    }

    // In the yard it sleeps in its house: it hops to the doorway first, then lies
    // there between the back and the front, the door lit. Awake, it hops back out
    // to the right of the house. (The hops are started from an idle callback: this
    // runs inside _play's own settle.)
    _syncHouse(rest) {
        if (this._k <= 1)
            return;
        let lying = rest === 'sleep';
        let door = Math.abs(this._sprite.translation_x - this._doorX) <= 1;
        let inside = !lying && this._sprite.translation_x < this._minX;
        if (!this._canMove() && ((lying && !door) || inside)) {   // nothing plays: it is just there
            this._sprite.translation_x = lying ? this._doorX : this._minX;
            door = lying;
            inside = false;
        }
        this._inHouse = lying && door;
        this._houseLight.opacity = this._inHouse ? 255 : 0;
        if (((lying && !door) || inside) && !this._houseId) {
            this._houseId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._houseId = 0;
                let x = this._sprite.translation_x;
                if (this._act)
                    return GLib.SOURCE_REMOVE;   // its settle asks again
                if (restAct(this._state ?? {}) === 'sleep') {
                    if (Math.abs(x - this._doorX) > 1)
                        this._play([{ act: 'hop', to: this._doorX }], rank('wake'), null, this._doorX);
                } else if (x < this._minX) {
                    this._play([{ act: 'hop', to: this._minX + this._s }], rank('wake'));   // out, as on arrival
                }
                return GLib.SOURCE_REMOVE;
            });
        }
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
            this._prop('prop-flower-bud', this._mw - this._p);
        } else if (prev.focus === 'focus' && next.focus !== 'focus' && this._flower === 'bud') {
            this._flower = 'open';
            this._prop('prop-flower', this._mw - this._p);
        } else if (this._flower && this._propShown === null && isIdle(next)) {
            this._prop(this._flower === 'bud' ? 'prop-flower-bud' : 'prop-flower', this._mw - this._p);
        }
    }

    // Rain, snow and fireflies move once a second, only while idle and on screen.
    _syncWorld() {
        let st = this._state;
        let lying = st?.nap && st.nap !== 'doze';
        let asleep = !!st && ['sleep', 'doze'].includes(restAct(st));
        let want = !!st && this.mapped && this.visible && (asleep || (isIdle(st) && (st.rain || st.snow || st.night || lying)));
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
        let st = this._state, w = this._mw;
        this._zPhase = (this._zPhase + 1) % 3;
        if (st.rain || st.snow) {
            if (this._drops.length < 4)
                this._drops.push({ x: Math.random() * w, y: 0 });
            for (let d of this._drops)
                d.y += st.snow ? 5 : 9;
            this._drops = this._drops.filter(d => d.y < this._g);
        } else {
            this._drops = [];
        }
        if (st.night || (st.nap && st.nap !== 'doze')) {
            if (this._flies.length < 2)
                this._flies.push({ x: Math.random() * w, y: 8 + Math.random() * 12 });
            for (let f of this._flies) {
                f.x = (f.x + (Math.random() - 0.5) * 6 + w) % w;
                f.y = Math.max(4, Math.min(this._g - 4, f.y + (Math.random() - 0.5) * 4));
            }
        } else {
            this._flies = [];
        }
        this._grass.queue_repaint();
    }

    // The z's while asleep (one for a doze), rising with the world tick's phase:
    // [x, y, size] each. In the house they rise beside its roof, from the roof's
    // height (the grass is under the house), kept under the tab row (Z_TOP).
    _zMarks(phase = this._zPhase) {
        let rest = restAct(this._state ?? {});
        if (this._out || (rest !== 'sleep' && rest !== 'doze'))
            return [];
        let k = this._k;
        let hx = this._sprite.translation_x + this._s * (this._facing > 0 ? 0.62 : 0.38);
        let hy = this._g - this._s * 0.55;
        if (this._inHouse) {
            hx = this._houseBack.x + this._houseSize + 2 * k;
            hy = Math.max(this._houseBack.y + (HOUSES.styles[this._houseStyle].roof - HBY) * this._houseU - 2 * k, (Z_TOP + 8.5) * k);
        }
        return (rest === 'doze' ? [0] : [0, 1]).map(i => {
            let ph = (phase + i) % 3;
            return [hx + i * 4 * k + ph * k, hy - ph * 2 * k - i * 4 * k, (2 + i) * k];
        });
    }

    // Dot grass in the wallpaper's style, with short blades; night dims it,
    // wind and landings lean it, rain and snow fall through it.
    _drawGrass(area) {
        let cr = area.get_context();
        let st = this._state ?? {};
        let w = this._mw, s = this._scroll;
        let dim = st.night || (st.nap && st.nap !== 'doze') ? 0.7 : 1;
        let feet = this._sprite.translation_x + this._s / 2;
        let wind = (st.wind ?? 0) > 20 ? 1 : 0;
        let k = this._k;
        if (k > 1)
            cr.translate(0, Z_ROOM * k);   // (the yard's grass starts above the zone)
        for (let x = 1; x < w; x += 3 * k) {
            let xx = x - (s % 3);
            let y = this._g + 0.5 + 0.8 * k * Math.sin(xx / (5 * k) + s / 4);
            let edge = Math.min(1, xx / 8, (w - xx) / 8);   // fade at both ends
            let a = Math.max(0, edge) * (0.25 + 0.25 * (0.5 + 0.5 * Math.sin(xx / 9))) * dim;
            cr.setSourceRGBA(0.75, 0.74, 0.8, a);
            let lean = this._bend && Math.abs(xx - feet) < 9 ? Math.sign(xx - feet) : wind;
            cr.rectangle(xx + lean, y - (lean ? 1 : 0), k, k);
            cr.fill();
            // a blade every 5 px, 2-3 px tall, not under the feet
            if (Math.round(x / k) % 5 === 1 && Math.abs(xx - feet) > 6 * k) {
                let h = (2 + ((x * 7) % 2)) * k;
                cr.setSourceRGBA(0.75, 0.74, 0.8, 0.6 * Math.max(0, edge) * dim);
                cr.rectangle(xx + lean, this._g - h, k, h);
                cr.fill();
            }
        }
        // planted flowers (the yard only): a stem and an accent head, at fixed
        // spots along the wide meadow, so widening it reveals more
        if (k > 1 && this._flowers) {
            let [r, g, b] = rgb(accentHex());
            for (let i = 0; i < Math.min(this._flowers, FLOWERS_MAX); i++) {
                let fx = Math.round(this._minX + ((i * 0.618) % 1) * (this._ww - this._minX - 6 * k));
                if (fx > w - 4 * k)
                    continue;
                cr.setSourceRGBA(0.75, 0.74, 0.8, 0.6 * dim);
                cr.rectangle(fx, this._g - 4 * k, k, 4 * k);
                cr.fill();
                cr.setSourceRGBA(r, g, b, 0.9 * dim);
                cr.rectangle(fx - k / 2, this._g - 6 * k, 2 * k, 2 * k);
                cr.fill();
            }
        }
        let marks = this._zMarks();
        if (marks.length) {
            cr.setSourceRGBA(0.75, 0.74, 0.8, 0.75);
            cr.setLineWidth(k);
            for (let [zx, zy, zs] of marks) {
                cr.moveTo(zx, zy); cr.lineTo(zx + zs, zy); cr.lineTo(zx, zy + zs); cr.lineTo(zx + zs, zy + zs);
                cr.stroke();
            }
        }
        if (this._dust && !this._out) {
            cr.setSourceRGBA(0.75, 0.74, 0.8, 0.7);
            let px = feet + this._facing * 9;
            cr.rectangle(px, this._g - 5, 1, 1);
            cr.rectangle(px + 2 * this._facing, this._g - 3, 1, 1);
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
