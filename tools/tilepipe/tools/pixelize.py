"""Turn a large AI image (figure on flat magenta) into a 32x48 paper-doll layer.

Usage:
  python3 pixelize.py base  raw/base.png out/body_base.png      # fits figure to canvas, saves transform
  python3 pixelize.py layer raw/edit.png out/helm.png --base raw/base.png
      # applies the base's transform to an edited image, keeps only what changed vs the base

Contract (see paperdoll README): 32x48 RGBA, feet on y=47 ground line, centred on x=16,
palette-locked, hard edges, 1px near-black outline.
"""
import argparse, json, os
import numpy as np
from PIL import Image
from palette import PALETTE, OUTLINE

W, H = 32, 48
PAL = np.array(PALETTE, dtype=np.float32)
SHADOW = (*OUTLINE, 120)          # ground shadow: outline colour at partial alpha


def classify(img):
    """Return rgb array plus masks for magenta background and magenta-tinted shadow."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    magenta = ((r + b) / 2 - g > 45) & (np.abs(r - b) < 70)
    bright = (r + b) / 2
    bg_level = np.median(bright[magenta]) if magenta.any() else 255
    shadow = magenta & (bright < bg_level * 0.72)
    bg = magenta & ~shadow
    return a, bg, shadow


def to_lab(rgb):
    c = np.asarray(rgb, dtype=np.float32) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], np.float32)
    xyz = c @ m.T / np.array([0.9505, 1.0, 1.089], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


PAL_LAB = to_lab(PAL)


def quantize(rgb):
    """Nearest palette index per pixel in CIELAB (perceptual) space."""
    lab = to_lab(rgb).reshape(-1, 3)
    d = ((lab[:, None, :] - PAL_LAB[None]) ** 2).sum(-1)
    return d.argmin(1).reshape(np.shape(rgb)[:2])


def fit_transform(fig_mask, top=1, feet=47, margin=0):
    """Scale + offset that rests the figure's bottom on y=feet, centred on x=16, as large as
    fits between y=top and the canvas sides. Wide figures (busts) are limited by width."""
    ys, xs = np.nonzero(fig_mask)
    y0, y1 = ys.min(), ys.max()
    scale = max((y1 - y0 + 1) / (feet - top + 1),            # source px per target px
                (xs.max() - xs.min() + 1) / (W - 2 * margin))
    cx = (xs.min() + xs.max() + 1) / 2
    return {"scale": float(scale), "ox": float(cx - 16 * scale), "oy": float(y1 + 1 - (feet + 1) * scale)}


def despeckle(out):
    """Replace opaque pixels whose colour matches none of their 8 neighbours with the
    most common neighbouring colour; drop opaque islands smaller than 4 pixels."""
    res = out.copy()
    for y in range(H):
        for x in range(W):
            if out[y, x, 3] != 255:
                continue
            nb = [tuple(out[j, i]) for j in range(y - 1, y + 2) for i in range(x - 1, x + 2)
                  if (j, i) != (y, x) and 0 <= j < H and 0 <= i < W and out[j, i, 3] == 255]
            if len(nb) >= 5 and tuple(out[y, x]) not in nb:
                res[y, x] = max(set(nb), key=nb.count)
    solid = res[..., 3] > 0
    seen = np.zeros_like(solid)
    for y in range(H):
        for x in range(W):
            if solid[y, x] and not seen[y, x]:
                comp, st = [], [(y, x)]
                seen[y, x] = True
                while st:
                    cy, cx = st.pop(); comp.append((cy, cx))
                    for j, i in ((cy+1, cx), (cy-1, cx), (cy, cx+1), (cy, cx-1)):
                        if 0 <= j < H and 0 <= i < W and solid[j, i] and not seen[j, i]:
                            seen[j, i] = True; st.append((j, i))
                if len(comp) < 4:
                    for cy, cx in comp:
                        res[cy, cx] = 0
    return res


def downsample(rgb, fig, shadow, t, outline=True, under=None):
    out = np.zeros((H, W, 4), dtype=np.uint8)
    s = t["scale"]
    for ty in range(H):
        for tx in range(W):
            x0, y0 = int(round(t["ox"] + tx * s)), int(round(t["oy"] + ty * s))
            x1, y1 = int(round(t["ox"] + (tx + 1) * s)), int(round(t["oy"] + (ty + 1) * s))
            x0, y0 = max(x0, 0), max(y0, 0)
            x1, y1 = min(x1, rgb.shape[1]), min(y1, rgb.shape[0])
            if x1 <= x0 or y1 <= y0:
                continue
            f = fig[y0:y1, x0:x1]
            n = f.size
            if f.sum() > n * 0.45:
                med = np.median(rgb[y0:y1, x0:x1][f], axis=0)
                out[ty, tx] = (*PALETTE[quantize(med[None, None, :])[0, 0]], 255)
            # no baked ground shadows (Santi, Nov 10)
    out = despeckle(out)
    if outline:
        # outline only the outer silhouette of (this layer + whatever sits under it),
        # so an item doesn't draw a black seam where it overlaps the body
        solid = out[..., 3] == 255
        union = solid if under is None else solid | (under[..., 3] == 255)
        pad = np.pad(union, 1)
        edge = solid & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
        out[edge] = (*OUTLINE, 255)
    return out


def pixelize_base(src, dst, outline=True):
    rgb, bg, sh = classify(Image.open(src))
    fig = ~bg & ~sh
    t = fit_transform(fig)
    arr = downsample(rgb, fig, sh, t, outline)
    Image.fromarray(arr).save(dst)
    json.dump(t, open(dst + ".json", "w"))
    return arr, t


def pixelize_layer(src, dst, base_src, base_png, thr=60.0, outline=True):
    """Keep only the pixels of `src` that differ from the base image (the new item)."""
    t = json.load(open(base_png + ".json"))
    rgb, bg, sh = classify(Image.open(src))
    brgb, bbg, bsh = classify(Image.open(base_src).resize(Image.open(src).size))
    fig = ~bg & ~sh
    changed = fig & ((np.abs(rgb - brgb).sum(-1) > thr) | bbg | bsh)
    under = np.asarray(Image.open(base_png).convert("RGBA"))
    arr = downsample(rgb, changed, np.zeros_like(sh), t, outline, under)
    Image.fromarray(arr).save(dst)
    return arr


def pixelize_variant(src, dst, base_png, outline=True):
    """A whole new body (e.g. zombie) registered with the base's transform, no diffing."""
    t = json.load(open(base_png + ".json"))
    rgb, bg, sh = classify(Image.open(src))
    arr = downsample(rgb, ~bg & ~sh, sh, t, outline)
    Image.fromarray(arr).save(dst)
    json.dump(t, open(dst + ".json", "w"))
    return arr


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["base", "layer", "variant"])
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--base-src"); ap.add_argument("--base-png")
    ap.add_argument("--no-outline", action="store_true")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.dst) or ".", exist_ok=True)
    if a.mode == "base":
        pixelize_base(a.src, a.dst, not a.no_outline)
    elif a.mode == "variant":
        pixelize_variant(a.src, a.dst, a.base_png, not a.no_outline)
    else:
        pixelize_layer(a.src, a.dst, a.base_src, a.base_png, outline=not a.no_outline)
    print("wrote", a.dst)
