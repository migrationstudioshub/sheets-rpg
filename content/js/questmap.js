// Content Studio: the questline map beside the Quests view. A picture only: it reads the quest rows (the draft) and
// draws every link one quest makes to another, so a questline can be followed at a glance. Nothing here is a rule;
// the rules that the links stand for are in shared/world.js (rewards, before_start, on_start, a goal's on_done, requires).
//   QuestMap.draw(box, rows, startIds, selectedId, {pick(id), move(id, x, y)})   QuestMap.fit()
// rows = the Quests table (raw records), startIds = Config start_quests. One canvas: boxes are dragged anywhere
// (move = where it was dropped; the Studio keeps it on the row as map_xy "x,y", so the layout is published with the
// quests and the game ignores it); a box with no map_xy is placed by the automatic layout. The view is moved by
// holding the mouse wheel (or dragging empty space) and zoomed with the wheel; it is kept across redraws.
var QuestMap = (function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var NW = 130, NH = 38, GX = 12, GY = 46, PAD = 6;
  // One look per kind of link. `from → to` always reads "from leads to to".
  var KINDS = {
    start:    { color: '#5aa0ff', dash: '',    name: 'starts with',     tip: 'starts with it (on_start)' },
    goal:     { color: '#e0a040', dash: '',    name: 'objective met',   tip: 'starts it when an objective is met' },
    reward:   { color: '#6fbf73', dash: '',    name: 'reward',          tip: 'starts it when handed in (rewards)' },
    requires: { color: '#9aa3b2', dash: '5 4', name: 'unlocks',         tip: 'must be done first (requires)' }
  };

  function str(v) { return v == null ? '' : String(v).trim(); }
  function isOn(v) { return v === true || /^(true|yes|1|on)$/i.test(str(v)); }
  /** The quest ids an action list starts ("xp:5; quest:next; quest:tut_x"). */
  function startsIn(text) {
    return str(text).split(';').map(function (x) { return x.trim().split(':'); })
      .filter(function (a) { return a[0].trim() === 'quest' && a[1]; }).map(function (a) { return a[1].trim(); });
  }
  function goalsOf(r) {
    try { return (typeof Content !== 'undefined' && Content.parseGoals) ? Content.parseGoals(r.objectives) : []; } catch (e) { return []; }
  }

  /** Nodes (known quests + ids that are linked to but do not exist) and edges {from, to, kind, tip}. */
  function graph(rows) {
    var nodes = {}, order = [], edges = [];
    rows.forEach(function (r, i) {
      var id = str(r.id); if (!id || nodes[id]) return;
      nodes[id] = { id: id, name: str(r.name) || id, tutorial: isOn(r.tutorial), row: i };
      order.push(id);
    });
    function link(from, to, kind, tip) {
      if (!from || !to || from === to) return;
      if (!nodes[to]) { nodes[to] = { id: to, name: to, missing: true, row: 1e6 + order.length }; order.push(to); }
      if (!nodes[from]) { nodes[from] = { id: from, name: from, missing: true, row: 1e6 + order.length }; order.push(from); }
      edges.push({ from: from, to: to, kind: kind, tip: tip || KINDS[kind].tip });
    }
    rows.forEach(function (r) {
      var id = str(r.id); if (!id) return;
      startsIn(r.before_start).forEach(function (to) { link(id, to, 'start', 'starts with it, before its window (before_start)'); });
      startsIn(r.on_start).forEach(function (to) { link(id, to, 'start'); });
      goalsOf(r).forEach(function (g, gi) {
        startsIn(g.onDone).forEach(function (to) { link(id, to, 'goal', 'starts it when "' + (g.label || g.type + (g.ref && g.ref !== '*' ? ' ' + g.ref : '')) + '" is met (objective ' + (gi + 1) + ')'); });
      });
      startsIn(r.rewards).forEach(function (to) { link(id, to, 'reward'); });
      str(r.requires).split(',').forEach(function (part) {   // quest:x = x handed in; quest_active:x = x on the go
        var a = part.trim().replace(/^!/, '').split(':');
        if ((a[0] === 'quest' || a[0] === 'quest_active') && a[1] && part.trim().charAt(0) !== '!')
          link(a[1].trim(), id, 'requires', a[0] === 'quest' ? 'must be handed in first (requires)' : 'must be under way (requires quest_active)');
      });
    });
    return { nodes: nodes, order: order, edges: edges };
  }

  /** Questlines = groups of quests joined by any link; a quest with no link at all stands alone. */
  function lines(g) {
    var parent = {};
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    g.order.forEach(function (id) { parent[id] = id; });
    g.edges.forEach(function (e) { var a = find(e.from), b = find(e.to); if (a !== b) parent[a] = b; });
    var groups = {};
    g.order.forEach(function (id) { (groups[find(id)] = groups[find(id)] || []).push(id); });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  /** Layers top to bottom (a quest sits below everything that leads to it, links going back up are drawn round the side). */
  function layout(g, ids) {
    var inLine = {}, out = {}, inc = {};
    ids.forEach(function (id) { inLine[id] = true; out[id] = []; inc[id] = []; });
    var es = g.edges.filter(function (e) { return inLine[e.from] && inLine[e.to]; });
    es.forEach(function (e) { out[e.from].push(e); inc[e.to].push(e); });
    var byRow = ids.slice().sort(function (a, b) { return g.nodes[a].row - g.nodes[b].row; });
    // find the links that go back (a ring): depth-first from the roots, in row order
    var state = {}, back = [];
    function visit(id) {
      state[id] = 1;
      out[id].forEach(function (e) { if (state[e.to] === 1) back.push(e); else if (!state[e.to]) visit(e.to); });
      state[id] = 2;
    }
    byRow.filter(function (id) { return !inc[id].length; }).forEach(function (id) { if (!state[id]) visit(id); });
    byRow.forEach(function (id) { if (!state[id]) visit(id); });   // (a ring with no way in: start at its first row)
    es.forEach(function (e) { e.back = back.indexOf(e) >= 0; });
    // longest path from a root = the layer
    var layer = {}, changed = true, guard = 0;
    ids.forEach(function (id) { layer[id] = 0; });
    while (changed && guard++ < ids.length + 2) {
      changed = false;
      es.forEach(function (e) { if (!e.back && layer[e.to] < layer[e.from] + 1) { layer[e.to] = layer[e.from] + 1; changed = true; } });
    }
    var rowsOf = [];
    byRow.forEach(function (id) { (rowsOf[layer[id]] = rowsOf[layer[id]] || []).push(id); });
    // order within a layer: under what leads to it (two sweeps of the average place of its parents)
    var pos = {};
    function place() { rowsOf.forEach(function (L) { L.forEach(function (id, i) { pos[id] = i - (L.length - 1) / 2; }); }); }
    place();
    for (var sweep = 0; sweep < 2; sweep++) {
      for (var l = 1; l < rowsOf.length; l++) {
        var L = rowsOf[l] || [];
        L.sort(function (a, b) {
          function bary(id) { var ps = inc[id].filter(function (e) { return !e.back; }); return ps.length ? ps.reduce(function (s, e) { return s + pos[e.from]; }, 0) / ps.length : pos[id]; }
          return bary(a) - bary(b) || g.nodes[a].row - g.nodes[b].row;
        });
        L.forEach(function (id, i) { pos[id] = i - (L.length - 1) / 2; });
      }
    }
    var widest = Math.max.apply(null, rowsOf.map(function (L) { return (L || []).length; }));
    var side = back.length ? 44 : 0;                               // room on the right for links going back up
    var W = widest * (NW + GX) - GX + PAD * 2 + side, at = {};
    rowsOf.forEach(function (L, l) {
      (L || []).forEach(function (id) { at[id] = { x: PAD + (W - side - PAD * 2 - NW) / 2 + pos[id] * (NW + GX), y: PAD + 14 + l * (NH + GY) }; });
    });
    return { at: at, edges: es, W: W, H: PAD * 2 + 14 + rowsOf.length * (NH + GY) - GY };
  }

  function el(tag, attrs, kids) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { if (k) e.appendChild(k); });
    return e;
  }
  function clip(text, n) { text = String(text); return text.length > n ? text.slice(0, n - 1) + '…' : text; }
  function savedAt(r) {                                            // map_xy "x,y" on the row = where the author put the box
    var a = str(r && r.map_xy).split(','), x = parseFloat(a[0]), y = parseFloat(a[1]);
    return isFinite(x) && isFinite(y) ? { x: x, y: y } : null;
  }

  // The view (pan + zoom) outlives a redraw: the map is redrawn after every edit, and must stay where it was looked at.
  var view = { x: 12, y: 8, z: 1 }, lastSel = null, live = null;   // live = what the last draw made (for fit, and the drags)
  var Z_MIN = 0.25, Z_MAX = 2.5, SNAP = 4;

  /** Where every box goes: the automatic layout (questlines one under another, then the quests with no link), then
   *  wherever the author dragged one. Also the heading of each group, kept above its boxes. */
  function placeAll(g, rows, startIds) {
    var all = lines(g);
    var linked = all.filter(function (ids) { return ids.length > 1; }), alone = all.filter(function (ids) { return ids.length === 1; }).map(function (ids) { return ids[0]; });
    function first(ids) { return Math.min.apply(null, ids.map(function (id) { return g.nodes[id].row; })); }
    function hasStart(ids) { return ids.some(function (id) { return startIds.indexOf(id) >= 0; }); }
    linked.sort(function (a, b) { return (hasStart(b) - hasStart(a)) || first(a) - first(b); });   // the line new characters begin first
    var pos = {}, groups = [], oy = 0, saved = {};
    rows.forEach(function (r) { var id = str(r.id), at = savedAt(r); if (id && at && g.nodes[id] && !g.nodes[id].missing) saved[id] = at; });
    linked.forEach(function (ids) {
      // named after where it begins: a quest new characters start with, else one that nothing leads to, else its first row
      var byRow = ids.slice().sort(function (a, b) { return g.nodes[a].row - g.nodes[b].row; });
      var roots = byRow.filter(function (id) { return !g.nodes[id].missing && !g.edges.some(function (e) { return e.to === id; }); });
      var title = g.nodes[byRow.filter(function (id) { return startIds.indexOf(id) >= 0; })[0] || roots[0] || byRow[0]].name;
      var L = layout(g, ids);
      ids.forEach(function (id) { pos[id] = { x: L.at[id].x, y: oy + 24 + L.at[id].y }; });
      groups.push({ ids: ids, text: title + ' · ' + ids.length + ' quests' });
      oy += 24 + L.H + 30;
    });
    if (alone.length) {
      alone.sort(function (a, b) { return g.nodes[a].row - g.nodes[b].row; }).forEach(function (id, i) {
        pos[id] = { x: PAD + (i % 3) * (NW + GX), y: oy + 24 + Math.floor(i / 3) * (NH + 22) };
      });
      groups.push({ ids: alone, text: 'Not linked to any other quest · ' + alone.length });
    }
    Object.keys(saved).forEach(function (id) { pos[id] = saved[id]; });
    return { pos: pos, groups: groups };
  }

  /** How a link is drawn between two boxes, from where they are now. */
  function route(a, b, outPort, inPort, sideOff) {
    var dy = b.y - a.y;
    if (dy >= NH + 12) {                                           // downwards: bottom edge to top edge
      var x1 = a.x + outPort, y1 = a.y + NH, x2 = b.x + inPort, y2 = b.y - 2, my = (y1 + y2) / 2;
      return 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2;
    }
    if (dy <= -(NH + 12)) {                                        // back up: round the right-hand side
      var rx = Math.max(a.x, b.x) + NW + sideOff;
      return 'M' + (a.x + NW) + ',' + (a.y + NH / 2) + ' C' + rx + ',' + (a.y + NH / 2) + ' ' + rx + ',' + (b.y + NH / 2) + ' ' + (b.x + NW + 2) + ',' + (b.y + NH / 2);
    }
    var right = b.x >= a.x;                                        // side by side: facing edges
    var sx = right ? a.x + NW : a.x, ex = right ? b.x - 2 : b.x + NW + 2, mx = (sx + ex) / 2;
    return 'M' + sx + ',' + (a.y + NH / 2) + ' C' + mx + ',' + (a.y + NH / 2) + ' ' + mx + ',' + (b.y + NH / 2) + ' ' + ex + ',' + (b.y + NH / 2);
  }

  function draw(box, rows, startIds, selected, opts) {
    opts = opts || {};
    rows = rows || [];
    box.innerHTML = '';
    var g = graph(rows), P = placeAll(g, rows, startIds), pos = P.pos;
    var svg = el('svg', { class: 'qmcanvas', width: '100%', height: '100%' });
    var defs = el('defs');
    Object.keys(KINDS).forEach(function (k) {
      defs.appendChild(el('marker', { id: 'qm-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        [el('path', { d: 'M0,0 L10,5 L0,10 z', fill: KINDS[k].color })]));
    });
    svg.appendChild(defs);
    var root = el('g'), labelLayer = el('g'), edgeLayer = el('g'), nodeLayer = el('g');
    root.appendChild(labelLayer); root.appendChild(edgeLayer); root.appendChild(nodeLayer);
    svg.appendChild(root);
    box.appendChild(svg);
    if (!g.order.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'note qmempty', textContent: 'No quests yet.' }));
    function apply() { root.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.z + ')'); }

    function drawLabels() {
      labelLayer.innerHTML = '';
      P.groups.forEach(function (grp) {
        var xs = grp.ids.map(function (id) { return pos[id].x; }), ys = grp.ids.map(function (id) { return pos[id].y; });
        var t = el('text', { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys) - 20, class: 'qmlabel' });
        t.textContent = grp.text.toUpperCase();
        labelLayer.appendChild(t);
      });
    }
    function drawEdges() {
      edgeLayer.innerHTML = '';
      // ports: links leaving downwards spread along the bottom of a box (in the order of where they go), arriving ones along the top
      var outs = {}, ins = {}, backs = 0;
      g.edges.forEach(function (e) {
        if (!pos[e.from] || !pos[e.to]) return;
        if (pos[e.to].y - pos[e.from].y >= NH + 12) { (outs[e.from] = outs[e.from] || []).push(e); (ins[e.to] = ins[e.to] || []).push(e); }
      });
      Object.keys(outs).forEach(function (k) { outs[k].sort(function (a, b) { return pos[a.to].x - pos[b.to].x; }); });
      Object.keys(ins).forEach(function (k) { ins[k].sort(function (a, b) { return pos[a.from].x - pos[b.from].x; }); });
      function port(list, e) { if (!list) return NW / 2; var i = list.indexOf(e); return NW * (i + 1) / (list.length + 1); }
      g.edges.forEach(function (e) {
        var a = pos[e.from], b = pos[e.to]; if (!a || !b) return;
        var d = route(a, b, port(outs[e.from], e), port(ins[e.to], e), 18 + 8 * (backs++ % 3));
        var k = KINDS[e.kind], hot = e.from === selected || e.to === selected;
        var path = el('path', { d: d, class: 'qedge' + (hot ? ' hot' : ''), stroke: k.color, 'marker-end': 'url(#qm-' + e.kind + ')', opacity: selected && !hot ? 0.55 : 1 });
        if (k.dash) path.setAttribute('stroke-dasharray', k.dash);
        var t = el('title'); t.textContent = g.nodes[e.from].name + ' → ' + g.nodes[e.to].name + ': ' + e.tip; path.appendChild(t);
        edgeLayer.appendChild(path);
      });
    }
    var nodeEls = {};
    g.order.forEach(function (id) {
      var n = g.nodes[id], p = pos[id], isStart = startIds.indexOf(id) >= 0; if (!p) return;
      var grp = el('g', { class: 'qnode' + (id === selected ? ' on' : '') + (n.missing ? ' missing' : ''), transform: 'translate(' + p.x + ',' + p.y + ')', 'data-id': id });
      grp.appendChild(el('rect', { class: 'box', width: NW, height: NH, rx: 6 }));
      if (n.tutorial) grp.appendChild(el('rect', { x: 0, y: 0, width: 4, height: NH, rx: 2, fill: '#b48cf0' }));
      var name = el('text', { x: 10, y: 16 }); name.textContent = clip(n.name, 18); grp.appendChild(name);
      var sub = el('text', { x: 10, y: 30, class: 'sub' }); sub.textContent = clip(n.missing ? id + ' — no such quest' : id + (n.tutorial ? ' · tutorial' : ''), 22); grp.appendChild(sub);
      if (isStart) { var st = el('text', { x: 0, y: -4, class: 'sub' }); st.textContent = '▶ every new character'; grp.appendChild(st); }
      var tip = el('title'); tip.textContent = n.missing ? 'Linked to, but there is no quest "' + id + '"' : n.name + ' (' + id + ')' + (n.tutorial ? ' — tutorial step' : '') + (isStart ? ' — in Config start_quests' : '') + '\nClick to open · drag to move';
      grp.appendChild(tip);
      nodeLayer.appendChild(grp);
      nodeEls[id] = grp;
    });
    drawLabels(); drawEdges(); apply();

    // ---- moving about: hold the wheel (or drag empty space) to pan, the wheel zooms where the pointer is
    function drag(e, onMove, onUp) {
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      function mv(ev) { onMove(ev.clientX - sx, ev.clientY - sy); }
      function up(ev) { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); svg.classList.remove('panning'); if (onUp) onUp(ev.clientX - sx, ev.clientY - sy); }
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }
    svg.addEventListener('mousedown', function (e) {
      var hit = e.target.closest ? e.target.closest('.qnode') : null, id = hit && hit.getAttribute('data-id');
      if (e.button === 1 || (e.button === 0 && !hit)) {           // pan
        var vx = view.x, vy = view.y;
        svg.classList.add('panning');
        drag(e, function (dx, dy) { view.x = vx + dx; view.y = vy + dy; apply(); });
        return;
      }
      if (e.button !== 0 || !id) return;
      var p0 = { x: pos[id].x, y: pos[id].y }, moved = false, canMove = !g.nodes[id].missing && !!opts.move;
      drag(e, function (dx, dy) {                                  // a box: click = open it, drag = put it elsewhere
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!canMove) return;
        moved = true;
        pos[id] = { x: Math.round((p0.x + dx / view.z) / SNAP) * SNAP, y: Math.round((p0.y + dy / view.z) / SNAP) * SNAP };
        nodeEls[id].setAttribute('transform', 'translate(' + pos[id].x + ',' + pos[id].y + ')');
        drawEdges(); drawLabels();
      }, function () {
        if (moved) opts.move(id, pos[id].x, pos[id].y);
        else if (!g.nodes[id].missing && opts.pick) opts.pick(id);
      });
    });
    svg.addEventListener('auxclick', function (e) { if (e.button === 1) e.preventDefault(); });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      var nz = Math.min(Z_MAX, Math.max(Z_MIN, view.z * Math.exp(-e.deltaY * 0.0015)));
      view.x = mx - (mx - view.x) * (nz / view.z); view.y = my - (my - view.y) * (nz / view.z); view.z = nz;
      apply();
    }, { passive: false });

    live = { svg: svg, pos: pos, apply: apply };
    // a quest picked in the list (not here) and out of sight: bring it into view
    if (selected && selected !== lastSel && pos[selected]) {
      var w = svg.clientWidth || box.clientWidth, h = svg.clientHeight || box.clientHeight, p = pos[selected];
      var sx = p.x * view.z + view.x, sy = p.y * view.z + view.y;
      if (w && h && (sx < 0 || sy < 20 || sx + NW * view.z > w || sy + NH * view.z > h)) { view.x = w / 2 - (p.x + NW / 2) * view.z; view.y = h / 2 - (p.y + NH / 2) * view.z; apply(); }
    }
    lastSel = selected;
  }

  /** Everything in sight, as large as fits (not larger than life). */
  function fit() {
    if (!live) return;
    var ids = Object.keys(live.pos); if (!ids.length) return;
    var xs = ids.map(function (id) { return live.pos[id].x; }), ys = ids.map(function (id) { return live.pos[id].y; });
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys) - 26, x1 = Math.max.apply(null, xs) + NW, y1 = Math.max.apply(null, ys) + NH;
    var w = live.svg.clientWidth, h = live.svg.clientHeight; if (!w || !h) return;
    view.z = Math.max(Z_MIN, Math.min(1, (w - 24) / (x1 - x0), (h - 24) / (y1 - y0)));
    view.x = (w - (x1 - x0) * view.z) / 2 - x0 * view.z; view.y = 12 - y0 * view.z;
    live.apply();
  }

  function legend() {
    var d = document.createElement('div'); d.className = 'qmlegend';
    Object.keys(KINDS).forEach(function (k) {
      var s = document.createElement('span');
      s.innerHTML = '<svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="' + KINDS[k].color + '" stroke-width="2"' + (KINDS[k].dash ? ' stroke-dasharray="4 3"' : '') + '/></svg>';
      s.appendChild(document.createTextNode(KINDS[k].name)); s.title = KINDS[k].tip;
      d.appendChild(s);
    });
    var t = document.createElement('span');
    t.innerHTML = '<svg width="8" height="12"><rect width="4" height="12" rx="2" fill="#b48cf0"/></svg>';
    t.appendChild(document.createTextNode('tutorial step'));
    d.appendChild(t);
    return d;
  }

  return { draw: draw, fit: fit, legend: legend, graph: graph };
})();
if (typeof module !== 'undefined') module.exports = QuestMap;
