// VPN state for the Tray's VPN row and the pill's VPN icon — the pure part.
// No actors here, so tests/vpn-check.js runs it under plain `gjs -m`.
//
// Two sources:
//   - Tailscale: the `tailscale` CLI (status --json, up, down). Turning it
//     on or off needs this user to be Tailscale's operator, which
//     tools/vpn-setup.sh sets once.
//   - Forti (openfortivpn): it needs root, so tools/vpn-setup.sh wraps it in
//     a systemd unit that only this user may start and stop (polkit), and
//     NotchNux starts and stops that unit over D-Bus.
// ponytail: NetworkManager VPN profiles aren't listed (none here yet); add
// them with libnm, like the hotspot in system.js, when one exists.

export const FORTI_UNIT = 'notchnux-forti.service';
export const FORTI_UNIT_PATH = `/etc/systemd/system/${FORTI_UNIT}`;
export const FORTI_CONFIG = '/etc/openfortivpn/config';

// `tailscale status --json` → { state: 'up'|'down'|'login'|'starting', name }.
// Only Running is up: a stopped node still lists its addresses.
export function parseTailscaleStatus(text) {
    let s;
    try {
        s = JSON.parse(text);
    } catch (e) {
        return null;
    }
    if (!s || typeof s !== 'object')
        return null;
    let state = { Running: 'up', Starting: 'starting', NeedsLogin: 'login', NeedsMachineAuth: 'login' }[s.BackendState] ?? 'down';
    let name = typeof s.CurrentTailnet?.Name === 'string' ? s.CurrentTailnet.Name : '';
    return { state, name };
}

// A failed `tailscale up/down` → { kind: 'operator'|'login'|'other', line, url, suggest }:
// line is the message to show, url a login page, suggest a `tailscale up …`
// command the CLI asked for (shown to copy, never run).
export function tailscaleError(stderr) {
    let text = String(stderr ?? '');
    let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let url = text.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0] ?? null;
    let suggest = lines.find(l => /^tailscale up\b/.test(l)) ?? null;
    let kind = /access denied|operator/i.test(text) ? 'operator'
        : url || /NeedsLogin|log ?in/i.test(text) ? 'login' : 'other';
    let line = lines.find(l => /^(error|fatal)\b/i.test(l)) ?? lines[0] ?? 'Tailscale didn’t answer';
    return { kind, line: line.replace(/^(error|fatal):\s*/i, ''), url, suggest };
}

// The Forti unit's systemd state (+ whether a ppp link exists) → one word.
export function fortiState({ load, active, ppp }) {
    if (load !== 'loaded')
        return 'missing';
    if (active === 'active')
        return ppp ? 'up' : 'connecting';
    if (active === 'activating' || active === 'reloading')
        return 'connecting';
    if (active === 'failed')
        return 'failed';
    return 'off';
}

// The row's second line: who's up, else connecting, else Off.
export function vpnSummary(items) {
    let up = items.filter(i => i.state === 'up').map(i => i.name);
    if (up.length)
        return up.join(' · ');
    if (items.some(i => i.state === 'connecting' || i.state === 'starting'))
        return 'Connecting…';
    return 'Off';
}
