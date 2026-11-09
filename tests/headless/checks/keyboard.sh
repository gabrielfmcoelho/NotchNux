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
nnx_check command-closes "(() => { const n = $NNX; return [n.isExpanded, n._kbGrab === null, n._commandBar.visible]; })()" '[false,true,false]'
# A tab command opens that tab and stays open.
nnx_check command-tab "(() => { const n = $NNX; n._toggleFromKeyboard(); n._commandEntry.text = 'home'; n._submitCommand(); const r = n.isExpanded; n.collapse(); return [r, n._kbGrab === null]; })()" '[true,true]'
# A plain (hover-style) open does not show the bar.
nnx_check bar-hidden-on-plain-expand "(() => { const n = $NNX; n.collapse(); n.expand(); return n._commandBar.visible; })()" false
