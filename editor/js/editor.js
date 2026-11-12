/**
 * Map editor core: state, canvas drawing, tools, undo, map operations.
 * Panels (palette, map list, inspector) live in panels.js.
 */
var E = {
  tables: null, content: null, mapId: null,
  layer: 'terrain', terrainLayer: 'base', tool: 'brush', paletteTab: 'terrain',
  brush: { terrain: 'til_3', object: null, monster: null },
  view: { zoom: 2, x: 40, y: 40 },
  show: { terrain: true, objects: true, grid: true },
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
    if (wipTimer || !E.tables || !Store.online()) return;
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
    ['shapes', 'overlayShapes'].forEach(function (k) {                       // frozen shift-click shapes
      var o = map[k]; if (o && Object.keys(o).length) row[k] = JSON.stringify(o); else delete row[k];
    });
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
    Object.keys(c.objects).forEach(function (k) {
      var o = c.objects[k]; if (o.sprite) paths.push(o.sprite); if (o.spriteTop) paths.push(o.spriteTop);
      Object.keys(o.spriteStates).forEach(function (s) { paths.push(o.spriteStates[s]); });
    });
    return Promise.all(paths.map(Assets.load));
  };

  E.markDirty = function (what) {
    if (what === 'map') { E.dirty.maps[E.mapId] = true; E.groundDirty = true; }
    else E.dirty.tabs[what] = true;
    E.redraw(); Panels.status(); scheduleWip();
  };
  E.isDirty = function () { return Object.keys(E.dirty.maps).length || Object.keys(E.dirty.tabs).length || E.dirty.deleted.length; };

  // ------------------------------------------------------------ undo
  function snapshot() {
    var m = E.map();
    return { mapId: m.id, width: m.width, height: m.height, name: m.name,
      terrain: JSON.parse(JSON.stringify(m.terrain)), overlay: JSON.parse(JSON.stringify(m.overlay || [])),
      shapes: JSON.parse(JSON.stringify(m.shapes || {})), overlayShapes: JSON.parse(JSON.stringify(m.overlayShapes || {})),
      entities: JSON.parse(JSON.stringify(m.entities)) };
  }
  function restore(s) {
    var m = E.content.maps[s.mapId]; if (!m) return;
    if (E.mapId !== s.mapId) E.openMap(s.mapId);
    m.width = s.width; m.height = s.height; m.name = s.name; m.terrain = s.terrain; m.overlay = s.overlay || [];
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
  // The eraser: clears an overlay cell back to empty; on objects it removes the entity. The base ground
  // can't be erased (every cell needs a terrain), so erase is only offered on the overlay or objects.
  function eraseAt(x, y) {
    if (E.layer === 'terrain') return E.terrainLayer === 'overlay' ? setTerrain(x, y, '') : false;
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
    var m = E.map(), old = E.entityAt(x, y);
    if (old && old.ref === ref) return false;
    if (old) m.entities.splice(m.entities.indexOf(old), 1);
    var e = { key: E.newKey(m), x: x, y: y, ref: ref, data: {} };
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
  /** The object used to place monsters: the first object of kind "spawn". */
  E.spawnObject = function () {
    return Object.keys(E.content.objects).filter(function (k) { return E.content.objects[k].kind === 'spawn'; })[0] || null;
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
  E.setPaletteTab = function (t) {
    E.paletteTab = t;
    E.layer = t === 'terrain' ? 'terrain' : 'objects';
    if (E.tool === 'erase' && t === 'terrain' && E.terrainLayer !== 'overlay') E.tool = 'brush';
  };
  function paint(x, y) {
    if (E.layer === 'terrain') return setTerrain(x, y, E.brush.terrain);
    if (E.paletteTab === 'monsters') return placeMonster(x, y, E.brush.monster);
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
  function flood(x, y) {
    if (!E.inside(x, y)) return false;
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
    else if (E.layer === 'objects' && e) { E.brush.object = e.ref; E.setPaletteTab('objects'); }
    else { var picked = E.cells()[y][x]; if (picked) E.brush.terrain = picked; E.setPaletteTab('terrain'); }
    E.setTool('brush'); Panels.palette();
  }

  // ------------------------------------------------------------ maps
  E.openMap = function (id) {
    E.mapId = id; E.selected = null; E.groundDirty = true;
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
  E.newMap = function (name, w, h) {
    var n = 0;
    Object.keys(E.content.maps).forEach(function (id) { var m = /^map_(\d+)$/.exec(id); if (m) n = Math.max(n, Number(m[1]) + 1); });
    var id = 'map_' + n, fill = E.brush.terrain;
    var terrain = [];
    for (var y = 0; y < h; y++) { var row = []; for (var x = 0; x < w; x++) row.push(fill); terrain.push(row); }
    E.content.maps[id] = { id: id, name: name || id, width: w, height: h, terrain: terrain, overlay: [], shapes: {}, overlayShapes: {}, entities: [] };
    E.dirty.maps[id] = true;
    E.openMap(id);
    return id;
  };
  E.duplicateMap = function () {
    var src = E.map(), id = E.newMap(src.name + ' copy', src.width, src.height), m = E.content.maps[id];
    m.terrain = JSON.parse(JSON.stringify(src.terrain));
    m.overlay = JSON.parse(JSON.stringify(src.overlay || []));
    m.shapes = JSON.parse(JSON.stringify(src.shapes || {}));
    m.overlayShapes = JSON.parse(JSON.stringify(src.overlayShapes || {}));
    m.entities = src.entities.map(function (e, i) { return { key: id + '.e' + (i + 1), x: e.x, y: e.y, ref: e.ref, data: JSON.parse(JSON.stringify(e.data)) }; });
    E.markDirty('map'); Panels.all();
  };
  E.resizeMap = function (w, h) {
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
    m.terrain = terrain; if (overlay) m.overlay = overlay; m.width = w; m.height = h;
    m.entities = m.entities.filter(function (e) { return e.x < w && e.y < h; });
    ['shapes', 'overlayShapes'].forEach(function (k) {         // drop frozen shapes outside the new bounds
      var o = m[k]; if (!o) return; var keep = {};
      Object.keys(o).forEach(function (key) { var p = key.split(','); if (+p[0] < w && +p[1] < h) keep[key] = o[key]; });
      m[k] = keep;
    });
    E.markDirty('map'); E.fitView(); Panels.all();
  };
  E.deleteMap = function () {
    var id = E.mapId, ids = Object.keys(E.content.maps);
    if (ids.length < 2) { alert('A game needs at least one map.'); return; }
    delete E.content.maps[id];
    delete E.dirty.maps[id];
    E.tables.Maps = E.tables.Maps.filter(function (r) { return String(r.id) !== id; });
    E.tables.MapEntities = E.tables.MapEntities.filter(function (r) { return String(r.map) !== id; });
    if (E.dirty.deleted.indexOf(id) < 0) E.dirty.deleted.push(id);
    E.undo = E.undo.filter(function (s) { return s.mapId !== id; }); E.redo = [];
    E.openMap(Object.keys(E.content.maps)[0]);
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
      if (r.where === 'server') { E.base = Store.baseOf(E.tables); Store.clearWip(); }  // published: tables are now the base
      Panels.status(r.where === 'server' ? 'saved to Game Data' : 'saved as a draft in this browser');
    }).catch(function (e) { Panels.status('save failed: ' + e.message, true); });
  };

  // ------------------------------------------------------------ drawing
  E.redraw = function () { E.needsDraw = true; };

  function frame() {
    requestAnimationFrame(frame);
    if (!E.needsDraw || !E.content) return;
    E.needsDraw = false;
    var wrap = canvas.parentElement;
    if (canvas.width !== wrap.clientWidth || canvas.height !== wrap.clientHeight) {
      canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight;
    }
    var m = E.map(), c = E.content, t = T(), s = cellSize(), vx = E.view.x, vy = E.view.y;
    if (E.groundDirty) { E.ground = Render.bakeGround(c, m); E.groundDirty = false; }
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#101216'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#1b1e25'; g.fillRect(vx - 1, vy - 1, m.width * s + 2, m.height * s + 2);
    if (E.show.terrain) g.drawImage(E.ground, vx, vy, m.width * s, m.height * s);

    var dim = E.layer === 'terrain' && E.tool !== 'select' ? 0.55 : 1;
    if (E.show.objects) {
      g.globalAlpha = dim;
      var tops = [];
      m.entities.forEach(function (e) {
        var o = c.objects[e.ref], dx = vx + e.x * s, dy = vy + e.y * s;
        if (!o) { g.drawImage(Assets.placeholder('?', '#a33', t), dx, dy, s, s); return; }
        if (o.kind === 'spawn') { drawSpawn(e, o, dx, dy, s); return; }
        var path = (e.data && e.data.state && o.spriteStates[e.data.state]) || o.sprite;
        Render.drawObject(g, o, path, dx, dy, s, 'base', 0);
        tops.push({ o: o, path: path, y: e.y, dx: dx, dy: dy });
      });
      // tall objects' upper parts, lower rows last so they overlap correctly (as in the game)
      tops.sort(function (a, b) { return a.y - b.y; }).forEach(function (q) { Render.drawObject(g, q.o, q.path, q.dx, q.dy, s, 'top', 0); });
      g.globalAlpha = 1;
    }

    if (E.show.grid && s >= 8) {
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.beginPath();
      for (var x = 0; x <= m.width; x++) { g.moveTo(vx + x * s + .5, vy); g.lineTo(vx + x * s + .5, vy + m.height * s); }
      for (var y = 0; y <= m.height; y++) { g.moveTo(vx, vy + y * s + .5); g.lineTo(vx + m.width * s, vy + y * s + .5); }
      g.stroke();
    }

    // links from the selected entity (switch targets, door/teleport destinations on this map)
    var sel = E.selected && E.entityByKey(E.selected);
    if (sel) {
      Panels.links(sel).forEach(function (l) {
        if (l.map !== m.id) return;
        g.strokeStyle = '#f2c14e'; g.setLineDash([5, 4]); g.lineWidth = 2; g.beginPath();
        g.moveTo(vx + (sel.x + .5) * s, vy + (sel.y + .5) * s); g.lineTo(vx + (l.x + .5) * s, vy + (l.y + .5) * s); g.stroke();
        g.setLineDash([]); g.strokeRect(vx + l.x * s + 3, vy + l.y * s + 3, s - 6, s - 6);
      });
      g.strokeStyle = '#4ea1ff'; g.lineWidth = 2; g.strokeRect(vx + sel.x * s + 1, vy + sel.y * s + 1, s - 2, s - 2);
    }

    // pick modes: highlight what can be clicked
    if (E.mode && E.mode.type === 'entities') {
      g.lineWidth = 2;
      m.entities.forEach(function (e) {
        var on = E.mode.keys.indexOf(e.key) >= 0;
        g.strokeStyle = on ? '#f2c14e' : 'rgba(242,193,78,.35)';
        g.strokeRect(vx + e.x * s + 2, vy + e.y * s + 2, s - 4, s - 4);
      });
    }

    if (drag && (drag.kind === 'rect' || drag.kind === 'copy')) {
      var a = drag.start, b = drag.end, copy = drag.kind === 'copy', erasing = drag.erase;   // red = erase, amber = copy-to-stamp, blue = paint rect
      g.fillStyle = erasing ? 'rgba(255,122,106,.22)' : copy ? 'rgba(242,193,78,.18)' : 'rgba(78,161,255,.25)';
      g.strokeStyle = erasing ? '#ff7a6a' : copy ? '#f2c14e' : '#4ea1ff'; g.lineWidth = 1;
      var rx = vx + Math.min(a.x, b.x) * s, ry = vy + Math.min(a.y, b.y) * s;
      var rw = (Math.abs(a.x - b.x) + 1) * s, rh = (Math.abs(a.y - b.y) + 1) * s;
      g.fillRect(rx, ry, rw, rh); g.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
    } else if (E.stamp && E.layer === 'terrain' && E.hover && E.inside(E.hover.x, E.hover.y)) {
      g.strokeStyle = '#f2c14e'; g.lineWidth = 1;                       // paste footprint of the clipboard
      g.strokeRect(vx + E.hover.x * s + .5, vy + E.hover.y * s + .5, E.stamp.w * s - 1, E.stamp.h * s - 1);
    } else if (E.hover && E.inside(E.hover.x, E.hover.y)) {
      g.strokeStyle = E.mode ? '#f2c14e' : 'rgba(255,255,255,.8)'; g.lineWidth = 1;
      g.strokeRect(vx + E.hover.x * s + .5, vy + E.hover.y * s + .5, s - 1, s - 1);
      if (!E.mode && (E.tool === 'brush' || E.tool === 'rect')) {     // ghost of what will be painted
        g.globalAlpha = .5;
        if (E.layer === 'objects' && E.paletteTab === 'monsters' && E.brush.monster) {
          var bm = c.monsters[E.brush.monster], bmi = bm && Assets.get(bm.sprite);
          if (bmi) g.drawImage(bmi, vx + E.hover.x * s, vy + E.hover.y * s, s, s);
        } else if (E.layer === 'objects' && E.brush.object) {
          var bo = c.objects[E.brush.object], bi = bo && Assets.get(bo.sprite);
          if (bi) g.drawImage(bi, vx + E.hover.x * s, vy + E.hover.y * s, s, s);
        } else if (E.layer === 'terrain') {
          var tt = c.terrain[E.brush.terrain], gx = vx + E.hover.x * s, gy = vy + E.hover.y * s, gts, gimg;
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

  // ------------------------------------------------------------ input
  function cellAt(ev) {
    var r = canvas.getBoundingClientRect(), s = cellSize();
    return { x: Math.floor((ev.clientX - r.left - E.view.x) / s), y: Math.floor((ev.clientY - r.top - E.view.y) / s) };
  }

  E.setTool = function (t) {
    E.tool = t;
    // Erase stays on the active layer. On terrain the base can't be erased (every cell needs a tile), so
    // point it at the overlay; objects erase removes entities. (No more jumping to the Objects layer.)
    if (t === 'erase' && E.layer === 'terrain' && E.terrainLayer !== 'overlay') E.terrainLayer = 'overlay';
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

    if (E.tool === 'select') {
      var e = E.inside(cell.x, cell.y) && E.entityAt(cell.x, cell.y);
      E.selected = e ? e.key : null;
      Panels.inspector(cell);
      if (e) drag = { kind: 'move', key: e.key, from: cell, moved: false };
      E.redraw(); return;
    }
    if (E.tool === 'pick') { eyedrop(cell.x, cell.y); return; }
    if (E.layer === 'objects' && E.tool !== 'erase' && !(E.paletteTab === 'monsters' ? E.brush.monster : E.brush.object)) {
      Panels.status('pick ' + (E.paletteTab === 'monsters' ? 'a monster' : 'an object') + ' in the palette first', true); return;
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
    if (!drag) return;
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
      if (e && E.inside(cell.x, cell.y) && !E.entityAt(cell.x, cell.y)) {
        if (!drag.moved) { E.checkpoint(); drag.moved = true; }
        e.x = cell.x; e.y = cell.y; E.markDirty('map'); Panels.inspector();
      }
    }
  });

  function endDrag() {
    if (!drag) return;
    if (drag.kind === 'copy') { copyRegion(drag.start, drag.end, drag.freeze); }   // captures into E.stamp; no map change
    else if (drag.kind === 'rect') {
      if (rect(drag.start, drag.end, drag.erase ? eraseAt : paint)) E.markDirty('map'); else E.undo.pop();
    } else if ((drag.kind === 'paint' || drag.kind === 'stamp') && !drag.changed) E.undo.pop();
    drag = null; canvas.style.cursor = ''; E.redraw();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function () { E.hover = null; E.redraw(); });

  canvas.addEventListener('wheel', function (ev) {
    ev.preventDefault();
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
    if (KEYS[k]) { E.setTool(KEYS[k]); return; }
    if (k === 'g') { E.show.grid = !E.show.grid; Panels.toolbar(); E.redraw(); return; }
    if (k === '1') { E.setPaletteTab('terrain'); Panels.all(); E.redraw(); return; }
    if (k === '2') { E.setPaletteTab(E.paletteTab === 'monsters' ? 'monsters' : 'objects'); Panels.all(); E.redraw(); return; }
    if (k === '3') { E.setPaletteTab('monsters'); Panels.all(); E.redraw(); return; }
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
    E.base = res.source === 'server' ? Store.baseOf(res.tables) : null;   // what the sheet looked like when loaded
    // Restore unsaved work-in-progress (autosaved locally in online mode) so switching tools or restarting
    // the app doesn't lose edits. Only when loaded from the server — offline keeps its own draft.
    if (res.source === 'server') {
      var wip = Store.loadWip();
      if (wip && wip.tables) {
        var unchanged = JSON.stringify(wip.base) === JSON.stringify(E.base);   // server same as when editing began
        var keep = unchanged || confirm('You have unsaved editor changes from before, but the published game data has changed since.\n\n' +
          'OK: keep your unsaved changes (Save may then report a conflict to resolve).\nCancel: discard them and open the latest data.');
        if (keep) { E.tables = wip.tables; E.base = wip.base || E.base; E.dirty = wip.dirty || { maps: {}, tabs: {}, deleted: [] }; E.source = 'wip'; }
        else { Store.clearWip(); }
      }
    }
    E.content = Content.build(E.tables);
    var first = Object.keys(E.content.objects).filter(function (k) { return E.content.objects[k].kind !== 'spawn'; })[0];
    E.brush.object = first || null;
    E.brush.monster = Object.keys(E.content.monsters)[0] || null;
    if (!E.content.terrain[E.brush.terrain]) E.brush.terrain = Object.keys(E.content.terrain)[0];
    // open right away; repaint as images arrive instead of waiting for slow image hosts
    E.loadArt().then(function () { E.groundDirty = true; E.redraw(); Panels.palette(); Panels.inspector(); });
  }).then(function () {
    var want = new URLSearchParams(location.search).get('map');
    E.mapId = E.content.maps[want] ? want : Object.keys(E.content.maps)[0];
    Panels.all(); E.openMap(E.mapId);
    Panels.status(E.source === 'draft' ? 'opened your draft from this browser' :
      E.source === 'wip' ? 'restored your unsaved changes (not yet published)' :
      E.source === 'server' ? 'opened Game Data from the server' : 'opened the repository data (offline)');
  }).catch(function (e) { Panels.status('could not load: ' + e.message, true); console.error(e); });
})();
