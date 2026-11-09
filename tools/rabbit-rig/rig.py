"""Rabbit rig: the coelho lockup split into parts, posed per frame, written as symbolic SVGs.

    python3 -I rig.py <marca.tsx> <frames-dir> <acts.json>

Parts come from the visible rabbit (the lockup is 5 overlapping sub-paths filled even-odd, so the
parts are found by XOR-ing them in Inkscape and splitting the result). Each frame is a pose:
a root transform (squash, stretch, tilt about the feet) plus per-part offsets and rotations about
joints. Vertical travel (the hop arc) is NOT baked in: it goes to acts.json as per-frame y offsets,
so the shell can tween it at full frame rate while the pose steps at 12 fps.
"""
import json, os, re, subprocess, sys, tempfile

MARCA, OUT, ACTS = sys.argv[1:4]
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "out")
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT, exist_ok=True)


def inkscape(svg_text, actions, out):
    with tempfile.NamedTemporaryFile("w", suffix=".svg", delete=False) as f:
        f.write(svg_text)
    subprocess.run(["inkscape", f.name, f"--actions={actions};export-plain-svg;export-filename:{out};export-do"],
                   check=True, capture_output=True)
    os.unlink(f.name)


def paths_of(svg_file):
    s = open(svg_file).read()
    return {m.group(1): m.group(2) for m in re.finditer(r'<path[^>]*?\sd="([^"]+)"[^>]*?id="([^"]+)"', s)} or \
        {i: d for d, i in re.findall(r'<path[^>]*?id="([^"]+)"[^>]*?\sd="([^"]+)"', s)}


def path_ds(svg_file):
    # (id, d) pairs whatever the attribute order
    out = {}
    for tag in re.findall(r"<path\b[^>]*>", open(svg_file).read()):
        out[re.search(r'\bid="([^"]+)"', tag).group(1)] = re.search(r'\sd="([^"]+)"', tag).group(1)
    return out


# ---------------------------------------------------------------- parts
src = open(MARCA, encoding="utf-8").read()
VB, D = re.search(r'coelho: \{ viewBox: "([^"]+)", d: "([^"]+)"', src).groups()
VX, VY = map(float, VB.split()[:2])

pieces_svg = os.path.join(CACHE, "pieces.svg")
if not os.path.exists(pieces_svg):
    inkscape(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}"><path fill="#000" fill-rule="evenodd" d="{D}"/></svg>',
             "select-all;path-break-apart;select-all;path-exclusion;select-all;path-split", pieces_svg)


def bbox_all(svg_file):
    q = subprocess.run(["inkscape", "--query-all", svg_file], capture_output=True, text=True, check=True).stdout
    rows = [l.split(",") for l in q.strip().splitlines()[1:]]
    return {r[0]: tuple(map(float, r[1:])) for r in rows}


ds, boxes = path_ds(pieces_svg), bbox_all(pieces_svg)
area = lambda i: boxes[i][2] * boxes[i][3]
ids = sorted(ds, key=area)
sliver = ids[0]                                   # half of the foot node
rest = ids[1:]
ear2 = min(rest, key=lambda i: boxes[i][1] + boxes[i][3])        # highest bottom edge: the short ear
head = min((i for i in rest if i != ear2), key=lambda i: boxes[i][1])
haunch = min((i for i in rest if i not in (ear2, head)), key=lambda i: boxes[i][0])
body = next(i for i in rest if i not in (ear2, head, haunch))
assert len({ear2, head, haunch, body}) == 4

# Open eye: a bigger round hole than the logo's node, so it survives at ~18 px.
EYE = (VX + 234.6, VY + 115.4)
EYE_R = 15
head_open_svg = os.path.join(CACHE, "head-open.svg")
if not os.path.exists(head_open_svg):
    inkscape(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}"><path id="h" d="{ds[head]}"/>'
             f'<circle id="e" cx="{EYE[0]}" cy="{EYE[1]}" r="{EYE_R}"/></svg>',
             "select-all;path-difference", head_open_svg)
HEAD_OPEN = next(iter(path_ds(head_open_svg).values()))

PARTS = {
    "haunch": [ds[haunch], ds[sliver]],
    "body": [ds[body]],
    "head": None,                                 # open or closed eye, per pose
    "ear2": [ds[ear2]],
}

# Joints (absolute viewBox units) and the small-size "explode": the logo's ~10-unit gaps are under
# 1 px at pill size, so parts move apart to keep about 1.5 px between them.
J = {
    "root": (VX + 150, VY + 259),                 # feet, bottom centre
    "head": (VX + 186, VY + 147),                 # neck
    "ear2": (VX + 213, VY + 73),                  # where the short ear meets the head
    "haunch": (VX + 68, VY + 236),                # foot node
    "body": (VX + 150, VY + 200),
}
EXPLODE = {"ear2": (4, -9), "head": (3, -6), "body": (0, 0), "haunch": (-7, 3)}

# Frame box: rabbit plus room for ears going up and squash going wide.
FX, FY, FW, FH = VX - 14, VY - 24, 340, 290


def pose(root=(0, 0, 0, 1, 1), eye="open", **parts):
    return {"root": root, "eye": eye, **parts}


def svg_for(p):
    rdx, rdy, rrot, sx, sy = p["root"]
    px, py = J["root"]
    g = [f'<g transform="translate({rdx} {rdy}) translate({px} {py}) rotate({rrot}) scale({sx} {sy}) translate({-px} {-py})">']
    for name in ("haunch", "body", "head", "ear2"):
        dx, dy, rot = p.get(name, (0, 0, 0))
        ex, ey = EXPLODE[name]
        jx, jy = J[name]
        dlist = PARTS[name] or [HEAD_OPEN if p["eye"] == "open" else ds[head]]
        g.append(f'<g transform="translate({dx + ex} {dy + ey}) rotate({rot} {jx} {jy})">'
                 + "".join(f'<path fill="#bebebe" fill-rule="evenodd" d="{d}"/>' for d in dlist) + "</g>")
    g.append("</g>")
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{FX} {FY} {FW} {FH}">{"".join(g)}</svg>\n'


# ---------------------------------------------------------------- poses
SIT = pose(root=(0, 0, -5, 0.88, 1.02), haunch=(3, -2, 8))
P = lambda **k: pose(**{**{"root": SIT["root"]}, **k})
CROUCH = P(root=(0, 0, -2, 1.06, 0.86))
CROUCH2 = P(root=(0, 0, -1, 1.09, 0.81), haunch=(0, 0, 6))
TAKEOFF = P(root=(0, 0, -6, 0.93, 1.1), haunch=(0, 0, -14), ear2=(0, 0, -8))
AIR = P(root=(0, 0, -4, 1.0, 1.05), haunch=(0, 0, -6), ear2=(0, 0, -5))
AIR2 = P(root=(0, 0, 2, 1.0, 1.0), haunch=(0, 0, 4), ear2=(0, 0, 4))
LAND = P(root=(0, 0, 0, 1.09, 0.84), ear2=(0, 0, 10), head=(0, 0, 3))
SETTLE = P(root=(0, 0, -2, 0.96, 0.96), ear2=(0, 0, 4))
STAND = P(root=(0, 0, -24, 0.92, 1.14), ear2=(0, 0, -14), head=(0, 0, -8))
THUMP = P(root=(0, 0, -22, 0.95, 1.08), ear2=(0, 0, -20), head=(0, 0, -8), haunch=(2, 8, 24))
SLEEP = P(root=(0, 0, 3, 1.12, 0.74), ear2=(0, 0, 16), head=(0, 4, 8), eye="closed")
FLOP = P(root=(0, 0, 0, 1.18, 0.6), ear2=(0, 0, 20), head=(0, 6, 10), eye="closed")
STRETCH = P(root=(0, 0, -1, 1.18, 0.86), head=(0, 0, -12), ear2=(0, 0, 8))

# act: (frames, y offsets in px at 1x per frame, loopable)
ACT_DEFS = {
    "sit":     ([SIT], [0]),
    "blink":   ([P(eye="closed"), P(eye="closed"), SIT], [0, 0, 0]),
    "flick":   ([P(ear2=(0, 0, -16)), P(ear2=(0, 0, -26)), P(ear2=(0, 0, -12)), P(ear2=(0, 0, 4)), SIT], [0] * 5),
    "nibble":  ([P(head=(0, 0, 8)), P(head=(0, 0, 14)), P(head=(0, 0, 11)), P(head=(0, 0, 14)), P(head=(0, 0, 11)), P(head=(0, 0, 6)), SIT], [0] * 7),
    "look":    ([P(head=(0, 0, -6)), P(head=(0, 0, -10)), P(head=(0, 0, -10)), P(head=(0, 0, -10)), P(head=(0, 0, -5)), SIT], [0] * 6),
    "perk":    ([P(ear2=(0, 0, -14), head=(0, 0, -4)), P(ear2=(0, 0, -22), head=(0, 0, -7)), P(ear2=(0, 0, -22), head=(0, 0, -7)), P(ear2=(0, 0, -10), head=(0, 0, -3)), SIT], [0] * 5),
    "hop":     ([CROUCH, CROUCH2, TAKEOFF, AIR, AIR2, LAND, SETTLE, SIT], [0, 0, -2, -5, -4, 0, 0, 0]),
    "run":     ([CROUCH, TAKEOFF, AIR, AIR2, LAND, SETTLE], [0, -1, -4, -3, 0, 0]),
    "thump":   ([STAND, STAND, THUMP, STAND, THUMP, STAND, SETTLE, SIT], [0, -1, 1, -1, 1, -1, 0, 0]),       # thump frames dip 1 px: the impact
    "binky":   ([CROUCH, CROUCH2, TAKEOFF, P(root=(0, 0, 22, 1.0, 1.05), ear2=(0, 0, -14)), P(root=(0, 0, -18, 1.0, 1.05), ear2=(0, 0, 10)), AIR2, LAND, SETTLE, SIT],
                [0, 0, -3, -7, -8, -5, 0, 0, 0]),
    "stretch": ([STRETCH, STRETCH, P(root=(0, 0, -1, 1.18, 0.86), head=(0, 0, -16), eye="closed"), STRETCH, SETTLE, SIT], [0] * 6),
    "sleep":   ([SLEEP], [0]),
    "flop":    ([SETTLE, P(root=(0, 0, 0, 1.12, 0.74), eye="closed"), FLOP], [0, 0, 0]),
    "tired":   ([P(root=(0, 0, 2, 1.08, 0.8), ear2=(0, 0, 14), eye="closed")], [0]),
}

# Unique frames get one file each; acts reference them by index.
files, names, acts = {}, [], {}
for act, (frames, ys) in ACT_DEFS.items():
    assert len(frames) == len(ys), act
    idx = []
    for f in frames:
        svg = svg_for(f)
        if svg not in files:
            files[svg] = f"rabbit-{len(names):02d}-symbolic.svg"
            names.append(files[svg])
            open(os.path.join(OUT, files[svg]), "w").write(svg)
        idx.append(files[svg])
    acts[act] = {"frames": idx, "y": ys}
json.dump({"fps": 12, "acts": acts}, open(ACTS, "w"), indent=1)
print(len(names), "frames,", len(acts), "acts")
