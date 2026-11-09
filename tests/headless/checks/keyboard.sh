# Keyboard shortcut checks (sourced by tests/headless-smoke.sh --script).
nnx_check keybinding-registered "Main.wm._allowedKeybindings['toggle-notch'] !== undefined" true
# The smoke run leaves the notch open, so start by closing it.
# expand()/collapse() flip isExpanded synchronously, so no waiting between calls.
nnx_check toggle "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); const a = n.isExpanded; n._toggleFromKeyboard(); return [a, n.isExpanded]; })()" '[true,false]'
# Command bar: a keyboard open shows it with the entry focused.
nnx_check bar-visible "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); return [n._commandBar.visible, n._openedByKeyboard, global.stage.get_key_focus() === n._commandEntry.clutter_text]; })()" '[true,true,true]'
# Math preview formats 0.1+0.2 as 0.3.
nnx_check calc-format "(() => { const n = $NNX; n._commandEntry.text = '=0.1+0.2'; return n._commandHint.text.startsWith('= 0.3 '); })()" true
# A calc error shows in the preview and Enter keeps the notch open.
nnx_check calc-error "(() => { const n = $NNX; n._commandEntry.text = '=2+'; n._submitCommand(); return n._commandHint.text === 'Incomplete expression' && n.isExpanded; })()" true
nnx_check starred-preview "(() => { const n = $NNX; n._commandEntry.text = 't !buy milk'; return n._commandHint.text === \"Add task 'buy milk' \\u2605\"; })()" true
sleep 1.5
nnx_shot tab-home-bar
# A task command runs and the notch closes, releasing every grab.
nnx_check command-task "(() => { const n = $NNX; n._commandEntry.text = 't smoke task'; n._submitCommand(); return n._prod.openTasks.some(t => t.text === 'smoke task'); })()" true
# The n command adds a post-it note.
nnx_check command-note "(() => { const n = $NNX; n._toggleFromKeyboard(); n._commandEntry.text = 'n smoke note'; n._submitCommand(); return n._prod.notes.some(x => x.text === 'smoke note'); })()" true
nnx_check command-closes "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null, n._commandBar.visible]; })()" '[false,true,false]'
# Notes editor stays bound to the note it showed: a note added meanwhile is not overwritten.
nnx_check notes-editor-bound "(() => { const n = $NNX; n.collapse(); n._prod.addNote('first note'); n.expand(); n._switchTab('notes'); const a = n._prod.notes[0].id; n._notesUi.showEditor(a); const b = n._prod.addNote('other note'); const shown = n._notesUi.entry.get_text(); n._notesUi.entry.set_text('edited'); const r = [shown, n._prod.getNote(a).text, n._prod.getNote(b).text, n._notesUi.openId === a]; n.collapse(); return r; })()" '["first note","edited","other note",true]'
# An outside change while the editor has focus marks the tab dirty; it shows once focus leaves.
nnx_check notes-dirty-while-focused "(() => { const n = $NNX; n.collapse(); n.expand(); n._switchTab('notes'); n._notesUi.entry.clutter_text.grab_key_focus(); n._prod.addNote('ext note'); return n._tabHosts.get('notes')._dirty === true; })()" true
nnx_check notes-focus-leaves "(() => { const n = $NNX; n._tabButtons[n._activeTab].grab_key_focus(); return [global.stage.get_key_focus() === n._notesUi.entry.clutter_text, n._tabHosts.get('notes')._dirty === true]; })()" '[false,true]'
sleep 0.5
nnx_check notes-keeps-bound-note "(() => { const n = $NNX; const r = n._notesUi.entry?.get_text(); const open = n._notesUi.openId; return [r, n._prod.getNote(open).text]; })()" '["edited","edited"]'
# Showing the dirty tab again refreshes it from the store (the outside note is on the board).
nnx_check notes-dirty-refreshes-on-show "(() => { const n = $NNX; n.collapse(); n._notesOpenId = null; n.expand(); n._switchTab('notes'); const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const r = [n._tabHosts.get('notes')._dirty === false, n._notesUi.openId, n._prod.notes.some(x => x.text === 'ext note')]; n.collapse(); return r; })()" '[true,null,true]'
# A tab command opens that tab and stays open.
nnx_check command-tab "(() => { const n = $NNX; n._toggleFromKeyboard(); n._commandEntry.text = 'home'; n._submitCommand(); const r = n.isExpanded; n.collapse(); return [r, n._kbGrab === null]; })()" '[true,true]'
# A plain (hover-style) open does not show the bar.
nnx_check bar-hidden-on-plain-expand "(() => { const n = $NNX; n.collapse(); n.expand(); return n._commandBar.visible; })()" false
# Esc in the command entry, sent as a real key press through a virtual keyboard
# (reaches both key-press handlers in connection order), closes the notch.
nnx_check esc-open "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); return [n.isExpanded, n._kbGrab !== null]; })()" '[true,true]'
sleep 1
nnx_check esc-press "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; d.notify_keyval(t, C.KEY_Escape, C.KeyState.PRESSED); d.notify_keyval(t + 1000, C.KEY_Escape, C.KeyState.RELEASED); return true; })()" true
sleep 1
nnx_check esc-collapses "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null]; })()" '[false,true]'

# ---- Dashboard keyboard navigation (real key presses) ----
# nnx_keys KEY_x [ctrl]: press+release a key, optionally with Ctrl held.
nnx_keys() {
    local ctrl="" ctrlup=""
    if [ -n "${2:-}" ]; then
        ctrl="d.notify_keyval(t, 0xffe3, C.KeyState.PRESSED);"
        ctrlup="d.notify_keyval(t + 3000, 0xffe3, C.KeyState.RELEASED);"
    fi
    nnx_check "press-$1${2:-}" "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; $ctrl d.notify_keyval(t + 1000, C.$1, C.KeyState.PRESSED); d.notify_keyval(t + 2000, C.$1, C.KeyState.RELEASED); $ctrlup return true; })()" true
    sleep 0.8
}
nnx_check nav-open "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); n._switchTab(n._tabOrder[0]); return [n.isExpanded, n._kbGrab !== null]; })()" '[true,true]'
sleep 1
# Right inside the command entry moves the caret, not the tab.
nnx_keys KEY_Right
nnx_check right-in-entry "(() => { const n = $NNX; return n._activeTab === n._tabOrder[0]; })()" true
# Tab leaves the entry; the grab stays.
nnx_keys KEY_Tab
nnx_check tab-leaves-entry "(() => { const n = $NNX; return [global.stage.get_key_focus() !== n._commandEntry.clutter_text, n._kbGrab !== null]; })()" '[true,true]'
# Right now switches to the next tab.
nnx_keys KEY_Right
nnx_check right-next-tab "(() => { const n = $NNX; return n._activeTab === n._railIds()[1]; })()" true
nnx_keys KEY_3 ctrl
nnx_check ctrl3 "(() => { const n = $NNX; return n._activeTab === n._tabOrder[2]; })()" true
# Esc with focus on a tab button collapses and releases the grab.
nnx_check focus-tab-btn "(() => { const n = $NNX; n._tabButtons[n._activeTab].grab_key_focus(); return n._isDescendant(global.stage.get_key_focus()); })()" true
nnx_keys KEY_Escape
nnx_check esc-on-button "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null]; })()" '[false,true]'

# ---- Super+/ and Esc with real keys ----
# nnx_super_slash: press Super_L, slash, release both.
nnx_super_slash() {
    nnx_eval "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; d.notify_keyval(t + 1000, 0xffeb, C.KeyState.PRESSED); d.notify_keyval(t + 2000, C.KEY_slash, C.KeyState.PRESSED); d.notify_keyval(t + 3000, C.KEY_slash, C.KeyState.RELEASED); d.notify_keyval(t + 4000, 0xffeb, C.KeyState.RELEASED); return true; })()" >/dev/null
    sleep 0.8
}
nnx_check super-open "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); return [n.isExpanded, n._kbGrab !== null, global.stage.get_key_focus() === n._commandEntry.clutter_text]; })()" '[true,true,true]'
sleep 1
nnx_super_slash
nnx_check super-closes-from-bar "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null, n._commandEntry.get_text().includes('/')]; })()" '[false,true,false]'
# Super+/ opens a closed notch again (NORMAL mode).
nnx_super_slash
nnx_check super-opens "(() => { const n = $NNX; const r = [n.isExpanded, n._kbGrab !== null]; n.collapse(); return r; })()" '[true,true]'
sleep 0.7
# Another modal on top: Super+/ must not open the notch over it.
nnx_eval "(() => { globalThis.__nnxModalActor = new imports.gi.St.Widget({ reactive: true }); Main.uiGroup.add_child(globalThis.__nnxModalActor); globalThis.__nnxModal = Main.pushModal(globalThis.__nnxModalActor, { actionMode: imports.gi.Shell.ActionMode.POPUP }); return true; })()" >/dev/null
nnx_super_slash
nnx_check super-ignored-over-modal "$NNX.isExpanded" false
nnx_eval "(() => { Main.popModal(globalThis.__nnxModal); globalThis.__nnxModalActor.destroy(); return true; })()" >/dev/null; sleep 0.5

# The overview holds a modal of its own: Super+/ still opens the notch over it,
# with the command bar focused, and Esc closes the notch, leaving the overview.
nnx_eval "(() => { Main.overview.show(); return true; })()" >/dev/null; sleep 1.5
nnx_check overview-shown "[Main.overview.visible, Main.actionMode === imports.gi.Shell.ActionMode.OVERVIEW]" '[true,true]'
nnx_super_slash
nnx_check super-opens-in-overview "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab !== null, global.stage.get_key_focus() === n._commandEntry.clutter_text]; })()" '[true,true,true]'
nnx_keys KEY_Escape
nnx_check overview-esc-closes "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null, Main.overview.visible, Main.actionMode === imports.gi.Shell.ActionMode.OVERVIEW]; })()" '[false,true,true,true]'
nnx_eval "(() => { Main.overview.hide(); return true; })()" >/dev/null; sleep 1.5
nnx_check overview-hidden "[Main.overview.visible, Main.actionMode === imports.gi.Shell.ActionMode.NORMAL]" '[false,true]'

# Esc in a Tasks in-place edit cancels the edit and leaves the notch open.
nnx_eval "(() => { const n = $NNX; n.collapse(); n._prod.addTask('esc edit task'); n.expand(); n._switchTab('tasks'); return true; })()" >/dev/null; sleep 1.5
FIND="const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; };"
TASKLABEL="find(n._tabHosts.get('tasks'), a => a instanceof imports.gi.St.Label && a.has_style_class_name('nook-task-text') && a.get_text() === 'esc edit task')"
EDIT="find(n._tabHosts.get('tasks'), a => a.has_style_class_name && a.has_style_class_name('nook-task-edit'))"
POS=$(nnx_eval "(() => { const n = $NNX; $FIND const l = $TASKLABEL; if (!l) return [-1, -1]; const [x, y] = l.get_transformed_position(); return [Math.round(x + 20), Math.round(y + l.height / 2)]; })()")
PX=$(echo "$POS" | tr -d '[]' | cut -d, -f1); PY=$(echo "$POS" | tr -d '[]' | cut -d, -f2)
nnx_eval "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); const t = global.get_current_time() * 1000; d.notify_absolute_motion(t, $PX, $PY); d.notify_button(t + 20000, C.BUTTON_PRIMARY, C.ButtonState.PRESSED); d.notify_button(t + 40000, C.BUTTON_PRIMARY, C.ButtonState.RELEASED); return true; })()" >/dev/null; sleep 0.8
nnx_check task-edit-open "(() => { const n = $NNX; $FIND const e = $EDIT; return [!!e, !!e && global.stage.get_key_focus() === e.clutter_text, n._kbGrab !== null]; })()" '[true,true,true]'
nnx_keys KEY_x
nnx_check task-edit-typed "(() => { const n = $NNX; $FIND const e = $EDIT; return !!e && e.get_text() === 'esc edit taskx'; })()" true
nnx_keys KEY_Escape
nnx_check task-edit-esc-cancels "(() => { const n = $NNX; $FIND return [n.isExpanded, !$EDIT, n._prod.openTasks.some(t => t.text === 'esc edit task'), !!$TASKLABEL]; })()" '[true,true,true,true]'

# Esc in a field of a mouse-opened dashboard only releases the grab.
nnx_check field-grab "(() => { const n = $NNX; $FIND const e = find(n._tabHosts.get('tasks'), a => a instanceof imports.gi.St.Entry && a.has_style_class_name('nook-input')); e.clutter_text.grab_key_focus(); return [n._openedByKeyboard, n._kbGrab !== null]; })()" '[false,true]'
nnx_keys KEY_Escape
nnx_check field-esc-releases "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null]; })()" '[true,true]'
# Esc on the scan sheet (Wi-Fi/Bluetooth overlay) closes just the sheet.
nnx_check sheet-open "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); n._openScanOverlay({ title: 'Test' }); return [!!n._scanOverlay, n._kbGrab !== null, n._isDescendant(global.stage.get_key_focus())]; })()" '[true,true,true]'
sleep 0.5
nnx_keys KEY_Escape
nnx_check sheet-esc-closes-sheet "(() => { const n = $NNX; return [n._scanOverlay === null, n.isExpanded]; })()" '[true,true]'
# A throw while releasing never leaves focus-driven grabs switched off.
# The deliberate throw gets logged, so report earlier errors now and mark after.
pre=$(nnx_errors); [ -z "$pre" ] || { nnx_fail errors-before-release-throw 'NotchNux errors in the shell log:'; printf '%s\n' "$pre"; }
nnx_check release-throw-resets "(() => { const n = $NNX; n.collapse(); n.expand(); n._grabKeyboard(null); const had = n._kbGrab !== null; const s = global.stage; s.set_key_focus = () => { throw new Error('test'); }; let threw = false; try { n._releaseKeyboard(); } catch (e) { threw = true; } delete s.set_key_focus; return [had, threw, n._releasingKeyboard, n._kbGrab === null]; })()" '[true,true,false,true]'
nnx_eval "$NNX.collapse(), true" >/dev/null
nnx_mark
# A collapsed notch never takes a grab.
nnx_check no-grab-collapsed "(() => { const n = $NNX; n.collapse(); n._grabKeyboard(null); return n._kbGrab === null; })()" true
