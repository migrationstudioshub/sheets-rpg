# Paper-doll player sprites

Players are drawn as a **stack of single transparent PNGs** — a base body plus one image
per equipped item, painted in the same spot and composited bottom-to-top. No atlas, no
autotile, no per-direction art, no animation. This folder holds the placeholder layers;
swap them for real art that follows the contract below and nothing in the code changes.

The engine side lives in [`client/js/render.js`](../../../client/js/render.js) (`drawLayers`)
and [`client/js/main.js`](../../../client/js/main.js) (`playerLayers`, `SLOT_Z`).

## The contract (read this before drawing)

- **Size: 32 × 48 px, RGBA, transparent background.** Every layer is the same size.
  1 tile wide (tile = 32), 1.5 tiles tall. The game displays at 2× (64 × 96) with
  nearest-neighbour scaling, so author at native 32×48 — no anti-aliased edges, no
  downscaling. Pixel art.
- **Coordinates:** origin top-left, `x` → right (0–31), `y` → down (0–47). The **bottom row
  (`y = 47`) is the ground line** — the figure's feet rest there. Extra height rises upward
  out of the tile (the "bust" standing on its square).
- **One shared skeleton.** Every piece is registered to the *same* base body. A layer is
  mostly empty and only draws where that piece sits (a helm near the head, boots at the
  feet). If a chest piece is 2px off the body's torso, it's 2px off in game. Use
  `body_base.png` as the alignment reference for everything else.
- **One facing, built to mirror.** Draw the character once (front / three-quarter). The only
  turn the engine does is **face-west = flip the whole stack horizontally** about the vertical
  centre (`x = 16`). Keep it readable mirrored. Asymmetric gear (a weapon in one hand) swaps
  sides when flipped — that's expected, don't fight it.
- **Footprint is always 1 tile.** Height is purely cosmetic; collision is the single bottom
  tile. Characters are y-sorted, so a tall bust correctly overlaps things behind it.

## Draw order (by equipment slot)

Lowest `z` is drawn first (furthest back). The order is fixed in `SLOT_Z`; the art just needs
to respect which band each piece occupies:

| z | slot              | what it is                      |
|---|-------------------|---------------------------------|
| 0 | `back`            | cape, cloak, quiver (behind)    |
| 1 | `body`            | **base body** (always present)  |
| 2 | `legs`            | pants, greaves                  |
| 3 | `armor`           | chest / torso armor             |
| 4 | `head`            | hair / face overlay             |
| 5 | `helm`            | helmet                          |
| 6 | `offhand`         | shield                          |
| 7 | `weapon`          | sword, axe, staff (on top)      |

Unknown slots sort above all of these. Slots other than `body`, `armor` and `weapon` have no
items yet — they're reserved so new gear drops in without code changes.

## Where each slot sits on the 32×48 canvas

Approximate bounding boxes, taken from the placeholder `body_base.png`. Treat them as the
registration guide: keep real art within/around these bands so any combination lines up.

```
 x:  0    8   16   24  31
 y0  ┌─────────────────┐
     │                 │
 2   │     ░helm░      │   head / helm   : x 8–24,  y 2–14
     │    ███████      │   face          : x 8–24,  y 3–21
 12  │    █ face █     │
     │     █████       │
 19  │      ▐█▌        │   neck          : x 14–17, y 19–22
 22  │   ▟███████▙     │   shoulders     : x 8–23,  y 22–26  (pauldrons)
     │ ◀█ ▐chest▌ █▶   │   torso / armor : x 10–21, y 25–36
 28  │ arm▐█████▌arm   │   arms          : x 6–9 & 23–26, y 24–34   ╲ weapon
     │    ▐█████▌      │                                            ╲ hand:
 34  │    ██   ██      │   legs          : x 12–20, y 34–44          x 22–30
     │    ██   ██      │                                             y 9–38
 43  │   ▓██▓ ▓██▓     │   feet / boots  : x 11–21, y 43–46
 47  └─────────────────┘   ground line (feet) at y 47
```

- **Base body** (`body_base.png`) fills head, torso, arms, legs, boots and a soft ground
  shadow near `y 44–47`.
- **Chest armor** (`chest_*.png`) covers the torso + shoulders band (`y ~22–36`), transparent
  elsewhere. Iron adds metal shoulder caps around `x 9` / `x 23`, `y 24`.
- **Weapon** (`sword_*.png`) is held at the figure's **right** (image right): a vertical blade
  around `x 25–27, y 9–31`, guard/grip near `y 31–38`. Mirrors to the left when facing west.

## Files here

| File | Slot | Notes |
|------|------|-------|
| `body_base.png`     | body  | Shared base body (all classes use it for now) |
| `chest_leather.png` | armor | `leather_armor` worn layer |
| `chest_iron.png`    | armor | `iron_armor` worn layer (+ pauldrons) |
| `sword_wooden.png`  | weapon| `wooden_sword` worn layer |
| `sword_iron.png`    | weapon| `iron_sword` worn layer |

## Wiring art to the game

Two optional columns in the Game Data sheet point at PNG paths (repo-relative path or a full
URL, like all other art):

- **Classes → `body_sprite`** — the base body for that class.
- **Items → `worn_sprite`** — the on-body layer drawn when the item is equipped. This is
  *separate* from the item's `sprite` (which stays the bag / ground icon). The item's existing
  `slot` decides the draw band.

The engine composes each player at draw time: class `body_sprite` + the `worn_sprite` of every
equipped item, sorted by slot. Nothing is wired per piece beyond those two fields.

## Regenerating the placeholders

```bash
node tools/gen_paperdoll.js            # writes the 5 PNGs above into this folder
```

The generator ([`tools/gen_paperdoll.js`](../../../tools/gen_paperdoll.js)) is the source of
truth for the exact placeholder pixels if you need precise registration coordinates.
