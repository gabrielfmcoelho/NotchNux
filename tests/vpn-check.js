// Self-check for src/helpers/vpn.js. Run: gjs -m tests/vpn-check.js
// Exits non-zero on the first failure.

import { parseTailscaleStatus, tailscaleError, fortiState, vpnSummary } from '../src/helpers/vpn.js';
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

// ---- Tailscale status ----
eq(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', CurrentTailnet: { Name: 'me@example.com' } })),
    { state: 'up', name: 'me@example.com' }, 'running');
// A stopped node still lists its addresses: not up.
eq(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', TailscaleIPs: ['100.64.0.1'] })),
    { state: 'down', name: '' }, 'stopped with IPs');
eq(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' })).state, 'login', 'needs login');
eq(parseTailscaleStatus(JSON.stringify({ BackendState: 'Starting' })).state, 'starting', 'starting');
eq(parseTailscaleStatus(JSON.stringify({ BackendState: 'NoState' })).state, 'down', 'unknown state is down');
ok(parseTailscaleStatus('not json') === null, 'garbage is null');
ok(parseTailscaleStatus('null') === null, 'null is null');

// ---- Tailscale errors ----
let e = tailscaleError('Access denied: prefs write access denied\n\nUse \'sudo tailscale up\' or \'tailscale set --operator=$USER\'\n');
eq([e.kind, e.line], ['operator', 'Access denied: prefs write access denied'], 'operator error');
e = tailscaleError('\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n\nerror: timeout waiting for Tailscale service to enter a Running state\n');
eq([e.kind, e.url, e.line], ['login', 'https://login.tailscale.com/a/abc123',
    'timeout waiting for Tailscale service to enter a Running state'], 'login error');
e = tailscaleError('Error: changing settings via \'tailscale up\' requires mentioning all\nnon-default flags. To proceed, either re-run your command with --reset or\nuse the command below to explicitly mention the current value of\nall non-default settings:\n\n\ttailscale up --accept-routes\n');
eq([e.kind, e.suggest], ['other', 'tailscale up --accept-routes'], 'flags error suggests the command');
e = tailscaleError('');
eq([e.kind, e.line, e.url, e.suggest], ['other', 'Tailscale didn’t answer', null, null], 'empty stderr');

// ---- Forti ----
eq(fortiState({ load: 'not-found', active: 'inactive', ppp: false }), 'missing', 'no unit');
eq(fortiState({ load: 'loaded', active: 'inactive', ppp: false }), 'off', 'off');
eq(fortiState({ load: 'loaded', active: 'activating', ppp: false }), 'connecting', 'activating');
eq(fortiState({ load: 'loaded', active: 'active', ppp: false }), 'connecting', 'running, no link yet');
eq(fortiState({ load: 'loaded', active: 'active', ppp: true }), 'up', 'up');
eq(fortiState({ load: 'loaded', active: 'failed', ppp: false }), 'failed', 'failed');

// ---- Summary ----
eq(vpnSummary([{ name: 'Tailscale', state: 'up' }, { name: 'Forti', state: 'up' }]), 'Tailscale · Forti', 'both up');
eq(vpnSummary([{ name: 'Tailscale', state: 'down' }, { name: 'Forti', state: 'connecting' }]), 'Connecting…', 'connecting');
eq(vpnSummary([{ name: 'Tailscale', state: 'down' }]), 'Off', 'off');
eq(vpnSummary([]), 'Off', 'nothing');

// ---- Config ----
ok(cfg({}).isFeatureEnabled('pillVpn'), 'pillVpn defaults on');
ok(!cfg({ features: { pillVpn: false } }).isFeatureEnabled('pillVpn'), 'pillVpn can be off');

print(`vpn-check: ${n} checks passed`);
