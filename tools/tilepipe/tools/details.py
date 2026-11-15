"""Ground variety layer: plain base tile + a sheet of detail sprites the engine scatters per cell.

  python3 details.py raw/tiles2/grass_dead.png out/tiles/grass_dead [--contrast 2.5] [--joints 32] [--shift -0.2]
      -> grass_dead.png          plain base tile (32x32, wraps; only the 2 main colours)
         grass_dead_details.png  detail sprites, one per 32x32 cell (8 per row), transparent
         grass_dead_details.json {"count": n}

How: the AI texture is pixelized and palette-locked like make_tile.py. Its 2 most common colours
are the ground itself; every connected blob of other colours (tufts, pebbles, cracks, stains) is a
"detail". Details are cut out and each placed at a random spot inside its own cell, so the engine
only has to pick an index. The base tile is the same texture with the details painted out, so it
repeats without anything for the eye to catch.
"""
import argparse, json, os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import make_tile as mt

N = 32


def components(mask):
    H, W = mask.shape
    seen = np.zeros_like(mask)
    out = []
    for y in range(H):
        for x in range(W):
            if mask[y, x] and not seen[y, x]:
                comp, st = [], [(y, x)]
                seen[y, x] = True
                while st:
                    cy, cx = st.pop(); comp.append((cy, cx))
                    for j in (-1, 0, 1):
                        for i in (-1, 0, 1):
                            ny, nx = cy + j, cx + i
                            if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                                seen[ny, nx] = True; st.append((ny, nx))
                out.append(np.array(comp))
    return out


def texture(src, px=112, ring=10, contrast=2.5, shift=0.0):
    P = mt.pixelize(Image.open(src), px)
    mean = P.reshape(-1, 3).mean(0)
    P = np.clip(mean * (1 + shift) + (P - mean) * contrast, 0, 255)
    S = mt.quantize_to(P, mt.GROUND, mt.GROUND_LAB)
    return S[ring:px - ring, ring:px - ring]


def main_colours(S, k=2):
    cols, counts = np.unique(S.reshape(-1, 3), axis=0, return_counts=True)
    order = np.argsort(-counts)
    keep = [cols[order[0]]]
    for i in order[1:k]:
        if counts[i] / counts.sum() > 0.12:
            keep.append(cols[i])
    return np.array(keep)


def paint_out(S, base_cols):
    """Replace non-base pixels with the nearest base colour."""
    isbase = (S[..., None, :] == base_cols[None, None]).all(-1).any(-1)
    lab = mt.to_lab(S.astype(np.float32))
    blab = mt.to_lab(base_cols.astype(np.float32)[None])[0]
    near = ((lab[..., None, :] - blab[None, None]) ** 2).sum(-1).argmin(-1)
    out = S.copy()
    out[~isbase] = base_cols[near[~isbase]]
    return out, isbase


def speckle(t, dom, rng, amount=0.08):
    """Quiet grain so the base isn't a flat fill: tiny darker/lighter specks of the main colour."""
    from autotile import darker
    t = t.copy()
    dk, lt = darker(dom, 0.8), darker(dom, 1.2)
    for _ in range(int(N * N * amount)):
        y, x = rng.integers(0, N, 2)
        c = dk if rng.random() < 0.6 else lt
        t[y, x] = c
        if rng.random() < 0.4:
            t[y, (x + 1) % N] = c
    return t


def panel_tile(S, rng, tries=60):
    """Built surfaces: a seamless quilt cuts through plates and planks and the repeat shows as a smeared grid.
    Instead take the calmest 32px window (one or two units, few colours, closest to neutral), and hide the wrap
    behind a seam of the material itself on the tile edge: dark line on top/left, light lip after it,
    with a few bead pixels. The surface reads as panels laid on the tile grid, like floor tiles."""
    from autotile import darker
    H = S.shape[0]
    best = None
    for _ in range(tries):
        y0, x0 = rng.integers(0, H - N + 1, 2)
        w = S[y0:y0 + N, x0:x0 + N]
        lab = mt.to_lab(w.astype(np.float32))
        edges = (np.abs(np.diff(lab, axis=0)).sum(-1) > 25).mean() + (np.abs(np.diff(lab, axis=1)).sum(-1) > 25).mean()
        ncol = len(np.unique(w.reshape(-1, 3), axis=0))
        chroma = np.hypot(lab[..., 1], lab[..., 2]).mean()
        score = -edges - 0.01 * ncol - 0.01 * chroma
        if best is None or score > best[1]:
            best = (w.copy(), score)
    t = best[0].astype(np.uint8)
    dark = mt.quantize_to(np.array([[[24, 22, 26]]], np.float32), mt.GROUND, mt.GROUND_LAB)[0, 0]
    for i in range(N):
        t[0, i] = t[i, 0] = dark
        for (y, x) in ((1, i), (i, 1)):
            if x > 0 and y > 0:
                t[y, x] = darker(t[y, x], 1.15)
        if rng.random() < 0.18:          # weld/joint beads along the seam
            t[0, i] = darker(t[1, i], 0.75)
        if rng.random() < 0.18:
            t[i, 0] = darker(t[i, 1], 0.75)
    return t


def run(src, prefix, contrast=2.5, shift=0.0, joints=0, max_details=24, seed=0, pattern=False, px=None):
    # built surfaces are shrunk harder so one 32px tile holds several plates/planks, not one big unit
    px = px or (int(os.environ.get("PATTERN_PX", 150)) if pattern else 112)
    S = texture(src, px=px, ring=max(4, px * 10 // 112), contrast=contrast, shift=shift)
    base_cols = main_colours(S)
    flat, isbase = paint_out(S, base_cols)
    if pattern:
        # built surfaces (plates, planks, tiles): the seams and welds ARE the material, so the base keeps
        # the full texture; only small specks become scatter details
        flat = S.copy()

    # base tile: quilt the painted-out texture so it wraps
    rng = np.random.default_rng(seed)
    if pattern:
        base = panel_tile(S, rng)
        Image.fromarray(base).save(prefix + ".png")
    best = None
    span = flat.shape[0] - N - mt.K
    for _ in range(0 if pattern else 25):
        x0, y0 = rng.integers(0, max(span, 0) + 1, 2)
        t, err = mt.wrap_tile(flat.astype(np.float32), x0, y0)
        if best is None or err < best[1]:
            best = (t, err)
    if not pattern:
        base = speckle(best[0].astype(np.uint8), base_cols[0], rng)
        if joints:
            base = mt.add_joints(base, joints)
        Image.fromarray(base).save(prefix + ".png")

    # details: blobs of non-base colour, plus a 1px base-colour-free crop
    comps = [c for c in components(~isbase) if 3 <= len(c) <= (40 if pattern else 220)]
    comps = [c for c in comps if np.ptp(c[:, 0]) < 24 and np.ptp(c[:, 1]) < 24
             and c[:, 0].min() > 0 and c[:, 1].min() > 0 and c[:, 0].max() < S.shape[0] - 1 and c[:, 1].max() < S.shape[1] - 1]
    comps.sort(key=len, reverse=True)
    # keep a spread of sizes: alternate big and small ones
    if len(comps) > max_details:
        idx = np.linspace(0, len(comps) - 1, max_details).astype(int)
        comps = [comps[i] for i in idx]
    cells = []
    for c in comps:
        y0, x0 = c.min(0)
        h, w = np.ptp(c[:, 0]) + 1, np.ptp(c[:, 1]) + 1
        spr = np.zeros((h, w, 4), np.uint8)
        for (y, x) in c:
            spr[y - y0, x - x0] = (*S[y, x], 255)
        cell = np.zeros((N, N, 4), np.uint8)
        # keep clear of the 7px edge band so details are safe on autotile edge cells too
        m = 7 if max(h, w) <= N - 14 else 2
        oy = int(rng.integers(m, max(m + 1, N - h - m + 1)))
        ox = int(rng.integers(m, max(m + 1, N - w - m + 1)))
        cell[oy:oy + h, ox:ox + w] = spr
        cells.append(cell)
    cols = 8
    rows = max(1, (len(cells) + cols - 1) // cols)
    sheet = np.zeros((rows * N, cols * N, 4), np.uint8)
    for i, cell in enumerate(cells):
        r, c = divmod(i, cols)
        sheet[r * N:(r + 1) * N, c * N:(c + 1) * N] = cell
    Image.fromarray(sheet).save(prefix + "_details.png")
    json.dump({"count": len(cells), "cols": cols}, open(prefix + "_details.json", "w"))
    print(f"wrote {prefix}.png and {len(cells)} details -> {prefix}_details.png")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("prefix")
    ap.add_argument("--contrast", type=float, default=2.5)
    ap.add_argument("--shift", type=float, default=0.0)
    ap.add_argument("--joints", type=int, default=0)
    ap.add_argument("--max", type=int, default=24)
    o = ap.parse_args()
    run(o.src, o.prefix, o.contrast, o.shift, o.joints, o.max)
