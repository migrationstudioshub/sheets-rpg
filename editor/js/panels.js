/**
 * Editor panels: toolbar, map panel, palette, inspector (entity forms built from
 * the Kinds tab, definition forms for objects and terrain), status bar.
 */
var Panels = (function () {
  function $(id) { return document.getElementById(id); }
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
      var c = arguments[i];
      if (c == null || c === false) continue;
      (Array.isArray(c) ? c : [c]).forEach(function (x) { if (x != null && x !== false) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    }
    return el;
  }
  function T() { return E.content.config.tile_size || 32; }

  // ------------------------------------------------------------ thumbnails
  function thumb(type, id, size) {
    size = size || 32;
    var c = h('canvas', { width: T(), height: T(), className: 'thumb' }), g = c.getContext('2d');
    c.style.width = c.style.height = size + 'px';
    g.imageSmoothingEnabled = false;
    if (type === 'terrain') {
      var t = E.content.terrain[id]; if (!t) return c;
      var ts = t.autotile && E.content.tilesets[t.autotile], img;   // no art → empty thumb (shows what needs art)
      if (ts && (img = Assets.get(ts.image))) {
        var full = (E.content.autotile[ts.layout] || {})[255], n = full ? full[0] : 1, i = n - 1;
        g.drawImage(img, (i % ts.columns) * ts.tileSize, Math.floor(i / ts.columns) * ts.tileSize, ts.tileSize, ts.tileSize, 0, 0, T(), T());
      } else if (t.sprite && (img = Assets.get(t.sprite))) g.drawImage(img, 0, 0, T(), T());
    } else if (type === 'monster') {
      var mo = E.content.monsters[id], mi = mo && mo.sprite && Assets.get(mo.sprite);
      g.fillStyle = '#3a2a2a'; g.fillRect(0, 0, T(), T());
      if (mi) g.drawImage(mi, 0, 0, T(), T()); else g.drawImage(Assets.placeholder(mo ? mo.name : '?', '#8a2f2f', T()), 0, 0);
    } else {
      var o = E.content.objects[id], oi = o && o.sprite && Assets.get(o.sprite);
      g.fillStyle = '#2a2f3a'; g.fillRect(0, 0, T(), T());
      if (oi) g.drawImage(oi, 0, 0, T(), T());
      else g.drawImage(Assets.placeholder(o ? o.name : '?', '#7a5a3a', T()), 0, 0);
    }
    return c;
  }

  // ------------------------------------------------------------ toolbar
  var TOOLS = [['select', 'Select / move', 'V'], ['brush', 'Brush', 'B'], ['rect', 'Rectangle', 'R'],
    ['fill', 'Fill', 'F'], ['erase', 'Erase', 'E']];   // eyedropper removed: right-click picks into the stamp
  var ICONS = { select: '⬚', brush: '✎', rect: '▭', fill: '▧', pick: '⊙', erase: '⌫' };

  function toolbar() {
    var bar = $('toolbar'); bar.innerHTML = '';
    var tools = h('div', { className: 'group' }, TOOLS.map(function (t) {
      return h('button', { className: 'tool' + (E.tool === t[0] ? ' on' : ''), title: t[1] + ' (' + t[2] + ')',
        onclick: function () { E.setTool(t[0]); } }, h('span', { className: 'ico', text: ICONS[t[0]] }), ' ' + t[1].split(' ')[0]);
    }));
    var layers = h('div', { className: 'group' },
      h('span', { className: 'lbl', text: 'Layer' }),
      layerBtn('terrain', 'Terrain', '1'), layerBtn('objects', 'Objects', '2'));
    var sub = E.layer === 'terrain' ? h('div', { className: 'group' },
      h('span', { className: 'lbl', text: 'Paint' }), subBtn('base', 'Base'), subBtn('overlay', 'Overlay')) : null;
    var view = h('div', { className: 'group' },
      toggle('grid', 'Grid (G)'),
      h('button', { title: 'Fit map in view (0)', onclick: E.fitView, text: 'Fit' }),
      h('button', { title: 'Undo (Ctrl+Z)', onclick: E.doUndo, text: '↶' }),
      h('button', { title: 'Redo (Ctrl+Y)', onclick: E.doRedo, text: '↷' }));
    var save = h('div', { className: 'group right' },
      Store.online() ? null : h('button', { title: 'Download tables.json to commit to the repository', text: 'Export',
        onclick: function () { E.syncAll(); Store.exportFile(E.tables); } }),
      Store.online() ? null : h('button', { title: 'Throw away this browser\'s draft and reload the repository data', text: 'Discard draft',
        onclick: function () { if (confirm('Discard all draft changes in this browser?')) { Store.discardDraft(); Store.clearWip(); E.dirty = { maps: {}, tabs: {}, deleted: [] }; location.reload(); } } }),
      h('button', { title: 'Open the game on this map in a new tab', text: '▶ Play-test', onclick: playtest }),
      h('button', { className: 'primary', title: Store.online() ? 'Save to the Game Data spreadsheet (Ctrl+S)' : 'Save a draft in this browser (Ctrl+S)',
        text: Store.online() ? 'Save to Game Data' : 'Save draft', onclick: E.save }));
    bar.appendChild(tools); bar.appendChild(layers); if (sub) bar.appendChild(sub);
    bar.appendChild(view); bar.appendChild(save);
  }
  // Base = the opaque ground layer; Overlay = autotiles drawn on top (transparent outside their shape).
  // Which layer a terrain paints on by default when selected. Walls (…_top_auto.png) are structural — their
  // front faces are drawn only from the base grid — so they're always base, even if tagged otherwise. Then an
  // explicit per-terrain default wins; otherwise plain tiles are base and other autotiles overlay.
  function terrainDefaultLayer(d) {
    var ts = d.autotile && E.content.tilesets[d.autotile];
    var info = ts && typeof Scatter !== 'undefined' && Scatter.tileInfo ? Scatter.tileInfo(ts.image) : null;
    if (info && info.isWall) return 'base';
    if (d.layer === 'overlay' || d.layer === 'base') return d.layer;
    return d.autotile ? 'overlay' : 'base';
  }
  function subBtn(id, label) {
    return h('button', { className: 'tool' + (E.terrainLayer === id ? ' on' : ''),
      title: id === 'base' ? 'Paint the ground layer (opaque)' : 'Paint autotiles on top of the ground (transparent outside their shape); the eraser clears them',
      text: label,
      onclick: function () {
        E.terrainLayer = id;
        if (id === 'base' && E.tool === 'erase') E.tool = 'brush';   // the ground can't be erased
        toolbar(); E.redraw();
      } });
  }
  function layerBtn(id, label, key) {
    return h('span', { className: 'layer' + (E.layer === id ? ' on' : '') },
      h('button', { className: 'eye', title: 'Show / hide', text: E.show[id] ? '◉' : '○',
        onclick: function () { E.show[id] = !E.show[id]; toolbar(); E.redraw(); } }),
      h('button', { title: 'Edit the ' + label.toLowerCase() + ' layer (' + key + ')', text: label,
        onclick: function () { E.setPaletteTab(id === 'terrain' ? 'terrain' : (E.paletteTab === 'monsters' ? 'monsters' : 'objects')); all(); E.redraw(); } }));
  }
  function toggle(what, title) {
    return h('button', { className: E.show[what] ? 'on' : '', title: title, text: 'Grid',
      onclick: function () { E.show[what] = !E.show[what]; toolbar(); E.redraw(); } });
  }
  function playtest() {
    // Play-test runs the game OFFLINE against the editor's current content, so you play the map you're
    // editing (online, your saved character stays on its own map and the ?map warp is disabled). The
    // editor's tables (maps included) are handed to the offline game through the shared content draft.
    var go = function () {
      E.syncAll();
      try { localStorage.setItem('sheetsrpg.contentDraft', JSON.stringify(E.tables)); } catch (e) {}
      window.open('../client/?offline&map=' + encodeURIComponent(E.mapId), 'sheetsrpg-play');
    };
    if (!E.isDirty()) return go();
    if (Store.online() && !confirm('Save your changes to Game Data first, then play?')) return;
    E.save().then(go);
  }

  // ------------------------------------------------------------ map panel
  function maps() {
    var box = $('maps'), m = E.map(); box.innerHTML = '';
    var sel = h('select', { onchange: function () { E.openMap(sel.value); } },
      Object.keys(E.content.maps).map(function (id) {
        return h('option', { value: id, text: E.content.maps[id].name + (E.dirty.maps[id] ? ' •' : ''), selected: id === E.mapId });
      }));
    var name = h('input', { value: m.name, title: 'Map name', onchange: function () {
      E.checkpoint(); m.name = name.value.trim() || m.id; E.markDirty('map'); maps(); } });
    box.appendChild(h('div', { className: 'row' }, sel));
    box.appendChild(h('div', { className: 'row' }, h('label', { text: 'Name' }), name));
    box.appendChild(h('div', { className: 'row small' },
      h('span', { text: m.id + ' · ' + m.width + ' × ' + m.height + ' · ' + m.entities.length + ' objects' })));
    box.appendChild(h('div', { className: 'row buttons' },
      h('button', { text: 'New', onclick: function () {
        Dialogs.prompt('Name of the new map:', 'New map').then(function (name) {
          if (!name) return;
          Dialogs.prompt('Size (width × height):', '24 x 18').then(function (size) {
            if (!size) return;
            var wh = size.match(/\d+/g) || []; var w = Math.min(128, Number(wh[0]) || 16), hh = Math.min(128, Number(wh[1]) || w);
            E.newMap(name, w, hh);
          });
        }); } }),
      h('button', { text: 'Resize', onclick: function () {
        Dialogs.prompt('New size (width × height). New cells are filled with the selected terrain; rows/columns are added or cut at the right and bottom.', m.width + ' x ' + m.height).then(function (size) {
          if (!size) return; var wh = size.match(/\d+/g) || [];
          E.resizeMap(Math.max(1, Math.min(128, Number(wh[0]) || m.width)), Math.max(1, Math.min(128, Number(wh[1]) || m.height)));
        }); } }),
      h('button', { text: 'Duplicate', onclick: E.duplicateMap }),
      h('button', { text: 'Delete', className: 'danger', onclick: function () {
        if (confirm('Delete "' + m.name + '"? You can still undo by not saving (reload the page).')) E.deleteMap(); } })));
  }

  // ------------------------------------------------------------ palette
  var filter = '';
  var TAB_NAMES = { terrain: 'Terrain', objects: 'Objects', monsters: 'Monsters' };
  function palette() {
    var box = $('palette'); box.innerHTML = '';
    var paletteTab = E.paletteTab;
    var tabs = h('div', { className: 'tabs' },
      ['terrain', 'objects', 'monsters'].map(function (t) {
        return h('button', { className: paletteTab === t ? 'on' : '', text: TAB_NAMES[t],
          onclick: function () { E.setPaletteTab(t); all(); E.redraw(); } });
      }));
    var defType = paletteTab === 'terrain' ? 'terrain' : paletteTab === 'monsters' ? 'monster' : 'object';
    var current = paletteTab === 'terrain' ? E.brush.terrain : paletteTab === 'monsters' ? E.brush.monster : E.brush.object;
    var search = h('input', { placeholder: 'Search…', value: filter, oninput: function () { filter = search.value; list(); } });
    var listBox = h('div', { className: 'items' });
    box.appendChild(tabs); box.appendChild(search); box.appendChild(listBox);
    box.appendChild(h('div', { className: 'row buttons' },
      h('button', { text: '✎ Edit selected', onclick: function () { editDef(defType, current); } }),
      h('button', { text: '+ New ' + defType, onclick: function () { newDef(defType); } })));
    if (paletteTab === 'monsters') box.appendChild(h('p', { className: 'note',
      text: 'Paint a monster to place a spawn point. Select it (V) to set how many appear and how far they roam.' }));

    function list() {
      listBox.innerHTML = '';
      var f = filter.trim().toLowerCase();
      function match(d) { return !f || (d.name + ' ' + d.id + ' ' + (d.kind || '')).toLowerCase().indexOf(f) >= 0; }
      function item(type, d, on) {
        return h('button', { className: 'item' + (on ? ' on' : ''), title: d.name + ' (' + d.id + ')' + (d.kind ? ' · ' + d.kind : '') + '\nDouble-click to edit',
          onclick: function () {
            if (type === 'terrain') { E.brush.terrain = d.id; E.layer = 'terrain';
              E.terrainLayer = terrainDefaultLayer(d);   // walls + plain tiles → base, other autotiles → overlay
              if (E.terrainLayer === 'base' && E.tool === 'erase') E.tool = 'brush';   // the ground can't be erased
              if (E.clearStamp) E.clearStamp(); }
            else if (type === 'monster') { E.brush.monster = d.id; E.layer = 'objects'; }
            else { E.brush.object = d.id; E.layer = 'objects'; }
            if (E.tool === 'select' || E.tool === 'pick' || E.tool === 'erase') E.tool = 'brush';
            toolbar(); list(); E.redraw();
          },
          ondblclick: function () { editDef(type, d.id); } }, thumb(type, d.id), h('span', { text: d.name }));
      }
      if (paletteTab === 'terrain') {
        var terrains = Object.keys(E.content.terrain).map(function (k) { return E.content.terrain[k]; }).filter(match);
        [['Tiles', function (t) { return !t.autotile; }], ['Autotiles', function (t) { return !!t.autotile; }]].forEach(function (grp) {
          var members = terrains.filter(grp[1]);
          if (!members.length) return;
          listBox.appendChild(h('div', { className: 'kind', text: grp[0] }));
          members.forEach(function (t) { listBox.appendChild(item('terrain', t, E.brush.terrain === t.id)); });
        });
      } else if (paletteTab === 'monsters') {
        Object.keys(E.content.monsters).map(function (k) { return E.content.monsters[k]; }).filter(match)
          .forEach(function (m) { listBox.appendChild(item('monster', m, E.brush.monster === m.id)); });
        if (!Object.keys(E.content.monsters).length) listBox.appendChild(h('div', { className: 'kind', text: 'No monsters yet: add one with + New monster' }));
      } else {
        var byKind = {};
        Object.keys(E.content.objects).map(function (k) { return E.content.objects[k]; })
          .filter(function (o) { return o.kind !== 'spawn'; })            // monsters have their own tab
          .filter(match).forEach(function (o) { (byKind[o.kind] = byKind[o.kind] || []).push(o); });
        Object.keys(byKind).sort().forEach(function (k) {
          listBox.appendChild(h('div', { className: 'kind', text: k }));
          byKind[k].forEach(function (o) { listBox.appendChild(item('object', o, E.brush.object === o.id)); });
        });
      }
    }
    list();
  }

  // ------------------------------------------------------------ fields (shared by entity and definition forms)
  var HINT = { item: 'item id (Items tab arrives in milestone 3)', item_list: 'e.g. potion:2, gold:30',
    loot_table: 'loot table id (milestone 3)', dialogue: 'dialogue id (milestone 5)', monster: 'monster id (milestone 3)',
    shop: 'shop id (milestone 5)', text: '' };

  /** One input for a property type. get() = current value or undefined; set(v) stores it (undefined = default). */
  function field(name, prop, value, set, ctx) {
    var type = prop.type || 'text', def = prop['default'], input, row;
    var label = h('label', { text: name.replace(/_/g, ' '), title: prop.notes || '' });
    function changed(v) { set(v === '' || v === undefined || v === def || String(v) === String(def) ? undefined : v); }

    if (type === 'bool') {
      input = h('input', { type: 'checkbox', checked: value === undefined ? !!def : !!value,
        onchange: function () { changed(input.checked); } });
    } else if (type === 'number') {
      input = h('input', { type: 'number', value: value === undefined ? '' : value, placeholder: def === '' || def == null ? '' : String(def),
        onchange: function () { changed(input.value === '' ? undefined : Number(input.value)); } });
    } else if (type.indexOf('select:') === 0) {
      input = h('select', { onchange: function () { changed(input.value); } },
        type.slice(7).split('|').map(function (o) { return h('option', { value: o, text: o + (o === def ? ' (default)' : ''), selected: (value === undefined ? def : value) === o }); }));
    } else if (type === 'monster' || type === 'item' || type === 'loot_table') {
      var src = type === 'monster' ? E.content.monsters : type === 'item' ? E.content.items : E.content.loot;
      var cur = value === undefined ? def : value;
      input = h('select', { onchange: function () { changed(input.value); } },
        [h('option', { value: '', text: '(none)' })].concat(Object.keys(src || {}).map(function (id) {
          var label = src[id].name ? src[id].name + ' (' + id + ')' : id;
          return h('option', { value: id, text: label + (id === def ? ' (default)' : ''), selected: id === cur });
        })));
    } else if (type === 'map_pos') {
      return mapPosField(label, name, value, changed, ctx);
    } else if (type === 'entity_list') {
      return entityListField(label, name, value, changed, ctx);
    } else if (name === 'text' || name === 'do') {
      input = h('textarea', { rows: 3, value: value === undefined ? '' : value, placeholder: def ? String(def) : '',
        onchange: function () { changed(input.value); } });
    } else {
      input = h('input', { value: value === undefined ? '' : value, placeholder: def ? String(def) : (HINT[type] || ''),
        onchange: function () { changed(input.value.trim()); } });
    }
    row = h('div', { className: 'field' }, label, input);
    if (prop.notes) row.appendChild(h('div', { className: 'note', text: prop.notes }));
    return row;
  }

  function parsePos(v) {
    var p = String(v || '').split(':');
    return p.length === 3 ? { map: p[0], x: Number(p[1]), y: Number(p[2]) } : null;
  }
  function mapPosField(label, name, value, changed, ctx) {
    var pos = parsePos(value) || { map: '', x: '', y: '' };
    var sel = h('select', {}, [h('option', { value: '', text: '(none)' })].concat(Object.keys(E.content.maps).map(function (id) {
      return h('option', { value: id, text: E.content.maps[id].name, selected: id === pos.map });
    })));
    var x = h('input', { type: 'number', value: pos.x, className: 'num', title: 'x' });
    var y = h('input', { type: 'number', value: pos.y, className: 'num', title: 'y' });
    function commit() { changed(sel.value ? sel.value + ':' + (Number(x.value) || 0) + ':' + (Number(y.value) || 0) : undefined); }
    sel.onchange = x.onchange = y.onchange = commit;
    var pick = h('button', { text: 'Pick on map', onclick: function () {
      startPick({ type: 'pos', entity: ctx.entity.key, prop: name, back: E.mapId, target: sel.value || E.mapId });
    } });
    return h('div', { className: 'field' }, label, h('div', { className: 'inline' }, sel, x, y), pick);
  }
  function entityListField(label, name, value, changed, ctx) {
    var keys = String(value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var shown = keys.map(function (k) {
      var e = E.entityByKey(k), o = e && E.content.objects[e.ref];
      return o ? o.name + ' (' + e.x + ',' + e.y + ')' : k + ' (other map)';
    });
    return h('div', { className: 'field' }, label,
      h('div', { className: 'chips' }, shown.length ? shown.map(function (s) { return h('span', { className: 'chip', text: s }); }) : h('span', { className: 'note', text: 'nothing linked' })),
      h('button', { text: 'Pick on map', onclick: function () {
        startPick({ type: 'entities', entity: ctx.entity.key, prop: name, keys: keys.slice(), back: E.mapId });
      } }));
  }

  // ------------------------------------------------------------ pick modes
  function startPick(mode) {
    E.mode = mode;
    if (mode.type === 'pos' && mode.target !== E.mapId) { var s = E.selected; E.openMap(mode.target); E.mode = mode; E.selected = s; }
    inspector(); E.redraw();
  }
  function setProp(entityKey, mapId, prop, value) {
    var m = E.content.maps[mapId], e = m && m.entities.filter(function (x) { return x.key === entityKey; })[0];
    if (!e) return;
    E.checkpoint();
    if (value === undefined || value === '') delete e.data[prop]; else e.data[prop] = value;
    E.dirty.maps[mapId] = true; E.groundDirty = true; status(); if (E.scheduleWip) E.scheduleWip();
  }
  function pickAt(cell) {
    var mode = E.mode;
    if (!mode || !E.inside(cell.x, cell.y)) return;
    if (mode.type === 'pos') {
      var target = E.mapId;
      E.mode = null;
      if (mode.back !== E.mapId) E.openMap(mode.back);
      E.selected = mode.entity;
      setProp(mode.entity, mode.back, mode.prop, target + ':' + cell.x + ':' + cell.y);
      inspector(); E.redraw();
    } else if (mode.type === 'entities') {
      var e = E.entityAt(cell.x, cell.y);
      if (!e || e.key === mode.entity) return;
      var i = mode.keys.indexOf(e.key);
      if (i >= 0) mode.keys.splice(i, 1); else mode.keys.push(e.key);
      inspector();
    }
  }
  function endPick(apply) {
    var mode = E.mode; E.mode = null;
    if (mode && mode.type === 'entities' && apply) setProp(mode.entity, mode.back, mode.prop, mode.keys.join(', '));
    if (mode && mode.back !== E.mapId) E.openMap(mode.back);
    if (mode) E.selected = mode.entity;
    inspector(); E.redraw();
  }

  /** Where the selected entity points: used to draw link lines on the map. */
  function links(e) {
    var o = E.content.objects[e.ref], kind = o && E.content.kinds[o.kind], out = [];
    if (!kind) return out;
    Object.keys(kind.props).forEach(function (p) {
      var t = kind.props[p].type, v = e.data[p] !== undefined ? e.data[p] : (o.properties[p] !== undefined ? o.properties[p] : kind.props[p]['default']);
      if (t === 'map_pos') { var pos = parsePos(v); if (pos) out.push(pos); }
      if (t === 'entity_list') String(v || '').split(',').forEach(function (k) {
        var t2 = E.entityByKey(k.trim()); if (t2) out.push({ map: E.mapId, x: t2.x, y: t2.y });
      });
    });
    return out;
  }

  // ------------------------------------------------------------ inspector
  var lastCell = null, defEdit = null;
  function inspector(cell) {
    if (cell) lastCell = cell;
    var box = $('inspector'); box.innerHTML = '';
    if (E.mode) return box.appendChild(pickHelp());
    var e = E.selected && E.entityByKey(E.selected);
    if (e) { defEdit = null; return box.appendChild(entityForm(e)); }
    if (defEdit) return box.appendChild(defForm(defEdit.type, defEdit.id));
    box.appendChild(help());
  }

  function pickHelp() {
    var m = E.mode;
    if (m.type === 'pos') return h('div', { className: 'pick' }, h('h3', { text: 'Pick a destination' }),
      h('p', { text: 'Click the cell to arrive at. You can switch maps with the map list on the left.' }),
      h('button', { text: 'Cancel (Esc)', onclick: function () { endPick(false); } }));
    return h('div', { className: 'pick' }, h('h3', { text: 'Pick linked objects' }),
      h('p', { text: 'Click objects on this map to link or unlink them. ' + m.keys.length + ' linked.' }),
      h('div', { className: 'row buttons' },
        h('button', { className: 'primary', text: 'Done', onclick: function () { endPick(true); } }),
        h('button', { text: 'Cancel', onclick: function () { endPick(false); } })));
  }

  function entityForm(e) {
    var o = E.content.objects[e.ref], kind = (o && E.content.kinds[o.kind]) || { props: {}, states: [] };
    var wrap = h('div', { className: 'form' });
    wrap.appendChild(h('div', { className: 'head' }, thumb('object', e.ref, 40),
      h('div', {}, h('h3', { text: o ? o.name : e.ref }), h('div', { className: 'note', text: (o ? o.kind : 'unknown object') + ' · ' + e.key + ' · (' + e.x + ', ' + e.y + ')' }))));

    var objSel = h('select', { onchange: function () { E.checkpoint(); e.ref = objSel.value; E.markDirty('map'); inspector(); } },
      Object.keys(E.content.objects).map(function (id) { var d = E.content.objects[id];
        return h('option', { value: id, text: d.name + ' (' + d.kind + ')', selected: id === e.ref }); }));
    wrap.appendChild(h('div', { className: 'field' }, h('label', { text: 'object' }), objSel));

    if (kind.states.length) {
      var st = h('select', { onchange: function () { setProp(e.key, E.mapId, 'state', st.value === kind.states[0] ? undefined : st.value); E.redraw(); } },
        kind.states.map(function (s, i) { return h('option', { value: s, text: s + (i === 0 ? ' (default)' : ''), selected: (e.data.state || kind.states[0]) === s }); }));
      wrap.appendChild(h('div', { className: 'field' }, h('label', { text: 'starts as' }), st));
    }
    var props = Object.keys(kind.props);
    if (props.length) wrap.appendChild(h('div', { className: 'sub', text: 'Properties of this ' + (o ? o.kind : 'object') }));
    props.forEach(function (p) {
      var prop = Object.assign({}, kind.props[p]);
      if (o && o.properties[p] !== undefined) prop['default'] = o.properties[p]; // the object's own default wins over the kind's
      wrap.appendChild(field(p, prop, e.data[p], function (v) { setProp(e.key, E.mapId, p, v); inspector(); E.redraw(); }, { entity: e }));
    });
    if (!props.length && !kind.states.length) wrap.appendChild(h('p', { className: 'note', text: 'This kind has no settings. Add rows to the Kinds tab to give it some.' }));
    wrap.appendChild(h('div', { className: 'row buttons' },
      h('button', { text: '✎ Edit "' + (o ? o.name : e.ref) + '" for every map', onclick: function () { E.selected = null; editDef('object', e.ref); } }),
      h('button', { className: 'danger', text: 'Delete (Del)', onclick: function () {
        E.checkpoint(); var m = E.map(); m.entities.splice(m.entities.indexOf(e), 1); E.selected = null; E.markDirty('map'); inspector(); } })));
    return wrap;
  }

  function help() {
    return h('div', { className: 'help' }, h('h3', { text: 'Map editor' }),
      h('p', { text: 'Pick terrain or an object on the left, then paint. Use Select (V) and click an object to set its properties, such as a chest\'s contents or where a door leads.' }),
      h('p', { text: 'Terrain has two layers: paint a plain ground on Base, then autotiles (grass, roads) on Overlay. Right-drag copies tiles into a stamp; Shift+Left stamps them (or an autotile\'s plain centre tile).' }),
      h('table', {}, [['B', 'brush'], ['R', 'rectangle'], ['F', 'fill'], ['I', 'eyedropper'], ['E', 'erase'], ['V', 'select / drag to move'],
        ['1 / 2 / 3', 'terrain / objects / monsters'], ['G', 'grid'], ['0', 'fit map'], ['Space / middle-drag', 'pan'], ['Wheel', 'zoom'],
        ['Right-drag', 'copy tiles to the stamp (both layers)'], ['Shift+Right-drag', 'also copy exact autotile shapes'],
        ['Shift+Left', 'stamp the copy, or an autotile\'s centre tile'],
        ['Ctrl+Z / Ctrl+Y', 'undo / redo'], ['Ctrl+S', 'save'], ['Del', 'delete selected object'], ['Esc', 'cancel']].map(function (r) {
          return h('tr', {}, h('td', { className: 'k', text: r[0] }), h('td', { text: r[1] }));
        })));
  }

  // ------------------------------------------------------------ definition forms (Objects / Terrain rows)
  function editDef(type, id) { if (!id) return; E.selected = null; E.mode = null; defEdit = { type: type, id: id }; inspector(); }

  var DEF_TAB = { terrain: 'Terrain', object: 'Objects', monster: 'Monsters' };
  function newDef(type) {
    Dialogs.prompt('Name of the new ' + type + ':').then(function (name) {
    if (!name) return;
    var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'new';
    var tab = DEF_TAB[type], pre = type === 'terrain' ? 'ter_' : type === 'monster' ? '' : 'obj_', id = pre + slug, n = 2;
    E.tables[tab] = E.tables[tab] || [];
    var exists = function (x) { return (E.tables[tab] || []).some(function (r) { return String(r.id) === x; }); };
    while (exists(id)) id = pre + slug + '_' + n++;
    var row = type === 'terrain'
      ? { id: id, name: name, color: '#808080', sprite: '', autotile: '', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1, frames: '', frame_ms: '', notes: '' }
      : type === 'monster'
      ? { id: id, name: name, sprite: '', hp: 10, atk: 3, def: 0, xp: 3, gold_min: 0, gold_max: 2, loot_table: '', aggro_range: 4, move_ms: 800, respawn_s: 60, notes: '' }
      : { id: id, name: name, kind: 'deco', sprite: '', sprite_top: '', sprite_states: '', frames: '', frame_ms: '', walkable: false, properties: '', on_interact: '', notes: '' };
    E.tables[tab].push(row);
    E.dirty.tabs[tab] = true;
    if (type === 'terrain') E.brush.terrain = id; else if (type === 'monster') E.brush.monster = id; else E.brush.object = id;
    E.rebuild().then(function () { editDef(type, id); });
    });
  }

  function defForm(type, id) {
    var tab = DEF_TAB[type];
    var rec = (E.tables[tab] || []).filter(function (r) { return String(r.id) === id; })[0];
    if (!rec) return h('p', { text: 'Not found: ' + id });
    var draft = JSON.parse(JSON.stringify(rec));
    var wrap = h('div', { className: 'form' });
    wrap.appendChild(h('div', { className: 'head' }, thumb(type, id, 40),
      h('div', {}, h('h3', { text: { terrain: 'Terrain: ', object: 'Object: ', monster: 'Monster: ' }[type] + (rec.name || id) }),
        h('div', { className: 'note', text: id + ' · changes apply everywhere it is used' }))));
    function text(k, label, hint) {
      var i = h('input', { value: draft[k] == null ? '' : draft[k], placeholder: hint || '', oninput: function () { draft[k] = i.value; } });
      return h('div', { className: 'field' }, h('label', { text: label }), i);
    }
    function check(k, label) {
      var i = h('input', { type: 'checkbox', checked: Content.bool(draft[k]), onchange: function () { draft[k] = i.checked; } });
      return h('div', { className: 'field check' }, i, h('label', { text: label }));
    }
    function preview(k) {
      var img = h('img', { className: 'preview' });
      function upd() { img.src = Assets.resolve(draft[k] || ''); img.style.display = draft[k] ? '' : 'none'; }
      upd(); setTimeout(function () { var inp = img.previousSibling && img.parentNode.querySelector('input'); if (inp) inp.addEventListener('input', upd); });
      return img;
    }

    if (type === 'monster') {
      wrap.appendChild(text('name', 'name'));
      var msp = text('sprite', 'sprite', 'image URL or art/… path'); msp.appendChild(preview('sprite')); wrap.appendChild(msp);
      [['hp', 'health'], ['atk', 'attack'], ['def', 'defence'], ['xp', 'XP when defeated'], ['gold_min', 'gold dropped (min)'],
        ['gold_max', 'gold dropped (max)'], ['aggro_range', 'notices players within (tiles)'], ['move_ms', 'ms per step (lower = faster)'],
        ['respawn_s', 'seconds until it comes back']].forEach(function (f) { wrap.appendChild(text(f[0], f[1])); });
      var lt = h('select', { onchange: function () { draft.loot_table = lt.value; } },
        [h('option', { value: '', text: '(no drops)' })].concat(Object.keys(E.content.loot).map(function (k) {
          return h('option', { value: k, text: k, selected: draft.loot_table === k }); })));
      wrap.appendChild(h('div', { className: 'field' }, h('label', { text: 'loot table' }), lt));
    } else if (type === 'terrain') {
      wrap.appendChild(text('name', 'name'));
      var sp = text('sprite', 'sprite', 'image URL or art/… path'); sp.appendChild(preview('sprite')); wrap.appendChild(sp);
      var at = h('select', { onchange: function () { draft.autotile = at.value; } },
        [h('option', { value: '', text: '(none: use the sprite)' })].concat(Object.keys(E.content.tilesets).map(function (k) {
          return h('option', { value: k, text: k, selected: draft.autotile === k }); })));
      wrap.appendChild(h('div', { className: 'field' }, h('label', { text: 'autotile' }), at));
      wrap.appendChild(h('div', { className: 'inline' }, text('frames', 'animation frames', '1'), text('frame_ms', 'ms per frame', '200')));
      wrap.appendChild(h('div', { className: 'sub', text: 'Can be crossed from' }));
      wrap.appendChild(h('div', { className: 'inline' }, check('pass_n', 'north'), check('pass_e', 'east'), check('pass_s', 'south'), check('pass_w', 'west')));
    } else {
      wrap.appendChild(text('name', 'name'));
      var ks = h('select', { onchange: function () { draft.kind = ks.value; } },
        Object.keys(E.content.kinds).map(function (k) { return h('option', { value: k, text: k, selected: draft.kind === k }); }));
      wrap.appendChild(h('div', { className: 'field' }, h('label', { text: 'kind' }), ks));
      var sp2 = text('sprite', 'sprite', 'image URL or art/… path'); sp2.appendChild(preview('sprite')); wrap.appendChild(sp2);
      var top = text('sprite_top', 'top part (tall objects)', 'drawn one tile up, over characters'); top.appendChild(preview('sprite_top')); wrap.appendChild(top);
      wrap.appendChild(text('sprite_states', 'sprite per state', 'open=https://…; empty=https://…'));
      wrap.appendChild(h('div', { className: 'inline' }, text('frames', 'animation frames', '1'), text('frame_ms', 'ms per frame', '200')));
      wrap.appendChild(check('walkable', 'players can walk over it'));
      wrap.appendChild(text('on_interact', 'on interact', 'e.g. give:potion:1; flag:found_it'));
      var kind = E.content.kinds[draft.kind];
      if (kind && Object.keys(kind.props).length) {
        var props = {}; try { props = draft.properties ? JSON.parse(draft.properties) : {}; } catch (er) {}
        wrap.appendChild(h('div', { className: 'sub', text: 'Defaults for every placed ' + draft.name }));
        Object.keys(kind.props).forEach(function (p) {
          if (kind.props[p].type === 'map_pos' || kind.props[p].type === 'entity_list') return; // only make sense per placement
          wrap.appendChild(field(p, kind.props[p], props[p], function (v) {
            if (v === undefined) delete props[p]; else props[p] = v;
            draft.properties = Object.keys(props).length ? JSON.stringify(props) : '';
          }, {}));
        });
      }
    }
    wrap.appendChild(text('notes', 'notes'));
    wrap.appendChild(h('div', { className: 'row buttons' },
      h('button', { className: 'primary', text: 'Apply', onclick: function () {
        Object.keys(draft).forEach(function (k) {   // numbers typed into text boxes stay numbers
          var v = draft[k]; rec[k] = typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) && typeof rec[k] === 'number' ? Number(v) : v;
        });
        E.dirty.tabs[tab] = true;
        E.rebuild().then(function () { editDef(type, id); status('applied: remember to save'); });
      } }),
      h('button', { text: 'Close', onclick: function () { defEdit = null; inspector(); } })));
    return wrap;
  }

  // ------------------------------------------------------------ status bar
  var lastMsg = '', lastBad = false;
  function status(msg, bad) {
    if (msg !== undefined) { lastMsg = msg; lastBad = !!bad; }
    var s = $('status');
    var dirty = E.isDirty();
    s.innerHTML = '';
    s.appendChild(h('span', { className: 'mode', text: Store.online() ? 'online' : 'offline' }));
    s.appendChild(h('span', { className: dirty ? 'dirty' : 'clean', text: dirty ? '● unsaved changes' : '✓ all saved' }));
    s.appendChild(h('span', { className: lastBad ? 'bad' : '', text: lastMsg }));
    s.appendChild(h('span', { className: 'right', text: Math.round(E.view.zoom * 100) + '%' }));
    var sel = document.querySelector('#maps select');
    if (sel) Array.prototype.forEach.call(sel.options, function (o) { o.text = E.content.maps[o.value].name + (E.dirty.maps[o.value] ? ' •' : ''); });
  }
  function cellInfo(cell) {
    var box = $('cellinfo');
    if (!E.inside(cell.x, cell.y)) { box.textContent = ''; return; }
    var t = E.content.terrain[E.map().terrain[cell.y][cell.x]], e = E.entityAt(cell.x, cell.y), o = e && E.content.objects[e.ref];
    box.textContent = '(' + cell.x + ', ' + cell.y + ')  ' + (t ? t.name : '?') + (o ? '  ·  ' + o.name + ' [' + o.kind + ']' : '');
  }

  function all() { toolbar(); maps(); palette(); inspector(); status(); }
  return { all: all, toolbar: toolbar, maps: maps, palette: palette, inspector: inspector, status: status, cellInfo: cellInfo,
    links: links, pickAt: pickAt, endPick: endPick, editDef: editDef };
})();
