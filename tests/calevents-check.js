// Run: gjs -m tests/calevents-check.js  (exit 1 on the first failure)
// The Calendar tab's event form (src/helpers/calevents.js): defaults, local
// ISO times, all-day DATE ranges and the update patch. Pure: no EDS.
import System from 'system';
import {
    DEFAULT_MINUTES, localIso, parseDay, parseHm, newEventForm, eventForm, eventTimes, createArgs, eventPatch,
    writableCalendars,
} from '../src/helpers/calevents.js';

let n = 0;
function ok(cond, what) {
    n++;
    if (!cond) {
        printerr(`FAIL: ${what}`);
        System.exit(1);
    }
}
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const TZ = 'America/Fortaleza';

// localIso: wall time + this zone's offset; parses back to the same instant.
let d = new Date(2026, 10, 9, 15, 0, 0);
let iso = localIso(d);
ok(/^2026-11-09T15:00:00[+-]\d{2}:\d{2}$/.test(iso), `localIso shape: ${iso}`);
ok(new Date(iso).getTime() === d.getTime(), `localIso is the same instant: ${iso}`);

eq([parseHm('9'), parseHm('9:30'), parseHm('09:30'), parseHm('0930'), parseHm('24:00'), parseHm('9:75'), parseHm('x')],
    [540, 570, 570, 570, null, null, null], 'parseHm');
ok(parseDay('2026-11-09')?.getDate() === 9 && parseDay('2026-02-30') === null && parseDay('9/11') === null, 'parseDay');

// New event defaults: 30 minutes, next half hour today, 09:00 another day.
eq(DEFAULT_MINUTES, 30, 'default length');
let today = new Date(2026, 10, 9);
eq(newEventForm(today, new Date(2026, 10, 9, 14, 10), 'cal-1'),
    { title: '', date: '2026-11-09', start: '14:30', end: '15:00', allDay: false, days: 1, location: '', calendar: 'cal-1' },
    'new event today');
eq([newEventForm(today, new Date(2026, 10, 9, 14, 40)).start, newEventForm(today, new Date(2026, 10, 9, 14, 40)).end],
    ['15:00', '15:30'], 'next half hour rolls the hour');
eq([newEventForm(new Date(2026, 10, 12), new Date(2026, 10, 9, 14, 10)).start, newEventForm(new Date(2026, 10, 12)).end],
    ['09:00', '09:30'], 'another day: 09:00–09:30');

// Times for the worker.
let form = { ...newEventForm(today, new Date(2026, 10, 9, 14, 10), 'cal-1'), title: '  Dentist ', start: '15:00', end: '15:30' };
let args = createArgs(form, TZ);
eq(args, { source: 'cal-1', summary: 'Dentist', start: localIso(new Date(2026, 10, 9, 15)),
    end: localIso(new Date(2026, 10, 9, 15, 30)), allDay: false, tzid: TZ }, 'createArgs: timed, local ISO + tzid');
eq(createArgs({ ...form, location: ' Rua 1 ' }, TZ).location, 'Rua 1', 'location trimmed');
eq(eventTimes({ ...form, allDay: true }, TZ), { start: '2026-11-09', end: '2026-11-10', allDay: true, tzid: TZ },
    'all-day: DATE, end exclusive (next day)');
eq(eventTimes({ ...form, allDay: true, date: '2026-12-31' }, TZ).end, '2027-01-01', 'all-day across the year');
eq(eventTimes({ ...form, start: '23:30', end: '00:30' }, TZ).end, localIso(new Date(2026, 10, 10, 0, 30)), 'ends after midnight');
ok(eventTimes({ ...form, end: '15:00' }, TZ).error, 'zero length refused');
ok(eventTimes({ ...form, start: 'soon' }, TZ).error && eventTimes({ ...form, date: 'tomorrow' }, TZ).error, 'bad input refused');
ok(createArgs({ ...form, title: ' ' }, TZ).error === 'Add a title', 'title required');
ok(createArgs({ ...form, calendar: null }, TZ).error === 'Pick a calendar', 'calendar required');

// From a CalendarServer event (no all-day flag: midnight to midnight is).
let ev = { title: 'Standup', location: '', start: new Date(2026, 10, 9, 10), end: new Date(2026, 10, 9, 10, 15), allDay: false };
let initial = eventForm(ev, 'cal-1');
eq([initial.date, initial.start, initial.end, initial.allDay], ['2026-11-09', '10:00', '10:15', false], 'eventForm timed');
let holiday = eventForm({ title: 'Trip', start: new Date(2026, 10, 9), end: new Date(2026, 10, 12), allDay: false });
eq([holiday.allDay, holiday.days, eventTimes(holiday, TZ).end], [true, 3, '2026-11-12'], 'midnight-to-midnight is all day, length kept');

// Patch: only what changed.
eq(eventPatch(initial, { ...initial }, TZ), { patch: {} }, 'nothing changed');
eq(eventPatch(initial, { ...initial, title: 'Standup!' }, TZ), { patch: { summary: 'Standup!' } }, 'title only');
eq(eventPatch(initial, { ...initial, location: 'Room 2' }, TZ), { patch: { location: 'Room 2' } }, 'location only');
eq(eventPatch(initial, { ...initial, end: '10:45' }, TZ).patch,
    { start: localIso(new Date(2026, 10, 9, 10)), end: localIso(new Date(2026, 10, 9, 10, 45)), allDay: false, tzid: TZ }, 'times');
eq(eventPatch(holiday, { ...holiday, start: '08:00' }, TZ), { patch: {} }, 'hidden time fields of an all-day event ignored');
ok(eventPatch(initial, { ...initial, title: '' }, TZ).error, 'empty title refused');

// The picker: writable calendars only.
eq(writableCalendars([
    { uid: 'a', name: 'Work', account: 'me@example.com', writable: true, color: '#f00' },
    { uid: 'h', name: 'Holidays', account: 'me@example.com', writable: false },
    { uid: 'p', name: 'Personal', account: null, writable: true },
]).map(c => [c.id, c.label]), [['a', 'Work — me@example.com'], ['p', 'Personal']], 'writableCalendars');
eq(writableCalendars(null), [], 'no answer → none');

print(`calevents-check: ${n} checks passed`);
