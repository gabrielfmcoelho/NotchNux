// Self-check for src/helpers/companion-brain.js and the shipped companion frames.
// Run: gjs -m tests/companion-check.js   Exits non-zero on the first failure.

import Gio from 'gi://Gio';
import {
    diffEvents, strongest, restAct, ambient, breathing, rank, REACTION_ACT, meadow, wantsLunch, wantsMushroom,
    sheltering, facing, weatherKind, isNight, cleanSpecies, SPECIES, isIdle,
} from '../src/helpers/companion-brain.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}`);

const base = { mood: 'idle', fresh: 0, focus: 'idle', music: false, track: null, low: false, charging: false, away: false,
    night: false, rain: false, snow: false, wind: 0, unread: 0, calm: false, minutes: 14 * 60, dayKey: '2026-11-09',
    mem: { lastFed: null, lastMushroom: null } };
const s = o => ({ ...base, ...o });

// events
eq(diffEvents(base, base), [], 'no change, no events');
eq(diffEvents(base, s({ mood: 'working' })), ['working'], 'idle -> working');
eq(diffEvents(s({ mood: 'waiting' }), s({ mood: 'working' })), [], 'waiting -> working is not a new start');
eq(diffEvents(s({ mood: 'working' }), s({ mood: 'waiting', fresh: 1 })), ['waiting', 'finished'], 'two at once');
eq(diffEvents(s({ away: true }), base), ['wake'], 'back from away');
eq(diffEvents(s({ away: true, dayKey: '2026-11-08' }), base), ['dayStart'], 'first input of a new day');
eq(diffEvents(s({ dayKey: '2026-11-08' }), s({ away: true })), [], 'the day turns while away: wait for the user');
eq(diffEvents(s({ focus: 'focus' }), s({ focus: 'break' })), ['focusdone', 'break'], 'focus ends into a break');
eq(diffEvents(s({ focus: 'focus' }), base), ['focusdone'], 'focus ends');
eq(diffEvents(base, s({ charging: true })), ['charger'], 'charger in');
eq(diffEvents(s({ mood: 'working' }), s({ mood: 'working', charging: true })), [], 'no snack while Claude works');
eq(diffEvents(s({ fresh: 2 }), s({ fresh: 1 })), [], 'seen sessions are not finishes');
eq(diffEvents(s({ music: true, track: 'a' }), s({ music: true, track: 'b' })), ['track'], 'track change');
eq(diffEvents(s({ music: false, track: 'a' }), s({ music: true, track: 'b' })), [], 'play start is not a track change');
eq(diffEvents(s({ minutes: 11 * 60 }), s({ minutes: 12 * 60 })), ['eat'], 'lunch window opens');

// priority
eq(strongest(['notification', 'finished', 'working']), 'finished', 'finished beats working and notification');
eq(strongest(['charger', 'waiting']), 'waiting', 'waiting beats all');
eq(strongest(['focusdone', 'break']), 'focusdone', 'the binky, then the flop next time');
eq(strongest(['pet', 'eat']), 'eat', 'a meal is not interrupted by a pet');
eq(strongest([]), null, 'nothing');
ok(rank('flick') === Infinity, 'ambient acts rank below reactions');
for (let ev of Object.keys(REACTION_ACT))
    ok(rank(ev) < Infinity, `${ev} has a rank`);

// lunch and mushroom, once a day
ok(wantsLunch(s({ minutes: 12 * 60 + 30 })), 'lunch in the window');
ok(!wantsLunch(s({ minutes: 12 * 60 + 30, mem: { lastFed: '2026-11-09' } })), 'already fed today');
ok(wantsLunch(s({ minutes: 12 * 60 + 30, mem: { lastFed: '2026-11-08' } })), 'fed yesterday: hungry again');
ok(!wantsLunch(s({ minutes: 12 * 60 + 30, mood: 'working' })), 'no lunch while Claude works');
ok(!wantsLunch(s({ minutes: 12 * 60 + 30, focus: 'focus' })), 'no lunch during focus');
ok(!wantsLunch(s({ minutes: 12 * 60 + 30, rain: true })), 'no lunch in the rain');
ok(!wantsLunch(s({ minutes: 14 * 60 })), 'window closed');
ok(wantsMushroom(s({ minutes: 16 * 60 + 5 })), 'mushroom after 16:00');
ok(!wantsMushroom(s({ minutes: 16 * 60 + 5, mem: { lastMushroom: '2026-11-09' } })), 'one mushroom a day');
ok(!wantsMushroom(s({ minutes: 15 * 60 })), 'no mushroom before');

// rest pose
eq(restAct(base), 'sit', 'day idle sits');
eq(restAct(s({ night: true })), 'sleep', 'night sleeps');
eq(restAct(s({ night: true, mood: 'working' })), 'sit', 'never sleeps while Claude works');
eq(restAct(s({ away: true, focus: 'focus' })), 'sit', 'never sleeps during focus');
eq(restAct(s({ focus: 'break' })), 'flop', 'break flops');
eq(restAct(s({ low: true })), 'tired', 'low battery');
eq(restAct(s({ low: true, charging: true })), 'sit', 'charging is not tired');

// meadow width: every row of the plan's table
eq(meadow(base), 'wide', 'idle daytime: wide');
eq(meadow(s({ music: true })), 'wide', 'music: wide');
eq(meadow(s({ mood: 'working' })), 'compact', 'Claude working: compact');
eq(meadow(s({ mood: 'waiting', music: true })), 'compact', 'Claude wins over music');
eq(meadow(s({ focus: 'focus' })), 'compact', 'focus: compact');
eq(meadow(s({ focus: 'break' })), 'compact', 'break: compact');
eq(meadow(s({ calm: true })), 'compact', 'calm: compact');
eq(meadow(s({ night: true })), 'compact', 'asleep: compact');
eq(meadow(s({ away: true })), 'compact', 'away: compact');
eq(meadow(s({ rain: true })), 'compact', 'sheltering: compact');
eq(meadow(s({ low: true })), 'compact', 'tired: compact');

// ambient
eq(ambient(s({ mood: 'waiting', calm: true }), 0.5), { act: 'thump', delay: 3000 }, 'waiting thumps even when calm');
eq(ambient(s({ mood: 'working' }), 0.5).act, 'run', 'working runs');
eq(ambient(s({ night: true }), 0.5), null, 'sleeping: no timer');
eq(ambient(s({ calm: true }), 0.5), null, 'calm: no idle acts');
eq(ambient(s({ rain: true }), 0).act, 'shiver', 'rain: shivers under the leaf');
ok(ambient(s({ rain: true }), 0).delay >= 6000, 'shiver is rare');
eq(ambient(s({ unread: 5 }), 0).act, 'perk', '5 unread: perks toward the bell');
eq(facing(s({ unread: 5 })), 1, 'faces the bell (right)');
eq(facing(base), null, 'otherwise keeps facing');
const seen = new Set();
for (let i = 0; i < 100; i++) {
    let a = ambient(base, i / 100);
    ok(a.delay >= 3000 && a.delay <= 8000, `idle delay in 3-8 s (${a.delay})`);
    seen.add(a.act);
}
eq([...seen].sort(), ['blink', 'chase', 'dig', 'flick', 'groom', 'look', 'nibble', 'sniff', 'sniffup', 'turn', 'wander'], 'every idle move gets picked');
const music = new Set();
for (let i = 0; i < 100; i++)
    music.add(ambient(s({ music: true }), i / 100).act);
ok(music.has('bob') && music.has('twostep'), 'music: bobs and two-steps');
ok(ambient(s({ music: true }), 0.1).delay <= 4000, 'music: lively');
ok(ambient(s({ focus: 'focus' }), 0).delay >= 15000, 'focus: quiet');

// breathing
eq(breathing(base), { act: 'breathe', ms: 1600 }, 'sitting breathes');
eq(breathing(s({ night: true })), { act: 'sleepbreathe', ms: 2600 }, 'sleeping breathes slower');
eq(breathing(s({ focus: 'break' })), null, 'flopped holds still');
eq(breathing(s({ low: true })), null, 'tired holds still');

// weather and night
eq(weatherKind(0), null, 'clear');
eq(weatherKind(61), 'rain', 'rain');
eq(weatherKind(80), 'rain', 'showers');
eq(weatherKind(95), 'rain', 'thunderstorm counts as rain');
eq(weatherKind(71), 'snow', 'snow');
eq(weatherKind(85), 'snow', 'snow showers');
eq(weatherKind(undefined), null, 'no weather yet');
ok(sheltering(s({ snow: true })), 'snow: shelters');
ok(!sheltering(s({ rain: true, mood: 'working' })), 'no shelter act while Claude works');
const day = new Date(2026, 10, 9);
const t = h => day.getTime() + h * 3600 * 1000;
ok(!isNight(t(12), t(6), t(18), 12), 'noon is day');
ok(!isNight(t(19.5), t(6), t(18), 19), 'two hours after sunset is still evening');
ok(isNight(t(20.5), t(6), t(18), 20), 'past sunset + 2 h is night');
ok(isNight(t(5), t(6), t(18), 5), 'before sunrise is night');
ok(isNight(0, 0, 0, 23) && !isNight(0, 0, 0, 7), 'falls back to the hour without sun times');

// species
eq(cleanSpecies('cat'), 'cat', 'cat');
eq(cleanSpecies('dragon'), 'rabbit', 'unknown -> rabbit');
ok(isIdle(base) && !isIdle(s({ away: true })), 'idle means present and free');

// shipped frames: every species has every act, every frame file, props and food, no act longer than 1.2 s
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('src').get_child('companions');
const needed = new Set([...Object.values(REACTION_ACT).flat().filter(a => !['eat', 'snack'].includes(a)),
    'sit', 'blink', 'flick', 'look', 'nibble', 'sniff', 'groom', 'hop', 'run', 'thump', 'sleep', 'flop', 'tired',
    'breathe', 'sleepbreathe', 'bob', 'dig', 'sniffup', 'shiver', 'yawn', 'shake', 'pet',
    'bob@music', 'sit@music', 'breathe@music', 'hop@music', 'dig@music']);
for (let sp of SPECIES) {
    let dir = root.get_child(sp);
    let spec = JSON.parse(new TextDecoder().decode(dir.get_child('acts.json').load_contents(null)[1]));
    for (let act of needed)
        ok(spec.acts[act], `${sp}: act ${act} shipped`);
    for (let [act, a] of Object.entries(spec.acts)) {
        ok(a.frames.length === a.y.length, `${sp}/${act}: one y per frame`);
        ok(a.frames.length * 1000 / spec.fps <= 1200, `${sp}/${act} lasts <= 1.2 s`);
        for (let f of a.frames)
            ok(dir.get_child(f).query_exists(null), `${sp}/${act}: ${f} exists`);
    }
    for (let f of ['food-whole', 'food-half', 'food-stub', 'prop-mushroom', 'prop-bit', 'prop-flower-bud', 'prop-flower', 'prop-leaf', 'prop-drop', 'prop-flake'])
        ok(dir.get_child(`${f}-symbolic.svg`).query_exists(null), `${sp}: ${f} shipped`);
}

print(`companion-check: ${n} checks passed`);
