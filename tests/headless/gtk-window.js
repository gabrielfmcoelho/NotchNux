// A plain 600x400 GTK 4 window for the headless shell's stacking checks.
// Run with WAYLAND_DISPLAY set to the test shell's socket; ARGV[0] is the title.
imports.gi.versions.Gtk = '4.0';
const { Gtk, GLib } = imports.gi;

Gtk.init();
const loop = new GLib.MainLoop(null, false);
const win = new Gtk.Window({ title: ARGV[0] || 'nnx-stack-window', default_width: 600, default_height: 400 });
win.set_child(new Gtk.Label({ label: 'NotchNux stacking check' }));
win.connect('close-request', () => { loop.quit(); return false; });
win.present();
loop.run();
