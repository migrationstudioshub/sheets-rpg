# Art

- `tilesets/fields_placeholder.png` — drawn by `tools/gen_placeholder_fields.py` in the same 8×8 layout as
  CraftPix's *FieldsTileset.png* (47-tile blob set). To use the real art, add it here and change the
  `image` of the `fields` row in Game Data → Tilesets.
- `sprites/` — monster and item sprites drawn by `tools/gen_sprites.py` (placeholders; ours to share).
- Terrain and object sprites currently load from the imgur links in Game Data.
- **Tall objects** (trees, lamp posts): set `sprite_top` to the upper half, or use one image taller than it is wide.
- **Animation:** make the sprite a horizontal strip of frames and set `frames` and `frame_ms` in its row.

**Licences:** this repository is public, so only commit art you're allowed to redistribute
(your own, CC0 packs such as Kenney's, or packs whose licence allows it). Many paid and "free"
packs, CraftPix's included, allow use in games but not sharing the raw files; check before
committing them. Anything in `art/inbox/` is ignored by git.
