# Companion checks (sourced by tests/headless-smoke.sh --script).
# One animal on the pill: it breathes, plans its next move, wanders inside a meadow
# that widens while it has a life to live and narrows while you are busy, eats,
# wears an earpiece for music, can be petted and swapped for another animal.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
R="$NNX._pillRabbit"

nnx_check comp-mapped "$R.mapped && $R.species === 'rabbit'" true
nnx_check comp-idle-timers "[$R._ambientId > 0, $R._breathId > 0]" '[true,true]'
# daytime idle: the meadow is wide (the test runs by day; at night this would be compact and asleep)
nnx_check comp-wide-idle "$R._state.night ? $R.width === 60 : $R.width === 120" true

# breathing: within ~2 s the shown frame alternates at least once
nnx_check comp-breathes "(() => { globalThis.__seen = new Set(); let r = $R; let id = setInterval(() => __seen.add(r._shown), 100); setTimeout(() => clearInterval(id), 2000); return true; })()" true
sleep 2.3
nnx_check comp-breath-frames "__seen.size >= 2 || $R._state.night" true

W0=$(nnx_eval "$NNX.width")
# wander: lands inside the meadow, facing the way it went, back to rest; the pill keeps its width
nnx_check comp-wander "(() => { let r = $R; globalThis.__x0 = r._sprite.translation_x; r._play('wander'); globalThis.__dir = r._facing; return r._act?.name; })()" '"hop"'
sleep 0.35; nnx_shot comp-wander-mid 760 0 400 48; sleep 1
nnx_check comp-wander-landed "(() => { let r = $R; let x = r._sprite.translation_x; return [x >= 0 && x <= r.width - 32, Math.abs(x - __x0) >= 9, Math.sign(x - __x0) === __dir, r._act === null, r._sprite.translation_y === 0]; })()" '[true,true,true,true,true]'
nnx_check comp-pill-width "$NNX.width === $W0" true

# composite acts run as sequences and clean up their props
nnx_check comp-chase "(() => { let r = $R; r._play('chase'); return [r._act?.name, r._queue.length, r._propShown]; })()" '["look",3,"prop-bit"]'
sleep 2.4
nnx_check comp-chase-done "[$R._act, $R._propShown]" '[null,null]'
nnx_check comp-snack "(() => { let r = $R; r._play('snack'); return [r._act?.name, r._propShown]; })()" '["look","food-whole"]'
sleep 0.6; nnx_shot comp-snack 760 0 400 48
sleep 2.2
nnx_check comp-snack-done "[$R._act, $R._propShown]" '[null,null]'
for act in dig sniffup yawn shake; do
  nnx_check "comp-$act" "($R._play('$act'), $R._act?.name)" "\"$act\""
  sleep 0.3; nnx_shot "comp-$act" 760 0 400 48; sleep 0.8
done

# a cut mid-wander leaves nothing half done
nnx_check comp-cut-wander "(() => { let r = $R; r._play('wander'); let t = r._xTarget; r._cut(); return [r._sprite.translation_x === t, r._xTarget === null, r._stepId === 0, r._queue.length]; })()" '[true,true,true,0]'

# music: the earpiece frames, a bob, and the meadow stays wide
nnx_check comp-music-rest "(() => { let n = $NNX, r = $R; n._musicPlaying = true; r.update(); return ['sit', 'breathe'].some(a => r._acts(a).frames.includes(r._shown)) && r._acts('sit') !== r._spec.acts.sit; })()" true
nnx_check comp-music-bob "(() => { let r = $R; r._play('bob'); return r._acts('bob') === r._spec.acts['bob@music'] && r._acts('bob').frames[0] === r._shown; })()" true
sleep 0.2; nnx_shot comp-music 760 0 400 48; sleep 1
nnx_check comp-music-off "(() => { let n = $NNX, r = $R; n._musicPlaying = false; r.update(); return r._spec.acts.sit.frames.includes(r._shown) || r._spec.acts.breathe.frames.includes(r._shown); })()" true

# Claude waiting: thumps in orange, asks for the compact meadow after a hold (no flapping), never mid-act
nnx_check comp-waiting "(() => { let r = $R; r.setClaude('waiting', 0, '#ff9f0a'); return [r._act?.name, r._sprite.get_style().includes('#ff9f0a'), r._narrowId > 0 || r.width === 60]; })()" '["thump",true,true]'
sleep 0.3; nnx_shot comp-waiting 760 0 400 48; sleep 1
nnx_check comp-waiting-ambient "$R._ambientId > 0" true
nnx_check comp-finished "(() => { let r = $R; r.setClaude('idle', 1, null); return r._act?.name; })()" '"binky"'
sleep 1.2
nnx_check comp-wide-again "[$R._narrowId, $R._state.night || $R.width === 120]" '[0,true]'

# pet: a click plays the pet act and is swallowed; a second click right after propagates
nnx_check comp-pet "(() => { let r = $R; r._lastPet = 0; let first = r._onPress(1); let again = r._onPress(1); return [first, again, r._act?.name, r._onPress(3)]; })()" '[true,false,"pet",false]'
sleep 1.2

# species switch: hops off, the new animal hops in from the left with its own frames
nnx_check comp-switch "(() => { let r = $R; r.setSpecies('fox'); return r._act?.name; })()" '"hop"'
sleep 1.8
nnx_check comp-switched "(() => { let r = $R; return [r.species, r._frames.size > 100, r._act === null || r._act.name === 'hop']; })()" '["fox",true,true]'
sleep 1.2; nnx_shot comp-fox 760 0 400 48
nnx_check comp-switch-back "($R.setSpecies('rabbit'), true)" true
sleep 3

# switched off: hidden, no timers; back on: alive again
nnx_check comp-off-no-timers "($NNX._onFeatureToggled('rabbitCompanion', false), [$R.mapped, $R._ambientId, $R._breathId, $R._worldId])" '[false,0,0,0]'
nnx_check comp-on-timers "($NNX._onFeatureToggled('rabbitCompanion', true), [$R._ambientId > 0, $R._breathId > 0])" '[true,true]'

# asleep: slow breathing, no next move, compact requested; waking stretches
nnx_check comp-sleep "(() => { let r = $R; r._away = true; r.update(); return [r._ambientId, r._breathId > 0, r._narrowId > 0 || r.width === 60]; })()" '[0,true,true]'
nnx_shot comp-sleep 760 0 400 48
nnx_check comp-wake "(() => { let r = $R; r._away = false; r.update(); return r._act?.name; })()" '"stretch"'
sleep 1
