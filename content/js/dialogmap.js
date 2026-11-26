// Content Studio: the map of one dialogue, beside the Dialogues view. A picture of the draft, nothing more: every line
// the NPC can say is a box, every answer the player can give is an arrow to the line it leads to. The rules these
// stand for are in shared/world.js (talkTo, talkAct).
//   DialogMap.draw(box, nodes, selectedId, {pick(id), move(id, x, y)})   DialogMap.fit()   DialogMap.legend()
// nodes = the dialogue's lines as stored: [{id, text, start, if, x, y, answers: [{id, text, if, do, to, once}]}].
// A box is dragged anywhere (move = where it was dropped; kept on the line as x, y, which the game ignores); a line
// with no x, y is placed by the automatic layout (how many answers it is from an opening line). Hold the mouse wheel
// or drag empty space to move around, wheel to zoom; the view is kept across redraws.
var DialogMap = (function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var NW = 150, NH = 40, GX = 16, GY = 44, PAD = 8, SNAP = 4, Z_MIN = 0.25, Z_MAX = 2.5;
  var KINDS = {
    plain: { color: '#9aa3b2', dash: '',    name: 'answer',          tip: 'an answer leading to that line' },
    does:  { color: '#6fbf73', dash: '',    name: 'does something',  tip: 'an answer that also does something (gives, takes, sets a flag, starts a quest…)' },
    cond:  { color: '#e0a040', dash: '5 4', name: 'only if',         tip: 'an answer offered only on a condition' }
  };
  function str(v) { return v == null ? '' : String(v).trim(); }
  function isOn(v) { return v === true || /^(true|yes|1|on)$/i.test(str(v)); }
  function clip(text, n) { text = String(text).replace(/\s+/g, ' '); return text.length > n ? text.slice(0, n - 1) + '…' : text; }
  function el(tag, attrs, kids) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (k) { if (k) e.appendChild(k); });
    return e;
  }

  /** Boxes (the lines, plus ids that an answer leads to but that do not exist) and arrows. */
  function graph(nodes) {
    var by = {}, order = [], edges = [];
    (nodes || []).forEach(function (n) { var id = str(n && n.id); if (!id || by[id]) return; by[id] = { id: id, text: str(n.text), start: isOn(n.start), n: n, ends: 0, count: 0 }; order.push(id); });
    order.slice().forEach(function (id) {
      (by[id].n.answers || []).forEach(function (a) {
        by[id].count++;
        var to = str(a.to);
        if (!to) { by[id].ends++; return; }
        if (!by[to]) { by[to] = { id: to, text: to, missing: true }; order.push(to); }
        edges.push({ from: id, to: to, kind: str(a['if']) ? 'cond' : str(a['do']) ? 'does' : 'plain', text: str(a.text) || '(no words yet)', once: isOn(a.once) });
      });
    });
    return { by: by, order: order, edges: edges };
  }
  /** Where the boxes go when the author has not placed them: a row per number of answers from an opening line. */
  function layout(g) {
    var depth = {}, queue = [];
    g.order.forEach(function (id) { if (g.by[id].start) { depth[id] = 0; queue.push(id); } });
    if (!queue.length && g.order.length) { depth[g.order[0]] = 0; queue.push(g.order[0]); }
    while (queue.length) {
      var id = queue.shift();
      g.edges.forEach(function (e) { if (e.from === id && depth[e.to] == null) { depth[e.to] = depth[id] + 1; queue.push(e.to); } });
    }
    var deepest = Math.max.apply(null, [0].concat(Object.keys(depth).map(function (k) { return depth[k]; })));
    var rows = [], lost = [];
    g.order.forEach(function (id) { if (depth[id] == null) lost.push(id); else (rows[depth[id]] = rows[depth[id]] || []).push(id); });
    if (lost.length) rows[deepest + 1] = lost;                       // lines nothing leads to: a last row of their own
    var pos = {}, widest = Math.max.apply(null, rows.map(function (r) { return (r || []).length; }).concat([1]));
    rows.forEach(function (r, l) {
      (r || []).forEach(function (id, i) { pos[id] = { x: PAD + (widest - r.length) * (NW + GX) / 2 + i * (NW + GX), y: PAD + 16 + l * (NH + GY) }; });
    });
    g.order.forEach(function (id) {
      var n = g.by[id].n, x = n ? parseFloat(n.x) : NaN, y = n ? parseFloat(n.y) : NaN;
      if (isFinite(x) && isFinite(y)) pos[id] = { x: x, y: y };
    });
    return { pos: pos, lost: lost };
  }
  function route(a, b, outPort, inPort, sideOff) {
    var dy = b.y - a.y;
    if (dy >= NH + 12) {
      var x1 = a.x + outPort, y1 = a.y + NH, x2 = b.x + inPort, y2 = b.y - 2, my = (y1 + y2) / 2;
      return 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + my + ' ' + x2 + ',' + my + ' ' + x2 + ',' + y2;
    }
    if (dy <= -(NH + 12) || a === b) {                             // back up (or to itself): round the right-hand side
      var rx = Math.max(a.x, b.x) + NW + sideOff;
      return 'M' + (a.x + NW) + ',' + (a.y + NH * 0.7) + ' C' + rx + ',' + (a.y + NH * 0.7) + ' ' + rx + ',' + (b.y + NH * 0.3) + ' ' + (b.x + NW + 2) + ',' + (b.y + NH * 0.3);
    }
    var right = b.x >= a.x, sx = right ? a.x + NW : a.x, ex = right ? b.x - 2 : b.x + NW + 2, mx = (sx + ex) / 2;
    return 'M' + sx + ',' + (a.y + NH / 2) + ' C' + mx + ',' + (a.y + NH / 2) + ' ' + mx + ',' + (b.y + NH / 2) + ' ' + ex + ',' + (b.y + NH / 2);
  }

  var view = { x: 12, y: 8, z: 1 }, live = null;

  function draw(box, nodes, selected, opts) {
    opts = opts || {};
    box.innerHTML = '';
    var g = graph(nodes), L = layout(g), pos = L.pos;
    var svg = el('svg', { class: 'qmcanvas', width: '100%', height: '100%' }), defs = el('defs');
    Object.keys(KINDS).forEach(function (k) {
      defs.appendChild(el('marker', { id: 'dm-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        [el('path', { d: 'M0,0 L10,5 L0,10 z', fill: KINDS[k].color })]));
    });
    svg.appendChild(defs);
    var root = el('g'), edgeLayer = el('g'), nodeLayer = el('g');
    root.appendChild(edgeLayer); root.appendChild(nodeLayer); svg.appendChild(root); box.appendChild(svg);
    if (!g.order.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'note qmempty', textContent: 'No lines yet: add one with + New line.' }));
    function apply() { root.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.z + ')'); }

    function drawEdges() {
      edgeLayer.innerHTML = '';
      var outs = {}, ins = {}, backs = 0;
      g.edges.forEach(function (e) {
        if (pos[e.to].y - pos[e.from].y >= NH + 12) { (outs[e.from] = outs[e.from] || []).push(e); (ins[e.to] = ins[e.to] || []).push(e); }
      });
      Object.keys(outs).forEach(function (k) { outs[k].sort(function (a, b) { return pos[a.to].x - pos[b.to].x; }); });
      Object.keys(ins).forEach(function (k) { ins[k].sort(function (a, b) { return pos[a.from].x - pos[b.from].x; }); });
      function port(list, e) { if (!list) return NW / 2; return NW * (list.indexOf(e) + 1) / (list.length + 1); }
      g.edges.forEach(function (e) {
        var k = KINDS[e.kind], hot = e.from === selected || e.to === selected;
        var path = el('path', { d: route(pos[e.from], pos[e.to], port(outs[e.from], e), port(ins[e.to], e), 18 + 8 * (backs++ % 3)),
          class: 'qedge' + (hot ? ' hot' : ''), stroke: k.color, 'marker-end': 'url(#dm-' + e.kind + ')', opacity: selected && !hot ? 0.55 : 1 });
        if (k.dash) path.setAttribute('stroke-dasharray', k.dash);
        var t = el('title'); t.textContent = '"' + e.text + '"' + (e.once ? ' (once)' : '') + ' → ' + clip(g.by[e.to].text || e.to, 40); path.appendChild(t);
        edgeLayer.appendChild(path);
      });
    }
    var nodeEls = {};
    g.order.forEach(function (id) {
      var n = g.by[id], p = pos[id];
      var grp = el('g', { class: 'qnode' + (id === selected ? ' on' : '') + (n.missing ? ' missing' : ''), transform: 'translate(' + p.x + ',' + p.y + ')', 'data-id': id });
      grp.appendChild(el('rect', { class: 'box', width: NW, height: NH, rx: 6 }));
      if (n.start) grp.appendChild(el('rect', { x: 0, y: 0, width: 4, height: NH, rx: 2, fill: '#5aa0ff' }));
      var name = el('text', { x: 10, y: 17 }); name.textContent = n.missing ? id : clip(n.text || '(says nothing yet)', 23); grp.appendChild(name);
      var sub = el('text', { x: 10, y: 31, class: 'sub' });
      sub.textContent = n.missing ? 'no such line' : clip(id + ' · ' + (n.count ? n.count + (n.count === 1 ? ' answer' : ' answers') : 'no answers') + (n.ends ? ', ' + n.ends + ' end' + (n.ends === 1 ? 's' : '') + ' it' : ''), 30);
      grp.appendChild(sub);
      if (n.start) { var st = el('text', { x: 0, y: -4, class: 'sub' }); st.textContent = '▶ can open the talk' + (str(n.n['if']) ? ' (if ' + clip(str(n.n['if']), 16) + ')' : ''); grp.appendChild(st); }
      var tip = el('title'); tip.textContent = n.missing ? 'An answer leads to "' + id + '", but there is no such line' : (n.text || '(says nothing yet)') + '\nClick to edit it, drag to place it';
      grp.appendChild(tip);
      nodeLayer.appendChild(grp); nodeEls[id] = grp;
    });
    drawEdges(); apply();

    function drag(e, onMove, onUp) {
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      function mv(ev) { onMove(ev.clientX - sx, ev.clientY - sy); }
      function up() { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); svg.classList.remove('panning'); if (onUp) onUp(); }
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }
    svg.addEventListener('mousedown', function (e) {
      var hit = e.target.closest ? e.target.closest('.qnode') : null, id = hit && hit.getAttribute('data-id');
      if (e.button === 1 || (e.button === 0 && !hit)) {
        var vx = view.x, vy = view.y;
        svg.classList.add('panning');
        drag(e, function (dx, dy) { view.x = vx + dx; view.y = vy + dy; apply(); });
        return;
      }
      if (e.button !== 0 || !id) return;
      var p0 = { x: pos[id].x, y: pos[id].y }, moved = false, canMove = !g.by[id].missing && !!opts.move;
      drag(e, function (dx, dy) {
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!canMove) return;
        moved = true;
        pos[id] = { x: Math.round((p0.x + dx / view.z) / SNAP) * SNAP, y: Math.round((p0.y + dy / view.z) / SNAP) * SNAP };
        nodeEls[id].setAttribute('transform', 'translate(' + pos[id].x + ',' + pos[id].y + ')');
        drawEdges();
      }, function () {
        if (moved) opts.move(id, pos[id].x, pos[id].y);
        else if (!g.by[id].missing && opts.pick) opts.pick(id);
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
  }
  function fit() {
    if (!live) return;
    var ids = Object.keys(live.pos); if (!ids.length) return;
    var xs = ids.map(function (id) { return live.pos[id].x; }), ys = ids.map(function (id) { return live.pos[id].y; });
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys) - 16, x1 = Math.max.apply(null, xs) + NW + 30, y1 = Math.max.apply(null, ys) + NH;
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
    t.innerHTML = '<svg width="8" height="12"><rect width="4" height="12" rx="2" fill="#5aa0ff"/></svg>';
    t.appendChild(document.createTextNode('can open the talk'));
    d.appendChild(t);
    return d;
  }
  return { draw: draw, fit: fit, legend: legend, graph: graph };
})();
if (typeof module !== 'undefined') module.exports = DialogMap;
