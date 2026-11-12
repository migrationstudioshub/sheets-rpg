"""Make ONE terrain or wall set end to end, the way the pilot tilesets were made.

Ground (Nano Banana texture -> plain base + variety layer -> 8x8 autotile sheet):
  python3 make_tileset.py ground --name gravel --what "loose grey gravel, small stones, a few weeds" \
      --decals "six details on gravel: a large rock, a weed clump, a rusty bolt, a puddle, scattered pebbles, a crushed can"
  python3 make_tileset.py ground --name tile_floor --what "plain worn linoleum" --joints 16 --under wood
  python3 make_tileset.py ground --pattern --name steel_floor --what "salvaged steel sheets welded together"
  options: --pattern  (built surfaces: keeps seams/welds/joints; without it the base is flattened to 2 colours)
           --joints N  (slab/tile lines every N px)  --contrast 2.5  --shift -0.2 (darker)
           --details-chance 0.4 --decals-chance 0.06  --under <terrain> (what the review sits on)
           --raw <png>  reuse an existing texture image instead of generating one (no credits)

Wall (procedural bricks, no credits):
  python3 make_tileset.py wall --name wall_concrete --material concrete

Writes, in ../out/tiles/:
  <name>.png               plain base tile (32x32, wraps)
  <name>_auto.png          256x256 autotile sheet in the engine's 8x8 blob layout (templates/autotile_8x8.png)
  <name>_details.png       small detail sprites (32x32 cells), scattered by scatter.js
  <name>_decals.png        bigger decals (32x32 cells), interior cells only
  scatter.json             updated with this terrain's entry (sheet, count, cols, chance)
  review_<name>.png        test patch at 2x: this terrain as an island with edges + variety layer, and its sheet
Walls: <name>_top_auto.png (8x8 sheet), <name>_face.png (4 cols x 2 rows), review_<name>.png
"""
import argparse, json, os, shutil, sys
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_tile, details, autotile, make_prop as mp
from tile_preview import render, scatter

ROOT = mp.ROOT
TILES = f"{ROOT}/out/tiles"
ISLAND = [
    "aaaaaaaaaaaa",
    "aaannnnaaaaa",
    "aannnnnnnaaa",
    "aannnaannnaa",
    "aaannnnnnnaa",
    "aaaannnnnaaa",
    "aaaaaanaaaaa",
    "aaaaaaaaaaaa",
]


def update_scatter(name, n_details, n_decals, dc, kc):
    p = f"{TILES}/scatter.json"
    cfg = json.load(open(p)) if os.path.exists(p) else {}
    e = {}
    if n_details:
        e["details"] = [f"{name}_details.png", n_details, 8, dc]
    if n_decals:
        e["decals"] = [f"{name}_decals.png", n_decals, n_decals, kc]
    cfg[name] = e
    json.dump(cfg, open(p, "w"), indent=1)


def review_ground(name, under, out):
    grid = [r.replace("n", "n") for r in ISLAND]
    layers = {"a": f"{TILES}/{under}_auto.png", "n": f"{TILES}/{name}_auto.png"}
    img = render(grid, layers, base="a")
    cfg = json.load(open(f"{TILES}/scatter.json"))
    if under in cfg:
        scatter(img, grid, "a", under, TILES)
    scatter(img, grid, "n", name, TILES)
    sheet = Image.open(f"{TILES}/{name}_auto.png").convert("RGBA")
    W = img.width * 2 + sheet.width * 2 + 24
    H = max(img.height, sheet.height) * 2 + 30
    s = Image.new("RGBA", (W, H), (255, 0, 255, 255))
    s.alpha_composite(img.resize((img.width * 2, img.height * 2), Image.NEAREST), (8, 22))
    s.alpha_composite(sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST), (img.width * 2 + 16, 22))
    d = ImageDraw.Draw(s)
    d.rectangle((0, 0, W, 18), fill=(30, 28, 26))
    d.text((8, 4), f"{name} on {under} (2x, with variety layer)   |   autotile sheet (magenta = transparent)", fill=(230, 220, 200))
    s.save(out)


def plain_review(name, out):
    """Show a plain (non-autotiled) tile repeated, so you can see how it tiles."""
    base = Image.open(f"{TILES}/{name}.png").convert("RGBA")
    rep = Image.new("RGBA", (base.width * 4, base.height * 4))
    for yy in range(4):
        for xx in range(4):
            rep.alpha_composite(base, (xx * base.width, yy * base.height))
    rep.resize((rep.width * 2, rep.height * 2), Image.NEAREST).save(out)


def ground(a):
    raw = a.raw or make_tile.gen(a.name, a.what, a.pattern)
    contrast = a.contrast if a.contrast is not None else (1.3 if a.pattern else 2.5)
    details.run(raw, f"{TILES}/{a.name}", contrast, a.shift, a.joints, pattern=a.pattern)
    if a.plain:                                       # a plain, non-autotiled ground tile (a sprite terrain)
        out = f"{TILES}/review_{a.name}.png"
        plain_review(a.name, out)
        print(f"done {a.name} (plain tile)\n  Terrain  id={a.name}  name={a.name.replace('_', ' ')}  "
              f"sprite=art/tilesets/{a.name}.png  (no autotile)  pass_n/e/s/w=1\n  review: {out}")
        return
    autotile.build(f"{TILES}/{a.name}.png", f"{TILES}/{a.name}_auto.png")
    n_details = json.load(open(f"{TILES}/{a.name}_details.json"))["count"]
    n_decals = 0
    if a.decals:
        dn = f"decals_{a.name}"
        mp.make(dn, a.decals, 6, 1, decal=True)
        shutil.copy(f"{ROOT}/out/props/{dn}.png", f"{TILES}/{a.name}_decals.png")
        n_decals = Image.open(f"{TILES}/{a.name}_decals.png").width // 32
    elif os.path.exists(f"{TILES}/{a.name}_decals.png"):
        n_decals = Image.open(f"{TILES}/{a.name}_decals.png").width // 32
    update_scatter(a.name, n_details, n_decals, a.details_chance, a.decals_chance)
    out = f"{TILES}/review_{a.name}.png"
    review_ground(a.name, a.under, out)
    print(f"done {a.name}: {n_details} details, {n_decals} decals\n  review: {out}")


def wall(a):
    import make_wall
    m = make_wall.MATERIALS[a.material]
    prefix = f"{TILES}/{a.name}"
    Image.fromarray(make_wall.face_strip(make_wall.brick_face(m), m)).save(prefix + "_face.png")
    Image.fromarray(make_wall.cap_tile(m)).save(prefix + "_top.png")
    autotile.build(prefix + "_top.png", prefix + "_top_auto.png", style="rim")
    # review: a small room, tops + 2-tile faces under the lowest wall row
    import numpy as np
    from tile_preview import signatures, cell_sig
    walls = ["..........", ".WWWWWWWW.", ".W......W.", ".W......W.", ".WWWWWWWW.", "..........",
             "..........", ".........."]
    img = render(["a" * 10] * 8, {"a": f"{TILES}/{a.under}_auto.png"}, base="a")
    wm = np.array([[c == "W" for c in r] for r in walls])
    sig = signatures()
    top = Image.open(prefix + "_top_auto.png").convert("RGBA")
    face = Image.open(prefix + "_face.png").convert("RGBA")
    N = 32
    for y in range(8):
        for x in range(10):
            if wm[y, x]:
                r, c = sig.get(cell_sig(wm, y, x), sig[(False,) * 8])
                img.alpha_composite(top.crop((c * N, r * N, c * N + N, r * N + N)), (x * N, y * N))
    for y in range(8):
        for x in range(10):
            if wm[y, x] and (y + 1 >= 8 or not wm[y + 1, x]):
                l = x > 0 and wm[y, x - 1] and not (y + 1 < 8 and wm[y + 1, x - 1])
                rr = x + 1 < 10 and wm[y, x + 1] and not (y + 1 < 8 and wm[y + 1, x + 1])
                col = {(False, False): 0, (False, True): 1, (True, True): 2, (True, False): 3}[(l, rr)]
                img.alpha_composite(face.crop((col * N, 0, col * N + N, 64)), (x * N, (y + 1) * N))
    out = f"{TILES}/review_{a.name}.png"
    img.resize((img.width * 2, img.height * 2), Image.NEAREST).save(out)
    print(f"done {a.name}\n  review: {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["ground", "wall"])
    ap.add_argument("--name", required=True)
    ap.add_argument("--what", help="ground: what the surface is (fills the frame, no borders)")
    ap.add_argument("--decals", help="ground: a list of six bigger marks for this surface")
    ap.add_argument("--raw", help="ground: reuse this texture image (skip generation)")
    ap.add_argument("--joints", type=int, default=0)
    ap.add_argument("--contrast", type=float, default=None, help="default 2.5 (natural ground) or 1.3 (--pattern)")
    ap.add_argument("--plain", action="store_true",
                    help="ground: a plain non-autotiled tile (a sprite terrain for the base layer); skips the autotile sheet")
    ap.add_argument("--pattern", action="store_true",
                    help="built surfaces (metal plates, planks, tiles, pavers): keep seams/joints in the base tile and ask for small units")
    ap.add_argument("--shift", type=float, default=0.0)
    ap.add_argument("--details-chance", type=float, default=0.4)
    ap.add_argument("--decals-chance", type=float, default=0.06)
    ap.add_argument("--under", default="asphalt", help="terrain the review patch sits on")
    ap.add_argument("--material", default="brick", help="wall: brick | concrete (see make_wall.MATERIALS)")
    a = ap.parse_args()
    os.makedirs(TILES, exist_ok=True)
    if a.kind == "ground":
        if not (a.what or a.raw):
            ap.error("ground needs --what (or --raw)")
        ground(a)
    else:
        wall(a)
