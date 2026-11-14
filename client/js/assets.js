/** Loads images once and hands out drawable sources, with placeholders for anything missing. */
var Assets = (function () {
  var cache = {};

  function resolve(path) {
    if (!path) return '';
    if (/^(https?:|data:)/.test(path)) return path;
    return GAME_CONFIG.ASSET_BASE + path.replace(/^\//, '');
  }

  function load(path) {
    var url = resolve(path);
    if (!url) return Promise.resolve(null);
    if (cache[url]) return cache[url].promise;
    var entry = cache[url] = { img: null };
    entry.promise = new Promise(function (done) {
      var img = new Image();
      img.onload = function () { entry.img = img; done(img); };
      img.onerror = function () { entry.img = null; done(null); };
      setTimeout(function () { done(entry.img); }, 8000);
      img.src = url;
    });
    return entry.promise;
  }

  function get(path) {
    var e = cache[resolve(path)];
    return e ? e.img : null;
  }

  /** Loads every image a map needs before it is drawn. */
  function loadForMap(content, map) {
    var paths = {};
    var tiles = [];                                   // convention tilesets on this map (for scatter sheets)
    function scanTerrain(grid) {                       // the art a terrain grid needs (sprite or autotile tileset)
      (grid || []).forEach(function (row) {
        row.forEach(function (tid) {
          var t = content.terrain[tid]; if (!t) return;
          if (t.sprite) paths[t.sprite] = 1;
          if (t.autotile && content.tilesets[t.autotile]) {
            var img = content.tilesets[t.autotile].image;
            paths[img] = 1;
            var info = (typeof Scatter !== 'undefined') && Scatter.tileInfo(img);  // base tile / wall face / scatter
            if (info) { tiles.push(info); if (info.baseTile) paths[info.baseTile] = 1; if (info.face) paths[info.face] = 1; }
          }
        });
      });
    }
    scanTerrain(map.terrain);
    scanTerrain(map.overlay);   // overlay layer too — a terrain painted only on the overlay (e.g. grass) is otherwise never preloaded
    map.entities.forEach(function (e) {
      var o = content.objects[e.ref]; if (!o) return;
      if (o.sprite) paths[o.sprite] = 1;
      if (o.spriteTop) paths[o.spriteTop] = 1;
      Object.keys(o.spriteStates).forEach(function (s) { paths[o.spriteStates[s]] = 1; });
    });
    Object.keys(content.monsters || {}).forEach(function (k) { if (content.monsters[k].sprite) paths[content.monsters[k].sprite] = 1; });
    Object.keys(content.items || {}).forEach(function (k) {
      var it = content.items[k]; if (it.sprite) paths[it.sprite] = 1;
      if (it.wornSprite) { paths[it.wornSprite] = 1;                                              // worn paper-doll layer
        if (it.defaultTint) paths[it.wornSprite.replace(/\.png$/i, '.tint.png')] = 1; }           // + its grey tint mask
    });
    Object.keys(content.classes || {}).forEach(function (k) { if (content.classes[k].bodySprite) paths[content.classes[k].bodySprite] = 1; });   // player base bodies

    // Variety layer: load scatter.json once, then the detail/decal sheets each ground terrain needs.
    var ready = (typeof Scatter !== 'undefined') ? Scatter.load(resolve('art/tilesets/scatter.json')) : Promise.resolve({});
    return ready.then(function (cfg) {
      tiles.forEach(function (info) {
        if (!info.scatterKey) return;
        var e = (cfg || {})[info.scatterKey]; if (!e) return;
        ['details', 'decals'].forEach(function (k) { if (e[k] && e[k][0]) paths[Scatter.sheetPath(info.dir, e[k][0])] = 1; });
      });
      return Promise.all(Object.keys(paths).map(load));
    });
  }

  /** A labelled square for things that have no art yet. */
  var placeholders = {};
  function placeholder(label, color, size) {
    var key = label + color + size;
    if (placeholders[key]) return placeholders[key];
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(3, 3, size - 6, size - 6);
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(3.5, 3.5, size - 7, size - 7);
    g.fillStyle = '#fff'; g.font = 'bold ' + Math.round(size * 0.45) + 'px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((label || '?').charAt(0).toUpperCase(), size / 2, size / 2 + 1);
    return (placeholders[key] = c);
  }

  /** Simple drawn character until real character art exists. One per facing. */
  var heroes = {};
  function hero(facing, tint, size) {
    var key = facing + tint + size;
    if (heroes[key]) return heroes[key];
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var g = c.getContext('2d'), u = size / 16;
    function px(x, y, w, h, col) { g.fillStyle = col; g.fillRect(x * u, y * u, w * u, h * u); }
    px(4, 14, 8, 1.5, 'rgba(0,0,0,.25)');               // shadow
    px(5, 9, 6, 5, tint);                                // body
    px(5, 13, 2, 2, '#3b2a1a'); px(9, 13, 2, 2, '#3b2a1a'); // feet
    px(5, 3, 6, 6, '#f1c27d');                           // head
    px(5, 2, 6, 2, '#5a3a1a');                           // hair
    var eye = '#1b1b1b';
    if (facing === 'S') { px(6, 5, 1, 1.5, eye); px(9, 5, 1, 1.5, eye); }
    if (facing === 'E') { px(9, 5, 1, 1.5, eye); px(4.5, 2, 2, 4, '#5a3a1a'); }
    if (facing === 'W') { px(6, 5, 1, 1.5, eye); px(9.5, 2, 2, 4, '#5a3a1a'); }
    if (facing === 'N') { px(5, 2, 6, 5, '#5a3a1a'); }
    return (heroes[key] = c);
  }

  return { load: load, get: get, loadForMap: loadForMap, placeholder: placeholder, hero: hero, resolve: resolve };
})();
