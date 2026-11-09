// Keyboard access: the global shortcut that opens and closes the notch.
//
// Methods mixed into the NotchNux actor, like tabs/dev.js.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { logError } from '../helpers/log.js';
import { TAB_DEFS } from '../helpers/config.js';
import { parseCommand } from '../helpers/commands.js';
import { VERTICAL } from '../helpers/compat.js';

// 0.1+0.2 -> 0.3, and never "-0".
function formatCalc(value) {
    let n = Number(Number(value).toPrecision(12));
    return String(Object.is(n, -0) ? 0 : n);
}

const KeyboardFeatures = {
    _initKeyboard() {
        this._settings = null;
        this._openedByKeyboard = false;
        this._keybindingAdded = false;
        // A manual install that skipped glib-compile-schemas has no compiled
        // schema: only the shortcut is lost, the extension still runs.
        try {
            this._settings = this.extension?.getSettings() ?? null;
        } catch (e) {
            logError('shortcut unavailable (settings schema not compiled?)', e);
            return;
        }
        if (!this._settings)
            return;
        try {
            // POPUP too: the notch's own grab runs in that mode, and the
            // shortcut must still close a notch the command bar is typing in.
            Main.wm.addKeybinding('toggle-notch', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this._onShortcut());
            this._keybindingAdded = true;
        } catch (e) {
            logError('could not register the notch shortcut', e);
        }
    },

    _destroyKeyboard() {
        if (this._keybindingAdded) {
            this._keybindingAdded = false;
            try {
                Main.wm.removeKeybinding('toggle-notch');
            } catch (e) {
                logError('could not remove the notch shortcut', e);
            }
        }
        this._settings = null;
    },

    // The shortcut fired. Opening is allowed from the desktop and the
    // overview (which holds a modal of its own); a panel menu or dialog
    // (POPUP, SYSTEM_MODAL, ...) keeps the keyboard, so don't open over it.
    _onShortcut() {
        const canOpen = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        if (!this.isExpanded && !(Main.actionMode & canOpen))
            return;
        this._toggleFromKeyboard();
    },

    // Open when closed, close when open. Never reopens or stacks a second
    // modal grab: expand() is a no-op while open, collapse() while closed.
    _toggleFromKeyboard() {
        if (this._destroyed)
            return;
        if (this.isExpanded) {
            this.collapse();
            return;
        }
        // expand() shows and focuses the command bar when this is set.
        this._commandBarWanted = true;
        try {
            this.expand();
        } catch (e) {
            this._commandBarWanted = false;
            if (this._commandBar) this._commandBar.visible = false;
            throw e;
        }
        this._openedByKeyboard = true;
    },

    // ---- Dashboard keys -------------------------------------------------

    _focusIsTextField() {
        let f = global.stage.get_key_focus();
        return !!f && (f instanceof St.Entry || f instanceof Clutter.Text || !!this._typables?.has(f));
    },

    // Captured phase: arrows, Ctrl+N and Tab only (see _onDashboardEscape).
    _onDashboardKey(event) {
        if (!this.isExpanded)
            return Clutter.EVENT_PROPAGATE;
        let sym = event.get_key_symbol();
        let state = event.get_state();
        if ((state & Clutter.ModifierType.CONTROL_MASK) && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            let id = this._tabOrder[sym - Clutter.KEY_1];
            if (id)
                this._switchTab(id);
            return id ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }
        if ((sym === Clutter.KEY_Left || sym === Clutter.KEY_Right) && !this._focusIsTextField()) {
            this._switchTabRelative(sym === Clutter.KEY_Left ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            let back = sym === Clutter.KEY_ISO_Left_Tab || (state & Clutter.ModifierType.SHIFT_MASK);
            let from = global.stage.get_key_focus();
            if (!from || !this._isDescendant(from))
                from = null;
            this.navigate_focus(from,
                back ? St.DirectionType.TAB_BACKWARD : St.DirectionType.TAB_FORWARD, true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    },

    // Bubble phase: an Esc no field or overlay handled. In an open note it
    // goes back to the board; anywhere else it closes the notch.
    _onDashboardEscape(event) {
        if (!this.isExpanded || event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        if (this._notesEscape())
            return Clutter.EVENT_STOP;
        this.collapse();
        return Clutter.EVENT_STOP;
    },

    // ---- Command bar ----------------------------------------------------

    _buildCommandBar() {
        this._commandBar = new St.BoxLayout({
            style_class: 'nook-command-bar', ...VERTICAL, x_expand: true, visible: false });
        this._commandEntry = new St.Entry({
            style_class: 'nook-command-entry', hint_text: 'Task, 25 (focus), =math, n note, or a tab',
            can_focus: true, x_expand: true });
        this._commandHint = new St.Label({ style_class: 'nook-command-hint', text: '' });
        this._commandBar.add_child(this._commandEntry);
        this._commandBar.add_child(this._commandHint);

        let text = this._commandEntry.clutter_text;
        text.connect('text-changed', () => this._updateCommandHint());
        text.connect('activate', () => this._submitCommand());
        // Connected before _makeTypable so Esc collapses (which releases the
        // grab) instead of only releasing it; EVENT_STOP skips _makeTypable's.
        text.connect('key-press-event', (a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        });
        this._makeTypable(this._commandEntry);
        return this._commandBar;
    },

    // Called from expand(): show the bar only for keyboard opens.
    _syncCommandBar() {
        if (!this._commandBar)
            return;
        let on = !!this._commandBarWanted;
        this._commandBar.visible = on;
        if (!on)
            return;
        this._commandEntry.set_text('');
        this._updateCommandHint();
        this._commandEntry.clutter_text.grab_key_focus();
    },

    _commandTabs() {
        return TAB_DEFS.filter(t => this._tabOrder.includes(t.id));
    },

    _updateCommandHint() {
        if (!this._commandHint)
            return;
        this._commandHint.text = this._previewCommand(
            parseCommand(this._commandEntry.get_text(), this._commandTabs()));
    },

    _previewCommand(cmd) {
        switch (cmd.kind) {
        case 'task': return `Add task '${cmd.text}'${cmd.starred ? ' \u2605' : ''}`;
        case 'focus': return `Start ${cmd.minutes} min focus`;
        case 'calc': return cmd.error ? cmd.error : `= ${formatCalc(cmd.value)} \u2014 Enter copies`;
        case 'tab': return `Open ${this._tabs[cmd.id]?.label ?? cmd.id}`;
        case 'note': return `Add note '${cmd.text}'`;
        default: return '';
        }
    },

    // Enter in the command entry.
    _submitCommand() {
        let cmd = parseCommand(this._commandEntry.get_text(), this._commandTabs());
        let handled = false;
        try {
            handled = this._runCommand(cmd);
        } catch (e) {
            logError('command failed', e);
        }
        if (handled && cmd.kind !== 'calc' && cmd.kind !== 'tab')
            this.collapse();
    },

    // true = handled. Calc stays open (result copied); a tab command opens
    // that tab and stays open; everything else lets _submitCommand close.
    _runCommand(cmd) {
        switch (cmd.kind) {
        case 'task':
            this._prod.addTask((cmd.starred ? '!' : '') + cmd.text);
            return true;
        case 'focus':
            this._prod.setFocusMinutes(cmd.minutes);
            this._prod.startFocus();
            return true;
        case 'note': {
            try {
                this._prod.addNote(cmd.text);
            } catch (e) {
                if (e.message !== 'TooManyNotes')
                    throw e;
                Main.notify('NotchNux', 'Too many notes (50). Delete one first.');
            }
            return true;
        }
        case 'tab':
            this._switchTab(cmd.id);
            return true;
        case 'calc':
            if (cmd.error)
                return false;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, formatCalc(cmd.value));
            return true;
        default:
            return false;
        }
    },
};

export function installKeyboard(proto) {
    for (let [name, fn] of Object.entries(KeyboardFeatures))
        proto[name] = fn;
}
