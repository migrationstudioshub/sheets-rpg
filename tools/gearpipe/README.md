# Vendored gear pipeline

This is a trimmed copy of the character-art pipeline (`character-art-handoff.zip`), vendored so
`tools/gear_server.py` can drive it from the Map Editor's **Gear** view. It generates one paper-doll
layer (and its tint mask) from a text description, exactly like running `tools/make_gear.py` by hand.

**Do not edit the base files** — every existing layer in `art/sprites/paperdoll/` is registered to them:

```
tools/                 make_gear.py, build_gear.py, nano.py, pixelize.py, tint.py, palette.py
raw/base_bald_m.png    bald male base, full-size Nano Banana source (EVERY gear/hair edit starts here)
raw/base_bald_f.png    bald female base
out/hair/body_survivor_bald.png(.json)          pixel base + its fit transform (registers layers)
out/hair/body_survivor_female_bald.png(.json)
out/bust3f/body_survivor.png(.json)             transform for whole-body variants
samples/characters/body_*.png                   the three bodies the review sheets composite onto
out/gear/              generated scratch (git-ignored): <fname>.png, .tint.png, review_*.png
```

## Running

Requires Python 3 with Pillow and numpy, and a Gemini API key:

```
GOOGLE_API=<key> python3 tools/gear_server.py        # from the repo root
```

Then open http://localhost:8765/editor/ and switch to the Gear view. Generated art is reviewed in the
browser and saved into `art/sprites/paperdoll/`. You can still run the pipeline directly if you prefer:

```
cd tools/gearpipe/tools
GOOGLE_API=<key> python3 make_gear.py --slot armor --name trench_coat --what "a long dirty trench coat" --tint "the coat fabric"
```

Trimmed vs. the full handoff: the one-off generators `gear_sheet.py`, `preview.py`, `tile.py` and the
female/zombie body-variant sources are omitted — add them back from the handoff if you need them.
