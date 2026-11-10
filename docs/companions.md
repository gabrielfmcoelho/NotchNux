# Adding a companion

The pill companion (rabbit, cat, fox) is drawn by an offline Python rig and
played by the shell from generated symbolic SVGs. A new animal is one species
entry in the rig, a few registry lines in the extension, and a look at the
contact sheets. All acts (hops, naps, meals, music, reactions), the wardrobe
and the houses are shared; you only draw the animal.

## What you need

- Python 3 with PyGObject `Rsvg` 2.0 and `cairo` (for the contact sheets)
- Inkscape (the rig measures each frame to sit its feet on the ground)
- ImageMagick `magick` (only for the `--try` model sheet)
- `gjs` (self-checks) and, for the in-shell checks, `tests/headless-smoke.sh`

## 1. Draw the animal — `tools/rabbit-rig/rig.py`

Add an entry to `SPECIES` with `species(...)`. Every animal shares one
skeleton (root > body > {tail, hind @hip, arm @shoulder, head @neck > ears}),
so the poses and acts work unchanged.

Units and frame:

- Side view, **facing right**, sitting. Ground at **y = 100**. The frame box
  is `-20 -31 135 135`; at pill size (32 px icon) **1 px ≈ 4.2 units**.
- `skull=(cx, cy, rx, ry)` — the head ellipse. Wearables sit on it, and hats
  keep their lower edge above the eye.
- `eye=(x, y)` — the open eye's centre (cut out of the head).
- `ears=(far, near)`, `body`, `hind`, `arm`, `tail`, optional `snout` — path
  strings from the helpers (`ellipse`, `leaf`, `tri_ear`, `rbar`,
  `thick_curve`, `poly`). Separate several snout shapes with `" | "`.
- `nodes` — accent dots (about 2 px) on the tip of the animal's longest
  feature (ear tips, tail tip).
- `phones=headphones(cx, cy, r, PHONES_STYLE)` — the music earpiece, on the
  skull.
- `joints` — pivots for `root`, `hip`, `shoulder`, `neck`, `ear_far`,
  `ear_near`, `tail`. Put each where that part meets the body; the poses
  rotate about them.

Drawing rules (they are what makes the animals read at 22 px):

- Two tones only: the body grey (`fill(d)`) and the accent
  (`fill(d, "success")`). The shell recolours both.
- Head about 60 % of the visual mass, body 40 %; circles and triangles,
  short limbs. Exaggerate the one or two traits that name the animal, so the
  silhouette alone says what it is.
- Main features at least 2 px at pill size (about 8.4 units); no 1 px
  strokes.
- Nothing below y = 100 in the sitting pose.

Iterate with the model sheet (renders poses big and at 32 px):

```bash
COMPANION=<name> python3 -I tools/rabbit-rig/rig.py --try /tmp/try.png '[{}, {"eye": "closed"}]'
```

Also in `rig.py`:

- **Food** — add `FOOD["<name>"]` with `whole`, `half` and `stub` shapes in
  a 24 × 24 box (the meal is eaten in those three bites).
- **Long ears** — `GEO["long_ears"]` is true only for the rabbit today
  (`SPECIES_NAME == "rabbit"`). If your animal's ears are long enough to
  rise through a hat's crown, include it there; otherwise hats part short
  ears to the sides.

## 2. Generate the art

```bash
COMPANION=<name> python3 -I tools/rabbit-rig/rig.py src/companions/<name> src/companions/<name>/acts.json
```

This writes the frames (with the wardrobe's empty slots), `acts.json`,
`wear.json` (the wardrobe drawn for this animal), the item pictures, food and
props into `src/companions/<name>/`. It takes a few minutes (one Inkscape
call per unique frame).

## 3. Register it

| File | What to add |
|---|---|
| `src/helpers/companion-brain.js` | the id in `SPECIES`; its default house in `HOUSE_DEFAULT` (one of `HOUSE_STYLES`) |
| `src/helpers/config.js` | `[id, 'Label']` in `COMPANION_SPECIES` (the Preferences picker) |
| `tools/rabbit-rig/sheet.py` | the id in the two `animals = (...)` tuples |
| `tests/companion-check.js` | the new entry in the `HOUSE_DEFAULT` expectation |

The self-checks loop over `SPECIES`, so they cover the new animal's acts,
frames, wardrobe and item pictures without further edits.

## 4. Check it

```bash
gjs -m tests/companion-check.js
python3 tools/rabbit-rig/sheet.py /tmp/wardrobe.png
python3 tools/rabbit-rig/sheet.py /tmp/houses.png --houses
tests/headless-smoke.sh --tabs companion --script tests/headless/checks/companion.sh
```

Look at both sheets at pill size, not only large:

- **Wardrobe** — every item sits right on the new animal, sitting, leaping,
  asleep and with the earpiece. No hat covers the eye or hides what names the
  animal; ears stay outside the outline (they vanish if they fold over the
  body). Items are drawn from the animal's geometry, so most fit as they are.
  If one needs a per-animal tweak, branch on `g["species"]` in
  `tools/rabbit-rig/wear.py`, then raise `ART_VERSION` there so outfits
  composed from the old drawing are not reused.
- **Houses** — the lying animal must be fully inside every doorway (the
  houses share one door position, `door` in `src/companions/houses/houses.json`).
  If it pokes out, widen the doorways in `tools/rabbit-rig/houses.py` and
  regenerate them with `python3 -I tools/rabbit-rig/houses.py src/companions/houses`.

Then switch to the animal in Preferences → Companion and watch it on the
pill and in the Pet tab.
