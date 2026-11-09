# Calendar event create/edit/delete (the calendarEdit feature), sourced by
# tests/headless-smoke.sh --script. Runs against a FAKE EdsClient injected
# through Eval and CalendarServer events injected into the notch: the real EDS
# worker is never started and no calendar is touched. The fake's
# events.create rejects a title of 'fail' with 'offline'.

FAKE="{ calls: [], resets: 0, destroyed: false,
  call(op, args) { this.calls.push([op, JSON.parse(JSON.stringify(args ?? {}))]);
    if (op === 'sources') return Promise.resolve({ tasks: [], calendars: [
      { uid: 'w', name: 'Work', account: 'me@example.com', backend: 'caldav', writable: true, color: null },
      { uid: 'h', name: 'Holidays', account: 'me@example.com', backend: 'caldav', writable: false, color: null }] });
    if (op === 'events.create') return args.summary === 'fail' ? Promise.reject(new Error('offline')) : Promise.resolve({ uid: 'new1' });
    return Promise.resolve({}); },
  reset() { this.resets++; }, destroy() { this.destroyed = true; } }"
# Event ids are "<source>\n<uid>\n<rid>"; built with fromCharCode because a
# backslash-n reaches Eval as a raw line break.
ID="const ID = (...p) => p.join(String.fromCharCode(10));"
FIND="$ID const find =(x, cls) => { if (x.has_style_class_name && x.has_style_class_name(cls)) return x; for (const c of x.get_children()) { const r = find(c, cls); if (r) return r; } return null; }; const host = n._tabHosts.get('calendar');"
LAST="const last = op => [...globalThis.__nnxCal.calls].reverse().find(c => c[0] === op);"
# Three of today's events: one in a writable calendar, one in a read-only
# one, and an occurrence of a recurring event (ids as gnome-shell-calendar-server makes them).
EVENTS="$ID const at =(h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const add = (id, title, s, e) => n._calendarServerEvents.set(id, { id, title, location: '', start: s, end: e, allDay: false });
  add(ID('w', 'ev1', ''), 'Review', at(10), at(10, 30)); add(ID('h', 'hol1', ''), 'Holiday party', at(11), at(12)); add(ID('w', 'rec1', '20261109T130000Z'), 'Standup', at(12), at(12, 15));"
# press KEY_x: a real key press through a virtual keyboard.
press() {
    nnx_eval "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; d.notify_keyval(t + 1000, C.$1, C.KeyState.PRESSED); d.notify_keyval(t + 2000, C.$1, C.KeyState.RELEASED); return true; })()" >/dev/null
    sleep 0.8
}

# Flag off (default): the Calendar tab is as before and nothing is spawned.
nnx_eval "(() => { const n = $NNX; n.collapse(); n.expand(); n._switchTab('calendar'); n._renderActiveTab(); return true; })()" >/dev/null; sleep 1
nnx_check caledit-off "(() => { const n = $NNX; $FIND return [n._config.isFeatureEnabled('calendarEdit'), !!find(host, 'nook-calendar-add'), !!find(host, 'nook-calendar-event-btn'), n._calClient ?? null]; })()" '[false,false,false,null]'

# Flag on, the fake client in place first: "+" beside the strip, tappable events.
nnx_eval "(() => { const n = $NNX; globalThis.__nnxCal = $FAKE; n._calClient = globalThis.__nnxCal; n._selectedCalendarDate = null; $EVENTS n._setFeature('calendarEdit', true); return true; })()" >/dev/null; sleep 1
nnx_check caledit-on "(() => { const n = $NNX; $FIND return [!!find(host, 'nook-calendar-add'), !!find(host, 'nook-calendar-event-btn'), globalThis.__nnxCal.calls.length]; })()" '[true,true,0]'

# "+" opens the editor: 30 minutes, the first writable calendar once known.
nnx_eval "(() => { const n = $NNX; $FIND find(host, 'nook-calendar-add').emit('clicked', 1); return true; })()" >/dev/null; sleep 1
nnx_check caledit-new-opens "(() => { const n = $NNX; $FIND const f = n._calSheet.form; const mins = s => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]); return [n._calSheet.mode, !!find(host, 'nook-calendar-sheet'), !find(host, 'nook-calendar-event-btn'), f.calendar, (mins(f.end) - mins(f.start) + 1440) % 1440, global.stage.get_key_focus() === n._calSheetUi.title.clutter_text, globalThis.__nnxCal.calls.some(c => c[0] === 'sources' && c[1].connect === true)]; })()" '["new",true,true,"w",30,true,true]'
nnx_check caledit-picker-writable-only "(() => { const n = $NNX; return n._calWritable.choices.map(c => c.label); })()" '["Work — me@example.com"]'

# Save: events.create with local-zone ISO times, 30 minutes, the local tzid.
nnx_eval "(() => { const n = $NNX; n._calSheetUi.title.set_text('Dentist'); n._calSheetUi.title.clutter_text.emit('activate'); return true; })()" >/dev/null; sleep 1
nnx_check caledit-create "(() => { const n = $NNX; $LAST const [, a] = last('events.create'); const off = s => s.slice(19); const local = d => { const o = -d.getTimezoneOffset(); const p = v => String(Math.abs(v)).padStart(2, '0'); return (o < 0 ? '-' : '+') + p(Math.trunc(o / 60)) + ':' + p(o % 60); }; const s = new Date(a.start), e = new Date(a.end); return [a.source, a.summary, a.allDay, a.tzid === imports.gi.GLib.TimeZone.new_local().get_identifier(), /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00[+-][0-9]{2}:[0-9]{2}$/.test(a.start), off(a.start) === local(s), (e - s) / 60000, n._calSheet]; })()" '["w","Dentist",false,true,true,true,30,null]'
nnx_check caledit-no-local-insert "(() => { const n = $NNX; return [...n._calendarServerEvents.values()].some(e => e.title === 'Dentist'); })()" false

# A read-only calendar's event: detail without Edit/Delete.
nnx_eval "(() => { const n = $NNX; $ID n._openCalendarEvent(n._calendarServerEvents.get(ID('h', 'hol1', ''))); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-readonly "(() => { const n = $NNX; $FIND return [n._calSheet.mode, !!find(host, 'nook-calendar-sheet-title'), !!find(host, 'nook-calendar-edit'), !!find(host, 'nook-calendar-delete')]; })()" '["detail",true,false,false]'
nnx_eval "(() => { const n = $NNX; $FIND find(host, 'nook-calendar-close').emit('clicked', 1); return true; })()" >/dev/null; sleep 0.5

# A writable one: Edit/Delete; Edit changes only what changed.
nnx_eval "(() => { const n = $NNX; $FIND n._openCalendarEvent(n._calendarServerEvents.get(ID('w', 'ev1', ''))); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-writable "(() => { const n = $NNX; $FIND return [!!n._calSheet && n._calSheet.mode, !!find(host, 'nook-calendar-edit'), !!find(host, 'nook-calendar-delete')]; })()" '["detail",true,true]'
nnx_eval "(() => { const n = $NNX; $FIND find(host, 'nook-calendar-edit').emit('clicked', 1); n._calSheetUi.title.set_text('Review v2'); find(host, 'nook-calendar-save').emit('clicked', 1); return true; })()" >/dev/null; sleep 1
nnx_check caledit-update "(() => { const n = $NNX; $LAST const [, a] = last('events.update'); return [a.source, a.uid, a.rid, Object.keys(a.patch), a.patch.summary === 'Review v2', n._calSheet]; })()" '["w","ev1",null,["summary"],true,null]'

# A recurring event's Delete asks: This event / All events.
nnx_eval "(() => { const n = $NNX; $FIND n._openCalendarEvent(n._calendarServerEvents.get(ID('w', 'rec1', '20261109T130000Z'))); find(host, 'nook-calendar-delete').emit('clicked', 1); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-recurring-asks "(() => { const n = $NNX; $FIND return [n._calSheet.confirm, !!find(host, 'nook-calendar-delete-this'), !!find(host, 'nook-calendar-delete-all')]; })()" '[true,true,true]'
nnx_shot caledit-recurring-delete
nnx_eval "(() => { const n = $NNX; $FIND find(host, 'nook-calendar-delete-all').emit('clicked', 1); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-delete-all "(() => { const n = $NNX; $LAST const [, a] = last('events.delete'); return [a.source, a.uid, a.rid, a.all, n._calSheet]; })()" '["w","rec1","20261109T130000Z",true,null]'
nnx_eval "(() => { const n = $NNX; $FIND n._openCalendarEvent(n._calendarServerEvents.get(ID('w', 'rec1', '20261109T130000Z'))); find(host, 'nook-calendar-delete').emit('clicked', 1); find(host, 'nook-calendar-delete-this').emit('clicked', 1); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-delete-this "(() => { const n = $NNX; $LAST const [, a] = last('events.delete'); return [a.rid, a.all]; })()" '["20261109T130000Z",false]'

# A refused save keeps the editor open with the input, inline error + alert.
nnx_eval "(() => { const n = $NNX; $FIND find(host, 'nook-calendar-add').emit('clicked', 1); n._calSheetUi.title.set_text('fail'); n._calSheetUi.location.set_text('Room 9'); find(host, 'nook-calendar-save').emit('clicked', 1); return true; })()" >/dev/null; sleep 1
nnx_check caledit-save-rejected "(() => { const n = $NNX; $FIND const err = find(host, 'nook-calendar-sheet-error'); return [n._calSheet && n._calSheet.mode, n._calSheetUi.title.get_text(), n._calSheetUi.location.get_text(), err.visible, err.get_text(), n._alerts._pending.some(a => a.kind === 'gcal' && a.title === \"Couldn't save to Google\" && a.value === 'offline')]; })()" '["new","fail","Room 9",true,"offline",true]'
nnx_shot caledit-save-rejected

# Keyboard: Esc in an editor field releases the grab only (sheet and input stay).
nnx_eval "(() => { const n = $NNX; n._calSheetUi.title.clutter_text.grab_key_focus(); return true; })()" >/dev/null; sleep 0.5
nnx_check caledit-field-grab "(() => { const n = $NNX; return [n._kbGrab !== null, global.stage.get_key_focus() === n._calSheetUi.title.clutter_text]; })()" '[true,true]'
press KEY_Escape
nnx_check caledit-field-esc "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null, n._calSheet && n._calSheet.mode, n._calSheetUi.title.get_text()]; })()" '[true,true,"new","fail"]'

# Flag off again: the sheet and the client go, the tab is as before.
nnx_eval "(() => { const n = $NNX; n._setFeature('calendarEdit', false); return true; })()" >/dev/null; sleep 1
nnx_check caledit-off-again "(() => { const n = $NNX; $FIND return [globalThis.__nnxCal.destroyed, n._calClient, n._calSheet, !!find(host, 'nook-calendar-add'), !!find(host, 'nook-calendar-event-btn')]; })()" '[true,null,null,false,false]'
nnx_eval "(() => { const n = $NNX; $ID for (const id of [ID('w', 'ev1', ''), ID('h', 'hol1', ''), ID('w', 'rec1', '20261109T130000Z')]) n._calendarServerEvents.delete(id); n.collapse(); delete globalThis.__nnxCal; return true; })()" >/dev/null
