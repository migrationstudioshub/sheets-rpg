/**
 * Where the editor reads and writes Game Data.
 *   Online (API_URL set): loads the live tabs from the server; Save writes maps and
 *     definitions straight into the Game Data spreadsheet (needs the editor key).
 *   Offline: loads data/tables.json; Save keeps a draft in this browser, which the
 *     game's offline mode plays automatically. Export downloads tables.json.
 */
var Store = (function () {
  var DRAFT_KEY = 'sheetsrpg.editorDraft', EDITOR_KEY = 'sheetsrpg.editorKey';
  var WIP_KEY = 'sheetsrpg.editorWip';   // unsaved edits (online mode), so switching tools doesn't lose work

  function online() { return !!(GAME_CONFIG.FUNCTIONS_URL || GAME_CONFIG.API_URL); }

  function load() {
    if (GAME_CONFIG.FUNCTIONS_URL) return loadFromFunction(GAME_CONFIG.FUNCTIONS_URL);
    if (online()) {
      return fetch(GAME_CONFIG.API_URL + '?action=tables').then(function (r) { return r.json(); })
        .then(function (res) { if (res.error) throw new Error(res.error); return { tables: res.tables, source: 'server' }; });
    }
    var draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) {}
    return fetch(GAME_CONFIG.OFFLINE_TABLES, { cache: 'no-cache' }).then(function (r) { return r.json(); })
      .then(function (repo) {
        if (!draft) return { tables: repo, source: 'repository' };
        if (draft._version === repo._version) return { tables: draft, source: 'draft' };
        // the draft was made from older data: let the person choose
        if (confirm('Your saved draft was made from an older version of the game data, so it is missing newer ' +
          'maps, monsters and settings.\n\nOK: discard the draft and open the latest data.\n' +
          'Cancel: keep editing your draft (new tabs such as Items and Monsters are added to it).')) {
          localStorage.removeItem(DRAFT_KEY);
          return { tables: repo, source: 'repository' };
        }
        Object.keys(repo).forEach(function (tab) { if (!(tab in draft)) draft[tab] = repo[tab]; });
        draft._version = repo._version;
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        return { tables: draft, source: 'draft' };
      });
  }

  // Resolves to the editor key (from storage, or a masked prompt). Async so it works in the desktop
  // app, where the native window.prompt() is unsupported. Resolves to null if the person cancels.
  function key() {
    var k = localStorage.getItem(EDITOR_KEY);
    if (k) return Promise.resolve(k);
    return Dialogs.prompt('Editor key (the EDITOR_KEY secret set on the function):', '', { password: true })
      .then(function (v) { v = v && v.trim(); if (v) localStorage.setItem(EDITOR_KEY, v); return v || null; });
  }

  function call(body) {
    return fetch(GAME_CONFIG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) {
          if (/editor key/i.test(res.error)) localStorage.removeItem(EDITOR_KEY);
          var e = new Error(res.error); e.conflict = !!res.conflict; throw e;
        }
        return res;
      });
  }

  /**
   * changes = { maps: {id: {map row, entities rows}} , deletedMaps: [ids], tabs: {TabName: rows} }
   * tables = the whole edited data (used for the offline draft).
   */
  /** Fingerprints of what was loaded from the server, so saves never silently overwrite edits made in the sheet. */
  function baseOf(tables) {
    var b = { tabs: {}, maps: {} };
    Object.keys(tables).forEach(function (t) { if (Array.isArray(tables[t])) b.tabs[t] = Content.hash(tables[t]); });
    (tables.Maps || []).forEach(function (r) { b.maps[String(r.id)] = Content.mapHash(tables, String(r.id)); });
    return b;
  }

  function save(changes, tables, base) {
    if (!online()) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(tables));
      return Promise.resolve({ where: 'draft' });
    }
    if (GAME_CONFIG.FUNCTIONS_URL) return saveToFunction(GAME_CONFIG.FUNCTIONS_URL, changes, tables);
    return key().then(function (k) {
      if (!k) throw new Error('no editor key');
      base = base || { tabs: {}, maps: {} };
      var jobs = [];
      Object.keys(changes.tabs).forEach(function (tab) {
        jobs.push({ body: { action: 'saveTab', key: k, tab: tab, rows: changes.tabs[tab], base: base.tabs[tab] },
          what: 'the ' + tab + ' tab', done: function (r) { base.tabs[tab] = r.hash; } });
      });
      Object.keys(changes.maps).forEach(function (id) {
        jobs.push({ body: { action: 'saveMap', key: k, map: changes.maps[id].row, entities: changes.maps[id].entities, base: base.maps[id] },
          what: 'map "' + changes.maps[id].row.name + '"', done: function (r) { base.maps[id] = r.hash; } });
      });
      changes.deletedMaps.forEach(function (id) {
        jobs.push({ body: { action: 'deleteMap', key: k, id: id }, what: 'map ' + id, done: function () { delete base.maps[id]; } });
      });
      function run(job) {
        return call(job.body).catch(function (e) {
          if (!e.conflict) throw e;
          var ok = confirm(e.message + '\n\nOK: overwrite it with the editor\'s version (the spreadsheet changes to ' + job.what +
            ' are lost; File > Version history in Sheets can still bring them back).\n' +
            'Cancel: don\'t save ' + job.what + ' now. Reload the editor to get the latest version, then redo your change.');
          if (!ok) { var stop = new Error(job.what + ' not saved: it changed in the spreadsheet. Reload the editor.'); stop.stopped = true; throw stop; }
          return call(Object.assign({}, job.body, { force: true }));
        }).then(function (r) { job.done(r); return r; });
      }
      return jobs.reduce(function (p, job) { return p.then(function () { return run(job); }); }, Promise.resolve())
        .then(function () { return { where: 'server' }; });
    });
  }

  function discardDraft() { localStorage.removeItem(DRAFT_KEY); }
  function hasDraft() { return !!localStorage.getItem(DRAFT_KEY); }

  // ---- work-in-progress autosave (online mode) ----
  // In online mode, edits normally live only in memory until Publish, so leaving the editor loses them.
  // We autosave the whole working set (tables + the base fingerprint it was loaded against + which
  // items are dirty) locally, and restore it when the editor reopens. Cleared on a successful save.
  function saveWip(tables, base, dirty) {
    try { localStorage.setItem(WIP_KEY, JSON.stringify({ tables: tables, base: base, dirty: dirty, ts: Date.now() })); return true; }
    catch (e) { return false; }   // quota or serialization issue: just skip this autosave
  }
  function loadWip() { try { return JSON.parse(localStorage.getItem(WIP_KEY)); } catch (e) { return null; } }
  function clearWip() { localStorage.removeItem(WIP_KEY); }

  function exportFile(tables) {
    var blob = new Blob([JSON.stringify(tables, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'tables.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---- Firestore via the Cloud Function (the migrated path) ----
  // Content (definitions) comes from the function's records; maps come from their own Firestore docs
  // (maps/<id>, terrain compact-encoded) and overlay the blob maps.
  function loadFromFunction(FUN) {
    return Promise.all([
      fetch(FUN + '?action=records').then(function (r) { return r.json(); }),
      fetch(FUN + '?action=maps').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var rec = res[0], mp = res[1];
      if (rec.error) throw new Error(rec.error);
      var tables = rec.tables || {};
      var docs = (mp && mp.maps) || [];
      if (docs.length) {
        var ids = {}; docs.forEach(function (m) { ids[m.id] = 1; });
        tables.Maps = (tables.Maps || []).filter(function (r) { return !ids[r.id]; });
        tables.MapEntities = (tables.MapEntities || []).filter(function (r) { return !ids[r.map]; });
        docs.forEach(function (m) {
          tables.Maps.push({ id: m.id, name: m.name, width: m.width, height: m.height, terrain: JSON.stringify(m.terrain),
            // carry the overlay layer + frozen shapes back, or the whole overlay is lost on reload
            overlay: m.overlay == null ? '' : JSON.stringify(m.overlay),
            shapes: m.shapes == null ? '' : JSON.stringify(m.shapes),
            overlayShapes: m.overlayShapes == null ? '' : JSON.stringify(m.overlayShapes), notes: '' });
          (m.entities || []).forEach(function (e) {
            tables.MapEntities.push({ map: m.id, key: e.key, x: e.x, y: e.y, ref: e.ref,
              data: e.data == null ? '' : (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) });
          });
        });
      }
      return { tables: tables, source: 'server' };
    });
  }
  function callFun(FUN, body) {
    return fetch(FUN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) { if (/editor key/i.test(res.error)) localStorage.removeItem(EDITOR_KEY); throw new Error(res.error); } return res; });
  }
  // A terrain grid (JSON string or array) → compact MapCode, or null when empty/absent (overlay-free maps).
  function encodeGrid(v) {
    if (v == null || v === '') return null;
    var grid = typeof v === 'string' ? JSON.parse(v) : v;
    if (typeof MapCode === 'undefined') return grid;
    if (MapCode.isEncoded(grid)) return grid;
    if (!Array.isArray(grid) || !grid.length) return null;
    return MapCode.encode(grid);
  }
  function saveToFunction(FUN, changes, tables) {
    return key().then(function (k) {
      if (!k) throw new Error('no editor key');
      var jobs = [];
      Object.keys(changes.maps).forEach(function (id) {
        var mc = changes.maps[id];                            // { row:{...,terrain: JSON string of the grid}, entities }
        var parseObj = function (v) { return v == null || v === '' ? null : (typeof v === 'string' ? JSON.parse(v) : v); };
        jobs.push({ action: 'publishMap', key: k, map: {
          id: mc.row.id, name: mc.row.name, width: mc.row.width, height: mc.row.height,
          terrain: encodeGrid(mc.row.terrain), overlay: encodeGrid(mc.row.overlay),
          shapes: parseObj(mc.row.shapes), overlayShapes: parseObj(mc.row.overlayShapes),
          entities: (mc.entities || []).map(function (e) { return { key: e.key, x: e.x, y: e.y, ref: e.ref, data: e.data }; }) } });
      });
      changes.deletedMaps.forEach(function (id) { jobs.push({ action: 'deleteMap', key: k, id: id }); });
      if (Object.keys(changes.tabs).length) {                // a definition tab changed → re-publish the content blob
        // Publish the whole tables (maps included) so no map is lost during the transition; the per-map
        // Firestore docs still override the blob, so edited big maps stay authoritative.
        jobs.push({ action: 'publish', key: k, tables: tables });
      }
      return jobs.reduce(function (p, body) { return p.then(function () { return callFun(FUN, body); }); }, Promise.resolve())
        .then(function () { return { where: 'server' }; });
    });
  }

  return { load: load, save: save, baseOf: baseOf, online: online, discardDraft: discardDraft, hasDraft: hasDraft,
    exportFile: exportFile, DRAFT_KEY: DRAFT_KEY,
    saveWip: saveWip, loadWip: loadWip, clearWip: clearWip };
})();
