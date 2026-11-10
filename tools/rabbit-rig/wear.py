"""Wearables, drawn at the animal's own scale into the empty slots of its frames.

Each item is a function of the animal's geometry (rig.GEO: species, neck joint, skull ellipse,
long_ears) returning {"slot", "rest": {layer: [svg]}, "stream"?: {layer: [svg]}, "ears"?: (far, near)}.
Layers: back and neck are in body space (over the body and arm, under the head); head0, head1,
head2 are in head space (under the far ear, between skull and near ear, over everything).
"stream" replaces the rest layers on the stretched-out leap frames; "ears" turns the ears (degrees).
rig.py writes these into <animal>/wear.json; bump ART_VERSION whenever an item's drawing changes,
so outfits composed from older art are not reused.
"""
from rig import fill, rbar, thick_curve

ART_VERSION = 1


def accent(d):
    return fill(d, "success")


def scarf(g):
    nx, ny = g["neck"]
    band = accent(rbar(nx - 9, ny - 1, nx + 7, ny + 8, 4.8))
    return {"slot": "neck",
            "rest": {"neck": [band, accent(rbar(nx + 5, ny + 8, nx + 2.5, ny + 21, 4.0))]},          # the end hangs down the chest
            "stream": {"neck": [band, accent(thick_curve((nx - 7, ny), (nx - 22, ny - 9), (nx - 36, ny - 3), 9, 6.5))]}}   # and flies behind


ITEMS = {"scarf": scarf}
