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
  document.addEventListener('click', function () { if (typeof closePickers === 'function') closePickers(); });   // close any open visual dropdown

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
    if (type === 'objects') return objForm();
    if (type === 'appearances') return appearanceForm();
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
      var ids = type === 'item' ? (T.Items || []).map(function (x) { return x.id; })
              : type === 'loot_table' ? lootTableNames() : (T.Monsters || []).map(function (x) { return x.id; });
      var lid = 'dl_kp_' + k.property;
      return h('span', { className: 'row', style: 'flex:1' },
        h('input', { value: value == null ? '' : value, list: lid, oninput: function (e) { onchange(e.target.value); } }),
        h('datalist', { id: lid }, ids.filter(Boolean).map(function (o) { return h('option', { value: o }); })));
    }
    return h('input', { value: value == null ? '' : value, oninput: function (e) { onchange(e.target.value); } });
  }

  function objForm() {
    var form = $('form'); form.innerHTML = '';
    if (curIndex < 0 || !rows('objects')[curIndex]) { form.appendChild(h('div', { className: 'empty', text: 'Select an object, or click New.' })); return; }
    var o = rows('objects')[curIndex], p = propsObj(o);
    form.appendChild(h('div', { className: 'formhead' }, h('h2', { text: rowLabel('objects', o) }), h('span', { className: 'pill', text: 'Objects' }),
      h('button', { title: 'Delete this object', text: '🗑 Delete', style: 'margin-left:auto', onclick: function () {
        if (!confirm('Delete this object?')) return; rows('objects').splice(curIndex, 1); curIndex = -1; persist(); renderNav(); renderList(); renderForm();
      } })));
    // base fields (the raw `properties` blob is replaced by the structured sections below)
    Schema.get('objects').fields.forEach(function (fl) {
      if (fl.key === 'properties') return;
      var el = fieldEl(o, fl);
      if (fl.key === 'kind') { var sel = el.querySelector('select'); if (sel) sel.addEventListener('change', function () { setTimeout(objForm, 0); }); }
      form.appendChild(el);
    });
    // Footprint
    form.appendChild(h('div', { className: 'sub', text: 'Footprint — tiles, from the sprite’s bottom-left' }));
    form.appendChild(h('div', { className: 'lootrow' },
      h('span', { className: 'lootlbl', text: 'w' }), h('input', { type: 'number', min: 1, value: p.width == null ? '' : p.width, style: 'width:70px', title: 'Width in tiles', oninput: function (e) { setProp(o, 'width', e.target.value === '' ? undefined : Number(e.target.value)); } }),
      h('span', { className: 'lootlbl', text: 'h' }), h('input', { type: 'number', min: 1, value: p.height == null ? '' : p.height, style: 'width:70px', title: 'Height in tiles', oninput: function (e) { setProp(o, 'height', e.target.value === '' ? undefined : Number(e.target.value)); } }),
      h('span', { className: 'note', text: '(blank = the sprite’s own size)' })));
    // Container loot
    if (o.kind === 'container') form.appendChild(containerLoot(o));
    // All kind properties, collapsible
    form.appendChild(kindPropsSection(o));
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
  function layersOf(r) {
    if (typeof r.layers === 'string') { try { return JSON.parse(r.layers || '[]'); } catch (e) { return []; } }
    return Array.isArray(r.layers) ? r.layers : [];
  }
  function setLayers(r, layers) { r.layers = layers; persist(); }   // array; content.js json() passes arrays through
  function maskPath(p) { return p ? p.replace(/\.png$/i, '.tint.png') : ''; }
  function tintNames() { return (typeof Tint !== 'undefined' && Tint.TINTS) ? Object.keys(Tint.TINTS) : []; }
  // A convenience list for the sprite picker: the paper-doll art shipped with the game, plus any sprite
  // already referenced in content (so newly generated art shows up once it is used somewhere).
  function paperdollSprites() {
    var s = {};
    ['body_zombie', 'body_zombie_female', 'body_survivor', 'body_survivor_female',
     'hair_bob', 'hair_buzz', 'hair_long', 'hair_messy', 'hair_metal_mohawk_v1', 'hair_metal_mohawk_v2',
     'hair_pony', 'hair_shaggy', 'hair_slick', 'hair_under',
     'chest_leather_jacket', 'chest_riot_vest', 'helm_army', 'gun_pistol', 'sword_machete'
    ].forEach(function (n) { s['art/sprites/paperdoll/' + n + '.png'] = 1; });
    (T.Classes || []).forEach(function (r) { if (r.body_sprite) s[r.body_sprite] = 1; });
    (T.Items || []).forEach(function (r) { if (r.worn_sprite) s[r.worn_sprite] = 1; });
    (T.Appearances || []).forEach(function (r) { layersOf(r).forEach(function (L) { (L.options || []).forEach(function (o) { if (o.sprite) s[o.sprite] = 1; }); }); });
    return Object.keys(s).sort();
  }

  // --- layer types: filter the sprite list by what a layer is (body/hair/head/hand…). A sprite's type
  //     comes from the prefix before the first underscore in its filename (body_zombie -> body). ---
  var LAYER_TYPES = [
    { id: 'body',    label: 'Body',     match: ['body'] },
    { id: 'hair',    label: 'Hair',     match: ['hair'] },
    { id: 'head',    label: 'Head',     match: ['helm', 'hat', 'mask', 'hood'] },
    { id: 'chest',   label: 'Chest',    match: ['chest', 'shirt', 'jacket', 'vest', 'armor', 'coat'] },
    { id: 'legs',    label: 'Legs',     match: ['legs', 'pants', 'skirt'] },
    { id: 'hand',    label: 'Hand',     match: ['sword', 'gun', 'axe', 'bat', 'knife', 'weapon'] },
    { id: 'offhand', label: 'Off-hand', match: ['shield', 'offhand', 'torch'] },
    { id: 'back',    label: 'Back',     match: ['back', 'cape', 'pack', 'bag'] },
    { id: 'any',     label: 'Any',      match: [] }
  ];
  function fileName(path) { return String(path || '').split('/').pop().replace(/\.png$/i, ''); }
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
  function spriteThumb(p) { return h('img', { className: 'thumb', src: spritePath(p), alt: '', title: p, onerror: function () { this.style.visibility = 'hidden'; } }); }
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
      .concat(spritesForType(layerType(L)).map(function (p) { return { value: p, label: fileName(p), visual: function () { return spriteThumb(p); } }; }));
    return visualPicker(current, items, onPick, 'sprite…');
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
        colourPicker(o.tint || '', function (v) { o.tint = v; setLayers(r, layers); appearanceForm(); }),
        pctInput(o.weight, function (v) { o.weight = v; setLayers(r, layers); }), h('span', { className: 'lootlbl', text: '%' }),
        h('button', { title: 'Remove', text: '✕', onclick: function () { L.options.splice(oi, 1); setLayers(r, layers); appearanceForm(); } })));
    });
    card.appendChild(h('button', { style: 'margin:2px 0 6px', text: '+ sprite', onclick: function () { L.options.push({ sprite: '', tint: '', weight: 50 }); setLayers(r, layers); appearanceForm(); } }));
    // colour pool
    card.appendChild(h('div', { className: 'lsub', text: 'Colour pool — optional; recolours the chosen sprite' }));
    L.tints.forEach(function (t, ti) {
      card.appendChild(h('div', { className: 'lootrow' },
        colourPicker(t.tint || '', function (v) { t.tint = v; setLayers(r, layers); appearanceForm(); }),
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
      look.forEach(function (l) {
        var base = pvImg(l.path); if (!base.complete || !base.width) return;
        var layer = base;
        if (l.tint && typeof Tint !== 'undefined' && Tint.TINTS[l.tint]) {
          var mask = pvImg(maskPath(l.path));
          if (mask.complete && mask.width) layer = Tint.getTintedLayer(base, mask, Tint.TINTS[l.tint]);
        }
        try { g.drawImage(layer, 0, 0, c.width, c.height); } catch (e) { /* image still loading */ }
      });
    }
    draw();
    look.forEach(function (l) {                               // redraw as each sprite/mask finishes loading
      [pvImg(l.path), l.tint ? pvImg(maskPath(l.path)) : null].forEach(function (im) { if (im && !im.complete) im.addEventListener('load', draw, { once: true }); });
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
