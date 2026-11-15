"""Placeholder brick art for the 2.5D (cap + face) wall renderer. Distinct names so they do
not collide with the owner's real tileset-maker art (wall_brick_face.png / *_top_auto.png).

  wall_demo_face.png  32x32  — the vertical FRONT face; tiles seamlessly up/down so a
                               segment of any height is just this strip repeated.
  wall_demo_cap.png   32x16  — the TOP cap seen at a slight angle (lighter), 1 tile wide.

Swap these for real art later; the renderer also has a flat-colour fallback.

Usage: python tools/gen_wall_faces.py
"""
import sys
from PIL import Image, ImageDraw

T = 32
FACE=(150,73,52); FACE_D=(126,58,41); MORTAR=(188,172,150); MORTAR_D=(150,136,116)
CAP=(190,150,120); CAP_HI=(214,180,150); CAP_MORT=(150,116,92)


def face_tile():
    im = Image.new('RGBA', (T, T), FACE)
    d = ImageDraw.Draw(im)
    ch = 8                                  # course height (divides 32 -> seamless vertical tiling)
    for i, y in enumerate(range(0, T, ch)):
        d.line([(0, y), (T, y)], fill=MORTAR)          # mortar course
        d.line([(0, y + 1), (T, y + 1)], fill=MORTAR_D)
        off = 0 if i % 2 == 0 else 16                  # running bond: offset every other course
        x = off
        while x <= T:
            d.line([(x, y), (x, y + ch)], fill=MORTAR)  # vertical joint
            x += 16
        # a little shading at the bottom of each brick for depth
        d.line([(0, y + ch - 1), (T, y + ch - 1)], fill=FACE_D)
    return im


def cap_tile():
    im = Image.new('RGBA', (T, 16), CAP)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, T - 1, 15], fill=CAP)
    d.line([(0, 0), (T, 0)], fill=CAP_HI)              # lit front lip
    d.line([(0, 1), (T, 1)], fill=CAP_HI)
    for x in range(0, T, 10):                          # faint top-course joints
        d.line([(x, 2), (x, 15)], fill=CAP_MORT)
    d.line([(0, 15), (T, 15)], fill=CAP_MORT)
    return im


def main():
    base = 'art/tilesets/'
    face_tile().save(base + 'wall_demo_face.png')
    cap_tile().save(base + 'wall_demo_cap.png')
    print('wrote', base + 'wall_demo_face.png', 'and', base + 'wall_demo_cap.png')


if __name__ == '__main__':
    main()
