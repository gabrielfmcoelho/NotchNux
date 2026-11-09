# Companions v2: tech look, three species, eating, roaming room

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The pill companion gets a tech look, a choice of three animals, and room to live in: it wears headphones and dances to music, eats, and roams. The pill grows to give it space while it does, and shrinks back when you are busy.

**Architecture:** unchanged layers. `tools/rabbit-rig/rig.py` draws every species on one skeleton (root > body > {tail, hind @hip, arm @shoulder, head @neck > ears}), so all 29 acts are shared and only the shapes differ (`COMPANION=cat python3 -I rig.py …`). `companion-brain.js` stays pure and gains the roam/eat rules. `companion.js` plays frames, moves in a meadow whose width now changes, and draws the food.

**Spec:** the 2026-11-09 session: "make the rabbit a little more tech, make variations of 2 other companions, plan with ear piece (music), eating, wandering, give the pill space to wander in these cases."

## Look (approved 2026-11-09: button eye + clip earpiece)

- **Drawn from researched rules:** main features at least 2 px (GNOME symbolic icons), no 1 px strokes; head about 60 % of the visual mass, circles and triangles, short limbs; the one or two traits that name the animal are exaggerated so the silhouette alone reads. Model sheet: `COMPANION=cat python3 -I tools/rabbit-rig/rig.py --try out.png '<poses>'`.
- **Eye:** one big round dark eye with a small highlight ("button"); closed is a happy arc.
- **Tech cue:** the logo's line-ending-in-a-node, carried by the body: accent LEDs set inside the rabbit's ear tips, at the cat's and fox's tail tips. No traces on the body (sub-pixel at this size).
- **Earpiece:** "clip": a solid accent muff on the side of the head with a short thick clip up the near ear, no headband. Worn while music plays.
- **Rabbit:** long rounded ears, round haunch, long hind foot, cotton tail. **Cat:** upright, triangle ears, curling tail. **Fox:** low body, pointed snout, tall ears, bushy tail.
- **Choice:** Preferences → Companion: Rabbit (default), Cat, Fox. Frames per species under `src/companions/<species>/`; only the chosen one is loaded; switching applies live.

## Grass and world

The meadow is drawn by `St.DrawingArea` (Cairo), so it can change without new frames.

- **Grass:** the wavy dot row stays (it is the wallpaper's style) and gains short blades: 1 px wide, 2–3 px tall, every 4–6 px, in the dot colour at 60 %. Blades lean away from a landing and spring back over two repaints; a blade the companion stands on is hidden.
- **Wind:** when the weather says wind over 20 km/h, blades hold a lean in one direction and the ears drift the same way between acts.
- **Rain / snow** (weather code groups 51–67 / 80–82, 71–77 / 85–86): a few accent-grey drops or flakes fall across the zone at most once a second while the pill is idle; the companion sits under a leaf (a single big blade, drawn once) and shivers (a 1 px x-jitter, two frames). Nothing falls while Claude works or waits.
- **Day and night from the weather helper's sunrise/sunset** (today's), not a fixed 23:00: after sunset the dots dim to 70 % and two accent "firefly" dots drift slowly; the companion sleeps once you are away *or* it is past sunset + 2 h.
- **Food:** per species, as symbolic frames: carrot, fish, berries. Whole, half, stub. Drawn on the grass as a child actor.
- **Props on the grass, rare, one at a time:** a mushroom (first idle after 16:00), a data bit (accent dot that skips; the companion chases it), a flower that opens over three repaints after a finished focus session and stays until the next one.

## Life: habits and actions

Priority stays: Claude waiting > finished > working > focus > notification > battery > music > ambient > sleep. Rows marked *daily* fire once a day and are remembered in the config (`companion.lastFed`, `companion.lastMushroom`), so a shell restart does not repeat them.

| Trigger (from the notch) | Act | Notes |
|---|---|---|
| First unlock / first input of the day | wake: stretch, yawn, shake (ears flap), look around | *daily* |
| Lunch window 12:00–13:30, first idle moment | eat | *daily*; food drops at the far side, it hops over, three bites, groom |
| Charger plugged in | eat (small portion: two bites) | |
| Focus session running | sits still, blinks every 15–30 s; a flower bud appears on the grass | companionship, no distraction |
| Focus session finished | binky, the flower opens | |
| Break starts | stretch then flop | |
| Music playing | earpiece on; bob, foot tap; every 4th bob a two-step (hop left, hop right); on track change: perk | |
| Notification arrives | perk toward the banner side | |
| 5+ unread notifications | sits facing the bell with ears up until you open Alerts | a quiet nudge |
| Calendar event in 5 min (the pill already shows a heads-up) | stands tall (STAND) for one cycle | |
| Battery < 15 %, not charging | tired, slow blink; < 5 %: lies flat | |
| Away 10 min, or past sunset + 2 h | sleep (slow breathing, "z" dots) | |
| Rain / snow | under the leaf, shiver | see Grass and world |
| Idle, daytime | breathe; every 3–8 s one of: blink, ear flick, sniff, look, nibble, groom, turn, wander, dig (front paws scrabble, two dust dots), chase the data bit, sit up and sniff the air | the two new acts need 6 and 4 frames |
| Pointer rests on the pill > 1 s (dashboard does not open on hover-only in some configs) | looks toward the pointer | only if hover does not open the dashboard |
| Companion switched in Preferences | the old one hops off the right edge, the new one hops in from the left | |

**Memory (small, in the config):** last fed, last mushroom, times petted (a click on the companion = pet: it closes its eyes and leans into the pointer; the dashboard still opens on a second click). Nothing else is stored.

## Pill space

- **Compact 60 px / wide 120 px** as before. Wide while: music, eating, chasing, idle daytime. Compact while: Claude working or waiting, focus running, Calm mode, sleep, rain shelter, another live activity needing the width.
- 30 s hold before narrowing; the companion hops back inside first.

## Tasks

### Task 1: Look and species (review gate)
- [x] Finalise the three species in the rig; render a sheet of every act per species; user approves.
- [x] `rig.py` writes `src/companions/<species>/` (frames + `acts.json`); remove `src/rabbit/`.

### Task 2: Behaviour module
- [x] `companion-brain.js`: `meadow(state)` → `'compact' | 'wide'`; `eatTrigger(prev, next, now)` (charger, lunch window once a day, focus finished); `dance` and `chase` in the idle/music act lists.
- [x] Tests: width rules (every row of the table), lunch window once per day, no eating while Claude waits or focus runs.

### Task 3: Food and the data bit
- [x] Rig: food frames per species (whole, two bites left, one bite left) and the data bit, as symbolic SVGs.
- [x] Player: a food actor on the grass; `eat` = turn, wander to the food, three `nibble` cycles swapping the food frame, `groom`.

### Task 4: Roaming room
- [x] Player: meadow width follows `meadow(state)` with the 30 s hold; hop back inside before shrinking.
- [x] Notch: the rabbit zone's width enters `_pillWidth()` as it does today; call `_applyPillWidth()` when it changes.

### Task 5: Grass and world
- [x] Blades, lean-on-landing, wind; day/night from sunrise/sunset; rain/snow drops and the leaf shelter; props (mushroom, data bit, flower) as symbolic frames + a prop actor.
- [x] Rate limits: nothing repaints more than once a second while idle; nothing at all while Claude works or waits or the pill is hidden.

### Task 6: Life
- [x] New acts in the rig: yawn, shake, dig, sit-up sniff, pet; the two-step from hop frames.
- [x] Triggers wired: first unlock (idle monitor + day key), lunch window, unread count (the Alerts badge), calendar heads-up (`_checkEventHeadsUp`), track change (MPRIS), weather (`_onWeatherUpdated`), click on the companion.
- [x] Config memory: `companion.lastFed`, `companion.lastMushroom`, `companion.pets`.
- [x] Tests: every row of the Life table as a brain-level check; daily rows fire once per day key.

### Task 7: Preferences
- [x] `companionSpecies` (rabbit, cat, fox) in the config, a row in Preferences, live switch (rebuild the frame icons).

### Task 8: Verify
- [x] `gjs -m tests/companion-check.js`, all suites.
- [x] `tests/headless/checks/companion.sh`: each species loads; music → wide pill and headphones; charger → food appears and is eaten; Claude waiting → compact; the pill width only changes on mode change.

## Review Focus

- **Music starts during a Claude session:** stays compact (Claude wins), headphones still on.
- **Pill hidden mid-meal:** the meal is cut, the food removed, no timers left.
- **Switching species mid-act:** the act is cut, frames rebuilt, rest pose of the new species.
- **Width flapping:** music toggled every few seconds never makes the pill pulse.

## As built (2026-11-09)

- Frames ship per species under `src/companions/<species>/` (136 frames + 10 props/food each, ~1.1 MB per animal); only the chosen one is loaded. `src/rabbit/` is gone.
- Composite acts (`wander`, `turn`, `twostep`, `chase`, `eat`, `snack`, the species switch) are sequences of frame acts built by the player; each step can travel and run a callback (show a prop, remember a day key).
- Night comes from the weather helper's sunrise/sunset when it has them (new raw fields `code`, `windKmh`, `sunriseMs`, `sunsetMs`), else from the hour.
- Memory lives in the config under `companion` (`species`, `lastFed`, `lastMushroom`, `pets`); Preferences gets a Companion group with the animal picker and the two switches (moved out of Features).
- Pointer hover was dropped (hovering opens the dashboard); petting is a click on the companion, a second click within 1.5 s opens the dashboard as before.
- Checked by `tests/companion-check.js` (1168 checks) and `tests/headless/checks/companion.sh` (36 checks in a real shell).
- **Lively mode (follow-up):** a third Companion switch, on by default. With it the idle life also draws from the day's habits every 2–5 s: naps (a short sleep with fireflies, 8–15 s, wakes with a stretch, cut short by anything that needs it), snacks and full meals (the once-a-day lunch memory is untouched), chases, roaming and two-steps. Off, the idle life is the quieter 3–8 s set and the habits happen only at their times. Calm wins over lively.
