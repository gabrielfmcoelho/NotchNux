// Run: gjs -m tests/activities-check.js  (exit 1 on the first failure)
import { AlertQueue } from '../src/helpers/alerts.js';
import { normalizeActivity, ActivityTable } from '../src/helpers/activities.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const throwsMsg = (fn, msg, what) => {
    let got = null;
    try { fn(); } catch (e) { got = e.message; }
    eq(got, msg, what);
};

const long = normalizeActivity({ title: 'x'.repeat(61) });
eq(long.title.length, 60, 'title cut to 60');
ok(long.title.endsWith('…'), 'title ends with ellipsis');
eq(normalizeActivity({ title: 'x'.repeat(60) }).title.length, 60, '60-char title untouched');
const b = normalizeActivity({ body: 'y'.repeat(130) });
eq(b.body.length, 120, 'body cut to 120');
ok(b.body.endsWith('…'), 'body ends with ellipsis');
eq(normalizeActivity({ title: null, body: undefined }).title, '', 'null title is empty');
eq(normalizeActivity({}).body, '', 'missing body is empty');

eq(normalizeActivity({ icon: '../../etc/x' }).icon, 'dialog-information-symbolic', 'path icon rejected');
eq(normalizeActivity({ icon: 'Bad Icon' }).icon, 'dialog-information-symbolic', 'uppercase icon rejected');
eq(normalizeActivity({}).icon, 'dialog-information-symbolic', 'default icon');
eq(normalizeActivity({ icon: 'mail-unread-symbolic' }).icon, 'mail-unread-symbolic', 'themed icon kept');

eq(normalizeActivity({ progress: -1 }).level, null, 'progress -1 is none');
eq(normalizeActivity({ progress: 1.7 }).level, 1, 'progress clamped high');
eq(normalizeActivity({ progress: 0.4 }).level, 0.4, 'progress kept');
eq(normalizeActivity({ progress: 'x' }).level, null, 'bad progress is none');
eq(normalizeActivity({}).level, null, 'missing progress is none');

eq(normalizeActivity({ timeout: 0 }).ms, 8000, 'timeout 0 is 8 s');
eq(normalizeActivity({ timeout: 9999 }).ms, 600000, 'timeout clamped to 600 s');
eq(normalizeActivity({ timeout: 5 }).ms, 5000, 'timeout 5 s');
eq(normalizeActivity({ timeout: -3 }).ms, 1000, 'timeout floor 1 s');
eq(normalizeActivity({}).ms, 8000, 'default timeout');

// rate limiting
let t = 1000;
const tbl = new ActivityTable({ now: () => t, max: 100 });
for (let i = 0; i < 20; i++) tbl.show(':1.1', { title: 't' });
throwsMsg(() => tbl.show(':1.1', { title: 't' }), 'RateLimited', '21st call in one second');
tbl.show(':1.2', { title: 'other' });
t += 1001;
tbl.show(':1.1', { title: 'again' });
ok(true, 'window slides');

// update counts against the owner
t = 5000;
const t2 = new ActivityTable({ now: () => t });
const id = t2.show(':1.3', { title: 'a' });
eq(id, 'a1', 'first id');
for (let i = 0; i < 19; i++) ok(t2.update(id, { title: 'u' }), 'update ok');
throwsMsg(() => t2.update(id, { title: 'u' }), 'RateLimited', 'update rate limited');
eq(t2.update('zz', {}), false, 'unknown id');

// update merges
t = 9000;
const t3 = new ActivityTable({ now: () => t });
const m = t3.show(':1.4', { title: 'T', body: 'B', progress: 0.2 });
t3.update(m, { progress: 0.9 });
const g = t3.get(m);
eq([g.id, g.sender, g.title, g.body, g.level], [m, ':1.4', 'T', 'B', 0.9], 'merge keeps old fields');
eq(t3.get('nope'), null, 'get unknown');
eq(t3.end(m), true, 'end ok');
eq(t3.end(m), false, 'end twice');
eq(t3.get(m), null, 'ended is gone');
ok(t3.show(':1.4', {}) !== m, 'ids not reused');

// max live
t = 20000;
const t4 = new ActivityTable({ now: () => t });
const ids = [];
for (let i = 0; i < 8; i++) ids.push(t4.show(i < 5 ? ':1.5' : ':1.6', {}));
throwsMsg(() => t4.show(':1.7', {}), 'TooMany', '9th live id');
t4.end(ids[7]);
ok(t4.show(':1.7', {}), 'slot freed');
eq(t4.endSender(':1.5'), ids.slice(0, 5), 'endSender returns only its ids');
eq(t4.endSender(':1.5'), [], 'endSender twice empty');
eq(t4.get(ids[5]) !== null, true, 'other sender untouched');

// the rate-window map is pruned
t = 50000;
const t5 = new ActivityTable({ now: () => t });
t5.show(':1.8', {}); t5.show(':1.9', {});
eq(t5._calls.size, 2, 'two senders tracked');
t5.endSender(':1.8');
eq(t5._calls.size, 1, 'endSender drops its window');
t += 2000;
t5.show(':1.10', {});
eq([...t5._calls.keys()], [':1.10'], 'stale windows swept');

// AlertQueue.dropKind
const q = new AlertQueue();
q.enqueue({ kind: 'a' }); q.enqueue({ kind: 'b' }); q.enqueue({ kind: 'c' });
eq(q.dropKind('b'), true, 'dropKind pending');
eq(q.dropKind('b'), false, 'dropKind nothing');
eq(q.dropKind('a'), true, 'dropKind current');
eq(q.current, null, 'current cleared');
eq(q.promote().kind, 'c', 'rest of the queue survives');

print(`activities-check: ${n} checks passed`);
