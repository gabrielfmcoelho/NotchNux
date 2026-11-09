# Desktop post-its stay under real windows across restacks and above the
# wallpaper across wallpaper changes (sourced by tests/headless-smoke.sh
# --script). Run with
#   --data tests/headless/notes-fixture.json:notchnux/notes.json
# Launches two tests/headless/gtk-window.js Wayland clients in the test shell.
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
ID=fx-blue
nnx_eval "($NNX._prod.pinNote('$ID', true), $NNX._prod.moveNote('$ID', 300, 200), $NNX._deskNotes.sync(), true)" >/dev/null; sleep 0.5
CARD="$NNX._deskNotes._cards.get('$ID').actor"
BG="Main.layoutManager._backgroundGroup"
# Index under global.window_group of the top-level ancestor of an actor.
TOPIDX="const top = a => { while (a && a.get_parent() !== global.window_group) a = a.get_parent(); return a ? global.window_group.get_children().indexOf(a) : -1; };"
nnx_check stack-layer "(() => { const c = $CARD; const g = $BG; const kids = g.get_children(); return [c.get_parent() === g, kids[kids.length - 1] === c, kids.some(k => k.constructor.name.includes('BackgroundActor'))]; })()" '[true,true,true]'

# A real wallpaper change (isolated keyfile GSettings) adds a new wallpaper actor.
nnx_eval "(() => { const s = new imports.gi.Gio.Settings({ schema_id: 'org.gnome.desktop.background' }); s.set_string('picture-uri', 'file:///usr/share/backgrounds/Derwentwater_by_mendhak.jpg'); s.set_string('picture-uri-dark', 'file:///usr/share/backgrounds/Derwentwater_by_mendhak.jpg'); return true; })()" >/dev/null; sleep 3
nnx_check stack-after-wallpaper "(() => { const c = $CARD; const g = $BG; const kids = g.get_children(); return [c.get_parent() === g, kids[kids.length - 1] === c]; })()" '[true,true]'
# Any other child added to the group (e.g. a wallpaper actor without position control) goes under the card.
nnx_check stack-child-added "(() => { const g = $BG; const x = new imports.gi.Clutter.Actor(); g.add_child(x); const kids = g.get_children(); const r = kids[kids.length - 1] === $CARD; x.destroy(); return r; })()" true

# Two real Wayland windows from GTK 4 clients. Mutter only reorders
# window_group when the window order changes, so it takes two to restack.
WL=$(nnx_eval "imports.gi.GLib.getenv('WAYLAND_DISPLAY')" | tr -d '"')
GTKPIDS=''
if [ -n "$WL" ] && [ -S "$XDG_RUNTIME_DIR/$WL" ]; then
    for t in nnx-stack-a nnx-stack-b; do
        WAYLAND_DISPLAY=$WL GDK_BACKEND=wayland GTK_A11Y=none gjs "$HERE/headless/gtk-window.js" "$t" >"$NNX_OUT/gtk-$t.log" 2>&1 &
        GTKPIDS="$GTKPIDS $!"
    done
fi
WIN() { echo "global.get_window_actors().find(a => a.meta_window.get_title() === 'nnx-stack-$1')"; }
WA=$(WIN a); WB=$(WIN b)
for _ in $(seq 40); do [ "$(nnx_eval "!!$WA && !!$WB")" = true ] && break; sleep 0.25; done
echo "wayland socket: ${WL:-none}, client pids:${GTKPIDS:- none}"
nnx_check stack-windows-up "[!!$WA, !!$WB]" '[true,true]'
# Put both windows over the card, then swap their order back and forth.
nnx_eval "(() => { const t = global.get_current_time(); $WA.meta_window.move_frame(true, 200, 150); $WB.meta_window.move_frame(true, 150, 100); $WA.meta_window.activate(t); return true; })()" >/dev/null; sleep 0.7
nnx_check stack-covers "(() => { const c = $CARD; return [$WA, $WB].map(w => { const r = w.meta_window.get_frame_rect(); return r.x <= c.x && r.y <= c.y && r.x + r.width >= c.x + 180 && r.y + r.height >= c.y + 180; }); })()" '[true,true]'
for w in b a b; do
    nnx_eval "($(WIN $w).meta_window.activate(global.get_current_time()), true)" >/dev/null; sleep 0.7
done
nnx_check stack-restacked "(() => { $TOPIDX return top($WB) > top($WA); })()" true
nnx_check stack-below-windows "(() => { $TOPIDX const c = $CARD; return [c.get_parent() === $BG, top(c) >= 0, top(c) < top($WA), top(c) < top($WB)]; })()" '[true,true,true,true]'
# What the pointer hits at the card's centre is a window, not the card.
nnx_check stack-pick-window "(() => { const c = $CARD; let a = global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.ALL, c.x + 90, c.y + 90); while (a && a !== $WA && a !== $WB && a !== c) a = a.get_parent(); return !!a && a !== c; })()" true
sleep 0.5
nnx_shot desknotes-under-window
# Move the windows away: the card is on the wallpaper and takes the pointer again.
nnx_eval "($WA.meta_window.move_frame(true, 1100, 500), $WB.meta_window.move_frame(true, 1150, 550), true)" >/dev/null; sleep 1
nnx_check stack-pick-card "(() => { const c = $CARD; return global.stage.get_actor_at_pos(imports.gi.Clutter.PickMode.REACTIVE, c.x + 90, c.y + 90) === c; })()" true
nnx_shot desknotes-beside-window
# shellcheck disable=SC2086
[ -n "$GTKPIDS" ] && kill $GTKPIDS 2>/dev/null
nnx_eval "($NNX._prod.pinNote('$ID', false), true)" >/dev/null; sleep 0.3
