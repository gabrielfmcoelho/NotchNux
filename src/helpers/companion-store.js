// The companion's own file: needs, pantry, finds, what it wears, a short
// diary and the meal streak. ~/.local/share/notchnux/companion.json, next to
// tasks.json. Saved atomically, at most once a minute from drift plus once
// per action. The maths lives in companion-brain.js; this only keeps state.

import GLib from 'gi://GLib';

import { freshNeeds, progressNeeds, applyNeed, digFind, earned, FINDS, WEARABLES, NEED_KEYS } from './companion-brain.js';

export const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchnux']);
const DIARY_MAX = 12;
const SAVE_MIN_MS = 60 * 1000;
export const FOOD_PER_DAY = 3;

export function dayKeyOf(ms) {
    let d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanState(raw, nowMs) {
    raw = raw && typeof raw === 'object' ? raw : {};
    let needs = raw.needs && typeof raw.needs === 'object' ? raw.needs : freshNeeds(nowMs);
    for (let k of NEED_KEYS)
        if (typeof needs[k] !== 'number')
            needs[k] = freshNeeds(nowMs)[k];
    if (typeof needs.at !== 'number')
        needs.at = nowMs;
    let pantry = raw.pantry && typeof raw.pantry === 'object' ? raw.pantry : {};
    let n = v => (Number.isInteger(v) && v >= 0 ? v : 0);
    let worn = raw.worn && typeof raw.worn === 'object' ? raw.worn : {};
    let items = Array.isArray(raw.items) ? raw.items.filter(i => typeof i === 'string') : [];
    return {
        needs,
        pantry: { food: n(pantry.food), treat: n(pantry.treat), bath: n(pantry.bath), seed: n(pantry.seed) },
        items,
        worn: { head: WEARABLES[worn.head]?.slot === 'head' && items.includes(worn.head) ? worn.head : null,
            neck: WEARABLES[worn.neck]?.slot === 'neck' && items.includes(worn.neck) ? worn.neck : null },
        diary: Array.isArray(raw.diary) ? raw.diary.filter(e => e && typeof e.t === 'number' && typeof e.what === 'string').slice(-DIARY_MAX) : [],
        streak: { days: n(raw.streak?.days), lastMeal: typeof raw.streak?.lastMeal === 'string' ? raw.streak.lastMeal : null },
        restocked: typeof raw.restocked === 'string' ? raw.restocked : null,
        flowers: n(raw.flowers),
    };
}

export class CompanionStore {
    constructor({ dataDir = DATA_DIR, now = () => Date.now() } = {}) {
        this._path = GLib.build_filenamev([dataDir, 'companion.json']);
        this._dir = dataDir;
        this._now = now;
        this._lastSave = 0;
        this._dirty = false;
        this.onChanged = null;   // the tab refreshes on this
        this._load();
    }

    _load() {
        let raw = null;
        try {
            let [ok, bytes] = GLib.file_get_contents(this._path);
            if (ok)
                raw = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) { /* first run or unreadable: start fresh */ }
        this.state = cleanState(raw, this._now());
        this.restock();
    }

    save(force = false) {
        let now = this._now();
        if (!force && now - this._lastSave < SAVE_MIN_MS) {
            this._dirty = true;
            return;
        }
        this._lastSave = now;
        this._dirty = false;
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents_full(this._path, new TextEncoder().encode(JSON.stringify(this.state, null, 1)),
                GLib.FileSetContentsFlags.CONSISTENT, 0o600);
        } catch (e) {
            console.warn(`NotchNux: companion.json not saved: ${e.message}`);
        }
    }

    // Flush a pending drift save (on destroy).
    flush() {
        if (this._dirty)
            this.save(true);
    }

    // Current needs, brought up to now. `asleep` is how it has been since the last save.
    needs(asleep = false) {
        this.state.needs = progressNeeds(this.state.needs, this._now(), asleep);
        this.save();
        return this.state.needs;
    }

    // Something happened: apply its effect on the needs and write the diary line.
    event(name, what = null) {
        this.state.needs = applyNeed(progressNeeds(this.state.needs, this._now()), name);
        if (what)
            this.record(what);
        this.save(true);
        this.onChanged?.();
    }

    record(what) {
        this.state.diary.push({ t: this._now(), what });
        if (this.state.diary.length > DIARY_MAX)
            this.state.diary.splice(0, this.state.diary.length - DIARY_MAX);
    }

    // Three portions of food appear at dawn (the first time the day is seen).
    restock() {
        let day = dayKeyOf(this._now());
        if (this.state.restocked === day)
            return false;
        this.state.restocked = day;
        this.state.pantry.food = Math.max(this.state.pantry.food, FOOD_PER_DAY);
        this.save(true);
        return true;
    }

    // A meal was eaten (its own lunch or one you gave): pantry, streak, earned hats.
    meal(kind = 'meal') {
        let day = dayKeyOf(this._now());
        if (kind === 'meal' && this.state.pantry.food > 0)
            this.state.pantry.food--;
        if (kind === 'treat' && this.state.pantry.treat > 0)
            this.state.pantry.treat--;
        let st = this.state.streak;
        if (st.lastMeal !== day) {
            let yesterday = dayKeyOf(this._now() - 24 * 3600 * 1000);
            st.days = st.lastMeal === yesterday ? st.days + 1 : 1;
            st.lastMeal = day;
            let gift = earned('streak', st.days);
            if (gift)
                this.gain(gift, `found ${WEARABLES[gift].name} after ${st.days} days of meals`);
        }
        this.event(kind, kind === 'treat' ? 'had a treat' : kind === 'snack' ? 'had a snack' : 'ate a meal');
    }

    // A dig: maybe a find.
    dig(rand = Math.random()) {
        let id = digFind(rand);
        this.event('dig', id ? null : 'dug a little hole');
        if (id)
            this.gain(id, `dug up ${FINDS[id].name}`);
        return id;
    }

    // Something earned by living (a finished focus, a closed Claude session).
    earn(event) {
        let id = earned(event);
        if (id)
            this.gain(id, event === 'focusdone' ? 'got a treat for the focus session' : 'found a seed after the Claude session');
        return id;
    }

    gain(id, line) {
        if (FINDS[id]?.kind === 'food' || id === 'treat')
            this.state.pantry.treat++;
        else if (FINDS[id]?.kind === 'seed' || id === 'seed')
            this.state.pantry.seed++;
        else if (!this.state.items.includes(id))
            this.state.items.push(id);
        if (line)
            this.record(line);
        this.save(true);
        this.onChanged?.();
    }

    // Wear or take off; only owned items, one per slot.
    wear(id) {
        let w = WEARABLES[id];
        if (!w || !this.state.items.includes(id))
            return false;
        this.state.worn[w.slot] = this.state.worn[w.slot] === id ? null : id;
        this.record(this.state.worn[w.slot] ? `put on ${w.name}` : `took off ${w.name}`);
        this.save(true);
        this.onChanged?.();
        return true;
    }

    // Plant a seed: a flower in the yard.
    plant() {
        if (this.state.pantry.seed <= 0)
            return false;
        this.state.pantry.seed--;
        this.state.flowers++;
        this.record('planted a seed');
        this.save(true);
        this.onChanged?.();
        return true;
    }

    bath() {
        if (this.state.pantry.bath <= 0)
            return false;
        this.state.pantry.bath--;
        this.event('bath', 'had a bath');
        return true;
    }
}
