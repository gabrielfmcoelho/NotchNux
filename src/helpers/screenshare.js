import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { logError } from './log.js';

// Watches for screen sharing / recording, the way GNOME's own remote-access
// indicator does: the backend's remote-access controller announces every new
// RemoteAccessHandle (screen cast, remote desktop), and the screenshot UI
// reports its own built-in screencast through a property.
//
// Handles created BEFORE NotchNux was enabled never emit 'new-handle', so a
// remote-desktop / screen-cast share that was already running is invisible to
// us until another one starts (the controller API cannot list existing
// handles). The screenshot-UI screencast is covered: its state is read live.
export class ScreenShareWatch {
    constructor(onChange) {
        this._onChange = onChange;
        this._handles = new Set();   // alive handles
        this._conns = [];            // [object, id] pairs to disconnect
        this._destroyed = false;

        try {
            let controller = global.backend?.get_remote_access_controller?.();
            if (controller && typeof controller.connect === 'function')
                this._conns.push([controller, controller.connect('new-handle',
                    (c, handle) => this._onNewHandle(c, handle))]);
        } catch (e) {
            logError('screen share: remote access controller unavailable', e);
        }

        try {
            let ui = Main.screenshotUI;
            if (ui && typeof ui.connect === 'function') {
                this._conns.push([ui, ui.connect('notify::screencast-in-progress',
                    () => this._changed())]);
                // At shell teardown the UI is disposed before our destroy()
                // runs; forget it then rather than disconnecting a dead object.
                let destroyId = ui.connect('destroy', () => {
                    this._conns = this._conns.filter(c => c[0] !== ui);
                });
                this._conns.push([ui, destroyId]);
            }
        } catch (e) {
            logError('screen share: screenshot UI unavailable', e);
        }
    }

    // Read live (not cached), so a screencast already running when NotchNux
    // starts is seen on the first update.
    _screencasting() {
        try {
            return !!Main.screenshotUI?.screencast_in_progress;
        } catch (e) {
            return false;
        }
    }

    // `controller` is unused; kept so the signature matches the signal.
    _onNewHandle(controller, handle) {
        if (this._destroyed || !handle) return;
        this._handles.add(handle);
        try {
            let id = handle.connect('stopped', () => {
                this._handles.delete(handle);
                try { handle.disconnect(id); } catch (e) { /* already gone */ }
                this._conns = this._conns.filter(c => c[1] !== id);
                this._changed();
            });
            this._conns.push([handle, id]);
        } catch (e) {
            logError('screen share: cannot watch handle', e);
        }
        this._changed();
    }

    _changed() {
        if (this._destroyed) return;
        try { this._onChange?.(); } catch (e) { logError('screen share: change callback', e); }
    }

    get active() {
        return this._handles.size > 0 || this._screencasting();
    }

    get recording() {
        if (this._screencasting()) return true;
        for (let h of this._handles) {
            if (h.is_recording) return true;
        }
        return false;
    }

    // End every share and the screenshot-UI screencast.
    stop() {
        for (let h of [...this._handles]) {
            try {
                if (typeof h.stop === 'function') h.stop();
            } catch (e) {
                logError('screen share: stop failed', e);
            }
        }
        try {
            let ui = Main.screenshotUI;
            if (this._screencasting() && typeof ui.stopScreencast === 'function')
                ui.stopScreencast();
        } catch (e) {
            logError('screen share: stopScreencast failed', e);
        }
    }

    destroy() {
        this._destroyed = true;
        for (let [obj, id] of this._conns) {
            try { obj.disconnect(id); } catch (e) { /* already gone */ }
        }
        this._conns = [];
        this._handles.clear();
    }
}
