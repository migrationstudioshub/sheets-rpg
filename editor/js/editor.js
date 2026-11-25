/**
 * Map editor core: state, canvas drawing, tools, undo, map operations.
 * Panels (palette, map list, inspector) live in panels.js.
 */
var E = {
  tables: null, content: null, mapId: null,
  layer: 'terrain', terrainLayer: 'base', tool: 'rect', paletteTab: 'terrain',   // terrain is laid in blocks: rectangle is its default tool
  brush: { terrain: 'til_3', object: null, monster: null, wall: null },
  hoverEdge: null, mountHover: null,   // edge walls: the hovered edge; mountHover = wall-mount target cell (walls are always Rules.WALL_H high)
  brushFacing: 'S',     // which way the next turnable object (a chair) faces: T or Shift+wheel turns it
  wallSide: 'cursor',   // N-S walls: 'center' straddles the line; 'cursor' snaps the wall onto whichever tile the cursor is nearer
  view: { zoom: 2, x: 40, y: 40 },
  show: { terrain: true, objects: true, grid: true, raised: true, animate: false },   // animate: water, lava and waterfalls move (off = still, and the map is only redrawn when something changes);   // raised: ground height drawn as in the game (cliffs and all)
  selected: null, hover: null, mode: null,
  stamp: null,   // shift-click clipboard: { w, h, cells:[{base, overlay, baseMask, overlayMask}] }
  dirty: { maps: {}, tabs: {}, deleted: [] },
  undo: [], redo: [],
  ground: null, groundDirty: true, needsDraw: true,
  source: ''
};

(function () {
  var canvas = document.getElementById('canvas'), g = canvas.getContext('2d');
  var drag = null, spaceDown = false;

  // Autosave unsaved edits locally (online mode) so leaving the editor — switching tools, closing the
  // desktop app — doesn't lose them; restored on reopen (see the start block). Debounced so a burst of
  // paints is one write. Offline mode already persists through its own draft, so skip it there.
  var wipTimer = null;
  function scheduleWip() {
    if (wipTimer || !E.tables || !(Store.online() || Store.local())) return;   // (local mode too: switching tools reloads the page)
    wipTimer = setTimeout(function () {
      wipTimer = null;
      if (!E.isDirty()) { Store.clearWip(); return; }
      E.syncAll();
      Store.saveWip(E.tables, E.base, E.dirty);
    }, 600);
  }
  E.scheduleWip = scheduleWip;   // panels.js calls this after edits that set dirty directly

  function T() { return E.content.config.tile_size || 32; }
  function cellSize() { return T() * E.view.zoom; }
  E.map = function () { return E.content.maps[E.mapId]; };

  // The terrain grid currently being painted: the base ground, or the overlay (autotiles drawn on top).
  E.cells = function (map) {
    map = map || E.map();
    return E.terrainLayer === 'overlay' ? E.ensureOverlay(map) : map.terrain;
  };
  // Overlay starts empty ([]) to keep maps small; build a full W×H grid of '' the first time it's painted.
  E.ensureOverlay = function (map) {
    var ov = map.overlay;
    if (!ov || ov.length !== map.height || (ov[0] && ov[0].length !== map.width)) {
      var g = [];
      for (var y = 0; y < map.height; y++) {
        var row = [];
        for (var x = 0; x < map.width; x++) row.push((ov && ov[y] && ov[y][x]) || '');
        g.push(row);
      }
      map.overlay = g;
    }
    return map.overlay;
  };
  // Roof cover: a W×H mask ('1' = roofed interior tile). Built lazily the first time it's painted; mapRows
  // drops it when all-empty. Contiguous '1' tiles form a room hidden in-game until entered (see render.js).
  E.ensureRoof = function (map) {
    map = map || E.map();
    var r = map.roof;
    if (!r || r.length !== map.height || (r[0] && r[0].length !== map.width)) {
      var g = [];
      for (var y = 0; y < map.height; y++) { var row = []; for (var x = 0; x < map.width; x++) row.push((r && r[y] && r[y][x]) || ''); g.push(row); }
      map.roof = g;
    }
    return map.roof;
  };
  function setRoof(x, y, v) {
    var m = E.map(); if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
    var g = E.ensureRoof(m); if (g[y][x] === v) return false;
    g[y][x] = v; m._roofZones = null; return true;                 // invalidate the cached room grouping
  }
  // No-build mask: a W×H grid ('1' = players may not build on this tile). Same shape and handling as the roof.
  E.ensureNoBuild = function (map) {
    map = map || E.map();
    var r = map.nobuild;
    if (!r || r.length !== map.height || (r[0] && r[0].length !== map.width)) {
      var g = [];
      for (var y = 0; y < map.height; y++) { var row = []; for (var x = 0; x < map.width; x++) row.push((r && r[y] && r[y][x]) || ''); g.push(row); }
      map.nobuild = g;
    }
    return map.nobuild;
  };
  // Ground height: a W×H grid of tokens ('' = level, '2' = two steps up, '1N' = a ramp from 1 up to 2 going north);
  // see Rules.heightAt. The Height tab paints E.brush.elev (a level) with E.brush.ramp ('' or the way it climbs).
  E.ensureElev = function (map) {
    map = map || E.map();
    var r = map.elev;
    if (!r || r.length !== map.height || (r[0] && r[0].length !== map.width)) {
      var g = [];
      for (var y = 0; y < map.height; y++) { var row = []; for (var x = 0; x < map.width; x++) row.push((r && r[y] && r[y][x]) || ''); g.push(row); }
      map.elev = g;
    }
    return map.elev;
  };
  function setElev(x, y, v) {
    var m = E.map(); if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
    var g = E.ensureElev(m); if (g[y][x] === v) return false;
    g[y][x] = v; return true;
  }
  // Waterfalls by hand: a W×H grid ('' = by itself, '1' = a fall here, a tint name = a fall in that colour, '0' = none
  // here). Painted from the Height tab (Paint: Waterfalls); see Render.fallAt.
  E.ensureFalls = function (map) {
    map = map || E.map();
    var r = map.falls;
    if (!r || r.length !== map.height || (r[0] && r[0].length !== map.width)) {
      var g = [];
      for (var y = 0; y < map.height; y++) { var row = []; for (var x = 0; x < map.width; x++) row.push((r && r[y] && r[y][x]) || ''); g.push(row); }
      map.falls = g;
    }
    return map.falls;
  };
  function setFall(x, y, v) {
    var m = E.map(); if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
    if (!v && !(m.falls && m.falls.length)) return false;
    var g = E.ensureFalls(m); if (g[y][x] === v) return false;
    g[y][x] = v; return true;
  }
  function fallMode() { return (E.brush || {}).heightMode === 'fall'; }
  function fallToken() { var b = E.brush || {}; return b.fall === '0' ? '0' : (b.fallTint || '1'); }
  function elevToken() { var b = E.brush || {}, h = Math.max(0, Math.min(9, Number(b.elev) || 0)), r = b.ramp || ''; return r ? h + r : (h ? String(h) : ''); }
  // ---- random hills (the Height tab's generator). Smooth noise at several sizes laid over each other, cut into
  // whole levels; then no step is ever more than one level (terraces, not towers), and ramps are cut into them.
  function seeded(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  /**
   * A W×H grid of height tokens. o = {min, max, size (tiles across one hill), ramps (0 none, 1 few, 2 many), seed,
   * fixed: grid of tokens that must stay as they are (undefined = free), flat (0..: how much of the land is lowland)}.
   */
  E.hillGrid = function (W, H, o) {
    var lo = Math.max(0, Math.min(9, Math.round(Number(o.min) || 0))), hi = Math.max(lo, Math.min(9, Math.round(Number(o.max) || 0)));
    var rnd = seeded(o.seed || 1), size = Math.max(3, Number(o.size) || 14), fixed = o.fixed || [];
    var isFixed = function (x, y) { return !!fixed[y] && fixed[y][x] != null; };
    // value noise: random numbers on a coarse lattice, blended smoothly between
    function layer(cell) {
      var gw = Math.ceil(W / cell) + 3, gh = Math.ceil(H / cell) + 3, lat = [], ox = rnd() * cell, oy = rnd() * cell;
      for (var i = 0; i < gw * gh; i++) lat.push(rnd());
      var sm = function (t) { return t * t * (3 - 2 * t); };
      return function (x, y) {
        var fx = (x + ox) / cell, fy = (y + oy) / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), u = sm(fx - x0), v = sm(fy - y0);
        var a = lat[y0 * gw + x0], b = lat[y0 * gw + x0 + 1], c2 = lat[(y0 + 1) * gw + x0], d = lat[(y0 + 1) * gw + x0 + 1];
        return (a + (b - a) * u) * (1 - v) + (c2 + (d - c2) * u) * v;
      };
    }
    var layers = [[size, 1], [size / 2, 0.5], [size / 4, 0.22], [size / 8, 0.08]].filter(function (l) { return l[0] >= 1.5; }).map(function (l) { return { f: layer(l[0]), w: l[1] }; });
    var v = [], x, y, mn = Infinity, mx = -Infinity;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) { var n = 0; layers.forEach(function (l) { n += l.f(x, y) * l.w; }); v.push(n); if (n < mn) mn = n; if (n > mx) mx = n; }
    // into levels: lowland is common, high ground rarer the higher it is (valleys with hills and the odd mountain)
    var steps = hi - lo + 1, bend = 1 + 1.6 * (o.flat == null ? 0.5 : Number(o.flat)), hgt = [];
    for (y = 0; y < H; y++) { hgt.push([]); for (x = 0; x < W; x++) {
      var t = mx > mn ? (v[y * W + x] - mn) / (mx - mn) : 0;
      hgt[y].push(isFixed(x, y) ? (parseInt(fixed[y][x], 10) || 0) : Math.min(hi, lo + Math.floor(Math.pow(t, bend) * steps)));
    } }
    var at = function (x, y) { return x < 0 || y < 0 || x >= W || y >= H ? null : hgt[y][x]; };
    var N4 = [[0, -1], [1, 0], [0, 1], [-1, 0]], N8 = N4.concat([[1, -1], [1, 1], [-1, 1], [-1, -1]]);
    // no one-tile pimples or pits
    for (var pass = 0; pass < 2; pass++) for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (isFixed(x, y)) continue;
      var ns = N4.map(function (d) { return at(x + d[0], y + d[1]); }).filter(function (q) { return q != null; }), h0 = hgt[y][x];
      if (ns.length && ns.every(function (q) { return q < h0; })) hgt[y][x] = Math.max.apply(null, ns);
      else if (ns.length && ns.every(function (q) { return q > h0; })) hgt[y][x] = Math.min.apply(null, ns);
    }
    // one level at a time: nothing stands more than a step above anything beside it (corners too)
    var changed = true, guard = 0;
    var sweep = function (x, y) {
      if (isFixed(x, y)) return;
      var low = Infinity; N8.forEach(function (d) { var q = at(x + d[0], y + d[1]); if (q != null && q < low) low = q; });
      if (hgt[y][x] > low + 1) { hgt[y][x] = low + 1; changed = true; }
    };
    while (changed && guard++ < 40) {
      changed = false;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) sweep(x, y);
      for (y = H - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--) sweep(x, y);
    }
    var out = hgt.map(function (row, y) { return row.map(function (q, x) { return isFixed(x, y) ? String(fixed[y][x]) : (q ? String(q) : ''); }); });
    // ramps: on a lower tile at the foot of a step, with level ground to walk in from and level ground on top.
    // (None climbing south: that one is edge-on in the game, it cannot be seen.)
    var gap = o.ramps === 2 ? 4 : o.ramps === 1 ? 9 : 0;
    if (gap) {
      var cand = [], put = [];
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
        if (isFixed(x, y)) continue;
        [['N', 0, -1], ['E', 1, 0], ['W', -1, 0]].forEach(function (d) {
          var up = at(x + d[1], y + d[2]), back = at(x - d[1], y - d[2]), top2 = at(x + 2 * d[1], y + 2 * d[2]);
          if (up !== hgt[y][x] + 1 || back !== hgt[y][x] || top2 !== up) return;
          if (isFixed(x + d[1], y + d[2])) return;
          cand.push({ x: x, y: y, d: d[0], h: hgt[y][x], r: rnd() });
        });
      }
      cand.sort(function (a, b) { return a.r - b.r; });
      cand.forEach(function (q) {
        if (put.some(function (p) { return p.h === q.h && Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < gap; })) return;
        if (put.some(function (p) { return Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < 2; })) return;      // never two ramps touching
        put.push(q); out[q.y][q.x] = q.h + q.d;
      });
    }
    return out;
  };
  /** Tiles the generator leaves alone: anything built or placed (objects, walls, roofs) and ground nobody walks on (water). */
  E.hillFixed = function (m) {
    var cur = E.ensureElev(m), fx = [], x, y, c = E.content;
    for (y = 0; y < m.height; y++) fx.push(new Array(m.width));
    var keep = function (x, y) { if (x >= 0 && y >= 0 && x < m.width && y < m.height) fx[y][x] = cur[y][x] || ''; };
    (m.entities || []).forEach(function (e) {
      var ob = c.objects[e.ref] || {}, fw = Math.max(1, ob.footprintW || 1), fh = Math.max(1, ob.footprintH || 1);
      for (var dy = 0; dy < fh; dy++) for (var dx = 0; dx < fw; dx++) keep(e.x + dx, e.y - dy);
    });
    for (y = 0; y < m.height; y++) for (x = 0; x < m.width; x++) {
      if (m.hWalls && m.hWalls[y] && m.hWalls[y][x]) { keep(x, y); keep(x, y - 1); }
      if (m.vWalls && m.vWalls[y] && m.vWalls[y][x]) { keep(x, y); keep(x - 1, y); }
      if (m.roof && m.roof[y] && m.roof[y][x] && m.roof[y][x] !== '0') keep(x, y);
      var t = Rules.terrainAt(c, m, x, y);
      if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) keep(x, y);
    }
    return fx;
  };
  /** The Height tab's Generate button: random hills over the whole map (one undo step). Returns the seed it used. */
  E.generateHills = function (o) {
    var m = E.map(), seed = o.seed || (Math.floor(Math.random() * 2147483646) + 1);
    E.checkpoint();
    m.elev = E.hillGrid(m.width, m.height, { min: o.min, max: o.max, size: o.size, ramps: o.ramps, flat: o.flat, seed: seed, fixed: o.keep === false ? null : E.hillFixed(m) });
    E.groundDirty = true; E.markDirty('map');
    return seed;
  };
  function setNoBuild(x, y, v) {
    var m = E.map(); if (x < 0 || y < 0 || x >= m.width || y >= m.height) return false;
    var g = E.ensureNoBuild(m); if (g[y][x] === v) return false;
    g[y][x] = v; return true;
  }
  // Edge walls live on cell boundaries. Two full grids of "styleId:height" tokens ('' = no wall), built
  // lazily the first time walls are painted: hWalls = horizontal lines ((H+1) rows × W cols), vWalls =
  // vertical lines (H rows × (W+1) cols). Kept full while editing; mapRows drops them when all-empty.
  E.ensureWalls = function (map) {
    map = map || E.map();
    var w = map.width, h = map.height;
    function build(src, rows, cols) {
      var g = [];
      for (var y = 0; y < rows; y++) { var r = []; for (var x = 0; x < cols; x++) r.push((src && src[y] && src[y][x]) || ''); g.push(r); }
      return g;
    }
    if (!map.hWalls || map.hWalls.length !== h + 1 || (map.hWalls[0] && map.hWalls[0].length !== w)) map.hWalls = build(map.hWalls, h + 1, w);
    if (!map.vWalls || map.vWalls.length !== h || (map.vWalls[0] && map.vWalls[0].length !== w + 1)) map.vWalls = build(map.vWalls, h, w + 1);
    return map;
  };
  // The grid cell (edge) nearest the mouse: whichever of the hovered tile's four sides the cursor is closest
  // to. Returns {orient:'h'|'v', x, y} indexing the matching wall grid, or null when outside the map.
  E.edgeAt = function (ev) {
    var r = canvas.getBoundingClientRect(), s = cellSize(), m = E.map();
    var pt = mapPt(ev), fx = pt.fx, fy = pt.fy;
    var cx = Math.floor(fx), cy = Math.floor(fy), rx = fx - cx, ry = fy - cy;
    // Each candidate edge also carries `side`: the tile the cursor is on, used to offset N-S walls.
    // left edge of the hovered cell → cursor is to its right ('r'); right edge → cursor to its left ('l').
    var d = [['v', cx, cy, rx, 'r'], ['v', cx + 1, cy, 1 - rx, 'l'], ['h', cx, cy, ry, 's'], ['h', cx, cy + 1, 1 - ry, 'n']];
    d.sort(function (a, b) { return a[3] - b[3]; });
    var e = { orient: d[0][0], x: d[0][1], y: d[0][2], side: d[0][4] };
    if (e.orient === 'h') { if (e.x < 0 || e.x >= m.width || e.y < 0 || e.y > m.height) return null; }
    else { if (e.x < 0 || e.x > m.width || e.y < 0 || e.y >= m.height) return null; }
    return e;
  };
  // The frozen-shape override map ({ "x,y": mask }) for the layer currently being painted.
  E.shapeMap = function (map) {
    map = map || E.map();
    return E.terrainLayer === 'overlay' ? (map.overlayShapes = map.overlayShapes || {}) : (map.shapes = map.shapes || {});
  };

  // ------------------------------------------------------------ data helpers
  E.entityAt = function (x, y) {
    var m = E.map();
    for (var i = m.entities.length - 1; i >= 0; i--) if (m.entities[i].x === x && m.entities[i].y === y) return m.entities[i];
    return null;
  };
  E.entityByKey = function (k) { return E.map().entities.filter(function (e) { return e.key === k; })[0] || null; };
  E.newKey = function (map) {
    var n = 0;
    map.entities.forEach(function (e) { var m = /\.e(\d+)$/.exec(e.key); if (m) n = Math.max(n, Number(m[1])); });
    // keys must stay unique even against entities deleted this session, so never reuse lower numbers
    return map.id + '.e' + (n + 1);
  };
  E.inside = function (x, y) { var m = E.map(); return x >= 0 && y >= 0 && x < m.width && y < m.height; };

  /** Writes one map back into the table rows (Maps + MapEntities). */
  E.mapRows = function (map) {
    var old = (E.tables.Maps || []).filter(function (r) { return String(r.id) === map.id; })[0] || {};
    var row = Object.assign({}, old, { id: map.id, name: map.name, width: map.width, height: map.height,
      terrain: JSON.stringify(map.terrain) });
    var ov = map.overlay;
    var hasOv = ov && ov.some(function (r) { return r && r.some(function (c) { return c; }); });
    if (hasOv) row.overlay = JSON.stringify(ov); else delete row.overlay;   // keep overlay-free maps clean
    ['vWalls', 'hWalls', 'roof', 'nobuild', 'elev', 'falls'].forEach(function (k) {           // edge walls + roof cover + no-build mask, dropped when all-empty
      var grid = map[k], has = grid && grid.some(function (r) { return r && r.some(function (c) { return c; }); });
      if (has) row[k] = JSON.stringify(grid); else delete row[k];
    });
    ['shapes', 'overlayShapes'].forEach(function (k) {                       // frozen shift-click shapes
      var o = map[k]; if (o && Object.keys(o).length) row[k] = JSON.stringify(o); else delete row[k];
    });
    if (map.roof_color) row.roof_color = map.roof_color; else delete row.roof_color;   // per-map roof tint (optional)
    if (map.spawn) row.spawn = JSON.stringify(map.spawn); else delete row.spawn;        // per-map player spawn point (optional)
    if (map.floorOf) { row.floor_of = map.floorOf; row.z = map.z; } else { delete row.floor_of; delete row.z; }   // a floor of a multi-storey map
    if (row.notes === undefined) row.notes = '';
    var ents = map.entities.map(function (e) {
      return { map: map.id, key: e.key, x: e.x, y: e.y, ref: e.ref,
        data: e.data && Object.keys(e.data).length ? JSON.stringify(e.data) : '' };
    });
    return { row: row, entities: ents };
  };
  E.syncMap = function (map) {
    var r = E.mapRows(map);
    E.tables.Maps = (E.tables.Maps || []).filter(function (x) { return String(x.id) !== map.id; }).concat([r.row]);
    E.tables.MapEntities = (E.tables.MapEntities || []).filter(function (x) { return String(x.map) !== map.id; }).concat(r.entities);
  };
  E.syncAll = function () { Object.keys(E.content.maps).forEach(function (id) { E.syncMap(E.content.maps[id]); }); };

  /** Rebuilds content after definition edits, keeping map edits. */
  E.rebuild = function () {
    E.syncAll();
    E.content = Content.build(E.tables);
    E.loadArt().then(function () { E.groundDirty = true; E.redraw(); Panels.palette(); });
    E.groundDirty = true; E.redraw(); Panels.all();
    scheduleWip();   // definition edits set dirty.tabs then rebuild
    return Promise.resolve();
  };

  E.loadArt = function () {
    var c = E.content, paths = [];
    Object.keys(c.terrain).forEach(function (k) { if (c.terrain[k].sprite) paths.push(c.terrain[k].sprite); });
    Object.keys(c.tilesets).forEach(function (k) { paths.push(c.tilesets[k].image); });
    Object.keys(c.monsters || {}).forEach(function (k) { if (c.monsters[k].sprite) paths.push(c.monsters[k].sprite); });
    Object.keys(c.items || {}).forEach(function (k) { if (c.items[k].sprite) paths.push(c.items[k].sprite); });   // (the Items tab lays them on the ground)
    Object.keys(c.objects).forEach(function (k) {
      var o = c.objects[k]; if (o.sprite) paths.push(o.sprite);
      Object.keys(o.spriteStates).forEach(function (s) { paths.push(o.spriteStates[s]); });
    });
    Object.keys(c.wallStyles || {}).forEach(function (k) {
      var w = c.wallStyles[k]; [w.cap, w.face].forEach(function (p) { if (p) paths.push(p); });
    });
    // raised ground (the Raised view): cliff faces, the tint masks of water and lava, and the waterfall strips
    var foamOf = function (p) { if (Render.foamPaths) { var f = Render.foamPaths(p); paths.push(f.top, f.small, f.big); } };
    var mask = function (p) { return p.replace(/[.]png$/i, '.tint.png'); }, local = function (p) { return /[.]png$/i.test(p) && !/^https?:/i.test(p); };
    Object.keys(c.terrain).forEach(function (k) {
      var t = c.terrain[k], ts = t.autotile && c.tilesets[t.autotile];
      if (t.sprite && local(t.sprite)) paths.push(t.sprite.replace(/[.]png$/i, '_face.png'));
      if (t.fall) { paths.push(t.fall); if (local(t.fall)) paths.push(mask(t.fall)); foamOf(t.fall); }
      if (ts && ts.image) {
        if (t.tint && local(ts.image)) paths.push(mask(ts.image));
        var info = typeof Scatter !== 'undefined' && Scatter.tileInfo ? Scatter.tileInfo(ts.image) : null;
        if (info && info.cliff) paths.push(info.cliff);
      }
    });
    var fall = (c.config && c.config.waterfall_sprite) || Render.FALL_SPRITE;
    if (fall) { paths.push(fall); if (local(fall)) paths.push(mask(fall)); foamOf(fall); }
    return Promise.all(paths.map(Assets.load));
  };

  E.markDirty = function (what, sameGround) {                // sameGround: the painted ground did not change (an object moved): no need to paint it again
    if (what === 'map') { E.dirty.maps[E.mapId] = true; if (!sameGround) E.groundDirty = true; }
    else E.dirty.tabs[what] = true;
    E.redraw(); Panels.status(); scheduleWip();
  };
  E.isDirty = function () { return Object.keys(E.dirty.maps).length || Object.keys(E.dirty.tabs).length || E.dirty.deleted.length; };

  // ------------------------------------------------------------ undo
  function snapshot() {
    var m = E.map();
    return { mapId: m.id, width: m.width, height: m.height, name: m.name,
      terrain: JSON.parse(JSON.stringify(m.terrain)), overlay: JSON.parse(JSON.stringify(m.overlay || [])),
      vWalls: JSON.parse(JSON.stringify(m.vWalls || [])), hWalls: JSON.parse(JSON.stringify(m.hWalls || [])),
      roof: JSON.parse(JSON.stringify(m.roof || [])), roof_color: m.roof_color || '',
      nobuild: JSON.parse(JSON.stringify(m.nobuild || [])), elev: JSON.parse(JSON.stringify(m.elev || [])), falls: JSON.parse(JSON.stringify(m.falls || [])),
      spawn: m.spawn ? JSON.parse(JSON.stringify(m.spawn)) : null,
      shapes: JSON.parse(JSON.stringify(m.shapes || {})), overlayShapes: JSON.parse(JSON.stringify(m.overlayShapes || {})),
      entities: JSON.parse(JSON.stringify(m.entities)) };
  }
  function restore(s) {
    var m = E.content.maps[s.mapId]; if (!m) return;
    if (E.mapId !== s.mapId) E.openMap(s.mapId);
    m.width = s.width; m.height = s.height; m.name = s.name; m.terrain = s.terrain; m.overlay = s.overlay || [];
    m.vWalls = s.vWalls || []; m.hWalls = s.hWalls || []; m.roof = s.roof || []; m.roof_color = s.roof_color || '';
    m.nobuild = s.nobuild || []; m.elev = s.elev || []; m.falls = s.falls || [];
    m.spawn = s.spawn || null;
    m.shapes = s.shapes || {}; m.overlayShapes = s.overlayShapes || {}; m.entities = s.entities;
    if (E.selected && !E.entityByKey(E.selected)) E.selected = null;
    E.markDirty('map'); Panels.all();
  }
  E.checkpoint = function () { E.undo.push(snapshot()); if (E.undo.length > 100) E.undo.shift(); E.redo = []; };
  E.doUndo = function () { if (!E.undo.length) return; E.redo.push(snapshot()); restore(E.undo.pop()); };
  E.doRedo = function () { if (!E.redo.length) return; E.undo.push(snapshot()); restore(E.redo.pop()); };

  // ------------------------------------------------------------ edits
  function setTerrain(x, y, id) {
    if (!E.inside(x, y)) return false;
    var cells = E.cells();                        // base or overlay, whichever layer is active
    var had = E.shapeMap()[x + ',' + y] != null;
    if (cells[y][x] === id && !had) return false;
    cells[y][x] = id;
    delete E.shapeMap()[x + ',' + y];             // normal painting re-autotiles the cell (unfreezes it)
    return true;
  }
  // The eraser clears a terrain cell to empty (overlay cell, or a base cell to void) or, on the objects
  // layer, removes the entity. An empty base cell is safe: Rules treats a cell with no terrain as
  // unwalkable void (terrainAt → undefined, tryMove 'no terrain', standable false) and it draws nothing.
  function eraseAt(x, y) {
    if (E.layer === 'spawn') return clearSpawn();
    if (E.layer === 'roof') return setRoof(x, y, '');
    if (E.layer === 'nobuild') return setNoBuild(x, y, '');
    if (E.layer === 'height') return fallMode() ? setFall(x, y, '') : setElev(x, y, '');
    if (E.layer === 'terrain') return setTerrain(x, y, '');
    return removeObject(x, y);
  }

  // ---- shift-click mapping: frozen shapes + a two-layer stamp clipboard ----
  function writeCell(cells, overrides, x, y, id, maskVal) {
    if (id !== undefined && cells[y]) cells[y][x] = id;
    var key = x + ',' + y;
    if (maskVal == null) delete overrides[key]; else overrides[key] = maskVal;
  }
  function edgeSame() { return E.content.config.autotile_edge_same !== false; }
  // The exact mask a cell currently draws (override if frozen, else computed) — null for non-autotiles.
  function shapeOf(cells, overrides, x, y, id) {
    var t = id && E.content.terrain[id];
    return (t && t.autotile) ? Autotile.effectiveMask(cells, x, y, edgeSame(), overrides) : null;
  }
  // Place just the centre tile (mask 255, no edges) of the palette terrain on the active layer.
  function stampCenter(x, y) {
    if (!E.inside(x, y) || !E.brush.terrain) return false;
    var cells = E.cells(), ov = E.shapeMap();
    if (cells[y][x] === E.brush.terrain && ov[x + ',' + y] === 255) return false;
    writeCell(cells, ov, x, y, E.brush.terrain, 255);
    return true;
  }
  // Paste the clipboard (both layers + frozen shapes) anchored at (x, y).
  function pasteStamp(x, y) {
    if (!E.stamp) return false;
    var m = E.map(); E.ensureOverlay(m);
    var baseOv = (m.shapes = m.shapes || {}), ovOv = (m.overlayShapes = m.overlayShapes || {});
    var s = E.stamp, changed = false;
    for (var j = 0; j < s.h; j++) for (var i = 0; i < s.w; i++) {
      var tx = x + i, ty = y + j; if (!E.inside(tx, ty)) continue;
      var cell = s.cells[j * s.w + i];
      writeCell(m.terrain, baseOv, tx, ty, cell.base, cell.baseMask);
      writeCell(m.overlay, ovOv, tx, ty, cell.overlay, cell.overlayMask);
      changed = true;
    }
    return changed;
  }
  // Copy a region (or one cell) into the clipboard. freeze = capture exact shapes (Shift+Right), else ids only.
  function copyRegion(a, b, freeze) {
    var m = E.map();
    var x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    var w = x1 - x0 + 1, h = y1 - y0 + 1, cells = [];
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var base = (m.terrain[y] && m.terrain[y][x]) || '';
      var overlay = (m.overlay && m.overlay[y] && m.overlay[y][x]) || '';
      cells.push({ base: base, overlay: overlay,
        baseMask: freeze ? shapeOf(m.terrain, m.shapes, x, y, base) : null,
        overlayMask: freeze ? shapeOf(m.overlay, m.overlayShapes, x, y, overlay) : null });
    }
    E.stamp = { w: w, h: h, cells: cells };
    Panels.status((freeze ? 'Copied ' : 'Picked ') + w + '×' + h + ' — Shift+Left-click to stamp it');
  }
  function stampAt(x, y) { return E.stamp ? pasteStamp(x, y) : stampCenter(x, y); }
  E.clearStamp = function () { E.stamp = null; };
  function placeObject(x, y, ref) {
    if (!E.inside(x, y) || !ref) return false;
    var m = E.map(), old = E.entityAt(x, y), def = E.content.objects[ref];
    var stairs = !!def && def.kind === 'stairs';             // a staircase always says which way it climbs
    var face = stairs ? E.brushFacing : (def && Rules.turnable(def) && E.brushFacing !== 'S' ? E.brushFacing : '');
    var look = def && Rules.lookSprite(def, E.brushLook) ? E.brushLook : '';
    if (old && old.ref === ref) {                           // painting the same thing again only turns it, or changes its look
      var sameFace = !def || !(stairs || Rules.turnable(def)) || (stairs ? Rules.stairDir(old) === face : Rules.facingOf(old) === (face || 'S'));
      if (sameFace && (old.data.look || '') === look) return false;
      if (!sameFace) { if (face) old.data.facing = face; else delete old.data.facing; }
      if (look) old.data.look = look; else delete old.data.look;
      return old;
    }
    if (old) m.entities.splice(m.entities.indexOf(old), 1);
    var e = { key: E.newKey(m), x: x, y: y, ref: ref, data: face ? { facing: face } : {} };
    if (look) e.data.look = look;
    m.entities.push(e);
    return e;
  }
  function removeObject(x, y) {
    var m = E.map(), e = E.entityAt(x, y);
    if (!e) return false;
    m.entities.splice(m.entities.indexOf(e), 1);
    if (E.selected === e.key) E.selected = null;
    return true;
  }
  // ---- things on cliff faces (object defs with properties.layer === 'cliff'); see Render.cliffRect ----
  function isCliffObj(o) { return !!(o && o.properties && o.properties.layer === 'cliff'); }
  /** The current object brush, if it goes on cliff faces; else null. */
  E.cliffBrush = function () {
    if (E.layer !== 'objects' || E.paletteTab === 'monsters' || E.paletteTab === 'items' || !E.brush.object) return null;
    var o = E.content.objects[E.brush.object];
    return isCliffObj(o) ? o : null;
  };
  /** The spot on a cliff face under the pointer, for object o: { x, y, up, dx } (the middle of its picture lands on
   *  the pointer, in steps of an eighth of a tile), or null when the pointer is not on a face (or the view is flat). */
  E.cliffSpotAt = function (ev, o) {
    if (!raisedView()) return null;
    var r = canvas.getBoundingClientRect(), s = cellSize(), m = E.map(), px = ev.clientX - r.left - E.view.x, py = ev.clientY - r.top - E.view.y;
    var x = Math.floor(px / s); if (x < 0 || x >= m.width) return null;
    var img = o && o.sprite && Assets.get(o.sprite), hT = img ? img.height / 32 : 1;
    for (var y = Math.min(m.height - 1, Math.floor(py / s) + Render.maxElev(m) + 1); y >= 0 && y >= Math.floor(py / s) - 1; y--) {
      var f = Render.cliffFoot(m, x, y, 0, s);
      if (f.drop < 0.01 || py < f.top || py >= f.foot) continue;
      var snap = function (v) { return Math.round(v * 8) / 8; };
      return { x: x, y: y, up: Math.max(0, snap((f.foot - py) / s - hT / 2)), dx: snap(px / s - x - 0.5) };
    }
    return null;
  };
  /** The cliff thing drawn under the pointer (the last placed wins: it is drawn on top), or null. */
  E.cliffEntAt = function (ev) {
    if (!raisedView()) return null;
    var r = canvas.getBoundingClientRect(), s = cellSize(), m = E.map(), px = ev.clientX - r.left - E.view.x, py = ev.clientY - r.top - E.view.y;
    for (var i = m.entities.length - 1; i >= 0; i--) {
      var e = m.entities[i], o = e.ref && E.content.objects[e.ref]; if (!isCliffObj(o)) continue;
      var q = Render.cliffRect(m, o, e, 0, 0, s, 0);
      if (q && px >= q.x && px < q.x + q.w && py >= q.y && py < q.y + q.h) return e;
    }
    return null;
  };
  function placeCliffObject(spot, ref) {
    if (!spot || !ref) return false;
    var m = E.map(), d = {};
    if (spot.up) d.up = spot.up; if (spot.dx) d.dx = spot.dx;
    m.entities.push({ key: E.newKey(m), x: spot.x, y: spot.y, ref: ref, data: d });
    return true;
  }
  function removeEntity(e) {
    var m = E.map(), i = m.entities.indexOf(e); if (i < 0) return false;
    m.entities.splice(i, 1); if (E.selected === e.key) E.selected = null; return true;
  }
  // ---- wall-mounted objects (object defs with properties.layer === 'wall') ----
  // The current object brush, if it is a wall-mount object; else null.
  E.wallMountBrush = function () {
    if (E.layer !== 'objects' || E.paletteTab === 'monsters' || E.paletteTab === 'items' || !E.brush.object) return null;
    var o = E.content.objects[E.brush.object];
    return o && o.properties && o.properties.layer === 'wall' ? o : null;
  };
  // Wall-mount objects snap to the grid line nearest the cursor. An E-W line: the mount cell is the cell
  // south of it and the object sits on that cell's north wall (side 'N', its south face). A N-S line: the
  // mount cell is the cell east of it and the object sits on that cell's west wall (side 'W'). When only one
  // of the two nearest lines actually has a wall, that one wins. Returns {x, y, side} or null (outside the
  // map). ev = pointer event.
  E.mountCellAt = function (ev) {
    var r = canvas.getBoundingClientRect(), s = cellSize(), m = E.map();
    var pt = mapPt(ev), fx = pt.fx, fy = pt.fy;
    var hC = { x: Math.floor(fx), y: Math.round(fy), side: 'N' };       // nearest E-W line; the cell south of it
    var vC = { x: Math.round(fx), y: Math.floor(fy), side: 'W' };       // nearest N-S line; the cell east of it
    function ok(c) { return c.x >= 0 && c.x < m.width && c.y >= 0 && c.y < m.height; }
    function has(g, c) { return !!(g && g[c.y] && g[c.y][c.x]); }
    var hOk = ok(hC), vOk = ok(vC);
    if (!hOk || !vOk) return hOk ? hC : vOk ? vC : null;
    var hW = has(m.hWalls, hC), vW = has(m.vWalls, vC);
    if (hW !== vW) return hW ? hC : vC;
    return Math.abs(fx - vC.x) < Math.abs(fy - hC.y) ? vC : hC;
  };
  // The wall-mount entity already on this cell (its south-facing wall), so it can be repainted without
  // disturbing a floor object sharing the cell. One wall object per cell.
  function wallEntAt(x, y, side) {
    var m = E.map(); side = side || 'N';
    for (var i = m.entities.length - 1; i >= 0; i--) {
      var e = m.entities[i], o = e.ref && E.content.objects[e.ref];
      if (e.x === x && e.y === y && o && o.properties && o.properties.layer === 'wall' && ((e.data && e.data.side) || 'N') === side) return e;
    }
    return null;
  }
  function placeWallObject(cell, ref) {
    if (!cell || !E.inside(cell.x, cell.y) || !ref) return false;
    var ex = wallEntAt(cell.x, cell.y, cell.side);
    if (ex) { if (ex.ref === ref) return false; ex.ref = ref; return true; }
    var m = E.map();
    m.entities.push({ key: E.newKey(m), x: cell.x, y: cell.y, ref: ref, data: { side: cell.side || 'N' } });
    return true;
  }
  function eraseWallObject(cell) {
    if (!cell) return false;
    var ex = wallEntAt(cell.x, cell.y, cell.side); if (!ex) return false;
    var m = E.map(); m.entities.splice(m.entities.indexOf(ex), 1);
    if (E.selected === ex.key) E.selected = null; return true;
  }
  /** The object used to place monsters from the Monsters tab: the plain invisible spawn marker.
   *  (Sprited spawns like a nest are placed from the Objects palette; don't let them become the default.) */
  E.spawnObject = function () {
    var spawns = Object.keys(E.content.objects).filter(function (k) { return E.content.objects[k].kind === 'spawn'; });
    return spawns.filter(function (k) { return !E.content.objects[k].sprite; })[0] || spawns[0] || null;
  };
  function placeMonster(x, y, monster) {
    var spawn = E.spawnObject();
    if (!spawn) { Panels.status('Can\'t place monsters: no spawn object exists. Add an Object of kind "spawn" in the Content Studio and publish.', true); return false; }
    if (!E.inside(x, y) || !monster) return false;
    var old = E.entityAt(x, y);
    if (old && old.ref === spawn && old.data.monster === monster) return false;
    var e = placeObject(x, y, spawn);
    if (!e && old) { old.data = {}; e = old; }
    e.data = { monster: monster, count: 1, radius: 2 };
    return e;
  }
  /** The Items tab: an item lying on the ground (the built-in '_drop' object, which says what lies there). */
  function placeItem(x, y, item) {
    if (!E.inside(x, y) || !item || !E.content.objects._drop) return false;
    var old = E.entityAt(x, y), want = item + ':1';
    if (old && old.ref === '_drop' && String(old.data.pickup || '').split(':')[0] === item) return false;
    var e = placeObject(x, y, '_drop');
    if (!e && old) e = old;
    e.data = { pickup: want };
    return e;
  }
  E.setPaletteTab = function (t) {
    // Terrain defaults to the rectangle tool; things placed one at a time (objects, monsters, walls) to the brush.
    if (t !== E.paletteTab) {
      if (t === 'terrain' && E.tool === 'brush') E.tool = 'rect';
      else if (E.paletteTab === 'terrain' && E.tool === 'rect' && (t === 'objects' || t === 'monsters' || t === 'items' || t === 'walls')) E.tool = 'brush';
    }
    E.paletteTab = t;
    E.layer = t === 'terrain' ? 'terrain' : t === 'walls' ? 'walls' : t === 'roof' ? 'roof' : t === 'nobuild' ? 'nobuild' : t === 'height' ? 'height' : t === 'spawn' ? 'spawn' : 'objects';
  };
  // Player spawn point: a single cell per map {x, y, facing} where new/respawning players start. Click to set,
  // erase/click again on it to clear. Facing is chosen in the Start panel; it defaults to S.
  function setSpawn(x, y) {
    var m = E.map(); if (!m || !E.inside(x, y)) return false;
    if (m.spawn && m.spawn.x === x && m.spawn.y === y) return false;
    m.spawn = { x: x, y: y, facing: (m.spawn && m.spawn.facing) || 'S' };
    if (Panels.palette) Panels.palette();
    return true;
  }
  function clearSpawn() { var m = E.map(); if (!m || !m.spawn) return false; m.spawn = null; if (Panels.palette) Panels.palette(); return true; }
  // While a wall stroke is held, it stays on the grid line it started on (same direction, same line, and in
  // 'cursor' mode the same side): the cursor only chooses how far along that line. lock = the stroke's first edge.
  E.edgeOnLine = function (ev, lock) {
    var r = canvas.getBoundingClientRect(), s = cellSize(), m = E.map();
    var pt = mapPt(ev), fx = pt.fx, fy = pt.fy;
    if (lock.orient === 'h') return { orient: 'h', x: Math.max(0, Math.min(m.width - 1, Math.floor(fx))), y: lock.y, side: lock.side };
    return { orient: 'v', x: lock.x, y: Math.max(0, Math.min(m.height - 1, Math.floor(fy))), side: lock.side };
  };
  // Paint every segment from the last one painted to this one, so a fast drag leaves no gaps.
  function paintWallRun(from, to) {
    var along = to.orient === 'h' ? 'x' : 'y', a = from ? from[along] : to[along], b = to[along], step = a <= b ? 1 : -1, changed = false;
    for (var i = a; ; i += step) {
      var e = { orient: to.orient, x: to.x, y: to.y, side: to.side }; e[along] = i;
      if (paintWall(e)) changed = true;
      if (i === b) break;
    }
    return changed;
  }
  E.clearSpawn = clearSpawn;
  // ---- edge walls ----
  function wallToken(edge) {
    if (!E.brush.wall) return '';
    var t = E.brush.wall + ':' + Rules.WALL_H;
    // Offset onto one tile only for N-S walls, and only in 'cursor' mode (keeps existing maps centred).
    if (E.wallSide === 'cursor' && edge && edge.orient === 'v' && (edge.side === 'l' || edge.side === 'r')) t += ':' + edge.side;
    return t;
  }
  function setWall(edge, val) {
    if (!edge) return false;
    E.ensureWalls();
    var m = E.map(), grid = edge.orient === 'h' ? m.hWalls : m.vWalls, row = grid[edge.y];
    if (!row || row[edge.x] === undefined) return false;
    if (row[edge.x] === val) return false;
    row[edge.x] = val; return true;
  }
  function paintWall(edge) { return setWall(edge, E.tool === 'erase' ? '' : wallToken(edge)); }
  function paint(x, y) {
    if (E.layer === 'spawn') return setSpawn(x, y);
    if (E.layer === 'roof') return setRoof(x, y, '1');
    if (E.layer === 'nobuild') return setNoBuild(x, y, '1');
    if (E.layer === 'height') return fallMode() ? setFall(x, y, fallToken()) : setElev(x, y, elevToken());
    if (E.layer === 'terrain') return setTerrain(x, y, E.brush.terrain);
    if (E.paletteTab === 'monsters') return placeMonster(x, y, E.brush.monster);
    if (E.paletteTab === 'items') return placeItem(x, y, E.brush.item);
    return placeObject(x, y, E.brush.object);
  }
  function line(a, b, fn) {  // every cell between a and b, so fast strokes leave no gaps
    var dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y), sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1, err = dx - dy;
    var x = a.x, y = a.y, changed = false;
    for (;;) {
      if (fn(x, y)) changed = true;
      if (x === b.x && y === b.y) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return changed;
  }
  function rect(a, b, fn) {
    var changed = false;
    for (var y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++)
      for (var x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) if (fn(x, y)) changed = true;
    return changed;
  }
  // Fill a building: flood the cells enclosed by walls from (sx,sy) and mark them as roof — or clear them,
  // if the clicked cell is already roofed (toggle). Any wall edge is the boundary; an open route to the map
  // edge means it isn't enclosed, so nothing is filled. This makes the roof exactly the interior, so the
  // cover reveals only when the player is truly inside the walls (not merely under an overhang).
  function floodRoof(sx, sy) {
    var m = E.map(), w = m.width, h = m.height, g = E.ensureRoof(m);
    function edgeWall(x, y, dir) { var e = Rules.wallEdge(x, y, dir); return Rules.wallAt(m, e.orient, e.x, e.y); }
    var DIRS = [['N', 0, -1], ['S', 0, 1], ['W', -1, 0], ['E', 1, 0]];
    var seen = {}, stack = [[sx, sy]], cells = [], escaped = false;
    seen[sx + ',' + sy] = 1;
    while (stack.length) {
      var p = stack.pop(), x = p[0], y = p[1]; cells.push(p);
      for (var i = 0; i < DIRS.length; i++) {
        var d = DIRS[i], nx = x + d[1], ny = y + d[2];
        if (edgeWall(x, y, d[0])) continue;                                   // a wall on this edge bounds the building
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) { escaped = true; continue; }  // open to the map edge → not enclosed
        var k = nx + ',' + ny; if (seen[k]) continue; seen[k] = 1; stack.push([nx, ny]);
      }
    }
    if (escaped) { Panels.status('Not enclosed — that area opens to the map edge. Close the walls (or add a door) around the building, then Fill again.', true); return false; }
    var to = g[sy][sx] === '1' ? '' : '1', changed = false;                   // toggle: fill an open building, clear a roofed one
    cells.forEach(function (cc) { if (g[cc[1]][cc[0]] !== to) { g[cc[1]][cc[0]] = to; changed = true; } });
    if (changed) m._roofZones = null;
    return changed;
  }
  function flood(x, y) {
    if (!E.inside(x, y)) return false;
    if (E.layer === 'spawn') return setSpawn(x, y);
    if (E.layer === 'roof') return floodRoof(x, y);
    if (E.layer === 'nobuild') return setNoBuild(x, y, '1');
    if (E.layer === 'height') return fallMode() ? setFall(x, y, fallToken()) : setElev(x, y, elevToken());
    if (E.layer === 'objects') return rect({ x: x, y: y }, { x: x, y: y }, paint);
    var cells = E.cells();
    var from = cells[y][x], to = (E.tool === 'erase' && E.terrainLayer === 'overlay') ? '' : E.brush.terrain;
    if (from === to) return false;
    var stack = [[x, y]];
    while (stack.length) {
      var p = stack.pop(), px = p[0], py = p[1];
      if (!E.inside(px, py) || cells[py][px] !== from) continue;
      cells[py][px] = to;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    return true;
  }
  function eyedrop(x, y) {
    if (!E.inside(x, y)) return;
    var e = E.entityAt(x, y);
    var eo = e && E.content.objects[e.ref];
    if (E.layer === 'objects' && e && eo && eo.kind === 'spawn' && e.data.monster) { E.brush.monster = e.data.monster; E.setPaletteTab('monsters'); }
    else if (E.layer === 'objects' && e && e.ref === '_drop' && e.data.pickup) { E.brush.item = String(e.data.pickup).split(':')[0]; E.setPaletteTab('items'); }
    else if (E.layer === 'objects' && e) { E.brush.object = e.ref; E.setPaletteTab('objects'); }
    else { var picked = E.cells()[y][x]; if (picked) E.brush.terrain = picked; E.setPaletteTab('terrain'); }
    E.setTool(E.paletteTab === 'terrain' ? 'rect' : 'brush'); Panels.palette();
  }

  // ------------------------------------------------------------ maps
  var LAST_MAP_KEY = 'sheetsrpg.editorLastMap';   // the map last opened, so a reload comes back to it
  E.openMap = function (id) {
    E.mapId = id; E.selected = null; E.groundDirty = true; if (E.underBake) E.underBake.stale = true;
    try { localStorage.setItem(LAST_MAP_KEY, id); } catch (e) {}
    if (!E.mode || E.mode.type !== 'pos') E.mode = null;   // picking a destination may switch maps
    E.fitView(); Panels.all(); E.redraw();
  };
  E.fitView = function () {
    var m = E.map(), wrap = canvas.parentElement, t = T();
    var z = Math.min((wrap.clientWidth - 60) / (m.width * t), (wrap.clientHeight - 60) / (m.height * t));
    z = Math.max(0.25, Math.min(4, Math.floor(z * 4) / 4));
    E.view.zoom = z;
    E.view.x = Math.round((wrap.clientWidth - m.width * t * z) / 2);
    E.view.y = Math.round((wrap.clientHeight - m.height * t * z) / 2);
    E.redraw();
  };
  // ---- floors (docs/FLOORS.md): a multi-storey map is a ground map plus one map per floor, all the same size.
  E.groundId = function (id) { var m = E.content.maps[id || E.mapId]; return m && m.floorOf ? m.floorOf : (id || E.mapId); };
  /** The floors of the open map's building, lowest first: [{z, id}]. */
  E.floors = function (id) {
    var g = E.content.maps[E.groundId(id)], f = (g && g.floors) || {};
    var out = Object.keys(f).map(function (k) { return { z: Number(k), id: f[k] }; }).sort(function (a, b) { return a.z - b.z; });
    return out.length ? out : [{ z: 0, id: E.groundId(id) }];
  };
  /** How many tiles up the screen one floor is drawn: the height of a wall. */
  E.storey = function () { return Rules.WALL_H; };
  /** Add a floor above the highest (dir 1) or a basement below the lowest (dir -1): empty, same size, and open it. */
  E.addFloor = function (dir) {
    var gid = E.groundId(), g = E.content.maps[gid], fl = E.floors();
    var z = dir > 0 ? fl[fl.length - 1].z + 1 : fl[0].z - 1, id = gid + '_z' + (z < 0 ? 'm' + (-z) : z);
    while (E.content.maps[id]) id += 'x';
    var terrain = [];
    for (var y = 0; y < g.height; y++) { var row = []; for (var x = 0; x < g.width; x++) row.push(''); terrain.push(row); }   // open air: paint the floor where there is one
    E.content.maps[id] = { id: id, name: g.name, width: g.width, height: g.height, terrain: terrain, overlay: [], vWalls: [], hWalls: [], roof: [],
      shapes: {}, overlayShapes: {}, entities: [], floorOf: gid, z: z };
    Content.linkFloors(E.content);
    E.dirty.maps[id] = true;
    E.openFloor(z);
    if (E.scheduleWip) E.scheduleWip();
    return id;
  };
  /** Open another floor of the same building, keeping the view where it is. */
  E.openFloor = function (z) {
    var hit = E.floors().filter(function (f) { return f.z === z; })[0]; if (!hit || hit.id === E.mapId) return;
    // Floors are drawn raised, as in the game: each one wall-height (2 tiles) higher on the screen than the one
    // below. The view belongs to the open floor, so moving it by the difference keeps the ground where it was.
    var v = { zoom: E.view.zoom, x: E.view.x, y: E.view.y }, from = E.map().z || 0;
    E.openMap(hit.id);
    E.view.zoom = v.zoom; E.view.x = v.x; E.view.y = v.y - (z - from) * E.storey() * cellSize(); E.redraw();
  };
  /** Delete the open floor (not the ground: that is Delete map, which takes the floors with it). */
  E.deleteFloor = function () {
    var m = E.map(); if (!m.floorOf) return;
    var gid = m.floorOf; dropMap(m.id);
    Content.linkFloors(E.content);
    E.openFloor(0); if (E.mapId !== gid) E.openMap(gid);
    Panels.all(); Panels.status(); if (E.scheduleWip) E.scheduleWip();
  };
  function dropMap(id) {
    delete E.content.maps[id];
    delete E.dirty.maps[id];
    E.tables.Maps = E.tables.Maps.filter(function (r) { return String(r.id) !== id; });
    E.tables.MapEntities = E.tables.MapEntities.filter(function (r) { return String(r.map) !== id; });
    if (E.dirty.deleted.indexOf(id) < 0) E.dirty.deleted.push(id);
    E.undo = E.undo.filter(function (s) { return s.mapId !== id; }); E.redo = [];
  }
  E.newMap = function (name, w, h) {
    var n = 0;
    Object.keys(E.content.maps).forEach(function (id) { var m = /^map_(\d+)$/.exec(id); if (m) n = Math.max(n, Number(m[1]) + 1); });
    var id = 'map_' + n, fill = E.brush.terrain;
    var terrain = [];
    for (var y = 0; y < h; y++) { var row = []; for (var x = 0; x < w; x++) row.push(fill); terrain.push(row); }
    E.content.maps[id] = { id: id, name: name || id, width: w, height: h, terrain: terrain, overlay: [], vWalls: [], hWalls: [], roof: [], shapes: {}, overlayShapes: {}, entities: [] };
    E.dirty.maps[id] = true;
    E.openMap(id);
    return id;
  };
  E.duplicateMap = function () {
    var fam = E.floors(), srcGround = E.content.maps[E.groundId()];
    if (E.map().floorOf) E.openMap(srcGround.id);                       // duplicate the whole building, from its ground floor
    var src = E.map(), id = E.newMap(src.name + ' copy', src.width, src.height), m = E.content.maps[id];
    fam.forEach(function (f) {                                          // its other floors come along
      if (!f.z) return;
      var fs = E.content.maps[f.id], fid = id + '_z' + (f.z < 0 ? 'm' + (-f.z) : f.z), copy = JSON.parse(JSON.stringify(fs));
      copy.id = fid; copy.name = m.name; copy.floorOf = id; copy.floors = null;
      copy.entities = fs.entities.map(function (e, i) { return { key: fid + '.e' + (i + 1), x: e.x, y: e.y, ref: e.ref, data: JSON.parse(JSON.stringify(e.data)) }; });
      E.content.maps[fid] = copy; E.dirty.maps[fid] = true;
    });
    Content.linkFloors(E.content);
    m.terrain = JSON.parse(JSON.stringify(src.terrain));
    m.overlay = JSON.parse(JSON.stringify(src.overlay || []));
    m.vWalls = JSON.parse(JSON.stringify(src.vWalls || []));
    m.hWalls = JSON.parse(JSON.stringify(src.hWalls || []));
    m.roof = JSON.parse(JSON.stringify(src.roof || [])); m.roof_color = src.roof_color || '';
    m.spawn = src.spawn ? JSON.parse(JSON.stringify(src.spawn)) : null;
    m.shapes = JSON.parse(JSON.stringify(src.shapes || {}));
    m.overlayShapes = JSON.parse(JSON.stringify(src.overlayShapes || {}));
    m.entities = src.entities.map(function (e, i) { return { key: id + '.e' + (i + 1), x: e.x, y: e.y, ref: e.ref, data: JSON.parse(JSON.stringify(e.data)) }; });
    E.markDirty('map'); Panels.all();
  };
  E.resizeMap = function (w, h) {
    var fam = E.floors(), here = E.mapId, brush = E.brush.terrain;
    if (fam.length > 1 && !resizingFamily) {                            // a building: every floor keeps the same size
      resizingFamily = true;
      fam.forEach(function (f) { E.mapId = f.id; E.brush.terrain = f.z ? '' : brush; E.resizeMap(w, h); E.dirty.maps[f.id] = true; });
      resizingFamily = false; E.mapId = here; E.brush.terrain = brush; E.groundDirty = true;
      E.fitView(); Panels.all();
      return;
    }
    E.checkpoint();
    var m = E.map(), fill = E.brush.terrain, terrain = [];
    for (var y = 0; y < h; y++) {
      var row = [];
      for (var x = 0; x < w; x++) row.push(y < m.height && x < m.width ? m.terrain[y][x] : fill);
      terrain.push(row);
    }
    var overlay = (m.overlay && m.overlay.length) ? [] : null;   // resize the overlay the same way, '' for new cells
    if (overlay) for (var oy = 0; oy < h; oy++) {
      var orow = [];
      for (var ox = 0; ox < w; ox++) orow.push(oy < m.height && ox < m.width && m.overlay[oy] ? (m.overlay[oy][ox] || '') : '');
      overlay.push(orow);
    }
    m.terrain = terrain; if (overlay) m.overlay = overlay;
    // edge walls: rebuild to the new bounds, keeping segments still in range
    function resizeWalls(src, rows, cols) {
      if (!src || !src.length) return src;
      var g = [];
      for (var y = 0; y < rows; y++) { var r = []; for (var x = 0; x < cols; x++) r.push((src[y] && src[y][x]) || ''); g.push(r); }
      return g;
    }
    if (m.hWalls && m.hWalls.length) m.hWalls = resizeWalls(m.hWalls, h + 1, w);
    if (m.vWalls && m.vWalls.length) m.vWalls = resizeWalls(m.vWalls, h, w + 1);
    if (m.roof && m.roof.length) m.roof = resizeWalls(m.roof, h, w);
    if (m.nobuild && m.nobuild.length) m.nobuild = resizeWalls(m.nobuild, h, w);
    if (m.elev && m.elev.length) m.elev = resizeWalls(m.elev, h, w);
    if (m.falls && m.falls.length) m.falls = resizeWalls(m.falls, h, w);
    m.width = w; m.height = h;
    m.entities = m.entities.filter(function (e) { return e.x < w && e.y < h; });
    ['shapes', 'overlayShapes'].forEach(function (k) {         // drop frozen shapes outside the new bounds
      var o = m[k]; if (!o) return; var keep = {};
      Object.keys(o).forEach(function (key) { var p = key.split(','); if (+p[0] < w && +p[1] < h) keep[key] = o[key]; });
      m[k] = keep;
    });
    E.markDirty('map'); E.fitView(); Panels.all();
  };
  var resizingFamily = false;
  E.deleteMap = function () {
    var fam = E.floors().map(function (f) { return f.id; }), grounds = Object.keys(E.content.maps).filter(function (k) { return !E.content.maps[k].floorOf; });
    if (grounds.length < 2) { alert('A game needs at least one map.'); return; }
    fam.forEach(dropMap);                                               // the map and all its floors
    Content.linkFloors(E.content);
    E.openMap(Object.keys(E.content.maps).filter(function (k) { return !E.content.maps[k].floorOf; })[0]);
    Panels.status(); scheduleWip();
  };

  // ------------------------------------------------------------ saving
  E.save = function () {
    E.syncAll();
    var changes = { maps: {}, tabs: {}, deleted: [] };
    Object.keys(E.dirty.maps).forEach(function (id) { if (E.content.maps[id]) changes.maps[id] = E.mapRows(E.content.maps[id]); });
    Object.keys(E.dirty.tabs).forEach(function (t) { changes.tabs[t] = E.tables[t]; });
    changes.deletedMaps = E.dirty.deleted.slice();
    Panels.status('saving…');
    return Store.save(changes, E.tables, E.base).then(function (r) {
      E.dirty = { maps: {}, tabs: {}, deleted: [] };
      if (r.where === 'server' || r.where === 'local') { E.base = Store.baseOf(E.tables); Store.clearWip(); }  // saved: tables are now the base
      Panels.status(r.where === 'server' ? 'saved to Game Data' : r.where === 'local' ? 'saved in the project files (data/game/)' : 'saved as a draft in this browser');
    }).catch(function (e) { Panels.status('save failed: ' + e.message, true); });
  };

  // ------------------------------------------------------------ drawing
  E.redraw = function () { E.needsDraw = true; };
  // Authoring aid: an arrow along a staircase's run, pointing the way it climbs, and a box where it lands upstairs.
  function stairArrow(e, o, vx, vy, s) {
    var dir = Rules.stairDir(e), d = Rules.DIRS[dir], n = Rules.stairLen();
    var x0 = vx + (e.x + 0.5) * s, y0 = vy + (e.y + 0.5) * s, x1 = x0 + d.dx * (n - 0.6) * s, y1 = y0 + d.dy * (n - 0.6) * s, a = s * 0.22;
    g.save(); g.strokeStyle = '#ffe08a'; g.fillStyle = '#ffe08a'; g.lineWidth = Math.max(2, s * 0.08);
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.beginPath(); g.moveTo(x1 + d.dx * a, y1 + d.dy * a); g.lineTo(x1 - d.dy * a, y1 + d.dx * a); g.lineTo(x1 + d.dy * a, y1 - d.dx * a); g.closePath(); g.fill();
    g.setLineDash([4, 3]); g.lineWidth = 1;
    g.strokeRect(vx + (e.x + n * d.dx) * s + 2.5, vy + (e.y + n * d.dy) * s + 2.5, s - 5, s - 5);            // the landing, on the floor above
    g.restore();
  }
  /** Clear the floor above a staircase's run, so there is a stairwell to come up through. Says what it found. */
  E.openStairwell = function (e) {
    var o = E.content.objects[e.ref], m = E.map(), up = E.floors().filter(function (f) { return f.z === (m.z || 0) + 1; })[0];
    if (!up) return 'There is no floor above this one yet: add it with “+ Above”.';
    var um = E.content.maps[up.id], dir = Rules.stairDir(e), d = Rules.DIRS[dir], n = Rules.stairLen(), cleared = 0;
    for (var i = 0; i < n; i++) {
      var x = e.x + i * d.dx, y = e.y + i * d.dy;
      if (um.terrain[y] && um.terrain[y][x]) { um.terrain[y][x] = ''; cleared++; }
      if (um.overlay && um.overlay[y] && um.overlay[y][x]) um.overlay[y][x] = '';
    }
    if (cleared) { E.dirty.maps[up.id] = true; if (E.underBake) E.underBake.stale = true; if (E.scheduleWip) E.scheduleWip(); }
    var lx = e.x + n * d.dx, ly = e.y + n * d.dy, landed = um.terrain[ly] && um.terrain[ly][lx];
    return (cleared ? 'Opened the stairwell on the floor above (' + cleared + ' tile' + (cleared === 1 ? '' : 's') + ' cleared). ' : 'The stairwell above is already open. ') +
      (landed ? 'It lands on the floor above at (' + lx + ', ' + ly + ').' : 'But there is no floor to land on above at (' + lx + ', ' + ly + '): paint one there.');
  };

  function frame() {
    requestAnimationFrame(frame);
    var nowF = performance.now();
    if (E.animates && E.show.animate && nowF - (E.lastAnim || 0) > 100) E.needsDraw = true;      // water, lava and waterfalls keep moving
    if (!E.needsDraw || !E.content) return;
    E.needsDraw = false; E.lastAnim = nowF;
    var animT = E.show.animate ? nowF : 0;                                     // still pictures unless Animate is on
    var wrap = canvas.parentElement;
    if (canvas.width !== wrap.clientWidth || canvas.height !== wrap.clientHeight) {
      canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    }
    var m = E.map(), c = E.content, t = T(), s = cellSize(), vx = E.view.x, vy = E.view.y;
    // Raised view: ground with height is drawn as the game draws it, each tile lifted by its height with its cliff
    // face under it, and everything that stands on it lifted the same (LF). Off (H), the map is flat, with relief.
    var up = raisedView();
    if (E.groundDirty || E.groundUp !== up) {
      E.ground = Render.bakeGround(c, m, up); E.groundUp = up; E.groundDirty = false;
      E.moving = Render.animatedCells ? Render.animatedCells(c, m) : [];
      E.fallList = Render.fallCells ? Render.fallCells(c, m) : [];
      E.animates = !!(E.moving.length || E.fallList.length);
    }
    function LF(x, y) { return up ? Render.liftAt(m, Math.max(0, Math.min(m.width - 1, x)), Math.max(0, Math.min(m.height - 1, y)), s) : 0; }
    function cy(x, y) { return vy + y * s - LF(x, y); }                       // where a tile's top edge is drawn
    var hovY = E.hover ? cy(E.hover.x, E.hover.y) : 0, hovVy = E.hover ? vy - LF(E.hover.x, E.hover.y) : vy;
    var cx0 = Math.max(0, Math.floor(-vx / s) - 1), cx1 = Math.min(m.width - 1, Math.ceil((canvas.width - vx) / s) + 1);
    var cy0 = Math.max(0, Math.floor(-vy / s) - 1), cy1 = Math.min(m.height - 1, Math.ceil((canvas.height - vy) / s) + 1 + (up ? Render.maxElev(m) : 0));
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#101216'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#1b1e25'; g.fillRect(vx - 1, vy - 1, m.width * s + 2, m.height * s + 2);
    // On a floor of a building, the next floor toward the ground shows faintly as a guide, at its own height:
    // lower on the screen under an upper floor, higher above a basement — where the game will draw it.
    var under = null, mz = m.z || 0;
    if (m.floors && mz) {
      var toward = E.floors().filter(function (f) { return mz > 0 ? f.z < mz : f.z > mz; });
      if (toward.length) under = c.maps[(mz > 0 ? toward[toward.length - 1] : toward[0]).id];
    }
    if (under) {
      if (!E.underBake || E.underBake.id !== under.id || E.underBake.stale) E.underBake = { id: under.id, img: Render.bakeGround(c, under) };
      var uy = vy + Math.round((mz - (under.z || 0)) * E.storey() * s);
      g.fillStyle = '#1b1e25'; g.fillRect(vx - 1, uy - 1, m.width * s + 2, m.height * s + 2);
      g.globalAlpha = 0.45; g.drawImage(E.underBake.img, vx, uy, m.width * s, m.height * s);
      g.globalAlpha = 0.35; if (Render.wall25) Render.wall25(c, under).forEach(function (p) { Render.drawPrim25(g, c, p, vx, uy, s); });
      g.globalAlpha = 1;
    }
    var gpad = (E.ground.pad || 0) * s / t;                                    // (a raised bake has room on top for the lift)
    if (E.show.terrain) g.drawImage(E.ground, vx, vy - gpad, m.width * s, m.height * s + gpad);
    if (E.show.terrain && E.moving && E.moving.length) Render.drawAnimated(g, c, E.moving, vx, vy, s, animT, null, null, null, null, up ? LF : null);   // water, lava… move here as in the game
    if (E.show.terrain && up && E.fallList && E.fallList.length) Render.drawFalls(g, c, m, E.fallList, vx, vy, s, animT);
    if (E.show.objects && up) {                                               // what hangs on the cliff faces
      g.globalAlpha = E.layer === 'terrain' && E.tool !== 'select' ? 0.55 : 1;
      Render.drawCliffThings(g, c, m, vx, vy, s, animT);
      g.globalAlpha = 1;
      var cbr = E.cliffBrush();
      if (cbr && E.cliffHover && !E.mode && E.tool !== 'erase' && E.tool !== 'select') {
        g.globalAlpha = 0.55; Render.drawCliffThing(g, m, cbr, { x: E.cliffHover.x, y: E.cliffHover.y, data: { up: E.cliffHover.up, dx: E.cliffHover.dx } }, vx, vy, s, 0); g.globalAlpha = 1;
      }
    }

    // Objects and 2.5D edge walls share ONE back-to-front pass (by south edge), exactly as the game draws
    // them, so a thing north of a wall is hidden behind it and one south of it sits in front — live, as you
    // paint.
    var objDim = E.layer === 'terrain' && E.tool !== 'select' ? 0.55 : 1;
    var wallAlpha = E.layer === 'walls' ? 1 : 0.85;   // walls dimmed a touch unless their layer is active
    var items = [];
    if (E.show.objects) m.entities.forEach(function (e) {
      var eo = c.objects[e.ref];
      if (up && isCliffObj(eo)) return;                                      // on a cliff face: drawn with the ground (flat view: on its tile, like any object)
      if (eo && Render.wallMountPlace && Render.layerOf(eo) === 'wall') {              // hung on a wall edge
        var mp = Render.wallMountPlace(m, eo, e, vx, vy, s);                           // screen position (with view offset)
        var ms = Render.wallMountPlace(m, eo, e, 0, 0, s);                             // sort key in the no-offset space the other items use
        items.push({ sortY: ms.sortY, ent: e, o: eo, dx: mp.dx, dy: mp.dy - LF(e.x, e.y), flip: mp.flip });
      } else items.push({ sortY: Math.round(e.y * s) + s, ent: e, o: eo, dx: vx + e.x * s, dy: cy(e.x, e.y), face: eo && e.data && e.data.facing ? Rules.facingSprite(eo, e) : null });
    });
    if (Render.wall25) Render.wall25(c, m).forEach(function (p) {
      var isCap = p.kind === 'hcap' || p.kind === 'vcap';
      items.push({ sortY: Render.prim25SortY(p, 0, s) + (isCap ? 0.5 : 0.25), prim: p });
    });
    items.sort(function (a, b) { return a.sortY - b.sortY; });
    items.forEach(function (it) {
      if (it.prim) { g.globalAlpha = wallAlpha; Render.drawPrim25(g, c, it.prim, vx, vy - LF(it.prim.x, it.prim.y), s); g.globalAlpha = 1; return; }
      g.globalAlpha = objDim;
      var e = it.ent, o = it.o, vyE = vy - LF(e.x, e.y);
      if (!o) g.drawImage(Assets.placeholder('?', '#a33', t), it.dx, it.dy, s, s);
      else if (o.kind === 'stairs') { Render.drawStairs(g, c, o, e, vx, vyE, s, 0); stairArrow(e, o, vx, vyE, s); }
      else if (o.kind === 'spawn' && !o.sprite) drawSpawn(e, o, it.dx, it.dy, s);   // spriteless: editor-only marker
      else {
        var sde = Render.sideDoorEdges ? Render.sideDoorEdges(o, e) : [];
        if (sde.length && sde.every(function (q) { return Render.drawDoorstep(g, m, o, e.data && e.data.state === 'open', vx, vyE, q.x, q.y, s); })) { g.globalAlpha = 1; return; }
        var path = (e.data && e.data.state && o.spriteStates[e.data.state]) || (it.face ? it.face.path : o.sprite);
        if (!(e.data && e.data.state && o.spriteStates[e.data.state]) && !it.face) path = Rules.lookSprite(o, e) || path;   // one of its other looks
        if (o.id === '_drop') { var lying = World.list((e.data || {}).pickup)[0], lit = lying && c.items[lying.item]; path = (lit && lit.sprite) || '#built'; }   // an item on the ground: its own picture
        var flp = it.flip || !!(it.face && it.face.flip);                    // turned objects show the way they face
        Render.drawObject(g, o, path, it.dx, it.dy, s, 'base', 0, flp);
        Render.drawObject(g, o, path, it.dx, it.dy, s, 'top', 0, flp);   // overflow (no-op when the sprite is one tile)
        if (o.kind === 'spawn') drawSpawnBadge(e, o, vx + e.x * s, cy(e.x, e.y), s);   // a sprited spawner (nest…): show what it spawns
      }
      g.globalAlpha = 1;
    });

    // roof cover (authoring aid): tint roofed tiles so you can see what counts as indoors (under the roof until seen) in-game.
    // Stronger when the Roof layer is active; dimmed otherwise so it never obscures normal editing.
    if (m.roof && m.roof.length && E.layer === 'roof') {              // only while the Roof tab is active; otherwise the cover is fully transparent
      g.fillStyle = 'rgba(66,105,200,0.5)';
      for (var ry = 0; ry < m.height; ry++) { var rrow = m.roof[ry] || [];
        for (var rx = 0; rx < m.width; rx++) if (rrow[rx]) g.fillRect(vx + rx * s, cy(rx, ry), s, s); }
    }

    // ground height: relief as the game shows it, with the numbers while the Height tab is active
    if (!up && m.elev && m.elev.length && Render.drawRelief) Render.drawRelief(g, m, vx, vy, s, null, null, null, null, E.layer === 'height');
    if (E.layer === 'height') {
      var hx, hy;
      if (up) {                                                            // raised: the height written on each raised tile
        g.font = 'bold ' + Math.max(9, Math.round(s * 0.34)) + 'px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
        for (hy = cy0; hy <= cy1; hy++) for (hx = cx0; hx <= cx1; hx++) {
          var eh = Rules.heightAt(m, hx, hy), er = Rules.rampAt(m, hx, hy); if (!eh && !er) continue;
          var lab = String(eh) + (er ? { N: '▲', E: '▶', S: '▼', W: '◀' }[er] : '');
          g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(lab, vx + hx * s + 3, cy(hx, hy) + 2);
          g.fillStyle = 'rgba(255,255,255,.95)'; g.fillText(lab, vx + hx * s + 2, cy(hx, hy) + 1);
        }
        g.textBaseline = 'alphabetic';
      }
      // waterfalls: on the flat map a blue band along the edge the water falls from (raised, the fall itself shows);
      // a ring on the ones put by hand, a cross where one is forbidden, a grey W on a mark with no cliff under it.
      var bw = Math.max(3, Math.round(s * 0.22)), seenF = {};
      (E.fallList || []).forEach(function (f) {
        seenF[f.x + ',' + f.y] = 1;
        if (!up) { g.fillStyle = 'rgba(70,170,255,.85)'; g.fillRect(vx + f.x * s, vy + (f.y + 1) * s - bw, s, bw); }
        if (f.hand) { g.strokeStyle = '#7fd0ff'; g.lineWidth = 2; g.strokeRect(vx + f.x * s + 2, cy(f.x, f.y) + 2, s - 4, s - 4); }
      });
      if (m.falls && m.falls.length) for (hy = cy0; hy <= cy1; hy++) for (hx = cx0; hx <= cx1; hx++) {
        var fm = m.falls[hy] && m.falls[hy][hx]; if (!fm) continue;
        var fX = vx + hx * s, fY = cy(hx, hy);
        if (fm === '0') { g.strokeStyle = '#ff7a6a'; g.lineWidth = 2; g.beginPath(); g.moveTo(fX + s * 0.25, fY + s * 0.25); g.lineTo(fX + s * 0.75, fY + s * 0.75); g.moveTo(fX + s * 0.75, fY + s * 0.25); g.lineTo(fX + s * 0.25, fY + s * 0.75); g.stroke(); }
        else if (!seenF[hx + ',' + hy]) { g.fillStyle = 'rgba(200,200,200,.8)'; g.font = 'bold ' + Math.max(9, Math.round(s * 0.4)) + 'px sans-serif'; g.textAlign = 'center'; g.fillText('W', fX + s / 2, fY + s * 0.65); g.textAlign = 'left'; }
      }
      g.lineWidth = 1;
    }

    // no-build tiles (authoring aid): a red hatch, shown while the No-build tab is active
    if (m.nobuild && m.nobuild.length && E.layer === 'nobuild') {
      g.fillStyle = 'rgba(220,70,60,0.35)'; g.strokeStyle = 'rgba(255,120,110,0.9)'; g.lineWidth = 1;
      for (var ny = 0; ny < m.height; ny++) { var nrow = m.nobuild[ny] || [];
        for (var nx = 0; nx < m.width; nx++) if (nrow[nx]) {
          g.fillRect(vx + nx * s, cy(nx, ny), s, s);
          g.beginPath(); g.moveTo(vx + nx * s, cy(nx, ny) + s); g.lineTo(vx + (nx + 1) * s, cy(nx, ny)); g.stroke();
        } }
    }

    // player spawn marker (authoring aid): a green pin + facing arrow at the map's spawn cell. Always visible
    // so the start point shows from any tab; brighter while the Start tab is active.
    if (m.spawn) {
      var spActive = E.layer === 'spawn';
      var cxp = vx + m.spawn.x * s + s / 2, cyp = cy(m.spawn.x, m.spawn.y) + s / 2, rad = Math.max(4, s * 0.3);
      g.globalAlpha = spActive ? 1 : 0.65; g.fillStyle = '#3fd27a'; g.strokeStyle = '#0b3b22'; g.lineWidth = 2;
      g.beginPath(); g.arc(cxp, cyp, rad, 0, Math.PI * 2); g.fill(); g.stroke();
      var fd = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[(m.spawn.facing || 'S')] || [0, 1];
      var px = -fd[1], py = fd[0], hw = s * 0.16;                         // facing arrow: a triangle from the rim outward
      var tipX = cxp + fd[0] * (rad + s * 0.3), tipY = cyp + fd[1] * (rad + s * 0.3), bx = cxp + fd[0] * rad, by = cyp + fd[1] * rad;
      g.beginPath(); g.moveTo(tipX, tipY); g.lineTo(bx + px * hw, by + py * hw); g.lineTo(bx - px * hw, by - py * hw); g.closePath(); g.fill(); g.stroke();
      if (s >= 14) { g.fillStyle = '#0b3b22'; g.font = 'bold ' + Math.round(s * 0.5) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('P', cxp, cyp + 1); }
      g.globalAlpha = 1;
    }

    if (E.show.grid && s >= 8 && up) {                                     // raised: each tile's own outline, where it is drawn
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
      for (var gy = cy0; gy <= cy1; gy++) for (var gx = cx0; gx <= cx1; gx++) g.strokeRect(vx + gx * s + .5, cy(gx, gy) + .5, s, s);
    } else if (E.show.grid && s >= 8) {
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.beginPath();
      for (var x = 0; x <= m.width; x++) { g.moveTo(vx + x * s + .5, vy); g.lineTo(vx + x * s + .5, vy + m.height * s); }
      for (var y = 0; y <= m.height; y++) { g.moveTo(vx, vy + y * s + .5); g.lineTo(vx + m.width * s, vy + y * s + .5); }
      g.stroke();
    }

    // walls layer: highlight the edge under the cursor (red when erasing, else the brush colour)
    if (E.layer === 'walls' && E.hoverEdge && !E.mode) {
      var he = E.hoverEdge, ws = c.wallStyles && c.wallStyles[E.brush.wall];
      g.strokeStyle = E.tool === 'erase' ? '#ff7a6a' : (ws && ws.color) || '#6fe08a';
      g.lineWidth = Math.max(3, Math.round(s * 0.18)); g.lineCap = 'round'; g.beginPath();
      var hvy = vy - LF(he.orient === 'v' && he.side === 'l' ? he.x - 1 : he.x, he.orient === 'h' && he.side === 'n' ? he.y - 1 : he.y);   // (lifted with the tile the cursor is on)
      if (he.orient === 'h') { g.moveTo(vx + he.x * s, hvy + he.y * s); g.lineTo(vx + (he.x + 1) * s, hvy + he.y * s); }
      else {
        // In 'cursor' mode nudge the preview onto the tile the wall will occupy, matching the render offset.
        var hd = Math.round(Math.max(4, Math.round(s * 0.32)) / 2);
        var off = E.wallSide === 'cursor' && he.side === 'r' ? hd : E.wallSide === 'cursor' && he.side === 'l' ? -hd : 0;
        g.moveTo(vx + he.x * s + off, hvy + he.y * s); g.lineTo(vx + he.x * s + off, hvy + (he.y + 1) * s);
      }
      g.stroke(); g.lineWidth = 1; g.lineCap = 'butt';
    }

    // objects layer, wall-mount brush: ghost the object on the south-facing wall + highlight that wall line
    var wmb = E.wallMountBrush();
    if (wmb && E.mountHover && !E.mode && (E.tool === 'brush' || E.tool === 'erase')) {
      var mc = E.mountHover, mvy = vy - LF(mc.x, mc.y);
      if (E.tool !== 'erase') {
        var gp = Render.wallMountPlace(m, wmb, { x: mc.x, y: mc.y, data: { side: mc.side || 'N' } }, vx, mvy, s);
        g.globalAlpha = 0.5;
        Render.drawObject(g, wmb, wmb.sprite, gp.dx, gp.dy, s, 'base', 0, gp.flip);
        Render.drawObject(g, wmb, wmb.sprite, gp.dx, gp.dy, s, 'top', 0, gp.flip);
        g.globalAlpha = 1;
      }
      g.strokeStyle = E.tool === 'erase' ? '#ff7a6a' : '#ffd27a';
      g.lineWidth = Math.max(3, Math.round(s * 0.18)); g.lineCap = 'round'; g.beginPath();
      g.moveTo(vx + mc.x * s, mvy + mc.y * s);                                                  // the cell's north wall line, or its west one
      if (mc.side === 'W') g.lineTo(vx + mc.x * s, mvy + (mc.y + 1) * s); else g.lineTo(vx + (mc.x + 1) * s, mvy + mc.y * s);
      g.stroke(); g.lineWidth = 1; g.lineCap = 'butt';
    }

    // links from the selected entity (switch targets, door/teleport destinations on this map)
    var sel = E.selected && E.entityByKey(E.selected);
    if (sel) {
      Panels.links(sel).forEach(function (l) {
        if (l.map !== m.id) return;
        g.strokeStyle = '#f2c14e'; g.setLineDash([5, 4]); g.lineWidth = 2; g.beginPath();
        g.moveTo(vx + (sel.x + .5) * s, cy(sel.x, sel.y) + .5 * s); g.lineTo(vx + (l.x + .5) * s, cy(l.x, l.y) + .5 * s); g.stroke();
        g.setLineDash([]); g.strokeRect(vx + l.x * s + 3, cy(l.x, l.y) + 3, s - 6, s - 6);
      });
      g.strokeStyle = '#4ea1ff'; g.lineWidth = 2;
      var selR = up && isCliffObj(c.objects[sel.ref]) ? Render.cliffRect(m, c.objects[sel.ref], sel, vx, vy, s, 0) : null;
      if (selR) g.strokeRect(selR.x - 1, selR.y - 1, selR.w + 2, selR.h + 2);                // on a cliff face: round its picture
      else g.strokeRect(vx + sel.x * s + 1, cy(sel.x, sel.y) + 1, s - 2, s - 2);
    }

    // pick modes: highlight what can be clicked
    if (E.mode && E.mode.type === 'entities') {
      g.lineWidth = 2;
      m.entities.forEach(function (e) {
        var on = E.mode.keys.indexOf(e.key) >= 0;
        g.strokeStyle = on ? '#f2c14e' : 'rgba(242,193,78,.35)';
        g.strokeRect(vx + e.x * s + 2, cy(e.x, e.y) + 2, s - 4, s - 4);
      });
    }

    if (drag && (drag.kind === 'rect' || drag.kind === 'copy')) {
      var a = drag.start, b = drag.end, copy = drag.kind === 'copy', erasing = drag.erase;   // red = erase, amber = copy-to-stamp, blue = paint rect
      g.fillStyle = erasing ? 'rgba(255,122,106,.22)' : copy ? 'rgba(242,193,78,.18)' : 'rgba(78,161,255,.25)';
      g.strokeStyle = erasing ? '#ff7a6a' : copy ? '#f2c14e' : '#4ea1ff'; g.lineWidth = 1;
      var rx = vx + Math.min(a.x, b.x) * s, ry = vy + Math.min(a.y, b.y) * s;
      var rw = (Math.abs(a.x - b.x) + 1) * s, rh = (Math.abs(a.y - b.y) + 1) * s;
      if (up) {                                                            // raised: tile by tile, each where it is drawn
        for (var qy = Math.max(0, Math.min(a.y, b.y)); qy <= Math.min(m.height - 1, Math.max(a.y, b.y)); qy++)
          for (var qx = Math.max(0, Math.min(a.x, b.x)); qx <= Math.min(m.width - 1, Math.max(a.x, b.x)); qx++) { g.fillRect(vx + qx * s, cy(qx, qy), s, s); g.strokeRect(vx + qx * s + .5, cy(qx, qy) + .5, s - 1, s - 1); }
      } else { g.fillRect(rx, ry, rw, rh); g.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1); }
    } else if (E.stamp && E.layer === 'terrain' && E.hover && E.inside(E.hover.x, E.hover.y)) {
      g.strokeStyle = '#f2c14e'; g.lineWidth = 1;                       // paste footprint of the clipboard
      g.strokeRect(vx + E.hover.x * s + .5, hovY + .5, E.stamp.w * s - 1, E.stamp.h * s - 1);
    } else if (E.hover && E.inside(E.hover.x, E.hover.y)) {
      g.strokeStyle = E.mode ? '#f2c14e' : 'rgba(255,255,255,.8)'; g.lineWidth = 1;
      g.strokeRect(vx + E.hover.x * s + .5, hovY + .5, s - 1, s - 1);
      if (!E.mode && (E.tool === 'brush' || E.tool === 'rect')) {     // ghost of what will be painted
        g.globalAlpha = .5;
        if (E.layer === 'objects' && E.paletteTab === 'monsters' && E.brush.monster) {
          var bm = c.monsters[E.brush.monster], bmi = bm && Assets.get(bm.sprite);
          if (bmi) g.drawImage(bmi, vx + E.hover.x * s, hovY, s, s);
        } else if (E.layer === 'objects' && E.paletteTab === 'items') {
          var bit = c.items[E.brush.item], biti = bit && bit.sprite && Assets.get(bit.sprite);
          if (biti) g.drawImage(biti, vx + E.hover.x * s, hovY, s, s);
        } else if (E.layer === 'objects' && E.brush.object) {
          var bo = c.objects[E.brush.object], bfs = bo && Rules.turnable(bo) ? Rules.facingSprite(bo, E.brushFacing) : null;
          if (bo && bo.kind === 'stairs') { var ge = { x: E.hover.x, y: E.hover.y, data: { facing: E.brushFacing } }; Render.drawStairs(g, c, bo, ge, vx, hovVy, s, 0); g.globalAlpha = 1; stairArrow(ge, bo, vx, hovVy, s); bo = null; }
          var bi = bo && Assets.get(bfs ? bfs.path : (Rules.lookSprite(bo, E.brushLook) || bo.sprite)), bgx = vx + E.hover.x * s, bgy = hovY;
          if (bi && bfs && bfs.flip) { g.save(); g.translate(bgx + s, bgy); g.scale(-1, 1); g.drawImage(bi, 0, 0, s, s); g.restore(); }
          else if (bi) g.drawImage(bi, bgx, bgy, s, s);
        } else if (E.layer === 'terrain') {
          var tt = c.terrain[E.brush.terrain], gx = vx + E.hover.x * s, gy = hovY, gts, gimg;
          if (tt && tt.autotile && (gts = c.tilesets[tt.autotile]) && (gimg = Assets.get(gts.image))) {
            var full = (c.autotile[gts.layout] || {})[255], gn = (full ? full[0] : 1) - 1, gc = gts.columns || 8, gz = gts.tileSize || 32;
            g.drawImage(gimg, (gn % gc) * gz, Math.floor(gn / gc) * gz, gz, gz, gx, gy, s, s);
          } else if (tt && tt.sprite && (gimg = Assets.get(tt.sprite))) g.drawImage(gimg, gx, gy, s, s);
          // no art → no ghost fill (the cell outline still shows where you'll paint)
        }
        g.globalAlpha = 1;
      }
    }
  }
  requestAnimationFrame(frame);

  /** Spawn points look like their monster, with how many appear; the selected one shows how far they roam. */
  function drawSpawn(e, o, dx, dy, s) {
    var pr = World.props(E.content, e), mon = E.content.monsters[pr.monster], img = mon && mon.sprite && Assets.get(mon.sprite);
    g.fillStyle = 'rgba(200,60,60,.25)'; g.fillRect(dx, dy, s, s);
    if (img) g.drawImage(img, dx, dy, s, s); else g.drawImage(Assets.placeholder(mon ? mon.name : '?', '#8a2f2f', T()), dx, dy, s, s);
    var n = Number(pr.count) || 1;
    g.font = 'bold ' + Math.max(9, Math.round(s * 0.3)) + 'px sans-serif'; g.textAlign = 'right';
    g.fillStyle = 'rgba(0,0,0,.7)'; g.fillText('×' + n, dx + s - 1, dy + s - 1);
    g.fillStyle = '#fff'; g.fillText('×' + n, dx + s - 2, dy + s - 2);
    if (E.selected === e.key) {
      var r = Number(pr.radius) || 0;
      g.strokeStyle = '#ff7a6a'; g.setLineDash([4, 3]); g.lineWidth = 1.5;
      g.strokeRect(dx - r * s + .5, dy - r * s + .5, (2 * r + 1) * s - 1, (2 * r + 1) * s - 1); g.setLineDash([]);
    }
  }
  // A sprited spawner (a nest, a portal…) draws its own art; this adds the editor-only spawn info over its
  // cell — a small monster badge, the ×count, and the spawn radius when selected. None of it shows in-game.
  function drawSpawnBadge(e, o, cx, cy, s) {
    var pr = World.props(E.content, e), mon = E.content.monsters[pr.monster], img = mon && mon.sprite && Assets.get(mon.sprite);
    var n = Number(pr.count) || 1, bs = Math.max(8, Math.round(s * 0.4));
    g.fillStyle = 'rgba(200,60,60,.6)'; g.fillRect(cx, cy, bs, bs);
    if (img) g.drawImage(img, cx, cy, bs, bs);
    g.font = 'bold ' + Math.max(9, Math.round(s * 0.3)) + 'px sans-serif'; g.textAlign = 'right';
    g.fillStyle = 'rgba(0,0,0,.7)'; g.fillText('×' + n, cx + s - 1, cy + s - 1);
    g.fillStyle = '#fff'; g.fillText('×' + n, cx + s - 2, cy + s - 2);
    if (E.selected === e.key) {
      var r = Number(pr.radius) || 0;
      g.strokeStyle = '#ff7a6a'; g.setLineDash([4, 3]); g.lineWidth = 1.5;
      g.strokeRect(cx - r * s + .5, cy - r * s + .5, (2 * r + 1) * s - 1, (2 * r + 1) * s - 1); g.setLineDash([]);
    }
  }

  // ------------------------------------------------------------ input
  /** Is the open map drawn with its ground raised (the Raised view, on a map that has height)? */
  function raisedView() { var m = E.map(); return !!(E.show.raised !== false && m && Render.elevOn && Render.elevOn(m)); }
  /** Where on the map the pointer is, in tiles with fractions. On raised ground that is the tile DRAWN under it. */
  function mapPt(ev) {
    var r = canvas.getBoundingClientRect(), s = cellSize(), px = ev.clientX - r.left - E.view.x, py = ev.clientY - r.top - E.view.y;
    if (!raisedView()) return { fx: px / s, fy: py / s };
    var m = E.map(), cell = Render.pickCells(m, px, py, s)[0];
    if (!cell || cell.x < 0 || cell.y < 0 || cell.x >= m.width || cell.y >= m.height) return { fx: px / s, fy: py / s };
    var fy = (py + Render.liftAt(m, cell.x, cell.y, s)) / s;
    return { fx: px / s, fy: Math.max(cell.y, Math.min(cell.y + 0.999, fy)) };
  }
  function cellAt(ev) { var pt = mapPt(ev); return { x: Math.floor(pt.fx), y: Math.floor(pt.fy) }; }

  E.setTool = function (t) {
    E.tool = t;   // erase works on whatever layer is active: base or overlay terrain, or objects
    Panels.toolbar(); E.redraw();
  };

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (ev) {
    canvas.setPointerCapture(ev.pointerId);
    var cell = cellAt(ev);
    if (ev.button === 1 || spaceDown) {            // middle button / Space pans (right-click is free now)
      drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, vx: E.view.x, vy: E.view.y }; canvas.style.cursor = 'grabbing'; return;
    }
    if (ev.button === 2) {                          // right button copies into the stamp (drag selects more)
      drag = { kind: 'copy', start: cell, end: cell, freeze: ev.shiftKey }; E.redraw(); return;
    }
    if (ev.button !== 0) return;

    if (E.mode) { Panels.pickAt(cell); E.redraw(); return; }

    if (ev.shiftKey && E.layer === 'terrain') {     // Shift+Left stamps: paste the clipboard, else the centre tile
      E.checkpoint();
      var sch = stampAt(cell.x, cell.y);
      drag = { kind: 'stamp', last: cell, changed: sch };
      if (sch) E.markDirty('map');
      return;
    }

    if (E.layer === 'walls') {
      var edge = E.edgeAt(ev);
      if (E.tool === 'pick') {   // eyedrop a wall: adopt its style + height as the brush
        var tok = edge && Rules.wallAt(E.map(), edge.orient, edge.x, edge.y), pw = tok && Rules.parseWall(tok);
        if (pw) { E.brush.wall = pw.style; E.setPaletteTab('walls'); E.setTool('brush'); Panels.palette(); }
        return;
      }
      if (E.tool !== 'erase' && !E.brush.wall) { Panels.status('pick a wall style in the palette first', true); return; }
      E.checkpoint();
      var wch = paintWall(edge);
      drag = { kind: 'wall', changed: wch, lock: edge, last: edge };
      if (wch) E.markDirty('map'); else E.undo.pop();
      return;
    }

    if (E.tool === 'select') {
      var e = E.cliffEntAt(ev) || (E.inside(cell.x, cell.y) && E.entityAt(cell.x, cell.y));   // (what hangs on a cliff face is picked by its picture)
      E.selected = e ? e.key : null;
      Panels.inspector(cell);
      if (e) drag = { kind: 'move', key: e.key, from: cell, moved: false };
      E.redraw(); return;
    }
    if (E.tool === 'pick') { eyedrop(cell.x, cell.y); return; }
    if (E.layer === 'objects' && E.tool === 'erase' && E.cliffEntAt(ev)) {     // erasing on a cliff face: the thing under the pointer, one per click
      E.checkpoint(); removeEntity(E.cliffEntAt(ev)); E.markDirty('map', true); Panels.inspector(); return;
    }
    if (E.cliffBrush() && E.tool !== 'erase') {                                // things for cliff faces go on a face, anywhere on it, as many as you like
      if (!raisedView()) { Panels.status('this goes on a cliff face: turn on Raised (H) to see the cliffs', true); return; }
      var cspot = E.cliffSpotAt(ev, E.cliffBrush());
      if (!cspot) { Panels.status('this goes on a cliff face: click on the face of raised ground', true); return; }
      E.checkpoint(); placeCliffObject(cspot, E.brush.object); E.markDirty('map', true); return;
    }
    if (E.wallMountBrush() && (E.tool === 'brush' || E.tool === 'erase')) {   // snap wall-mount objects to the south-facing wall
      E.checkpoint();
      var wcell = E.mountCellAt(ev), wok = E.tool === 'erase' ? eraseWallObject(wcell) : placeWallObject(wcell, E.brush.object);
      drag = { kind: 'wallobj', erase: E.tool === 'erase', changed: wok };
      if (wok) E.markDirty('map'); else E.undo.pop();
      return;
    }
    if (E.layer === 'objects' && E.tool !== 'erase' && !(E.paletteTab === 'monsters' ? E.brush.monster : E.paletteTab === 'items' ? E.brush.item : E.brush.object)) {
      Panels.status('pick ' + (E.paletteTab === 'monsters' ? 'a monster' : E.paletteTab === 'items' ? 'an item' : 'an object') + ' in the palette first', true); return;
    }

    E.checkpoint();
    var changed = false;
    if (E.tool === 'brush') { changed = paint(cell.x, cell.y); drag = { kind: 'paint', last: cell, changed: changed }; }
    else if (E.tool === 'erase') { drag = { kind: 'rect', start: cell, end: cell, erase: true }; }   // drag a box to erase; click = one tile
    else if (E.tool === 'rect') { drag = { kind: 'rect', start: cell, end: cell }; }
    else if (E.tool === 'fill') { changed = flood(cell.x, cell.y); if (changed) E.markDirty('map'); else E.undo.pop(); }
    if (changed) E.markDirty('map');
  });

  canvas.addEventListener('pointermove', function (ev) {
    var cell = cellAt(ev);
    if (!E.hover || E.hover.x !== cell.x || E.hover.y !== cell.y) { E.hover = cell; Panels.cellInfo(cell); E.redraw(); }
    if (E.layer === 'walls') {   // track the nearest edge for the walls-layer highlight (and to paint while dragging)
      var ed = drag && drag.kind === 'wall' && drag.lock ? E.edgeOnLine(ev, drag.lock) : E.edgeAt(ev), he = E.hoverEdge;
      if (!he || !ed || he.orient !== ed.orient || he.x !== ed.x || he.y !== ed.y || he.side !== ed.side) { E.hoverEdge = ed; E.redraw(); }
    } else if (E.cliffBrush()) {       // the ghost of a cliff thing follows the pointer over the faces
      E.cliffHover = E.cliffSpotAt(ev, E.cliffBrush()); E.redraw();
    } else if (E.wallMountBrush()) {   // track the mount cell (south-facing wall) for the wall-mount ghost
      var mc = E.mountCellAt(ev), mh = E.mountHover;
      if (!mh || !mc || mh.x !== mc.x || mh.y !== mc.y || mh.side !== mc.side) { E.mountHover = mc; E.redraw(); }
    }
    if (!drag) return;
    if (drag.kind === 'wall') {
      if (!drag.lock) { drag.lock = drag.last = E.edgeAt(ev); if (!drag.lock) return; }     // the press was off the map: lock on entering it
      var we = E.edgeOnLine(ev, drag.lock);
      if (paintWallRun(drag.last, we)) { drag.changed = true; E.markDirty('map'); }
      drag.last = we;
      return;
    }
    if (drag.kind === 'wallobj') {
      var wc = E.mountCellAt(ev);
      if (drag.erase ? eraseWallObject(wc) : placeWallObject(wc, E.brush.object)) { drag.changed = true; E.markDirty('map'); }
      return;
    }
    if (drag.kind === 'pan') { E.view.x = drag.vx + ev.clientX - drag.sx; E.view.y = drag.vy + ev.clientY - drag.sy; E.redraw(); return; }
    if (drag.kind === 'paint' || drag.kind === 'stamp') {
      if (cell.x === drag.last.x && cell.y === drag.last.y) return;
      var fn = drag.kind === 'paint' ? paint : stampAt;
      var ch = line(drag.last, cell, fn);
      drag.last = cell;
      if (ch) { drag.changed = true; E.markDirty('map'); }
    } else if (drag.kind === 'rect' || drag.kind === 'copy') { drag.end = cell; E.redraw(); }
    else if (drag.kind === 'move') {
      var e = E.entityByKey(drag.key);
      if (e && isCliffObj(E.content.objects[e.ref])) {                         // along the cliff faces, wherever the pointer goes
        var cs = E.cliffSpotAt(ev, E.content.objects[e.ref]);
        if (cs && (cs.x !== e.x || cs.y !== e.y || cs.up !== ((e.data || {}).up || 0) || cs.dx !== ((e.data || {}).dx || 0))) {
          if (!drag.moved) { E.checkpoint(); drag.moved = true; }
          e.x = cs.x; e.y = cs.y; e.data = e.data || {};
          if (cs.up) e.data.up = cs.up; else delete e.data.up;
          if (cs.dx) e.data.dx = cs.dx; else delete e.data.dx;
          E.markDirty('map', true); Panels.inspector();
        }
        return;
      }
      if (e && E.inside(cell.x, cell.y) && !E.entityAt(cell.x, cell.y)) {
        if (!drag.moved) { E.checkpoint(); drag.moved = true; }
        var eo = E.content.objects[e.ref], onGround = !!(eo && Render.layerOf && Render.layerOf(eo) === 'ground_decal');   // (a decal is part of the painted ground)
        e.x = cell.x; e.y = cell.y; E.markDirty('map', !onGround); Panels.inspector();
      }
    }
  });

  function endDrag() {
    if (!drag) return;
    if (drag.kind === 'copy') { copyRegion(drag.start, drag.end, drag.freeze); }   // captures into E.stamp; no map change
    else if (drag.kind === 'rect') {
      if (rect(drag.start, drag.end, drag.erase ? eraseAt : paint)) E.markDirty('map'); else E.undo.pop();
    } else if ((drag.kind === 'paint' || drag.kind === 'stamp' || drag.kind === 'wall' || drag.kind === 'wallobj') && !drag.changed) E.undo.pop();
    drag = null; canvas.style.cursor = ''; E.redraw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function () { E.hover = null; E.hoverEdge = null; E.mountHover = null; E.cliffHover = null; E.redraw(); });

  // Turn a turnable object: the selected one if there is one, else the one about to be placed. dir 1 = clockwise.
  E.turn = function (dir) {
    var sel = E.selected && E.entityByKey(E.selected), so = sel && E.content.objects[sel.ref];
    if (sel && so && (so.kind === 'stairs' || Rules.turnable(so)) && !(so.properties && so.properties.layer === 'wall')) {
      E.checkpoint();
      var nf = Rules.nextFacing(so.kind === 'stairs' ? Rules.stairDir(sel) : sel, dir);
      if (nf === 'S' && so.kind !== 'stairs') delete sel.data.facing; else sel.data.facing = nf;
      E.markDirty('map'); Panels.inspector(); E.redraw();
      return true;
    }
    var bo = E.layer === 'objects' && E.paletteTab !== 'monsters' && E.paletteTab !== 'items' && E.brush.object && E.content.objects[E.brush.object];
    if (!bo || !(bo.kind === 'stairs' || Rules.turnable(bo))) return false;
    E.brushFacing = Rules.nextFacing(E.brushFacing, dir);
    Panels.status((bo.kind === 'stairs' ? 'climbs ' : 'facing ') + ({ N: 'north', E: 'east', S: 'south', W: 'west' })[E.brushFacing] + ' (T or Shift+wheel turns)');
    E.redraw();
    return true;
  };
  /** The next look of the selected object, else of the object about to be painted (N, or Shift+wheel on one that does not turn). */
  E.nextLook = function (dir) {
    var sel = E.selected && E.entityByKey(E.selected), so = sel && E.content.objects[sel.ref];
    if (sel && so && Rules.looks(so).length) {
      E.checkpoint();
      var nl = Rules.nextLook(so, sel.data.look, dir);
      if (nl) sel.data.look = nl; else delete sel.data.look;
      E.markDirty('map'); Panels.inspector(); E.redraw();
      return true;
    }
    var bo = E.layer === 'objects' && E.paletteTab !== 'monsters' && E.paletteTab !== 'items' && E.brush.object && E.content.objects[E.brush.object];
    var all = bo ? Rules.looks(bo) : [];
    if (!all.length) return false;
    E.brushLook = Rules.nextLook(bo, Rules.lookSprite(bo, E.brushLook) ? E.brushLook : '', dir);
    Panels.status('look ' + ((E.brushLook ? all.indexOf(E.brushLook) + 1 : 0) + 1) + ' of ' + (all.length + 1) + ' (N or Shift+wheel: the next one)');
    E.redraw();
    return true;
  };
  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    if (ev.shiftKey) { var wd = (ev.deltaY || ev.deltaX) > 0 ? 1 : -1; if (!E.turn(wd)) E.nextLook(wd); return; }      // Shift+wheel turns (or, for something that does not turn, shows its next look); plain wheel zooms
    var r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    var z = E.view.zoom, nz = Math.max(0.25, Math.min(8, z * (ev.deltaY < 0 ? 1.25 : 0.8)));
    E.view.x = mx - (mx - E.view.x) * nz / z; E.view.y = my - (my - E.view.y) * nz / z; E.view.zoom = nz;
    Panels.status(); E.redraw();
  }, { passive: false });

  var KEYS = { b: 'brush', r: 'rect', f: 'fill', e: 'erase', v: 'select' };
  addEventListener('keydown', function (ev) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? E.doRedo() : E.doUndo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); E.doRedo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 's') { ev.preventDefault(); E.save(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (k === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; ev.preventDefault(); return; }
    if (k === 'n') { if (!E.nextLook(ev.shiftKey ? -1 : 1)) Panels.status('this object has only one look: add more pictures to it in the Content Studio (Other looks)', true); return; }
    if (k === 't') { if (!E.turn(1)) Panels.status('nothing to turn: pick or select an object that has pictures for other directions', true); return; }
    if (KEYS[k]) { E.setTool(KEYS[k]); return; }
    if (k === 'g') { E.show.grid = !E.show.grid; Panels.toolbar(); E.redraw(); return; }
    if (k === 'h') { E.show.raised = E.show.raised === false; Panels.toolbar(); E.redraw(); return; }
    if (k === '1') { E.setPaletteTab('terrain'); Panels.all(); E.redraw(); return; }
    if (k === '2') { E.setPaletteTab(E.paletteTab === 'monsters' ? 'monsters' : 'objects'); Panels.all(); E.redraw(); return; }
    if (k === '3') { E.setPaletteTab('monsters'); Panels.all(); E.redraw(); return; }
    if (k === '4') { E.setPaletteTab('walls'); Panels.all(); E.redraw(); return; }
    if (k === '5') { E.setPaletteTab('roof'); Panels.all(); E.redraw(); return; }
    if (k === '6') { E.setPaletteTab('spawn'); Panels.all(); E.redraw(); return; }
    if (k === '7') { E.setPaletteTab('nobuild'); Panels.all(); E.redraw(); return; }
    if (k === '8') { E.setPaletteTab('height'); Panels.all(); E.redraw(); return; }
    if (k === 'o' && E.layer === 'walls') { E.wallSide = E.wallSide === 'cursor' ? 'center' : 'cursor'; Panels.palette(); E.redraw(); return; }
    if (k === '0') { E.fitView(); return; }
    if (k === 'escape') { if (E.mode) Panels.endPick(); else { E.selected = null; Panels.inspector(); E.redraw(); } return; }
    if ((k === 'delete' || k === 'backspace') && E.selected) {
      var e = E.entityByKey(E.selected);
      if (e) { E.checkpoint(); removeObject(e.x, e.y); E.markDirty('map'); Panels.inspector(); }
    }
  });
  addEventListener('keyup', function (ev) { if (ev.key === ' ') { spaceDown = false; canvas.style.cursor = ''; } });
  addEventListener('resize', E.redraw);
  // Warn before leaving with unsaved changes — but NOT inside the desktop app (window.desktop, set by
  // Electron's preload): there, a beforeunload that cancels silently blocks closing the window and
  // switching tools, which wedges the whole app. On the web this still guards against losing edits.
  if (!window.desktop) {
    addEventListener('beforeunload', function (ev) { if (E.isDirty()) { ev.preventDefault(); ev.returnValue = ''; } });
  }

  // ------------------------------------------------------------ start
  Store.load().then(function (res) {
    E.tables = res.tables; E.source = res.source;
    var fromFiles = res.source === 'local';
    E.base = res.source === 'server' || fromFiles ? Store.baseOf(res.tables) : null;   // what the sheet / the files looked like when loaded
    // Restore unsaved work-in-progress (autosaved locally in online and local mode) so switching tools or restarting
    // the app doesn't lose edits. Not offline — offline keeps its own draft.
    if (res.source === 'server' || fromFiles) {
      var wip = Store.loadWip();
      if (wip && wip.tables) {
        var unchanged = JSON.stringify(wip.base) === JSON.stringify(E.base);   // server same as when editing began
        var keep = unchanged || confirm((fromFiles
          ? 'You have unsaved map editor changes from before, but the project files have changed since (a git pull, or the Content Studio).\n\n' +
            'OK: keep your unsaved changes (saving writes the maps you changed over the files).\nCancel: discard them and open the files as they are now.'
          : 'You have unsaved editor changes from before, but the published game data has changed since.\n\n' +
            'OK: keep your unsaved changes (Save may then report a conflict to resolve).\nCancel: discard them and open the latest data.'));
        if (keep) { E.tables = wip.tables; E.base = wip.base || E.base; E.dirty = wip.dirty || { maps: {}, tabs: {}, deleted: [] }; E.source = 'wip'; }
        else { Store.clearWip(); }
      }
    }
    E.content = Content.build(E.tables);
    var first = Object.keys(E.content.objects).filter(function (k) { return E.content.objects[k].kind !== 'spawn'; })[0];
    E.brush.object = first || null;
    E.brush.monster = Object.keys(E.content.monsters)[0] || null;
    E.brush.wall = Object.keys(E.content.wallStyles || {})[0] || null;
    if (!E.content.terrain[E.brush.terrain]) E.brush.terrain = Object.keys(E.content.terrain)[0];
    // open right away; repaint as images arrive instead of waiting for slow image hosts
    E.loadArt().then(function () { E.groundDirty = true; E.redraw(); Panels.palette(); Panels.inspector(); });
  }).then(function () {
    // ?map= wins; otherwise the map that was open last time (if it still exists); otherwise the first one
    var want = new URLSearchParams(location.search).get('map'), last = null;
    try { last = localStorage.getItem(LAST_MAP_KEY); } catch (e) {}
    E.mapId = E.content.maps[want] ? want : E.content.maps[last] ? last : Object.keys(E.content.maps)[0];
    Panels.all(); E.openMap(E.mapId);
    Panels.status(E.source === 'draft' ? 'opened your draft from this browser' :
      E.source === 'wip' ? (Store.local() ? 'restored your unsaved changes (not yet saved to the project files)' : 'restored your unsaved changes (not yet published)') :
      E.source === 'local' ? 'opened the project files (data/game/)' :
      E.source === 'server' ? 'opened Game Data from the server' : 'opened the repository data (offline)');
  }).catch(function (e) { Panels.status('could not load: ' + e.message, true); console.error(e); });
})();
