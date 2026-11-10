// Composes what the companion wears into a folder of frames under the user's cache. No Shell imports.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const CACHE_ROOT = `${GLib.get_user_cache_dir()}/notchnux/companion`;
export const OUTFIT_KEEP = 6;

const SLOTS = ['back', 'neck', 'head0', 'head1', 'head2'];
const SLOT_OF = { back: 'back', neck: 'neck', head0: 'head', head1: 'head', head2: 'head' };

export function outfitKey(species, worn, version) {
    let ids = ['head', 'neck', 'back'].map(s => worn?.[s] || 'none');
    return ids.every(i => i === 'none') ? null : `${species}-${ids.join('-')}-v${version}`;
}

export function outfitLayers(lib, worn, streaming) {
    let layers = Object.fromEntries(SLOTS.map(s => [s, '']));
    let ears = [0, 0];
    for (let slot of ['head', 'neck', 'back']) {
        let item = lib.items?.[worn?.[slot]];
        if (!item || item.slot !== slot)
            continue;
        let shapes = streaming && item.stream ? { ...item.rest, ...item.stream } : item.rest;
        for (let l of SLOTS)
            if (SLOT_OF[l] === slot && shapes?.[l])
                layers[l] = shapes[l];
        if (slot === 'head' && item.ears)
            ears = item.ears;
    }
    return { layers, ears };
}

// Function replacers: layer text may hold `$`. Only the two ear wrappers' rotate(0 is touched.
export function composeFrame(template, layers, ears) {
    let out = template.replace(/<!--(back|neck|head0|head1|head2)-->/g, (_, s) => layers[s] ?? '');
    return out.replace(/(data-ear="(far|near)" transform=")rotate\(0 /g,
        (_, pre, which) => `${pre}rotate(${ears[which === 'far' ? 0 : 1]} `);
}

function usedAt(info) {
    let t = info.get_modification_date_time();
    return t.to_unix() * 1e6 + t.get_microsecond();
}

function rmTree(path) {
    let dir = Gio.File.new_for_path(path);
    if (dir.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) !== Gio.FileType.DIRECTORY) {
        dir.delete(null);
        return;
    }
    let en = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null), fi;
    while ((fi = en.next_file(null))) {
        let child = `${path}/${fi.get_name()}`;
        if (fi.get_file_type() === Gio.FileType.DIRECTORY)
            rmTree(child);
        else
            Gio.File.new_for_path(child).delete(null);
    }
    en.close(null);
    dir.delete(null);
}

// Leftovers, then all but the `keep` most recently used; a failure leaves the outfit worn.
function prune(cacheRoot, key, keep) {
    try {
        let old = [], en = Gio.File.new_for_path(cacheRoot).enumerate_children('standard::name,time::modified,time::modified-usec', 0, null), fi;
        while ((fi = en.next_file(null))) {
            let n = fi.get_name();
            if (n.endsWith('.tmp'))
                rmTree(`${cacheRoot}/${n}`);
            else if (n !== key)
                old.push({ n, t: usedAt(fi) });
        }
        en.close(null);
        old.sort((a, b) => b.t - a.t);
        for (let { n } of old.slice(Math.max(keep - 1, 0)))
            rmTree(`${cacheRoot}/${n}`);
    } catch (e) {
        console.warn(`NotchNux: companion outfit cache not pruned: ${e.message}`);
    }
}

// Never rewrite a folder: Shell keeps one texture per path until logout.
export function ensureOutfit({ srcDir, cacheRoot, species, worn, spec, lib, keep = OUTFIT_KEEP }) {
    try {
        let key = lib && outfitKey(species, worn, lib.version);
        if (!key)
            return srcDir;
        let dest = `${cacheRoot}/${key}`;
        GLib.mkdir_with_parents(cacheRoot, 0o700);
        if (GLib.file_test(dest, GLib.FileTest.IS_DIR)) {
            try {   // marks it recently used; a failure only risks an early prune
                let now = new Gio.FileInfo();
                now.set_modification_date_time(GLib.DateTime.new_now_utc());
                Gio.File.new_for_path(dest).set_attributes_from_info(now, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                console.warn(`NotchNux: companion outfit not marked used: ${e.message}`);
            }
        } else {
            let tmp = `${dest}.tmp`;
            if (GLib.file_test(tmp, GLib.FileTest.EXISTS))
                rmTree(tmp);
            GLib.mkdir_with_parents(tmp, 0o700);
            let names = [...new Set(Object.values(spec.acts).flatMap(a => a.frames))];
            let streams = new Set(spec.stream ?? []);
            let enc = new TextEncoder(), dec = new TextDecoder();
            let rest = outfitLayers(lib, worn, false), str = outfitLayers(lib, worn, true);
            for (let name of names) {
                let tpl = dec.decode(GLib.file_get_contents(`${srcDir}/${name}`)[1]);
                let o = streams.has(name) ? str : rest;
                GLib.file_set_contents(`${tmp}/${name}`, enc.encode(composeFrame(tpl, o.layers, o.ears)));
            }
            if (GLib.rename(tmp, dest) !== 0)
                throw new Error(`cannot rename ${tmp}`);
        }
        prune(cacheRoot, key, keep);
        return dest;
    } catch (e) {
        console.warn(`NotchNux: companion outfit not composed: ${e.message}`);
        return srcDir;
    }
}
