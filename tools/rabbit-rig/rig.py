"""Rabbit rig: an original side-view rabbit built from simple shapes, posed per frame, written as
symbolic SVGs (one fill colour; the headphones use the symbolic "success" class).

    python3 -I rig.py <frames-dir> <acts.json>
    python3 -I rig.py --try <out.png> '<json list of poses>'      # calibration / model sheet

Drawn in its rest pose: sitting, facing right, ground at y=100 (units). Anatomy: pear body, big
round haunch with a long flat hind foot, slim front leg with a paw, round head with snout and an
eye cut out, two long ears (near and far), a cotton tail.
Bones: root (squash/stretch/tilt about the feet) > body > {tail, hind @hip, arm @shoulder,
head @neck > {ear_far, ear_near}}. Pose values: root (dx, dy, rot, sx, sy); every other bone
(dx, dy, rot[, length]), rot clockwise in degrees, length < 1 folds a limb toward its joint.
Every frame is grounded: shifted so its lowest point touches the grass.
Hop arcs are not baked in: acts.json has per-frame y offsets the shell tweens.
"""
import json, math, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "out")
os.makedirs(CACHE, exist_ok=True)


# ---------------------------------------------------------------- shapes
def poly(pts):
    return "M " + " L ".join(f"{x:.2f} {y:.2f}" for x, y in pts) + " Z"


def ellipse(cx, cy, rx, ry, rot=0, n=40):
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x, y = rx * math.cos(t), ry * math.sin(t)
        pts.append((cx + x * c - y * s, cy + x * s + y * c))
    return poly(pts)


def leaf(bx, by, tx, ty, w, n=16):
    # an ear from base to tip: widest a third of the way up, rounded tip
    L = math.hypot(tx - bx, ty - by)
    ux, uy = (tx - bx) / L, (ty - by) / L
    nx, ny = -uy, ux
    half = lambda t: w / 2 * math.sin(math.pi * min(1, t * 1.5) / 2) * (1 - t) ** 0.35
    side = lambda sgn: [(bx + ux * L * t + nx * sgn * half(t), by + uy * L * t + ny * sgn * half(t)) for t in [i / n for i in range(n + 1)]]
    base = [(bx + nx * w * 0.42, by + ny * w * 0.42), (bx - nx * w * 0.42, by - ny * w * 0.42)]
    return poly([base[0]] + side(1)[1:] + side(-1)[::-1][:-1] + [base[1]])


def rbar(x0, y0, x1, y1, r):
    # rounded bar (stadium) from (x0,y0) to (x1,y1), radius r
    a = math.atan2(y1 - y0, x1 - x0)
    pts = [(x1 + r * math.cos(a + t), y1 + r * math.sin(a + t)) for t in [math.pi * (i / 10 - 0.5) for i in range(11)]]
    pts += [(x0 + r * math.cos(a + t), y0 + r * math.sin(a + t)) for t in [math.pi * (i / 10 + 0.5) for i in range(11)]]
    return poly(pts)


def arc_band(cx, cy, r0, r1, a0, a1, n=20):
    p = lambda r, a: (cx + r * math.cos(math.radians(a)), cy - r * math.sin(math.radians(a)))
    return poly([p(r1, a0 + (a1 - a0) * i / n) for i in range(n + 1)] + [p(r0, a1 - (a1 - a0) * i / n) for i in range(n + 1)])


def thick_curve(p0, p1, p2, w0, w1, n=18):
    # a tapering stroke along a quadratic curve, as a filled outline (tails)
    pts = [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
            (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]) for t in [i / n for i in range(n + 1)]]
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(n, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1
        w = (w0 + (w1 - w0) * i / n) / 2
        left.append((x - dy / L * w, y + dx / L * w))
        right.append((x + dy / L * w, y - dx / L * w))
    return poly(left + right[::-1])


def tri_ear(bx, by, tx, ty, w, tip=3.0):
    # a blunt triangle ear: wide base, rounded tip of radius `tip`
    L = math.hypot(tx - bx, ty - by)
    ux, uy = (tx - bx) / L, (ty - by) / L
    nx, ny = -uy, ux
    k = (L - tip) / L
    cx, cy = bx + ux * L * k, by + uy * L * k      # tip circle centre
    a = math.atan2(uy, ux)
    cap = [(cx + tip * math.cos(a + t), cy + tip * math.sin(a + t)) for t in [math.pi * (i / 8 - 0.5) for i in range(9)]]
    # the cap runs from the -n side to the +n side, so the base points go the same way (no bow-tie)
    return poly([(bx - nx * w / 2, by - ny * w / 2)] + cap + [(bx + nx * w / 2, by + ny * w / 2)])


# ---- the tech motif, at a size that survives 22 px: GNOME symbolic icons want main
# features >= 2 px and no 1 px strokes; here 1 px is ~4.2 units.
PX = 4.2


EYE_STYLE = os.environ.get("EYE", "button")


def eye_open(cx, cy):
    if EYE_STYLE == "button":      # big round eye, a grey highlight dot left inside it (even-odd)
        return ellipse(cx, cy, 6.2, 6.2, 0, 22) + " " + ellipse(cx + 2.2, cy - 2.2, 1.9, 1.9, 0, 10)
    if EYE_STYLE == "visor":       # dark rounded bar across the face; the accent pupil is drawn separately
        return rbar(cx - 9, cy, cx + 5, cy, 3.6)
    return node_eye(cx, cy)


def eye_closed(cx, cy):
    if EYE_STYLE == "button":      # a happy arc
        return arc_band(cx, cy + 3.5, 3.6, 6, 15, 165)
    if EYE_STYLE == "visor":
        return rbar(cx - 9, cy, cx + 5, cy, 1.6)
    return slit(cx, cy)


def eye_accent(cx, cy, dx=0):
    # visor pupil: an accent dot that slides inside the bar when it looks around
    return [ellipse(cx + 1.5 + dx, cy, 2.6, 2.6, 0, 12)] if EYE_STYLE == "visor" else []


def node_eye(cx, cy):
    # the logo's mark, a line ending in a node, cut out of the head: reads as a visor eye.
    # dot r 4.6 (~2.2 px), slot 5.6 tall (~1.3 px) running back from it
    return (ellipse(cx, cy, 4.6, 4.6, 0, 18) + " "
            + poly([(cx - 9.5, cy - 2.8), (cx - 3.6, cy - 2.8), (cx - 3.6, cy + 2.8), (cx - 9.5, cy + 2.8)]))


def slit(cx, cy):
    return poly([(cx - 9.5, cy - 1.5), (cx + 4.6, cy - 1.5), (cx + 4.6, cy + 1.5), (cx - 9.5, cy + 1.5)])


def headphones(cx, cy, r, style):
    """Headphones on a head centred (cx, cy) with radius r. Side view, facing right.
    band: cup on the near ear + thick band over the skull.  muffs: two cups (the far one
    peeks over the top) joined by a band.  bud: one big earbud, no band."""
    cup = ellipse(cx - r * 0.55, cy + r * 0.05, 6.5, 7)
    if style == "band":
        return [cup, arc_band(cx, cy + 2, r + 1, r + 7.5, 20, 160)]
    if style == "muffs":
        far = ellipse(cx + r * 0.1, cy - r - 3, 5.5, 4)
        return [cup, far, arc_band(cx, cy + 2, r + 0.5, r + 7, 60, 160)]
    if style == "clip":          # a solid muff on the side of the head + a short thick clip up the ear, no headband
        mx, my = cx - r * 0.5, cy + r * 0.05
        return [ellipse(mx, my, 7, 7.5), rbar(mx + 1, my - 6, mx + 3, my - r * 0.95 - 2, 2.8)]
    if style == "neckband":      # a bud at the ear + a collar band at the neck
        return [ellipse(cx - r * 0.5, cy + r * 0.05, 5, 5.5), arc_band(cx, cy + 4, r - 1, r + 5.5, 215, 330)]
    return [ellipse(cx - r * 0.55, cy + r * 0.05, 7.5, 8), poly([(cx - r * 0.55 - 2, cy + 6), (cx - r * 0.55 + 2, cy + 6), (cx - r * 0.55 + 1, cy + 16), (cx - r * 0.55 - 3, cy + 16)])]


PHONES_STYLE = os.environ.get("PHONES", "clip")


def species(skull, eye, ears, body, hind, arm, tail, nodes, phones, joints, snout=None):
    """Shapes + joints for one companion. `nodes` are accent dots (~2 px) on the tips of its
    longest feature: the logo's line-ending-in-a-node, carried by the body itself."""
    extra = snout.split(" | ") if snout else []
    skull_d = ellipse(*skull)
    return {
        "SHAPES": {
            "body": [body],
            "tail": [tail],
            "hind": hind,
            "arm": arm,
            "head_open": [skull_d + " " + eye_open(*eye)] + extra,
            "head_closed": [skull_d + " " + eye_closed(*eye)] + extra,
            "ear_far": [ears[0]],
            "ear_near": [ears[1]],
        },
        "NODES": nodes,        # {bone: [accent shapes]}
        "EYE": eye,
        "SKULL": skull,        # (cx, cy, rx, ry): where wearables sit on the head
        "PHONES": phones,
        "J": joints,
    }


# Proportions follow the cute-creature rule of thumb: head ~ 60 / body ~ 40 of the visual
# mass (never 50/50), circles and triangles, short limbs; the one or two traits that
# identify the animal are exaggerated so the black silhouette alone names it.
SPECIES = {
    "rabbit": species(
        skull=(66, 58, 16, 14.5), snout=ellipse(77, 64, 8, 6.5),      # round head + cheek
        eye=(72, 55),
        ears=(leaf(58, 46, 47, 6, 14), leaf(66, 45, 65, 3, 15)),
        body=ellipse(42, 82, 23, 16, -8),
        hind=[ellipse(31, 86, 14.5, 13.5), rbar(26, 97.4, 50, 97.4, 2.6)],
        arm=[rbar(58, 80, 61, 95, 4.4), ellipse(62.5, 97.2, 5, 2.8)],
        tail=ellipse(17, 80, 6.5, 6),
        nodes={"ear_far": [ellipse(48.6, 12.5, 3.3, 3.3, 0, 14)], "ear_near": [ellipse(65.2, 10, 3.5, 3.5, 0, 14)]},   # LEDs in the ear tips
        phones=headphones(66, 58, 15, PHONES_STYLE),
        joints={"root": (44, 100), "hip": (31, 86), "shoulder": (58, 80), "neck": (60, 68),
                "ear_far": (58, 46), "ear_near": (66, 45), "tail": (19, 80)}),
    "cat": species(
        skull=(60, 53, 15.5, 13.5), eye=(66, 50),
        snout=ellipse(69, 60, 7, 5),
        ears=(tri_ear(51, 41, 44, 24, 19, 4), tri_ear(67, 40, 73, 23, 19, 4)),
        body=ellipse(44, 79, 19, 19, -35),
        hind=[ellipse(36, 87, 13.5, 12.5), rbar(30, 97.4, 48, 97.4, 2.6)],
        arm=[rbar(53, 72, 56, 95, 4.4), ellipse(57, 97.2, 4.8, 2.8)],
        tail=thick_curve((26, 93), (2, 92), (7, 66), 7, 6),
        nodes={"tail": [ellipse(7, 65, 4.2, 4.2, 0, 14)]},
        phones=headphones(60, 53, 14.5, PHONES_STYLE),
        joints={"root": (42, 100), "hip": (36, 87), "shoulder": (53, 72), "neck": (54, 62),
                "ear_far": (51, 41), "ear_near": (67, 40), "tail": (26, 93)}),
    "fox": species(
        skull=(61, 56, 14.5, 12.5), eye=(66, 53),
        snout=poly([(68, 53), (83, 61), (82.5, 66), (67, 66.5)]) + " | " + ellipse(83.5, 63.5, 2.6, 2.6, 0, 12),
        ears=(tri_ear(53, 45, 49, 25, 18, 4), tri_ear(66, 43, 71, 24, 18, 4)),
        body=ellipse(42, 82, 24, 15, -10),
        hind=[ellipse(31, 87, 13.5, 12.5), rbar(26, 97.4, 48, 97.4, 2.6)],
        arm=[rbar(57, 82, 60, 95, 4.4), ellipse(61.5, 97.2, 4.8, 2.8)],
        tail=thick_curve((21, 86), (-2, 96), (-9, 74), 12, 13) + " " + ellipse(-9.5, 72, 4.6, 4.6, 0, 16),
        nodes={"tail": [ellipse(-9.5, 72, 2.8, 2.8, 0, 12)]},
        phones=headphones(61, 56, 13.5, PHONES_STYLE),
        joints={"root": (43, 100), "hip": (31, 87), "shoulder": (57, 82), "neck": (56, 66),
                "ear_far": (53, 45), "ear_near": (66, 43), "tail": (21, 86)}),
}
def fill(d, cls=None):
    if cls:
        return f'<path class="{cls}" fill="#73d216" d="{d}"/>'
    return f'<path fill="#bebebe" fill-rule="evenodd" d="{d}"/>'


SPECIES_NAME = os.environ.get("COMPANION", "rabbit")
SHAPES, NODES, PHONES, J, EYE_AT = (SPECIES[SPECIES_NAME][k] for k in ("SHAPES", "NODES", "PHONES", "J", "EYE"))
# what wear.py's items draw against, for the current animal
GEO = {"species": SPECIES_NAME, "neck": J["neck"], "skull": SPECIES[SPECIES_NAME]["SKULL"], "long_ears": SPECIES_NAME == "rabbit",
       "eye": EYE_AT, "ears": (J["ear_far"], J["ear_near"])}

# Frame box (units): the ~93-unit rabbit is ~22 px tall in a 32 px icon; room for ears and squash.
FX, FY, FW, FH = -20, -31, 135, 135
GROUND = 100


def pose(root=(0, 0, 0, 1, 1), eye="open", **bones):
    return {"root": root, "eye": eye, **bones}


def bone(p, name, joint, inner, extra_rot=0):
    dx, dy, rot, *ln = p.get(name, (0, 0, 0))
    rot += extra_rot
    k = ln[0] if ln else 1
    jx, jy = J[joint]
    fold = f" translate({jx} {jy}) scale({k} {k}) translate({-jx} {-jy})" if k != 1 else ""
    return f'<g transform="translate({dx} {dy}) rotate({rot} {jx} {jy}){fold}">{inner}</g>'


def svg_body(p):
    rdx, rdy, rrot, sx, sy = p["root"]
    px, py = J["root"]
    shapes = lambda k: "".join(fill(d) for d in SHAPES[k])
    nodes = lambda b: "".join(fill(d, "success") for d in NODES.get(b, []))
    phones = "".join(fill(d, "success") for d in PHONES) if p.get("phones") else ""
    # frames carry empty slots and ear wrappers that the shell's outfit composer fills
    # (an item's layer replaces <!--slot-->, its ear turn replaces "rotate(0 ")
    slot = lambda s: f"<!--{s}-->"
    ear = lambda e, inner: f'<g data-ear="{e}" transform="rotate(0 {J["ear_" + e][0]} {J["ear_" + e][1]})">{inner}</g>'
    head = bone(p, "head", "neck",
                slot("head0")
                + bone(p, "ear_far", "ear_far", ear("far", shapes("ear_far") + nodes("ear_far")))
                + shapes("head_open" if p["eye"] == "open" else "head_closed")
                + ("".join(fill(d, "success") for d in eye_accent(*EYE_AT, p.get("gaze", 0))) if p["eye"] == "open" else "") + phones
                + slot("head1")
                + bone(p, "ear_near", "ear_near", ear("near", shapes("ear_near") + nodes("ear_near")))
                + slot("head2"))
    body = (bone(p, "tail", "tail", shapes("tail") + nodes("tail")) + bone(p, "hind", "hip", shapes("hind")) + shapes("body")
            + slot("back") + bone(p, "arm", "shoulder", shapes("arm")) + slot("neck") + head)
    return (f'<g transform="translate({rdx} {rdy}) translate({px} {py}) rotate({rrot}) scale({sx} {sy}) '
            f'translate({-px} {-py})">{body}</g>')


def bbox_of(svg_text):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg_text)
    q = subprocess.run(["inkscape", "--query-all", f.name], capture_output=True, text=True, check=True).stdout
    os.unlink(f.name)
    rows = {r.split(",")[0]: tuple(map(float, r.split(",")[1:])) for r in q.strip().splitlines()}
    return rows["all"]


_ground = {}


def svg_for(p):
    inner = svg_body(p)
    if inner not in _ground:   # measure, then sit the lowest point on the ground
        b = bbox_of(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{FX} {FY} {FW} {FH}"><g id="all">{inner}</g></svg>')
        _ground[inner] = GROUND - (FY + b[1] + b[3])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{FX} {FY} {FW} {FH}">'
            f'<g transform="translate(0 {_ground[inner]:.2f})">{inner}</g></svg>\n')


def model_sheet(out_png, poses):
    tiles = []
    for i, p in enumerate(poses):
        svg = svg_for(p).replace("#bebebe", "#c4c2cc").replace("#73d216", "#7aa2ff")
        svg = svg.replace("</svg>", f'<line x1="{FX}" y1="{GROUND}" x2="{FX + FW}" y2="{GROUND}" stroke="#444" stroke-width="0.6"/></svg>')
        f = os.path.join(CACHE, f"_try{i}.svg")
        open(f, "w").write(svg)
        for w, suf in ((200, "b"), (32, "s")):
            subprocess.run(["inkscape", f, "-w", str(w), "-b", "#111", "-o", f"{f}.{suf}.png"], check=True, capture_output=True)
        tiles.append(f)
    subprocess.run(["magick", *[f"{t}.b.png" for t in tiles], "+append", f"{out_png}.b.png"], check=True)
    subprocess.run(["magick", *[f"{t}.s.png" for t in tiles], "-scale", "400%", "+append", f"{out_png}.s.png"], check=True)
    subprocess.run(["magick", f"{out_png}.b.png", f"{out_png}.s.png", "-append", out_png], check=True)


if __name__ == "__main__" and sys.argv[1] == "--try":
    raw = json.loads(sys.argv[3])
    model_sheet(sys.argv[2], [pose(**{k: tuple(v) if isinstance(v, list) else v for k, v in kw.items()}) for kw in raw])
    sys.exit(0)


# ---------------------------------------------------------------- poses
SIT = pose()


def P(**k):
    return {**SIT, **k}


EARS = lambda far, near=None: dict(ear_far=(0, 0, far), ear_near=(0, 0, far if near is None else near))
CROUCH = P(root=(0, 0, 0, 1.05, 0.9), arm=(0, 0, 10), head=(0, 3, 5), tail=(0, 2, 0), **EARS(-6))
CROUCH2 = P(root=(0, 0, 2, 1.08, 0.85), arm=(0, 0, 14), hind=(0, 0, -6), head=(0, 4, 7), tail=(0, 3, 0), **EARS(-10))
TAKEOFF = P(root=(0, 0, -16, 1.04, 1.04), hind=(0, 0, 28), arm=(0, 0, -35), head=(0, 0, 4), **EARS(-14))
LEAP = P(root=(0, 0, -10, 1.15, 0.92), hind=(0, 0, 35), arm=(0, 0, -55), head=(0, 0, -5), tail=(0, -2, 0), **EARS(-25))
REACH = P(root=(0, 0, 4, 1.1, 0.95), hind=(0, 0, 20), arm=(0, 0, -30), head=(0, 0, 0), **EARS(-15))       # front paws reach for the ground
LAND = P(root=(0, 0, 10, 1.05, 0.92), hind=(0, 0, -8), arm=(0, 0, -12), head=(0, 3, 8), tail=(0, 2, 0), **EARS(8))
SETTLE = P(root=(0, 0, 2, 1.02, 0.96), head=(0, 1, 3), **EARS(4))
STAND = P(root=(0, 0, -35, 1, 1), arm=(0, 0, -40, 0.8), head=(0, 0, 30), **EARS(10))
THUMP = P(root=(0, 0, -30, 1, 0.97), arm=(0, 0, -35, 0.8), head=(0, 0, 26), hind=(0, 0, -6), **EARS(14, 18))
BREATHE = P(root=(0, 0, 0, 0.99, 1.025), head=(0, -0.6, 0))                        # chest up: the in-breath
LOAF = dict(arm=(0, 0, 30, 0.6), head=(0, 6, 8), eye="closed", **EARS(-35))
SLEEP = P(root=(0, 0, 0, 1.05, 0.8), **LOAF)
SLEEP_IN = P(root=(0, 0, 0, 1.04, 0.83), **LOAF)
FLOP = P(root=(0, 0, 0, 1.18, 0.62), head=(0, 10, 30), hind=(0, 0, 40), arm=(0, 0, -60), eye="closed", **EARS(-40))
STRETCH = P(root=(0, 0, 4, 1.16, 0.88), arm=(0, 0, -50), hind=(0, 0, 25), head=(0, 4, -10), **EARS(-20))
TIRED = P(root=(0, 0, 0, 1.04, 0.84), arm=(0, 0, 25, 0.7), head=(0, 6, 12), eye="closed", **EARS(-28))
TWITCH = dict(tail=(0, -3, 0))
GROOM = lambda up, tilt: P(arm=(0, 0, -up, 0.8), head=(0, 4, tilt), **EARS(-4))

# act: (frames, y offsets in px at 1x per frame)
ACT_DEFS = {
    "sit":     ([SIT], [0]),
    "blink":   ([P(eye="closed"), P(eye="closed"), SIT], [0, 0, 0]),
    "flick":   ([P(**EARS(0, 14), **TWITCH), P(**EARS(-4, 22)), P(**EARS(0, 8), **TWITCH), P(**EARS(2, -4)), SIT], [0] * 5),
    "nibble":  ([P(head=(0, 4, 18)), P(head=(0, 6, 28), arm=(0, 0, 6)), P(head=(0, 5, 24)), P(head=(0, 6, 28), arm=(0, 0, 6)),
                 P(head=(0, 5, 24)), P(head=(0, 3, 12)), SIT], [0] * 7),
    "look":    ([P(head=(0, -1, -8)), P(head=(0, -2, -14), **EARS(6)), P(head=(0, -2, -14), **EARS(6), **TWITCH), P(head=(0, -2, -14), **EARS(4)),
                 P(head=(0, -1, -6)), SIT], [0] * 6),
    "perk":    ([P(head=(0, -1, -6), **EARS(10)), P(head=(0, -2, -10), **EARS(16), **TWITCH), P(head=(0, -2, -10), **EARS(16)),
                 P(head=(0, -1, -4), **EARS(8)), SIT], [0] * 5),
    "hop":     ([CROUCH, CROUCH2, TAKEOFF, LEAP, REACH, LAND, SETTLE, SIT], [0, 0, -2, -5, -4, 0, 0, 0]),
    "run":     ([CROUCH, TAKEOFF, LEAP, REACH, LAND, SETTLE], [0, -1, -4, -3, 0, 0]),
    "thump":   ([STAND, STAND, THUMP, STAND, THUMP, STAND, SETTLE, SIT], [0, -1, 1, -1, 1, -1, 0, 0]),       # thump frames dip 1 px: the impact
    "binky":   ([CROUCH, CROUCH2, TAKEOFF, P(**{**LEAP, "root": (0, 0, 18, 1.1, 0.95), "hind": (0, 0, 50), **EARS(-30, 10)}),
                 P(**{**LEAP, "root": (0, 0, -22, 1.1, 0.95), "hind": (0, 0, 10), **EARS(10, -30)}), REACH, LAND, SETTLE, SIT],
                [0, 0, -3, -7, -8, -5, 0, 0, 0]),
    "stretch": ([STRETCH, STRETCH, P(**{**STRETCH, "eye": "closed", "head": (0, 2, -18)}), STRETCH, SETTLE, SIT], [0] * 6),
    "sleep":   ([SLEEP], [0]),
    # rest-pose variants the player toggles on a slow timer: breathing
    "breathe": ([BREATHE], [0]),
    "sleepbreathe": ([SLEEP_IN], [0]),
    # dozing: sitting up, eyes shut, head nodding a little (a light nap)
    "doze":    ([P(eye="closed", head=(0, 2, 6), **EARS(-12))], [0]),
    "dozebreathe": ([P(root=(0, 0, 0, 0.99, 1.02), eye="closed", head=(0, 3, 9), **EARS(-14))], [0]),
    "sniff":   ([P(head=(0, 0, -4)), P(head=(0, 1, 3)), P(head=(0, 0, -4), **TWITCH), P(head=(0, 1, 3)), P(head=(0, 0, -2)), SIT], [0] * 6),
    "groom":   ([GROOM(45, 12), GROOM(80, 25), GROOM(70, 22), GROOM(80, 25), GROOM(60, 18), P(head=(0, 2, 8)), SIT], [0] * 7),
    # music: head bobs on the beat, the ears swing after it, the hind foot taps
    "bob":     ([P(head=(0, 2, 8), **EARS(4)), P(head=(0, 0, 0), hind=(0, 0, -8), **EARS(10)), P(head=(0, 2, 8), **EARS(2)),
                 P(head=(0, 0, 0), hind=(0, 0, -8), **EARS(9)), P(head=(0, 2, 8), **EARS(3)), P(head=(0, 0, 0), hind=(0, 0, -8), **EARS(8)),
                 P(head=(0, 1, 5)), SIT], [0] * 8),
    "flop":    ([SETTLE, P(root=(0, 0, 0, 1.08, 0.78), head=(0, 6, 16), eye="closed", **EARS(-25)), FLOP], [0, 0, 0]),
    # waking: a yawn (head back, eyes shut, mouth is implied by the tilt) and a shake (ears flap both ways)
    "yawn":    ([P(head=(0, -2, -10), eye="closed", **EARS(-6)), P(head=(0, -4, -22), eye="closed", **EARS(-14)),
                 P(head=(0, -4, -24), eye="closed", **EARS(-16)), P(head=(0, -4, -22), eye="closed", **EARS(-14)), P(head=(0, -2, -8), eye="closed"), SIT], [0] * 6),
    "shake":   ([P(head=(0, 0, -6), **EARS(-30, 20)), P(head=(0, 0, 6), **EARS(26, -24)), P(head=(0, 0, -6), **EARS(-28, 18)),
                 P(head=(0, 0, 5), **EARS(22, -20)), P(head=(0, 0, -3), **EARS(-12, 8)), P(head=(0, 0, 2), **EARS(6, -4)), SIT], [0] * 7),
    # digging: head down, front paw scrabbles (the dust is drawn by the player)
    "dig":     ([P(head=(0, 5, 22), arm=(0, 0, 25, 0.8), **EARS(-10)), P(head=(0, 6, 26), arm=(0, 0, -30, 0.85), **EARS(-14)),
                 P(head=(0, 6, 26), arm=(0, 0, 28, 0.8), **EARS(-14)), P(head=(0, 6, 26), arm=(0, 0, -30, 0.85), **EARS(-14)),
                 P(head=(0, 6, 26), arm=(0, 0, 28, 0.8), **EARS(-14)), P(head=(0, 4, 14), **EARS(-6)), SIT], [0] * 7),
    # sitting up to sniff the air: tall, nose up, ears forward
    "sniffup": ([P(root=(0, 0, -14, 0.98, 1.06), arm=(0, 0, -25, 0.85), head=(0, -1, -4), **EARS(8)),
                 P(root=(0, 0, -22, 0.97, 1.1), arm=(0, 0, -40, 0.8), head=(0, -2, -12), **EARS(14)),
                 P(root=(0, 0, -22, 0.97, 1.1), arm=(0, 0, -40, 0.8), head=(0, -2, -6), **EARS(16)),
                 P(root=(0, 0, -22, 0.97, 1.1), arm=(0, 0, -40, 0.8), head=(0, -2, -12), **EARS(14)),
                 P(root=(0, 0, -12, 0.98, 1.05), arm=(0, 0, -20, 0.85), head=(0, -1, -3), **EARS(6)), SIT], [0] * 6),
    # petted: eyes shut, leans into the hand, ears relax
    "pet":     ([P(root=(0, 0, -3, 1, 1), head=(0, 1, 6), eye="closed", **EARS(-10)), P(root=(0, 0, -6, 1.02, 0.98), head=(0, 2, 10), eye="closed", **EARS(-20)),
                 P(root=(0, 0, -6, 1.02, 0.98), head=(0, 2, 10), eye="closed", **EARS(-20)), P(root=(0, 0, -6, 1.02, 0.98), head=(0, 2, 10), eye="closed", **EARS(-22)),
                 P(root=(0, 0, -3, 1, 1), head=(0, 1, 5), eye="closed", **EARS(-10)), SIT], [0] * 6),
    # a hungry sigh: ears down, head lowers, a small breath out
    "sigh":    ([P(head=(0, 1, 4), **EARS(-10)), P(root=(0, 0, 0, 1.01, 0.97), head=(0, 3, 10), **EARS(-22)),
                 P(root=(0, 0, 0, 1.01, 0.97), head=(0, 3, 10), **EARS(-22)), P(head=(0, 2, 8), **EARS(-16)), P(head=(0, 1, 3), **EARS(-6)), SIT], [0] * 6),
    # shiver (rain): a 1 px side jitter, ears down
    "shiver":  ([P(root=(-1, 0, 0, 1, 0.98), **EARS(-30)), P(root=(1, 0, 0, 1, 0.98), **EARS(-32)), P(root=(-1, 0, 0, 1, 0.98), **EARS(-30)), P(root=(0, 0, 0, 1, 0.99), **EARS(-28))], [0] * 4),
    "tired":   ([TIRED], [0]),
}
# With music on, the idle acts play with headphones: "<act>@music".
for act in ("sit", "breathe", "blink", "flick", "look", "sniff", "nibble", "groom", "bob", "hop", "dig", "sniffup", "pet", "shake", "doze", "dozebreathe"):
    frames, ys = ACT_DEFS[act]
    ACT_DEFS[act + "@music"] = ([{**f, "phones": True} for f in frames], ys)

# Props on the grass (drawn in the pill's grey; the accent part is a "success" fill). Each is a
# small symbolic icon in a 24x24 box with the ground at y=22. Food has three states.
PROP_BOX = "0 0 24 24"
PROPS = {
    "mushroom": [fill(ellipse(12, 11, 9, 5.5)), fill(poly([(9, 12), (15, 12), (14.5, 22), (9.5, 22)])),
                 fill(ellipse(8.5, 10.2, 1.8, 1.6), "success"), fill(ellipse(14.5, 9.4, 1.6, 1.4), "success")],
    "bit": [fill(ellipse(12, 18, 3.6, 3.6, 0, 16), "success")],                        # the data bit it chases
    "flower-bud": [fill(rbar(12, 22, 12, 13, 1.3)), fill(ellipse(12, 11, 3, 3.6))],
    "flower": [fill(rbar(12, 22, 12, 14, 1.3))] + [fill(ellipse(12 + 4.2 * math.cos(math.radians(a)), 11 + 4.2 * math.sin(math.radians(a)), 3.2, 3.2, 0, 14)) for a in range(0, 360, 72)]
              + [fill(ellipse(12, 11, 2.6, 2.6, 0, 14), "success")],
    "leaf": [fill(poly([(2, 10), (12, 2), (22, 10), (12, 8)])), fill(rbar(12, 8, 12, 22, 1.4))],   # the rain shelter, a big leaf on a stem
    "drop": [fill(rbar(12, 6, 12, 16, 2.2))],
    "flake": [fill(ellipse(12, 12, 2.6, 2.6, 0, 12))],
}
FOOD = {
    "rabbit": {"whole": [fill(poly([(6, 10), (20, 7), (21, 11), (8, 16)]), "success"), fill(poly([(19, 4), (23, 6), (21, 9)]))],   # carrot + leaves
               "half": [fill(poly([(6, 10), (14, 8.3), (15, 12.3), (8, 16)]), "success")],
               "stub": [fill(poly([(6, 11), (10, 10), (10.5, 14), (8, 16)]), "success")]},
    "cat":    {"whole": [fill(ellipse(11, 12, 7, 4, -10)), fill(poly([(17, 12), (22, 8), (22, 16)]))],                          # fish
               "half": [fill(ellipse(13, 12, 4.5, 3.6, -10)), fill(poly([(17, 12), (22, 8), (22, 16)]))],
               "stub": [fill(poly([(17, 12), (22, 8), (22, 16)]))]},
    "fox":    {"whole": [fill(ellipse(9, 13, 3.2, 3.2, 0, 12), "success"), fill(ellipse(14, 10, 3.2, 3.2, 0, 12), "success"), fill(ellipse(15, 15, 3, 3, 0, 12), "success")],   # berries
               "half": [fill(ellipse(9, 13, 3.2, 3.2, 0, 12), "success"), fill(ellipse(15, 15, 3, 3, 0, 12), "success")],
               "stub": [fill(ellipse(15, 15, 3, 3, 0, 12), "success")]},
}


def write_props(out):
    for name, shapes in PROPS.items():
        open(os.path.join(out, f"prop-{name}-symbolic.svg"), "w").write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{PROP_BOX}">{"".join(shapes)}</svg>\n')
    for state, shapes in FOOD[SPECIES_NAME].items():
        open(os.path.join(out, f"food-{state}-symbolic.svg"), "w").write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{PROP_BOX}">{"".join(shapes)}</svg>\n')


def write_wear(out):
    """The item library (per item, the SVG text of each layer it draws into) and a 24x24 picture of each item."""
    sys.path.insert(0, HERE)                              # -I leaves the script's folder off the path
    sys.modules.setdefault("rig", sys.modules[__name__])  # wear.py's `import rig` gets this module, not a second copy
    import wear
    items = {}
    for iid, make in wear.ITEMS.items():
        it = make(GEO)
        out_it = {"slot": it["slot"], "rest": {k: "".join(v) for k, v in it["rest"].items()}}
        if "stream" in it:
            out_it["stream"] = {k: "".join(v) for k, v in it["stream"].items()}
        if "ears" in it:
            out_it["ears"] = list(it["ears"])
        # rest pose has identity bones, so the item's own coordinates are frame units: nothing below the feet
        pts = [(float(x), float(y)) for svg in out_it["rest"].values() for d in re.findall(r' d="([^"]*)"', svg)
               for x, y in re.findall(r"(-?[\d.]+) (-?[\d.]+)", d)]
        assert max(y for _, y in pts) <= GROUND, f"{iid} reaches below the feet ({max(y for _, y in pts)})"
        items[iid] = out_it
        # the picture: the rest shapes alone, in drawing order, centred and scaled to fill 22 of 24 units
        x0, x1 = min(x for x, _ in pts), max(x for x, _ in pts)
        y0, y1 = min(y for _, y in pts), max(y for _, y in pts)
        k = 22 / max(x1 - x0, y1 - y0)
        art = "".join(out_it["rest"].get(s, "") for s in ("back", "neck", "head0", "head1", "head2"))
        open(os.path.join(out, f"item-{iid}-symbolic.svg"), "w").write(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="translate(12 12) scale({k:.4f}) '
            f'translate({-(x0 + x1) / 2:.2f} {-(y0 + y1) / 2:.2f})">{art}</g></svg>\n')
    json.dump({"version": wear.ART_VERSION, "items": items}, open(os.path.join(out, "wear.json"), "w"), indent=1)
    return len(items)


if __name__ == "__main__":
    OUT, ACTS = sys.argv[1], sys.argv[2]
    os.makedirs(OUT, exist_ok=True)
    write_props(OUT)
    files, names, acts = {}, [], {}
    base_of = {}   # frame name -> pose
    for act, (frames, ys) in ACT_DEFS.items():
        assert len(frames) == len(ys), act
        idx = []
        for f in frames:
            svg = svg_for(f)
            if svg not in files:
                files[svg] = f"rabbit-{len(names):02d}-symbolic.svg"
                names.append(files[svg])
                open(os.path.join(OUT, files[svg]), "w").write(svg)
                base_of[files[svg]] = f
            idx.append(files[svg])
        acts[act] = {"frames": idx, "y": ys}
    # stretched out mid-leap: cloth streams behind
    stream = [n for n in names if base_of[n]["root"][3] > 1.08]
    json.dump({"fps": 12, "box": [FX, FY, FW, FH], "acts": acts, "stream": stream}, open(ACTS, "w"), indent=1)
    print(len(names), "frames,", len(acts), "acts,", write_wear(OUT), "items")
