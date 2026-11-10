"""Wearables, drawn at the animal's own scale into the empty slots of its frames.

Each item is a function of the animal's geometry (rig.GEO: species, neck joint, skull ellipse, eye,
ear joints, long_ears) returning {"slot", "rest": {layer: [svg]}, "stream"?: {layer: [svg]}, "ears"?: (far, near)}.
Layers: back and neck are in body space (over the body and arm, under the head); head0, head1,
head2 are in head space (under the far ear, between skull and near ear, over everything).
"stream" replaces the rest layers it names on the stretched-out leap frames; "ears" turns the ears (degrees).
rig.py writes these into <animal>/wear.json; bump ART_VERSION whenever an item's drawing changes,
so outfits composed from older art are not reused.
Shapes are plain path points (turned here, never with a transform), so the rig can measure them.
Two tones: the body's grey, or the accent. Anything worn is accent or changes the outline.
"""
import math, re
from rig import fill, rbar, thick_curve, ellipse, poly

ART_VERSION = 2
EYE_R = 6.2          # the open eye's radius (rig.eye_open); a hat's lower edge stays clear of it


def accent(d):
    return fill(d, "success")


def turn(d, deg, cx, cy):
    """Path d turned `deg` clockwise about (cx, cy)."""
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    rot = lambda m: f"{cx + (float(m[1]) - cx) * c - (float(m[2]) - cy) * s:.2f} {cy + (float(m[1]) - cx) * s + (float(m[2]) - cy) * c:.2f}"
    return re.sub(r"(-?[\d.]+) (-?[\d.]+)", rot, d)


def ellipse_pts(cx, cy, rx, ry, n=64):
    return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]


def above(pts, p, slope):
    """The polygon cut to the part above the line through p with the given slope (Sutherland-Hodgman)."""
    side = lambda q: (p[1] + slope * (q[0] - p[0])) - q[1]          # > 0: above the line
    out = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        if side(a) >= 0:
            out.append(a)
        if (side(a) >= 0) != (side(b) >= 0):
            t = side(a) / (side(a) - side(b))
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def brow(g, tilt):
    """A hat's lower edge: the line just over the eye, rising toward the face by `tilt` degrees."""
    ex, ey = g["eye"]
    return (ex, ey - EYE_R - 1.2), -math.tan(math.radians(tilt))


def top_at(g, x):
    cx, cy, rx, ry = g["skull"]
    return cy - ry * math.sqrt(max(0, 1 - ((x - cx) / rx) ** 2))


# ---------------------------------------------------------------- neck: under the chin, over the chest
def band(g, r):
    nx, ny = g["neck"]
    return accent(rbar(nx - 9, ny - 1, nx + 7, ny + 8, r))


def collar(g, w):
    """A thin band round the neck, dipping at the throat."""
    nx, ny = g["neck"]
    return accent(thick_curve((nx - 9, ny - 2), (nx - 1, ny + 10), (nx + 8, ny + 7), w, w))


def scarf(g):
    nx, ny = g["neck"]
    tails = [accent(thick_curve((nx + 6, ny + 7), (nx + 10, ny + 15), (nx + 8, ny + 25), 8, 8.5)),       # two ends down the chest,
             accent(thick_curve((nx + 3, ny + 8), (nx + 1, ny + 15), (nx - 3, ny + 21), 6.5, 6.5))]      # parted at the knot
    fly = [accent(thick_curve((nx - 4, ny + 1), (nx - 18, ny - 18), (nx - 42, ny - 19), 9, 6.5)),      # and streaming behind in a leap,
           accent(thick_curve((nx - 4, ny + 4), (nx - 18, ny - 6), (nx - 34, ny - 6), 7, 5))]          # clear of the back
    return {"slot": "neck", "rest": {"neck": [band(g, 5)] + tails}, "stream": {"neck": [band(g, 5)] + fly}}


def bandana(g):
    nx, ny = g["neck"]
    return {"slot": "neck", "rest": {"neck": [collar(g, 4.6), accent(poly([(nx - 5, ny + 3), (nx + 11, ny + 9), (nx + 3, ny + 22)]))]}}


def bell(g):
    nx, ny = g["neck"]
    return {"slot": "neck", "rest": {"neck": [collar(g, 4.4), accent(ellipse(nx + 7, ny + 13, 4.8, 4.8, 0, 18))]}}


def bow(g):
    nx, ny = g["neck"]
    x, y = nx + 7, ny + 9
    wing = lambda s: accent(poly([(x, y), (x + s * 8, y - 6), (x + s * 9.5, y), (x + s * 8, y + 6)]))
    return {"slot": "neck", "rest": {"neck": [collar(g, 4.4), wing(-1), wing(1), accent(ellipse(x, y, 2.6, 2.6, 0, 12))]}}


# ---------------------------------------------------------------- back: from the nape over the back
def smooth(pts, k=3):
    """A closed polygon with its corners rounded off (Chaikin)."""
    for _ in range(k):
        pts = [q for a, b in zip(pts, pts[1:] + pts[:1]) for q in ((a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25),
                                                                   (a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75))]
    return poly(pts)


def cape(g):
    nx, ny = g["neck"]
    # tied at the throat, over the back a little proud of it, the hem flaring to a point behind
    tie = accent(rbar(nx - 2, ny - 4, nx + 6, ny + 5, 2.4))
    rest = [(nx - 1, ny - 7), (nx + 3, ny + 3), (nx - 4, ny + 23), (nx - 12, ny + 27), (nx - 19, ny + 21), (nx - 27, ny + 28),
            (nx - 33, ny + 21), (nx - 41, ny + 25), (nx - 24, ny + 1)]
    fly = [(nx - 1, ny - 7), (nx + 3, ny + 3), (nx - 14, ny + 7), (nx - 30, ny + 6), (nx - 50, ny + 10), (nx - 43, ny),
           (nx - 54, ny - 12), (nx - 34, ny - 16), (nx - 16, ny - 13)]
    return {"slot": "back", "rest": {"back": [tie, accent(smooth(rest, 1))]}, "stream": {"back": [tie, accent(smooth(fly, 2))]}}


# ---------------------------------------------------------------- head: hats over the skull, ears through or beside
def straw(g):
    cx, cy, rx, ry = g["skull"]
    ex, ey = g["eye"]
    t = -5                                                     # tipped back a little
    bx, by = cx + 1, ey - EYE_R - 1.4 - 4.8                    # the brim's lower edge clears the eye
    brim = turn(ellipse(bx, by, rx + 8, 4.8, 0, 48), t, bx, by)   # 9.6 units thick: 2 px at pill size
    hx = cx - 1
    crown = turn(poly(above(ellipse_pts(hx, by, 11.5, 15), (hx, by), 0)), t, bx, by)
    ribbon = turn(rbar(hx - 8.6, by - 6.2, hx + 8.6, by - 6.2, 2.0), t, bx, by)        # inside the crown
    # crown behind the near ear, brim in front of it: the ear rises out of the crown in every pose, even laid back asleep
    return {"slot": "head", "rest": {"head1": [accent(crown), fill(ribbon)], "head2": [accent(brim)]},
            "ears": (0, 0) if g["long_ears"] else (-8, 8)}


def beanie(g):
    cx, cy, rx, ry = g["skull"]
    p, slope = brow(g, 10)
    r, gap = 3.0, 1.4                                          # the cuff, and a seam of the head showing above it
    yb = p[1] + slope * (cx - 1 - p[0])
    cap = ellipse_pts(cx - 1, yb, rx + 1.5, yb - (cy - ry) + 13)
    rim = [q for q in above(cap, p, slope) if abs(q[1] - (p[1] + slope * (q[0] - p[0]))) < 0.01]
    (ax, ay), (bx, by) = min(rim), max(rim)
    cuff = rbar(ax - 0.5, ay - r, bx + 1, by - r, r)
    dome = poly(above(cap, (p[0], p[1] - 2 * r - gap), slope))
    top = min(y for _, y in cap)
    if g["long_ears"]:
        pom = ellipse(cx - rx * 0.55, top + 3.5, 4.3, 4.3, 0, 16)        # at the back: the ears come out of the top
        ears = (6, -3)                                                     # long ears rise through, close together
    else:
        pom = ellipse(cx - 1, top - 1.5, 4.3, 4.3, 0, 16)
        ears = (-8, 8)
    # dome behind the near ear, cuff in front of it, as the straw hat
    return {"slot": "head", "rest": {"head1": [accent(dome), accent(pom)], "head2": [accent(cuff)]}, "ears": ears}


def crown(g):
    cx, cy, rx, ry = g["skull"]
    x = cx - 2
    y = top_at(g, x) + 1.5
    pts = [(x - 12, y), (x + 12, y), (x + 13.5, y - 12), (x + 6.5, y - 5.5), (x, y - 14), (x - 6.5, y - 5.5), (x - 13.5, y - 12)]   # 24 wide: 5.7 px on the pill
    t = -12
    shapes = [turn(poly(pts), t, x, y)] + [turn(ellipse(px, py, 2.7, 2.7, 0, 12), t, x, y) for px, py in (pts[2], pts[4], pts[6])]
    return {"slot": "head", "rest": {"head2": [accent(s) for s in shapes]}, "ears": (-6, 8) if g["long_ears"] else (-8, 8)}


def party(g):
    cx, cy, rx, ry = g["skull"]
    if g["long_ears"]:
        x, t = g["ears"][1][0] + 3, 24                     # in front of the long ears, on the forehead
    else:
        x, t = (g["ears"][0][0] + g["ears"][1][0]) / 2, 12  # between the ears
    y = top_at(g, x) + 1.5
    cone = poly([(x - 8, y), (x + 8, y), (x, y - 25)])
    pom = ellipse(x, y - 25, 3.6, 3.6, 0, 12)
    return {"slot": "head", "rest": {"head2": [accent(turn(cone, t, x, y)), accent(turn(pom, t, x, y))]},
            "ears": (-4, 4)}


ITEMS = {"straw": straw, "beanie": beanie, "crown": crown, "party": party,
         "scarf": scarf, "bandana": bandana, "bell": bell, "bow": bow, "cape": cape}
