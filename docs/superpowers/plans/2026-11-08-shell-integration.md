# Live Activities API, Screen-Share Indicator and System Accent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scripts can push live activities into the pill over D-Bus, the pill shows when the screen is shared or recorded, and the accent can follow GNOME's system accent.

**Architecture:** There are three independent pieces, each with a pure, tested core and a thin Shell adapter.
- **Activities:** validation lives in `src/helpers/activities.js`. A `Gio.DBusExportedObject` owns `io.github.notchnux` and feeds the existing island alert queue (`_pushAlert({kind, icon, title, value, level, color, ms, onClick})` in `src/tabs/ledge.js:266`, which replaces an alert of the same `kind`).
- **Screen share:** watched through `global.backend.get_remote_access_controller()` (`new-handle`, `handle.is_recording`, `stopped`) and `Main.screenshotUI` (`screencast-in-progress`). This is the same source GNOME's own `ui/status/remoteAccess.js` uses.
- **Accent:** reads `org.gnome.desktop.interface accent-color` when it exists (GNOME 47+).

**Tech Stack:** GJS ESM, Gio D-Bus, Meta.RemoteAccessController, GSettings, Adw/Gtk 4.

**Spec:** Features 3, 5 and 10 from the 2026-11-08 session.
- "Public D-Bus API for live activities": any script can push into the pill (builds, tests, backups, downloads).
- "Screen-sharing dot": a red dot plus a stop action, completing the mic/camera privacy dots.
- "Follow the system accent": an Auto accent option on GNOME 47+.

## Global Constraints

- Bus name `io.github.notchnux`, object `/io/github/notchnux/Activities`, interface `io.github.notchnux.Activities`.
- Limits:
  - title ≤ 60 characters, body ≤ 120 (longer input is cut with "…")
  - icon must match `^[a-z0-9-]+$` (themed icon names only, never paths), otherwise `dialog-information-symbolic`
  - progress is `-1` for none or is clamped to `0..1`
  - timeout is 1–600 s, and 0 means 8 s
  - at most 8 live ids, and 20 calls/s per sender (extra calls fail with `io.github.notchnux.Error.RateLimited`)
- Text is shown with `St.Label`/`set_text` only, never markup.
- System accent map (libadwaita values): blue `#3584e4`, teal `#2190a4`, green `#3a944a`, yellow `#c88800`, orange `#ed5b00`, red `#e62d42`, pink `#d56199`, purple `#9141ac`, slate `#6f8396`.
- GNOME 46 has no `accent-color` key. The Auto option is hidden there, and a stored `accentMode: 'system'` falls back to the custom accent.
- New feature flags in `FEATURE_DEFS` (`src/helpers/config.js:164`):
  - `activityApi` (default `true`, label "Live activities API")
  - `showScreenShare` (default `true`, label "Screen sharing indicator")
- UI tasks are verified with `tests/headless-smoke.sh` (smoke-test plan first).

## Review Focus

- **The bus name is already owned** (two shells, or an old instance during disable/enable): `bus_own_name` loses the name, the API is silently off and one line is logged. It must never throw out of `enable()`.
- **Update or End for an unknown or expired id:** returns `false`, no error dialog, no exception in the journal.
- **The sender exits without End:** watch the sender with `Gio.bus_watch_name` and end its activities when it vanishes, so a crashed build script doesn't leave a 10-minute bar.
- **Screen sharing that starts before NotchNux is enabled:** handles created earlier never emit `new-handle`. On init, call `Main.screenshotUI.screencast_in_progress`, and accept that remote-desktop handles created before enable are missed until the next one (document it).
- **The user changes the system accent while Auto is on:** the whole UI recolors live (`changed::accent-color`), with no restart.

---

### Task 1: Activity validation core

**Files:**
- Create: `src/helpers/activities.js`
- Test: `tests/activities-check.js`

**Interfaces:**
- Produces: `normalizeActivity({title, body, icon, progress, timeout}) -> {title, body, icon, level: number|null, ms}`.
- Produces: `class ActivityTable { constructor({max = 8, perSecond = 20, now = Date.now}); show(sender, fields) -> id; update(id, fields) -> boolean; end(id) -> boolean; endSender(sender) -> string[]; get(id) }`. `show` throws `Error('RateLimited')` or `Error('TooMany')`; ids are `a1`, `a2`, …

- [ ] **Step 1: Write the failing test.** Assertions:
  - a 61-character title comes back 60 characters long, ending in `…`
  - the icon `../../etc/x` becomes `dialog-information-symbolic`
  - progress `-1` gives level `null` and `1.7` gives `1`
  - timeout `0` gives `ms` 8000 and `9999` gives 600000
  - the 21st `show` in the same mocked second throws `RateLimited`
  - the 9th live id throws `TooMany`
  - `endSender(':1.5')` returns only that sender's ids
- [ ] **Step 2: Run it.** `gjs -m tests/activities-check.js` → expect an import error.
- [ ] **Step 3: Implement** using a sliding one-second window per sender with an injectable `now`.
- [ ] **Step 4: Run it.** Expect `activities-check: N checks passed`.
- [ ] **Step 5: Commit.**
```bash
git add src/helpers/activities.js tests/activities-check.js
git commit -m "feat: validation and limits for live activities"
```

### Task 2: D-Bus service, pill wiring and CLI

**Files:**
- Create: `src/tabs/activities.js` (`installActivities(proto)`; `_initActivities()`, `_destroyActivities()`)
- Create: `src/tools/notchnux-activity` (bash: `notchnux-activity show "Build" --body "linking" --progress 0.4 --icon system-run-symbolic --timeout 60` prints the id; `update ID …`; `end ID`; implemented with `gdbus call`)
- Modify: `src/notchnux.js` (import/install next to `installDev` near line 6687; init/destroy), `src/helpers/config.js` (`activityApi` flag), `install.sh` (offer `ln -s` of the CLI into `~/.local/bin` when that dir is on `PATH`)

**Interfaces:**
- Consumes: `ActivityTable`, `normalizeActivity` (Task 1); `this._pushAlert(...)`, `this._dismissAlert()` from `ledge.js`.
- Produces: D-Bus methods
  - `Show(s title, s body, s icon, d progress, u timeout) → (s id)`
  - `Update(s id, s title, s body, d progress) → (b ok)`
  - `End(s id) → (b ok)`

  Each live activity maps to `_pushAlert({kind: 'act:' + id, icon, title, value: body, level, color: accentHex(), ms})`. End dismisses it when it is current; otherwise it is dropped from the queue (add `this._alerts.dropKind(kind)` if the queue lacks it).

- [ ] **Step 1: Implement.** Use `Gio.bus_own_name_on_connection(Gio.DBus.session, 'io.github.notchnux', …)`. Export only while `activityApi` is on, and re-own or unown on toggle.
- [ ] **Step 2: Smoke check.** Create `tests/headless/checks/activities.sh`: run `gdbus call --session --dest io.github.notchnux …Show "Build" "linking" "system-run-symbolic" 0.4 30` (the bus is the smoke shell's private bus, already exported by the script), wait 1 s, `nnx_shot pill-activity 660 0 600 80`, then `…Update a1 "Build" "done" 1` and `…End a1`.
  Run: `tests/headless-smoke.sh --tabs home --script tests/headless/checks/activities.sh`
  Expected: Show returns `('a1',)`, End returns `(true,)`, the screenshot shows the title and a 40 % bar, and `nnx_errors` is empty.
- [ ] **Step 3: Commit.**
```bash
git add src/tabs/activities.js src/tools/notchnux-activity src/notchnux.js src/helpers/config.js install.sh
git commit -m "feat: io.github.notchnux.Activities — push live activities into the pill"
```

### Task 3: Screen-share and recording indicator

**Files:**
- Create: `src/helpers/screenshare.js` (`class ScreenShareWatch { constructor(onChange); get active: boolean; get recording: boolean; stop(); destroy() }`)
- Modify: `src/notchnux.js` (a third pill icon `this._pillShare`, built next to `_pillMic`/`_pillCam`; `_updatePrivacyIndicators()` around line 2551 shows it while `active`, gated by `showPrivacy` and `showScreenShare`; clicking it opens a notification peek "Screen is being shared" with a **Stop** action calling `watch.stop()`)
- Modify: `src/helpers/config.js` (`showScreenShare` flag), `stylesheet.css` (reuse `priv-red`)

**Interfaces:**
- Consumes: `global.backend.get_remote_access_controller()` → `new-handle(handle)`, with `handle.is_recording` and `handle.connect('stopped')`. `Main.screenshotUI` → `notify::screencast-in-progress`, `stopScreencast()`. Guard every call with `typeof … === 'function'`.
- Produces: `ScreenShareWatch.active` is true while any non-recording handle is alive (sharing) or a recording handle or a screenshot-UI screencast is alive. `recording` is true for the latter two, which picks the icon (`screen-shared-symbolic` vs `media-record-symbolic`).

- [ ] **Step 1: Implement** the watch and the pill icon.
- [ ] **Step 2: Smoke check.** In `tests/headless/checks/screenshare.sh`, run with `--script`, feed a fake handle through `nnx_eval`:
```js
let n = …_notch;
let h = new (imports.gi.GObject.registerClass({Signals: {stopped: {}}}, class H extends imports.gi.GObject.Object { get is_recording() { return false; } stop() { this.emit('stopped'); } }))();
n._screenShare._onNewHandle(null, h);
[n._pillShare.visible, (h.stop(), n._pillShare.visible)]
```
  Expected: `[true, false]`, and `tests/out` gets a pill shot with the red icon.
- [ ] **Step 3: Manual check** on the real desktop: start a screencast with Ctrl+Shift+Alt+R → the red icon appears → Stop in the peek ends the recording.
- [ ] **Step 4: Commit.**
```bash
git add src/helpers/screenshare.js src/notchnux.js src/helpers/config.js stylesheet.css
git commit -m "feat: screen sharing / recording indicator in the pill with Stop"
```

### Task 4: Follow the system accent

**Files:**
- Modify: `src/helpers/config.js` (`accentMode: 'custom' | 'system'`, default `'custom'`; `setAccentMode(mode)`; `export const SYSTEM_ACCENTS = { blue: '#3584e4', … }` with the nine values above; `resolveAccent(mode, customHex, systemName) -> hex`)
- Modify: `src/notchnux.js` (where `setAccent(this._config.accentRgb)` runs at lines 88 and 446: resolve through `resolveAccent`; watch `org.gnome.desktop.interface` `changed::accent-color` only when the schema has that key, checked with `Gio.SettingsSchemaSource.get_default().lookup('org.gnome.desktop.interface', true).has_key('accent-color')`)
- Modify: `prefs.js` (accent group, line ~100: an "Accent" combo with Custom and System on 47+; the color button is insensitive while System is chosen)
- Test: `tests/config-check.js` (extend it)

**Interfaces:**
- Produces: `resolveAccent('system', '#7aa2ff', 'teal') === '#2190a4'`; `resolveAccent('system', '#7aa2ff', null) === '#7aa2ff'`; `resolveAccent('custom', '#7aa2ff', 'teal') === '#7aa2ff'`.

- [ ] **Step 1: Add the three `resolveAccent` assertions** above to `tests/config-check.js`, plus `cfg({accentMode: 'bogus'}).accentMode === 'custom'`. Run `gjs -m tests/config-check.js` → FAIL.
- [ ] **Step 2: Implement it.** Run it again → PASS.
- [ ] **Step 3: Wire up the shell and prefs.** Manual check on GNOME 51: set Auto, change the accent in Settings → Appearance, and the notch recolors within a second.
- [ ] **Step 4: Run** `tests/headless-smoke.sh` → all PASS.
- [ ] **Step 5: Update README/CHANGELOG and commit.**
```bash
git add src/helpers/config.js src/notchnux.js prefs.js tests/config-check.js README.md CHANGELOG.md
git commit -m "feat: accent can follow GNOME's system accent (GNOME 47+)"
```
