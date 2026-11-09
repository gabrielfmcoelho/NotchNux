# Headless Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command boots a hidden GNOME Shell with the working-tree extension, opens every tab, screenshots each, and exits non-zero on any NotchNux JS error.

**Architecture:** A bash driver starts a private session bus (runtime-only systemd user units running `dbus-broker-launch` with a config that has no service directories), launches `gnome-shell --headless` with an isolated XDG profile and the keyfile GSettings backend, and drives it over `org.gnome.Shell.Eval`, which a tiny test-only helper extension unlocks by setting `global.context.unsafe_mode`. Everything it creates is removed by a `trap`.

**Tech Stack:** bash, systemd user units, dbus-broker, gdbus, gnome-shell `--headless --virtual-monitor`.

**Spec:** Feature 11 ("headless smoke test") from the 2026-11-08 session, plus the manual procedure used there to verify GNOME 51 support.

## Global Constraints

- Must never touch the user's real session: no `pkill -f` patterns, no writes to `~/.config`, `~/.local/share` or real dconf; kill only the PID the script started.
- The bus socket path must stay short (the AF_UNIX limit is 108 bytes): use `$XDG_RUNTIME_DIR/nnx-smoke-$$`, never the scratch dir.
- Reuse the real GStreamer registry (`GST_REGISTRY=$HOME/.cache/gstreamer-1.0/registry.$(uname -m).bin`). A fresh registry scan inside the shell blocks it for minutes; this is what froze the Studio tab during the 51 testing.
- Runs on GNOME 46–51 hosts (the `--headless`, `--virtual-monitor` and Screenshot D-Bus APIs exist on all of them).

## Review Focus

- **Shell never becomes ready** (missing GPU, or a broken extension that hangs enable): the script must give up after 180 s with a clear message and still clean up.
- **Interrupted with Ctrl+C mid-run:** the trap must stop the units and kill the shell. A rerun must not fail on "unit already exists".
- **A tab hangs the shell** (an Eval call times out): report that tab as FAIL, skip the remaining tabs, still exit non-zero and clean up.
- **The extension failed to load** (state ≠ 1 or a non-empty `error`): fail before the tab loop, printing the error string.
- **Two runs at once:** names carry `$$`, so they must not collide.

---

### Task 1: Driver script with isolated shell, readiness and cleanup

**Files:**
- Create: `tests/headless-smoke.sh`, `tests/headless/lib.sh`
- Create: `tests/headless/session.conf` (copy of `/usr/share/dbus-1/session.conf` with `<standard_session_servicedirs/>` removed and the `<include>` lines dropped)
- Create: `tests/headless/unsafe@notchnux-test/metadata.json` (`shell-version` 46–51)
- Create: `tests/headless/unsafe@notchnux-test/extension.js` (`enable() { global.context.unsafe_mode = true; }`)
- Create: `tests/headless/config.json` (`{"blur":{"enabled":true},"wallpaper":{"folder":"/usr/share/backgrounds"}}`)
- Modify: `.gitignore` (add `tests/out/`)

**Interfaces:**
- Produces: `tests/headless-smoke.sh [--src DIR] [--tabs id,id] [--script FILE] [--data SRC:REL] [--keep] [--out DIR]`.
  - `--src` defaults to the repo root and `--out` to `tests/out`.
  - `--script FILE` is sourced after the tab checks, with the helpers below in scope. Feature plans put their checks in `tests/headless/checks/<feature>.sh`.
  - `--data SRC:REL` copies a file into the isolated `~/.local/share/<REL>` before the shell starts (repeatable), e.g. `--data notes.json:notchnux/notes.json`.
  - Exit 0 means pass, 1 means a check failed, 2 means the environment is unusable (no gnome-shell, no dbus-broker-launch).
- Produces: in `tests/headless/lib.sh`:
  - `nnx_eval <js>` prints the result and returns 1 on `(false, …)` or timeout
  - `nnx_check <name> <js> <expected>` prints PASS/FAIL and records failures for the exit code
  - `nnx_shot <name> [x y w h]`
  - `nnx_errors` lists NotchNux-related `JS ERROR`/`CRITICAL` lines since the last mark
  - `NNX` is the JS expression for the notch object: `Main.extensionManager.lookup('notchnux@adityasah.programs').stateObj._notch`

- [ ] **Step 1: Write the driver.** Profile in `mktemp -d /tmp/nnx.XXXX` with `data/gnome-shell/extensions/<uuid>` symlinked to `--src`, plus the helper extension. Keyfile at `config/glib-2.0/settings/keyfile` enabling both. Units in `$XDG_RUNTIME_DIR/systemd/user/nnx-smoke-$$.{socket,service}`, where the service runs `dbus-broker-launch --scope user --config-file tests/headless/session.conf`. Shell started with `&`, PID saved. Readiness polls `nnx_eval 'global.context.unsafe_mode'` until `'true'`, for at most 180 s. `trap cleanup EXIT INT TERM`.
- [ ] **Step 2: Add the checks.**
  1. `GetExtensionInfo` returns state 1 and an empty error.
  2. `expand()` succeeds.
  3. For each id in `_tabOrder` (or `--tabs`): `_switchTab(id)` returns `_activeTab === id` within 20 s, then `nnx_shot tab-<id>`.
  4. `nnx_errors` is empty.

  Print one line per check: `PASS`/`FAIL name detail`.
- [ ] **Step 3: Run it against the tree.**
  Run: `tests/headless-smoke.sh`
  Expected: every line `PASS`, exit 0, `tests/out/tab-*.png` present, and afterwards `systemctl --user list-units 'nnx-smoke-*'` is empty.
- [ ] **Step 4: Prove it catches breakage.** Copy the repo to a temp dir, add `throw new Error('smoke')` at the top of `src/helpers/compat.js`.
  Run: `tests/headless-smoke.sh --src /tmp/nnx-broken`
  Expected: `FAIL extension-state … smoke`, exit 1, cleanup done.
- [ ] **Step 5: Prove Ctrl+C cleanup.** Start a run, press Ctrl+C during the readiness wait.
  Expected: no leftover `nnx-smoke-*` units, socket or shell PID.
- [ ] **Step 6: Document and commit.** Add a "Testing" section to `README.md` (what it needs: GPU render node, dbus-broker; how long: about 1–2 min).
```bash
git add tests/headless-smoke.sh tests/headless .gitignore README.md
git commit -m "test: headless GNOME Shell smoke test for every tab"
```
