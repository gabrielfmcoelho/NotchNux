// Self-check for src/helpers/proc.js. Run: gjs -m tests/proc-check.js
// Exits non-zero on the first failure.

import GLib from 'gi://GLib';
import { run, killAll, findProgram } from '../src/helpers/proc.js';

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
