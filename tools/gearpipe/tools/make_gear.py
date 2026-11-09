"""Make ONE paper-doll item (or hairstyle) end to end, the same way the starter gear was made.

  python3 make_gear.py --slot armor   --name trench_coat --what "a long dirty trench coat, belted" --tint "the coat fabric, not the belt buckle"
  python3 make_gear.py --slot weapon  --name crossbow    --what "a loaded wooden crossbow"
  python3 make_gear.py --slot helm    --name cowboy_hat  --what "a battered leather cowboy hat" --tint "the hat" --keep-hair
  python3 make_gear.py --slot hair    --name dreads      --what "shoulder-length dreadlocks"
  add --variants 3 to generate 3 candidates (name_v1..v3) and pick the best from the sheet.

Writes, in ../out/gear/:
  <prefix>_<name>.png        fixed pixels (the layer)
  <prefix>_<name>.tint.png   shade mask, if --tint (or always for hair)
  review_<prefix>_<name>.png sheet: male + female + zombie, default/alt tints, both facings
Copy approved files into ../samples/characters/ (or your game's art folder).
"""
import argparse, os, shutil
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image

import build_gear as bg
from pixelize import pixelize_layer
from tint import apply, split

ROOT = bg.ROOT
CHAR = f"{ROOT}/samples/characters"

# slot -> (file prefix, placement sentence appended to the description)
SLOTS = {
    "helm":    ("helm",    "put it on his head"),
    "armor":   ("chest",   "dress the whole torso in it, down to the waist; still no arms, it ends at the rounded bust shoulders"),
    "back":    ("back",    "worn on his back: only the parts above and beside the shoulders are visible behind him"),
    "weapon":  ("weapon",  bg.MOUNT),
    "offhand": ("offhand", bg.OFF + ", covering the left half of the torso if it is big"),
    "hair":    ("hair",    "give him this hairstyle; plain medium brown hair with a dark shadow tone, a mid tone and a light "
                           "highlight from the top-left, bold chunky shapes"),
}
# weapons keep the old sword_/gun_ prefixes so existing data stays valid
WEAPON_PREFIX = {"blade": "sword", "gun": "gun"}


def review(layer_png, slot, out):
    """Composite on male, female, zombie in 3 tints, plus the west-facing flip."""
    has_mask = os.path.exists(layer_png[:-4] + ".tint.png")
    tints = (["hair_brown", "hair_black", "hair_blonde"] if slot == "hair"
             else ["navy", "maroon", "khaki"] if has_mask else [None] * 3)
    bodies = ["body_survivor", "body_survivor_female", "body_zombie"]
    tiles = []
    for b, t in zip(bodies, tints):
        body = Image.open(f"{CHAR}/{b}.png").convert("RGBA")
        lay = apply(layer_png, t) if t else Image.open(layer_png).convert("RGBA")
        im = Image.alpha_composite(lay, body) if slot == "back" else Image.alpha_composite(body, lay)
        tiles += [im, im.transpose(Image.FLIP_LEFT_RIGHT)]
    z = 5
    s = Image.new("RGBA", (len(tiles) * (32 * z + 6) + 6, 48 * z + 12), (58, 54, 50, 255))
    for i, t in enumerate(tiles):
        s.alpha_composite(t.resize((32 * z, 48 * z), Image.NEAREST), (6 + i * (32 * z + 6), 6))
    s.save(out)


def make(slot, name, what, tint, keep_hair=False, kind=None):
    prefix = SLOTS[slot][0]
    if slot == "weapon":
        prefix = WEAPON_PREFIX.get(kind or "blade", "sword")
    fname = f"{prefix}_{name}"
    raw, kraw, out = f"{bg.RAW}/{fname}.png", f"{bg.RAW}/{fname}_key.png", f"{bg.OUT}/{fname}.png"
    prompt = f"Edit this pixel art bust miniature: {what}, {SLOTS[slot][1]}. {bg.KEEP}"
    bg.gen(raw, prompt, bg.BASE_RAW)
    pixelize_layer(raw, out, bg.BASE_RAW, bg.BASE_PNG)
    mask = out[:-4] + ".tint.png"
    if os.path.exists(mask):
        os.remove(mask)
    if slot == "hair":
        split(out, ["ALL"])                          # all hair recolours, outline stays fixed
    elif tint:
        bg.gen(kraw, f"Recolour ONLY {tint} to a completely flat pure bright green (#00FF00), no shading at all. "
                     f"Keep everything else in the image exactly identical: same shapes, pixels, colours and position.", raw)
        bg.make_mask(out, kraw)
    sheet = f"{bg.OUT}/review_{fname}.png"
    review(out, slot, sheet)
    solid = int((np.asarray(Image.open(out))[..., 3] > 0).sum())
    print(f"done {fname}: {solid} fixed px, mask={'yes' if os.path.exists(mask) else 'no'}, "
          f"hides_hair={'false' if keep_hair else 'true' if slot == 'helm' else '-'}")
    print("  layer :", out)
    print("  review:", sheet)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", required=True, choices=SLOTS)
    ap.add_argument("--name", required=True, help="snake_case id, e.g. trench_coat")
    ap.add_argument("--what", required=True, help="what the item looks like")
    ap.add_argument("--tint", help="which part recolours, e.g. 'the coat fabric, not the buttons'")
    ap.add_argument("--kind", choices=["blade", "gun"], help="weapons: file prefix sword_ or gun_")
    ap.add_argument("--keep-hair", action="store_true", help="helm items worn on the face (hides_hair=false)")
    ap.add_argument("--variants", type=int, default=1)
    a = ap.parse_args()
    os.makedirs(bg.RAW, exist_ok=True); os.makedirs(bg.OUT, exist_ok=True)
    names = [a.name] if a.variants == 1 else [f"{a.name}_v{i + 1}" for i in range(a.variants)]
    with ThreadPoolExecutor(4) as ex:
        list(ex.map(lambda n: make(a.slot, n, a.what, a.tint, a.keep_hair, a.kind), names))
