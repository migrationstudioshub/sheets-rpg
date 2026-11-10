"""Render a test map the way Santi's engine would: stacked terrain layers with blob autotiles,
plus props and bust characters, shown at 2x.

  python3 tile_preview.py map.txt out.png --terrain g=out/tiles/grass_auto.png a=out/tiles/asphalt_auto.png ...
          [--base a] [--chars ...] [--scale 2]

map.txt: one char per cell. Terrain layers are drawn in --terrain order (first = bottom).
The --base terrain fills every cell underneath.
"""
import argparse, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from autotile import read_template, BAND, DEFAULT_TEMPLATE

N = 32


def signatures(template=DEFAULT_TEMPLATE):
    green, rows, cols = read_template(template)
    sig = {}
    for r in range(rows):
        for c in range(cols):
            g = green[r * N:(r + 1) * N, c * N:(c + 1) * N]
            s = (g[0:BAND, 8:24].mean() > .9, g[8:24, N - BAND:].mean() > .9,
                 g[N - BAND:, 8:24].mean() > .9, g[8:24, 0:BAND].mean() > .9)
            n, e, so, w = s
            corners = (bool(g[0, 0]) and not n and not w, bool(g[0, -1]) and not n and not e,
                       bool(g[-1, -1]) and not so and not e, bool(g[-1, 0]) and not so and not w)
            interior = g[BAND + 2:-BAND - 2, BAND + 2:-BAND - 2].any()
            if interior or g.mean() > .95:
                continue
            sig.setdefault(s + corners, (r, c))
    return sig


def cell_sig(m, y, x):
    H, W = m.shape
    def at(j, i):
        return m[j, i] if 0 <= j < H and 0 <= i < W else True   # map edge counts as same terrain
    n, e, s, w = not at(y - 1, x), not at(y, x + 1), not at(y + 1, x), not at(y, x - 1)
    nw = not n and not w and not at(y - 1, x - 1)
    ne = not n and not e and not at(y - 1, x + 1)
    se = not s and not e and not at(y + 1, x + 1)
    sw = not s and not w and not at(y + 1, x - 1)
    return (n, e, s, w, nw, ne, se, sw)


def render(grid, layers, base=None, sig=None):
    sig = sig or signatures()
    H, W = len(grid), len(grid[0])
    canvas = Image.new("RGBA", (W * N, H * N), (0, 0, 0, 255))
    order = list(layers)
    for key in order:
        sheet = Image.open(layers[key]).convert("RGBA")
        if key == base:
            m = np.ones((H, W), bool)
        else:
            m = np.array([[ch == key for ch in row] for row in grid])
            # a higher layer also covers cells of terrains drawn above it
            for above in order[order.index(key) + 1:]:
                m |= np.array([[ch == above for ch in row] for row in grid])
        for y in range(H):
            for x in range(W):
                if not m[y, x]:
                    continue
                r, c = sig.get(cell_sig(m, y, x), sig[(False,) * 8])
                canvas.alpha_composite(sheet.crop((c * N, r * N, c * N + N, r * N + N)), (x * N, y * N))
    return canvas


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("map")
    ap.add_argument("dst")
    ap.add_argument("--terrain", nargs="+", required=True)
    ap.add_argument("--base")
    ap.add_argument("--scale", type=int, default=2)
    o = ap.parse_args()
    grid = [l.rstrip("\n") for l in open(o.map) if l.strip()]
    layers = dict(t.split("=", 1) for t in o.terrain)
    img = render(grid, layers, o.base)
    img.resize((img.width * o.scale, img.height * o.scale), Image.NEAREST).save(o.dst)
    print("wrote", o.dst)


# ---- variety layer (mirror of scatter.js; same hash so previews match the engine) ----
M32 = 0xFFFFFFFF
SCATTER = {
    "asphalt":    {"details": ("asphalt_details.png", 8, 8, 0.40),     "decals": ("asphalt_decals.png", 4, 4, 0.06)},
    "grass_dead": {"details": ("grass_dead_details.png", 24, 8, 0.60), "decals": ("grass_dead_decals.png", 6, 6, 0.08)},
    "dirt":       {"details": ("dirt_details.png", 13, 8, 0.45),       "decals": ("dirt_decals.png", 5, 5, 0.06)},
    "sidewalk":   {"details": ("sidewalk_details.png", 10, 8, 0.35),   "decals": ("sidewalk_decals.png", 5, 5, 0.05)},
}


def hash32(x, y, salt):
    h = ((x * 374761393) & M32) ^ ((y * 668265263) & M32) ^ ((salt * 2246822519) & M32)
    h = ((h ^ (h >> 13)) * 1274126177) & M32
    return (h ^ (h >> 16)) & M32


def load_scatter(tiles_dir):
    """scatter.json in the tiles folder is the source of truth (make_tileset.py updates it)."""
    import json
    p = os.path.join(tiles_dir, "scatter.json")
    return json.load(open(p)) if os.path.exists(p) else SCATTER


def scatter(canvas, grid, key, terrain, tiles_dir):
    """Draw the variety layer for every cell of `key` in grid (decals only on interior cells)."""
    t = load_scatter(tiles_dir)[terrain]
    m = np.array([[ch == key for ch in row] for row in grid])
    H, W = m.shape
    sheets = {}
    for y in range(H):
        for x in range(W):
            if not m[y, x]:
                continue
            interior = not any(cell_sig(m, y, x))
            for kind, salt in (("details", 1), ("decals", 2)):
                if kind == "decals" and not interior:
                    continue
                sheet, count, cols, chance = t[kind]
                h = hash32(x, y, salt)
                if (h & 0xFFFF) / 0x10000 >= chance:
                    continue
                i = (h >> 16) % count
                if sheet not in sheets:
                    sheets[sheet] = Image.open(os.path.join(tiles_dir, sheet)).convert("RGBA")
                spr = sheets[sheet].crop(((i % cols) * N, (i // cols) * N, (i % cols) * N + N, (i // cols) * N + N))
                if (h >> 31) & 1:
                    spr = spr.transpose(Image.FLIP_LEFT_RIGHT)
                canvas.alpha_composite(spr, (x * N, y * N))
