// GENERATED from shared/mapcode.js by tools/sync_server.sh. Edit the original, not this copy.
/**
 * Compact terrain encoding for maps. A map's terrain is a W×H grid of terrain ids; stored as a plain
 * JSON array it is huge (a 101×101 map is ~92k chars — too big for a Google Sheets cell, and wasteful
 * even in Firestore). This encodes it as a small palette + run-length list, which is tiny for the big
 * uniform regions real maps have.
 *
 *   encode(grid) -> { e: 1, w, h, p: [id0, id1, ...], r: [[paletteIndex, runLength], ...] }
 *   decode(obj)  -> grid (array of arrays of ids); passes a plain array through unchanged
 *
 * `shared/content.js` decodes on read (so maps work the same offline and online, old plain-array maps
 * included); the map editor encodes before saving. Classic script, global `MapCode`, no dependencies.
 */
var MapCode = (function () {
  function isEncoded(v) { return !!(v && typeof v === 'object' && !Array.isArray(v) && v.e === 1); }

  function encode(grid) {
    var h = grid.length, w = h ? grid[0].length : 0;
    var pal = [], idx = Object.create(null), runs = [], cur = -1, n = 0;
    for (var y = 0; y < h; y++) {
      var row = grid[y] || [];
      for (var x = 0; x < w; x++) {
        var id = row[x];
        var pi = idx[id];
        if (pi === undefined) { pi = pal.length; idx[id] = pi; pal.push(id); }
        if (pi === cur) { n++; } else { if (cur >= 0) runs.push([cur, n]); cur = pi; n = 1; }
      }
    }
    if (cur >= 0) runs.push([cur, n]);
    return { e: 1, w: w, h: h, p: pal, r: runs };
  }

  function decode(o) {
    if (!isEncoded(o)) return o;                 // already a plain grid (or nothing)
    var w = o.w, h = o.h, flat = [];
    (o.r || []).forEach(function (run) { var id = o.p[run[0]]; for (var i = 0; i < run[1]; i++) flat.push(id); });
    var grid = [];
    for (var y = 0; y < h; y++) grid.push(flat.slice(y * w, (y + 1) * w));
    return grid;
  }

  return { encode: encode, decode: decode, isEncoded: isEncoded };
})();
if (typeof module !== 'undefined') module.exports = MapCode;
