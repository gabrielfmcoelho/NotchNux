// Self-check for src/helpers/dev.js. Run: gjs -m tests/dev-check.js
// Exits non-zero on the first failure.

import {
    terminalArgv, exitedRecently, parsePorts, parseDockerPs, visibleContainers, groupByProject, parseDockerEvent, CrashTracker,
    dockerError, parseSs, portRows,
} from '../src/helpers/dev.js';
import { ConfigStore } from '../src/helpers/config.js';

let n = 0;
function ok(cond, what) {
    if (!cond) {
        print(`FAIL: ${what}`);
        imports.system.exit(1);
    }
    n++;
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const cfg = obj => new ConfigStore({ contents: new TextEncoder().encode(JSON.stringify(obj)) });

// ---- Terminal ----
let t = terminalArgv('/tmp', ['docker', 'logs', '-f', 'x'], { hold: true });
ok(t === null || (t[1] === '--dir=/tmp' && t[2] === '--hold' && t.slice(3).join(' ') === '-- docker logs -f x'), 'terminal argv');
t = terminalArgv('/tmp');
ok(t === null || t.length === 2, 'terminal with no command');

// ---- Ports ----
eq(parsePorts('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp, 8080/tcp'),
    [{ port: 5432, target: 5432, proto: 'tcp', local: false }], 'published once, unpublished skipped');
eq(parsePorts('127.0.0.1:8000->80/tcp, [::1]:8000->80/tcp'), [{ port: 8000, target: 80, proto: 'tcp', local: true }], 'local only');
eq(parsePorts('127.0.0.1:8000->80/tcp, [::]:8000->80/tcp')[0].local, false, 'local on v4 but public on v6');
eq(parsePorts(''), [], 'no ports');
eq(parsePorts(undefined), [], 'missing ports');

// ---- docker ps ----
let ps = [
    { ID: 'a1', Names: 'api-1', Image: 'api:dev', State: 'restarting', Status: 'Restarting (1) 3 seconds ago',
        Labels: 'com.docker.compose.project.config_files=/x/a.yml,/x/b.yml,com.docker.compose.project=inova,com.docker.compose.service=api',
        Ports: '' },
    { ID: 'b2', Names: 'db-1', Image: 'postgres:16', State: 'running', Status: 'Up 2 hours',
        Labels: 'com.docker.compose.project=inova', Ports: '0.0.0.0:5432->5432/tcp' },
    { ID: 'c3', Names: 'old', Image: 'x', State: 'exited', Status: 'Exited (0) 3 days ago', Labels: '', Ports: '' },
    { ID: 'd4', Names: 'crashed', Image: 'y', State: 'exited', Status: 'Exited (137) About an hour ago', Labels: '', Ports: '' },
    { ID: 'f6', Names: 'rebooted', Image: 'y', State: 'exited', Status: 'Exited (255) 2 weeks ago', Labels: '', Ports: '' },
    { ID: 'e5', Names: 'fresh', Image: 'z', State: 'created', Status: 'Created', Labels: '', Ports: '' },
].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n';
let list = parseDockerPs(ps);
eq(list.map(c => [c.name, c.project, c.exitCode]), [['api-1', 'inova', null], ['db-1', 'inova', null],
    ['old', '', 0], ['crashed', '', 137], ['rebooted', '', 255], ['fresh', '', null]], 'parsed, compose project with commas in config_files');
eq(list[1].ports, [{ port: 5432, target: 5432, proto: 'tcp', local: false }], 'ports parsed');
eq(visibleContainers(list).map(c => c.name), ['api-1', 'db-1', 'crashed'], 'clean exits, old crashes and created ones hidden');
for (let [status, want] of [['Exited (1) Less than a second ago', true], ['Exited (1) 5 minutes ago', true],
    ['Exited (1) About an hour ago', true], ['Exited (1) 23 hours ago', true], ['Exited (1) 24 hours ago', false],
    ['Exited (1) 3 days ago', false], ['Exited (1) 2 weeks ago', false], ['Up 2 hours', false], [undefined, false]])
    eq(exitedRecently(status), want, `exitedRecently(${status})`);
eq(groupByProject(visibleContainers(list)).map(([p, cs]) => [p, cs.map(c => c.name)]),
    [['inova', ['api-1', 'db-1']], ['', ['crashed']]], 'grouped, loose last');
eq(parseDockerPs(''), [], 'empty');

// ---- events ----
let ev = parseDockerEvent(JSON.stringify({ status: 'die', id: 'abc', Type: 'container', Action: 'die',
    Actor: { ID: 'abc', Attributes: { exitCode: '1', name: 'api-1' } }, time: 1700000000, timeNano: 1700000000123456789 }));
eq([ev.action, ev.id, ev.name, ev.exitCode, ev.at], ['die', 'abc', 'api-1', 1, 1700000000123], 'die event');
ev = parseDockerEvent(JSON.stringify({ Action: 'start', Actor: { ID: 'abcdef0123456789', Attributes: {} }, time: 5 }));
eq([ev.name, ev.exitCode, ev.at], ['abcdef012345', null, 5000], 'start event without a name');
ok(parseDockerEvent('nope') === null && parseDockerEvent('{}') === null, 'bad events');

// ---- crash tracker ----
let tr = new CrashTracker();
let e = (action, at, exitCode = null, id = 'a') => ({ action, id, name: 'api-1', exitCode, at });
eq(tr.add(e('die', 1000, 1)), { kind: 'exited', name: 'api-1', exitCode: 1 }, 'first crash alerts');
ok(tr.add(e('start', 1100)) === null, 'start is quiet');
ok(tr.add(e('die', 2000, 1)) === null, 'dying again soon after is quiet');
eq(tr.add(e('die', 3000, 1)), { kind: 'loop', name: 'api-1', count: 3 }, 'third within 2 min: loop');
ok(tr.add(e('die', 60000, 1)) === null, 'muted while it keeps dying');
ok(tr.add(e('die', 60000 + 299000, 1)) === null, 'mute extends with each death');
eq(tr.add(e('die', 60000 + 299000 + 300001, 1)).kind, 'exited', 'up for 5 min: alerts again');
tr = new CrashTracker();
ok(tr.add(e('kill', 1000)) === null && tr.add(e('die', 1500, 137)) === null, 'a stop you asked for is quiet');
ok(tr.add(e('die', 1000 + 16000, 0)) === null, 'a clean exit is quiet');
tr = new CrashTracker();
tr.add(e('die', 1000, 1));
tr.add(e('destroy', 1200));
eq(tr.add(e('die', 1300, 1)).kind, 'exited', 'destroy forgets history');

// ---- ports ----
let ss = [
    'LISTEN 0      4096       127.0.0.1:9277  0.0.0.0:* users:(("warp-terminal",pid=14963,fd=56))',
    'LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*',
    'LISTEN 0      4096       127.0.0.1:631   0.0.0.0:*',
    'LISTEN 0      2048         0.0.0.0:8000  0.0.0.0:* users:(("uvicorn",pid=42,fd=3),("uvicorn",pid=43,fd=3))',
    'LISTEN 0      2048            [::]:8000     [::]:* users:(("uvicorn",pid=42,fd=4))',
    'LISTEN 0      4096         0.0.0.0:5432  0.0.0.0:*',
    'LISTEN 0      4096            [::]:5432     [::]:*',
    'LISTEN 0      511            [::1]:5173     [::]:* users:(("node",pid=7,fd=20))',
    'LISTEN 0      511                *:37901        *:* users:(("bun",pid=8,fd=11))',
    'ESTAB  0      0      127.0.0.1:1 127.0.0.1:2 users:(("x",pid=1,fd=1))',
    '',
].join('\n');
let socks = parseSs(ss);
eq(socks.map(s => [s.port, s.local, s.name, s.pid]), [[53, true, '', null], [631, true, '', null], [5173, true, 'node', 7],
    [5432, false, '', null], [8000, false, 'uvicorn', 42], [9277, true, 'warp-terminal', 14963], [37901, false, 'bun', 8]],
    'ss: merged v4/v6, %lo stripped, first process, sorted');
let pr = portRows(socks, [{ name: 'db-1', state: 'running', ports: [{ port: 5432, target: 5432, proto: 'tcp', local: false }] },
    { name: 'gone', state: 'exited', ports: [{ port: 631, target: 631, proto: 'tcp', local: true }] }]);
eq(pr.rows.map(r => [r.port, r.name, r.container]), [[5173, 'node', null], [5432, 'db-1', 'db-1'], [8000, 'uvicorn', null],
    [9277, 'warp-terminal', null], [37901, 'bun', null]], 'own processes and published container ports');
eq(pr.hidden, 2, 'system ports counted as hidden');
eq(parseSs(''), [], 'no sockets');

// ---- errors ----
eq(dockerError({ started: false }), 'Docker isn’t installed', 'not installed');
eq(dockerError({ started: true, err: 'permission denied while trying to connect to the Docker daemon socket' }),
    'No permission to use Docker (add yourself to the docker group)', 'no permission');
eq(dockerError({ started: true, err: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' }),
    'Docker isn’t running', 'not running');
eq(dockerError({ started: true, err: '', timedOut: true }), 'Docker took too long', 'timeout');

// ---- config ----
ok(!cfg({}).visibleTabs.includes('dev'), 'Dev tab is opt-in');
ok(cfg({ tabs: { dev: true } }).visibleTabs.includes('dev'), 'Dev tab can be turned on');

print(`dev-check: ${n} checks passed`);
