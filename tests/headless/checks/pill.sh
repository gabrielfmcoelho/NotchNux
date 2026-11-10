# Pill zone checks (sourced by tests/headless-smoke.sh --script): the configured
# order lays the zones out around the clock, hidden zones stay hidden through their
# own syncs, and the music zone can show bars only.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
ORDER="(() => { let n = $NNX; let a = n._pillZoneActors(); let byActor = new Map(Object.entries(a).map(([k, v]) => [v, k])); return n._pill.get_children().map(c => byActor.get(c) ?? (c === n._pillClockLeftSpacer ? '<' : c === n._pillClockRightSpacer ? '>' : '?')); })()"
nnx_check pill-default-order "$ORDER" '["companion","focus","stopwatch","stats","music","<","clock",">","claude","battery","alerts","privacy"]'
# reorder: battery to the left of the clock, companion to the far right
nnx_check pill-reorder "(() => { let n = $NNX; n._config.setPillOrder(['battery', 'focus', 'stopwatch', 'stats', 'music', 'clock', 'claude', 'alerts', 'privacy', 'companion']); n._applyPillOrder(); return true; })()" true
nnx_check pill-reordered "$ORDER" '["battery","focus","stopwatch","stats","music","<","clock",">","claude","alerts","privacy","companion"]'
nnx_check pill-still-wide "$NNX.width > 200" true
# hide the music zone: it stays hidden even when a track plays; the title switch leaves only the bars
nnx_check pill-hide-music "(() => { let n = $NNX; n._config.setPillZoneShown('music', false); n._musicPlaying = true; n._pillMusicBox.visible = true; n._pillWidth(); return n._pillMusicBox.visible; })()" false
nnx_check pill-show-music "(() => { let n = $NNX; n._config.setPillZoneShown('music', true); n._pillMusicBox.visible = true; n._pillWidth(); return n._pillMusicBox.visible; })()" true
nnx_check pill-title-off "(() => { let n = $NNX; n._config.setFeatureEnabled('pillTrackTitle', false); n._refreshLive(); return [n._pillTitleClip.visible, n._pillWidth() < 340 || !n._pillMusicBox.visible]; })()" '[false,true]'
nnx_check pill-title-on "(() => { let n = $NNX; n._config.setFeatureEnabled('pillTrackTitle', true); n._refreshLive(); return n._pillTitleClip.visible; })()" true
# hiding the clock: the width no longer reserves it; switched back on, it shows again (it has no sync of its own)
nnx_check pill-hide-clock "(() => { let n = $NNX; let w0 = n._pillWidth(); n._config.setPillZoneShown('clock', false); n._applyPillOrder(); let w1 = n._pillWidth(); n._config.setPillZoneShown('clock', true); n._applyPillOrder(); return [n._pillClock.visible, w1 <= w0]; })()" '[true,true]'
# back to defaults
nnx_eval "$NNX._config.setPillOrder([]), $NNX._applyPillOrder(), true" >/dev/null
nnx_check pill-restored "$ORDER" '["companion","focus","stopwatch","stats","music","<","clock",">","claude","battery","alerts","privacy"]'
# The notification banner is never narrower than the pill's content (music, the wide meadow).
nnx_check peek-width "(() => { let n = $NNX; return n._peekWidth() >= n._pillWidth() + 16 && n._peekWidth() >= 420; })()" true
