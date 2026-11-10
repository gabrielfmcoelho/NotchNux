"""Houses, drawn at the animals' own scale, in the frames' units (ground at y = 100, animal facing right).

    python3 -I tools/rabbit-rig/houses.py <out-dir>        # src/companions/houses

Per style four symbolic SVGs on one view box (BOX, wider than a frame so a house can be bigger than its
animal): `back` (behind the animal: bedding, the far wall), `front` (in front of it, the doorway cut out),
`light` (accent shapes at the door, shown while the animal sleeps inside) and `icon` (back and front
flattened, for the House card). houses.json gives the box and, per style, `door`: the x of the doorway's
centre. The lying animal goes there: its frame's centre (x = 47.5 in frame units) at `door`.
Two tones: the body grey, or the accent. Details are holes in the same path (even-odd), so they read in
one tone. Any animal can use any style.
"""
import json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -I leaves the script's folder off the path
from rig import fill, poly, ellipse, rbar, arc_band, leaf, GROUND

BOX = [-10, -50, 150, 150]
D = 62     # every style's doorway centre; the doorways are ~118 wide so the fox's tail is seen too


def lit(d):
    return fill(d, "success")


def band(pts, w):
    """A stroke of width w along a polyline, as a filled outline."""
    L, R = [], []
    for i, (x, y) in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        L.append((x - dy / n * w / 2, y + dx / n * w / 2))
        R.append((x + dy / n * w / 2, y - dx / n * w / 2))
    return poly(L + R[::-1])


def arch(cx, hw, top, shoulder, n=28):
    """A doorway from its left foot over the top to its right foot: straight sides up to `shoulder`, a half-ellipse above."""
    return ([(cx - hw, GROUND)] + [(cx - hw * math.cos(math.pi * i / n), shoulder - (shoulder - top) * math.sin(math.pi * i / n))
                                   for i in range(n + 1)] + [(cx + hw, GROUND)])


def in_arch(p, cx, hw, top, shoulder, m=0):
    x, y = (p[0] - cx) / (hw + m), p[1]
    return abs(x) < 1 and (y > shoulder or x * x + ((shoulder - y) / (shoulder - top + m)) ** 2 < 1)


def cut(outer, door):
    """One outline, left foot over the top to right foot, with the doorway (same direction) taken out of its bottom edge."""
    return poly(outer + door[::-1])


def dome(cx, hw, top, n=48):
    return [(cx - hw * math.cos(math.pi * i / n), GROUND - (GROUND - top) * math.sin(math.pi * i / n)) for i in range(n + 1)]


def lantern(x, y):
    """Hanging from (x, y): a hook, a little roof and the glowing body."""
    return lit(rbar(x, y, x, y + 4, 0.9) + " " + poly([(x - 4.2, y + 6), (x + 4.2, y + 6), (x + 2.2, y + 3.4), (x - 2.2, y + 3.4)])
               + " " + rbar(x, y + 9.5, x, y + 13, 4.2))


def bedding(x0, x1, y=95.5):
    """Straw or a cushion under the animal: a low bumpy strip on the floor."""
    n = 14
    return fill(poly([(x0, GROUND)] + [(x0 + (x1 - x0) * i / n, y - (1.6 if i % 2 else 0)) for i in range(n + 1)] + [(x1, GROUND)]))


# ---------------------------------------------------------------- styles
def burrow():
    # a grassy hill: its foot flares out (a hill, not an arch), grass on top, roots hanging in the mouth
    hill = lambda x: GROUND - 106 * max(0, 1 - ((x - 64) / 74) ** 2) ** 0.75
    outline = [(-10 + 148 * i / 60, hill(-10 + 148 * i / 60)) for i in range(61)]
    door = arch(D, 58, 23, GROUND)
    pebbles = [ellipse(36, 8, 3.4, 2.3, 0, 12), ellipse(86, 5, 3.6, 2.4, 0, 12), ellipse(122, 52, 3, 2.1, 0, 12),
               ellipse(1, 56, 3, 2.1, 0, 12), ellipse(60, -1, 2.4, 1.7, 0, 12), ellipse(128, 80, 2.4, 1.7, 0, 12)]
    tufts = [leaf(x + dx, hill(x) + 4, x + dx * 1.8 + lean, hill(x) + 4 - h, 5)
             for x, lean in ((24, -2), (52, 0), (80, 1), (106, 3)) for dx, h in ((-3.5, 10), (0, 15), (3.5, 11))]
    roots = [band([(34, 29), (33, 34), (35, 39)], 1.8), band([(41, 26), (42, 31)], 1.8), band([(88, 28), (89, 33)], 1.8)]
    tunnel = [(D - 50 * math.cos(math.pi * i / 24), GROUND - 68 * math.sin(math.pi * i / 24)) for i in range(3, 22)]
    return {"back": [fill(band(tunnel, 2.6)), bedding(6, 118)],
            "front": [fill(cut(outline, door) + " " + " ".join(pebbles)), fill(" ".join(tufts)), fill(" ".join(roots))],
            "light": [lantern(24, 41)]}


def basket():
    weave = " ".join(rbar(x + (7 if row else 0), y, x + 6 + (7 if row else 0), y, 1.4)
                     for row, y in enumerate((88.5, 94.5)) for x in range(6, 112, 14))
    body = poly([(-4, 80), (128, 80), (121, GROUND), (3, GROUND)])
    far = [(D - 64 * math.cos(math.pi * i / 24), 75 - 17 * math.sin(math.pi * i / 24)) for i in range(25)]
    return {"back": [fill(poly(far) + " " + " ".join(rbar(x, 68, x + 7, 68, 1.3) for x in range(16, 106, 14)))],
            "front": [fill(body + " " + weave), fill(rbar(-5, 79, 129, 79, 4)), fill(arc_band(D, 79, 60, 65, 9, 171))],
            "light": [lantern(104, 79 - math.sqrt(60 ** 2 - 42 ** 2))]}


def den():
    # a hollow old stump: broken off high on the left, roots flaring over the ground, a branch stub with a leaf
    top = [(2, -12), (6, -28), (12, -20), (20, -46), (27, -24), (34, -16), (46, -12), (58, -6), (72, -10), (86, -2), (100, -6),
           (112, 1), (122, -1)]
    outline = [(-10, GROUND), (-9, 95), (-4, 82), (-1, 62), (1, 30)] + top + [(124, 30), (126, 56), (130, 78), (136, 92), (140, GROUND)]
    door = arch(D, 56, 24, 58)
    bark = [rbar(x, y0, x, y1, 1.1) for x, y0, y1 in ((12, -8, 14), (20, -28, -6), (30, -6, 14), (96, 4, 16), (108, 6, 18))]
    knot = ellipse(62, 4, 4, 5.5, 0, 16)
    return {"back": [bedding(8, 116)],
            "front": [fill(cut(outline, door) + " " + " ".join(bark + [knot])),
                      fill(band([(120, 14), (130, 4), (136, -6)], 5)), fill(leaf(134, -4, 132, -22, 7))],
            "light": [lantern(24, 36)]}


def hutch():
    door = [(4, GROUND)] + [(4 + 14 - 14 * math.cos(math.pi / 2 * i / 8), 36 - 14 * math.sin(math.pi / 2 * i / 8)) for i in range(9)] \
        + [(106 + 14 * math.sin(math.pi / 2 * i / 8), 22 + 14 - 14 * math.cos(math.pi / 2 * i / 8)) for i in range(9)] + [(120, GROUND)]
    wall = [(-4, GROUND), (-4, 12), (D, -36), (128, 12), (128, GROUND)]
    mesh = [poly([(x, y), (x + 5.4, y), (x + 5.4, y + 5), (x, y + 5)]) for x in (52.4, 59.3, 66.2) for y in (-16, -9.3, -2.6)]
    planks = [rbar(2, 16, 118, 16, 0.8), rbar(14, 4, 44, 4, 0.8), rbar(80, 4, 110, 4, 0.8)]
    return {"back": [bedding(8, 116)],
            "front": [fill(cut(wall, door) + " " + " ".join(mesh + planks)),
                      fill(rbar(-5, 14, D, -44, 4.5)), fill(rbar(D, -44, 129, 14, 4.5)),             # the roof, overhanging
                      fill(poly([(-4, 96.5), (128, 96.5), (128, GROUND), (-4, GROUND)]))],          # the sill
            "light": [lit(" ".join(mesh)), lantern(28, 22)]}


def tent():
    door = [(3, GROUND), (D, -18), (121, GROUND)]
    flap = lambda s: band([(D + s * 2, -10), (D + s * 21, 34), (D + s * 34, 52), (D + s * 52, 82), (D + s * 60, 96)], 2.2)
    return {"back": [fill(rbar(D, -12, D, 92, 1.3)), bedding(8, 116)],
            "front": [fill(cut([(-8, GROUND), (D, -40), (132, GROUND)], door) + " " + flap(-1) + " " + flap(1)),
                      fill(rbar(D, -48, D, -34, 1.6)), fill(poly([(D + 1, -49), (D + 15, -45), (D + 1, -41)])),  # pole and pennant
                      fill(ellipse(D - 33, 50, 3.2, 3.2, 0, 14)), fill(ellipse(D + 33, 50, 3.2, 3.2, 0, 14))],          # the flaps' ties
            "light": [lantern(D, -2)]}


def mushroom():
    door = arch(D, 57, 26, 60)
    stem = [(-6, GROUND), (-2, 60), (2, 12), (122, 12), (126, 60), (130, GROUND)]
    cap = [(65 - 75 * math.cos(math.pi * i / 40), 12 - 60 * math.sin(math.pi * i / 40)) for i in range(41)] \
        + [(65 + 75 * math.cos(math.pi * i / 20), 12 - 7 * math.sin(math.pi * i / 20)) for i in range(21)]
    spots = [ellipse(26, -14, 9, 6.5, -20, 20), ellipse(68, -33, 11, 6.5, 0, 20), ellipse(108, -14, 9, 6.5, 20, 20),
             ellipse(48, -6, 5, 3.6, 0, 16), ellipse(88, -4, 5.5, 3.8, 0, 16), ellipse(6, 4, 3.5, 2.6, -30, 12)]
    return {"back": [bedding(8, 116)],
            "front": [fill(cut(stem, door)), fill(poly(cap) + " " + " ".join(spots))],
            "light": [lit(" ".join(spots)), lantern(26, 32)]}


def box():
    # a cardboard box standing open: flaps splayed at the top, taped, a doorway cut in its side
    face = [(-4, GROUND), (-4, 8), (128, 8), (128, GROUND)]
    door = arch(D, 56, 26, 58)
    crease = rbar(-2, 8, 126, 8, 1)                                                 # where the flaps fold
    tape = poly([(56, 9.5), (68, 9.5), (68, 20), (56, 20)])
    arrows = " ".join(poly([(x - 1.2, 2), (x + 1.2, 2), (x + 1.2, -6), (x + 3.6, -6), (x, -11), (x - 3.6, -6), (x - 1.2, -6)])
                      for x in (52, 62, 72))
    flaps = [poly([(-4, 7), (28, 7), (14, -22), (-10, -14)]), poly([(96, 7), (128, 7), (140, -14), (110, -22)]),
             poly([(22, 7), (102, 7), (98, -18), (26, -18)])]                       # left, right, and the back one between
    return {"back": [bedding(8, 116)],
            "front": [fill(cut(face, door) + " " + crease + " " + tape), fill(flaps[0]), fill(flaps[1]), fill(flaps[2] + " " + arrows)],
            "light": [lantern(24, 26)]}


STYLES = {"burrow": burrow, "basket": basket, "den": den, "hutch": hutch, "tent": tent, "mushroom": mushroom, "box": box}


def svg(shapes):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, BOX))}">{"".join(shapes)}</svg>\n'


if __name__ == "__main__":
    import re
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    styles = {}
    for name, make in STYLES.items():
        h = make()
        for part, shapes in h.items():
            for x, y in re.findall(r"(-?[\d.]+) (-?[\d.]+)", "".join(shapes)):
                assert BOX[0] <= float(x) <= BOX[0] + BOX[2] and BOX[1] <= float(y) <= BOX[1] + BOX[3], f"{name}/{part} leaves the box ({x}, {y})"
            open(os.path.join(out, f"house-{name}-{part}-symbolic.svg"), "w").write(svg(shapes))
        open(os.path.join(out, f"house-{name}-icon-symbolic.svg"), "w").write(svg(h["back"] + h["front"]))
        styles[name] = {"door": D}
    json.dump({"box": BOX, "styles": styles}, open(os.path.join(out, "houses.json"), "w"), indent=1)
    print(len(styles), "houses")
