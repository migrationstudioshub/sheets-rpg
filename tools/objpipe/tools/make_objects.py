"""Make ONE map object (furniture, prop, vehicle, tree...) end to end, the way the pilot objects were made.

  python3 make_objects.py --name bookshelf --size 1.0,1.9,0.4 --what "a tall wooden bookshelf with a few dusty books"
  python3 make_objects.py --name chair --size 0.45,0.9,0.45 --box 26x40 --views down,up,side --what "a simple wooden kitchen chair"
  python3 make_objects.py --name car_sedan --size 4.5,1.4,1.8 --free-top --what "a burned-out sedan, long side facing the viewer"
  python3 make_objects.py --name sofa --size 2.0,0.9,0.9 --what "a torn fabric sofa" --variants 3

  --size W,H,D   real size in metres; the size rule (STYLE_GUIDE.md) turns it into the canvas
                 (whole tiles wide, height to the nearest 16px) - the 32x48 human is 1.8 m.
  --box WxH      optional override of the object's box inside the canvas (e.g. chairs read better bigger).
  --views        down (faces the viewer, default), up (seen from behind), side (faces right; the engine
                 flips it for left). Extra views are generated from the 'down' result so they match.
  --free-top     skip squaring the top (cars, trees, round things whose top is really narrower).
  --variants N   N candidates per view (name_vN); pick from the review sheet.

Writes, in ../out/objects/:
  <name>[_<view>][_vN].png    the object (RGBA, palette-locked, 1px outline, no shadow)
  review_<name>.png           every candidate at 1x and 4x on a wood floor, next to a 32x48 bust for scale,
                              with the mirrored copy for side views; prints its canvas, size and top taper.
Copy approved files (dropping _vN) into your game's object folder and add a row to objects.json.
"""
import argparse, os, sys
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_prop as mp

ROOT = mp.ROOT
RAW, OUT = f"{ROOT}/raw/objects", f"{ROOT}/out/objects"
CAMERA_REF = f"{ROOT}/raw/props/chest_o_v2.png"
VIEW_TEXT = {
    "down": "{what}, facing the viewer",
    "up": "the SAME object as the last reference image ({what}), but seen from behind: it faces away from the "
          "viewer, toward the wall. Same materials, same size, same style",
    "side": "the SAME object as the last reference image ({what}), but turned 90 degrees: we now see its SIDE "
            "(profile) straight on, NOT its front. Its front/seat points to the RIGHT edge of the image and its "
            "back is on the LEFT, so the silhouette is clearly asymmetric (for a chair: an L or h shape, backrest "
            "standing up on the left). Same materials, same size, same style",
}


def aspect_for(W, H):
    return "1:1" if abs(W - H) < 8 else ("16:9" if W > H * 1.5 else "4:3" if W > H else "2:3" if H > W * 1.3 else "3:4")


def generate(raw, what, ref=None, aspect="1:1"):
    from nano import generate as nano
    refs = [Image.open(f"{ROOT}/samples/palette.png").convert("RGBA"),
            Image.open(f"{ROOT}/samples/preview_scene.png").convert("RGBA"),
            Image.open(CAMERA_REF).convert("RGBA")]
    if ref:
        refs.append(Image.open(ref).convert("RGBA"))
    style = mp.PROP_STYLE.format(what=what)
    if "turned 90 degrees" in what:   # side view: the front-view wording must not fight the profile
        style = style.replace("the object is drawn straight-on from the front", "the object's side is drawn straight-on")
        style = style.replace("left-right symmetric where the object allows", "asymmetric, seen in profile")
        style = style.replace("front face", "side face")
    img = nano(style, refs, aspect=aspect,
               model=os.environ.get("NANO_MODEL", "gemini-3.1-flash-image"))
    img.save(raw)
    return raw


def review(files, out):
    """Each candidate at 1x and 4x on wood floor tiles, with a bust beside it for scale."""
    floor = Image.open(f"{ROOT}/samples/tiles/tile_floor.png").convert("RGBA")
    bust = Image.open(f"{ROOT}/samples/characters/body_survivor.png").convert("RGBA")
    shirt = f"{ROOT}/samples/characters/chest_hoodie.png"
    if os.path.exists(shirt):
        from tint import apply
        bust = Image.alpha_composite(bust, apply(shirt, "charcoal"))
    cells = []
    for f in files:
        o = Image.open(f).convert("RGBA")
        imgs = [o] + ([o.transpose(Image.FLIP_LEFT_RIGHT)] if "_side" in os.path.basename(f) else [])
        W = sum(i.width for i in imgs) + 32 + 8 * len(imgs)
        H = max(max(i.height for i in imgs), 48) + 8
        c = Image.new("RGBA", (W, H))
        for y in range(0, H, 32):
            for x in range(0, W, 32):
                c.alpha_composite(floor, (x, y))
        x = 4
        for i in imgs:
            c.alpha_composite(i, (x, H - 4 - i.height)); x += i.width + 8
        c.alpha_composite(bust, (x, H - 4 - 48))
        cells.append((os.path.basename(f), c))
    z = 4
    W = max(c.width * (z + 1) for _, c in cells) + 24
    H = sum(c.height * z + 24 for _, c in cells) + 8
    sheet = Image.new("RGBA", (W, H), (40, 37, 35, 255))
    y = 8
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for name, c in cells:
        d.text((8, y), name, fill=(230, 220, 200))
        sheet.alpha_composite(c, (8, y + 14))
        sheet.alpha_composite(c.resize((c.width * z, c.height * z), Image.NEAREST), (16 + c.width, y + 14))
        y += c.height * z + 24
    sheet.save(out)


def make_one(name, view, what, W, H, box, square_top, ref=None):
    raw, out = f"{RAW}/{name}.png", f"{OUT}/{name}.png"
    generate(raw, VIEW_TEXT[view].format(what=what), ref, aspect_for(W, H))
    o = mp.pixelize_prop(raw, out, W, H, False, box, square_top and view != "side")
    t, _ = mp.taper(o)
    print(f"  {name}: canvas {W}x{H}, top taper {t}px{' (check it)' if t > 2 and square_top else ''}")
    return raw, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="snake_case id, e.g. bookshelf")
    ap.add_argument("--what", required=True, help="what the object looks like (no clutter on top)")
    ap.add_argument("--size", required=True, help="real size in metres: width,height,depth")
    ap.add_argument("--box", help="override the object box inside the canvas, e.g. 26x40")
    ap.add_argument("--h", type=float, help="override canvas height in tiles (e.g. 1.5)")
    ap.add_argument("--views", default="down", help="comma list of down,up,side")
    ap.add_argument("--free-top", action="store_true")
    ap.add_argument("--variants", type=int, default=2)
    a = ap.parse_args()
    os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    tw, th, box = mp.size_rule(*[float(v) for v in a.size.split(",")])
    if a.h: th = a.h
    if a.box: box = tuple(int(v) for v in a.box.split("x"))
    W, H = int(tw * 32), int(th * 32)
    print(f"size rule: canvas {W}x{H}, object box {box[0]}x{box[1]}")
    views = [v.strip() for v in a.views.split(",")]
    multi = len(views) > 1
    vn = lambda base, i: base if a.variants == 1 else f"{base}_v{i + 1}"
    files = []
    # 'down' first: the other views use its first candidate as the design reference
    base = f"{a.name}_down" if multi else a.name
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(lambda i: make_one(vn(base, i), "down", a.what, W, H, box, not a.free_top), range(a.variants)))
    files += [r[1] for r in res]
    ref = res[0][0]
    for v in views:
        if v == "down":
            continue
        with ThreadPoolExecutor(4) as ex:
            res = list(ex.map(lambda i: make_one(vn(f"{a.name}_{v}", i), v, a.what, W, H, box, not a.free_top, ref),
                              range(a.variants)))
        files += [r[1] for r in res]
    sheet = f"{OUT}/review_{a.name}.png"
    review(files, sheet)
    print("  review:", sheet)


if __name__ == "__main__":
    main()
