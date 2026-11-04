// Self-check for src/helpers/proc.js. Run: gjs -m tests/proc-check.js
// Exits non-zero on the first failure.

import GLib from 'gi://GLib';
import { run, killAll, findProgram, watchRecords } from '../src/helpers/proc.js';

let n = 0;
function ok(cond, what) {
    if (!cond) {
        print(`FAIL: ${what}`);
        imports.system.exit(1);
    }
    n++;
}

const runP = (argv, opts) => new Promise(resolve => run(argv, opts, resolve));

async function main() {
    ok(findProgram('sh'), 'findProgram finds sh');
    ok(findProgram('no-such-program-nn') === null, 'findProgram: missing is null');

    let r = await runP(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    ok(r.started && r.out === 'out\n' && r.err === 'err\n' && !r.ok && !r.timedOut, 'stdout, stderr and failure');

    r = await runP(['sh', '-c', 'pwd'], { cwd: '/tmp' });
    ok(r.ok && r.out.trim() === '/tmp', 'cwd');

    r = await runP(['sh', '-c', 'echo $NN_X'], { env: ['NN_X=7', 'PATH=/usr/bin:/bin'] });
    ok(r.out === '7\n', 'env replaces the environment');

    r = await runP(['/no/such/binary']);
    ok(!r.started && !r.ok && r.err, 'spawn failure reports started=false');

    let t0 = GLib.get_monotonic_time();
    r = await runP(['sleep', '30'], { timeoutS: 1 });
    ok(r.timedOut && !r.ok && GLib.get_monotonic_time() - t0 < 4e6, 'timeout sends SIGTERM');

    let procs = new Map();
    let killed = runP(['sleep', '30'], { procs });
    ok(procs.size === 1, 'procs tracks the running process');
    killAll(procs);
    r = await killed;
    ok(procs.size === 0 && !r.ok && !r.timedOut, 'killAll stops it');

    // Records split across reads come out whole; onEnd once stdout closes.
    let recs = [];
    await new Promise(resolve => watchRecords(['sh', '-c', 'printf "a\\nb\\nc"; sleep 0.2; printf "d\\n"'], '\n',
        rec => recs.push(rec), resolve));
    ok(JSON.stringify(recs) === '["a","b","cd"]', `watchRecords splits records: ${JSON.stringify(recs)}`);
    ok(watchRecords(['/no/such/binary'], '\n', () => {}) === null, 'watchRecords: missing program is null');
    let ended = false;
    let w = watchRecords(['sleep', '30'], '\n', () => {}, () => { ended = true; });
    w.stop();
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => resolve() ?? GLib.SOURCE_REMOVE));
    ok(!ended, 'stop() doesn\u2019t call onEnd');
}

let loop = new GLib.MainLoop(null, false);
main().then(() => {
    print(`proc-check: ${n} checks passed`);
    loop.quit();
}, e => {
    print(`FAIL: ${e}\n${e.stack}`);
    imports.system.exit(1);
});
loop.run();
