"""Contact sheet of the shipped companion art with items worn, composed the way the shell composes it.

    python3 tools/rabbit-rig/sheet.py <out.png> [--items a,b,...]
    python3 tools/rabbit-rig/sheet.py <out.png> --houses

Per animal: a bare column, then each item, on the sitting, mid-leap, sleeping and sitting-with-the-earpiece
frames, each at 4x (128 px), yard size (64 px) and pill size (32 px) side by side. Reads src/companions.
--houses: per house style its icon, then per animal the house with the animal sitting beside it and lying inside
it (back, animal, front, door light), at yard size and at twice that.
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


def draw(cr, svg, x, y, size, body=BODY, alpha=1):
    h = Rsvg.Handle.new_from_data(svg.replace("#bebebe", body).replace("#73d216", ACCENT).encode())
    r = Rsvg.Rectangle()
    r.x, r.y, r.width, r.height = x, y, size, size
    cr.push_group()
    h.render_document(cr, r)
    cr.pop_group_to_source()
    cr.paint_with_alpha(alpha)


HOUSE, HOUSE_A = "#bfbdcc", 0.34          # the yard's .nn-pet-house colour, each layer its own actor


def houses(out):
    hd = os.path.join(ROOT, "houses")
    meta = json.load(open(os.path.join(hd, "houses.json")))
    bx, by, bw, _ = meta["box"]
    part = lambda st, p: open(os.path.join(hd, f"house-{st}-{p}-symbolic.svg")).read()
    animals = ("rabbit", "cat", "fox")
    frames = {}
    for sp in animals:
        spec = json.load(open(os.path.join(ROOT, sp, "acts.json")))
        frames[sp] = [open(os.path.join(ROOT, sp, spec["acts"][a]["frames"][i])).read() for a, i in (("sit", 0), ("sleep", -1))]

    def cell(cr, st, sp, x, y, S, inside):
        """The house at (x, y), its box drawn at round(S * 150 / 135) px, with the animal's S px frame in the same units."""
        hp = round(S * bw / 135)
        k = hp / bw
        draw(cr, part(st, "back"), x, y, hp, HOUSE, HOUSE_A)
        fx = (-20 + meta["styles"][st]["door"] - 47.5 - bx) if inside else 140     # frame left edge, in house units from bx
        if inside:
            draw(cr, frames[sp][1], x + fx * k, y + (-31 - by) * k, S)
        draw(cr, part(st, "front"), x, y, hp, HOUSE, HOUSE_A)
        if inside:
            draw(cr, part(st, "light"), x, y, hp)
        else:
            draw(cr, frames[sp][0], x + fx * k, y + (-31 - by) * k, S)
        return hp

    yard = 2 * (71 + 6) + 66                 # per animal: beside (house + animal), inside
    big = 142 + 8
    W = 80 + 56 + len(animals) * yard + len(animals) * big
    rowh = 142 + 26
    H = 16 + rowh * len(meta["styles"])
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(surf)
    cr.set_source_rgb(*BG)
    cr.paint()
    cr.set_font_size(11)
    for r, st in enumerate(meta["styles"]):
        oy = 16 + r * rowh
        cr.set_source_rgb(*INK)
        cr.move_to(4, oy + 70)
        cr.show_text(st)
        draw(cr, part(st, "icon"), 80, oy + 94, 48)                                  # the House card's picture
        for a, sp in enumerate(animals):
            ox = 80 + 56 + a * yard
            cr.set_source_rgb(*INK)
            cr.move_to(ox, oy + 10)
            cr.show_text(f"{sp} (yard)")
            cell(cr, st, sp, ox, oy + 142 - 71, 64, False)
            cell(cr, st, sp, ox + 71 + 66 + 6, oy + 142 - 71, 64, True)
            bx2 = 80 + 56 + len(animals) * yard + a * big
            cr.set_source_rgb(*INK)
            cr.move_to(bx2, oy + 10)
            cr.show_text(f"{sp} (2x)")
            cell(cr, st, sp, bx2, oy + 14, 128, True)
    surf.write_to_png(out)
    print(out, W, H)


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
    if "--houses" in args:
        sys.exit(houses(out))
    lib0 = json.load(open(os.path.join(ROOT, "rabbit", "wear.json")))
    items = args[args.index("--items") + 1].split(",") if "--items" in args else list(lib0["items"])
    main(out, items)
