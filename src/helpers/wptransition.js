// Animated wallpaper changes on the desktop (the "swww"-style reveal).
//
// GNOME draws the desktop background itself and, when picture-uri changes,
// just cross-fades. To get a riced reveal we draw the NEW wallpaper ourselves
// first: one Meta.BackgroundActor per monitor — GNOME's own background
// renderer, so the image is scaled/cropped exactly as the real one will be —
// placed in the window group directly above the desktop background and below
// every window. A GLSL mask uncovers it (a circle growing out of the notch, a
// slanted wipe, or a fade). Only when the reveal is finished do we write
// picture-uri; GNOME then loads the same file (already in Mutter's image
// cache) underneath us and runs its own swap, after which the overlay —
// now pixel-identical to what's below — is quietly removed.
//
// The overlay is monitor-sized and never resizes during the animation, so the
// effect's offscreen buffer is allocated once; per frame only a uniform moves.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import { SnippetEffect } from './shader.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const TRANSITIONS = ['grow', 'wipe', 'fade', 'none'];
export const TRANSITION_LABELS = ['Grow from notch', 'Slanted wipe', 'Fade', 'None'];

// GNOME 46–50 have Meta.BackgroundImageCache + Meta.Background.set_file();
// GNOME 51 removed both and only takes textures (set_texture).
const HAS_IMAGE_CACHE = typeof Meta.BackgroundImageCache?.get_default === 'function';

// Decode an image file off the main thread into a Cogl texture (GNOME 51+).
async function loadTexture(file) {
    let stream = await new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try { resolve(f.read_finish(res)); } catch (e) { reject(e); }
        });
    });
    let pixbuf = await new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (s, res) => {
            try { resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res)); } catch (e) { reject(e); }
        });
    });
    stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
    pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;
    let ctx = global.stage.context.get_backend().get_cogl_context();
    return Cogl.Texture2D.new_from_data(ctx,
        pixbuf.get_width(), pixbuf.get_height(),
        pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
        pixbuf.get_rowstride(), pixbuf.get_pixels());
}

const DURATION = { grow: 1100, wipe: 950, fade: 700 };
// After picture-uri is written GNOME cross-fades its own actors for 1 s
// (background.js FADE_ANIMATION_TIME); stay on top until that's over.
const HANDOFF_MS = 1250;
const LOAD_TIMEOUT_MS = 4000;

const DECLS = `
uniform vec2 size;
uniform vec2 origin;
uniform float progress;
uniform float mode;
`;

// mode 0 = grow (circle from origin), 1 = slanted wipe, 2 = fade.
// A soft feathered edge plus a faint light rim riding the edge for grow/wipe.
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
float a;
float rim = 0.0;
if (mode < 0.5) {
    float far = max(max(length(origin), length(origin - vec2(size.x, 0.0))),
                    max(length(origin - vec2(0.0, size.y)), length(origin - size)));
    float feather = 40.0;
    float r = progress * (far + feather);
    float d = length(p - origin);
    a = clamp((r - d) / feather, 0.0, 1.0);
    rim = clamp(1.0 - abs(r - feather * 0.5 - d) / (feather * 0.6), 0.0, 1.0)
        * (1.0 - progress);
} else if (mode < 1.5) {
    float lean = size.y * 0.35;
    float feather = 56.0;
    float edge = progress * (size.x + lean + feather) - feather;
    float s = p.x + lean * (1.0 - p.y / size.y);
    a = clamp((edge + feather - s) / feather, 0.0, 1.0);
    rim = clamp(1.0 - abs(edge + feather * 0.5 - s) / (feather * 0.5), 0.0, 1.0)
        * (1.0 - progress);
} else {
    a = progress;
}
vec4 c = cogl_color_out;
c.rgb = mix(c.rgb, vec3(c.a), rim * 0.28);
cogl_color_out = c * a;
`;

const RevealMask = GObject.registerClass(
class RevealMask extends SnippetEffect {
    static snippetDeclarations = DECLS;
    static snippetCode = CODE;

    _init(width, height, origin, mode) {
        super._init();
        this.setUniform('size', 2, [width, height]);
        this.setUniform('origin', 2, origin);
        this.setUniform('mode', 1, [mode]);
        this.setProgress(0);
    }

    setProgress(p) {
        this.setUniform('progress', 1, [p]);
        this.queue_repaint();
    }
});

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutQuart(t) {
    return 1 - Math.pow(1 - t, 4);
}

export class WallpaperTransition {
    constructor() {
        // GNOME's own wallpaper schema (always installed), not one of ours.
        this._bgSettings = Gio.Settings.new('org.gnome.desktop.background');
        this._style = 'grow';
        this._run = null;
        this._fading = new Set();
    }

    setStyle(style) {
        this._style = TRANSITIONS.includes(style) ? style : 'grow';
    }

    // Reveal `path` on the desktop, then call commit() (which writes
    // picture-uri). commit is always called exactly once, even when the
    // animation is skipped or something fails.
    play(path, commit) {
        // A newer change interrupts an older one: land the old one instantly.
        this._finish(true);
        // Overlays still fading out already match the committed wallpaper
        // below them; drop them so they can't sit on top of the new reveal.
        for (let a of this._fading)
            a.destroy();
        this._fading.clear();

        let style = this._style;
        let uri = Gio.File.new_for_path(path).get_uri();
        let skip = style === 'none'
            || !St.Settings.get().enable_animations
            || Main.layoutManager.screenTransition?.visible
            || Main.sessionMode.isLocked
            || this._bgSettings.get_string('picture-uri') === uri
            || !Main.layoutManager._backgroundGroup;
        if (skip) {
            commit();
            return;
        }

        let run = {
            commit, committed: false, actors: [], masks: [],
            timeline: null, sources: [], imageSignal: null, image: null,
            file: null, texture: null,
        };
        this._run = run;

        let start = () => {
            if (this._run !== run)
                return;
            try {
                this._start(run, run.file, style);
            } catch (e) {
                logError(e, 'NotchNux: wallpaper transition');
                this._finish(true);
            }
        };
        let waitForLoad = () => {
            // Never hold the change hostage to a slow/broken decode.
            run.sources.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOAD_TIMEOUT_MS, () => {
                if (this._run === run)
                    this._finish(true);
                return GLib.SOURCE_REMOVE;
            }));
        };

        try {
            run.file = Gio.File.new_for_path(path);
            if (HAS_IMAGE_CACHE) {
                // GNOME 46–50: Mutter decodes and caches the image itself.
                let image = Meta.BackgroundImageCache.get_default().load(run.file);
                if (image.is_loaded()) {
                    start();
                } else {
                    run.image = image;
                    run.imageSignal = image.connect('loaded', () => {
                        image.disconnect(run.imageSignal);
                        run.imageSignal = null;
                        start();
                    });
                    waitForLoad();
                }
            } else {
                // GNOME 51+: Mutter no longer loads files, so decode here and
                // hand Meta.Background a ready texture.
                waitForLoad();
                loadTexture(run.file).then(texture => {
                    run.texture = texture;
                    start();
                }).catch(e => {
                    logError(e, 'NotchNux: wallpaper transition');
                    if (this._run === run)
                        this._finish(true);
                });
            }
        } catch (e) {
            logError(e, 'NotchNux: wallpaper transition');
            this._finish(true);
        }
    }

    _start(run, file, style) {
        let group = Main.layoutManager._backgroundGroup;
        let parent = group.get_parent();
        let bgStyle = this._bgSettings.get_enum('picture-options');
        let mode = style === 'wipe' ? 1 : style === 'fade' ? 2 : 0;
        let primary = Main.layoutManager.primaryMonitor;

        for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
            let m = Main.layoutManager.monitors[i];
            let background = new Meta.Background({ meta_display: global.display });
            if (run.texture)
                background.set_texture(run.texture, bgStyle, null);
            else
                background.set_file(file, bgStyle);
            let actor = new Meta.BackgroundActor({
                meta_display: global.display, monitor: i,
                x: m.x, y: m.y, width: m.width, height: m.height,
                reactive: false,
            });
            actor.content.set({ background, vignette: false });
            // Grow from the notch: top centre of the primary monitor, expressed
            // in this monitor's coordinates (so it sweeps across monitors).
            let ox = primary ? primary.x + primary.width / 2 - m.x : m.width / 2;
            let oy = primary ? primary.y - m.y : 0;
            let mask = new RevealMask(m.width, m.height, [ox, oy], mode);
            actor.add_effect(mask);
            parent.insert_child_above(actor, group);
            run.actors.push(actor);
            run.masks.push(mask);
        }

        let duration = DURATION[style] ?? 1000;
        let ease = style === 'fade' ? easeOutQuart : easeInOutCubic;
        let tl = new Clutter.Timeline({ actor: run.actors[0], duration });
        tl.connect('new-frame', () => {
            let p = ease(Math.min(1, tl.get_elapsed_time() / duration));
            for (let m of run.masks)
                m.setProgress(p);
        });
        tl.connect('completed', () => {
            if (this._run !== run)
                return;
            for (let m of run.masks)
                m.setProgress(1);
            this._commit(run);
            // GNOME now swaps its own actors underneath; leave once it's done.
            run.sources.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, HANDOFF_MS, () => {
                run.sources = [];
                if (this._run === run)
                    this._fadeOut(run);
                return GLib.SOURCE_REMOVE;
            }));
        });
        run.timeline = tl;
        tl.start();
    }

    _commit(run) {
        if (run.committed)
            return;
        run.committed = true;
        try {
            run.commit();
        } catch (e) {
            logError(e, 'NotchNux: wallpaper commit');
        }
    }

    _fadeOut(run) {
        this._run = null;
        let actors = run.actors;
        run.actors = [];
        for (let a of actors) {
            this._fading.add(a);
            a.connect('destroy', () => this._fading.delete(a));
            a.ease({
                opacity: 0, duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => a.destroy(),
            });
        }
    }

    // Tear the current run down. `commit` lands its wallpaper if it hadn't
    // been written yet (interrupted or failed run).
    _finish(commit) {
        let run = this._run;
        if (!run)
            return;
        this._run = null;
        run.timeline?.stop();
        run.timeline = null;
        for (let id of run.sources)
            GLib.Source.remove(id);
        run.sources = [];
        if (run.imageSignal) {
            run.image.disconnect(run.imageSignal);
            run.imageSignal = null;
        }
        for (let a of run.actors)
            a.destroy();
        run.actors = [];
        if (commit)
            this._commit(run);
    }

    destroy() {
        this._finish(true);
        for (let a of this._fading)
            a.destroy();
        this._fading.clear();
        this._bgSettings = null;
    }
}
