// Ground variety layer for Santi's engine.
// Each terrain has a plain base autotile sheet (<terrain>_auto.png) plus two scatter sheets of
// transparent 32x32 sprites drawn on a layer above it:
//   <terrain>_details.png  small specks, tufts, pebbles (cut from the same texture)   - common
//   <terrain>_decals.png   bigger marks: cracks, stains, weeds, litter                 - rare
// Which sprite goes on a cell is a pure function of (x, y), so nothing is stored in the map and
// the same map always looks the same. Only interior cells get one (the autotile slot with no
// border) get a decal, so nothing pokes out over a terrain edge. Details are drawn clear of the
// 7px edge band, so they go on every cell of the terrain, edge cells included.

// Config: scatter.json (shipped next to the sheets, updated by make_tileset.py). Load it at startup:
//   setScatterConfig(await (await fetch("tiles/scatter.json")).json());
// Each terrain: { details: [sheet, count, cols, chance per cell], decals: [sheet, count, cols, chance] }
let SCATTER = {};
function setScatterConfig(cfg) { SCATTER = cfg; }

// Small integer hash -> [0, 2^32). Stable across platforms.
function hash32(x, y, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// Returns a list of {sheet, sx, sy, flip} to draw on this cell (0, 1 or 2 sprites).
// isInterior: true when the cell's autotile slot has no border (all 8 neighbours same terrain).
function scatterFor(terrain, x, y, isInterior) {
  const t = SCATTER[terrain];
  if (!t) return [];
  const out = [];
  [["details", 1], ["decals", 2]].forEach(([kind, salt]) => {
    if (kind === "decals" && !isInterior) return;
    if (!t[kind]) return;
    const [sheet, count, cols, chance] = t[kind];
    const h = hash32(x, y, salt);
    if ((h & 0xffff) / 0x10000 >= chance) return;
    const i = (h >>> 16) % count;
    out.push({ sheet, sx: (i % cols) * 32, sy: Math.floor(i / cols) * 32, flip: ((h >>> 31) & 1) === 1 });
  });
  return out;
}

// Draw: base autotile first, then for each sprite: drawImage(sheet, sx, sy, 32, 32, cellX, cellY, 32, 32),
// mirrored horizontally inside the cell when flip is true.
if (typeof module !== "undefined") module.exports = { setScatterConfig, hash32, scatterFor };
