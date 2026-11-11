"""Ground textures -> seamless 32x32 tiles, palette-locked and kept dark.

  python3 make_tile.py gen  <name> "<what the ground is>"      # Nano Banana texture -> raw/tiles2/<name>.png
  python3 make_tile.py cut  raw/tiles2/<name>.png out/tiles/<name>.png [--px 112]

How it stays seamless: the AI paints a big texture (no borders asked, but we never trust it).
We pixelize it to a px*px grid, crop away the outer ring (where AI borders live), then build a
32x32 tile by image quilting: the strip that naturally continues the tile's right/bottom edge is
stitched over its left/top edge along a minimum-error cut, so the tile wraps on itself.
Several windows are tried; the one with the lowest seam error wins.
"""
import argparse, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from palette import PALETTE, RAMPS
from pixelize import to_lab

N = 32           # tile size
K = 12           # overlap strip used for the wrap stitch

# Ground keeps to the darker steps so busts always read on top.
GROUND_HEX = (RAMPS["ink"][:6] + RAMPS["grime"] + RAMPS["rot"][:4] + RAMPS["rust"] + RAMPS["drab"]
              + RAMPS["cold"] + RAMPS["pale"][:3] + RAMPS["blood"][:3])
GROUND = np.array([tuple(int(h[i:i + 2], 16) for i in (1, 3, 5)) for h in GROUND_HEX], np.float32)
GROUND_LAB = to_lab(GROUND)


def quantize_to(rgb, pal, pal_lab):
    lab = to_lab(rgb).reshape(-1, 3)
    idx = ((lab[:, None] - pal_lab[None]) ** 2).sum(-1).argmin(1)
    return pal[idx].reshape(*np.shape(rgb)[:2], 3).astype(np.uint8)


def pixelize(img, px):
    img = img.convert("RGB")
    s = min(img.size)
    img = img.crop(((img.width - s) // 2, (img.height - s) // 2, (img.width + s) // 2, (img.height + s) // 2))
    a = np.asarray(img, np.float32)
    b = s / px
    out = np.zeros((px, px, 3), np.float32)
    for y in range(px):
        for x in range(px):
            out[y, x] = np.median(a[int(y * b):int((y + 1) * b), int(x * b):int((x + 1) * b)].reshape(-1, 3), 0)
    return out


def _cut_cols(A, B):
    """Min-error vertical cut through two HxK overlaps. Returns mask True where A is kept."""
    e = ((to_lab(A) - to_lab(B)) ** 2).sum(-1)
    H, W = e.shape
    cost = e.copy()
    for y in range(1, H):
        for x in range(W):
            cost[y, x] += cost[y - 1, max(0, x - 1):min(W, x + 2)].min()
    path = np.zeros(H, int)
    path[-1] = cost[-1].argmin()
    for y in range(H - 2, -1, -1):
        lo = max(0, path[y + 1] - 1)
        path[y] = lo + cost[y, lo:min(W, path[y + 1] + 2)].argmin()
    keepA = np.arange(W)[None, :] < path[:, None]
    return keepA, float(e[np.arange(H), path].mean())


def wrap_tile(S, x0, y0):
    """From texture S, build an NxN tile at (x0,y0) that wraps, using the K pixels past its edges."""
    # horizontal: rows y0 .. y0+N+K (extra rows needed for the vertical pass)
    R = S[y0:y0 + N + K, x0:x0 + N + K].copy()
    A, B = R[:, N:N + K], R[:, :K]                 # A continues the right edge -> belongs left of col 0
    keep, eh = _cut_cols(A, B)
    R[:, :K] = np.where(keep[..., None], A, B)
    R = R[:, :N]
    A, B = R[N:N + K], R[:K]
    keep, ev = _cut_cols(A.transpose(1, 0, 2), B.transpose(1, 0, 2))
    R[:K] = np.where(keep.T[..., None], A, B)
    return R[:N], eh + ev


def despeckle_wrap(t):
    res = t.copy()
    for y in range(N):
        for x in range(N):
            nb = [tuple(t[(y + j) % N, (x + i) % N]) for j in (-1, 0, 1) for i in (-1, 0, 1) if (i, j) != (0, 0)]
            if tuple(t[y, x]) not in nb:
                res[y, x] = max(set(nb), key=nb.count)
    return res


def wrap_score(t):
    """Mean colour jump across the wrap edges divided by the mean jump inside. ~1 = invisible seam."""
    lab = to_lab(t)
    inner = (np.abs(np.diff(lab, axis=1)).sum(-1).mean() + np.abs(np.diff(lab, axis=0)).sum(-1).mean()) / 2
    edge = (np.abs(lab[:, 0] - lab[:, -1]).sum(-1).mean() + np.abs(lab[0] - lab[-1]).sum(-1).mean()) / 2
    return edge / max(inner, 1e-6)


def add_joints(t, step):
    """Slab joints every `step` px: dark line on the top/left of each slab, light lip below/right."""
    t = t.copy()
    from autotile import darker
    for y in range(N):
        for x in range(N):
            if x % step == 0 or y % step == 0:
                t[y, x] = darker(t[y, x], 0.55)
            elif x % step == 1 or y % step == 1:
                t[y, x] = darker(t[y, x], 1.18)
    return t


def mottle(shape, seed=0):
    """Blotchy noise in about [-1, 1]: big soft patches plus small clumps, no single-pixel salt."""
    rng = np.random.default_rng(seed + 99)
    out = np.zeros(shape, np.float32)
    for cell, w in ((10, 0.6), (4, 0.4)):
        small = rng.uniform(-1, 1, (shape[0] // cell + 2, shape[1] // cell + 2)).astype(np.float32)
        img = Image.fromarray(small).resize(((shape[1] // cell + 2) * cell, (shape[0] // cell + 2) * cell), Image.BICUBIC)
        out += w * np.asarray(img)[:shape[0], :shape[1]]
    return out / max(np.abs(out).max(), 1e-6)


def cut(src, dst, px=112, ring=10, tries=25, seed=0, joints=0, contrast=2.5, despeckle=False, shift=0.0, grain=0.0):
    P = pixelize(Image.open(src), px)
    # AI textures are subtle; push variation apart so it survives the palette lock
    mean = P.reshape(-1, 3).mean(0)
    P = np.clip(mean * (1 + shift) + (P - mean) * contrast, 0, 255)
    if grain:
        P = np.clip(P + mottle(P.shape[:2], seed)[..., None] * grain, 0, 255)
    S = quantize_to(P, GROUND, GROUND_LAB).astype(np.float32)
    S = S[ring:px - ring, ring:px - ring]                     # AI borders live in the outer ring
    rng = np.random.default_rng(seed)
    best = None
    span = S.shape[0] - N - K
    for _ in range(tries):
        x0, y0 = rng.integers(0, span + 1, 2)
        t, err = wrap_tile(S, x0, y0)
        if best is None or err < best[1]:
            best = (t, err)
    t = best[0].astype(np.uint8)
    if despeckle:
        t = despeckle_wrap(t)
    if joints:
        t = add_joints(t, joints)
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    Image.fromarray(t).save(dst)
    print(f"wrote {dst}  wrap score {wrap_score(t):.2f} (1.0 = seamless)")
    return t


STYLE = ("Seamless top-down ground texture for a dark zombie-apocalypse pixel-art game: {what}. "
         "Straight overhead orthographic view, NO perspective, NO horizon, NO objects casting long shadows. "
         "The texture fills the ENTIRE square edge to edge: NO border, NO frame, NO vignette, NO tile grid lines. "
         "Chunky retro pixel art with big flat pixels (about 100 pixels across the whole image), 2 to 3 tones, "
         "hard edges, no anti-aliasing, no gradients. Even, dim, desaturated colours; one dominant colour with "
         "sparse small details so it does not look busy. Match the colour mood of the reference images.")


PATTERN_TAIL = ("Even, dim, desaturated colours. The surface's STRUCTURE is what matters (plates, seams, joints, "
                "welds, planks, tiles, bricks): keep it bold and clearly visible everywhere, with SMALL units: about "
                "6 to 8 units across the whole image, so several fit in one game tile.")


def gen(name, what, pattern=False):
    from nano import generate
    here = os.path.dirname(__file__)
    root = os.path.join(here, "..")
    refs = [Image.open(os.path.join(root, "samples/palette.png")).convert("RGBA"),
            Image.open(os.path.join(root, "samples/tiles/tile_floor.png")).convert("RGBA").resize((256, 256), Image.NEAREST)]
    prompt = STYLE.format(what=what)
    if pattern:   # built surfaces: the default "one colour, sparse detail" wording erases their structure
        prompt = prompt.replace("Even, dim, desaturated colours; one dominant colour with "
                                "sparse small details so it does not look busy.", PATTERN_TAIL)
    img = generate(prompt, refs, aspect="1:1", model=os.environ.get("NANO_MODEL", "gemini-3.1-flash-image"))
    out = os.path.join(root, "raw/tiles2", name + ".png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out)
    print("saved", out)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["gen", "cut"])
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--px", type=int, default=112)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--contrast", type=float, default=2.5, help="boost texture variation before palette lock")
    ap.add_argument("--shift", type=float, default=0.0, help="brightness shift, e.g. -0.15 = darker")
    ap.add_argument("--grain", type=float, default=0.0, help="add blotchy variation (RGB units, ~10-25) to flat textures")
    ap.add_argument("--despeckle", action="store_true")
    ap.add_argument("--joints", type=int, default=0, help="slab joints every N px (sidewalk, floor tiles)")
    o = ap.parse_args()
    if o.cmd == "gen":
        gen(o.a, o.b)
    else:
        cut(o.a, o.b, o.px, seed=o.seed, joints=o.joints, contrast=o.contrast, despeckle=o.despeckle, shift=o.shift, grain=o.grain)
