/**
 * Content Studio: a schema-driven editor for all game content (items, classes, skills, monsters,
 * statuses, loot, config, terrain, objects, tilesets, levels). It reads the current content from the
 * Cloud Function, edits a LOCAL draft, Play-tests it offline, and Publishes to Firestore.
 * Local mode (the project's own server is there: the desktop app, tools/asset_server.py): it edits the project
 * files in data/game/ instead, saving each change as it is made; no draft, no publishing (client/js/localdata.js).
 *
 * Every form is generated from shared/schema.js — add a field there and it shows up here. `T` is the
 * working tables object ({ Items:[rows], ... }); records are just row objects, keyed by their id field
 * where they have one. Classic script, global `CStudio`.
 */
var CStudio = (function () {
  var KEY_LS = 'sheetsrpg.editorKey';
  var FUN = (typeof GAME_CONFIG !== 'undefined' && GAME_CONFIG.FUNCTIONS_URL) || '';
  var T = {};            // working tables (the draft)
  var type = null;       // current content type
  var curIndex = -1;     // index into T[tab] of the record being edited
  var curLoot = null;    // selected loot-table name (loot is edited grouped by table)
  var curKind = null;    // selected object-kind name (kinds are edited grouped by kind, not row-by-row)
  var filter = '';
  var VIEW_LS = 'sheetsrpg.studioView';   // which type + record was open, so a reload comes back to it
  var hasAssetServer = false;   // the local Asset Studio server (asset_server.py) is reachable → offer "Rescan art"
  // Local mode (the project's own server answers /data/ping): the game is the project files in data/game/, edits are
  // saved there as they are made, and nothing is published. savedT = the tabs as last written, to send only changes.
  var LOCAL = false, freshLocal = false, savedT = {}, saveTimer = null, saving = null, saveAgain = false, saveErr = null;

  function h(tag, props) {
    var el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'style') el.style.cssText = props[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), props[k]);
      else if (k === 'text') el.textContent = props[k];
      else if (k in el && k !== 'list') el[k] = props[k];
      else el.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]; if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x != null && x !== false) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    }
    return el;
  }
  function $(id) { return document.getElementById(id); }
  // 'npcs' is not a table of its own: it is the Objects table seen through its rows of kind npc (the NPCs panel).
  function tab(t) { return Schema.tabOf(t === 'npcs' ? 'objects' : t); }
  function rows(t) { return (T[tab(t)] = T[tab(t)] || []); }
  function idField(t) { return Schema.get(t === 'npcs' ? 'objects' : t).id; }
  function isNpc(r) { return !!r && String(r.kind) === 'npc'; }
  function rowLabel(t, r) {
    var idf = idField(t);
    if (idf && r[idf]) return String(r[idf]);
    if (r.name) return String(r.name);
    var k = Object.keys(r)[0];
    return k ? k + ': ' + r[k] : '(row)';
  }
  // Resolve a sprite path for display (the Studio lives in /content/, like /client/, one level deep).
  function spritePath(s) { return /^(https?:|data:)/.test(s) ? s : '../' + String(s).replace(/^\//, ''); }

  // ---------------------------------------------------------------- load / persist
  // A game published before Item Types existed has none stored: start from the built-in ones (what the rules
  // assume anyway), so they can be edited. Nothing is saved until the owner changes something.
  function typeRow(d) {
    var r = Schema.defaults('itemTypes');
    Object.keys(d).forEach(function (k) { r[k] = d[k]; });
    return r;
  }
  function seedItemTypes() {
    var ty = rows('itemTypes');
    if (!ty.length) Content.ITEM_TYPES.forEach(function (d) { ty.push(typeRow(d)); });
    var cfg = rows('config'), old = cfg.filter(function (c) { return c.key === 'item_types'; })[0];   // the short-lived Config list of names
    if (old) {
      String(old.value || '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (id) {
        if (!ty.some(function (t) { return t.id === id; })) ty.push(typeRow({ id: id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
      });
      cfg.splice(cfg.indexOf(old), 1);
    }
  }
  function itemTypeRow(id) { return rows('itemTypes').filter(function (t) { return t.id === id; })[0] || null; }
  function init() {
    renderTop('Loading…');
    loadManifest().then(function () { if (type === 'appearances') renderForm(); });   // paper-doll art list for the picker
    LocalData.probe().then(function (pr) {
      if (pr.local) return initLocal(pr);
      if (!FUN) { $('top').textContent = 'No FUNCTIONS_URL in client/js/config.js — cannot reach the content server.'; return; }
      var draft = ContentStore.getDraft();
      return (draft && Object.keys(draft).length
        ? Promise.resolve(draft)
        : ContentStore.loadRecords(FUN)
      ).then(function (tables) {
        start(tables);
        setStatus(draft ? 'Editing your local draft.' : 'Loaded live content.', draft ? 'dirty' : 'clean');
      });
    }).catch(function (e) { renderTop('Load failed'); setStatus('Could not load content: ' + e.message, 'bad'); });
  }
  function start(tables) {
    T = tables || {};
    Schema.list().forEach(function (t) { if (!Array.isArray(T[tab(t)])) T[tab(t)] = []; }); seedItemTypes();
    type = Schema.authored('studio')[0];
    restoreView();
    renderAll();
    var on = $('list').querySelector('.rec.on'); if (on) on.scrollIntoView({ block: 'center' });
    probeAssetServer();                                         // reveal "Rescan art" if the local art server is up
  }
  // Local mode: the game from data/game/ (or, in a project that has none yet, the sample data/tables.json, which the
  // first change writes out whole). A draft left in this browser from before (never published) is offered once.
  function initLocal(pr) {
    LOCAL = true;
    return LocalData.load().then(function (files) {
      if (files) return files;
      freshLocal = true;
      return fetch(GAME_CONFIG.OFFLINE_TABLES, { cache: 'no-cache' }).then(function (r) { return r.json(); });
    }).then(function (tables) {
      savedT = JSON.parse(JSON.stringify(tables));
      start(tables);
      setStatus(freshLocal ? 'Local project: no data/game yet — starting from the sample data; your first change saves it.' : 'Local project: editing the files in data/game/.', freshLocal ? 'dirty' : 'clean');
      offerOldDraft();
    });
  }
  function offerOldDraft() {
    var d = ContentStore.getDraft();
    if (!d || !Object.keys(d).length) return;
    var diff = LocalData.changedTabs(d, T), names = Object.keys(diff).filter(function (k) { return Array.isArray(diff[k]); });
    if (!names.length) { ContentStore.clearDraft(); return; }          // nothing in it that the files lack
    var lines = names.map(function (k) {
      var a = d[k] || [], b = T[k] || [], same = {};
      b.forEach(function (r) { same[JSON.stringify(r)] = 1; });
      return '  ' + k + ': ' + a.filter(function (r) { return !same[JSON.stringify(r)]; }).length + ' changed or new row(s)';
    });
    var ok = confirm('This app still holds Content Studio edits from before local mode, which were never published:\n\n' + lines.join('\n') +
      '\n\nOK: bring those tabs into the project files (each replaces the same tab in data/game/).\n' +
      'Cancel: leave the project files as they are (you will be asked again next time).');
    if (!ok) return;
    names.forEach(function (k) { T[k] = diff[k]; });
    seedItemTypes();
    flushFiles().then(function () { return saveFiles(); }).then(function () {
      if (!saveErr) { ContentStore.clearDraft(); setStatus('Brought your earlier edits into the project files ✓ (' + names.join(', ') + ')', 'clean'); }
    });
    renderAll();
  }
  // Remember the open type + record (called whenever the form is drawn). Records are remembered by id
  // where the type has one, so the right one comes back even if rows were added or removed meanwhile.
  function rememberView() {
    if (!type) return;
    var idf = idField(type), r = curIndex >= 0 ? rows(type)[curIndex] : null;
    try {
      localStorage.setItem(VIEW_LS, JSON.stringify({ type: type, index: curIndex, id: r && idf && r[idf] != null ? String(r[idf]) : null, loot: curLoot, kind: curKind }));
    } catch (e) {}
  }
  function restoreView() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(VIEW_LS)); } catch (e) {}
    if (!v || (Schema.authored('studio').indexOf(v.type) < 0 && v.type !== 'npcs')) return;
    type = v.type;
    if (type === 'loot') { curLoot = lootTableNames().indexOf(v.loot) >= 0 ? v.loot : null; return; }
    if (type === 'kinds') { curKind = allKindNames().indexOf(v.kind) >= 0 ? v.kind : null; return; }
    var all = rows(type), idf = idField(type), i = -1;
    if (v.id != null && idf) all.forEach(function (r, n) { if (i < 0 && String(r[idf]) === v.id) i = n; });
    else if (v.index >= 0 && v.index < all.length) i = v.index;
    curIndex = i;
  }
  function persist() { keep(); questMapSoon(); }   // (an edit may change a link: the questline map follows)
  // Keep the edits: in local mode written into the project files (data/game/, client/js/localdata.js) a moment
  // after the last change, only the tabs that changed; otherwise the browser draft, as before.
  function keep() {
    if (!LOCAL) { ContentStore.setDraft(T); setStatus('Draft saved in this browser (unpublished).', 'dirty'); return; }
    setStatus('Saving…', 'dirty');
    clearTimeout(saveTimer); saveTimer = setTimeout(saveFiles, 400);
  }
  // One save at a time: a change made while one is being written is picked up by the next (what still differs).
  function saveFiles() {
    clearTimeout(saveTimer); saveTimer = null;
    if (saving) { saveAgain = true; return saving; }
    var tabs = LocalData.changedTabs(T, savedT), names = Object.keys(tabs);
    if (!names.length && !freshLocal) { setStatus('Saved in the project files ✓', 'clean'); return Promise.resolve(); }
    var snap = JSON.parse(JSON.stringify(freshLocal ? T : tabs));
    saving = (freshLocal ? LocalData.saveAll(T) : LocalData.saveTabs(tabs)).then(function () {
      if (freshLocal) { savedT = snap; freshLocal = false; } else names.forEach(function (k) { savedT[k] = snap[k]; });
      saveErr = null;
      setStatus('Saved in the project files ✓ (' + (names.length ? names.join(', ') : 'everything') + ')', 'clean');
    }, function (e) {
      saveErr = e;
      setStatus('Could not save to the project files: ' + e.message, 'bad');
    }).then(function () {
      saving = null;
      if (saveAgain) { saveAgain = false; return saveFiles(); }
    });
    return saving;
  }
  /** Before Play-test or a reload: anything still waiting is written now. */
  function flushFiles() { return !LOCAL ? Promise.resolve() : saveTimer ? saveFiles() : (saving || Promise.resolve()); }
  document.addEventListener('click', function () { if (typeof closePickers === 'function') closePickers(); });   // close any open visual dropdown

  // ---------------------------------------------------------------- top bar
  function renderTop(msg) {
    var top = $('top'); top.innerHTML = '';
    top.appendChild(h('span', { className: 'title', text: 'Content Studio' }));
    top.appendChild(h('span', { id: 'status', className: 'status note', text: msg || '' }));
    top.appendChild(h('span', { className: 'sp' }));
    if (hasAssetServer) top.appendChild(h('button', { className: 'ghost', title: 'Rescan the art/ folder and rebuild the picker list (local app only)', text: '↻ Rescan art', onclick: rescanArt }));
    if (LOCAL) {                                              // local mode: saved as you go, nothing to publish
      top.appendChild(h('button', { className: 'ghost', title: 'Play the project files offline', text: '▶ Play-test', onclick: playtest }));
      top.appendChild(h('button', { title: 'Read data/game/ again (after a git pull, or a change made in the map editor)', text: '↻ Reload files', onclick: reloadFiles }));
      return;
    }
    top.appendChild(h('button', { className: 'ghost', title: 'Play-test offline against this draft', text: '▶ Play-test', onclick: playtest }));
    top.appendChild(h('button', { className: 'ghost', title: 'Download the draft as JSON (for a repo snapshot)', text: 'Export', onclick: function () { ContentStore.exportFile(T, 'content.json'); } }));
    top.appendChild(h('button', { title: 'Reload live content, discarding the local draft', text: 'Discard draft', onclick: discard }));
    top.appendChild(h('button', { className: 'primary', title: 'Publish the draft to the live game', text: 'Publish', onclick: publish }));
  }
  function setStatus(msg, cls) { var s = $('status'); if (s) { s.textContent = msg || ''; s.className = 'status note ' + (cls || ''); } }

  function playtest() {
    if (LOCAL) { flushFiles().then(function () { window.open('../client/?offline', '_blank'); }); return; }   // the game reads the files
    ContentStore.setDraft(T);                                   // make sure the latest edits are in the draft
    window.open('../client/?offline', '_blank');
  }
  function reloadFiles() {
    flushFiles().then(function () { return LocalData.load(); }).then(function (files) {
      if (!files) { setStatus('There is no data/game/ to read yet.', 'bad'); return; }
      savedT = JSON.parse(JSON.stringify(files)); freshLocal = false;
      var keepType = type; T = files;
      Schema.list().forEach(function (t) { if (!Array.isArray(T[tab(t)])) T[tab(t)] = []; }); seedItemTypes();
      type = keepType; restoreView(); renderAll();
      setStatus('Read the project files again ✓', 'clean');
    });
  }
  // The Asset Studio server (asset_server.py, behind the desktop app) can rescan art/ and rebuild the
  // manifest. GitHub Pages has no such server, so only show the button when it answers.
  function probeAssetServer() {
    fetch('/gear/ping', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.ok) { hasAssetServer = true; renderTop(); } })
      .catch(function () { /* no local server (e.g. on Pages): leave the button hidden */ });
  }
  function rescanArt() {
    setStatus('Rescanning art…', 'dirty');
    fetch('/art/rebuild-manifest', { method: 'POST' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('the art server returned ' + r.status)); })
      .then(function (res) { return loadManifest().then(function () { return res; }); })
      .then(function (res) { renderList(); renderForm(); setStatus('Art list rebuilt ✓ (' + (res.count != null ? res.count : '?') + ' images).', 'clean'); })
      .catch(function (e) { setStatus('Rescan failed: ' + e.message, 'bad'); });
  }
  function discard() {
    if (!confirm('Discard your local draft and reload the live content?')) return;
    ContentStore.clearDraft();
    ContentStore.loadRecords(FUN).then(function (tables) {
      T = tables || {}; Schema.list().forEach(function (t) { if (!Array.isArray(T[tab(t)])) T[tab(t)] = []; }); seedItemTypes();
      curIndex = -1; renderAll(); setStatus('Loaded live content.', 'clean');
    });
  }
  // A masked key prompt (the native prompt() shows the key in plain text). Resolves to the key or null.
  function promptKey() {
    return new Promise(function (resolve) {
      var done = false;
      function close(val) { if (done) return; done = true; document.body.removeChild(bg); resolve(val); }
      var input = h('input', { type: 'password', autocomplete: 'off', value: localStorage.getItem(KEY_LS) || '', placeholder: 'Editor key' });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') close(input.value.trim() || null); if (e.key === 'Escape') close(null); });
      var modal = h('div', { className: 'modal' },
        h('div', { className: 'note', style: 'margin-bottom:8px', text: 'Editor key (the EDITOR_KEY set on the function). It stays in this browser.' }),
        input,
        h('div', { className: 'buttons' },
          h('button', { text: 'Cancel', onclick: function () { close(null); } }),
          h('button', { className: 'primary', text: 'Publish', onclick: function () { close(input.value.trim() || null); } })));
      var bg = h('div', { className: 'modal-bg', onclick: function (e) { if (e.target === bg) close(null); } }, modal);
      document.body.appendChild(bg); input.focus(); input.select();
    });
  }
  function publish() {
    promptKey().then(function (key) {
      if (!key) return;
      localStorage.setItem(KEY_LS, key);
      setStatus('Publishing…', 'dirty');
      return ContentStore.publish(FUN, key, T).then(function (res) {
        setStatus('Published ✓ (version ' + res.version + ', ' + res.tabs + ' tabs). Live within ~30 min, or reload to force.', 'clean');
      }).catch(function (e) {
        if (/editor key/i.test(e.message)) localStorage.removeItem(KEY_LS);
        setStatus('Publish failed: ' + e.message, 'bad');
      });
    });
  }

  // ---------------------------------------------------------------- nav + list
  function renderAll() { renderTop(); renderNav(); renderList(); renderForm(); }
  function renderNav() {
    var nav = $('nav'); nav.innerHTML = '';
    var all = Schema.authored('studio'), placed = {};   // (the menu)
    var groups = NAV_GROUPS.map(function (g) { return [g[0], g[1].filter(function (t) { placed[t] = 1; return t === 'npcs' || all.indexOf(t) >= 0; })]; });
    groups.push(['Other', all.filter(function (t) { return !placed[t]; })]);          // a new type nobody filed yet still shows
    groups.forEach(function (g) {
      if (g[1].length) nav.appendChild(h('div', { className: 'navgroup', text: g[0] }));
      g[1].forEach(navButton);
    });
    function navButton(t) {
      var count = t === 'loot' ? lootTableNames().length : t === 'kinds' ? allKindNames().length : t === 'config' ? rows(t).filter(shownConfig).length
        : t === 'npcs' ? rows(t).filter(isNpc).length : t === 'objects' ? rows(t).filter(function (r) { return !isNpc(r); }).length : rows(t).length;
      nav.appendChild(h('button', { className: t === type ? 'on' : '', onclick: function () { type = t; curIndex = -1; curLoot = null; curKind = null; filter = ''; renderList(); renderForm(); renderNav(); } },
        h('span', { text: t === 'npcs' ? 'NPCs' : Schema.get(t).label }), h('span', { className: 'n', text: String(count) })));
    }
  }
  var NAV_GROUPS = [
    ['Setup', ['config', 'kinds', 'itemTypes', 'levels']],
    ['World', ['tilesets', 'terrain', 'wallStyles', 'objects']],
    ['Things', ['items', 'loot', 'blueprints', 'recipes']],
    ['Characters', ['classes', 'skills', 'statuses', 'monsters', 'appearances']],
    ['Story', ['npcs', 'dialogues', 'shops', 'quests', 'scenes']]
  ];
  // object_kinds is kept in Config but edited from the Object Kinds card, so the Config list leaves it out.
  // (so are the lists' folders: questlines, scene_folders, dialogue_folders)
  function shownConfig(r) { return ['object_kinds', 'questlines', 'scene_folders', 'dialogue_folders'].indexOf(r.key) < 0; }
  // The thumbnail for a list card: the row's art. Terrain shows its sprite (or its autotile's tileset
  // image); everything else shows the first image-typed field that has a value.
  function rowThumbSrc(t, r) {
    if (t === 'terrain') {
      if (r.sprite) return spritePath(r.sprite);
      if (r.autotile) { var ts = (rows('tilesets') || []).filter(function (x) { return x[idField('tilesets')] === r.autotile; })[0]; return ts && ts.image ? spritePath(ts.image) : ''; }
      return '';
    }
    var imgs = (Schema.get(t).fields || []).filter(function (f) { return f.type === 'image'; });
    for (var i = 0; i < imgs.length; i++) if (r[imgs[i].key]) return spritePath(r[imgs[i].key]);
    return '';
  }
  // Clothes and armour are drawn in two parts: the picture holds what never changes colour, and the mask next to it
  // (foo.tint.png) the cloth, coloured by the item's default_tint. showTinted puts both, one over the other, in an
  // <img> once they have loaded (until then, and when there is no mask, the plain picture stays).
  function showTinted(el, path, tint) {
    var ramp = tint && typeof Tint !== 'undefined' && Tint.TINTS[tint];
    if (!ramp || !path || !/\.png$/i.test(path)) return el;
    var base = pvImg(path), mask = pvImg(maskPath(path)), want = spritePath(path);
    el._tintOf = want;
    function go() {
      if (el._tintOf !== want || !base.complete || !mask.complete || !mask.width) return;   // (a picture that is all mask has no base: Tint.layer)
      try { var cv = Tint.layer(base, mask, ramp); if (cv && cv.toDataURL) el.src = cv.toDataURL(); } catch (e) { /* keep the plain picture */ }
    }
    [base, mask].forEach(function (im) { if (!im.complete) { im.addEventListener('load', go); im.addEventListener('error', go); } });
    go();
    return el;
  }
  function rowThumbPath(t, r) {
    var imgs = (Schema.get(t).fields || []).filter(function (f) { return f.type === 'image'; });
    for (var i = 0; i < imgs.length; i++) if (r[imgs[i].key]) return String(r[imgs[i].key]);
    return '';
  }
  function recCard(t, r, i, idf) {
    var src = rowThumbSrc(t, r);
    var thumb = src ? hoverZoom(showTinted(h('img', { className: 'rthumb', src: src, alt: '', onerror: function () { this.style.visibility = 'hidden'; } }), t === 'items' ? rowThumbPath(t, r) : '', r.default_tint), src)
      : h('span', { className: 'rthumb ph' });   // empty thumb = no art yet (stays visible)
    var body = h('div', { className: 'rbody' }, h('div', { text: rowLabel(t, r) }), r.name && idf && r[idf] !== r.name ? h('small', { text: r.name }) : null);
    return h('button', { className: 'rec' + (i === curIndex ? ' on' : ''), onclick: function () { curIndex = i; renderList(); renderForm(); } }, thumb, body);
  }
  function renderList() {
    if (type === 'loot') return lootList();
    if (type === 'kinds') return kindsList();
    if (type === 'npcs') return npcList();
    var list = $('list'); list.innerHTML = '';
    var search = h('input', { placeholder: 'Search ' + Schema.get(type).label.toLowerCase() + '…', value: filter,
      oninput: function (e) { filter = e.target.value; renderList(); } });
    list.appendChild(h('div', { className: 'head' }, search,
      h('button', { className: 'primary', title: 'New', text: '+ New', onclick: addRecord })));
    var all = rows(type), q = filter.toLowerCase(), idf = idField(type);
    function matches(r) { return !q || rowLabel(type, r).toLowerCase().indexOf(q) >= 0; }
    if (type === 'terrain') {                      // group plain tiles vs autotiles, like the map editor palette
      [['Tiles', function (r) { return !r.autotile; }], ['Autotiles', function (r) { return !!r.autotile; }]].forEach(function (grp) {
        var members = [];
        all.forEach(function (r, i) { if (grp[1](r) && matches(r)) members.push([r, i]); });
        if (!members.length) return;
        list.appendChild(h('div', { className: 'listgroup', text: grp[0] }));
        members.forEach(function (ri) { list.appendChild(recCard(type, ri[0], ri[1], idf)); });
      });
    } else if (type === 'items' || type === 'objects') {   // one group per item type / object kind, in the order of its dropdown
      var gkey = type === 'items' ? 'type' : 'kind';
      var order = optionsOf(type, fieldDef(type, gkey)), groups = {};
      all.forEach(function (r, i) {
        if (!matches(r) || (type === 'objects' && isNpc(r))) return;   // (NPCs have their own panel)
        var k = String(r[gkey] || '').trim();
        if (order.indexOf(k) < 0) order.push(k);   // a type not in the dropdown (or none) still gets its own group, last
        (groups[k] = groups[k] || []).push([r, i]);
      });
      order.forEach(function (k) {
        if (!groups[k]) return;
        var named = type === 'items' && itemTypeRow(k) && itemTypeRow(k).name;
        list.appendChild(h('div', { className: 'listgroup', text: (k ? named || k.charAt(0).toUpperCase() + k.slice(1) : type === 'items' ? 'No type' : 'No kind') + '  (' + groups[k].length + ')' }));
        groups[k].forEach(function (ri) { list.appendChild(recCard(type, ri[0], ri[1], idf)); });
      });
    } else if (FOLDERS[type] && !q) {                // quests, scenes, dialogues: in their folders (a search shows them flat)
      questFolders(list, all, idf);
    } else {
      var sortable = false;      // quests: the order is the order an NPC offers them in — drag to change it
      all.forEach(function (r, i) {
        if (!matches(r) || (type === 'config' && !shownConfig(r)) || (type === 'objects' && isNpc(r))) return;   // (NPCs have their own panel)
        var card = recCard(type, r, i, idf);
        if (sortable) dragSort(card, i);
        list.appendChild(card);
      });
      if (FOLDERS[type]) list.appendChild(h('div', { className: 'note', style: 'padding:4px 2px', text: 'Clear the search to drag ' + fo().many + ' into order and into ' + fo().word + 's.' }));
    }
    if (!list.querySelector('.rec')) list.appendChild(h('div', { className: 'note', style: 'padding:8px', text: all.length ? 'No match.' : 'Nothing here yet — click New.' }));
  }
  // ---------------------------------------------------------------- folders in a list (Quests: "questlines"; Scenes, Dialogues)
  // Only for keeping the list tidy (the game never reads them). FOLDERS says which lists have them: a row names its
  // folder in `field`; the folders themselves, in order and empty ones included, are Config `key` (names joined by |). Which are shut
  // is this browser's own business (localStorage). The row order stays one list — the order an NPC offers its quests —
  // so a folder only gathers its quests; dragging still moves the row.
  var FOLDERS = {
    quests:    { field: 'questline', key: 'questlines',       ls: 'sheetsrpg.studioQuestlinesShut',        word: 'questline', Word: 'Questline', one: 'quest',    many: 'quests',    tail: ' An NPC offers its quests in this order.' },
    scenes:    { field: 'folder',    key: 'scene_folders',    ls: 'sheetsrpg.studioFoldersShut.scenes',    word: 'folder',    Word: 'Folder',    one: 'scene',    many: 'scenes',    tail: '' },
    dialogues: { field: 'folder',    key: 'dialogue_folders', ls: 'sheetsrpg.studioFoldersShut.dialogues', word: 'folder',    Word: 'Folder',    one: 'dialogue', many: 'dialogues', tail: '' }
  };
  function fo() { return FOLDERS[type]; }
  var qlEdit = '';
  function qlOf(r) { return String((r && fo() && r[fo().field]) || '').trim(); }
  function qlList() {
    var row = rows('config').filter(function (c) { return c.key === fo().key; })[0];
    var names = String(row && row.value != null ? row.value : '').split('|').map(function (x) { return x.trim(); }).filter(Boolean);
    rows(type).forEach(function (r) { var n = qlOf(r); if (n && names.indexOf(n) < 0) names.push(n); });   // (named on a row only: still a folder)
    return names.filter(function (n, i) { return names.indexOf(n) === i; });
  }
  function qlSet(names) {
    var cfg = rows('config'), row = cfg.filter(function (c) { return c.key === fo().key; })[0];
    if (!row) { row = { key: fo().key, value: '', notes: fo().Word + ' folders of the Content Studio\'s ' + Schema.get(type).label + ' list (names joined by |). The game does not read this' }; cfg.push(row); }
    row.value = names.join('|');
  }
  function qlShut() { try { return JSON.parse(localStorage.getItem(fo().ls)) || {}; } catch (e) { return {}; } }
  function qlToggle(name) { var s = qlShut(); if (s[name]) delete s[name]; else s[name] = 1; try { localStorage.setItem(fo().ls, JSON.stringify(s)); } catch (e) { /* private mode */ } renderList(); }
  function qlAdd() {
    var names = qlList(), n = 1, name = 'New ' + fo().word;
    while (names.indexOf(name) >= 0) name = 'New ' + fo().word + ' ' + (++n);
    qlSet(names.concat([name])); qlEdit = name;
    persist(); renderList();
  }
  function qlRename(from, to) {
    to = String(to || '').replace(/\|/g, ' ').trim(); qlEdit = '';
    if (!to || to === from) return renderList();
    rows(type).forEach(function (r) { if (qlOf(r) === from) r[fo().field] = to; });
    var names = qlList().map(function (n) { return n === from ? to : n; });    // (a name already taken: the two become one)
    qlSet(names.filter(function (n, i) { return names.indexOf(n) === i; }));
    var s = qlShut(); if (s[from]) { delete s[from]; s[to] = 1; try { localStorage.setItem(fo().ls, JSON.stringify(s)); } catch (e) { /* private mode */ } }
    persist(); renderList();
  }
  function qlRemove(name) {
    var n = rows(type).filter(function (r) { return qlOf(r) === name; }).length;
    if (n && !confirm('Remove the ' + fo().word + ' "' + name + '"? Its ' + n + ' ' + (n === 1 ? fo().one + ' is' : fo().many + ' are') + ' kept, outside any ' + fo().word + '.')) return;
    rows(type).forEach(function (r) { if (qlOf(r) === name) delete r[fo().field]; });
    qlSet(qlList().filter(function (x) { return x !== name; }));
    persist(); renderList();
  }
  /** Put quest row `from` into questline `name` ('' = none) and move it to just before row `to` (counted before the move; -1 = stay). */
  // Several at once: quests picked with Shift+click (a run) or Ctrl+click (one more) all go when one of them is dragged,
  // keeping their order. qlSel holds the rows themselves; qlAnchor = the row a Shift+click runs from.
  var qlSel = [], qlAnchor = null, qlShown = [];
  function qlPick(e, i) {
    var all = rows(type), r = all[i];
    if (e.shiftKey) {
      var a = qlShown.indexOf(all.indexOf(qlAnchor || all[curIndex])), b = qlShown.indexOf(i);
      if (a < 0) a = b;
      var run = qlShown.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (k) { return all[k]; });
      qlSel = (e.ctrlKey || e.metaKey ? qlSel : []).concat(run);
      if (!qlAnchor) qlAnchor = all[qlShown[a]];
    } else {
      if (!qlSel.length && all[curIndex] && all[curIndex] !== r) qlSel = [all[curIndex]];   // (the open quest counts as the first pick)
      if (qlSel.indexOf(r) >= 0) qlSel = qlSel.filter(function (x) { return x !== r; }); else qlSel.push(r);
      qlAnchor = r;
    }
    qlSel = qlSel.filter(function (x, k) { return qlSel.indexOf(x) === k; });
    renderList();
  }
  function qlDrop(from, name, to) {
    var all = rows(type), open = all[curIndex], r = all[from]; if (!r) return;
    var moving = qlSel.indexOf(r) >= 0 ? all.filter(function (x) { return qlSel.indexOf(x) >= 0; }) : [r];
    var target = to >= 0 ? all[to] : null;                       // the row to land before (none = the end)
    while (target && moving.indexOf(target) >= 0) target = all[all.indexOf(target) + 1] || null;   // (dropped among themselves: before the next that stays)
    moving.forEach(function (x) { if (name) x[fo().field] = name; else delete x[fo().field]; });
    if (to >= 0) {
      var rest = all.filter(function (x) { return moving.indexOf(x) < 0; }), at = target ? rest.indexOf(target) : rest.length;
      rest.splice.apply(rest, [at, 0].concat(moving));
      all.length = 0; rest.forEach(function (x) { all.push(x); });
    }
    curIndex = open ? all.indexOf(open) : -1;
    persist(); renderList(); renderForm();
  }
  function qlClear() { Array.prototype.forEach.call(document.querySelectorAll('#list .dropbefore, #list .dropafter, #list .dropin'), function (c) { c.classList.remove('dropbefore', 'dropafter', 'dropin'); }); }
  /** A quest card: dragged; dropped on, the dragged quest joins this one's questline, above or below it. */
  function qlCard(card, i, name) {
    card.draggable = true;
    if (qlSel.indexOf(rows(type)[i]) >= 0) card.classList.add('sel');
    card.addEventListener('click', function (e) {              // Shift / Ctrl+click picks; a plain click opens it and lets the picks go
      if (e.shiftKey || e.ctrlKey || e.metaKey) { e.stopImmediatePropagation(); e.preventDefault(); return qlPick(e, i); }
      qlSel = []; qlAnchor = rows(type)[i];
    }, true);
    function below(e) { var b = card.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; }
    card.addEventListener('dragstart', function (e) {
      dragFrom = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) { /* old browsers */ }
      var many = card.classList.contains('sel');                 // one of the picked ones: they all go
      Array.prototype.forEach.call(many ? document.querySelectorAll('#list .rec.sel') : [card], function (c) { c.classList.add('dragging'); });
    });
    card.addEventListener('dragend', function () { dragFrom = -1; Array.prototype.forEach.call(document.querySelectorAll('#list .rec.dragging'), function (c) { c.classList.remove('dragging'); }); qlClear(); });
    card.addEventListener('dragover', function (e) { if (dragFrom < 0) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; qlClear(); card.classList.add(below(e) ? 'dropafter' : 'dropbefore'); });
    card.addEventListener('drop', function (e) { e.preventDefault(); qlClear(); if (dragFrom < 0) return; var f = dragFrom; dragFrom = -1; qlDrop(f, name, below(e) ? i + 1 : i); });
  }
  /** A folder's heading (or its empty body): dropped on, the dragged quest goes into it, after its last quest. */
  function qlTarget(el, name, last) {
    el.addEventListener('dragover', function (e) { if (dragFrom < 0) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; qlClear(); el.classList.add('dropin'); });
    el.addEventListener('dragleave', function () { el.classList.remove('dropin'); });
    el.addEventListener('drop', function (e) { e.preventDefault(); qlClear(); if (dragFrom < 0) return; var f = dragFrom; dragFrom = -1; qlDrop(f, name, last >= 0 ? last + 1 : -1); });
  }
  function questFolders(list, all, idf) {
    var names = qlList(), shut = qlShut(), groups = { '': [] };
    qlSel = qlSel.filter(function (x) { return all.indexOf(x) >= 0; }); qlShown = [];
    names.forEach(function (n) { groups[n] = []; });
    all.forEach(function (r, i) { groups[qlOf(r)].push([r, i]); });
    function body(name) {
      var g = groups[name];
      g.forEach(function (ri) { qlShown.push(ri[1]); var card = recCard(type, ri[0], ri[1], idf); if (name) card.classList.add('inql'); qlCard(card, ri[1], name); list.appendChild(card); });
    }
    function lastOf(name) { var g = groups[name]; return g.length ? g[g.length - 1][1] : -1; }
    if (names.length && groups[''].length) {
      var loose = h('div', { className: 'listgroup', text: 'No ' + fo().word + '  (' + groups[''].length + ')' });
      qlTarget(loose, '', lastOf('')); list.appendChild(loose);
    }
    body('');
    names.forEach(function (name) {
      var g = groups[name], isShut = !!shut[name], head;
      if (qlEdit === name) {
        var done = false, commit = function (v) { if (done) return; done = true; qlRename(name, v); };   // (once: redrawing the list blurs the box again)
        var inp = h('input', { value: name, onkeydown: function (e) { if (e.key === 'Enter') commit(inp.value); else if (e.key === 'Escape') commit(name); }, onblur: function () { commit(inp.value); } });
        head = h('div', { className: 'qlhead' }, inp);
        setTimeout(function () { inp.focus(); inp.select(); }, 0);
      } else {
        head = h('div', { className: 'qlhead' + (isShut ? ' shut' : ''), title: 'Click to ' + (isShut ? 'open' : 'close') + '. Drop a ' + fo().one + ' here to put it in this ' + fo().word,
          onclick: function () { qlToggle(name); } },
          h('span', { className: 'qlarrow', text: isShut ? '▸' : '▾' }), h('span', { className: 'qlname', text: name }), h('small', { text: String(g.length) }),
          h('button', { title: 'Rename', text: '✎', onclick: function (e) { e.stopPropagation(); qlEdit = name; renderList(); } }),
          h('button', { title: 'Remove this ' + fo().word + ' (its ' + fo().many + ' are kept)', text: '✕', onclick: function (e) { e.stopPropagation(); qlRemove(name); } }));
        qlTarget(head, name, lastOf(name));
      }
      list.appendChild(head);
      if (isShut) return;
      if (!g.length) { var empty = h('div', { className: 'qlempty', text: 'Empty. Drag ' + fo().many + ' here.' }); qlTarget(empty, name, -1); list.appendChild(empty); }
      body(name);
    });
    list.appendChild(h('button', { className: 'qladd', title: 'A new ' + fo().word + ': a folder to keep ' + fo().many + ' together in this list', text: '+ New ' + fo().word, onclick: qlAdd }));
    list.appendChild(h('div', { className: 'note', style: 'padding:4px 2px', text: 'Drag a ' + fo().one + ' to change the order or to put it in a ' + fo().word + '. Shift+click picks a run, Ctrl+click one more: drag any of them and they all go.' + fo().tail }));
  }

  // Drag a record card onto another: it moves above or below it (whichever half of the card it is dropped on).
  var dragFrom = -1;
  function dragSort(card, i) {
    card.draggable = true;
    function clear() { Array.prototype.forEach.call(document.querySelectorAll('#list .rec'), function (c) { c.classList.remove('dropbefore', 'dropafter'); }); }
    function below(e) { var b = card.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; }
    card.addEventListener('dragstart', function (e) { dragFrom = i; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch (x) { /* old browsers */ } });
    card.addEventListener('dragend', function () { dragFrom = -1; card.classList.remove('dragging'); clear(); });
    card.addEventListener('dragover', function (e) {
      if (dragFrom < 0) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      clear(); card.classList.add(below(e) ? 'dropafter' : 'dropbefore');
    });
    card.addEventListener('drop', function (e) {
      e.preventDefault(); clear();
      if (dragFrom < 0) return;
      moveRow(dragFrom, below(e) ? i + 1 : i);
      dragFrom = -1;
    });
  }
  /** Move a row of the current table to just before index `to` (counted before the move). The open record stays open. */
  function moveRow(from, to) {
    var all = rows(type), open = all[curIndex];
    if (from < 0 || from >= all.length || to === from || to === from + 1) return;
    var r = all.splice(from, 1)[0];
    all.splice(to > from ? to - 1 : to, 0, r);
    curIndex = open ? all.indexOf(open) : -1;
    persist(); renderList(); renderForm();
  }

  // ---------------------------------------------------------------- the questline map (Quests only; js/questmap.js)
  var QMAP_LS = 'sheetsrpg.studioQuestMap';      // 'wide' | 'shut' | '' (normal)
  function qmapMode() { try { return localStorage.getItem(QMAP_LS) || ''; } catch (e) { return ''; } }
  function setQmapMode(m) { try { localStorage.setItem(QMAP_LS, m); } catch (e) { /* private mode */ } renderQuestMap(); }
  function renderQuestMap() {
    var box = $('qmap'), main = $('main'); if (!box || !main) return;
    if (type === 'dialogues' && typeof DialogMap !== 'undefined') return renderDialogMap(box, main);
    if (type === 'scenes' && typeof SceneMap !== 'undefined') return renderSceneMap(box, main);
    var on = type === 'quests' && typeof QuestMap !== 'undefined', mode = qmapMode();
    box.hidden = !on;
    main.classList.toggle('withmap', on); main.classList.toggle('wide', on && mode === 'wide'); main.classList.toggle('mapshut', on && mode === 'shut');
    if (!on) return;
    box.innerHTML = '';
    if (mode === 'shut') { box.appendChild(h('button', { className: 'qmshut', text: 'Questlines ▸', title: 'Show the questline map', onclick: function () { setQmapMode(''); } })); return; }
    var all = rows('quests'), cur = all[curIndex];
    var placed = all.filter(function (r) { return r.map_xy; }).length;
    box.appendChild(h('div', { className: 'qmhead' }, h('b', { text: 'Questlines' }), h('span', { className: 'sp', style: 'margin-left:auto' }),
      h('button', { text: 'Fit', title: 'Show every quest', onclick: function () { QuestMap.fit(); } }),
      placed ? h('button', { text: 'Reset layout', title: 'Forget where the boxes were dragged to (' + placed + ' placed by hand) and lay them all out again', onclick: function () {
        if (!confirm('Put all ' + placed + ' hand-placed quest boxes back where the automatic layout puts them?')) return;
        all.forEach(function (r) { delete r.map_xy; }); persist(); renderQuestMap();
      } }) : null,
      h('button', { text: mode === 'wide' ? 'Narrow' : 'Wide', title: 'Give the map more room', onclick: function () { setQmapMode(mode === 'wide' ? '' : 'wide'); } }),
      h('button', { text: 'Hide', title: 'Fold the map away', onclick: function () { setQmapMode('shut'); } })));
    box.appendChild(QuestMap.legend());
    box.appendChild(h('div', { className: 'qmhint', text: 'Drag a box to place it · hold the mouse wheel (or drag empty space) to move around · wheel to zoom' }));
    var body = h('div', { className: 'qmbody' }); box.appendChild(body);
    function rowOf(id) { for (var i = 0; i < all.length; i++) if (String(all[i].id || '') === id) return i; return -1; }
    QuestMap.draw(body, all, configList('start_quests'), cur ? String(cur.id || '') : '', {
      pick: function (id) { var i = rowOf(id); if (i < 0) return; curIndex = i; renderList(); renderForm(); },
      // where a box was dropped: kept on its row (published with it; the game never reads it). Saved without redrawing
      // the map, which already shows it there — a redraw would cut short the next drag.
      move: function (id, x, y) {
        var i = rowOf(id); if (i < 0) return;
        var had = !!all[i].map_xy;
        all[i].map_xy = Math.round(x) + ',' + Math.round(y);
        keep();
        if (!had) renderQuestMap();                                  // (the first box placed by hand brings the Reset layout button)
      }
    });
  }
  var qmapTimer = 0;
  function questMapSoon() { if (type !== 'quests' && type !== 'dialogues' && type !== 'scenes') return; clearTimeout(qmapTimer); qmapTimer = setTimeout(renderQuestMap, 350); }
  function addRecord() {
    if (type === 'npcs') { var n = Schema.defaults('objects'); n.kind = 'npc'; rows('objects').push(n); curIndex = rows('objects').length - 1; persist(); renderNav(); renderList(); renderForm(); return; }
    var r = Schema.defaults(type);
    if (type === 'dialogues') r.nodes = [{ id: 'hello', start: true, text: '', answers: [] }];   // a conversation needs a line to open on
    if (type === 'scenes') r.steps = [{ type: 'say', text: '' }];                                  // a scene needs a step to play
    if (FOLDERS[type] && qlOf(rows(type)[curIndex])) r[fo().field] = qlOf(rows(type)[curIndex]);   // (made with one of a folder open: it joins it)
    rows(type).push(r); curIndex = rows(type).length - 1;
    persist(); renderNav(); renderList(); renderForm();
  }

  // ---------------------------------------------------------------- dialogues (Story → Dialogues; the map is js/dialogmap.js)
  // A dialogue = the lines an NPC can say, each with the answers the player may give. Stored on the row as `nodes`:
  // [{id, text, start, if, x, y, answers: [{id, text, if, do, to, once}]}] (x, y = where its box was dragged to on the
  // map). The form edits the dialogue and ONE line at a time (the one picked on the map or in the strip of lines).
  var curLineId = '', curLineOf = null;
  var COND_HELP = 'A condition list, all must hold: talked (they have spoken before), !talked (first meeting), said:<line id> (the NPC has said that line to them), flag:x, !flag:x, has:item:n, level:n, quest:x (handed in), quest_active:x';
  function linesOf(r) {
    if (!Array.isArray(r.nodes)) { var v = []; try { v = JSON.parse(r.nodes || '[]'); } catch (e) { v = []; } r.nodes = Array.isArray(v) ? v : []; }
    r.nodes.forEach(function (n) { if (!Array.isArray(n.answers)) n.answers = []; });
    return r.nodes;
  }
  function freeId(list, prefix) { var i = 1; while (list.some(function (x) { return x.id === prefix + i; })) i++; return prefix + i; }
  function isTrue(v) { return v === true || /^(true|yes|1|on)$/i.test(String(v == null ? '' : v).trim()); }
  function dialogueUsers(id) { return rows('objects').filter(function (o) { return isNpc(o) && id && String(propsObj(o).dialogue || '') === String(id); }); }
  function openDialogue(id) {
    var i = -1; rows('dialogues').forEach(function (d, n) { if (i < 0 && String(d.id || '') === String(id)) i = n; });
    if (i < 0) return;
    type = 'dialogues'; curIndex = i; filter = ''; renderNav(); renderList(); renderForm();
  }
  // ---- the scene map (Scenes; js/scenemap.js): the real map beside the steps. The scene's `map` says which one, its
  // `start_xy` where the player stands on it (both for the Studio, and for Play this scene). A step's tile is set
  // with its "Pick on map" button and a click, or by dragging its marker; a click on a marker picks its step.
  var scenePick = null, sceneSel = -1, sceneOf = null;        // pick: 'start' | a step's index | null
  function sceneStart(r) { var m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(String(r.start_xy || '')); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; }
  function stepHasTile(st) { return (st.type === 'camera' && st.to !== 'me') || st.type === 'show' || st.type === 'walk' || (st.type === 'emote' && st.over === 'tile'); }
  function renderSceneMap(box, main) {
    var mode = qmapMode();
    box.hidden = false;
    main.classList.add('withmap'); main.classList.toggle('wide', mode === 'wide'); main.classList.toggle('mapshut', mode === 'shut');
    if (mode === 'shut') { box.innerHTML = ''; box.appendChild(h('button', { className: 'qmshut', text: 'Scene map ▸', title: 'Show the map of this scene', onclick: function () { setQmapMode(''); } })); return; }
    var r = rows('scenes')[curIndex];
    if (sceneOf !== r) { sceneOf = r; scenePick = null; sceneSel = -1; }
    var maps = SceneMap.info(T), body = box.querySelector('.qmbody.sm');
    if (!body) { box.innerHTML = ''; body = h('div', { className: 'qmbody sm' }); } else { while (box.firstChild) box.removeChild(box.firstChild); }
    function again() { renderSceneMap(box, main); }
    box.appendChild(h('div', { className: 'qmhead' }, h('b', { text: 'Scene map' }),
      r ? h('select', { title: 'The map this scene plays on (for picking tiles here; the game plays it wherever it is started)', onchange: function (e) { r.map = e.target.value; delete r.start_xy; scenePick = null; keep(); sceneForm(); again(); } },
        [h('option', { value: '', text: '— pick a map —', selected: !r.map })].concat(maps.map(function (m) { return h('option', { value: m.id, text: m.name + ' (' + m.id + ')', selected: m.id === String(r.map || '') }); }))) : null,
      h('span', { className: 'sp', style: 'margin-left:auto' }),
      r && r.map ? h('button', { className: scenePick === 'start' ? 'on' : '', text: sceneStart(r) ? 'Move player' : 'Set player', title: 'Click the map where the player stands when the scene starts. Play this scene puts the test character there', onclick: function () { scenePick = scenePick === 'start' ? null : 'start'; again(); } }) : null,
      h('button', { text: 'Fit', title: 'Show the whole map', onclick: function () { SceneMap.fit(); } }),
      h('button', { text: '↻', title: 'Read the maps again (after saving in the map editor)', onclick: function () { SceneMap.reload(); } }),
      h('button', { text: mode === 'wide' ? 'Narrow' : 'Wide', title: 'Give the map more room', onclick: function () { setQmapMode(mode === 'wide' ? '' : 'wide'); } }),
      h('button', { text: 'Hide', title: 'Fold the map away', onclick: function () { setQmapMode('shut'); } })));
    box.appendChild(SceneMap.legend());
    box.appendChild(h('div', { className: 'qmhint', text: 'A numbered dot = that step\'s tile · drag a dot to move it, click it to find its step · P = where the player stands · a dashed ring = it stays after the scene · wheel to zoom, drag the ground to move' }));
    box.appendChild(body);
    if (!r) { body.innerHTML = ''; body.appendChild(h('div', { className: 'note qmempty', text: 'Pick a scene to see its map.' })); return; }
    if (!maps.length) { body.innerHTML = ''; body.appendChild(h('div', { className: 'note qmempty', text: 'This draft holds no maps, so there is nothing to draw. Maps come with the project files (the desktop app), or are made in the map editor.' })); return; }
    var old = body.querySelector('.qmempty'); if (old) old.remove();
    var steps = stepsOf(r);
    SceneMap.draw(body, { tables: T, mapId: r.map || '', start: sceneStart(r), steps: steps, sel: sceneSel, pick: scenePick, on: {
      move: function (i, x, y) { var st = steps[i]; if (!st) return; st.x = x; st.y = y; sceneSel = i; keep(); sceneForm(); again(); },
      start: function (x, y) { r.start_xy = x + ',' + y; keep(); again(); },
      select: function (i) { sceneSel = i; sceneForm(); again(); var card = document.querySelector('#form .dcard.picked'); if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' }); },
      picked: function () { scenePick = null; again(); }
    } });
  }
  function renderDialogMap(box, main) {
    var mode = qmapMode();
    box.hidden = false;
    main.classList.add('withmap'); main.classList.toggle('wide', mode === 'wide'); main.classList.toggle('mapshut', mode === 'shut');
    box.innerHTML = '';
    if (mode === 'shut') { box.appendChild(h('button', { className: 'qmshut', text: 'Dialogue map ▸', title: 'Show the map of this dialogue', onclick: function () { setQmapMode(''); } })); return; }
    var r = rows('dialogues')[curIndex], lines = r ? linesOf(r) : [];
    var placed = lines.filter(function (n) { return n.x != null && n.y != null; }).length;
    box.appendChild(h('div', { className: 'qmhead' }, h('b', { text: 'Dialogue map' }), h('span', { className: 'sp', style: 'margin-left:auto' }),
      h('button', { text: 'Fit', title: 'Show every line', onclick: function () { DialogMap.fit(); } }),
      placed ? h('button', { text: 'Reset layout', title: 'Forget where the boxes were dragged to and lay them out again', onclick: function () {
        if (!confirm('Put all ' + placed + ' hand-placed boxes back where the automatic layout puts them?')) return;
        lines.forEach(function (n) { delete n.x; delete n.y; }); persist(); renderDialogMap(box, main);
      } }) : null,
      h('button', { text: mode === 'wide' ? 'Narrow' : 'Wide', title: 'Give the map more room', onclick: function () { setQmapMode(mode === 'wide' ? '' : 'wide'); } }),
      h('button', { text: 'Hide', title: 'Fold the map away', onclick: function () { setQmapMode('shut'); } })));
    box.appendChild(DialogMap.legend());
    box.appendChild(h('div', { className: 'qmhint', text: 'A box = a line the NPC says · an arrow = an answer · click a box to edit it, drag to place it · wheel to zoom' }));
    var body = h('div', { className: 'qmbody' }); box.appendChild(body);
    if (!r) { body.appendChild(h('div', { className: 'note qmempty', text: 'Pick a dialogue to see its map.' })); return; }
    DialogMap.draw(body, lines, curLineOf === r ? curLineId : '', {
      pick: function (id) { curLineOf = r; curLineId = id; dialogueForm(); renderDialogMap(box, main); },
      move: function (id, x, y) {                                   // (saved without redrawing the map, which already shows it there)
        var n = lines.filter(function (q) { return q.id === id; })[0]; if (!n) return;
        var had = n.x != null; n.x = Math.round(x); n.y = Math.round(y); keep();
        if (!had) renderDialogMap(box, main);
      }
    });
  }
  // ---------------------------------------------------------------- shops (Story → Shops)
  // A shop = a list of offers, stored on the row as `offers`: [{id, gives, costs, sell, stock, restock_h, if}]. One
  // offer is one trade: the player hands over `costs` and gets `gives` (item lists; gold is the item "gold", edited
  // here as a number of its own). sell = the shop is the one buying: the game lists it under Sell.
  function offersOf(r) {
    if (!Array.isArray(r.offers)) { var v = []; try { v = JSON.parse(r.offers || '[]'); } catch (e) { v = []; } r.offers = Array.isArray(v) ? v : []; }
    return r.offers;
  }
  /** One side of a trade: a gold amount and an item list, kept together as the item-list text the rules read. */
  function tradeSide(text, onSave) {
    var gold = 0, rest = [];
    String(text == null ? '' : text).split(/[,;]/).forEach(function (part) {
      var b = part.trim().split(':'); if (!b[0]) return;
      if (b[0].trim() === 'gold') gold += parseInt(b[1], 10) > 0 ? parseInt(b[1], 10) : 0; else rest.push(part.trim());
    });
    var items = rest.join(', ');
    function save() { onSave([gold > 0 ? 'gold:' + gold : '', items].filter(Boolean).join(', ')); }
    return h('div', null,
      h('div', { className: 'row', style: 'margin-bottom:4px' }, h('span', { className: 'lootlbl', text: 'Gold' }),
        h('input', { type: 'number', min: 0, step: 1, value: gold || '', placeholder: '0', style: 'width:90px;flex:none', oninput: function (e) { var q = parseInt(e.target.value, 10); gold = q > 0 ? q : 0; save(); } })),
      itemsBox(items, function (t) { items = t; save(); }));
  }
  function shopUsers(id) { return rows('objects').filter(function (o) { return isNpc(o) && id && String(propsObj(o).shop || '') === String(id); }); }
  function shopForm() {
    var form = $('form'), keepTop = form.scrollTop; form.innerHTML = '';
    var r = rows('shops')[curIndex];
    if (curIndex < 0 || !r) { form.appendChild(h('div', { className: 'empty', text: 'Select a shop, or click New.' })); return; }
    var offers = offersOf(r), users = shopUsers(r.id);
    function save(again) { persist(); if (again) shopForm(); }
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('shops', r) }), h('span', { className: 'pill', text: 'Shop' }),
      h('button', { title: 'Delete this shop', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete this shop?' + (users.length ? ' ' + users.length + ' NPC' + (users.length === 1 ? ' keeps' : 's keep') + ' it and will have nothing to trade.' : ''))) return;
        rows('shops').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    Schema.get('shops').fields.forEach(function (fl) { if (fl.key === 'id' || fl.key === 'name') form.appendChild(fieldEl(r, fl)); });
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Kept by' }),
      users.length ? h('div', null, users.map(function (o, n) {
        return h('a', { href: '#', text: (o.name || o.id) + (n < users.length - 1 ? ', ' : ''), onclick: function (e) { e.preventDefault(); type = 'npcs'; curIndex = rows('objects').indexOf(o); filter = ''; renderNav(); renderList(); renderForm(); } });
      })) : h('div', { className: 'help', text: 'No NPC yet. Pick this shop on an NPC\'s page (Story → NPCs); several NPCs can keep the same shop.' })));
    [[false, 'Sells — what players can buy here', '+ Add something to sell'], [true, 'Buys — what players can sell here', '+ Add something to buy']].forEach(function (grp) {
      form.appendChild(h('div', { className: 'sub', text: grp[1] }));
      offers.forEach(function (o, oi) {
        if (isTrue(o.sell) !== grp[0]) return;
        var card = h('div', { className: 'dcard' });
        card.appendChild(h('div', { className: 'row' },
          h('b', { style: 'flex:1;font-size:12px', text: grp[0] ? 'The player hands over' : 'The player gets' }),
          h('button', { text: '↑', title: 'Earlier in the list', disabled: oi === 0, onclick: function () { offers.splice(oi - 1, 0, offers.splice(oi, 1)[0]); save(true); } }),
          h('button', { text: '↓', title: 'Later in the list', disabled: oi === offers.length - 1, onclick: function () { offers.splice(oi + 1, 0, offers.splice(oi, 1)[0]); save(true); } }),
          h('button', { text: '✕', title: 'Remove this offer', onclick: function () { offers.splice(oi, 1); save(true); } })));
        // (whichever way it goes, the goods come first and the price second: a sale's goods are what the player hands over)
        card.appendChild(tradeSide(grp[0] ? o.costs : o.gives, function (t) { if (grp[0]) o.costs = t; else o.gives = t; save(); }));
        card.appendChild(h('div', { className: 'row', style: 'margin-top:6px' }, h('b', { style: 'font-size:12px', text: grp[0] ? 'and gets' : 'and pays' })));
        card.appendChild(tradeSide(grp[0] ? o.gives : o.costs, function (t) { if (grp[0]) o.gives = t; else o.costs = t; save(); }));
        card.appendChild(h('div', { className: 'row', style: 'margin-top:6px' },
          h('span', { className: 'lootlbl', text: 'Stock' }),
          h('input', { type: 'number', min: 0, step: 1, value: Number(o.stock) > 0 ? o.stock : '', placeholder: 'no limit', style: 'width:90px;flex:none',
            title: 'How many times EACH character can take this offer before it runs out for them. Empty = no limit',
            oninput: function (e) { var q = parseInt(e.target.value, 10); if (q > 0) o.stock = q; else delete o.stock; save(); } }),
          h('span', { className: 'lootlbl', text: 'back after' }),
          h('input', { type: 'number', min: 0, step: 0.5, value: Number(o.restock_h) > 0 ? o.restock_h : '', placeholder: 'never', style: 'width:90px;flex:none',
            title: 'Hours until this offer is whole again for a character, counted from the first one they took. Empty = it never comes back',
            oninput: function (e) { var q = parseFloat(e.target.value); if (q > 0) o.restock_h = q; else delete o.restock_h; save(); } }),
          h('span', { className: 'lootlbl', text: 'hours' })));
        card.appendChild(h('div', { className: 'row' },
          h('span', { className: 'lootlbl', text: 'Only if' }),
          h('input', { type: 'text', value: o['if'] || '', placeholder: 'always (e.g. quest:helped_doc or level:3)', title: 'The offer is shown only to characters for whom this holds. ' + COND_HELP,
            oninput: function (e) { var v = e.target.value.trim(); if (v) o['if'] = v; else delete o['if']; save(); } })));
        form.appendChild(card);
      });
      form.appendChild(h('button', { className: 'primary', style: 'margin:2px 0 8px', text: grp[2], onclick: function () {
        var n = { id: freeId(offers, 'o'), gives: '', costs: '' }; if (grp[0]) n.sell = true;
        offers.push(n); save(true);
      } }));
    });
    form.appendChild(h('div', { className: 'help', text: 'Stock is counted for each character on their own: one player buying everything leaves the next player\'s shop full. An offer with nothing for the player to get is left out of the game.' }));
    Schema.get('shops').fields.forEach(function (fl) { if (fl.key === 'notes') form.appendChild(fieldEl(r, fl)); });
    form.scrollTop = keepTop;
  }
  // ---------------------------------------------------------------- scenes (Story → Scenes)
  // A scene = a list of steps the game page plays for one player (client/js/scene.js), stored on the row as `steps`:
  // [{type, with, ...}]. The kinds and their fields are Content.SCENE_STEPS ([key, type, default, help, options]).
  // An action list starts one with scene:<id>; what follows it in that list happens when the scene ends.
  var STEP_LABEL = { on: 'On', out: 'Fade out', color: 'Colour', s: 'Seconds', to: 'Look at', x: 'Tile x', y: 'Tile y', zoom: 'Zoom', shake: 'Shake',
    image: 'Picture', text: 'Text', bg: 'Around it', name: 'Name shown', emote: 'Emote', over: 'Over', npc: 'NPC', a: 'Actor', dir: 'Facing', speed: 'Speed', straight: 'Straight line', wait: 'Wait for it', stay: 'Stays after', count: 'How many' };
  var STEP_OPT = { me: 'the player', tile: 'a tile', npc: 'an NPC', actor: 'an actor', E: 'right', W: 'left', player: 'towards the player' };
  /** A picker of who acts in a scene: the player, an NPC (npc:<id>) or a monster (mon:<id>). */
  // Another of the same is "#<n>" after it (mon:rat#2 = the second rat): the number box beside the list. For an NPC that
  // stands on the map several times, 2 = the second nearest to the player.
  function actorPicker(full, set, none) {
    var cut = String(full || '').split('#'), val = cut[0], copy = Math.max(1, Math.round(Number(cut[1]) || 1));
    function put(v, n) { set(v && v !== 'me' && n > 1 ? v + '#' + n : v); }
    var npcs = rows('objects').filter(isNpc).filter(function (o) { return o.id; }), mons = rows('monsters').filter(function (m) { return m.id; });
    var known = !val || val === 'me' || npcs.some(function (o) { return 'npc:' + o.id === val; }) || mons.some(function (m) { return 'mon:' + m.id === val; });
    var box = h('div', { className: 'row', style: 'flex:1;min-width:0' });
    box.appendChild(actorList());
    if (val && val !== 'me') box.appendChild(h('input', { type: 'number', min: 1, max: 20, step: 1, value: copy, style: 'width:54px;flex:none', title: 'Which one, when the scene has several of the same: 1 = the first, 2 = another one, 3 = a third… (for an NPC that stands on the map several times: 2 = the second nearest to the player)',
      onchange: function (e) { put(val, Math.max(1, Math.round(Number(e.target.value) || 1))); } }));
    return box;
    function actorList() { return h('select', { style: 'flex:1;min-width:0' + (known ? '' : ';border-color:var(--bad)'), onchange: function (e) { put(e.target.value, copy); sceneForm(); } },
      none ? h('option', { value: '', text: none, selected: !val }) : null,
      known ? null : h('option', { value: val, text: val + ' (missing)', selected: true }),
      h('option', { value: 'me', text: 'The player', selected: val === 'me' }),
      h('optgroup', { label: 'NPCs' }, npcs.map(function (o) { return h('option', { value: 'npc:' + o.id, text: (o.name || o.id) + ' (' + o.id + ')', selected: val === 'npc:' + o.id }); })),
      h('optgroup', { label: 'Monsters' }, mons.map(function (m) { return h('option', { value: 'mon:' + m.id, text: (m.name || m.id) + ' (' + m.id + ')', selected: val === 'mon:' + m.id }); }))); }
  }
  /** A picker of the emotes (Content.EMOTES), each with its picture (client/js/emotes.js); `none` first when asked. */
  function emotePicker(val, set, withNone, noneText) {
    var box = h('div', { className: 'row', style: 'flex:1;flex-wrap:wrap;gap:3px' });
    var list = (withNone ? [{ id: withNone, name: noneText || 'None' }] : []).concat(Content.EMOTES || []);
    list.forEach(function (em) {
      var on = (val || withNone || '') === em.id;
      var b = h('button', { title: em.name, style: 'padding:2px 4px;display:flex;align-items:center;gap:4px;' + (on ? 'outline:2px solid #e0b84a;' : ''), onclick: function () { set(em.id); } });
      if (typeof Emotes !== 'undefined' && Emotes.known(em.id)) { var cv = Emotes.icon(em.id, 2); cv.style.imageRendering = 'pixelated'; b.appendChild(cv); }
      b.appendChild(h('span', { style: 'font-size:11px', text: em.name }));
      box.appendChild(b);
    });
    return box;
  }
  function stepsOf(r) {
    if (!Array.isArray(r.steps)) { var v = []; try { v = JSON.parse(r.steps || '[]'); } catch (e) { v = []; } r.steps = Array.isArray(v) ? v : []; }
    return r.steps;
  }
  function stepKind(id) { return (Content.SCENE_STEPS || []).filter(function (k) { return k.id === id; })[0] || null; }
  /** Where a scene is started: every row whose text holds scene:<id> (quest hooks and rewards, dialogue answers, objects). */
  function sceneUsers(id) {
    var out = [], re = new RegExp('scene:\\s*' + String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
    [['quests', 'Quest'], ['dialogues', 'Dialogue'], ['objects', 'Object'], ['items', 'Item'], ['skills', 'Skill']].forEach(function (t) {
      (rows(t[0]) || []).forEach(function (row) { if (re.test(JSON.stringify(row))) out.push({ t: t[0], what: t[1], row: row }); });
    });
    return out;
  }
  function tryScene(id) {
    var url = '../client/?offline&scene=' + encodeURIComponent(id);
    if (LOCAL) { flushFiles().then(function () { window.open(url, '_blank'); }); return; }
    ContentStore.setDraft(T); window.open(url, '_blank');
  }
  function stepField(st, f) {
    var key = f[0], kind = f[1], def = f[2], val = st[key] === undefined ? def : st[key], c;
    function set(v) { st[key] = v; persist(); }
    if (kind === 'bool') c = h('input', { type: 'checkbox', checked: isTrue(val), onchange: function (e) { set(e.target.checked); } });
    else if (kind === 'number') c = h('input', { type: 'number', step: 'any', value: val, style: 'width:90px;flex:none', oninput: function (e) { set(e.target.value === '' ? def : Number(e.target.value)); } });
    else if (kind === 'textarea') c = h('textarea', { rows: 2, value: val || '', style: 'flex:1', oninput: function (e) { set(e.target.value); } });
    else if (kind === 'color') c = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(val) ? val : def, style: 'width:60px;flex:none', oninput: function (e) { set(e.target.value); } });
    else if (kind === 'select') c = h('select', { onchange: function (e) { set(e.target.value); sceneForm(); } }, (f[4] || []).map(function (o) { return h('option', { value: o, text: STEP_OPT[o] || o, selected: o === val }); }));
    else if (kind === 'actor') c = actorPicker(val, set, st.type === 'say' ? '— nobody on screen —' : '');
    else if (kind === 'emote') c = emotePicker(val, function (v) { set(v); sceneForm(); }, 'none', 'None (take it down)');
    else if (kind === 'npc') c = h('select', { style: 'flex:1', onchange: function (e) { set(e.target.value); } },
      [h('option', { value: '', text: '(pick an NPC)' })].concat(rows('objects').filter(isNpc).map(function (o) { return h('option', { value: o.id, text: (o.name || o.id) + ' (' + o.id + ')', selected: o.id === val }); })));
    else if (kind === 'image') c = h('div', { style: 'flex:1' }, imageControl(st, { key: key, type: 'image', help: f[3] }, val, set));
    else c = h('input', { type: 'text', value: val || '', style: 'flex:1', oninput: function (e) { set(e.target.value); } });
    return h('div', { className: 'row', style: 'margin:3px 0;align-items:flex-start', title: f[3] || '' }, h('span', { className: 'lootlbl', style: 'min-width:70px', text: STEP_LABEL[key] || key }), c);
  }
  function sceneForm() {
    var form = $('form'), keepTop = form.scrollTop; form.innerHTML = '';
    var r = rows('scenes')[curIndex];
    if (curIndex < 0 || !r) { form.appendChild(h('div', { className: 'empty', text: 'Select a scene, or click New.' })); return; }
    var steps = stepsOf(r), users = r.id ? sceneUsers(r.id) : [];
    function save(again) { persist(); if (again) sceneForm(); }
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('scenes', r) }), h('span', { className: 'pill', text: 'Scene' }),
      h('button', { className: 'primary', style: 'margin-left:auto', text: '▶ Play this scene', title: 'Open the game offline and play this scene at once (seen or not). What follows it in an action list only happens in play', disabled: !r.id, onclick: function () { tryScene(r.id); } }),
      h('button', { title: 'Delete this scene', text: '🗑 Delete', onclick: function () {
        if (!confirm('Delete this scene?' + (users.length ? ' ' + users.length + ' place' + (users.length === 1 ? ' starts' : 's start') + ' it; they will simply go on without it.' : ''))) return;
        rows('scenes').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    Schema.get('scenes').fields.forEach(function (fl) { if (fl.key === 'id' || fl.key === 'name') form.appendChild(fieldEl(r, fl)); });
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Started by' }),
      users.length ? h('div', null, users.map(function (u, n) {
        return h('a', { href: '#', text: u.what + ': ' + (u.row.name || u.row.id) + (n < users.length - 1 ? ', ' : ''), onclick: function (e) {
          e.preventDefault(); var t = u.t === 'objects' && isNpc(u.row) ? 'npcs' : u.t; type = t; curIndex = rows(u.t).indexOf(u.row); filter = ''; renderNav(); renderList(); renderForm(); } });
      })) : h('div', { className: 'help', text: 'Nothing yet. Put scene:' + (r.id || '<id>') + ' in any list of actions: a quest\'s "when it starts" or rewards, an objective\'s "when met", a dialogue answer, a trigger. Whatever comes after it in that list happens when the scene ends (watched or skipped), e.g. scene:' + (r.id || 'gate') + '; set_state:map_3.e9:open.' })));
    form.appendChild(h('div', { className: 'sub', text: 'Steps — played one after another' }));
    steps.forEach(function (st, i) {
      var k = stepKind(st.type), card = h('div', { className: 'dcard' + (sceneSel === i ? ' picked' : '') });
      card.appendChild(h('div', { className: 'row' },
        h('b', { style: 'font-size:12px;min-width:18px', text: String(i + 1) }),
        h('select', { style: 'flex:1', onchange: function (e) { st.type = e.target.value; save(true); } },
          (Content.SCENE_STEPS || []).map(function (sk) { return h('option', { value: sk.id, text: sk.name, selected: sk.id === st.type }); })),
        i ? h('label', { className: 'row', title: 'Starts at the same time as the step before, instead of after it (a camera move while a line is said)', style: 'font-size:12px;flex:none' },
          h('input', { type: 'checkbox', checked: isTrue(st['with']), onchange: function (e) { if (e.target.checked) st['with'] = true; else delete st['with']; save(); } }), h('span', { text: ' with the one before' })) : null,
        h('button', { text: '↑', title: 'Earlier', disabled: i === 0, onclick: function () { steps.splice(i - 1, 0, steps.splice(i, 1)[0]); save(true); } }),
        h('button', { text: '↓', title: 'Later', disabled: i === steps.length - 1, onclick: function () { steps.splice(i + 1, 0, steps.splice(i, 1)[0]); save(true); } }),
        h('button', { text: '⧉', title: 'Copy this step', onclick: function () { steps.splice(i + 1, 0, JSON.parse(JSON.stringify(st))); save(true); } }),
        h('button', { text: '✕', title: 'Remove this step', onclick: function () { steps.splice(i, 1); save(true); } })));
      if (!k) card.appendChild(h('div', { className: 'help', text: 'Unknown kind of step "' + st.type + '": the game leaves it out.' }));
      else k.fields.forEach(function (f) {
        if (st.type === 'camera' && st.to === 'me' && (f[0] === 'x' || f[0] === 'y')) return;      // (looking at the player: no tile)
        if (st.type === 'emote' && (((f[0] === 'x' || f[0] === 'y') && st.over !== 'tile') || (f[0] === 'npc' && st.over !== 'npc') || (f[0] === 'a' && st.over !== 'actor'))) return;   // (only what "over" needs)
        if (st.type === 'face' && f[0] === 'to' && st.dir !== 'actor') return;
        if (st.type === 'show' && f[0] === 'count' && st.a === 'me') return;                       // (there is one of you)
        card.appendChild(stepField(st, f));
      });
      if (k && stepHasTile(st) && typeof SceneMap !== 'undefined') card.appendChild(h('div', { className: 'row', style: 'margin:3px 0' }, h('span', { className: 'lootlbl', style: 'min-width:70px', text: '' }),
        h('button', { className: scenePick === i ? 'primary' : '', text: scenePick === i ? 'Now click the map…' : '📍 Pick on map', title: 'Then click the tile on the scene map (or drag this step\'s dot there)', disabled: !r.map,
          onclick: function () { scenePick = scenePick === i ? null : i; sceneSel = i; sceneForm(); renderQuestMap(); } }),
        r.map ? null : h('span', { className: 'note', text: ' pick the scene\'s map first (top of the map on the right)' })));
      form.appendChild(card);
    });
    form.appendChild(h('div', { className: 'row', style: 'margin:2px 0 8px' },
      (Content.SCENE_STEPS || []).map(function (sk) {
        return h('button', { text: '+ ' + sk.name, onclick: function () { var n = { type: sk.id }; sk.fields.forEach(function (f) { n[f[0]] = f[2]; }); steps.push(n); save(true); } });
      })));
    form.appendChild(h('div', { className: 'help', text: '"Stays after" (on Actor: show / walk): a monster becomes a real one where the scene leaves it, and the player really ends up where their figure was walked to; it happens in play only, not in ▶ Play this scene. Actors: an NPC that stands on the map is taken over where it stands the first time a step names it (the one nearest the player); a monster, or an NPC that is not on this map, must be brought in with "Actor: show" first. Everything actors do is only drawn: when the scene ends everyone is back where they really stand, so put real changes in the action list after scene:<id>. A scene starts with black bars and the HUD hidden, the camera on the player. A line or a picture with 0 seconds waits for a click (or Space). The player can always skip it (Esc twice, or the Skip button); each character sees it once. Monsters and other players are not drawn while it plays, and nothing can touch the player meanwhile.' }));
    Schema.get('scenes').fields.forEach(function (fl) { if (fl.key === 'notes') form.appendChild(fieldEl(r, fl)); });
    form.scrollTop = keepTop;
  }
  function dialogueForm() {
    var form = $('form'), keepTop = form.scrollTop; form.innerHTML = '';
    var r = rows('dialogues')[curIndex];
    if (curIndex < 0 || !r) { form.appendChild(h('div', { className: 'empty', text: 'Select a dialogue, or click New.' })); return; }
    var lines = linesOf(r);
    if (curLineOf !== r || !lines.some(function (n) { return n.id === curLineId; })) { curLineOf = r; curLineId = lines.length ? lines[0].id : ''; }
    function redraw() { dialogueForm(); questMapSoon(); }
    function save(again) { persist(); if (again) redraw(); }
    var users = dialogueUsers(r.id);
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('dialogues', r) }), h('span', { className: 'pill', text: 'Dialogue' }),
      h('button', { title: 'Delete this dialogue', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete this dialogue?' + (users.length ? ' ' + users.length + ' NPC' + (users.length === 1 ? ' uses' : 's use') + ' it: ' + (users.length === 1 ? 'it goes' : 'they go') + ' back to saying one line.' : ''))) return;
        rows('dialogues').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    Schema.get('dialogues').fields.forEach(function (fl) { if (fl.key === 'id' || fl.key === 'name') form.appendChild(fieldEl(r, fl)); });
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Used by' }),
      users.length ? h('div', null, users.map(function (o, n) {
        return h('a', { href: '#', text: (o.name || o.id) + (n < users.length - 1 ? ', ' : ''), onclick: function (e) { e.preventDefault(); type = 'npcs'; curIndex = rows('objects').indexOf(o); filter = ''; renderNav(); renderList(); renderForm(); } });
      })) : h('div', { className: 'help', text: 'No NPC yet. Pick this dialogue on an NPC\'s page (Story → NPCs); several NPCs can share one.' })));

    // the lines, as a strip to pick from (the map on the right picks too)
    form.appendChild(h('div', { className: 'sub', text: 'Lines — what the NPC can say' }));
    var strip = h('div', { className: 'dlines' });
    lines.forEach(function (n) {
      strip.appendChild(h('button', { className: n.id === curLineId ? 'on' : '', text: (isTrue(n.start) ? '▶ ' : '') + n.id, title: n.text || '(says nothing yet)',
        onclick: function () { curLineId = n.id; redraw(); renderQuestMap(); } }));
    });
    strip.appendChild(h('button', { className: 'primary', text: '+ New line', onclick: function () {
      var n = { id: freeId(lines, 'line'), text: '', answers: [] }; if (!lines.length) { n.id = 'hello'; n.start = true; }
      lines.push(n); curLineId = n.id; save(true); renderQuestMap();
    } }));
    form.appendChild(strip);

    var line = lines.filter(function (n) { return n.id === curLineId; })[0];
    if (line) {
      var card = h('div', { className: 'dcard' });
      card.appendChild(h('div', { className: 'row' },
        h('span', { className: 'lootlbl', text: 'Line id' }),
        h('input', { type: 'text', value: line.id, title: 'A short name for this line: answers lead to it by this id, and said:<id> asks whether it was said', onchange: function (e) {
          var v = String(e.target.value || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
          if (!v || lines.some(function (n) { return n !== line && n.id === v; })) { e.target.value = line.id; return; }
          lines.forEach(function (n) { n.answers.forEach(function (a) { if (a.to === line.id) a.to = v; }); });   // answers that lead here follow the new name
          line.id = v; curLineId = v; save(true); renderQuestMap();
        } }),
        h('button', { text: '🗑 Delete line', title: 'Delete this line. Answers that led to it will end the talk instead', onclick: function () {
          if (!confirm('Delete the line "' + line.id + '"?')) return;
          lines.splice(lines.indexOf(line), 1);
          lines.forEach(function (n) { n.answers.forEach(function (a) { if (a.to === line.id) a.to = ''; }); });
          curLineId = ''; save(true); renderQuestMap();
        } })));
      card.appendChild(h('div', { className: 'field' }, h('label', { text: 'What the NPC says' }),
        h('textarea', { rows: 3, value: line.text || '', placeholder: 'The words shown beside the NPC. A key in square brackets, like [E], is drawn as a key.', oninput: function (e) { line.text = e.target.value; save(); } })));
      var startTick = h('input', { type: 'checkbox', checked: isTrue(line.start), onchange: function (e) { if (e.target.checked) line.start = true; else { delete line.start; delete line['if']; } save(true); renderQuestMap(); } });
      card.appendChild(h('div', { className: 'row', style: 'margin-top:6px' },
        h('label', { className: 'tick', title: 'A conversation opens on the FIRST line ticked here (in the order of the strip above) whose condition holds. So a first meeting can differ from later ones: tick two lines, give the first the condition !talked' }, startTick, document.createTextNode('Can open the conversation'))));
      if (isTrue(line.start)) card.appendChild(h('div', { className: 'row' },
        h('span', { className: 'lootlbl', text: 'Only if' }),
        h('input', { type: 'text', value: line['if'] || '', placeholder: 'always (e.g. !talked for a first meeting)', title: COND_HELP, oninput: function (e) { var v = e.target.value.trim(); if (v) line['if'] = v; else delete line['if']; save(); } })));
      if (isTrue(line.start)) card.appendChild(h('div', { className: 'help', text: 'On a line that opens the conversation, the quests this NPC gives and takes back are listed among the answers by themselves. The first such line whose condition holds is used; move a line earlier with the arrows below.' }));
      if (isTrue(line.start)) {
        var li = lines.indexOf(line);
        card.appendChild(h('div', { className: 'row', style: 'margin-top:4px' },
          h('button', { text: '↑ Try earlier', disabled: li === 0, onclick: function () { lines.splice(li - 1, 0, lines.splice(li, 1)[0]); save(true); } }),
          h('button', { text: '↓ Try later', disabled: li === lines.length - 1, onclick: function () { lines.splice(li + 1, 0, lines.splice(li, 1)[0]); save(true); } })));
      }
      form.appendChild(card);

      form.appendChild(h('div', { className: 'sub', text: 'Answers — what the player can say to "' + line.id + '"' }));
      if (!line.answers.length) form.appendChild(h('div', { className: 'help', style: 'margin-bottom:6px', text: 'No answers: the player gets a single "Goodbye." that ends the talk.' }));
      line.answers.forEach(function (a, ai) {
        var ac = h('div', { className: 'dcard' });
        ac.appendChild(h('div', { className: 'row' },
          h('input', { type: 'text', value: a.text || '', placeholder: 'What the player says', oninput: function (e) { a.text = e.target.value; save(); } }),
          h('button', { text: '↑', title: 'Earlier in the list', disabled: ai === 0, onclick: function () { line.answers.splice(ai - 1, 0, line.answers.splice(ai, 1)[0]); save(true); } }),
          h('button', { text: '↓', title: 'Later in the list', disabled: ai === line.answers.length - 1, onclick: function () { line.answers.splice(ai + 1, 0, line.answers.splice(ai, 1)[0]); save(true); } }),
          h('button', { text: '✕', title: 'Remove this answer', onclick: function () { line.answers.splice(ai, 1); save(true); renderQuestMap(); } })));
        var known = !a.to || lines.some(function (n) { return n.id === a.to; });
        ac.appendChild(h('div', { className: 'row' },
          h('span', { className: 'lootlbl', text: 'Leads to' }),
          h('select', { style: known ? '' : 'border-color:var(--bad)', title: 'The line the NPC says next', onchange: function (e) {
            var v = e.target.value;
            if (v === '+') { var n = { id: freeId(lines, 'line'), text: '', answers: [] }; lines.push(n); v = n.id; }
            a.to = v; save(true); renderQuestMap();
          } },
            h('option', { value: '', text: '— ends the talk —', selected: !a.to }),
            known ? null : h('option', { value: a.to, text: a.to + ' (missing line)', selected: true }),
            lines.map(function (n) { return h('option', { value: n.id, text: n.id + (n.text ? ' — ' + String(n.text).replace(/\s+/g, ' ').slice(0, 40) : ''), selected: n.id === a.to }); }),
            h('option', { value: '+', text: '+ a new line…' })),
          a.to && known ? h('button', { text: 'Edit ›', title: 'Go to that line', onclick: function () { curLineId = a.to; redraw(); renderQuestMap(); } }) : null,
          h('label', { className: 'tick', title: 'Offered only once to each character: after it is picked it is gone for good' },
            h('input', { type: 'checkbox', checked: isTrue(a.once), onchange: function (e) { if (e.target.checked) a.once = true; else delete a.once; save(); questMapSoon(); } }), document.createTextNode('Once only')),
          h('label', { className: 'tick', title: 'Picking this answer opens the shop of the NPC being talked to (set on the NPC\'s page) and ends the talk. An NPC with no shop just goes on to the line above' },
            h('input', { type: 'checkbox', checked: isTrue(a.shop), onchange: function (e) { if (e.target.checked) a.shop = true; else delete a.shop; save(); } }), document.createTextNode('Opens the shop'))));
        ac.appendChild(h('div', { className: 'row' },
          h('span', { className: 'lootlbl', text: 'Only if' }),
          h('input', { type: 'text', value: a['if'] || '', placeholder: 'always (e.g. has:iron_key or !flag:paid)', title: COND_HELP, oninput: function (e) { var v = e.target.value.trim(); if (v) a['if'] = v; else delete a['if']; save(); } })));
        var does = rewardsField(a, { key: 'do', when: 'when this answer is picked', help: 'What picking this answer does: one row each (give something, start a quest). Other actions: take:item:n; gold:-5 (pay); flag:x; unflag:x; heal:n; teleport:map:x:y; message:text' });
        var lb = does.querySelector('label'); if (lb) lb.textContent = 'What it does';
        ac.appendChild(does);
        form.appendChild(ac);
      });
      form.appendChild(h('button', { className: 'primary', style: 'margin:2px 0 8px', text: '+ Add answer', onclick: function () {
        line.answers.push({ id: freeId(line.answers, 'a'), text: '', to: '' }); save(true); renderQuestMap();
      } }));
    }
    Schema.get('dialogues').fields.forEach(function (fl) { if (fl.key === 'notes') form.appendChild(fieldEl(r, fl)); });
    form.scrollTop = keepTop;
  }

  // ---------------------------------------------------------------- the form
  function renderForm() {
    rememberView();
    renderQuestMap();
    if (type === 'loot') return lootForm();
    if (type === 'kinds') return kindsForm();
    if (type === 'objects') return objForm();
    if (type === 'npcs') return npcForm();
    if (type === 'appearances') return appearanceForm();
    if (type === 'dialogues') return dialogueForm();
    if (type === 'shops') return shopForm();
    if (type === 'scenes') return sceneForm();
    var form = $('form'); form.innerHTML = '';
    if (curIndex < 0 || !rows(type)[curIndex]) { form.appendChild(h('div', { className: 'empty', text: 'Select a ' + (Schema.get(type).singular || Schema.get(type).label.toLowerCase().replace(/s$/, '')) + ', or click New.' })); return; }
    var r = rows(type)[curIndex], def = Schema.get(type), hiddenCount = 0;
    form.appendChild(h('div', { className: 'formhead' },
      h('h2', { text: rowLabel(type, r) }),
      h('span', { className: 'pill', text: def.label }),
      h('span', { className: 'sp', style: 'margin-left:auto' }),
      h('button', { title: 'Delete this record', text: '🗑 Delete', onclick: function () {
        if (type === 'itemTypes') {
          var used = rows('items').filter(function (i) { return r.id && i.type === r.id; }).length;
          if (used) { alert(used + ' item' + (used === 1 ? ' is' : 's are') + ' of type "' + r.id + '". Give ' + (used === 1 ? 'it' : 'them') + ' another type first.'); return; }
        }
        if (!confirm('Delete this ' + (def.singular || 'record') + '?')) return;
        rows(type).splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    def.fields.forEach(function (fl) {
      if (type === 'terrain' && (fl.key === 'sprite' || fl.key === 'autotile')) {
        if (fl.key === 'sprite') form.appendChild(tileModeField(r));   // a Base Tile / Autotile toggle replaces both
        return;
      }
      if (type === 'items' && !showAllItemFields && itemFieldHidden(r, fl)) { hiddenCount++; return; }
      form.appendChild(fieldEl(r, fl));
    });
    if (type === 'items' && (hiddenCount || showAllItemFields)) {
      form.appendChild(h('div', { className: 'note', style: 'margin-top:10px' },
        h('span', { text: showAllItemFields ? 'Showing every field. ' : hiddenCount + ' field' + (hiddenCount === 1 ? ' is' : 's are') + ' hidden because the type “' + r.type + '” does not use them. ' }),
        h('button', { text: showAllItemFields ? 'Hide unused fields' : 'Show all fields', onclick: function () { showAllItemFields = !showAllItemFields; renderForm(); } })));
    }
  }
  // Which tick on its type makes an item field worth showing. Fields not listed always show; a field that
  // already holds a value shows whatever the type says, so nothing set is ever out of sight.
  var showAllItemFields = false;
  var ITEM_FIELD_NEEDS = {
    slot: 'equip', worn_sprite: 'equip', worn_empty: 'shoot', worn_aim: 'shoot', worn_reload: 'shoot', default_tint: 'equip', hides_head: 'equip', hides_beard: 'equip', atk: 'equip', def: 'equip', equip_if: 'equip',
    range: 'shoot', ammo: 'shoot', ammo_cost: 'shoot', fire_ms: 'shoot', clip: 'shoot', reload_ms: 'shoot', fire_mode: 'shoot', aim: 'shoot',
    heal: 'consume', mp: 'consume', hunger: 'consume', thirst: 'consume', toxicity: 'consume', leaves: 'consume', on_use: 'consume', cooldown_s: 'consume',
    places: 'place',
    noise: 'equip',
    throw_range: 'throw', throw_area: 'throw', throw_power: 'throw', throw_status: 'throw', throw_status_ms: 'throw', throw_noise: 'throw', burns: 'throw',
    penetration: 'ammo', falloff: 'ammo', recover: 'ammo', tool: 'tool', structure_dmg: 'tool', durability: 'tool', material_wear: 'tool', repair_cost: 'tool', repair_station: 'tool', salvage: 'tool'
  };
  function typePropDefs(ty) {
    var v = ty ? ty.properties : null;
    if (typeof v === 'string') { try { v = JSON.parse(v || '[]'); } catch (e) { v = []; } }
    return Array.isArray(v) ? v : [];
  }
  function itemFieldHidden(r, fl) {
    var ty = itemTypeRow(r.type); if (!ty) return false;
    if (fl.key === 'props') return !typePropDefs(ty).length;
    var need = ITEM_FIELD_NEEDS[fl.key]; if (!need || Content.bool(ty[need])) return false;
    if (need === 'throw' && Content.bool(r.throwable)) return false;   // thrown by its own tick (a rock that is a material)
    var v = r[fl.key];
    return v == null || v === '' || v === 0 || v === '0' || v === false || v === fl.def;
  }

  // Extra choices the owner adds in Config: item_types (Items → type) and object_kinds (Objects → kind), comma-separated.
  function configList(key) {
    var row = (T.Config || []).filter(function (c) { return c.key === key; })[0];
    return String(row && row.value != null ? row.value : '').split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function optionsOf(t, fl) {
    if (t === 'items' && fl.key === 'type') { var ids = rows('itemTypes').map(function (x) { return x.id; }).filter(Boolean); if (ids.length) return ids; }
    var opts = (fl.options || []).slice(), key = t === 'objects' && fl.key === 'kind' ? 'object_kinds' : '';
    if (key) configList(key).forEach(function (x) { if (opts.indexOf(x) < 0) opts.push(x); });
    return opts;
  }
  function fieldEl(r, fl) {
    var control, val = r[fl.key];
    if (fl.type === 'looks') return looksField(r, fl);
    if (fl.type === 'goals') return goalsField(r, fl);
    if (fl.type === 'rewards') return rewardsField(r, fl);
    if (fl.type === 'aim') return aimField(r, fl);
    if (fl.type === 'items' || (fl.type === 'list' && fl.of === 'item:count')) return itemsField(r, fl);
    if (fl.type === 'list' && fl.of === 'skill@level') return skillsField(r, fl);
    if (fl.type === 'materials') return materialsField(r, fl);
    if (fl.type === 'choice') return choiceField(r, fl);
    function change(v) {
      var was = r[fl.key]; r[fl.key] = v;
      if (type === 'itemTypes' && fl.key === 'id' && was && v && !rows('itemTypes').some(function (t) { return t !== r && t.id === was; }))
        rows('items').forEach(function (i) { if (i.type === was) i.type = v; });          // items follow a renamed type
      persist();
      if (fl.key === idField(type) || fl.key === 'name') { renderNav(); renderList(); }
      else if (type === 'items' && fl.key === 'type') { renderList(); renderForm(); }       // other fields apply to the new type
      else if (type === 'items' && fl.key === 'throwable') renderForm();                    // its throw fields show or go
    }
    if (fl.type === 'propdefs') return propDefsField(r, fl);
    if (fl.type === 'itemprops') return itemPropsField(r, fl);
    if (fl.type === 'bool') {
      control = h('input', { type: 'checkbox', checked: !!val, onchange: function (e) { change(e.target.checked); } });
      return h('div', { className: 'field', title: fl.help || '' }, h('label', { className: 'row' }, control, h('span', { text: '  ' + fl.key }), fl.help ? h('span', { className: 'help', text: '— ' + fl.help }) : null));
    } else if (fl.type === 'number') {
      control = h('input', { type: 'number', value: val == null ? '' : val, oninput: function (e) { change(e.target.value === '' ? '' : Number(e.target.value)); } });
    } else if (fl.type === 'textarea' || fl.type === 'json') {
      control = h('textarea', { rows: 3, value: val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : val),
        onchange: function (e) {
          var v = e.target.value;
          if (fl.type === 'json' && v.trim()) { try { JSON.parse(v); e.target.style.borderColor = ''; } catch (x) { e.target.style.borderColor = 'var(--bad)'; } }
          change(v);
        } });
    } else if (fl.type === 'select') {
      var opts = optionsOf(type, fl); if (val && opts.indexOf(val) < 0) opts.unshift(val);
      control = h('select', { onchange: function (e) { change(e.target.value); } },
        h('option', { value: '', text: '—' }), opts.map(function (o) { return h('option', { value: o, text: o, selected: o === val }); }));
    } else if (fl.type === 'tint') {                                        // one of the page's colour ramps (Tint.TINTS), shown as swatches (not the water and lava ones: those are for terrain)
      var tints = [{ value: '', label: 'no tint', visual: function () { return h('span', { className: 'swatch none' }); } }]
        .concat(tintNames().filter(function (t) { return !/^(water|lava)/.test(t); }).map(function (t) { return { value: t, label: t, visual: function () { return swatch(t); } }; }));
      if (val && tintNames().indexOf(val) < 0) tints.push({ value: val, label: val + ' (unknown colour)', visual: function () { return h('span', { className: 'swatch none' }); } });
      control = visualPicker(val || '', tints, function (v) { change(v); renderList(); renderForm(); }, 'colour…');
    } else if (fl.type === 'image') {
      control = imageControl(r, fl, val, change);
    } else if (fl.type === 'ref') {
      control = pickSelect(fl.ref === 'loot' ? lootTableNames()                                     // (a loot table is the name its rows share, not a record)
        : (rows(fl.ref) || []).map(function (x) { return { id: x[idField(fl.ref)], name: x.name }; }), val, change);
    } else {
      control = h('input', { type: 'text', value: val == null ? '' : val, oninput: function (e) { change(e.target.value); } });
    }
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key + (fl.type === 'ref' ? '  → ' + fl.ref : '') }), control,
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }

  // Item Types → properties: the extra settings a type gives its items (name, kind of value, default, help).
  function propDefsField(r, fl) {
    var list = typePropDefs(r).map(function (d) { return { name: d.name || '', type: d.type || 'text', def: d.def == null ? '' : d.def, notes: d.notes || '' }; });
    var box = h('div', {});
    function save() { r[fl.key] = list.length ? JSON.stringify(list) : ''; persist(); }
    function draw() {
      box.innerHTML = '';
      box.appendChild(h('datalist', { id: 'dl_ptype' }, ['text', 'number', 'bool', 'select:a|b|c', 'item'].map(function (t) { return h('option', { value: t }); })));
      list.forEach(function (d, i) {
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('input', { value: d.name, placeholder: 'name', style: 'flex:1.2;min-width:0', title: 'Property name', onchange: function (e) { d.name = e.target.value.trim().replace(/\s+/g, '_'); e.target.value = d.name; save(); } }),
          h('input', { value: d.type, list: 'dl_ptype', placeholder: 'type', style: 'flex:1;min-width:0', title: 'text, number, bool, select:a|b|c or item', onchange: function (e) { d.type = e.target.value.trim() || 'text'; save(); } }),
          h('input', { value: d.def, placeholder: 'default', style: 'flex:1;min-width:0', title: 'Value when the item leaves it unset', oninput: function (e) { d.def = e.target.value; save(); } }),
          h('input', { value: d.notes, placeholder: 'help (optional)', style: 'flex:1.6;min-width:0', oninput: function (e) { d.notes = e.target.value; save(); } }),
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: '+ Add property', onclick: function () { list.push({ name: '', type: 'text', def: '', notes: '' }); draw(); } }));
    }
    draw();
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }), box, fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }
  // Items → the values for those properties (kept in the item's props, only what differs from the default).
  function itemPropsField(r, fl) {
    var ty = itemTypeRow(r.type), defs = typePropDefs(ty).filter(function (d) { return d && d.name; }), vals = {};
    try { vals = typeof r.props === 'string' ? JSON.parse(r.props || '{}') : (r.props || {}); } catch (e) { vals = {}; }
    var box = h('div', { className: 'field' }, h('div', { className: 'sub', text: ((ty && ty.name) || r.type || 'Type') + ' properties' }));
    if (!defs.length) box.appendChild(h('div', { className: 'help', text: 'This type defines none. Add them in Item Types.' }));
    defs.forEach(function (d) {
      var k = { property: d.name, type: d.type || 'text', def: d.def };
      box.appendChild(h('div', { className: 'field', title: d.notes || '' }, h('label', { text: d.name }),
        propInput(k, vals[d.name] === undefined && k.type === 'bool' ? Content.bool(d.def) : vals[d.name], function (v) {
          if (v === undefined || v === '') delete vals[d.name]; else vals[d.name] = v;
          r.props = Object.keys(vals).length ? JSON.stringify(vals) : ''; persist();
        }),
        d.notes ? h('div', { className: 'help', text: d.notes }) : null));
    });
    return box;
  }

  // A dropdown fed by the draft itself: the tool tags items carry, or the station ids of craft objects.
  function choicesFor(from) {
    var out = [], seen = {};
    function add(value, label) { if (value && !seen[value]) { seen[value] = out.length + 1; out.push({ value: value, names: [label] }); } else if (value) out[seen[value] - 1].names.push(label); }
    if (from === 'tools') (T.Items || []).forEach(function (it) {
      Content.toolTags(it, itemTypeRow(it.type)).forEach(function (tag) { add(tag, it.name || it.id); });   // its tags, or itself when its type is a tool type
    });
    if (from === 'stations') (T.Objects || []).forEach(function (o) { if (o.kind === 'craft') add(String(propsObj(o).station || '').trim() || String(o.id || ''), o.name || o.id); });   // its station id, or itself
    return out;
  }
  // Pick one of the records of another list: a real dropdown (it scrolls, however long the list — the type-ahead
  // list this used to be could not be scrolled once it overflowed). Sorted by name, each with its id. A value
  // that names nothing any more stays selectable and is marked, so it is seen and not silently dropped.
  // list = [{id, name}] (or plain ids).
  function pickSelect(list, value, onchange, style, blank) {
    var cur = value == null ? '' : String(value);
    var opts = (list || []).map(function (x) { return typeof x === 'object' ? { id: String(x.id == null ? '' : x.id), name: String(x.name || x.id || '') } : { id: String(x), name: String(x) }; })
      .filter(function (x) { return x.id; })
      .sort(function (p, q) { var a = p.name.toLowerCase(), b = q.name.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; });
    var known = !cur || opts.some(function (x) { return x.id === cur; });
    return h('select', { style: (style || '') + (known ? '' : ';border-color:var(--bad)'), title: known ? '' : 'Nothing has this id any more', onchange: function (e) { onchange(e.target.value); } },
      h('option', { value: '', text: blank || '\u2014' }),
      known ? null : h('option', { value: cur, text: cur + ' (missing)', selected: true }),
      opts.map(function (x) { return h('option', { value: x.id, text: x.name === x.id ? x.id : x.name + '  (' + x.id + ')', selected: x.id === cur }); }));
  }
  function choiceField(r, fl) {
    var val = r[fl.key] == null ? '' : String(r[fl.key]), opts = choicesFor(fl.from);
    var known = !val || opts.some(function (o) { return o.value === val; });
    var none = !opts.length ? (fl.from === 'tools' ? 'No tool yet: make an item of a tool type (Item Types → tool tick), or give any item a tag in Items → tool.' : 'No station yet: make an object of kind craft.') : '';
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }),
      h('select', { style: known ? '' : 'border-color:var(--bad)', onchange: function (e) { r[fl.key] = e.target.value; persist(); renderForm(); } },
        h('option', { value: '', text: '— none —' }),
        known ? null : h('option', { value: val, text: val + ' (missing)', selected: true }),
        opts.map(function (o) { return h('option', { value: o.value, text: o.value + '  (' + o.names.join(', ') + ')', selected: o.value === val }); })),
      fl.help ? h('div', { className: 'help', text: fl.help }) : null,
      none ? h('div', { className: 'help', style: 'color:var(--bad)', text: none }) : null);
  }

  /** Rows of tool dropdowns (the tool tags items carry) and "+ Add tool". text = "axe, saw"; onSave(text) on every change. */
  function toolsBox(text, onSave) {
    var list = String(text == null ? '' : text).split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean);
    var opts = choicesFor('tools'), box = h('div', {});
    function save() { onSave(list.filter(function (g, i) { return g && list.indexOf(g) === i; }).join(', ')); }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        var known = !g || opts.some(function (o) { return o.value === g; });
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('select', { style: 'flex:1;min-width:0' + (known ? '' : ';border-color:var(--bad)'), title: known ? '' : 'No item carries this tool tag', onchange: function (e) { list[i] = e.target.value; save(); draw(); } },
            h('option', { value: '', text: '— pick a tool —' }),
            known ? null : h('option', { value: g, text: g + ' (missing)', selected: true }),
            opts.filter(function (o) { return o.value === g || list.indexOf(o.value) < 0; }).map(function (o) { return h('option', { value: o.value, text: o.value + '  (' + o.names.join(', ') + ')', selected: o.value === g }); })),
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: '+ Add tool', onclick: function () { list.push(''); draw(); } }));
      if (!opts.length) box.appendChild(h('div', { className: 'help', style: 'color:var(--bad)', text: 'No tool yet: make an item of a tool type (Item Types → tool tick), or give any item a tag in Items → tool.' }));
    }
    draw();
    return box;
  }

  // A list of "item + amount" rows (blueprint cost, recipe inputs/outputs). Stored as the same text the rules
  // read ("wood:4, nails:2"), so nothing else changes; a row with no item picked yet is simply not saved.
  // A multiplier per material: a material dropdown + a number, one row each ("wood:3, stone:0.5").
  var MATERIALS = ['wood', 'metal', 'stone', 'glass', 'flesh'];
  function materialsField(r, fl) {
    var list = String(r[fl.key] == null ? '' : r[fl.key]).split(/[,;]/).map(function (part) {
      var bits = part.trim().split(':'), v = Number(bits[1]);
      return bits[0] ? { m: bits[0].trim(), v: v >= 0 ? v : 1 } : null;
    }).filter(Boolean), box = h('div', {}), wearing = fl.key === 'material_wear';   // (wear per hit, not a damage multiplier)
    function save() { r[fl.key] = list.filter(function (g) { return g.m; }).map(function (g) { return g.m + ':' + g.v; }).join(', '); persist(); }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('select', { style: 'flex:1;min-width:0', onchange: function (e) { g.m = e.target.value; save(); } },
            h('option', { value: '', text: '— pick a material —' }),
            MATERIALS.concat(g.m && MATERIALS.indexOf(g.m) < 0 ? [g.m] : []).map(function (m) { return h('option', { value: m, text: m, selected: m === g.m }); })),
          h('span', { text: wearing ? '−' : '×' }),
          h('input', { type: 'number', min: 0, step: wearing ? 1 : 0.5, value: g.v, style: 'width:80px', title: wearing ? 'Durability lost per hit' : 'Damage multiplier',
            oninput: function (e) { var v = Number(e.target.value); g.v = v >= 0 ? v : 1; save(); } }),
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: '+ Add material', onclick: function () { list.push({ m: '', v: wearing ? 1 : 2 }); draw(); } }));
    }
    draw();
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }), box,
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }
  function itemsField(r, fl) {
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }),
      itemsBox(r[fl.key], function (text) { r[fl.key] = text; persist(); }),
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }
  // A quest's objectives: one row each — what kind (a dropdown of every kind there is, Content.GOAL_TYPES), which
  // one (a dropdown of the monsters / items / NPCs / objects / blueprints, or a map and a spot for a place), how
  // many, and optionally how it should read in the game. Stored as the JSON list Content.parseGoals reads; a quest
  // written by hand as text ("kill:rat:5; have:hide:3") is read the same way and saved as the list.
  function goalsField(r, fl) {
    var list = Content.parseGoals(r[fl.key]).map(function (g) { return Object.assign({}, g); }), box = h('div', {});
    function byName(a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id)); }
    function pool(ref) {
      if (ref === 'ui') return Content.UI_PARTS.slice();        // (the game's own windows: a fixed list)
      var src = ref === 'monsters' ? T.Monsters : ref === 'items' ? T.Items : ref === 'blueprints' ? T.Blueprints : ref === 'place' ? T.Maps : T.Objects;
      src = (src || []).filter(function (x) { return x.id; });
      if (ref === 'npcs') src = src.filter(function (x) { return x.kind === 'npc'; });
      return src.slice().sort(byName);
    }
    function save() {
      // no target to save: a kind that has none, or one left at "anything will do"
      var noTarget = function (g) { var k = Content.GOAL_TYPES.filter(function (k) { return k.id === g.type; })[0] || {}; return k.ref === 'none' || (k.any && (!g.ref || g.ref === '*')); };
      var out = list.filter(function (g) { return g.ref || noTarget(g); }).map(function (g) {
        var kind = Content.GOAL_TYPES.filter(function (k) { return k.id === g.type; })[0], o = noTarget(g) ? { type: g.type } : { type: g.type, ref: g.ref };
        if (kind && kind.count) o.need = Math.max(1, parseInt(g.need, 10) || 1);
        if (g.type === 'goto') { o.x = parseInt(g.x, 10) || 0; o.y = parseInt(g.y, 10) || 0; o.r = Math.max(0, parseInt(g.r, 10) || 0); }
        if (g.label) o.label = g.label;
        if (g.opt) o.opt = true;
        if (g.onDone) o.on_done = g.onDone;
        return o;
      });
      r[fl.key] = out.length ? JSON.stringify(out) : '';
      persist();
    }
    function num(g, key, title, min, label) {
      return [h('span', { className: 'lootlbl', text: label }),
        h('input', { type: 'number', min: min, step: 1, value: g[key] == null ? min : g[key], style: 'width:62px', title: title,
          oninput: function (e) { var q = parseInt(e.target.value, 10); g[key] = q >= min ? q : min; save(); } })];
    }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        var kind = Content.GOAL_TYPES.filter(function (k) { return k.id === g.type; })[0] || Content.GOAL_TYPES[0];
        var opts = pool(kind.ref), known = !g.ref || (kind.any && g.ref === '*') || opts.some(function (x) { return x.id === g.ref; });
        var what = kind.ref === 'place' ? 'map' : kind.ref === 'npcs' ? 'person' : kind.ref === 'ui' ? 'window' : kind.ref.replace(/s$/, '');
        // with no list to pick from (the maps are kept by the map editor), the id is typed
        var target = kind.ref === 'none' ? h('span', { className: 'lootlbl', style: 'flex:1', text: 'anything will do' }) : opts.length || kind.ref !== 'place'
          ? h('select', { style: 'flex:1;min-width:0' + (known ? '' : ';border-color:var(--bad)'), title: known ? '' : 'Nothing has this id', onchange: function (e) { g.ref = e.target.value; save(); draw(); } },
              kind.any ? h('option', { value: '*', text: 'Anything will do', selected: !g.ref || g.ref === '*' }) : h('option', { value: '', text: '— pick a ' + what + ' —' }),
              known ? null : h('option', { value: g.ref, text: g.ref + ' (missing)', selected: true }),
              opts.map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: x.id === g.ref }); }))
          : h('input', { type: 'text', value: g.ref || '', placeholder: 'map id, e.g. map_3', style: 'flex:1;min-width:0', title: 'The id of the map, as the map editor shows it',
              oninput: function (e) { g.ref = e.target.value.trim(); save(); } });
        var top = h('div', { className: 'row', style: 'margin-bottom:3px' },
          h('select', { style: 'width:210px', title: 'What kind of thing must be done', onchange: function (e) { g.type = e.target.value; g.ref = ''; save(); draw(); } },
            Content.GOAL_TYPES.map(function (k) { return h('option', { value: k.id, text: k.name, selected: k.id === kind.id }); })),
          target,
          kind.count ? num(g, 'need', 'How many', 1, '×') : null,
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } }));
        box.appendChild(top);
        var more = h('div', { className: 'row', style: 'margin:0 0 8px 0' },
          kind.id === 'goto' ? num(g, 'x', 'The spot: its column on the map (the map editor shows it under the cursor)', 0, 'x') : null,
          kind.id === 'goto' ? num(g, 'y', 'The spot: its row', 0, 'y') : null,
          kind.id === 'goto' ? num(g, 'r', 'How close counts, in tiles (0 = that very tile)', 0, 'within') : null,
          h('input', { type: 'text', value: g.label || '', placeholder: kind.id === 'goto' ? 'Shown as, e.g. Reach the old mill' : 'Shown as (optional), e.g. Clear the cellar', style: 'flex:1;min-width:0',
            title: 'How this objective reads in the game. Empty = made up from its target',
            oninput: function (e) { g.label = e.target.value; save(); } }),
          h('label', { className: 'lootlbl', style: 'display:flex;align-items:center;gap:4px;white-space:nowrap', title: 'An optional objective is counted and shown, but the quest can be handed in without it' },
            h('input', { type: 'checkbox', checked: !!g.opt, onchange: function (e) { g.opt = e.target.checked; save(); } }), 'optional'));
        box.appendChild(more);
        // When met: start a quest (a tutorial step) the moment this objective is done. Other actions written by hand are kept.
        var then = String(g.onDone || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
        var startId = (then.filter(function (x) { return /^quest:[^:]+$/.test(x); })[0] || '').slice(6), rest = then.filter(function (x) { return !/^quest:[^:]+$/.test(x) || x.slice(6) !== startId; });
        var quests = (T.Quests || []).filter(function (x) { return x.id && x.id !== r.id; });
        box.appendChild(h('div', { className: 'row', style: 'margin:-4px 0 10px 0' },
          h('span', { className: 'lootlbl', text: 'When met, start' }),
          h('select', { style: 'flex:1;min-width:0', title: 'A quest that starts the moment this objective is done (a tutorial step, say). It is shown in a "New quest" window, and closed with this quest if the player gives it up',
            onchange: function (e) { g.onDone = (e.target.value ? ['quest:' + e.target.value] : []).concat(rest).join('; '); save(); } },
            h('option', { value: '', text: '— nothing —' }),
            startId && !quests.some(function (x) { return x.id === startId; }) ? h('option', { value: startId, text: startId + ' (missing quest)', selected: true }) : null,
            quests.map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')' + (x.tutorial === true || x.tutorial === 'TRUE' || x.tutorial === 'true' ? ' · tutorial' : ''), selected: x.id === startId }); })),
          rest.length ? h('span', { className: 'lootlbl', title: 'Written by hand; kept as it is', text: '+ ' + rest.join('; ') }) : null));
        if (!opts.length && kind.ref !== 'place' && kind.ref !== 'none' && !kind.any) box.appendChild(h('div', { className: 'help', style: 'color:var(--bad);margin:-4px 0 8px', text: kind.ref === 'npcs'
          ? 'Nobody to pick yet: make an object of kind npc under Objects, and place it with the map editor.' : 'Nothing to pick yet: make one under ' + (kind.ref.charAt(0).toUpperCase() + kind.ref.slice(1)) + '.' }));
      });
      box.appendChild(h('button', { text: '+ Add objective', onclick: function () { list.push({ type: 'kill', ref: '', need: 1 }); draw(); } }));
    }
    draw();
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }), box,
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }
  // A quest's rewards: one row each — what (a dropdown: XP, gold, every item, or "start another quest") and how
  // much. Stored as the action list the rules run when the quest is handed in ("xp:100; gold:20; give:axe:1;
  // quest:next_one"). Any other action written there by hand (flag:x, message:…) is kept, in the box underneath.
  function rewardsField(r, fl) {
    var list = [], other = [];
    String(r[fl.key] == null ? '' : r[fl.key]).split(';').forEach(function (cmd) {
      cmd = cmd.trim(); if (!cmd) return;
      var a = cmd.split(':'), n = parseInt(a[a.length - 1], 10);
      if (a[0] === 'xp' && a.length === 2) list.push({ what: 'xp', qty: n > 0 ? n : 1 });
      else if (a[0] === 'gold' && a.length === 2 && n > 0) list.push({ what: 'gold', qty: n });
      else if (a[0] === 'give' && a[1]) list.push({ what: 'item:' + a[1], qty: parseInt(a[2], 10) > 0 ? parseInt(a[2], 10) : 1 });
      else if (a[0] === 'quest' && a[1] && a.length === 2) list.push({ what: 'quest', id: a[1] });
      else if (a[0] === 'scene' && a[1] && a.length === 2) list.push({ what: 'scene', id: a[1].trim() });
      else other.push(cmd);
    });
    var scenes = (T.Scenes || []).filter(function (x) { return x.id; });
    var items = (T.Items || []).filter(function (x) { return x.id; }).slice().sort(function (a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id)); });
    var quests = (T.Quests || []).filter(function (x) { return x.id && x.id !== r.id; }), box = h('div', {});
    function save() {
      var out = list.map(function (g) {
        if (g.what === 'xp') return 'xp:' + g.qty;
        if (g.what === 'gold') return 'gold:' + g.qty;
        if (g.what === 'quest') return g.id ? 'quest:' + g.id : '';
        if (g.what === 'scene') return g.id ? 'scene:' + g.id : '';
        return g.what.slice(0, 5) === 'item:' && g.what.length > 5 ? 'give:' + g.what.slice(5) + ':' + g.qty : '';
      }).filter(Boolean).concat(other);
      r[fl.key] = out.join('; ');
      persist();
    }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        var itemId = g.what.slice(0, 5) === 'item:' ? g.what.slice(5) : '', known = !itemId || items.some(function (x) { return x.id === itemId; });
        var second = g.what === 'scene'
          ? h('select', { style: 'flex:1;min-width:0', title: 'The scene the player watches. The rows below it, and the Other actions, happen when it ends (watched or skipped). Each character sees it once', onchange: function (e) { g.id = e.target.value; save(); } },
              h('option', { value: '', text: '— pick a scene —' }),
              g.id && !scenes.some(function (x) { return x.id === g.id; }) ? h('option', { value: g.id, text: g.id + ' (missing scene)', selected: true }) : null,
              scenes.map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: x.id === g.id }); }))
          : g.what === 'quest'
          ? h('select', { style: 'flex:1;min-width:0', title: 'The quest that starts ' + (fl.when || 'when this one is handed in') + '. It is shown to the player in a "New quest" window', onchange: function (e) { g.id = e.target.value; save(); } },
              h('option', { value: '', text: '— pick a quest —' }),
              g.id && !quests.some(function (x) { return x.id === g.id; }) ? h('option', { value: g.id, text: g.id + ' (missing quest)', selected: true }) : null,
              quests.map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: x.id === g.id }); }))
          : [h('span', { className: 'lootlbl', text: '×' }),
             h('input', { type: 'number', min: 1, step: 1, value: g.qty, style: 'width:80px', title: 'How much',
               oninput: function (e) { var q = parseInt(e.target.value, 10); g.qty = q > 0 ? q : 1; save(); },
               onchange: function (e) { e.target.value = g.qty; } })];
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('select', { style: (g.what === 'quest' || g.what === 'scene' ? 'width:210px' : 'flex:1;min-width:0') + (known ? '' : ';border-color:var(--bad)'), title: known ? 'What is given' : 'There is no item with this id',
            onchange: function (e) { g.what = e.target.value; if (g.what !== 'quest' && g.what !== 'scene' && !(g.qty > 0)) g.qty = 1; save(); draw(); } },
            h('option', { value: 'xp', text: 'XP', selected: g.what === 'xp' }),
            h('option', { value: 'gold', text: 'Gold', selected: g.what === 'gold' }),
            h('option', { value: 'quest', text: 'Start another quest', selected: g.what === 'quest' }),
            h('option', { value: 'scene', text: 'Play a scene', selected: g.what === 'scene' }),
            known ? null : h('option', { value: g.what, text: itemId + ' (missing item)', selected: true }),
            h('optgroup', { label: 'Items' }, items.map(function (x) { return h('option', { value: 'item:' + x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: 'item:' + x.id === g.what }); }))),
          second,
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: fl.when ? '+ Add' : '+ Add reward', onclick: function () { list.push({ what: list.some(function (g) { return g.what === 'xp'; }) ? 'gold' : 'xp', qty: 10 }); save(); draw(); } }));
      box.appendChild(h('div', { className: 'row', style: 'margin-top:6px' },
        h('span', { className: 'lootlbl', text: 'Other actions' }),
        h('input', { type: 'text', value: other.join('; '), placeholder: 'optional, e.g. flag:met_mayor; message:Well done', style: 'flex:1;min-width:0',
          title: 'Anything else to run when the quest is handed in, as an action list: flag:x; unflag:x; heal:n; teleport:map:x:y; set_state:key:state; message:text',
          oninput: function (e) { other = e.target.value.split(';').map(function (x) { return x.trim(); }).filter(Boolean); save(); } })));
    }
    draw();
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }), box,
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
  }
  // A class's skills: a skill dropdown + the level it is learned at, one row each. Stored as the text the rules read
  // ("charge@1, cleave@3"); a row with no skill picked yet is simply not saved.
  function skillsField(r, fl) {
    var list = String(r[fl.key] == null ? '' : r[fl.key]).split(/[,;]/).map(function (part) {
      var bits = part.trim().split('@'), lv = parseInt(bits[1], 10);
      return bits[0] ? { id: bits[0].trim(), lv: lv > 0 ? lv : 1 } : null;
    }).filter(Boolean);
    var skills = (T.Skills || []).filter(function (x) { return x.id; }), box = h('div', {});
    function save() { r[fl.key] = list.filter(function (g) { return g.id; }).map(function (g) { return g.id + '@' + g.lv; }).join(', '); persist(); }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        var known = !g.id || skills.some(function (x) { return x.id === g.id; });
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('select', { style: 'flex:1;min-width:0' + (known ? '' : ';border-color:var(--bad)'), title: known ? '' : 'There is no skill with this id', onchange: function (e) { g.id = e.target.value; save(); draw(); } },
            h('option', { value: '', text: '— pick a skill —' }),
            known ? null : h('option', { value: g.id, text: g.id + ' (missing skill)', selected: true }),
            skills.filter(function (x) { return x.id === g.id || !list.some(function (q) { return q.id === x.id; }); })
              .map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: x.id === g.id }); })),
          h('span', { className: 'lootlbl', text: 'from level' }),
          h('input', { type: 'number', min: 1, step: 1, value: g.lv, style: 'width:70px', title: 'The level at which the class learns it',
            oninput: function (e) { var q = parseInt(e.target.value, 10); g.lv = q > 0 ? q : 1; save(); },
            onchange: function (e) { e.target.value = g.lv; } }),
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: '+ Add skill', onclick: function () { list.push({ id: '', lv: 1 }); draw(); } }));
      if (!skills.length) box.appendChild(h('div', { className: 'help', style: 'color:var(--bad)', text: 'No skills yet: make one under Skills.' }));
    }
    draw();
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }), box,
      h('div', { className: 'help', text: 'The skills this class learns, and the level each comes at.' }));
  }
  /** The rows themselves: an item dropdown + an amount each, and "+ Add item". text = "wood:2, nails:1"; onSave(text) on every change. */
  function itemsBox(text, onSave) {
    var list = String(text == null ? '' : text).split(/[,;]/).map(function (part) {
      var bits = part.trim().split(':'), q = parseInt(bits[1], 10);
      return bits[0] ? { item: bits[0].trim(), qty: q > 0 ? q : 1 } : null;
    }).filter(Boolean);
    var items = (T.Items || []).filter(function (x) { return x.id; }), box = h('div', {});
    function save() { onSave(list.filter(function (g) { return g.item; }).map(function (g) { return g.item + ':' + g.qty; }).join(', ')); }
    function draw() {
      box.innerHTML = '';
      list.forEach(function (g, i) {
        var known = !g.item || items.some(function (x) { return x.id === g.item; });
        box.appendChild(h('div', { className: 'row', style: 'margin-bottom:4px' },
          h('select', { style: 'flex:1;min-width:0' + (known ? '' : ';border-color:var(--bad)'), title: known ? '' : 'There is no item with this id', onchange: function (e) { g.item = e.target.value; save(); draw(); } },
            h('option', { value: '', text: '— pick an item —' }),
            known ? null : h('option', { value: g.item, text: g.item + ' (missing item)', selected: true }),
            items.map(function (x) { return h('option', { value: x.id, text: (x.name || x.id) + '  (' + x.id + ')', selected: x.id === g.item }); })),
          h('input', { type: 'number', min: 1, step: 1, value: g.qty, style: 'width:80px', title: 'Amount',
            oninput: function (e) { var q = parseInt(e.target.value, 10); g.qty = q > 0 ? q : 1; save(); },
            onchange: function (e) { e.target.value = g.qty; } }),
          h('button', { text: '✕', title: 'Remove', onclick: function () { list.splice(i, 1); save(); draw(); } })));
      });
      box.appendChild(h('button', { text: '+ Add item', onclick: function () { list.push({ item: '', qty: 1 }); draw(); } }));
    }
    draw();
    return box;
  }

  // Terrain is EITHER a plain sprite OR an autotile; a segmented toggle shows only the matching field and
  // clears the other, so a row is never ambiguous.
  function fieldDef(t, key) { return (Schema.get(t).fields || []).filter(function (f) { return f.key === key; })[0]; }
  function tileModeField(r) {
    var wrap = h('div', { className: 'field' });
    var mode = r.autotile ? 'autotile' : 'base';
    function render() {
      wrap.innerHTML = '';
      wrap.appendChild(h('label', { text: 'Tile type' }));
      wrap.appendChild(h('div', { className: 'seg' },
        h('button', { type: 'button', className: 'segbtn' + (mode === 'base' ? ' on' : ''), text: 'Base Tile',
          onclick: function () { if (mode === 'base') return; mode = 'base'; r.autotile = ''; persist(); render(); } }),
        h('button', { type: 'button', className: 'segbtn' + (mode === 'autotile' ? ' on' : ''), text: 'Autotile',
          onclick: function () { if (mode === 'autotile') return; mode = 'autotile'; r.sprite = ''; persist(); render(); } })));
      if (mode === 'base') {
        wrap.appendChild(fieldEl(r, fieldDef('terrain', 'sprite')));
      } else {
        var af = fieldEl(r, fieldDef('terrain', 'autotile'));
        wrap.appendChild(af);
        // show the whole autotile sheet below the picker, same idea as the Base Tile preview
        var prev = h('img', { className: 'autoprev', alt: '', onerror: function () { this.style.display = 'none'; } });
        function tsImage(id) { var ts = (rows('tilesets') || []).filter(function (x) { return x[idField('tilesets')] === id; })[0]; return ts && ts.image ? spritePath(ts.image) : ''; }
        function showAuto(id) { var s = tsImage(id); if (s) { prev.src = s; prev.style.display = ''; } else { prev.removeAttribute('src'); prev.style.display = 'none'; } }
        var inp = af.querySelector('input');
        if (inp) inp.addEventListener('input', function (e) { showAuto(e.target.value); });
        showAuto(r.autotile);
        wrap.appendChild(prev);
      }
    }
    render();
    return wrap;
  }

  // ---------------------------------------------------------------- objects (structured editor)
  function propsObj(o) {
    if (typeof o.properties === 'string') { try { return JSON.parse(o.properties || '{}'); } catch (e) { return {}; } }
    return o.properties || {};
  }
  function setProp(o, key, val) {
    var p = propsObj(o);
    if (val === undefined || val === '' || (Array.isArray(val) && !val.length)) delete p[key]; else p[key] = val;
    o.properties = Object.keys(p).length ? JSON.stringify(p) : '';
    persist();
  }
  // The properties the Kinds tab defines for a kind (type/default/notes), excluding `states`.
  function kindRows(kindName) {
    return (T.Kinds || []).filter(function (r) { return String(r.kind) === String(kindName) && String(r.property) !== 'states'; })
      .map(function (r) { return { property: String(r.property || ''), type: String(r.type || ''), def: r['default'], notes: String(r.notes || '') }; });
  }
  function propInput(k, value, onchange) {
    var type = k.type || 'text';
    if (type === 'bool') return h('input', { type: 'checkbox', checked: !!value, onchange: function (e) { onchange(e.target.checked); } });
    if (type === 'number') return h('input', { type: 'number', value: value == null ? '' : value, placeholder: k.def == null ? '' : String(k.def), oninput: function (e) { onchange(e.target.value === '' ? undefined : Number(e.target.value)); } });
    if (type.indexOf('select:') === 0) {
      var opts = type.slice(7).split('|');
      return h('select', { onchange: function (e) { onchange(e.target.value); } },
        [h('option', { value: '', text: '—' })].concat(opts.map(function (o) { return h('option', { value: o, text: o, selected: o === value }); })));
    }
    if (type === 'item' || type === 'loot_table' || type === 'monster') {
      var ids = type === 'item' ? (T.Items || []).map(function (x) { return { id: x.id, name: x.name }; })
              : type === 'loot_table' ? lootTableNames() : (T.Monsters || []).map(function (x) { return { id: x.id, name: x.name }; });
      return pickSelect(ids, value, onchange, 'flex:1');
    }
    return h('input', { value: value == null ? '' : value, oninput: function (e) { onchange(e.target.value); } });
  }

  function objForm() {
    var form = $('form'); form.innerHTML = '';
    if (curIndex < 0 || !rows('objects')[curIndex]) { form.appendChild(h('div', { className: 'empty', text: 'Select an object, or click New.' })); return; }
    var o = rows('objects')[curIndex], p = propsObj(o), statesInput = null;
    if (isNpc(o)) { type = 'npcs'; renderNav(); renderList(); return npcForm(); }   // (made an NPC: it moves to the NPCs panel)
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('objects', o) }), h('span', { className: 'pill', text: 'Objects' }),
      h('button', { title: 'Delete this object', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete this object?')) return; rows('objects').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    // base fields (the raw `properties` blob is replaced by the structured sections below)
    Schema.get('objects').fields.forEach(function (fl) {
      if (fl.key === 'properties') return;
      var el = fieldEl(o, fl);
      if (fl.key === 'kind') { var sel = el.querySelector('select'); if (sel) sel.addEventListener('change', function () { setTimeout(objForm, 0); }); }
      if (fl.key === 'sprite_states') statesInput = el.querySelector('input');
      if (fl.key === 'sprite' && o.kind === 'door') {
        // A door has two pictures, one under the other: sprite-closed is the plain `sprite` field, sprite-open
        // is the "open" entry of sprite_states (this picker just edits that entry).
        el.querySelector('label').textContent = 'sprite-closed';
        var stPairs = function () { var out = []; String(o.sprite_states || '').split(';').forEach(function (q) { var i = q.indexOf('='); if (i > 0) out.push([q.slice(0, i).trim(), q.slice(i + 1).trim()]); }); return out; };
        var openNow = (stPairs().filter(function (q) { return q[0] === 'open'; })[0] || [])[1] || '';
        form.appendChild(h('div', { className: 'field' },
          h('label', { text: 'sprite-open' }),
          imageControl(o, { key: 'sprite_states' }, openNow, function (v) {
            var list = stPairs().filter(function (q) { return q[0] !== 'open'; }); if (v) list.push(['open', v]);
            o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
            if (statesInput) statesInput.value = o.sprite_states;
          }),
          h('div', { className: 'help', text: 'Shown while the door is open (e.g. the empty frame). Leave empty and an open door is just a hole in the wall.' })));
      }
      if (fl.key === 'sprite' && o.kind === 'door') form.insertBefore(el, form.lastChild); else form.appendChild(el);
      if (fl.key === 'sprite' && o.kind === 'door') {
        // On a N-S wall a door is seen edge-on and shown as a doorstep on the floor: its own two pictures for that,
        // the "step" and "step_open" entries of sprite_states.
        var stepPick = function (key, label, help) {
          var now = (stPairs().filter(function (q) { return q[0] === key; })[0] || [])[1] || '';
          return h('div', { className: 'field' }, h('label', { text: label }),
            imageControl(o, { key: 'sprite_states' }, now, function (v) {
              var list = stPairs().filter(function (q) { return q[0] !== key; }); if (v) list.push([key, v]);
              o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
              if (statesInput) statesInput.value = o.sprite_states;
            }),
            h('div', { className: 'help', text: help }));
        };
        form.appendChild(h('div', { className: 'sub', text: 'On a north-south wall — the doorstep' }));
        form.appendChild(stepPick('step', 'doorstep-closed', 'Shown, lying on the floor across the wall line, when this door is placed on a north-south wall (in the map editor or built by a player). Empty = the sprite-closed picture is laid down instead.'));
        form.appendChild(stepPick('step_open', 'doorstep-open', 'The same doorstep while the door is open. Empty = the doorstep-closed picture.'));
      }
      if (fl.key === 'sprite' && o.kind !== 'door' && propsObj(o).layer !== 'wall') {
        // Other directions: the main sprite is the object FACING SOUTH; these are the "north" and "side" entries of
        // sprite_states. With either one set the object can be turned (map editor and build mode: T / Shift+wheel).
        var dirPairs = function () { var out = []; String(o.sprite_states || '').split(';').forEach(function (q) { var i = q.indexOf('='); if (i > 0) out.push([q.slice(0, i).trim(), q.slice(i + 1).trim()]); }); return out; };
        var dirPick = function (key, label, help) {
          var now = (dirPairs().filter(function (q) { return q[0] === key; })[0] || [])[1] || '';
          return h('div', { className: 'field' }, h('label', { text: label }),
            imageControl(o, { key: 'sprite_states' }, now, function (v) {
              var list = dirPairs().filter(function (q) { return q[0] !== key; }); if (v) list.push([key, v]);
              o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
              if (statesInput) statesInput.value = o.sprite_states;
            }),
            h('div', { className: 'help', text: help }));
        };
        // Other looks: the same object drawn differently (five trees, three rocks). Entries v1, v2, … of sprite_states;
        // the map editor goes through them with N or Shift+wheel before painting.
        // A row per look, each with its own Remove, and "+ Add look" for one more: as many as wanted. A look keeps its
        // name (v3 stays v3 when v2 is removed), so the maps that already use it are not disturbed.
        var lookBox = h('div', {}), lookOpen = [];                 // lookOpen: rows added just now, still without a picture
        var lookKeys = function () {
          var have = dirPairs().filter(function (q) { return /^v\d+$/.test(q[0]); }).map(function (q) { return q[0]; });
          lookOpen.forEach(function (k) { if (have.indexOf(k) < 0) have.push(k); });
          return have.sort(function (x, y) { return Number(x.slice(1)) - Number(y.slice(1)); });
        };
        var drawLooks = function () {
          lookBox.innerHTML = '';
          var keys = lookKeys();
          keys.forEach(function (k, n) {
            var row = dirPick(k, 'look ' + (n + 2), '');
            row.appendChild(h('button', { text: 'Remove this look', onclick: function () {
              var list = dirPairs().filter(function (q) { return q[0] !== k; });
              o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
              if (statesInput) statesInput.value = o.sprite_states;
              lookOpen = lookOpen.filter(function (q) { return q !== k; });
              drawLooks();
            } }));
            lookBox.appendChild(row);
          });
          lookBox.appendChild(h('div', { className: 'field' },
            h('button', { text: '+ Add look', onclick: function () {
              var top = Math.max.apply(null, [0].concat(lookKeys().map(function (q) { return Number(q.slice(1)); })));
              lookOpen.push('v' + (top + 1)); drawLooks();
            } }),
            h('div', { className: 'help', text: 'The main sprite is look 1' + (keys.length ? '; this object has ' + (keys.length + 1) + ' looks.' : '.') + ' In the map editor, N or Shift+wheel goes through the looks before you paint. Nothing else about the object changes.' })));
        };
        form.appendChild(h('div', { className: 'sub', text: 'Other looks (optional) — the same object drawn differently' }));
        drawLooks(); form.appendChild(lookBox);
        form.appendChild(h('div', { className: 'sub', text: 'Other directions (optional) — makes the object turnable' }));
        form.appendChild(dirPick('north', 'sprite facing north', 'The main sprite above is the object facing south (towards the camera). This one is its back.'));
        form.appendChild(dirPick('side', 'sprite facing side', 'Facing east. West is this picture mirrored, so three pictures cover all four directions. Turn with T or Shift+wheel in the map editor and in build mode.'));
      }
    });
    // Footprint — the solid tiles this object blocks (bottom-left anchored). w×h, default 1×1.
    // Non-walkable objects block their whole footprint, not just the anchor tile. Width auto-fills
    // from the sprite so a wide object blocks its whole base without extra typing.
    form.appendChild(h('div', { className: 'sub', text: 'Footprint — solid tiles this blocks (from the bottom-left)' }));
    var fpW = h('input', { type: 'number', min: 1, value: p.width == null ? '' : p.width, style: 'width:70px', title: 'Width in tiles', oninput: function (e) { setProp(o, 'width', e.target.value === '' ? undefined : Number(e.target.value)); } });
    form.appendChild(h('div', { className: 'lootrow' },
      h('span', { className: 'lootlbl', text: 'w' }), fpW,
      h('span', { className: 'lootlbl', text: 'h' }), h('input', { type: 'number', min: 1, value: p.height == null ? '' : p.height, style: 'width:70px', title: 'Height in tiles', oninput: function (e) { setProp(o, 'height', e.target.value === '' ? undefined : Number(e.target.value)); } }),
      h('span', { className: 'note', text: '(blank = 1 tile; width auto-fills from the sprite)' })));
    form.appendChild(h('div', { className: 'help', text: 'The sprite is centred over this width, so a sprite wider than its footprint straddles the tiles — e.g. a 2-tile (64px) sprite with width 1 sits centred on a single tile.' }));
    if (p.width == null && o.sprite) {                       // detect the sprite’s tile-width and prefill it
      var im = new Image();
      im.onload = function () {
        if (propsObj(o).width != null) return;               // the user typed one meanwhile
        var tiles = Math.max(1, Math.round((im.naturalWidth / (Number(o.frames) || 1)) / 32));
        if (tiles > 1) { setProp(o, 'width', tiles); fpW.value = tiles; }
      };
      im.src = spritePath(o.sprite);
    }
    // Draw order relative to the player, and one-way passability for walkable objects.
    form.appendChild(h('div', { className: 'sub', text: 'Drawing & one-way movement' }));
    var drawMode = p.draw === 'over' || p.draw === 'under' ? p.draw : 'auto';
    form.appendChild(h('div', { className: 'field', title: 'Where the object is painted relative to characters' },
      h('label', { text: 'Draw order' }),
      h('div', { className: 'seg' }, ['auto', 'over', 'under'].map(function (m) {
        return h('button', { type: 'button', className: 'segbtn' + (drawMode === m ? ' on' : ''),
          text: m === 'auto' ? 'Auto' : m === 'over' ? 'Over player' : 'Under player',
          onclick: function () { setProp(o, 'draw', m === 'auto' ? undefined : m); objForm(); } });
      })),
      h('div', { className: 'help', text: 'Auto: base behind the player, tall tops in front. Over: always in front (foreground). Under: always behind.' })));
    form.appendChild(h('div', { className: 'field', title: 'Nudge the sprite up or down without moving its tile' },
      h('label', { text: 'Vertical nudge (px)' }),
      h('input', { type: 'number', value: p.offset_y == null ? '' : p.offset_y, style: 'width:70px', title: 'Pixels: negative = up, positive = down', oninput: function (e) { setProp(o, 'offset_y', e.target.value === '' ? undefined : Number(e.target.value)); } }),
      h('div', { className: 'help', text: 'Shifts the sprite vertically in pixels (negative = up, positive = down) — e.g. -6 to sit a centred object slightly higher on its tile.' })));
    form.appendChild(h('div', { className: 'field', title: 'Nudge the sprite left or right without moving its tile' },
      h('label', { text: 'Horizontal nudge (px)' }),
      h('input', { type: 'number', value: p.offset_x == null ? '' : p.offset_x, style: 'width:70px', title: 'Pixels: negative = left, positive = right', oninput: function (e) { setProp(o, 'offset_x', e.target.value === '' ? undefined : Number(e.target.value)); } }),
      h('div', { className: 'help', text: 'Shifts the sprite horizontally in pixels (negative = left, positive = right) — handy to line a door or window up on its wall.' })));
    form.appendChild(h('div', { className: 'field', title: 'Foliage: the picture stays planted at its foot and its top leans slowly from side to side' },
      h('label', { className: 'row' },
        h('input', { type: 'checkbox', checked: !!p.sway, onchange: function (e) { setProp(o, 'sway', e.target.checked ? true : undefined); objForm(); } }),
        h('span', { text: '  sways in the wind' }), h('span', { className: 'help', text: '— trees, bushes, plants. Only how it is drawn' })),
      p.sway ? h('div', { className: 'lootrow', style: 'margin-top:4px' },
        h('span', { className: 'lootlbl', text: 'strength' }),
        h('input', { type: 'number', min: 0.1, step: 0.1, placeholder: '1', value: p.sway === true ? '' : p.sway, style: 'width:70px', title: 'How far it leans: 1 = normal, 0.5 = half, 2 = double. Config foliage_sway scales every one (0 = off)', oninput: function (e) { var v = Number(e.target.value); setProp(o, 'sway', e.target.value === '' || !(v > 0) || v === 1 ? true : v); } })) : null));
    form.appendChild(h('div', { className: 'field', title: 'Block leaving/entering this walkable object in a direction (one-way)' },
      h('label', { text: 'Can pass (walkable objects only)' }),
      h('div', { className: 'lootrow' }, [['n', 'N'], ['e', 'E'], ['s', 'S'], ['w', 'W']].map(function (d) {
        var open = propsObj(o)['pass_' + d[0]] !== false;
        return h('label', { className: 'row', style: 'margin-right:8px' },
          h('input', { type: 'checkbox', checked: open, title: d[1], onchange: function (e) { setProp(o, 'pass_' + d[0], e.target.checked ? undefined : false); } }),
          h('span', { text: ' ' + d[1] }));
      })),
      h('div', { className: 'help', text: 'Unticked = you cannot move that way across the object (e.g. a ledge you drop off but can’t climb). Ignored if the object isn’t walkable. Set it for the object facing south: when the object is turned, the blocked sides turn with it.' })));
    // Placement layer — works for ANY kind (deco, switch, sign…): a normal object, one hung on a wall
    // face, or a flat ground decal. This writes properties.layer, read by the renderer (layerOf).
    // Durability — can this object be damaged and broken? Stored in properties (hp, armor, material, ...).
    form.appendChild(h('div', { className: 'sub', text: 'Durability' }));
    var numProp = function (key, title) { return h('input', { type: 'number', min: 0, value: p[key] == null ? '' : p[key], style: 'width:70px', title: title,
      oninput: function (e) { setProp(o, key, e.target.value === '' ? undefined : Number(e.target.value)); } }); };
    form.appendChild(h('div', { className: 'lootrow' },
      h('span', { className: 'lootlbl', text: 'health' }), numProp('hp', 'Health. Empty or 0 = cannot be damaged'),
      h('span', { className: 'lootlbl', text: 'armor' }), numProp('armor', 'Taken off every hit'),
      h('span', { className: 'lootlbl', text: 'made of' }),
      h('select', { title: 'Decides how hard blows, bullets, blasts and fire land', onchange: function (e) { setProp(o, 'material', e.target.value === 'wood' ? undefined : e.target.value); } },
        ['wood', 'metal', 'stone', 'glass'].map(function (m) { return h('option', { value: m, text: m, selected: (p.material || 'wood') === m }); }))));
    form.appendChild(h('div', { className: 'field' },
      h('label', { className: 'row' },
        h('input', { type: 'checkbox', checked: !!p.indestructible, onchange: function (e) { setProp(o, 'indestructible', e.target.checked ? true : undefined); } }),
        h('span', { text: '  never breaks' }), h('span', { className: 'help', text: '— even with health set (quest doors and the like)' })),
      h('label', { text: 'salvage' }),
      itemsBox(p.salvage, function (text) { setProp(o, 'salvage', text || undefined); }),
      h('label', { text: 'harvest' }),
      itemsBox(p.harvest, function (text) { setProp(o, 'harvest', text || undefined); }),
      h('div', { className: 'lootrow', style: 'margin-top:4px' },
        h('span', { className: 'lootlbl', text: 'back after (s)' }),
        h('input', { type: 'number', min: 0, value: p.respawn_s == null ? '' : p.respawn_s, style: 'width:70px', title: 'Seconds until it grows back (empty = the Config default)', oninput: function (e) { setProp(o, 'respawn_s', e.target.value === '' ? undefined : Number(e.target.value)); } })),
      h('label', { text: 'needs tool' }),
      toolsBox(p.harvest_tool, function (text) { setProp(o, 'harvest_tool', text || undefined); }),
      h('div', { className: 'help', text: 'Tools that can harvest it by hand: any ONE of them is enough (none = bare hands). Lists the tool tags your items carry.' }),
      h('label', { text: 'without the tool' }),
      itemsBox(p.harvest_bare, function (text) { setProp(o, 'harvest_bare', text || undefined); }),
      h('div', { className: 'lootrow', style: 'margin-top:4px' },
        h('span', { className: 'lootlbl', text: 'over (blows)' }),
        h('input', { type: 'number', min: 1, value: p.harvest_bare_hits == null ? '' : p.harvest_bare_hits, style: 'width:70px', title: 'How many blows bring the whole list out, each time round (empty = 4; 1 = the whole list on every blow)', oninput: function (e) { setProp(o, 'harvest_bare_hits', e.target.value === '' ? undefined : Number(e.target.value)); } })),
      h('div', { className: 'help', text: 'Optional: what someone gets by hitting it WITHOUT one of those tools in hand (a tree punched bare-handed: a few branches and fibres). This does not damage it and never runs out: the list comes out once every that many blows. The harvest above is what cutting it down with the tool gives. Empty = it cannot be harvested without the tool.' }),
      h('label', { text: 'picked by hand — gives' }),
      itemsBox(p.pick, function (text) { setProp(o, 'pick', text || undefined); }),
      h('div', { className: 'lootrow', style: 'margin-top:4px' },
        h('span', { className: 'lootlbl', text: 'picks' }),
        h('input', { type: 'number', min: 1, placeholder: '1', value: p.pick_times == null ? '' : p.pick_times, style: 'width:70px', title: 'How many times it can be picked before it is empty (empty = 1)', oninput: function (e) { setProp(o, 'pick_times', e.target.value === '' ? undefined : Number(e.target.value)); } }),
        h('span', { className: 'lootlbl', text: 'full again after (s)' }),
        h('input', { type: 'number', min: 1, placeholder: '300', value: p.pick_s == null ? '' : p.pick_s, style: 'width:70px', title: 'Seconds after it was emptied until it is full again (empty = Config pick_refill_s, 300)', oninput: function (e) { setProp(o, 'pick_s', e.target.value === '' ? undefined : Number(e.target.value)); } })),
      h('label', { text: 'picture when empty' }),
      (function () {
        var pairs = function () { var out = []; String(o.sprite_states || '').split(';').forEach(function (q) { var i = q.indexOf('='); if (i > 0) out.push([q.slice(0, i).trim(), q.slice(i + 1).trim()]); }); return out; };
        return imageControl(o, { key: 'sprite_states' }, (pairs().filter(function (q) { return q[0] === 'empty'; })[0] || [])[1] || '', function (v) {
          var list = pairs().filter(function (q) { return q[0] !== 'empty'; }); if (v) list.push(['empty', v]);
          o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
          if (statesInput) statesInput.value = o.sprite_states;
        });
      })(),
      h('div', { className: 'help', text: 'A berry bush: using it (F or a click; hold to keep going) gives this list each time, that many times. Then it is empty — it shows the empty picture and nothing can be done with it — until it is full again. It is never damaged and never disappears, and it is shared: whoever picks it empties it for everyone. For objects with no use of their own (not chests, doors, NPCs…). Empty = it is not picked.' }),
      h('label', { text: 'drops nearby' }),
      itemsBox(p.drops, function (text) { setProp(o, 'drops', text || undefined); }),
      h('div', { className: 'lootrow', style: 'margin-top:4px' },
        h('span', { className: 'lootlbl', text: 'every (s)' }),
        h('input', { type: 'number', min: 0, placeholder: '0', value: p.drop_s == null ? '' : p.drop_s, style: 'width:70px', title: 'Seconds between two drops from one of these. Empty or 0 = it drops nothing', oninput: function (e) { setProp(o, 'drop_s', e.target.value === '' ? undefined : Number(e.target.value)); } }),
        h('span', { className: 'lootlbl', text: 'within (tiles)' }),
        h('input', { type: 'number', min: 0, placeholder: '2', value: p.drop_radius == null ? '' : p.drop_radius, style: 'width:70px', title: 'How far from it things may land (empty = 2, at most 6). They land on ground at its own height when there is any free', oninput: function (e) { setProp(o, 'drop_radius', e.target.value === '' ? undefined : Number(e.target.value)); } }),
        h('span', { className: 'lootlbl', text: 'at most' }),
        h('input', { type: 'number', min: 0, placeholder: '3', value: p.drop_max == null ? '' : p.drop_max, style: 'width:70px', title: 'The most of its items that may lie within that distance; nothing more falls until some are picked up (empty = 3)', oninput: function (e) { setProp(o, 'drop_max', e.target.value === '' ? undefined : Number(e.target.value)); } })),
      h('div', { className: 'help', text: 'Optional: items that fall from it by themselves and lie on the ground nearby to be picked up (a tree shedding branches). One of the list each time, on a free tile. Nothing falls while it is cut down. Only while someone is on the map; time away is caught up, within limits.' }),
      h('div', { className: 'help', text: 'Harvest: set it (with health) on a tree, a wreck, a bush — breaking it gives these items, and it comes back after a while instead of being gone for good.' }),
      h('div', { className: 'help', text: 'Health 0 or empty = this object cannot be damaged. With health, players can break it by attacking, shooting or blasting it; whoever breaks it gets the salvage. Spawns, triggers, teleports, signs and NPCs never break.' })));
    if (o.kind === 'stairs') {
      form.appendChild(h('div', { className: 'sub', text: 'Staircase' }));
      form.appendChild(h('div', { className: 'help', text: 'A staircase joins the floor it stands on to the floor above. It always runs along 2 tiles, starting at its own tile (the foot): players walk onto the foot, up the run, and step off the far end onto the floor above. Its picture is ONE step tile; the game repeats it for the second tile, one tile further along and one tile higher. The main sprite is a step climbing NORTH; in sprite_states, "side=" is a step climbing east (west is mirrored) and "south=" one climbing south. A direction with no picture of its own uses the main sprite; with no art at all it is drawn as plain steps. In the map editor, T or Shift+wheel turns it.' }));
    }
    if (o.kind === 'claim') {
      form.appendChild(h('div', { className: 'sub', text: 'Base claim' }));
      form.appendChild(h('div', { className: 'field' },
        h('label', { text: 'claim radius (tiles)' }),
        h('input', { type: 'number', min: 1, value: p.claim_radius == null ? '' : p.claim_radius, placeholder: '8', oninput: function (e) { setProp(o, 'claim_radius', e.target.value === '' ? undefined : Number(e.target.value)); } }),
        h('div', { className: 'help', text: 'A player who builds this (through a blueprint) owns the land this many tiles around it: only they and the members they add can build, open built doors and crates, or damage things there. A claim cannot be placed near the map\'s own doors, chests, teleports or arrival point.' })));
    }
    if (o.kind === 'craft') {
      form.appendChild(h('div', { className: 'sub', text: 'Crafting station' }));
      form.appendChild(h('div', { className: 'field' },
        h('label', { text: 'station id' }),
        h('input', { type: 'text', value: p.station || '', placeholder: o.id || 'workbench', oninput: function (e) { setProp(o, 'station', e.target.value.trim() || undefined); } }),
        h('div', { className: 'help', text: 'Optional. Empty = recipes name this object itself as their station. Give several objects the same id (e.g. workbench) when any of them should do for a recipe.' })));
      // A cooker (campfire, furnace): its recipes are made in it over time, with fuel
      form.appendChild(h('div', { className: 'field' },
        h('label', {}, h('input', { type: 'checkbox', checked: !!p.cooks, onchange: function (e) { setProp(o, 'cooks', e.target.checked ? true : undefined); objForm(); } }), ' cooks over time (raw materials, fuel, cooked)'),
        h('div', { className: 'help', text: 'Ticked: using it opens the cooking window — your bag, its recipes, and its cells for raw materials, fuel and what comes out. Turned on, it burns fuel (Items → fuel_s) and makes the recipe the player picked in it (Cook) out of what is in its raw cells, one batch every time_s seconds. Nothing is cooked that was not picked. Those recipes are then no longer made by hand in the crafting panel.' })));
      if (p.cooks) {
        [['raw_slots', 'Raw material cells'], ['fuel_slots', 'Fuel cells'], ['out_slots', 'Cooked cells']].forEach(function (q) {
          form.appendChild(h('div', { className: 'field' }, h('label', { text: q[1] }),
            h('input', { type: 'number', min: 1, max: 60, value: p[q[0]] || '', placeholder: '20', oninput: function (e) { var v = Math.round(Number(e.target.value)); setProp(o, q[0], v > 0 ? Math.min(60, v) : undefined); } })));
        });
        var ckPairs = function () { var out = []; String(o.sprite_states || '').split(';').forEach(function (q) { var i = q.indexOf('='); if (i > 0) out.push([q.slice(0, i).trim(), q.slice(i + 1).trim()]); }); return out; };
        var ckPick = function (key, label, help) {
          var now = (ckPairs().filter(function (q) { return q[0] === key; })[0] || [])[1] || '';
          return h('div', { className: 'field' }, h('label', { text: label }),
            imageControl(o, { key: 'sprite_states' }, now, function (v) {
              var list = ckPairs().filter(function (q) { return q[0] !== key; }); if (v) list.push([key, v]);
              o.sprite_states = list.map(function (q) { return q[0] + '=' + q[1]; }).join('; '); persist();
            }),
            h('div', { className: 'help', text: help }));
        };
        form.appendChild(ckPick('fueled', 'sprite-fueled', 'Shown when there is fuel in it but it is not burning. The main sprite above is the empty one.'));
        form.appendChild(ckPick('burning', 'sprite-lit', 'Shown while it burns. For an animated fire use ONE picture with the frames side by side, and set frames and frame_ms above: the empty and fueled pictures, being a single tile wide, stay still.'));
      }
    }
    form.appendChild(h('div', { className: 'sub', text: 'Placement layer' }));
    var layer = ['wall', 'ground_decal', 'cliff'].indexOf(p.layer) >= 0 ? p.layer : 'object';
    form.appendChild(h('div', { className: 'field', title: 'How this object is placed and drawn' },
      h('label', { text: 'Layer' }),
      h('div', { className: 'seg' }, [['object', 'Object'], ['wall', 'Wall-mounted'], ['ground_decal', 'Ground decal'], ['cliff', 'On a cliff face']].map(function (m) {
        return h('button', { type: 'button', className: 'segbtn' + (layer === m[0] ? ' on' : ''), text: m[1],
          onclick: function () {
            // A wall object sits on the wall, not the floor, so default it to walkable + see-through so it
            // doesn't block or wall off the tile in front. You can still toggle those back above.
            if (m[0] === 'wall' || m[0] === 'cliff') { o.walkable = true; o.blocks_sight = false; }
            setProp(o, 'layer', m[0] === 'object' ? undefined : m[0]); objForm();
          } });
      })),
      h('div', { className: 'help', text: 'On a cliff face: a decoration (vines, rocks, a cave mouth) put anywhere on the face of raised ground, as many as you like: in the map editor, with Raised on, click on a cliff. Object: normal, y-sorted on the ground. Wall-mounted: hangs on a wall’s visible (south-facing) face — in the map editor, paint it on the Objects layer and it snaps to the nearest wall. Choosing this sets the object walkable and see-through, so it doesn’t block the floor tile in front (the wall itself still stops you); tick those back on above if you want a solid, view-blocking panel. Ground decal: a flat mark baked into the ground.' })));
    if (layer === 'wall') {
      // What the object does to the wall it sits on. A door is always a door (kind = door); anything else can
      // be a plain mount, a window (see through, can't walk through) or an archway (always open).
      var opening = o.kind === 'door' ? 'door' : (p.opening === 'window' || p.opening === 'arch' ? p.opening : 'none');
      form.appendChild(h('div', { className: 'field' },
        h('label', { text: 'Opening in the wall' }),
        o.kind === 'door'
          ? h('div', { className: 'help', text: 'Door: closed, it blocks walking and sight like the wall; open, you can walk and see through.' })
          : h('div', { className: 'seg' }, [['none', 'None (hangs on the wall)'], ['window', 'Window'], ['arch', 'Archway']].map(function (m) {
              return h('button', { type: 'button', className: 'segbtn' + (opening === m[0] ? ' on' : ''), text: m[1],
                onclick: function () { setProp(o, 'opening', m[0] === 'none' ? undefined : m[0]); objForm(); } });
            })),
        o.kind === 'door' ? null : h('div', { className: 'help', text: 'None: decoration or a switch on the wall; the wall behaves as normal. Window: you can see and shoot through it but not walk through. Archway: an always-open gap you can walk and see through.' })));
      form.appendChild(h('div', { className: 'field', title: 'Raise the object off the wall base, in whole tiles' },
        h('label', { text: 'Raise off base (tiles)' }),
        h('input', { type: 'number', step: '0.1', value: p.mount == null ? '' : p.mount, style: 'width:70px', title: '0 = standing on the wall base; each tile lifts it higher',
          oninput: function (e) { setProp(o, 'mount', e.target.value === '' ? undefined : Number(e.target.value)); } }),
        h('div', { className: 'help', text: 'The sprite is drawn at its own size with its bottom edge on the wall base. This lifts it up in whole tiles (e.g. 1 for a window a tile up); fine-tune with the pixel nudges above. Each placement can override it in the map editor.' })));
    }
    // Container loot
    if (o.kind === 'container') form.appendChild(containerLoot(o));
    // All kind properties, collapsible
    form.appendChild(kindPropsSection(o));
  }

  // An NPC's outfit: the exact pictures it wears, listed bottom to top (body first) — properties.outfit =
  // [{path, tint, type}] (type only says which pictures the picker offers). With one, the game draws the NPC as a
  // figure like a player, turned towards whoever looks at it; its plain sprite is then what the map editor shows.
  function npcOutfit(o) {
    var fit = (propsObj(o).outfit || []).map(function (l) { return { type: l.type || '', path: l.path || '', tint: l.tint || '' }; });
    function isHair(l) { return l.type === 'hair' || l.type === 'beard' || /(^|\/)(hair|beard)_[^\/]*$/.test(l.path); }
    function save() {
      fit.forEach(function (l) { if (l.path && !l.tint && isHair(l)) l.tint = 'hair_brown'; });   // hair shows only through its colour: never leave it without one
      setProp(o, 'outfit', fit.map(function (l) { var q = { path: l.path }; if (l.tint) q.tint = l.tint; if (l.type) q.type = l.type; return q; }));
      npcForm(); npcList();
    }
    var box = h('div', { className: 'field' }, h('div', { className: 'sub', text: 'Outfit — what this NPC looks like' }),
      h('div', { className: 'help', text: 'The pictures this NPC wears, listed bottom to top (the body first, then clothes, hair, what it holds). The game and the map editor draw it as a figure like a player: it breathes, and turns to face whoever is near.' }));
    fit.forEach(function (l, i) {
      var L = { type: l.type, options: [{ sprite: l.path }] }, tid = layerType(L);
      box.appendChild(h('div', { className: 'lootrow' },
        h('select', { style: 'width:auto;min-width:92px', title: 'Layer type — filters which sprites you can pick', onchange: function (e) { l.type = e.target.value; save(); } },
          LAYER_TYPES.map(function (t) { return h('option', { value: t.id, text: t.label, selected: t.id === tid }); })),
        spritePicker(L, l.path, function (v) { l.path = v; save(); }),
        tid === 'body' ? skinPicker(l.tint, function (v) { l.tint = v; save(); }) : colourPicker(l.tint, function (v) { l.tint = v; save(); }),
        h('button', { title: 'Earlier in the list (drawn behind)', text: '↑', disabled: i === 0, onclick: function () { fit.splice(i - 1, 0, fit.splice(i, 1)[0]); save(); } }),
        h('button', { title: 'Later in the list (drawn in front)', text: '↓', disabled: i === fit.length - 1, onclick: function () { fit.splice(i + 1, 0, fit.splice(i, 1)[0]); save(); } }),
        h('button', { title: 'Remove layer', text: '✕', onclick: function () { fit.splice(i, 1); save(); } })));
    });
    box.appendChild(h('button', { style: 'margin:2px 0 6px', text: '+ Add layer', onclick: function () { fit.push({ type: fit.length ? 'chest' : 'body', path: '', tint: '' }); save(); } }));
    var look = fit.filter(function (l) { return l.path; }).map(function (l) { return { path: l.path, tint: l.tint }; });
    if (look.length) box.appendChild(h('div', { className: 'preview' }, composeLook(look)));
    return box;
  }

  // ---------------------------------------------------------------- NPCs (objects of kind npc, in a panel of their own)
  function npcThumb(o) {
    var fit = (propsObj(o).outfit || []).filter(function (l) { return l && l.path; });
    if (!fit.length) {
      var src = o.sprite ? spritePath(o.sprite) : '';
      return src ? h('img', { className: 'rthumb', src: src, alt: '' }) : h('span', { className: 'rthumb ph' });
    }
    var cv = composeLook(fit.map(function (l) { return { path: l.path, tint: l.tint || '' }; }));
    cv.className = 'rthumb'; return cv;
  }
  function npcList() {
    var list = $('list'); list.innerHTML = '';
    var search = h('input', { placeholder: 'Search NPCs…', value: filter, oninput: function (e) { filter = e.target.value; npcList(); } });
    list.appendChild(h('div', { className: 'head' }, search, h('button', { className: 'primary', title: 'New', text: '+ New', onclick: addRecord })));
    var q = filter.toLowerCase(), any = false;
    rows('objects').forEach(function (o, i) {
      if (!isNpc(o) || (q && (rowLabel('objects', o) + ' ' + (o.name || '')).toLowerCase().indexOf(q) < 0)) return;
      any = true;
      list.appendChild(h('button', { className: 'rec' + (i === curIndex ? ' on' : ''), onclick: function () { curIndex = i; npcList(); renderForm(); } },
        npcThumb(o), h('div', { className: 'rbody' }, h('div', { text: rowLabel('objects', o) }), o.name && o.id !== o.name ? h('small', { text: o.name }) : null)));
    });
    if (!any) list.appendChild(h('div', { className: 'note', style: 'padding:8px', text: rows('objects').some(isNpc) ? 'No match.' : 'No NPCs yet — click New.' }));
  }
  function npcForm() {
    var form = $('form'); form.innerHTML = '';
    var o = rows('objects')[curIndex];
    if (curIndex < 0 || !isNpc(o)) { form.appendChild(h('div', { className: 'empty', text: 'Select an NPC, or click New.' })); return; }
    var p = propsObj(o), qs = rows('quests');
    function questsWhere(field) { return qs.filter(function (q) { return o.id && String(q[field] || '') === String(o.id); }); }
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('objects', o) }), h('span', { className: 'pill', text: 'NPC' }),
      h('button', { title: 'Delete this NPC', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        var uses = questsWhere('giver').concat(questsWhere('ender')).length;
        if (!confirm('Delete this NPC?' + (uses ? ' ' + uses + ' quest link' + (uses === 1 ? '' : 's') + ' name' + (uses === 1 ? 's' : '') + ' it.' : '') + ' Where it is placed on a map, the placement is left without a picture.')) return;
        rows('objects').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); npcList(); npcForm();
      } })));
    Schema.get('objects').fields.forEach(function (fl) { if (fl.key === 'id' || fl.key === 'name') form.appendChild(fieldEl(o, fl)); });
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'What it says' }),
      h('textarea', { rows: 3, value: p.text || '', placeholder: 'Shown when a player talks to it (above the quests it has for them).', oninput: function (e) { setProp(o, 'text', e.target.value); } })));
    // its conversation: a dialogue of its own or a shared one (Story → Dialogues); none = it says the one line above
    var dls = rows('dialogues').filter(function (d) { return d.id; }), dcur = String(p.dialogue || ''), dknown = !dcur || dls.some(function (d) { return String(d.id) === dcur; });
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Dialogue' }),
      h('div', { className: 'row' },
        h('select', { style: 'flex:1;min-width:0' + (dknown ? '' : ';border-color:var(--bad)'), onchange: function (e) { setProp(o, 'dialogue', e.target.value || undefined); npcForm(); } },
          h('option', { value: '', text: '— none: it only says the line above —', selected: !dcur }),
          dknown ? null : h('option', { value: dcur, text: dcur + ' (missing dialogue)', selected: true }),
          dls.map(function (d) { return h('option', { value: d.id, text: (d.name || d.id) + '  (' + d.id + ')', selected: String(d.id) === dcur }); })),
        dcur && dknown ? h('button', { text: 'Edit dialogue ›', onclick: function () { openDialogue(dcur); } })
          : h('button', { text: '+ New dialogue', title: 'Make a dialogue for this NPC, opening with the line above', disabled: !o.id, onclick: function () {
              var all = rows('dialogues'), id = String(o.id).replace(/^npc_/, '') + '_talk', n = 1, base = id;
              while (all.some(function (d) { return String(d.id) === id; })) id = base + (++n);
              all.push({ id: id, name: o.name || o.id, nodes: [{ id: 'hello', start: true, text: p.text || '', answers: [] }], notes: '' });
              setProp(o, 'dialogue', id); openDialogue(id);
            } })),
      h('div', { className: 'help', text: 'A conversation with answers to pick, conditions and things that happen. With one, the line above is only used if the dialogue has no line to open on.' })));
    // its shop (Story → Shops): opened by a dialogue answer ticked "Opens the shop", or by a Trade button when it has no dialogue
    var shs = rows('shops').filter(function (d) { return d.id; }), scur = String(p.shop || ''), sknown = !scur || shs.some(function (d) { return String(d.id) === scur; });
    function openShopRow(id) { var i = -1; rows('shops').forEach(function (d, n) { if (i < 0 && String(d.id || '') === String(id)) i = n; }); if (i < 0) return; type = 'shops'; curIndex = i; filter = ''; renderNav(); renderList(); renderForm(); }
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Shop' }),
      h('div', { className: 'row' },
        h('select', { style: 'flex:1;min-width:0' + (sknown ? '' : ';border-color:var(--bad)'), onchange: function (e) { setProp(o, 'shop', e.target.value || undefined); npcForm(); } },
          h('option', { value: '', text: '— none: it does not trade —', selected: !scur }),
          sknown ? null : h('option', { value: scur, text: scur + ' (missing shop)', selected: true }),
          shs.map(function (d) { return h('option', { value: d.id, text: (d.name || d.id) + '  (' + d.id + ')', selected: String(d.id) === scur }); })),
        scur && sknown ? h('button', { text: 'Edit shop ›', onclick: function () { openShopRow(scur); } })
          : h('button', { text: '+ New shop', title: 'Make a shop for this NPC', disabled: !o.id, onclick: function () {
              var all = rows('shops'), id = String(o.id).replace(/^npc_/, '') + '_shop', n = 1, base = id;
              while (all.some(function (d) { return String(d.id) === id; })) id = base + (++n);
              all.push({ id: id, name: (o.name || o.id) + '\'s shop', offers: [], notes: '' });
              setProp(o, 'shop', id); openShopRow(id);
            } })),
      h('div', { className: 'help', text: scur && dcur ? 'With a dialogue, the shop opens from an answer ticked "Opens the shop" — add one, or players cannot reach it.' : 'What it sells and buys. With no dialogue, its window gets a Trade button by itself.' })));
    form.appendChild(npcOutfit(o));
    // a standing emote: always over its head in the game (a sleeping guard: zzz); a scene can put another one up meanwhile
    form.appendChild(h('div', { className: 'field' }, h('label', { text: 'Emote over its head' }),
      emotePicker(p.emote, function (v) { setProp(o, 'emote', v === 'none' ? undefined : v); npcForm(); }, 'none', 'None'),
      h('div', { className: 'help', text: 'Always shown over this NPC in the game, wherever it stands. A scene\'s Emote step can show a different one for a while.' })));
    // the quests it gives and takes back (set on each quest: giver / ender)
    var gives = questsWhere('giver'), takes = questsWhere('ender');
    function qlinks(list) {
      if (!list.length) return h('span', { className: 'note', text: 'none' });
      return h('span', null, list.map(function (q, n) {
        return h('a', { href: '#', text: (q.name || q.id) + (n < list.length - 1 ? ', ' : ''), onclick: function (e) { e.preventDefault(); type = 'quests'; curIndex = qs.indexOf(q); filter = ''; renderNav(); renderList(); renderForm(); } });
      }));
    }
    form.appendChild(h('div', { className: 'field' }, h('div', { className: 'sub', text: 'Quests' }),
      h('div', null, h('b', { text: 'Gives: ' }), qlinks(gives)), h('div', null, h('b', { text: 'Takes back: ' }), qlinks(takes)),
      h('div', { className: 'help', text: 'Set on each quest (Story → Quests: giver and ender).' })));
    var more = h('details', { className: 'field' }, h('summary', { text: 'More (picture without an outfit, notes)' }));
    Schema.get('objects').fields.forEach(function (fl) { if (fl.key === 'sprite' || fl.key === 'notes') more.appendChild(fieldEl(o, fl)); });
    form.appendChild(more);
  }

  // Save the weighted loot list, and retire the legacy single `loot_table` so there's one source of truth.
  function saveLoot(o, list) {
    setProp(o, 'loot', list.filter(function (e) { return e.table; }));
    if (propsObj(o).loot_table) setProp(o, 'loot_table', undefined);
  }
  function containerLoot(o) {
    var p = propsObj(o);
    // Seed from the legacy single loot_table so an older chest shows its table as one weighted row;
    // this is display-only until the user edits (then saveLoot upgrades it and drops loot_table).
    var list = Array.isArray(p.loot) ? p.loot : (p.loot_table ? [{ table: p.loot_table, weight: 1 }] : []);
    var tables = lootTableNames();
    var box = h('div', {});
    box.appendChild(h('div', { className: 'sub', text: 'Loot — on open, one table is picked by weight, then rolled' }));
    if (p.contents) box.appendChild(h('div', { className: 'note', style: 'margin-bottom:6px', text: 'This chest has a fixed "contents" list (set below), which overrides loot tables.' }));
    list.forEach(function (entry, i) {
      box.appendChild(h('div', { className: 'lootrow' },
        h('select', { style: 'flex:2', onchange: function (e) { entry.table = e.target.value; saveLoot(o, list); } },
          [h('option', { value: '', text: '(loot table…)' })].concat(tables.map(function (t) { return h('option', { value: t, text: t, selected: t === entry.table }); }))),
        h('span', { className: 'lootlbl', text: 'weight' }),
        h('input', { type: 'number', min: 0, value: entry.weight == null ? 1 : entry.weight, style: 'width:64px', title: 'Relative weight for the pick', oninput: function (e) { entry.weight = Number(e.target.value) || 0; saveLoot(o, list); } }),
        h('button', { title: 'Remove', text: '✕', onclick: function () { list.splice(i, 1); saveLoot(o, list); objForm(); } })));
    });
    box.appendChild(h('button', { className: 'primary', style: 'margin:2px 0 8px', text: '+ Add loot table', onclick: function () { list.push({ table: '', weight: 1 }); saveLoot(o, list); objForm(); } }));
    var refillOn = p.refill_after_s != null && Number(p.refill_after_s) > 0;
    box.appendChild(h('div', { className: 'lootrow' },
      h('label', { className: 'row' }, h('input', { type: 'checkbox', checked: refillOn, onchange: function (e) { setProp(o, 'refill_after_s', e.target.checked ? (Number(p.refill_after_s) || 300) : undefined); objForm(); } }), h('span', { text: ' refills after' })),
      h('input', { type: 'number', min: 1, value: p.refill_after_s || 300, style: 'width:80px', disabled: !refillOn, oninput: function (e) { setProp(o, 'refill_after_s', Number(e.target.value) || 0); } }),
      h('span', { className: 'lootlbl', text: 'seconds' })));
    return box;
  }

  function kindPropsSection(o) {
    var p = propsObj(o);
    var handled = { width: 1, height: 1 };
    if (o.kind === 'container') { handled.loot = 1; handled.loot_table = 1; handled.refill_after_s = 1; }
    var kprops = kindRows(o.kind).filter(function (k) { return !handled[k.property]; });
    var box = h('details', { open: false });
    box.appendChild(h('summary', { text: 'All ' + (o.kind || '?') + ' properties (' + kprops.length + ')' }));
    if (!kprops.length) { box.appendChild(h('div', { className: 'note', style: 'padding:6px', text: 'This kind has no extra properties.' })); return box; }
    kprops.forEach(function (k) {
      var has = p[k.property] !== undefined;
      box.appendChild(h('div', { className: 'kprop', title: k.notes || '' },
        h('label', { className: 'row' },
          h('input', { type: 'checkbox', checked: has, title: 'Include this property (off = use the default)', onchange: function (e) {
            if (e.target.checked) setProp(o, k.property, k.def !== undefined && k.def !== '' ? k.def : ''); else setProp(o, k.property, undefined);
            objForm();
          } }),
          h('span', { text: ' ' + k.property.replace(/_/g, ' ') }), k.type ? h('span', { className: 'lootlbl', text: '(' + k.type + ')' }) : null),
        propInput(k, p[k.property], function (v) { setProp(o, k.property, v); }),
        k.notes ? h('div', { className: 'help', text: k.notes }) : null));
    });
    return box;
  }

  // ---------------------------------------------------------------- appearances (paper-doll look sets)
  // The monster `appearance` field: one or more Appearance sets, "set" or "set:weight" comma-separated.
  // One is picked per spawn — add a male and a female set (say) without duplicating the monster's stats.
  function looksField(r, fl) {
    var sets = (rows('appearances') || []).map(function (x) { return x[idField('appearances')]; }).filter(Boolean);
    var list = String(r[fl.key] || '').split(',').map(function (x) { var a = x.trim().split(':'); return a[0].trim() ? { set: a[0].trim(), weight: Number(a[1]) || 1 } : null; }).filter(Boolean);
    var save = function () { r[fl.key] = list.map(function (e) { return e.weight === 1 ? e.set : e.set + ':' + e.weight; }).join(', '); persist(); };
    var box = h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key }));
    list.forEach(function (e, i) {
      box.appendChild(h('div', { className: 'lootrow' },
        h('select', { style: 'flex:2', onchange: function (ev) { e.set = ev.target.value; save(); } },
          [h('option', { value: '', text: '(appearance set…)' })].concat(sets.map(function (s) { return h('option', { value: s, text: s, selected: s === e.set }); }))),
        list.length > 1 ? h('span', { className: 'lootlbl', text: 'weight' }) : null,
        list.length > 1 ? h('input', { type: 'number', min: 0, max: 100, step: 1, value: e.weight, style: 'width:56px', title: 'Relative chance (0–100%) of this set', oninput: function (ev) { e.weight = Number(ev.target.value) || 0; save(); } }) : null,
        list.length > 1 ? h('span', { className: 'lootlbl', text: '%' }) : null,
        h('button', { title: 'Remove', text: '✕', onclick: function () { list.splice(i, 1); save(); renderForm(); } })));
    });
    box.appendChild(h('button', { className: 'primary', style: 'margin:2px 0', text: list.length ? '+ add another set (one is picked per spawn)' : '+ add appearance set', onclick: function () { list.push({ set: sets[0] || '', weight: 1 }); save(); renderForm(); } }));
    box.appendChild(h('div', { className: 'help', text: fl.help }));
    return box;
  }
  // Weapon aim setup: a little sprite viewer with two draggable dots — the rotation pivot (orange) and the
  // barrel tip (blue). Stored normalised (0–1 of the worn sprite) as {px,py,mx,my}; the game rotates the gun
  // about the pivot so pivot→tip points at the cursor. See drawLayers() in client/js/render.js.
  function aimField(r, fl) {
    var box = h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key + ' — aim setup' }));
    if (r.type !== 'weapon') { box.appendChild(h('div', { className: 'help', text: 'Aim points apply to weapons. Set type = weapon first.' })); return box; }
    var spr = r.worn_sprite || r.sprite;
    if (!spr) { box.appendChild(h('div', { className: 'help', text: 'Give this weapon a worn sprite, then place its aim points here.' })); return box; }
    function read() { var v = r[fl.key]; if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } }
    var pts = read() || { px: 0.5, py: 0.55, mx: 0.95, my: 0.5 };
    var round = function (n) { return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000; };
    var W = 200, cv = h('canvas', { width: W, height: Math.round(W * 1.5),
      style: 'display:block;background:#20242e;border:1px solid var(--line);image-rendering:pixelated;cursor:crosshair;touch-action:none;max-width:100%' });
    var img = new Image(), drag = null;
    function layout() {
      var ar = (img.naturalWidth && img.naturalHeight) ? img.naturalHeight / img.naturalWidth : 1.5;
      cv.width = W; cv.height = Math.round(W * ar);
    }
    function P() { return { x: pts.px * cv.width, y: pts.py * cv.height }; }
    function M() { return { x: pts.mx * cv.width, y: pts.my * cv.height }; }
    function dot(g, p, color) {
      g.beginPath(); g.arc(p.x, p.y, 6, 0, 7); g.fillStyle = color; g.fill();
      g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
    }
    function draw() {
      var g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
      if (img.complete && img.naturalWidth) g.drawImage(img, 0, 0, cv.width, cv.height);
      var p = P(), m = M();
      g.strokeStyle = '#ffd36b'; g.lineWidth = 2; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(m.x, m.y); g.stroke();
      var a = Math.atan2(m.y - p.y, m.x - p.x);             // little arrowhead at the barrel tip
      g.beginPath(); g.moveTo(m.x, m.y);
      g.lineTo(m.x - 9 * Math.cos(a - 0.4), m.y - 9 * Math.sin(a - 0.4));
      g.lineTo(m.x - 9 * Math.cos(a + 0.4), m.y - 9 * Math.sin(a + 0.4));
      g.closePath(); g.fillStyle = '#ffd36b'; g.fill();
      dot(g, p, '#ff7a2a'); dot(g, m, '#39c0ff');
    }
    function at(e) { var b = cv.getBoundingClientRect(); return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height }; }
    function move(e) {
      var n = at(e), x = round(n.x), y = round(n.y);
      if (drag === 'm') { pts.mx = x; pts.my = y; } else { pts.px = x; pts.py = y; }
      draw();
    }
    function save() { r[fl.key] = JSON.stringify({ px: round(pts.px), py: round(pts.py), mx: round(pts.mx), my: round(pts.my) }); persist(); }
    cv.addEventListener('pointerdown', function (e) {           // pick the nearer dot, then drag it (pointer capture, so no window leaks)
      e.preventDefault(); cv.setPointerCapture(e.pointerId);
      var n = at(e), p = P(), m = M(), cw = cv.width, ch = cv.height;
      var dp = Math.hypot(n.x * cw - p.x, n.y * ch - p.y), dm = Math.hypot(n.x * cw - m.x, n.y * ch - m.y);
      drag = dp <= dm ? 'p' : 'm'; move(e);
    });
    cv.addEventListener('pointermove', function (e) { if (drag) move(e); });
    cv.addEventListener('pointerup', function () { if (drag) { drag = null; save(); } });
    img.onload = function () { layout(); draw(); };
    img.onerror = function () { draw(); };
    img.src = spritePath(canonSprite(spr));
    layout(); draw();
    box.appendChild(cv);
    box.appendChild(h('div', { className: 'help', style: 'margin-top:4px' },
      h('span', { style: 'color:#ff7a2a;font-weight:600' }, 'Orange'), ' = rotation pivot · ',
      h('span', { style: 'color:#39c0ff;font-weight:600' }, 'Blue'), ' = barrel tip (points at the cursor). Drag either dot.'));
    box.appendChild(h('button', { className: 'ghost', style: 'margin-top:4px', text: 'Reset to default',
      onclick: function () { r[fl.key] = ''; persist(); renderForm(); } }));
    return box;
  }
  function layersOf(r) {
    if (typeof r.layers === 'string') { try { return JSON.parse(r.layers || '[]'); } catch (e) { return []; } }
    return Array.isArray(r.layers) ? r.layers : [];
  }
  function setLayers(r, layers) { r.layers = layers; persist(); }   // array; content.js json() passes arrays through
  function maskPath(p) { return p ? p.replace(/\.png$/i, '.tint.png') : ''; }
  function tintNames() { return (typeof Tint !== 'undefined' && Tint.TINTS) ? Object.keys(Tint.TINTS) : []; }
  // The paper-doll art the sprite picker offers. Primary source is the generated art manifest (below);
  // a built-in list is the fallback when the manifest can't be fetched. Paths follow the type subfolders
  // (base/ hair/ head/ chest/ hands/). We also fold in any sprite already referenced in content.
  var pdManifest = null, artManifest = null;
  var PD_SUBDIR = { body: 'base', hair: 'hair', helm: 'head', chest: 'chest/male', gun: 'hands', sword: 'hands' };
  var PD_FALLBACK = ['body_zombie', 'body_zombie_female', 'body_zombie_female_slim', 'body_survivor', 'body_survivor_female', 'body_survivor_female_slim',
    'hair_bob', 'hair_buzz', 'hair_long', 'hair_messy', 'hair_metal_mohawk_v1', 'hair_metal_mohawk_v2',
    'hair_pony', 'hair_shaggy', 'hair_slick', 'hair_under',
    'chest_leather_jacket', 'chest_riot_vest', 'helm_army', 'gun_pistol', 'sword_machete'
  ].map(function (n) {
    var f = PD_SUBDIR[n.split('_')[0]] || '';
    if (f === 'base') f += /zombie/.test(n) ? '/monsters' : '/player';   // bodies: base/player, base/monsters, base/animals
    return 'art/sprites/paperdoll/' + (f ? f + '/' : '') + n + '.png';
  });
  // One manifest of every image under art/ (built by tools/build_art_manifest.js, auto-rebuilt by the Asset
  // Studio on save). Feeds the "Browse /art" picker; the paper-doll list is the same manifest filtered.
  function loadManifest() {
    return fetch('../art/manifest.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && Array.isArray(j.images)) {
          artManifest = j.images;
          pdManifest = j.images.filter(function (p) { return /\/paperdoll\//.test(p) && !/\.tint\.png$/i.test(p); });
        }
      })
      .catch(function () { /* keep the built-in fallback */ });
  }
  function artSprites() {
    var s = {};
    (artManifest || []).forEach(function (p) { s[p] = 1; });
    return Object.keys(s).sort();
  }
  function pdBase() { return (pdManifest && pdManifest.length ? pdManifest : PD_FALLBACK); }
  // Resolve a (possibly stale, pre-reorg flat) path to the real art file with the same filename, so an old
  // reference like art/sprites/paperdoll/chest_leather_jacket.png maps onto .../chest/chest_leather_jacket.png.
  function canonSprite(p) {
    if (!p) return p;
    if (pdBase().indexOf(p) >= 0) return p;                  // it is where it says (a man's and a woman's cut share one file name)
    var want = baseName(p), hits = pdBase().filter(function (q) { return baseName(q) === want; });
    return hits.filter(function (q) { return !isFemaleCut(q); })[0] || hits[0] || p;
  }
  // The sprite options, de-duplicated by filename (the manifest/base path wins), so a moved-and-renamed
  // file never appears twice — once broken (old path), once working (new path).
  function paperdollSprites() {
    var byName = {};
    function add(p, preferred) { if (!p) return; var n = baseName(p) + (isFemaleCut(p) ? '|f' : ''); if (preferred || !byName[n]) byName[n] = p; }
    pdBase().forEach(function (p) { add(p, true); });
    (T.Classes || []).forEach(function (r) { if (r.body_sprite) add(canonSprite(r.body_sprite)); });
    (T.Items || []).forEach(function (r) { if (r.worn_sprite) add(canonSprite(r.worn_sprite)); });
    (T.Appearances || []).forEach(function (r) { layersOf(r).forEach(function (L) { (L.options || []).forEach(function (o) { if (o.sprite) add(canonSprite(o.sprite)); }); }); });
    return Object.keys(byName).map(function (n) { return byName[n]; }).sort();
  }

  // --- layer types: filter the sprite list by what a layer is (body/hair/head/hand…). A sprite's type
  //     comes from the prefix before the first underscore in its filename (body_zombie -> body). ---
  // Hand and off-hand hold the same things (a weapon can go in either), so they share one sprite set.
  var HELD = ['sword', 'gun', 'axe', 'bat', 'knife', 'weapon', 'shield', 'offhand', 'torch'];
  var LAYER_TYPES = [
    { id: 'body',    label: 'Body',     match: ['body'] },
    { id: 'hair',    label: 'Hair',     match: ['hair'] },
    { id: 'beard',   label: 'Beard',    match: ['beard'] },
    { id: 'face',    label: 'Face',     match: ['face', 'glasses'] },
    { id: 'head',    label: 'Head',     match: ['helm', 'hat', 'mask', 'hood'] },
    { id: 'chest',   label: 'Chest',    match: ['chest', 'shirt', 'jacket', 'vest', 'armor', 'coat'] },
    { id: 'legs',    label: 'Legs',     match: ['legs', 'pants', 'skirt'] },
    { id: 'hand',    label: 'Hand',     match: HELD },
    { id: 'offhand', label: 'Off-hand', match: HELD },
    { id: 'back',    label: 'Back',     match: ['back', 'cape', 'pack', 'bag'] },
    { id: 'any',     label: 'Any',      match: [] }
  ];
  function fileName(path) { return String(path || '').split('/').pop().replace(/\.png$/i, ''); }
  // Gear cut for a woman's body lives in a female/ folder under the same file name as the man's (in male/): see Tint.twin.
  function isFemaleCut(path) { return /\/female\/[^\/]+$/.test(String(path || '')); }
  function spriteLabel(path) { return fileName(path) + (isFemaleCut(path) ? ' (female)' : ''); }
  function spritePrefix(path) { var n = fileName(path).toLowerCase(), i = n.indexOf('_'); return i < 0 ? n : n.slice(0, i); }
  function layerTypeDef(id) { for (var i = 0; i < LAYER_TYPES.length; i++) if (LAYER_TYPES[i].id === id) return LAYER_TYPES[i]; return LAYER_TYPES[LAYER_TYPES.length - 1]; }
  function typeOfSprite(path) {
    var p = spritePrefix(path);
    for (var i = 0; i < LAYER_TYPES.length - 1; i++) if (LAYER_TYPES[i].match.indexOf(p) >= 0) return LAYER_TYPES[i].id;
    return 'any';
  }
  function layerType(L) {                             // a layer's type, inferred from its sprites when unset
    if (L.type) return L.type;
    var o = (L.options || [])[0];
    return o && o.sprite ? typeOfSprite(o.sprite) : 'any';
  }
  function spritesForType(typeId) {
    var def = layerTypeDef(typeId), all = paperdollSprites();
    return def.match.length ? all.filter(function (p) { return def.match.indexOf(spritePrefix(p)) >= 0; }) : all;
  }

  // --- visual dropdown: items show a sprite thumbnail or colour swatch + a name (not a raw path) ---
  function closePickers() { Array.prototype.forEach.call(document.querySelectorAll('.pickwrap.open'), function (w) { w.classList.remove('open'); }); }
  // Hold a hover on any sprite thumbnail for ~1s to pop a big, crisp preview near the cursor.
  var hv = { el: null, timer: 0, mx: 0, my: 0, bound: false };
  function hvPlace() {
    var el = hv.el; if (!el || el.style.display === 'none') return;
    var w = el.offsetWidth || 170, ht = el.offsetHeight || 170, x = hv.mx + 18, y = hv.my + 18;
    if (x + w > window.innerWidth - 8) x = Math.max(8, hv.mx - w - 18);
    if (y + ht > window.innerHeight - 8) y = Math.max(8, window.innerHeight - ht - 8);
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  function hvInit() {
    if (hv.bound) return; hv.bound = true;
    hv.el = h('div', { className: 'sprhover' }); document.body.appendChild(hv.el);
    document.addEventListener('mousemove', function (e) { hv.mx = e.clientX; hv.my = e.clientY; hvPlace(); });
  }
  function hoverZoom(img, src) {
    if (!src) return img;
    hvInit();
    img.addEventListener('mouseenter', function () {
      clearTimeout(hv.timer);
      hv.timer = setTimeout(function () {
        hv.el.innerHTML = ''; hv.el.appendChild(h('img', { src: img.src || src, alt: '' })); hv.el.style.display = 'block'; hvPlace();
      }, 1000);
    });
    img.addEventListener('mouseleave', function () { clearTimeout(hv.timer); if (hv.el) hv.el.style.display = 'none'; });
    return img;
  }
  function lookTint(p, tint) { return typeof Tint !== 'undefined' && Tint.lookTint ? Tint.lookTint(p, tint) : tint; }
  // a garment is shown whole: its fixed part and its cloth (the mask), in the default colour when none is given
  function spriteThumb(p, tint) {
    var img = h('img', { className: 'thumb lit', src: spritePath(p), alt: '', onerror: function () { this.style.visibility = 'hidden'; } });
    return hoverZoom(showTinted(img, p, lookTint(p, tint)), spritePath(p));
  }
  function swatch(ramp) {
    var cs = (typeof Tint !== 'undefined' && Tint.TINTS[ramp]) || null;
    return cs ? h('span', { className: 'swatch', style: 'background:linear-gradient(90deg,' + cs.join(',') + ')' }) : h('span', { className: 'swatch none' });
  }
  function visualPicker(current, items, onPick, placeholder) {
    var cur = null; items.forEach(function (it) { if (it.value === current) cur = it; });
    var pop = h('div', { className: 'pickpop' });
    items.forEach(function (it) {
      pop.appendChild(h('div', { className: 'pickitem' + (it.value === current ? ' on' : ''),
        onclick: function (e) { e.stopPropagation(); closePickers(); onPick(it.value); } }, it.visual(), h('span', { text: it.label })));
    });
    var btn = h('button', { type: 'button', className: 'picker' },
      cur ? cur.visual() : h('span', { className: 'thumb ph' }),
      h('span', { className: 'picklabel', text: cur ? cur.label : (placeholder || '—') }), h('span', { className: 'caret', text: '▾' }));
    var wrap = h('div', { className: 'pickwrap' }, btn, pop);
    btn.onclick = function (e) { e.stopPropagation(); var open = wrap.classList.contains('open'); closePickers(); if (!open) wrap.classList.add('open'); };
    return wrap;
  }
  function spritePicker(L, current, onPick) {
    var items = [{ value: '', label: '— none —', visual: function () { return h('span', { className: 'thumb ph' }); } }]
      .concat(spritesForType(layerType(L)).map(function (p) { return { value: p, label: spriteLabel(p), visual: function () { return spriteThumb(p); } }; }));
    return visualPicker(canonSprite(current), items, onPick, 'sprite…');
  }
  function skinNames() { return (typeof Tint !== 'undefined' && Tint.SKINS) ? Object.keys(Tint.SKINS) : []; }
  function skinPicker(current, onPick) {
    var items = [{ value: '', label: 'skin as drawn', visual: function () { return h('span', { className: 'swatch none' }); } }]
      .concat(skinNames().map(function (s) { return { value: s, label: s.replace(/^skin_/, '') + ' skin', visual: function () { return h('span', { className: 'swatch', style: 'background:' + Tint.SKINS[s] }); } }; }));
    return visualPicker(current, items, onPick, 'skin…');
  }
  function colourPicker(current, onPick) {
    var items = [{ value: '', label: 'no tint', visual: function () { return h('span', { className: 'swatch none' }); } }]
      .concat(tintNames().map(function (t) { return { value: t, label: t, visual: function () { return swatch(t); } }; }));
    return visualPicker(current, items, onPick, 'colour…');
  }
  // weight as a 0–100 %; weights are relative within a layer (the engine normalises them)
  function pctInput(value, onInput) {
    return h('input', { type: 'number', min: 0, max: 100, step: 1, value: value == null ? 0 : value, className: 'pct',
      title: 'Weight 0–100% (relative to the other choices in this layer)', oninput: function (e) { onInput(Math.max(0, Math.min(100, Number(e.target.value) || 0))); } });
  }

  // --- image field: a /art file-browser (collapsible folder tree) + an inline preview of the pick ---
  function baseName(p) { return String(p || '').split('/').pop(); }
  function buildTree(paths) {                            // nested { dirs:{name:node}, files:[path] } from art/ paths
    var root = { dirs: {}, files: [] };
    paths.forEach(function (p) {
      var parts = p.split('/'), node = root;            // parts[0] is 'art' (the root) — skip it
      for (var i = 1; i < parts.length - 1; i++) { node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] }; node = node.dirs[parts[i]]; }
      node.files.push(p);
    });
    return root;
  }
  function artPicker(current, onPick) {
    var tree = buildTree(artSprites()), expanded = {}, q = '';
    if (current) { var pp = current.split('/'), acc = ''; for (var i = 1; i < pp.length - 1; i++) { acc = acc ? acc + '/' + pp[i] : pp[i]; expanded[acc] = true; } }

    var btn = h('button', { type: 'button', className: 'picker' });
    function renderBtn(v) {
      btn.innerHTML = '';
      btn.appendChild(v ? spriteThumb(v) : h('span', { className: 'thumb ph' }));
      btn.appendChild(h('span', { className: 'picklabel', text: v ? baseName(v) : 'Browse /art…' }));
      btn.appendChild(h('span', { className: 'caret', text: '▾' }));
    }
    renderBtn(current);

    var tree_el = h('div', { className: 'picktree' });
    var search = h('input', { className: 'picksearch', placeholder: 'Search /art…', oninput: function (e) { q = e.target.value.trim().toLowerCase(); draw(); } });
    var pop = h('div', { className: 'pickpop art' }, search, tree_el);

    function matches(p) { return !q || p.toLowerCase().indexOf(q) >= 0; }
    function hasMatch(node) { return node.files.some(matches) || Object.keys(node.dirs).some(function (k) { return hasMatch(node.dirs[k]); }); }
    function pick(v) { renderBtn(v); closePickers(); onPick(v); }
    function fileRow(p, depth) {
      return h('div', { className: 'pickitem' + (p === current ? ' on' : ''), style: 'padding-left:' + (depth * 14 + 8) + 'px',
        onclick: function (e) { e.stopPropagation(); pick(p); } }, spriteThumb(p), h('span', { className: 'picklabel', text: baseName(p) }));
    }
    function renderNode(node, prefix, depth, frag) {
      Object.keys(node.dirs).sort().forEach(function (name) {
        var child = node.dirs[name], fp = prefix ? prefix + '/' + name : name;
        if (q && !hasMatch(child)) return;
        var open = q ? true : !!expanded[fp];
        frag.appendChild(h('div', { className: 'pickfolder', style: 'padding-left:' + (depth * 14) + 'px',
          onclick: function (e) { e.stopPropagation(); if (!q) { expanded[fp] = !expanded[fp]; draw(); } } },
          h('span', { className: 'tw', text: open ? '▾' : '▸' }), h('span', { text: name })));
        if (open) renderNode(child, fp, depth + 1, frag);
      });
      node.files.filter(matches).sort().forEach(function (p) { frag.appendChild(fileRow(p, depth)); });
    }
    function draw() {
      tree_el.innerHTML = '';
      tree_el.appendChild(h('div', { className: 'pickitem', onclick: function (e) { e.stopPropagation(); pick(''); } }, h('span', { className: 'thumb ph' }), h('span', { text: '— none —' })));
      var frag = document.createDocumentFragment();
      renderNode(tree, '', 0, frag);
      tree_el.appendChild(frag);
    }
    var wrap = h('div', { className: 'pickwrap' }, btn, pop);
    btn.onclick = function (e) { e.stopPropagation(); var open = wrap.classList.contains('open'); closePickers(); if (!open) { wrap.classList.add('open'); q = ''; search.value = ''; draw(); setTimeout(function () { search.focus(); }, 0); } };
    wrap.setValue = renderBtn;
    return wrap;
  }
  function imageControl(r, fl, val, change) {
    var cur = val == null ? '' : String(val);
    var prev = h('img', { className: 'imgprev', alt: '', onerror: function () { this.style.display = 'none'; } });
    function showPrev(v) { prev._tintOf = ''; if (v) { prev.src = spritePath(v); prev.style.display = ''; if (type === 'items') showTinted(prev, v, r.default_tint); } else { prev.removeAttribute('src'); prev.style.display = 'none'; } }
    var input = h('input', { type: 'text', value: cur, placeholder: 'art/… path or URL',
      oninput: function (e) { cur = e.target.value; change(cur); showPrev(cur); picker.setValue(cur); } });
    var picker = artPicker(cur, function (v) { cur = v; input.value = v; change(v); showPrev(v); });
    showPrev(cur);
    return h('div', { className: 'imagefield' }, h('div', { className: 'row' }, picker, input), prev);
  }

  function layerCard(r, layers, L, li) {
    L.options = L.options || []; L.tints = L.tints || [];
    var tid = layerType(L);
    var card = h('div', { className: 'layer' });
    card.appendChild(h('div', { className: 'lhead' },
      h('select', { className: 'ltype', title: 'Layer type — filters which sprites you can pick', onchange: function (e) { L.type = e.target.value; setLayers(r, layers); appearanceForm(); } },
        LAYER_TYPES.map(function (t) { return h('option', { value: t.id, text: t.label, selected: t.id === tid }); })),
      h('span', { className: 'sp', style: 'flex:1' }),
      h('span', { className: 'lootlbl', text: 'none' }), pctInput(L.empty, function (v) { L.empty = v; setLayers(r, layers); }), h('span', { className: 'lootlbl', text: '%' }),
      h('button', { title: 'Move up', text: '↑', disabled: li === 0, onclick: function () { layers.splice(li - 1, 0, layers.splice(li, 1)[0]); setLayers(r, layers); appearanceForm(); } }),
      h('button', { title: 'Move down', text: '↓', disabled: li === layers.length - 1, onclick: function () { layers.splice(li + 1, 0, layers.splice(li, 1)[0]); setLayers(r, layers); appearanceForm(); } }),
      h('button', { title: 'Remove layer', text: '✕', onclick: function () { layers.splice(li, 1); setLayers(r, layers); appearanceForm(); } })));
    // sprite options (filtered by the layer type)
    card.appendChild(h('div', { className: 'lsub', text: 'Sprites — one is picked per spawn' }));
    L.options.forEach(function (o, oi) {
      card.appendChild(h('div', { className: 'lootrow' },
        spritePicker(L, o.sprite || '', function (v) { o.sprite = v; setLayers(r, layers); appearanceForm(); }),
        (tid === 'body' ? skinPicker : colourPicker)(o.tint || '', function (v) { o.tint = v; setLayers(r, layers); appearanceForm(); }),
        pctInput(o.weight, function (v) { o.weight = v; setLayers(r, layers); }), h('span', { className: 'lootlbl', text: '%' }),
        h('button', { title: 'Remove', text: '✕', onclick: function () { L.options.splice(oi, 1); setLayers(r, layers); appearanceForm(); } })));
    });
    card.appendChild(h('button', { style: 'margin:2px 0 6px', text: '+ sprite', onclick: function () { L.options.push({ sprite: '', tint: '', weight: 50 }); setLayers(r, layers); appearanceForm(); } }));
    // colour pool
    card.appendChild(h('div', { className: 'lsub', text: 'Colour pool — optional; recolours the chosen sprite' }));
    L.tints.forEach(function (t, ti) {
      card.appendChild(h('div', { className: 'lootrow' },
        (tid === 'body' ? skinPicker : colourPicker)(t.tint || '', function (v) { t.tint = v; setLayers(r, layers); appearanceForm(); }),
        pctInput(t.weight, function (v) { t.weight = v; setLayers(r, layers); }), h('span', { className: 'lootlbl', text: '%' }),
        h('button', { title: 'Remove', text: '✕', onclick: function () { L.tints.splice(ti, 1); setLayers(r, layers); appearanceForm(); } })));
    });
    card.appendChild(h('button', { style: 'margin:2px 0 2px', text: '+ colour', onclick: function () { L.tints.push({ tint: '', weight: 50 }); setLayers(r, layers); appearanceForm(); } }));
    return card;
  }

  // ---- preview: roll sample looks and compose them with the tint system (same as the game's renderer) ----
  var pvCache = {};
  function pvImg(path) {
    if (pvCache[path]) return pvCache[path];
    var im = new Image(); im.src = spritePath(path); pvCache[path] = im; return im;
  }
  function pickW(items, extra) {
    var total = Math.max(0, Number(extra) || 0), i;
    for (i = 0; i < items.length; i++) total += Math.max(0, Number(items[i].weight) || 0);
    if (total <= 0) return -1;
    var p = Math.random() * total; p -= Math.max(0, Number(extra) || 0); if (p < 0) return -1;
    for (i = 0; i < items.length; i++) { p -= Math.max(0, Number(items[i].weight) || 0); if (p < 0) return i; }
    return items.length - 1;
  }
  function rollOne(layers) {                                   // mirrors World.rollLook, standalone for the studio
    var look = [];
    layers.forEach(function (L) {
      var opts = L.options || [];
      var i = pickW(opts, L.empty); if (i < 0 || !opts[i].sprite) return;
      var tint = opts[i].tint || '';
      if (L.tints && L.tints.length) { var ti = pickW(L.tints, 0); if (ti >= 0) tint = L.tints[ti].tint; }
      look.push({ path: opts[i].sprite, tint: tint });
    });
    return look;
  }
  function composeLook(look) {
    var c = document.createElement('canvas'); c.width = 64; c.height = 96; c.className = 'pv';
    var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    function draw() {
      g.clearRect(0, 0, c.width, c.height);
      var tone = typeof Tint !== 'undefined' && Tint.lookSkin ? Tint.lookSkin(look) : '';
      var fem = typeof Tint !== 'undefined' && Tint.femaleLook && Tint.femaleLook(look);
      look.forEach(function (l) {
        var tw = fem ? Tint.twin(l.path) : '';                   // a woman's body wears the woman's cut, when the file is there (as in the game)
        if (tw) { var ti = pvImg(tw); if (ti.complete && ti.width) l = { path: tw, tint: l.tint }; else if (!ti.complete) ti.addEventListener('load', draw, { once: true }); }
        var base = pvImg(l.path); if (!base.complete) return;
        var tint = lookTint(l.path, l.tint), ramp = tint && typeof Tint !== 'undefined' ? Tint.TINTS[tint] : null;
        var layer = Tint.layer(base, ramp ? pvImg(maskPath(l.path)) : null, ramp);   // (the picture, its coloured mask, or both)
        if (!layer) return;
        var sk = tone ? Tint.skinFor(l.path, tone) : null;
        if (sk) layer = Tint.skinned(layer, sk.tone, !sk.all);
        try { g.drawImage(layer, 0, 0, c.width, c.height); } catch (e) { /* image still loading */ }
      });
    }
    draw();
    look.forEach(function (l) {                               // redraw as each sprite/mask finishes loading
      [pvImg(l.path), lookTint(l.path, l.tint) ? pvImg(maskPath(l.path)) : null].forEach(function (im) { if (im && !im.complete) { im.addEventListener('load', draw, { once: true }); im.addEventListener('error', draw, { once: true }); } });
    });
    return c;
  }
  function renderPreview(strip, layers) {
    strip.innerHTML = '';
    if (!layers.length || !layers.some(function (L) { return (L.options || []).some(function (o) { return o.sprite; }); })) {
      strip.appendChild(h('span', { className: 'note', text: 'Add a layer with at least one sprite to preview.' })); return;
    }
    for (var n = 0; n < 8; n++) strip.appendChild(composeLook(rollOne(layers)));
  }

  function appearanceForm() {
    var form = $('form'); form.innerHTML = '';
    if (curIndex < 0 || !rows('appearances')[curIndex]) { form.appendChild(h('div', { className: 'empty', text: 'Select an appearance set, or click New.' })); return; }
    var r = rows('appearances')[curIndex], layers = layersOf(r);
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('appearances', r) }), h('span', { className: 'pill', text: 'Appearances' }),
      h('button', { title: 'Delete this set', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete this appearance set?')) return; rows('appearances').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    Schema.get('appearances').fields.forEach(function (fl) { if (fl.key !== 'layers') form.appendChild(fieldEl(r, fl)); });
    form.appendChild(h('div', { className: 'sub', text: 'Layers — listed bottom to top (base body first)' }));
    layers.forEach(function (L, li) { form.appendChild(layerCard(r, layers, L, li)); });
    form.appendChild(h('button', { className: 'primary', style: 'margin:4px 0 8px', text: '+ Add layer', onclick: function () { layers.push({ name: '', empty: 0, options: [], tints: [] }); setLayers(r, layers); appearanceForm(); } }));
    // preview strip
    form.appendChild(h('div', { className: 'sub', text: 'Preview — sample rolls' }));
    var strip = h('div', { className: 'preview' });
    form.appendChild(h('button', { text: '🎲 Roll samples', onclick: function () { renderPreview(strip, layersOf(r)); } }));
    form.appendChild(strip);
    renderPreview(strip, layers);
  }

  // ---------------------------------------------------------------- loot tables (grouped by table name)
  function lootTableNames() {
    var seen = {}, out = [];
    rows('loot').forEach(function (r) { var t = String(r.table || ''); if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out;
  }
  function lootList() {
    var list = $('list'); list.innerHTML = '';
    var search = h('input', { placeholder: 'Search loot tables…', value: filter, oninput: function (e) { filter = e.target.value; lootList(); } });
    list.appendChild(h('div', { className: 'head' }, search, h('button', { className: 'primary', text: '+ New', onclick: newLootTable })));
    var q = filter.toLowerCase();
    lootTableNames().forEach(function (name) {
      if (q && name.toLowerCase().indexOf(q) < 0) return;
      var n = rows('loot').filter(function (r) { return String(r.table) === name; }).length;
      list.appendChild(h('button', { className: 'rec' + (name === curLoot ? ' on' : ''), onclick: function () { curLoot = name; lootList(); lootForm(); } },
        h('div', { className: 'rbody' }, h('div', { text: name }), h('small', { text: n + ' item' + (n !== 1 ? 's' : '') }))));
    });
    if (!list.querySelector('.rec')) list.appendChild(h('div', { className: 'note', style: 'padding:8px', text: lootTableNames().length ? 'No match.' : 'No loot tables yet — click New.' }));
  }
  function newLootTable() {
    var base = 'new_table', name = base, i = 1, names = lootTableNames();
    while (names.indexOf(name) >= 0) name = base + '_' + (i++);
    rows('loot').push({ table: name, item: '', chance: 1, min: 1, max: 1 });
    curLoot = name; persist(); renderNav(); lootList(); lootForm();
  }
  function lootForm() {
    rememberView();
    var form = $('form'); form.innerHTML = '';
    if (!curLoot) { form.appendChild(h('div', { className: 'empty', text: 'Select a loot table, or click New.' })); return; }
    var entries = rows('loot').filter(function (r) { return String(r.table) === curLoot; });
    var nameInput = h('input', { value: curLoot, style: 'max-width:240px', onchange: function (e) {
      var nn = e.target.value.trim(); if (!nn || nn === curLoot) return;
      entries.forEach(function (r) { r.table = nn; }); curLoot = nn; persist(); renderNav(); lootList();
    } });
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: 'Loot table' }), nameInput,
      h('span', { className: 'pill', text: entries.length + ' items' }),
      h('button', { title: 'Delete this loot table', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete loot table "' + curLoot + '" and its ' + entries.length + ' entries?')) return;
        T[tab('loot')] = rows('loot').filter(function (r) { return String(r.table) !== curLoot; });
        curLoot = null; persist(); renderNav(); lootList(); lootForm();
      } })));
    form.appendChild(h('div', { className: 'note', style: 'margin-bottom:8px', text: 'Items that can drop from this table, each with a drop chance (0–100%) and a quantity range.' }));
    entries.forEach(function (r) { form.appendChild(lootEntry(r)); });
    form.appendChild(h('button', { className: 'primary', style: 'margin-top:8px', text: '+ Add item', onclick: function () {
      rows('loot').push({ table: curLoot, item: '', chance: 1, min: 1, max: 1 }); persist(); lootForm();
    } }));
  }
  function lootEntry(r) {
    var item = pickSelect(rows('items').map(function (x) { return { id: x.id, name: x.name }; }), r.item || '', function (v) { r.item = v; persist(); }, 'flex:2;min-width:0', '— pick an item —');
    var chance = h('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round((Number(r.chance) || 0) * 100), style: 'width:64px',
      title: 'Drop chance (%)', oninput: function (e) { r.chance = e.target.value === '' ? 0 : Number(e.target.value) / 100; persist(); } });
    var mn = h('input', { type: 'number', min: 1, value: r.min == null ? 1 : r.min, style: 'width:52px', title: 'Min quantity', oninput: function (e) { r.min = Number(e.target.value) || 1; persist(); } });
    var mx = h('input', { type: 'number', min: 1, value: r.max == null ? 1 : r.max, style: 'width:52px', title: 'Max quantity', oninput: function (e) { r.max = Number(e.target.value) || 1; persist(); } });
    var del = h('button', { title: 'Remove this item', text: '✕', onclick: function () { var a = rows('loot'); a.splice(a.indexOf(r), 1); persist(); lootForm(); } });
    return h('div', { className: 'lootrow' }, item,
      h('span', { className: 'lootlbl', text: '%' }), chance,
      h('span', { className: 'lootlbl', text: 'qty' }), mn, h('span', { className: 'lootlbl', text: '–' }), mx, del);
  }

  // ---------------------------------------------------------------- kinds (grouped by kind, not row-by-row)
  // The Kinds tab is stored as one row per (kind, property). Here it's edited as one entry per object KIND
  // with its full property list — so you add a property to "deco" in one place instead of hunting rows.
  function allKindNames() {
    var kf = fieldDef('objects', 'kind');
    var names = kf ? optionsOf('objects', kf) : [];
    rows('kinds').forEach(function (r) { var k = String(r.kind || ''); if (k && names.indexOf(k) < 0) names.push(k); });
    return names;
  }
  function kindPropRows(kind) { return rows('kinds').filter(function (r) { return String(r.kind) === kind && String(r.property) !== 'states'; }); }
  function kindStatesRow(kind) { return rows('kinds').filter(function (r) { return String(r.kind) === kind && String(r.property) === 'states'; })[0] || null; }
  function kindsList() {
    var list = $('list'); list.innerHTML = '';
    var search = h('input', { placeholder: 'Search kinds…', value: filter, oninput: function (e) { filter = e.target.value; kindsList(); } });
    list.appendChild(h('div', { className: 'head' }, search, h('button', { className: 'primary', title: 'New object kind', text: '+ New', onclick: addKind })));
    var q = filter.toLowerCase();
    allKindNames().forEach(function (name) {
      if (q && name.toLowerCase().indexOf(q) < 0) return;
      var n = kindPropRows(name).length, st = kindStatesRow(name), hasSt = st && String(st['default'] || '').trim();
      var sub = n + ' propert' + (n === 1 ? 'y' : 'ies') + (hasSt ? ' · states' : '');
      list.appendChild(h('button', { className: 'rec' + (name === curKind ? ' on' : ''), onclick: function () { curKind = name; kindsList(); kindsForm(); } },
        h('div', { className: 'rbody' }, h('div', { text: name }), h('small', { text: sub }))));
    });
    if (!list.querySelector('.rec')) list.appendChild(h('div', { className: 'note', style: 'padding:8px', text: 'No match.' }));
  }
  function uniqueProp(kind) {
    var base = 'new_property', n = base, i = 1, taken = rows('kinds').filter(function (r) { return String(r.kind) === kind; }).map(function (r) { return r.property; });
    while (taken.indexOf(n) >= 0) n = base + '_' + (i++);
    return n;
  }
  // Kinds the owner made (as opposed to the ones the rules know) are listed in Config → object_kinds.
  function builtinKind(name) { return (fieldDef('objects', 'kind').options || []).indexOf(name) >= 0; }
  function setCustomKinds(names) {
    var cfg = rows('config'), row = cfg.filter(function (c) { return c.key === 'object_kinds'; })[0];
    if (!row) { row = { key: 'object_kinds', value: '', notes: 'Object kinds added in the Content Studio (Object Kinds card)' }; cfg.push(row); }
    row.value = names.join(', ');
  }
  function addKind() {
    var all = allKindNames(), n = 1, name = 'new_kind';
    while (all.indexOf(name) >= 0) name = 'new_kind_' + (++n);
    setCustomKinds(configList('object_kinds').concat([name]));
    curKind = name; filter = ''; persist(); renderNav(); kindsList(); kindsForm();
  }
  function renameKind(to) {
    to = String(to || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!to || to === curKind) return '';
    if (allKindNames().indexOf(to) >= 0) return 'There is already a kind called "' + to + '".';
    var from = curKind;
    setCustomKinds(configList('object_kinds').map(function (k) { return k === from ? to : k; }));
    rows('kinds').forEach(function (r) { if (String(r.kind) === from) r.kind = to; });
    rows('objects').forEach(function (o) { if (o.kind === from) o.kind = to; });
    curKind = to; persist(); renderNav(); kindsList(); kindsForm();
    return '';
  }
  function deleteKind() {
    var name = curKind, used = rows('objects').filter(function (o) { return o.kind === name; }).length;
    if (used) { alert(used + ' object' + (used === 1 ? ' is' : 's are') + ' of kind "' + name + '". Give ' + (used === 1 ? 'it' : 'them') + ' another kind first.'); return; }
    if (!confirm('Delete the object kind "' + name + '" and its properties?')) return;
    setCustomKinds(configList('object_kinds').filter(function (k) { return k !== name; }));
    var a = rows('kinds'); for (var i = a.length - 1; i >= 0; i--) if (String(a[i].kind) === name) a.splice(i, 1);
    curKind = null; persist(); renderNav(); kindsList(); kindsForm();
  }
  function kindsForm() {
    rememberView();
    var form = $('form'); form.innerHTML = '';
    if (!curKind) { form.appendChild(h('div', { className: 'empty', text: 'Select an object kind on the left to edit its properties.' })); return; }
    var own = !builtinKind(curKind);
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: curKind }), h('span', { className: 'pill', text: own ? 'Object kind' : 'Built-in object kind' }),
      own ? h('button', { title: 'Delete this kind', text: '🗑 Delete', style: 'margin-left:auto', onclick: deleteKind }) : null));
    if (own) {
      var warn = h('div', { className: 'help', style: 'color:var(--bad)' });
      form.appendChild(h('div', { className: 'field' }, h('label', { text: 'name' }),
        h('input', { type: 'text', value: curKind, onchange: function (e) { var err = renameKind(e.target.value); if (err) { warn.textContent = err; e.target.value = curKind; } } }),
        h('div', { className: 'help', text: 'Lower-case letters, numbers and _ only. Objects of this kind follow the new name. A kind you add has no behaviour of its own in the game: it is a label with its own properties.' }), warn));
    }
    form.appendChild(h('div', { className: 'note', style: 'margin-bottom:8px', text: 'Settings an author can give a ' + curKind + ' object — they appear in that object’s “All ' + curKind + ' properties” section. Each is read by the game from the object’s properties.' }));
    form.appendChild(h('datalist', { id: 'dl_kindtype' }, ['text', 'number', 'bool', 'select:a|b|c', 'item', 'monster', 'loot_table'].map(function (t) { return h('option', { value: t }); })));
    // states
    form.appendChild(h('div', { className: 'sub', text: 'States (optional) — named looks this object can start in or switch to' }));
    form.appendChild(kindStatesEditor());
    // properties
    form.appendChild(h('div', { className: 'sub', text: 'Properties' }));
    var prs = kindPropRows(curKind);
    if (!prs.length) form.appendChild(h('div', { className: 'note', style: 'padding:4px 0', text: 'No properties yet — click “Add property”.' }));
    prs.forEach(function (r) { form.appendChild(kindPropRow(r)); });
    form.appendChild(h('button', { className: 'primary', style: 'margin-top:8px', text: '+ Add property', onclick: function () {
      rows('kinds').push({ kind: curKind, property: uniqueProp(curKind), type: 'text', 'default': '', notes: '' }); persist(); kindsForm(); kindsList();
    } }));
  }
  function kindPropRow(r) {
    var name = h('input', { value: r.property || '', placeholder: 'name', style: 'flex:1.2', title: 'Property name (the key in the object’s properties)',
      onchange: function (e) { r.property = e.target.value.trim(); persist(); kindsList(); } });
    var type = h('input', { value: r.type || '', list: 'dl_kindtype', placeholder: 'type', style: 'flex:1.2', title: 'Field type: text, number, bool, select:a|b|c, item, monster, loot_table',
      oninput: function (e) { r.type = e.target.value.trim(); persist(); } });
    var def = h('input', { value: r['default'] == null ? '' : r['default'], placeholder: 'default', style: 'flex:1', title: 'Default value (used when the author leaves it unset)', oninput: function (e) { r['default'] = e.target.value; persist(); } });
    var notes = h('input', { value: r.notes || '', placeholder: 'help (optional)', style: 'flex:1.6', oninput: function (e) { r.notes = e.target.value; persist(); } });
    var del = h('button', { title: 'Remove this property', text: '✕', onclick: function () { var a = rows('kinds'); a.splice(a.indexOf(r), 1); persist(); kindsForm(); kindsList(); } });
    return h('div', { className: 'lootrow' }, name, type, def, notes, del);
  }
  function kindStatesEditor() {
    var row = kindStatesRow(curKind);
    var inp = h('input', { value: row ? String(row['default'] || '') : '', placeholder: 'e.g. closed|open  (first = default)', style: 'flex:1',
      oninput: function (e) {
        var v = e.target.value.trim();
        if (!v) { if (row) { var a = rows('kinds'); a.splice(a.indexOf(row), 1); row = null; } }
        else { if (!row) { row = { kind: curKind, property: 'states', type: '', 'default': '', notes: '' }; rows('kinds').push(row); } row['default'] = v; }
        persist();
      } });
    return h('div', {}, h('div', { className: 'lootrow' }, inp),
      h('div', { className: 'help', text: 'Pipe-separated named looks, first = default (e.g. closed|open). Each state’s sprite is set per object in its “state=sprite” field. Blank = none.' }));
  }

  return { init: init };
})();
