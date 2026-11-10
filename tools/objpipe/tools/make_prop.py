"""Props, wall openings and decals: Nano Banana on magenta -> palette-locked sprite of any tile size.

  python3 make_prop.py --name barrel --w 1 --h 1.5 --what "a rusty oil drum"
  python3 make_prop.py --name car_wreck --w 2 --h 2 --what "a burned-out sedan seen from the side-front"
  python3 make_prop.py --name blood --decal --w 4 --h 1 --what "four different dark blood pools"   (top-down, no outline)
  add --variants 2 for candidates (name_v1, name_v2). Raw images go to raw/props/.

Size is in tiles (32px). Props stand on the bottom edge of the canvas (the footprint is the bottom
row of tiles; anything above overflows upward and is drawn over the tile above, like the busts).
They get the busts' 1px outline and a soft contact shadow. Decals are flat, top-down, no outline,
for laying on top of ground tiles.
"""
import argparse, os, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from palette import PALETTE, OUTLINE
from pixelize import classify, quantize

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SHADOW = (*OUTLINE, 110)

PROP_STYLE = ("A single game prop for a dark zombie-apocalypse pixel-art RPG: {what}. "
              "CAMERA (strict): classic 16-bit JRPG map view, like RPG Maker VX: the object is drawn straight-on "
              "from the front in an orthographic view; its top surface shows as a flat band directly above the "
              "front face. NO side faces visible, NO diagonal edges, NO vanishing points, NO three-quarter "
              "rotation, NO isometric angle. Vertical edges perfectly vertical, horizontal edges perfectly "
              "horizontal, the object centred and left-right symmetric where the object allows. Match the camera "
              "angle of the wooden chest reference image exactly. "
              "PARALLEL PROJECTION: the top surface is a perfect rectangle; its far (back) edge is exactly as "
              "long as its near (front) edge, its left and right edges are perfectly vertical; no foreshortening, "
              "no trapezoids, nothing gets smaller with distance. "
              "Furniture surfaces are EMPTY: nothing on top, no dishes, no tools, no items, no decorations. "
              "Light from the top-left. Bold, chunky, readable shapes, 2 to 3 tones per material, hard pixel "
              "edges, no anti-aliasing, dirty and worn, desaturated colours like the reference images. "
              "The object fills most of the frame on a flat pure magenta (#FF00FF) background. "
              "No cast shadow, no ground, no floor, no text, no other objects.")
DECAL_STYLE = ("Top-down overhead pixel-art decals for a dark zombie-apocalypse RPG: {what}. Laid out side by side "
               "in a single row with clear magenta gaps between them, each one a flat stain or mark seen straight "
               "from above, no perspective, no outline, chunky pixels, hard edges, desaturated dark colours like the "
               "reference images. Each mark sits directly on a flat pure magenta (#FF00FF) background: no panels, no boxes, no ground swatches behind them, no labels, no text.")


def fit(fig, W, H, pad=1, box=None):
    """Scale so the object fills the canvas, or fits inside box=(bw, bh) px for real-world sizing
    (a chair shouldn't be as big as a wardrobe). Bottom-centred either way."""
    ys, xs = np.nonzero(fig)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    bw, bh = box if box else (W - 2 * pad, H - pad)
    s = max((y1 - y0 + 1) / bh, (x1 - x0 + 1) / bw)
    cx = (x0 + x1 + 1) / 2
    return s, cx - W / 2 * s, y1 + 1 - H * s          # bottom of object on the canvas bottom


def downsample(rgb, fig, W, H, s, ox, oy, cover=0.45):
    out = np.zeros((H, W, 4), np.uint8)
    for ty in range(H):
        for tx in range(W):
            xa, ya = int(round(ox + tx * s)), int(round(oy + ty * s))
            xb, yb = int(round(ox + (tx + 1) * s)), int(round(oy + (ty + 1) * s))
            xa, ya, xb, yb = max(xa, 0), max(ya, 0), min(xb, rgb.shape[1]), min(yb, rgb.shape[0])
            if xb <= xa or yb <= ya:
                continue
            f = fig[ya:yb, xa:xb]
            if f.sum() > f.size * cover:
                med = np.median(rgb[ya:yb, xa:xb][f], 0)
                out[ty, tx] = (*PALETTE[quantize(med[None, None])[0, 0]], 255)
    return out


def outline(out):
    solid = out[..., 3] == 255
    pad = np.pad(solid, 1)
    edge = solid & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    out[edge] = (*OUTLINE, 255)
    return out


def contact_shadow(out, foot_h):
    """Soft ellipse under the object's base, outline colour at partial alpha, behind the object."""
    H, W = out.shape[:2]
    solid = out[..., 3] == 255
    cols = np.nonzero(solid[H - foot_h // 2:].any(0))[0]
    if not len(cols):
        return out
    cx, rx = (cols.min() + cols.max()) / 2, (cols.max() - cols.min()) / 2 + 2
    cy, ry = H - 3, 3
    ys, xs = np.mgrid[0:H, 0:W]
    ell = ((xs + .5 - cx - .5) / rx) ** 2 + ((ys + .5 - cy) / ry) ** 2 <= 1
    out[ell & ~solid] = SHADOW
    return out


def split_decals(rgb, fig, n, cell=8, gap=1):
    """Find the n biggest decals anywhere on the sheet (grid or row), grouping pieces that sit
    within `gap` coarse cells of each other (scattered leaves stay one decal). Each gets its own
    32x32 cell. Big ones are fitted to the cell; small ones are enlarged at most 2x relative."""
    H, W = fig.shape
    gh, gw = H // cell, W // cell
    coarse = fig[:gh * cell, :gw * cell].reshape(gh, cell, gw, cell).mean((1, 3)) > 0.05
    grown = coarse.copy()
    for _ in range(gap):
        p = np.pad(grown, 1)
        grown = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    lab = np.zeros((gh, gw), int); k = 0
    for y in range(gh):
        for x in range(gw):
            if grown[y, x] and not lab[y, x]:
                k += 1; st = [(y, x)]; lab[y, x] = k
                while st:
                    cy, cx = st.pop()
                    for j, i in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= j < gh and 0 <= i < gw and grown[j, i] and not lab[j, i]:
                            lab[j, i] = k; st.append((j, i))
    boxes = []
    for c in range(1, k + 1):
        m = (lab == c) & coarse
        if not m.any():
            continue
        full = np.kron(m, np.ones((cell, cell), bool))
        full = np.pad(full, ((0, H - full.shape[0]), (0, W - full.shape[1])))
        f = fig & full
        ys, xs = np.nonzero(f)
        boxes.append((f.sum(), xs.min(), xs.max() + 1, ys.min(), ys.max() + 1, f))
    boxes = sorted(boxes, key=lambda b: -b[0])[:n]
    boxes.sort(key=lambda b: (b[3] // (H // 3), b[1]))          # reading order
    s0 = max(max(x1 - x0, y1 - y0) / 28 for _, x0, x1, y0, y1, _ in boxes)
    out = np.zeros((32, 32 * len(boxes), 4), np.uint8)
    for i, (_, x0, x1, y0, y1, f) in enumerate(boxes):
        si = min(s0, max(max(x1 - x0, y1 - y0) / 28, s0 * 0.5))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        out[:, i * 32:(i + 1) * 32] = downsample(rgb, f, 32, 32, si, cx - 16 * si, cy - 16 * si, cover=0.25)
    return out


PX_PER_M = 27          # 48px human = 1.8 m


def size_rule(width_m, height_m, depth_m):
    """Santi's size rule: canvas and object box from real-world size, measured against the 32x48 human.
    width -> whole tiles; height = front height + top depth (full scale, top capped at 1 tile);
    canvas height = nearest multiple of 16 (ties round down), at least 32."""
    import math
    tiles = max(1, math.ceil(width_m * PX_PER_M / 32 - 0.05))
    h = height_m * PX_PER_M + min(depth_m * PX_PER_M, 32)
    canvas_h = max(32, math.ceil(h / 16 - 0.5) * 16)          # nearest 16, ties down
    return tiles, canvas_h / 32, (tiles * 32 - 2, min(int(round(h)), canvas_h - 1))


def row_spans(out):
    solid = out[..., 3] == 255
    spans = {}
    for y in range(out.shape[0]):
        xs = np.nonzero(solid[y])[0]
        if len(xs):
            spans[y] = (xs.min(), xs.max())
    return spans


def taper(out):
    """Pixels the far (top) edge is narrower than the widest row in the upper 40% of the object.
    0-2 = square top (fine); more = the AI drew perspective."""
    sp = row_spans(out)
    ys = sorted(sp)
    if not ys:
        return 0, None
    band = [y for y in ys if y <= ys[0] + 0.4 * (ys[-1] - ys[0])]
    near = max(band, key=lambda y: sp[y][1] - sp[y][0])
    far_w = np.mean([sp[y][1] - sp[y][0] for y in ys[:2]])
    return int(round((sp[near][1] - sp[near][0]) - far_w)), near


def rectify(out):
    """Undo a perspective top: stretch every row above the near edge to the near edge's span."""
    t, near = taper(out)
    if t <= 2:
        return out
    sp = row_spans(out)
    L, R = sp[near]
    res = out.copy()
    for y in sorted(sp):
        if y >= near:
            break
        l, r = sp[y]
        res[y] = 0
        for x in range(L, R + 1):
            sx = int(round(l + (x - L) * (r - l) / max(R - L, 1)))
            res[y, x] = out[y, sx]
    return res


def pixelize_prop(src, dst, W, H, decal=False, box=None, square_top=True):
    rgb, bg, sh = classify(Image.open(src))
    fig = ~bg & ~sh
    if decal:
        if bg.mean() < 0.3:          # AI drew a backing panel: key out its flat colour instead
            med = np.median(rgb[~bg], 0)
            near = bg.copy()
            for _ in range(8):                       # drop the panel borders next to magenta
                p = np.pad(near, 1)
                near = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
            fig = ~near & (np.abs(rgb - med).sum(-1) > 40)
        out = split_decals(rgb, fig, W // 32)
        Image.fromarray(out).save(dst)
        return out
    s, ox, oy = fit(fig, W, H, box=box)
    out = downsample(rgb, fig, W, H, s, ox, oy)
    out = outline(rectify(out) if square_top else out)
    t, _ = taper(out)
    if t > 2:
        if square_top: print(f"  WARNING {os.path.basename(dst)}: top still tapers by {t}px")
    # no baked shadows (Santi, Nov 10): the engine draws any shadow it wants
    Image.fromarray(out).save(dst)
    return out


def make(name, what, w, h, decal=False, variants=1, box=None, square_top=True, ref=None):
    from nano import generate
    W, H = int(w * 32), int(h * 32)
    refs = [Image.open(os.path.join(ROOT, "samples/palette.png")).convert("RGBA"),
            Image.open(os.path.join(ROOT, "samples/preview_scene.png")).convert("RGBA")]
    if not decal:   # camera reference: a prop already drawn in the locked front view
        refs.append(Image.open(os.path.join(ROOT, "raw/props/chest_o_v2.png")).convert("RGBA"))
    if ref:         # same object, another facing: keep its design
        refs.append(Image.open(ref).convert("RGBA"))
    prompt = (DECAL_STYLE if decal else PROP_STYLE).format(what=what)
    aspect = "1:1" if abs(W - H) < 8 else ("16:9" if W > H * 1.5 else "4:3" if W > H else "2:3" if H > W * 1.3 else "3:4")
    model = os.environ.get("NANO_MODEL", "gemini-3.1-flash-image")
    names = [name] if variants == 1 else [f"{name}_v{i + 1}" for i in range(variants)]
    os.makedirs(os.path.join(ROOT, "raw/props"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "out/props"), exist_ok=True)

    def one(n):
        raw = os.path.join(ROOT, "raw/props", n + ".png")
        generate(prompt, refs, aspect=aspect, model=model).save(raw)
        dst = os.path.join(ROOT, "out/props", n + ".png")
        pixelize_prop(raw, dst, W, H, decal, box, square_top)
        print("wrote", dst)
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, names))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--what", required=True)
    ap.add_argument("--w", type=float, default=1)
    ap.add_argument("--h", type=float, default=1)
    ap.add_argument("--decal", action="store_true")
    ap.add_argument("--variants", type=int, default=1)
    ap.add_argument("--box", help="fit the object inside WxH px of the canvas (true scale), e.g. 26x28")
    ap.add_argument("--size", help="real size in metres W,H,D (e.g. 1.6,0.75,0.9); sets --w/--h/--box by the size rule")
    ap.add_argument("--ref", help="raw image of the same object to match (e.g. other facings)")
    ap.add_argument("--free-top", action="store_true", help="don't square the top (cars, trees, round things whose top is legitimately narrower)")
    ap.add_argument("--repixel", help="skip generation; re-pixelize this raw image")
    o = ap.parse_args()
    box = tuple(int(v) for v in o.box.split('x')) if o.box else None
    if o.size:
        o.w, o.h, box = size_rule(*[float(v) for v in o.size.split(',')])
        print(f"size rule: canvas {int(o.w * 32)}x{int(o.h * 32)}, object box {box[0]}x{box[1]}")
    if o.repixel:
        pixelize_prop(o.repixel, os.path.join(ROOT, "out/props", o.name + ".png"), int(o.w * 32), int(o.h * 32), o.decal, box, not o.free_top)
    else:
        make(o.name, o.what, o.w, o.h, o.decal, o.variants, box, not o.free_top, o.ref)
