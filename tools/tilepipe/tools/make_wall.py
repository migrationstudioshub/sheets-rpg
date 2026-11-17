"""Edge-wall art for the 2.5D (cap + face) wall renderer.

Produces TWO small sprites per wall style, the shape shared/render.js wants:
  <prefix>_face.png  32x32  front face; tiles seamlessly BOTH ways (side-by-side on E-W runs,
                            stacked for height). Same wrap requirement as a ground tile.
  <prefix>_cap.png   32x16  the lit wall top; derived from the face so it stays on-palette.

Two sources, same output shape:
  * procedural (keyless): brick / concrete / wood / stone / metal, drawn to wrap perfectly.
  * Nano Banana (optional): a front-on wall texture, then palette-locked and made seamless the
    exact way ground tiles are (reuses make_tile's pixelize + quantize + minimum-error wrap quilt).

  python3 make_wall.py proc brick out/tiles/wall_brick      # procedural face + cap
  (the AI path is driven by make_tileset.py: gen_face -> ai_cut -> derive_cap)
"""
import os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from palette import RAMPS

N = 32
_hex = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
def shade(c, f):  # nudge an rgb lighter (f>0) or darker (f<0) by a fraction of 255
    return np.clip(np.asarray(c, np.float32) + 255.0 * f, 0, 255)

# material palettes, pulled from the game ramps so procedural walls already sit in the palette.
MATS = {
    "brick":    dict(body=["#38251a", "#5b3923", "#88582f"], line="#2c2a31", hi="#88582f", unit=4),
    "concrete": dict(body=["#423f46", "#4a413b", "#2c2a31"], line="#2c2a31", hi="#5e5a60", unit=8),
    "wood":     dict(body=["#5b3923", "#88582f", "#4a413b"], line="#1c1b21", hi="#b0793b", unit=8),
    "stone":    dict(body=["#423f46", "#4a413b", "#6c6058"], line="#1c1b21", hi="#837d7f", unit=8),
    "metal":    dict(body=["#333f58", "#536884", "#5e5a60"], line="#1c1b21", hi="#536884", unit=8),
}


def _brick(m, rng, w):
    f = np.zeros((N, N, 3), np.float32)
    body = [_hex(h) for h in m["body"]]; line = _hex(m["line"]); hi = _hex(m["hi"])
    bh, bw = 4, 8
    for row in range(N // bh):
        off = (bw // 2) * (row % 2)
        for b in range(-1, N // bw + 1):
            x0 = b * bw + off; col = body[rng.integers(len(body))]
            for y in range(row * bh, row * bh + bh):
                for x in range(x0, x0 + bw):
                    xx = x % N
                    if y == row * bh + bh - 1 or x == x0 + bw - 1: f[y, xx] = line
                    elif y == row * bh and rng.random() < .5: f[y, xx] = hi
                    else: f[y, xx] = col
    return f


def _wood(m, rng, w):
    f = np.zeros((N, N, 3), np.float32)
    body = [_hex(h) for h in m["body"]]; gap = _hex(m["line"]); hi = _hex(m["hi"])
    pw = 8
    for p in range(N // pw):
        x0 = p * pw; col = body[rng.integers(len(body))]
        f[:, x0:x0 + pw] = col
        for _ in range(2):                                   # a couple of full-height grain streaks
            gx = x0 + 1 + rng.integers(pw - 2)
            f[:, gx] = shade(col, -0.05)
        f[:, x0] = hi if rng.random() < .5 else shade(col, 0.06)   # lit left edge of the plank
        f[:, x0 + pw - 1] = gap                              # dark seam between planks
    return f


def _panels(m, rng, w, rivets=False):                        # concrete / stone / metal: unit rows
    f = np.zeros((N, N, 3), np.float32)
    body = [_hex(h) for h in m["body"]]; line = _hex(m["line"]); hi = _hex(m["hi"])
    uh = m["unit"]; bw = 16
    for row in range(N // uh):
        off = (bw // 2) * (row % 2) if not rivets else 0
        for b in range(-1, N // bw + 1):
            x0 = b * bw + off; col = body[rng.integers(len(body))]
            for y in range(row * uh, row * uh + uh):
                for x in range(x0, x0 + bw):
                    xx = x % N
                    if (not rivets) and (y == row * uh + uh - 1 or x == x0 + bw - 1): f[y, xx] = line
                    elif y == row * uh and rng.random() < .35: f[y, xx] = hi
                    else: f[y, xx] = col
        if rivets:
            f[row * uh, :] = line                            # panel seam
            for rx in range(3, N, 8):
                f[row * uh + 1, rx] = hi; f[(row * uh + uh - 2), rx] = hi
    return f


def proc_face(material, weather=0.22, seed=3):
    """A 32x32 face that wraps on both axes (so E-W runs and height both tile cleanly)."""
    m = MATS.get(material) or MATS["brick"]; rng = np.random.default_rng(seed)
    if material == "wood": f = _wood(m, rng, weather)
    elif material == "brick": f = _brick(m, rng, weather)
    else: f = _panels(m, rng, weather, rivets=(material == "metal"))
    # uniform grime (no top/bottom gradient -> stays seamless)
    for _ in range(int(weather * 120)):
        y, x = rng.integers(N), rng.integers(N)
        f[y, x] = shade(f[y, x], -0.10 - 0.10 * rng.random())
    return f.astype(np.uint8)


def derive_cap(face):
    """The 32x16 wall top: a lit, slightly flattened version of the face. On-palette by construction."""
    src = shade(face, 0.14)                                   # the top catches more light than the face
    cap = src[:16].copy()
    cap = (cap * 0.5 + np.median(src.reshape(-1, 3), 0)[None, None] * 0.5)   # flatten toward the mean
    cap[-2:] = shade(cap[-2:], 0.16)                         # bright front lip (nearest the camera)
    cap[0] = shade(cap[0], -0.12)                            # the far edge sits in shade
    return np.clip(cap, 0, 255).astype(np.uint8)


# ---- Nano Banana face: a front-on wall texture, locked to the game look like the ground tiles ----
WALL_STYLE = (
    "Front-on wall texture for a dark zombie-apocalypse pixel-art game: {what}. "
    "Straight orthographic ELEVATION — the camera looks at the wall face head on. NO perspective, "
    "NO wall top, NO floor, NO sky, NO corners. The texture fills the ENTIRE square edge to edge: "
    "NO border, NO frame, NO vignette. Chunky retro pixel art with big flat pixels (about 90 across "
    "the whole image), 2 to 3 tones, hard edges, no anti-aliasing, no gradients. Dim, desaturated "
    "colours matched to the palette reference. The material's STRUCTURE (bricks, planks, panels, "
    "blocks) is bold and evenly repeating, with SMALL units — about 6 to 8 across the image, so "
    "several fit in one game tile.")


def gen_face(name, what, colours=None):
    """Ask Nano Banana for a front-on wall texture. Returns the raw PNG path (before cut/lock)."""
    from nano import generate
    root = os.path.join(os.path.dirname(__file__), "..")
    refs = [Image.open(os.path.join(root, "samples/palette.png")).convert("RGBA")]
    prompt = WALL_STYLE.format(what=what)
    if colours:
        prompt += " Colours: %s." % colours
    img = generate(prompt, refs, aspect="1:1", model=os.environ.get("NANO_MODEL", "gemini-3.1-flash-image"))
    out = os.path.join(root, "raw/tiles2", name + "_wall.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out)
    return out


# wall palette for the AI lock: structural neutrals + material accents (not blood/rot/skin), and NOT
# forced as dark as the ground lock so faces can read as mid-tone surfaces.
_WALL_HEX = RAMPS["ink"][1:7] + RAMPS["grime"] + RAMPS["rust"] + RAMPS["drab"] + RAMPS["cold"] + RAMPS["pale"][:3]


def ai_cut(src, dst, px=96, contrast=2.0, seed=0, tries=25, ring=8):
    """Pixelize an AI texture, lock it to the wall palette, and quilt it seamless on both axes.
    Mirrors make_tile.cut but with the wall palette. Writes a 32x32 _face.png and returns it."""
    from make_tile import pixelize, quantize_to, wrap_tile, N as TN, K
    from pixelize import to_lab
    pal = np.array([_hex(h) for h in _WALL_HEX], np.float32); pal_lab = to_lab(pal)
    P = pixelize(Image.open(src), px)
    mean = P.reshape(-1, 3).mean(0)
    P = np.clip(mean + (P - mean) * contrast, 0, 255)         # push variation so it survives the lock
    S = quantize_to(P, pal, pal_lab).astype(np.float32)
    S = S[ring:px - ring, ring:px - ring]                     # the AI's border ring lives at the edges
    rng = np.random.default_rng(seed); best = None; span = S.shape[0] - TN - K
    for _ in range(tries):
        x0, y0 = rng.integers(0, span + 1, 2)
        t, err = wrap_tile(S, x0, y0)
        if best is None or err < best[1]:
            best = (t, err)
    Image.fromarray(best[0].astype(np.uint8)).save(dst)
    return dst


if __name__ == "__main__":
    cmd, prefix = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)
    if cmd == "proc":
        material = sys.argv[2] if len(sys.argv) > 3 else "brick"
        prefix = sys.argv[3] if len(sys.argv) > 3 else sys.argv[2]
        face = proc_face(material)
        Image.fromarray(face).save(prefix + "_face.png")
        Image.fromarray(derive_cap(face)).save(prefix + "_cap.png")
        print("wrote", prefix + "_face.png", "+", prefix + "_cap.png")
