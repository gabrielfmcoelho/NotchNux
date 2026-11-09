// Run: gjs -m tests/config-check.js  (exit 1 on the first failure)
// Header shortcut limit in helpers/config.js. Read-only: never saves.
import GLib from 'gi://GLib';
import { ConfigStore, TAB_DEFS, clampPinnedMax, resolveAccent, SYSTEM_ACCENTS } from '../src/helpers/config.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        imports.system.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
// Setters save: point the config dir at a scratch dir so the real one is untouched.
const tmpCfg = GLib.dir_make_tmp('nnx-cfg-XXXXXX');
GLib.setenv('XDG_CONFIG_HOME', tmpCfg, true);
const cfg = obj => new ConfigStore({ contents: new TextEncoder().encode(JSON.stringify(obj)) });

eq([cfg({}).pinnedMax, cfg({ pinnedMax: 0 }).pinnedMax, cfg({ pinnedMax: 99 }).pinnedMax, cfg({ pinnedMax: null }).pinnedMax,
    cfg({ pinnedMax: '3' }).pinnedMax, cfg({ pinnedMax: 'x' }).pinnedMax, cfg({ pinnedMax: 6.6 }).pinnedMax],
[5, 1, 8, 5, 3, 5, 7], 'shortcut limit: default 5, clamped to 1–8');
eq([clampPinnedMax(undefined), clampPinnedMax(''), clampPinnedMax(true), clampPinnedMax(8)], [5, 5, 5, 8], 'clamp edge cases');
const eight = TAB_DEFS.map(t => t.id).filter(id => id !== 'home').slice(0, 8);
ok(eight.length === 8, 'eight tabs to pin');
eq(cfg({ pinnedTabs: eight, pinnedMax: 3 }).pinnedTabs, eight.slice(0, 3), 'limit 3 shows the first three');
eq(cfg({ pinnedTabs: eight, pinnedMax: 8 }).pinnedTabs, eight, 'limit 8 shows all eight (the stored list kept them)');
eq(cfg({ pinnedTabs: [...eight, 'home', 'nope'] }).pinnedTabs, eight.slice(0, 5), 'home and unknown ids dropped, default limit');
eq(cfg({}).pinnedTabs, ['media', 'tasks', 'calendar', 'weather', 'system'], 'default shortcuts unchanged');

// ---- system accent ----
eq(resolveAccent('system', '#7aa2ff', 'teal'), '#2190a4', 'system accent resolves teal');
eq(resolveAccent('system', '#7aa2ff', null), '#7aa2ff', 'system with no name falls back to custom');
eq(resolveAccent('custom', '#7aa2ff', 'teal'), '#7aa2ff', 'custom ignores system accent');
eq(resolveAccent('system', '#7aa2ff', 'chartreuse'), '#7aa2ff', 'unknown system name falls back to custom');
eq(Object.keys(SYSTEM_ACCENTS).length, 9, 'nine system accents');
eq(cfg({}).accentMode, 'custom', 'accentMode defaults to custom');
eq(cfg({ accentMode: 'bogus' }).accentMode, 'custom', 'bogus accentMode falls back to custom');
eq(cfg({ accentMode: 'system' }).accentMode, 'system', 'stored system accentMode kept');
{
    const c = new ConfigStore({ readFile: p => { try { return GLib.file_get_contents(p)[1]; } catch (e) { return null; } } });
    ok(GLib.get_user_config_dir() === tmpCfg, 'config dir redirected to scratch');
    ok(c.setAccentMode('system'), 'setAccentMode accepts system');
    ok(!c.setAccentMode('bogus'), 'setAccentMode rejects bogus');
    eq(c.accentMode, 'system', 'mode kept after rejected value');
    const again = new ConfigStore({ readFile: p => { try { return GLib.file_get_contents(p)[1]; } catch (e) { return null; } } });
    eq(again.accentMode, 'system', 'accentMode round-trips through the file');
}

print(`config-check: ${n} checks passed`);
