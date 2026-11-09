/**
 * Where the editor reads and writes Game Data.
 *   Online (API_URL set): loads the live tabs from the server; Save writes maps and
 *     definitions straight into the Game Data spreadsheet (needs the editor key).
 *   Offline: loads data/tables.json; Save keeps a draft in this browser, which the
 *     game's offline mode plays automatically. Export downloads tables.json.
 */
var Store = (function () {
  var DRAFT_KEY = 'sheetsrpg.editorDraft', EDITOR_KEY = 'sheetsrpg.editorKey';

  function online() { return !!GAME_CONFIG.API_URL; }

  function load() {
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

  function key() {
    var k = localStorage.getItem(EDITOR_KEY);
    if (!k) {
      k = prompt('Editor key (the EDITOR_KEY script property on the server):');
      if (k) localStorage.setItem(EDITOR_KEY, k);
    }
    return k;
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
    var k = key();
    if (!k) return Promise.reject(new Error('no editor key'));
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
  }

  function discardDraft() { localStorage.removeItem(DRAFT_KEY); }
  function hasDraft() { return !!localStorage.getItem(DRAFT_KEY); }

  function exportFile(tables) {
    var blob = new Blob([JSON.stringify(tables, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'tables.json';
    document.body.appendChild(a); a.click(); a.remove();
  }

  return { load: load, save: save, baseOf: baseOf, online: online, discardDraft: discardDraft, hasDraft: hasDraft,
    exportFile: exportFile, DRAFT_KEY: DRAFT_KEY };
})();
