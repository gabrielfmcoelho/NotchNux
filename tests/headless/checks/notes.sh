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

nnx_eval "(() => { const n = $NNX; n.expand(); n._switchTab('notes'); return true; })()" >/dev/null; sleep 0.5
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

# ---- keyboard grab, deleted-elsewhere, pin, colors, limit (fix round) ----
nnx_eval "(() => { const n = $NNX; n.collapse(); n.expand(); n._switchTab('notes'); return true; })()" >/dev/null
sleep 1
notes_esc() { nnx_eval "(() => { const C = imports.gi.Clutter; const d = global.stage.context.get_backend().get_default_seat().create_virtual_device(C.InputDeviceType.KEYBOARD_DEVICE); const t = global.get_current_time() * 1000; d.notify_keyval(t + 1000, C.KEY_Escape, C.KeyState.PRESSED); d.notify_keyval(t + 2000, C.KEY_Escape, C.KeyState.RELEASED); return true; })()" >/dev/null; }

nnx_check deleted-elsewhere "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); const id = n._prod.addNote('tmp'); n._notesUi.showEditor(id); const before = n._prod.notes.length; n._prod.removeNote(id); return [n._notesUi.openId, n._notesOpenId, !n._prod.getNote(id), n._prod.notes.length === before - 1, !!find(host(), x => x.has_style_class_name && x.has_style_class_name('nook-postit-add'))]; })()" '[null,null,true,true,true]'

nnx_check esc-setup "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._notesUi.showEditor('fx-yellow'); n._notesUi.entry.clutter_text.grab_key_focus(); return n._kbGrab !== null; })()" true
notes_esc; sleep 0.7
nnx_check esc-returns-to-board "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); return [n._notesUi.openId, !!n._prod.getNote('fx-yellow'), n._kbGrab === null, n.isExpanded]; })()" '[null,true,true,true]'

nnx_check back-setup "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._notesUi.showEditor('fx-yellow'); n._notesUi.entry.clutter_text.grab_key_focus(); const g = n._kbGrab !== null; find(host(), x => x.accessible_name === 'Back to notes').emit('clicked', 1); return g; })()" true
sleep 0.7
nnx_check back-releases-grab "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); return [n._notesUi.openId, n._kbGrab === null]; })()" '[null,true]'

nnx_check tabswitch-setup "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._notesUi.showEditor('fx-yellow'); n._notesUi.entry.clutter_text.grab_key_focus(); n._switchTab('home'); return true; })()" true
sleep 0.7
nnx_check tabswitch-releases-grab "$NNX._kbGrab === null" true

nnx_check collapse-empty-setup "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._switchTab('notes'); n._notesUi.showBoard(); find(host(), x => x.has_style_class_name && x.has_style_class_name('nook-postit-add')).emit('clicked', 1); globalThis.__emptyId = n._notesUi.openId; return [!!n._prod.getNote(__emptyId), n._kbGrab !== null]; })()" '[true,true]'
nnx_eval "$NNX.collapse(), true" >/dev/null; sleep 0.7
nnx_check collapse-removes-empty "(() => { const n = $NNX; return [!n._prod.getNote(__emptyId), n._kbGrab === null, n._notesUi.openId]; })()" '[true,true,null]'

nnx_eval "(() => { const n = $NNX; n.expand(); n._switchTab('notes'); return true; })()" >/dev/null
sleep 1
nnx_check pin-toggle "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._notesUi.showEditor('fx-yellow'); const pin = find(host(), x => x.label === 'Pin to desktop'); pin.checked = true; pin.emit('clicked', 1); return n._prod.getNote('fx-yellow').pinned; })()" true
nnx_check color-dot "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); find(host(), x => x.accessible_name === 'pink note').emit('clicked', 1); return [n._prod.getNote('fx-yellow').color, n._prod.notes.filter(x => x.color === 'pink').length]; })()" '["pink",1]'
nnx_eval "$NNX._notesUi.showBoard(), true" >/dev/null

nnx_check limit-max "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); globalThis.__extra = []; while (n._prod.notes.length < 50) __extra.push(n._prod.addNote('x' + __extra.length)); n._notesUi.render(); find(host(), x => x.has_style_class_name && x.has_style_class_name('nook-postit-add')).emit('clicked', 1); const l = find(host(), x => x.has_style_class_name && x.has_style_class_name('nook-postit-plus')); return [n._prod.notes.length, l.get_text(), n._notesUi.openId]; })()" '[50,"50 max",null]'
sleep 2
nnx_check limit-label-reverts "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); return find(host(), x => x.has_style_class_name && x.has_style_class_name('nook-postit-plus')).get_text(); })()" '"+"'
nnx_check limit-cleanup "(() => { const n = $NNX; __extra.forEach(id => n._prod.removeNote(id)); n._notesUi.render(); return n._prod.notes.length; })()" 3

# Timer regression: an undo timeout firing on another tab must not drop a keyboard grab.
nnx_check timer-setup "(() => { const n = $NNX; const find = (x, f) => { if (f(x)) return x; for (const c of x.get_children()) { const r = find(c, f); if (r) return r; } return null; }; const host = () => n._tabHosts.get('notes'); n._switchTab('notes'); const id = n._prod.addNote('to delete'); n._notesUi.showEditor(id); find(host(), x => x.label === 'Delete').emit('clicked', 1); n._switchTab('home'); n.collapse(); n._toggleFromKeyboard(); n._commandEntry.clutter_text.grab_key_focus(); return [!!n._notesUndo, n._kbGrab !== null]; })()" '[true,true]'
sleep 6
nnx_check timer-keeps-grab "(() => { const n = $NNX; return [n._notesUndo, n._kbGrab !== null, global.stage.get_key_focus() === n._commandEntry.clutter_text]; })()" '[null,true,true]'
nnx_eval "$NNX.collapse(), true" >/dev/null

# Search filters the board in place; the field survives; the add card hides while searching.
nnx_check search-field "(() => { const n = $NNX; n.expand(); n._switchTab('notes'); n._notesUi.showBoard(); const find = (x) => { if (x.has_style_class_name && x.has_style_class_name('nook-notes-search')) return x; for (const c of x.get_children()) { const r = find(c); if (r) return r; } return null; }; globalThis.__s = find(n._tabHosts.get('notes')); return !!__s; })()" true
nnx_check search-filters "(() => { const n = $NNX; __s.set_text('milk'); const q = (x, cls) => { let c = 0; const w = y => { if (y.has_style_class_name && y.has_style_class_name(cls)) c++; y.get_children().forEach(w); }; w(x); return c; }; const host = n._tabHosts.get('notes'); return [q(host, 'nook-postit'), q(host, 'nook-postit-add'), __s.get_parent() !== null]; })()" '[1,0,true]'
nnx_check search-clears "(() => { const n = $NNX; __s.set_text(''); const q = (x, cls) => { let c = 0; const w = y => { if (y.has_style_class_name && y.has_style_class_name(cls)) c++; y.get_children().forEach(w); }; w(x); return c; }; return q(n._tabHosts.get('notes'), 'nook-postit-add'); })()" 1
# Every card has a delete cross, hidden until hover; pressing it removes the note with an undo.
nnx_check delete-cross "(() => { const n = $NNX; const all = []; const w = y => { if (y.has_style_class_name && y.has_style_class_name('nook-postit-del')) all.push(y); y.get_children().forEach(w); }; w(n._tabHosts.get('notes')); const before = n._prod.notes.length; const hidden = all.every(d => d.opacity === 0); all[0].emit('button-press-event', null); return [all.length, hidden, n._prod.notes.length === before - 1, !!n._notesUndo]; })()" '[3,true,true,true]'
# The clear colour is a real note colour: dot in the editor, no tint on the board card.
nnx_check clear-colour "(() => { const n = $NNX; const id = n._prod.addNote('see-through', 'clear'); const ok = n._prod.getNote(id).color === 'clear'; n._notesUi.showBoard(); const find = (x) => { if (x.has_style_class_name && x.has_style_class_name('nook-postit-clear')) return x; for (const c of x.get_children()) { const r = find(c); if (r) return r; } return null; }; const card = !!find(n._tabHosts.get('notes')); n._notesUi.showEditor(id); const dots = []; const w = y => { if (y.has_style_class_name && y.has_style_class_name('nook-postit-dot')) dots.push(y); y.get_children().forEach(w); }; w(n._tabHosts.get('notes')); n.collapse(); return [ok, card, dots.length]; })()" '[true,true,6]'
