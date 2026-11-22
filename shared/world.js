/**
 * The game world: monsters, combat, interacting with objects, inventory, levels.
 * Shared by the server (which has the final say) and offline mode, so both play
 * exactly the same game. Nothing here touches sheets, caches or the screen.
 *
 * ws (world state) = { seq, log: [events], maps: { mapId: { states, timers, monsters } } }
 * player = { id, name, class, map, x, y, facing, hp, level, xp, gold,
 *            inventory: [{item, qty}], equipment: {weapon, armor}, flags: {}, respawn: 'map:x:y' }
 * Events = what happened, for messages and effects: {type, text, to?, map, x, y, amount?}
 *   to = only that player sees it; without to, everyone on the map does.
 */
var World = (function () {
  // looked up on use, not at load time: Apps Script may load this file before shared_rules
  function Rl() { return typeof Rules !== 'undefined' ? Rules : require('./rules.js'); }

  // ------------------------------------------------------------ helpers
  /** "potion:2, gold:30" -> [{item:'potion', qty:2}, {item:'gold', qty:30}] */
  function list(s) {
    return String(s || '').split(/[;,]/).map(function (p) {
      p = p.trim(); if (!p) return null;
      var i = p.lastIndexOf(':'), id = i > 0 ? p.slice(0, i).trim() : p, q = i > 0 ? Number(p.slice(i + 1)) : 1;
      return { item: id, qty: isNaN(q) ? 1 : q };
    }).filter(Boolean);
  }
  function objOf(c, e) { return c.objects[e.ref]; }
  function kindOf(c, e) { var o = objOf(c, e); return o ? c.kinds[o.kind] : null; }
  /** An entity's settings: kind defaults, then the object's defaults, then this placement's own. */
  function props(c, e) {
    var o = objOf(c, e), k = o && c.kinds[o.kind], out = {};
    if (k) Object.keys(k.props).forEach(function (p) { out[p] = k.props[p]['default']; });
    if (o) Object.keys(o.properties || {}).forEach(function (p) { out[p] = o.properties[p]; });
    Object.keys(e.data || {}).forEach(function (p) { out[p] = e.data[p]; });
    return out;
  }
  function yes(v) { return v === true || v === 1 || /^(true|1|yes|on)$/i.test(String(v)); }
  function rint(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }
  function damage(atk, def, rng) { return Math.max(1, atk - def + rint(rng, -1, 2)); }
  function lower(s) { return String(s || '').toLowerCase(); }
  function aAn(w) { return (/^[aeiou]/i.test(String(w)) ? 'an ' : 'a ') + w; }

  function mapState(ws, id) {
    ws.maps = ws.maps || {};
    var m = ws.maps[id] || (ws.maps[id] = {});
    m.states = m.states || {}; m.timers = m.timers || {};
    if (m.monsters === undefined) m.monsters = null;
    return m;
  }
  // ------------------------------------------------------------ the structure layer
  // Per map, next to states/monsters: what players built and what has been damaged or destroyed.
  //   struct = { rev, n, walls: {edgeKey: {tok, hp, max, ...}}, ents: [built entities], dmg: {key: hp lost by an
  //              AUTHORED wall/object}, gone: {key: 1 = an authored wall/object that was destroyed} }
  // rev goes up on every change. See docs/BASE_BUILDING.md (5, 6).
  // Stage 4 of floors (docs/FLOORS.md) adds: floor = {"x,y": {t: terrainId, by, bp}} tiles players laid; hole =
  // {"x,y": 1} authored floor removed (a stairwell opened from below); shadow = {claimKey: {x, y, r, by, owner,
  // members, home}} the claims standing on OTHER floors of this building, which cover this floor too.
  // Roofs (docs/FLOORS.md, stage 5) add: roof = {"x,y": {t, by, bp, up}} the cells of THIS storey that players put a
  // roof over. The same piece is a laid floor tile on the storey above (its struct.floor); notices keep the two in step.
  var NO_STRUCT = { rev: 0, n: 0, walls: {}, ents: [], dmg: {}, gone: {}, floor: {}, hole: {}, shadow: {}, roof: {} };
  function structOf(ws, mapId) {
    var ms = mapState(ws, mapId), st = ms.struct || (ms.struct = {});
    st.rev = st.rev || 0; st.n = st.n || 0;
    st.walls = st.walls || {}; st.ents = st.ents || []; st.dmg = st.dmg || {}; st.gone = st.gone || {};
    st.floor = st.floor || {}; st.hole = st.hole || {}; st.shadow = st.shadow || {}; st.roof = st.roof || {};
    return st;
  }
  function touchStruct(st) { st.rev = (st.rev || 0) + 1; }
  function edgeOfKey(key) { var m = /^([hv])(\d+),(\d+)$/.exec(String(key)); return m ? { orient: m[1], x: Number(m[2]), y: Number(m[3]) } : null; }
  // A wall grid with the layer applied: destroyed edges emptied, built walls added. Copies only the rows it changes.
  function overlayGrid(grid, st, orient) {
    var out = grid || [], copied = {}, k;
    function put(key, tok) {
      var ed = edgeOfKey(key); if (!ed || ed.orient !== orient) return;
      if (out === (grid || [])) out = out.slice();
      if (!copied[ed.y]) { out[ed.y] = (out[ed.y] || []).slice(); copied[ed.y] = 1; }
      while (out[ed.y].length < ed.x) out[ed.y].push('');
      out[ed.y][ed.x] = tok;
    }
    for (k in st.gone) put(k, '');
    for (k in st.walls) put(k, st.walls[k].tok);
    return out;
  }
  /**
   * THE MAP THE RULES USE: the authored map with the structure layer applied. A fresh object (its own
   * derived caches) per layer revision; the authored map itself is never changed. Shared by the referee
   * (via liveMap) and the client (which gets the layer in its view), so both agree on what blocks.
   */
  function liveMapFromStruct(c, base, st) {
    if (!base || !st || !st.rev) return base;
    var cache = base._live;
    if (cache && cache.rev === st.rev && cache.of === st) return cache.map;
    var m = Object.create(base);
    m.hWalls = overlayGrid(base.hWalls, st, 'h');
    m.vWalls = overlayGrid(base.vWalls, st, 'v');
    m.entities = base.entities.filter(function (e) { return !st.gone[e.key]; }).concat(st.ents || []);
    var fk = Object.keys(st.floor || {}), hk = Object.keys(st.hole || {});
    if (fk.length || hk.length) {                             // laid floor tiles and opened stairwells: copy only the rows they touch
      var terr = base.terrain.slice(), done = {};
      var setCell = function (k, v) {
        var q = k.split(','), x = Number(q[0]), y = Number(q[1]);
        if (!(y >= 0 && y < terr.length) || !(x >= 0)) return;
        if (!done[y]) { terr[y] = (terr[y] || []).slice(); done[y] = 1; }
        terr[y][x] = v;
      };
      hk.forEach(function (k) { setCell(k, ''); });
      fk.forEach(function (k) { setCell(k, st.floor[k].t); });
      m.terrain = terr;
      // …and covers whatever was painted over the ground there (grass on the overlay layer)
      if (base.overlay && base.overlay.length && fk.length) {
        var ovl = base.overlay.slice(), odone = {};
        fk.forEach(function (k) {
          var q = k.split(','), x = Number(q[0]), y = Number(q[1]);
          if (!ovl[y] || !ovl[y][x]) return;
          if (!odone[y]) { ovl[y] = ovl[y].slice(); odone[y] = 1; }
          ovl[y][x] = '';
        });
        m.overlay = ovl;
      }
    }
    var rk = Object.keys(st.roof || {});
    if (rk.length) {                                          // roofs players built: indoors, like a roof painted in the editor
      var rf = (base.roof || []).slice(), rdone = {};
      rk.forEach(function (k) {
        var q = k.split(','), x = Number(q[0]), y = Number(q[1]);
        if (!(y >= 0 && y < base.height) || !(x >= 0 && x < base.width)) return;
        if (!rdone[y]) { rf[y] = (rf[y] || []).slice(); rdone[y] = 1; }
        while (rf[y].length < x) rf[y].push('');
        rf[y][x] = '1';
      });
      m.roof = rf; m._roofZones = null;
    }
    m._block = null; m._at = null; m._edgeOv = null; m._struct = st;   // its OWN derived caches (never the authored map's, via the prototype)
    // not enumerable: the content object is sent to clients as JSON and must not drag live state along
    Object.defineProperty(base, '_live', { value: { rev: st.rev, of: st, map: m }, enumerable: false, writable: true, configurable: true });
    return m;
  }
  function liveMap(c, ws, mapId) {
    var base = c.maps[mapId]; if (!base) return null;
    var ms = ws && ws.maps && ws.maps[mapId], st = ms && ms.struct;
    if (!st || !st.rev) return base;
    var m = liveMapFromStruct(c, base, st);
    if (!m._edgeOv) m._edgeOv = buildEdgeOv(c, m, function (e) { return stateOf(c, ws, mapId, e); });
    return m;
  }
  function publicStruct(st) {
    return { rev: st.rev || 0, walls: st.walls || {}, dmg: st.dmg || {}, gone: st.gone || {}, floor: st.floor || {}, hole: st.hole || {}, shadow: st.shadow || {}, roof: st.roof || {},
      ents: (st.ents || []).map(function (e) { var o = {}; Object.keys(e).forEach(function (k) { if (k !== 'inv') o[k] = e[k]; }); return o; }) };
  }

  // ---- health: what a wall or object can take ----
  // A target is {t:'wall', orient, x, y} or {t:'ent', key}. resolveOn answers what it is and how hurt it is,
  // from a map (authored or live) plus the layer — so the referee and the client's menus/drawing agree.
  var NO_HP_KINDS = { spawn: 1, trigger: 1, teleport: 1, npc: 1, sign: 1 };
  // damage multiplier by what hits (row) and what it is made of (column)
  var MULT = {
    melee:   { wood: 1,   metal: 0.25, stone: 0.25, glass: 2 },
    bullet:  { wood: 0.5, metal: 0.1,  stone: 0.1,  glass: 3 },
    blast:   { wood: 2,   metal: 1,    stone: 1,    glass: 4 },
    fire:    { wood: 1,   metal: 0,    stone: 0,    glass: 0 },
    monster: { wood: 1,   metal: 0.5,  stone: 0.5,  glass: 2 }
  };
  function resolveOn(c, map, st, t) {
    if (!map || !t) return null;
    st = st || NO_STRUCT;
    var key, rec, max;
    if (t.t === 'wall') {
      key = Rl().edgeKey(t.orient, t.x, t.y); rec = st.walls[key] || null;
      var tok = rec ? rec.tok : (st.gone[key] ? '' : Rl().wallAt(map, t.orient, t.x, t.y));
      if (!tok) return null;
      var style = (c.wallStyles && c.wallStyles[Rl().parseWall(tok).style]) || {};
      max = rec ? Number(rec.max) || 0 : Number(style.hp) || 0;
      return { t: 'wall', key: key, orient: t.orient, x: t.x, y: t.y, built: !!rec, rec: rec, name: lower(style.name || 'wall'),
        max: max, hp: rec ? Number(rec.hp) || 0 : max - (Number(st.dmg[key]) || 0),
        armor: Number(style.armor) || 0, material: style.material || 'stone', salvage: style.salvage || '',
        by: rec ? rec.by : null, can: max > 0 && (!!rec || !!style.breakable) };
    }
    key = t.key;
    if (st.gone[key]) return null;
    var e = (map.entities || []).filter(function (x) { return x.key === key; })[0]; if (!e) return null;
    var o = objOf(c, e); if (!o) return null;
    var pr = o.properties || {};
    rec = (st.ents || []).indexOf(e) >= 0 ? e : null;
    max = rec ? Number(rec.max) || 0 : Number(pr.hp) || 0;
    return { t: 'ent', key: key, e: e, x: e.x, y: e.y, built: !!rec, rec: rec, name: lower(o.name), obj: o,
      max: max, hp: rec ? Number(rec.hp) || 0 : max - (Number(st.dmg[key]) || 0),
      armor: Number(pr.armor) || 0, material: pr.material || 'wood', salvage: pr.salvage || '',
      by: rec ? rec.by : null, can: max > 0 && !yes(pr.indestructible) && !NO_HP_KINDS[o.kind] };
  }
  /** Client-side: the same answer from the map it draws (the layer hangs on a live map as map._struct). */
  function structInfo(c, map, t) { return resolveOn(c, map, map && map._struct, t); }
  function resolveTarget(c, ws, mapId, t) { return resolveOn(c, liveMap(c, ws, mapId), structOf(ws, mapId), t); }

  /** A wall or object is destroyed: it leaves the map (and takes the fixtures hanging on it along). */
  function destroyStructure(c, ws, mapId, tg, src, ev) {
    var st = structOf(ws, mapId), ms = mapState(ws, mapId), map = liveMap(c, ws, mapId);
    function dropEnt(key) {
      var i = -1; st.ents.forEach(function (b, n) { if (b.key === key) i = n; });
      if (i >= 0) {
        var lost = st.ents.splice(i, 1)[0], rub = c.config.rubble_object || 'obj_rubble';
        var lo = objOf(c, lost);
        if (lo && lo.kind === 'claim') {
          shadowClaim(c, ws, mapId, lost, true);              // the other floors of the base lose it too
          var cr = claimRadius(c, lost);
          st.ents.forEach(function (b) { if (cheb(b.x, b.y, lost.x, lost.y) <= cr) b.by = null; });
          Object.keys(st.walls).forEach(function (wk) {
            var we = edgeOfKey(wk);
            if (we && edgeCells(we).some(function (cl) { return cheb(cl.x, cl.y, lost.x, lost.y) <= cr; })) st.walls[wk].by = null;
          });
        }
        // a storage container's contents are never just deleted: they stay behind in a pile of rubble
        if (lost.inv && Object.keys(lost.inv).length && c.objects[rub])
          st.ents.push({ key: mapId + '.b' + (++st.n), x: lost.x, y: lost.y, ref: rub, data: {}, hp: 0, max: 0, bp: '', by: null, built: (src && src.now) || Date.now(), prog: 0, need: 0, inv: lost.inv });
      } else st.gone[key] = 1;
      delete st.dmg[key]; delete ms.states[key]; delete ms.timers[key];
    }
    if (tg.t === 'wall') {
      // whatever hangs on this stretch of wall (a door, a window, a torch) goes with it
      (map.entities || []).forEach(function (e) {
        var o = objOf(c, e);
        if (isWallFixture(o) && fixtureEdges(o, e).some(function (q) { return q.orient === tg.orient && q.x === tg.x && q.y === tg.y; })) dropEnt(e.key);
      });
      if (st.walls[tg.key]) delete st.walls[tg.key]; else st.gone[tg.key] = 1;
      delete st.dmg[tg.key];
    } else {
      dropEnt(tg.key);
      var hv = !tg.built && tg.obj && tg.obj.properties && tg.obj.properties.harvest;
      if (hv) {                                              // a tree, a wreck...: it yields, then comes back later
        if (src && src.player) list(hv).forEach(function (g) { give(c, src.player, g.item, g.qty, ev); });
        var back = Number(tg.obj.properties.respawn_s) || Number(c.config.harvest_respawn_s) || 600;
        st.gone[tg.key] = 2;
        ms.timers[tg.key] = { at: ((src && src.now) || Date.now()) + back * 1000, regrow: true };
      }
    }
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: mapId, op: 'break', key: tg.key, x: tg.x, y: tg.y });
    if (src && src.player) {
      ev.push({ type: 'info', to: src.player.id, text: 'The ' + tg.name + ' breaks.' });
      if (tg.salvage) list(tg.salvage).forEach(function (g) { give(c, src.player, g.item, g.qty, ev); });
    }
  }
  /**
   * Hurt a wall or object. src = {kind: 'melee'|'bullet'|'blast'|'fire'|'monster', by: id, player: the
   * player object when a player did it}. Returns null when the thing cannot be damaged at all, else
   * {dealt, destroyed, tg}.
   */
  function damageStructure(c, ws, mapId, t, amount, src, ev) {
    var tg = resolveTarget(c, ws, mapId, t);
    if (!tg || !tg.can || tg.hp <= 0) return null;
    src = src || {};
    // Another player's structure is protected only where a claim covers it (see protectedFrom).
    if (src.player && protectedFrom(c, ws, mapId, tg, src.player)) return null;
    var mult = (MULT[src.kind] || {})[tg.material]; if (mult === undefined) mult = 1;
    var dealt = Math.max(0, Math.round(amount * mult) - tg.armor);
    if (dealt <= 0) return { dealt: 0, destroyed: false, tg: tg };
    var st = structOf(ws, mapId), left = tg.hp - dealt;
    if (tg.built) tg.rec.hp = Math.max(0, left); else st.dmg[tg.key] = (Number(st.dmg[tg.key]) || 0) + dealt;
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'hit', map: mapId, x: tg.x, y: tg.y, amount: dealt, struct: tg.key, hp: Math.max(0, left), max: tg.max });
    if (left <= 0) destroyStructure(c, ws, mapId, tg, src, ev);
    return { dealt: dealt, destroyed: left <= 0, tg: tg };
  }
  // ------------------------------------------------------------ claims (who owns a base)
  // A claim is a BUILT object of kind `claim`: the land within its radius belongs to whoever built it and the
  // members they add. Everything here reads a live map (map._struct), so the client's ghost and menus agree
  // with the referee. Outside every claim nothing is owned: anyone may knock a stray wall down.
  function isBuiltEnt(map, e) { var st = map && map._struct; return !!(st && st.ents && st.ents.indexOf(e) >= 0); }
  function claimRadius(c, e) { var r = Number(props(c, e).claim_radius); return r > 0 ? r : 8; }
  /** Every claim on a live map: [{e (its record), x, y, r}]. */
  function claimsOn(c, map) {
    var st = map && map._struct; if (!st) return [];
    var own = (st.ents || []).filter(function (e) { var o = objOf(c, e); return o && o.kind === 'claim'; })
      .map(function (e) { return { e: e, x: e.x, y: e.y, r: claimRadius(c, e) }; });
    // …and the claims standing on the other floors of this building: a base is the whole column (st.shadow)
    var sh = st.shadow || {};
    return own.concat(Object.keys(sh).map(function (k) { return { e: sh[k], x: sh[k].x, y: sh[k].y, r: sh[k].r, shadow: true }; }));
  }
  /** The claim record covering a cell, or null. */
  function claimAt(c, map, x, y) {
    var cl = claimsOn(c, map).filter(function (q) { return cheb(q.x, q.y, x, y) <= q.r; })[0];
    return cl ? cl.e : null;
  }
  function isMember(e, p) { return !!e && (e.by === p.id || (e.members || []).some(function (m) { return m.id === p.id; })); }
  /** May p build on / use built things at this cell? True when no claim covers it, or p owns or belongs to it. */
  function mayUse(c, map, p, x, y) { var e = claimAt(c, map, x, y); return !e || isMember(e, p); }
  /** The first claim covering any of these cells that p does not belong to (null = none). */
  function foreignClaim(c, map, p, cells) {
    var cls = claimsOn(c, map);
    for (var i = 0; i < cls.length; i++) {
      if (isMember(cls[i].e, p)) continue;
      for (var j = 0; j < cells.length; j++) if (cheb(cls[i].x, cls[i].y, cells[j].x, cells[j].y) <= cls[i].r) return cls[i].e;
    }
    return null;
  }
  function claimOwner(e) { return (e && e.owner) || 'someone'; }
  /** The tiles a structure touches (a wall or fixture touches the two tiles its edge separates). */
  function structCells(tg) {
    if (tg.t === 'wall') return edgeCells({ orient: tg.orient, x: tg.x, y: tg.y });
    if (tg.obj && isWallFixture(tg.obj)) { var cells = []; fixtureEdges(tg.obj, tg.e).forEach(function (q) { edgeCells(q).forEach(function (cl) { cells.push(cl); }); }); return cells; }
    return [{ x: tg.x, y: tg.y }];
  }
  /**
   * Is this structure out of bounds for player p to DAMAGE? Only inside a claim p does not belong to (and only
   * while pvp_structures is off — turning it on allows raids). Trees and other harvestables stay open to all.
   */
  function protectedOn(c, map, tg, p) {
    if (yes(c.config.pvp_structures)) return false;
    if (tg.by && tg.by === p.id) return false;
    if (!tg.built && tg.obj && tg.obj.properties && tg.obj.properties.harvest) return false;
    return !!foreignClaim(c, map, p, structCells(tg));
  }
  function protectedFrom(c, ws, mapId, tg, p) { return protectedOn(c, liveMap(c, ws, mapId), tg, p); }
  /** May p take this built thing apart? Shared by the action menu and the referee. */
  function mayDismantle(c, map, p, tg) {
    if (!tg || !tg.built) return false;
    if (tg.obj && tg.obj.kind === 'claim') return tg.by === p.id;                  // a claim: its owner only
    var cells = structCells(tg);
    if (foreignClaim(c, map, p, cells)) return false;                              // someone else's base
    if (!tg.by || tg.by === p.id) return true;                                     // yours, or nobody's any more
    if (cells.some(function (cl) { return claimAt(c, map, cl.x, cl.y); })) return true;   // inside a base you belong to
    return yes(c.config.pvp_structures);
  }
  /** The claims this player still holds: entries for this map are checked against what stands there. */
  // ---- word between floors ----
  // Each floor is its own record, so what one floor must tell another travels as a NOTICE in ws.transfers:
  //   { map, monster }            a monster that took the stairs (see leaveFloor)
  //   { map, shadow: {key, rec} } a claim on another floor of the building appeared, changed, or (rec null) went
  //   { map, tiles: [...] }       floor to lay ({x, y, t, ifNone, s}) or open ({x, y, hole: 1}) — stairs or a roof built below
  //   { map, roofs: [...] }       this storey gained ({x, y, t, by, bp}) or lost ({x, y, gone: 1}) cover: floor laid or taken up above
  // World.deliver applies them where the whole world is in memory; the referee applies them to the other floor's
  // record. Either way through applyNotice, so both do exactly the same thing.
  function notify(ws, mapId, notice) { notice.map = mapId; (ws.transfers = ws.transfers || []).push(notice); ws.dirty = true; }
  /** Apply one notice to a floor's state record (ms). Safe on a record that has never been used. */
  function applyNotice(c, mapId, ms, t) {
    if (!ms || !t) return;
    if (t.monster) { (ms.arrivals = ms.arrivals || []).push(t.monster); return; }
    var st = ms.struct || (ms.struct = {}), base = c.maps[mapId];
    st.rev = st.rev || 0; st.n = st.n || 0;                   // the whole shape, as structOf makes it: this record may be brand new
    st.walls = st.walls || {}; st.ents = st.ents || []; st.dmg = st.dmg || {}; st.gone = st.gone || {};
    st.floor = st.floor || {}; st.hole = st.hole || {}; st.shadow = st.shadow || {}; st.roof = st.roof || {};
    if (t.shadow) { if (t.shadow.rec) st.shadow[t.shadow.key] = t.shadow.rec; else delete st.shadow[t.shadow.key]; }
    (t.tiles || []).forEach(function (q) {
      var k = q.x + ',' + q.y, authored = !!(base && base.terrain[q.y] && base.terrain[q.y][q.x]);
      if (q.hole) { delete st.floor[k]; if (authored) st.hole[k] = 1; }
      else if (!(q.ifNone && ((authored && !st.hole[k]) || st.floor[k]))) { st.floor[k] = { t: q.t, by: q.by || null, bp: q.bp || '' }; if (q.s) st.floor[k].s = q.s; delete st.hole[k]; }
    });
    (t.roofs || []).forEach(function (q) {
      var k = q.x + ',' + q.y;
      if (q.gone) delete st.roof[k];
      else if (!st.roof[k]) st.roof[k] = { t: q.t, by: q.by || null, bp: q.bp || '', up: 1 };
    });
    st.rev++;
  }
  /** Tell the other floors of the building about a claim on this one (gone = it no longer stands). */
  function shadowClaim(c, ws, mapId, e, gone) {
    floorsOf(c, mapId).forEach(function (f) {
      if (f.id === mapId) return;
      notify(ws, f.id, { shadow: { key: e.key, rec: gone ? null : { key: e.key, ref: e.ref, x: e.x, y: e.y, r: claimRadius(c, e), by: e.by, owner: e.owner, members: e.members || [], home: mapId } } });
    });
  }
  function heldClaims(map, p) {
    var st = (map && map._struct) || NO_STRUCT;
    return (p.claims || []).filter(function (q) { return !map || q.map !== map.id || (st.ents || []).some(function (b) { return b.key === q.key; }); });
  }
  function claimEvent(c, p, e, ev) {
    ev.push({ type: 'claim', to: p.id, key: e.key, owner: claimOwner(e), mine: e.by === p.id, radius: claimRadius(c, e), members: e.members || [] });
  }
  /** Manage a claim's members: {key, op: 'look' | 'add' (name) | 'remove' (id)}. Owner only; a new member must be here. */
  function claimAct(c, ws, p, a, now, ev, players) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var st = structOf(ws, p.map), e = st.ents.filter(function (b) { return b.key === String(a.key || ''); })[0], o = e && objOf(c, e);
    if (!e || !o || o.kind !== 'claim') return say('There is no claim there.');
    if (a.op === 'look') return claimEvent(c, p, e, ev);
    if (e.by !== p.id) return say('Only ' + claimOwner(e) + ' can do that.');
    if (cheb(p.x, p.y, e.x, e.y) > 1) return say('Too far away.');
    e.members = e.members || [];
    if (a.op === 'add') {
      var name = String(a.name || '').trim(), want = name.toLowerCase();
      if (!want) return say('Type a name.');
      var q = (players || []).filter(function (x) { return x.id !== p.id && x.map === p.map && String(x.name || '').toLowerCase() === want; })[0];
      if (!q) return say('No one called "' + name + '" is here. They have to be in this area with you.');
      if (isMember(e, q)) return say(q.name + ' already belongs to this base.');
      if (e.members.length >= cfgNum(c, 'claim_max_members', 8)) return say('This base has as many members as it can.');
      e.members.push({ id: q.id, name: q.name });
      ev.push({ type: 'info', to: q.id, text: p.name + ' made you a member of their base.' });
      say(q.name + ' is now a member of your base.');
    } else if (a.op === 'remove') {
      var before = e.members.length;
      e.members = e.members.filter(function (m) { return m.id !== String(a.id || ''); });
      if (e.members.length === before) return say('They are not a member.');
    } else return;
    touchStruct(st); ws.dirty = true;
    shadowClaim(c, ws, p.map, e, false);                    // members changed: the other floors hear of it
    claimEvent(c, p, e, ev);
  }

  // ------------------------------------------------------------ building
  // ---- floors (docs/FLOORS.md): a floor is a map of its own; these are the only readers of the family links.
  /** The id of the ground map of the building this map belongs to (itself when it has no floors). */
  function groundId(c, mapId) { var m = c.maps[mapId]; return m && m.floorOf ? m.floorOf : mapId; }
  /** The id of level z of that building, or '' when it has no such floor. */
  function floorId(c, mapId, z) { var m = c.maps[mapId], f = m && m.floors; return (f && f[z]) || (!z && m ? groundId(c, mapId) : ''); }
  /** The levels of that building, lowest first: [{z, id}]. A plain map answers [{z: 0, id}]. */
  function floorsOf(c, mapId) {
    var m = c.maps[mapId], f = (m && m.floors) || {};
    var out = Object.keys(f).map(function (k) { return { z: Number(k), id: f[k] }; }).sort(function (a, b) { return a.z - b.z; });
    return out.length ? out : (m ? [{ z: 0, id: mapId }] : []);
  }
  function cfgNum(c, key, def) { var v = c.config[key]; v = v === undefined || v === '' ? def : Number(v); return isNaN(v) ? def : v; }
  function noBuild(map, x, y) { var g = map && map.nobuild, row = g && g[y]; return !!(row && row[x] && row[x] !== '0'); }
  function inMap(map, x, y) { return x >= 0 && y >= 0 && x < map.width && y < map.height; }
  /** The grid edge a blueprint placed at cell (x,y) with side N|W sits on. */
  function sideEdge(x, y, side) { return String(side || 'N').toUpperCase() === 'W' ? { orient: 'v', x: x, y: y } : { orient: 'h', x: x, y: y }; }
  function edgeCells(ed) { return ed.orient === 'h' ? [{ x: ed.x, y: ed.y }, { x: ed.x, y: ed.y - 1 }] : [{ x: ed.x, y: ed.y }, { x: ed.x - 1, y: ed.y }]; }
  /** Where a blueprint would go: {kind:'wall'|'fixture'|'floor', edges, cells (every tile it touches), obj}. null = nonsense. */
  function buildSpot(c, map, bp, x, y, side) {
    if (bp.places === 'wall') { var ed = sideEdge(x, y, side); return { kind: 'wall', edges: [ed], cells: edgeCells(ed) }; }
    if (bp.places === 'tile' || bp.places === 'roof') return c.terrain[bp.terrain] ? { kind: bp.places, edges: [], cells: [{ x: x, y: y }] } : null;
    var o = c.objects[bp.object]; if (!o) return null;
    if (isWallFixture(o)) {
      var eds = fixtureEdges(o, { x: x, y: y, data: { side: String(side || 'N').toUpperCase() === 'W' ? 'W' : 'N' } }), cells = [];
      eds.forEach(function (q) { edgeCells(q).forEach(function (cl) { cells.push(cl); }); });
      return { kind: 'fixture', edges: eds, cells: cells, obj: o };
    }
    var fc = [];
    for (var ax = x; ax < x + Math.max(1, o.footprintW || 1); ax++) for (var ay = y; ay > y - Math.max(1, o.footprintH || 1); ay--) fc.push({ x: ax, y: ay });
    return { kind: 'floor', edges: [], cells: fc, obj: o };
  }
  /**
   * May p build blueprint bp at cell (x,y) (side N|W for walls and wall-mounted things)? {ok, reason}.
   * map = the live map; lk = serverLookup / viewLookup. The ghost preview and the referee both ask this.
   */
  function canBuild(c, map, lk, p, bp, x, y, side, facing) {
    function no(t) { return { ok: false, reason: t }; }
    if (String(c.config.build || 'on') === 'off') return no('Building is turned off.');
    if (!bp || (bp.unlock && !check(c, p, bp.unlock))) return no('You don\'t know how to build that.');
    if (!map || isNaN(x) || isNaN(y)) return no('Pick a spot.');
    var spot = buildSpot(c, map, bp, x, y, side);
    if (!spot) return no('That blueprint builds nothing.');
    var cells = spot.cells.filter(function (cl) { return inMap(map, cl.x, cl.y); });
    if (!cells.length || (spot.kind === 'floor' && cells.length !== spot.cells.length)) return no('Out of the map.');
    if (bp.tool && !hasTool(c, p, bp.tool)) return no('Needs ' + aAn(bp.tool) + '.');
    if (bp.station && !stationsNear(c, map, p, lk)[bp.station]) return no('Needs ' + aAn(stationName(c, bp.station)) + ' nearby.');
    var lack = list(bp.cost).filter(function (g) { return count(p, g.item) < g.qty; });
    if (lack.length) return no('Not enough ' + lack.map(function (g) { return lower(itemName(c, g.item)); }).join(', ') + '.');
    var reach = cfgNum(c, 'build_reach', 2), best = null, bd = 1e9;
    cells.forEach(function (cl) { var d = cheb(p.x, p.y, cl.x, cl.y); if (d < bd) { bd = d; best = cl; } });
    if (bd > reach) return no('Too far away.');
    if (bd > 0 && !canSee(c, map, p.x, p.y, best.x, best.y, lk.stateOf)) return no('You can\'t reach there.');
    if (cells.some(function (cl) { return noBuild(map, cl.x, cl.y); })) return no('You can\'t build here.');
    var fcl = foreignClaim(c, map, p, cells);
    if (fcl) return no('This land belongs to ' + claimOwner(fcl) + '.');
    var st = map._struct || NO_STRUCT, mine = 0, total = Object.keys(st.walls).length + st.ents.length;
    Object.keys(st.walls).forEach(function (k) { if (st.walls[k].by === p.id) mine++; });
    st.ents.forEach(function (b) { if (b.by === p.id) mine++; });
    if (total >= cfgNum(c, 'structure_cap_per_map', 600)) return no('This area is full of structures.');
    if (mine >= cfgNum(c, 'structure_cap_per_player', 150)) return no('You have built as much as you can here.');
    var R = Rl();
    if (spot.kind === 'tile') {
      // A piece of floor: only where there is none, and it has to join onto floor already there (no floating slabs).
      // …or on open ground: terrain ticked build_over (grass, dirt), or the bare earth a taken-up floor left.
      if (hasFloorAt(map, x, y) && (map.terrain[y][x] === bp.terrain || !openGround(c, map, x, y))) return no('There is already a floor there.');
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(function (d) { return hasFloorAt(map, x + d[0], y + d[1]); })) return no('A floor has to join onto one that is already there.');
      if ((map.z || 0) > 0) {
        // Upstairs a floor is also the roof of the storey below, so it obeys the same support rule. The walls below
        // are another record, so from up here it is counted the careful way: from the floor it joins onto
        // (the map's own floor counts as resting on a wall; a laid piece remembers its own count, rec.s).
        var fS = roofSpan(c), fbest = Infinity;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
          if (!hasFloorAt(map, x + d[0], y + d[1])) return;
          var fr = st.floor[(x + d[0]) + ',' + (y + d[1])];
          fbest = Math.min(fbest, fr && !fr.bare ? (Number(fr.s) || 1) : 1);
        });
        var fres = riskOf(fS, fbest + 1);
        if (!fres.ok) return fres;
        fres.spot = spot; return fres;
      }
      return { ok: true, spot: spot };
    }
    if (spot.kind === 'roof') {
      // A roof over this storey = a piece of floor on the storey above. It rests on walls: a piece may be at most
      // roof_support tiles from one, counted through the roof already there (roofSteps).
      if (!upperOf(c, map)) return no('Nothing can be built above here.');
      if (covered(c, map, x, y)) return no('There is already a roof there.');
      if (R.stairAt(c, map, x, y)) return no('Stairs come up through here.');
      var rres = riskOf(roofSpan(c), roofSteps(c, map, x, y));
      if (!rres.ok) return rres;
      rres.spot = spot; return rres;
    }
    if (spot.kind === 'floor' && spot.obj.kind === 'stairs') {
      // Stairs climb from this floor to the one above: it must exist (the owner adds floors in the map editor),
      // the whole run must be clear floor, and there must be room to land.
      var sf = facing && R.DIRS[facing] ? facing : 'N', sd = R.DIRS[sf], sn = R.stairLen();
      if (!(map.floors && map.floors[(map.z || 0) + 1])) return no('There is no floor above here to climb to.');
      for (var si = 0; si <= sn; si++) {
        var sx = x + si * sd.dx, sy = y + si * sd.dy;
        if (!inMap(map, sx, sy)) return no('Out of the map.');
        if (si === sn) break;                                 // (the landing only has to be on the map)
        if (!hasFloorAt(map, sx, sy)) return no('Stairs need floor under them.');
        if (noBuild(map, sx, sy)) return no('You can\'t build here.');
        if ((map.entities || []).some(function (e) { return e.x === sx && e.y === sy && !isWallFixture(objOf(c, e)); }) || R.stairAt(c, map, sx, sy)) return no('Something is in the way of the stairs.');
        var se = si ? R.wallEdge(sx - sd.dx, sy - sd.dy, sf) : null;                       // the line between this step and the one before
        if (se && R.edgeBlocked(c, map, se.orient, se.x, se.y, 'move')) return no('A wall crosses the stairs.');
      }
    }
    if (spot.kind === 'wall') {
      var ed = spot.edges[0];
      if (ed.orient === 'h' ? (ed.x >= map.width || ed.y > map.height) : (ed.x > map.width || ed.y >= map.height)) return no('Out of the map.');
      if (R.wallAt(map, ed.orient, ed.x, ed.y)) return no('There is already a wall there.');
      if (!c.wallStyles || !c.wallStyles[bp.wallStyle]) return no('That blueprint builds nothing.');
    } else if (spot.kind === 'fixture') {
      if (bp.needsWall && spot.edges.some(function (q) { return !R.wallAt(map, q.orient, q.x, q.y); })) return no('It needs a wall to hang on.');
      var taken = (map.entities || []).some(function (e) {
        var o2 = objOf(c, e);
        return isWallFixture(o2) && fixtureEdges(o2, e).some(function (q) { return spot.edges.some(function (w) { return w.orient === q.orient && w.x === q.x && w.y === q.y; }); });
      });
      if (taken) return no('Something is already on that wall.');
    } else {
      if ((map.entities || []).some(function (e) { return e.x === x && e.y === y && !isWallFixture(objOf(c, e)) && (st.ents.indexOf(e) >= 0 || !objOf(c, e) || !objOf(c, e).walkable); })) return no('Something is already there.');
      if (spot.obj.kind === 'claim') {
        var cr = claimRadius(c, { ref: bp.object, data: {} }), cmax = cfgNum(c, 'claim_max_per_player', 1), held = heldClaims(map, p);
        if (held.length >= cmax) {
          var om = held[0].map !== map.id && c.maps[held[0].map];
          return no(cmax > 1 ? 'You have as many claims as you can.' : 'You already have a base' + (om ? ' (in ' + om.name + ')' : '') + '. Take its claim apart first.');
        }
        if (claimsOn(c, map).some(function (q) { return cheb(q.x, q.y, x, y) <= q.r + cr; })) return no('Too close to another base.');
        // a claim must never fence other players off from the map's own doors, chests and ways out
        var sp = map.spawn;
        if (sp && cheb(Number(sp.x), Number(sp.y), x, y) <= cr) return no('Too close to where people arrive.');
        var keep = String(c.config.claim_open_land || 'on') === 'off' ? {} : { door: 1, container: 1, teleport: 1 }, near0 = (map.entities || []).filter(function (e) {
          var o3 = objOf(c, e); return o3 && keep[o3.kind] && st.ents.indexOf(e) < 0 && cheb(e.x, e.y, x, y) <= cr;
        })[0];
        if (near0) return no('Too close to the ' + lower(objOf(c, near0).name) + '. Claims need open land.');
        var others = st.ents.some(function (b) { return b.by && b.by !== p.id && cheb(b.x, b.y, x, y) <= cr; }) ||
          Object.keys(st.walls).some(function (wk) {
            var we = edgeOfKey(wk), w = st.walls[wk];
            return we && w.by && w.by !== p.id && edgeCells(we).some(function (cl) { return cheb(cl.x, cl.y, x, y) <= cr; });
          });
        if (others) return no('Someone else has built here.');
      }
      var bad = cells.some(function (cl) {
        var t = R.terrainAt(c, map, cl.x, cl.y);
        if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return true;
        return spot.obj.walkable ? false : !lk.free(cl.x, cl.y);
      });
      if (bad) return no('That spot is not clear.');
    }
    return { ok: true, spot: spot };
  }
  // ---- roofs (docs/FLOORS.md, stage 5) ----
  /** A floor blueprint (places: tile) used the other way: as a roof over the storey you stand on. One entry serves both
   *  (`build` takes `roof: true`; the build menu offers Floor and Roof for it). Anything else comes back as it is. */
  function asRoof(bp) { return bp && bp.places === 'tile' ? Object.assign({}, bp, { places: 'roof' }) : bp; }
  /** How many tiles from a wall a roof piece may be (Config roof_support, default 3; 0 = no rule). */
  function roofSpan(c) { return Math.max(0, Math.round(cfgNum(c, 'roof_support', 3))); }
  /** The storey above this map, as authored (null when the building has none). */
  function upperOf(c, map) { var id = map && map.floors && map.floors[(map.z || 0) + 1]; return (id && c.maps[id]) || null; }
  /** Covered by something the map itself has: a roof painted in the editor, or the authored floor of the storey above. */
  function authoredCover(c, map, x, y) { return roofTile(c.maps[map.id] || map, x, y) || hasFloorAt(upperOf(c, map), x, y); }
  /**
   * IS THIS CELL UNDER COVER? (map = the live map.) A roof players built, a roof painted in the editor, or the floor
   * of the storey above. The one question for anything that falls or flies in from above (rain, later).
   */
  function covered(c, map, x, y) {
    var st = map && map._struct;
    return !!(st && st.roof && st.roof[x + ',' + y]) || authoredCover(c, map, x, y);
  }
  /**
   * What holds the built roof up, per live map: steps = {"x,y": n} for every built roof cell, n = how many tiles
   * it is from a wall (1 = it rests on one), counted through roof cells side to side; cells that reach no wall are
   * left out. A wall on any of the cell's four sides holds it, and so does an object with properties.support (a
   * pillar) standing in it; roof joined onto the map's own cover counts as one step further than a wall.
   */
  function roofSupport(c, map) {
    if (Object.prototype.hasOwnProperty.call(map, '_roofSup') && map._roofSup) return map._roofSup;
    var st = map._struct || NO_STRUCT, keys = Object.keys(st.roof || {}), steps = {}, pillars = {}, R = Rl();
    (map.entities || []).forEach(function (e) { var o = objOf(c, e); if (o && o.properties && yes(o.properties.support)) pillars[e.x + ',' + e.y] = 1; });
    function held(x, y) { return !!(pillars[x + ',' + y] || R.wallAt(map, 'h', x, y) || R.wallAt(map, 'h', x, y + 1) || R.wallAt(map, 'v', x, y) || R.wallAt(map, 'v', x + 1, y)); }
    var out = { steps: steps, held: held }, cells = keys.map(function (k) { var q = k.split(','); return { k: k, x: Number(q[0]), y: Number(q[1]) }; });
    var D = [[1, 0], [-1, 0], [0, 1], [0, -1]], level = cells.filter(function (cl) { return held(cl.x, cl.y); }), n = 1;
    level.forEach(function (cl) { steps[cl.k] = 1; });
    var second = cells.filter(function (cl) { return !steps[cl.k] && D.some(function (d) { return authoredCover(c, map, cl.x + d[0], cl.y + d[1]); }); });
    while (level.length || (n === 1 && second.length)) {
      var next = [];
      level.forEach(function (cl) {
        D.forEach(function (d) {
          var k = (cl.x + d[0]) + ',' + (cl.y + d[1]);
          if (st.roof[k] && !steps[k]) { steps[k] = n + 1; next.push({ k: k, x: cl.x + d[0], y: cl.y + d[1] }); }
        });
      });
      if (n === 1) second.forEach(function (cl) { if (!steps[cl.k]) { steps[cl.k] = 2; next.push(cl); } });
      level = next; n++;
    }
    Object.defineProperty(map, '_roofSup', { value: out, enumerable: false, writable: true, configurable: true });
    return out;
  }
  /** How many tiles from a wall a NEW roof piece at (x,y) would be (1 = on a wall; Infinity = it joins nothing that holds). */
  function roofSteps(c, map, x, y) {
    var sup = roofSupport(c, map), best = Infinity;
    if (sup.held(x, y)) return 1;
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
      var nx = x + d[0], ny = y + d[1], s = sup.steps[nx + ',' + ny] || (authoredCover(c, map, nx, ny) ? 1 : 0);
      if (s && s + 1 < best) best = s + 1;
    });
    return best;
  }
  /** The answer for a piece that would be `steps` tiles from a wall: safe, at the limit (edge), or it would fall. */
  function riskOf(span, steps) {
    if (!span || steps < span) return { ok: true, steps: steps === Infinity ? 1 : steps, risk: 'safe' };
    if (steps === span) return { ok: true, steps: steps, risk: 'edge' };
    return { ok: false, risk: 'fall', reason: steps === Infinity ? 'A roof has to rest on a wall, or join onto roof that does.' : 'Too far from a wall: it would fall.' };
  }
  /** The blueprints this player knows, with what each costs and whether they can pay. For the build menu. */
  function blueprintsFor(c, p) {
    var bps = c.blueprints || {};
    return Object.keys(bps).map(function (id) { return bps[id]; })
      .filter(function (b) { return !b.unlock || check(c, p, b.unlock); })
      .map(function (b) {
        var cost = list(b.cost).map(function (g) { return { item: g.item, qty: g.qty, have: count(p, g.item) }; });
        return { id: b.id, name: b.name, category: b.category, places: b.places, object: b.object, terrain: b.terrain, icon: b.icon, wallStyle: b.wallStyle, wallHeight: b.wallHeight,
          tool: b.tool, toolOk: !b.tool || hasTool(c, p, b.tool), cost: cost, afford: cost.every(function (g) { return g.have >= g.qty; }), upgradeOf: b.upgradeOf };
      });
  }
  // A N-S wall can sit to one side of its grid line ('l' | 'r'; anything else = centred on it), as walls painted in
  // the map editor's cursor-side mode do. It is the third part of the wall token and changes only where the wall is
  // DRAWN: what blocks movement and sight stays on the line.
  function wallOff(tok) { var o = String(tok || '').split(':')[2]; return o === 'l' || o === 'r' ? o : ''; }
  function withOff(tok, off) { var b = String(tok || '').split(':'); return b[0] + ':' + (b[1] || 1) + (off === 'l' || off === 'r' ? ':' + off : ''); }
  /** Slide a N-S wall you built to the left, the right or back onto its line. Free; open to whoever may take it apart. */
  function shiftWall(c, ws, p, t, off, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), tg = resolveTarget(c, ws, p.map, t);
    if (!tg || !tg.built || tg.t !== 'wall' || tg.orient !== 'v') return say('Only a wall you built, running north to south, can be moved.');
    if (!besideTarget(c, map, p, tg)) return say('Too far away.');
    if (!mayDismantle(c, map, p, tg)) return say('That is not yours to move.');
    off = off === 'l' || off === 'r' ? off : '';
    if (wallOff(tg.rec.tok) === off) return;
    tg.rec.tok = withOff(tg.rec.tok, off);
    var st = structOf(ws, p.map); touchStruct(st); ws.dirty = true;
    say('You move the ' + tg.name + (off === 'l' ? ' to the left.' : off === 'r' ? ' to the right.' : ' back to the middle.'));
  }
  /** Turn something you built that has pictures for other directions (a chair): to `facing`, or a quarter turn clockwise. */
  function turnObj(c, ws, p, t, facing, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), tg = resolveTarget(c, ws, p.map, t);
    if (!tg || !tg.built || tg.t !== 'ent' || isWallFixture(tg.obj) || !Rl().turnable(tg.obj)) return say('That can\'t be turned.');
    if (!besideTarget(c, map, p, tg)) return say('Too far away.');
    if (!mayDismantle(c, map, p, tg)) return say('That is not yours to turn.');
    var f = facing ? Rl().facingOf(String(facing)) : Rl().nextFacing(tg.rec, 1);
    tg.rec.data = tg.rec.data || {};
    if (f === 'S') delete tg.rec.data.facing; else tg.rec.data.facing = f;
    var st = structOf(ws, p.map); touchStruct(st); ws.dirty = true;
    say('You turn the ' + tg.name + '.');
  }
  function build(c, ws, p, a, now, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var bp = (c.blueprints || {})[String(a.bp || '')], x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
    if (a.roof) bp = asRoof(bp);                              // a floor blueprint put up as a roof
    var map = liveMap(c, ws, p.map), chk = canBuild(c, map, serverLookup(c, ws, p.map, players || [p]), p, bp, x, y, a.side, a.facing);
    if (!chk.ok) return say(chk.reason);
    list(bp.cost).forEach(function (g) { take(p, g.item, g.qty); });
    var st = structOf(ws, p.map), need = bp.work, pct = cfgNum(c, 'frame_hp_pct', 0.2), max, rec;
    function live(mx) { return need > 0 && mx > 0 ? Math.max(1, Math.round(mx * pct)) : mx; }
    if (chk.spot.kind === 'tile') {                           // a piece of floor: laid at once, no frame
      st.floor[x + ',' + y] = { t: bp.terrain, by: p.id, bp: bp.id }; delete st.hole[x + ',' + y];
      if (chk.steps) st.floor[x + ',' + y].s = chk.steps;
      var below = (map.z || 0) > 0 && map.floors && map.floors[(map.z || 0) - 1];   // upstairs, a floor is the roof of the storey below
      if (below && c.maps[below]) notify(ws, below, { roofs: [{ x: x, y: y, t: bp.terrain, by: p.id, bp: bp.id }] });
      touchStruct(st); ws.dirty = true;
      ev.push({ type: 'struct', map: p.map, op: 'place', x: x, y: y, by: p.id });
      return say('You lay ' + aAn(lower(bp.name)) + '.');
    }
    if (chk.spot.kind === 'roof') {                           // a roof over this storey: the storey above gets it as floor
      st.roof[x + ',' + y] = { t: bp.terrain, by: p.id, bp: bp.id };
      notify(ws, upperOf(c, map).id, { tiles: [{ x: x, y: y, t: bp.terrain, by: p.id, bp: bp.id, s: chk.steps || 1 }] });
      touchStruct(st); ws.dirty = true;
      ev.push({ type: 'struct', map: p.map, op: 'place', x: x, y: y, by: p.id });
      return say('You put up ' + (a.roof ? 'a roof of ' + lower(bp.name) : aAn(lower(bp.name))) + (chk.risk === 'edge' ? '. It is as far from a wall as it can go.' : '.'));
    }
    if (chk.spot.kind === 'wall') {
      var ed = chk.spot.edges[0];
      max = Number(c.wallStyles[bp.wallStyle].hp) || 0;
      rec = { tok: withOff(bp.wallStyle + ':' + Rl().WALL_H, ed.orient === 'v' ? a.off : ''), hp: live(max), max: max, bp: bp.id, by: p.id, built: now, prog: 0, need: need };
      st.walls[Rl().edgeKey(ed.orient, ed.x, ed.y)] = rec;
    } else {
      var o = chk.spot.obj, pr = o.properties || {};
      max = Number(pr.hp) || 0;
      rec = { key: p.map + '.b' + (++st.n), x: x, y: y, ref: bp.object, data: chk.spot.kind === 'fixture' ? { side: String(a.side || 'N').toUpperCase() === 'W' ? 'W' : 'N' }
          : o.kind === 'stairs' ? { facing: Rl().DIRS[a.facing] ? a.facing : 'N' }       // stairs always say which way they climb
          : (a.facing && Rl().turnable(o) && Rl().facingOf(String(a.facing)) !== 'S' ? { facing: Rl().facingOf(String(a.facing)) } : {}),
        hp: live(max), max: max, bp: bp.id, by: p.id, built: now, prog: 0, need: need };
      if (o.kind === 'container' && Number(pr.storage) > 0) rec.inv = {};
      if (o.kind === 'claim') { rec.owner = p.name; rec.members = []; p.claims = heldClaims(map, p).concat([{ map: p.map, key: rec.key }]); shadowClaim(c, ws, p.map, rec, false); }
      if (o.kind === 'stairs') {
        openAbove(c, ws, p.map, map, rec, bp, p);
        var sdr = Rl().DIRS[Rl().stairDir(rec)];                 // the stairwell is open: no roof over the run
        for (var sri = 0; sri < Rl().stairLen(); sri++) delete st.roof[(rec.x + sri * sdr.dx) + ',' + (rec.y + sri * sdr.dy)];
      }
      st.ents.push(rec);
    }
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'place', x: x, y: y, by: p.id });
    say(need > 0 ? 'You set up the frame of ' + aAn(lower(bp.name)) + '. Work on it to finish.' : 'You build ' + aAn(lower(bp.name)) + '.');
  }
  // Stairs built here open the floor above: the cells over the run become a stairwell, and the landing gets a
  // piece of floor if it has none. That is the other floor's record, so it goes as a notice.
  function openAbove(c, ws, mapId, map, rec, bp, p) {
    var up = map.floors && map.floors[(map.z || 0) + 1]; if (!up) return;
    var o = objOf(c, rec), d = Rl().DIRS[Rl().stairDir(rec)], n = Rl().stairLen(), tiles = [];
    for (var i = 0; i < n; i++) tiles.push({ x: rec.x + i * d.dx, y: rec.y + i * d.dy, hole: 1 });
    var lay = c.terrain[bp.terrain] ? bp.terrain : (map.terrain[rec.y] && map.terrain[rec.y][rec.x]);
    if (lay) tiles.push({ x: rec.x + n * d.dx, y: rec.y + n * d.dy, t: lay, ifNone: true, by: p.id, bp: bp.id, s: 99 });   // s 99: a landing holds itself, but no floor may be hung from it
    notify(ws, up, { tiles: tiles });
  }
  /** May a floor be laid over what is at (x,y)? Ground ticked build_over (and nothing else painted on it), or bare earth. */
  function openGround(c, map, x, y) {
    var st = map._struct, rec = st && st.floor && st.floor[x + ',' + y];
    if (rec) return !!rec.bare;
    var t = c.terrain[map.terrain[y][x]], ov = map.overlay && map.overlay[y] && map.overlay[y][x];
    return !!t && t.buildOver && (!ov || !!(c.terrain[ov] && c.terrain[ov].buildOver));
  }
  /** What the ground is left as when a floor laid on it is taken up: Config floor_removed_terrain (a terrain id;
   *  'none' = the ground comes back as it was), else the terrain called Dirt, if there is one. */
  function bareTerrain(c) {
    var id = String(c.config.floor_removed_terrain || '').trim();
    if (id) return c.terrain[id] ? id : '';
    return Object.keys(c.terrain).filter(function (k) { return k.toLowerCase() === 'dirt' || String(c.terrain[k].name).trim().toLowerCase() === 'dirt'; })[0] || '';
  }
  /** Take up a piece of floor that was laid (target {t:'tile', x, y}): part of its materials come back. */
  function liftTile(c, ws, p, t, now, ev, players) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var st = structOf(ws, p.map), map = liveMap(c, ws, p.map), k = t.x + ',' + t.y;
    var chk = canRemove(c, map, serverLookup(c, ws, p.map, players || [p]), p, t);
    if (!chk.ok) return say(chk.reason);
    var rec = st.floor[k], bp = (c.blueprints || {})[rec.bp];
    // Over open air it leaves a gap; over the ground, bare earth (the grass does not come back)
    var under = c.maps[p.map].terrain[t.y] && c.maps[p.map].terrain[t.y][t.x], bare = under && !st.hole[k] ? bareTerrain(c) : '';
    if (bare) st.floor[k] = { t: bare, bare: 1 }; else delete st.floor[k];
    var lmap = c.maps[p.map], below = (lmap.z || 0) > 0 && lmap.floors && lmap.floors[(lmap.z || 0) - 1];
    if (below && c.maps[below]) notify(ws, below, { roofs: [{ x: t.x, y: t.y, gone: 1 }] });   // the storey below loses that piece of roof
    var share = cfgNum(c, 'dismantle_refund_pct', 0.5);
    list(bp ? bp.cost : '').forEach(function (g) { var q = Math.floor(g.qty * share); if (q > 0) give(c, p, g.item, q, ev); });
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'remove', x: t.x, y: t.y, by: p.id });
    say('You take up the floor.');
  }
  /** Take down a piece of roof from below (target {t:'roof', x, y}): the floor it was upstairs goes with it. */
  function liftRoof(c, ws, p, t, now, ev, players) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var st = structOf(ws, p.map), map = liveMap(c, ws, p.map), k = t.x + ',' + t.y;
    var chk = canRemove(c, map, serverLookup(c, ws, p.map, players || [p]), p, t);
    if (!chk.ok) return say(chk.reason);
    var rec = st.roof[k], bp = (c.blueprints || {})[rec.bp], up = upperOf(c, map);
    delete st.roof[k];
    if (up) notify(ws, up.id, { tiles: [{ x: t.x, y: t.y, hole: 1 }] });
    var share = cfgNum(c, 'dismantle_refund_pct', 0.5);
    list(bp ? bp.cost : '').forEach(function (g) { var q = Math.floor(g.qty * share); if (q > 0) give(c, p, g.item, q, ev); });
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'remove', x: t.x, y: t.y, by: p.id });
    say('You take down the roof.');
  }
  /** May p take up the laid floor at (x,y)? Its layer, or anyone in the base it lies in; anyone, if nobody's. */
  function tileMine(c, map, p, x, y) {
    var st = map && map._struct, rec = st && st.floor && st.floor[x + ',' + y]; if (!rec || rec.bare) return false;
    var cl = claimAt(c, map, x, y);
    return cl ? isMember(cl, p) : (!rec.by || rec.by === p.id);
  }
  /** Is p standing where they can work on / take apart this structure? */
  function besideTarget(c, map, p, tg) {
    var cells;
    if (tg.t === 'wall') cells = edgeCells({ orient: tg.orient, x: tg.x, y: tg.y });
    else if (isWallFixture(tg.obj)) { cells = []; fixtureEdges(tg.obj, tg.e).forEach(function (q) { edgeCells(q).forEach(function (cl) { cells.push(cl); }); }); }
    else return cheb(p.x, p.y, tg.x, tg.y) <= 1 && !(p.x === tg.x && p.y === tg.y && !tg.obj.walkable);
    return cells.some(function (cl) { return cl.x === p.x && cl.y === p.y; });
  }
  function needsWork(tg) { return !!tg && ((tg.rec && (tg.rec.prog || 0) < (tg.rec.need || 0)) || (tg.max > 0 && tg.hp < tg.max)); }
  /**
   * The structure at/toward cell (x,y) from p, as a target: the fixture or wall on the edge between, else an
   * object in that cell. `want` filters (needsWork, built...). Used for F, the action menu, and `work` with a cell.
   */
  function structAt(c, map, p, x, y, want) {
    var st = map && map._struct, out = [], ed = Rl().sharedEdge(p.x, p.y, x, y);
    if (!map) return null;
    if (ed) {
      (map.entities || []).forEach(function (e) {
        var o = objOf(c, e);
        if (isWallFixture(o) && fixtureEdges(o, e).some(function (q) { return q.orient === ed.orient && q.x === ed.x && q.y === ed.y; })) out.push({ t: 'ent', key: e.key });
      });
      out.push({ t: 'wall', orient: ed.orient, x: ed.x, y: ed.y });
    }
    Rl().blockersAt(c, map, x, y).concat(Rl().entitiesAt(map, x, y)).forEach(function (e) { if (!isWallFixture(objOf(c, e))) out.push({ t: 'ent', key: e.key }); });
    for (var i = 0; i < out.length; i++) { var tg = resolveOn(c, map, st, out[i]); if (tg && (!want || want(tg))) return out[i]; }
    return null;
  }
  function cleanTarget(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.t === 'wall' && (t.orient === 'h' || t.orient === 'v')) return { t: 'wall', orient: t.orient, x: Math.round(Number(t.x)), y: Math.round(Number(t.y)) };
    if (t.t === 'tile' || t.t === 'roof') return { t: t.t, x: Math.round(Number(t.x)), y: Math.round(Number(t.y)) };
    return t.t === 'ent' && t.key ? { t: 'ent', key: String(t.key) } : null;
  }
  /** One go at a frame (it gets nearer to finished) or at something damaged (it is repaired a bit, for materials). */
  function work(c, ws, p, t, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), tg = resolveTarget(c, ws, p.map, t);
    if (!tg || !needsWork(tg)) return say('Nothing to work on there.');
    if (!besideTarget(c, map, p, tg)) return say('Too far away.');
    var wcl = foreignClaim(c, map, p, structCells(tg));
    if (wcl) return say('This land belongs to ' + claimOwner(wcl) + '.');
    var bp = tg.rec && (c.blueprints || {})[tg.rec.bp];
    if (bp && bp.tool && !hasTool(c, p, bp.tool)) return say('You need ' + aAn(bp.tool) + '.');
    if (now < ((p.cooldowns || {})._work || 0)) return;
    p.cooldowns = p.cooldowns || {}; p.cooldowns._work = now + cfgNum(c, 'work_ms', 600);
    var st = structOf(ws, p.map), rec = tg.rec;
    if (rec && (rec.prog || 0) < (rec.need || 0)) {                     // a frame: one step nearer
      rec.prog = (rec.prog || 0) + 1;
      rec.hp = rec.prog >= rec.need ? rec.max : Math.min(rec.max, rec.hp + Math.ceil(rec.max * (1 - cfgNum(c, 'frame_hp_pct', 0.2)) / rec.need));
      touchStruct(st); ws.dirty = true;
      ev.push({ type: 'struct', map: p.map, op: rec.prog >= rec.need ? 'done' : 'work', key: tg.key, x: tg.x, y: tg.y, by: p.id });
      return say(rec.prog >= rec.need ? 'The ' + tg.name + ' is finished.' : 'You work on the ' + tg.name + ' (' + rec.prog + '/' + rec.need + ').');
    }
    var steps = (rec && rec.need) || 4, share = cfgNum(c, 'repair_cost_pct', 0.5);
    var cost = list(bp ? bp.cost : tg.salvage).map(function (g) { return { item: g.item, qty: Math.max(1, Math.ceil(g.qty * share / steps)) }; });
    var lack = cost.filter(function (g) { return count(p, g.item) < g.qty; });
    if (lack.length) return say('Repairing needs ' + lack.map(function (g) { return g.qty + ' ' + lower(itemName(c, g.item)); }).join(', ') + '.');
    cost.forEach(function (g) { take(p, g.item, g.qty); });
    var amt = Math.ceil(tg.max / steps), hp = Math.min(tg.max, tg.hp + amt);
    if (rec) rec.hp = hp; else { var left = tg.max - hp; if (left > 0) st.dmg[tg.key] = left; else delete st.dmg[tg.key]; }
    touchStruct(st); ws.dirty = true;
    say('You repair the ' + tg.name + ' (' + hp + '/' + tg.max + ').');
  }
  /**
   * May p take this apart right now? t = {t:'wall', orient, x, y} | {t:'ent', key} | {t:'tile', x, y} on a LIVE map.
   * Answers {ok, reason, info, cells}. The one question behind the remove tool's outline (client) and the referee:
   * it must have been built, be within building reach, be yours (or your base's), and be free of what depends on it.
   */
  function canRemove(c, map, lk, p, t) {
    function no(why, info) { return { ok: false, reason: why, info: info || null }; }
    var st = (map && map._struct) || NO_STRUCT, reach = cfgNum(c, 'build_reach', 2), bp;
    function far(cells) { return !cells.some(function (cl) { return cheb(p.x, p.y, cl.x, cl.y) <= reach; }); }
    if (!map || !t) return no('Pick something.');
    if (t.t === 'roof') {                                     // a piece of roof over this storey, taken down from below
      var rr = st.roof && st.roof[t.x + ',' + t.y], rcell = [{ x: t.x, y: t.y }];
      if (!rr) return no('There is no roof there that was built.');
      var ri = { t: 'roof', x: t.x, y: t.y, name: 'roof', rec: rr };
      if (far(rcell)) return no('Too far away.', ri);
      var rcl = claimAt(c, map, t.x, t.y);
      if (!(rcl ? isMember(rcl, p) : (!rr.by || rr.by === p.id))) return no('That is not yours to take apart.', ri);
      bp = (c.blueprints || {})[rr.bp];
      if (bp && bp.tool && !hasTool(c, p, bp.tool)) return no('You need ' + aAn(bp.tool) + '.', ri);
      return { ok: true, info: ri, cells: rcell };
    }
    if (t.t === 'tile') {
      var rec = st.floor && st.floor[t.x + ',' + t.y], cell = [{ x: t.x, y: t.y }];
      if (!rec || rec.bare) return no('You can only take up floor that was laid.');
      var ti = { t: 'tile', x: t.x, y: t.y, name: 'floor', rec: rec };
      if (far(cell)) return no('Too far away.', ti);
      if (!tileMine(c, map, p, t.x, t.y)) return no('That is not yours to take apart.', ti);
      if ((p.x === t.x && p.y === t.y) || lk.monsterAt(t.x, t.y) || lk.playerAt(t.x, t.y)) return no('Someone is standing on it.', ti);
      if ((map.entities || []).some(function (e) { return e.x === t.x && e.y === t.y && !isWallFixture(objOf(c, e)); }) || Rl().stairAt(c, map, t.x, t.y)) return no('Clear what stands on it first.', ti);
      bp = (c.blueprints || {})[rec.bp];
      if (bp && bp.tool && !hasTool(c, p, bp.tool)) return no('You need ' + aAn(bp.tool) + '.', ti);
      return { ok: true, info: ti, cells: cell };
    }
    var tg = resolveOn(c, map, st, t);
    if (!tg || !tg.built) return no('You can only take apart what was built.');
    var cells = structCells(tg);
    if (far(cells)) return no('Too far away.', tg);
    if (!mayDismantle(c, map, p, tg)) return no('That is not yours to take apart.', tg);
    bp = (c.blueprints || {})[tg.rec.bp];
    if (bp && bp.tool && !hasTool(c, p, bp.tool)) return no('You need ' + aAn(bp.tool) + '.', tg);
    if (tg.rec.inv && Object.keys(tg.rec.inv).length) return no('Empty it first.', tg);
    if (tg.t === 'wall' && (map.entities || []).some(function (e) { var o = objOf(c, e); return isWallFixture(o) && fixtureEdges(o, e).some(function (q) { return q.orient === tg.orient && q.x === tg.x && q.y === tg.y; }); }))
      return no('Take down what hangs on it first.', tg);
    return { ok: true, info: tg, cells: cells };
  }
  /** Take apart something that was built: it leaves the map and part of its materials come back. */
  function dismantle(c, ws, p, t, now, ev, players) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), chk = canRemove(c, map, serverLookup(c, ws, p.map, players || [p]), p, t);
    if (!chk.ok) return say(chk.reason);
    var tg = chk.info, bp = (c.blueprints || {})[tg.rec.bp];
    var st = structOf(ws, p.map), ms = mapState(ws, p.map);
    if (tg.t === 'wall') {
      delete st.walls[tg.key];
    } else {
      st.ents.splice(st.ents.indexOf(tg.rec), 1); delete ms.states[tg.key]; delete ms.timers[tg.key];
      if (tg.obj.kind === 'claim') { p.claims = (p.claims || []).filter(function (q) { return !(q.map === p.map && q.key === tg.key); }); shadowClaim(c, ws, p.map, tg.rec, true); }
    }
    var ratio = tg.max > 0 ? Math.max(0, Math.min(1, tg.hp / tg.max)) : 1, share = cfgNum(c, 'dismantle_refund_pct', 0.5);
    list(bp ? bp.cost : '').forEach(function (g) { var q = Math.floor(g.qty * share * ratio); if (q > 0) give(c, p, g.item, q, ev); });
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'remove', key: tg.key, x: tg.x, y: tg.y, by: p.id });
    say('You take the ' + tg.name + ' apart.');
  }
  /** Apply an upgrade blueprint to something already built (same spot, health kept in proportion). */
  function upgrade(c, ws, p, t, bpId, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), tg = resolveTarget(c, ws, p.map, t), nb = (c.blueprints || {})[String(bpId || '')];
    if (!tg || !tg.built || !nb || !nb.upgradeOf || nb.upgradeOf !== tg.rec.bp) return say('That can\'t be upgraded that way.');
    if ((tg.rec.prog || 0) < (tg.rec.need || 0)) return say('Finish building it first.');
    if (!besideTarget(c, map, p, tg)) return say('Too far away.');
    var ucl = foreignClaim(c, map, p, structCells(tg));
    if (ucl) return say('This land belongs to ' + claimOwner(ucl) + '.');
    if (nb.tool && !hasTool(c, p, nb.tool)) return say('You need ' + aAn(nb.tool) + '.');
    var lack = list(nb.cost).filter(function (g) { return count(p, g.item) < g.qty; });
    if (lack.length) return say('Not enough ' + lack.map(function (g) { return lower(itemName(c, g.item)); }).join(', ') + '.');
    var ratio = tg.max > 0 ? tg.hp / tg.max : 1, max;
    if (tg.t === 'wall') {
      if (nb.places !== 'wall' || !c.wallStyles[nb.wallStyle]) return say('That can\'t be upgraded that way.');
      max = Number(c.wallStyles[nb.wallStyle].hp) || 0; tg.rec.tok = withOff(nb.wallStyle + ':' + Rl().WALL_H, wallOff(tg.rec.tok));
    } else {
      if (nb.places !== 'object' || !c.objects[nb.object]) return say('That can\'t be upgraded that way.');
      max = Number((c.objects[nb.object].properties || {}).hp) || 0; tg.rec.ref = nb.object;
    }
    list(nb.cost).forEach(function (g) { take(p, g.item, g.qty); });
    tg.rec.max = max; tg.rec.hp = Math.max(max > 0 ? 1 : 0, Math.round(max * ratio)); tg.rec.bp = nb.id;
    var st = structOf(ws, p.map); touchStruct(st); ws.dirty = true;
    say('You upgrade it to ' + aAn(lower(nb.name)) + '.');
  }
  /** Storage containers players built: look inside, put things in, take things out. */
  function storageEvent(c, p, e, ev) {
    var o = objOf(c, e);
    ev.push({ type: 'storage', to: p.id, key: e.key, name: o.name, slots: Number((o.properties || {}).storage) || 0, inv: e.inv || {} });
  }
  function storeAct(c, ws, p, a, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var st = structOf(ws, p.map), e = st.ents.filter(function (b) { return b.key === String(a.key || ''); })[0];
    if (!e || !e.inv) return say('That holds nothing.');
    if (cheb(p.x, p.y, e.x, e.y) > 1) return say('Too far away.');
    var scl = foreignClaim(c, liveMap(c, ws, p.map), p, [{ x: e.x, y: e.y }]);
    if (scl) return say('That belongs to ' + claimOwner(scl) + '\'s base.');
    var id = String(a.item || ''), qty = Math.max(1, Math.round(Number(a.qty)) || 1), o = objOf(c, e), slots = Number((o.properties || {}).storage) || 0;
    if (a.op === 'put') {
      if (id === 'gold' || !c.items[id]) return say('You can\'t store that.');
      qty = Math.min(qty, count(p, id)); if (qty < 1) return say('You have none.');
      if (e.inv[id] === undefined && slots > 0 && Object.keys(e.inv).length >= slots) return say('It is full.');
      take(p, id, qty); e.inv[id] = (e.inv[id] || 0) + qty;
    } else if (a.op === 'take') {
      qty = Math.min(qty, e.inv[id] || 0); if (qty < 1) return say('There is none in there.');
      e.inv[id] -= qty; if (e.inv[id] <= 0) delete e.inv[id];
      give(c, p, id, qty, ev, true);
    } else if (a.op !== 'look') return;
    ws.dirty = true;                                                   // contents are private: no revision bump, no push
    storageEvent(c, p, e, ev);
  }

  /** What stands on a wall edge, as a target: the door/window fixture there if it can be hurt, else the wall. */
  function edgeTarget(c, map, st, orient, x, y) {
    var fx = (map.entities || []).filter(function (e) {
      var o = objOf(c, e);
      return isWallFixture(o) && fixtureEdges(o, e).some(function (q) { return q.orient === orient && q.x === x && q.y === y; });
    }).map(function (e) { return resolveOn(c, map, st, { t: 'ent', key: e.key }); }).filter(function (g) { return g && g.can; })[0];
    if (fx) return { t: 'ent', key: fx.key };
    var w = resolveOn(c, map, st, { t: 'wall', orient: orient, x: x, y: y });
    return w && w.can ? { t: 'wall', orient: orient, x: x, y: y } : null;
  }
  /**
   * What a melee swing from p at the neighbouring cell (x,y) would hit, if not a creature: the wall or
   * fixture on the edge between them, else a solid object standing in that cell. null = nothing breakable.
   */
  function strikeTarget(c, map, p, x, y) {
    var st = map && map._struct, ed = Rl().sharedEdge(p.x, p.y, x, y);
    if (!map) return null;
    if (!ed) {                                                                         // diagonal: only an object there, and only with no wall corner between
      if (Math.abs(p.x - x) !== 1 || Math.abs(p.y - y) !== 1 || moveBlockedEdge(c, map, p.x, p.y, x, y)) return null;
    } else {
      var onEdge = edgeTarget(c, map, st, ed.orient, ed.x, ed.y);
      if (onEdge) return onEdge;
      if (Rl().edgeBlocked(c, map, ed.orient, ed.x, ed.y, 'move')) return null;        // an unbreakable wall is in the way
    }
    var hit = Rl().blockersAt(c, map, x, y).filter(function (e) { return !isWallFixture(objOf(c, e)); })
      .map(function (e) { return resolveOn(c, map, st, { t: 'ent', key: e.key }); }).filter(function (g) { return g && g.can; })[0];
    return hit ? { t: 'ent', key: hit.key } : null;
  }
  function structureDamageOf(c, p, weapon) {
    if (weapon && Number(weapon.structureDmg) > 0) return Number(weapon.structureDmg);
    var k = c.config.structure_dmg_scale === undefined || c.config.structure_dmg_scale === '' ? 0.5 : Number(c.config.structure_dmg_scale);
    return Math.max(1, Math.round(stats(c, p).atk * (k >= 0 ? k : 0.5)));
  }
  /** A melee swing at a wall or object (same pace as a basic attack). */
  function strike(c, ws, p, t, now, rng, ev) {
    if (now < (p.nextAttack || 0)) return false;
    p.nextAttack = now + (Number(c.config.attack_ms) || 0);
    var tg0 = resolveTarget(c, ws, p.map, t), needTool = tg0 && tg0.obj && tg0.obj.properties && tg0.obj.properties.harvest_tool;
    if (needTool && !hasTool(c, p, needTool)) { ev.push({ type: 'info', to: p.id, text: 'You need ' + toolsText(needTool) + ' for the ' + tg0.name + '.' }); return true; }
    var res = damageStructure(c, ws, p.map, t, structureDamageOf(c, p, c.items[(p.equipment || {}).weapon]), { kind: 'melee', by: p.id, player: p, now: now }, ev);
    if (!res) ev.push({ type: 'info', to: p.id, text: 'You can\'t damage that.' });
    else if (!res.dealt) ev.push({ type: 'info', to: p.id, text: 'You can\'t even scratch the ' + res.tg.name + '.' });
    else if (!res.destroyed) ev.push({ type: 'info', to: p.id, text: 'You hit the ' + res.tg.name + ' for ' + res.dealt + '.' });
    return true;
  }

  function entity(c, mapId, key) {
    var m = c.maps[mapId];
    return m ? m.entities.filter(function (e) { return e.key === key; })[0] : null;
  }
  /** Timed traps cycle up and down by the clock, so every client can draw them without asking. */
  function trapPhase(pr, now) {
    var up = Math.max(50, Number(pr.up_ms) || 1000), down = Math.max(50, Number(pr.down_ms) || 1000), period = up + down;
    var t = now + (Number(pr.offset_ms) || 0);
    return { up: ((t % period) + period) % period < up, cycle: Math.floor(t / period) };
  }
  function isTimed(c, e, pr) { var o = objOf(c, e); return o && o.kind === 'trap' && (pr || props(c, e)).trigger === 'timed'; }
  /** State to draw: a forced state wins; timed traps follow the clock; otherwise undefined (use the view's). */
  function liveState(c, e, now, states) {
    if (states && states[e.key] !== undefined) return states[e.key];
    var pr = props(c, e);
    return isTimed(c, e, pr) ? (trapPhase(pr, now).up ? 'up' : 'down') : undefined;
  }

  function stateOf(c, ws, mapId, e, now) {
    var ms = mapState(ws, mapId);
    if (ms.states[e.key] !== undefined) return ms.states[e.key];
    var p = props(c, e), k = kindOf(c, e);
    if (isTimed(c, e, p)) return trapPhase(p, now || Date.now()).up ? 'up' : 'down';
    if (p.state) return p.state;
    if (k && (k.kind === 'container' || k.kind === 'door') && (p.locked_by || yes(p.locked))) return 'locked';
    return k && k.states.length ? k.states[0] : '';
  }
  function setState(ws, mapId, key, st) {
    var ms = mapState(ws, mapId);
    if (st == null) delete ms.states[key]; else ms.states[key] = st;
    ws.dirty = true;
  }

  // ------------------------------------------------------------ players
  function classOf(c, p) {
    return c.classes[p['class']] || c.classes[c.config.start_class] || c.classes[Object.keys(c.classes)[0]] ||
      { id: '', name: 'Adventurer', hp: 100, atk: 5, def: 1, hpPerLevel: 10, atkPerLevel: 1, defPerLevel: 1, startItems: '' };
  }
  function stats(c, p) {
    var k = classOf(c, p), l = (Number(p.level) || 1) - 1;
    var s = { maxHp: k.hp + k.hpPerLevel * l, atk: k.atk + k.atkPerLevel * l, def: k.def + k.defPerLevel * l,
      maxMp: (k.mp || 0) + (k.mpPerLevel || 0) * l, mpRegen: k.mpRegen || 0 };
    Object.keys(p.equipment || {}).forEach(function (slot) {
      var it = c.items[p.equipment[slot]]; if (it) { s.atk += it.atk; s.def += it.def; }
    });
    (p.statuses || []).forEach(function (st) { var d = c.statuses && c.statuses[st.id]; if (d) { s.atk += d.atk; s.def += d.def; } });
    s.atk = Math.max(1, s.atk);
    return s;
  }
  function levelFor(c, xp) {
    var lv = 1; c.levels.forEach(function (r) { if (xp >= r.xp) lv = Math.max(lv, r.level); }); return lv;
  }
  function xpFor(c, level) { var r = c.levels.filter(function (x) { return x.level === level; })[0]; return r ? r.xp : null; }

  // The map a brand-new / respawning player starts on: the configured start_map, else the first map that has
  // an authored spawn point (set in the map editor), else the first map. start_x/start_y stay the fallback pos.
  function startMap(c) {
    if (c.config.start_map && c.maps[c.config.start_map]) return c.maps[c.config.start_map];
    var ks = Object.keys(c.maps), withSpawn = ks.filter(function (k) { return c.maps[k] && c.maps[k].spawn; })[0];
    return c.maps[withSpawn] || c.maps[ks[0]];
  }
  function newPlayer(c, id, name, cls) {
    var p = { id: id, name: name, 'class': c.classes[cls] ? cls : (c.config.start_class || Object.keys(c.classes)[0] || ''),
      map: '', x: 0, y: 0, facing: 'S', level: 1, xp: 0, gold: 0, inventory: [], equipment: {}, flags: {}, explored: {}, respawn: '',
      // cosmetic paper-doll choices (character creation will let players pick these)
      hair: c.config.start_hair || '', hairColor: c.config.start_hair_color || 'hair_brown' };
    var map = startMap(c), sp = map && map.spawn;                           // the map's own spawn point wins over config.start_x/y
    var sx = sp ? Number(sp.x) || 0 : Number(c.config.start_x) || 0, sy = sp ? Number(sp.y) || 0 : Number(c.config.start_y) || 0;
    var at = Rl().nearestStandable(c, map, sx, sy);
    p.map = map.id; p.x = at.x; p.y = at.y; p.facing = (sp && sp.facing) || 'S';
    p.hp = stats(c, p).maxHp; p.mp = stats(c, p).maxMp;
    p.hunger = 100; p.thirst = 100;
    p.cooldowns = {}; p.statuses = []; p.mags = {}; p.abilities = ['', '']; p.belt = emptyBelt();
    list(classOf(c, p).startItems).forEach(function (s) { give(c, p, s.item, s.qty, [], true); });
    // equip the first weapon/armor they start with, so e.g. a survivor spawns with the pistol in hand
    list(classOf(c, p).startItems).forEach(function (s) {
      var it = c.items[s.item];
      if (it && it.slot && !p.equipment[it.slot] && (!it.equipIf || check(c, p, it.equipIf))) p.equipment[it.slot] = s.item;
    });
    var wep0 = rangedWeapon(c, p); if (wep0) loadMag(c, p, wep0);   // a spawned gun starts with a full magazine
    fillLoadout(c, p);
    adoptWeapon(c, p);
    return p;
  }
  /** The hotbar: this many belt slots (keys 1-9 and 0). With Config `skills` on, the two abilities (Q, E) show beside it. */
  var BELT_SIZE = 10;
  /** Skills are switched off for now (Config `skills`: on brings back Q/E, the bag's abilities and the mana bar).
   *  The rules for them are untouched; this only decides what players are shown and told. */
  function skillsOn(c) { return String((c.config || {}).skills || '').toLowerCase() === 'on'; }
  function emptyBelt() { var a = []; while (a.length < BELT_SIZE) a.push(''); return a; }
  /** The belt slot an item sits in, putting it there first if it is not on the belt (an empty slot, else the one in hand). */
  function beltSlotFor(p, id) {
    p.belt = p.belt || emptyBelt();
    var i = p.belt.indexOf(id);
    if (i < 0) { i = p.belt.indexOf(''); if (i < 0) i = p.held >= 0 ? p.held : BELT_SIZE - 1; p.belt[i] = id; }
    return i;
  }
  /** A character with no belt slot chosen yet (new, or saved before the belt held weapons): the weapon they wear
   *  goes on the belt and is what they hold; with no weapon they hold nothing (-1). */
  function adoptWeapon(c, p) {
    var w = (p.equipment || {}).weapon;
    p.held = w && c.items[w] ? beltSlotFor(p, w) : -1;
  }
  /**
   * What is in your hands is the belt slot you chose (p.held; -1 = nothing). A weapon there is the weapon you wear;
   * anything else (food, a grenade, a tool, an empty slot) puts the weapon away. Using what you hold is a separate
   * action (`use`, `throw`), so nothing is eaten by choosing it.
   */
  function holdSlot(c, p, slot, ev) {
    slot = Math.floor(Number(slot)); if (!(slot >= 0 && slot < BELT_SIZE)) slot = -1;
    p.held = slot; p.equipment = p.equipment || {};
    var id = slot >= 0 ? (p.belt || [])[slot] : '', it = id && c.items[id], was = p.equipment.weapon || '';
    var wep = !!(it && it.slot === 'weapon' && count(p, id) > 0);
    if (wep && it.equipIf && !check(c, p, it.equipIf)) {
      wep = false;
      var req = /level:(\d+)/.exec(it.equipIf);
      if (ev) ev.push({ type: 'info', to: p.id, text: 'You cannot use the ' + lower(it.name) + ' yet.' + (req ? ' (Requires level ' + req[1] + '.)' : '') });
    }
    if (wep) {
      p.equipment.weapon = id;
      if (was !== id && itemCan(it, 'shoot') && Number(it.clip) > 0 && !((p.mags && p.mags[id]) || 0)) loadMag(c, p, it);   // a freshly drawn gun loads its magazine
    } else delete p.equipment.weapon;
    if ((p.equipment.weapon || '') !== was) { syncLoadout(c, p); p.hp = Math.min(p.hp, stats(c, p).maxHp); }
  }
  /** Fills in anything missing (e.g. a character saved before milestone 3). */
  function normalize(c, p) {
    function obj(v, d) { if (v && typeof v === 'object') return v; try { return v ? JSON.parse(v) : d; } catch (e) { return d; } }
    p.inventory = obj(p.inventory, []); if (!Array.isArray(p.inventory)) p.inventory = [];
    p.equipment = obj(p.equipment, {}); p.flags = obj(p.flags, {}); p.explored = obj(p.explored, {});
    p.cooldowns = obj(p.cooldowns, {}); p.statuses = obj(p.statuses, []); if (!Array.isArray(p.statuses)) p.statuses = [];
    p.mags = obj(p.mags, {}); if (!p.mags || typeof p.mags !== 'object' || Array.isArray(p.mags)) p.mags = {};   // rounds loaded per gun
    p.abilities = obj(p.abilities, null); p.belt = obj(p.belt, null);
    if (!Array.isArray(p.abilities) || !Array.isArray(p.belt)) {
      p.abilities = ['', '']; p.belt = emptyBelt();
      var oldBar = obj(p.loadout, null);              // pre-rework: one mixed 5-slot bar of "skill:x"/"item:x"
      if (Array.isArray(oldBar)) oldBar.forEach(function (e) {
        var k = String(e || '').split(':')[0], id = String(e || '').slice(k.length + 1); if (!id) return;
        if (k === 'skill') { var a = p.abilities.indexOf(''); if (a >= 0) p.abilities[a] = id; }
        else if (k === 'item') { var b = p.belt.indexOf(''); if (b >= 0) p.belt[b] = id; }
      });
      p._fill = true;
    }
    while (p.abilities.length < 2) p.abilities.push('');
    while (p.belt.length < BELT_SIZE) p.belt.push('');           // older characters had five
    delete p.loadout;
    p.abilities = p.abilities.map(function (id) { return id && c.skills && c.skills[id] ? id : ''; });   // drop skills no longer in the data (e.g. the old gunshot)
    p.belt = p.belt.map(function (id) { return id && c.items[id] ? id : ''; });
    if (typeof p.held !== 'number' || isNaN(p.held)) adoptWeapon(c, p);
    else p.held = Math.max(-1, Math.min(BELT_SIZE - 1, Math.floor(p.held)));
    p.level = Number(p.level) || 1; p.xp = Number(p.xp) || 0; p.gold = Number(p.gold) || 0;
    p.x = Number(p.x) || 0; p.y = Number(p.y) || 0; p.facing = p.facing || 'S'; p.respawn = p.respawn || '';
    if (!p['class'] || !c.classes[p['class']]) p['class'] = c.config.start_class || Object.keys(c.classes)[0] || '';
    if (p.hair == null) p.hair = c.config.start_hair || '';
    if (!p.hairColor) p.hairColor = c.config.start_hair_color || 'hair_brown';
    var mx = stats(c, p).maxHp, hp = Number(p.hp);
    p.hp = !hp || hp <= 0 || isNaN(hp) ? mx : Math.min(hp, mx);
    var mm = stats(c, p).maxMp, mp = Number(p.mp);
    p.mp = p.mp === '' || p.mp == null || isNaN(mp) ? mm : Math.max(0, Math.min(mp, mm));
    var hun = Number(p.hunger); p.hunger = p.hunger === '' || p.hunger == null || isNaN(hun) ? 100 : Math.max(0, Math.min(100, hun));
    var thi = Number(p.thirst); p.thirst = p.thirst === '' || p.thirst == null || isNaN(thi) ? 100 : Math.max(0, Math.min(100, thi));
    if (p._fill) { delete p._fill; syncLoadout(c, p); }   // migrated/empty bars: drop stale skills/items, then refill
    if (!c.maps[p.map]) { var np = newPlayer(c, p.id, p.name, p['class']); p.map = np.map; p.x = np.x; p.y = np.y; }
    return p;
  }

  /** Skills this character knows from its class at their level. */
  function knownSkills(c, p) {
    return (classOf(c, p).skills || []).filter(function (s) { return p.level >= s.level && c.skills && c.skills[s.skill]; })
      .map(function (s) { return s.skill; });
  }
  /** Everything the character can cast right now (class skills at their level). */
  function usableSkills(c, p) { return knownSkills(c, p); }
  /** Can this item 'equip' | 'shoot' | 'consume' | 'throw'? Decided by its type's ticks (Content Studio → Item Types).
   *  Content built by an older referee has no ticks: read the type's name, as the rules used to. */
  function itemCan(it, what) {
    if (!it) return false;
    if (it.can) return !!it.can[what];
    return what === 'consume' ? it.type === 'consumable' : what === 'throw' ? it.type === 'throwable'
         : what === 'shoot' ? it.type === 'weapon' : what === 'equip' ? !!it.slot : false;
  }
  /** Items that belong on the belt: things you consume or throw, weapons and tools. */
  function beltItems(c, p) {
    return (p.inventory || []).map(function (s) { return s.item; }).filter(function (id) {
      var it = c.items[id]; return itemCan(it, 'consume') || itemCan(it, 'throw') || !!(it && (it.slot === 'weapon' || (it.tools || []).length));
    });
  }
  /** Fills empty ability slots (Q/E) with usable skills, and empty belt slots with what belongs there (beltItems). */
  function fillLoadout(c, p) {
    p.abilities = p.abilities || ['', '']; p.belt = p.belt || emptyBelt();
    usableSkills(c, p).forEach(function (id) {
      if (p.abilities.indexOf(id) >= 0) return;
      var i = p.abilities.indexOf(''); if (i >= 0) p.abilities[i] = id;
    });
    beltItems(c, p).forEach(function (id) {
      if (p.belt.indexOf(id) >= 0) return;
      var j = p.belt.indexOf(''); if (j >= 0) p.belt[j] = id;
    });
  }
  /** After gear/level changes: drop abilities you can no longer use and invalid belt items, then refill. */
  function syncLoadout(c, p) {
    var usable = usableSkills(c, p);
    p.abilities = (p.abilities || ['', '']).map(function (id) { return id && usable.indexOf(id) < 0 ? '' : id; });
    p.belt = (p.belt || emptyBelt()).map(function (id) { return id && c.items[id] ? id : ''; });
    fillLoadout(c, p);
  }

  function itemName(c, id) { return id === 'gold' ? 'gold' : (c.items[id] ? c.items[id].name : id); }
  function count(p, id) {
    if (id === 'gold') return p.gold;
    var s = p.inventory.filter(function (x) { return x.item === id; })[0]; return s ? s.qty : 0;
  }
  function give(c, p, id, qty, ev, quiet) {
    if (!qty) return;
    if (id === 'gold') p.gold += qty;
    else {
      var s = p.inventory.filter(function (x) { return x.item === id; })[0];
      if (s) s.qty += qty; else p.inventory.push({ item: id, qty: qty });
    }
    if (!quiet) ev.push({ type: 'loot', to: p.id, map: p.map, x: p.x, y: p.y, text: '+' + qty + ' ' + itemName(c, id) });
  }
  function take(p, id, qty) {
    if (id === 'gold') { if (p.gold < qty) return false; p.gold -= qty; return true; }
    var s = p.inventory.filter(function (x) { return x.item === id; })[0];
    if (!s || s.qty < qty) return false;
    s.qty -= qty;
    if (s.qty <= 0) {
      p.inventory.splice(p.inventory.indexOf(s), 1);
      Object.keys(p.equipment).forEach(function (k) { if (p.equipment[k] === id) delete p.equipment[k]; });
    }
    return true;
  }
  function roll(c, table, rng) {
    var out = [];
    (c.loot[table] || []).forEach(function (r) { if (rng() < r.chance) out.push({ item: r.item, qty: rint(rng, r.min, r.max) }); });
    return out;
  }
  // Weighted pick: returns the index of one item by its weight, or -1 when the weights sum to <= 0.
  // `extra` is an optional extra weight for a "none" outcome that maps to index -1.
  function pickWeighted(items, weightOf, rng, extra) {
    var total = Math.max(0, Number(extra) || 0), i;
    for (i = 0; i < items.length; i++) total += Math.max(0, Number(weightOf(items[i])) || 0);
    if (total <= 0) return -1;
    var pick = rng() * total;
    pick -= Math.max(0, Number(extra) || 0);
    if (pick < 0) return -1;                               // landed on the "none" outcome
    for (i = 0; i < items.length; i++) { pick -= Math.max(0, Number(weightOf(items[i])) || 0); if (pick < 0) return i; }
    return items.length - 1;
  }
  function wOf(x) { return x.weight; }
  // A container may list several loot tables each with a weight; one is picked per open, then rolled.
  // `loot` is [{table, weight}]; falls back to the legacy single `loot_table` when there's no list.
  function pickLootTable(pr, rng) {
    var list = pr.loot;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = null; } }
    if (!Array.isArray(list) || !list.length) return pr.loot_table;
    var i = pickWeighted(list, wOf, rng);
    if (i < 0) return list[0].table;                      // all zero/blank weights: just use the first
    return list[i].table;
  }
  // Roll one Appearance set's layers into a look: for each layer, weighted-pick one option (or none,
  // by the layer's `empty` weight), plus an independent colour. Returns [{path, tint}] in draw order.
  function rollSetLayers(set, rng) {
    if (!set || !set.layers || !set.layers.length) return null;
    var look = [];
    set.layers.forEach(function (L) {
      var opts = L.options || [];
      var i = pickWeighted(opts, wOf, rng, L.empty);
      if (i < 0 || !opts[i].sprite) return;
      var tint = opts[i].tint || '';
      if (L.tints && L.tints.length) {                    // independent colour pick for the chosen sprite
        var ti = pickWeighted(L.tints, function (t) { return t.weight; }, rng);
        if (ti >= 0) tint = L.tints[ti].tint;
      }
      look.push({ path: opts[i].sprite, tint: tint });
    });
    return look.length ? look : null;
  }
  // A monster may list several Appearance sets (e.g. a male and a female variant), each with a weight;
  // one is picked per spawn, then rolled. `def.appearance` is [{set, weight}] (content.js parses it).
  function rollLook(c, def, rng) {
    var list = def && def.appearance;
    if (!Array.isArray(list) || !list.length || !c.appearances) return null;
    var i = list.length === 1 ? 0 : pickWeighted(list, wOf, rng);
    if (i < 0) i = 0;
    return rollSetLayers(c.appearances[list[i].set], rng);
  }

  // ------------------------------------------------------------ space
  // ---- wall fixtures: everything that lives ON a wall edge ----
  // A wall fixture is a placed object whose definition has properties.layer === 'wall'. It is anchored to one
  // grid-line edge by its cell + data.side: N/S = the horizontal edge on the cell's north/south line, W/E =
  // the vertical edge on its west/east line. A wide fixture spans footprintW edges east (horizontal) or
  // footprintH edges north (vertical). A fixture may be an OPENING, which replaces what its edges let through:
  //   door   (kind 'door')                 closed: no walk, no sight · open: both
  //   window (properties.opening 'window') never walk, always sight
  //   arch   (properties.opening 'arch')   always both
  // Anything else (torch, painting, switch) is a plain mount and changes nothing about the edge.
  // syncEdges folds the openings into map._edgeOv, which Rules.edgeBlocked consults — so movement, sight,
  // shots and visibility all read one answer. A fixture never blocks its own floor cell.
  function isWallFixture(o) { return !!(o && o.properties && o.properties.layer === 'wall'); }
  function openingOf(o) {
    if (!isWallFixture(o)) return '';
    if (o.kind === 'door') return 'door';
    var t = o.properties.opening;
    return t === 'window' || t === 'arch' ? t : '';
  }
  function isEdgeDoor(o) { return openingOf(o) === 'door'; }
  function mountSideOf(e) { return String((e.data && (e.data.side || e.data.facing)) || 'N').toUpperCase().charAt(0); }
  function mountEdgeOf(e) {
    var s = mountSideOf(e);
    if (s === 'S') return { orient: 'h', x: e.x, y: e.y + 1 };
    if (s === 'W') return { orient: 'v', x: e.x, y: e.y };
    if (s === 'E') return { orient: 'v', x: e.x + 1, y: e.y };
    return { orient: 'h', x: e.x, y: e.y };                              // 'N' (default: wall on the cell's north line)
  }
  /** Every edge a fixture occupies, as [{orient, x, y}]. */
  function fixtureEdges(o, e) {
    var ed = mountEdgeOf(e), out = [], k;
    if (ed.orient === 'h') { var w = Math.max(1, (o && o.footprintW) || 1); for (k = 0; k < w; k++) out.push({ orient: 'h', x: ed.x + k, y: ed.y }); }
    else { var hh = Math.max(1, (o && o.footprintH) || 1); for (k = 0; k < hh; k++) out.push({ orient: 'v', x: ed.x, y: ed.y - k }); }
    return out;
  }
  /** The opening overlay for a map: {edgeKey: {move, sight, key}} (true = blocked). stateFn(entity) -> state. */
  function buildEdgeOv(c, map, stateFn) {
    var out = {}, R = Rl();
    // A wall beaten below the breach point has holes in it: you can see and shoot through, not walk through.
    var st0 = map && map._struct;
    if (st0) {
      var bp = c.config.breach_at_pct === undefined || c.config.breach_at_pct === '' ? 0.33 : Number(c.config.breach_at_pct);
      Object.keys(st0.dmg || {}).concat(Object.keys(st0.walls || {})).forEach(function (k) {
        var ed = edgeOfKey(k); if (!ed) return;
        var g = resolveOn(c, map, st0, { t: 'wall', orient: ed.orient, x: ed.x, y: ed.y });
        if (g && g.max > 0 && g.hp > 0 && g.hp / g.max < bp && R.edgeBlocked(c, { hWalls: map.hWalls, vWalls: map.vWalls }, ed.orient, ed.x, ed.y, 'move'))
          out[k] = { move: true, sight: false, breach: true };
      });
    }
    if (map) (map.entities || []).forEach(function (e) {
      var o = objOf(c, e), kind = openingOf(o); if (!kind) return;
      var shut = kind === 'door' && stateFn(e) !== 'open';
      // A window never lets you through, and shows what is behind it only to someone standing right at it (peek).
      var rec = { move: kind === 'window' || shut, sight: shut || kind === 'window', peek: kind === 'window', key: e.key };
      fixtureEdges(o, e).forEach(function (ed) { out[R.edgeKey(ed.orient, ed.x, ed.y)] = rec; });
    });
    return out;
  }
  function syncEdges(c, ws, mapId) {
    var m = liveMap(c, ws, mapId); if (m) m._edgeOv = buildEdgeOv(c, m, function (e) { return stateOf(c, ws, mapId, e); });
  }
  /** The client's version: same overlay, built from its view (stateFn = viewLookup(...).stateOf). */
  function syncEdgesView(c, map, stateFn) { if (map) map._edgeOv = buildEdgeOv(c, map, stateFn); }
  // Is reaching from one cell to a neighbouring one (straight or diagonal) stopped by a wall or shut door?
  function moveBlockedEdge(c, map, ax, ay, bx, by) { return Rl().reachBlocked(c, map, ax, ay, bx, by, 'move'); }

  // ---- clicking a wall fixture's sprite / the hole a door leaves ----
  // A fixture renders on its wall's FACE, which rises over its span of cells as tall as the wall — not on
  // the floor tile its anchor sits in. So a click resolves to it when it lands anywhere in that face box
  // (plus the anchor floor cell), for ANY tile a multi-tile door spans.
  function wallWithHeight(map, ed) {
    var p = Rl().parseWall(Rl().wallAt(map, ed.orient, ed.x, ed.y));
    return Math.max(1, (p && p.height) || 2);
  }
  // The interactive wall fixture whose visible footprint covers clicked cell (cx,cy), or null.
  function wallMountAt(c, map, cx, cy) {
    var ents = (map && map.entities) || [];
    for (var i = 0; i < ents.length; i++) {
      var e = ents[i], o = objOf(c, e);
      if (!isWallFixture(o) || !INTERACTIVE[o.kind]) continue;
      var ed = mountEdgeOf(e), H = wallWithHeight(map, ed);
      if (ed.orient === 'h') {
        var w = Math.max(1, o.footprintW || 1);
        if (cx >= e.x && cx < e.x + w && cy >= ed.y - H && cy <= Math.max(ed.y, e.y)) return e;
      } else {
        var hh = Math.max(1, o.footprintH || 1);
        if (cy <= e.y && cy > e.y - hh && (cx === ed.x || cx === ed.x - 1 || cx === e.x)) return e;
      }
    }
    return null;
  }
  // The footprint cell (either side of the wall) nearest the player, so range + facing use it, not the click.
  function wallMountUseCell(c, map, e, p) {
    var o = objOf(c, e), best = null, bd = 1e9;
    function consider(x, y) { var d = Math.abs(p.x - x) + Math.abs(p.y - y); if (d < bd) { bd = d; best = { x: x, y: y }; } }
    fixtureEdges(o, e).forEach(function (ed) {
      if (ed.orient === 'h') { consider(ed.x, ed.y - 1); consider(ed.x, ed.y); }
      else { consider(ed.x - 1, ed.y); consider(ed.x, ed.y); }
    });
    return best || { x: e.x, y: e.y };
  }

  function walkableEntity(c, ws, mapId, e) {
    var o = objOf(c, e); if (!o) return true;
    if (o.kind === 'spawn' || o.kind === 'trigger') return true;        // invisible markers
    if (o.kind === 'door') return isEdgeDoor(o) ? true : stateOf(c, ws, mapId, e) === 'open';   // edge door sits on the wall, tile stays walkable
    return o.walkable;
  }
  function monsterAt(ms, x, y, except) {
    for (var i = 0; ms.monsters && i < ms.monsters.length; i++) {
      var m = ms.monsters[i]; if (!m.dead && m !== except && m.x === x && m.y === y) return m;
    }
    return null;
  }
  function moveOpts(c, ws, mapId, players, self) {
    var ms = mapState(ws, mapId);
    return {
      mapOf: function (id) { return liveMap(c, ws, id); },      // another floor of this building, for stairs
      walkable: function (e) { return walkableEntity(c, ws, mapId, e); },
      occupied: function (x, y) {
        var m = monsterAt(ms, x, y, self); if (m) return { monster: m };
        for (var i = 0; i < players.length; i++) {
          var q = players[i]; if (q !== self && q.map === mapId && q.x === x && q.y === y && q.hp > 0) return { player: q };
        }
        return null;
      }
    };
  }
  function free(c, ws, mapId, x, y, self) {
    var map = liveMap(c, ws, mapId);
    if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    var t = Rl().terrainAt(c, map, x, y);
    if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return false;
    if (Rl().blockersAt(c, map, x, y).some(function (e) { return !walkableEntity(c, ws, mapId, e); })) return false;
    return !monsterAt(mapState(ws, mapId), x, y, self);
  }
  function facingCell(p) { var d = Rl().DIRS[p.facing] || Rl().DIRS.S; return { x: p.x + d.dx, y: p.y + d.dy }; }

  // ------------------------------------------------------------ monsters
  function place(c, ws, mapId, m, spawn, radius, pickIndex) {
    var cells = [];
    for (var dy = -radius; dy <= radius; dy++) for (var dx = -radius; dx <= radius; dx++) {
      var x = spawn.x + dx, y = spawn.y + dy;
      if (free(c, ws, mapId, x, y, m)) cells.push({ x: x, y: y, d: Math.abs(dx) + Math.abs(dy) });
    }
    if (!cells.length) { m.x = spawn.x; m.y = spawn.y; return; }
    cells.sort(function (a, b) { return a.d - b.d || a.y - b.y || a.x - b.x; });
    var pick = cells[(pickIndex * 7) % cells.length]; m.x = pick.x; m.y = pick.y;
  }
  // Give a monster a rolled paper-doll look if its def has an Appearance set but it carries none yet —
  // e.g. it was spawned before the look feature existed, or before its appearance was authored, and is
  // being reused from saved world state. Returns true if it changed (so the caller can mark the world dirty).
  function ensureLook(c, m, rng) {
    if (!m || m.look) return false;
    var look = rollLook(c, c.monsters[m.ref], rng || Math.random);
    if (!look) return false;
    m.look = look; return true;
  }
  /**
   * Makes the map's monsters match its spawn points. Runs whenever the spawn points change
   * (edited in the editor or in Game Data): unchanged monsters stay where they are.
   */
  function ensureMonsters(c, ws, mapId, now, rng) {
    var ms = mapState(ws, mapId), map = liveMap(c, ws, mapId);
    if (!map) { ms.monsters = ms.monsters || []; return ms; }
    var want = [];
    map.entities.forEach(function (e) {
      var o = objOf(c, e); if (!o || o.kind !== 'spawn') return;
      var pr = props(c, e), def = c.monsters[pr.monster]; if (!def) return;
      for (var i = 0; i < (Number(pr.count) || 1); i++) want.push({ id: e.key + '#' + i, ref: def.id, e: e, radius: Number(pr.radius) || 0, i: i });
    });
    var sig = want.map(function (w) { return w.id + '=' + w.ref + '@' + w.e.x + ',' + w.e.y; }).join(';');
    if (ms.monsters && ms.spawnSig === sig) {                 // spawns unchanged: still heal any look-less monsters
      var healed = false;
      ms.monsters.forEach(function (m) { if (ensureLook(c, m, rng)) healed = true; });
      if (healed) ws.dirty = true;
      return ms;
    }
    var old = {};
    (ms.monsters || []).forEach(function (m) { old[m.id] = m; });
    ms.monsters = want.map(function (w) {
      var m = old[w.id];
      if (m && m.ref === w.ref) { ensureLook(c, m, rng); return m; }    // reused: keep it, but give it a look if it lacks one
      m = { id: w.id, ref: w.ref, spawn: w.e.key, x: w.e.x, y: w.e.y, hp: c.monsters[w.ref].hp, dead: false, last: now, respawnAt: 0, facing: 'S' };
      var look = rollLook(c, c.monsters[w.ref], rng || Math.random);     // random paper-doll look, fixed for this instance
      if (look) m.look = look;
      place(c, ws, mapId, m, w.e, w.radius, w.i);
      return m;
    });
    ms.spawnSig = sig;
    ws.dirty = true;
    return ms;
  }

  // ---- monsters and stairs (docs/FLOORS.md §4.2) ----
  // A monster lives in ONE floor's record, and each floor's record is written on its own. So a monster does not
  // "walk" between floors: when a player it is after takes the stairs, it is told to follow (m.follow); it walks to
  // the stairs and, on the step that would change floor, it is taken off this floor and put in ws.transfers as a
  // GUEST for the other one. Whoever runs the world delivers that (World.deliver here, or the referee into the
  // other floor's record) and the other floor takes it in on its next advance (ms.arrivals). The floor it left
  // treats it as lost: its spawner brings a new one after the usual wait. A guest that dies, or loses interest
  // for GUEST_IDLE_MS, is simply removed.
  var FOLLOW_MS = 20000, GUEST_IDLE_MS = 90000;
  function tagFollowers(c, ws, mapId, p, way, x, y, dir, now) {
    var ms = mapState(ws, mapId), map = liveMap(c, ws, mapId), goal, any = false;
    if (way === 'up') { var hit = Rl().stairAt(c, map, x, y); if (!hit) return; goal = { way: 'up', x: hit.s.x, y: hit.s.y, dir: hit.s.dir }; }
    else goal = { way: 'down', x: x, y: y, dir: dir };            // from the landing they left, the way they stepped
    (ms.monsters || []).forEach(function (m) {
      var def = c.monsters[m.ref]; if (!def || m.dead) return;
      if (m.engaged !== p.id && Math.abs(m.x - x) + Math.abs(m.y - y) > def.aggro) return;
      m.follow = { way: goal.way, x: goal.x, y: goal.y, dir: goal.dir, who: p.id, until: now + FOLLOW_MS };
      any = true;
    });
    if (any) { p.wake = { map: mapId, until: now + FOLLOW_MS }; ws.dirty = true; }   // keep that floor moving while they come
  }
  function stepsToward(m, tx, ty) {
    var dx = tx - m.x, dy = ty - m.y, dirs = [];
    if (!dx && !dy) return dirs;
    if (Math.abs(dx) >= Math.abs(dy)) { if (dx) dirs.push(dx > 0 ? 'E' : 'W'); if (dy) dirs.push(dy > 0 ? 'S' : 'N'); }
    else { dirs.push(dy > 0 ? 'S' : 'N'); if (dx) dirs.push(dx > 0 ? 'E' : 'W'); }
    if (dx && dy) dirs.unshift((dy > 0 ? 'S' : 'N') + (dx > 0 ? 'E' : 'W'));
    return dirs;
  }
  // One step of a monster heading for the stairs its target took. True when that step took it off this floor.
  function followStairs(c, ws, mapId, map, ms, m, here, now) {
    var f = m.follow, R = Rl(), d = R.DIRS[f.dir], dirs;
    if (f.way === 'up') {
      var on = R.stairAt(c, map, m.x, m.y), ax = f.x - d.dx, ay = f.y - d.dy;       // (ax,ay) = the tile before the foot
      dirs = (on && on.s.x === f.x && on.s.y === f.y) || (m.x === ax && m.y === ay) ? [f.dir] : stepsToward(m, ax, ay);
    } else dirs = m.x === f.x && m.y === f.y ? [f.dir] : stepsToward(m, f.x, f.y);
    for (var i = 0; i < dirs.length; i++) {
      var r = R.tryMove(c, map, m.x, m.y, dirs[i], moveOpts(c, ws, mapId, here, m));
      if (!r.ok) continue;
      if (r.map) { leaveFloor(c, ws, mapId, m, r, now); return true; }
      m.x = r.x; m.y = r.y; m.facing = R.faceFor(dirs[i], m.facing);
      return false;
    }
    return false;
  }
  function leaveFloor(c, ws, mapId, m, r, now) {
    var def = c.monsters[m.ref];
    var guest = { id: String(m.id).replace(/~.*$/, '') + '~' + Math.floor(now % 1e9), ref: m.ref, x: r.x, y: r.y, hp: m.hp, last: now,
      facing: m.facing, spawn: '', guest: true, engaged: m.follow ? m.follow.who : (m.engaged || null), idleUntil: now + GUEST_IDLE_MS };
    if (m.look) guest.look = m.look;
    (ws.transfers = ws.transfers || []).push({ map: r.map, monster: guest });
    if (m.guest) m.gone = true;                                    // a guest moving on: nothing of it stays behind
    else {                                                         // a resident: its spawner brings a new one, as after a kill
      var se = m.spawn && entity(c, mapId, m.spawn), rs = se ? (Number(props(c, se).respawn_after_s) || 0) : 0;
      m.dead = true; m.statuses = []; m.engaged = null; m.respawnAt = now + (rs > 0 ? rs : def.respawnS) * 1000;
    }
    delete m.follow;
    ws.dirty = true;
  }
  /** Hand over monsters that changed floor to the floors they went to — for a world held whole in memory (offline play, tests). */
  function deliver(c, ws) {
    var list = ws.transfers || [];
    ws.transfers = [];
    list.forEach(function (t) { if (!c.maps[t.map]) return; applyNotice(c, t.map, mapState(ws, t.map), t); ws.dirty = true; });
    return list.length;
  }

  /**
   * Keeps the OTHER floors of a building moving while somebody is in it, so what a player watches from a window or
   * a balcony is alive — for a world held whole in memory (offline play, a LAN host). playersOn(mapId) = who is there.
   */
  function advanceFloors(c, ws, mapId, playersOn, now, rng, ev) {
    floorsOf(c, mapId).forEach(function (f) {
      if (f.id !== mapId && c.maps[f.id]) advance(c, ws, f.id, (playersOn && playersOn(f.id)) || [], now, rng, ev);
    });
  }

  /** Moves the world on to `now`: timers, respawns, monsters wandering, chasing and attacking. */
  function advance(c, ws, mapId, players, now, rng, ev) {
    if (!c.maps[mapId]) return;
    syncEdges(c, ws, mapId);                              // refresh the opening overlay monster AI reads
    var map = liveMap(c, ws, mapId);
    var ms = ensureMonsters(c, ws, mapId, now, rng);
    if (ms.arrivals && ms.arrivals.length) {                      // monsters that came up or down the stairs since last time
      ms.arrivals.forEach(function (a) { if (!ms.monsters.some(function (q) { return q.id === a.id; })) ms.monsters.push(a); });
      ms.arrivals = []; ws.dirty = true;
    }
    Object.keys(ms.timers).forEach(function (k) {
      var t = ms.timers[k]; if (now < t.at) return;
      if (t.regrow) { var stg = structOf(ws, mapId); delete stg.gone[k]; touchStruct(stg); }   // a harvested object is back
      else setState(ws, mapId, k, t.state);
      delete ms.timers[k];
    });
    var here = players.filter(function (p) { return p.map === mapId && p.hp > 0; });
    var engageRange = Number(c.config.engage_range) || 24;       // how far a hit monster will chase before giving up
    var hDecay = Number(c.config.hunger_decay_per_min) || 0, tDecay = Number(c.config.thirst_decay_per_min) || 0;
    var starveDmg = Number(c.config.starve_damage) || 0, starveMs = Math.max(1000, (Number(c.config.starve_tick_s) || 5) * 1000);
    here.forEach(function (p) {
      var st = stats(c, p);
      if (p.lastRegen && st.mpRegen) p.mp = Math.min(st.maxMp, (Number(p.mp) || 0) + st.mpRegen * Math.max(0, now - p.lastRegen) / 1000);
      p.lastRegen = now;
      survivalTick(c, ws, p, now, hDecay, tDecay, starveDmg, starveMs, ev);
      tickStatuses(c, ws, mapId, p, false, now, rng, ev, players);
    });
    ms.monsters.forEach(function (m) { if (!m.dead && m.statuses && m.statuses.length) tickStatuses(c, ws, mapId, m, true, now, rng, ev, players); });
    here = here.filter(function (p) { return p.map === mapId && p.hp > 0; });
    here.forEach(function (p) {
      Rl().entitiesAt(map, p.x, p.y).forEach(function (e) {
        var o = objOf(c, e), pr = o && props(c, e);
        if (o && o.kind === 'trap' && isTimed(c, e, pr) && p.map === mapId) timedTrapHit(c, ws, p, e, o, pr, now, ev);
      });
    });
    ms.monsters.forEach(function (m) {
      var def = c.monsters[m.ref]; if (!def) return;
      if (m.dead) {
        if (now >= m.respawnAt) {
          var se = entity(c, mapId, m.spawn);
          if (se) place(c, ws, mapId, m, se, Number(props(c, se).radius) || 0, rint(rng, 0, 50));
          m.dead = false; m.hp = def.hp; m.last = now;
          m.look = rollLook(c, def, rng || Math.random) || undefined;   // fresh paper-doll look each respawn
          ws.dirty = true;
        }
        return;
      }
      var ms2 = monStats(c, m), stepMs = def.moveMs * ms2.slow;
      if (ms2.stunned) { m.last = now; return; }
      var steps = Math.floor((now - m.last) / stepMs);
      if (steps <= 0) return;
      m.last = steps > 2 ? now : m.last + steps * stepMs;
      steps = Math.min(steps, 2);
      for (var s = 0; s < steps; s++) {
        var target = null, best = 1e9;
        var eng = m.engaged ? here.filter(function (q) { return q.id === m.engaged; })[0] : null;   // chase whoever hit it
        if (eng) {
          var ed = Math.abs(eng.x - m.x) + Math.abs(eng.y - m.y);
          if (ed <= engageRange) { target = eng; best = ed; } else m.engaged = null;                // fled too far: give up
        }
        if (!target) here.forEach(function (q) {
          if (q.hp <= 0 || q.map !== mapId) return;
          var d = Math.abs(q.x - m.x) + Math.abs(q.y - m.y);
          if (d <= def.aggro && d < best) { best = d; target = q; }
        });
        if (target && m.guest) m.idleUntil = now + GUEST_IDLE_MS;
        if (target) {
          if (def.attackRange > 1 && best > 1 && best <= def.attackRange && now >= (m.nextShot || 0) &&
              canSee(c, map, m.x, m.y, target.x, target.y, function (e) { return stateOf(c, ws, mapId, e); })) {
            m.nextShot = now + def.rangedMs;
            m.facing = Math.abs(target.x - m.x) >= Math.abs(target.y - m.y) ? (target.x > m.x ? 'E' : 'W') : (target.y > m.y ? 'S' : 'N');
            var rdmg = damage(ms2.atk, stats(c, target).def, rng);
            target.hp -= rdmg;
            ev.push({ type: 'cast', map: mapId, skill: '_ranged', by: m.id, from: { x: m.x, y: m.y }, to: { x: target.x, y: target.y }, x: target.x, y: target.y, projectile: !!def.rangedProjectile, color: '#8fbf4f' });
            ev.push({ type: 'hit', map: mapId, x: target.x, y: target.y, amount: rdmg, to: target.id, text: 'The ' + lower(def.name) + ' spits at you for ' + rdmg + '.' });
            if (target.hp <= 0) die(c, ws, target, ev);
            else {
              if (def.rangedStatus && c.statuses && c.statuses[def.rangedStatus]) applyStatus(c, target, def.rangedStatus, Number(c.config.ranged_status_ms) || 3000, now, m.id);
              if (def.infectChance && rng() < def.infectChance) applyInfection(c, ws, mapId, target, now, ev);
            }
            break;
          }
          if (cheb(m.x, m.y, target.x, target.y) === 1 && !moveBlockedEdge(c, map, m.x, m.y, target.x, target.y)) {
            // beside its target (diagonals count) with no wall between: swing. (A wall on the edge makes it try to move around instead.)
            var dmg = damage(ms2.atk, stats(c, target).def, rng);
            target.hp -= dmg;
            m.facing = target.x > m.x ? 'E' : target.x < m.x ? 'W' : target.y > m.y ? 'S' : 'N';
            ev.push({ type: 'hit', map: mapId, x: target.x, y: target.y, amount: dmg, to: target.id, text: 'The ' + lower(def.name) + ' hits you for ' + dmg + '.' });
            if (target.hp <= 0) die(c, ws, target, ev);
            else if (def.infectChance && rng() < def.infectChance) applyInfection(c, ws, mapId, target, now, ev);
            break;
          }
          var dx = target.x - m.x, dy = target.y - m.y, dirs = [];
          if (Math.abs(dx) >= Math.abs(dy)) { dirs.push(dx > 0 ? 'E' : 'W'); if (dy) dirs.push(dy > 0 ? 'S' : 'N'); }
          else { dirs.push(dy > 0 ? 'S' : 'N'); if (dx) dirs.push(dx > 0 ? 'E' : 'W'); }
          if (dx && dy) dirs.unshift((dy > 0 ? 'S' : 'N') + (dx > 0 ? 'E' : 'W'));             // cut the corner when the rules allow it
          for (var i = 0; i < dirs.length; i++) {
            var r = Rl().tryMove(c, map, m.x, m.y, dirs[i], moveOpts(c, ws, mapId, here, m));
            if (r.ok && !r.map) {                                 // (monsters do not change floor yet: FLOORS.md stage 2b)
              m.x = r.x; m.y = r.y; m.facing = Rl().faceFor(dirs[i], m.facing);
              m.last += (Rl().stepCost(dirs[i]) - 1) * stepMs;                                   // a diagonal takes longer, as it does for players
              break;
            }
          }
        } else if (m.follow && now < m.follow.until) {
          if (followStairs(c, ws, mapId, map, ms, m, here, now)) return;      // gone to the other floor
        } else if (rng() < 0.5) {
          var dir = 'NESW'.charAt(rint(rng, 0, 3));
          var sp = entity(c, mapId, m.spawn), rad = sp ? (Number(props(c, sp).radius) || 0) + 2 : 3;
          // Away from home (it chased someone and lost them): it does not freeze there. It mills about, and half
          // its steps head back, so it drifts home.
          var away = !!sp && (Math.abs(m.x - sp.x) > rad || Math.abs(m.y - sp.y) > rad);
          if (away && rng() < 0.5) {
            var hx = sp.x - m.x, hy = sp.y - m.y;
            dir = Math.abs(hx) >= Math.abs(hy) ? (hx > 0 ? 'E' : 'W') : (hy > 0 ? 'S' : 'N');
          }
          var r2 = Rl().tryMove(c, map, m.x, m.y, dir, moveOpts(c, ws, mapId, here, m));
          if (r2.ok && !r2.map && (!sp || away || (Math.abs(r2.x - sp.x) <= rad && Math.abs(r2.y - sp.y) <= rad))) { m.x = r2.x; m.y = r2.y; m.facing = dir; }
        }
      }
    });
    // guests that moved on, died, or lost interest are simply gone (they have no spawner to return to)
    var before = ms.monsters.length;
    ms.monsters = ms.monsters.filter(function (m) { return !m.gone && !(m.guest && (m.dead || now > (m.idleUntil || 0))); });
    if (ms.monsters.length !== before) ws.dirty = true;
  }

  function respawnPoint(c, p) {
    var pos = String(p.respawn || '').split(':');
    if (pos.length === 3 && c.maps[pos[0]]) return { map: pos[0], x: Number(pos[1]), y: Number(pos[2]) };
    var sm = startMap(c), sp = sm && sm.spawn;                              // no checkpoint: fall back to the start map's spawn
    return { map: sm ? sm.id : c.config.start_map,
      x: sp ? Number(sp.x) || 0 : Number(c.config.start_x) || 0,
      y: sp ? Number(sp.y) || 0 : Number(c.config.start_y) || 0, facing: sp && sp.facing };
  }
  function die(c, ws, p, ev) {
    var lost = Math.floor(p.gold * (Number(c.config.death_gold_loss) || 0));
    p.gold -= lost;
    ev.push({ type: 'death', map: p.map, x: p.x, y: p.y, to: p.id, text: 'You were defeated' + (lost ? ' and lost ' + lost + ' gold' : '') + '.' });
    var r = respawnPoint(c, p), map = c.maps[r.map] || c.maps[Object.keys(c.maps)[0]];
    var at = Rl().nearestStandable(c, map, r.x, r.y);
    p.map = map.id; p.x = at.x; p.y = at.y; p.facing = r.facing || 'S'; p.hp = stats(c, p).maxHp;
  }
  /** Hunger and thirst drain over time; at zero they gnaw at your health. Set to 0 in Config to disable. */
  function survivalTick(c, ws, p, now, hDecay, tDecay, starveDmg, starveMs, ev) {
    // Time only passes for a player who is in the game. A playing client checks in every few seconds, so a
    // gap longer than AWAY_MS means they were logged out: that stretch costs no food or water, and the
    // starvation clock starts afresh instead of landing all its missed bites at once.
    var AWAY_MS = 120000;
    if (p.lastSurvival != null && now - p.lastSurvival > AWAY_MS) { p.lastSurvival = now; p.nextStarve = 0; }
    if (p.lastSurvival != null) {
      var secs = Math.max(0, now - p.lastSurvival) / 1000;
      if (hDecay) p.hunger = Math.max(0, (Number(p.hunger) == null || isNaN(Number(p.hunger)) ? 100 : Number(p.hunger)) - hDecay * secs / 60);
      if (tDecay) p.thirst = Math.max(0, (Number(p.thirst) == null || isNaN(Number(p.thirst)) ? 100 : Number(p.thirst)) - tDecay * secs / 60);
    }
    p.lastSurvival = now;
    var empty = (Number(p.hunger) || 0) <= 0, dry = (Number(p.thirst) || 0) <= 0;
    if (!starveDmg || !(empty || dry)) { p.nextStarve = 0; return; }
    if (!p.nextStarve) p.nextStarve = now + starveMs;
    while (p.nextStarve <= now && p.hp > 0) {
      p.nextStarve += starveMs;
      var why = empty && dry ? 'Starving and parched' : empty ? 'Starving' : 'Dehydrated';
      hurt(c, ws, p, starveDmg, why + ', you lose ', ev);
    }
  }

  function gainXp(c, p, xp, ev) {
    p.xp += xp;
    var lv = levelFor(c, p.xp);
    if (lv > p.level) {
      var before = knownSkills(c, p);
      p.level = lv; p.hp = stats(c, p).maxHp; p.mp = stats(c, p).maxMp;
      ev.push({ type: 'level', map: p.map, x: p.x, y: p.y, to: p.id, text: 'Level up! You are now level ' + lv + '.' });
      knownSkills(c, p).forEach(function (id) {
        if (before.indexOf(id) >= 0) return;
        if (skillsOn(c)) ev.push({ type: 'level', to: p.id, text: 'You learned ' + c.skills[id].name + '.' });
      });
      fillLoadout(c, p);
    }
  }
  /** A monster's attack/defence/speed with its statuses (chilled, stunned, ...). */
  function monStats(c, m) {
    var d = c.monsters[m.ref], s = { atk: d.atk, def: d.def, slow: 1, stunned: false };
    (m.statuses || []).forEach(function (st) {
      var k = c.statuses && c.statuses[st.id]; if (!k) return;
      s.atk += k.atk; s.def += k.def;
      if (k.kind === 'slow') s.slow = Math.max(s.slow, k.slow || 1);
      if (k.kind === 'stun') s.stunned = true;
    });
    s.def = Math.max(0, s.def);
    return s;
  }
  function attack(c, ws, mapId, p, m, now, rng, ev) {
    if (now < (p.nextAttack || 0)) return false;               // basic attacks have a short delay
    p.nextAttack = now + (Number(c.config.attack_ms) || 0);
    var def = c.monsters[m.ref], dmg = damage(stats(c, p).atk, monStats(c, m).def, rng);
    hitMonster(c, ws, mapId, p, m, dmg, now, rng, ev, 'You hit the ' + lower(def.name) + ' for ' + dmg + '.');
    return true;
  }
  /** Damages a monster; if it dies, p (if any) gets the XP, gold and loot. */
  function hitMonster(c, ws, mapId, p, m, dmg, now, rng, ev, text) {
    var def = c.monsters[m.ref];
    m.hp -= dmg; ws.dirty = true;
    if (p && m.hp > 0) m.engaged = p.id;                        // being hit (even from range) makes it come after you
    ev.push({ type: 'hit', map: mapId, x: m.x, y: m.y, amount: dmg, to: p ? p.id : undefined, text: p ? text : '' });
    if (m.hp > 0) return;
    m.dead = true; m.statuses = [];
    // Respawn delay: the spawn point's own respawn_after_s wins (set per spawner); 0/blank falls back
    // to the monster's respawn_s. The monster reappears that many seconds after it's killed.
    var se = m.spawn && entity(c, mapId, m.spawn);
    var rs = se ? (Number(props(c, se).respawn_after_s) || 0) : 0;
    m.respawnAt = now + (rs > 0 ? rs : def.respawnS) * 1000;
    if (!p) return;
    ev.push({ type: 'kill', map: mapId, x: m.x, y: m.y, to: p.id, text: 'The ' + lower(def.name) + ' is defeated. +' + def.xp + ' XP' });
    var gold = rint(rng, def.goldMin, def.goldMax);
    if (gold > 0) give(c, p, 'gold', gold, ev);
    roll(c, def.lootTable, rng).forEach(function (l) { give(c, p, l.item, l.qty, ev); });
    gainXp(c, p, def.xp, ev);
  }

  // ------------------------------------------------------------ statuses
  function applyStatus(c, t, id, ms, now, src) {
    var d = c.statuses && c.statuses[id]; if (!d || !ms) return;
    t.statuses = t.statuses || [];
    var cur = t.statuses.filter(function (x) { return x.id === id; })[0];
    if (cur) { cur.until = Math.max(cur.until, now + ms); cur.src = src || cur.src; }
    else t.statuses.push({ id: id, until: now + ms, next: now + (d.tickMs || 1000), src: src || '' });
  }
  function hasStatus(t, id) { return (t.statuses || []).some(function (s) { return s.id === id; }); }
  /** A bite can infect a survivor. Infection does not fade on its own and worsens over time — cure it or turn. */
  function applyInfection(c, ws, mapId, p, now, ev) {
    if (!(c.statuses && c.statuses.infection) || hasStatus(p, 'infection')) return;
    var d = c.statuses.infection;
    p.statuses = p.statuses || [];
    p.statuses.push({ id: 'infection', until: 1e15, next: now + Math.max(500, d.tickMs || 3000), stacks: 0, src: '' });
    ev.push({ type: 'info', to: p.id, text: 'You have been infected!' });
  }
  /** Damage/healing over time, then expiry. Monsters killed by a status reward whoever applied it. */
  function tickStatuses(c, ws, mapId, t, isMonster, now, rng, ev, players) {
    var keep = [];
    (t.statuses || []).forEach(function (st) {
      var d = c.statuses && c.statuses[st.id]; if (!d) return;
      if (d.kind === 'infection') {
        if (isMonster) { keep.push(st); return; }            // only survivors get infected
        var itick = Math.max(500, d.tickMs || 3000);
        while (st.next <= now && t.hp > 0) {
          st.next += itick; st.stacks = (st.stacks || 0) + 1;
          var idmg = Math.max(1, (d.amount || 1) + Math.floor((st.stacks - 1) * (Number(c.config.infection_escalate) || 0)));
          t.hp -= idmg;
          ev.push({ type: 'hit', map: mapId, x: t.x, y: t.y, amount: idmg, to: t.id, text: '' });
          if (t.hp <= 0) { die(c, ws, t, ev); return; }       // it takes them; they respawn clean
        }
        keep.push(st);                                        // never fades on its own — needs a cure
        return;
      }
      if (d.kind === 'dot' || d.kind === 'hot') {
        var tick = Math.max(100, d.tickMs || 1000);
        while (st.next <= Math.min(now, st.until) && (isMonster ? !t.dead : t.hp > 0)) {
          st.next += tick;
          if (d.kind === 'hot') {
            if (isMonster) t.hp = Math.min(c.monsters[t.ref].hp, t.hp + d.amount);
            else { var h = Math.min(d.amount, stats(c, t).maxHp - t.hp); if (h > 0) { t.hp += h; ev.push({ type: 'heal', map: mapId, x: t.x, y: t.y, amount: h, to: t.id }); } }
          } else if (isMonster) {
            var src = (players || []).filter(function (q) { return q.id === st.src && q.map === mapId; })[0];
            hitMonster(c, ws, mapId, src || null, t, d.amount, now, rng, ev, '');
          } else {
            t.hp -= d.amount;
            ev.push({ type: 'hit', map: mapId, x: t.x, y: t.y, amount: d.amount, to: t.id, text: '' });
            if (t.hp <= 0) { die(c, ws, t, ev); return; }
          }
        }
      }
      if (now < st.until && (isMonster ? !t.dead : t.hp > 0)) keep.push(st);
    });
    t.statuses = keep;
  }

  // ------------------------------------------------------------ line of sight and targeting
  /** Cells on the straight line from (x0,y0) to (x1,y1), both ends included. */
  function lineCells(x0, y0, x1, y1) {
    var out = [], dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    for (var n = 0; n < 500; n++) {
      out.push({ x: x0, y: y0 });
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
    return out;
  }
  /** Walls (terrain nobody can cross), closed doors and objects marked blocks_sight stop skills. */
  function blocksSight(c, map, x, y, stateFn) {
    var t = Rl().terrainAt(c, map, x, y);
    if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return true;
    return Rl().blockersAt(c, map, x, y).some(function (e) {
      var o = objOf(c, e); if (!o) return false;
      if (o.kind === 'door') return isEdgeDoor(o) ? false : stateFn(e) !== 'open';   // edge door blocks sight on its EDGE, not its cell
      return o.blocksSight;
    });
  }
  // A wall between two line cells blocks passage. Orthogonal step: the one shared edge. Diagonal step:
  // blocked when BOTH ways around the shared corner are obstructed — each L-detour has a wall on at least
  // one of its two edges. A lone wall (or a wall's end) still lets a diagonal slip past, but two collinear
  // segments forming a straight barrier correctly seal the diagonal that crosses them. `blk(c, token)`
  // chooses which walls count: sight for shots and sight-skills, movement for melee/physical reach.
  function edgeBlocks(c, map, a, b, what, from) {
    var R = Rl();
    function w(ax, ay, bx, by) { return R.blockedBetween(c, map, ax, ay, bx, by, what, from); }
    if (a.x === b.x || a.y === b.y) return w(a.x, a.y, b.x, b.y);
    return (w(a.x, a.y, b.x, a.y) || w(b.x, a.y, b.x, b.y)) &&
           (w(a.x, a.y, a.x, b.y) || w(a.x, b.y, b.x, b.y));
  }
  function edgeBlocksSight(c, map, a, b, from) { return edgeBlocks(c, map, a, b, 'sight', from); }
  function edgeBlocksMove(c, map, a, b) { return edgeBlocks(c, map, a, b, 'move'); }
  // Is the straight line between two cells clear? `edgeFn` picks the wall rule: sight for seeing/shooting,
  // movement for a thrown item's flight and a blast's reach (an explosion is stopped by any solid wall).
  function clearLine(c, map, x0, y0, x1, y1, stateFn, edgeFn, noPeek) {
    var cells = lineCells(x0, y0, x1, y1);
    for (var i = 1; i < cells.length - 1; i++) if (blocksSight(c, map, cells[i].x, cells[i].y, stateFn)) return false;
    var from = noPeek ? null : { x: x0, y: y0, tx: x1, ty: y1 };   // the viewer + target: a window only shows a narrow cone to someone at it
    for (var j = 0; j < cells.length - 1; j++) if (edgeFn(c, map, cells[j], cells[j + 1], from)) return false;
    return true;
  }
  function canSee(c, map, x0, y0, x1, y1, stateFn, noPeek) { return clearLine(c, map, x0, y0, x1, y1, stateFn, edgeBlocksSight, noPeek); }

  // ------------------------------------------------------------ visibility (what a player can see)
  // The set of cells visible from (px,py): every cell within `radius` with a clear sight line — the SAME
  // line-of-sight rule combat uses, so "I can see it" and "I can shoot it" never disagree. Returns
  // {"x,y": 1}. The caller must have the opening overlay current (syncEdges / syncEdgesView).
  // Cells seen ONLY by peeking through a window you stand at get the value 2 instead of 1: they are in view
  // now, but a client does not remember them (a peek does not explore the room).
  // A second pass adds cells that sit right beside a visible cell with nothing sight-blocking between them
  // and that lie no further from the viewer — it fills the one-cell notches straight sight lines leave
  // along walls, without ever leaking through one.
  function visibleCells(c, map, px, py, radius, stateFn) {
    var out = {}, r = radius > 0 ? radius : 16, x, y;
    var xa = Math.max(0, px - r), xb = Math.min(map.width - 1, px + r), ya = Math.max(0, py - r), yb = Math.min(map.height - 1, py + r);
    for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++)
      if (canSee(c, map, px, py, x, y, stateFn, true)) out[x + ',' + y] = 1;
    var add = [];
    for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++) {
      if (out[x + ',' + y]) continue;
      var d = Math.abs(x - px) + Math.abs(y - py), nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (var i = 0; i < 4; i++) {
        var nx = nb[i][0], ny = nb[i][1];
        if (!out[nx + ',' + ny] || Math.abs(nx - px) + Math.abs(ny - py) >= d) continue;
        if (blocksSight(c, map, nx, ny, stateFn) || Rl().blockedBetween(c, map, nx, ny, x, y, 'sight')) continue;
        add.push(x + ',' + y); break;
      }
    }
    add.forEach(function (k) { out[k] = 1; });
    var ov = map._edgeOv || {}, R = Rl();                     // standing at a window? add the peek cone
    var atWindow = [['h', px, py], ['h', px, py + 1], ['v', px, py], ['v', px + 1, py]].some(function (q) { var o = ov[R.edgeKey(q[0], q[1], q[2])]; return o && o.peek; });
    if (atWindow) for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++)
      if (!out[x + ',' + y] && canSee(c, map, px, py, x, y, stateFn)) out[x + ',' + y] = 2;
    return out;
  }
  // ---- seeing between floors (docs/FLOORS.md §6) ----
  function hasFloorAt(m, x, y) { return !!(m && m.terrain && m.terrain[y] && m.terrain[y][x]); }
  function roofedAt(m, x, y) { var r = m && m.roof && m.roof[y] && m.roof[y][x]; return !!r && r !== '0'; }
  /** How far a player on this map sees: Config sight_radius, plus sight_per_floor for every floor above the ground. */
  function sightRadius(c, map) {
    var base = cfgNum(c, 'sight_radius', 16), per = cfgNum(c, 'sight_per_floor', 3);
    return (base > 0 ? base : 16) + Math.max(0, (map && map.z) || 0) * Math.max(0, per);
  }
  /**
   * Is there a line of sight between someone at (ux,uy) on an UPPER floor and the cell (lx,ly) on a LOWER floor
   * of the same building? The same answer serves both ways: if the one above can see the one below, the one
   * below can see them. The eye travels on the upper floor first — its walls and solid things stop it as usual,
   * a window lets it through — until it passes over a cell with no floor (open air: past the edge of a balcony,
   * or out of a window). From there it carries on above the lower floors, stopped only by something as tall as
   * the viewer: a cell that has a floor at the viewer's height, or on a floor in between. So single-storey walls
   * below do not hide anything. Never seen: what is under the viewer's own floor, a roofed interior, or anything
   * below ground. radius (optional) limits the distance.
   */
  function seesAcross(c, upper, ux, uy, lower, lx, ly, radius, stateFn) {
    if (!upper || !lower) return false;
    var uz = upper.z || 0, lz = lower.z || 0;
    if (uz <= lz || lz < 0) return false;
    if (radius > 0 && cheb(ux, uy, lx, ly) > radius) return false;
    if (hasFloorAt(upper, lx, ly) || roofedAt(lower, lx, ly)) return false;
    var mids = [], fam = upper.floors || {}, k;
    for (k = lz + 1; k < uz; k++) if (fam[k] && c.maps[fam[k]]) mids.push(c.maps[fam[k]]);
    var sf = stateFn || function () { return ''; }, line = lineCells(ux, uy, lx, ly), out = false;
    var from = { x: ux, y: uy, tx: lx, ty: ly };                    // the one upstairs and what they look at: a window shows its cone to someone standing at it
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      if (!out) {
        if (edgeBlocksSight(c, upper, a, b, from)) return false;
        if (!hasFloorAt(upper, b.x, b.y)) out = true;
        else if (blocksSight(c, upper, b.x, b.y, sf)) return false;
      } else if (hasFloorAt(upper, b.x, b.y)) return false;         // another part of a building at the viewer's height
      if (out && mids.some(function (m) { return hasFloorAt(m, b.x, b.y); })) return false;
    }
    return out;
  }
  /** What stands on a floor, as other floors may be shown it: { monsters: [...] } in the same shape the view uses. */
  /**
   * The states of a floor's doors and of whatever hangs on its walls, where they differ from the usual one
   * ({key: state}) — what someone looking at that floor from another one needs to draw it as it really is.
   */
  function fixtureStates(c, ws, mapId) {
    var out = {}, map = liveMap(c, ws, mapId);
    if (map) map.entities.forEach(function (e) {
      var o = objOf(c, e), k = kindOf(c, e); if (!o || !k || !k.states.length || !(o.kind === 'door' || isWallFixture(o))) return;
      var st = stateOf(c, ws, mapId, e);
      if (st !== k.states[0]) out[e.key] = st;
    });
    return out;
  }
  function peek(c, ws, mapId, everyone, but, haveRev) {
    var ms = ws.maps && ws.maps[mapId];
    // what players built or broke there travels only when the asker is behind (haveRev = the revision they hold)
    var sv = ms && ms.struct, srev = sv ? sv.rev || 0 : 0;
    return { structRev: srev, struct: srev && haveRev !== srev ? publicStruct(sv) : undefined, states: fixtureStates(c, ws, mapId), players: (everyone || []).filter(function (q) { return q.map === mapId && q.hp > 0 && !(but && q.id === but.id); }).map(function (q) {
      return { id: q.id, name: q.name, 'class': q['class'], equipment: q.equipment || {}, hair: q.hair || '', hairColor: q.hairColor || '',
        x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: stats(c, q).maxHp, level: q.level };
    }), monsters: ((ms && ms.monsters) || []).filter(function (m) { return !m.dead; }).map(function (m) {
      var d = c.monsters[m.ref];
      return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing, look: m.look || undefined };
    }) };
  }
  // How a viewer perceives something standing on a cell: 'seen' (in sight), 'sensed' (not in sight, but
  // known by another sense — drawn as an outline) or 'hidden'. `sensed` is an optional {"x,y":1} set; no
  // sense fills it yet — it is the hook a future hearing sense plugs into.
  function perceive(vis, sensed, x, y) {
    var k = Math.round(x) + ',' + Math.round(y);
    return !vis || vis[k] ? 'seen' : (sensed && sensed[k] ? 'sensed' : 'hidden');
  }
  // Where a thrown item ends up when aimed at (tx,ty): it travels along the line and stops at the first
  // solid wall or blocker it cannot pass, detonating against it rather than the throw being refused.
  function throwLanding(c, map, px, py, tx, ty, stateFn) {
    var line = lineCells(px, py, tx, ty), land = { x: px, y: py };
    for (var i = 1; i < line.length; i++) {
      if (edgeBlocksMove(c, map, line[i - 1], line[i])) break;            // a wall stops it at the previous cell
      if (blocksSight(c, map, line[i].x, line[i].y, stateFn)) break;      // can't land inside a solid cell
      land = line[i];
    }
    return land;
  }
  // The cells a blast of radius `area` centred on (cx,cy) actually touches — those its force can reach
  // without crossing a wall. Used for damage splash and to draw the explosion so it stops at walls.
  function blastCells(c, map, cx, cy, area, stateFn) {
    var out = [];
    for (var y = cy - area; y <= cy + area; y++)
      for (var x = cx - area; x <= cx + area; x++)
        if (x >= 0 && y >= 0 && x < map.width && y < map.height && clearLine(c, map, cx, cy, x, y, stateFn, edgeBlocksMove))
          out.push({ x: x, y: y });
    return out;
  }
  /** What the world looks like for targeting: the server builds it from world state, the client from its view. */
  function serverLookup(c, ws, mapId, players) {
    var ms = mapState(ws, mapId);
    return {
      stateOf: function (e) { return stateOf(c, ws, mapId, e); },
      monsterAt: function (x, y) { return monsterAt(ms, x, y); },
      playerAt: function (x, y) { return players.filter(function (q) { return q.map === mapId && q.x === x && q.y === y && q.hp > 0; })[0] || null; },
      monsters: function () { return (ms.monsters || []).filter(function (m) { return !m.dead; }); },
      free: function (x, y, self) { return free(c, ws, mapId, x, y) && !players.some(function (q) { return q !== self && q.map === mapId && q.x === x && q.y === y; }); }
    };
  }
  function viewLookup(c, map, v, me) {
    function st(e) {
      if (v.states[e.key] !== undefined) return v.states[e.key];
      var pr = props(c, e), k = kindOf(c, e);
      if (k && (k.kind === 'door' || k.kind === 'container') && (pr.locked_by || yes(pr.locked))) return 'locked';
      return pr.state || (k && k.states[0]) || '';
    }
    function mon(x, y) { return v.monsters.filter(function (m) { return m.x === x && m.y === y; })[0] || null; }
    function ply(x, y) { return (me && me.x === x && me.y === y) ? me : v.players.filter(function (q) { return q.x === x && q.y === y; })[0] || null; }
    return {
      stateOf: st, monsterAt: mon, playerAt: ply, monsters: function () { return v.monsters; },
      free: function (x, y) {
        if (!Rl().standable(c, map, x, y) && !Rl().entitiesAt(map, x, y).length) return false;
        var t = Rl().terrainAt(c, map, x, y); if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return false;
        if (Rl().blockersAt(c, map, x, y).some(function (e) {
          var o = objOf(c, e); if (!o || o.kind === 'spawn' || o.kind === 'trigger') return false;
          return o.kind === 'door' ? (isEdgeDoor(o) ? false : st(e) !== 'open') : !o.walkable;
        })) return false;
        return !mon(x, y) && !ply(x, y);
      }
    };
  }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  /**
   * Monsters move while you aim (and while your click travels to the server), so an enemy
   * skill aimed one tile off snaps to the nearest monster next to that cell.
   */
  function snapTarget(sk, tx, ty, lk, caster) {
    if (sk.target !== 'enemy' || lk.monsterAt(tx, ty)) return { x: tx, y: ty };
    var best = null, bd = 1e9;
    lk.monsters().forEach(function (m) {
      if (cheb(m.x, m.y, tx, ty) > 1) return;
      var d = Math.abs(m.x - tx) + Math.abs(m.y - ty) + (caster ? cheb(m.x, m.y, caster.x, caster.y) / 100 : 0);
      if (d < bd) { bd = d; best = m; }
    });
    return best ? { x: best.x, y: best.y } : { x: tx, y: ty };
  }
  /** Can caster (at x,y) use skill sk on cell (tx,ty)? Used by the server and for the client's aiming preview. */
  function checkTarget(c, map, caster, sk, tx, ty, lk) {
    if (sk.target === 'self' || sk.target === 'around') return { ok: true };
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return { ok: false, reason: 'Out of the map.' };
    if (cheb(caster.x, caster.y, tx, ty) > sk.range) return { ok: false, reason: 'Out of range.' };
    if (sk.los && !canSee(c, map, caster.x, caster.y, tx, ty, lk.stateOf)) return { ok: false, reason: 'Something is in the way.' };
    if (sk.target === 'enemy' && !lk.monsterAt(tx, ty)) return { ok: false, reason: 'No enemy there.' };
    if (sk.target === 'ally' && !(tx === caster.x && ty === caster.y) && !lk.playerAt(tx, ty)) return { ok: false, reason: 'No ally there.' };
    if (sk.target === 'tile' && sk.dash && !lk.free(tx, ty, caster)) return { ok: false, reason: 'You cannot land there.' };
    return { ok: true };
  }
  function skillAmount(c, p, sk) {
    var v = sk.stat === 'atk' ? stats(c, p).atk : sk.stat === 'level' ? p.level : 0;
    return sk.power + sk.scale * v;
  }

  // ------------------------------------------------------------ firearms (shooting is the click action, not a skill)
  /** The equipped weapon if it is a ranged one (range > 0), else null. */
  function rangedWeapon(c, p) {
    var it = c.items[(p.equipment || {}).weapon];
    return itemCan(it, 'shoot') && (Number(it.range) || 0) > 0 ? it : null;
  }
  /**
   * Can p fire at cell (tx,ty), and which cells does the shot cross? Used by the server's `shoot`
   * and by the client (the laser line + the "too far"/"in the way" logs), so both agree.
   * cells = the ray past the shooter, capped at the weapon's range and stopped at a sight-blocker.
   */
  function shotReach(c, map, p, tx, ty, lk) {
    var w = rangedWeapon(c, p);
    if (!w) return { ok: false, reason: 'You have no ranged weapon equipped.' };
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return { ok: false, reason: 'Out of the map.' };
    if (tx === p.x && ty === p.y) return { ok: false, reason: 'Pick a target.' };
    if (cheb(p.x, p.y, tx, ty) > w.range) return { ok: false, reason: 'Too far away. Move closer with the movement keys.' };
    var line = lineCells(p.x, p.y, tx, ty).slice(1), cells = [], prev = { x: p.x, y: p.y }, stop = null;
    for (var i = 0; i < line.length; i++) {
      var cx = line[i].x, cy = line[i].y;
      if (cheb(p.x, p.y, cx, cy) > w.range) break;
      if (edgeBlocksSight(c, map, prev, line[i])) { stop = { edge: Rl().sharedEdge(prev.x, prev.y, cx, cy) }; break; }   // an edge wall stops the shot before this cell
      cells.push(line[i]);
      if (blocksSight(c, map, cx, cy, lk.stateOf)) { stop = { cell: { x: cx, y: cy } }; if (!(cx === tx && cy === ty)) break; }   // a wall stops the shot here
      prev = line[i];
    }
    var last = cells[cells.length - 1];
    if (lk.monsterAt(tx, ty) && !(last && last.x === tx && last.y === ty)) return { ok: false, reason: 'Something is in the way.' };
    // stop = what ended the bullet's flight, if a wall edge or a solid cell did (the shot damages it)
    return { ok: true, cells: cells, weapon: w, stop: stop };
  }

  function cast(c, ws, p, a, now, rng, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var sk = c.skills && c.skills[a.skill];
    if (!sk || usableSkills(c, p).indexOf(sk.id) < 0) return say('You don\'t know that skill.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (now < ((p.cooldowns || {})[sk.id] || 0)) return say(sk.name + ' is not ready yet.');
    if ((Number(p.mp) || 0) < sk.mp) return say('Not enough mana for ' + sk.name + '.');
    if (sk.ammo && count(p, sk.ammo) < sk.ammoCost) return say('Out of ' + lower(itemName(c, sk.ammo)) + '.');
    var mapId = p.map, map = liveMap(c, ws, mapId), lk = serverLookup(c, ws, mapId, players);
    var self = sk.target === 'self' || sk.target === 'around';
    var tx = self ? p.x : Math.round(Number(a.x)), ty = self ? p.y : Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a target.');
    var snap = snapTarget(sk, tx, ty, lk, p); tx = snap.x; ty = snap.y;
    var chk = checkTarget(c, map, p, sk, tx, ty, lk);
    if (!chk.ok) return say(chk.reason);
    var from = { x: p.x, y: p.y };
    if (!self && (tx !== p.x || ty !== p.y)) p.facing = Math.abs(tx - p.x) >= Math.abs(ty - p.y) ? (tx > p.x ? 'E' : 'W') : (ty > p.y ? 'S' : 'N');

    if (sk.dash) {
      if (sk.target === 'tile') { p.x = tx; p.y = ty; }
      else if (cheb(p.x, p.y, tx, ty) > 1) {
        var cells = lineCells(p.x, p.y, tx, ty), land = cells[cells.length - 2];
        if (!land || !lk.free(land.x, land.y, p)) return say('No room to get there.');
        p.x = land.x; p.y = land.y;
      }
    }

    var targets = [], mons = mapState(ws, mapId).monsters || [];
    // Area hits reach only monsters the blast centre can actually reach — a wall between shields them.
    function monstersNear(x, y, r) {
      return mons.filter(function (m) {
        return !m.dead && cheb(m.x, m.y, x, y) <= r && clearLine(c, map, x, y, m.x, m.y, lk.stateOf, edgeBlocksMove);
      });
    }
    if (sk.target === 'enemy') targets = sk.area > 0 ? monstersNear(tx, ty, sk.area) : [lk.monsterAt(tx, ty)];
    else if (sk.target === 'around') targets = monstersNear(p.x, p.y, Math.max(1, sk.area));
    else if (sk.target === 'tile') targets = sk.area > 0 ? monstersNear(tx, ty, sk.area) : [];
    else if (sk.target === 'ally') targets = [tx === p.x && ty === p.y ? p : lk.playerAt(tx, ty)];
    else if (sk.target === 'self') targets = [p];
    targets = targets.filter(Boolean);

    p.mp = (Number(p.mp) || 0) - sk.mp;
    if (sk.ammo) take(p, sk.ammo, sk.ammoCost);
    p.cooldowns = p.cooldowns || {}; p.cooldowns[sk.id] = now + sk.cooldownMs;
    ev.push({ type: 'cast', map: mapId, skill: sk.id, by: p.id, from: from, to: { x: tx, y: ty }, x: tx, y: ty });

    var amount = skillAmount(c, p, sk), isMon = sk.target === 'enemy' || sk.target === 'around' || sk.target === 'tile';
    targets.forEach(function (t) {
      if (isMon) {
        if (sk.status) applyStatus(c, t, sk.status, sk.statusMs, now, p.id);
        if (sk.effect === 'damage') {
          var dmg = Math.max(1, Math.round(amount - monStats(c, t).def) + rint(rng, -1, 1));
          hitMonster(c, ws, mapId, p, t, dmg, now, rng, ev, sk.name + ' hits the ' + lower(c.monsters[t.ref].name) + ' for ' + dmg + '.');
        }
      } else {
        if (sk.effect === 'heal') {
          var h = Math.max(0, Math.min(Math.round(amount), stats(c, t).maxHp - t.hp)); t.hp += h;
          ev.push({ type: 'heal', map: mapId, x: t.x, y: t.y, amount: h, to: t.id, text: sk.name + ': +' + h + ' HP' + (t === p ? '' : ' to ' + t.name) });
        }
        if (sk.status) {
          applyStatus(c, t, sk.status, sk.statusMs, now, p.id);
          ev.push({ type: 'info', to: t.id, text: 'You are ' + lower(c.statuses[sk.status] ? c.statuses[sk.status].name : sk.status) + '.' });
        }
      }
    });
    if (isMon && !targets.length && sk.effect === 'damage') say(sk.name + ' hits nothing.');
    if (sk.onCast) run(c, ws, p, sk.onCast, now, ev);
  }

  /** Fill the equipped gun's magazine from the reserve ammo stack; returns the rounds added. */
  function loadMag(c, p, w) {
    if (!w || !(Number(w.clip) > 0)) return 0;
    p.mags = p.mags || {};
    var loaded = p.mags[w.id] || 0, need = w.clip - loaded;
    if (need <= 0) return 0;
    var add = Math.min(need, count(p, w.ammo));
    if (add <= 0) return 0;
    take(p, w.ammo, add); p.mags[w.id] = loaded + add;
    return add;
  }
  /** Reload the equipped gun (R): pull rounds from the ammo stack into its magazine. */
  function reload(c, ws, p, a, now, ev) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var w = rangedWeapon(c, p);
    if (!w) return say('You have no gun to reload.');
    if (!(Number(w.clip) > 0)) return say('The ' + lower(w.name) + ' has no magazine.');
    if (((p.mags && p.mags[w.id]) || 0) >= w.clip) return say('The ' + lower(w.name) + ' is already loaded.');
    var add = loadMag(c, p, w);
    if (add <= 0) return say('Out of ' + lower(itemName(c, w.ammo)) + '.');
    say('You reload the ' + lower(w.name) + '. ' + p.mags[w.id] + '/' + w.clip);
    ev.push({ type: 'reload', to: p.id, map: p.map, x: p.x, y: p.y });
  }

  /** Fire the equipped ranged weapon toward (x,y): a ray that pierces `penetration` enemies with damage falloff. */
  /**
   * May p, standing on `mine` (their live map), shoot the cell (tx,ty) of another floor `theirs` of the same
   * building? Only along a clear view between the two floors (seesAcross), within the weapon's range.
   */
  function shotAcross(c, p, mine, theirs, tx, ty, stateFn) {
    var w = rangedWeapon(c, p);
    if (!w) return { ok: false, reason: 'You have no ranged weapon equipped.' };
    if (!mine || !theirs || mine.id === theirs.id || groundId(c, mine.id) !== groundId(c, theirs.id)) return { ok: false, reason: 'Pick a target.' };
    if (!inMap(theirs, tx, ty)) return { ok: false, reason: 'Out of the map.' };
    if (cheb(p.x, p.y, tx, ty) > w.range) return { ok: false, reason: 'Too far away. Move closer with the movement keys.' };
    var up = (mine.z || 0) > (theirs.z || 0);
    var clear = up ? seesAcross(c, mine, p.x, p.y, theirs, tx, ty, w.range, stateFn) : seesAcross(c, theirs, tx, ty, mine, p.x, p.y, w.range, stateFn);
    return clear ? { ok: true, weapon: w } : { ok: false, reason: 'You have no clear shot.' };
  }
  // A shot at another floor (action.map). The referee runs it on the TARGET floor's record, where the creature
  // is — so ws holds that floor, and the shooter's own floor only as authored. One creature, no piercing, and
  // nothing built is damaged.
  function shootAcross(c, ws, p, a, now, rng, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var w = rangedWeapon(c, p);
    if (!w) return say('You have no ranged weapon equipped.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (now < ((p.cooldowns || {})._shoot || 0)) return;
    var theirs = liveMap(c, ws, String(a.map)), tx = Math.round(Number(a.x)), ty = Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a target.');
    var chk = shotAcross(c, p, liveMap(c, ws, p.map), theirs, tx, ty, function (e) { return stateOf(c, ws, p.map, e); });
    if (!chk.ok) return say(chk.reason);
    var ammoId = w.ammo, cost = w.ammoCost || 1, clip = Number(w.clip) || 0;
    if (clip > 0) {
      p.mags = p.mags || {};
      if ((p.mags[w.id] || 0) < cost) return say(count(p, ammoId) >= cost ? 'Out of ammo — press R to reload.' : 'Out of ' + lower(itemName(c, ammoId)) + '.');
    } else if (ammoId && count(p, ammoId) < cost) return say('Out of ' + lower(itemName(c, ammoId)) + '.');
    faceTo(p, tx, ty);
    if (clip > 0) p.mags[w.id] = (p.mags[w.id] || 0) - cost; else if (ammoId) take(p, ammoId, cost);
    p.cooldowns = p.cooldowns || {}; p.cooldowns._shoot = now + (Number(w.fireMs) || Number(c.config.attack_ms) || 0);
    var m = monsterAt(mapState(ws, theirs.id), tx, ty);
    if (m) {
      var dmg = Math.max(1, damage(stats(c, p).atk, monStats(c, m).def, rng));
      hitMonster(c, ws, theirs.id, p, m, dmg, now, rng, ev, 'You shoot the ' + lower(c.monsters[m.ref].name) + ' for ' + dmg + '.');
      if (!m.dead) m.engaged = p.id;
    }
    ev.push({ type: 'shoot', map: theirs.id, by: p.id, from: { x: p.x, y: p.y }, to: { x: tx, y: ty }, aim: { x: tx, y: ty }, color: w.tint || '#ffd36b', fromMap: p.map });
  }
  function shoot(c, ws, p, a, now, rng, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    if (a.map && String(a.map) !== p.map) return shootAcross(c, ws, p, a, now, rng, ev, players);
    var w = rangedWeapon(c, p);
    if (!w) return say('You have no ranged weapon equipped.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    var fire = Number(w.fireMs) || Number(c.config.attack_ms) || 0;
    if (now < ((p.cooldowns || {})._shoot || 0)) return;        // still cycling: ignore quietly
    var map = liveMap(c, ws, p.map), lk = serverLookup(c, ws, p.map, players);
    var tx = Math.round(Number(a.x)), ty = Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a target.');
    var reach = shotReach(c, map, p, tx, ty, lk);
    if (!reach.ok) return say(reach.reason);
    var ammoId = w.ammo, cost = w.ammoCost || 1, ammoIt = ammoId && c.items[ammoId], clip = Number(w.clip) || 0;
    if (clip > 0) {                                             // magazine: fire from loaded rounds (reload with R)
      p.mags = p.mags || {};
      if ((p.mags[w.id] || 0) < cost) return say(count(p, ammoId) >= cost ? 'Out of ammo — press R to reload.' : 'Out of ' + lower(itemName(c, ammoId)) + '.');
    } else if (ammoId && count(p, ammoId) < cost) return say('Out of ' + lower(itemName(c, ammoId)) + '.');
    faceTo(p, tx, ty);
    if (clip > 0) p.mags[w.id] = (p.mags[w.id] || 0) - cost;
    else if (ammoId) take(p, ammoId, cost);
    p.cooldowns = p.cooldowns || {}; p.cooldowns._shoot = now + fire;
    var pen = ammoIt ? (ammoIt.penetration || 1) : 1, fall = ammoIt ? (ammoIt.falloff || 0) : 0;
    var base = stats(c, p).atk, ms = mapState(ws, p.map), hits = 0, end = { x: p.x, y: p.y };
    for (var i = 0; i < reach.cells.length; i++) {
      end = reach.cells[i];
      if (hits >= pen) break;
      var m = monsterAt(ms, end.x, end.y); if (!m) continue;
      var dmg = Math.max(1, Math.round(damage(base, monStats(c, m).def, rng) * Math.pow(1 - fall, hits)));
      hitMonster(c, ws, p.map, p, m, dmg, now, rng, ev, 'You shoot the ' + lower(c.monsters[m.ref].name) + ' for ' + dmg + '.');
      hits++;
    }
    ev.push({ type: 'shoot', map: p.map, by: p.id, from: { x: p.x, y: p.y }, to: { x: end.x, y: end.y },
      aim: { x: tx, y: ty }, color: w.tint || '#ffd36b' });
    // A bullet that was stopped by a wall, door or solid object (rather than spent on a creature) damages it.
    if (reach.stop && hits < pen) {
      var st1 = map._struct, bt = null;
      if (reach.stop.edge) bt = edgeTarget(c, map, st1, reach.stop.edge.orient, reach.stop.edge.x, reach.stop.edge.y);
      else if (reach.stop.cell) {
        var bc = Rl().blockersAt(c, map, reach.stop.cell.x, reach.stop.cell.y).filter(function (e) { var o = objOf(c, e); return o && !isWallFixture(o); })
          .map(function (e) { return resolveOn(c, map, st1, { t: 'ent', key: e.key }); }).filter(function (g) { return g && g.can; })[0];
        if (bc) bt = { t: 'ent', key: bc.key };
      }
      if (bt) damageStructure(c, ws, p.map, bt, structureDamageOf(c, p, w), { kind: 'bullet', by: p.id, player: p, now: now }, ev);
    }
  }

  /**
   * May p, standing on `mine` (their live map), throw this item DOWN onto the cell (tx,ty) of a lower floor
   * `theirs` of the same building? Only where they have a clear view of that cell from above (seesAcross: over an
   * open edge, or out of a window they stand at), within the item's throw range, and onto a cell it can lie on.
   * Never upwards.
   */
  function throwAcross(c, p, it, mine, theirs, tx, ty, stateFn) {
    if (!mine || !theirs || mine.id === theirs.id || groundId(c, mine.id) !== groundId(c, theirs.id)) return { ok: false, reason: 'Pick a spot.' };
    if ((mine.z || 0) <= (theirs.z || 0)) return { ok: false, reason: 'You can\'t throw that far up.' };
    if (!inMap(theirs, tx, ty)) return { ok: false, reason: 'Out of the map.' };
    var range = (it && it.throwRange) || 4;
    if (cheb(p.x, p.y, tx, ty) > range) return { ok: false, reason: 'Too far away. Move closer with the movement keys.' };
    if (!seesAcross(c, mine, p.x, p.y, theirs, tx, ty, range, stateFn) || blocksSight(c, theirs, tx, ty, function () { return ''; })) return { ok: false, reason: 'You have no clear throw.' };
    return { ok: true };
  }
  /** Throw a belt item (grenade/molotov) at (x,y): area damage + status, up to throw_range away. */
  function throwItem(c, ws, p, a, now, rng, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var id = String(a.item || ''), it = c.items[id];
    if (!itemCan(it, 'throw')) return say('You can\'t throw that.');
    if (count(p, id) < 1) return say('Out of ' + lower(it.name) + '.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (now < ((p.cooldowns || {})._throw || 0)) return;
    var tx = Math.round(Number(a.x)), ty = Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a spot.');
    // Down onto a lower floor of the building (action.map). The referee runs this on the TARGET floor's record, so
    // ws holds that floor and the thrower's own floor only as authored. It lands where it was aimed and goes off there.
    var far = a.map && String(a.map) !== p.map ? String(a.map) : null;
    var blastMap = far || p.map, map = liveMap(c, ws, blastMap), land;
    var stateFn = function (e) { return stateOf(c, ws, blastMap, e); };
    if (far) {
      var chk = throwAcross(c, p, it, liveMap(c, ws, p.map), map, tx, ty, function (e) { return stateOf(c, ws, p.map, e); });
      if (!chk.ok) return say(chk.reason);
      land = { x: tx, y: ty };
    } else {
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return say('Out of the map.');
      if (cheb(p.x, p.y, tx, ty) > (it.throwRange || 4)) return say('Too far away. Move closer with the movement keys.');
      // The throw always happens; if a wall is in the way the grenade stops and goes off against it.
      land = throwLanding(c, map, p.x, p.y, tx, ty, stateFn);
    }
    take(p, id, 1);
    p.cooldowns = p.cooldowns || {}; p.cooldowns._throw = now + (Number(it.fireMs) || 0);
    faceTo(p, tx, ty);
    var ms = mapState(ws, blastMap), area = Number(it.throwArea) || 0;
    // Splash from where it detonates, onto only the monsters the blast can actually reach (not through walls).
    var mons = (ms.monsters || []).filter(function (m) {
      return !m.dead && cheb(m.x, m.y, land.x, land.y) <= area && clearLine(c, map, land.x, land.y, m.x, m.y, stateFn, edgeBlocksMove);
    });
    ev.push({ type: 'throw', map: blastMap, by: p.id, item: id, from: { x: p.x, y: p.y }, to: { x: land.x, y: land.y },
      area: area, color: it.tint || '#ff8c3b', fromMap: far ? p.map : undefined });
    mons.forEach(function (m) {
      if (Number(it.throwPower) > 0) {
        var dmg = Math.max(1, Math.round(it.throwPower - monStats(c, m).def) + rint(rng, -1, 1));
        hitMonster(c, ws, blastMap, p, m, dmg, now, rng, ev, 'The ' + lower(it.name) + ' hits the ' + lower(c.monsters[m.ref].name) + ' for ' + dmg + '.');
      }
      if (it.throwStatus) applyStatus(c, m, it.throwStatus, Number(it.throwStatusMs) || 3000, now, p.id);
    });
    // The blast also batters the walls, doors and objects it reaches (worked out before anything breaks, so a
    // wall still shields what is behind it from this same blast).
    var broke = 0;
    if (Number(it.throwPower) > 0) {
      var reached = blastCells(c, map, land.x, land.y, area, stateFn), seenT = {}, targets = [], R2 = Rl();
      var addT = function (t, key) { if (!seenT[key]) { seenT[key] = 1; targets.push(t); } };
      reached.forEach(function (cell) {
        R2.blockersAt(c, map, cell.x, cell.y).forEach(function (e) { if (!isWallFixture(objOf(c, e))) addT({ t: 'ent', key: e.key }, e.key); });
        [['h', cell.x, cell.y], ['h', cell.x, cell.y + 1], ['v', cell.x, cell.y], ['v', cell.x + 1, cell.y]].forEach(function (q) {
          addT({ t: 'wall', orient: q[0], x: q[1], y: q[2] }, R2.edgeKey(q[0], q[1], q[2]));
        });
      });
      (map.entities || []).forEach(function (e) {
        var o = objOf(c, e);
        if (isWallFixture(o) && fixtureEdges(o, e).some(function (q) { return seenT[R2.edgeKey(q.orient, q.x, q.y)]; })) targets.unshift({ t: 'ent', key: e.key });
      });
      targets.forEach(function (t) {
        var r1 = damageStructure(c, ws, blastMap, t, Number(it.throwPower), { kind: 'blast', by: p.id, player: p, now: now }, ev);
        if (r1 && r1.dealt) broke++;
        if (it.burns && !(r1 && r1.destroyed)) { var r2 = damageStructure(c, ws, blastMap, t, Number(it.throwPower) / 2, { kind: 'fire', by: p.id, player: p, now: now }, ev); if (r2 && r2.dealt) broke++; }
      });
    }
    if (!mons.length && !broke) say('The ' + lower(it.name) + ' goes off, hitting nothing.');
  }

  /** Rearrange a bar. bar 'ability' = the 2 Q/E skill slots; 'belt' = the BELT_SIZE item slots. */
  function setLoadout(c, p, bar, slot, entry, ev) {
    slot = Number(slot); entry = String(entry || '');
    var ab = bar !== 'belt', arr = ab ? p.abilities : p.belt, lim = ab ? 2 : BELT_SIZE;
    if (!arr || !(slot >= 0 && slot < lim)) return;
    if (entry && ab && usableSkills(c, p).indexOf(entry) < 0) { ev.push({ type: 'info', to: p.id, text: 'You can\'t use that skill.' }); return; }
    if (entry && !ab && !c.items[entry]) { ev.push({ type: 'info', to: p.id, text: 'That can\'t go on the belt.' }); return; }
    var was = arr.indexOf(entry);
    if (entry && was >= 0) arr[was] = arr[slot];               // swap if it was already on the bar
    arr[slot] = entry;
    if (!ab && typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);   // what is in hand may have just changed
  }

  // ------------------------------------------------------------ data-driven actions
  /** "flag:met_mayor, has:iron_key, !flag:done, level:3" -> all must hold */
  function check(c, p, cond) {
    return String(cond || '').split(',').every(function (part) {
      part = part.trim(); if (!part) return true;
      var not = part.charAt(0) === '!'; if (not) part = part.slice(1);
      var a = part.split(':'), ok;
      if (a[0] === 'flag') ok = !!(p.flags || {})[a[1]];
      else if (a[0] === 'has') ok = count(p, a[1]) >= (Number(a[2]) || 1);
      else if (a[0] === 'level') ok = p.level >= Number(a[1]);
      else ok = true;
      return not ? !ok : ok;
    });
  }
  // ------------------------------------------------------------ crafting
  /** Does the player carry something that counts as this tool (an item whose tool tags include it)? */
  /** tag may list several tools ("axe, saw"): any one of them will do. */
  function toolTags(tag) { return String(tag || '').split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function hasTool(c, p, tag) {
    var tags = toolTags(tag);
    if (!tags.length) return true;
    return (p.inventory || []).some(function (s) { var it = c.items[s.item]; return it && it.tools && tags.some(function (g) { return it.tools.indexOf(g) >= 0; }); });
  }
  function toolsText(tag) { return toolTags(tag).map(aAn).join(' or '); }
  /** The crafting stations in reach: {stationId: object name}. A station is an object of kind craft with a station id. */
  function stationsNear(c, map, p, lk) {
    var out = {}, range = Number(c.config.station_range) || 2;
    (map.entities || []).forEach(function (e) {
      var o = objOf(c, e), id = o && o.kind === 'craft' && props(c, e).station;
      if (!id || cheb(p.x, p.y, e.x, e.y) > range) return;
      if (e.need && (e.prog || 0) < e.need) return;                      // still being built
      if (isBuiltEnt(map, e) && !mayUse(c, map, p, e.x, e.y)) return;    // in someone else's base
      if (!(p.x === e.x && p.y === e.y) && !canSee(c, map, p.x, p.y, e.x, e.y, lk.stateOf)) return;
      out[id] = o.name;
    });
    return out;
  }
  function stationName(c, id) {
    var k = Object.keys(c.objects).filter(function (x) { var o = c.objects[x]; return o.kind === 'craft' && o.properties && o.properties.station === id; })[0];
    return lower(k ? c.objects[k].name : id);
  }
  /** Can p make `qty` of recipe r right here? {ok, reason, missing: [{item, need, have}]} — shared by the panel and the referee. */
  function recipeCheck(c, r, p, stations, qty) {
    qty = qty || 1;
    var missing = [];
    list(r.inputs).forEach(function (g) { var have = count(p, g.item); if (have < g.qty * qty) missing.push({ item: g.item, need: g.qty * qty, have: have }); });
    var reason = '';
    if (r.station && !stations[r.station]) reason = 'Needs ' + aAn(stationName(c, r.station)) + ' nearby.';
    else if (r.tool && !hasTool(c, p, r.tool)) reason = 'Needs ' + aAn(r.tool) + '.';
    else if (missing.length) reason = 'Not enough ' + missing.map(function (m) { return lower(itemName(c, m.item)); }).join(', ') + '.';
    return { ok: !reason, reason: reason, missing: missing };
  }
  /** Every recipe this player knows, with whether it can be made here and now. For the crafting panel. */
  function recipesFor(c, map, p, lk) {
    var stations = stationsNear(c, map, p, lk), recs = c.recipes || {};
    return Object.keys(recs).map(function (id) { return recs[id]; })
      .filter(function (r) { return !r.unlock || check(c, p, r.unlock); })
      .map(function (r) {
        var chk = recipeCheck(c, r, p, stations, 1);
        return { id: r.id, name: r.name, category: r.category, station: r.station, tool: r.tool, timeS: r.timeS,
          inputs: list(r.inputs).map(function (g) { return { item: g.item, qty: g.qty, have: count(p, g.item) }; }),
          outputs: list(r.outputs), can: chk.ok, reason: chk.reason, here: !r.station || !!stations[r.station] };
      });
  }
  function craft(c, ws, p, a, now, ev) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var r = (c.recipes || {})[String(a.recipe || '')];
    if (!r || (r.unlock && !check(c, p, r.unlock))) return say('You don\'t know how to make that.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (now < ((p.cooldowns || {})._craft || 0)) return say('You are still busy.');
    var qty = Math.max(1, Math.min(20, Math.round(Number(a.qty)) || 1));
    var map = liveMap(c, ws, p.map), chk = recipeCheck(c, r, p, stationsNear(c, map, p, serverLookup(c, ws, p.map, [p])), qty);
    if (!chk.ok) return say(chk.reason);
    list(r.inputs).forEach(function (g) { take(p, g.item, g.qty * qty); });
    var made = list(r.outputs);
    made.forEach(function (g) { give(c, p, g.item, g.qty * qty, ev, true); });
    if (r.timeS > 0) { p.cooldowns = p.cooldowns || {}; p.cooldowns._craft = now + r.timeS * 1000 * qty; }
    ev.push({ type: 'loot', to: p.id, map: p.map, x: p.x, y: p.y,
      text: 'You make ' + made.map(function (g) { return g.qty * qty + ' ' + lower(itemName(c, g.item)); }).join(', ') + '.' });
  }

  /** "give:potion:2; gold:10; heal:20; flag:x; teleport:map_1:3:4; set_state:map_3.e7:open; message:Hello" */
  function run(c, ws, p, script, now, ev) {
    String(script || '').split(';').forEach(function (cmd) {
      cmd = cmd.trim(); if (!cmd) return;
      var i = cmd.indexOf(':'), verb = i < 0 ? cmd : cmd.slice(0, i), arg = i < 0 ? '' : cmd.slice(i + 1), a = arg.split(':');
      if (verb === 'give') give(c, p, a[0], Number(a[1]) || 1, ev);
      else if (verb === 'take') take(p, a[0], Number(a[1]) || 1);
      else if (verb === 'gold') { var g = Number(a[0]) || 0; if (g > 0) give(c, p, 'gold', g, ev); else p.gold = Math.max(0, p.gold + g); }
      else if (verb === 'heal') p.hp = Math.min(stats(c, p).maxHp, p.hp + (Number(a[0]) || 0));
      else if (verb === 'damage') { p.hp -= Number(a[0]) || 0; if (p.hp <= 0) die(c, ws, p, ev); }
      else if (verb === 'flag') p.flags[a[0]] = true;
      else if (verb === 'unflag') delete p.flags[a[0]];
      else if (verb === 'teleport') teleport(c, p, arg, ev);
      else if (verb === 'set_state') setState(ws, p.map, a[0], a[1] || null);
      else if (verb === 'xp') gainXp(c, p, Number(a[0]) || 0, ev);
      else if (verb === 'cure') {
        var which = a[0] || 'infection', before = (p.statuses || []).length;
        p.statuses = (p.statuses || []).filter(function (s) { return s.id !== which; });
        if (p.statuses.length < before) ev.push({ type: 'info', to: p.id, text: which === 'infection' ? 'The infection fades.' : 'You feel better.' });
      }
      else if (verb === 'message') ev.push({ type: 'info', to: p.id, text: arg });
    });
  }
  function teleport(c, p, target, ev) {
    var t = String(target || '').split(':'), map = c.maps[t[0]];
    if (!map) { ev.push({ type: 'info', to: p.id, text: 'This leads nowhere yet.' }); return false; }
    var at = Rl().nearestStandable(c, map, Number(t[1]) || 0, Number(t[2]) || 0), changed = p.map !== map.id;
    p.map = map.id; p.x = at.x; p.y = at.y;
    ev.push({ type: 'teleport', to: p.id, map: map.id, x: p.x, y: p.y, text: changed ? 'You arrive at ' + map.name + '.' : '' });
    return true;
  }

  // ------------------------------------------------------------ player actions
  // ---- roof cover (hidden interiors) ----
  // A map's roof grid ('1' = a roofed interior tile) groups into "rooms": connected roofed tiles that are
  // NOT separated by a wall. So an interior wall splits one roofed building into separate rooms, each of
  // which stays a black void until the player steps inside IT (not merely the building). roofZoneAt returns a
  // STABLE id for the room at (x,y) — its top-most, then left-most cell "x,y" — or null. Cached on the map;
  // the client and the referee compute them identically. See render.js for drawing the cover.
  function roofTile(map, x, y) { var g = map && map.roof, row = g && g[y]; return !!(row && row[x]); }
  function roofZones(map) {
    if (map._roofZones) return map._roofZones;
    var g = (map && map.roof) || [], h = g.length, seen = {}, zoneOf = {};
    function k(x, y) { return x + ',' + y; }
    for (var y = 0; y < h; y++) {
      var row = g[y] || [];
      for (var x = 0; x < row.length; x++) {
        if (!row[x] || seen[k(x, y)]) continue;
        var stack = [[x, y]], cells = [], id = k(x, y);                 // id = first (top-left-most) cell of the room
        seen[id] = true;
        while (stack.length) {
          var pt = stack.pop(), px = pt[0], py = pt[1]; cells.push(pt);
          [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]].forEach(function (n) {
            var gr = g[n[1]]; if (!gr || !gr[n[0]] || seen[k(n[0], n[1])]) return;
            if (Rl().wallBetweenCells(map, px, py, n[0], n[1])) return;  // a wall divides rooms, even with continuous roof
            seen[k(n[0], n[1])] = true; stack.push(n);
          });
        }
        cells.forEach(function (cc) { zoneOf[k(cc[0], cc[1])] = id; });
      }
    }
    map._roofZones = zoneOf;
    return zoneOf;
  }
  function roofZoneAt(map, x, y) { return roofTile(map, x, y) ? (roofZones(map)[x + ',' + y] || null) : null; }
  // Record that this player has now been inside the room they stand in (persisted per player, per map).
  function markExplored(c, p, map) {
    var z = roofZoneAt(map || c.maps[p.map], p.x, p.y); if (!z) return;
    var ex = p.explored || (p.explored = {}); (ex[p.map] || (ex[p.map] = {}))[z] = 1;
  }

  function onStep(c, ws, p, now, ev) {
    var map = liveMap(c, ws, p.map), moved = false;
    markExplored(c, p, map);                                           // stepped into a room? remember it
    Rl().entitiesAt(map, p.x, p.y).forEach(function (e) {
      if (moved) return;
      var o = objOf(c, e); if (!o) return;
      var pr = props(c, e), st = stateOf(c, ws, p.map, e);
      if (o.kind === 'trap') {
        if (isTimed(c, e, pr)) { if (timedTrapHit(c, ws, p, e, o, pr, now, ev)) moved = true; return; }
        if (stateOf(c, ws, p.map, e, now) === 'down') return;
        hurt(c, ws, p, Number(pr.damage) || 0, 'A ' + lower(o.name) + ' hits you for ', ev);
        setState(ws, p.map, e.key, 'down');
        if (Number(pr.rearm_after_s) > 0) mapState(ws, p.map).timers[e.key] = { at: now + Number(pr.rearm_after_s) * 1000, state: null };
        if (p.map !== map.id || p.x !== e.x || p.y !== e.y) moved = true;   // died and respawned elsewhere
      } else if (o.kind === 'teleport' && o.walkable && pr.target) {
        moved = teleport(c, p, pr.target, ev);
      } else if (o.kind === 'trigger' && st !== 'fired' && (!pr['if'] || check(c, p, pr['if']))) {
        var from = p.map;
        run(c, ws, p, pr['do'], now, ev);
        if (yes(pr.once)) setState(ws, from, e.key, 'fired');
        if (p.map !== from) moved = true;
      }
    });
    return moved;
  }

  function hurt(c, ws, p, dmg, text, ev) {
    p.hp -= dmg;
    ev.push({ type: 'hit', map: p.map, x: p.x, y: p.y, amount: dmg, to: p.id, text: text + dmg + '.' });
    if (p.hp <= 0) die(c, ws, p, ev);
  }
  /** A timed trap hurts whoever is on it while it is up, once per up-phase. Returns true if they died. */
  function timedTrapHit(c, ws, p, e, o, pr, now, ev) {
    var ms = mapState(ws, p.map);
    if (ms.states[e.key] !== undefined && ms.states[e.key] !== 'up') return false;  // held down by a lever
    var ph = trapPhase(pr, now), hits = ms.hits || (ms.hits = {}), k = e.key + '|' + p.id;
    if (!ph.up || hits[k] === ph.cycle) return false;
    hits[k] = ph.cycle;
    var from = p.map;
    hurt(c, ws, p, Number(pr.damage) || 0, 'The ' + lower(o.name) + ' hits you for ', ev);
    return p.map !== from || p.x !== e.x || p.y !== e.y;
  }

  function openContainer(c, ws, p, e, o, pr, now, rng, ev) {
    var st = stateOf(c, ws, p.map, e), name = lower(o.name), flag = 'opened:' + p.map + ':' + e.key;
    if (st === 'locked') {
      if (pr.locked_by && count(p, pr.locked_by) > 0) {
        setState(ws, p.map, e.key, 'closed'); st = 'closed';
        ev.push({ type: 'info', to: p.id, text: 'You unlock the ' + name + ' with the ' + lower(itemName(c, pr.locked_by)) + '.' });
      } else { lockedMessage(c, p, pr, ev); return; }
    }
    var refill = Number(pr.refill_after_s) || 0;
    if (yes(pr.per_player)) {
      var when = p.flags[flag];
      if (when && (!refill || now < when + refill * 1000)) { ev.push({ type: 'info', to: p.id, text: 'It is empty.' }); return; }
      p.flags[flag] = now;
    } else {
      if (st === 'empty' || st === 'open') { ev.push({ type: 'info', to: p.id, text: 'It is empty.' }); return; }
      setState(ws, p.map, e.key, 'empty');
      if (refill) mapState(ws, p.map).timers[e.key] = { at: now + refill * 1000, state: null };
    }
    var got = pr.contents ? list(pr.contents) : roll(c, pickLootTable(pr, rng), rng);
    ev.push({ type: 'info', to: p.id, text: 'You open the ' + name + '.' + (got.length ? '' : ' Nothing inside.') });
    got.forEach(function (g) { give(c, p, g.item, g.qty, ev); });
  }

  function useDoor(c, ws, p, e, o, pr, ev, players) {
    var st = stateOf(c, ws, p.map, e);
    if (st === 'locked') {
      if (!(pr.locked_by && count(p, pr.locked_by) > 0)) { lockedMessage(c, p, pr, ev); return; }
      setState(ws, p.map, e.key, 'closed'); st = 'closed';
      ev.push({ type: 'info', to: p.id, text: 'You unlock the ' + lower(o.name) + ' with the ' + lower(itemName(c, pr.locked_by)) + '.' });
    }
    if (pr.target) { teleport(c, p, pr.target, ev); return; }
    if (st === 'open') {
      if (!isEdgeDoor(o)) {                               // a tile door can't close on someone standing on it; an edge door sits on the wall line
        var opts = moveOpts(c, ws, p.map, players, null);
        if (opts.occupied(e.x, e.y)) { ev.push({ type: 'info', to: p.id, text: 'Something is in the way.' }); return; }
      }
      setState(ws, p.map, e.key, 'closed');
    } else setState(ws, p.map, e.key, 'open');
  }

  function lockedMessage(c, p, pr, ev) {
    ev.push({ type: 'info', to: p.id, text: 'It is locked.' + (pr.locked_by ? ' You need: ' + itemName(c, pr.locked_by) + '.' : '') +
      (count(p, 'lockpick') > 0 ? ' (Right-click to pick the lock.)' : '') });
  }
  function lockpickChance(c, p, pr) {
    var ch = (Number(c.config.lockpick_chance) || 0.5) + (classOf(c, p).lockpicking || 0) - (Number(pr.lock_difficulty) || 0);
    return Math.max(0.05, Math.min(0.95, ch));
  }
  /** Try to pick a lock: needs a lockpick; may break it. Success unlocks (then a normal click opens). */
  function pickLock(c, ws, p, e, o, pr, rng, ev) {
    if (stateOf(c, ws, p.map, e) !== 'locked') { ev.push({ type: 'info', to: p.id, text: 'It isn\'t locked.' }); return false; }
    if (count(p, 'lockpick') < 1) { ev.push({ type: 'info', to: p.id, text: 'You need a lockpick.' }); return false; }
    if (rng() < lockpickChance(c, p, pr)) {
      setState(ws, p.map, e.key, 'closed');
      ev.push({ type: 'info', to: p.id, text: 'Click. You pick the lock of the ' + lower(o.name) + '.' });
      return true;
    }
    if (rng() < (Number(c.config.lockpick_break) || 0)) { take(p, 'lockpick', 1); ev.push({ type: 'info', to: p.id, text: 'Snap! Your lockpick breaks.' }); }
    else ev.push({ type: 'info', to: p.id, text: 'The lock resists. Try again?' });
    return false;
  }

  function flipSwitch(c, ws, p, e, o, pr, ev) {
    var st = stateOf(c, ws, p.map, e), on = st !== 'on';
    if (pr.mode === 'once' && st === 'on') { ev.push({ type: 'info', to: p.id, text: 'It won\'t move any more.' }); return; }
    setState(ws, p.map, e.key, on ? 'on' : 'off');
    String(pr.targets || '').split(',').forEach(function (k) {
      var t = entity(c, p.map, k.trim()); if (!t) return;
      var to = objOf(c, t); if (!to) return;
      if (to.kind === 'door') setState(ws, p.map, t.key, on ? 'open' : 'closed');
      else if (to.kind === 'trap') setState(ws, p.map, t.key, on ? 'down' : null);
      else if (to.kind === 'container' && stateOf(c, ws, p.map, t) === 'locked') setState(ws, p.map, t.key, 'closed');
      else if (to.kind === 'teleport') setState(ws, p.map, t.key, on ? 'active' : 'inactive');
    });
    ev.push({ type: 'info', to: p.id, text: 'Click. You hear something move.' });
  }

  var INTERACTIVE = { container: 1, door: 1, teleport: 1, 'switch': 1, rest: 1, sign: 1, craft: 1, npc: 1, trap: 1, claim: 1 };

  /** Within reach: your own cell or any of the eight around it (walls in the way are a separate question: moveBlockedEdge). */
  function near(p, x, y) { return Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1; }
  function faceTo(p, x, y) {
    if (x === p.x && y === p.y) return;
    p.facing = Math.abs(x - p.x) >= Math.abs(y - p.y) ? (x > p.x ? 'E' : 'W') : (y > p.y ? 'S' : 'N');
  }
  /**
   * Use something: target = {x, y} (a clicked cell next to you, or your own cell); without a target,
   * whatever you face. verb '' = the default action; 'picklock' = try to pick its lock.
   */
  function interact(c, ws, p, now, rng, ev, players, target, verb) {
    var map = liveMap(c, ws, p.map);
    // A click on a wall object's sprite / a door's hole resolves to that entity, and uses it from the
    // nearest footprint cell — so range + facing are right, and any tile of a wide door works.
    var wm = target ? wallMountAt(c, map, target.x, target.y) : null;
    // Facing (no click): a usable fixture on the wall edge right in front of you — a door, a switch — is what
    // you use, from either side of the wall.
    if (!target) {
      var fc0 = facingCell(p), se = Rl().sharedEdge(p.x, p.y, fc0.x, fc0.y);
      if (se) wm = (map.entities || []).filter(function (en) {
        var o = objOf(c, en);
        return isWallFixture(o) && INTERACTIVE[o.kind] && fixtureEdges(o, en).some(function (q) { return q.orient === se.orient && q.x === se.x && q.y === se.y; });
      })[0] || null;
    }
    var f = wm ? wallMountUseCell(c, map, wm, p) : (target || facingCell(p));
    if ((target || wm) && !near(p, f.x, f.y)) { ev.push({ type: 'info', to: p.id, text: 'Too far away.' }); return; }
    if (target || wm) faceTo(p, f.x, f.y);
    // A wall (or closed door) on the edge between you and the faced/clicked cell blocks reaching across it —
    // you can't use or hit things through a wall. Wall-mounted objects sit ON the wall (resolved via wm), and
    // your own cell is never across an edge, so both are exempt.
    var blocked = !wm && (f.x !== p.x || f.y !== p.y) && moveBlockedEdge(c, map, p.x, p.y, f.x, f.y);
    var ms = mapState(ws, p.map), m = (wm || blocked) ? null : monsterAt(ms, f.x, f.y);
    // A creature there is never attacked by using or clicking: fighting is aiming (hold right-click) and clicking.
    if (m && verb !== 'picklock') { ev.push({ type: 'info', to: p.id, text: 'Hold right-click to aim, then click to attack.' }); return; }
    var e = wm;
    if (!e) {
      var fced = blocked ? [] : Rl().entitiesAt(map, f.x, f.y);
      var cells = target ? fced : fced.concat(Rl().entitiesAt(map, p.x, p.y));
      var ents = cells.filter(function (en) { var o = objOf(c, en); return o && INTERACTIVE[o.kind]; });
      e = ents[0];
    }
    if (!e) {
      var wt = !verb ? structAt(c, map, p, f.x, f.y, needsWork) : null;     // a frame to finish or something to repair
      if (wt) { work(c, ws, p, wt, now, ev); return; }
      ev.push({ type: 'info', to: p.id, text: blocked ? 'A wall is in the way.' : 'Nothing to use here.' }); return;
    }
    var o = objOf(c, e), pr = props(c, e);
    if (verb === 'picklock') {
      if (o.kind !== 'door' && o.kind !== 'container') { ev.push({ type: 'info', to: p.id, text: 'There is no lock.' }); return; }
      pickLock(c, ws, p, e, o, pr, rng, ev); return;
    }
    // a frame is not usable yet: using it means working on it
    if (isBuiltEnt(map, e) && e.need && (e.prog || 0) < e.need && verb !== 'picklock') { work(c, ws, p, { t: 'ent', key: e.key }, now, ev); return; }
    if (isBuiltEnt(map, e) && o.kind !== 'claim') {
      var icl = foreignClaim(c, map, p, [{ x: e.x, y: e.y }]);
      if (icl) { ev.push({ type: 'info', to: p.id, text: o.kind === 'door' ? 'It is barred. This is ' + claimOwner(icl) + '\'s base.' : 'That belongs to ' + claimOwner(icl) + '\'s base.' }); return; }
    }
    if (o.onInteract && (!pr['if'] || check(c, p, pr['if']))) run(c, ws, p, o.onInteract, now, ev);
    switch (o.kind) {
      case 'claim':
        if (!isBuiltEnt(map, e)) ev.push({ type: 'info', to: p.id, text: o.name + '.' });
        else if (e.by === p.id) claimEvent(c, p, e, ev);                   // the owner's client opens the members panel
        else ev.push({ type: 'info', to: p.id, text: 'This is ' + claimOwner(e) + '\'s base.' + (isMember(e, p) ? ' You are a member.' : '') });
        break;
      case 'container':
        if (e.inv) storageEvent(c, p, e, ev);                              // a storage container someone built
        else openContainer(c, ws, p, e, o, pr, now, rng, ev);
        break;
      case 'door': useDoor(c, ws, p, e, o, pr, ev, players); break;
      case 'teleport':
        if (stateOf(c, ws, p.map, e) === 'inactive') ev.push({ type: 'info', to: p.id, text: 'It won\'t open.' });
        else if (pr.requires && count(p, pr.requires) < 1) ev.push({ type: 'info', to: p.id, text: 'You need: ' + itemName(c, pr.requires) + '.' });
        else if (pr.target) teleport(c, p, pr.target, ev);
        else ev.push({ type: 'info', to: p.id, text: 'This leads nowhere yet.' });
        break;
      case 'switch': flipSwitch(c, ws, p, e, o, pr, ev); break;
      case 'rest':
        var cost = Number(pr.cost) || 0;
        if (cost && !take(p, 'gold', cost)) { ev.push({ type: 'info', to: p.id, text: 'Resting here costs ' + cost + ' gold.' }); break; }
        if (yes(pr.heals)) p.hp = stats(c, p).maxHp;
        if (yes(pr.sets_respawn)) p.respawn = p.map + ':' + p.x + ':' + p.y;
        ev.push({ type: 'heal', to: p.id, map: p.map, x: p.x, y: p.y, text: 'You rest.' + (yes(pr.heals) ? ' Health restored.' : '') + (yes(pr.sets_respawn) ? ' You will return here if you fall.' : '') });
        break;
      case 'sign': ev.push({ type: 'info', to: p.id, text: pr.text || o.name }); break;
      case 'craft': ev.push({ type: 'craft', to: p.id, key: e.key, station: pr.station || '' }); break;   // the client opens its crafting panel
      case 'npc': ev.push({ type: 'info', to: p.id, text: o.name + ' has nothing to say yet.' }); break;
      case 'trap': ev.push({ type: 'info', to: p.id, text: 'A trap. Better not step on it.' }); break;
    }
  }

  function useItem(c, ws, p, id, now, ev) {
    var it = c.items[id];
    if (!it || count(p, id) < 1) { ev.push({ type: 'info', to: p.id, text: 'You don\'t have that.' }); return; }
    var mx = stats(c, p).maxHp;
    if (itemCan(it, 'consume')) {
      var ready = (p.cooldowns || {})['use:' + id] || 0;
      if (now < ready) { ev.push({ type: 'info', to: p.id, text: 'You can use the ' + lower(it.name) + ' again in ' + Math.ceil((ready - now) / 1000) + ' s.' }); return; }
      var mm = stats(c, p).maxMp, hun = Number(p.hunger) || 0, thi = Number(p.thirst) || 0;
      var fullHp = !it.heal || p.hp >= mx, fullMp = !it.mp || p.mp >= mm, fullHun = !it.hunger || hun >= 100, fullThi = !it.thirst || thi >= 100;
      if (!it.onUse && fullHp && fullMp && fullHun && fullThi) {
        ev.push({ type: 'info', to: p.id, text: it.hunger && !it.heal && !it.mp ? 'You are not hungry.' :
          it.thirst && !it.heal && !it.mp && !it.hunger ? 'You are not thirsty.' :
          it.mp && !it.heal ? 'Your mana is already full.' : 'You are already at full health.' }); return;
      }
      take(p, id, 1);
      if (it.cooldownMs > 0) { p.cooldowns = p.cooldowns || {}; p.cooldowns['use:' + id] = now + it.cooldownMs; }
      if (it.heal) {
        var h = Math.min(it.heal, mx - p.hp); p.hp += h;
        ev.push({ type: 'heal', to: p.id, map: p.map, x: p.x, y: p.y, amount: h, text: 'You use the ' + lower(it.name) + '. +' + h + ' HP' });
      }
      if (it.mp) {
        var g = Math.min(it.mp, mm - p.mp); p.mp += g;
        ev.push({ type: 'mana', to: p.id, map: p.map, x: p.x, y: p.y, amount: Math.round(g), text: 'You use the ' + lower(it.name) + '. +' + Math.round(g) + ' MP' });
      }
      if (it.hunger) {
        var fe = Math.min(it.hunger, 100 - hun); if (fe > 0) { p.hunger = hun + fe; ev.push({ type: 'info', to: p.id, text: 'You eat the ' + lower(it.name) + '.' }); }
      }
      if (it.thirst) {
        var dr = Math.min(it.thirst, 100 - thi); if (dr > 0) { p.thirst = thi + dr; ev.push({ type: 'info', to: p.id, text: 'You drink the ' + lower(it.name) + '.' }); }
      }
      if (it.onUse) run(c, ws, p, it.onUse, now, ev);
    } else if (it.slot) {
      if (p.equipment[it.slot] === id) { delete p.equipment[it.slot]; if (it.slot === 'weapon') p.held = -1; ev.push({ type: 'info', to: p.id, text: 'You put away the ' + lower(it.name) + '.' }); }
      else {
        if (it.equipIf && !check(c, p, it.equipIf)) {
          var req = /level:(\d+)/.exec(it.equipIf);
          ev.push({ type: 'info', to: p.id, text: 'You cannot equip the ' + lower(it.name) + ' yet.' + (req ? ' (Requires level ' + req[1] + '.)' : '') });
          return;
        }
        if (it.slot === 'weapon') p.held = beltSlotFor(p, id);            // a weapon is worn by holding its belt slot
        p.equipment[it.slot] = id; ev.push({ type: 'info', to: p.id, text: 'You equip the ' + lower(it.name) + '.' });
        if (itemCan(it, 'shoot') && Number(it.clip) > 0 && !((p.mags && p.mags[id]) || 0)) loadMag(c, p, it);   // a freshly drawn gun loads its magazine
      }
      syncLoadout(c, p);
      p.hp = Math.min(p.hp, stats(c, p).maxHp);
    } else ev.push({ type: 'info', to: p.id, text: 'You can\'t use that.' });
  }

  /** Runs one player action. players = everyone on the map (including p). Returns events. */
  function act(c, ws, p, action, now, rng, players) {
    var ev = [];
    if (!action || !c.maps[p.map]) return ev;
    players = players || [p];
    syncEdges(c, ws, p.map);                              // refresh the opening overlay this action reads
    if (action.type === 'move') {
      // Walking speed is the referee's to enforce, not the page's. Each player has a budget of steps that refills
      // with time (one per move_ms, with some slack for uneven connections) up to move_burst; a straight step
      // costs 1, a diagonal 1.4. Steps the budget cannot pay for are dropped, so a doctored page gains nothing.
      var dirs = (action.dirs || []).slice(0, 20);
      var perStep = Math.max(20, cfgNum(c, 'move_ms', 140)) * 0.85, burst = Math.max(2, cfgNum(c, 'move_burst', 6));
      p.mvB = Math.min(burst, (p.mvB == null ? burst : Number(p.mvB) || 0) + Math.max(0, now - (Number(p.mvT) || now)) / perStep);
      p.mvT = now;
      for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i]; if (!Rl().isDir(dir)) continue;
        var cost = Rl().stepCost(dir);
        if (p.mvB < cost) break;
        p.facing = Rl().faceFor(dir, p.facing);
        var r = Rl().tryMove(c, liveMap(c, ws, p.map), p.x, p.y, dir, moveOpts(c, ws, p.map, players, p));
        if (r.ok && r.map && r.map !== p.map) {            // walked off the head (or into the well) of a staircase: now on another floor
          var leftMap = p.map, leftX = p.x, leftY = p.y;
          p.map = r.map; p.x = r.x; p.y = r.y; p.mvB -= cost; markExplored(c, p, liveMap(c, ws, p.map));
          tagFollowers(c, ws, leftMap, p, r.stairs, leftX, leftY, dir, now);
          break;                                           // the rest of this batch was aimed at the floor just left
        }
        if (r.ok) { p.x = r.x; p.y = r.y; p.mvB -= cost; if (onStep(c, ws, p, now, ev)) break; }
        // (walking into a creature does nothing: an attack is a deliberate click, never a bump)
      }
    } else if (action.type === 'interact') {
      var tgt = action.x != null && action.y != null ? { x: Math.round(Number(action.x)), y: Math.round(Number(action.y)) } : null;
      interact(c, ws, p, now, rng, ev, players, tgt, action.verb || '');
    } else if (action.type === 'attack') {
      var ax = Math.round(Number(action.x)), ay = Math.round(Number(action.y)), am = monsterAt(mapState(ws, p.map), ax, ay);
      var amap = liveMap(c, ws, p.map), wallHere = near(p, ax, ay) && moveBlockedEdge(c, amap, p.x, p.y, ax, ay);
      // No creature to hit (or a wall between you and it): a breakable wall, door or object there takes the swing.
      var sTarget = (!am || wallHere) && near(p, ax, ay) && !(ax === p.x && ay === p.y) ? strikeTarget(c, amap, p, ax, ay) : null;
      if (sTarget) { faceTo(p, ax, ay); strike(c, ws, p, sTarget, now, rng, ev); }
      else if (!am) ev.push({ type: 'info', to: p.id, text: 'Nothing to attack there.' });
      else if (!near(p, ax, ay)) ev.push({ type: 'info', to: p.id, text: 'Too far away.' });
      // A wall between you (round the corner, for a diagonal) stops a melee swing, just as it stops a step.
      else if (wallHere) ev.push({ type: 'info', to: p.id, text: 'A wall is in the way.' });
      else { faceTo(p, ax, ay); attack(c, ws, p.map, p, am, now, rng, ev); }
    }
    else if (action.type === 'use') useItem(c, ws, p, action.item, now, ev);
    else if (action.type === 'face' && Rl().DIRS[action.dir]) p.facing = action.dir;
    else if (action.type === 'cast') cast(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'shoot') shoot(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'throw') throwItem(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'reload') reload(c, ws, p, action, now, ev);
    else if (action.type === 'craft') craft(c, ws, p, action, now, ev);
    else if (action.type === 'build') build(c, ws, p, action, now, ev, players);
    else if (action.type === 'work' || action.type === 'dismantle' || action.type === 'upgrade' || action.type === 'shift' || action.type === 'turn') {
      var stT = cleanTarget(action.target);
      if (!stT) ev.push({ type: 'info', to: p.id, text: 'Pick something.' });
      else if (action.type === 'work') work(c, ws, p, stT, now, ev);
      else if (stT.t === 'tile' || stT.t === 'roof') { if (action.type === 'dismantle') (stT.t === 'roof' ? liftRoof : liftTile)(c, ws, p, stT, now, ev, players); else ev.push({ type: 'info', to: p.id, text: 'Pick something.' }); }
      else if (action.type === 'dismantle') dismantle(c, ws, p, stT, now, ev, players);
      else if (action.type === 'shift') shiftWall(c, ws, p, stT, action.off, now, ev);
      else if (action.type === 'turn') turnObj(c, ws, p, stT, action.facing, now, ev);
      else upgrade(c, ws, p, stT, action.bp, now, ev);
    }
    else if (action.type === 'store') storeAct(c, ws, p, action, now, ev);
    else if (action.type === 'claim') claimAct(c, ws, p, action, now, ev, players);
    else if (action.type === 'loadout') setLoadout(c, p, action.bar, action.slot, action.entry, ev);
    else if (action.type === 'hold') holdSlot(c, p, action.slot, ev);
    return ev;
  }

  /**
   * Everything a player could do with a cell, default first: [{verb, label, type}].
   * type 'attack' | 'interact' | 'walk'. Built from what the client sees (lk = viewLookup).
   */
  function actionsAt(c, map, lk, p, x, y) {
    var out = [], m = lk.monsterAt(x, y);
    if (m) {
      return out;                                           // nothing a plain click does to a creature: attacks are aimed (right-click held), then clicked
    }
    var ents = Rl().entitiesAt(map, x, y).filter(function (e) { var o = objOf(c, e); return o && INTERACTIVE[o.kind]; });
    var e = ents[0], at = null;
    if (!e) { var wm = wallMountAt(c, map, x, y); if (wm) { e = wm; at = wallMountUseCell(c, map, wm, p); } }   // clicked a wall object's sprite / a door's hole
    if (e && !(isBuiltEnt(map, e) && e.need && (e.prog || 0) < e.need)) {     // (a frame only offers "Work on", below)
      var o = objOf(c, e), pr = props(c, e), st = lk.stateOf(e), name = lower(o.name), has = function (id) { return count(p, id) > 0; };
      var locked = st === 'locked' && (o.kind === 'door' || o.kind === 'container');
      if (locked) {
        if (pr.locked_by && has(pr.locked_by)) out.push({ type: 'interact', verb: '', label: 'Unlock the ' + name + ' (' + itemName(c, pr.locked_by) + ')' });
        else out.push({ type: 'interact', verb: '', label: 'Locked' + (pr.locked_by ? ': needs ' + itemName(c, pr.locked_by) : '') });
        if (has('lockpick')) out.push({ type: 'interact', verb: 'picklock', label: 'Pick the lock (' + Math.round(100 * lockpickChance(c, p, pr)) + '%)' });
      } else if (o.kind === 'container') out.push({ type: 'interact', verb: '', label: (st === 'empty' || st === 'open' ? 'Search the ' : 'Open the ') + name });
      else if (o.kind === 'door') out.push({ type: 'interact', verb: '', label: pr.target ? 'Go through the ' + name : (st === 'open' ? 'Close the ' : 'Open the ') + name });
      else {
        var verbs = { teleport: 'Enter', 'switch': 'Pull', rest: 'Rest at', sign: 'Read', craft: 'Use', npc: 'Talk to', trap: 'Look at', claim: 'Look at' };
        out.push({ type: 'interact', verb: '', label: (verbs[o.kind] || 'Use') + ' the ' + name });
      }
      if (at) out.forEach(function (a) { a.at = at; });          // act from the footprint cell, not the clicked face/hole
    }
    // A breakable wall, door or object right next to you can be attacked (listed after any way to use it).
    if (near(p, x, y) && !(x === p.x && y === p.y)) {
      var stg = strikeTarget(c, map, p, x, y), sinfo = stg && structInfo(c, map, stg);
      // (own = something you built or may take apart: hitting it is never what a quick click means — the client skips it)
      if (sinfo && !protectedOn(c, map, sinfo, p)) out.push({ type: 'attack', verb: '', label: 'Attack the ' + sinfo.name, own: !!sinfo.built && mayDismantle(c, map, p, sinfo) });
    }
    // Something built or damaged right there: finish / repair it, or take your own work apart.
    if (near(p, x, y)) {
      var bt2 = structAt(c, map, p, x, y, function (g) { return g.built || needsWork(g); }), bi = bt2 && structInfo(c, map, bt2);
      if (bi) {
        if (needsWork(bi)) out.push({ type: 'work', verb: '', target: bt2, label: (bi.rec && (bi.rec.prog || 0) < (bi.rec.need || 0) ? 'Work on the ' : 'Repair the ') + bi.name });
        if (mayDismantle(c, map, p, bi)) {
          if (bi.t === 'wall' && bi.orient === 'v' && bi.built) {             // a N-S wall can be slid off its line, out of an object's way
            var cur = wallOff(bi.rec.tok);
            [['l', 'Move the ' + bi.name + ' left'], ['', 'Move the ' + bi.name + ' to the middle'], ['r', 'Move the ' + bi.name + ' right']].forEach(function (m) {
              if (m[0] !== cur) out.push({ type: 'shift', verb: '', target: bt2, off: m[0], label: m[1] });
            });
          }
          if (bi.t === 'ent' && bi.built && !isWallFixture(bi.obj) && Rl().turnable(bi.obj)) out.push({ type: 'turn', verb: '', target: bt2, label: 'Turn the ' + bi.name });
          out.push({ type: 'dismantle', verb: '', target: bt2, label: 'Take the ' + bi.name + ' apart' });
        }
      }
    }
    // A piece of floor you (or your base) laid, right beside you: it can be taken up again.
    if (near(p, x, y) && !(x === p.x && y === p.y) && tileMine(c, map, p, x, y) && !out.length)
      out.push({ type: 'dismantle', verb: '', target: { t: 'tile', x: x, y: y }, label: 'Take up the floor' });
    return out;                                                 // movement is keyboard-only: no "walk here"
  }

  // ------------------------------------------------------------ what a player sees
  function view(c, ws, mapId, p, players, structRev, everyone, floorRevs) {   // floorRevs = {floorId: structure revision the client holds}   // everyone = all players in the world, for the other floors' people
    var ms = mapState(ws, mapId), states = {}, map = liveMap(c, ws, mapId), now = Date.now();
    Object.keys(ms.states).forEach(function (k) { states[k] = ms.states[k]; });
    if (map) map.entities.forEach(function (e) {
      var o = objOf(c, e), k = kindOf(c, e); if (!o || !k || !k.states.length) return;
      if (o.kind === 'container') {                          // containers this player already emptied
        var pr = props(c, e), when = p.flags['opened:' + mapId + ':' + e.key], refill = Number(pr.refill_after_s) || 0;
        if (yes(pr.per_player) && when && (!refill || now < when + refill * 1000)) { states[e.key] = 'empty'; return; }
      }
      if (isTimed(c, e)) return;                            // clients compute these from the clock
      var s = stateOf(c, ws, mapId, e);
      if (s !== k.states[0]) states[e.key] = s; else delete states[e.key];
    });
    // The structure layer travels with the view only when this client is behind (it sends the revision it has).
    var sv = ms.struct, srev = sv ? sv.rev || 0 : 0;
    // The other floors of this building, when this world holds their state (offline play, a LAN host). The live
    // referee holds one floor at a time: there the client listens to each floor's own pushed view instead.
    var others;
    floorsOf(c, mapId).forEach(function (f) { if (f.id !== mapId && ws.maps && ws.maps[f.id]) (others = others || {})[f.id] = peek(c, ws, f.id, everyone, p, floorRevs ? floorRevs[f.id] : undefined); });
    return {
      map: mapId, states: states, now: now, floors: others,
      structRev: srev, struct: srev && structRev !== srev ? publicStruct(sv) : undefined,
      monsters: (ms.monsters || []).filter(function (m) { return !m.dead; }).map(function (m) {
        var d = c.monsters[m.ref];
        return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing,
          statuses: (m.statuses || []).map(function (st) { return st.id; }),
          look: m.look || undefined };     // random paper-doll layers [{path, tint}], when the monster has an Appearance set
      }),
      players: (players || []).filter(function (q) { return q.id !== p.id && q.map === mapId; }).map(function (q) {
        // class + equipment + hair let other clients draw this player's paper-doll (base body, hair, worn gear)
        return { id: q.id, name: q.name, 'class': q['class'], equipment: q.equipment || {},
          hair: q.hair || '', hairColor: q.hairColor || '', x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: stats(c, q).maxHp, level: q.level };
      })
    };
  }

  /** Move-check options for the client's prediction, from a view (no world state on the client). */
  function viewOpts(c, map, v, selfId) {
    return {
      mapOf: function (id) { return c.maps[id]; },             // another floor, as authored (the client has no live copy of it)
      walkable: function (e) {
        var o = c.objects[e.ref]; if (!o) return true;
        if (o.kind === 'spawn' || o.kind === 'trigger') return true;
        if (o.kind === 'door') return isEdgeDoor(o) ? true : v.states[e.key] === 'open';
        return o.walkable;
      },
      occupied: function (x, y) {
        for (var i = 0; i < v.monsters.length; i++) if (v.monsters[i].x === x && v.monsters[i].y === y) return { monster: v.monsters[i] };
        for (var j = 0; j < v.players.length; j++) if (v.players[j].x === x && v.players[j].y === y && v.players[j].id !== selfId) return { player: v.players[j] };
        return null;
      }
    };
  }

  // ------------------------------------------------------------ event log
  function record(ws, events) {
    ws.seq = ws.seq || 0; ws.log = ws.log || [];
    events.forEach(function (e) { ws.seq++; e.seq = ws.seq; e.t = Date.now(); ws.log.push(e); });
    if (ws.log.length > 150) ws.log = ws.log.slice(-150);
  }
  function eventsFor(ws, since, p) {
    if (since == null || since < 0) return [];
    return (ws.log || []).filter(function (e) {
      return e.seq > since && (e.to ? e.to === p.id : e.map === p.map);
    });
  }

  function publicPlayer(c, p) {
    var s = stats(c, p);
    return { id: p.id, name: p.name, 'class': p['class'], map: p.map, x: p.x, y: p.y, facing: p.facing,
      hair: p.hair || '', hairColor: p.hairColor || '',
      hp: p.hp, maxHp: s.maxHp, mp: Math.floor(Number(p.mp) || 0), maxMp: s.maxMp, atk: s.atk, def: s.def, level: p.level, xp: p.xp,
      hunger: Math.round(Number(p.hunger) == null || isNaN(Number(p.hunger)) ? 100 : Number(p.hunger)),
      thirst: Math.round(Number(p.thirst) == null || isNaN(Number(p.thirst)) ? 100 : Number(p.thirst)),
      skills: usableSkills(c, p), abilities: p.abilities, belt: p.belt, held: p.held, mags: p.mags || {}, cooldowns: p.cooldowns || {},
      statuses: (p.statuses || []).map(function (st) { return { id: st.id, until: st.until }; }),
      xpNext: xpFor(c, p.level + 1), xpThis: xpFor(c, p.level) || 0, gold: p.gold,
      // rooms this player has entered (per map) — the client needs it so `roof_reveal: permanent` keeps
      // explored rooms revealed across reloads, not just within one session's live accumulation.
      explored: p.explored || {}, claims: p.claims || [],
      inventory: p.inventory, equipment: p.equipment, respawn: p.respawn };
  }

  return { list: list, props: props, stats: stats, newPlayer: newPlayer, normalize: normalize, advance: advance,
    act: act, view: view, viewOpts: viewOpts, record: record, eventsFor: eventsFor, publicPlayer: publicPlayer,
    stateOf: stateOf, mapState: mapState, check: check, run: run, give: give, count: count,
    liveState: liveState, trapPhase: trapPhase, knownSkills: knownSkills, checkTarget: checkTarget,
    viewLookup: viewLookup, canSee: canSee, snapTarget: snapTarget, actionsAt: actionsAt, lineCells: lineCells, applyStatus: applyStatus,
    rangedWeapon: rangedWeapon, shotReach: shotReach, throwLanding: throwLanding, blastCells: blastCells, pickLootTable: pickLootTable, rollLook: rollLook,
    syncEdges: syncEdges, syncEdgesView: syncEdgesView, isEdgeDoor: isEdgeDoor, isWallFixture: isWallFixture, openingOf: openingOf,
    mountEdgeOf: mountEdgeOf, fixtureEdges: fixtureEdges, wallMountAt: wallMountAt, wallMountUseCell: wallMountUseCell,
    visibleCells: visibleCells, perceive: perceive,
    roofZoneAt: roofZoneAt, roofZones: roofZones, covered: covered, asRoof: asRoof, roofSteps: roofSteps, roofSpan: roofSpan, roofSupport: roofSupport,
    liveMap: liveMap, liveMapFromStruct: liveMapFromStruct, structOf: structOf, publicStruct: publicStruct,
    structInfo: structInfo, strikeTarget: strikeTarget, damageStructure: damageStructure,
    recipesFor: recipesFor, hasTool: hasTool,
    canBuild: canBuild, blueprintsFor: blueprintsFor, noBuild: noBuild, buildSpot: buildSpot,
    claimsOn: claimsOn, claimAt: claimAt, mayUse: mayUse, isMember: isMember, mayDismantle: mayDismantle, canRemove: canRemove, itemCan: itemCan, beltItems: beltItems, BELT_SIZE: BELT_SIZE, skillsOn: skillsOn, holdSlot: holdSlot,
    groundId: groundId, floorId: floorId, floorsOf: floorsOf, deliver: deliver,
    sightRadius: sightRadius, seesAcross: seesAcross, peek: peek, advanceFloors: advanceFloors, fixtureStates: fixtureStates,
    applyNotice: applyNotice, shotAcross: shotAcross, throwAcross: throwAcross, tileMine: tileMine };
})();
if (typeof module !== 'undefined') module.exports = World;
