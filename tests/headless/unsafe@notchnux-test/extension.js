// Test-only helper: org.gnome.Shell.Eval refuses to run unless unsafe_mode is on.
export default class UnsafeHelper {
    constructor(_metadata) {}
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
