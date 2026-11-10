/**
 * Ground variety layer + tileset filename conventions (client render only; nothing here touches
 * the shared rules, so the server/referee are unaffected).
 *
 * A tileset image named `<key>_auto.png` is an 8x8 blob autotile sheet. By convention its siblings are:
 *   <key>.png            a plain base tile, drawn under the sheet so ragged transparent edges reveal
 *                        texture instead of flat colour.
 *   <key>_details.png    small scatter sprites (any cell), <key>_decals.png bigger marks (interior only),
 *                        picked per cell by scatterFor() using art/tilesets/scatter.json.
 * A wall tileset `wall_<m>_top_auto.png` instead has a 2-tile front face `wall_<m>_face.png`, drawn by
 * the renderer in the cells below a wall whose south neighbour is not the same wall.
 *
 * scatterFor() and hash32() mirror the pipeline's scatter.js exactly, so the game looks like the
 * review sheets and a map always looks the same (pure function of the cell coordinates).
 */
var Scatter = (function () {
  var CFG = {};
  function setConfig(cfg) { CFG = cfg || {}; }
  function config() { return CFG; }

  // Stable 32-bit hash of a cell + salt, identical to tools/*/scatter.js.
  function hash32(x, y, salt) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // 0, 1 or 2 sprites {sheet, sx, sy, flip} for this cell. interior = no autotile border (all 8 same).
  function scatterFor(key, x, y, interior) {
    var t = CFG[key];
    if (!t) return [];
    var out = [];
    [['details', 1], ['decals', 2]].forEach(function (p) {
      var kind = p[0], salt = p[1];
      if (kind === 'decals' && !interior) return;
      var e = t[kind]; if (!e) return;
      var sheet = e[0], count = e[1], cols = e[2], chance = e[3];
      var hh = hash32(x, y, salt);
      if ((hh & 0xffff) / 0x10000 >= chance) return;
      var i = (hh >>> 16) % count;
      out.push({ sheet: sheet, sx: (i % cols) * 32, sy: Math.floor(i / cols) * 32, flip: ((hh >>> 31) & 1) === 1 });
    });
    return out;
  }

  // Derive the sibling files from a tileset image path. Returns null for non-convention images
  // (e.g. the legacy fields_placeholder.png), which then render exactly as before.
  function tileInfo(image) {
    var m = String(image || '').match(/^(.*\/)?([a-z0-9_]+)_auto\.png$/i);
    if (!m) return null;
    var dir = m[1] || '', key = m[2];
    var wall = /_top$/.test(key);
    if (wall) {
      var base = key.replace(/_top$/, '');
      return { dir: dir, key: key, isWall: true, baseTile: null, face: dir + base + '_face.png', scatterKey: null };
    }
    return { dir: dir, key: key, isWall: false, baseTile: dir + key + '.png', face: null, scatterKey: key };
  }

  // Full asset path of a scatter sheet named in scatter.json, relative to the tileset's folder.
  function sheetPath(dir, sheet) { return (dir || '') + sheet; }

  // Fetch scatter.json once at boot (resolve the URL through Assets). Safe if it's missing.
  function load(url) {
    if (typeof fetch !== 'function') return Promise.resolve({});
    return fetch(url).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { setConfig(j); return j; })
      .catch(function () { setConfig({}); return {}; });
  }

  return { setConfig: setConfig, config: config, scatterFor: scatterFor, hash32: hash32,
    tileInfo: tileInfo, sheetPath: sheetPath, load: load };
})();
if (typeof module !== 'undefined') module.exports = Scatter;
