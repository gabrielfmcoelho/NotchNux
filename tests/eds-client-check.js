// Self-check for EdsClient in src/helpers/eds.js (wire format, timeouts,
// restart policy) against a fake worker — no EDS needed.
// Run: gjs -m tests/eds-client-check.js. Exits non-zero on the first failure.

import GLib from 'gi://GLib';
import System from 'system';
import { EdsClient, STOPPED_MESSAGE } from '../src/helpers/eds.js';

let n = 0;
function ok(cond, what) {
    if (!cond) {
        print(`FAIL: ${what}`);
        System.exit(1);
    }
    n++;
}

// Answers {"id":N,"ok":true,"result":{"op":…,"pid":…}}; op "crash" exits,
// "hang" never answers, "fail" answers ok:false. Logs each start to $1.
const FAKE = `
echo start >> "$1"
while IFS= read -r line; do
    id=$(printf '%s' "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
    op=$(printf '%s' "$line" | sed -n 's/.*"op":"\\([^"]*\\)".*/\\1/p')
    case $op in
        crash) exit 1 ;;
        hang) ;;
        fail) printf '{"id":%s,"ok":false,"error":"nope"}\\n' "$id" ;;
        *) printf 'not json\\n{"id":%s,"ok":true,"result":{"op":"%s","pid":%s}}\\n' "$id" "$op" "$$" ;;
    esac
done`;

const starts = GLib.build_filenamev([GLib.get_tmp_dir(), `nnx-eds-client-${new Date().getTime()}`]);
const argv = ['sh', '-c', FAKE, 'fake', starts];
const startCount = () => {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(starts)[1]).split('\n').filter(Boolean).length;
    } catch (e) {
        return 0;
    }
};
const rejects = p => p.then(() => null, e => e);

async function main() {
    let clock = 0;
    let c = new EdsClient({ argv, now: () => clock, timeoutMs: 400 });
    ok(startCount() === 0, 'spawns lazily');

    let r = await c.call('hello', { a: 1 });
    ok(r.op === 'hello', `result comes back: ${JSON.stringify(r)}`);
    ok(startCount() === 1, 'one worker started');
    let pid = r.pid;
    let [a, b] = await Promise.all([c.call('x'), c.call('y')]);
    ok(a.op === 'x' && b.op === 'y' && a.pid === pid, 'concurrent calls are matched by id on one worker');

    let e = await rejects(c.call('fail'));
    ok(e && e.message === 'nope', `ok:false rejects with the error: ${e}`);

    e = await rejects(c.call('hang'));
    ok(e && /timed out/.test(e.message), `timeout rejects: ${e}`);
    ok((await c.call('after')).pid === pid, 'a timeout alone does not restart the worker');

    // Crash → the pending call rejects; the next call restarts.
    e = await rejects(c.call('crash'));
    ok(e && /exited/.test(e.message), `crash rejects pending: ${e}`);
    r = await c.call('again');
    ok(r.pid !== pid && startCount() === 2, 'restarted on the next call (1)');

    await rejects(c.call('crash'));
    clock += 10e3;
    await c.call('again');
    await rejects(c.call('crash'));
    clock += 10e3;
    await c.call('again');
    ok(startCount() === 4, 'three restarts within a minute');
    await rejects(c.call('crash'));
    clock += 10e3;
    e = await rejects(c.call('again'));
    ok(e && e.message === STOPPED_MESSAGE, `fourth restart in a minute is refused: ${e}`);
    ok(startCount() === 4, 'no worker started once stopped');
    clock += 120e3;
    e = await rejects(c.call('again'));
    ok(e && e.message === STOPPED_MESSAGE, 'stays stopped until reset()');

    c.reset();
    r = await c.call('again');
    ok(r.op === 'again' && startCount() === 5, 'reset() allows a restart');

    // Restarts older than a minute don't count.
    let c2 = new EdsClient({ argv, now: () => clock, timeoutMs: 400 });
    for (let i = 0; i < 6; i++) {
        await c2.call('x');
        await rejects(c2.call('crash'));
        clock += 25e3;
    }
    ok((await c2.call('x')).op === 'x', 'restarts spread over minutes keep working');
    c2.destroy();

    c.destroy();
    e = await rejects(c.call('x'));
    ok(e && /destroyed/.test(e.message), 'calls after destroy() reject');

    let missing = new EdsClient({ argv: ['/no/such/worker'], now: () => clock });
    e = await rejects(missing.call('hello'));
    ok(e, 'unstartable worker rejects');
    missing.destroy();

    let probe = await EdsClient.probe({ argv: ['sh', '-c', 'read l; printf \'{"id":1,"ok":true,"result":{"ecal":false}}\\n\''] });
    ok(probe.available === false && probe.reason, `probe without ECal: ${JSON.stringify(probe)}`);
    probe = await EdsClient.probe({ argv: ['/no/such/worker'] });
    ok(probe.available === false && probe.reason, `probe with no worker: ${JSON.stringify(probe)}`);
    probe = await EdsClient.probe({ argv: ['sh', '-c', 'read l; printf \'{"id":1,"ok":true,"result":{"ecal":true}}\\n\''] });
    ok(probe.available === true, `probe with ECal: ${JSON.stringify(probe)}`);
}

let loop = new GLib.MainLoop(null, false);
let status = 0;
main().then(() => {
    print(`eds-client-check: ${n} checks passed`);
}, e => {
    print(`FAIL: ${e}\n${e.stack}`);
    status = 1;
}).finally(() => {
    GLib.unlink(starts);
    loop.quit();
});
loop.run();
System.exit(status);
