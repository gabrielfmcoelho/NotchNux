"""One labelled GIF of every act, from a preview dir made by preview.py.
    python3 -I allacts.py <preview-dir> <out.gif>"""
import sys
from PIL import Image, ImageDraw, ImageSequence

ORDER = ["sit", "blink", "flick", "sniff", "look", "nibble", "groom", "perk", "bob@music", "hop", "run", "thump", "binky",
         "stretch", "flop", "sleep", "tired"]
WHAT = {"sit": "sitting", "blink": "idle: blink", "flick": "idle: ear flick", "sniff": "idle: sniff", "look": "idle: look up",
        "nibble": "idle: nibble", "groom": "idle: groom", "perk": "notification", "bob@music": "music: earpiece + bob",
        "hop": "hop / wander", "run": "Claude working", "thump": "Claude waiting on you", "binky": "Claude finished",
        "stretch": "wake up", "flop": "focus break", "sleep": "away / night", "tired": "low battery"}
src, out = sys.argv[1:3]
frames = []
for a in ORDER:
    fs = [f.convert("RGB").copy() for f in ImageSequence.Iterator(Image.open(f"{src}/{a}.gif"))]
    if a in ("sit", "sleep", "tired"):
        fs = fs[:1] * 14
    for f in fs:
        c = Image.new("RGB", (f.width, f.height + 26), (16, 16, 18))
        c.paste(f, (0, 26))
        ImageDraw.Draw(c).text((8, 7), f"{a.split('@')[0]} - {WHAT[a]}", fill=(200, 198, 210))
        frames.append(c)
frames[0].save(out, save_all=True, append_images=frames[1:], duration=83, loop=0)
print(len(frames), "frames")
