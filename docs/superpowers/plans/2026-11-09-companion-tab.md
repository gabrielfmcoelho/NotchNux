# Companion Tab: a small life to take care of (proposal)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard tab where the pill companion becomes a small pet you look after: its needs, a yard with a house, food you find and give, treasures it digs up, hats and bells you dress it in, and a diary of what it did today. The pill keeps showing its life at a glance; the tab is where you take part.

**Architecture:** the same three layers. The brain gains *needs* (energy, hunger, mood, cleanliness) as pure functions of time and events, plus an *inventory* and *finds*. The player gets the pill-side bits (the z's over its head, a hat on every frame). A new `src/tabs/companion.js` mixin (`installCompanion(proto)`, like `installDev`) renders the tab: a bigger meadow (the same frames at 64 px), the need bars, the yard and the inventory. State lives in `~/.local/share/notchnux/companion.json` (next to `tasks.json`), not in the config: it changes every minute.

**Tech Stack:** GJS ESM, St/Clutter, Cairo for the yard; the rig (`tools/rabbit-rig`) draws props and wearables as symbolic SVGs so they recolour and stack on the frames.

## Principles

- **It can't die and never nags.** Needs drift and recover; nothing bad happens if you ignore it for a week. The worst state is "a bit scruffy and sleepy", shown with a sigh, never with alerts.
- **The pill stays calm.** Everything new on the pill is tiny: z's when asleep, a hat, a hungry sigh now and then. No bars, no numbers on the pill.
- **Earn by living, not grinding.** Finds come from what you already do: a focus session finished, a Claude session closed, a day streak. No clicking for coins.
- **One file, small:** `companion.json` is a few hundred bytes; writes are atomic like `tasks.json`.

## Needs (the four bars)

| Need | Drifts | Recovers | Shows on the pill | Shows in the tab |
|---|---|---|---|---|
| **Energy** | −1 per 10 min awake; faster during lively zoomies | sleep +1/min (night, away, naps); a deep nap +8 | tired pose below 25 %; it naps on its own below 15 % | bar + "sleepy / rested / full of beans" |
| **Hunger** | +1 per 15 min | a meal −40, a snack −15, a treat −8 | below 30 % food: a soft sigh act every few minutes; at lunch it looks toward the far side of the meadow | bar + what it last ate and when |
| **Mood** | −1 per 30 min alone; −5 when a Claude wait goes unanswered > 10 min | pet +10 (max 3 pets per 10 min count), play (chase/twostep) +5, music +1/min, a finished focus +8 | ears a touch lower below 30 %; binky when it crosses 90 % | bar + a one-line thought ("wants to play", "happy you're back") |
| **Clean** | −1 per hour; −10 after digging; −5 in rain | groom +15 (it grooms by itself when below 50 %), a bath item +60 | a little dust puff on hop below 30 % | bar + brush button |

All four are computed, not ticked: `needs(state, nowMs)` from the last saved values and timestamps, so nothing runs while the tab is closed. The pill reads them on its usual updates.

## Pill additions

- **z's:** while asleep (night, away, nap:nap, nap:deep) two tiny "z" marks rise over its head, one repaint a second (joins the firefly tick, no new timer). Doze shows one.
- **Hat/accessory:** the worn item is drawn as an extra symbolic layer on every frame by the rig (`--wear hat:beanie`), so it follows the head. Items ship as frames per species; the player swaps the frame set like it swaps species.
- **Hungry sigh:** a short act (ears down, head lowers, a small breath) every 3–5 min when hunger > 70 %. Never more.
- **Looks for food:** when hungry and idle, it hops to the far side and sniffs where food appears (the "search food" of the plan is literal).

## The tab

A single column, like Focus:

1. **The yard** (full width, 96 px tall): the same meadow drawn at 2× (frames at 64 px), with a **house** at the left edge (a burrow for the rabbit, a basket for the cat, a den for the fox: the house is per species, drawn by the rig), the flower, the mushroom, and the companion living exactly as on the pill (same brain, same acts; the tab's player is a second `Companion` instance in "yard" mode: 2× size, no width changes). Clicking it pets it. When it sleeps it goes into the house (hops in; the z's rise from the roof).
2. **Needs**: four thin bars with the labels above, plus the one-line thought.
3. **Actions** (a row of `nook-mini-btn`s): **Pet**, **Feed** (opens the pantry), **Play** (throws a data bit: a chase), **Brush** (groom + clean), **Nap** (asks it to lie down; it won't if energy > 80 %).
4. **Pantry and finds**: a small grid. Food you have (carrot/fish/berries stacks, treats), items (bath, ball), wearables (hats, a bell collar, a scarf). Tap food to feed, tap a wearable to put it on or take it off.
5. **Diary**: the last 12 things it did with times ("12:31 ate a carrot", "15:02 dug up a bottle cap", "16:40 napped 25 min"), from the brain's events; the same list the pill already lives.

## Finding things ("search")

- **Digging finds:** a `dig` act has a 20 % chance to turn up a find: a treat (common), a bottle cap or a shiny pebble (keepsakes, common), a seed (plant it: a flower in the yard), rarely a wearable (a ribbon, a beanie). Finds show as a prop for a moment, then land in the pantry.
- **Earned:** a finished focus session gives a treat; a closed Claude session gives a seed; 5 days with a meal each gives a hat; a week gives the bell collar. These arrive in the diary ("found a straw hat in the burrow").
- **Food restocks:** three carrots (fish, berries) a day appear in the pantry at dawn; a treat per two focus sessions. Feeding uses them; the companion's own lunch takes one too, so the pantry is shared.

## Wearables

- **Hats:** straw hat, beanie, tiny crown (rare). **Collar:** bell (accent, jingles: a sparkle on hops). **Scarf:** for winter weeks (worn automatically below 10 °C if owned, like the earpiece for music).
- Drawn by the rig as `wear-<item>` layers positioned by each species' head/neck joints, so a hat sits right on all three. One worn hat and one worn neck item at a time.

## Storage

`~/.local/share/notchnux/companion.json`:
```json
{ "needs": { "energy": 72, "hunger": 35, "mood": 80, "clean": 60, "at": 1794240000000 },
  "pantry": { "food": 2, "treat": 1, "bath": 0 },
  "items": ["cap", "pebble", "beanie"], "worn": { "head": "beanie", "neck": null },
  "diary": [{ "t": 1794239100000, "what": "ate a carrot" }],
  "streak": { "days": 3, "lastMeal": "2026-11-09" } }
```
The existing `config.companion` keeps `species`, `lastFed`, `lastMushroom`, `pets` (they are settings and once-a-day keys, read by Preferences).

## Tasks

### Task 1: Needs in the brain
- [x] `needs(saved, nowMs)` and `applyEvent(needs, event)` as pure functions; thresholds that change acts (`restAct`: tired below 25 % energy; `ambient`: sigh when hungry, self-groom when dirty, own nap when sleepy).
- [x] Tests: drift rates, recovery, clamping 0–100, and that nothing "bad" happens past the floor.

### Task 2: Storage and diary
- [x] `helpers/companion-store.js`: load/save `companion.json` (atomic), `record(what)` keeps the last 12 diary lines, dawn restock.

### Task 3: Pill bits
- [x] z's in the grass repaint while asleep; the hungry sigh act (rig); "looks for food" sequence.
- [x] Rig: `--wear` layers; ship `wear-*` frames per species (only for items that exist).

### Task 4: The tab
- [x] `TAB_DEFS` entry `companion` ("Pet", icon `face-smile-symbolic`), off by default like Dev; `src/tabs/companion.js` with the yard (second Companion in yard mode), bars, actions, pantry, diary.
- [x] House per species (rig); sleeping goes into the house.

### Task 5: Finds and wearables
- [x] Dig finds with the 20 % table; earned finds from focus/Claude/streak; wearing and taking off; the bell sparkle.

### Task 6: Verify
- [x] Brain tests; headless: open the tab, feed, pet, brush, nap, wear a hat (frame set swaps), diary grows, pantry shrinks; the pill shows z's when asleep and the hat on every act.

## Review Focus

- **A week away:** needs floor at their minimums with no pile of diary lines or alerts; on return: one line ("missed you"), a stretch, and a hungry look.
- **Two Companion instances (pill and tab):** one brain state, one storage; acts are not duplicated (the tab's yard mirrors the pill's act, it does not start its own).
- **Feeding while a Claude session waits:** the tab lets you, the pill stays on the thump (reactions keep priority).
- **Storage write rate:** at most one save per minute from drift, plus one per user action.

## As built (2026-11-09)

- Needs, finds and wearables are pure functions in `companion-brain.js` (`progressNeeds`, `applyNeed`, `thought`, `needAct`, `digFind`, `earned`); state lives in `helpers/companion-store.js` → `~/.local/share/notchnux/companion.json` (atomic, at most one drift save a minute).
- Wearables are **not** frame sets: the rig writes each frame's hat and neck anchor (position + head angle) into `acts.json`, and the player places one `wear-<item>` icon on the sprite per frame. 6 wearables + a house per species cost 7 small SVGs each, not megabytes.
- The Pet tab (`src/tabs/companion.js`, `TAB_DEFS` id `companion`) runs a second `Companion` at 2× in *mirror* mode: the pill's instance decides and the yard replays its acts, so there is one life. Sleeping in the yard moves the animal into its house; z's rise over the head on both.
- Actions: Pet, Feed (a meal from the pantry), Treat, Play (a chase), Brush, Bath (when owned), Nap (not above 80 % energy). Pantry: 3 portions a day at dawn; treats from focus sessions and digs; seeds from closed Claude sessions, plantable into yard flowers; a straw hat at a 5-day meal streak, the bell collar at 7.
- Checked by the brain/store tests (2047 + needs + store) and 61 shell checks (tab opens, yard mirrors, feed/pet/hat/sleep-in-house, pill z's).
- **Hats as frame sets (follow-up):** the overlay hat looked pasted on, so hats are now drawn into the frames by the rig, one set per hat (`hats[name][baseFrame] = hatFrame` in acts.json, 144 frames each) with the ears reacting: through the straw hat's brim, folded down under the beanie (rabbit; cat and fox ears poke out), the crown between them. A hat's frames load when it is first put on. Neck items stay overlays at the neck anchor. `src/companions/` is ~16 MB.
- **House:** inside, the yard's animal is hidden (opacity 0) and the z's rise from the roof; it reappears on its next act or when it wakes.
