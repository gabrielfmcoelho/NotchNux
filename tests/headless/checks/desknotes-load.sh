# A note pinned in an earlier session is back on the desktop after login or
# unlock, with no user action (sourced by tests/headless-smoke.sh --script).
# Run with
#   --data tests/headless/desknotes-fixture.json:notchnux/notes.json
nnx_check desk-load-store "[$NNX._prod.loaded, $NNX._prod.notes.length]" '[true,2]'
nnx_check desk-load-cards "(() => { const d = $NNX._deskNotes; const c = d._cards.get('fx-pinned'); return [d._cards.size, !!c, c ? c.actor.x : -1, c ? c.actor.y : -1, c ? c.label.get_text() === 'Pinned since last session' : false]; })()" '[1,true,300,200,true]'
# GNOME disables and re-enables every extension around a lock; the card comes back.
nnx_eval "(Main.extensionManager.disableExtension('notchnux@adityasah.programs'), true)" >/dev/null; sleep 1
nnx_eval "(Main.extensionManager.enableExtension('notchnux@adityasah.programs'), true)" >/dev/null; sleep 2
nnx_check desk-load-after-reenable "(() => { const d = $NNX._deskNotes; const c = d._cards.get('fx-pinned'); return [d._cards.size, c ? c.actor.x : -1, c ? c.actor.y : -1, c ? c.actor.visible : false]; })()" '[1,300,200,true]'
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
nnx_shot desknotes-load
