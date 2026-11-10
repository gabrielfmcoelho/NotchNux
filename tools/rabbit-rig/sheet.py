"""Contact sheet of the shipped companion art with items worn, composed the way the shell composes it.

    python3 tools/rabbit-rig/sheet.py <out.png> [--items a,b,...]

Per animal: a bare column, then each item, on the sitting, mid-leap, sleeping and sitting-with-the-earpiece
frames, each at 4x (128 px), yard size (64 px) and pill size (32 px) side by side. Reads src/companions.
"""
import json, os, sys
import gi
gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg
import cairo

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "companions")
SLOTS = ("back", "neck", "head0", "head1", "head2")
BODY, ACCENT, BG, INK = "#c8c7d4", "#a78bfa", (0.04, 0.04, 0.05), (0.6, 0.6, 0.65)


def compose(template, layers, ears):
    """The frame text: each slot comment replaced by its layer, each ear wrapper turned by its extra."""
    for s in SLOTS:
        template = template.replace(f"<!--{s}-->", layers.get(s, ""))
    for e, extra in zip(("far", "near"), ears):
        template = template.replace(f'data-ear="{e}" transform="rotate(0 ', f'data-ear="{e}" transform="rotate({extra:g} ')
    return template


def draw(cr, svg, x, y, size):
    h = Rsvg.Handle.new_from_data(svg.replace("#bebebe", BODY).replace("#73d216", ACCENT).encode())
    r = Rsvg.Rectangle()
    r.x, r.y, r.width, r.height = x, y, size, size
    h.render_document(cr, r)


def main(out, items):
    S = 128                                # 4x the 32 px icon
    CW = S + 4 + 64 + 4 + 32 + 12          # each pose at 4x, yard and pill size side by side
    animals = ("rabbit", "cat", "fox")
    cols = [None] + items
    block = 4 * S + 8                      # four poses
    W, H = 70 + CW * len(cols), 16 + block * len(animals)
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)
    cr.set_source_rgb(*BG)
    cr.paint()
    cr.set_font_size(11)
    for i, iid in enumerate(cols):
        cr.set_source_rgb(*INK)
        cr.move_to(70 + i * CW + 4, 12)
        cr.show_text(iid or "bare")
    for a, sp in enumerate(animals):
        d = os.path.join(ROOT, sp)
        spec = json.load(open(os.path.join(d, "acts.json")))
        lib = json.load(open(os.path.join(d, "wear.json")))
        leap = next(f for f in spec["acts"]["hop"]["frames"] if f in spec["stream"])
        poses = [("sit", spec["acts"]["sit"]["frames"][0]), ("leap", leap), ("sleep", spec["acts"]["sleep"]["frames"][0]),
                 ("music", spec["acts"]["sit@music"]["frames"][0])]     # a hat and the earpiece can be on together
        oy = 16 + a * block
        cr.set_source_rgb(*INK)
        for j, (label, _) in enumerate(poses):
            cr.move_to(4, oy + j * S + S / 2)
            cr.show_text(f"{sp} {label}" if j == 0 else label)
        for i, iid in enumerate(cols):
            it = lib["items"].get(iid) if iid else None
            if iid and not it:
                sys.exit(f"{sp}: no item {iid} in wear.json")
            ox = 70 + i * CW
            for j, (_, f) in enumerate(poses):
                layers = ({**it["rest"], **it.get("stream", {})} if f in spec["stream"] else it["rest"]) if it else {}   # as the shell merges them
                svg = compose(open(os.path.join(d, f)).read(), layers, it.get("ears", (0, 0)) if it else (0, 0))
                y = oy + j * S
                draw(cr, svg, ox, y, S)
                draw(cr, svg, ox + S + 4, y + S - 64, 64)              # yard size, on the same ground line
                draw(cr, svg, ox + S + 4 + 64 + 4, y + S - 32, 32)     # pill size
    surf.write_to_png(out)
    print(out, W, H)


if __name__ == "__main__":
    args = sys.argv[1:]
    out = args[0]
    lib0 = json.load(open(os.path.join(ROOT, "rabbit", "wear.json")))
    items = args[args.index("--items") + 1].split(",") if "--items" in args else list(lib0["items"])
    main(out, items)
