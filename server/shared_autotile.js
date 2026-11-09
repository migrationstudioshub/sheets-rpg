// GENERATED from shared/autotile.js by tools/sync_server.sh. Edit the original, not this copy.
/**
 * Autotiling: picks the edge/corner tile for every autotiled terrain cell from
 * its 8 neighbours. Bits: N=1 E=2 S=4 W=8 NE=16 SE=32 SW=64 NW=128 (set = the
 * neighbour is the same terrain). A corner counts only when both of its sides
 * do, which leaves the standard 47 "blob" cases.
 */
var Autotile = (function () {
  function mask(grid, x, y, edgeSame) {
    var id = grid[y][x], H = grid.length, W = grid[0].length;
    function same(xx, yy) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) return edgeSame;
      return grid[yy][xx] === id;
    }
    var n = same(x, y - 1), e = same(x + 1, y), s = same(x, y + 1), w = same(x - 1, y);
    var m = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
    if (n && e && same(x + 1, y - 1)) m |= 16;
    if (s && e && same(x + 1, y + 1)) m |= 32;
    if (s && w && same(x - 1, y + 1)) m |= 64;
    if (n && w && same(x - 1, y - 1)) m |= 128;
    return m;
  }

  /**
   * For a map, returns a grid of {tileset, tile} (tile = 1-based index in the
   * tileset image) for autotiled cells, null elsewhere. Variants are chosen by
   * position, so the same map always looks the same.
   */
  function grid(content, map) {
    var edgeSame = content.config.autotile_edge_same !== false;
    return map.terrain.map(function (row, y) {
      return row.map(function (tid, x) {
        var t = content.terrain[tid];
        if (!t || !t.autotile) return null;
        var ts = content.tilesets[t.autotile];
        var table = ts && content.autotile[ts.layout];
        if (!table) return null;
        var options = table[mask(map.terrain, x, y, edgeSame)];
        if (!options || !options.length) return null;
        return { tileset: ts.id, tile: options[(y * 31 + x * 17) % options.length] };
      });
    });
  }

  return { mask: mask, grid: grid };
})();
if (typeof module !== 'undefined') module.exports = Autotile;
