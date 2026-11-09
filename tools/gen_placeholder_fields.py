"""Draw a placeholder 'fields' autotile sheet in the same 8x8 layout as the
CraftPix FieldsTileset.png (47-tile blob set + extras), so the real sheet can
replace it later without touching any data.

Usage: python3 tools/gen_placeholder_fields.py art/tilesets/fields_placeholder.png
"""
import random
import sys

from PIL import Image, ImageDraw

# FieldsTile number -> neighbour mask (N=1 E=2 S=4 W=8 NE=16 SE=32 SW=64 NW=128)
BLOB47 = {
    0: [47], 1: [44], 2: [41], 3: [22], 4: [43], 5: [32, 40, 48], 6: [6], 7: [50],
    8: [42], 9: [24], 10: [30, 31, 39], 11: [52], 12: [8], 13: [49], 14: [51], 15: [15],
    19: [26], 23: [62], 27: [63], 31: [58], 38: [10], 39: [54], 46: [55], 47: [59],
    55: [13, 21, 29], 63: [14], 76: [12], 77: [53], 78: [56], 79: [60], 95: [46],
    110: [34, 35, 36], 111: [7], 127: [37], 137: [28], 139: [64], 141: [61], 143: [57],
    155: [2, 3, 4], 159: [23], 175: [45], 191: [5], 205: [9, 17, 25], 207: [16],
    223: [1], 239: [33], 255: [11, 18, 20, 27],
}
TILE_TO_MASK = {t: m for m, ts in BLOB47.items() for t in ts}

T = 32
EDGE = 6
GRASS = (109, 155, 26)       # matches til_3's colour (#6d9b1a)
GRASS_DARK = (88, 128, 20)
DIRT = (201, 150, 96)
DIRT_DARK = (168, 116, 70)
RIM = (120, 84, 48)


def dirt_tile(rng):
    im = Image.new('RGB', (T, T), DIRT)
    d = ImageDraw.Draw(im)
    for _ in range(9):  # cobble-ish speckles
        x, y = rng.randrange(T), rng.randrange(T)
        r = rng.choice([1, 2, 2, 3])
        d.ellipse([x - r, y - r, x + r, y + r], fill=DIRT_DARK)
    return im


def grass_px(d, box, rng):
    d.rectangle(box, fill=GRASS)
    x0, y0, x1, y1 = box
    for _ in range(max(1, (x1 - x0) * (y1 - y0) // 40)):
        x, y = rng.randint(x0, x1), rng.randint(y0, y1)
        d.point((x, y), fill=GRASS_DARK)


def draw(mask, rng):
    im = dirt_tile(rng)
    d = ImageDraw.Draw(im)
    n, e, s, w = (mask & 1, mask & 2, mask & 4, mask & 8)
    e_ = EDGE - 1
    # rims first, grass on top
    if not n: d.line([0, EDGE, T - 1, EDGE], fill=RIM)
    if not s: d.line([0, T - 1 - EDGE, T - 1, T - 1 - EDGE], fill=RIM)
    if not w: d.line([EDGE, 0, EDGE, T - 1], fill=RIM)
    if not e: d.line([T - 1 - EDGE, 0, T - 1 - EDGE, T - 1], fill=RIM)
    if not n: grass_px(d, (0, 0, T - 1, e_), rng)
    if not s: grass_px(d, (0, T - EDGE, T - 1, T - 1), rng)
    if not w: grass_px(d, (0, 0, e_, T - 1), rng)
    if not e: grass_px(d, (T - EDGE, 0, T - 1, T - 1), rng)
    # inner corners: both sides are field but the diagonal is not
    if n and e and not mask & 16: grass_px(d, (T - EDGE, 0, T - 1, e_), rng)
    if s and e and not mask & 32: grass_px(d, (T - EDGE, T - EDGE, T - 1, T - 1), rng)
    if s and w and not mask & 64: grass_px(d, (0, T - EDGE, e_, T - 1), rng)
    if n and w and not mask & 128: grass_px(d, (0, 0, e_, e_), rng)
    return im


def main(out):
    sheet = Image.new('RGB', (8 * T, 8 * T), (255, 0, 255))
    for num in range(1, 65):
        rng = random.Random(num)
        if num == 38:            # plain grass
            tile = Image.new('RGB', (T, T))
            grass_px(ImageDraw.Draw(tile), (0, 0, T - 1, T - 1), rng)
        elif num == 19:          # field with a grass patch in the middle
            tile = draw(255, rng)
            grass_px(ImageDraw.Draw(tile), (9, 9, 22, 22), rng)
        else:
            tile = draw(TILE_TO_MASK[num], rng)
        sheet.paste(tile, (((num - 1) % 8) * T, ((num - 1) // 8) * T))
    sheet.save(out)
    print('wrote', out)


if __name__ == '__main__':
    main(sys.argv[1])
