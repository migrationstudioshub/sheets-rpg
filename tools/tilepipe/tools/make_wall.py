"""RPG Maker style walls: a wall-top autotile (8x8 blob, Santi's layout) + a front face strip.

  python3 make_wall.py brick out/tiles/wall_brick      # -> wall_brick_top_auto.png, wall_brick_face.png

Face strip: 4 columns x 2 rows of 32x32 (128x64): columns = single, left end, middle, right end;
rows = upper and lower half of a 2-tile-tall wall. The engine draws the face under a wall-top cell
whose south neighbour is not wall. Bricks are procedural so they wrap perfectly; colours come from
the palette.
"""
import os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from palette import RAMPS
from autotile import build, darker

N = 32
hexrgb = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.uint8)

MATERIALS = {
    # brick colours (dark->light), mortar, top cap
    "brick": dict(bricks=[RAMPS["rust"][0], RAMPS["rust"][1], RAMPS["grime"][1]], hi=RAMPS["rust"][2],
                  mortar=RAMPS["ink"][2], cap=[RAMPS["ink"][2], RAMPS["ink"][3], RAMPS["ink"][4]]),
    "concrete": dict(bricks=[RAMPS["ink"][3], RAMPS["ink"][3], RAMPS["grime"][1]], hi=RAMPS["ink"][4],
                     mortar=RAMPS["ink"][2], cap=[RAMPS["ink"][2], RAMPS["ink"][3], RAMPS["ink"][4]]),
}


def brick_face(m, seed=3, h=64, bw=8, bh=4):
    rng = np.random.default_rng(seed)
    face = np.zeros((h, N, 3), np.uint8)
    for row in range(h // bh):
        off = (bw // 2) * (row % 2)
        for b in range(-1, N // bw + 1):
            x0 = b * bw + off
            col = hexrgb(m["bricks"][rng.integers(len(m["bricks"]))])
            for y in range(row * bh, row * bh + bh):
                for x in range(x0, x0 + bw):
                    xx = x % N
                    if y == row * bh + bh - 1 or x == x0 + bw - 1:
                        face[y, xx] = hexrgb(m["mortar"])
                    elif y == row * bh and rng.random() < .5:
                        face[y, xx] = hexrgb(m["hi"])       # top-lit edge
                    else:
                        face[y, xx] = col
    # grime: darken toward the bottom and a few stains
    for y in range(h):
        for x in range(N):
            if rng.random() < (y / h) ** 2 * .35:
                face[y, x] = darker(face[y, x], .7)
    return face


def face_strip(face, m):
    """single / left / middle / right, each 32 wide x 64 tall, with dark outline ends and a top lip."""
    out = np.zeros((64, 4 * N, 4), np.uint8)
    for i, (l, r) in enumerate(((1, 1), (1, 0), (0, 0), (0, 1))):
        f = np.dstack([face.copy(), np.full((64, N), 255, np.uint8)])
        f[0, :, :3] = hexrgb(RAMPS["ink"][0])                    # lip under the wall top
        f[1, :, :3] = darker(hexrgb(m["mortar"]), .6)            # shadow under the lip
        f[-1, :, :3] = hexrgb(RAMPS["ink"][0])                   # base line on the ground
        if l: f[:, 0, :3] = hexrgb(RAMPS["ink"][0]); f[:, 1, :3] = [darker(c, .7) for c in f[:, 1, :3]]
        if r: f[:, -1, :3] = hexrgb(RAMPS["ink"][0]); f[:, -2, :3] = [darker(c, .7) for c in f[:, -2, :3]]
        out[:, i * N:(i + 1) * N] = f
    # re-pack as 4 cols x 2 rows of tiles: row 0 = upper halves, row 1 = lower halves (same as 128x64)
    return out


def cap_tile(m, seed=5):
    rng = np.random.default_rng(seed)
    c = [hexrgb(h) for h in m["cap"]]
    t = np.zeros((N, N, 3), np.uint8)
    t[:] = c[1]
    for _ in range(40):
        y, x = rng.integers(0, N, 2)
        t[y, x] = c[rng.choice([0, 2])]
    return t


if __name__ == "__main__":
    mat, prefix = sys.argv[1], sys.argv[2]
    m = MATERIALS[mat]
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)
    Image.fromarray(face_strip(brick_face(m), m)).save(prefix + "_face.png")
    Image.fromarray(cap_tile(m)).save(prefix + "_top.png")
    build(prefix + "_top.png", prefix + "_top_auto.png", style="rim")
    print("wrote", prefix + "_face.png")
