"""Seamless 32x32 tile -> 256x256 autotile sheet in Santi's engine layout (8x8 blob).

  python3 autotile.py out/tiles/grass.png out/tiles/grass_auto.png [--template templates/autotile_8x8.png]

The template is Santi's FieldsTilesetTest.png: per slot, the green band marks the sides and corners
that touch a different terrain. We read that per slot, so every output tile lands in the exact slot
the engine expects. Border areas become transparent (the layer below shows through), with a ragged
pixel edge and a darker rim so the terrain reads as sitting on top.
"""
import argparse, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from palette import PALETTE
from pixelize import to_lab

N = 32
BAND = 5                       # template band width; the ragged edge varies around it
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TEMPLATE = os.path.join(HERE, "..", "templates", "autotile_8x8.png")
PAL = np.array(PALETTE, np.float32)
PAL_LAB = to_lab(PAL)


def read_template(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(int)
    green = a[..., 1] > a[..., 0]
    rows, cols = a.shape[0] // N, a.shape[1] // N
    return green, rows, cols


def edge_profile(seed, n=N, lo=3, hi=7, end=BAND):
    """Depth of the cut along one side: stepped noise, fixed to `end` at both ends so neighbours join."""
    rng = np.random.default_rng(seed)
    d = np.full(n, end)
    x = 3
    while x < n - 3:
        run = int(rng.integers(2, 5))
        d[x:min(x + run, n - 3)] = int(rng.integers(lo, hi))
        x += run
    # soften steps of more than 1px between runs
    for _ in range(2):
        for i in range(1, n):
            if d[i] - d[i - 1] > 1: d[i] = d[i - 1] + 1
            if d[i - 1] - d[i] > 1: d[i - 1] = d[i] + 1
    return d


# One shared profile per side direction, so horizontally/vertically adjacent edge tiles line up.
PROF = {s: edge_profile(i + 11) for i, s in enumerate("NESW")}


def slot_mask(g):
    """g: 32x32 bool template (True = border). Returns alpha mask (True = terrain kept)."""
    keep = ~g.copy()
    side = {"N": g[0:BAND, 8:24].mean() > .9, "S": g[N - BAND:, 8:24].mean() > .9,
            "W": g[8:24, 0:BAND].mean() > .9, "E": g[8:24, N - BAND:].mean() > .9}
    if all(side.values()) and g.mean() > .95:
        return keep                                     # fully-border slot: follow template literally
    # interior shapes the template draws (not touching sides) are followed literally
    ys, xs = np.mgrid[0:N, 0:N]
    k = np.ones((N, N), bool)
    if side["N"]: k &= ys >= PROF["N"][xs]
    if side["S"]: k &= (N - 1 - ys) >= PROF["S"][xs]
    if side["W"]: k &= xs >= PROF["W"][ys]
    if side["E"]: k &= (N - 1 - xs) >= PROF["E"][ys]
    # inner corners: green at a corner pixel whose two sides are not borders -> rounded notch
    for cy, cx, s1, s2 in ((0, 0, "N", "W"), (0, N - 1, "N", "E"), (N - 1, 0, "S", "W"), (N - 1, N - 1, "S", "E")):
        if g[cy, cx] and not side[s1] and not side[s2]:
            dy, dx = np.abs(ys - cy), np.abs(xs - cx)
            k &= ~((dy < BAND) & (dx < BAND) & ~((dy == BAND - 1) & (dx == BAND - 1)))
    # outer corners: round off one extra pixel where two borders meet
    for cy, cx, s1, s2 in ((0, 0, "N", "W"), (0, N - 1, "N", "E"), (N - 1, 0, "S", "W"), (N - 1, N - 1, "S", "E")):
        if side[s1] and side[s2]:
            dy, dx = np.abs(ys - cy), np.abs(xs - cx)
            k &= ~((dy <= PROF[s1][min(cx, N - 1)] + 1) & (dx <= PROF[s2][min(cy, N - 1)] + 1) & (dy + dx <= 2 * BAND + 1))
    # keep any template interior detail (pixels green that are not near a side)
    inner = g.copy()
    inner[:BAND + 2] = inner[-BAND - 2:] = False
    inner[:, :BAND + 2] = inner[:, -BAND - 2:] = False
    return k & ~inner


def darker(rgb, f):
    lab = to_lab(np.asarray(rgb, np.float32)[None, None] * f)[0, 0]
    return PAL[((PAL_LAB - lab) ** 2).sum(-1).argmin()].astype(np.uint8)


def rim_mask(g):
    """Wall tops: no transparency; border sides/corners get a 2px dark rim at the tile edge."""
    side = {"N": g[0:BAND, 8:24].mean() > .9, "S": g[N - BAND:, 8:24].mean() > .9,
            "W": g[8:24, 0:BAND].mean() > .9, "E": g[8:24, N - BAND:].mean() > .9}
    ys, xs = np.mgrid[0:N, 0:N]
    r1 = np.zeros((N, N), bool); r2 = np.zeros((N, N), bool)
    for s_, d in (("N", ys), ("S", N - 1 - ys), ("W", xs), ("E", N - 1 - xs)):
        if side[s_]:
            r1 |= d == 0; r2 |= d == 1
    for cy, cx in ((0, 0), (0, N - 1), (N - 1, 0), (N - 1, N - 1)):
        if g[cy, cx]:
            dy, dx = np.abs(ys - cy), np.abs(xs - cx)
            r1 |= (dy <= 1) & (dx <= 1) & ((dy == 0) | (dx == 0)) & (dy + dx <= 1)
            r1 |= (dy == 0) & (dx <= 1) | (dx == 0) & (dy <= 1)
            r2 |= (dy <= 2) & (dx <= 2) & ~r1 & ((dy == 1) | (dx == 1))
    return r1, r2 & ~r1


def build(tile_path, dst, template=DEFAULT_TEMPLATE, style="cut"):
    tile = np.asarray(Image.open(tile_path).convert("RGB"))
    green, rows, cols = read_template(template)
    sheet = np.zeros((rows * N, cols * N, 4), np.uint8)
    cache = {}
    for r in range(rows):
        for c in range(cols):
            g = green[r * N:(r + 1) * N, c * N:(c + 1) * N]
            t = np.dstack([tile, np.full((N, N), 255, np.uint8)])
            if style == "rim":
                r1, r2 = rim_mask(g)
                for mask, f in ((r1, 0.3), (r2, 1.25)):
                    for y, x in zip(*np.nonzero(mask)):
                        t[y, x, :3] = darker(t[y, x, :3], f)
                sheet[r * N:(r + 1) * N, c * N:(c + 1) * N] = t
                continue
            m = slot_mask(g)
            t[~m, 3] = 0
            # rim: 1px darkest edge, then a 1px shade inside it (only along cut edges, not tile sides)
            pad = np.pad(m, 1, constant_values=True)
            nb_out = ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
            rim = m & nb_out
            pad2 = np.pad(m & ~rim, 1, constant_values=True)
            rim2 = (m & ~rim) & ~(pad2[:-2, 1:-1] & pad2[2:, 1:-1] & pad2[1:-1, :-2] & pad2[1:-1, 2:])
            for mask, f in ((rim, 0.45), (rim2, 0.75)):
                for y, x in zip(*np.nonzero(mask)):
                    key = (tuple(t[y, x, :3]), f)
                    if key not in cache: cache[key] = darker(t[y, x, :3], f)
                    t[y, x, :3] = cache[key]
            sheet[r * N:(r + 1) * N, c * N:(c + 1) * N] = t
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    Image.fromarray(sheet).save(dst)
    print("wrote", dst)
    return sheet


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("tile")
    ap.add_argument("dst")
    ap.add_argument("--template", default=DEFAULT_TEMPLATE)
    o = ap.parse_args()
    build(o.tile, o.dst, o.template)
