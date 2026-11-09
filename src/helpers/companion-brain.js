// What the pill companion does, as pure functions (no Shell imports, so
// tests/companion-check.js runs with plain gjs). The player in companion.js
// asks these and only draws.
//
// State (built by the notch each update):
//   mood 'idle'|'working'|'waiting', fresh (Claude sessions finished unseen),
//   focus 'idle'|'focus'|'break', music, track (id of the playing track),
//   low, charging, away, night, rain, snow, wind (km/h), unread, calm,
//   minutes (of the day), dayKey ('2026-11-09'),
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
    if (s.away || s.night)
        return 'sleep';
    if (s.low && !s.charging)
        return 'tired';
    return 'sit';
}

// How much pill the companion gets: the wide meadow only when it has a life to
// live in it; compact whenever you are busy or it is resting.
export function meadow(s) {
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

// The rest pose's breathing: the frame act to alternate with, and how often.
// Only sitting and sleeping breathe; flopped and tired hold still.
export function breathing(s) {
    let rest = restAct(s);
    if (rest === 'sit')
        return { act: 'breathe', ms: 1600 };
    if (rest === 'sleep')
        return { act: 'sleepbreathe', ms: 2600 };
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
    if (s.music)
        return { act: MUSIC_ACTS[Math.floor(rand * MUSIC_ACTS.length)], delay: 1500 + 2500 * rand };
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
