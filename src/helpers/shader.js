// One base class for the fragment-snippet effects (island mask, slit deck,
// wallpaper reveal, rounded camera preview) that works on GNOME 46–51.
//
// Up to GNOME 50 these were Shell.GLSLEffect subclasses that add a snippet in
// vfunc_build_pipeline() and set uniforms by location. GNOME 51 removed
// Shell.GLSLEffect: the replacement is Clutter.ShaderEffect returning a
// Cogl.Snippet from vfunc_get_static_snippet(), with uniforms set by name.
// Both run the snippet at the FRAGMENT hook over the actor's offscreen
// texture, so the GLSL itself is the same on every version.
//
// Subclasses set static `snippetDeclarations` / `snippetCode` and call
// setUniform(name, components, values).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const HAS_GLSL_EFFECT = typeof Shell.GLSLEffect === 'function';

function declarationsOf(obj) {
    return obj.constructor.snippetDeclarations ?? '';
}

function codeOf(obj) {
    return obj.constructor.snippetCode ?? '';
}

export const SnippetEffect = HAS_GLSL_EFFECT
    ? GObject.registerClass({ GTypeName: 'NotchNuxSnippetEffect' },
        class SnippetEffect extends Shell.GLSLEffect {
            _init(params = {}) {
                super._init(params);
                this._locs = new Map();
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
                    declarationsOf(this), codeOf(this), false);
            }

            setUniform(name, components, values) {
                let loc = this._locs.get(name);
                if (loc === undefined) {
                    loc = this.get_uniform_location(name);
                    this._locs.set(name, loc);
                }
                this.set_uniform_float(loc, components, values);
            }
        })
    : GObject.registerClass({ GTypeName: 'NotchNuxSnippetEffect' },
        class SnippetEffect extends Clutter.ShaderEffect {
            vfunc_get_static_snippet() {
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
                    declarationsOf(this), codeOf(this));
            }

            setUniform(name, components, values) {
                this.set_uniform_float(name, components, values);
            }
        });
