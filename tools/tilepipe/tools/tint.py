"""Split a clothing layer into a fixed part and a tintable shade mask, and preview tints.

  python3 tint.py split ../samples/characters/chest_riot_vest.png cold
      -> chest_riot_vest.png        (fixed pixels only, overwritten in place)
         chest_riot_vest.tint.png   (shade mask: grey 64/128/192/255 = shade 0..3)
  The listed palette ramps (e.g. "cold", or "skin,rust") are the tintable pixels.

  python3 tint.py apply item.png navy out.png   -> fixed part + mask recoloured with a preset
"""
import sys
import numpy as np
from PIL import Image
from palette import RAMPS, TINTS

LEVELS = [64, 128, 192, 255]


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def split(path, ramps):
    a = np.asarray(Image.open(path).convert("RGBA")).copy()
    if ramps == ["ALL"]:   # everything except the outline colour (hair)
        tint_cols = {rgb(c) for r in RAMPS.values() for c in r} - {rgb(RAMPS["ink"][0])}
    else:
        tint_cols = {rgb(c) for r in ramps for c in RAMPS[r]}
    sel = (a[..., 3] > 0) & np.array([[tuple(p[:3]) in tint_cols for p in row] for row in a])
    lum = a[..., :3].astype(float) @ [0.299, 0.587, 0.114]
    uniq = sorted(set(np.round(lum[sel], 1)))
    shade = {u: round(i * 3 / max(len(uniq) - 1, 1)) for i, u in enumerate(uniq)}
    mask = np.zeros_like(a)
    for y, x in zip(*np.nonzero(sel)):
        v = LEVELS[shade[round(lum[y, x], 1)]]
        mask[y, x] = (v, v, v, 255)
    fixed = a.copy()
    fixed[sel] = 0
    Image.fromarray(fixed).save(path)
    Image.fromarray(mask).save(path[:-4] + ".tint.png")
    return int(sel.sum())


def recolour(mask_path, preset):
    m = np.asarray(Image.open(mask_path).convert("RGBA"))
    out = np.zeros_like(m)
    ramp = [rgb(c) for c in TINTS[preset]]
    for i, v in enumerate(LEVELS):
        hit = (m[..., 3] > 0) & (m[..., 0] == v)
        out[hit] = (*ramp[i], 255)
    return Image.fromarray(out)


def apply(item, preset):
    """Composite = tinted mask under the fixed part (they never overlap, order is cosmetic)."""
    img = recolour(item[:-4] + ".tint.png", preset)
    return Image.alpha_composite(img, Image.open(item).convert("RGBA"))


if __name__ == "__main__":
    if sys.argv[1] == "split":
        print("tintable pixels:", split(sys.argv[2], sys.argv[3].split(",")))
    else:
        apply(sys.argv[2], sys.argv[3]).save(sys.argv[4])
