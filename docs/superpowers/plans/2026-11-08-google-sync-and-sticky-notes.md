# Google Tasks & Calendar Sync and Sticky Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- The Tasks tab can use a Google Tasks list (create, read, update, delete).
- The Calendar tab can create, edit and delete events.
- Notes become several colored post-its that can also be pinned to the desktop.

**Architecture:**
- **No Google OAuth client of our own.** Google access goes through Evolution Data Server (EDS), using the Google account the user adds in Settings → Online Accounts (GOA). EDS already ships the `gtasks` backend (`libecalbackendgtasks.so` is installed here) and the CalDAV backend for Google Calendar.
- **EDS calls run in a long-lived helper process** (`src/tools/eds-worker.js`, `gjs -m`, JSON lines over stdin/stdout). The same pattern as `src/tools/image-worker.js`, and for the same reason GNOME Shell keeps its own calendar server out of process: EDS calls can block.
- **The shell talks to the helper through `src/helpers/eds.js`.**
- **Reading events stays on `org.gnome.Shell.CalendarServer`** (`src/notchnux.js` around line 4459); only writes go through the helper.
- **Notes move from one `notes.md` string to a `notes.json` list** in `ProductivityStore`.

**Tech Stack:** GJS ESM, ECal 2.0 / EDataServer 1.2 / ICalGLib 3.0 (GObject introspection), Gio.Subprocess, St/Clutter.

**Spec:** From the 2026-11-08 session: "tasks optional integration with google tasks (CRUD) and calendar (CRUD) and notes could be optional integrated with google notes and could create several post-its of notes".

## Global Constraints

- **Everything Google is optional and off by default.** Feature flags: `googleTasks` ("Google Tasks in the Tasks tab") and `calendarEdit` ("Create and edit calendar events"), both default `false`. Without them, behavior is exactly today's.
- **Runtime deps when enabled:**
  - Ubuntu/Debian: `gir1.2-ecal-2.0 gir1.2-edataserver-1.2`
  - Fedora: `evolution-data-server` (ships the typelibs)
  - A Google account in Online Accounts with Calendar turned on

  When either is missing, Preferences shows the exact install command or "Add Google in Settings → Online Accounts" and the tab stays on Local.
- **Google Keep is out of scope.** Its API is only available to Google Workspace (business) accounts, not personal ones. Post-its are local only. Say so in the README.
- **Stars on Google tasks are local only.** Google Tasks has no priority field, so stars are kept in `~/.local/share/notchnux/gtask-stars.json` (a uid list).
- **Recurring events:** "Edit" changes this occurrence only (`E_CAL_OBJ_MOD_THIS`). "Delete" asks "This event" or "All events" (`MOD_THIS` / `MOD_ALL`).
- **Time:**
  - New events use the local zone (`GLib.TimeZone.new_local().get_identifier()`).
  - All-day events are DATE values with an exclusive end (next day).
  - Default duration is 30 min.
- **Note colors:** yellow `#ffd60a`, green `#30d158`, blue `#64d2ff`, pink `#ff6482`, purple `#bf5af2`. At most 50 notes, each at most 64 KiB (existing `MAX_NOTES`).
- **Every helper call has a 15 s timeout.** Writes are optimistic: on failure the UI rolls back, shows an island alert "Couldn't save to Google — <reason>", and puts typed text back into the entry.
- **The `metadata.json` description must mention** the EDS/Online Accounts access (extensions.gnome.org review requires listing data access).
- **UI tasks are verified with `tests/headless-smoke.sh`** (smoke-test plan first). Google behavior is verified manually against a real account (the smoke shell has no GOA).

## Review Focus

- **Network down or token expired while adding a task:** the task flashes in, rolls back, the alert names the reason, and the typed text is back in the entry. Nothing is lost silently.
- **Read-only calendars** (Birthdays, holidays, shared read-only): never offered in the "Calendar" picker; their events show no Edit/Delete.
- **Upgrading with an existing `notes.md`:**
  - It becomes exactly one note on the first run and is not duplicated on later runs.
  - `notes.md` stays as `notes.md.bak`.
  - A corrupt `notes.json` is moved to `notes.json.bak` and an empty list starts, the same as `tasks.json` today.
- **A pinned desktop note dragged off-screen, or its monitor unplugged:** on the next layout it is clamped back inside the primary monitor's work area.
- **Worker crash mid-session:** the next call restarts it (at most 3 restarts per minute, then the source shows "Google sync stopped — reopen the tab to retry").

---

### Task 1: Spike — confirm EDS + GOA give Google Tasks and writable Google calendars (go/no-go)

**Files:**
- Create: `src/tools/eds-probe.js` (throwaway; deleted in Task 2)

- [ ] **Step 1: Set up the environment.** Install the deps with `sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2`. The user adds a Google account in Settings → Online Accounts with Calendar on.
- [ ] **Step 2: Write `eds-probe.js`.** It uses `EDataServer.SourceRegistry.new_sync`, lists sources with `EDataServer.SOURCE_EXTENSION_TASK_LIST` and `SOURCE_EXTENSION_CALENDAR`, and prints display name, backend name, parent account and `get_writable()`. Then, on the first `gtasks` list, it creates `NotchNux probe`, reads it back, marks it done and deletes it, printing each step.
- [ ] **Step 3: Run it.**
  Run: `gjs -m src/tools/eds-probe.js`
  Expected: at least one task list with backend `gtasks` and one writable calendar with backend `caldav`, and the four CRUD steps all print `ok`.
- [ ] **Step 4: Decide.**
  - If there is no `gtasks` list, Google Tasks is not reachable through GOA on this distro. Stop Tasks 3–4 and tell the user; the Calendar and notes tasks still go ahead.
  - If the CRUD steps pass, note the exact property names that worked in this plan's Task 2 Interfaces block and continue.

### Task 2: EDS worker and shell client (sources + tasks)

**Files:**
- Create: `src/tools/eds-worker.js`, `src/helpers/eds.js`
- Delete: `src/tools/eds-probe.js`
- Test: `tests/eds-check.js` (needs the deps). It creates a temporary local task list through `SourceRegistry` (backend `local`, display name `nnx-test-<pid>`), runs every op against it, and removes the source at the end, so it never touches the user's lists. It prints `SKIP: ECal not installed` and exits 0 when the typelibs are missing.

**Interfaces:**
- **Wire format:** request `{"id":n,"op":"…","args":{…}}`, response `{"id":n,"ok":true,"result":…}` or `{"id":n,"ok":false,"error":"…"}`. One JSON object per line.
- **Produces** these ops (the worker is a single process, used by the next tasks):
  - `hello` → `{ecal: true}`
  - `sources` → `{tasks: Source[], calendars: Source[]}` where `Source = {uid, name, account, backend, writable, color}`
  - `tasks.list {source}` → `Task[]` where `Task = {uid, summary, done, due: 'YYYY-MM-DD'|null, notes, updated: ms}`
  - `tasks.create {source, summary, due?}` → `{uid}`
  - `tasks.update {source, uid, patch: {summary?, done?, due?, notes?}}` → `{}`
  - `tasks.delete {source, uid}` → `{}`
  - `refresh {source}` → `{}`
- **Produces:** `class EdsClient { static async probe() -> {available: boolean, reason?: string}; call(op, args) -> Promise<any>; destroy() }` in `src/helpers/eds.js`. It spawns the worker lazily, uses a 15 s timeout per call, and applies the restart policy from Review Focus.

- [ ] **Step 1: Write `tests/eds-check.js`** with assertions: `create` returns a uid; `list` contains it with `done: false`; after `update {done: true}` `list` shows `done: true`; after `delete` the uid is absent; an unknown op returns `ok: false`.
- [ ] **Step 2: Run** `gjs -m tests/eds-check.js` → expect FAIL (worker missing).
- [ ] **Step 3: Implement the worker and client.** Use `ECal.Client.connect_sync(source, ECal.ClientSourceType.TASKS, 30, null)`, `get_object_list_as_comps_sync('#t')`, `create_object_sync`, `modify_object_sync(comp, ECal.ObjModType.THIS, ECal.OperationFlags.NONE)`, `remove_object_sync`. Done ↔ `STATUS:COMPLETED` + `COMPLETED` time; not done ↔ `NEEDS-ACTION` and no `COMPLETED`.
- [ ] **Step 4: Run** `gjs -m tests/eds-check.js` → expect `eds-check: N checks passed`.
- [ ] **Step 5: Commit.**
```bash
git add src/tools/eds-worker.js src/helpers/eds.js tests/eds-check.js
git commit -m "feat: EDS helper process for task lists (Google Tasks via Online Accounts)"
```

### Task 3: Task sources and Google mode in the Tasks tab

**Files:**
- Create: `src/helpers/tasksources.js`
- Modify:
  - `src/helpers/config.js` (`googleTasks` flag; `tasksSource: 'local' | <source uid>`, default `'local'`)
  - `src/tabs/productivity.js` (Tasks tab and Home tasks card read from `this._taskSource` instead of `this._store` directly; a source dropdown in the Tasks header when `googleTasks` is on; a refresh button)
  - `prefs.js` (Google group: status line from `EdsClient.probe()`, the switch, and the list picker)
- Test: `tests/tasksources-check.js` (a fake `EdsClient` with a canned `call`)

**Interfaces:**
- Consumes: `EdsClient` (Task 2); `ProductivityStore` task methods (`addTask`, `toggleTask`, `toggleStar`, `renameTask`, `removeTask`, `clearDone`, `openTasks`, `doneTasks`).
- Produces: a common interface implemented by `LocalTaskSource(store)` and `EdsTaskSource(client, sourceUid, starsPath)`:
  - `get open(): Task[]`, `get done(): Task[]`, using the existing local task shape `{id, text, done, starred, created, doneAt}`; for EDS, `id` = uid and `text` = summary
  - `add(text)`, `toggle(id)`, `star(id)`, `rename(id, text)`, `remove(id)`, `clearDone()`
  - `refresh()`, `subscribe(cb) -> unsubscribe`, `get error(): string | null`

  `EdsTaskSource` updates the in-memory list first, calls the worker, and on rejection restores the previous list, sets `error`, and notifies. Stars persist in `gtask-stars.json`. A leading `!` in `add()` stars the new task (same as local).

- [ ] **Step 1: Write the failing test.** With a fake client whose `tasks.create` rejects `'offline'`: after `add('x')` the list contains `x`; after the promise settles the list is back to empty and `error === 'offline'`. With a fake that resolves: `star(uid)` survives `refresh()` (read back from the stars file in a temp dir).
- [ ] **Step 2: Run** `gjs -m tests/tasksources-check.js` → FAIL.
- [ ] **Step 3: Implement** `tasksources.js`, then switch the Tasks and Home renderers to `this._taskSource` (picked from config on init and on config change; auto-refresh every 5 min only while the Tasks tab is visible).
- [ ] **Step 4: Run** `gjs -m tests/tasksources-check.js` → PASS. Run `tests/headless-smoke.sh` → all PASS (Local mode unchanged).
- [ ] **Step 5: Manual check** against a real Google account:
  1. Add a task in the notch → it appears at tasks.google.com.
  2. Tick it on the web → it shows done in the notch after a refresh.
  3. Delete it in the notch → it is gone on the web.
  4. Unplug the network and add one → rollback and the alert.
- [ ] **Step 6: Commit.**
```bash
git add src/helpers/tasksources.js src/helpers/config.js src/tabs/productivity.js prefs.js tests/tasksources-check.js
git commit -m "feat: optional Google Tasks list as the Tasks tab source"
```

### Task 4: Calendar event create, edit and delete

**Files:**
- Modify:
  - `src/tools/eds-worker.js` (event ops)
  - `src/helpers/eds.js` (no change beyond typing)
  - `src/notchnux.js` (Calendar tab, `_renderCalendarTab` around line 4340: "+" button on the day strip; tapping an event opens a detail sheet with Edit/Delete for writable sources; an editor form with title, date, start, end, all-day toggle, calendar picker of writable calendars and location)
  - `src/helpers/config.js` (`calendarEdit` flag)
- Test: extend `tests/eds-check.js` with a temporary local calendar

**Interfaces:**
- Produces worker ops:
  - `events.create {source, summary, start: ISO, end: ISO, allDay, location?}` → `{uid}`
  - `events.update {source, uid, rid?, patch}` → `{}`
  - `events.delete {source, uid, rid?, all: boolean}` → `{}`
- Consumes: the CalendarServer event id. Confirm its format in Step 1 by logging an id from `EventsAddedOrUpdated`; the expected format is `"<source uid>\n<uid>\n<rid>"`. Map it with a helper `splitEventId(id) -> {source, uid, rid}` in `src/helpers/eds.js`, and cover the helper in `tests/eds-check.js`.

- [ ] **Step 1: Log a real CalendarServer id** from the running shell (journal) and write the `splitEventId` assertions to match it.
- [ ] **Step 2: Add the event tests:**
  - create a 30-min event today 15:00 local; list it and see it
  - update its summary
  - create an all-day event and check the end is the next day (DATE)
  - delete one occurrence of a daily recurring event with `all: false` and check the others remain
  - delete with `all: true` and check none remain

  Run `gjs -m tests/eds-check.js` → FAIL.
- [ ] **Step 3: Implement** the event ops (`ECal.ClientSourceType.EVENTS`; `ECal.ObjModType.THIS` / `ALL`), then run the test → PASS.
- [ ] **Step 4: Build the Calendar tab UI** (only when `calendarEdit` is on). Read-only sources get no buttons. After a successful write, rely on CalendarServer's `EventsAddedOrUpdated` to redraw. Never insert the event locally.
- [ ] **Step 5: Run** `tests/headless-smoke.sh` → PASS (flag off). Manual check against Google: create, edit time, delete; repeat on a recurring event (this vs all).
- [ ] **Step 6: Commit.**
```bash
git add src/tools/eds-worker.js src/helpers/eds.js src/notchnux.js src/helpers/config.js tests/eds-check.js
git commit -m "feat: create, edit and delete calendar events from the notch"
```

### Task 5: Notes as a list of post-its (store + migration)

**Files:**
- Modify: `src/helpers/productivity.js` (constructor takes `{dataDir = DATA_DIR}` so tests can use a temp dir; notes become a list)
- Test: `tests/notes-check.js`

**Interfaces:**
- Produces: on `ProductivityStore`:
  - `get notes(): Note[]` (most recently updated first) and `getNote(id)`, where `Note = {id, text, color: 'yellow'|'green'|'blue'|'pink'|'purple', created, updated, pinned: boolean, pos: {x, y} | null}`
  - `addNote(text = '', color = 'yellow') -> id` (throws `Error('TooManyNotes')` at 50)
  - `updateNote(id, text)`, `setNoteColor(id, color)`, `removeNote(id) -> Note` (returned so Undo can call `restoreNote(note)`), `pinNote(id, on)`, `moveNote(id, x, y)`
  - The `'notes'` change event fires on each change.
- Removes: `setNotes(text)` and the string `notes` getter. Callers: the Notes tab and the command bar (`n …` → `addNote(text)`).

- [ ] **Step 1: Write the failing test** in a temp dir:
  - a `notes.md` containing `hello` loads as one note `hello`, and `notes.md.bak` exists
  - a second store on the same dir still has exactly one note
  - a corrupt `notes.json` gives an empty list plus `notes.json.bak`
  - `addNote` 50 times then once more throws `TooManyNotes`
  - `removeNote` then `restoreNote` gives back the same id and text
  - an unknown color in `setNoteColor` is ignored
- [ ] **Step 2: Run** `gjs -m tests/notes-check.js` → FAIL.
- [ ] **Step 3: Implement.** Saves stay debounced (`_scheduleSave('notes', 600)`) and atomic with `0600` permissions as today.
- [ ] **Step 4: Run** `gjs -m tests/notes-check.js` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add src/helpers/productivity.js tests/notes-check.js
git commit -m "feat: notes become a list of colored post-its (migrates notes.md)"
```

### Task 6: Notes tab as a post-it board

**Files:**
- Modify: `src/tabs/productivity.js` (`_renderNotesTab`, line ~759), `stylesheet.css` (`.nook-postit`, `.nook-postit-<color>`, `.nook-postit-add`)

**Interfaces:**
- Consumes: the Task 5 store API.
- Produces: a 2-column grid of post-it cards (first 4 lines of text, colored background, relative "edited 5 min ago") and a "+" card. Clicking a card opens it full-size in the tab with a multi-line `St.Entry`, color dots, a "Pin to desktop" toggle and Delete (with an "Undo" island alert for 5 s). Esc or the back arrow returns to the board.

- [ ] **Step 1: Implement the board and editor.**
- [ ] **Step 2: Smoke check.** Create `tests/headless/notes-fixture.json` with three notes of different colors.
  Run: `tests/headless-smoke.sh --tabs notes --data tests/headless/notes-fixture.json:notchnux/notes.json`
  Expected: PASS, and `tests/out/tab-notes.png` shows three colored cards and a "+" card.
- [ ] **Step 3: Commit.**
```bash
git add src/tabs/productivity.js stylesheet.css tests/headless/notes-fixture.json
git commit -m "feat: Notes tab shows a board of post-its"
```

### Task 7: Pin post-its to the desktop

**Files:**
- Create: `src/helpers/desknotes.js` (`class DeskNotes { constructor(store, {onOpen}); sync(); destroy() }`)
- Modify: `src/notchnux.js` (create on init, destroy on disable; `onOpen(id)` expands the notch on the Notes tab with that note open)

**Interfaces:**
- Consumes: `store.notes` (only those with `pinned`), `store.moveNote(id, x, y)`, `store.subscribe`.
- Produces: one `St.Widget` per pinned note, 180×180, inserted directly above `Main.layoutManager._backgroundGroup` in its parent. It sits on the wallpaper, under windows, the same layer `wptransition.js` uses. It is dragged with plain `button-press`/`motion`/`button-release` handlers, not `Clutter.DragAction`, so it behaves the same on 46–51. The position is saved on release and clamped to the work area of the monitor under the pointer. Double-click calls `onOpen(id)`. No text editing on the desktop itself, so no keyboard grab is needed there.

- [ ] **Step 1: Implement**, including the clamp on `monitors-changed`.
- [ ] **Step 2: Smoke check.** In `tests/headless/checks/desknotes.sh`:
  1. Pin the first fixture note (`${NNX}._store.pinNote(id, true)`).
  2. Take a full-screen `nnx_shot`.
  3. Call `moveNote(id, -500, -500)`, then `${NNX}._deskNotes.sync()`.
  4. `nnx_check` that the widget's position is inside `[0, 0, 1920, 1080]`.

  Run: `tests/headless-smoke.sh --tabs notes --data tests/headless/notes-fixture.json:notchnux/notes.json --script tests/headless/checks/desknotes.sh`
  Expected: PASS, and the full-screen shot shows the post-it on the wallpaper.
- [ ] **Step 3: Manual check** on the real desktop: pin, drag, log out and in → same place; open a maximized window → the note is hidden under it.
- [ ] **Step 4: Update docs.** README (features table: Tasks/Calendar Google options, post-its; requirements: EDS typelibs; note that Keep isn't supported and why), CHANGELOG, and the `metadata.json` description (EDS/Online Accounts access). Commit.
```bash
git add src/helpers/desknotes.js src/notchnux.js README.md CHANGELOG.md metadata.json
git commit -m "feat: pin post-it notes to the desktop"
```
