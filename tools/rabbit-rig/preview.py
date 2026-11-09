"""Review renders for the rig: a contact sheet of every frame (large, and at pill size 1x / 2x) and one
GIF per act, as it would sit in the pill (black pill, dot grass, hop arc applied, 12 fps).

    python3 -I preview.py <frames-dir> <acts.json> <out-dir>
"""
import json, math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

FRAMES, ACTS, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
ICON = 32                     # St.Icon size in the pill (rabbit itself ~18 px tall)
GREY, MOODS = "#c4c2cc", {"working": "#7aa2ff", "waiting": "#ff9f0a", "done": "#32d74b"}
ACT_MOOD = {"run": "working", "thump": "waiting", "binky": "done"}
PILL = (0, 0, 0)

acts = json.load(open(ACTS))["acts"]
names = sorted({f for a in acts.values() for f in a["frames"]})
cache = {}


def render(name, width, color):
    key = (name, width, color)
    if key not in cache:
        svg = open(os.path.join(FRAMES, name)).read().replace("#bebebe", color).replace("#73d216", "#7aa2ff")
        tmp_svg = os.path.join(OUT, "_tmp.svg")
        tmp_png = os.path.join(OUT, f"_tmp_{width}.png")
        open(tmp_svg, "w").write(svg)
        subprocess.run(["inkscape", tmp_svg, "-w", str(width), "-o", tmp_png], check=True, capture_output=True)
        cache[key] = Image.open(tmp_png).convert("RGBA")
    return cache[key]


# ---- contact sheet: large on top, pill size 1x (shown 4x nearest) and 2x below
cell = 150
sheet = Image.new("RGB", (cell * len(names), cell + 130), (24, 24, 26))
d = ImageDraw.Draw(sheet)
for i, n in enumerate(names):
    big = render(n, 140, GREY)
    sheet.paste(big, (i * cell + 5, 5), big)
    small = render(n, ICON, GREY).resize((ICON * 2, int(render(n, ICON, GREY).height * 2)), Image.NEAREST)
    sheet.paste(small, (i * cell + 10, cell + 10), small)
    s2 = render(n, ICON * 2, GREY)
    sheet.paste(s2, (i * cell + 80, cell + 10), s2)
    d.text((i * cell + 5, cell + 100), n[7:9], fill=(140, 140, 150))
sheet.save(os.path.join(OUT, "sheet.png"))


# ---- act GIFs: a 120x40 slice of the pill, shown at 3x so pixels are visible
W, H, Z = 120, 40, 3
GROUND = 31                   # feet line inside the pill


def grass(draw, scroll=0.0, bend=0.0):
    for x in range(4, W - 4, 3):
        xx = x - (scroll % 3)
        y = GROUND + 1 + 0.8 * math.sin(xx / 5 + scroll / 4)
        a = 0.35 + 0.35 * (0.5 + 0.5 * math.sin(xx / 9))
        c = tuple(int(v * a) for v in (170, 168, 180))
        draw.point((xx, y), fill=c)
        if bend and abs(xx - W / 2) < 10:   # landing pushes the grass by the feet
            draw.point((xx + (1 if xx > W / 2 else -1), y - 1), fill=c)


for act, a in acts.items():
    color = MOODS.get(ACT_MOOD.get(act), GREY)
    imgs = []
    seq = list(zip(a["frames"], a["y"]))
    seq = seq * (3 if act in ("run", "thump") else 1) + [(acts["sit"]["frames"][0], 0)] * 6
    for k, (n, y) in enumerate(seq):
        im = Image.new("RGB", (W, H), PILL)
        dr = ImageDraw.Draw(im)
        grass(dr, scroll=k * 2 if act == "run" else 0, bend=act in ("hop", "binky", "run") and y == 0 and k > 0)
        spr = render(n, ICON, color)
        top = GROUND - int(spr.height * 0.97) + y   # rabbit feet near the bottom of the frame box
        im.paste(spr, (W // 2 - spr.width // 2, top), spr)
        if act == "sleep":
            for j, (zx, zy) in enumerate([(8, -4), (12, -8), (17, -12)]):
                dr.point((W // 2 + zx, top + zy), fill=(150, 150, 160))
        imgs.append(im.resize((W * Z, H * Z), Image.NEAREST))
    imgs[0].save(os.path.join(OUT, f"{act}.gif"), save_all=True, append_images=imgs[1:], duration=83, loop=0, disposal=2)

for f in os.listdir(OUT):
    if f.startswith("_tmp"):
        os.remove(os.path.join(OUT, f))
print("sheet + gifs in", OUT)
