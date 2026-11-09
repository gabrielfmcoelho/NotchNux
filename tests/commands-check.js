// Run: gjs -m tests/commands-check.js  (exit 1 on the first failure)
// Pure command-bar parser in helpers/commands.js. Read-only: never saves.
import { parseCommand, evalMath } from '../src/helpers/commands.js';
import { TAB_DEFS } from '../src/helpers/config.js';
import { clampFocusMinutes } from '../src/helpers/productivity.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
const TABS = TAB_DEFS.map(({ id, label }) => ({ id, label }));

eq(parseCommand('t buy milk', TABS), { kind: 'task', text: 'buy milk', starred: false }, 'task prefix');
eq(parseCommand('t !call bank', TABS), { kind: 'task', text: 'call bank', starred: true }, 'starred task');
eq(parseCommand('n idea', TABS), { kind: 'note', text: 'idea' }, 'note prefix');
eq(['25', '25m', '25 min', '1h'].map(s => parseCommand(s, TABS).minutes), [25, 25, 25, 60], 'focus durations');
eq(parseCommand('=2*(3+4)^2', TABS), { kind: 'calc', value: 98 }, 'math precedence');
eq(parseCommand('=2+', TABS), { kind: 'calc', error: 'Incomplete expression' }, 'bad math');
eq(parseCommand('wea', TABS), { kind: 'tab', id: 'weather' }, 'tab label prefix');
eq(parseCommand('abc', TABS), { kind: 'task', text: 'abc', starred: false }, 'fallback is a task');
eq(parseCommand('   ', TABS), { kind: 'empty' }, 'blank');
ok(throws(() => evalMath('process.exit()')), 'no code execution');

eq([clampFocusMinutes(0), clampFocusMinutes(500), clampFocusMinutes('x')], [1, 180, 25], 'clampFocusMinutes');
eq([parseCommand('mus', TABS).id, parseCommand('tray', TABS).id, parseCommand('tbuy', TABS).kind, parseCommand('t', TABS).kind,
    parseCommand('500', TABS).kind, parseCommand('0', TABS).kind, parseCommand('1 hr', TABS).minutes, parseCommand('25min', TABS).minutes],
['media', 'system', 'task', 'empty', 'task', 'task', 60, 25], 'edge cases');
eq([evalMath('-2^2'), evalMath('2^3^2'), evalMath('7%4'), evalMath(' .5 + 1.5 '), throws(() => evalMath('1/0')), throws(() => evalMath('2+a'))],
    [-4, 512, 3, 2, true, true], 'evalMath details');

print(`commands-check: ${n} checks passed`);
