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
