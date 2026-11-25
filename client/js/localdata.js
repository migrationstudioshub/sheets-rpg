/**
 * The game kept as files in the project (local mode, Nov 2026: the owner works locally; nothing is published).
 *
 *   data/game/tables.json        every definition tab (Items, Quests, Config…), one row per line; no maps
 *   data/game/maps/index.json    the map ids, in order
 *   data/game/maps/<id>.json     one map: its row + its entities, terrain packed by shared/mapcode.js
 *                                (the same "map document" the Cloud Function keeps in Firestore maps/<id>)
 *
 * The tools still work on one `tables` object ({Items: [rows], Maps: [rows], MapEntities: [rows], …}):
 * `assemble` builds it from the files, `docOf` / `split` turn it back into files. data/tables.json is left alone:
 * it is the tests' fixed sample world (and the fallback when there is no data/game yet).
 *
 * Reading needs only static files (it works on GitHub Pages too). Writing needs the project's local server
 * (tools/asset_server.py, or desktop/server.js in the desktop app): `probe()` asks it, and only then are the
 * Content Studio and the map editor in local mode. The server writes only inside data/game/.
 * Classic script, global `LocalData`; Node scripts require it (tools/pull_live.js, desktop/server.js).
 */
var LocalData = (function () {
  var BASE = '../data/game/';          // the pages that use this live one folder down (client/, content/, editor/)
  var MAP_TABS = { Maps: 1, MapEntities: 1 };
  var GRIDS = ['terrain', 'overlay', 'vWalls', 'hWalls', 'roof', 'nobuild', 'elev', 'falls'];

  function MC() { return typeof MapCode !== 'undefined' ? MapCode : (typeof require === 'function' ? require('../../shared/mapcode.js') : null); }
  function parse(v) { if (v == null || v === '') return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return null; } }
  // A grid (JSON string or array) → packed, or null when empty/absent.
  function pack(v) {
    var grid = parse(v), mc = MC();
    if (grid == null) return null;
    if (mc && mc.isEncoded(grid)) return grid;
    if (!Array.isArray(grid) || !grid.length) return null;
    return mc ? mc.encode(grid) : grid;
  }

  /** One map's row + its entity rows (tables form) → a map document (file form). */
  function docOf(row, entities) {
    var d = { id: String(row.id), name: String(row.name || row.id), width: Number(row.width) || 0, height: Number(row.height) || 0 };
    GRIDS.forEach(function (k) { d[k] = pack(row[k]); });
    d.roof_color = row.roof_color || '';
    d.spawn = parse(row.spawn);
    d.shapes = parse(row.shapes); d.overlayShapes = parse(row.overlayShapes);
    d.floor_of = row.floor_of ? String(row.floor_of) : ''; d.z = Number(row.z) || 0;
    if (row.notes) d.notes = String(row.notes);
    d.entities = (entities || []).map(function (e) {
      return { key: e.key, x: e.x, y: e.y, ref: e.ref, data: e.data == null || e.data === '' ? '' : (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) };
    });
    return d;
  }
  /** A map document → its row + entity rows (what loadFromFunction in editor/js/store.js has always made). */
  function rowsOf(m) {
    function str(v) { return v == null || v === '' ? '' : JSON.stringify(v); }
    var row = { id: m.id, name: m.name, width: m.width, height: m.height, terrain: str(m.terrain) };
    GRIDS.slice(1).forEach(function (k) { row[k] = str(m[k]); });
    row.roof_color = m.roof_color || ''; row.spawn = str(m.spawn);
    row.shapes = str(m.shapes); row.overlayShapes = str(m.overlayShapes);
    row.floor_of = m.floor_of || ''; row.z = Number(m.z) || 0; row.notes = m.notes || '';
    var ents = (m.entities || []).map(function (e) {
      return { map: m.id, key: e.key, x: e.x, y: e.y, ref: e.ref, data: e.data == null ? '' : (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) };
    });
    return { row: row, entities: ents };
  }
  /** Definition tabs + map documents → one tables object. */
  function assemble(defs, docs) {
    var t = {};
    Object.keys(defs || {}).forEach(function (k) { if (!MAP_TABS[k]) t[k] = defs[k]; });
    t.Maps = []; t.MapEntities = [];
    (docs || []).forEach(function (m) { var r = rowsOf(m); t.Maps.push(r.row); t.MapEntities = t.MapEntities.concat(r.entities); });
    return t;
  }
  /** One tables object → {defs, docs} (what the files hold). */
  function split(tables) {
    var defs = {}, docs = [];
    Object.keys(tables || {}).forEach(function (k) { if (!MAP_TABS[k]) defs[k] = tables[k]; });
    var ents = {};
    (tables.MapEntities || []).forEach(function (e) { (ents[String(e.map)] = ents[String(e.map)] || []).push(e); });
    (tables.Maps || []).forEach(function (r) { if (r && r.id) docs.push(docOf(r, ents[String(r.id)])); });
    return { defs: defs, docs: docs };
  }
  /** Only the definition tabs whose rows differ from `before` (both tables objects). */
  function changedTabs(tables, before) {
    var out = {};
    Object.keys(tables || {}).forEach(function (k) {
      if (MAP_TABS[k]) return;
      if (JSON.stringify(tables[k]) !== JSON.stringify((before || {})[k])) out[k] = tables[k];
    });
    return out;
  }

  // ---- how the files are written (the servers use the same layout: tools/asset_server.py, desktop/server.js) ----
  // One tab row / one entity per line, so Git shows a change as the lines that changed.
  function tablesText(defs) {
    return '{\n' + Object.keys(defs).map(function (k) {
      var v = defs[k];
      if (!Array.isArray(v)) return JSON.stringify(k) + ': ' + JSON.stringify(v);
      return JSON.stringify(k) + ': [' + (v.length ? '\n' + v.map(function (r) { return '  ' + JSON.stringify(r); }).join(',\n') + '\n' : '') + ']';
    }).join(',\n') + '\n}\n';
  }
  function mapText(doc) {
    return '{\n' + Object.keys(doc).map(function (k) {
      var v = doc[k];
      if (k === 'entities' && Array.isArray(v)) return '"entities": [' + (v.length ? '\n' + v.map(function (e) { return '  ' + JSON.stringify(e); }).join(',\n') + '\n' : '') + ']';
      return JSON.stringify(k) + ': ' + JSON.stringify(v);
    }).join(',\n') + '\n}\n';
  }

  // ---- in the browser ----
  function getJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); });
  }
  function post(path, body) {
    return fetch('../data/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { error: 'the local server answered ' + r.status }; }); })
      .then(function (res) { if (!res || res.error) throw new Error((res && res.error) || 'no answer'); return res; });
  }
  var probed = null;
  /** Resolves to {local: true, game: bool} when the project's local server can write files, else {local: false}. */
  function probe() {
    if (!probed) probed = fetch('../data/ping', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && j.local ? { local: true, game: !!j.game } : { local: false }; })
      .catch(function () { return { local: false }; });
    return probed;
  }
  /** The game from data/game/ as one tables object, or null when the project has none yet. */
  function load() {
    return fetch(BASE + 'tables.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) return null;
      return r.json().then(function (defs) {
        return getJson(BASE + 'maps/index.json').catch(function () { return { maps: [] }; }).then(function (ix) {
          var ids = (ix && ix.maps) || [];
          return Promise.all(ids.map(function (id) { return getJson(BASE + 'maps/' + id + '.json'); }))
            .then(function (docs) { return assemble(defs, docs); });
        });
      });
    }).catch(function () { return null; });
  }
  function saveTabs(tabs) { return Object.keys(tabs || {}).length ? post('save-tabs', { tabs: tabs }) : Promise.resolve({ ok: true }); }
  function saveMap(doc) { return post('save-map', { map: doc }); }
  function deleteMap(id) { return post('delete-map', { id: id }); }
  /** Write the whole game (the first save into a project with no data/game yet). */
  function saveAll(tables) {
    var s = split(tables);
    return post('save-tabs', { tabs: s.defs, all: true }).then(function () {
      return s.docs.reduce(function (p, d) { return p.then(function () { return saveMap(d); }); }, Promise.resolve());
    });
  }

  return { BASE: BASE, docOf: docOf, rowsOf: rowsOf, assemble: assemble, split: split, changedTabs: changedTabs,
    tablesText: tablesText, mapText: mapText, probe: probe, load: load, saveTabs: saveTabs, saveMap: saveMap,
    deleteMap: deleteMap, saveAll: saveAll };
})();
if (typeof module !== 'undefined') module.exports = LocalData;
