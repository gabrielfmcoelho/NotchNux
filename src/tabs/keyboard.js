// Keyboard access: the global shortcut that opens and closes the notch.
//
// Methods mixed into the NotchNux actor, like tabs/dev.js.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { logError } from '../helpers/log.js';

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
            Main.wm.addKeybinding('toggle-notch', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleFromKeyboard());
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

    // Open when closed, close when open. Never reopens or stacks a second
    // modal grab: expand() is a no-op while open, collapse() while closed.
    _toggleFromKeyboard() {
        if (this._destroyed)
            return;
        if (this.isExpanded) {
            this._openedByKeyboard = false;
            this.collapse();
        } else {
            this._openedByKeyboard = true;
            this.expand();
        }
    },
};

export function installKeyboard(proto) {
    for (let [name, fn] of Object.entries(KeyboardFeatures))
        proto[name] = fn;
}
