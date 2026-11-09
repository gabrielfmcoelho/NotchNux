# Desktop post-it checks (sourced by tests/headless-smoke.sh --script). Run with
#   --data tests/headless/notes-fixture.json:notchnux/notes.json
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
ID=$(nnx_eval "$NNX._prod.notes[0].id" | tr -d '"')
nnx_check desk-none-before "$NNX._deskNotes._cards.size" 0
nnx_eval "($NNX._prod.pinNote('$ID', true), true)" >/dev/null; sleep 1
nnx_check desk-actor-exists "(() => { const d = $NNX._deskNotes; const c = d._cards.get('$ID'); return [d._cards.size, !!c, c.actor.width, c.actor.height]; })()" '[1,true,180,180]'
nnx_check desk-layer "(() => { const c = $NNX._deskNotes._cards.get('$ID').actor; const g = Main.layoutManager._backgroundGroup; return [c.get_parent() === g, g.get_last_child() === c, c.get_previous_sibling() !== null]; })()" '[true,true,true]'
nnx_check desk-text "(() => { const c = $NNX._deskNotes._cards.get('$ID'); return c.label.get_text() === $NNX._prod.getNote('$ID').text; })()" true
nnx_check desk-default-pos-saved "(() => { const n = $NNX._prod.getNote('$ID'); const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex); return [!!n.pos, n.pos.x + 180 <= a.x + a.width, n.pos.y >= a.y]; })()" '[true,true,true]'
sleep 0.5
nnx_shot desknotes
nnx_eval "($NNX._prod.moveNote('$ID', -500, -500), $NNX._deskNotes.sync(), true)" >/dev/null
nnx_check desk-clamped "(() => { const [x, y] = $NNX._deskNotes._cards.get('$ID').actor.get_position(); const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex); return x >= a.x && y >= a.y && x + 180 <= a.x + a.width && y + 180 <= a.y + a.height; })()" true
nnx_check desk-clamp-saved "(() => { const n = $NNX._prod.getNote('$ID'); return n.pos.x >= 0 && n.pos.y >= 0; })()" true
# Drag through the handlers with synthetic events (no real pointer needed).
nnx_check desk-drag "(() => { const d = $NNX._deskNotes; const a = d._cards.get('$ID').actor; const [x0, y0] = a.get_position(); const ev = (x, y) => ({ get_button: () => 1, get_state: () => 256, get_coords: () => [x, y], get_time: () => 1000 }); d._onPress('$ID', a, ev(x0 + 110, y0 + 10)); d._onMotion('$ID', ev(x0 + 210, y0 + 40)); d._onRelease('$ID', ev(x0 + 210, y0 + 40)); const [x1, y1] = a.get_position(); const n = $NNX._prod.getNote('$ID'); return [x1 === x0 + 100, y1 === y0 + 30, n.pos.x === x1, n.pos.y === y1, d._drag === null]; })()" '[true,true,true,true,true]'
nnx_check desk-doubleclick "(() => { const d = $NNX._deskNotes; const a = d._cards.get('$ID').actor; let opened = null; d._onOpen = id => { opened = id; }; const ev = t => ({ get_button: () => 1, get_coords: () => [5, 5], get_time: () => t }); d._onPress('$ID', a, ev(5000)); d._onRelease('$ID', ev(5010)); d._onPress('$ID', a, ev(5200)); d._onRelease('$ID', ev(5210)); return opened; })()" "\"$ID\""
nnx_check desk-open-editor "(() => { const n = $NNX; n._openNoteInEditor('$ID'); return [n.isExpanded, n._activeTab, n._notesUi.openId]; })()" "[true,\"notes\",\"$ID\"]"
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 0.7

# Real virtual pointer: the Clutter grab must really be released.
vp() { nnx_eval "(() => { const C = imports.gi.Clutter; if (!globalThis.__vp) { globalThis.__vp = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.POINTER_DEVICE); globalThis.__vt = global.get_current_time() * 1000; } const d = globalThis.__vp; const t = () => (globalThis.__vt += 20000); $1; return true; })()" >/dev/null; sleep 0.25; }
NOGRAB="(global.stage.get_grab_actor?.() ?? null) === null"
vp_press_move() { # press on the card, then move 100 px left in steps
    CX=$(nnx_eval "$NNX._deskNotes._cards.get('$ID').actor.x + 90"); CY=$(nnx_eval "$NNX._deskNotes._cards.get('$ID').actor.y + 90")
    X0=$(nnx_eval "$NNX._deskNotes._cards.get('$ID').actor.x")
    vp "d.notify_absolute_motion(t(), $CX, $CY)"
    vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.PRESSED)"
    for i in $(seq 1 ${STEPS:-5}); do vp "d.notify_absolute_motion(t(), $CX - 20 * $i * ${DIR:-1}, $CY)"; done
}
vp_press_move
nnx_check pointer-dragging "[$NNX._deskNotes._drag !== null, !($NOGRAB)]" '[true,true]'
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
nnx_check pointer-release "(() => { const n = $NNX; const x = n._deskNotes._cards.get('$ID').actor.x; return [Math.abs(($X0) - x - 100) <= 2, n._prod.getNote('$ID').pos.x === x, n._deskNotes._drag === null, $NOGRAB]; })()" '[true,true,true,true]'
# Unpin mid-drag.
vp_press_move
nnx_eval "($NNX._prod.pinNote('$ID', false), true)" >/dev/null; sleep 0.3
nnx_check pointer-unpin-mid-drag "[$NNX._deskNotes._cards.has('$ID'), $NNX._deskNotes._drag === null, $NOGRAB]" '[false,true,true]'
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
# Lost release: a motion with no button held ends the drag.
nnx_eval "($NNX._prod.pinNote('$ID', true), true)" >/dev/null; sleep 0.3
vp_press_move
nnx_eval "($NNX._deskNotes._onMotion('$ID', { get_state: () => 0, get_coords: () => [0, 0] }), true)" >/dev/null
nnx_check lost-release "[$NNX._deskNotes._drag === null, $NOGRAB]" '[true,true]'
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
pickcheck() { nnx_check "$1" "(() => { const a = $NNX._deskNotes._cards.get('$ID').actor; return global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, a.x + 90, a.y + 90) === a; })()" "${2:-true}"; }
pickcheck pick-before
# Overview opening mid-drag (button still held): drag ends, no grab, clamped position saved.
nnx_check grab-api "typeof global.stage.get_grab_actor === 'function'" true
STEPS=3 vp_press_move
nnx_check overview-mid-drag-start "[$NNX._deskNotes._drag !== null, !($NOGRAB)]" '[true,true]'
nnx_eval "(Main.overview.show(), true)" >/dev/null; sleep 1.5
nnx_check overview-mid-drag-ended "(() => { const n = $NNX; const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex); const p = n._prod.getNote('$ID').pos; const x = n._deskNotes._cards.get('$ID').actor.x; return [n._deskNotes._drag === null, global.stage.get_grab_actor() !== n._deskNotes._cards.get('$ID').actor, p.x >= a.x && p.y >= a.y && p.x + 180 <= a.x + a.width && p.y + 180 <= a.y + a.height, p.x === x]; })()" '[true,true,true,true]'
nnx_shot desknotes-overview
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
nnx_eval "(Main.overview.hide(), true)" >/dev/null; sleep 3
pickcheck pick-after-overview
nnx_check overview-after-release "[$NNX._deskNotes._drag === null, $NOGRAB]" '[true,true]'
P0=$(nnx_eval "$NNX._prod.getNote('$ID').pos.x")
DIR=-1 STEPS=3 vp_press_move
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
nnx_check drag-after-overview "(() => { const n = $NNX; const x = n._deskNotes._cards.get('$ID').actor.x; return [n._prod.getNote('$ID').pos.x !== $P0, n._prod.getNote('$ID').pos.x === x, n._deskNotes._drag === null, $NOGRAB]; })()" '[true,true,true,true]'
# Lock mid-drag: fake isLocked on the session mode and re-run the visibility sync.
STEPS=3 vp_press_move
nnx_eval "(Object.defineProperty(Main.sessionMode, 'isLocked', { value: true, configurable: true }), $NNX._deskNotes._syncVisible(), true)" >/dev/null
nnx_check lock-mid-drag "[$NNX._deskNotes._drag === null, $NOGRAB, $NNX._deskNotes._cards.get('$ID').actor.visible]" '[true,true,false]'
nnx_eval "(delete Main.sessionMode.isLocked, $NNX._deskNotes._syncVisible(), true)" >/dev/null
vp "d.notify_button(t(), C.BUTTON_PRIMARY, C.ButtonState.RELEASED)"
nnx_check lock-restored "[$NNX._deskNotes._cards.get('$ID').actor.visible, $NOGRAB]" '[true,true]'
# A press that never passes the threshold saves nothing when interrupted.
nnx_check interrupt-unmoved-saves-nothing "(() => { const n = $NNX; const d = n._deskNotes; const a = d._cards.get('$ID').actor; const before = JSON.stringify(n._prod.getNote('$ID').pos); const ev = { get_button: () => 1, get_coords: () => [a.x + 5, a.y + 5], get_time: () => 1 }; d._onPress('$ID', a, ev); d._interruptDrag(); d._interruptDrag(); return [d._drag === null, JSON.stringify(n._prod.getNote('$ID').pos) === before]; })()" '[true,true]'
nnx_eval "($NNX._prod.pinNote('$ID', false), true)" >/dev/null; sleep 0.3
nnx_check desk-unpinned-gone "(() => [$NNX._deskNotes._cards.size, $NNX._deskNotes._cards.has('$ID')])()" '[0,false]'
