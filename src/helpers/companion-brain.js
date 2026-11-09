// What the pill rabbit does, as pure functions (no Shell imports, so
// tests/companion-check.js runs with plain gjs). The player in companion.js
// asks these and only draws.
//
// State: { mood: 'idle'|'working'|'waiting', fresh: finished-unseen count,
//          focus: 'idle'|'focus'|'break', music, low, charging, away, hour, calm }

// Reactions, strongest first: a weaker one never cuts a stronger one short.
const RANK = ['waiting', 'finished', 'working', 'wake', 'break', 'notification', 'charger'];

export const REACTION_ACT = {
    waiting: 'thump',       // rabbits thump to warn: needs you
    finished: 'binky',      // happy twist jump
    working: 'hop',
    wake: 'stretch',
    break: 'stretch',
    notification: 'perk',
    charger: 'nibble',      // "fed"
};

// Ambient acts fire on a timer; they rank below every reaction.
export function rank(event) {
    let i = RANK.indexOf(event);
    return i < 0 ? Infinity : i;
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
    if (prev.away && !next.away)
        ev.push('wake');
    if (next.focus === 'break' && prev.focus !== 'break')
        ev.push('break');
    if (next.charging && !prev.charging)
        ev.push('charger');
    return ev;
}

// The strongest of several simultaneous events, or null.
export function strongest(events) {
    return events.length ? events.reduce((a, b) => (rank(b) < rank(a) ? b : a)) : null;
}

export function isNight(hour) {
    return hour >= 23 || hour < 6;
}

// The pose held between acts.
export function restAct(s) {
    if (s.focus === 'break')
        return 'flop';
    if (s.mood !== 'idle' || s.focus === 'focus')
        return 'sit';
    if (s.away || isNight(s.hour))
        return 'sleep';
    if (s.low && !s.charging)
        return 'tired';
    return 'sit';
}

const IDLE_ACTS = ['blink', 'blink', 'flick', 'look', 'nibble'];

// Next timed act and the wait before it, or null to hold the rest pose with no
// timer at all (sleeping, tired, flopped, or calm with nothing to signal).
// `rand` is a number in [0, 1).
export function ambient(s, rand) {
    if (s.mood === 'waiting')
        return { act: 'thump', delay: 3000 };
    if (s.mood === 'working')
        return { act: 'run', delay: 3000 };
    if (restAct(s) !== 'sit' || s.calm)
        return null;
    if (s.focus === 'focus')
        return { act: 'blink', delay: 30000 + 30000 * rand };
    if (s.music)   // ear flicks along with the music
        return { act: rand < 0.6 ? 'flick' : 'look', delay: 8000 + 6000 * rand };
    return { act: IDLE_ACTS[Math.floor(rand * IDLE_ACTS.length)], delay: 20000 + 40000 * rand };
}
