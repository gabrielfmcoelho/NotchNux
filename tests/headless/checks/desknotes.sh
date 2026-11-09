# Desktop post-it checks (sourced by tests/headless-smoke.sh --script). Run with
#   --data tests/headless/notes-fixture.json:notchnux/notes.json
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
ID=$(nnx_eval "$NNX._prod.notes[0].id" | tr -d '"')
nnx_check desk-none-before "$NNX._deskNotes._cards.size" 0
nnx_eval "($NNX._prod.pinNote('$ID', true), true)" >/dev/null; sleep 1
nnx_check desk-actor-exists "(() => { const d = $NNX._deskNotes; const c = d._cards.get('$ID'); return [d._cards.size, !!c, c.actor.width, c.actor.height]; })()" '[1,true,180,180]'
nnx_check desk-layer "(() => { const c = $NNX._deskNotes._cards.get('$ID').actor; const g = Main.layoutManager._backgroundGroup; return [c.get_parent() === g.get_parent(), c.get_previous_sibling() === g]; })()" '[true,true]'
nnx_check desk-text "(() => { const c = $NNX._deskNotes._cards.get('$ID'); return c.label.get_text() === $NNX._prod.getNote('$ID').text; })()" true
nnx_check desk-default-pos-saved "(() => { const n = $NNX._prod.getNote('$ID'); const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex); return [!!n.pos, n.pos.x + 180 <= a.x + a.width, n.pos.y >= a.y]; })()" '[true,true,true]'
sleep 0.5
nnx_shot desknotes
nnx_eval "($NNX._prod.moveNote('$ID', -500, -500), $NNX._deskNotes.sync(), true)" >/dev/null
nnx_check desk-clamped "(() => { const [x, y] = $NNX._deskNotes._cards.get('$ID').actor.get_position(); const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex); return x >= a.x && y >= a.y && x + 180 <= a.x + a.width && y + 180 <= a.y + a.height; })()" true
nnx_check desk-clamp-saved "(() => { const n = $NNX._prod.getNote('$ID'); return n.pos.x >= 0 && n.pos.y >= 0; })()" true
# Drag through the handlers with synthetic events (no real pointer needed).
nnx_check desk-drag "(() => { const d = $NNX._deskNotes; const a = d._cards.get('$ID').actor; const [x0, y0] = a.get_position(); const ev = (x, y) => ({ get_button: () => 1, get_coords: () => [x, y], get_time: () => 1000 }); d._onPress('$ID', a, ev(x0 + 110, y0 + 10)); d._onMotion('$ID', ev(x0 + 210, y0 + 40)); d._onRelease('$ID', ev(x0 + 210, y0 + 40)); const [x1, y1] = a.get_position(); const n = $NNX._prod.getNote('$ID'); return [x1 === x0 + 100, y1 === y0 + 30, n.pos.x === x1, n.pos.y === y1, d._drag === null]; })()" '[true,true,true,true,true]'
nnx_check desk-doubleclick "(() => { const d = $NNX._deskNotes; const a = d._cards.get('$ID').actor; let opened = null; d._onOpen = id => { opened = id; }; const ev = t => ({ get_button: () => 1, get_coords: () => [5, 5], get_time: () => t }); d._onPress('$ID', a, ev(5000)); d._onRelease('$ID', ev(5010)); d._onPress('$ID', a, ev(5200)); d._onRelease('$ID', ev(5210)); return opened; })()" "\"$ID\""
nnx_check desk-open-editor "(() => { const n = $NNX; n._openNoteInEditor('$ID'); return [n.isExpanded, n._activeTab, n._notesUi.openId]; })()" "[true,\"notes\",\"$ID\"]"
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 0.7
nnx_eval "($NNX._prod.pinNote('$ID', false), true)" >/dev/null; sleep 0.3
nnx_check desk-unpinned-gone "(() => [$NNX._deskNotes._cards.size, $NNX._deskNotes._cards.has('$ID')])()" '[0,false]'
