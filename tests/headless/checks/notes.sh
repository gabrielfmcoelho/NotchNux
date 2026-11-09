# Notes board checks (sourced by tests/headless-smoke.sh --script). Run with
#   --data tests/headless/notes-fixture.json:notchnux/notes.json
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 1
nnx_check board-ready "(() => { const n = $NNX; n.expand(); n._switchTab('notes'); return n._prod.notes.length; })()" 3
sleep 1
nnx_check board-cards "(() => { const n = $NNX; const q = a => { let c = 0; const w = x => { if (x.has_style_class_name && x.has_style_class_name('nook-postit')) c++; x.get_children().forEach(w); }; w(a); return c; }; return q(n._tabHosts.get('notes')); })()" 4
nnx_check board-add-card "(() => { const n = $NNX; const q = (x, cls) => { let c = 0; const w = y => { if (y.has_style_class_name && y.has_style_class_name(cls)) c++; y.get_children().forEach(w); }; w(x); return c; }; return q(n._tabHosts.get('notes'), 'nook-postit-add'); })()" 1
sleep 0.5
nnx_shot tab-notes-board

# Opening a card binds the editor to that note; typing edits that note only.
nnx_check editor-binds "(() => { const n = $NNX; n._notesUi.showEditor('fx-green'); n._notesUi.entry.set_text('green edited'); const p = n._prod; return [n._notesUi.openId, p.getNote('fx-green').text, p.getNote('fx-yellow').text.startsWith('Buy milk'), p.getNote('fx-blue').text, p.notes.length]; })()" '["fx-green","green edited",true,"Call the dentist",3]'
sleep 0.5
nnx_shot tab-notes-editor

# An outside addNote while the editor has key focus leaves the open note alone and marks the tab dirty.
nnx_check outside-add "(() => { const n = $NNX; const ui = n._notesUi; ui.entry.clutter_text.grab_key_focus(); n._tabHosts.get('notes')._dirty = false; const id = n._prod.addNote('outside'); return [ui.openId, ui.entry.get_text(), n._prod.getNote('fx-green').text, n._tabHosts.get('notes')._dirty, n._prod.notes.length]; })()" '["fx-green","green edited","green edited",true,4]'

# Delete from the editor, then Undo restores the same id.
nnx_check delete-undo "(() => { const n = $NNX; n._notesUi.showEditor('fx-green'); const p = n._prod; const note = p.removeNote('fx-green'); const gone = !p.getNote('fx-green'); p.restoreNote(note); return [gone, !!p.getNote('fx-green'), p.getNote('fx-green').text]; })()" '[true,true,"green edited"]'
nnx_check delete-button "(() => { const n = $NNX; n._switchTab('home'); n._switchTab('notes'); n._notesUi.showEditor('fx-green'); const find = (x) => { if (x.label === 'Delete') return x; for (const c of x.get_children()) { const r = find(c); if (r) return r; } return null; }; find(n._tabHosts.get('notes')).emit('clicked', 1); return [n._notesUi.openId, !n._prod.getNote('fx-green')]; })()" '[null,true]'

# Leaving a new, empty note removes it; a note with text stays.
nnx_check empty-removed "(() => { const n = $NNX; const before = n._prod.notes.length; n._notesUi.showBoard(); const add = (x) => { if (x.has_style_class_name && x.has_style_class_name('nook-postit-add')) return x; for (const c of x.get_children()) { const r = add(c); if (r) return r; } return null; }; add(n._tabHosts.get('notes')).emit('clicked', 1); const id = n._notesUi.openId; const created = !!n._prod.getNote(id) && n._prod.notes.length === before + 1; n._notesUi.showBoard(); return [created, !n._prod.getNote(id), n._prod.notes.length === before]; })()" '[true,true,true]'
nnx_check typed-new-stays "(() => { const n = $NNX; const add = (x) => { if (x.has_style_class_name && x.has_style_class_name('nook-postit-add')) return x; for (const c of x.get_children()) { const r = add(c); if (r) return r; } return null; }; add(n._tabHosts.get('notes')).emit('clicked', 1); const id = n._notesUi.openId; n._notesUi.entry.set_text('kept'); n._notesUi.showBoard(); const r = n._prod.getNote(id)?.text; n.collapse(); return r; })()" '"kept"'

# Undo bar: Delete shows it on the board, Undo restores the same id and removes it.
nnx_check undo-bar-shows "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; n._switchTab('notes'); n._notesUi.showEditor('fx-blue'); find(n._tabHosts.get('notes'), x => x.label === 'Delete').emit('clicked', 1); const host = n._tabHosts.get('notes'); return [!n._prod.getNote('fx-blue'), !!find(host, x => x.label === 'Undo'), n._notesUi.openId]; })()" '[true,true,null]'
nnx_check undo-bar-survives-rerender "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; n._notesUi.showBoard(); return !!find(n._tabHosts.get('notes'), x => x.label === 'Undo'); })()" true
nnx_check undo-restores-id "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; find(n._tabHosts.get('notes'), x => x.label === 'Undo').emit('clicked', 1); return [n._prod.getNote('fx-blue')?.text, !find(n._tabHosts.get('notes'), x => x.label === 'Undo'), n._notesUndo]; })()" '["Call the dentist",true,null]'
# The bar goes away on its own after 5 s.
nnx_check undo-timeout-arm "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; n._notesUi.showEditor('fx-blue'); find(n._tabHosts.get('notes'), x => x.label === 'Delete').emit('clicked', 1); return !!n._notesUndo; })()" true
sleep 6
nnx_check undo-timeout-gone "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; return [n._notesUndo, !find(n._tabHosts.get('notes'), x => x.label === 'Undo')]; })()" '[null,true]'
# An empty note is dropped when the user switches tab with its editor open.
nnx_check empty-dropped-on-tab-switch "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; n._notesUi.showBoard(); find(n._tabHosts.get('notes'), x => x.has_style_class_name && x.has_style_class_name('nook-postit-add')).emit('clicked', 1); const id = n._notesUi.openId; const had = !!n._prod.getNote(id); n._switchTab('home'); return [had, !n._prod.getNote(id), n._notesOpenId]; })()" '[true,true,null]'
nnx_check collapse-cleanup "(() => { const n = $NNX; n.collapse(); return true; })()" true
