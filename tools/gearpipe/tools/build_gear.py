"""Batch-generate paper-doll gear on the bald base, with automatic tint masks.

For each item:
  1. Nano Banana adds the item to the bald male base image          -> raw/gear/<id>.png
  2. if tintable: a second edit recolours ONLY the tintable part to
     flat #00FF00, everything else identical                         -> raw/gear/<id>_key.png
  3. pixelize.py layer: keep only changed pixels                    -> out/gear/<id>.png
  4. green pixels of the key image become the shade mask            -> out/gear/<id>.tint.png
     (shade 0-3 from the item's own luminance; outline stays fixed)

python3 build_gear.py            # all items not yet built
python3 build_gear.py cap hoodie # just these (re-run to regenerate)
"""
import json, os, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image

os.environ.setdefault("NANO_MODEL", "gemini-3.1-flash-image")
from nano import generate
from pixelize import pixelize_layer, classify, downsample
from tint import LEVELS
from palette import OUTLINE

ROOT = os.path.dirname(os.path.abspath(__file__)) + "/.."
BASE_RAW = f"{ROOT}/raw/base_bald_m.png"
BASE_PNG = f"{ROOT}/out/hair/body_survivor_bald.png"
RAW, OUT = f"{ROOT}/raw/gear", f"{ROOT}/out/gear"

KEEP = ("Keep the same chunky stylized pixel art style. Keep EVERYTHING else exactly identical: same face, "
        "same bald head unless the item covers it, same position and size in the frame, same pixel grid, same "
        "colours, same pedestal, same magenta background. Do NOT add arms or hands. Only add the item described; "
        "do not move, redraw or restyle anything else. Bold simple readable shapes, 2 to 3 tones per material, "
        "1-pixel near-black outline.")
MOUNT = ("mounted on the bust like a game piece's weapon, no hands holding it, large and clearly readable, "
         "pointing forward and up toward the upper-RIGHT of the image (the direction he faces)")
OFF = "mounted in front of the LEFT side of the chest (the left side of the image), no hands holding it"

# id: (filename, prompt, tintable part or None)
ITEMS = {
    # head
    "cap":      ("helm_cap", "put a worn baseball cap on his head, peak facing forward and slightly to the right, plain fabric, no logo", "the fabric of the cap"),
    "beanie":   ("helm_beanie", "put a knitted beanie hat on his head, folded cuff, slightly slouchy", "the knitted beanie"),
    "bandana":  ("helm_bandana", "tie a cloth bandana over his nose and mouth like a face mask, knot at the back of the head, simple paisley dots", "the bandana cloth"),
    "hardhat":  ("helm_hardhat", "put a big bright construction hard hat on his head: a smooth rounded dome shell with a raised ridge down the middle and a short brim all around, scuffed, clearly a hard hat and not a cap", "the shell of the hard hat"),
    "moto":     ("helm_moto", "put a full-face motorcycle helmet on his head, dark tinted visor closed, scratched shell", "the helmet shell, not the visor"),
    "gasmask":  ("helm_gasmask", "put a black rubber military gas mask with a round filter canister on his face, straps over the bald head", None),
    # torso
    "hoodie":   ("chest_hoodie", "dress the whole torso in a worn pullover hoodie with the hood down behind the neck, a front pocket, white drawstrings", "the hoodie fabric, not the drawstrings"),
    "flannel":  ("chest_flannel", "dress the whole torso in a buttoned flannel shirt with a bold plaid pattern of dark lines, rolled collar", "the shirt's base colour, not the dark plaid lines or buttons"),
    "puffer":   ("chest_puffer", "dress the whole torso in a puffy quilted winter jacket with horizontal padded segments, zipped up, a little torn", "the jacket fabric, not the zipper"),
    "hivis":    ("chest_hivis", "dress him in a dark grey t-shirt with a high-visibility work vest over it, with two horizontal silver reflective stripes", "the high-visibility vest fabric only, not the stripes or the t-shirt"),
    "carrier":  ("chest_plate_carrier", "dress him in a dark t-shirt with a military plate carrier over it: a chest plate, three magazine pouches on the belly, webbing", "the fabric of the plate carrier and its pouches, not the t-shirt"),
    "scrap":    ("chest_scrap_armor", "give him improvised scrap armour covering the whole torso: big chunky padded sports pads (an American football shoulder pad set over the shoulders and a thick padded chest protector) strapped on with a few strips of grey duct tape, one dented metal plate on the belly", "the padded sports pads only, not the duct tape or metal plate"),
    "doctor":   ("chest_doctor_coat", "dress him in a long doctor's coat open over a blue scrub top, a stethoscope around the neck, a few blood stains on the coat", "the coat fabric only, not the stethoscope, scrubs or blood"),
    # back
    "backpack": ("back_backpack", "give him a big hiking backpack worn on his back, the top of the pack and its bedroll visible above and beside his shoulders behind him, straps over the shoulders", "the backpack fabric, not the straps or bedroll"),
    # weapons
    "bat":      ("sword_nail_bat", f"attach a wooden baseball bat with rusty nails hammered through its end, {MOUNT}", None),
    "crowbar":  ("sword_crowbar", f"attach a long red-painted steel crowbar with a hooked end, {MOUNT}", None),
    "axe":      ("sword_fire_axe", f"attach a firefighter's axe with a red axe head and a long yellow-black handle, {MOUNT}", None),
    "knife":    ("sword_kitchen_knife", f"attach a big kitchen chef's knife with a black handle, {MOUNT}", None),
    "shotgun":  ("gun_shotgun", f"attach a pump-action shotgun with a wooden stock and pump, {MOUNT}", None),
    "rifle":    ("gun_hunting_rifle", f"attach a long bolt-action hunting rifle with a wooden stock and a black scope, held diagonally across the front of the body: the stock low at the bottom LEFT of the torso and the barrel pointing forward and up past the RIGHT shoulder toward the upper-right corner of the image, no hands holding it, large and clearly readable", None),
    "revolver": ("gun_revolver", f"attach a big chunky silver revolver with a dark wooden grip, as long as the head is wide, {MOUNT}", None),
    # off-hand
    "stopsign": ("offhand_stop_sign", f"attach an improvised shield made from a dented red stop sign with a clear eight-sided OCTAGON outline, a thick white border line following the octagon, blank with no letters, {OFF}, covering the left half of the torso", None),
    "riot":     ("offhand_riot_shield", f"attach a tall black opaque police riot shield with a small clear viewing window at the top and a white horizontal stripe, {OFF}, covering the left half of the torso", None),
    "flashlight": ("offhand_flashlight", f"attach a big chunky flashlight {OFF}, pointing forward to the right with a pale yellow light at its lens", "the flashlight body, not the lens or light"),
}


def gen(path, prompt, ref, tries=4):
    for i in range(tries):
        try:
            generate(prompt, [Image.open(ref).convert("RGBA")]).save(path)
            return
        except Exception as e:
            print("  retry", os.path.basename(path), str(e)[:120], flush=True)
            time.sleep(4 * (i + 1))
    raise RuntimeError("failed " + path)


def build(key):
    fname, what, tint = ITEMS[key]
    raw, kraw, out = f"{RAW}/{key}.png", f"{RAW}/{key}_key.png", f"{OUT}/{fname}.png"
    gen(raw, f"Edit this pixel art bust miniature: {what}. {KEEP}", BASE_RAW)
    pixelize_layer(raw, out, BASE_RAW, BASE_PNG)
    mpath = out[:-4] + ".tint.png"
    if os.path.exists(mpath):
        os.remove(mpath)
    if tint:
        gen(kraw, f"Recolour ONLY {tint} to a completely flat pure bright green (#00FF00), no shading at all. "
                  f"Keep everything else in the image exactly identical: same shapes, pixels, colours and position.", raw)
        make_mask(out, kraw)
    print("built", key, flush=True)


def make_mask(layer_png, key_raw):
    t = json.load(open(BASE_PNG + ".json"))
    rgb, bg, sh = classify(Image.open(key_raw))
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    green = (g > 150) & (r < 130) & (b < 130)
    gm = downsample(rgb, green, np.zeros_like(green), t, outline=False)[..., 3] == 255
    a = np.asarray(Image.open(layer_png).convert("RGBA")).copy()
    sel = gm & (a[..., 3] == 255) & ~np.all(a[..., :3] == OUTLINE, -1)
    lum = a[..., :3].astype(float) @ [0.299, 0.587, 0.114]
    uniq = sorted(set(np.round(lum[sel], 1)))
    shade = {u: round(i * 3 / max(len(uniq) - 1, 1)) for i, u in enumerate(uniq)}
    mask = np.zeros_like(a)
    for y, x in zip(*np.nonzero(sel)):
        v = LEVELS[shade[round(lum[y, x], 1)]]
        mask[y, x] = (v, v, v, 255)
    a[sel] = 0
    Image.fromarray(a).save(layer_png)
    Image.fromarray(mask).save(layer_png[:-4] + ".tint.png")
    print(f"  mask {os.path.basename(layer_png)}: {int(sel.sum())} px", flush=True)


if __name__ == "__main__":
    os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    keys = sys.argv[1:] or [k for k in ITEMS if not os.path.exists(f"{OUT}/{ITEMS[k][0]}.png")]
    with ThreadPoolExecutor(4) as ex:
        for f in [ex.submit(build, k) for k in keys]:
            try:
                f.result()
            except Exception as e:
                print("FAILED", e, flush=True)
