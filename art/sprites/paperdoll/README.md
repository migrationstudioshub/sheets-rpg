# Paper-doll player sprites

Players are drawn as a **stack of single transparent PNGs** — a base body, optional hair, and
one image per equipped item, all painted in the same spot and composited bottom-to-top. No
atlas, no autotile, no per-direction art, no animation. The figures are **bust miniatures**:
a big head plus the torso down to the waist on a round stone pedestal — no arms or legs — in a
dirty zombie-apocalypse style (see [`STYLE_GUIDE.md`](STYLE_GUIDE.md) if present, or the art
team's handoff). Swap any layer for new art that follows the contract below and the code is
unchanged.

The engine side lives in [`client/js/render.js`](../../../client/js/render.js) (`drawLayers`),
[`client/js/main.js`](../../../client/js/main.js) (`playerLayers`, `SLOT_Z`) and
[`client/js/tint.js`](../../../client/js/tint.js) (`Tint.TINTS`, `getTintedLayer`).

## The contract (read this before drawing)

- **Size: 32 × 48 px, RGBA, transparent background.** Every layer is the same size — 1 tile
  wide (tile = 32), 1.5 tiles tall. The game displays at 2× (64 × 96) with nearest-neighbour
  scaling, so author at native 32×48. Pixel art, no anti-aliased edges, no downscaling.
- **Coordinates:** origin top-left, `x` → right (0–31), `y` → down (0–47). The **bottom row
  (`y = 47`) is the ground line** — the pedestal rests there. Height rises upward out of the
  tile (the bust standing on its square).
- **One shared skeleton.** Every piece is registered to the *same* base body, so hair, a helm
  and a chest layer all line up. A layer is mostly empty and only draws where its piece sits.
  Use `body_survivor.png` as the alignment reference for everything else.
- **One facing, built to mirror.** Draw the character once (front three-quarter, facing image
  right). The only turn the engine does is **face-west = flip the whole stack horizontally**
  about the vertical centre (`x = 16`). Weapons mount in front of the chest pointing forward and
  up toward image right, so they swap sides on the flip — that's expected.
- **Footprint is always 1 tile.** Height is cosmetic; collision is the single bottom tile.
  Characters are y-sorted, so a tall bust correctly overlaps things behind it.

## Draw order (by equipment slot)

Lowest `z` is drawn first (furthest back); the order is fixed in `SLOT_Z`.

| z | slot     | what it is                                   |
|---|----------|----------------------------------------------|
| 0 | `back`   | backpack straps, a rifle slung on the back   |
| 1 | `body`   | **base body** (always present)               |
| 2 | `legs`   | *unused for busts*                           |
| 3 | `armor`  | chest / torso armor                          |
| 4 | `head`   | **hair** (hidden whenever a `helm` is worn)  |
| 5 | `helm`   | helmet                                       |
| 6 | `offhand`| shield                                       |
| 7 | `weapon` | machete, pistol, … (mounted in front)        |

Unknown slots sort above all of these. Empty slots are reserved so new gear drops in without
code changes.

## Where each piece sits on the 32×48 canvas

Bust bounding boxes (the pedestal bottom is on the `y = 47` ground line, centred on `x = 16`):

| layer | x | y |
|---|---|---|
| base bodies (all 4) | 4–27 | 1–47 |
| `helm_army` | 7–27 | 1–13 |
| hair (all styles) | 0–28 | 0–38 (long styles reach the chest) |
| `chest_*` (armor) | 7–25 | 18–40 |
| `sword_machete` | 10–31 | 13–38 |
| `gun_pistol` | 11–31 | 18–40 |

Keep new art within/around these bands so any combination lines up.

## Tintable cloth & hair (`.tint.png` masks)

A worn sprite `foo.png` may ship a sibling **`foo.tint.png`**: a grey mask where values
64 / 128 / 192 / 255 mark shade 0–3 of the recolourable cloth. `foo.png` keeps only the parts
that never change (vest plates, zippers, blood, outlines). At draw time the engine paints the
mask with a 4-colour ramp from `Tint.TINTS` and draws `foo.png` over it, so one grey mask + any
ramp = any colour of that garment (`getTintedLayer` in `client/js/tint.js`, cached per image+ramp).

- A masked item **must** name a ramp (its `default_tint`), or its cloth pixels are simply missing.
- Clothing ramps: `black, charcoal, navy, olive, khaki, brown, maroon, bone, hazard`.
- Hair ramps: `hair_black, hair_dark, hair_brown, hair_auburn, hair_ginger, hair_blonde,
  hair_grey, hair_white`.

## Hair

Bodies are **bald**; hair is a separate layer in the `head` slot, chosen per character (a style
+ a colour). Every style fits every body because all are drawn on the shared bald base. Hair is
fully tintable (only the outline is fixed). **Anything worn in `helm` hides the hair layer.**
"No hair" (bald) is also valid — leave the style blank.

Styles: `hair_buzz, hair_messy, hair_slick, hair_shaggy, hair_pony, hair_bob, hair_long, hair_under`.

## Files here

Bodies (`body` slot): `body_survivor.png` (male, bald, bare chest), `body_survivor_female.png`
(female, bald, tank top), `body_zombie.png`, `body_zombie_female.png` (zombie bases; their hair
is still baked in for now).

Equipment:

| File | Slot | Mask | Default tint |
|------|------|------|--------------|
| `helm_army.png` | helm | yes | olive |
| `chest_leather_jacket.png` | armor | yes | brown |
| `chest_riot_vest.png` | armor | yes | navy |
| `sword_machete.png` | weapon | no | — |
| `gun_pistol.png` | weapon | no | — |

Hair: `hair_*.png` + `hair_*.tint.png` for each of the 8 styles above (always tintable).

## Wiring art to the game

Columns in the Game Data sheet point at PNG paths (repo-relative or a full URL):

- **Classes → `body_sprite`** — the base body for that class.
- **Items → `worn_sprite`** — the on-body layer drawn when the item is equipped (separate from
  the item's `sprite`, which stays the bag / ground icon). The item's `slot` decides the band.
- **Items → `default_tint`** — the ramp name for a tintable item (one with a `.tint.png` mask);
  blank = not tintable. The mask path is derived (`worn_sprite` with `.png` → `.tint.png`).
- **Config → `start_hair` / `start_hair_color`** — the hair layer and colour a new character
  starts with (until character creation lets players pick). A player carries its own `hair`
  (a `hair_*.png` path, blank = bald) and `hairColor` (a `hair_*` ramp name).

The engine composes each player at draw time: `body_sprite`, then hair (unless a helm is worn),
then the `worn_sprite` of every equipped item, sorted by slot, with tint masks applied where present.

## Making new art

The art team's pipeline (Nano Banana generation → `pixelize.py` registration → `tint.py split`
→ `preview.py`) and the locked style rules live in the character-art handoff package
(`tools/`, `STYLE_GUIDE.md`). New pieces must keep the shared skeleton and, if the cloth should
recolour, split into `<name>.png` + `<name>.tint.png` and add a `default_tint`.
