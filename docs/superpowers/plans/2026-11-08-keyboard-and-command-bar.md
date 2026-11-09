# Keyboard Shortcut, Command Bar and Keyboard Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global shortcut opens the notch with a command bar focused, and the whole dashboard can be driven from the keyboard.

**Architecture:** The shortcut is a GSettings keybinding (the only thing Mutter can grab), so the extension gets its first schema. Command parsing is a pure module with no Shell imports, testable with plain `gjs -m`. The notch side lives in a new `src/tabs/keyboard.js` mixin (`installKeyboard(proto)` and `_initKeyboard()`, the same pattern as `installClaude`). It reuses the existing `Main.pushModal` keyboard grab in `notchnux.js` (`_grabKeyboard`, around line 6196).

**Tech Stack:** GJS ESM, GSettings, `Main.wm.addKeybinding`, St/Clutter key events, Adw/Gtk 4 for preferences.

**Spec:** Features 1 and 12 from the 2026-11-08 session. "Global keyboard shortcut and quick command bar": open the notch from the keyboard, then type to add a task, start a timer, do math or switch tabs. "Keyboard navigation": arrow keys between tabs, Esc to close.

## Global Constraints

- Default shortcut `['<Super>slash']`, checked free on GNOME. `<Super>n` is `focus-active-notification` and `<Super>semicolon` is the IBus emoji hotkey.
- Schema id `org.gnome.shell.extensions.notchnux`, path `/org/gnome/shell/extensions/notchnux/`, key `toggle-notch` (`as`). `metadata.json` gets `"settings-schema": "org.gnome.shell.extensions.notchnux"`. Every other setting stays in the JSON config.
- The command bar must never use `eval`/`Function`. Math is a hand-written parser that accepts only numbers, `+ - * / % ^ ( )` and decimals.
- Works on GNOME 46–51. Use `Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW` and `Meta.KeyBindingFlags.NONE` (both exist across that range).
- Verification for UI tasks: `tests/headless-smoke.sh` from the smoke-test plan, which must be done first.

## Review Focus

- **Shortcut pressed while the notch is already open:** it toggles closed. It does not reopen or stack a second modal grab.
- **Shortcut pressed while a text field has the grab** (a task entry is being edited): the existing grab is reused, never a double `pushModal`. Closing releases every grab, so the shell keeps keyboard input afterwards.
- **Command text that is a bare number with a unit or junk** (`25`, `25m`, `1h`, `25 min`, `abc`, `=2+`): `25`, `25m` and `25 min` start a 25-minute focus session, `1h` a 60-minute one; `=2+` shows "Incomplete expression" and does nothing; unknown text falls back to "Add task 'abc'" as the highlighted suggestion.
- **Arrow keys inside a text entry:** they move the caret and never switch tabs.
- **Schema missing at runtime** (a manual install that skipped `glib-compile-schemas`): the extension still enables and logs one error; only the shortcut is missing.

---

### Task 1: Command parser (pure, tested)

**Files:**
- Create: `src/helpers/commands.js`
- Test: `tests/commands-check.js` (same harness style as `tests/config-check.js`)

**Interfaces:**
- Produces: `parseCommand(text: string, tabs: {id: string, label: string}[]) -> Command`, where `Command` is one of:
  - `{kind: 'task', text, starred}`
  - `{kind: 'focus', minutes}`
  - `{kind: 'calc', value}` or `{kind: 'calc', error}`
  - `{kind: 'tab', id}`
  - `{kind: 'note', text}`
  - `{kind: 'empty'}`
- Produces: `evalMath(expr: string) -> number` (throws `Error('Incomplete expression')` or `Error('Not a number')`).

- [ ] **Step 1: Write the failing test** with these exact cases:
```js
eq(parseCommand('t buy milk', TABS), { kind: 'task', text: 'buy milk', starred: false }, 'task prefix');
eq(parseCommand('t !call bank', TABS), { kind: 'task', text: 'call bank', starred: true }, 'starred task');
eq(parseCommand('n idea', TABS), { kind: 'note', text: 'idea' }, 'note prefix');
eq(['25', '25m', '25 min', '1h'].map(s => parseCommand(s, TABS).minutes), [25, 25, 25, 60], 'focus durations');
eq(parseCommand('=2*(3+4)^2', TABS), { kind: 'calc', value: 98 }, 'math precedence');
eq(parseCommand('=2+', TABS), { kind: 'calc', error: 'Incomplete expression' }, 'bad math');
eq(parseCommand('wea', TABS), { kind: 'tab', id: 'weather' }, 'tab label prefix');
eq(parseCommand('abc', TABS), { kind: 'task', text: 'abc', starred: false }, 'fallback is a task');
eq(parseCommand('   ', TABS), { kind: 'empty' }, 'blank');
ok(throws(() => evalMath('process.exit()')), 'no code execution');
```
- [ ] **Step 2: Run it to see it fail.**
  Run: `gjs -m tests/commands-check.js`
  Expected: an import error (`commands.js` missing).
- [ ] **Step 3: Implement `parseCommand` and `evalMath`.** Use a recursive-descent parser for math: `^` is right-associative and binds tighter than unary minus on its left operand. Match a tab by a case-insensitive prefix of the id or label, only when the text is a single word of 3 or more letters.
- [ ] **Step 4: Run it to see it pass.**
  Run: `gjs -m tests/commands-check.js`
  Expected: `commands-check: 10 checks passed`.
- [ ] **Step 5: Commit.**
```bash
git add src/helpers/commands.js tests/commands-check.js
git commit -m "feat: command parser for the notch command bar"
```

### Task 2: Schema, keybinding and toggle

**Files:**
- Create: `schemas/org.gnome.shell.extensions.notchnux.gschema.xml`
- Create: `src/tabs/keyboard.js` (`installKeyboard(proto)`, methods `_initKeyboard()`, `_destroyKeyboard()`, `_toggleFromKeyboard()`)
- Modify: `metadata.json` (`settings-schema`), `extension.js` (pass `this.getSettings()` into the notch; `getSettings` wrapped in try/catch so a missing schema only disables the shortcut)
- Modify: `src/notchnux.js` (import and call `installKeyboard` next to `installDev` near line 6687; call `_initKeyboard()` in `_init` after `_initDev()`; call `_destroyKeyboard()` in destroy)
- Modify: `install.sh` (copy `schemas/` and run `glib-compile-schemas "$DEST_DIR/schemas"`), `pack.sh` (`--extra-source=schemas` is not needed because `gnome-extensions pack` picks up `schemas/` itself, but check the zip listing)

**Interfaces:**
- Consumes: `this.expand()`, `this.collapse()`, `this.isExpanded`, `this._grabKeyboard(focusTarget)`, `this._queueKeyboardRelease()` (existing).
- Produces: `this._settings: Gio.Settings | null`; `this._openedByKeyboard: boolean` (true until the next collapse); `_toggleFromKeyboard()`.

- [ ] **Step 1: Add the schema and keybinding.** Register `Main.wm.addKeybinding('toggle-notch', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._toggleFromKeyboard())`. Remove it with `Main.wm.removeKeybinding('toggle-notch')` on destroy.
- [ ] **Step 2: Verify in the smoke shell.** Create `tests/headless/checks/keyboard.sh` with:
  - `nnx_check keybinding-registered "Main.wm._allowedKeybindings['toggle-notch'] !== undefined" true` (`addKeybinding` records every binding there)
  - `nnx_check toggle "[${NNX}._toggleFromKeyboard(), ${NNX}.isExpanded, ${NNX}._toggleFromKeyboard(), ${NNX}.isExpanded].slice(1).filter((_, i) => i % 2 === 0)" '[true,false]'`

  Run: `tests/headless-smoke.sh --tabs home --script tests/headless/checks/keyboard.sh`
  Expected: all PASS.
- [ ] **Step 3: Install path check.**
  Run: `./install.sh` then `ls ~/.local/share/gnome-shell/extensions/notchnux@adityasah.programs/schemas/gschemas.compiled`
  Expected: the file exists.
- [ ] **Step 4: Commit.**
```bash
git add schemas src/tabs/keyboard.js metadata.json extension.js src/notchnux.js install.sh pack.sh
git commit -m "feat: global shortcut (Super+/) toggles the notch"
```

### Task 3: Command bar UI

**Files:**
- Modify: `src/tabs/keyboard.js` (`_buildCommandBar()` creating `this._commandEntry`, `_submitCommand()`, `_runCommand(cmd)`, `_previewCommand(cmd) -> string`)
- Modify: `src/notchnux.js` (insert the bar above the tab content when `_openedByKeyboard` is true; it is hidden otherwise)
- Modify: `stylesheet.css` (`.nook-command-bar`, `.nook-command-hint`)

**Interfaces:**
- Consumes: `parseCommand`, `evalMath` (Task 1); `this._store.addTask(text)` with a leading `!` for starred; `this._store.startFocus()` after a new `this._store.setFocusMinutes(min)` (add it to `ProductivityStore`: clamps to 1–180 and sets `_focus.presetMin`; `setPreset` stays as-is because it rejects anything but 15/25/50; cover the clamp with two assertions in `tests/commands-check.js`); `this._switchTab(id)`; `this._store.setNotes(...)` until the sticky-notes plan replaces notes with `addNote(text)`.
- Produces: `_runCommand(cmd) -> boolean` (true means handled and the notch closes, except for `calc`, which stays open to show the result and puts it on the clipboard).

- [ ] **Step 1: Build it.** An `St.Entry` with a one-line preview label under it ("Add task 'buy milk'", "Start 25 min focus", "= 98 — Enter copies", "Open Weather"). Enter runs the command, Esc closes.
- [ ] **Step 2: Smoke check.** In `tests/headless/checks/keyboard.sh`: open via `${NNX}._toggleFromKeyboard()`, set `${NNX}._commandEntry.text = 't smoke task'`, call `${NNX}._submitCommand()` (the Enter handler), then `nnx_check command-task "${NNX}._store.openTasks.some(t => t.text === 'smoke task')" true`.
  Run: `tests/headless-smoke.sh --tabs home --script tests/headless/checks/keyboard.sh`
  Expected: PASS, and `tests/out/tab-home.png` shows the bar.
- [ ] **Step 3: Commit.**
```bash
git add src/tabs/keyboard.js src/notchnux.js stylesheet.css src/helpers/productivity.js
git commit -m "feat: command bar — tasks, focus, math, tabs, notes from the keyboard"
```

### Task 4: Keyboard navigation in the open dashboard

**Files:**
- Modify: `src/tabs/keyboard.js` (`_onDashboardKey(event) -> Clutter.EVENT_*`)
- Modify: `src/notchnux.js` (connect `key-press-event` on the expanded surface; while expanded by keyboard, hold the modal grab so keys arrive)

**Interfaces:**
- Consumes: `this._switchTabRelative(delta)`, `this._tabOrder`, `this.collapse()`.
- Produces: the key map (applied only when the key focus is not an `St.Entry`/`Clutter.Text` in edit mode):
  - Esc closes
  - Left and Right switch tabs (`_switchTabRelative(∓1)`)
  - Ctrl+1 … Ctrl+9 open that tab in `_tabOrder`
  - Tab and Shift+Tab move focus inside the tab (`navigate_focus` with `St.DirectionType.TAB_FORWARD`/`TAB_BACKWARD`)
  - Enter and Space activate the focused button (St does this already; just don't swallow them)

- [ ] **Step 1: Implement `_onDashboardKey`.** Return `EVENT_PROPAGATE` for anything not in the map.
- [ ] **Step 2: Add visible focus styles** (`:focus` outline using the accent) to `.notchnux-tab-btn` and the main card buttons in `stylesheet.css`.
- [ ] **Step 3: Smoke check.** Real key injection isn't available in the headless shell, so call `_onDashboardKey` directly with a fake event: `{ get_key_symbol: () => Clutter.KEY_Right, get_state: () => 0 }`. In `tests/headless/checks/keyboard.sh`:
  - after Right, `nnx_check` that `_activeTab` is the next id in `_tabOrder`
  - after a fake Escape, `isExpanded === false`

  Run: `tests/headless-smoke.sh --tabs home --script tests/headless/checks/keyboard.sh`
  Expected: PASS.
- [ ] **Step 4: Manual check on the real desktop:** Super+/ → Right Right → Esc, then confirm typing works in other apps afterwards (no stuck grab).
- [ ] **Step 5: Commit.**
```bash
git add src/tabs/keyboard.js src/notchnux.js stylesheet.css
git commit -m "feat: keyboard navigation in the dashboard (arrows, Ctrl+N, Esc, focus ring)"
```

### Task 5: Preferences row for the shortcut

**Files:**
- Modify: `prefs.js` (new "Keyboard" group: shortcut row with a capture dialog, plus a reset button)

**Interfaces:**
- Consumes: `this.getSettings()` in `ExtensionPreferences`, key `toggle-notch`.

- [ ] **Step 1: Build the row.** An `Adw.ActionRow` that shows `Gtk.accelerator_get_label` for the current value. Clicking opens an `Adw.Dialog` with a `Gtk.EventControllerKey`; it accepts a combo that has a modifier, Backspace clears it and Esc cancels. Save with `Gtk.accelerator_name`.
- [ ] **Step 2: Manual check.** Run `gnome-extensions prefs notchnux@adityasah.programs`, set `<Super>j`, then press Super+J on the desktop.
  Expected: the notch toggles, and `gsettings --schemadir ~/.local/share/gnome-shell/extensions/notchnux@adityasah.programs/schemas get org.gnome.shell.extensions.notchnux toggle-notch` prints `['<Super>j']`.
- [ ] **Step 3: Update README features table and CHANGELOG `[Unreleased]`, then commit.**
```bash
git add prefs.js README.md CHANGELOG.md
git commit -m "feat: choose the notch shortcut in Preferences"
```
