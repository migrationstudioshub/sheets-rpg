"""Draw a placeholder brick WALL CONNECTOR sheet for edge walls.

Edge walls live on grid lines; they are textured by a 16-tile connection set, one
tile per grid node, chosen by which of the node's four directions have a wall
(N=1, E=2, S=4, W=8). The tile draws a brick band reaching toward each connected
direction, so straights, corners, T-junctions, crosses and end-caps all join.

Layout: 4 columns x 4 rows of 32px tiles; the tile for mask m is at column m%4,
row m//4 (so 1-based tile index = m + 1). Swap this PNG for real brick art later
without touching any data.

Usage: python tools/gen_wall_bricks.py art/tilesets/wall_bricks.png
"""
import sys
from PIL import Image, ImageDraw

T = 32
HALF = T // 2
HW = 7                      # band half-width (14px band)
BRICK = (150, 73, 52)      # brick face
BRICK_DK = (120, 56, 40)
MORTAR = (196, 180, 160)
TOP = (178, 96, 72)        # lit top bevel
SHADOW = (92, 44, 32)


def brick_fill(d, box):
    """Fill a rect with a simple brick/mortar pattern (offset rows)."""
    x0, y0, x1, y1 = box
    d.rectangle(box, fill=BRICK)
    row = 0
    y = y0
    while y < y1:
        d.line([(x0, y), (x1, y)], fill=MORTAR)              # mortar course
        off = 0 if row % 2 == 0 else 7
        x = x0 + off
        while x < x1:
            d.line([(x, y), (x, min(y + 5, y1))], fill=MORTAR)  # vertical joints
            x += 13
        y += 5
        row += 1


def tile(mask):
    im = Image.new('RGBA', (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    arms = []
    # each connected direction is a rectangle from centre to that edge
    if mask & 1: arms.append((HALF - HW, 0, HALF + HW, HALF + HW))         # N
    if mask & 2: arms.append((HALF - HW, HALF - HW, T, HALF + HW))         # E
    if mask & 4: arms.append((HALF - HW, HALF - HW, HALF + HW, T))         # S
    if mask & 8: arms.append((0, HALF - HW, HALF + HW, HALF + HW))         # W
    if not arms:                                                          # isolated post
        arms.append((HALF - HW, HALF - HW, HALF + HW, HALF + HW))
    for a in arms:
        brick_fill(d, a)
    # outline the union so the band reads crisply
    for a in arms:
        d.rectangle(a, outline=SHADOW)
    # a lit top edge on the northern face of horizontal spans, for a hint of height
    for a in arms:
        d.line([(a[0], a[1]), (a[2], a[1])], fill=TOP)
    return im


def main(out):
    sheet = Image.new('RGBA', (T * 4, T * 4), (0, 0, 0, 0))
    for mask in range(16):
        sheet.paste(tile(mask), ((mask % 4) * T, (mask // 4) * T))
    sheet.save(out)
    print('wrote', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'art/tilesets/wall_bricks.png')
