// The Calendar tab's event editor, minus the actors: the form it edits and
// what it sends to the EDS worker (events.create / events.update). No shell
// imports, so tests/calevents-check.js runs it under plain `gjs -m`.
//
// A form: { title, date: 'YYYY-MM-DD', start: 'HH:MM', end: 'HH:MM', allDay,
//           days (an all-day event's length), location, calendar (source uid),
//           spanDays (a timed event's end date − start date; absent = 0) }

export const DEFAULT_MINUTES = 30;

const pad = v => String(v).padStart(2, '0');

export const dayIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// 'YYYY-MM-DDTHH:MM:SS±HH:MM': the wall-clock time here, with this zone's
// offset at that moment.
export function localIso(d) {
    let off = -d.getTimezoneOffset();
    let sign = off < 0 ? '-' : '+';
    off = Math.abs(off);
    return `${dayIso(d)}T${hm(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

// 'YYYY-MM-DD' → local midnight, or null.
export function parseDay(text) {
    let m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$/.exec(text ?? '');
    if (!m)
        return null;
    let d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

// '9', '9:30', '09:30', '0930' → minutes after midnight, or null.
export function parseHm(text) {
    let m = /^\s*(\d{1,2})(?::?(\d{2}))?\s*$/.exec(text ?? '');
    if (!m)
        return null;
    let h = Number(m[1]), min = Number(m[2] ?? 0);
    return h < 24 && min < 60 ? h * 60 + min : null;
}

const at = (day, minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);
const isMidnight = d => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;

// A new event on `day`: today it starts at the next half hour, any other day
// at 09:00; DEFAULT_MINUTES long.
export function newEventForm(day, now = new Date(), calendar = null) {
    let start;
    if (dayIso(day) === dayIso(now)) {
        start = new Date(now);
        start.setSeconds(0, 0);
        start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
        if (dayIso(start) !== dayIso(day)) // 23:30 → still today
            start = at(day, 23 * 60 + 30);
    } else {
        start = at(day, 9 * 60);
    }
    let end = new Date(start.getTime() + DEFAULT_MINUTES * 60000);
    return { title: '', date: dayIso(start), start: hm(start), end: hm(end), allDay: false, days: 1, location: '', calendar };
}

// An event from the CalendarServer ({ title, location, start, end, allDay }).
// The server sends no all-day flag, so midnight-to-midnight counts as all day.
export function eventForm(ev, calendar = null) {
    let start = ev.start, end = ev.end instanceof Date && ev.end > ev.start ? ev.end : ev.start;
    let allDay = !!ev.allDay || (isMidnight(start) && isMidnight(end) && end > start);
    let days = allDay ? Math.max(1, Math.round((end - start) / 86400000)) : 1;
    // A timed event over several days keeps its end that many dates later
    // when only a time is edited (the editor shows one date).
    let midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let spanDays = allDay ? 0 : Math.max(0, Math.round((midnight(end) - midnight(start)) / 86400000));
    // An all-day event's hidden times are where "All day" off starts: 09:00
    // for DEFAULT_MINUTES, as for a new event on another day.
    let times = allDay
        ? { start: '09:00', end: hm(new Date(2000, 0, 1, 9, DEFAULT_MINUTES)) }
        : { start: hm(start), end: hm(end) };
    return {
        title: ev.title ?? '', date: dayIso(start), ...times,
        allDay, days, location: ev.location ?? '', calendar, spanDays,
    };
}

// The form's times as the worker takes them, or { error }.
export function eventTimes(form, tzid) {
    let day = parseDay(form.date);
    if (!day)
        return { error: 'Date must look like 2026-11-09' };
    if (form.allDay) {
        let next = new Date(day);
        next.setDate(next.getDate() + Math.max(1, form.days || 1));
        return { start: dayIso(day), end: dayIso(next), allDay: true, tzid };
    }
    let s = parseHm(form.start), e = parseHm(form.end);
    if (s === null || e === null)
        return { error: 'Times must look like 15:00' };
    let span = Math.max(0, Math.floor(form.spanDays || 0));
    if (e === s && !span)
        return { error: 'The end must be after the start' };
    let start = at(day, s);
    let dayPlus = n => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
    // Several days long: the end stays `span` dates after the start.
    // Otherwise an end before the start ends after midnight.
    let end = at(dayPlus(span || (e < s ? 1 : 0)), e);
    // Compared as instants: a time skipped by a DST change moves forward
    // (02:30 → 03:30), which can put the end at or before the start.
    if (end <= start)
        return { error: 'The end must be after the start' };
    return { start: localIso(start), end: localIso(end), allDay: false, tzid };
}

const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// events.create's args, or { error }.
export function createArgs(form, tzid) {
    let summary = clean(form.title);
    if (!summary)
        return { error: 'Add a title' };
    if (!form.calendar)
        return { error: 'Pick a calendar' };
    let times = eventTimes(form, tzid);
    if (times.error)
        return times;
    let args = { source: form.calendar, summary, ...times };
    let location = clean(form.location);
    if (location)
        args.location = location;
    return args;
}

// events.update's patch: only what changed between `initial` and `form`
// ({} when nothing did), or { error }.
export function eventPatch(initial, form, tzid) {
    let patch = {};
    let summary = clean(form.title);
    if (!summary)
        return { error: 'Add a title' };
    if (summary !== clean(initial.title))
        patch.summary = summary;
    if (clean(form.location) !== clean(initial.location))
        patch.location = clean(form.location);
    let timeKeys = form.allDay ? ['date', 'allDay'] : ['date', 'start', 'end', 'allDay'];
    if (timeKeys.some(k => form[k] !== initial[k])) {
        let times = eventTimes(form, tzid);
        if (times.error)
            return times;
        Object.assign(patch, times);
    }
    return { patch };
}

// The calendars an event can be created in: writable ones only (the worker's
// `sources {connect: true}` answer), labelled "<name> — <account>".
export function writableCalendars(calendars) {
    return (Array.isArray(calendars) ? calendars : [])
        .filter(c => c && typeof c.uid === 'string' && c.writable === true)
        .map(c => ({ id: c.uid, label: c.account ? `${c.name} — ${c.account}` : c.name, color: c.color ?? null }));
}
