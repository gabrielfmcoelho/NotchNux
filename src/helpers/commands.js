// Command-bar parser. Pure: no Shell or GObject imports.
//
//   t buy milk      task            t !call bank   starred task
//   n an idea       note            25 / 25m / 1h  focus session
//   =2*(3+4)        calculator      wea            jump to a tab
//   anything else   a task

const MIN_FOCUS = 1;
const MAX_FOCUS = 180;

// Recursive-descent arithmetic: + - * / % ^, unary minus, parentheses.
// expr   := term (('+'|'-') term)*
// term   := unary (('*'|'/'|'%') unary)*
// unary  := '-' unary | power
// power  := atom ('^' unary)?        right-associative; binds tighter than a leading '-'
// atom   := number | '(' expr ')'
export function evalMath(expr) {
    const s = String(expr);
    let i = 0;
    const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const peek = () => { skip(); return i < s.length ? s[i] : null; };
    const bad = () => new Error('Not a number');
    const incomplete = () => new Error('Incomplete expression');

    function expression() {
        let v = term();
        for (let c = peek(); c === '+' || c === '-'; c = peek()) {
            i++;
            const r = term();
            v = c === '+' ? v + r : v - r;
        }
        return v;
    }
    function term() {
        let v = unary();
        for (let c = peek(); c === '*' || c === '/' || c === '%'; c = peek()) {
            i++;
            const r = unary();
            if (c === '*') v *= r;
            else if (r === 0) throw bad();
            else v = c === '/' ? v / r : v % r;
        }
        return v;
    }
    function unary() {
        if (peek() === '-') {
            i++;
            return -unary();
        }
        return power();
    }
    function power() {
        const base = atom();
        if (peek() === '^') {
            i++;
            return Math.pow(base, unary());
        }
        return base;
    }
    function atom() {
        const c = peek();
        if (c === null) throw incomplete();
        if (c === '(') {
            i++;
            const v = expression();
            if (peek() !== ')') throw peek() === null ? incomplete() : bad();
            i++;
            return v;
        }
        const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
        if (!m) throw bad();
        i += m[0].length;
        return parseFloat(m[0]);
    }

    const v = expression();
    if (peek() !== null) throw bad();
    if (!Number.isFinite(v)) throw bad();
    return v;
}

function matchTab(word, tabs) {
    if (!/^[a-z]{3,}$/i.test(word)) return null;
    const w = word.toLowerCase();
    const hit = (tabs || []).find(t =>
        String(t.id).toLowerCase().startsWith(w) || String(t.label).toLowerCase().startsWith(w));
    return hit ? hit.id : null;
}

export function parseCommand(text, tabs) {
    const raw = String(text ?? '').trim();
    if (!raw) return { kind: 'empty' };

    if (raw[0] === '=') {
        try {
            return { kind: 'calc', value: evalMath(raw.slice(1)) };
        } catch (e) {
            return { kind: 'calc', error: e.message };
        }
    }

    if (/^[tn]$/i.test(raw)) return { kind: 'empty' };
    const prefixed = /^([tn])\s+(.+)$/i.exec(raw);
    if (prefixed) {
        let body = prefixed[2].trim();
        if (prefixed[1].toLowerCase() === 'n')
            return { kind: 'note', text: body };
        const starred = body.startsWith('!');
        if (starred) body = body.slice(1).trim();
        if (!body) return { kind: 'empty' };
        return { kind: 'task', text: body, starred };
    }

    const dur = /^(\d+)\s*(m|min|h|hr)?$/i.exec(raw);
    if (dur) {
        const unit = (dur[2] || 'm').toLowerCase();
        const minutes = parseInt(dur[1], 10) * (unit === 'h' || unit === 'hr' ? 60 : 1);
        if (minutes >= MIN_FOCUS && minutes <= MAX_FOCUS)
            return { kind: 'focus', minutes };
    }

    const tab = matchTab(raw, tabs);
    if (tab) return { kind: 'tab', id: tab };

    return { kind: 'task', text: raw, starred: false };
}
