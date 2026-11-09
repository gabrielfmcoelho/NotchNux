// Calendar tab: create, edit and delete events (the calendarEdit feature).
//
// Methods mixed into the NotchNux actor (see installCalendarEdit). With the
// feature off none of this shows and no EDS worker is started. Writes go
// through the EDS worker (helpers/eds.js → tools/eds-worker.js); nothing is
// inserted locally: the CalendarServer's EventsAddedOrUpdated / EventsRemoved
// redraw the agenda once EDS has the change.
//
// One "sheet" at a time takes the agenda's place under the date strip:
//   detail  an event's title, time and place; Edit / Delete when its
//           calendar is writable (asked from a connected client, Ruling 14)
//   new     the editor for a new event
//   edit    the editor for an existing one (a recurring event: this
//           occurrence only)
// The sheet lives in this._calSheet, not in actors, so a re-render of the tab
// (day rollover, date pill) rebuilds it with the user's input intact.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { EdsClient, splitEventId } from '../helpers/eds.js';
import { newEventForm, eventForm, createArgs, eventPatch, writableCalendars, parseDay } from '../helpers/calevents.js';
import { outcomeUnknown } from '../helpers/tasksources.js';
import { addPressFeedback } from '../helpers/motion.js';
import { accentHex } from '../helpers/widgets.js';
import { fmt } from '../helpers/format.js';
import { VERTICAL, HORIZONTAL } from '../helpers/compat.js';
import { logDebug } from '../helpers/log.js';
import { SYS } from './ledge.js';

// Writability answers are re-asked on tab open once older than this.
const WRITABLE_STALE_MS = 5 * 60 * 1000;

function label(text, styleClass, props = {}) {
    let l = new St.Label({ text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function button(text, styleClass, onClick, props = {}) {
    let b = new St.Button({ label: text, style_class: styleClass, can_focus: true, reactive: true,
        y_align: Clutter.ActorAlign.CENTER, ...props });
    b.connect('clicked', onClick);
    addPressFeedback(b);
    return b;
}

export const CalendarEdit = {
    _calEditOn() {
        return this._config.isFeatureEnabled('calendarEdit');
    },

    _calendarEditClient() {
        this._calClient ??= new EdsClient();
        return this._calClient;
    },

    // Feature switched: drop the sheet (and the worker when off), redraw.
    _onCalendarEditToggled(on) {
        this._calSheet = null;
        if (!on) {
            this._calClient?.destroy();
            this._calClient = null;
            this._calWritable = null;
            // That client's request is dead: a quick off/on asks again.
            this._calWritableLoading = null;
        }
        if (this._invalidateTab('calendar'))
            this._renderActiveTab();
    },

    _destroyCalendarEdit() {
        this._calSheet = null;
        this._calClient?.destroy();
        this._calClient = null;
        this._calWritable = null;
        this._calWritableLoading = null;
    },

    // Calendar tab on screen: retry a stopped worker; re-ask writability when
    // it is known but stale.
    _calendarTabShown() {
        if (!this._calEditOn())
            return;
        this._calClient?.reset();
        if (this._calWritable?.error) {
            // Asked again on the next event opened (bindings installed since?).
            this._calWritable = null;
        } else if (this._calWritable && Date.now() - this._calWritable.at > WRITABLE_STALE_MS) {
            this._loadCalendarWritability();
        }
    },

    // Ask the worker which calendars take writes (connecting each once).
    // Kept for the session; concurrent calls share one request. A failure
    // (no ECal bindings, worker can't start) is kept as { error } and shown
    // in the sheet; it is asked again only when the tab is shown again.
    _loadCalendarWritability() {
        if (this._calWritableLoading)
            return this._calWritableLoading;
        let client = this._calendarEditClient();
        let loading = client.call('sources', { connect: true }).then(res => {
            // Not from a client dropped meanwhile (feature switched off).
            if (this._calClient !== client)
                return;
            let calendars = Array.isArray(res?.calendars) ? res.calendars : [];
            this._calWritable = { at: Date.now(), calendars, choices: writableCalendars(calendars) };
        }, e => {
            // Shown in the sheet ("Calendar editing isn't available"), so not an error here.
            logDebug('listing calendars failed', e);
            if (this._calClient === client)
                this._calWritable = { at: Date.now(), calendars: [], choices: [], error: e?.message ?? String(e) };
        }).finally(() => {
            // Only our own: an off/on may have started a newer request.
            if (this._calWritableLoading === loading)
                this._calWritableLoading = null;
            if (this._destroyed || this._calClient !== client)
                return;
            let sheet = this._calSheet;
            if (sheet && sheet.mode === 'new' && !sheet.form.calendar)
                sheet.form.calendar = this._defaultCalendar();
            this._redrawCalendarSheet();
        });
        this._calWritableLoading = loading;
        return loading;
    },

    // true / false once known, null while not asked yet.
    _calendarWritable(sourceUid) {
        if (!this._calWritable)
            return null;
        return this._calWritable.calendars.some(c => c.uid === sourceUid && c.writable === true);
    },

    _calendarName(sourceUid) {
        let c = this._calWritable?.calendars.find(x => x.uid === sourceUid);
        if (!c)
            return null;
        return c.account ? `${c.name} — ${c.account}` : c.name;
    },

    // Why events can't be edited at all (the calendars couldn't be listed),
    // or null.
    _calendarEditUnavailable() {
        let reason = this._calWritable?.error;
        return reason ? `Calendar editing isn't available — ${reason}` : null;
    },

    _defaultCalendar() {
        let choices = this._calWritable?.choices ?? [];
        return choices.find(c => c.id === this._calLastCalendar)?.id ?? choices[0]?.id ?? null;
    },

    // ------------------------------------------------------------ opening

    _openCalendarEvent(ev) {
        let ids = splitEventId(ev?.id);
        if (!ids)
            return;
        this._calSheet = { mode: 'detail', ev, ids, confirm: false, busy: false, error: null };
        if (!this._calWritable)
            this._loadCalendarWritability();
        this._showCalendarSheet();
    },

    _newCalendarEvent() {
        let day = this._startOfDay(this._selectedCalendarDate ?? new Date());
        this._calSheet = { mode: 'new', form: newEventForm(day, new Date(), this._defaultCalendar()),
            busy: false, error: null, pickerOpen: false };
        if (!this._calWritable)
            this._loadCalendarWritability();
        this._showCalendarSheet(true);
    },

    _editCalendarEvent() {
        let sheet = this._calSheet;
        if (!sheet || sheet.mode !== 'detail')
            return;
        let form = eventForm(sheet.ev, sheet.ids.source);
        this._calSheet = { mode: 'edit', ev: sheet.ev, ids: sheet.ids, form, initial: { ...form },
            busy: false, error: null };
        this._showCalendarSheet(true);
    },

    _closeCalendarSheet() {
        this._calSheet = null;
        if (this._activeTab === 'calendar' && this.isExpanded)
            this._renderActiveTab();
        else
            this._markTabDirty('calendar');
    },

    // Esc with a sheet open (and no field handling it): a confirm step goes
    // back, anything else closes. True when handled.
    _calendarEscape() {
        let sheet = this._calSheet;
        if (this._activeTab !== 'calendar' || !sheet)
            return false;
        if (sheet.confirm) {
            sheet.confirm = false;
            this._redrawCalendarSheet();
        } else {
            this._closeCalendarSheet();
        }
        return true;
    },

    _showCalendarSheet(focusTitle = false) {
        if (this._activeTab !== 'calendar' || !this.isExpanded) {
            this._markTabDirty('calendar');
            return;
        }
        this._renderActiveTab();
        if (focusTitle && this._calSheetUi?.title) {
            let text = this._calSheetUi.title.clutter_text;
            text.grab_key_focus();
            this._grabKeyboard(text);
        }
    },

    // Rebuild the sheet's actors from this._calSheet. A field being typed in
    // (the calendars can arrive mid-typing) keeps focus and caret.
    _redrawCalendarSheet() {
        let old = this._calSheetActor;
        let panel = this._calPanel;
        if (!this._calSheet || !old || !panel || old.get_parent() !== panel) {
            this._markTabDirty('calendar');
            return;
        }
        let ui = this._calSheetUi ?? {};
        let focus = global.stage.get_key_focus();
        let field = Object.keys(ui).find(k => ui[k]?.clutter_text && ui[k].clutter_text === focus);
        let caret = field ? focus.get_cursor_position() : -1;
        let fresh = this._buildCalendarSheet();
        panel.replace_child(old, fresh);
        // replace_child only unparents: destroy the old sheet now, or its
        // fields linger until GC, where a modal grab that remembered one as
        // the previous focus can't hear its 'destroy' and pops onto a
        // disposed actor.
        old.destroy();
        this._calSheetActor = fresh;
        let text = field ? this._calSheetUi[field]?.clutter_text : null;
        if (text) {
            text.grab_key_focus();
            text.set_cursor_position(caret);
            this._grabKeyboard(text);
        }
        if (this.isExpanded && !this._isExpanding)
            this._resizeToContent();
    },

    // Called where the agenda would refresh (events changed, date scrolled)
    // while a sheet is up: the agenda waits; a shown event that is gone
    // closes its detail. Always true (handled).
    _calendarSheetEventsChanged() {
        let sheet = this._calSheet;
        if (sheet?.mode === 'detail' && !sheet.busy && !this._calendarServerEvents.has(sheet.ev.id))
            this._closeCalendarSheet();
        return true;
    },

    // ------------------------------------------------------------ actors

    // The "+" next to the date strip.
    _buildCalendarAddButton() {
        let b = new St.Button({ style_class: 'nook-calendar-add', can_focus: true, reactive: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'New event' });
        b.set_child(new St.Icon({ icon_name: 'list-add-symbolic', icon_size: 16 }));
        b.connect('clicked', () => this._newCalendarEvent());
        addPressFeedback(b);
        return b;
    },

    _buildCalendarSheet() {
        let sheet = this._calSheet;
        let box = new St.BoxLayout({ style_class: 'nook-calendar nook-calendar-full nook-calendar-sheet', ...VERTICAL, x_expand: true });
        this._calSheetUi = {};
        if (sheet.mode === 'detail')
            this._fillCalendarDetail(box, sheet);
        else
            this._fillCalendarEditor(box, sheet);
        return box;
    },

    _fillCalendarDetail(box, sheet) {
        let ev = sheet.ev;
        box.add_child(label(ev.title || 'Untitled event', 'nook-calendar-sheet-title'));
        let form = eventForm(ev);
        let when = form.allDay
            ? `${fmt(ev.start, { weekday: 'short', month: 'short', day: 'numeric' })} · All day`
            : `${fmt(ev.start, { weekday: 'short', month: 'short', day: 'numeric' })} · ${this._fmtEventTime(ev.start)} – ${this._fmtEventTime(ev.end)}`;
        box.add_child(label(when, 'nook-calendar-sheet-when'));
        if (sheet.ids.rid)
            box.add_child(label('Repeats', 'nook-calendar-sheet-meta'));
        if (ev.location)
            box.add_child(label(ev.location, 'nook-calendar-sheet-meta'));
        let calName = this._calendarName(sheet.ids.source);
        if (calName)
            box.add_child(label(calName, 'nook-calendar-sheet-meta'));
        let error = label(sheet.error ?? '', 'nook-task-error nook-calendar-sheet-error', { visible: !!sheet.error });
        box.add_child(error);
        let unavailable = this._calendarEditUnavailable();
        if (unavailable)
            box.add_child(label(unavailable, 'nook-task-error nook-calendar-unavailable', { x_expand: true }));

        let writable = this._calendarWritable(sheet.ids.source) === true;
        let actions = new St.BoxLayout({ style_class: 'nook-calendar-sheet-actions', ...HORIZONTAL, x_expand: true });
        if (sheet.confirm && writable) {
            actions.add_child(label(sheet.ids.rid ? 'Delete a repeating event' : 'Delete this event?',
                'nook-calendar-sheet-meta', { x_expand: true }));
            if (sheet.ids.rid) {
                actions.add_child(button('This event', 'nook-pill-btn nook-calendar-delete-this', () => this._deleteCalendarEvent(false),
                    { reactive: !sheet.busy }));
                actions.add_child(button('All events', 'nook-pill-btn nook-calendar-delete-all', () => this._deleteCalendarEvent(true),
                    { reactive: !sheet.busy }));
            } else {
                actions.add_child(button('Delete', 'nook-pill-btn nook-calendar-delete-this', () => this._deleteCalendarEvent(false),
                    { reactive: !sheet.busy }));
            }
            actions.add_child(button('Cancel', 'nook-clear-btn', () => {
                sheet.confirm = false;
                this._redrawCalendarSheet();
            }));
        } else {
            actions.add_child(button('Close', 'nook-clear-btn nook-calendar-close', () => this._closeCalendarSheet()));
            actions.add_child(new St.Widget({ x_expand: true }));
            // Read-only calendars (and ones not known yet) get no buttons.
            if (writable) {
                actions.add_child(button('Edit', 'nook-pill-btn nook-calendar-edit', () => this._editCalendarEvent()));
                actions.add_child(button('Delete', 'nook-pill-btn nook-calendar-delete', () => {
                    sheet.confirm = true;
                    sheet.error = null;
                    this._redrawCalendarSheet();
                }));
            }
        }
        box.add_child(actions);
    },

    _calendarEntry(form, key, hint, props = {}) {
        let entry = new St.Entry({ style_class: 'nook-input nook-input-compact', text: form[key] ?? '', hint_text: hint,
            can_focus: true, x_expand: true, ...props });
        entry.clutter_text.connect('text-changed', () => {
            form[key] = entry.get_text();
        });
        entry.clutter_text.connect('activate', () => this._saveCalendarSheet());
        // Connected before _makeTypable's handler, which stops Esc: Esc in a
        // field backs out of the sheet like Esc anywhere else in it.
        entry.clutter_text.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape || !this._calendarEscape())
                return Clutter.EVENT_PROPAGATE;
            // The field is gone with the sheet: let go of the grab (kept
            // for a keyboard-opened dashboard, as when focus leaves a field).
            this._queueKeyboardRelease();
            return Clutter.EVENT_STOP;
        });
        this._makeTypable(entry);
        return entry;
    },

    _fillCalendarEditor(box, sheet) {
        let form = sheet.form;
        box.add_child(label(sheet.mode === 'new' ? 'New event' : 'Edit event', 'nook-calendar-sheet-title'));
        if (sheet.mode === 'edit' && sheet.ids.rid)
            box.add_child(label('Changes this occurrence only', 'nook-calendar-sheet-meta'));

        let title = this._calendarEntry(form, 'title', 'Title');
        box.add_child(title);

        let dateRow = new St.BoxLayout({ style_class: 'nook-calendar-sheet-row', ...HORIZONTAL, x_expand: true });
        let date = this._calendarEntry(form, 'date', 'YYYY-MM-DD');
        dateRow.add_child(date);
        let allDay = button('All day', `nook-chip nook-calendar-allday${form.allDay ? ' nook-calendar-allday-on' : ''}`, () => {
            form.allDay = !form.allDay;
            this._redrawCalendarSheet();
        }, { checked: !!form.allDay });
        if (form.allDay)
            allDay.set_style(`color: ${accentHex()};`);
        dateRow.add_child(allDay);
        box.add_child(dateRow);

        let start = null, end = null;
        if (!form.allDay) {
            let timeRow = new St.BoxLayout({ style_class: 'nook-calendar-sheet-row', ...HORIZONTAL, x_expand: true });
            start = this._calendarEntry(form, 'start', '15:00');
            end = this._calendarEntry(form, 'end', '15:30');
            timeRow.add_child(start);
            timeRow.add_child(label('–', 'nook-calendar-sheet-meta'));
            timeRow.add_child(end);
            box.add_child(timeRow);
        }

        // The calendar: picked for a new event; an existing one stays put.
        let unavailable = this._calendarEditUnavailable();
        if (sheet.mode === 'new' && unavailable) {
            let why = label(unavailable, 'nook-task-error nook-calendar-unavailable', { x_expand: true });
            why.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            why.clutter_text.line_wrap = true;
            box.add_child(why);
        } else if (sheet.mode === 'new') {
            let choices = this._calWritable?.choices ?? [];
            let current = choices.find(c => c.id === form.calendar);
            let text = current?.label ?? (this._calWritableLoading ? 'Loading calendars…'
                : this._calWritable ? 'No calendar takes new events' : 'Calendar');
            let picker = new St.Button({ style_class: 'nook-clear-btn nook-task-source nook-calendar-picker', can_focus: true,
                reactive: choices.length > 0, x_align: Clutter.ActorAlign.START, accessible_name: 'Calendar' });
            let pickerRow = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
            pickerRow.add_child(label(text, 'nook-task-source-label nook-calendar-picker-label'));
            pickerRow.add_child(new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 12, y_align: Clutter.ActorAlign.CENTER }));
            picker.set_child(pickerRow);
            picker.connect('clicked', () => {
                sheet.pickerOpen = !sheet.pickerOpen;
                this._redrawCalendarSheet();
            });
            box.add_child(picker);
            if (sheet.pickerOpen && choices.length) {
                let list = new St.BoxLayout({ style_class: 'nook-task-picker nook-calendar-picker-list', ...VERTICAL, x_expand: true });
                for (let c of choices) {
                    let item = new St.Button({ style_class: `nook-task-picker-item${c.id === form.calendar ? ' nook-task-picker-item-active' : ''}`,
                        can_focus: true, x_expand: true, x_align: Clutter.ActorAlign.FILL });
                    item.set_child(label(c.label, ''));
                    item.connect('clicked', () => {
                        form.calendar = c.id;
                        this._calLastCalendar = c.id;
                        sheet.pickerOpen = false;
                        this._redrawCalendarSheet();
                    });
                    list.add_child(item);
                }
                box.add_child(list);
            }
        }

        let location = this._calendarEntry(form, 'location', 'Location (optional)');
        box.add_child(location);

        box.add_child(label(sheet.error ?? '', 'nook-task-error nook-calendar-sheet-error', { visible: !!sheet.error }));

        let actions = new St.BoxLayout({ style_class: 'nook-calendar-sheet-actions', ...HORIZONTAL, x_expand: true });
        actions.add_child(button('Cancel', 'nook-clear-btn nook-calendar-cancel', () => this._closeCalendarSheet()));
        actions.add_child(new St.Widget({ x_expand: true }));
        let canSave = !sheet.busy && (sheet.mode !== 'new' || !!form.calendar);
        let save = button(sheet.busy ? 'Saving…' : 'Save', 'nook-pill-btn nook-calendar-save', () => this._saveCalendarSheet(),
            { reactive: canSave });
        save.opacity = canSave ? 255 : 128;
        actions.add_child(save);
        box.add_child(actions);

        this._calSheetUi = { title, date, start, end, location, save };
    },

    // ------------------------------------------------------------ writes

    _saveCalendarSheet() {
        let sheet = this._calSheet;
        if (!sheet || sheet.busy || sheet.mode === 'detail')
            return;
        let tzid = GLib.TimeZone.new_local().get_identifier();
        let op, args;
        if (sheet.mode === 'new') {
            op = 'events.create';
            args = createArgs(sheet.form, tzid);
        } else {
            op = 'events.update';
            let r = eventPatch(sheet.initial, sheet.form, tzid);
            if (!r.error && !Object.keys(r.patch).length) {
                this._closeCalendarSheet();
                return;
            }
            args = r.error ? r : { source: sheet.ids.source, uid: sheet.ids.uid, rid: sheet.ids.rid || null, patch: r.patch };
        }
        if (args.error) {
            sheet.error = args.error;
            this._redrawCalendarSheet();
            return;
        }
        sheet.busy = true;
        sheet.error = null;
        this._redrawCalendarSheet();
        let client = this._calendarEditClient();
        client.call(op, args).then(() => {
            if (this._destroyed || this._calSheet !== sheet)
                return;
            // Show the day the event is on; the CalendarServer brings it in.
            let day = parseDay(sheet.form.date);
            if (day)
                this._selectedCalendarDate = day;
            this._requestCalendarServerRange(45, false);
            this._closeCalendarSheet();
        }, e => this._onCalendarWriteFailed(sheet, e, client));
    },

    _deleteCalendarEvent(all) {
        let sheet = this._calSheet;
        if (!sheet || sheet.mode !== 'detail' || sheet.busy)
            return;
        sheet.busy = true;
        sheet.error = null;
        this._redrawCalendarSheet();
        let { source, uid, rid } = sheet.ids;
        let client = this._calendarEditClient();
        client.call('events.delete', { source, uid, rid: rid || null, all: !!all }).then(() => {
            if (!this._destroyed && this._calSheet === sheet)
                this._closeCalendarSheet();
        }, e => this._onCalendarWriteFailed(sheet, e, client));
    },

    // A refused write: the alert (it waits while the notch is open), the
    // reason inline, the sheet open with the user's input. An unknown outcome
    // (timeout, worker gone) may have gone through: re-read the range instead.
    // A client dropped meanwhile (calendarEdit switched off mid-save) is no
    // failure to report.
    _onCalendarWriteFailed(sheet, e, client) {
        if (this._destroyed)
            return;
        let reason = e?.message ?? String(e);
        if (this._calClient !== client || reason === 'EdsClient destroyed')
            return;
        this._pushAlert({ kind: 'gcal', icon: 'dialog-warning-symbolic', color: SYS.red,
            title: "Couldn't save the event", value: reason });
        if (this._calSheet !== sheet)
            return;
        sheet.busy = false;
        sheet.confirm = false;
        if (outcomeUnknown(e)) {
            this._requestCalendarServerRange(45, true);
            this._closeCalendarSheet();
            return;
        }
        sheet.error = reason;
        this._redrawCalendarSheet();
    },
};

export function installCalendarEdit(proto) {
    for (let [name, fn] of Object.entries(CalendarEdit))
        proto[name] = fn;
}
