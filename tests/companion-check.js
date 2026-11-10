// Self-check for src/helpers/companion-brain.js and the shipped companion frames.
// Run: gjs -m tests/companion-check.js   Exits non-zero on the first failure.

import Gio from 'gi://Gio';
import {
    diffEvents, strongest, restAct, ambient, breathing, rank, REACTION_ACT, meadow, wantsLunch, wantsMushroom,
    sheltering, facing, weatherKind, isNight, cleanSpecies, SPECIES, isIdle, napLength, NAPS,
    ROUTINES, WANDER_STYLES, period, pickRoutine, wantsRoutine, splitHops, WEARABLES, HOUSE_STYLES,
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
    night: false, rain: false, snow: false, wind: 0, unread: 0, calm: false, lively: false, nap: false, minutes: 14 * 60, dayKey: '2026-11-09',
    mem: { lastFed: null, lastMushroom: null } };
const s = o => ({ ...base, ...o });

// long trips become several hops
{
    let look = { act: 'look' }, near = { act: 'hop', to: 80 };
    eq(splitHops([look, near], 10, 0, 88, 88), [look, near], 'a pill-sized hop is left alone');
    let started = 0, far = { act: 'hop', to: 400, onStart: () => started++ };
    let trip = splitHops([far, { act: 'sniff' }, { act: 'hop', to: 10 }], 100, 84, 464, 176);
    eq(trip.map(i => [i.act, i.to]), [['hop', 250], ['hop', 400], ['sniff', undefined], ['hop', 242], ['hop', 84]],
        'split evenly, each hop within the limit, the next trip from where the last ended, clamped');
    trip.forEach(i => i.onStart?.());
    eq(started, 1, 'the trip\'s onStart runs once, with its first hop');
}

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
let routines = 0;
for (let i = 0; i < 400; i++) {
    let a = ambient(base, i / 400);
    if (a.routine) {
        routines++;
        ok(a.delay >= 20000 && a.delay <= 60000, `quiet routine every 20-60 s (${a.delay})`);
        ok(ROUTINES[a.routine] === a.steps, 'routine steps come from the table');
        continue;
    }
    ok(a.delay >= 3000 && a.delay <= 8000, `idle delay in 3-8 s (${a.delay})`);
    seen.add(a.act);
}
eq([...seen].sort(), ['blink', 'chase', 'dig', 'flick', 'groom', 'look', 'nibble', 'sniff', 'sniffup', 'turn', 'wander'], 'every idle move gets picked');
ok(routines > 60 && routines < 140, `about a quarter of quiet slots are routines (${routines}/400)`);
const music = new Set();
for (let i = 0; i < 100; i++)
    music.add(ambient(s({ music: true }), i / 100).act);
ok(music.has('bob') && music.has('twostep'), 'music: bobs and two-steps');
ok(ambient(s({ music: true }), 0.1).delay <= 4000, 'music: lively');
ok(ambient(s({ focus: 'focus' }), 0).delay >= 15000, 'focus: quiet');

// lively: the whole life every few seconds
const lively = new Set();
for (let i = 0; i < 200; i++) {
    let a = ambient(s({ lively: true }), i / 200);
    ok(a.delay >= 2000 && a.delay <= 5000, `lively delay in 2-5 s (${a.delay})`);
    if (a.routine) {
        ok(ROUTINES[a.routine], `lively routine ${a.routine} exists`);
        continue;
    }
    lively.add(a.act);
}
for (let a of ['nap:doze', 'nap:nap', 'snack', 'meal', 'chase', 'wander:patrol', 'wander:explore', 'twostep', 'dig', 'groom'])
    ok(lively.has(a), `lively picks ${a}`);
eq(ambient(s({ lively: true, music: true }), 0.5).act !== 'nap', true, 'music still has the music moves');
eq(ambient(s({ lively: true, calm: true }), 0.5), null, 'calm wins over lively');
eq(restAct(s({ nap: true })), 'sleep', 'a nap is a short sleep');
eq(restAct(s({ nap: true, mood: 'working' })), 'sit', 'a nap ends when Claude works');
eq(meadow(s({ nap: true })), 'wide', 'a nap keeps the meadow');
eq(ambient(s({ nap: true, lively: true }), 0.5), null, 'no moves while napping');
eq(breathing(s({ nap: true })), { act: 'sleepbreathe', ms: 2600 }, 'napping breathes slowly');
ok(napLength('nap', 0) >= 8000 && napLength('nap', 0.999) <= 15000, 'a nap is 8-15 s');
ok(napLength('doze', 0.999) <= 7000 && napLength('deep', 0) >= 20000, 'a doze is short, a deep sleep long');
eq(napLength('what', 0), NAPS.nap[0], 'unknown kind: a nap');
eq(restAct(s({ nap: 'doze' })), 'doze', 'dozing sits with eyes shut');
eq(restAct(s({ nap: 'deep' })), 'sleep', 'deep sleep lies down');
eq(breathing(s({ nap: 'deep' })).ms, 3400, 'deep sleep breathes slower');
eq(breathing(s({ nap: 'doze' })).act, 'dozebreathe', 'dozing has its own breath');

// repertoire
const known = new Set(['sit', 'blink', 'flick', 'look', 'nibble', 'sniff', 'groom', 'hop', 'run', 'thump', 'binky', 'stretch',
    'yawn', 'shake', 'dig', 'sniffup', 'pet', 'shiver', 'bob', 'perk', 'flop', 'tired', 'sleep', 'doze',
    'wander', 'turn', 'twostep', 'chase', 'eat', 'meal', 'snack', 'nap']);
for (let [name, steps] of Object.entries(ROUTINES)) {
    ok(steps.length >= 3 && steps.length <= 6, `${name}: 3-6 steps`);
    for (let st of steps) {
        let [act, param] = st.split(':');
        ok(known.has(act), `${name}: step ${st} is a known move`);
        if (act === 'wander')
            ok(WANDER_STYLES.includes(param), `${name}: wander style ${param}`);
        if (act === 'nap')
            ok(param in NAPS, `${name}: nap kind ${param}`);
    }
}
eq([period(8 * 60), period(12 * 60), period(15 * 60), period(20 * 60)], ['morning', 'midday', 'afternoon', 'evening'], 'periods');
const picks = p => { let c = {}; for (let i = 0; i < 200; i++) { let r = pickRoutine(s({ minutes: p }), i / 200); c[r] = (c[r] || 0) + 1; } return c; };
let morning = picks(8 * 60), afternoon = picks(15 * 60);
ok(morning.zoomies > 0 && !morning.siesta && !morning.lazy, 'mornings are energetic');
ok(afternoon.lazy > (afternoon.zoomies ?? 0) && afternoon.siesta > 0, 'afternoons are lazy');
eq(pickRoutine(s({ music: true }), 0.3), 'dance', 'music: the dance routine');
for (let name of Object.keys(ROUTINES))
    ok(Object.keys(morning).concat(Object.keys(afternoon), Object.keys(picks(12 * 60)), Object.keys(picks(20 * 60)), ['dance']).includes(name), `${name} can be picked some time of day`);
ok(wantsRoutine(s({ lively: true }), 0.4) && !wantsRoutine(base, 0.4), 'lively has routines twice as often');

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
    'breathe', 'sleepbreathe', 'doze', 'dozebreathe', 'bob', 'dig', 'sniffup', 'shiver', 'yawn', 'shake', 'pet',
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
    for (let f of ['food-whole', 'food-half', 'food-stub', 'prop-mushroom', 'prop-bit', 'prop-flower-bud', 'prop-flower', 'prop-leaf', 'prop-drop', 'prop-flake', 'prop-house'])
        ok(dir.get_child(`${f}-symbolic.svg`).query_exists(null), `${sp}: ${f} shipped`);
    let bases = new Set(Object.values(spec.acts).flatMap(a => a.frames));
    // frames carry empty slots and ear wrappers; wear.json is the item library that fills them
    const SLOT_NAMES = ['back', 'neck', 'head0', 'head1', 'head2'];
    let lib = JSON.parse(new TextDecoder().decode(dir.get_child('wear.json').load_contents(null)[1]));
    ok(Number.isInteger(lib.version) && lib.version >= 1, `${sp}: the library has a version`);
    for (let f of bases) {
        let text = new TextDecoder().decode(dir.get_child(f).load_contents(null)[1]);
        for (let s of SLOT_NAMES)
            ok(text.split(`<!--${s}-->`).length === 2, `${sp}: ${f} has the ${s} slot once`);
        ok(/data-ear="far" transform="rotate\(0 [\d.]+ [\d.]+\)"/.test(text) && /data-ear="near" transform="rotate\(0 [\d.]+ [\d.]+\)"/.test(text), `${sp}: ${f} has both ear wrappers`);
    }
    ok(Array.isArray(spec.stream) && spec.stream.length > 0 && spec.stream.every(f => bases.has(f)), `${sp}: streaming frames are real frames`);
    for (let [id, it] of Object.entries(lib.items)) {
        ok(['head', 'neck', 'back'].includes(it.slot) && Object.keys(it.rest).length > 0, `${sp}: ${id} has a slot and shapes`);
        for (let k of [...Object.keys(it.rest), ...Object.keys(it.stream ?? {})])
            ok(SLOT_NAMES.includes(k), `${sp}: ${id} draws into a known layer (${k})`);
    }
    ok(lib.items.scarf?.slot === 'neck' && lib.items.scarf.stream?.neck, `${sp}: the scarf, with a streaming end`);
    for (let [id, w] of Object.entries(WEARABLES)) {
        ok(lib.items[id]?.slot === w.slot, `${sp}: ${id} is drawn, in its slot`);
        ok(dir.get_child(`item-${id}-symbolic.svg`).query_exists(null), `${sp}: ${id} has a picture`);
    }
    eq(Object.keys(lib.items).sort(), Object.keys(WEARABLES).sort(), `${sp}: nothing drawn that cannot be worn`);
}

// houses: every style, in a back and a front layer with a door light, on one shared view box
{
    let hdir = root.get_child('houses');
    let houses = JSON.parse(new TextDecoder().decode(hdir.get_child('houses.json').load_contents(null)[1]));
    eq(Object.keys(houses.styles).sort(), [...HOUSE_STYLES].sort(), 'every house style is drawn');
    eq(houses.box, [-10, -50, 150, 150], 'the houses\' view box');
    for (let s of HOUSE_STYLES) {
        ok(typeof houses.styles[s].door === 'number', `${s}: a door`);
        for (let part of ['back', 'front', 'light', 'icon'])
            ok(hdir.get_child(`house-${s}-${part}-symbolic.svg`).query_exists(null), `${s}: ${part}`);
    }
}

print(`companion-check: ${n} checks passed`);

// ---- needs
{
    const { freshNeeds, progressNeeds, applyNeed, thought, needAct, digFind, earned, FINDS, WEARABLES, SLOTS, HOUSE_DEFAULT, cleanHouse, NEED_KEYS, waitTick, MISSED_MS } =
        await import('../src/helpers/companion-brain.js');
    let t0 = 1_000_000_000_000;
    let f = freshNeeds(t0);
    eq(NEED_KEYS, ['energy', 'hunger', 'mood', 'clean'], 'four needs');
    let h = progressNeeds(f, t0 + 60 * 60000);
    ok(h.energy === 74 && h.hunger === 34 && h.mood === 68 && h.clean === 79, `an hour awake drifts gently (${JSON.stringify(h)})`);
    let z = progressNeeds({ ...f, energy: 20 }, t0 + 30 * 60000, true);
    ok(z.energy === 50 && z.hunger === 31, 'half an hour asleep restores energy, hunger grows slowly');
    let week = progressNeeds(f, t0 + 7 * 24 * 60 * 60000);
    ok(week.energy === 0 && week.hunger === 100 && week.mood === 0 && week.clean === 0, 'a week away floors, never below 0 or above 100');
    eq(progressNeeds(f, t0 - 1000).energy, 80, 'a clock set back changes nothing');
    eq(applyNeed(f, 'meal').hunger, 0, 'a meal when barely hungry floors at 0');
    eq(applyNeed({ ...f, hunger: 80 }, 'meal').hunger, 40, 'a meal takes 40');
    eq(applyNeed(f, 'pet').mood, 80, 'a pet gives 10');
    eq(applyNeed(f, 'nothing'), f, 'unknown event: unchanged');
    eq(thought({ energy: 10, hunger: 90, mood: 10, clean: 10 }), 'sleepy', 'sleepy first');
    eq(thought({ energy: 80, hunger: 90, mood: 80, clean: 80 }), 'hungry', 'then hungry');
    eq(thought({ energy: 80, hunger: 20, mood: 95, clean: 80 }), 'full of beans', 'high mood');
    eq(thought(f), 'doing fine', 'default');
    eq(thought(f, { away: false, justBack: true }), 'happy you\'re back', 'greets you back');
    eq(waitTick(0, false, 5), [0, false], 'not waiting');
    eq(waitTick(0, true, 5), [5, false], 'a wait starts');
    eq(waitTick(5, true, 4 + MISSED_MS), [5, false], 'not minded yet');
    eq(waitTick(5, true, 5 + MISSED_MS), [-1, true], 'minded after ten minutes');
    eq(waitTick(-1, true, 5 + 2 * MISSED_MS), [-1, false], 'only once per wait');
    eq(waitTick(-1, false, 0), [0, false], 'answered: starts over');
    eq(applyNeed(f, 'missed').mood, 65, 'a missed wait costs 5 mood');
    eq(needAct(s({ needs: { ...f, energy: 10 } }), 0.9).act, 'nap:nap', 'exhausted: naps by itself');
    eq(needAct(s({ needs: { ...f, hunger: 80 } }), 0.1).act, 'seek', 'hungry: looks for food');
    eq(needAct(s({ needs: { ...f, hunger: 80 } }), 0.4).act, 'sigh', 'hungry: sighs');
    ok(needAct(s({ needs: { ...f, hunger: 80 } }), 0.4).delay >= 180000, 'the sigh is rare');
    eq(needAct(s({ needs: { ...f, clean: 20 } }), 0.1).act, 'groom', 'scruffy: grooms itself');
    eq(needAct(s({ needs: f }), 0.1), null, 'content: nothing special');
    eq(needAct(s({ needs: { ...f, energy: 10 }, mood: 'working' }), 0.1), null, 'never while Claude works');
    eq(restAct(s({ needs: { ...f, energy: 10 } })), 'tired', 'low energy shows the tired pose');
    eq(restAct(s({ needs: { ...f, energy: 10 }, nap: 'nap' })), 'sleep', 'a nap lies down even when tired');
    eq(ambient(s({ needs: { ...f, energy: 10 } }), 0.5).act, 'nap:nap', 'ambient picks the need first');
    // finds
    eq(digFind(0.5), null, 'most digs find nothing');
    let found = {};
    for (let i = 0; i < 1000; i++) { let r = digFind(i / 1000); if (r) found[r] = (found[r] || 0) + 1; }
    ok(Math.abs(Object.values(found).reduce((a, b) => a + b, 0) - 200) <= 2, 'one dig in five finds something');
    ok(found.treat > found.beanie && found.bandana > 0 && found.scarf > 0, 'treats are common, wearables rare');
    for (let id of Object.keys(found))
        ok(FINDS[id], `${id} is a find`);
    eq(earned('focusdone'), 'treat', 'a finished focus earns a treat');
    eq(earned('finished'), 'seed', 'a closed Claude session earns a seed');
    eq([earned('streak', 5), earned('streak', 7), earned('streak', 6), earned('streak', 14)], ['straw', 'bell', null, 'crown'], 'streak hats');
    for (let w of ['straw', 'bell', 'beanie', 'bandana', 'crown', 'scarf'])
        ok(WEARABLES[w], `${w} is wearable`);
    eq(SLOTS, ['head', 'neck', 'back'], 'three slots');
    eq(Object.keys(WEARABLES).sort(), ['bandana', 'beanie', 'bell', 'bow', 'cape', 'crown', 'party', 'scarf', 'straw'], 'the wardrobe');
    ok(Object.values(WEARABLES).every(w => SLOTS.includes(w.slot) && w.name && w.how), 'every item: slot, name, how it is earned');
    eq([WEARABLES.cape.slot, WEARABLES.party.slot, WEARABLES.bow.slot, WEARABLES.bandana.slot], ['back', 'head', 'neck', 'neck'], 'new items sit in their slots');
    ok(!FINDS.ribbon && FINDS.bandana.slot === 'neck' && FINDS.bow.slot === 'neck', 'the bandana took the ribbon\'s place; the bow tie is a find');
    eq([earned('focuscount', 9), earned('focuscount', 10), earned('focuscount', 11)], [null, 'cape', 'cape'], 'the cape at ten focus sessions');
    eq([earned('pets', 99), earned('pets', 100), earned('pets', 250)], [null, 'party', 'party'], 'the party hat at 100 pets or more');
    eq([cleanHouse('tent'), cleanHouse('castle'), cleanHouse(null)], ['tent', null, null], 'house styles');
    eq(HOUSE_DEFAULT, { rabbit: 'burrow', cat: 'basket', fox: 'den' }, 'default houses');
    print(`companion-check (needs): ok`);
}

// ---- store: its own file, atomic, once-a-day restock, streak gifts, diary cap
{
    const GLib = (await import('gi://GLib')).default;
    const { CompanionStore, dayKeyOf, FOOD_PER_DAY, diaryDays } = await import('../src/helpers/companion-store.js');
    {
        let noon = new Date(2026, 10, 9, 12, 0).getTime(), h = 3600 * 1000;
        let lines = [{ t: noon - 40 * h, what: 'old' }, { t: noon - 20 * h, what: 'ate a meal' }, { t: noon - 3 * h, what: 'dug a little hole' },
            { t: noon - 2 * h, what: 'dug a little hole' }, { t: noon - h, what: 'ate a meal' }, { t: noon, what: 'dug a little hole' }];
        let days = diaryDays(lines, noon);
        eq(days.map(d => d.label), ['Today', 'Yesterday', '2026-11-07'], 'the diary by day, newest first');
        eq(days[0].lines.map(l => [l.what, l.n]), [['dug a little hole', 1], ['ate a meal', 1], ['dug a little hole', 2]], 'only a run of the same line folds');
        eq(days[0].lines[2].t, noon - 2 * h, 'a folded run keeps its latest time');
        eq(diaryDays([], noon), [], 'an empty diary');
    }
    let dir = GLib.Dir.make_tmp('nnx-companion-XXXXXX');
    let clock = new Date(2026, 10, 9, 9, 0).getTime();
    let now = () => clock;
    let st = new CompanionStore({ dataDir: dir, now });
    eq(st.state.pantry.food, FOOD_PER_DAY, 'dawn restock on first run');
    eq(st.state.restocked, '2026-11-09', 'restock remembered by day');
    ok(st.state.pantry.bath === 1 && st.bath() && st.state.pantry.bath === 0 && !st.bath(), 'one bath a day, used once');
    ok(!st.restock(), 'no second restock the same day');
    st.state.pantry.food = 1; clock += 24 * 3600 * 1000;
    ok(st.restock() && st.state.pantry.food === FOOD_PER_DAY, 'next day tops the pantry up');
    st.meal('meal');
    eq([st.state.pantry.food, st.state.streak.days, st.state.diary.at(-1).what], [2, 1, 'ate a meal'], 'a meal: pantry, streak, diary');
    st.meal('meal');
    eq(st.state.streak.days, 1, 'two meals a day count once');
    for (let d = 2; d <= 7; d++) { clock += 24 * 3600 * 1000; st.meal('meal'); }
    eq(st.state.streak.days, 7, 'a week of meals');
    ok(st.state.items.includes('straw') && st.state.items.includes('bell'), 'the straw hat at 5 days and the bell at 7');
    ok(st.state.diary.some(e => e.what.includes('straw hat')), 'the gift is in the diary');
    eq(st.streakDays(), 7, 'the streak stands while meals keep coming');
    clock += 2 * 24 * 3600 * 1000;
    eq(st.streakDays(), 0, 'a day without a meal: no streak to show');
    st.meal('meal');
    eq(st.state.streak.days, 1, 'a missed day resets the streak');
    ok(st.wear('straw') && st.state.worn.head === 'straw', 'wearing an owned hat');
    ok(st.wear('straw') && st.state.worn.head === null, 'again takes it off');
    ok(!st.wear('crown'), 'cannot wear what it does not own');
    eq(st.dig(0.5), null, 'a dig that finds nothing');
    ok(st.dig(0.0) === 'treat' && st.state.pantry.treat === 1, 'the first fifth of rolls finds (a treat first)');
    eq(st.earn('focusdone'), 'treat', 'a finished focus: a treat');
    eq(st.earn('finished'), 'seed', 'a Claude session: a seed');
    ok(st.plant() && st.state.flowers === 1 && st.state.pantry.seed === 0, 'planting a seed');
    st.state.needs.clean = 50;   // (days of test clock have floored it)
    ok(st.rain() && !st.rain() && st.needs().clean === 45, `rain soaks it once a day (${st.needs().clean})`);
    for (let i = 0; i < 20; i++) st.record(`line ${i}`);
    eq(st.state.diary.length, 12, 'the diary keeps 12 lines');
    st.state.needs.energy = 80; let before = st.needs().energy; clock += 60 * 60000;
    ok(st.needs().energy < before, 'needs drift with the clock');
    st.event('pet'); let m = st.state.needs.mood;
    st.flush();
    let again = new CompanionStore({ dataDir: dir, now });
    eq(again.state.needs.mood, m, 'reloaded from disk');
    eq(again.state.worn, { head: null, neck: null, back: null }, 'worn survives (nothing worn now)');
    ok(again.state.items.includes('bell'), 'items survive');
    GLib.spawn_command_line_sync(`rm -rf ${dir}`);
    // a save file from before
    let odir = GLib.Dir.make_tmp('nnx-old-XXXXXX');
    GLib.file_set_contents(`${odir}/companion.json`, JSON.stringify({ items: ['ribbon', 'straw', 'pebble'], worn: { head: 'straw', neck: 'ribbon' } }));
    let old = new CompanionStore({ dataDir: odir, now });
    eq([old.state.items, old.state.worn, old.state.focusDone, old.state.house], [['bandana', 'straw', 'pebble'], { head: 'straw', neck: 'bandana', back: null }, 0, null], 'an old save is brought forward');
    for (let i = 0; i < 9; i++) old.focusDone();
    ok(!old.state.items.includes('cape'), 'nine sessions: no cape yet');
    old.focusDone();
    ok(old.state.items.includes('cape') && old.state.diary.at(-1).what === 'earned a cape for 10 focus sessions', 'the tenth earns the cape');
    ok(!old.earnOnce('cape', 'again') && old.earnOnce('party', 'first'), 'earnOnce: only the first time');
    let lines = old.state.diary.length; old.petted(100);
    eq(old.state.diary.length, lines, 'already owned: no second line');
    ok(old.wear('cape') && old.state.worn.back === 'cape', 'the back slot');
    ok(old.setHouse('tent') && old.state.house === 'tent' && !old.setHouse('castle') && old.setHouse(null) && old.state.house === null, 'the house choice');
    GLib.spawn_command_line_sync(`rm -rf ${odir}`);
    print('companion-check (store): ok');
}


// ---- outfit: compose an outfit's frames into the cache
{
    const GLib = (await import('gi://GLib')).default;
    const { outfitKey, outfitLayers, composeFrame, ensureOutfit, OUTFIT_KEEP } = await import('../src/helpers/companion-outfit.js');
    const T = '<svg><g>B<!--back-->A<!--neck--><g><!--head0--><g data-ear="far" transform="rotate(0 58 46)">F</g>S<!--head1--><g data-ear="near" transform="rotate(0 66 45)">N</g><!--head2--></g></g></svg>';
    const LIB = { version: 3, items: {
        scarf: { slot: 'neck', rest: { neck: '<path id="r"/>' }, stream: { neck: '<path id="s"/>' } },
        beanie: { slot: 'head', rest: { head1: '<path id="d"/>', head2: '<path id="c"/>' }, ears: [-12, 8] } } };
    eq(outfitKey('cat', { head: 'beanie', neck: null, back: 'cape' }, 3), 'cat-beanie-none-cape-v3', 'the key names animal, slots and art version');
    eq(outfitKey('cat', { head: null, neck: null, back: null }, 3), null, 'nothing worn: no key');
    let o = outfitLayers(LIB, { head: 'beanie', neck: 'scarf', back: 'ghost' }, false);
    eq(o, { layers: { back: '', neck: '<path id="r"/>', head0: '', head1: '<path id="d"/>', head2: '<path id="c"/>' }, ears: [-12, 8] }, 'layers; an unknown item draws nothing');
    eq(outfitLayers(LIB, { neck: 'scarf' }, true).layers.neck, '<path id="s"/>', 'a streaming frame takes the streaming shapes');
    eq(outfitLayers(LIB, { head: 'beanie' }, true).layers.head1, '<path id="d"/>', 'no streaming variant: the rest shapes');
    eq(outfitLayers(LIB, { head: 'scarf' }, false).layers.neck, '', 'an item in the wrong slot draws nothing');
    let out = composeFrame(T, o.layers, o.ears);
    ok(out.includes('rotate(-12 58 46)') && out.includes('rotate(8 66 45)') && out.includes('A<path id="r"/>') && !out.includes('<!--'), 'slots filled, ears turned');
    eq(composeFrame(T, outfitLayers(LIB, {}, false).layers, [0, 0]), T.replace(/<!--\w+-->/g, ''), 'bare: only the slot comments go');

    let src = GLib.Dir.make_tmp('nnx-src-XXXXXX'), cache = `${GLib.Dir.make_tmp('nnx-cache-XXXXXX')}/companion`;
    let spec = { acts: { sit: { frames: ['a-symbolic.svg', 'b-symbolic.svg', 'a-symbolic.svg'] } }, stream: ['b-symbolic.svg'] };
    for (let f of ['a-symbolic.svg', 'b-symbolic.svg']) GLib.file_set_contents(`${src}/${f}`, T);
    let read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
    let args = { srcDir: src, cacheRoot: cache, species: 'cat', worn: { neck: 'scarf' }, spec, lib: LIB };
    let d = ensureOutfit(args);
    eq(d, `${cache}/cat-none-scarf-none-v3`, 'composed into its own folder');
    ok(read(`${d}/a-symbolic.svg`).includes('id="r"') && read(`${d}/b-symbolic.svg`).includes('id="s"'), 'rest and streaming frames');
    eq(ensureOutfit({ ...args, worn: {} }), src, 'nothing worn: the shipped frames');
    eq(ensureOutfit({ ...args, lib: null }), src, 'no library: the shipped frames');
    GLib.file_set_contents(`${src}/a-symbolic.svg`, 'CHANGED');
    ok(ensureOutfit(args) === d && read(`${d}/a-symbolic.svg`).includes('id="r"'), 'an existing folder is never rewritten');
    GLib.mkdir_with_parents(`${cache}/cat-none-scarf-none-v9.tmp`, 0o700);
    for (let v = 10; v < 10 + OUTFIT_KEEP + 2; v++) ensureOutfit({ ...args, lib: { ...LIB, version: v } });
    let left = []; let en = Gio.File.new_for_path(cache).enumerate_children('standard::name', 0, null), fi;
    while ((fi = en.next_file(null))) left.push(fi.get_name());
    ok(left.length === OUTFIT_KEEP && !left.some(n => n.endsWith('.tmp')) && left.includes(`cat-none-scarf-none-v${10 + OUTFIT_KEEP + 1}`), `keeps ${OUTFIT_KEEP}, the latest among them, no leftovers (${left})`);
    let file = `${GLib.Dir.make_tmp('nnx-ro-XXXXXX')}/not-a-folder`; GLib.file_set_contents(file, 'x');
    eq(ensureOutfit({ ...args, cacheRoot: file }), src, 'a cache that cannot be written: the shipped frames, no throw');
    print('companion-check (outfit): ok');
}
