# Keyboard shortcut checks (sourced by tests/headless-smoke.sh --script).
nnx_check keybinding-registered "Main.wm._allowedKeybindings['toggle-notch'] !== undefined" true
# The smoke run leaves the notch open, so start by closing it.
# expand()/collapse() flip isExpanded synchronously, so no waiting between calls.
nnx_check toggle "(() => { const n = $NNX; n.collapse(); n._toggleFromKeyboard(); const a = n.isExpanded; n._toggleFromKeyboard(); return [a, n.isExpanded]; })()" '[true,false]'
