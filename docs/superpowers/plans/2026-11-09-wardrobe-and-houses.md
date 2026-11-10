# Companion Wardrobe and Houses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wearables drawn at the animal's scale that combine freely (head, neck, back), a wardrobe shown as pictures, and houses the animal walks into whose style can be chosen.

**Architecture:** The rig (`tools/rabbit-rig`) stops baking a frame set per hat. It writes each frame once with empty slots, plus a per-animal item library (`wear.json`). A new pure module fills the slots for the current outfit and writes the 144 frames to a per-outfit folder under the user's cache; the player loads its one frame set from there. Houses become two layers plus a door light, drawn in the frames' units, shared by all animals.

**Tech Stack:** Python 3 + Inkscape (rig, offline), PyGObject Rsvg + cairo (contact sheet), GJS ESM with GLib/Gio (compose module), St/Clutter (player, tab), the project's `gjs -m tests/*-check.js` self-checks and `tests/headless-smoke.sh`.

**Spec:** `docs/superpowers/specs/2026-11-09-wardrobe-and-houses-design.md`

## Global Constraints

- **Precondition:** `git status -sb` is clean on `dev`. The owner commits the pending Pet tab work, the start-up guard in `src/tabs/claude.js`, the spec and this plan before Task 1.
- Two tones only: every shape is `fill="#bebebe"` or `class="success" fill="#73d216"`.
- No item reaches below the feet (y ≤ 100 in frame units, rest pose).
- At pill size 1 px ≈ 4.2 units. The straw brim is at least 2 px thick; the crown at least 5 px wide.
- Ears stay outside the outline. No item covers the eye or hides the cat's or fox's ears or the rabbit's long ears.
- One frame set per sprite, whatever is worn. Shipped files and live actors do not grow with combinations.
- Cache writes only under `GLib.get_user_cache_dir()/notchnux/companion/`. An existing outfit folder is never rewritten. At most 6 outfit folders are kept.
- `src/helpers/companion-outfit.js` and `src/helpers/companion-brain.js` import nothing from the Shell, so `gjs -m tests/companion-check.js` runs them.
- Runs on GNOME Shell 46 to 51.
- Before every commit: run the task's checks and read the output. Never pipe a test command into a commit. Commit subjects follow the repo: `Companion: …`.
- Regenerating art: `for sp in rabbit cat fox; do COMPANION=$sp python3 -I tools/rabbit-rig/rig.py src/companions/$sp src/companions/$sp/acts.json; done` (needs Inkscape).
- Headless run: `tests/headless-smoke.sh --tabs companion --script tests/headless/checks/companion.sh`. It passes 61 checks on the base.

## Review Focus

1. **The cache folder cannot be written** (read-only home, full disk). Expected: the animal shows undressed from the shipped frames, one warning, no crash. Test in Task 3.
2. **A save file from before**: `ribbon` owned or worn, no `back` slot, an item id the library no longer has. Expected: `ribbon` becomes `bandana`, unknown ids draw nothing. Tests in Tasks 1 and 3.
3. **A half-written outfit folder** left by a crash. Expected: ignored and removed, the outfit is composed again. Test in Task 3.
4. **Two outfit changes in quick succession.** Expected: ends on the last one, no leftover icons, no blank frame. Check in Task 4.
5. **Changing the animal while dressed.** Expected: the new animal wears the same items in its own drawing. Check in Task 4.

---

### Task 1: Slots, items, earning and the house choice (brain and store)

**Files:**
- Modify: `src/helpers/companion-brain.js` (`FINDS`, `WEARABLES`, `earned`)
- Modify: `src/helpers/companion-store.js` (`cleanState`, new methods)
- Modify: `src/tabs/companion.js` (`SLOTS` rows, the `pet` event), `src/tabs/productivity.js` (`_onFocusPhaseDone`)
- Test: `tests/companion-check.js`

**Interfaces:**
- Produces (brain):
  - `SLOTS = ['head', 'neck', 'back']`
  - `WEARABLES[id] = { slot, name, how }` for `straw, beanie, crown, party, scarf, bandana, bell, bow, cape`. `how` strings: `Keep a 5-day meal streak` (straw), `Keep a 7-day meal streak` (bell), `Keep a 14-day meal streak` (crown), `Turns up when digging` (beanie, scarf, bandana, bow), `Finish 10 focus sessions` (cape), `Pet it 100 times` (party). Names: `a party hat`, `a bandana`, `a bow tie`, `a cape`; the others unchanged.
  - `FINDS`: `ribbon` removed; `bandana` and `bow` added as `{ kind: 'wear', slot: 'neck', name, weight: 1 }`.
  - `earned('focuscount', n)` → `'cape'` when `n >= 10`; `earned('pets', n)` → `'party'` when `n >= 100`; existing rules unchanged.
  - `HOUSE_STYLES = ['burrow', 'basket', 'den', 'hutch', 'tent', 'mushroom', 'box']`, `HOUSE_DEFAULT = { rabbit: 'burrow', cat: 'basket', fox: 'den' }`, `cleanHouse(v)` → `v` if listed, else `null`.
- Produces (store):
  - `state.worn = { head, neck, back }`, `state.focusDone` (integer ≥ 0), `state.house` (a style or `null`).
  - `earnOnce(id, line)` → `true` and a diary line the first time, `false` if already owned.
  - `focusDone()` → counts one completed focus session; earns the cape (`earned a cape for 10 focus sessions`).
  - `petted(count)` → earns the party hat (`earned a party hat for 100 pets`).
  - `setHouse(style)` → `true` and saved for a listed style or `null`; `false` otherwise.
  - Reading a save: `ribbon` in `items` or `worn.neck` becomes `bandana`.

- [ ] **Step 1: Write the failing tests** in the needs block and the store block of `tests/companion-check.js`. Replace the two existing lines that name `ribbon` (the dig distribution and the "is wearable" loop) with `bandana`.

```js
// brain
eq(SLOTS, ['head', 'neck', 'back'], 'three slots');
eq(Object.keys(WEARABLES).sort(), ['bandana', 'beanie', 'bell', 'bow', 'cape', 'crown', 'party', 'scarf', 'straw'], 'the wardrobe');
ok(Object.values(WEARABLES).every(w => SLOTS.includes(w.slot) && w.name && w.how), 'every item: slot, name, how it is earned');
eq([WEARABLES.cape.slot, WEARABLES.party.slot, WEARABLES.bow.slot, WEARABLES.bandana.slot], ['back', 'head', 'neck', 'neck'], 'new items sit in their slots');
ok(!FINDS.ribbon && FINDS.bandana.slot === 'neck' && FINDS.bow.slot === 'neck', 'the bandana took the ribbon\'s place; the bow tie is a find');
eq([earned('focuscount', 9), earned('focuscount', 10), earned('focuscount', 11)], [null, 'cape', 'cape'], 'the cape at ten focus sessions');
eq([earned('pets', 99), earned('pets', 100), earned('pets', 250)], [null, 'party', 'party'], 'the party hat at 100 pets or more');
eq([cleanHouse('tent'), cleanHouse('castle'), cleanHouse(null)], ['tent', null, null], 'house styles');
eq(HOUSE_DEFAULT, { rabbit: 'burrow', cat: 'basket', fox: 'den' }, 'default houses');

// store: a save file from before
let odir = GLib.Dir.make_tmp('nnx-old-XXXXXX');
GLib.file_set_contents(`${odir}/companion.json`, JSON.stringify({ items: ['ribbon', 'straw', 'pebble'], worn: { head: 'straw', neck: 'ribbon' } }));
let old = new CompanionStore({ dataDir: odir, now });
eq([old.state.items, old.state.worn, old.state.focusDone, old.state.house], [['bandana', 'straw', 'pebble'], { head: 'straw', neck: 'bandana', back: null }, 0, null], 'an old save is brought forward');
for (let i = 0; i < 9; i++) old.focusDone();
ok(!old.state.items.includes('cape'), 'nine sessions: no cape yet');
old.focusDone();
ok(old.state.items.includes('cape') && old.state.diary.at(-1).what === 'earned a cape for 10 focus sessions', 'the tenth earns the cape');
ok(!old.earnOnce('cape', 'again') && old.earnOnce('party', 'first'), 'earnOnce: only the first time');
let lines = old.state.diary.length; old.petted(100);
eq(old.state.diary.length, lines, 'already owned: no second line');
ok(old.wear('cape') && old.state.worn.back === 'cape', 'the back slot');
ok(old.setHouse('tent') && old.state.house === 'tent' && !old.setHouse('castle') && old.setHouse(null) && old.state.house === null, 'the house choice');
```

- [ ] **Step 2: Run** `gjs -m tests/companion-check.js`. Expected: FAIL on `three slots` (`SLOTS` is not exported).
- [ ] **Step 3: Implement** the brain and store interfaces above. `cleanState` validates `worn` per slot against `WEARABLES[id].slot` as it does today, for all three slots.
- [ ] **Step 4: Wire the events.** In `src/tabs/companion.js`: the `pet` case also calls `st.petted(this._config.companion.pets)`; the Wardrobe rows gain `['back', 'Back']`. In `src/tabs/productivity.js` `_onFocusPhaseDone(kind)`: when `kind === 'focus-done'`, call `this._petStore?.focusDone()` (the helper emits it only when a session ran out, never on skip or reset).
- [ ] **Step 5: Run** `gjs -m tests/companion-check.js`. Expected: exit 0, three `ok` lines.
- [ ] **Step 6: Commit** `Companion: a back slot, new items and how they are earned, a house choice`.

---

### Task 2: The rig writes frames with slots, an item library and a contact sheet (scarf only)

**Files:**
- Create: `tools/rabbit-rig/wear.py`, `tools/rabbit-rig/sheet.py`
- Modify: `tools/rabbit-rig/rig.py` (`species()`, `svg_body`, the `__main__` block)
- Regenerate: `src/companions/{rabbit,cat,fox}/` (frames, `acts.json`, new `wear.json`)
- Test: `tests/companion-check.js` (the shipped-frames block)

**Interfaces:**
- Produces (files, per animal):
  - Every base frame keeps its name and gains, exactly once each, the comments `<!--back-->` (after the body, before the arm), `<!--neck-->` (after the arm, before the head), `<!--head0-->` (first thing in the head group, before the far ear), `<!--head1-->` (after the skull and earpiece, before the near ear), `<!--head2-->` (last thing in the head group).
  - Each ear's shapes are wrapped innermost in `<g data-ear="far" transform="rotate(0 JX JY)">` or `data-ear="near"`, with the ear joint's coordinates.
  - `acts.json` gains `"stream": [frame names]`: the frames whose root `sx` is above 1.08.
  - `wear.json`: `{ "version": 1, "items": { "<id>": { "slot", "rest": { "<layer>": "<svg text>" }, "stream": { … }, "ears": [far, near] } } }`. `stream` and `ears` are optional. Layers are `back`, `neck`, `head0`, `head1`, `head2`.
- Produces (Python):
  - `rig.SPECIES[name]["SKULL"] = (cx, cy, rx, ry)` and `rig.GEO` for the current animal: `{ "species", "neck": (x, y), "skull": (cx, cy, rx, ry), "long_ears": bool }`.
  - `wear.ART_VERSION = 1`; `wear.ITEMS: dict[str, Callable[[dict], dict]]`, each returning `{ "slot", "rest": {layer: [svg strings]}, "stream"?: {…}, "ears"?: (far, near) }`.
  - `sheet.compose(template: str, layers: dict, ears: tuple) -> str` (the same rule as Task 3's `composeFrame`) and the command `python3 tools/rabbit-rig/sheet.py <out.png> [--items a,b,…]`: for each animal, each item on the sitting, mid-leap and sleeping frames at 4x, then at yard size (64 px) and pill size (32 px), read from `src/companions`.
- The hat frame sets, `hats`, `anchors` and the `wear-*` icons keep being written in this task; Task 4 removes them.

- [ ] **Step 1: Write the failing test** in the shipped-frames block, inside its `for (let sp of SPECIES)` loop (`dir`, `spec` and `bases`, the set of all base frame names, are that block's variables; keep `bases` when Task 4 removes the hat checks around it):

```js
const SLOT_NAMES = ['back', 'neck', 'head0', 'head1', 'head2'];
let lib = JSON.parse(new TextDecoder().decode(dir.get_child('wear.json').load_contents(null)[1]));
ok(Number.isInteger(lib.version) && lib.version >= 1, `${sp}: the library has a version`);
for (let f of bases) {
    let text = new TextDecoder().decode(dir.get_child(f).load_contents(null)[1]);
    for (let s of SLOT_NAMES)
        ok(text.split(`<!--${s}-->`).length === 2, `${sp}: ${f} has the ${s} slot once`);
    ok(/data-ear="far" transform="rotate\(0 [\d.]+ [\d.]+\)"/.test(text) && /data-ear="near" transform="rotate\(0 [\d.]+ [\d.]+\)"/.test(text), `${sp}: ${f} has both ear wrappers`);
}
ok(Array.isArray(spec.stream) && spec.stream.length > 0 && spec.stream.every(f => bases.has(f)), `${sp}: streaming frames are real frames`);
for (let [id, it] of Object.entries(lib.items)) {
    ok(['head', 'neck', 'back'].includes(it.slot) && Object.keys(it.rest).length > 0, `${sp}: ${id} has a slot and shapes`);
    for (let k of [...Object.keys(it.rest), ...Object.keys(it.stream ?? {})])
        ok(SLOT_NAMES.includes(k), `${sp}: ${id} draws into a known layer (${k})`);
}
ok(lib.items.scarf?.slot === 'neck' && lib.items.scarf.stream?.neck, `${sp}: the scarf, with a streaming end`);
```

- [ ] **Step 2: Run** `gjs -m tests/companion-check.js`. Expected: FAIL (`wear.json` does not exist).
- [ ] **Step 3: Implement the rig changes** and `wear.py` with one item, the scarf. Starting shapes, relative to the neck joint `(nx, ny)`, all accent: band `rbar(nx-9, ny-1, nx+7, ny+8, 4.8)`; hanging end `rbar(nx+5, ny+8, nx+2.5, ny+21, 4.0)`; streaming end `thick_curve((nx-7, ny), (nx-22, ny-9), (nx-36, ny-3), 9, 6.5)`.
- [ ] **Step 4: Regenerate** the three animals (command in Global Constraints) and run the test. Expected: exit 0.
- [ ] **Step 5: Check nothing moved.** `git diff --stat src/companions` shows the base frames, `acts.json` and the new `wear.json` only; one base frame's diff shows added comments and ear wrappers and no changed path data.
- [ ] **Step 6: Implement `sheet.py`** and run `python3 tools/rabbit-rig/sheet.py /tmp/sheet.png --items scarf`. Expected: a PNG where the scarf sits under each animal's chin and streams behind in the leap row.
- [ ] **Step 7: Commit** `Companion rig: frames with slots, an item library, a contact sheet`.

---

### Task 3: Compose an outfit into the cache

**Files:**
- Create: `src/helpers/companion-outfit.js`
- Test: `tests/companion-check.js` (a new block)

**Interfaces:**
- Consumes: the frame, `acts.json` and `wear.json` formats from Task 2.
- Produces:
  - `CACHE_ROOT`: `<user cache dir>/notchnux/companion`; `OUTFIT_KEEP = 6`.
  - `outfitKey(species, worn, version)` → `'<species>-<head|none>-<neck|none>-<back|none>-v<version>'`, or `null` when nothing is worn.
  - `outfitLayers(lib, worn, streaming)` → `{ layers: { back, neck, head0, head1, head2 }, ears: [far, near] }`. Strings; an empty layer is `''`. An item without a streaming variant uses its rest shapes. Ids the library lacks, or in the wrong slot, add nothing. `ears` come from the head item, else `[0, 0]`.
  - `composeFrame(template, layers, ears)` → the frame text: each slot comment replaced by its layer, each ear wrapper's `rotate(0 ` replaced by `rotate(<extra> `.
  - `ensureOutfit({ srcDir, cacheRoot, species, worn, spec, lib, keep = OUTFIT_KEEP })` → the folder to load frames from (a path string). Returns `srcDir` when nothing is worn, when `lib` is missing, or when anything fails (one `console.warn`). Otherwise `<cacheRoot>/<key>`: used as is if it exists (its modification time is touched), else composed into `<key>.tmp` and renamed. Removes leftover `*.tmp` folders and all but the `keep` most recently used outfit folders, never the one returned.

- [ ] **Step 1: Write the failing tests:**

```js
const { outfitKey, outfitLayers, composeFrame, ensureOutfit, OUTFIT_KEEP } = await import('../src/helpers/companion-outfit.js');
const T = '<svg><g>B<!--back-->A<!--neck--><g><!--head0--><g data-ear="far" transform="rotate(0 58 46)">F</g>S<!--head1--><g data-ear="near" transform="rotate(0 66 45)">N</g><!--head2--></g></g></svg>';
const LIB = { version: 3, items: {
    scarf: { slot: 'neck', rest: { neck: '<path id="r"/>' }, stream: { neck: '<path id="s"/>' } },
    beanie: { slot: 'head', rest: { head1: '<path id="d"/>', head2: '<path id="c"/>' }, ears: [-12, 8] } } };
eq(outfitKey('cat', { head: 'beanie', neck: null, back: 'cape' }, 3), 'cat-beanie-none-cape-v3', 'the key names animal, slots and art version');
eq(outfitKey('cat', { head: null, neck: null, back: null }, 3), null, 'nothing worn: no key');
let o = outfitLayers(LIB, { head: 'beanie', neck: 'scarf', back: 'ghost' }, false);
eq(o, { layers: { back: '', neck: '<path id="r"/>', head0: '', head1: '<path id="d"/>', head2: '<path id="c"/>' }, ears: [-12, 8] }, 'layers; an unknown item draws nothing');
eq(outfitLayers(LIB, { neck: 'scarf' }, true).layers.neck, '<path id="s"/>', 'a streaming frame takes the streaming shapes');
eq(outfitLayers(LIB, { head: 'beanie' }, true).layers.head1, '<path id="d"/>', 'no streaming variant: the rest shapes');
eq(outfitLayers(LIB, { head: 'scarf' }, false).layers.neck, '', 'an item in the wrong slot draws nothing');
let out = composeFrame(T, o.layers, o.ears);
ok(out.includes('rotate(-12 58 46)') && out.includes('rotate(8 66 45)') && out.includes('A<path id="r"/>') && !out.includes('<!--'), 'slots filled, ears turned');
eq(composeFrame(T, outfitLayers(LIB, {}, false).layers, [0, 0]), T.replace(/<!--\w+-->/g, ''), 'bare: only the slot comments go');

let src = GLib.Dir.make_tmp('nnx-src-XXXXXX'), cache = `${GLib.Dir.make_tmp('nnx-cache-XXXXXX')}/companion`;
let spec = { acts: { sit: { frames: ['a-symbolic.svg', 'b-symbolic.svg', 'a-symbolic.svg'] } }, stream: ['b-symbolic.svg'] };
for (let f of ['a-symbolic.svg', 'b-symbolic.svg']) GLib.file_set_contents(`${src}/${f}`, T);
let read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
let args = { srcDir: src, cacheRoot: cache, species: 'cat', worn: { neck: 'scarf' }, spec, lib: LIB };
let d = ensureOutfit(args);
eq(d, `${cache}/cat-none-scarf-none-v3`, 'composed into its own folder');
ok(read(`${d}/a-symbolic.svg`).includes('id="r"') && read(`${d}/b-symbolic.svg`).includes('id="s"'), 'rest and streaming frames');
eq(ensureOutfit({ ...args, worn: {} }), src, 'nothing worn: the shipped frames');
eq(ensureOutfit({ ...args, lib: null }), src, 'no library: the shipped frames');
GLib.file_set_contents(`${src}/a-symbolic.svg`, 'CHANGED');
ok(ensureOutfit(args) === d && read(`${d}/a-symbolic.svg`).includes('id="r"'), 'an existing folder is never rewritten');
GLib.mkdir_with_parents(`${cache}/cat-none-scarf-none-v9.tmp`, 0o700);
for (let v = 10; v < 10 + OUTFIT_KEEP + 2; v++) ensureOutfit({ ...args, lib: { ...LIB, version: v } });
let left = []; let en = Gio.File.new_for_path(cache).enumerate_children('standard::name', 0, null), fi;
while ((fi = en.next_file(null))) left.push(fi.get_name());
ok(left.length === OUTFIT_KEEP && !left.some(n => n.endsWith('.tmp')) && left.includes(`cat-none-scarf-none-v${10 + OUTFIT_KEEP + 1}`), `keeps ${OUTFIT_KEEP}, the latest among them, no leftovers (${left})`);
let file = `${GLib.Dir.make_tmp('nnx-ro-XXXXXX')}/not-a-folder`; GLib.file_set_contents(file, 'x');
eq(ensureOutfit({ ...args, cacheRoot: file }), src, 'a cache that cannot be written: the shipped frames, no throw');
print('companion-check (outfit): ok');
```

- [ ] **Step 2: Run** `gjs -m tests/companion-check.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/helpers/companion-outfit.js`. Frame names come from the unique frames of `spec.acts`. Folder ages use the modification time down to microseconds (`time::modified` with `time::modified-usec`): the test makes eight folders within one second. Touching a folder on reuse is what makes "recently used" true. The test block needs `GLib` and `Gio` in scope.
- [ ] **Step 4: Run** the test. Expected: exit 0, a fourth `ok` line.
- [ ] **Step 5: Commit** `Companion: compose an outfit's frames into the cache`.

---

### Task 4: The player wears outfits; the hat frame sets go

**Files:**
- Modify: `src/helpers/companion.js` (`_loadSpecies`, `setWear`, `_show`; delete `_placeWear`, `_hatFrames`, `_hatMap`, `_wearIcons`, `_anchors`, `_box`)
- Modify: `tools/rabbit-rig/rig.py` (delete `HATS`, `hat_shapes`, `EAR_UNDER_HAT`, `WEAR`, `ANCHORS`, `anchors_for`, the hat loop)
- Delete: `src/companions/*/hat-*-symbolic.svg` (1,296 files), `src/companions/*/wear-*-symbolic.svg` (18 files)
- Test: `tests/companion-check.js`, `tests/headless/checks/companion.sh`

**Interfaces:**
- Consumes: `ensureOutfit`, `CACHE_ROOT` (Task 3); `worn = { head, neck, back }` (Task 1).
- Produces: `Companion.setWear(worn)` loads the outfit's frame set; `_lib` (the parsed `wear.json`), `_outfitDir` (the folder in use), `_frames` (144 icons, nothing else under the sprite).

- [ ] **Step 1: Find out when a new frame's texture is ready.** In a headless run (`--keep`, then `nnx_eval`), create an `St.Icon` from a frame file and poll `icon.get_first_child()?.get_content()` every 20 ms next to an `nnx_shot`. Decision rule: if the content appears only once the picture can be painted, the swap waits for it; if it is there before the picture is, the swap uses a fixed 300 ms overlap instead. Record the answer in a comment on the swap.
- [ ] **Step 2: Replace the wear checks** in `tests/headless/checks/companion.sh` (`pet-hat`, `pet-hat-off`, `pet-collar`) with:

```bash
# an outfit: one frame set, composed in the cache, the same on the pill and in the yard, never a blank
nnx_check pet-outfit "(() => { let st = $NNX._petStore, r = $R; st.gain('scarf', 't'); st.wear('scarf'); return [st.state.worn.neck, r._frames.get(r._shown).opacity]; })()" '["scarf",255]'
sleep 0.8
nnx_check pet-outfit-set "(() => { let r = $R, y = r._mirrors[0]; return [r._outfitDir.endsWith('/rabbit-none-scarf-none-v' + r._lib.version), y._outfitDir === r._outfitDir, r._frames.size, r._sprite.get_n_children(), r._frames.get(r._shown).opacity]; })()" '[true,true,144,144,255]'
nnx_shot pet-outfit 560 40 800 420
# two changes at once end on the last one and leave nothing behind
nnx_check pet-outfit-twice "(() => { let st = $NNX._petStore; st.gain('straw', 't'); st.wear('straw'); st.wear('straw'); st.wear('straw'); return st.state.worn.head; })()" '"straw"'
sleep 0.8
nnx_check pet-outfit-last "(() => { let r = $R; return [r._outfitDir.endsWith('/rabbit-straw-scarf-none-v' + r._lib.version), r._sprite.get_n_children()]; })()" '[true,144]'
# another animal, same clothes, its own drawing
nnx_eval "$R.setSpecies('cat'), true" >/dev/null; sleep 2.5
nnx_check pet-outfit-cat "$R._outfitDir.includes('/cat-straw-scarf-none-v')" true
nnx_eval "$R.setSpecies('rabbit'), true" >/dev/null; sleep 2.5
nnx_check pet-outfit-off "(() => { let st = $NNX._petStore, r = $R; st.wear('straw'); st.wear('scarf'); return [st.state.worn.head, st.state.worn.neck]; })()" '[null,null]'
sleep 0.8
nnx_check pet-outfit-bare "$R._outfitDir.endsWith('/src/companions/rabbit')" true
```

  (Task 2 ships only the scarf, so `straw` draws nothing yet; the key still names it.)

  And, after the existing `pet-yard-gone` check at the end, the first frames of a fresh yard with clothes on:

```bash
nnx_eval "(() => { let st = $NNX._petStore; st.wear('scarf'); return true; })()" >/dev/null; sleep 0.8
nnx_eval "$NNX.expand(), $NNX._switchTab('companion'), true" >/dev/null
sleep 0.15; nnx_shot pet-first-open 560 40 800 200
sleep 1; nnx_eval "(() => { $NNX._petStore.wear('scarf'); $NNX.collapse(); return true; })()" >/dev/null; sleep 1
```
- [ ] **Step 3: Run** the headless command. Expected: FAIL on `pet-outfit-set` (`_outfitDir` is undefined).
- [ ] **Step 4: Implement the player.** `_loadSpecies` also reads `wear.json`. The frame set is built from `ensureOutfit({ srcDir, cacheRoot: CACHE_ROOT, species, worn, spec, lib })`. `setWear` builds the new set at opacity 0 under the sprite, swaps per Step 1's rule (never longer than 500 ms), then destroys the old set; a newer `setWear` during the wait drops the pending set. Mirrors follow as today.
- [ ] **Step 5: Remove the old path.** Delete the listed code in the player and the rig, regenerate the art, delete the hat and wear files. In `tests/companion-check.js` drop the hat-frame, anchor and `wear-*` checks.
- [ ] **Step 6: Run** `gjs -m tests/companion-check.js` and the headless command. Expected: both exit 0; `ls src/companions/rabbit | wc -l` is about 160. Look at `tests/out/pet-first-open.png`: the yard shows either no animal yet or the animal with its scarf, never the animal without it.
- [ ] **Step 7: Commit** `Companion: outfits composed at runtime replace the hat frame sets`.

---

### Task 5: The full wardrobe art (owner's eye)

**Files:**
- Modify: `tools/rabbit-rig/wear.py`, `tools/rabbit-rig/rig.py` (item icons)
- Regenerate: `src/companions/*/wear.json`, new `src/companions/*/item-<id>-symbolic.svg`
- Test: `tests/companion-check.js`

**Interfaces:**
- Consumes: `wear.ITEMS`, `rig.GEO`, `sheet.py` (Task 2); `WEARABLES` (Task 1).
- Produces: all nine items for all three animals in `wear.json`; `item-<id>-symbolic.svg` per animal, a 24 × 24 picture of the item alone, cropped to its rest shapes; `wear.ART_VERSION` raised by one each time shapes change after this task is first committed.

- [ ] **Step 1: Write the failing test:**

```js
for (let [id, w] of Object.entries(WEARABLES)) {
    ok(lib.items[id]?.slot === w.slot, `${sp}: ${id} is drawn, in its slot`);
    ok(dir.get_child(`item-${id}-symbolic.svg`).query_exists(null), `${sp}: ${id} has a picture`);
}
eq(Object.keys(lib.items).sort(), Object.keys(WEARABLES).sort(), `${sp}: nothing drawn that cannot be worn`);
```

- [ ] **Step 2: Run** `gjs -m tests/companion-check.js`. Expected: FAIL (`rabbit: straw is drawn, in its slot`).
- [ ] **Step 3: Draw the items** to the spec's table ("The first wardrobe"), per animal. Two lessons from the throwaway redraw are binding: ears never fold down over the body, and short ears never flatten sideways under a brim.
- [ ] **Step 4: Regenerate, run the test** (expected: exit 0), and render `python3 tools/rabbit-rig/sheet.py <scratch>/wardrobe.png`. Add one earpiece frame (`sit@music`) to the sheet's rows for head items: a hat and the earpiece can be on together.
- [ ] **Step 5: Owner's gate.** Show the sheet. Accepted when, on it: hats, the cape and the scarf's end read at pill size; no item covers an eye; every animal is still recognisable in every hat; nothing reaches below the feet; nothing vanishes into the body. Iterate on the owner's remarks before committing.
- [ ] **Step 6: Commit** `Companion: the wardrobe redrawn at the animal's scale, a cape and a party hat`.

---

### Task 6: The wardrobe as pictures

**Files:**
- Modify: `src/tabs/companion.js` (the Wardrobe card), `stylesheet.css`
- Test: `tests/headless/checks/companion.sh`

**Interfaces:**
- Consumes: `SLOTS`, `WEARABLES[id].how` (Task 1); `item-<id>-symbolic.svg` (Task 5); `_attachTrayTooltip(actor, text, shouldShow)` in `src/notchnux.js`.
- Produces: per slot a row of tiles, one per item of that slot in `WEARABLES` order, style classes `nn-pet-item`, plus `nn-pet-item-on` (worn) or `nn-pet-item-locked` (not owned, not reactive, tooltip = `how`).

- [ ] **Step 1: Add the check**, right after `pet-outfit-bare` (the Pet tab is open and nothing is worn there):

```bash
nnx_check pet-wardrobe "(() => { let st = $NNX._petStore; let find = (a, f, out = []) => { if (f(a)) out.push(a); a.get_children().forEach(c => find(c, f, out)); return out; }; let tiles = find($NNX, a => a.has_style_class_name?.('nn-pet-item')); return [tiles.length, tiles.filter(t => t.has_style_class_name('nn-pet-item-locked')).every(t => !t.reactive), tiles.filter(t => t.has_style_class_name('nn-pet-item-on')).length]; })()" '[9,true,0]'
nnx_shot pet-wardrobe 560 40 800 700
```

- [ ] **Step 2: Run** the headless command. Expected: FAIL on `pet-wardrobe` (0 tiles).
- [ ] **Step 3: Implement** the rows. A tile is an `St.Button` holding the item's icon from the current animal's folder, 32 px; clicking an owned one calls `st.wear(id)`.
- [ ] **Step 4: Run** the headless command and look at `tests/out/pet-wardrobe.png`. Expected: all checks pass; three labelled rows; locked items dim.
- [ ] **Step 5: Commit** `Pet tab: the wardrobe as pictures, with what is still to earn`.

---

### Task 7: House art (owner's eye)

**Files:**
- Create: `tools/rabbit-rig/houses.py`
- Create (generated): `src/companions/houses/house-<style>-{back,front,light,icon}-symbolic.svg`, `src/companions/houses/houses.json`
- Modify: `tools/rabbit-rig/sheet.py` (`--houses`)
- Test: `tests/companion-check.js`

**Interfaces:**
- Consumes: `HOUSE_STYLES` (Task 1).
- Produces:
  - `python3 -I tools/rabbit-rig/houses.py src/companions/houses` writes, per style: `back` (what is behind the animal), `front` (what is in front of it, with the door opening cut out), `light` (accent shapes in the doorway), `icon` (back and front flattened, for the House card).
  - All four share the view box in `houses.json`: `{ "box": [-10, -50, 150, 150], "styles": { "<style>": { "door": <x> } } }`, in the frames' units with the ground at y = 100. `door` is the x of the doorway's centre.
  - `sheet.py <out.png> --houses`: every style at yard scale with each animal standing beside it and lying inside it.

- [ ] **Step 1: Write the failing test:**

```js
let hdir = root.get_child('houses');
let houses = JSON.parse(new TextDecoder().decode(hdir.get_child('houses.json').load_contents(null)[1]));
eq(Object.keys(houses.styles).sort(), [...HOUSE_STYLES].sort(), 'every house style is drawn');
eq(houses.box, [-10, -50, 150, 150], 'the houses\' view box');
for (let s of HOUSE_STYLES) {
    ok(typeof houses.styles[s].door === 'number', `${s}: a door`);
    for (let part of ['back', 'front', 'light', 'icon'])
        ok(hdir.get_child(`house-${s}-${part}-symbolic.svg`).query_exists(null), `${s}: ${part}`);
}
```

- [ ] **Step 2: Run** `gjs -m tests/companion-check.js`. Expected: FAIL (no `houses` folder).
- [ ] **Step 3: Draw the seven styles.** The doorway is wide and tall enough for the largest animal's sleeping frame; check it on the sheet, not by arithmetic.
- [ ] **Step 4: Generate, run the test** (expected: exit 0) and render `python3 tools/rabbit-rig/sheet.py <scratch>/houses.png --houses`.
- [ ] **Step 5: Owner's gate.** Show the sheet. Accepted when every style reads as what it is at yard size and every animal is seen through every door.
- [ ] **Step 6: Commit** `Companion rig: seven houses in two layers with a door light`.

---

### Task 8: The animal walks into its house; the house is a choice

**Files:**
- Modify: `src/helpers/companion.js` (the house icons, `_syncHouse`), `src/tabs/companion.js` (House card, `onChanged`), `stylesheet.css`
- Modify: `tools/rabbit-rig/rig.py` (delete `HOUSES` and the `prop-house` output); delete `src/companions/*/prop-house-symbolic.svg`
- Test: `tests/headless/checks/companion.sh`, `tests/companion-check.js` (drop `prop-house` from the prop list)

**Interfaces:**
- Consumes: `houses.json` and the house files (Task 7); `state.house`, `setHouse`, `HOUSE_DEFAULT` (Task 1).
- Produces: `Companion.setHouse(style)` (yard only) and `_houseStyle`, the style on show; `_houseBack` under the sprite, `_houseFront` and `_houseLight` over it, each sized `round(sprite size × 150 / 135)` so its units match the animal's; `_doorX`, the sprite's x when it is in the doorway; `_inHouse`.

- [ ] **Step 1: Replace `pet-in-house`** and add the choice:

```bash
nnx_check pet-in-house "(() => { let y = $R._mirrors[0]; return [y._act === null, y._inHouse, y._sprite.opacity, y._houseLight.opacity, Math.abs(y._sprite.translation_x - y._doorX) <= 1]; })()" '[true,true,255,255,true]'
nnx_shot pet-in-house 560 40 800 200
nnx_check pet-house-choice "(() => { let st = $NNX._petStore; st.setHouse('tent'); let y = $R._mirrors[0]; return [st.state.house, y._houseStyle]; })()" '["tent","tent"]'
nnx_check pet-house-default "(() => { let st = $NNX._petStore; st.setHouse(null); return $R._mirrors[0]._houseStyle; })()" '"burrow"'
```

  Keep the existing lines around it that put the animal to sleep; lengthen the wait before `pet-in-house` to cover the hop to the door.
- [ ] **Step 2: Run** the headless command. Expected: FAIL on `pet-in-house`.
- [ ] **Step 3: Implement.** In the yard, when the rest pose becomes the lying sleep and the animal is not in the doorway, it hops to `_doorX` first, then lies there between the two layers; the light shows while `_inHouse`. Awake, the light is off and the layers stay. The animal's first arrival in the yard still starts from the doorway. The z's rise from the roof as today.
- [ ] **Step 4: The House card** in `src/tabs/companion.js`, after Wardrobe: one tile per `HOUSE_STYLES` entry showing `house-<style>-icon-symbolic.svg`, class `nn-pet-house-tile` (not `nn-pet-item`: Task 6's check counts those), the current one also `nn-pet-house-tile-on`; a click calls `st.setHouse(style)`. `onChanged` calls `yard.setHouse(st.state.house ?? HOUSE_DEFAULT[species])`.
- [ ] **Step 5: Run** `gjs -m tests/companion-check.js` and the headless command; look at `tests/out/pet-in-house.png`. Expected: all pass; the animal is seen lying inside with the door lit.
- [ ] **Step 6: Commit** `Pet tab: the animal walks into its house; seven house styles to choose from`.

---

### Task 9: Whole-feature verification and the changelog

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Run every self-check:** `for t in tests/*-check.js; do gjs -m "$t" || echo "FAILED $t"; done`. Expected: no `FAILED` line except `eds-check.js`, which refuses to run outside its wrapper by design.
- [ ] **Step 2: Run the full smoke:** `tests/headless-smoke.sh`. Expected: `all checks passed`.
- [ ] **Step 3: Check the package:** `./pack.sh /tmp/nnx-dist` and compare the zip's size with the previous build. Expected: several megabytes smaller (the hat frame sets are gone); it contains `src/companions/*/wear.json` and `src/companions/houses/`.
- [ ] **Step 4: Review Focus walk.** For each of the five lines at the top, name the test that covers it and confirm it ran in Steps 1–2.
- [ ] **Step 5: Add the changelog entry** `### Added — a wardrobe that fits, and houses to choose`: items drawn at the animal's scale, three slots, the cape, party hat, bandana and bow tie and how they are earned, the picture wardrobe, the seven house styles, the animal walking in. One line under `### Changed`: the ribbon is now a bandana.
- [ ] **Step 6: Commit** `Changelog: wardrobe and houses`.
