// Test helper: show one activity and stay on the bus (so it is not reaped as
// a vanished sender) for N seconds. Prints the id.
// Usage: gjs -m tests/headless/activity-holder.js SECONDS TITLE BODY ICON PROGRESS TIMEOUT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [secs, title, body, icon, progress, timeout] = ARGV;
const r = Gio.DBus.session.call_sync('io.github.notchnux', '/io/github/notchnux/Activities',
    'io.github.notchnux.Activities', 'Show',
    new GLib.Variant('(sssdu)', [title, body, icon, Number(progress), Number(timeout)]),
    null, Gio.DBusCallFlags.NONE, 5000, null);
print(r.deepUnpack()[0]);
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Number(secs), () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
