// What the pill companion does, as pure functions (no Shell imports, so
// tests/companion-check.js runs with plain gjs). The player in companion.js
// asks these and only draws.
//
// State (built by the notch each update):
//   mood 'idle'|'working'|'waiting', fresh (Claude sessions finished unseen),
//   focus 'idle'|'focus'|'break', music, track (id of the playing track),
//   low, charging, away, night, rain, snow, wind (km/h), unread, calm,
//   lively (its whole life every few seconds, not only at its times),
//   nap (the player's short lively sleep), minutes (of the day), dayKey ('2026-11-09'),
//   mem { lastFed, lastMushroom } (day keys, kept in the config)

// Reactions, strongest first: a weaker one never cuts a stronger one short.
const RANK = ['waiting', 'finished', 'working', 'focusdone', 'dayStart', 'wake', 'event', 'break', 'eat', 'notification',
    'track', 'charger', 'pet'];

// An act may be a plain frame act or a sequence the player runs back to back.
export const REACTION_ACT = {
    waiting: 'thump',                       // rabbits thump to warn: needs you
    finished: 'binky',                      // happy twist jump
    working: 'hop',
    focusdone: 'binky',                     // a focus session ended
    dayStart: ['stretch', 'yawn', 'shake'], // first input of the day
    wake: 'stretch',
    event: 'sniffup',                       // a calendar event in a few minutes: stands tall
    break: 'stretch',
    eat: 'eat',                             // the player's meal sequence (lunch)
    notification: 'perk',
    track: 'perk',                          // the track changed
    charger: 'snack',                       // a short meal
    pet: 'pet',
};

export function rank(event) {
    let i = RANK.indexOf(event);
    return i < 0 ? Infinity : i;
}

export const LUNCH = [12 * 60, 13 * 60 + 30];   // minutes of the day
export const MUSHROOM_AFTER = 16 * 60;

// Nothing happening that the companion should stay out of the way of.
export function isIdle(s) {
    return s.mood === 'idle' && s.focus === 'idle' && !s.away;
}

// Events implied by going from one state to the next.
export function diffEvents(prev, next) {
    let ev = [];
    if (next.mood === 'waiting' && prev.mood !== 'waiting')
        ev.push('waiting');
    if (next.fresh > prev.fresh)
        ev.push('finished');
    if (next.mood === 'working' && prev.mood === 'idle')
        ev.push('working');
    if (prev.focus === 'focus' && next.focus !== 'focus')
        ev.push('focusdone');
    if (next.dayKey && prev.dayKey && next.dayKey !== prev.dayKey && !next.away)
        ev.push('dayStart');
    else if (prev.away && !next.away)
        ev.push('wake');
    if (next.focus === 'break' && prev.focus !== 'break')
        ev.push('break');
    if (next.charging && !prev.charging && isIdle(next))
        ev.push('charger');
    if (next.music && prev.music && next.track && prev.track && next.track !== prev.track)
        ev.push('track');
    if (wantsLunch(next) && !wantsLunch(prev))
        ev.push('eat');
    return ev;
}

// Lunch: once a day, in the window, only while nothing else is going on.
export function wantsLunch(s) {
    return isIdle(s) && !s.rain && !s.snow && s.minutes >= LUNCH[0] && s.minutes <= LUNCH[1]
        && s.mem?.lastFed !== s.dayKey;
}

// A mushroom shows up once a day in the late afternoon, while idle.
export function wantsMushroom(s) {
    return isIdle(s) && s.minutes >= MUSHROOM_AFTER && s.mem?.lastMushroom !== s.dayKey;
}

// The strongest of several simultaneous events, or null.
export function strongest(events) {
    return events.length ? events.reduce((a, b) => (rank(b) < rank(a) ? b : a)) : null;
}

export function sheltering(s) {
    return (s.rain || s.snow) && isIdle(s);
}

// The pose held between acts.
export function restAct(s) {
    if (s.focus === 'break')
        return 'flop';
    if (s.mood !== 'idle' || s.focus === 'focus')
        return 'sit';
    if (s.nap === 'doze')
        return 'doze';
    if (s.away || s.night || s.nap)
        return 'sleep';
    if ((s.low && !s.charging) || (s.needs && s.needs.energy < 25 && !s.nap))
        return 'tired';
    return 'sit';
}

// How much pill the companion gets: the wide meadow only when it has a life to
// live in it; compact whenever you are busy or it is resting.
export function meadow(s) {
    // (a lively nap keeps the meadow: it wakes in a few seconds)
    if (s.mood !== 'idle' || s.focus !== 'idle' || s.calm || s.away || s.night || sheltering(s))
        return 'compact';
    if (s.low && !s.charging)
        return 'compact';
    return 'wide';
}

// 'wander', 'turn', 'twostep', 'chase' are moves the player builds from
// frames; the rest are frame acts.
const IDLE_ACTS = ['blink', 'blink', 'flick', 'look', 'nibble', 'sniff', 'groom', 'wander', 'wander', 'turn', 'dig', 'sniffup', 'chase'];
// With music it wears the earpiece (the player picks '<act>@music' frames):
// mostly bobs, every so often a two-step.
const MUSIC_ACTS = ['bob', 'bob', 'bob', 'twostep', 'flick', 'look', 'sniff'];
// Lively: the day's habits as idle moves too. 'meal' is lunch without the
// memory (the real lunch still happens); naps come in kinds (see NAPS).
const LIVELY_ACTS = [...IDLE_ACTS, 'wander:patrol', 'wander:explore', 'chase', 'snack', 'meal', 'nap:doze', 'nap:nap', 'twostep'];

// ---- repertoire -----------------------------------------------------------
// Wandering styles the player builds from hops: 'hop' one hop anywhere,
// 'patrol' edge to edge, 'explore' three short hops one way then a sniff,
// 'zigzag' small hops side to side, 'cautious' hop, sniff, hop.
export const WANDER_STYLES = ['hop', 'patrol', 'explore', 'zigzag', 'cautious'];

// Routines: little stories of several moves. A step is 'act' or 'act:param'.
export const ROUTINES = {
    forage:   ['wander:explore', 'sniff', 'nibble', 'wander:hop', 'nibble', 'groom'],
    patrol:   ['wander:patrol', 'sniffup', 'turn', 'wander:patrol', 'look'],
    zoomies:  ['twostep', 'binky', 'wander:zigzag', 'shake'],
    wash:     ['groom', 'groom', 'shake', 'look', 'flick'],
    digfind:  ['dig', 'dig', 'chase', 'sniff'],
    watch:    ['look', 'sniffup', 'turn', 'look', 'flick'],
    lazy:     ['stretch', 'nap:doze', 'yawn', 'groom'],
    siesta:   ['wander:patrol', 'nap:deep', 'stretch', 'yawn', 'shake'],
    mealtime: ['meal', 'groom', 'nap:doze'],
    cautious: ['wander:cautious', 'sniffup', 'wander:cautious', 'groom'],
    dance:    ['bob', 'twostep', 'bob', 'shake', 'bob'],
};

// Time of day shapes the energy: which routines are likely.
export function period(minutes) {
    if (minutes < 11 * 60)
        return 'morning';
    if (minutes < 14 * 60)
        return 'midday';
    if (minutes < 17 * 60)
        return 'afternoon';
    return 'evening';
}

const ENERGY = {
    morning:   { zoomies: 3, forage: 3, patrol: 2, digfind: 2, watch: 1, wash: 1, cautious: 1, lazy: 0, siesta: 0, mealtime: 0 },
    midday:    { forage: 3, mealtime: 2, watch: 2, patrol: 1, digfind: 1, wash: 1, cautious: 1, lazy: 1, zoomies: 1, siesta: 0 },
    afternoon: { lazy: 3, siesta: 2, wash: 2, watch: 1, forage: 1, cautious: 1, patrol: 1, digfind: 1, zoomies: 0, mealtime: 0 },
    evening:   { watch: 3, wash: 2, lazy: 2, cautious: 2, forage: 1, patrol: 1, siesta: 1, digfind: 0, zoomies: 0, mealtime: 0 },
};

// Pick a routine for the moment: weighted by the time of day, 'dance' only with music.
export function pickRoutine(s, rand) {
    if (s.music)
        return 'dance';
    let w = ENERGY[period(s.minutes)];
    let total = Object.values(w).reduce((a, b) => a + b, 0);
    let r = rand * total;
    for (let [name, k] of Object.entries(w)) {
        r -= k;
        if (r < 0 && k > 0)
            return name;
    }
    return 'watch';
}

// Non-lively: a routine now and then (every 4th-ish idle slot); lively: every other one.
export function wantsRoutine(s, rand) {
    return s.lively ? rand < 0.5 : rand < 0.25;
}

// Naps: how long each kind lasts (ms). A doze is sitting with eyes shut, a nap
// and a deep sleep lie down (deep breathes slower). It stretches awake after.
export const NAPS = { doze: [4000, 7000], nap: [8000, 15000], deep: [20000, 40000] };

export function napLength(kind, rand) {
    let [a, b] = NAPS[kind] ?? NAPS.nap;
    return a + (b - a) * rand;
}

// The rest pose's breathing: the frame act to alternate with, and how often.
// Only sitting and sleeping breathe; flopped and tired hold still.
export function breathing(s) {
    let rest = restAct(s);
    if (rest === 'sit')
        return { act: 'breathe', ms: 1600 };
    if (rest === 'doze')
        return { act: 'dozebreathe', ms: 2200 };
    if (rest === 'sleep')
        return { act: 'sleepbreathe', ms: s.nap === 'deep' ? 3400 : 2600 };
    return null;
}

// Next timed act and the wait before it, or null to hold the rest pose with no
// timer at all (sleeping, tired, flopped, or calm with nothing to signal).
// `rand` is a number in [0, 1).
export function ambient(s, rand) {
    if (s.mood === 'waiting')
        return { act: 'thump', delay: 3000 };
    if (s.mood === 'working')
        return { act: 'run', delay: 3000 };
    let need = needAct(s, (rand * 104729) % 1);   // hungry, scruffy or exhausted comes first
    if (need)
        return need;
    if (restAct(s) !== 'sit')
        return null;
    if (s.focus === 'focus')   // keeps you company, quietly
        return { act: 'blink', delay: 15000 + 15000 * rand };
    if (sheltering(s))
        return { act: 'shiver', delay: 6000 + 6000 * rand };
    if (s.unread >= 5)         // a quiet nudge: faces the bell, ears up, now and then
        return { act: 'perk', delay: 15000 + 10000 * rand };
    if (s.calm)
        return null;
    // `rand` also decides whether this slot is a single move or a routine
    // (the player runs a routine's steps back to back). Spread the one random
    // number: its high bits pick, its low bits time.
    let r2 = (rand * 7919) % 1;
    if (!s.calm && wantsRoutine(s, r2)) {
        let name = pickRoutine(s, rand);
        return { routine: name, steps: ROUTINES[name], delay: (s.lively ? 2000 + 3000 * rand : 20000 + 40000 * rand) };
    }
    if (s.music)
        return { act: MUSIC_ACTS[Math.floor(rand * MUSIC_ACTS.length)], delay: 1500 + 2500 * rand };
    if (s.lively)
        return { act: LIVELY_ACTS[Math.floor(rand * LIVELY_ACTS.length)], delay: 2000 + 3000 * rand };
    return { act: IDLE_ACTS[Math.floor(rand * IDLE_ACTS.length)], delay: 3000 + 5000 * rand };
}

// Which way it should face between acts: 1 right (toward the clock and the
// bell), -1 left. null = keep.
export function facing(s) {
    return s.unread >= 5 ? 1 : null;
}

// WMO weather codes (open-meteo) to what the meadow shows.
export function weatherKind(code) {
    if (code == null)
        return null;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95)
        return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86)
        return 'snow';
    return null;
}

// Night from the weather helper's sun times (ms today) when known, else by hour.
export function isNight(nowMs, sunriseMs, sunsetMs, hour) {
    if (sunriseMs && sunsetMs)
        return nowMs < sunriseMs || nowMs > sunsetMs + 2 * 3600 * 1000;
    return hour >= 23 || hour < 6;
}

export const SPECIES = ['rabbit', 'cat', 'fox'];

export function cleanSpecies(v) {
    return SPECIES.includes(v) ? v : 'rabbit';
}

// ---- needs: the four bars of the Pet tab ---------------------------------
// Computed from the last saved values and their timestamp, never ticked, so
// nothing runs while the tab is closed. 0..100. Nothing bad happens at the
// floor: the worst state is "a bit scruffy and sleepy".
export const NEED_KEYS = ['energy', 'hunger', 'mood', 'clean'];
const MIN = 60 * 1000;
// per-minute drift while awake / asleep
const DRIFT = {
    energy: { awake: -1 / 10, asleep: +1 },
    hunger: { awake: +1 / 15, asleep: +1 / 30 },
    mood:   { awake: -1 / 30, asleep: 0 },
    clean:  { awake: -1 / 60, asleep: 0 },
};
const clamp = v => Math.max(0, Math.min(100, Math.round(v * 10) / 10));

export function freshNeeds(nowMs) {
    return { energy: 80, hunger: 30, mood: 70, clean: 80, at: nowMs };
}

// Bring saved needs up to `nowMs`. `asleep` is how it spent the gap.
export function progressNeeds(saved, nowMs, asleep = false) {
    let mins = Math.max(0, (nowMs - (saved.at || nowMs)) / MIN);
    let out = { at: nowMs };
    for (let k of NEED_KEYS)
        out[k] = clamp((saved[k] ?? freshNeeds(nowMs)[k]) + mins * DRIFT[k][asleep ? 'asleep' : 'awake']);
    return out;
}

// What an event does to the needs (deltas), by name.
export const NEED_EFFECTS = {
    meal:   { hunger: -40, mood: +4 },
    snack:  { hunger: -15, mood: +2 },
    treat:  { hunger: -8, mood: +3 },
    pet:    { mood: +10 },
    play:   { mood: +5, energy: -3 },        // a chase or a two-step
    music:  { mood: +1 },                    // per minute, applied by the notch
    focusdone: { mood: +8 },
    groom:  { clean: +15 },
    bath:   { clean: +60, mood: +2 },
    dig:    { clean: -10 },
    rain:   { clean: -5 },
    napEnd: { energy: +8 },                  // a deep nap; shorter naps use progressNeeds
    missed: { mood: -5 },                    // a Claude wait left over 10 min
};

export function applyNeed(needs, event) {
    let d = NEED_EFFECTS[event];
    if (!d)
        return needs;
    let out = { ...needs };
    for (let [k, v] of Object.entries(d))
        out[k] = clamp((out[k] ?? 50) + v);
    return out;
}

// One line for the tab, from the lowest need first.
export function thought(n, s = {}) {
    if (s.away === false && s.justBack)
        return 'happy you\'re back';
    if (n.energy < 25)
        return 'sleepy';
    if (n.hunger > 70)
        return 'hungry';
    if (n.clean < 30)
        return 'a bit scruffy';
    if (n.mood < 30)
        return 'wants some company';
    if (n.mood > 90)
        return 'full of beans';
    if (n.hunger < 25 && n.energy > 60)
        return 'content';
    return 'doing fine';
}

// Needs that change what it does on its own. Returns an ambient override or null.
export function needAct(s, rand) {
    let n = s.needs;
    if (!n || !isIdle(s) || s.calm || s.night || s.nap || sheltering(s) || s.focus !== 'idle')
        return null;
    if (n.energy < 15)
        return { act: 'nap:nap', delay: 2000 };
    if (n.hunger > 70 && rand < 0.5)
        return { act: rand < 0.25 ? 'seek' : 'sigh', delay: 180000 + 120000 * rand };   // every 3-5 min
    if (n.clean < 50 && rand < 0.3)
        return { act: 'groom', delay: 20000 + 20000 * rand };
    return null;
}

// ---- finds: what digging and living turn up --------------------------------
export const FINDS = {
    treat:  { kind: 'food', name: 'a treat', weight: 8 },
    cap:    { kind: 'keepsake', name: 'a bottle cap', weight: 5 },
    pebble: { kind: 'keepsake', name: 'a shiny pebble', weight: 5 },
    seed:   { kind: 'seed', name: 'a seed', weight: 3 },
    ribbon: { kind: 'wear', slot: 'neck', name: 'a ribbon', weight: 1 },
    beanie: { kind: 'wear', slot: 'head', name: 'a beanie', weight: 1 },
};
export const WEARABLES = {
    straw:  { slot: 'head', name: 'a straw hat' },
    beanie: { slot: 'head', name: 'a beanie' },
    crown:  { slot: 'head', name: 'a tiny crown' },
    bell:   { slot: 'neck', name: 'a bell collar' },
    ribbon: { slot: 'neck', name: 'a ribbon' },
    scarf:  { slot: 'neck', name: 'a scarf' },
};
export const DIG_FIND_CHANCE = 0.2;

// A dig's find, or null. rand in [0,1): the first fifth finds something.
export function digFind(rand) {
    if (rand >= DIG_FIND_CHANCE)
        return null;
    let r = (rand / DIG_FIND_CHANCE) * Object.values(FINDS).reduce((a, f) => a + f.weight, 0);
    for (let [id, f] of Object.entries(FINDS)) {
        r -= f.weight;
        if (r < 0)
            return id;
    }
    return 'treat';
}

// Earned finds from living: a treat per finished focus, a seed per closed
// Claude session, a straw hat at a 5-day meal streak, the bell at 7.
export function earned(event, streakDays) {
    if (event === 'focusdone')
        return 'treat';
    if (event === 'finished')
        return 'seed';
    if (event === 'streak' && streakDays === 5)
        return 'straw';
    if (event === 'streak' && streakDays === 7)
        return 'bell';
    return null;
}
