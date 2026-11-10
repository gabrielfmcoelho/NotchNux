# Companion wardrobe and houses — design

Date: 2026-11-09. Status: direction approved by the owner, reviewed once as a builder would read it, not built.

Lines marked **(call)** are choices made while writing this, not things the
owner asked for. They can be changed without changing the rest.

## Why

The companion can wear things and sleeps in a house, but both look wrong.

- **Neck items are four times too big.** Scarf, bell and ribbon are separate
  24-unit icons laid over the sprite, so a collar band is about 18 px wide on
  an animal whose neck is about 2 px. They sit on top of everything (over the
  eye and snout), and rotate rigidly about one point, so asleep they hang off
  the body. One drawing serves all three animals.
- **Hats fight the ears.** The rabbit's beanie folds the ears out sideways (a
  propeller). On the cat and fox the beanie and straw hat hide the ears, which
  are what name the animal. The straw brim is a ring with half-pixel edges; the
  crown is about 3 px wide.
- **Hats are expensive.** Each hat is a full copy of all 144 frames per
  animal: 1,296 shipped files. Loading a second frame set is also what causes
  the "collar only" flash the first time the Pet tab opens.
- **The house is a blob.** It is drawn on a 24-unit canvas and enlarged three
  times; the rabbit's burrow reads as an eye. The animal does not walk in: it
  jumps to the house's position and turns invisible. There is one fixed house
  per animal.
- **The wardrobe is a list of words.** Two slots, text chips, no picture of an
  item before wearing it, no view of what exists but is not owned.

The owner's words: the wardrobe needs to be better, "the scarf is horrible",
alternative ears or bodies per wardrobe combination are acceptable, and the
house style should be changeable.

## Goals

1. Every wearable is drawn at the animal's own scale, in the right place in
   the drawing order, per animal, and the ears react to it.
2. Any combination of one head, one neck and one back item works, without
   shipping a frame set per combination.
3. The existing six items are redrawn; a back slot and a few new items are
   added.
4. The Pet tab shows the wardrobe as pictures, including what is not owned yet
   and how to earn it.
5. The house is drawn at the animal's scale, the animal walks into it, and its
   style can be chosen in the Pet tab.

## Non-goals

- More than two tones. Frames stay GNOME symbolic icons: the body colour and
  the accent (`class="success"`).
- New animals, new acts or new poses.
- Outfits that change by themselves (a scarf when it snows). Worth doing
  later; not here.
- The other open proposals: pill signals, bond level, growing garden.
- A house on the pill. The house stays a Pet-tab-yard thing.

## Anti-goals

These make the result a failure even if everything works:

- An item that hides what names the animal (the cat's or fox's ears, the
  rabbit's long ears) or covers the eye.
- A part that disappears because it overlaps the body in the same tone.
  Anything worn must be accent-coloured or change the outline. Ears stay
  outside the outline.
- A blank or half-dressed animal while an outfit changes or the tab first
  opens.
- A number of shipped files, or of live actors, that grows with the number of
  combinations. (Texture memory growing with outfits *tried* in a session is
  accepted: see Memory under Design 2.)
- Writing anywhere outside NotchNux's own cache folder.

## What exists today (for the builder)

- `tools/rabbit-rig/rig.py` draws all three animals on one skeleton (root >
  body > {tail, hind, arm, head > ears}) and writes, per animal, 144 base
  frames, 144 frames per hat (`HATS`), `acts.json` (acts, per-frame anchors, a
  base-frame to hat-frame map), prop icons, one `prop-house` icon and six
  `wear-*` icons. Run per animal with `COMPANION=<animal>`. It needs Inkscape
  to measure each frame's lowest point so the feet sit on the ground.
- `src/helpers/companion.js` (the player) keeps every frame as an `St.Icon`
  at opacity 0 and shows one at a time. With a hat on it loads that hat's
  frame set as well and swaps to the hat frame. The neck item is one extra
  icon placed from the frame's `neck` anchor in `_placeWear`.
- `src/helpers/companion-brain.js` has `WEARABLES` (id, slot, name), `FINDS`
  and `earned()`. `src/helpers/companion-store.js` keeps `items` and
  `worn: {head, neck}` in `~/.local/share/notchnux/companion.json`.
- `src/tabs/companion.js` draws the Wardrobe card as text chips per slot.
- The Pet tab's yard is the same player at 2x, mirroring the pill's acts.
- **Base:** this builds on the working tree as of 2026-11-09, which has
  finished but uncommitted work in 11 files: the Pet tab rework (full-width
  yard, the pet leaving the pill, per-need actions) and, separately, a
  start-up guard in `src/tabs/claude.js`. Nobody else is editing it. Plan
  against that code as it is. Committing it is the owner's step, before the
  build starts **(call: two commits, the start-up guard and the Pet tab work)**.

## Design

### 1. Wearables are drawn by the rig, per animal

Each item is defined in `rig.py`, once per animal, as shapes in the
coordinates of the bone it rides:

| Slot | Rides | Drawn |
|---|---|---|
| back | body | over the body, under the arm |
| neck | body, at the neck joint | over the body and arm, under the head |
| head | head | in up to three places: behind the far ear, between skull and near ear, over the near ear |

An item also says, per animal:

- **how the ears sit under it**: an extra rotation for each ear, added to the
  pose's own;
- **a streaming variant** (optional): other shapes used in frames where the
  animal is stretched out in a leap, so a scarf end or a cape flies behind.

### 2. Outfits are composed at runtime into the cache

This is the main mechanism, and the reason combinations are free.

**The rig ships, per animal:**

- 144 **frame templates**: the frame as today, with empty slots where back,
  neck and the three head layers go, and with each ear's rotation left as
  "pose rotation plus an extra";
- per-frame data in `acts.json`: whether the frame is a streaming frame;
- one **item library**: for each item its slot, its shapes per layer (rest and
  streaming), and its ear extras;
- an **art version** number.

**The shell, when the animal or its outfit changes:**

1. Builds a key from animal, head, neck, back and art version.
2. If `<cache>/notchnux/companion/<key>/` does not exist, fills every
   template's slots from the library and writes the 144 frames there. The set
   is written to a temporary folder and renamed, so a half-written set is
   never used.
3. Loads the frames from that folder. There is one frame set per sprite,
   whatever is worn. The pill and the yard read the same folder.
4. Keeps the few most recently used outfit folders and deletes the rest
   **(call: 6)**.

The slot-filling function is pure text in, text out, so it is tested without
a shell.

**Proven on 2026-11-09 in a headless GNOME Shell 51** (throwaway patch, not in
the repo):

- The real player, pointed at 144 frames it had just written to the cache
  folder, plays them recoloured like the shipped ones. St decides "symbolic"
  from the `-symbolic.svg` file name, wherever the file is.
- Writing 144 frames took about 30 ms, synchronously.
- **A folder must never be rewritten in place.** A new icon for a path whose
  file changed got the old picture back from St's texture cache. Hence a new
  folder per key, and the art version in the key.

**Memory.** St keeps the texture of every file icon until logout, even after
the last actor showing it is destroyed (measured the same day: a new icon for
a path was handed the very same texture object after destroy, a GC and a
rewrite of the file). The "keep 6 folders" rule therefore bounds disk only.

- One outfit costs 144 frames at 32 px (pill) and 64 px (yard): about 2.9 MB
  per colour the sprite takes, at 100% scaling; about four times that at 200%.
- Wearing one outfit all session costs **less** than today: one frame set
  instead of the base set plus a hat set.
- Each further outfit tried in a session adds that much until logout. Trying
  all nine items once is about 27 MB.

**Decided by the owner: this is accepted.** The growth only happens while
someone is trying outfits, it resets at logout, and the common case gets
cheaper. Do not build around St's icon cache. The alternative that was turned
down, for the record: bake the two colours into the composed frames and load
them as plain images the player owns and can drop, recomposing whenever the
sprite's colour changes.

**Removed by this:** the three hat frame sets per animal (1,296 files), the
hat map and the anchors in `acts.json`, the six `wear-*` icons, and in the
player the hat-frame loading and `_placeWear`.

**Constraint on the art:** frames keep the ground offset measured for the bare
pose, so no item may reach below the feet.

### 3. The first wardrobe

| Slot | Item | How it should look |
|---|---|---|
| neck | Scarf | A band under the chin and an end hanging on the chest. The end streams behind in a leap. |
| neck | Bandana | A thin band and a triangle on the chest. Replaces the ribbon. |
| neck | Bell collar | A thin band and a round bell. |
| neck | Bow tie | A thin band and a bow at the throat. |
| back | Cape | From the nape over the back. Streams behind in a leap. |
| head | Beanie | A dome hugging the skull, accent cuff, pompom. The rabbit's ears rise through the top, close together. The cat's and fox's ears poke through. |
| head | Straw hat | Low crown, accent band, a solid brim at least 2 px thick at pill size. Every animal's ears rise through the crown. |
| head | Crown | At least 5 px wide at pill size, tilted, in front of the ears, which part slightly. |
| head | Party hat | A tilted cone between or in front of the ears. |

Known and accepted: the bell collar and bow tie are only a pixel or two on the
pill. They are yard pleasures. Hats, the cape and the scarf's end must read on
the pill.

What was tried and failed in a throwaway redraw, so do not repeat it: ears
folded down over the body (they vanish into it), and short ears flattened
sideways under a brim (they read as a cap's peak).

**Earning (call):**

| Item | Earned by |
|---|---|
| Straw hat, bell collar, crown | unchanged: 5-, 7- and 14-day meal streaks |
| Beanie, scarf, bandana | unchanged: rare dig finds (bandana takes the ribbon's place) |
| Bow tie | a rare dig find, like the others |
| Cape | the 10th focus session that ran to its end, not skipped or reset (a new counter in the store) |
| Party hat | 100 pets or more (the count already in the config), so an animal already past 100 gets it at its next pet |

**Saved data:** `worn` gains `back`. An owned or worn `ribbon` becomes
`bandana` when the file is read.

### 4. The wardrobe in the Pet tab

- The Wardrobe card shows a row of small pictures per slot (Head, Neck, Back)
  instead of text chips. The rig writes one small icon per item per animal
  from the same shapes.
- Owned: click to wear, click again to take off; the worn one is highlighted.
- Not owned: shown dim and not clickable, with how it is earned shown on
  hover (`_attachTrayTooltip` in `src/notchnux.js`; it is hover-only, which
  is enough).
- Changing an item swaps the whole animal at once: the new frames are loaded
  before the old ones are dropped. How to tell that a new set's textures have
  loaded is not known yet: the builder spikes it. An acceptable fallback is to
  keep the old set showing under the new one for a moment.

### 5. Houses

- **Drawn at the animal's scale**, in the same units as the frames, so the
  door is as big as the animal.
- **Two layers**, a back and a front, with the animal between them. The animal
  hops to the door and is then seen inside through the opening, instead of
  being made invisible.
- **A light in the door**, in the accent colour, while it is asleep inside.
- **Styles (call):** burrow, basket, den, hutch, tent, mushroom, cardboard
  box. Any animal can use any style; the default stays burrow for the rabbit,
  basket for the cat, den for the fox. All styles are available from the
  start: it is a taste choice, not a reward.
- **Choosing:** a House card in the Pet tab with one small picture per style,
  the current one highlighted. The choice is saved in `companion.json`. It is
  one choice, not one per animal; unset means the animal's default.
- The existing behaviours stay: the house takes the yard's left end, the
  animal goes in for the same sleeps as today (the lying sleeps, not the
  sitting doze), the z's rise from its roof, and on first arrival in the yard
  the animal comes out of it.

### 6. A contact sheet as the acceptance tool

The rig gains a command that renders every item on every animal, sitting,
mid-leap and asleep, at three sizes (large, yard size, pill size), composed
the same way the shell composes it, plus every house style with the animal
beside it. The art is accepted by the owner looking at that sheet, not by a
test.

## Checks

- **Self-checks (plain `gjs`, in `tests/companion-check.js`):** slot filling
  gives well-formed output for a bare outfit and a full one; the outfit key
  changes with each of animal, head, neck, back and art version; the `ribbon`
  to `bandana` migration; `worn.back`; the two new earning rules.
- **Rig check:** every item has shapes for every animal, and every template
  has every slot.
- **In a running shell:** changing outfit shows no blank frame; the first open
  of the Pet tab shows the dressed animal from its first frame; the animal
  walks into the house.
- **By eye, on the contact sheet:** the anti-goals above.

## Left to the builder

- Exact shapes and coordinates per item and animal, within the look described.
- The template slot syntax and the file names.
- Whether the frames are written synchronously (about 30 ms measured) or not.
- How a hat sits with the music earpiece, which is already part of the
  `@music` frames. Both may be on at once.
- The layout of the picture rows and the House card.
- How the door light is drawn (a third layer or a second front icon).
