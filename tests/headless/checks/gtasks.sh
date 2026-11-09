# Google Tasks mode of the Tasks tab (sourced by tests/headless-smoke.sh --script).
# Runs against a FAKE EdsClient injected through Eval: the real EDS worker is
# never started and no Google account is involved. Its `tasks.create` rejects
# with 'offline' to exercise the rollback path, except for 'hold', which never
# answers (a row still being saved).

FAKE="{ calls: [], resets: 0, destroyed: false,
  call(op, args) { this.calls.push(op);
    if (op === 'sources') return Promise.resolve({ tasks: [
      { uid: 'g1', name: 'My Tasks', account: 'me@example.com', backend: 'gtasks', writable: true, color: null },
      { uid: 'g2', name: 'My Tasks', account: 'you@example.com', backend: 'gtasks', writable: true, color: null },
      { uid: 'ro', name: 'Holidays', account: 'me@example.com', backend: 'caldav', writable: false, color: null }], calendars: [] });
    if (op === 'tasks.list') return Promise.resolve([{ uid: 't1', summary: 'from google', done: false, due: null, notes: '', updated: 1 }]);
    if (op === 'tasks.create') return args.summary === 'hold' ? new Promise(() => {}) : Promise.reject(new Error('offline'));
    return Promise.resolve({}); },
  reset() { this.resets++; }, destroy() { this.destroyed = true; } }"

nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 0.5
nnx_check gtasks-off-local "[$NNX._taskSource.kind, $NNX._edsClient === null || $NNX._edsClient === undefined]" '["local",true]'

# Flag on (fake client in place first, so nothing real is spawned).
nnx_check gtasks-on "(() => { const n = $NNX; globalThis.__nnxFake = $FAKE; n._edsClient = globalThis.__nnxFake; n._setFeature('googleTasks', true); return [n._taskSource.kind, n._edsClient === globalThis.__nnxFake]; })()" '["local",true]'
nnx_eval "(() => { const n = $NNX; n.expand(); n._switchTab('tasks'); return true; })()" >/dev/null; sleep 1
FIND="const find = (x, cls) => { if (x.has_style_class_name && x.has_style_class_name(cls)) return x; for (const c of x.get_children()) { const r = find(c, cls); if (r) return r; } return null; }; const host = n._tabHosts.get('tasks');"
nnx_check gtasks-tab-shown "(() => { const n = $NNX; $FIND return [globalThis.__nnxFake.resets >= 1, !!find(host, 'nook-task-source'), n._taskLists.map(c => c.label)]; })()" '[true,true,["Local","My Tasks — me@example.com","My Tasks — you@example.com"]]'

# Pick the first Google list: its tasks show.
nnx_eval "(() => { const n = $NNX; n._tasksPickerOpen = true; n._tasksUi.fill(); n._pickTaskList('g1'); return true; })()" >/dev/null; sleep 1
nnx_check gtasks-picked "(() => { const n = $NNX; $FIND return [n._config.tasksSource, n._taskSource.kind, n._taskSource.open.map(t => t.text), find(host, 'nook-task-source-label').get_text() === 'My Tasks — me@example.com', !!find(host, 'nook-task-refresh')]; })()" '["g1","eds",["from google"],true,true]'

# A refused add rolls back, shows the error inline and gives the text back.
nnx_eval "(() => { const n = $NNX; n._tasksUi.entry.set_text('will fail'); n._tasksUi.entry.clutter_text.emit('activate'); return true; })()" >/dev/null; sleep 1
nnx_check gtasks-add-rollback "(() => { const n = $NNX; $FIND const err = find(host, 'nook-task-error'); return [n._taskSource.open.map(t => t.text), n._taskSource.error, n._tasksUi.entry.get_text(), err.visible, err.get_text().startsWith('Couldn'), err.get_text().endsWith('save to Google — offline'), n._alerts._pending.some(a => a.kind === 'gtasks')]; })()" '[["from google"],"offline","will fail",true,true,true,true]'
nnx_shot tab-tasks-google

# The 5-min re-sync runs for a Google list only.
nnx_check gtasks-timer-on "$NNX._tasksRefreshId > 0" true

# A row still being saved can't be ticked, edited, starred or deleted.
nnx_eval "(() => { const n = $NNX; n._tasksUi.entry.set_text(''); n._taskSource.add('hold'); return true; })()" >/dev/null; sleep 0.5
nnx_check gtasks-pending-inert "(() => { const n = $NNX; $FIND const row = find(host, 'nook-task-pending'); const check = find(row, 'nook-task-check'); const text = find(row, 'nook-task-text'); const acts = find(row, 'nook-task-actions').get_children(); return [!!row, row.opacity < 255, check.reactive, text.reactive, acts.length, acts.some(b => b.reactive)]; })()" '[true,true,false,false,2,false]'

# Back to Local with the flag still on: the re-sync timer stops.
nnx_eval "(() => { const n = $NNX; n._pickTaskList('local'); return true; })()" >/dev/null; sleep 0.5
nnx_check gtasks-local-timer-off "[$NNX._taskSource.kind, $NNX._tasksRefreshId]" '["local",0]'
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
nnx_check gtasks-alert-after-collapse "(() => { const n = $NNX; return [n._alerts.current?.kind, n._alertTitle.get_text() === \"Couldn't save to Google\", n._alertValue.get_text()]; })()" '["gtasks",true,"offline"]'

# Flag off: Local again, the client destroyed, no picker.
nnx_eval "(() => { const n = $NNX; n._setFeature('googleTasks', false); n.expand(); n._switchTab('tasks'); return true; })()" >/dev/null; sleep 1
nnx_check gtasks-off-again "(() => { const n = $NNX; $FIND return [n._taskSource.kind, globalThis.__nnxFake.destroyed, n._edsClient, !!find(host, 'nook-task-source')]; })()" '["local",true,null,false]'
nnx_eval "(() => { const n = $NNX; n._writeConfig(c => c.setTasksSource('local')); n.collapse(); delete globalThis.__nnxFake; return true; })()" >/dev/null
