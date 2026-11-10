# tilepipe — vendored tileset art pipeline

Vendored copy of the owner's `tileset-art-handoff` pipeline, driven by the Map Editor's **Tileset**
view through `tools/gear_server.py` (routes `/tile/make`, `/tile/save`). Do not edit these files —
they are the upstream generators, kept here so one `python3 tools/gear_server.py` process can author
ground terrains and walls as well as gear.

Runs locally only (needs a Google Gemini key in `GOOGLE_API` or `tools/google_api_key.txt`, plus
Pillow + numpy). It writes scratch into `tools/tilepipe/raw/` and `tools/tilepipe/out/` (git-ignored);
approved sheets are copied into `art/tilesets/` by the save route.

- `tools/make_tileset.py` — one terrain (`ground`) or `wall` end to end (the server calls this).
- `tools/make_tile.py`, `details.py`, `autotile.py`, `make_wall.py`, `tile_preview.py` — its helpers.
- `tools/make_prop.py`, `nano.py`, `pixelize.py`, `palette.py`, `tint.py` — shared image tools.
- `tools/scatter.js` — the reference variety-layer function (the game runs `client/js/scatter.js`).
- `templates/autotile_8x8.png` — the engine's 8×8 blob slot layout every sheet is built in.
- `samples/`, `raw/props/chest_o_v2.png` — fixed generation references (palette, scene, camera).
