# Dead-world pixel art: style guide (locked)

Applies to everything drawn for the game: paper-doll characters (32×48) and ground tiles (32×32).
Follows the engine contract in the paper-doll README (canvas, ground line, slot z-order, flip at x=16).

## Mood
Dark zombie apocalypse. Dirty, worn, improvised. Colour is scarce: most of the screen is dark,
desaturated earth and grey, and the few saturated notes are blood red, rust, and hazard yellow.
Characters read like painted tabletop bust miniatures: big heads, full torso, on a round pedestal.

## Palette (41 colours, `tools/palette.py`, swatch in `samples/palette.png`)
| ramp   | use |
|--------|-----|
| ink    | outlines (darkest step), metal, asphalt, concrete, shadows |
| grime  | hair, stubble, dirt on skin and cloth |
| skin   | living people |
| pale   | weathered, desaturated skin |
| rot    | zombie flesh, mould, dead vegetation |
| blood  | wounds, stains, accents. Use sparingly so it stays loud |
| rust   | leather, wood, rusted metal |
| drab   | military cloth, canvas, helmets |
| cold   | denim, steel highlights, night accents |
| accent | hazard yellow, bone |

Every pixel must be one of these colours (the cleanup tool enforces it). The ground shadow is
the outline colour at partial alpha.

## Characters (32×48): bust miniatures
- **Form:** a big head (about a third of the height) and the full torso down to the waist, so clothing reads clearly. Shoulders rounded off
  like a statue bust, **no arms or hands**, on a short round dark stone pedestal.
- **Stylization:** bold, icon-like shapes, few pixels of detail, high light/shadow contrast. Faces
  read through a heavy brow line, 1 to 2 pixel eyes, a nose shadow and a dark mouth line.
- **Pose:** front three-quarter, facing image right.
- **Placement:** pedestal on the y=47 ground line, centred on x=16, as large as fits the 32px width.
- **Weapons:** mounted in front of the chest like a game piece's weapon, no hands. They point
  forward and up toward the upper right (the facing direction), so they flip with the figure.
  Make them large (a pistol about as long as the head is wide) or they turn to mush.
- **Slots:** `legs` doesn't apply to busts. `back` is still useful for things behind the shoulders
  (backpack, rifle on the back).
- **Outline:** 1px near-black (`#0e0d11`) around the outer silhouette only. Item layers do not
  draw a seam where they sit on the body; the tool handles this.
- **Light:** from the top-left. It moves to the top-right when flipped, which is accepted.
- **Shading:** 2 to 3 tones per material, no gradients, no anti-aliasing, minimal dithering.
- **Body variants:** every base (male, female, zombies) is made by editing the male survivor
  base image, so they all share one silhouette and every equipment layer fits all of them.
  Living bases wear trousers; the female base wears a plain dark tank top.
- **Tintable clothing:** cloth that can change colour is split out into `item.tint.png`, a shade
  mask (grey 64/128/192/255 = shade 0 to 3). `item.png` keeps only the parts that never change
  (vest plates, blood, zippers). The engine recolours the mask with a 4-colour preset from
  `TINTS` (`tools/palette.py`, `tools/tint_engine.js`). Split with `tint.py split item.png <ramps>`.
- **Hair:** base bodies are bald. Hairstyles are `hair_<style>.png` + `.tint.png` in the `head`
  slot, made on the bald base so every style fits both bodies. The whole hair is tintable
  (only the outline is fixed) with the `hair_*` presets. Anything in `helm` hides the hair.
- **Zombies:** same bust as the survivor, repainted with the rot ramp, plus wounds and blood.
  They share every equipment layer with the living.

## Tiles (32×32)
- Straight top-down, fills the square, must tile seamlessly with no border.
- One dominant base colour with sparse detail, so large areas don't look like wallpaper.
- Slightly darker and lower contrast than characters, so characters always read on top.

## Pipeline (tools/)
1. `nano.py`: generate on a flat magenta background (Nano Banana, `gemini-3.1-flash-image` works best so far).
2. `pixelize.py base`: fit the base body to the canvas and save its transform.
3. For each item: ask Nano Banana to add only that item to the **base image**, then
   `pixelize.py layer` keeps only the changed pixels, already registered to the skeleton.
4. `pixelize.py variant`: whole-body alternatives (zombie) using the base's transform.
5. `preview.py`: stacks layers and shows both facings for review.
6. `tile.py`: textures to 32×32 tiles (still rough: see notes below).
7. Hand touch-up in Aseprite or similar for faces, hands and stray pixels.
