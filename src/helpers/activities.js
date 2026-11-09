// Pure validation and limits for live activities (no Shell/GObject imports).
const DEFAULT_ICON = 'dialog-information-symbolic';
const ICON_RE = /^[a-z0-9-]+$/;
const TITLE_MAX = 60;
const BODY_MAX = 120;
const FIELDS = ['title', 'body', 'icon', 'progress', 'timeout'];

function cut(v, max) {
    const s = v == null ? '' : String(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function normalizeActivity(f) {
    f = f ?? {};
    const icon = typeof f.icon === 'string' && ICON_RE.test(f.icon) ? f.icon : DEFAULT_ICON;
    const p = num(f.progress);
    const level = p === null || p < 0 ? null : Math.min(1, p);
    const to = num(f.timeout);
    const ms = to === null || to === 0 ? 8000 : Math.min(600, Math.max(1, to)) * 1000;
    return { title: cut(f.title, TITLE_MAX), body: cut(f.body, BODY_MAX), icon, level, ms };
}

export class ActivityTable {
    constructor({ max = 8, perSecond = 20, now = Date.now } = {}) {
        this._max = max;
        this._perSecond = perSecond;
        this._now = now;
        this._items = new Map();   // id -> {sender, raw fields}
        this._calls = new Map();   // sender -> timestamps within the last second
        this._seq = 0;
    }

    _limit(sender) {
        const t = this._now();
        // Forget senders whose whole window has gone stale.
        for (const [s, ts] of this._calls)
            if (s !== sender && ts.every(x => t - x >= 1000)) this._calls.delete(s);
        const recent = (this._calls.get(sender) ?? []).filter(x => t - x < 1000);
        if (recent.length >= this._perSecond) {
            this._calls.set(sender, recent);
            throw new Error('RateLimited');
        }
        recent.push(t);
        this._calls.set(sender, recent);
    }

    show(sender, fields) {
        this._limit(sender);
        if (this._items.size >= this._max) throw new Error('TooMany');
        const id = `a${++this._seq}`;
        this._items.set(id, { sender, raw: { ...(fields ?? {}) } });
        return id;
    }

    update(id, fields) {
        const cur = this._items.get(id);
        if (!cur) return false;
        this._limit(cur.sender);
        for (const k of FIELDS)
            if (fields?.[k] !== undefined) cur.raw[k] = fields[k];
        return true;
    }

    end(id) { return this._items.delete(id); }

    endSender(sender) {
        const gone = [];
        for (const [id, e] of this._items) if (e.sender === sender) gone.push(id);
        for (const id of gone) this._items.delete(id);
        this._calls.delete(sender);
        return gone;
    }

    get(id) {
        const e = this._items.get(id);
        return e ? { id, sender: e.sender, ...normalizeActivity(e.raw) } : null;
    }
}
