// Self-check for src/helpers/companion-brain.js and the shipped rabbit frames.
// Run: gjs -m tests/companion-check.js   Exits non-zero on the first failure.

import Gio from 'gi://Gio';
import { diffEvents, strongest, restAct, ambient, rank, REACTION_ACT } from '../src/helpers/companion-brain.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}`);

const base = { mood: 'idle', fresh: 0, focus: 'idle', music: false, low: false, charging: false, away: false, hour: 14, calm: false };
const s = o => ({ ...base, ...o });

// events
eq(diffEvents(base, base), [], 'no change, no events');
eq(diffEvents(base, s({ mood: 'working' })), ['working'], 'idle -> working');
eq(diffEvents(s({ mood: 'waiting' }), s({ mood: 'working' })), [], 'waiting -> working is not a new start');
eq(diffEvents(s({ mood: 'working' }), s({ mood: 'waiting', fresh: 1 })), ['waiting', 'finished'], 'two at once');
eq(diffEvents(s({ away: true }), base), ['wake'], 'back from away');
eq(diffEvents(s({ focus: 'focus' }), s({ focus: 'break' })), ['break'], 'break starts');
eq(diffEvents(base, s({ charging: true })), ['charger'], 'charger in');
eq(diffEvents(s({ fresh: 2 }), s({ fresh: 1 })), [], 'seen sessions are not finishes');

// priority
eq(strongest(['notification', 'finished', 'working']), 'finished', 'finished beats working and notification');
eq(strongest(['charger', 'waiting']), 'waiting', 'waiting beats all');
eq(strongest([]), null, 'nothing');
ok(rank('flick') === Infinity, 'ambient acts rank below reactions');

// rest pose
eq(restAct(base), 'sit', 'day idle sits');
eq(restAct(s({ hour: 23 })), 'sleep', 'night sleeps');
eq(restAct(s({ hour: 3, mood: 'working' })), 'sit', 'never sleeps while Claude works');
eq(restAct(s({ away: true, focus: 'focus' })), 'sit', 'never sleeps during focus');
eq(restAct(s({ focus: 'break' })), 'flop', 'break flops');
eq(restAct(s({ low: true })), 'tired', 'low battery');
eq(restAct(s({ low: true, charging: true })), 'sit', 'charging is not tired');

// ambient
eq(ambient(s({ mood: 'waiting', calm: true }), 0.5), { act: 'thump', delay: 3000 }, 'waiting thumps even when calm');
eq(ambient(s({ mood: 'working' }), 0.5).act, 'run', 'working runs');
eq(ambient(s({ hour: 2 }), 0.5), null, 'sleeping: no timer');
eq(ambient(s({ calm: true }), 0.5), null, 'calm: no idle acts');
for (let r of [0, 0.25, 0.5, 0.75, 0.999]) {
    let a = ambient(base, r);
    ok(a.delay >= 20000 && a.delay <= 60000, `idle delay in 20-60 s (${a.delay})`);
    ok(['blink', 'flick', 'look', 'nibble'].includes(a.act), `idle act ${a.act}`);
}
ok(ambient(s({ music: true }), 0.1).delay < 20000, 'music: livelier');

// shipped frames: every act exists, every frame file exists, no act longer than 1.2 s
const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('src').get_child('rabbit');
const spec = JSON.parse(new TextDecoder().decode(dir.get_child('acts.json').load_contents(null)[1]));
const needed = new Set([...Object.values(REACTION_ACT), 'sit', 'blink', 'flick', 'look', 'nibble', 'run', 'thump', 'sleep', 'flop', 'tired']);
for (let act of needed)
    ok(spec.acts[act], `act ${act} shipped`);
for (let [act, a] of Object.entries(spec.acts)) {
    ok(a.frames.length === a.y.length, `${act}: one y per frame`);
    ok(a.frames.length * 1000 / spec.fps <= 1200, `${act} lasts <= 1.2 s`);
    for (let f of a.frames)
        ok(dir.get_child(f).query_exists(null), `${act}: ${f} exists`);
}

print(`companion-check: ${n} checks passed`);
