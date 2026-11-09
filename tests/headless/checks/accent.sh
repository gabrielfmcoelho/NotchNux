# System accent checks (sourced by tests/headless-smoke.sh --script).
# The smoke shell is GNOME 51, so accent-color exists; its isolated profile uses
# the keyfile GSettings backend, so the real desktop setting is never touched.
# widgets.js accentHex() is not reachable from Shell.Eval, so read what it fed:
# the active tab button's inline colour, set by _applyAccentStyles().
set_accent() { nnx_eval "new imports.gi.Gio.Settings({schema_id:'org.gnome.desktop.interface'}).set_string('accent-color','$1'), true" >/dev/null; sleep 1; }
tint() { echo "$NNX._tabButtons[$NNX._activeTab].get_style() === 'color: $1;'"; }

nnx_eval "$NNX._config._data.accentMode = 'system', $NNX._applyAccent(), true" >/dev/null
set_accent teal
nnx_check accent-teal "$(tint '#2190a4')" true
set_accent pink
nnx_check accent-pink "$(tint '#d56199')" true
