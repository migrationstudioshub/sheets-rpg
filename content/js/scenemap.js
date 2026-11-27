// Content Studio: the map of one scene, beside the Scenes view (stage 3 of scenes, CLAUDE.md "Scenes"). The real map,
// drawn by the game's own renderer (client/js/render.js) once into a picture, and over it where the scene's steps
// happen: camera stops, where actors appear and walk to, emotes on tiles, and where the player is taken to stand.
//   SceneMap.draw(box, o)     o = { tables, mapId, start: {x, y} | null, steps, sel (step index), pick ('start' |
//                                   step index | null: the next click on a tile sets that),
//                                   on: { move(i, x, y), start(x, y), select(i), picked() } }
//   SceneMap.fit()            show the whole map        SceneMap.reload()   read the tables and draw the map again
//   SceneMap.info(tables)     the maps there are: [{id, name}]
// A marker is dragged to move its step's tile; a click on one picks its step. Hold the mouse wheel or drag empty
// ground to move around, wheel to zoom; the view is kept across redraws. Nothing here is saved: the Studio does that.
// The content is built from the tables once (maps are edited in the map editor, another page): Reload builds it again.
var SceneMap = (function () {
  'use strict';
  var Z_MIN = 0.1, Z_MAX = 4, R = 9;
  var COL = { cam: '#e0b84a', me: '#5aa0e6', npc: '#6fbf73', mon: '#e06a5a', emote: '#c58ae0' };
  var st = { content: null, src: null, mapId: '', map: null, bake: null, top: 0, T: 32, z: 0, ox: 0, oy: 0, box: null, cv: null, o: null,
    plan: null, drag: null, pan: null, hover: null, paths: {}, opts: null, gen: 0, msg: '' };

  function num(v) { return Math.round(Number(v) || 0); }
  function info(tables) { return ((tables && tables.Maps) || []).filter(function (m) { return m && m.id; }).map(function (m) { return { id: String(m.id), name: String(m.name || m.id) }; }); }
  function ready() { return typeof Render !== 'undefined' && typeof Content !== 'undefined' && typeof Assets !== 'undefined' && typeof Rules !== 'undefined'; }

  // ---- the map as a picture -------------------------------------------------------------------------------------
  function build(tables) {
    if (st.content && st.src === tables) return st.content;
    st.src = tables; st.mapId = ''; st.bake = null; st.paths = {};
    try { st.content = Content.build(JSON.parse(JSON.stringify(tables))); } catch (e) { st.content = null; st.msg = 'The map could not be read: ' + e.message; }
    return st.content;
  }
  function npcActors(c, map) {
    var out = [];
    (map.entities || []).forEach(function (e) {
      var fit = Render.outfitOf(c.objects[e.ref]);
      if (fit) out.push({ x: e.x, y: e.y, facing: 'E', name: '', layers: Render.outfitLayers(fit), fixed: true });
    });
    return out;
  }
  function hidden(c) {
    return function (e) {
      var o = c.objects[e.ref]; if (!o) return false;
      if (Render.outfitOf(o)) return true;
      return (o.kind === 'spawn' || o.kind === 'trigger') && !o.sprite;
    };
  }
  function bake(mapId) {
    var c = st.content, map = c && c.maps[mapId], gen = ++st.gen;
    st.mapId = mapId; st.map = map || null; st.bake = null; st.paths = {}; st.opts = null; st.z = 0;
    if (!map) { st.msg = mapId ? 'There is no map "' + mapId + '".' : 'Pick the map this scene plays on.'; return; }
    st.msg = 'Drawing the map…';
    var T = st.T = c.config.tile_size || 32, top = st.top = (Render.maxElev(map) + 3) * T;
    var off = document.createElement('canvas'); off.width = map.width * T; off.height = map.height * T + top;
    var rn = new Render.Renderer(off, c);
    function paintMap() {
      if (gen !== st.gen) return;
      try {
        if (typeof World !== 'undefined' && World.syncEdgesView) World.syncEdgesView(c, map, function () { return undefined; });
        rn.setMap(map, {});
        rn.draw({ x: 0, y: -top }, npcActors(c, map), { states: {}, hidden: hidden(c) });
        st.bake = off; st.msg = '';
      } catch (e) { st.msg = 'The map could not be drawn: ' + e.message; }
      paint();
    }
    Assets.loadForMap(c, map).then(function () {
      paintMap();
      setTimeout(paintMap, 1200); setTimeout(paintMap, 4000);       // (figures and late pictures arrive after the first draw)
    });
  }

  // ---- where things are -----------------------------------------------------------------------------------------
  function lift(x, y) {
    var m = st.map; if (!m) return 0;
    return Render.liftAt(m, Math.max(0, Math.min(m.width - 1, x)), Math.max(0, Math.min(m.height - 1, y)), st.T);
  }
  function toScreen(x, y) { return { x: st.ox + (x + 0.5) * st.T * st.z, y: st.oy + ((y + 0.5) * st.T - lift(x, y) + st.top) * st.z }; }
  function tileAt(sx, sy) {
    var px = (sx - st.ox) / st.z, py = (sy - st.oy) / st.z - st.top, m = st.map;
    var c = Render.pickCells ? Render.pickCells(m, px, py, st.T)[0] : null;
    if (!c) c = { x: Math.floor(px / st.T), y: Math.floor(py / st.T) };
    return { x: Math.max(0, Math.min(m.width - 1, c.x)), y: Math.max(0, Math.min(m.height - 1, c.y)) };
  }
  /** The way an actor would walk (as the game finds it: eight ways, round walls and objects), or null = a straight line. */
  function pathOf(from, to) {
    var key = from.x + ',' + from.y + '>' + to.x + ',' + to.y;
    if (key in st.paths) return st.paths[key];
    var c = st.content, map = st.map, out = null;
    try {
      st.opts = st.opts || World.viewOpts(c, map, { states: {}, monsters: [], players: [] }, '');
      var dirs = Object.keys(Rules.DIRS).concat(Object.keys(Rules.DIAG || {})), K = function (x, y) { return x + ',' + y; };
      var prev = {}, q = [from], n = 0; prev[K(from.x, from.y)] = null;
      while (q.length && n++ < 6000) {
        var cur = q.shift();
        if (cur.x === to.x && cur.y === to.y) { out = []; for (var k = cur; k; k = prev[K(k.x, k.y)]) out.unshift({ x: k.x, y: k.y }); break; }
        for (var i = 0; i < dirs.length; i++) {
          var r = Rules.tryMove(c, map, cur.x, cur.y, dirs[i], st.opts);
          if (!r.ok || r.map || K(r.x, r.y) in prev) continue;
          prev[K(r.x, r.y)] = cur; q.push({ x: r.x, y: r.y });
        }
      }
    } catch (e) { out = null; }
    return (st.paths[key] = out);
  }
  function kindOf(ref) { return ref === 'me' ? 'me' : String(ref).indexOf('mon:') === 0 ? 'mon' : 'npc'; }
  /** The steps as marks on the map: {marks: [{i, kind, x, y, tag, stay}], lines: [{pts, kind, dash}]}, in step order. */
  function planOf(steps, start) {
    var marks = [], lines = [], pos = {}, map = st.map, c = st.content;
    if (start) pos.me = { x: start.x, y: start.y };
    function where(ref) {
      if (pos[ref] !== undefined) return pos[ref];
      if (String(ref).indexOf('npc:') !== 0) return null;
      // (npc:<id>#<n> = the n-th nearest placement to the player, as the game takes it)
      var parts = ref.slice(4).split('#'), id = parts[0], nth = Math.max(1, Number(parts[1]) || 1), at = start || { x: map.width / 2, y: map.height / 2 };
      var list = (map.entities || []).filter(function (e) { return e.ref === id; }).map(function (e) { return { x: e.x, y: e.y, d: Math.abs(e.x - at.x) + Math.abs(e.y - at.y) }; }).sort(function (a, b) { return a.d - b.d; });
      return (pos[ref] = list[nth - 1] ? { x: list[nth - 1].x, y: list[nth - 1].y } : null);
    }
    var cam = start ? { x: start.x, y: start.y } : null, camMe = true;
    (steps || []).forEach(function (s, i) {
      if (!s) return;
      if (s.type === 'camera') {
        var to = s.to === 'me' ? (pos.me || null) : { x: num(s.x), y: num(s.y) };
        if (camMe && pos.me) cam = { x: pos.me.x, y: pos.me.y };
        if (to && cam && (cam.x !== to.x || cam.y !== to.y)) lines.push({ pts: [cam, to], kind: 'cam', dash: !(Number(s.s) > 0) });
        if (s.to !== 'me') marks.push({ i: i, kind: 'cam', x: to.x, y: to.y, tag: 'camera' });
        if (to) cam = { x: to.x, y: to.y };
        camMe = s.to === 'me';
      } else if (s.type === 'show' && s.a) {
        pos[s.a] = { x: num(s.x), y: num(s.y) };
        marks.push({ i: i, kind: kindOf(s.a), x: num(s.x), y: num(s.y), tag: 'show', stay: !!s.stay, n: s.a === 'me' ? 1 : Math.max(1, Math.min(12, num(s.count) || 1)) });
      } else if (s.type === 'walk' && s.a) {
        var from = where(s.a), dest = { x: num(s.x), y: num(s.y) };
        if (from) { var pts = s.straight ? null : pathOf({ x: num(from.x), y: num(from.y) }, dest); lines.push({ pts: pts || [from, dest], kind: kindOf(s.a), dash: !!s.straight }); }
        marks.push({ i: i, kind: kindOf(s.a), x: dest.x, y: dest.y, tag: 'walk', stay: !!s.stay });
        pos[s.a] = dest;
      } else if (s.type === 'leave' && s.a) pos[s.a] = null;
      else if (s.type === 'emote' && s.over === 'tile') marks.push({ i: i, kind: 'emote', x: num(s.x), y: num(s.y), tag: 'emote' });
    });
    return { marks: marks, lines: lines, c: c };
  }

  // ---- drawing --------------------------------------------------------------------------------------------------
  function size() {
    var cv = st.cv, box = st.box; if (!cv || !box) return;
    var w = Math.max(50, box.clientWidth), h = Math.max(50, box.clientHeight);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }
  function fit() {
    if (!st.bake || !st.cv) return;
    size();
    var z = Math.min(st.cv.width / st.bake.width, st.cv.height / st.bake.height);
    st.z = Math.max(Z_MIN, Math.min(Z_MAX, z));
    st.ox = (st.cv.width - st.bake.width * st.z) / 2; st.oy = (st.cv.height - st.bake.height * st.z) / 2;
    paint();
  }
  /** First look at a map: close enough to read, on the scene's marks (or the player's place), else the whole map. */
  function firstView() {
    size();
    var o = st.o || {}, pts = (st.plan ? st.plan.marks : []).map(function (m) { return { x: m.x, y: m.y }; });
    if (o.start) pts.push(o.start);
    if (!pts.length) return fit();
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    var T = st.T, w = (x1 - x0 + 9) * T, h = (y1 - y0 + 9) * T;
    st.z = Math.max(Z_MIN, Math.min(1.5, Math.min(st.cv.width / w, st.cv.height / h)));
    var mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    st.ox = st.cv.width / 2 - (mid.x + 0.5) * T * st.z; st.oy = st.cv.height / 2 - ((mid.y + 0.5) * T - lift(Math.round(mid.x), Math.round(mid.y)) + st.top) * st.z;
  }
  function arrow(g, a, b) {
    var ang = Math.atan2(b.y - a.y, b.x - a.x), L = 7;
    g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - L * Math.cos(ang - 0.45), b.y - L * Math.sin(ang - 0.45));
    g.lineTo(b.x - L * Math.cos(ang + 0.45), b.y - L * Math.sin(ang + 0.45)); g.closePath(); g.fill();
  }
  function paint() {
    var cv = st.cv; if (!cv || !cv.isConnected) return;
    size();
    var g = cv.getContext('2d'), o = st.o || {};
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
    if (!st.bake) { g.fillStyle = '#8b93a3'; g.font = '12px sans-serif'; g.fillText(st.msg || '', 12, 22); return; }
    if (!st.z) firstView();
    g.imageSmoothingEnabled = st.z < 1;
    g.drawImage(st.bake, st.ox, st.oy, st.bake.width * st.z, st.bake.height * st.z);
    var plan = st.plan || { marks: [], lines: [] }, drag = st.drag;
    // the ways: the camera's, and each actor's walk
    plan.lines.forEach(function (ln) {
      var pts = ln.pts.map(function (p) { return toScreen(p.x, p.y); }); if (pts.length < 2) return;
      g.strokeStyle = COL[ln.kind] || '#fff'; g.fillStyle = g.strokeStyle; g.lineWidth = ln.kind === 'cam' ? 1.5 : 2.5; g.globalAlpha = 0.9;
      g.setLineDash(ln.dash ? [6, 5] : []);
      g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (var i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.stroke();
      g.setLineDash([]); arrow(g, pts[pts.length - 2], pts[pts.length - 1]); g.globalAlpha = 1;
    });
    // the tile under the pointer (and where a dragged mark would land)
    var hv = drag && drag.at ? drag.at : st.hover;
    if (hv) {
      var a = toScreen(hv.x, hv.y), half = st.T * st.z / 2;
      g.strokeStyle = o.pick != null || drag ? '#fff' : 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.strokeRect(Math.round(a.x - half) + 0.5, Math.round(a.y - half) + 0.5, Math.round(half * 2), Math.round(half * 2));
    }
    function mark(x, y, color, label, on, stay, many) {
      var p = toScreen(x, y);
      g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2); g.fillStyle = color; g.fill();
      g.lineWidth = on ? 3 : 1.5; g.strokeStyle = on ? '#fff' : '#12141a'; g.stroke();
      if (stay) { g.beginPath(); g.arc(p.x, p.y, R + 3.5, 0, Math.PI * 2); g.lineWidth = 1.5; g.strokeStyle = color; g.setLineDash([3, 3]); g.stroke(); g.setLineDash([]); }
      g.fillStyle = '#12141a'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, p.x, p.y + 0.5);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      if (many > 1) { g.font = 'bold 10px sans-serif'; g.strokeStyle = '#12141a'; g.lineWidth = 3; g.strokeText('×' + many, p.x + R + 3, p.y + 4); g.fillStyle = color; g.fillText('×' + many, p.x + R + 3, p.y + 4); }   // a pack
    }
    if (o.start) { var sp = drag && drag.id === 'start' && drag.at ? drag.at : o.start; mark(sp.x, sp.y, COL.me, 'P', o.pick === 'start', false); }
    plan.marks.forEach(function (m) {
      var at = drag && drag.id === m.i && drag.at ? drag.at : m;
      mark(at.x, at.y, COL[m.kind] || '#fff', String(m.i + 1), o.sel === m.i || o.pick === m.i, m.stay, m.n);
    });
    // what the pointer is on
    g.font = '11px sans-serif'; g.fillStyle = 'rgba(18,20,26,.8)';
    var text = (o.pick === 'start' ? 'Click where the player stands · ' : o.pick != null ? 'Click the tile for step ' + (o.pick + 1) + ' · ' : '') + (hv ? 'tile ' + hv.x + ', ' + hv.y : '');
    if (text) { var tw = g.measureText(text).width + 12; g.fillRect(6, cv.height - 24, tw, 18); g.fillStyle = '#e6e9ef'; g.fillText(text, 12, cv.height - 11); }
  }

  // ---- the pointer ----------------------------------------------------------------------------------------------
  function hit(sx, sy) {
    var o = st.o || {}, best = null, bd = (R + 3) * (R + 3), list = (st.plan ? st.plan.marks : []).map(function (m) { return { id: m.i, x: m.x, y: m.y }; });
    if (o.start) list.unshift({ id: 'start', x: o.start.x, y: o.start.y });
    list.forEach(function (m) { var p = toScreen(m.x, m.y), d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy); if (d <= bd) { bd = d; best = m; } });   // (the later step wins a tie: it is drawn on top)
    return best;
  }
  function pt(e) { var r = st.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function wire(cv) {
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('mousedown', function (e) {
      if (!st.bake) return;
      var p = pt(e), o = st.o || {}, on = o.on || {};
      e.preventDefault();
      if (e.button === 0 && o.pick != null) {                       // picking: this click is the tile
        var t = tileAt(p.x, p.y);
        if (o.pick === 'start') { if (on.start) on.start(t.x, t.y); } else if (on.move) on.move(o.pick, t.x, t.y);
        if (on.picked) on.picked();
        return;
      }
      var m = e.button === 0 ? hit(p.x, p.y) : null;
      if (m) st.drag = { id: m.id, from: { x: m.x, y: m.y }, at: null, moved: false, x0: p.x, y0: p.y };
      else st.pan = { x: p.x, y: p.y, ox: st.ox, oy: st.oy };
      cv.classList.toggle('panning', !!st.pan);
    });
    addEventListener('mousemove', function (e) {
      if (!st.cv || !st.cv.isConnected || !st.bake) return;
      var p = pt(e);
      if (st.pan) { st.ox = st.pan.ox + p.x - st.pan.x; st.oy = st.pan.oy + p.y - st.pan.y; paint(); return; }
      if (st.drag) {
        if (!st.drag.moved && Math.abs(p.x - st.drag.x0) + Math.abs(p.y - st.drag.y0) < 4) return;
        st.drag.moved = true; st.drag.at = tileAt(p.x, p.y); paint(); return;
      }
      var inside = p.x >= 0 && p.y >= 0 && p.x < st.cv.width && p.y < st.cv.height, h = inside ? tileAt(p.x, p.y) : null;
      if ((h && h.x) !== (st.hover && st.hover.x) || (h && h.y) !== (st.hover && st.hover.y) || !h !== !st.hover) { st.hover = h; paint(); }
      st.cv.style.cursor = (st.o && st.o.pick != null) ? 'crosshair' : inside && hit(p.x, p.y) ? 'move' : '';
    });
    addEventListener('mouseup', function () {
      if (st.pan) { st.pan = null; if (st.cv) st.cv.classList.remove('panning'); }
      var d = st.drag; if (!d) return;
      st.drag = null;
      var on = (st.o && st.o.on) || {};
      if (!d.moved) { if (d.id !== 'start' && on.select) on.select(d.id); else paint(); return; }
      if (d.at && (d.at.x !== d.from.x || d.at.y !== d.from.y)) { if (d.id === 'start') { if (on.start) on.start(d.at.x, d.at.y); } else if (on.move) on.move(d.id, d.at.x, d.at.y); }
      else paint();
    });
    cv.addEventListener('wheel', function (e) {
      if (!st.bake) return;
      e.preventDefault();
      var p = pt(e), z = Math.max(Z_MIN, Math.min(Z_MAX, st.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      st.ox = p.x - (p.x - st.ox) * z / st.z; st.oy = p.y - (p.y - st.oy) * z / st.z; st.z = z;
      paint();
    }, { passive: false });
  }

  function draw(box, o) {
    st.box = box; st.o = o || {};
    if (!st.cv || !st.cv.isConnected || st.cv.parentNode !== box) {
      st.cv = document.createElement('canvas'); st.cv.className = 'smcanvas'; wire(st.cv); box.appendChild(st.cv);
    }
    if (!ready()) { st.bake = null; st.msg = 'The map cannot be drawn here (the game\'s drawing code did not load).'; return paint(); }
    var c = build(st.o.tables);
    if (c && st.mapId !== String(st.o.mapId || '')) bake(String(st.o.mapId || ''));
    else if (c && !st.map) bake(String(st.o.mapId || ''));
    st.plan = st.map ? planOf(st.o.steps, st.o.start) : null;
    paint();
  }
  function reload() { st.src = null; st.content = null; st.mapId = ''; if (st.box && st.o) draw(st.box, st.o); }
  function legend() {
    var d = document.createElement('div'); d.className = 'qmlegend';
    [['cam', 'camera'], ['me', 'the player'], ['npc', 'an NPC'], ['mon', 'a monster'], ['emote', 'an emote']].forEach(function (k) {
      var s = document.createElement('span'), dot = document.createElement('i');
      dot.style.cssText = 'display:inline-block;width:9px;height:9px;border-radius:50%;background:' + COL[k[0]];
      s.appendChild(dot); s.appendChild(document.createTextNode(k[1])); d.appendChild(s);
    });
    return d;
  }
  return { draw: draw, fit: fit, reload: reload, info: info, legend: legend };
})();
