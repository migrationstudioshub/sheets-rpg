# objpipe — vendored map-object art pipeline

Vendored copy of the owner's `objects-art-handoff` pipeline, driven by the **Asset Studio**'s Objects
maker (`/studio/`) through `tools/asset_server.py` (routes `/object/make`, `/object/save`). Do not edit
these files — they are the upstream generators, kept here so one `python3 tools/asset_server.py`
process can author map objects (furniture, props, vehicles, trees, doors) as well as gear and tilesets.

Runs locally only (needs a Google Gemini key in `GOOGLE_API` or `tools/google_api_key.txt`, plus
Pillow + numpy). Scratch goes to `tools/objpipe/raw/` and `tools/objpipe/out/` (git-ignored);
approved objects are copied into `art/sprites/objects/` by the save route.

- `tools/make_objects.py` — one object end to end (the server calls this), with facing views.
- `tools/make_prop.py` — the size rule + prop pixelizer it builds on.
- `tools/nano.py`, `pixelize.py`, `palette.py`, `tint.py` — shared image tools.
- `samples/`, `raw/props/chest_o_v2.png` — fixed generation references (palette, scene, camera, a
  bust for scale in review sheets).

Object contract (see `art/sprites/objects/objects.json`): canvas is whole tiles wide × a multiple of
16 tall; the footprint is the bottom tile row; draw at `x=cx*32, y=(cy+1)*32-height`, y-sorted by the
footprint row. `layer` is `object` | `wall` | `ground_decal`.
