# Rabbit Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Inova Data rabbit in the pill becomes a companion: a small character that lives on a strip of grass at the pill's left edge, has its own quiet life when nothing happens, and reacts to what you are doing (Claude Code, focus timer, music, notifications, battery, being away).

**Architecture:** Three layers, each testable on its own.
1. **Art (offline):** a rig script splits the `coelho` lockup into its five parts (long ear, short ear, head with eye node, front body/leg, back leg node), poses them with per-part transforms, and writes one symbolic SVG per frame to `src/rabbit/`. A contact sheet and a GIF per scene are produced for review before any shell code changes.
2. **Behaviour (pure, no Shell imports):** `src/helpers/companion-brain.js` turns events and time into the next *act* (`sit`, `blink`, `nibble`, `hop`, `run`, `thump`, `binky`, `sleep`, …). Testable with plain `gjs -m`.
3. **Player (Shell):** `src/helpers/companion.js` plays an act: steps sprite frames at 12 fps (pose changes) while Clutter tweens position at full frame rate (smooth arcs). A `St.DrawingArea` draws the grass as dots, matching the wallpaper and boot screen.

**Tech Stack:** GJS ESM, St/Clutter, Cairo (grass), Python + Inkscape (rig, frames, previews).

**Spec:** the 2026-11-09 session. The wallpaper (`~/Projetos/tools/inovadata-desktop/wallpaper.py`) and the boot theme set the style: dots in waves, grey with a faint violet cast, the rabbit drawn by the dots.

## Global Constraints

- **Bursts, never loops.** Each act lasts at most 1.2 s, then the stage is static. The only longer motion is `run` while Claude works, at most 0.6 s of motion every 3 s. No motion while the pill is unmapped, the dashboard is open, a fullscreen app is focused, or `enable_animations` is off. The codebase already avoids endless pulses (see `_syncPillClaude` in `src/tabs/claude.js`).
- **Fixed footprint:** the zone is 30 × 22 px (rabbit 18 px plus grass), so the pill never changes width because of the companion.
- **Recolourable:** frames are `*-symbolic.svg`, so mood colours come from CSS. No PNG frames.
- **Brand:** the rabbit-only lockup is not in the official identity files (see the comment on `coelho` in `inovadata-lib-ui/src/marca.tsx`), and the simplified small version below is a new drawing. Both need sign-off from whoever owns the brand before this ships beyond this machine.
- **Off switch:** a `rabbitCompanion` feature in `FEATURE_DEFS` (default on), plus a `Calm` option that keeps reactions and drops the ambient acts.

## Character: what the companion does

| When | Act | Reads as |
|---|---|---|
| Nothing happening | every 20–60 s, one of: blink (eye node dims), ear flick, nibble grass, look left/right, groom | alive, not demanding |
| Claude session working | `run`: hops in place while the grass scrolls under it (accent colour) | busy, on it with you |
| Claude waiting on you | `thump`: stands tall, ears up, thumps a back foot (orange), repeats every 3 s | rabbits thump to warn: "needs you" |
| Claude session finished | one `binky` (twisting happy jump), green, then sits | done, pleased |
| Focus timer running | `sit` facing forward, ears still; only blinks | concentrating with you |
| Focus break starts | stretch, then `flop` (lies on its side) | relax |
| Music playing | head bob on every 4th beat of the pill EQ, only while it plays | listening along |
| Notification arrives | ears turn up, quick look up toward the banner | heard it |
| You're away (idle 10 min, Mutter idle monitor) or after 23:00 | `sleep`: curled, eye closed, 3 "z" dots drift once | resting |
| You come back / first unlock of the day | wake: stretch and yawn | hello |
| Battery under 15 % (not charging) | lies flat, slow blink | tired |
| Charger plugged in | nibbles a carrot (two accent dots) once | fed |
| Pointer hovers the pill | turns its head toward the pointer | notices you |

Priority when several apply: waiting > finished > working > focus > notification > battery > music > ambient > sleep. Sleep yields to anything except ambient.

## Animation quality

- **A small-size drawing.** At 18 px the full lockup turns to mush (thin legs, tiny node dots). Draw a simplified silhouette for the pill: thicker legs, a bigger eye node, gaps at least 1.5 px, edges snapped to the pixel grid at 1× and 2×. Keep the full lockup for sizes above 32 px.
- **Twelve principles, scaled down:** anticipation (crouch before every hop), squash and stretch (body 0.85 to 1.15 on the y axis on take-off and landing, volume kept), arcs (position tween with ease-out up, ease-in down), follow-through (ears lag the head by one frame), secondary motion (grass blades bend away when it lands, 2–3 dust dots).
- **Timing:** poses step at 12 fps (gives a hand-drawn look and keeps the frame count small), position moves at the display rate. A hop is 0.45 s: 2 crouch frames, 3 air frames, 2 landing frames.
- **Frame budget:** about 40 symbolic SVGs, each under 4 KB. St caches the rasterised icons, so stepping frames costs a texture swap, not a re-render.

## Tasks

### Task 1: Rig and art (review gate)

- [x] Split the `coelho` path into its five sub-paths (`M`…`Z`), name them, and find each part's pivot (ear base, neck, hips).
- [x] Draw the small-size silhouette in the same rig format.
- [x] Write `tools/rabbit-rig/rig.py`: pose table → `src/rabbit/<act>-<n>-symbolic.svg`.
- [x] Render `tools/rabbit-rig/out/sheet.png` (every frame at 18 px, 1× and 2×) and one GIF per act on a pill-coloured background.
- [x] **Stop for review:** the user approves the drawing and motion from the sheet and GIFs before Task 2.

### Task 2: Behaviour module

- [x] `src/helpers/companion-brain.js`: `nextAct(state, event, now, rand)` and the priority rules above. No Shell imports.
- [x] `tests/companion-check.js`: priorities, ambient interval bounds, sleep/wake, calm mode, and that no act lasts longer than 1.2 s.

### Task 3: Player and grass

- [x] Rewrite `src/helpers/companion.js` as a `St.Widget` holding the sprite (`St.Icon`) and the grass (`St.DrawingArea`). `play(act)` steps frames on one `GLib.timeout_add`, tweens translation, and calls `queue_repaint()` on the grass only during an act.
- [x] Keep the existing guards: no motion when unmapped or with animations off. Add the fullscreen check the pill already uses.

### Task 4: Wire the events

- [x] Claude: already in `_syncPillClaude`; send `working`, `waiting` and `finished` (a session moving to `fresh`).
- [x] Focus timer and breaks (`src/tabs/productivity.js`), music play/pause and EQ beat (`_pillEq`), notification peek (`_showNotificationPeek`), battery and charger (UPower in `notchnux.js`), idle monitor (`global.backend.get_core_idle_monitor()`), pointer hover on `this._pill`.

### Task 5: Preferences

- [x] `rabbitCompanion` and `rabbitCalm` in `FEATURE_DEFS` (`src/helpers/config.js`); toggling either applies live, like `pillMarquee`.

### Task 6: Verify

- [x] `gjs -m tests/companion-check.js` and the other `tests/*-check.js`.
- [x] Headless shell (as in the 2026-11-09 session: private bus via `dbus-broker-launch` user units, `gnome-shell --headless --virtual-monitor`, `Eval` in unsafe mode): trigger each act through `Eval`, screenshot the pill mid-act, and confirm the zone width never changes.

## Review Focus

- **Many events at once** (Claude finishes while a notification lands during music): one act plays, picked by priority, and the next starts only after it ends. Acts never stack.
- **Dashboard opened mid-hop:** the act is cut, the sprite resets to `sit` with no leftover translation, and the timer is removed.
- **Extension disabled mid-act:** every timeout and tween is gone (the existing `destroy` handler covers the timer; tweens die with the actor).
- **Long idle:** sleeping is static, with zero timers firing more often than once a minute.

## As built (2026-11-09)

- **Music:** ear flicks and looks every 8–14 s while a track plays, instead of a head bob on the EQ beat (the pill EQ bars are random, there is no beat to follow).
- **Pointer hover:** dropped. Hovering the pill opens the dashboard, which unmaps the rabbit, so a look toward the pointer would never be seen.
- **Hidden reactions:** a reaction that happens while the pill is hidden (notification banner, dashboard) is kept and played when the pill comes back; only the strongest one is kept.
- **Frames:** every frame is a child icon kept mapped at opacity 0. Swapping a single icon's `gicon`, or showing a hidden icon, loads the texture asynchronously and played blank or stale frames on the first run of an act.
- **Charger:** the carrot is the `nibble` act; no carrot drawing yet.
- **Idle life (follow-up):** the first build looked static (one tiny act every 20–60 s). Now it breathes (one frame swap every 0.8 s, 1.3 s asleep), makes an idle move every 3–8 s (blink, ear flick, look, nibble, sniff, groom, turn, wander), and wanders across a 60 px meadow, facing where it hops and travelling only while airborne. Flopped, tired, hidden or switched off still runs no timers. Checked by `tests/headless/checks/companion.sh`.
- **Body parts (follow-up):** the rig adds parts the logo doesn't have, drawn in its flat style: a long hind foot and a front leg with paw (outside the body's squash, so they stay planted while it crouches and breathes; they trail and tuck in the air, the hind foot stomps on the thump, the front paw reaches the face when grooming), a cotton tail that twitches, and headphones while music plays (`<act>@music` frames, the symbolic `success` class, tinted with the accent). With music the rabbit mostly bobs its head and taps a foot. 89 frames, 29 acts.
- **New rabbit (follow-up):** the logo's abstract parts (a mid-leap mark) fought natural poses, so the companion is now an original side-view rabbit drawn from simple shapes in `tools/rabbit-rig/rig.py`: pear body, round haunch with a long hind foot, front leg with paw, head with snout and a cut-out eye, near and far ears, cotton tail. Bones: root > body > {tail, hind @hip, arm @shoulder, head @neck > ears}; limbs can fold (foreshorten); every frame is grounded on the grass. `--try` renders a model sheet of any poses. 93 frames, 29 acts.
