/**
 * Content Studio: a schema-driven editor for all game content (items, classes, skills, monsters,
 * statuses, loot, config, terrain, objects, tilesets, levels). It reads the current content from the
 * Cloud Function, edits a LOCAL draft, Play-tests it offline, and Publishes to Firestore.
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
  var filter = '';

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
  function tab(t) { return Schema.tabOf(t); }
  function rows(t) { return (T[tab(t)] = T[tab(t)] || []); }
  function idField(t) { return Schema.get(t).id; }
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
  function init() {
    if (!FUN) { $('top').textContent = 'No FUNCTIONS_URL in client/js/config.js — cannot reach the content server.'; return; }
    renderTop('Loading…');
    var draft = ContentStore.getDraft();
    (draft && Object.keys(draft).length
      ? Promise.resolve(draft)
      : ContentStore.loadRecords(FUN)
    ).then(function (tables) {
      T = tables || {};
      Schema.list().forEach(function (t) { if (!Array.isArray(T[tab(t)])) T[tab(t)] = []; });
      type = Schema.authored('studio')[0];
      renderAll();
      setStatus(draft ? 'Editing your local draft.' : 'Loaded live content.', draft ? 'dirty' : 'clean');
    }).catch(function (e) { renderTop('Load failed'); setStatus('Could not load content: ' + e.message, 'bad'); });
  }
  function persist() { ContentStore.setDraft(T); setStatus('Draft saved in this browser (unpublished).', 'dirty'); }

  // ---------------------------------------------------------------- top bar
  function renderTop(msg) {
    var top = $('top'); top.innerHTML = '';
    top.appendChild(h('span', { className: 'title', text: 'Content Studio' }));
    top.appendChild(h('span', { id: 'status', className: 'status note', text: msg || '' }));
    top.appendChild(h('span', { className: 'sp' }));
    top.appendChild(h('button', { className: 'ghost', title: 'Play-test offline against this draft', text: '▶ Play-test', onclick: playtest }));
    top.appendChild(h('button', { className: 'ghost', title: 'Download the draft as JSON (for a repo snapshot)', text: 'Export', onclick: function () { ContentStore.exportFile(T, 'content.json'); } }));
    top.appendChild(h('button', { title: 'Reload live content, discarding the local draft', text: 'Discard draft', onclick: discard }));
    top.appendChild(h('button', { className: 'primary', title: 'Publish the draft to the live game', text: 'Publish', onclick: publish }));
  }
  function setStatus(msg, cls) { var s = $('status'); if (s) { s.textContent = msg || ''; s.className = 'status note ' + (cls || ''); } }

  function playtest() {
    ContentStore.setDraft(T);                                   // make sure the latest edits are in the draft
    window.open('../client/?offline', '_blank');
  }
  function discard() {
    if (!confirm('Discard your local draft and reload the live content?')) return;
    ContentStore.clearDraft();
    ContentStore.loadRecords(FUN).then(function (tables) {
      T = tables || {}; Schema.list().forEach(function (t) { if (!Array.isArray(T[tab(t)])) T[tab(t)] = []; });
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
    Schema.authored('studio').forEach(function (t) {
      var count = t === 'loot' ? lootTableNames().length : rows(t).length;
      nav.appendChild(h('button', { className: t === type ? 'on' : '', onclick: function () { type = t; curIndex = -1; curLoot = null; filter = ''; renderList(); renderForm(); renderNav(); } },
        h('span', { text: Schema.get(t).label }), h('span', { className: 'n', text: String(count) })));
    });
  }
  function renderList() {
    if (type === 'loot') return lootList();
    var list = $('list'); list.innerHTML = '';
    var search = h('input', { placeholder: 'Search ' + Schema.get(type).label.toLowerCase() + '…', value: filter,
      oninput: function (e) { filter = e.target.value; renderList(); } });
    list.appendChild(h('div', { className: 'head' }, search,
      h('button', { className: 'primary', title: 'New', text: '+ New', onclick: addRecord })));
    var all = rows(type), q = filter.toLowerCase(), idf = idField(type);
    all.forEach(function (r, i) {
      var lbl = rowLabel(type, r);
      if (q && lbl.toLowerCase().indexOf(q) < 0) return;
      var thumb = r.sprite ? h('img', { className: 'rthumb', src: spritePath(r.sprite), alt: '',
        onerror: function () { this.style.visibility = 'hidden'; } }) : null;
      var body = h('div', { className: 'rbody' }, h('div', { text: lbl }), r.name && idf && r[idf] !== r.name ? h('small', { text: r.name }) : null);
      list.appendChild(h('button', { className: 'rec' + (i === curIndex ? ' on' : ''), onclick: function () { curIndex = i; renderList(); renderForm(); } }, thumb, body));
    });
    if (!list.querySelector('.rec')) list.appendChild(h('div', { className: 'note', style: 'padding:8px', text: all.length ? 'No match.' : 'Nothing here yet — click New.' }));
  }
  function addRecord() {
    var r = Schema.defaults(type); rows(type).push(r); curIndex = rows(type).length - 1;
    persist(); renderNav(); renderList(); renderForm();
  }

  // ---------------------------------------------------------------- the form
  function renderForm() {
    if (type === 'loot') return lootForm();
    var form = $('form'); form.innerHTML = '';
    if (curIndex < 0 || !rows(type)[curIndex]) { form.appendChild(h('div', { className: 'empty', text: 'Select a ' + (Schema.get(type).singular || Schema.get(type).label.toLowerCase().replace(/s$/, '')) + ', or click New.' })); return; }
    var r = rows(type)[curIndex], def = Schema.get(type);
    form.appendChild(h('div', { className: 'formhead' },
      h('h2', { text: rowLabel(type, r) }),
      h('span', { className: 'pill', text: def.label }),
      h('span', { className: 'sp', style: 'margin-left:auto' }),
      h('button', { title: 'Delete this record', text: '🗑 Delete', onclick: function () {
        if (!confirm('Delete this ' + (def.singular || 'record') + '?')) return;
        rows(type).splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    def.fields.forEach(function (fl) { form.appendChild(fieldEl(r, fl)); });
  }

  function fieldEl(r, fl) {
    var control, val = r[fl.key];
    function change(v) { r[fl.key] = v; persist(); if (fl.key === idField(type) || fl.key === 'name') { renderNav(); renderList(); } }
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
      var opts = fl.options.slice(); if (val && opts.indexOf(val) < 0) opts.unshift(val);
      control = h('select', { onchange: function (e) { change(e.target.value); } },
        h('option', { value: '', text: '—' }), opts.map(function (o) { return h('option', { value: o, text: o, selected: o === val }); }));
    } else if (fl.type === 'ref') {
      var refType = fl.ref, lid = 'dl_' + fl.key, ids = (rows(refType) || []).map(function (x) { return x[idField(refType)]; }).filter(Boolean);
      control = h('span', { className: 'row' },
        h('input', { value: val == null ? '' : val, list: lid, placeholder: Schema.get(refType) ? Schema.get(refType).label : '', oninput: function (e) { change(e.target.value); } }),
        h('datalist', { id: lid }, ids.map(function (o) { return h('option', { value: o }); })));
    } else {
      control = h('input', { type: 'text', value: val == null ? '' : val, oninput: function (e) { change(e.target.value); } });
    }
    return h('div', { className: 'field', title: fl.help || '' }, h('label', { text: fl.key + (fl.type === 'ref' ? '  → ' + fl.ref : '') }), control,
      fl.help ? h('div', { className: 'help', text: fl.help }) : null);
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
    var ids = rows('items').map(function (x) { return x.id; }).filter(Boolean);
    form.appendChild(h('datalist', { id: 'dl_lootitem' }, ids.map(function (o) { return h('option', { value: o }); })));
    entries.forEach(function (r) { form.appendChild(lootEntry(r)); });
    form.appendChild(h('button', { className: 'primary', style: 'margin-top:8px', text: '+ Add item', onclick: function () {
      rows('loot').push({ table: curLoot, item: '', chance: 1, min: 1, max: 1 }); persist(); lootForm();
    } }));
  }
  function lootEntry(r) {
    var item = h('input', { value: r.item || '', list: 'dl_lootitem', placeholder: 'item…', style: 'flex:2', oninput: function (e) { r.item = e.target.value; persist(); } });
    var chance = h('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round((Number(r.chance) || 0) * 100), style: 'width:64px',
      title: 'Drop chance (%)', oninput: function (e) { r.chance = e.target.value === '' ? 0 : Number(e.target.value) / 100; persist(); } });
    var mn = h('input', { type: 'number', min: 1, value: r.min == null ? 1 : r.min, style: 'width:52px', title: 'Min quantity', oninput: function (e) { r.min = Number(e.target.value) || 1; persist(); } });
    var mx = h('input', { type: 'number', min: 1, value: r.max == null ? 1 : r.max, style: 'width:52px', title: 'Max quantity', oninput: function (e) { r.max = Number(e.target.value) || 1; persist(); } });
    var del = h('button', { title: 'Remove this item', text: '✕', onclick: function () { var a = rows('loot'); a.splice(a.indexOf(r), 1); persist(); lootForm(); } });
    return h('div', { className: 'lootrow' }, item,
      h('span', { className: 'lootlbl', text: '%' }), chance,
      h('span', { className: 'lootlbl', text: 'qty' }), mn, h('span', { className: 'lootlbl', text: '–' }), mx, del);
  }

  return { init: init };
})();
