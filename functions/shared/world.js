// GENERATED from shared/world.js by tools/sync_server.sh. Edit the original, not this copy.
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
  var NO_HP_KINDS = { spawn: 1, trigger: 1, teleport: 1, npc: 1, sign: 1, pickup: 1 };
  // damage multiplier by what hits (row) and what it is made of (column)
  var MULT = {
    melee:   { wood: 1,   metal: 0.25, stone: 0.25, glass: 2 },
    bullet:  { wood: 0.5, metal: 0.1,  stone: 0.1,  glass: 3 },
    blast:   { wood: 2,   metal: 1,    stone: 1,    glass: 4 },
    fire:    { wood: 1,   metal: 0,    stone: 0,    glass: 0 },
    monster: { wood: 1,   metal: 0.5,  stone: 0.5,  glass: 2 }
  };
  /** What a thing yields when worked: said on the thing itself (a carcass carries its animal's loot), else its object's harvest. */
  function harvestOf(tg) {
    var own = tg && tg.rec && tg.rec.data && tg.rec.data.harvest;
    return own || (tg && tg.obj && tg.obj.properties && tg.obj.properties.harvest) || '';
  }
  // Two yields for one thing: a tree asks for an axe (harvest_tool) and gives wood (harvest) as it is cut down, but
  // with properties.harvest_bare set it can also be PICKED without the tool (a few branches and fibres). Picking does
  // not hurt it and never runs out: the list comes out once every harvest_bare_hits blows (4), a share per blow.
  // The count of blows is the player's own (p.pickN), so nothing is kept per tree.
  // The tool counts only IN HAND. No harvest_bare = as before: no tool, no harvest.
  /** Does p hold a tool this object's harvest asks for (none asked = yes)? */
  function harvestTooled(c, p, obj) {
    var need = toolTags(obj && obj.properties && obj.properties.harvest_tool);
    if (!need.length) return true;
    var it = p && heldItem(c, p), tags = (it && it.tools) || [];
    return need.some(function (g) { return tags.indexOf(g) >= 0; });
  }
  /** A blow without the tool at something that can be picked by hand: hands over the next share, takes no health. */
  function pickBare(c, p, tg, ev) {
    var pr = tg.obj.properties, hits = Math.max(1, Math.round(Number(pr.harvest_bare_hits) || 4));
    var n = (Number(p.pickN) || 0) % hits + 1, got = 0;                        // 1..hits, round and round
    p.pickN = n;
    list(pr.harvest_bare).forEach(function (g) {
      var was = Math.floor(g.qty * (n - 1) / hits), is = Math.floor(g.qty * n / hits);
      if (is > was) { give(c, p, g.item, is - was, ev); got++; }
    });
    if (!got) ev.push({ type: 'info', to: p.id, text: 'You pull at the ' + lower(tg.name) + '.' });
  }
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

  // ---- the loot bag: what a player puts down, and what a smashed container held. One of the world's own containers
  // (wild, like a carcass): things come out of it, it is gone once emptied or after Config loot_bag_rot_s.
  function bagObject(c) { return c.objects[c.config.loot_bag_object] || c.objects._bag || null; }
  /** Puts stacks ([{item, qty}]) in the loot bag at (x, y), making one if none lies there. Returns its key ('' = no bag object). */
  function leaveBag(c, ws, mapId, x, y, stacks, now) {
    var o = bagObject(c); if (!o) return '';
    var st = structOf(ws, mapId), bag = st.ents.filter(function (b) { return b.wild && b.ref === o.id && b.x === x && b.y === y && Array.isArray(b.inv); })[0];
    if (!bag) {
      bag = { key: mapId + '.b' + (++st.n), x: x, y: y, ref: o.id, data: {}, hp: 0, max: 0, bp: '', by: null, built: now, prog: 0, need: 0, wild: true, inv: [] };
      st.ents.push(bag);
    }
    (stacks || []).forEach(function (g) { if (g && c.items[g.item] && g.qty > 0) addStacks(c, bag.inv, g.item, g.qty, 0, g); });
    mapState(ws, mapId).timers[bag.key] = { at: now + Math.max(10, cfgNum(c, 'loot_bag_rot_s', 900)) * 1000, rot: true };
    touchStruct(st); ws.dirty = true;
    return bag.key;
  }
  /** What a container holds, as plain [{item, qty}] (whatever shape it was kept in). */
  function plainStacks(inv) {
    if (Array.isArray(inv)) return inv.filter(function (g) { return g && g.qty > 0; }).map(function (g) { return g.dur != null ? { item: g.item, qty: g.qty, dur: g.dur } : { item: g.item, qty: g.qty }; });
    return Object.keys(inv || {}).map(function (id) { return { item: id, qty: Number(inv[id]) || 0 }; }).filter(function (g) { return g.qty > 0; });
  }

  /** A wall or object is destroyed: it leaves the map (and takes the fixtures hanging on it along). */
  function destroyStructure(c, ws, mapId, tg, src, ev) {
    var st = structOf(ws, mapId), ms = mapState(ws, mapId), map = liveMap(c, ws, mapId), spill = [];
    function dropEnt(key) {
      var i = -1; st.ents.forEach(function (b, n) { if (b.key === key) i = n; });
      if (i >= 0) {
        var lost = st.ents.splice(i, 1)[0];
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
        // a container's contents are never just deleted: they stay behind in a loot bag where it stood
        if (lost.inv && !lost.wild) spill.push({ x: lost.x, y: lost.y, inv: plainStacks(lost.inv) });
      } else {
        st.gone[key] = 1;
        if (ms.boxes && ms.boxes[key]) {                      // a container of the map itself (a chest from the editor)
          var ae = (map.entities || []).filter(function (en) { return en.key === key; })[0];
          if (ae) spill.push({ x: ae.x, y: ae.y, inv: plainStacks(ms.boxes[key]) });
          delete ms.boxes[key];
        }
      }
      delete st.dmg[key]; delete ms.states[key]; delete ms.timers[key]; if (ms.picks) delete ms.picks[key];
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
      // A door or a window broken out of its wall takes that stretch of wall with it: what is left is a hole to
      // walk through, not a blank wall (which is what the fixture was standing in).
      if (tg.obj && tg.e && openingOf(tg.obj)) fixtureEdges(tg.obj, tg.e).forEach(function (q) {
        var wk = Rl().edgeKey(q.orient, q.x, q.y);
        if (st.walls[wk]) delete st.walls[wk]; else if (Rl().wallAt(map, q.orient, q.x, q.y)) st.gone[wk] = 1;
        delete st.dmg[wk];
      });
      dropEnt(tg.key);
      var hv = !tg.built && tg.obj && tg.obj.properties && tg.obj.properties.harvest;
      if (hv) {                                              // a tree, a wreck...: it has yielded as it was worked (damageStructure); it comes back later
        var back = Number(tg.obj.properties.respawn_s) || Number(c.config.harvest_respawn_s) || 600;
        st.gone[tg.key] = 2;
        ms.timers[tg.key] = { at: ((src && src.now) || Date.now()) + back * 1000, regrow: true };
      }
    }
    spill.forEach(function (sp) { if (sp.inv.length) leaveBag(c, ws, mapId, sp.x, sp.y, sp.inv, (src && src.now) || Date.now()); });
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
    var hitEv = { type: 'hit', map: mapId, x: tg.x, y: tg.y, amount: dealt, struct: tg.key, hp: Math.max(0, left), max: tg.max };
    if (src.kind === 'melee' && src.player) hitEv.by = src.player.id;   // the others show this number from the player's `act` (noteAct)
    ev.push(hitEv);
    // A tree, a wreck…: what it yields comes out as it is worked, in step with the damage done (a third of the way
    // through = a third of each item, rounded down; the last blow hands over the rest). Nothing is kept on the side:
    // the share already handed out is worked out from its health, so only the difference is given.
    var hvy = src.player && (!tg.built || (tg.rec && tg.rec.wild)) && harvestOf(tg);   // (wild = a carcass: put there by the world, not built)
    if (hvy && tg.max > 0) list(hvy).forEach(function (g) {
      var was = Math.floor(g.qty * Math.max(0, tg.max - tg.hp) / tg.max), is = Math.floor(g.qty * Math.min(tg.max, tg.max - Math.max(0, left)) / tg.max);
      if (is > was) give(c, src.player, g.item, is - was, ev);
    });
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
    var fp = Rl().footprintOf(tg.obj, tg.e || tg.rec), out = [];              // every tile it takes, as it faces
    for (var ax = tg.x; ax < tg.x + fp.w; ax++) for (var ay = tg.y; ay > tg.y - fp.h; ay--) out.push({ x: ax, y: ay });
    return out;
  }
  /**
   * Is this structure out of bounds for player p to DAMAGE? Only inside a claim p does not belong to (and only
   * while pvp_structures is off — turning it on allows raids). Trees and other harvestables stay open to all.
   */
  function protectedOn(c, map, tg, p) {
    if (yes(c.config.pvp_structures)) return false;
    if (tg.by && tg.by === p.id) return false;
    if ((!tg.built || (tg.rec && tg.rec.wild)) && harvestOf(tg)) return false;
    return !!foreignClaim(c, map, p, structCells(tg));
  }
  function protectedFrom(c, ws, mapId, tg, p) { return protectedOn(c, liveMap(c, ws, mapId), tg, p); }
  /** May p take this built thing apart? Shared by the action menu and the referee. */
  function mayDismantle(c, map, p, tg) {
    if (!tg || !tg.built || (tg.rec && tg.rec.wild)) return false;                // (a carcass, an egg: nobody built those)
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
  function buildSpot(c, map, bp, x, y, side, facing) {
    if (bp.places === 'wall') { var ed = sideEdge(x, y, side); return { kind: 'wall', edges: [ed], cells: edgeCells(ed) }; }
    if (bp.places === 'tile' || bp.places === 'roof') return c.terrain[bp.terrain] ? { kind: bp.places, edges: [], cells: [{ x: x, y: y }] } : null;
    var o = c.objects[bp.object]; if (!o) return null;
    if (isWallFixture(o)) {
      var eds = fixtureEdges(o, { x: x, y: y, data: { side: String(side || 'N').toUpperCase() === 'W' ? 'W' : 'N' } }), cells = [];
      eds.forEach(function (q) { edgeCells(q).forEach(function (cl) { cells.push(cl); }); });
      return { kind: 'fixture', edges: eds, cells: cells, obj: o };
    }
    var fc = [], fp = Rl().footprintOf(o, facing);                    // turned on its side, it takes other tiles
    for (var ax = x; ax < x + fp.w; ax++) for (var ay = y; ay > y - fp.h; ay--) fc.push({ x: ax, y: ay });
    return { kind: 'floor', edges: [], cells: fc, obj: o };
  }
  /** Has this player unlocked building at all? Config build_if is an `if` list ("quest:first_steps", "flag:can_build",
   *  "level:2"); empty = everyone can from the start. Config build_locked_text = what a player who cannot is told. */
  function buildUnlocked(c, p) { return !c.config.build_if || check(c, p, c.config.build_if); }
  function buildLockedText(c) { return String(c.config.build_locked_text || '') || 'You don\'t know how to build yet.'; }
  /**
   * May p build blueprint bp at cell (x,y) (side N|W for walls and wall-mounted things)? {ok, reason}.
   * map = the live map; lk = serverLookup / viewLookup. The ghost preview and the referee both ask this.
   */
  function canBuild(c, map, lk, p, bp, x, y, side, facing) {
    function no(t) { return { ok: false, reason: t }; }
    if (!(bp && bp.placed)) {                                 // (an item put down from the hand is not construction: no build lock)
      if (String(c.config.build || 'on') === 'off') return no('Building is turned off.');
      if (!buildUnlocked(c, p)) return no(buildLockedText(c));
    }
    if (!bp || (bp.unlock && !check(c, p, bp.unlock))) return no(bp ? 'You can\'t put that down.' : 'You don\'t know how to build that.');
    if (!map || isNaN(x) || isNaN(y)) return no('Pick a spot.');
    var spot = buildSpot(c, map, bp, x, y, side, facing);
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
    if (cells.some(function (cl) { return noBuild(map, cl.x, cl.y); })) return no(bp.placed ? 'You can\'t put that down here.' : 'You can\'t build here.');
    // Nothing stands on ground nobody can walk on (water, lava, rock — the overlay's terrain if one is painted there,
    // else the base's): no object, no floor. A wall may run along its edge, but not with such ground on both sides.
    // (A roof is another storey's floor, so it may span it.)
    var unwalk = function (cx, cy) {
      var gt = inMap(map, cx, cy) ? Rl().terrainAt(c, map, cx, cy) : null;
      return gt && !(gt.pass.n || gt.pass.e || gt.pass.s || gt.pass.w) ? gt : null;
    };
    var wet = null;
    if (spot.kind === 'floor' || spot.kind === 'tile') cells.some(function (cl) { return !!(wet = unwalk(cl.x, cl.y)); });
    else if (spot.kind === 'wall' && spot.edges && spot.edges[0]) {
      var we = spot.edges[0], w1 = unwalk(we.x, we.y), w2 = we.orient === 'h' ? unwalk(we.x, we.y - 1) : unwalk(we.x - 1, we.y);
      if (w1 && w2) wet = w1;
    }
    if (wet) return no('You can\'t build on ' + lower(wet.name) + '.');
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
    if (tg.rec.item) return say('Pick it up and put it down again.');
    if (!besideTarget(c, map, p, tg)) return say('Too far away.');
    if (!mayDismantle(c, map, p, tg)) return say('That is not yours to turn.');
    var f = facing ? Rl().facingOf(String(facing)) : Rl().nextFacing(tg.rec, 1);
    // turned, it may take other tiles (a bedroll lying sideways): those must be inside the map and hold nothing else
    var was = Rl().footprintOf(tg.obj, tg.rec), will = Rl().footprintOf(tg.obj, f), tx, ty;
    for (tx = tg.x; tx < tg.x + will.w; tx++) for (ty = tg.y; ty > tg.y - will.h; ty--) {
      if (tx < tg.x + was.w && ty > tg.y - was.h) continue;
      if (!inMap(map, tx, ty) || Rl().blockersAt(c, map, tx, ty).length) return say('There is no room to turn it.');
    }
    tg.rec.data = tg.rec.data || {};
    if (f === 'S') delete tg.rec.data.facing; else tg.rec.data.facing = f;
    var st = structOf(ws, p.map); touchStruct(st); ws.dirty = true;
    say('You turn the ' + tg.name + '.');
  }
  // ---- items that are put down (a bedroll): an item whose type has the `place` tick and that names an object in
  // `places`. In hand, it goes down where the player points — through the SAME check as a build (canBuild: reach,
  // free tiles, claims, the footprint as it faces), minus the build lock, cost = the item itself, at once (no frame).
  // What stands there is a built object like any other (its record keeps `item`), except that taking it apart is
  // PICKING IT UP: the item comes back whole (dismantle).
  /** The blueprint an item is put down with, or null when it cannot be. */
  function placeBp(c, it) {
    if (typeof it === 'string') it = c.items[it];
    if (!it || !itemCan(it, 'place') || !c.objects[it.places] || isWallFixture(c.objects[it.places])) return null;
    return { id: '', name: c.objects[it.places].name || it.name, places: 'object', object: it.places, cost: it.id + ':1', work: 0, tool: '', station: '', unlock: '', placed: it.id };
  }
  /** May p put the item down at (x, y)? {ok, reason, spot} — the ghost and the referee both ask. */
  function canPlace(c, map, lk, p, itemId, x, y, facing) {
    var bp = placeBp(c, itemId);
    if (!bp) return { ok: false, reason: 'That can\'t be put down.' };
    return canBuild(c, map, lk, p, bp, x, y, undefined, facing);
  }
  function placeItem(c, ws, p, a, now, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var it = c.items[String(a.item || '')], bp = placeBp(c, it), x = Math.round(Number(a.x)), y = Math.round(Number(a.y));
    if (!bp) return say('That can\'t be put down.');
    if (count(p, it.id) < 1) return say('You have no ' + lower(it.name) + '.');
    var map = liveMap(c, ws, p.map), chk = canBuild(c, map, serverLookup(c, ws, p.map, players || [p]), p, bp, x, y, undefined, a.facing);
    if (!chk.ok) return say(chk.reason);
    take(p, it.id, 1);
    var o = chk.spot.obj, max = Number((o.properties || {}).hp) || 0, st = structOf(ws, p.map), f = a.facing && Rl().turnable(o) ? Rl().facingOf(String(a.facing)) : 'S';
    var rec = { key: p.map + '.b' + (++st.n), x: x, y: y, ref: o.id, data: f !== 'S' ? { facing: f } : {}, hp: max, max: max, bp: '', item: it.id, by: p.id, built: now, prog: 0, need: 0 };
    if (o.kind === 'container') rec.inv = [];
    var home = o.kind === 'rest' && yes(props(c, rec).sets_respawn);            // a bedroll: where you come back to, from the moment it lies there
    if (home) { rec.rs = p.map + ':' + (o.walkable ? x + ':' + y : p.x + ':' + p.y); p.respawn = rec.rs; }
    st.ents.push(rec);
    if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);   // the last one has left the hand
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'place', x: x, y: y, by: p.id });
    say('You put down the ' + lower(o.name) + '.' + (home ? ' You will return here if you fall.' : ''));
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
      if (o.kind === 'container') rec.inv = [];                // whatever is built to hold things starts empty (never with loot)
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
    if (!(need > 0)) questCount(c, p, 'build', bp.id, now, ev);
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
  function needsWork(tg) { return !!tg && !(tg.rec && tg.rec.wild) && ((tg.rec && (tg.rec.prog || 0) < (tg.rec.need || 0)) || (tg.max > 0 && tg.hp < tg.max)); }   // (a half-worked carcass is not something to repair)
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
      if (rec.prog >= rec.need && rec.bp) questCount(c, p, 'build', rec.bp, now, ev);   // whoever finishes it built it
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
  /**
   * May player p move something they built — and, with x and y given, may it go THERE? Answers {ok, reason, info, bp}.
   * The one question behind the move tool (its outline and its ghost) and the referee. Only free-standing objects:
   * a wall, a door or window, stairs and a claim flag are taken apart and built again. It keeps what it is (its
   * key, its health, what is inside it); the new spot must pass everything a fresh build there would, except the
   * cost and the tool. bp = the blueprint to draw the ghost with.
   */
  function canMove(c, map, lk, p, t, x, y, facing) {
    function no(why, info, bp) { return { ok: false, reason: why, info: info || null, bp: bp || null }; }
    var st = (map && map._struct) || NO_STRUCT, tg = map && t ? resolveOn(c, map, st, t) : null;
    if (!tg || !tg.built || tg.t !== 'ent' || (tg.rec && tg.rec.wild)) return no('Only something that was built can be moved.');
    if (isWallFixture(tg.obj) || tg.obj.kind === 'stairs' || tg.obj.kind === 'claim') return no('That can\'t be moved: take it apart and build it again.', tg);
    if (tg.rec.item) return no('Pick it up and put it down again.', tg);
    if (cheb(p.x, p.y, tg.x, tg.y) > cfgNum(c, 'build_reach', 2)) return no('Too far away.', tg);
    if (!mayDismantle(c, map, p, tg)) return no('That is not yours to move.', tg);
    var bp = Object.assign({ id: '', name: tg.name }, (c.blueprints || {})[tg.rec.bp] || {}, { places: 'object', object: tg.rec.ref, cost: '', tool: '', station: '', unlock: '' });
    if (x === undefined || x === null) return { ok: true, info: tg, bp: bp };
    x = Math.round(Number(x)); y = Math.round(Number(y));
    if (x === tg.x && y === tg.y) return no('It is already there.', tg, bp);
    // the map as it would be with the thing lifted off it
    var rest = function (e) { return e.key !== tg.key; };
    var m2 = Object.assign(Object.create(map), { entities: (map.entities || []).filter(rest), _struct: Object.assign({}, st, { ents: st.ents.filter(rest) }) });
    var own = buildSpot(c, map, bp, tg.x, tg.y, undefined, tg.rec), mine = own ? own.cells : [{ x: tg.x, y: tg.y }];
    var lk2 = Object.assign({}, lk, { free: function (fx, fy, who) {
      if (lk.free(fx, fy, who)) return true;
      return mine.some(function (cl) { return cl.x === fx && cl.y === fy; }) && !lk.monsterAt(fx, fy) && !lk.playerAt(fx, fy) && !(p.x === fx && p.y === fy);
    } });
    var chk = canBuild(c, m2, lk2, p, bp, x, y, undefined, facing || Rl().facingOf(tg.rec));   // it keeps the way it faces
    chk.info = tg; chk.bp = bp;
    return chk;
  }
  /** Move something you built to another spot (action {type:'relocate', target, x, y, facing}). Free. */
  function relocate(c, ws, p, a, now, ev, players) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), chk = canMove(c, map, serverLookup(c, ws, p.map, players || [p]), p, a.target, Number(a.x), Number(a.y), a.facing);
    if (!chk.ok) return say(chk.reason || 'That can\'t be moved there.');
    var st = structOf(ws, p.map), rec = null;
    st.ents.forEach(function (b) { if (b.key === chk.info.key) rec = b; });
    if (!rec) return say('Pick something.');
    rec.x = Math.round(Number(a.x)); rec.y = Math.round(Number(a.y));
    if (a.facing && Rl().turnable(chk.info.obj)) {
      var f = Rl().facingOf(String(a.facing)); rec.data = rec.data || {};
      if (f === 'S') delete rec.data.facing; else rec.data.facing = f;
    }
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'place', x: rec.x, y: rec.y, by: p.id });
    say('You move the ' + chk.info.name + '.');
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
    var back = tg.t === 'ent' && tg.rec.item && c.items[tg.rec.item] ? tg.rec.item : '';      // an item that was put down: it is picked up, whole
    if (back) {
      give(c, p, back, 1, ev);
      // nobody returns to a bed that is no longer there: whoever is here and had it as their place to come back to loses it
      (players || [p]).concat([p]).forEach(function (q) {
        var rp = String(q.respawn || '').split(':');
        if (tg.rec.rs ? q.respawn === tg.rec.rs : rp.length === 3 && rp[0] === p.map && structCells(tg).some(function (cl) { return cheb(Number(rp[1]), Number(rp[2]), cl.x, cl.y) <= 1; })) q.respawn = '';
      });
    } else list(bp ? bp.cost : '').forEach(function (g) { var q = Math.floor(g.qty * share * ratio); if (q > 0) give(c, p, g.item, q, ev); });
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'struct', map: p.map, op: 'remove', key: tg.key, x: tg.x, y: tg.y, by: p.id });
    say(back ? 'You pick up the ' + tg.name + '.' : 'You take the ' + tg.name + ' apart.');
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
  /** What a container holds, as stacks (one made before stacks had cells held {item: qty}: turned into stacks here). */
  // A carcass (e.wild) may hold stacks marked `own` = a player id: that player's own roll of the loot (killShare).
  // Asked with a player, the answer is what THAT player finds there — the unmarked stacks and their own — as a list
  // of the same stack objects (taking from one takes from the carcass; emptiedWild clears the used-up ones away).
  function boxInv(c, e, p) {
    if (!Array.isArray(e.inv)) { var old = e.inv || {}; e.inv = []; Object.keys(old).forEach(function (id) { addStacks(c, e.inv, id, Number(old[id]) || 0, 0); }); }
    if (p && e.wild && e.inv.some(function (st) { return st.own; })) return e.inv.filter(function (st) { return !st.own || st.own === p.id; });
    return e.inv;
  }
  // How many cells: the object's `storage`, else its `capacity` (the container kind's own setting), else MAP_BOX_SLOTS.
  function boxSlots(c, e) {
    if (e._slots) return e._slots;
    var o = objOf(c, e), pr = (o && o.properties) || {};
    return Number(pr.storage) || Number(props(c, e).capacity) || MAP_BOX_SLOTS;
  }
  // A container placed in the map editor (a chest, a cupboard…) holds things too: its stacks live in the map's own
  // state, ms.boxes[key], from the first time someone opens it (openContainer, which also rolls its loot INTO it).
  // This hands it out in the shape of a built one — {key, x, y, ref, inv} — so the same code moves things in and out.
  // Cells: its `storage` or `capacity` setting, else MAP_BOX_SLOTS. One marked per_player holds something different
  // for everyone: each player's own stacks for it are kept on the player (p.boxes['<map>:<key>']), loot included.
  var MAP_BOX_SLOTS = 16;
  function mapBox(c, ws, mapId, key, make, p) {
    var map = liveMap(c, ws, mapId), ent = map && (map.entities || []).filter(function (en) { return en.key === key; })[0], o = ent && objOf(c, ent);
    if (!o || o.kind !== 'container' || isBuiltEnt(map, ent)) return null;
    var pr = props(c, ent), own = yes(pr.per_player), hold, hk = own ? mapId + ':' + key : key;
    if (own) { if (!p) return null; hold = p.boxes = (p.boxes && typeof p.boxes === 'object' && !Array.isArray(p.boxes)) ? p.boxes : {}; }
    else { var ms = mapState(ws, mapId); hold = ms.boxes = ms.boxes || {}; }
    if (!Array.isArray(hold[hk])) { if (!make) return null; hold[hk] = []; }
    return { key: key, x: ent.x, y: ent.y, ref: ent.ref, inv: hold[hk], _slots: Number(pr.storage) || Number(pr.capacity) || MAP_BOX_SLOTS, _ent: ent };
  }
  function storageEvent(c, p, e, ev) {
    var o = objOf(c, e), out = { type: 'storage', to: p.id, key: e.key, name: o.name, slots: boxSlots(c, e), inv: boxInv(c, e, p) };
    if (e.wild) out.takeOnly = true;                          // a carcass: things come out of it, nothing goes in
    if (e._cook) {                                           // a cooker: how the fire stands, for the page to show and count on from
      // cells = how many raw / fuel / done cells (one after another in `inv`); rid = the recipe it was told to make and
      // left = how many batches of it are still to come; fuel = ms all the fuel in it will last; recipes = what this
      // player can make here (ids).
      var k = e._cook, r = cookJob(c, k), fuel = Math.max(0, k.burn || 0);
      zoneStacks(k, 1).forEach(function (st) { fuel += ((c.items[st.item] || {}).fuelS || 0) * 1000 * st.qty; });
      out.cook = { lit: !!k.lit, burn: Math.max(0, Math.round(k.burn || 0)), prog: Math.round(k.prog || 0), need: r ? Math.max(1, (r.timeS || COOK_S) * 1000) : 0,
        cells: k.lay.slice(), rid: r ? r.id : '', left: r ? k.job.n : 0, fuel: Math.round(fuel), station: e._station,
        recipes: cookRecs(c, e._station).filter(function (x) { return !x.unlock || check(c, p, x.unlock); }).map(function (x) { return x.id; }) };
    }
    ev.push(out);
  }
  // ------------------------------------------------------------ cookers (a campfire, a furnace)
  // A crafting station whose object says `cooks` does its recipes over time instead of at once. It holds three runs
  // of cells, one after another in one list: what goes in (raw), the fuel, what comes out. How many of each: the
  // object's raw_slots / fuel_slots / out_slots (COOK_CELLS each when not said); rec.lay remembers the three numbers
  // its stacks are laid out by. Lit, it burns one piece of fuel after another (an item's fuel_s = how long a piece
  // lasts). It cooks ONLY what it was told to: rec.job = {id, n} = so many batches of one of ITS recipes (station = the
  // cooker's station id; its inputs, its outputs, its time_s per batch), set by the 'load' op (the Cook button). What
  // merely lies in the raw cells is never cooked by itself — it may be an ingredient of something else. cookPick says
  // whether the job can go on now (everything it takes is in the raw cells, and there is room for what it gives).
  // It goes out when the fuel does. Its state lives in the map's own record, ms.cookers[key] = {inv, lay, lit, burn (ms
  // of the piece now burning), prog (ms on the batch being made), job, at, st: station}; time is counted
  // when someone is on the map or opens it, and all the time between is made up then — so a fire left alone keeps cooking.
  // The object's state for its picture (sprite_states): 'burning', 'fueled' (fuel in it, not burning) or 'empty'.
  var COOK_S = 5, COOK_CELLS = 20;
  function cookerOf(c, e) {
    var o = objOf(c, e); if (!o || o.kind !== 'craft') return null;
    var pr = props(c, e);
    function n(v) { v = Math.round(Number(v)); return v > 0 ? Math.min(60, v) : COOK_CELLS; }
    return yes(pr.cooks) ? { station: pr.station || o.id, cells: [n(pr.raw_slots), n(pr.fuel_slots), n(pr.out_slots)] } : null;
  }
  /** A cooker's recipes (kept on the content object: asked on every turn of a lit fire). */
  function cookRecs(c, station) {
    var by = c._cookRecs;
    if (!by) {
      by = {}; var recs = c.recipes || {};
      Object.keys(recs).forEach(function (id) { var r = recs[id]; if (r.station && list(r.inputs).length && list(r.outputs).length) (by[r.station] = by[r.station] || []).push(r); });
      try { Object.defineProperty(c, '_cookRecs', { value: by, enumerable: false, configurable: true, writable: true }); } catch (x) { c._cookRecs = by; }
    }
    return by[station] || [];
  }
  /** A recipe of this cooker that takes the item (so: may it go in the raw cells). */
  function cookRecipe(c, station, itemId) {
    return cookRecs(c, station).filter(function (r) { return list(r.inputs).some(function (g) { return g.item === itemId; }); })[0] || null;
  }
  // The three runs of cells: z = 0 raw, 1 fuel, 2 done.
  function cookZone(rec, z) { var L = rec.lay, lo = z > 0 ? L[0] + (z > 1 ? L[1] : 0) : 0; return { lo: lo, hi: lo + L[z] }; }
  function zoneOfCell(rec, s) { for (var z = 0; z < 3; z++) { var b = cookZone(rec, z); if (s >= b.lo && s < b.hi) return z; } return -1; }
  function zoneStacks(rec, z) {
    var b = cookZone(rec, z);
    return rec.inv.filter(function (st) { return st.s >= b.lo && st.s < b.hi; }).sort(function (x, y) { return x.s - y.s; });
  }
  /** addStacks, inside cells lo..hi-1 only. Returns how many did not fit. */
  function zoneAdd(c, inv, id, qty, lo, hi) {
    var max = stackMaxOf(c, id), used = {};
    inv.slice().sort(function (x, y) { return x.s - y.s; }).forEach(function (st) {
      if (!(st.s >= lo && st.s < hi)) return;
      used[st.s] = 1;
      if (qty > 0 && st.item === id && st.qty < max) { var n = Math.min(qty, max - st.qty); st.qty += n; qty -= n; }
    });
    for (var s = lo; s < hi && qty > 0; s++) if (!used[s]) { var m = Math.min(qty, max); inv.push({ item: id, qty: m, s: s }); qty -= m; }
    return qty;
  }
  function zoneTake(rec, z, id, qty) {
    zoneStacks(rec, z).forEach(function (st) {
      if (qty <= 0 || st.item !== id) return;
      var n = Math.min(qty, st.qty); st.qty -= n; qty -= n;
      if (st.qty <= 0) rec.inv.splice(rec.inv.indexOf(st), 1);
    });
  }
  /** The recipe it was told to make (with batches still to come), or null. */
  function cookJob(c, rec) {
    var job = rec.job; if (!job || !(job.n > 0)) return null;
    return cookRecs(c, rec.st).filter(function (r) { return r.id === job.id; })[0] || null;
  }
  /** What the fire makes now: its job, while everything that takes is in the raw cells and what it gives has room. */
  function cookPick(c, rec) {
    var r = cookJob(c, rec); if (!r) return null;
    var have = {}, ob = cookZone(rec, 2);
    zoneStacks(rec, 0).forEach(function (st) { have[st.item] = (have[st.item] || 0) + st.qty; });
    if (!list(r.inputs).every(function (g) { return (have[g.item] || 0) >= g.qty; })) return null;
    var copy = zoneStacks(rec, 2).map(function (st) { return { item: st.item, qty: st.qty, s: st.s }; });
    return list(r.outputs).every(function (g) { return zoneAdd(c, copy, g.item, g.qty, ob.lo, ob.hi) === 0; }) ? r : null;
  }
  function cookBox(c, ws, mapId, e, ck) {
    var ms = mapState(ws, mapId); ms.cookers = ms.cookers || {};
    var rec = ms.cookers[e.key] || (ms.cookers[e.key] = { inv: [], lay: ck.cells.slice(), lit: false, burn: 0, prog: 0, at: 0, st: ck.station });
    rec.st = ck.station;
    var old = rec.lay || [1, 1, 1];                            // (one saved before it had runs of cells: in, fuel, out)
    if (old.join() !== ck.cells.join()) {                      // the object's cell counts changed: every stack moves to its own run
      rec.lay = old;
      var moved = rec.inv.map(function (st) { return { item: st.item, qty: st.qty, z: zoneOfCell(rec, st.s) }; });
      rec.inv.length = 0; rec.lay = ck.cells.slice();
      moved.forEach(function (st) { if (st.z >= 0) { var b = cookZone(rec, st.z); zoneAdd(c, rec.inv, st.item, st.qty, b.lo, b.hi); } });
    }
    return { key: e.key, x: e.x, y: e.y, ref: e.ref, inv: rec.inv, _slots: rec.lay[0] + rec.lay[1] + rec.lay[2], _cook: rec, _station: ck.station };
  }
  /** The job's inputs are no longer all in the raw cells (someone took one out): the job fails and stops (owner, 26 Nov
   *  2026). Only for what goes IN: a job waiting for room in the cooked cells goes on once there is room. */
  function cookLost(c, rec) {
    var r = cookJob(c, rec); if (!r) return false;
    var have = {};
    zoneStacks(rec, 0).forEach(function (st) { have[st.item] = (have[st.item] || 0) + st.qty; });
    if (list(r.inputs).every(function (g) { return (have[g.item] || 0) >= g.qty; })) return false;
    delete rec.job; rec.prog = 0;
    return true;
  }
  function cookTick(c, ws, mapId, key, now) {
    var ms = mapState(ws, mapId), rec = ms.cookers && ms.cookers[key]; if (!rec) return;
    rec.lay = rec.lay || [1, 1, 1];
    cookLost(c, rec);
    var dt = rec.lit ? Math.max(0, now - (rec.at || now)) : 0, guard = 0, ob = cookZone(rec, 2);
    rec.at = now;
    function fuelStack() { return zoneStacks(rec, 1).filter(function (st) { return (c.items[st.item] || {}).fuelS > 0; })[0] || null; }
    while (rec.lit && dt > 0 && guard++ < 5000) {
      if (!(rec.burn > 0)) {                                  // the next piece of fuel, or the fire is out
        var f = fuelStack();
        if (!f) { rec.lit = false; rec.prog = 0; break; }
        rec.burn = c.items[f.item].fuelS * 1000; f.qty--; if (f.qty <= 0) rec.inv.splice(rec.inv.indexOf(f), 1);
      }
      var r = cookPick(c, rec), need = r ? Math.max(1, (r.timeS || COOK_S) * 1000) : 0;
      if (!r) rec.prog = 0;
      var step = Math.min(dt, rec.burn, r ? need - (rec.prog || 0) : Infinity);
      rec.burn -= step; dt -= step;
      if (r) {
        rec.prog = (rec.prog || 0) + step;
        if (rec.prog >= need) {
          rec.prog = 0;
          list(r.inputs).forEach(function (g) { zoneTake(rec, 0, g.item, g.qty); });
          list(r.outputs).forEach(function (g) { zoneAdd(c, rec.inv, g.item, g.qty, ob.lo, ob.hi); });
          rec.job.n--; if (rec.job.n <= 0) delete rec.job;
          cookLost(c, rec);                                   // (not enough left in the raw cells for the next one)
        }
      }
    }
    // ('burning', not 'lit': the craft kind's own default state is called lit, and a default state is never sent to the page)
    var state = rec.lit ? 'burning' : (zoneStacks(rec, 1).length || rec.burn > 0) ? 'fueled' : 'empty';
    if (ms.states[key] !== state) setState(ws, mapId, key, state);
    ws.dirty = true;
  }
  /** The container p may reach into (next to it, and not in someone else's base), or null with the reason said. */
  function openBox(c, ws, p, key, say, now) {
    var st = structOf(ws, p.map), e = st.ents.filter(function (b) { return b.key === String(key || ''); })[0];
    var le = (liveMap(c, ws, p.map).entities || []).filter(function (b) { return b.key === String(key || ''); })[0], ck = le && !(le.need && (le.prog || 0) < le.need) ? cookerOf(c, le) : null;
    if (ck) { e = cookBox(c, ws, p.map, le, ck); cookTick(c, ws, p.map, e.key, now || Date.now()); }
    if (e && !e.inv && (objOf(c, e) || {}).kind === 'container' && !(e.need && (e.prog || 0) < e.need)) e.inv = [];
    if (!e) { e = mapBox(c, ws, p.map, String(key || ''), false, p); if (e && stateOf(c, ws, p.map, e._ent) === 'locked') { say('It is locked.'); return null; } }
    if (!e || !e.inv) { say('That holds nothing.'); return null; }
    if (cheb(p.x, p.y, e.x, e.y) > 1) { say('Too far away.'); return null; }
    var scl = foreignClaim(c, liveMap(c, ws, p.map), p, [{ x: e.x, y: e.y }]);
    if (scl) { say('That belongs to ' + claimOwner(scl) + '\'s base.'); return null; }
    return e;
  }
  /** A container the world left (a carcass) that has just been emptied: it is gone, and the page is told to close it. */
  function emptiedWild(c, ws, p, e, ev) {
    if (!e || !e.wild) return false;
    if (Array.isArray(e.inv)) e.inv = e.inv.filter(function (s0) { return s0.qty > 0; });   // (stacks taken through a player's own view of it)
    if (e.inv && e.inv.length) {
      if (boxInv(c, e, p).length) return false;
      ev.push({ type: 'storage', to: p.id, key: e.key, gone: true });   // nothing left for THIS player: their window closes, the body stays for the others
      return true;
    }
    var st = structOf(ws, p.map), i = st.ents.indexOf(e);
    if (i >= 0) st.ents.splice(i, 1);
    delete mapState(ws, p.map).timers[e.key];
    touchStruct(st); ws.dirty = true;
    ev.push({ type: 'storage', to: p.id, key: e.key, gone: true });
    return true;
  }
  // The old way in: so many of an item, by name (kept for pages that still send it; the grid uses 'inv' below).
  function storeAct(c, ws, p, a, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var e = openBox(c, ws, p, a.key, say, now); if (!e) return;
    if (e._cook && (a.op === 'light' || a.op === 'douse')) {     // the fire itself
      var k = e._cook;
      if (a.op === 'douse') k.lit = false;
      else if (!zoneStacks(k, 1).length && !(k.burn > 0)) return say('There is nothing in it to burn.');
      else { k.lit = true; k.at = now; }
      cookTick(c, ws, p.map, e.key, now); storageEvent(c, p, e, ev); return;
    }
    // {op:'load', recipe, qty}: the Cook button — it is told to make so many batches of one of its recipes (more of
    // the one it is on are added to it; another recipe takes its place). What that takes and is not yet in its raw
    // cells comes out of the bag; as many batches as there are things and room for. With fuel in it, the fire is lit.
    // {op:'cancel'}: it stops making it (what is in its cells stays there).
    if (e._cook && a.op === 'cancel') { delete e._cook.job; e._cook.prog = 0; cookTick(c, ws, p.map, e.key, now); storageEvent(c, p, e, ev); return; }
    if (e._cook && a.op === 'load') {
      var lk = e._cook, lr = (c.recipes || {})[String(a.recipe || '')], rb = cookZone(lk, 0);
      if (!lr || cookRecs(c, e._station).indexOf(lr) < 0 || (lr.unlock && !check(c, p, lr.unlock))) return say('That can\'t be made here.');
      var ins = list(lr.inputs), on = lk.job && lk.job.id === lr.id && lk.job.n > 0 ? lk.job.n : 0, inRaw = {};
      zoneStacks(lk, 0).forEach(function (st) { inRaw[st.item] = (inRaw[st.item] || 0) + st.qty; });
      function missing(g, n) { return Math.max(0, g.qty * (on + n) - (inRaw[g.item] || 0)); }   // of g, still to come out of the bag for n more batches
      var more = Math.max(1, Math.min(CRAFT_MAX - on, Math.round(Number(a.qty)) || 1));
      ins.forEach(function (g) { if (g.qty > 0) more = Math.min(more, Math.floor(((inRaw[g.item] || 0) + count(p, g.item)) / g.qty) - on); });
      if (more < 1) {
        var lacks = ins.filter(function (g) { return (inRaw[g.item] || 0) + count(p, g.item) < g.qty * (on + 1); });
        return say('Not enough ' + lacks.map(function (g) { return lower(itemName(c, g.item)); }).join(', ') + '.');
      }
      for (; more >= 1; more--) {
        var copy = lk.inv.map(function (st) { return { item: st.item, qty: st.qty, s: st.s }; });
        if (ins.every(function (g) { var m = missing(g, more); return !m || zoneAdd(c, copy, g.item, m, rb.lo, rb.hi) === 0; })) break;
      }
      if (more < 1) return say('There is no room for it.');
      ins.forEach(function (g) { var m = missing(g, more); if (m) { take(p, g.item, m); zoneAdd(c, lk.inv, g.item, m, rb.lo, rb.hi); } });
      if (!on) lk.prog = 0;
      lk.job = { id: lr.id, n: on + more };
      if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
      syncLoadout(c, p);
      if (!lk.lit) { if (zoneStacks(lk, 1).length || lk.burn > 0) { lk.lit = true; lk.at = now; } else say('It needs fuel to cook.'); }
      cookTick(c, ws, p.map, e.key, now); storageEvent(c, p, e, ev); return;
    }
    if (e._cook && a.op !== 'look') return;                     // (things go in and out of a cooker by its cells: the 'inv' action)
    var id = String(a.item || ''), qty = Math.max(1, Math.round(Number(a.qty)) || 1), inv = boxInv(c, e, p), slots = boxSlots(c, e);
    if (a.op === 'put') {
      if (e.wild) return say('You can\'t put things in that.');
      if (id === 'gold' || !c.items[id]) return say('You can\'t store that.');
      qty = Math.min(qty, count(p, id)); if (qty < 1) return say('You have none.');
      var left = addStacks(c, inv, id, qty, slots);
      if (left >= qty) return say('It is full.');
      take(p, id, qty - left);
    } else if (a.op === 'take') {
      qty = Math.min(qty, countIn(inv, id)); if (qty < 1) return say('There is none in there.');
      var back = carryAdd(c, p, id, qty, bagSlots(c));
      if (back >= qty) return say('Your bag is full.');
      removeStacks(inv, id, qty - back);
    } else if (a.op !== 'look') return;
    ws.dirty = true;                                                   // contents are private: no revision bump, no push
    if (emptiedWild(c, ws, p, e, ev)) return;
    storageEvent(c, p, e, ev);
  }
  /**
   * Move a stack: {type:'inv', from:{w:'bag'|'box', s}, to:{w:'bag'|'box', s?}, qty?, key?}. w = whose grid (box =
   * the container `key`), s = the cell. qty = how many of the stack (missing = all of it: less = splitting it).
   * Onto an empty cell it is put down; onto more of the same it tops that stack up (what does not fit stays behind);
   * onto something else the two change places (whole stacks only). With no cell named it goes wherever it fits.
   */
  function invAct(c, ws, p, a, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    // The belt is cells of the bag's list (BELT_AT on): {w: 'belt', s: slot} is that cell of the bag.
    function beltCell(x) { return x && x.w === 'belt' ? { w: 'bag', s: BELT_AT + Math.floor(Number(x.s)), belt: true } : x; }
    var from = beltCell(a.from || {}), to = beltCell(a.to || {}), e = null;
    if (a.w === 'belt') a = Object.assign({}, a, { s: BELT_AT + Math.floor(Number(a.s)) });   // (drop / repair / salvage a belt slot)
    if ((from.belt && !onBeltCell(from.s)) || (to.belt && !onBeltCell(to.s))) return;
    if (onWornCell(Number(from.s)) || onWornCell(Number(to.s)) || onWornCell(Number(a.s))) return;   // (what is worn: Wear / Take off, the 'use' action)
    if (a.op === 'sort') {                                    // put the bag in order: same things joined into full stacks, kinds together
      sortStacks(c, tidyStacks(c, p.inventory));
      return;
    }
    if (a.op === 'repair' || a.op === 'salvage') {            // a weapon or tool in the bag: mend it to full, or take it apart
      var rs = stackAt(tidyStacks(c, p.inventory), Math.floor(Number(a.s))), rit = rs && c.items[rs.item];
      if (!rit) return say('There is nothing there.');
      if (a.op === 'repair') {
        var ri = repairInfo(c, liveMap(c, ws, p.map), p, serverLookup(c, ws, p.map, [p]), rs);
        if (!ri.ok) return say(ri.reason);
        ri.cost.forEach(function (g) { take(p, g.item, g.qty); });
        delete rs.dur;                                         // (whole again)
        if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
        return say('You repair the ' + lower(rit.name) + '.');
      }
      var si = salvageInfo(c, rs); if (!si.ok) return say(si.reason);
      p.inventory.splice(p.inventory.indexOf(rs), 1);
      goneFromBag(p, rs.item);
      if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
      say('You take the ' + lower(rit.name) + ' apart.');
      si.gives.forEach(function (g) { give(c, p, g.item, g.qty, ev); });
      return;
    }
    if (a.op === 'drop') {                                    // out of the bag, onto the ground: a loot bag at your feet
      var dbag = tidyStacks(c, p.inventory), ds = stackAt(dbag, Math.floor(Number(a.s)));
      if (!ds) return say('There is nothing there.');
      if (!bagObject(c)) return say('You can\'t drop things here.');
      var dn = Math.max(1, Math.min(ds.qty, Math.round(Number(a.qty)) || ds.qty)), did = ds.item;
      ds.qty -= dn; if (ds.qty <= 0) dbag.splice(dbag.indexOf(ds), 1);
      goneFromBag(p, did);
      if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
      syncLoadout(c, p);
      leaveBag(c, ws, p.map, p.x, p.y, [{ item: did, qty: dn, dur: ds.dur }], now);
      return say('You drop ' + (dn > 1 ? dn + ' × ' : 'the ') + lower(itemName(c, did)) + '.');
    }
    if (a.op === 'takeall') {                                 // everything in the open container, into the bag, as far as it fits
      e = openBox(c, ws, p, a.key, say, now); if (!e) return;
      if (e._cook) return;                                    // (a cooker's cells are taken one by one)
      var tb = tidyStacks(c, p.inventory), fb = boxInv(c, e, p), size = bagSlots(c), moved = 0, stuck = 0;
      fb.slice().sort(function (x, y) { return x.s - y.s; }).forEach(function (st) {
        var left = carryAdd(c, p, st.item, st.qty, size, st);
        moved += st.qty - left; stuck += left; st.qty = left;
        if (left <= 0) fb.splice(fb.indexOf(st), 1);
      });
      if (stuck) say(moved ? 'Your bag is full: some of it stays.' : 'Your bag is full.');
      if (!moved) return;
      if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
      if (emptiedWild(c, ws, p, e, ev)) return;
      ws.dirty = true; storageEvent(c, p, e, ev);
      return;
    }
    if (from.w === 'box' || to.w === 'box') { e = openBox(c, ws, p, a.key, say, now); if (!e) return; }
    if (e && e.wild && to.w === 'box') return say('You can\'t put things in that.');
    var bag = tidyStacks(c, p.inventory), box = e ? boxInv(c, e, p) : null;
    var fromL = from.w === 'box' ? box : bag, toL = to.w === 'box' ? box : bag;
    var toSize = to.w === 'box' ? boxSlots(c, e) : bagSlots(c), fromSize = from.w === 'box' ? boxSlots(c, e) : bagSlots(c);
    var src = stackAt(fromL, Math.floor(Number(from.s)));
    if (!src) return say('There is nothing there.');
    var zone = null;                                          // into a cooker with no cell to go to: anywhere in this run of its cells
    if (e && e._cook) {                                       // a cooker's cells take only what belongs in them
      var ck = e._cook, given = !(to.s === undefined || to.s === null || to.s === '');
      if (to.w === 'box') {
        var fuel = (c.items[src.item] || {}).fuelS > 0, cooks = !!cookRecipe(c, e._station, src.item);
        var z = given ? zoneOfCell(ck, Math.floor(Number(to.s))) : (cooks ? 0 : fuel ? 1 : -1);
        if (from.w === 'box') { if (!given || z !== zoneOfCell(ck, src.s)) return; }   // (inside it: only about its own run of cells)
        else {
          if (z === 2) return say('That is where things come out.');
          if (z === 1 && !fuel) return say('That will not burn.');
          if (z !== 1 && !(z === 0 && cooks)) return say('Nothing can be made of that here.');
          var there = given ? stackAt(box, Math.floor(Number(to.s))) : null;
          if (!given || (there && (there.item !== src.item || there.qty >= stackMaxOf(c, src.item)))) zone = cookZone(ck, z);   // (never a swap out of the cooker)
        }
      } else if (given) {
        var onto = stackAt(bag, Math.floor(Number(to.s)));
        if (onto && onto.item !== src.item) to = { w: 'bag' };  // (never a swap INTO the cooker: it goes wherever it fits)
      }
    }
    if (e && e.wild && from.w === 'box' && to.w === 'bag' && to.s !== undefined && to.s !== null && to.s !== '') {
      var onto2 = stackAt(bag, Math.floor(Number(to.s)));
      if (onto2 && onto2.item !== src.item) to = { w: 'bag' };   // (never a swap into a take-only container)
    }
    var id = src.item, other = '', max = stackMaxOf(c, id);
    // Out of a cooker's "comes out" cell into the bag: whoever takes it out made it (a fire cooks with nobody
    // there, so this is the one moment a player can be named), for quests that ask for it to be crafted.
    var cooked = !!(e && e._cook && from.w === 'box' && to.w === 'bag' && zoneOfCell(e._cook, src.s) === 2), hadBefore = cooked ? count(p, id) : 0;
    var qty = Math.max(1, Math.min(src.qty, Math.round(Number(a.qty)) || src.qty));
    if (zone) {
      var zl = zoneAdd(c, toL, id, qty, zone.lo, zone.hi);
      if (zl >= qty) return say('It is full.');
      src.qty -= qty - zl;
    } else if (to.s === undefined || to.s === null || to.s === '') {            // wherever it fits
      if (fromL === toL) {
        if (!from.belt || to.belt) return;
        // off the belt into the backpack, wherever it fits: onto stacks of it there with room, then the first free cell
        var topped = 0;
        bag.slice().sort(function (x, y) { return x.s - y.s; }).forEach(function (st) {
          if (topped < qty && st !== src && st.item === id && !onBeltCell(st.s) && st.s < toSize && st.qty < max) { var k = Math.min(qty - topped, max - st.qty); st.qty += k; topped += k; }
        });
        src.qty -= topped;
        var rest = qty - topped;
        if (rest > 0) {
          var fc = freeCell(bag);
          if (fc >= toSize) { if (!topped) return say('Your bag is full.'); }
          else if (rest === src.qty) src.s = fc;
          else { var nw = { item: id, qty: rest, s: fc }; if (src.dur != null) nw.dur = src.dur; bag.push(nw); src.qty -= rest; }
        }
      } else {
        var left = toL === bag && fromL !== bag ? carryAdd(c, p, id, qty, toSize, src) : addStacks(c, toL, id, qty, toSize, src);   // (out of a container: onto the belt first, like anything picked up)
        if (left >= qty) return say(to.w === 'box' ? 'It is full.' : 'Your bag is full.');
        src.qty -= qty - left;
      }
    } else {
      var t = Math.floor(Number(to.s));
      if (!(t >= 0) || (toSize && t >= toSize && !(to.belt && onBeltCell(t)))) return say('There is no room there.');
      if (fromL === toL && t === src.s) return;
      var dst = stackAt(toL, t);
      if (!dst) {
        if (qty === src.qty && fromL === toL) src.s = t;                 // the whole stack, to another cell of the same grid
        else { var mv = { item: id, qty: qty, s: t }; if (src.dur != null) mv.dur = src.dur; toL.push(mv); src.qty -= qty; }
      } else if (dst.item === id && dst.qty < max) {
        var n = Math.min(qty, max - dst.qty); dst.qty += n; src.qty -= n;
      } else {
        if (qty !== src.qty) return say('That cell is taken.');
        if (fromSize && src.s >= fromSize && !onBeltCell(src.s)) return say('There is no room to swap.');     // (a stack past the last cell cannot be swapped into)
        other = dst.item;
        var a0 = src.s; src.s = t; dst.s = a0;                          // change places…
        if (fromL !== toL) { fromL.splice(fromL.indexOf(src), 1); toL.splice(toL.indexOf(dst), 1); toL.push(src); fromL.push(dst); }   // …across the two grids
      }
    }
    if (src.qty <= 0 && fromL.indexOf(src) >= 0) fromL.splice(fromL.indexOf(src), 1);
    goneFromBag(p, id); if (other) goneFromBag(p, other);
    if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);     // what is in hand may have just left (or come back)
    if (e && e._cook) cookTick(c, ws, p.map, e.key, now);       // (its picture follows what is in it)
    if (cooked && count(p, id) > hadBefore) questCount(c, p, 'craft', id, now, ev, count(p, id) - hadBefore);
    if (emptiedWild(c, ws, p, e, ev)) return;
    if (e) { ws.dirty = true; storageEvent(c, p, e, ev); }
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
      if (Rl().cliffReach(map, p.x, p.y, x, y)) return null;                             // it stands on another level of ground
      var onEdge = edgeTarget(c, map, st, ed.orient, ed.x, ed.y);
      if (onEdge) return onEdge;
      if (Rl().edgeBlocked(c, map, ed.orient, ed.x, ed.y, 'move')) return null;        // an unbreakable wall is in the way
    }
    var hit = Rl().blockersAt(c, map, x, y).filter(function (e) { return !isWallFixture(objOf(c, e)); })
      .map(function (e) { return resolveOn(c, map, st, { t: 'ent', key: e.key }); }).filter(function (g) { return g && g.can; })[0];
    return hit ? { t: 'ent', key: hit.key } : null;
  }
  /** What the player strikes with: the belt slot in hand (a weapon or a tool), else the weapon worn (older characters). */
  /** Which of p's stacks of an item is the one in use (in hand, swung, fired): the one in the belt slot in hand, else the first. */
  // (a whole one before a broken one: with two axes, the good one is the one swung)
  function stackInUse(p, id) {
    var best = null, hand = typeof p.held === 'number' && p.held >= 0 ? BELT_AT + p.held : -1;
    (p.inventory || []).forEach(function (st) {
      if (st.item !== id || (best && best.s === hand)) return;
      if (st.s === hand) { best = st; return; }              // (the one in hand is the one in use, whole or not)
      var br = st.dur != null && Number(st.dur) <= 0, bb = best && best.dur != null && Number(best.dur) <= 0;
      if (!best || (bb && !br) || (bb === br && st.s < best.s)) best = st;
    });
    return best;
  }
  /** A stack worn down to nothing: it stays, and is good for nothing until it is repaired. */
  function isBroken(c, st) { var d = durOf(c, st); return !!d && d.left <= 0; }
  /** p has one of this item that is not broken. */
  function usable(c, p, id) { var st = stackInUse(p, id); return !!st && !isBroken(c, st); }
  /** What is left of a stack's wear, and its most ({left, max}), or null when the item never wears out. */
  function durOf(c, st) {
    var it = st && c.items[st.item], max = it ? Number(it.durability) || 0 : 0;
    return max > 0 ? { left: st.dur != null ? Math.max(0, Math.min(max, Math.ceil(Number(st.dur)))) : max, max: max } : null;
  }
  /** One use of a weapon or tool (a blow, a shot, a swing at a wall or a tree): its wear goes down by what the material
   *  hit costs it (the item's material_wear; not listed, or no material = 1); at 0 it breaks. */
  function wear(c, p, it, ev, material) {
    if (!it || !(Number(it.durability) > 0)) return;
    var st = stackInUse(p, it.id), d = durOf(c, st); if (!d) return;
    var cost = material && it.wearVs && it.wearVs[material] >= 0 ? Number(it.wearVs[material]) : 1;
    if (!(cost > 0)) return;
    st.dur = (st.dur != null ? Number(st.dur) : d.max) - cost;
    if (st.dur > 0) return;
    st.dur = 0;                                               // broken: it stays (repair it, or take it apart), but is good for nothing
    if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);
    ev.push({ type: 'info', to: p.id, text: 'Your ' + lower(it.name) + ' is broken.' });
  }
  function heldItem(c, p) {
    var id = p.held >= 0 ? beltOf(p)[p.held] : '';
    if (id && c.items[id] && count(p, id) > 0) return usable(c, p, id) ? c.items[id] : null;   // (broken: nothing in hand)
    return c.items[(p.equipment || {}).weapon] || null;
  }
  /**
   * The resource at (x,y) that p may keep working by holding the button: something next to them that yields when
   * broken (properties.harvest), with the tool it asks for IN HAND (no tool asked = anything will do). null otherwise.
   * map = a live map. The page asks this every swing; the referee has no say in it (each swing is a plain attack).
   */
  function harvestWith(c, map, p, x, y) {
    if (!map || cheb(p.x, p.y, x, y) !== 1) return null;
    var t = strikeTarget(c, map, p, x, y), tg = t && t.t === 'ent' ? resolveOn(c, map, map._struct || NO_STRUCT, t) : null;
    if (!tg || (tg.built && !(tg.rec && tg.rec.wild)) || !tg.can || tg.hp <= 0 || !tg.obj || !harvestOf(tg)) return null;
    var need = (tg.obj.properties || {}).harvest_bare ? [] : toolTags((tg.obj.properties || {}).harvest_tool);   // (with a bare-hands yield, anything will do)
    if (need.length) {
      var it = heldItem(c, p), tags = (it && it.tools) || [];
      if (!need.some(function (g) { return tags.indexOf(g) >= 0; })) return null;
    }
    return tg;
  }
  function structureDamageOf(c, p, weapon) {
    if (weapon && Number(weapon.structureDmg) > 0) return Number(weapon.structureDmg);
    var k = c.config.structure_dmg_scale === undefined || c.config.structure_dmg_scale === '' ? 0.5 : Number(c.config.structure_dmg_scale);
    return Math.max(1, Math.round(stats(c, p).atk * (k >= 0 ? k : 0.5)));
  }
  // What a player last did that the OTHERS should see: "n,kind,x,y,amount" on the player (kind m = a melee swing,
  // r = a shot that hurt a creature; x,y = what it was aimed at; amount = the damage, 0 for none). It travels with
  // the player wherever players are listed (answers and the live push), so a page shows the swing and the number the
  // moment it learns of it, without waiting for the events of its own next request. n only counts (1..999, round).
  function noteAct(p, kind, x, y, amount) {
    var n = (Number(String(p.act || '').split(',')[0]) || 0) % 999 + 1;
    p.act = [n, kind, x, y, Math.max(0, Math.round(Number(amount) || 0))].join(',');
  }
  /** A melee swing at a wall or object (same pace as a basic attack). */
  function strike(c, ws, p, t, now, rng, ev) {
    if (now < (p.nextAttack || 0)) return false;
    p.nextAttack = now + (Number(c.config.attack_ms) || 0);
    var tg0 = resolveTarget(c, ws, p.map, t), needTool = tg0 && tg0.obj && tg0.obj.properties && tg0.obj.properties.harvest_tool;
    if (tg0 && tg0.obj && !tg0.built && tg0.hp > 0 && tg0.obj.properties && tg0.obj.properties.harvest_bare && !harvestTooled(c, p, tg0.obj)) {
      noteAct(p, 'm', tg0.x, tg0.y, 0); pickBare(c, p, tg0, ev); return true;      // picked by hand: nothing is broken
    }
    if (needTool && !hasTool(c, p, needTool)) { noteAct(p, 'm', tg0.x, tg0.y, 0); ev.push({ type: 'info', to: p.id, text: 'You need ' + toolsText(needTool) + ' for the ' + tg0.name + '.' }); return true; }
    // An axe bites wood, a pickaxe stone: what is in hand may multiply its blows on one material (the item's material_dmg).
    var inHand = heldItem(c, p), edge = tg0 && inHand && inHand.vsMaterial ? Number(inHand.vsMaterial[tg0.material]) : NaN;
    var res = damageStructure(c, ws, p.map, t, structureDamageOf(c, p, inHand) * (edge >= 0 ? edge : 1), { kind: 'melee', by: p.id, player: p, now: now }, ev);
    var seenAt = res ? res.tg : tg0;
    if (seenAt) noteAct(p, 'm', seenAt.x, seenAt.y, res ? res.dealt : 0);
    if (!res) ev.push({ type: 'info', to: p.id, text: 'You can\'t damage that.' });
    else if (!res.dealt) ev.push({ type: 'info', to: p.id, text: 'You can\'t even scratch the ' + res.tg.name + '.' });
    else if (!res.destroyed) ev.push({ type: 'info', to: p.id, text: 'You hit the ' + res.tg.name + ' for ' + res.dealt + '.' });
    if (res && res.dealt) { questCount(c, p, 'hit', '*', now, ev); wear(c, p, inHand, ev, (res.tg && res.tg.material) || (tg0 && tg0.material)); }
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
  // ---- how a new character may look (the character screen offers these; the referee takes nothing else) ----
  // Hair shapes are paper-doll layers (a hair_*.png with its .tint.png mask); colours are hair_* ramps of the page's
  // Tint.TINTS. Config hair_styles / hair_colors (lists) replace the built-in ones. '' = bald, always allowed.
  var HAIR_DIR = 'art/sprites/paperdoll/hair/';
  var HAIR_STYLES = ['hair_messy', 'hair_buzz', 'hair_slick', 'hair_shaggy', 'hair_under', 'hair_bob', 'hair_pony', 'hair_long', 'hair_metal_mohawk_v1', 'hair_metal_mohawk_v2']
    .map(function (n) { return HAIR_DIR + n + '.png'; });
  // Facial hair (27 Nov 2026): the same kind of layer, in paperdoll/face/, picked on the character screen with a colour
  // of its own (the hair ramps). '' = none, the start. Config beard_styles (a list) replaces the built-in ones.
  var BEARD_DIR = 'art/sprites/paperdoll/face/';
  var BEARD_STYLES = ['beard_stubble_final', 'beard_goatee_only_final', 'beard_goatee_stubble_final', 'beard_goatee_moustache_final', 'beard_goatee_stubble_moustache_final',
    'beard_chops_v1_final', 'beard_full_only_final', 'beard_full_final', 'beard_long_final'].map(function (n) { return BEARD_DIR + n + '.png'; });
  var HAIR_COLORS = ['hair_black', 'hair_dark', 'hair_brown', 'hair_auburn', 'hair_ginger', 'hair_blonde', 'hair_grey', 'hair_white'];
  // The body under the gear: one for men, one for women, the same for every class (Config body_male / body_female).
  // A character carries body: 'female', 'female_slim' or nothing (= male). The class's own body_sprite is only the fallback for a
  // male body when the Config names none (content made before bodies were a choice).
  // A woman's body comes in two builds (owner, 27 Nov 2026): 'female' = curvy (the woman's cut of what she wears, and her
  // chest moves) and 'female_slim' = slim (Config body_female_slim): drawn in the MAN's cut of every garment and with no
  // chest motion — to the page a slim woman is like a man in all but her body picture (it asks body === 'female').
  var BODY_MALE = 'art/sprites/paperdoll/base/player/body_survivor.png', BODY_FEMALE = 'art/sprites/paperdoll/base/player/body_survivor_female.png',
    BODY_SLIM = 'art/sprites/paperdoll/base/player/body_survivor_female_slim.png', BODIES = ['', 'female', 'female_slim'];
  function bodySprite(c, p) {
    var cls = p && c.classes && c.classes[p['class']];
    if (p && p.body === 'female') return c.config.body_female || BODY_FEMALE;
    if (p && p.body === 'female_slim') return c.config.body_female_slim || BODY_SLIM;
    return c.config.body_male || (cls && cls.bodySprite) || BODY_MALE;
  }
  // Skin tones a character may have: names of the page's Tint.SKINS (which holds the colours). skin_light is the
  // art as drawn, and what a character with no tone recorded has.
  var SKIN_TONES = ['skin_pale', 'skin_light', 'skin_tan', 'skin_olive', 'skin_brown', 'skin_dark', 'skin_deep'];
  function cfgList(c, key) { return String(c.config[key] == null ? '' : c.config[key]).split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function hairChoices(c) {
    var styles = cfgList(c, 'hair_styles'), colors = cfgList(c, 'hair_colors');
    if (!styles.length) styles = HAIR_STYLES.slice();
    if (!colors.length) colors = HAIR_COLORS.slice();
    var s0 = c.config.start_hair || '', c0 = c.config.start_hair_color || 'hair_brown';
    if (s0 && styles.indexOf(s0) < 0) styles.unshift(s0);
    if (colors.indexOf(c0) < 0) colors.unshift(c0);
    if (styles.indexOf('') < 0) styles.push('');
    var beards = cfgList(c, 'beard_styles'); if (!beards.length) beards = BEARD_STYLES.slice();
    if (beards.indexOf('') < 0) beards.unshift('');
    return { styles: styles, colors: colors, style: s0, color: c0, skins: SKIN_TONES.slice(), skin: 'skin_light', beards: beards, beard: '' };
  }
  /** look (optional) = {body, skin, hair, hairColor, beard, beardColor} chosen on the character screen; anything not on offer is ignored. */
  function newPlayer(c, id, name, cls, look) {
    var p = { id: id, name: name, 'class': c.classes[cls] ? cls : (c.config.start_class || Object.keys(c.classes)[0] || ''),
      map: '', x: 0, y: 0, facing: 'S', level: 1, xp: 0, gold: 0, inventory: [], equipment: {}, flags: {}, quests: {}, questsDone: {}, explored: {}, respawn: '',
      // cosmetic paper-doll choices (character creation will let players pick these)
      hair: c.config.start_hair || '', hairColor: c.config.start_hair_color || 'hair_brown' };
    // Config start_quests: quests every new character begins with ("welcome" or "welcome, find_water"). They go
    // straight into the log; p.intro lists them until the page has shown its welcome window (quest op 'seen').
    // Each one's before_start runs here too (no world yet: the actions that need one are left out — see run); its on_start
    // waits for its window to be read, like any announced quest's.
    String(c.config.start_quests || '').split(/[;,\s]+/).forEach(function (qid, i) {
      var q = (c.quests || {})[qid]; if (!q || p.quests[qid]) return;
      questBegin(c, null, p, q, Date.now() + i, [], { announce: true });
    });
    if (look) {
      if (look.body && BODIES.indexOf(look.body) > 0) p.body = look.body;
      if (SKIN_TONES.indexOf(look.skin) >= 0 && look.skin !== 'skin_light') p.skin = look.skin;
      var ch = hairChoices(c);
      if (typeof look.hair === 'string' && ch.styles.indexOf(look.hair) >= 0) p.hair = look.hair;
      if (ch.colors.indexOf(look.hairColor) >= 0) p.hairColor = look.hairColor;
      if (look.beard && ch.beards.indexOf(look.beard) >= 0) {             // facial hair: none unless picked; its colour = the hair's unless picked too
        p.beard = look.beard;
        if (ch.colors.indexOf(look.beardColor) >= 0 && look.beardColor !== p.hairColor) p.beardColor = look.beardColor;
      }
    }
    var map = startMap(c), sp = map && map.spawn;                           // the map's own spawn point wins over config.start_x/y
    var sx = sp ? Number(sp.x) || 0 : Number(c.config.start_x) || 0, sy = sp ? Number(sp.y) || 0 : Number(c.config.start_y) || 0;
    var at = Rl().nearestStandable(c, map, sx, sy);
    p.map = map.id; p.x = at.x; p.y = at.y; p.facing = (sp && sp.facing) || 'S';
    p.hp = stats(c, p).maxHp; p.mp = stats(c, p).maxMp;
    // Config start_hunger / start_thirst (0-100; 100 = full): how a NEW character begins — thirsty, for a first quest
    // that sends them to water. (Coming back from death is another matter: see die.)
    p.hunger = Math.max(0, Math.min(100, cfgNum(c, 'start_hunger', 100))); p.thirst = Math.max(0, Math.min(100, cfgNum(c, 'start_thirst', 100))); p.tox = 0;
    p.cooldowns = {}; p.statuses = []; p.mags = {}; p.abilities = ['', '']; p.beltV = 2; p.wornV = 2; delete p.belt;
    list(classOf(c, p).startItems).forEach(function (s) { give(c, p, s.item, s.qty, [], true); });
    // equip the first weapon/armor they start with, so e.g. a survivor spawns with the pistol in hand
    list(classOf(c, p).startItems).forEach(function (s) {
      var it = c.items[s.item];
      var k0 = it && it.slot ? slotFor(p, it) : '';
      if (k0 && !p.equipment[k0] && !wornAt(p, it) && (!it.equipIf || check(c, p, it.equipIf))) { p.equipment[k0] = s.item; if (k0 !== 'weapon') putOn(p, bagStackOf(p, s.item), k0); }
    });
    var wep0 = rangedWeapon(c, p); if (wep0) loadMag(c, p, wep0);   // a spawned gun starts with a full magazine
    fillLoadout(c, p, true);
    adoptWeapon(c, p);
    return p;
  }
  /** The hotbar: this many belt slots (keys 1-9 and 0). With Config `skills` on, the two abilities (Q, E) show beside it. */
  var BELT_SIZE = 10;
  /** Skills are switched off for now (Config `skills`: on brings back Q/E, the bag's abilities and the mana bar).
   *  The rules for them are untouched; this only decides what players are shown and told. */
  function skillsOn(c) { return String((c.config || {}).skills || '').toLowerCase() === 'on'; }
  function emptyBelt() { var a = []; while (a.length < BELT_SIZE) a.push(''); return a; }
  // The belt is a place of its own (owner, 26 Nov 2026): what sits on it is NOT in the backpack. Its slots are cells of
  // the same list as the bag's (p.inventory), numbered from BELT_AT: slot i = cell BELT_AT + i, one stack each. So
  // count / give / take see everything carried, and the bag's grid is the cells below BELT_AT.
  var BELT_AT = 1000;
  function onBeltCell(s) { return s >= BELT_AT && s < BELT_AT + BELT_SIZE; }
  function beltStack(p, i) { return stackAt(p.inventory || [], BELT_AT + i); }
  // What is WORN is a place of its own too (owner, 26 Nov 2026): worn place k (helm, armor, …, accessory1…N) is cell
  // WORN_AT + its index in wornKeys(); p.equipment[k] still names the item (stats and drawing read that). A place the
  // rules have no cell for (a slot name of the content's own) is worn from the bag, as before.
  var WORN_AT = 2000;
  // (a place added later — `late`, the face — is numbered after the accessories, so the cells of old saves stay as they are)
  function wornKeys() {
    function ids(late) { return WORN_SLOTS.filter(function (w) { return !!w.late === late; }).map(function (w) { return w.id; }); }
    return ids(false).concat(accKeys(), ids(true));
  }
  function wornCell(k) { var i = wornKeys().indexOf(k); return i < 0 ? -1 : WORN_AT + i; }
  function onWornCell(s) { return s >= WORN_AT && s < WORN_AT + wornKeys().length; }
  /** Puts a stack on in worn place k: it moves to that place's cell, and what was worn there takes the cell it left. */
  function putOn(p, st, k) {
    var cell = wornCell(k); if (cell < 0 || !st) return;
    var there = stackAt(p.inventory, cell); if (there === st) return;
    var was = st.s; st.s = cell;
    if (there) there.s = was;
  }
  /** p.equipment follows the worn cells: a cell's stack is what is worn there; an emptied cell wears nothing. */
  function wornSync(p) {
    var eq = p.equipment = p.equipment || {};
    wornKeys().forEach(function (k, i) {
      var st = stackAt(p.inventory || [], WORN_AT + i);
      if (st) eq[k] = st.item; else delete eq[k];
    });
  }
  /** What is in each belt slot: item ids ('' = empty). */
  function beltOf(p) {
    var a = emptyBelt();
    (p.inventory || []).forEach(function (st) { if (onBeltCell(st.s)) a[st.s - BELT_AT] = st.item; });
    return a;
  }
  /** Puts a stack (of the bag or the belt) into belt slot i; what was there takes the cell it left. */
  function toBelt(p, st, i) {
    var there = beltStack(p, i); if (there === st) return;
    var was = st.s; st.s = BELT_AT + i;
    if (there) there.s = was;
  }
  /** The bag's own stacks of an item (not on the belt), the one to take first first: whole, then the first cell. */
  function bagStackOf(p, id) {
    return (p.inventory || []).filter(function (st) { return st.item === id && st.s < BELT_AT; }).sort(function (a, b) {
      return ((a.dur != null && Number(a.dur) <= 0) - (b.dur != null && Number(b.dur) <= 0)) || a.s - b.s;
    })[0] || null;
  }
  /** The belt slot an item sits in, moving it there first if it is not on the belt (an empty slot, else the one in hand). */
  function beltSlotFor(p, id) {
    var b = beltOf(p), i = b.indexOf(id);
    if (i >= 0) return i;
    i = b.indexOf(''); if (i < 0) i = p.held >= 0 ? p.held : BELT_SIZE - 1;
    var st = bagStackOf(p, id); if (st) toBelt(p, st, i);
    return i;
  }
  /** Into what a player carries, wherever it fits (owner, 26 Nov 2026): a weapon, a tool or something to consume, throw or
   *  put down goes onto the belt first — stacks of it there with room, then free slots —, the rest into the backpack as
   *  addStacks does (size 0 = no limit). keep = what a moved stack carries (its wear). Returns how many did not fit. */
  function carryAdd(c, p, id, qty, size, keep) {
    var inv = p.inventory;
    if (qty > 0 && beltWorthy(c.items[id])) {
      var max = stackMaxOf(c, id);
      inv.slice().sort(function (a, b) { return a.s - b.s; }).forEach(function (st) {
        if (qty > 0 && onBeltCell(st.s) && st.item === id && st.qty < max) { var n = Math.min(qty, max - st.qty); st.qty += n; qty -= n; }
      });
      for (var i = 0; i < BELT_SIZE && qty > 0; i++) {
        if (beltStack(p, i)) continue;
        var ns = { item: id, qty: Math.min(qty, max), s: BELT_AT + i };
        if (keep && keep.dur != null) ns.dur = keep.dur;
        inv.push(ns); qty -= ns.qty;
      }
    }
    return qty > 0 ? addStacks(c, inv, id, qty, size, keep) : 0;
  }
  /** Something new to the character (none of it carried before): if it belongs on the belt and a slot is free, it goes there. */
  function beltNew(c, p, id) {
    if (!beltWorthy(c.items[id])) return;
    var b = beltOf(p), i = b.indexOf(''); if (b.indexOf(id) >= 0 || i < 0) return;
    var st = bagStackOf(p, id); if (st) toBelt(p, st, i);
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
    delete p.reload;                                          // changing what is in hand drops a reload under way
    var id = slot >= 0 ? beltOf(p)[slot] : '', it = id && c.items[id], was = p.equipment.weapon || '';
    var wep = !!(it && it.slot === 'weapon' && count(p, id) > 0 && usable(c, p, id));   // (a broken one is not a weapon)
    if (wep && it.equipIf && !check(c, p, it.equipIf)) {
      wep = false;
      var req = /level:(\d+)/.exec(it.equipIf);
      if (ev) ev.push({ type: 'info', to: p.id, text: 'You cannot use the ' + lower(it.name) + ' yet.' + (req ? ' (Requires level ' + req[1] + '.)' : '') });
    }
    if (wep) {
      p.equipment.weapon = id;
      if (was !== id && itemCan(it, 'shoot') && Number(it.clip) > 0 && (!p.mags || p.mags[id] == null)) loadMag(c, p, it);   // a gun drawn for the first time comes loaded (an emptied one is reloaded the slow way)
    } else delete p.equipment.weapon;
    if ((p.equipment.weapon || '') !== was) { syncLoadout(c, p); p.hp = Math.min(p.hp, stats(c, p).maxHp); }
  }
  /** Fills in anything missing (e.g. a character saved before milestone 3). */
  function normalize(c, p) {
    function obj(v, d) { if (v && typeof v === 'object') return v; try { return v ? JSON.parse(v) : d; } catch (e) { return d; } }
    p.inventory = obj(p.inventory, []); if (!Array.isArray(p.inventory)) p.inventory = [];
    tidyStacks(c, p.inventory);                                // every stack in a cell of its own, none over its limit
    p.equipment = obj(p.equipment, {}); p.flags = obj(p.flags, {}); p.explored = obj(p.explored, {});
    p.quests = obj(p.quests, {}); p.questsDone = obj(p.questsDone, {});   // the quest log, and when each finished quest was handed in
    p.cooldowns = obj(p.cooldowns, {}); p.statuses = obj(p.statuses, []); if (!Array.isArray(p.statuses)) p.statuses = [];
    p.mags = obj(p.mags, {}); if (!p.mags || typeof p.mags !== 'object' || Array.isArray(p.mags)) p.mags = {};   // rounds loaded per gun
    p.abilities = obj(p.abilities, null); var belt = obj(p.belt, null);
    if (!Array.isArray(p.abilities) || (p.beltV !== 2 && !Array.isArray(belt))) {
      p.abilities = ['', '']; belt = emptyBelt();
      var oldBar = obj(p.loadout, null);              // pre-rework: one mixed 5-slot bar of "skill:x"/"item:x"
      if (Array.isArray(oldBar)) oldBar.forEach(function (e) {
        var k = String(e || '').split(':')[0], id = String(e || '').slice(k.length + 1); if (!id) return;
        if (k === 'skill') { var a = p.abilities.indexOf(''); if (a >= 0) p.abilities[a] = id; }
        else if (k === 'item') { var b = belt.indexOf(''); if (b >= 0) belt[b] = id; }
      });
      p._fill = true;
    }
    while (p.abilities.length < 2) p.abilities.push('');
    delete p.loadout;
    p.abilities = p.abilities.map(function (id) { return id && c.skills && c.skills[id] ? id : ''; });   // drop skills no longer in the data (e.g. the old gunshot)
    if (p.beltV !== 2) {                        // saved when the belt only named things in the bag: one stack of each moves onto it
      if (Array.isArray(belt)) belt.slice(0, BELT_SIZE).forEach(function (id, i) {
        if (!id || !c.items[id] || beltStack(p, i) || beltOf(p).indexOf(id) >= 0) return;
        var st = bagStackOf(p, id); if (st) st.s = BELT_AT + i;
      });
      p.beltV = 2;
    }
    delete p.belt;
    if (p.wornV === 1) {                        // saved with four accessory places and no belt place: each worn cell to its new number
      var OLD = ['helm', 'armor', 'pants', 'feet', 'gloves', 'back', 'accessory1', 'accessory2', 'accessory3', 'accessory4'], moved = [];
      p.inventory.forEach(function (st) {
        var k = st.s >= WORN_AT ? OLD[st.s - WORN_AT] : null; if (!k) return;
        moved.push([st, wornCell(k), k]);
      });
      moved.forEach(function (m) { m[0].s = m[1] >= 0 ? m[1] : -2; if (m[1] < 0) delete p.equipment[m[2]]; });
      moved.forEach(function (m) { if (m[0].s === -2) { var fc = freeCell(p.inventory); m[0].s = fc < bagSlots(c) ? fc : -1; } });   // (no place any more: back into the bag)
      p.wornV = 2;
    }
    if (p.wornV !== 2) {                        // saved when what was worn stayed in the bag: it moves to its worn place
      Object.keys(p.equipment).forEach(function (k) {
        var cell = wornCell(k), id = p.equipment[k]; if (k === 'weapon' || cell < 0) return;
        var here = stackAt(p.inventory, cell);
        if (here) { p.equipment[k] = here.item; return; }
        var st = bagStackOf(p, id); if (st) st.s = cell; else delete p.equipment[k];
      });
      p.wornV = 2;
    }
    Object.keys(p.equipment).forEach(function (k) { if (/^accessory\d+$/.test(k) && accKeys().indexOf(k) < 0) delete p.equipment[k]; });   // (places that are gone)
    // Something listed as worn in a place that is not its own (the item's slot was renamed after it was put on): nobody
    // could take it off, yet it was drawn. A place with no cell of its own wears from the bag, so the item is still there.
    Object.keys(p.equipment).forEach(function (k) {
      if (k === 'weapon' || wornCell(k) >= 0) return;
      var it = c.items[p.equipment[k]];
      if (!it || it.slot !== k.replace(/\d+$/, '')) delete p.equipment[k];
    });
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
    var tx = Number(p.tox); p.tox = isNaN(tx) ? 0 : Math.max(0, Math.min(100, tx));
    if (p._fill) { delete p._fill; syncLoadout(c, p); fillLoadout(c, p, true); }   // migrated/empty bars: drop stale skills/items, then refill
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
    return what === 'consume' ? it.type === 'consumable' : what === 'throw' ? it.type === 'throwable' : what === 'place' ? it.type === 'placeable' && !!it.places
         : what === 'shoot' ? it.type === 'weapon' : what === 'equip' ? !!it.slot : false;
  }
  /** Items that belong on the belt: things you consume or throw, weapons and tools. Decided by the item's TYPE (owner,
   *  27 Nov 2026): a material ticked `throwable` itself (a rock) stays a material — the player puts it on the belt. */
  function beltWorthy(it) { return itemCan(it, 'consume') || (itemCan(it, 'throw') && !it.ownThrow) || itemCan(it, 'place') || !!(it && (it.slot === 'weapon' || (it.tools || []).length)); }
  /** ...of those, the ones in the backpack (not on the belt already). */
  function beltItems(c, p) {
    return (p.inventory || []).filter(function (s) { return s.s < BELT_AT; }).map(function (s) { return s.item; }).filter(function (id, i, all) {
      return all.indexOf(id) === i && beltWorthy(c.items[id]);   // (an item may be in several stacks)
    });
  }
  /** Fills empty ability slots (Q/E) with usable skills; withBelt (a new character): empty belt slots too, with what belongs there. */
  function fillLoadout(c, p, withBelt) {
    p.abilities = p.abilities || ['', ''];
    usableSkills(c, p).forEach(function (id) {
      if (p.abilities.indexOf(id) >= 0) return;
      var i = p.abilities.indexOf(''); if (i >= 0) p.abilities[i] = id;
    });
    if (withBelt) beltItems(c, p).forEach(function (id) { beltNew(c, p, id); });
  }
  /** After gear/level changes: drop abilities you can no longer use, then refill. (The belt is never refilled behind the player's back.) */
  function syncLoadout(c, p) {
    var usable = usableSkills(c, p);
    p.abilities = (p.abilities || ['', '']).map(function (id) { return id && usable.indexOf(id) < 0 ? '' : id; });
    fillLoadout(c, p);
  }

  function itemName(c, id) { return id === 'gold' ? 'gold' : (c.items[id] ? c.items[id].name : id); }
  // ---- stacks and slots ----
  // What someone carries, and what a container holds, is a list of stacks {item, qty, s}: s = the cell it sits in
  // (the page draws the list as a grid). A stack holds at most the item's stack_max; more of it makes another stack.
  // The bag has Config bag_slots cells (32). Things GIVEN to a player (loot, crafting, harvest) are never lost: with
  // no cell free they land past the last cell (the page shows them as overflow) — but nothing can be MOVED into a
  // bag or a container that is full. count / give / take stay the only ways the rest of the rules touch a bag.
  // Never stack, whatever the data says (each is a thing of its own, with its own wear): weapons, gear that is worn, and
  // anything that wears out (a durability: every axe and pickaxe). A tool that is used up whole (a lockpick) still stacks.
  function oneOfAKind(it) {
    return !!it && (Number(it.durability) > 0 || it.type === 'weapon' || itemCan(it, 'shoot') || (!!it.slot && it.slot !== 'weapon'));
  }
  function stackMaxOf(c, id) { var it = c.items[id], m = it ? Number(it.stackMax) : 0; return oneOfAKind(it) ? 1 : m > 0 ? m : 99; }
  function bagSlots(c) { return Math.max(1, Math.round(cfgNum(c, 'bag_slots', 32))); }
  /** Every stack gets a cell of its own (older saves had none), and none is over its item's limit. */
  function tidyStacks(c, list) {
    var used = {}, extra = [];
    list.forEach(function (st) {
      if (!(st.s >= 0) || st.s !== Math.floor(st.s) || used[st.s] || (st.s >= BELT_AT && !onBeltCell(st.s) && !onWornCell(st.s))) st.s = -1; else used[st.s] = 1;
    });
    function free() { for (var i = 0; ; i++) if (!used[i]) { used[i] = 1; return i; } }
    list.forEach(function (st) {
      if (st.s < 0) st.s = free();
      var max = stackMaxOf(c, st.item);
      while (st.qty > max) { extra.push({ item: st.item, qty: max, s: free() }); st.qty -= max; }
    });
    extra.forEach(function (st) { list.push(st); });
    return list;
  }
  /** Puts a list in order, in place: stacks of the same item are joined (each as full as it goes), then laid out from
   *  the first cell by kind of item, then name. */
  function sortStacks(c, list) {
    var belt = list.filter(function (st) { return st.s >= BELT_AT; });     // (the belt and what is worn are not the bag: they stay as they are)
    for (var bi = list.length - 1; bi >= 0; bi--) if (list[bi].s >= BELT_AT) list.splice(bi, 1);
    var tot = {}, ids = [], own = {};                        // own = the stacks of things that do not stack, kept as they are (their wear)
    list.forEach(function (st) {
      if (!(st.item in tot)) { tot[st.item] = 0; ids.push(st.item); }
      tot[st.item] += st.qty;
      if (stackMaxOf(c, st.item) === 1) (own[st.item] = own[st.item] || []).push(st);
    });
    function k(id) { var it = c.items[id] || {}; return [String(it.type || '~'), String(it.name || id).toLowerCase(), id]; }
    ids.sort(function (x, y) { var a = k(x), b = k(y); for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; });
    list.length = 0;
    ids.forEach(function (id) {
      var max = stackMaxOf(c, id), n = tot[id];
      if (own[id]) { own[id].forEach(function (st) { var q = Math.max(1, st.qty); st.qty = 1; st.s = list.length; list.push(st); n -= 1; while (--q > 0) { list.push({ item: id, qty: 1, s: list.length }); n -= 1; } }); }
      while (n > 0) { var q = Math.min(n, max); list.push({ item: id, qty: q, s: list.length }); n -= q; }
    });
    belt.forEach(function (st) { list.push(st); });
    return list;
  }
  function stackAt(list, slot) { for (var i = 0; i < list.length; i++) if (list[i].s === slot) return list[i]; return null; }
  function freeCell(list) { var used = {}; list.forEach(function (st) { used[st.s] = 1; }); for (var i = 0; ; i++) if (!used[i]) return i; }
  /** Puts qty of an item into a list: tops up its stacks, then starts new ones in the first free cells. size = how
   *  many cells there are (0 = no limit). Returns how many did not fit. */
  // keep = what a stack being moved carries besides item and qty (its wear, dur): new stacks made for it get it too.
  function addStacks(c, list, id, qty, size, keep) {
    var max = stackMaxOf(c, id);
    if (list.some(function (st) { return !(st.s >= 0); })) tidyStacks(c, list);
    list.slice().sort(function (a, b) { return a.s - b.s; }).forEach(function (st) {
      if (qty > 0 && st.item === id && st.qty < max) { var n = Math.min(qty, max - st.qty); st.qty += n; qty -= n; }
    });
    while (qty > 0) {
      var cell = freeCell(list); if (size && cell >= size) break;
      var m = Math.min(qty, max), ns = { item: id, qty: m, s: cell };
      if (keep && keep.dur != null) ns.dur = keep.dur;
      list.push(ns); qty -= m;
    }
    return qty;
  }
  /** The order things are taken in: the bag's last stacks first, then the belt, what is worn last of all. */
  function takeOrder(a, b) { function r(s) { return s < BELT_AT ? 0 : onBeltCell(s) ? 1 : 2; } return (r(a.s) - r(b.s)) || b.s - a.s; }
  /** Takes qty of an item out of a list, from its last stacks first (the belt last). Returns how many it could not find. */
  function removeStacks(list, id, qty) {
    list.filter(function (st) { return st.item === id; }).sort(takeOrder).forEach(function (st) {
      var n = Math.min(qty, st.qty); st.qty -= n; qty -= n;
      if (st.qty <= 0) list.splice(list.indexOf(st), 1);
    });
    return qty;
  }
  function countIn(list, id) { var n = 0; (Array.isArray(list) ? list : []).forEach(function (st) { if (st.item === id) n += st.qty; }); return n; }
  function count(p, id) {
    if (id === 'gold') return p.gold;
    return countIn(p.inventory, id);
  }
  function give(c, p, id, qty, ev, quiet) {
    if (!qty) return;
    if (id === 'gold') p.gold += qty;
    else {
      var size = bagSlots(c), past = function (st) { return st.s >= size && st.s < BELT_AT; }, over = p.inventory.some(past);
      carryAdd(c, p, id, qty, 0);                             // (onto the belt first, when it belongs there and there is room)
      if (ev && !over && p.inventory.some(past)) ev.push({ type: 'info', to: p.id, text: 'Your bag is overfull.' });
    }
    if (!quiet) ev.push({ type: 'loot', to: p.id, map: p.map, x: p.x, y: p.y, item: id, qty: qty, text: '+' + qty + ' ' + itemName(c, id) });   // (every way into the bag says it like this: the page shows a card per item)
  }
  /** What is worn or held goes when the last of it leaves the bag. */
  function goneFromBag(p, id) {
    wornSync(p);
    if (countIn(p.inventory, id) > 0) return;
    Object.keys(p.equipment || {}).forEach(function (k) { if (p.equipment[k] === id) delete p.equipment[k]; });
  }
  /** Use up one of an item: from the stack in the cell it was used from (from.w 'bag'), else as take does. Returns
   *  that stack's cell when it is now empty (so what it leaves can go there), else -1. */
  function takeOne(p, id, from) {
    var cellAt = from && from.w === 'bag' ? Number(from.s) : from && from.w === 'belt' ? BELT_AT + Number(from.s) : NaN;
    var list = p.inventory || [], st = cellAt >= 0 ? list.filter(function (x) { return x.s === cellAt && x.item === id; })[0] : null;
    if (!st) st = list.filter(function (x) { return x.item === id; }).sort(takeOrder)[0];   // (take's own order)
    if (!st) return -1;
    st.qty -= 1;
    var cell = -1;
    if (st.qty <= 0) { cell = st.s; list.splice(list.indexOf(st), 1); }
    goneFromBag(p, id);
    return cell;
  }
  /** What a used item leaves (an empty bottle): used from a belt slot that now holds nothing (the last one was used),
   *  it takes that slot. Into the bag: 1. onto a stack of it with room, 2. into the cell the used one emptied,
   *  3. into a free cell (give's way). */
  function leaveItem(c, p, id, cell, from, ev) {
    var list = p.inventory, max = stackMaxOf(c, id), qty = 1, b = from && from.w === 'belt' ? Number(from.s) : -1;
    if (b >= 0 && b < BELT_SIZE && cell === BELT_AT + b && !beltStack(p, b)) { list.push({ item: id, qty: 1, s: cell }); qty = 0; }   // (it stays in hand)
    list.slice().sort(function (a, b) { return a.s - b.s; }).forEach(function (st) {
      if (qty > 0 && st.item === id && st.qty < max) { st.qty += 1; qty = 0; }
    });
    if (qty > 0 && cell >= 0 && cell < bagSlots(c) && !list.some(function (st) { return st.s === cell; })) { list.push({ item: id, qty: 1, s: cell }); qty = 0; }
    if (qty > 0) give(c, p, id, qty, ev, true);
    ev.push({ type: 'loot', to: p.id, map: p.map, x: p.x, y: p.y, item: id, qty: 1, text: '+1 ' + itemName(c, id) });
  }
  function take(p, id, qty) {
    if (id === 'gold') { if (p.gold < qty) return false; p.gold -= qty; return true; }
    if (countIn(p.inventory, id) < qty) return false;
    removeStacks(p.inventory, id, qty);
    goneFromBag(p, id);
    return true;
  }
  /** One roll of a loot table. A row marked with a quest only rolls for a player (p) who is on that quest and still needs the item. */
  function roll(c, table, rng, p) {
    var out = [];
    (c.loot[table] || []).forEach(function (r) {
      if (r.quest && !questNeeds(c, p, r.quest, r.item)) return;
      if (rng() < r.chance) out.push({ item: r.item, qty: rint(rng, r.min, r.max) });
    });
    return out;
  }
  function questNeeds(c, p, questId, item) {
    var q = (c.quests || {})[questId];
    if (!q || !p || !(p.quests || {})[questId]) return false;
    return q.goals.some(function (g) { return (g.type === 'have' || g.type === 'own') && g.ref === item && count(p, item) < g.need; });
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
    var old = {}, freed = (ms.monsters || []).filter(function (m) { return m.free; });   // tamed animals belong to no spawner: they stay whatever the spawners do
    (ms.monsters || []).forEach(function (m) { old[m.id] = m; });
    ms.monsters = want.map(function (w) {
      var m = old[w.id];
      if (m && m.ref === w.ref) { ensureLook(c, m, rng); return m; }    // reused: keep it, but give it a look if it lacks one
      m = { id: w.id, ref: w.ref, spawn: w.e.key, x: w.e.x, y: w.e.y, hp: c.monsters[w.ref].hp, dead: false, last: now, respawnAt: 0, facing: 'S' };
      var look = rollLook(c, c.monsters[w.ref], rng || Math.random);     // random paper-doll look, fixed for this instance
      if (look) m.look = look;
      place(c, ws, mapId, m, w.e, w.radius, w.i);
      return m;
    }).concat(freed);
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
      var after = m.engaged === p.id || !!(m.ai && m.ai.k === 'p' && m.ai.id === p.id);
      if (def.brain === 'walker' ? !after : (!after && Math.abs(m.x - x) + Math.abs(m.y - y) > def.aggro)) return;
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
  // ------------------------------------------------------------ things that appear on the ground by themselves
  // Two sources, both leaving ordinary pickups (the built-in '_drop', as a hen's egg):
  //   - an OBJECT with properties.drops (an item list) lets one of them fall on a free tile within drop_radius (2)
  //     every drop_s seconds, while fewer than drop_max (3) of its items lie within that radius. A felled one drops nothing.
  //   - a TERRAIN with 'grows' (an item list) grows one per 100 of its tiles every grow_s seconds, on a tile where it
  //     is the ground you see (the overlay, else the base), while fewer than grow_max (2) of that item lie within
  //     GROW_NEAR tiles (an 11x11 square, about 100 tiles).
  // A map only runs while someone is on it, so the time away is caught up on return (Config growth_catchup_s, 1800).
  // Nothing here grows with the size of the map: a round (every Config growth_round_s, 10) looks at GROW_TRIES
  // sources of each kind, picked at random, and Config ground_item_cap (150) bounds what lies on one map.
  var GROW_TRIES = 4, GROW_NEAR = 5;
  /** What can drop or grow on a map, worked out once from the authored map: { objs: [entity], tiles: [{ id, cells }] }. */
  function growSources(c, mapId) {
    var base = c.maps[mapId];
    if (!base) return { objs: [], tiles: [] };
    if (base._grow) return base._grow;
    var objs = [], by = {}, tiles = [], ov = base.overlay && base.overlay.length ? base.overlay : null;
    (base.entities || []).forEach(function (e) { var o = objOf(c, e), pr = o && o.properties; if (pr && pr.drops && Number(pr.drop_s) > 0) objs.push(e); });
    for (var y = 0; y < base.height; y++) for (var x = 0; x < base.width; x++) {
      var tid = (ov && ov[y] && ov[y][x]) || (base.terrain[y] && base.terrain[y][x]), t = tid && c.terrain[tid];
      if (t && t.grows && t.growS > 0) (by[tid] = by[tid] || []).push(y * base.width + x);
    }
    Object.keys(by).forEach(function (k) { tiles.push({ id: k, cells: by[k] }); });
    var out = { objs: objs, tiles: tiles };
    Object.defineProperty(base, '_grow', { value: out, enumerable: false, writable: true, configurable: true });
    return out;
  }
  function growStep(c, ws, mapId, map, ms, now, rng) {
    var src = growSources(c, mapId), drop = c.objects._drop;
    if (!drop || (!src.objs.length && !src.tiles.length)) return;
    var roundMs = Math.max(2, cfgNum(c, 'growth_round_s', 10)) * 1000;
    if (!ms.growAt) { ms.growAt = now + roundMs; ws.dirty = true; return; }
    if (now < ms.growAt) return;
    var rounds = Math.min(1 + Math.floor((now - ms.growAt) / roundMs), Math.max(1, Math.round(cfgNum(c, 'growth_catchup_s', 1800) * 1000 / roundMs)));
    ms.growAt = now + roundMs; ws.dirty = true;
    var st = structOf(ws, mapId), cap = cfgNum(c, 'ground_item_cap', 150), sec = roundMs / 1000, changed = false;
    var lying = st.ents.filter(function (b) { return b.ref === drop.id; });
    function what(b) { return String((b.data && b.data.pickup) || '').split(':')[0]; }
    function near(ids, x, y, r) { var n = 0; for (var i = 0; i < lying.length; i++) if (cheb(lying[i].x, lying[i].y, x, y) <= r && ids.indexOf(what(lying[i])) >= 0) n++; return n; }
    function free(x, y) { return x >= 0 && y >= 0 && x < map.width && y < map.height && Rl().standable(c, map, x, y) && !Rl().entitiesAt(map, x, y).length && !lying.some(function (b) { return b.x === x && b.y === y; }); }
    function put(x, y, g) {
      var b = { key: mapId + '.b' + (++st.n), x: x, y: y, ref: drop.id, data: { pickup: g.item + ':' + (g.qty || 1) }, hp: 0, max: 0, bp: '', by: null, built: now, prog: 0, need: 0, wild: true };
      st.ents.push(b); lying.push(b); changed = true;
    }
    for (var r = 0; r < rounds && lying.length < cap; r++) {
      var n = src.objs.length, k = Math.min(n, GROW_TRIES);
      for (var i = 0; i < k && lying.length < cap; i++) {
        var e = src.objs[rint(rng, 0, n - 1)], pr = props(c, e), every = Number(pr.drop_s) || 0;
        if (!(every > 0) || rng() >= sec / every * n / k) continue;              // (each one gets its turn once in drop_s, on average)
        if (st.gone && st.gone[e.key]) continue;                                 // cut down: nothing falls from it
        var items = list(pr.drops); if (!items.length) continue;
        var rad = Math.max(1, Math.min(6, Math.round(Number(pr.drop_radius) || 2))), max = Math.max(1, Math.round(Number(pr.drop_max) || 3));
        if (near(items.map(function (g) { return g.item; }), e.x, e.y, rad) >= max) continue;
        // It lands on ground at the height the thing stands at (a tree on a ledge keeps its branches on the ledge);
        // only when no such tile turns up does it settle for any free tile nearby.
        var lvl = Rl().groundHeight(map, e.x + 0.5, e.y + 0.5), same = [], other = [];
        for (var y = e.y - rad; y <= e.y + rad; y++) for (var x = e.x - rad; x <= e.x + rad; x++) {
          if ((x === e.x && y === e.y) || !free(x, y)) continue;
          (Math.abs(Rl().groundHeight(map, x + 0.5, y + 0.5) - lvl) < 0.5 ? same : other).push({ x: x, y: y });
        }
        var spots = same.length ? same : other;
        if (spots.length) { var sp = spots[rint(rng, 0, spots.length - 1)]; put(sp.x, sp.y, items[rint(rng, 0, items.length - 1)]); }
      }
      for (var j = 0; j < src.tiles.length; j++) {
        var T = src.tiles[j], tt = c.terrain[T.id], grows = tt ? list(tt.grows) : [];
        if (!grows.length) continue;
        var want = T.cells.length / 100 * sec / tt.growS, tries = Math.min(GROW_TRIES, Math.floor(want) + (rng() < want % 1 ? 1 : 0));
        for (var q = 0; q < tries && lying.length < cap; q++) {
          var cell = T.cells[rint(rng, 0, T.cells.length - 1)], gx = cell % map.width, gy = Math.floor(cell / map.width);
          var seen = (map.overlay && map.overlay[gy] && map.overlay[gy][gx]) || (map.terrain[gy] && map.terrain[gy][gx]);
          if (seen !== T.id) continue;                                           // built over since
          var g = grows[rint(rng, 0, grows.length - 1)];
          if (near([g.item], gx, gy, GROW_NEAR) >= tt.growMax || !free(gx, gy)) continue;
          put(gx, gy, g);
        }
      }
    }
    if (changed) touchStruct(st);
  }

  function advanceFloors(c, ws, mapId, playersOn, now, rng, ev) {
    floorsOf(c, mapId).forEach(function (f) {
      if (f.id !== mapId && c.maps[f.id]) advance(c, ws, f.id, (playersOn && playersOn(f.id)) || [], now, rng, ev);
    });
  }

  // ------------------------------------------------------------ monster brains
  // Each monster def names a brain (Monsters → brain). '' is the plain one in advance(): go for whoever is within
  // aggro range, in a straight line. 'walker' is walkerStep below.
  /** A ranged monster's shot at a player `dist` tiles away, if it has one ready and a clear line. True = it fired. */
  function monsterShot(c, ws, mapId, map, m, def, ms2, target, dist, now, rng, ev) {
    if (!(def.attackRange > 1 && dist > 1 && dist <= def.attackRange && now >= (m.nextShot || 0) && !watching(c, target, now) &&
        canSee(c, map, m.x, m.y, target.x, target.y, function (e) { return stateOf(c, ws, mapId, e); }))) return false;
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
    return true;
  }
  /** A monster's blow at the player beside it. True = that killed them. */
  function monsterSwing(c, ws, mapId, m, def, ms2, target, now, rng, ev) {
    if (watching(c, target, now)) return false;                // watching a scene: nothing hurts them
    var dmg = damage(ms2.atk, stats(c, target).def, rng);
    target.hp -= dmg;
    m.facing = target.x > m.x ? 'E' : target.x < m.x ? 'W' : target.y > m.y ? 'S' : 'N';
    ev.push({ type: 'hit', map: mapId, x: target.x, y: target.y, amount: dmg, to: target.id, text: 'The ' + lower(def.name) + ' hits you for ' + dmg + '.' });
    if (target.hp <= 0) { die(c, ws, target, ev); return true; }
    if (def.infectChance && rng() < def.infectChance) applyInfection(c, ws, mapId, target, now, ev);
    return false;
  }
  // ------------------------------------------------------------ animals (Monsters brain: animal | hunter)
  // animal: never attacks. It wanders (roamStep) and runs from whatever comes within its flee_range: players, and
  //   the monsters that hunt (brain hunter or walker). Hurt, it runs from whoever hurt it, from further off.
  //   One with tame_with does not run from a player HOLDING that item, and using it then feeds it: it is that player's
  //   (m.tame, m.owner), leaves its spawner (m.free: a new wild one grows there in time) and lives around its home
  //   (m.home: the nearest coop — an object of kind coop — within Config coop_range, else where it was tamed).
  //   A tame one with a coop leaves its `lays` object on the ground every lay_s seconds (an egg to pick up).
  // hunter: goes for the nearest prey animal or player within aggro_range, bites what it reaches, and after a
  //   kill it has eaten: for a while it only minds players who come close.
  // Killed, a monster leaves a loot bag where it fell (hitMonster, lootBox); Monsters `carcass` only says what that
  //   bag looks like.
  var TAME_LEASH = 3, HUNTER_FED_MS = 40000;
  // WHERE LOOT COMES TO LIE: always a loot bag (there are no carcasses apart from them), never straight into a
  // player's bag: a full bag would lose it. The owner's rules (26 Nov 2026), in order:
  //  The tile it fell on —
  //   1. nothing on it: a new bag there;
  //   2. a loot bag on it: the loot joins that bag, whose time to rot starts again;
  //   3. only DISPENSABLE items on the ground there (Items `dispensable`: branches, rocks): a new bag there, and
  //      those items go inside it;
  //  anything else on it (an item that is not dispensable, an object) — the tiles around, nearest first: those one
  //  can WALK to from there (walls, shut doors and cliffs in the way count), on the same level of ground, at most
  //  DROP_REACH steps off —
  //   4. the nearest free one: a new bag there;
  //   5. none free: the nearest holding only dispensable items, as in 3;
  //   6. none: it joins the nearest loot bag among them, as in 2;
  //   7. not even one: a new bag on the tile it fell on, sharing it with what is there.
  // An item that is not dispensable is never moved, covered up elsewhere than in 7, or put in a bag.
  var DROP_REACH = 3, UNSEEN_KINDS = { spawn: 1, trigger: 1 };
  function lootSpot(c, st, map, x, y) {
    var R = Rl(), h0 = R.heightAt(map, x, y), seen = {}, q = [{ x: x, y: y, d: 0 }], spare = null, box = null, drop = c.objects._drop;
    function things(a, b) {                                     // what is on a tile: not what hangs on a wall, nor what nobody sees (a spawn point, a trigger)
      return R.entitiesAt(map, a, b).filter(function (e) { var o = objOf(c, e); return !isWallFixture(o) && !(o && UNSEEN_KINDS[o.kind]); });
    }
    function dispensable(e) {                                   // a thing on the ground that grew or was left there, all of it dispensable
      if (!drop || e.ref !== drop.id || !e.wild || !st.ents.some(function (s) { return s.key === e.key; })) return false;
      var got = list(e.data && e.data.pickup);
      return got.length > 0 && got.every(function (g) { return c.items[g.item] && c.items[g.item].dispensable; });
    }
    function bagOn(on) { return on.filter(function (e) { return e.wild && Array.isArray(e.inv); })[0] || null; }
    function takes(at, on) { return { x: at.x, y: at.y, take: on.map(function (e) { return e.key; }) }; }
    seen[x + ',' + y] = 1;
    for (var i = 0; i < q.length; i++) {
      var at = q[i];
      if (!at.d || R.heightAt(map, at.x, at.y) === h0) {
        var on = things(at.x, at.y), bag = bagOn(on);
        if (!on.length) return { x: at.x, y: at.y };
        if (!at.d && bag) return { box: bag.key };              // where it fell: a bag, or only dispensable things, settles it
        if (!at.d && on.every(dispensable)) return takes(at, on);
        if (!spare && on.every(dispensable)) spare = takes(at, on);
        if (!box && bag) box = bag;
      }
      if (at.d >= DROP_REACH) continue;
      for (var k = 0; k < 4; k++) {
        var r = R.tryMove(c, map, at.x, at.y, 'NESW'.charAt(k));
        if (!r.ok || r.map || seen[r.x + ',' + r.y]) continue;
        seen[r.x + ',' + r.y] = 1; q.push({ x: r.x, y: r.y, d: at.d + 1 });
      }
    }
    return spare || (box ? { box: box.key } : { x: x, y: y });
  }
  /** The loot bag (object o: lootBagOf) for what falls at (x, y): a new one where lootSpot says, or
   *  the one it joins. Its time to rot starts now. Returns the struct entity (its inv is an array), or null. */
  function lootBox(c, ws, mapId, x, y, o, now) {
    var st = structOf(ws, mapId), ms = mapState(ws, mapId), map = liveMap(c, ws, mapId); if (!o || !map) return null;
    var spot = lootSpot(c, st, map, x, y), box = null;
    if (spot.box) box = st.ents.filter(function (b) { return b.key === spot.box; })[0] || null;
    if (!box) {
      if (spot.box) spot = { x: x, y: y };
      var max = Number((o.properties || {}).hp) || 0;
      box = { key: mapId + '.b' + (++st.n), x: spot.x, y: spot.y, ref: o.id, data: {}, hp: max, max: max, bp: '', by: null, built: now, prog: 0, need: 0, wild: true, inv: [] };
      (spot.take || []).forEach(function (key) {                // the dispensable things that lay there: into the bag
        var e = st.ents.filter(function (b) { return b.key === key; })[0]; if (!e) return;
        list(e.data && e.data.pickup).forEach(function (g) { if (c.items[g.item] && g.qty > 0) addStacks(c, box.inv, g.item, g.qty, 0); });
        st.ents = st.ents.filter(function (b) { return b.key !== key; }); delete ms.timers[key];
      });
      st.ents.push(box);
    }
    ms.timers[box.key] = { at: now + Math.max(10, cfgNum(c, 'loot_bag_rot_s', 900)) * 1000, rot: true };
    touchStruct(st); ws.dirty = true;
    return box;
  }
  /** The loot bag a monster leaves: the object named in Monsters `carcass` (its own look: a dead rabbit), else the
   *  standard one. Whatever it looks like it IS a loot bag: same rules, same time to rot. */
  function lootBagOf(c, def) { return (def && def.carcass && c.objects[def.carcass]) || bagObject(c); }
  /** One step toward (tx, ty), the way the plain brain walks: the long axis first, cutting a corner when it may. */
  function stepToward(c, ws, mapId, map, m, here, tx, ty, stepMs) {
    var dx = tx - m.x, dy = ty - m.y, dirs = [];
    if (!dx && !dy) return false;
    if (Math.abs(dx) >= Math.abs(dy)) { dirs.push(dx > 0 ? 'E' : 'W'); if (dy) dirs.push(dy > 0 ? 'S' : 'N'); }
    else { dirs.push(dy > 0 ? 'S' : 'N'); if (dx) dirs.push(dx > 0 ? 'E' : 'W'); }
    if (dx && dy) dirs.unshift((dy > 0 ? 'S' : 'N') + (dx > 0 ? 'E' : 'W'));
    for (var i = 0; i < dirs.length; i++) {
      var r = Rl().tryMove(c, map, m.x, m.y, dirs[i], moveOpts(c, ws, mapId, here, m));
      if (r.ok && !r.map) { m.x = r.x; m.y = r.y; m.facing = Rl().faceFor(dirs[i], m.facing); m.last += (Rl().stepCost(dirs[i], c, map, m.x, m.y) - 1) * stepMs; return true; }
    }
    return false;
  }
  /** One step away from (tx, ty): of the eight ways, the open one that ends furthest from it. */
  function stepAway(c, ws, mapId, map, m, here, tx, ty, stepMs) {
    var best = null, bd = (m.x - tx) * (m.x - tx) + (m.y - ty) * (m.y - ty), opts = moveOpts(c, ws, mapId, here, m);
    ['N', 'E', 'S', 'W', 'NE', 'SE', 'SW', 'NW'].forEach(function (dir) {
      var r = Rl().tryMove(c, map, m.x, m.y, dir, opts); if (!r.ok || r.map) return;
      var d = (r.x - tx) * (r.x - tx) + (r.y - ty) * (r.y - ty);
      if (d > bd) { bd = d; best = { r: r, dir: dir }; }
    });
    if (!best) return false;
    m.x = best.r.x; m.y = best.r.y; m.facing = Rl().faceFor(best.dir, m.facing); m.last += (Rl().stepCost(best.dir, c, map, m.x, m.y) - 1) * stepMs;
    return true;
  }
  function coopNear(c, map, x, y, range) {
    var best = null, bd = 1e9;
    (map.entities || []).forEach(function (e) {
      var o = objOf(c, e); if (!o || o.kind !== 'coop' || (e.need && (e.prog || 0) < e.need)) return;
      var d = cheb(x, y, e.x, e.y); if (d <= range && d < bd) { bd = d; best = e; }
    });
    return best;
  }
  function tame(c, ws, mapId, map, ms, m, def, p, now) {
    // its spawner grows a new wild one in time; this one is on its own from here on
    if (m.spawn) {
      ms.monsters.push({ id: m.id, ref: m.ref, spawn: m.spawn, x: m.x, y: m.y, hp: def.hp, dead: true, last: now, respawnAt: now + (Number(def.respawnS) || 60) * 1000, facing: 'S' });
      ms.tn = (ms.tn || 0) + 1; m.id = 'tame' + ms.tn + '_' + String(m.ref).replace(/[^a-z0-9_]/gi, '');
      delete m.spawn;
    }
    m.free = true; m.tame = true; m.owner = p.id; m.engaged = null;
    var coop = coopNear(c, map, m.x, m.y, cfgNum(c, 'coop_range', 8));
    m.home = coop ? { x: coop.x, y: coop.y, coop: coop.key } : { x: m.x, y: m.y };
    m.layAt = now + Math.max(5, def.layS || 0) * 1000;
    ws.dirty = true;
    return !!coop;
  }
  // ---- stealth (docs/STEALTH.md, stage 1): what a monster notices of a player ----
  // Config stealth (on when not said) — off = the old rules exactly. A player who sneaks (p.sneak, action
  // {type: 'sneak', on}) walks Config sneak_slow (2) times slower (Rules.stepCost), is seen from Config sneak_sight
  // (0.6) of the usual range, and makes Config noise_sneak (2) tiles of noise instead of noise_walk (6). Standing still
  // makes none: noise lasts NOISE_LINGER_MS after the last step (p.stepAt).
  var NOISE_LINGER_MS = 900;
  function stealthOn(c) { var v = c && c.config && c.config.stealth; return v === undefined || v === '' || yes(v); }
  /** How far (in tiles) a player's own noise carries: sneaking or not, moving or not. The page asks it too (the meter). */
  function noiseRadius(c, sneak, moving) {
    if (!moving || !stealthOn(c)) return 0;
    return Math.max(0, sneak ? cfgNum(c, 'noise_sneak', 2) : cfgNum(c, 'noise_walk', 6));
  }
  function noiseOf(c, p, now) { return noiseRadius(c, !!p.sneak, !!p.stepAt && now - Number(p.stepAt) <= NOISE_LINGER_MS); }
  /** The loudest a player gets (walking): what the noise meter is full at. */
  /** How far (tiles) a thrown `it` is heard from where it lands: its own throw_noise, else Config throw_noise (6); 0 = silent. */
  function throwNoise(c, it) {
    var own = it ? Number(it.throwNoise) || 0 : 0;
    return own < 0 ? 0 : own > 0 ? own : Math.max(0, cfgNum(c, 'throw_noise', 6));
  }
  /** A noise at a spot that is nobody's footsteps (a thrown thing landing; owner, 27 Nov 2026): every monster within
   *  `radius` tiles (x its `hearing`), walls or not, that is after nobody hears it exactly as senseStep's `heard` — the ?,
   *  the wait, then it goes to look THERE (an animal runs from there). `by` = who made it (a walker's search remembers). */
  function soundAt(c, ws, mapId, x, y, radius, now, by) {
    if (!stealthOn(c) || !(radius > 0)) return;
    var ms = mapState(ws, mapId);
    (ms.monsters || []).forEach(function (m) {
      var def = c.monsters[m.ref]; if (!def || m.dead || m.tame || m.wait > now) return;
      var far = radius * (def.hearing == null ? 1 : def.hearing);
      if (!(far > 0) || cheb(m.x, m.y, x, y) > far) return;
      if (def.brain === 'hunter' && now < (m.fedUntil || 0)) return;
      if (def.brain === 'walker' ? m.ai && m.ai.k === 'p' : !!(m.chase || m.engaged)) return;   // after someone already
      var on = def.brain === 'animal' ? m.fleeFrom : def.brain === 'walker' ? null : m.goTo, id = by ? by.id : '';
      if (on) { on.x = x; on.y = y; on.until = now + (def.brain === 'animal' ? SCARE_MS : GOTO_MS); }
      else if (m.hear) { m.hear.x = x; m.hear.y = y; m.hear.id = id; }
      else m.hear = { x: x, y: y, at: now, id: id };
      ws.dirty = true;
    });
  }
  function noiseMax(c) { return Math.max(1, cfgNum(c, 'noise_walk', 6), cfgNum(c, 'noise_sneak', 2)); }
  /**
   * What monster m notices of player p: 'seen' | 'heard' | ''. The ONE question every brain asks about a player
   * (a monster that was struck knows who did it, apart from this). range = how far this brain looks: the walker's
   * sight_range, the hunter's and the plain one's aggro_range, the animal's flee_range.
   * Seen = within range (× sneak_sight while p sneaks) with a clear line of sight (canSee: the edge question).
   * Heard = within the radius of p's noise × Monsters hearing (1 when not said, 0 = deaf), walls or not.
   * Stealth off: within range = seen, through walls — but for o.los (the walker), which always needed to see.
   * o.manhattan: the plain brain measures distance that way.
   */
  function notices(c, map, m, def, p, now, range, stateFn, o) {
    o = o || {};
    if (watching(c, p, now)) return '';                        // watching a scene: nobody notices them
    var d = o.manhattan ? Math.abs(p.x - m.x) + Math.abs(p.y - m.y) : cheb(m.x, m.y, p.x, p.y);
    if (!stealthOn(c)) return d <= range && (!o.los || canSee(c, map, m.x, m.y, p.x, p.y, stateFn)) ? 'seen' : '';
    if (looksAt(c, map, m, range, p.sneak, p.x, p.y, stateFn, o.manhattan)) return 'seen';
    var hear = noiseOf(c, p, now) * (def.hearing == null ? 1 : def.hearing);
    return hear > 0 && d <= hear ? 'heard' : '';
  }
  // SPOTTED (owner, 25 Nov 2026). A monster that sees a sneaking player (or is struck by one and lives) makes them
  // stand up: spotted() is the one way that happens. While any monster on their map is after them — it has seen
  // them or been hit by them and not given up (chasedBy) — they cannot sneak again; advance keeps p.chased, and
  // tells them when the last one has lost interest.
  function spotted(c, p, m, ev) {
    if (!p || !p.sneak) return;
    delete p.sneak; p.wasSneak = true;                         // (wasSneak: they are reminded of Z when it is over)
    var def = m && c.monsters[m.ref];
    if (ev) ev.push({ type: 'info', to: p.id, text: (def ? 'The ' + lower(def.name) : 'Something') + ' spotted you!' });
  }
  /** Is any monster here after player p? (engaged = p hit it; chase = a plain or hunter brain that saw p; a walker's
   *  ai on p with spot = it has seen them, not only heard them.) */
  function chasedBy(ms, p) {
    return ((ms && ms.monsters) || []).some(function (m) {
      return !m.dead && (m.engaged === p.id || m.chase === p.id || !!(m.ai && m.ai.k === 'p' && m.ai.id === p.id && m.ai.spot));
    });
  }
  /** A plain or hunter brain's choice this turn, kept as m.chase: a player it SAW (or that struck it) is chased, and
   *  spotted; a player it only heard keeps whatever it was (it goes to look, it does not know who). */
  function chaseNote(c, m, target, saw, ev) {
    if (target && saw) { m.chase = target.id; delete m.hear; delete m.goTo; spotted(c, target, m, ev); }
    else if (!target || m.chase !== target.id) delete m.chase;
  }
  // PERCEPTION (owner, 25 Nov 2026). Every time the world moves on (advance), not only on a monster's own turn:
  //  - SEEN: it reacts at once. A walker hunts, a plain or hunter brain chases (! over its head), an animal runs;
  //    the sneaking player is spotted, and the monster's next turn is due now.
  //  - HEARD, unseen, while it is after nobody: surprised, it freezes where it stands, facing as it was (? over its
  //    head: m.hear = {x, y, at, id}); Config hear_delay_s (2) later it turns to the sound and goes to look where the sound was — a walker searches (breaking
  //    nothing), a plain or hunter brain walks there (m.goTo) — or, an animal, runs from that spot (m.fleeFrom).
  //    A new sound while it is already on its way only moves the spot.
  var GOTO_MS = 15000, SCARE_MS = 4000;
  function hearDelay(c) { return Math.max(0, cfgNum(c, 'hear_delay_s', 2)) * 1000; }
  function faceToward(m, x, y) {
    var dx = x - m.x, dy = y - m.y; if (!dx && !dy) return;
    m.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
  }
  function senseStep(c, ws, mapId, map, ms, here, now, sfn, ev) {
    if (!stealthOn(c) || !here.length) return;
    var loud = noiseMax(c), wake = cfgNum(c, 'walker_wake_radius', 24);
    ms.monsters.forEach(function (m) {
      var def = c.monsters[m.ref]; if (!def || m.dead || m.tame) return;
      var range = lookRange(def, m, now), reach = Math.max(range * coneReach(c), loud * (def.hearing == null ? 1 : def.hearing)) + 1;
      if (def.brain === 'walker') reach = Math.min(reach, wake);   // (an inert walker senses nothing: see walkerStep)
      var o = { manhattan: !def.brain, los: def.brain === 'walker' }, seen = null, sd = 1e9, heard = null, hd = 1e9;
      here.forEach(function (q) {
        var d = cheb(q.x, q.y, m.x, m.y); if (d > reach) return;
        if (def.brain === 'animal' && def.tameWith && (heldItem(c, q) || {}).id === def.tameWith) return;   // feed in hand: nothing to fear
        var how = notices(c, map, m, def, q, now, range, sfn, o);
        if (how === 'seen' && d < sd) { sd = d; seen = q; } else if (how === 'heard' && d < hd) { hd = d; heard = q; }
      });
      var due = false, wasAfter = !!(m.engaged || m.chase || (m.ai && m.ai.k === 'p' && m.ai.s));   // (already after someone: no hurry-up)
      if (seen) {
        if (def.brain === 'walker') {
          if (!(m.ai && m.ai.k === 'p' && m.ai.id === seen.id && m.ai.s)) { m.ai = { k: 'p', id: seen.id, a: (def.aggroS > 0 ? def.aggroS : 30) * 1000, x: seen.x, y: seen.y, s: 1, spot: 1 }; due = true; }
        } else if (def.brain === 'animal') { if (!m.fleeFrom || m.fleeFrom.id !== seen.id) due = true; m.fleeFrom = { x: seen.x, y: seen.y, until: now + SCARE_MS, id: seen.id }; }
        else if (m.chase !== seen.id && !(def.brain === 'hunter' && m.engaged)) { m.chase = seen.id; due = true; }
        if (m.hear || m.goTo) { delete m.hear; delete m.goTo; }
        spotted(c, seen, m, ev);
      } else if (heard && !(def.brain === 'hunter' && now < (m.fedUntil || 0))) {
        var busy = def.brain === 'walker' ? m.ai && m.ai.k === 'p' : !!(m.chase || m.engaged);   // after someone already: its own brain tracks the sound
        if (!busy) {
          var on = def.brain === 'animal' ? m.fleeFrom : def.brain === 'walker' ? null : m.goTo;
          if (on) { on.x = heard.x; on.y = heard.y; on.until = now + (def.brain === 'animal' ? SCARE_MS : GOTO_MS); }
          else if (m.hear) { m.hear.x = heard.x; m.hear.y = heard.y; m.hear.id = heard.id; }
          else { m.hear = { x: heard.x, y: heard.y, at: now, id: heard.id }; ws.dirty = true; }   // surprised: it freezes as it is (it turns only when the wait is over)
        }
      }
      if (due && !wasAfter && !(m.wait > now)) {
        ws.dirty = true;
        var stepMs = def.moveMs * monStats(c, m).slow; if (!((now - m.last) >= stepMs)) m.last = now - stepMs;   // its turn is now
      }
    });
  }
  /** A monster that heard something and is waiting before it goes to look: true while it should stand still. Once
   *  the wait is over, the sound becomes where it goes (plain, hunter: m.goTo) or what it runs from (animal). */
  function listening(c, m, def, now) {
    if (!m.hear) return false;
    if (now - m.hear.at < hearDelay(c)) return true;
    var h = m.hear; delete m.hear;
    faceToward(m, h.x, h.y);                                  // the surprise is over: it turns to the sound (an animal then runs from it)
    if (def.brain === 'animal') m.fleeFrom = { x: h.x, y: h.y, until: now + SCARE_MS };
    else if (def.brain !== 'walker') m.goTo = { x: h.x, y: h.y, until: now + GOTO_MS };
    return false;
  }
  /** A plain or hunter brain on its way to a sound (m.goTo): one step there; gone once it arrives or tires of it. */
  function goToStep(c, ws, mapId, map, m, here, now, stepMs) {
    var g = m.goTo; if (!g) return false;
    if (now > g.until || (m.x === g.x && m.y === g.y)) { delete m.goTo; return false; }
    var x0 = m.x, y0 = m.y;
    stepToward(c, ws, mapId, map, m, here, g.x, g.y, stepMs);
    if (m.x === x0 && m.y === y0 && cheb(m.x, m.y, g.x, g.y) <= 1) delete m.goTo;   // (as near as it can get)
    return true;
  }
  /** How far a monster that looks `range` tiles sees a player, sneaking or not. */
  function seeRange(c, range, sneak) { return sneak && stealthOn(c) ? range * Math.max(0, cfgNum(c, 'sneak_sight', 0.6)) : range; }
  // FACING (stage 3). A monster sees its full range only within a cone in front of it: Config sight_cone degrees
  // wide (60; 360 = all round), centred on m.facing, and Config cone_reach (1.5) times as far as its range there. Anywhere else it sees Config back_sight times as far (0 = not
  // at all: it must hear you). Its own cell counts as in front.
  function inCone(c, m, x, y) {
    var dx = x - m.x, dy = y - m.y; if (!dx && !dy) return true;
    var deg = cfgNum(c, 'sight_cone', 60); if (!(deg < 360)) return true;
    var f = Rl().DIRS[m.facing] || Rl().DIRS.S;
    return (dx * f.dx + dy * f.dy) / Math.sqrt(dx * dx + dy * dy) >= Math.cos(Math.max(0, deg) / 2 * Math.PI / 180) - 1e-9;
  }
  /** Would monster m (looking `range` tiles) see a player standing at (x, y)? Reach (sneaking shrinks it, the cone
   *  turns it), then line of sight. notices and sightArea both ask this, so the drawing never lies. */
  function looksAt(c, map, m, range, sneak, x, y, stateFn, man) {
    // With a cone (sight_cone under 360): straight-line distance, so the fan ends in a rounded tip, long rather than
    // wide. Seeing all round, the brain's own measure (Chebyshev, or Manhattan for the plain brain), as before.
    var d = cfgNum(c, 'sight_cone', 60) < 360 ? Math.round(Math.sqrt((x - m.x) * (x - m.x) + (y - m.y) * (y - m.y)) * 10) / 10
      : man ? Math.abs(x - m.x) + Math.abs(y - m.y) : cheb(m.x, m.y, x, y);
    var r = seeRange(c, range, sneak) * (inCone(c, m, x, y) ? coneReach(c) : Math.min(1, Math.max(0, cfgNum(c, 'back_sight', 0))));
    return d <= r && canSee(c, map, m.x, m.y, x, y, stateFn);
  }
  /** How much further a monster sees straight ahead, inside its cone, than its range says (Config cone_reach, 1.5:
   *  the owner wanted the cone longer rather than wider). A monster that sees all round (sight_cone 360) has no
   *  "ahead": 1. */
  function coneReach(c) {
    if (!(cfgNum(c, 'sight_cone', 60) < 360)) return 1;
    return Math.max(1, cfgNum(c, 'cone_reach', 1.5));
  }
  /** How far each brain looks for players (what it passes to notices): walker sight_range (else aggro_range), animal
   *  flee_range (else aggro_range, else 4), hunter aggro_range (2 while fed after a kill), plain aggro_range. */
  function lookRange(def, m, now) {
    if (def.brain === 'walker') return def.sight > 0 ? def.sight : def.aggro;
    if (def.brain === 'animal') return def.fleeRange || def.aggro || 4;
    if (def.brain === 'hunter') return m && now < (m.fedUntil || 0) ? 2 : def.aggro || 6;
    return def.aggro;
  }
  /**
   * Where monster m would SEE a player (notices → 'seen'): {"x,y": 1}. Only for the page (the sight areas drawn
   * while sneaking); the rules ask notices. sneak = the player sneaks (the area shrinks by sneak_sight).
   */
  function sightArea(c, map, m, def, sneak, stateFn, now) {
    var out = {}, range = lookRange(def, m, now || 0), st = stealthOn(c), r = st ? seeRange(c, range, sneak) : range, R = Math.floor(st ? r * coneReach(c) : r);
    var man = !def.brain, los = st || def.brain === 'walker', x, y;
    if (!(def.brain === 'animal' && m.tame)) for (y = Math.max(0, m.y - R); y <= Math.min(map.height - 1, m.y + R); y++) for (x = Math.max(0, m.x - R); x <= Math.min(map.width - 1, m.x + R); x++) {
      if (st) { if (looksAt(c, map, m, range, sneak, x, y, stateFn, man)) out[x + ',' + y] = 1; continue; }
      var d = man ? Math.abs(x - m.x) + Math.abs(y - m.y) : cheb(m.x, m.y, x, y);
      if (d <= r && (!los || canSee(c, map, m.x, m.y, x, y, stateFn))) out[x + ',' + y] = 1;
    }
    return out;
  }
  function animalStep(c, ws, mapId, map, ms, m, def, here, now, rng, stepMs, sfn, ev) {
    var range = lookRange(def, m, now), threat = null, best = 1e9, seenP = null;
    if (!m.tame) here.forEach(function (q) {
      var d = cheb(q.x, q.y, m.x, m.y); if (d > range || d >= best) return;
      if (def.tameWith && (heldItem(c, q) || {}).id === def.tameWith) return;          // feed in hand: nothing to fear
      var how = notices(c, map, m, def, q, now, range, sfn);
      if (how !== 'seen') return;                                                       // (a sound: senseStep — it listens, then runs from the spot)
      best = d; threat = q; seenP = q;
    });
    if (seenP && seenP === threat) spotted(c, seenP, m, ev);                          // (it runs: it does not hunt them, so it is never after them)
    if (!threat && !m.tame && stealthOn(c)) {
      if (listening(c, m, def, now)) return;                                           // ? — it heard something, and waits
      var ff = m.fleeFrom, scarer = ff && ff.id ? here.filter(function (q) { return q.id === ff.id; })[0] : null;
      if (scarer && def.tameWith && (heldItem(c, scarer) || {}).id === def.tameWith) { delete m.fleeFrom; ff = null; }   // they hold out its feed now: calm
      if (ff && now < ff.until && cheb(m.x, m.y, ff.x, ff.y) <= range * 2 + 2) { stepAway(c, ws, mapId, map, m, here, ff.x, ff.y, stepMs); return; }
      if (ff) delete m.fleeFrom;
    }
    ms.monsters.forEach(function (q) {
      var qd = c.monsters[q.ref]; if (q === m || q.dead || !qd || qd.prey || (qd.brain !== 'hunter' && qd.brain !== 'walker')) return;
      var d = cheb(q.x, q.y, m.x, m.y); if (d <= range && d < best) { best = d; threat = q; }
    });
    if (!threat && m.engaged) {                                                        // hurt: away from whoever did it, from twice as far
      var eng = here.filter(function (q) { return q.id === m.engaged; })[0];
      if (eng && cheb(eng.x, eng.y, m.x, m.y) <= range * 2 + 2) threat = eng; else m.engaged = null;
    }
    if (threat) { stepAway(c, ws, mapId, map, m, here, threat.x, threat.y, stepMs); return; }
    if (!m.tame) { roamStep(c, ws, mapId, map, m, here, rng); return; }
    // tame: it keeps to its home, and lays there
    var h = m.home || (m.home = { x: m.x, y: m.y });
    if (!h.coop) { var cp = coopNear(c, map, h.x, h.y, cfgNum(c, 'coop_range', 8)); if (cp) { h.x = cp.x; h.y = cp.y; h.coop = cp.key; } }   // a coop built since: it moves in
    else if (!(map.entities || []).some(function (e) { return e.key === h.coop; })) delete h.coop;                                           // its coop is gone
    if (cheb(m.x, m.y, h.x, h.y) > TAME_LEASH) stepToward(c, ws, mapId, map, m, here, h.x, h.y, stepMs);
    else if (rng() < 0.4) {
      var dir = 'NESW'.charAt(rint(rng, 0, 3)), r = Rl().tryMove(c, map, m.x, m.y, dir, moveOpts(c, ws, mapId, here, m));
      if (r.ok && !r.map && cheb(r.x, r.y, h.x, h.y) <= TAME_LEASH) { m.x = r.x; m.y = r.y; m.facing = dir; }
    }
    var egg = list(def.lays).length ? c.objects._drop : null;
    if (egg && h.coop && def.layS > 0 && now >= (m.layAt || 0)) {
      m.layAt = now + def.layS * 1000;
      var st = structOf(ws, mapId), lying = st.ents.filter(function (b) { return b.ref === egg.id && cheb(b.x, b.y, h.x, h.y) <= TAME_LEASH + 1; }).length;
      var taken = (map.entities || []).some(function (e) { return e.x === m.x && e.y === m.y && !isWallFixture(objOf(c, e)); });
      if (lying < cfgNum(c, 'egg_cap', 6) && !taken) {
        st.ents.push({ key: mapId + '.b' + (++st.n), x: m.x, y: m.y, ref: egg.id, data: { pickup: def.lays }, hp: 0, max: 0, bp: '', by: null, built: now, prog: 0, need: 0, wild: true });
        touchStruct(st); ws.dirty = true;
      }
    }
  }
  function hunterStep(c, ws, mapId, map, ms, m, def, ms2, here, now, rng, ev, stepMs, engageRange, sfn) {
    var range = def.aggro || 6, fed = now < (m.fedUntil || 0), target = null, kind = '', best = 1e9;
    var eng = m.engaged ? here.filter(function (q) { return q.id === m.engaged; })[0] : null;
    if (eng && cheb(eng.x, eng.y, m.x, m.y) <= engageRange) { target = eng; kind = 'p'; best = 0; } else if (m.engaged) m.engaged = null;
    var sawIt = !!target;                                         // (struck: it knows who did it)
    if (!target) here.forEach(function (q) {
      var d = cheb(q.x, q.y, m.x, m.y); if (d >= best) return;
      var how = notices(c, map, m, def, q, now, lookRange(def, m, now), sfn);
      // heard: only someone it is already after (it lost sight of them); a sound from nobody it is after is senseStep's
      if (how === 'seen' || (how === 'heard' && !fed && (m.chase === q.id || !stealthOn(c)))) { best = d; target = q; kind = 'p'; sawIt = how === 'seen'; }
    });
    chaseNote(c, m, kind === 'p' ? target : null, sawIt, ev);
    if (!target && !fed) ms.monsters.forEach(function (q) {
      var qd = c.monsters[q.ref]; if (q === m || q.dead || !qd || !qd.prey) return;
      var d = cheb(q.x, q.y, m.x, m.y); if (d <= range && d < best) { best = d; target = q; kind = 'm'; }
    });
    if (!target) {
      if (listening(c, m, def, now) || goToStep(c, ws, mapId, map, m, here, now, stepMs)) return '';   // ? : it heard something
      roamStep(c, ws, mapId, map, m, here, rng); return '';
    }
    if (cheb(m.x, m.y, target.x, target.y) === 1 && !moveBlockedEdge(c, map, m.x, m.y, target.x, target.y)) {
      if (kind === 'p') monsterSwing(c, ws, mapId, m, def, ms2, target, now, rng, ev);
      else {
        m.facing = target.x > m.x ? 'E' : target.x < m.x ? 'W' : target.y > m.y ? 'S' : 'N';
        hitMonster(c, ws, mapId, null, target, damage(ms2.atk, monStats(c, target).def, rng), now, rng, ev, '');
        if (target.dead) m.fedUntil = now + HUNTER_FED_MS;
      }
      return 'stop';
    }
    stepToward(c, ws, mapId, map, m, here, target.x, target.y, stepMs);
    return '';
  }
  /** Idle wandering near its spawn point; away from home it drifts back. */
  function roamStep(c, ws, mapId, map, m, here, rng) {
    if (!(rng() < 0.5)) return;
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
    if (r2.ok && !r2.map && (!sp || away || (Math.abs(r2.x - sp.x) <= rad && Math.abs(r2.y - sp.y) <= rad))) { m.x = r2.x; m.y = r2.y; }
    m.facing = dir;                                            // where it cannot step, it still turns and looks that way (its sight cone)
  }
  function millStep(c, ws, mapId, map, m, here, rng) {
    var dir = 'NESW'.charAt(rint(rng, 0, 3)), r = Rl().tryMove(c, map, m.x, m.y, dir, moveOpts(c, ws, mapId, here, m));
    if (r.ok && !r.map) { m.x = r.x; m.y = r.y; m.facing = dir; }
  }

  // ---- the walker ----
  // What a walker carries between turns, in the map's record (so it survives everyone leaving): m.ai =
  //   {k: 'p' a player | 'm' a prey monster | 's' something players built, id / t: who or what,
  //    a: aggro left in ms, x, y: where it last knew its target to be,
  //    p: the way it worked out ("NNEES"), g: where that way leads, n: turns to wait before working one out again,
  //    w: 1 = it is poking around where it lost them (walks only, breaks nothing)}
  // No m.ai = it is not after anything.
  //   INERT     no player within Config walker_wake_radius: it does not move or think at all.
  //   ROAM      a player is around: it wanders, and looks. Seeing a player or a prey animal (line of sight, within
  //             sight_range) or, failing those, something players built, starts the hunt.
  //   HUNT      while it sees its target, aggro stays full. It walks straight at it, or along a way it works out;
  //             what blocks that way and can be broken, it breaks (the cheapest way counts blows as steps, so a
  //             door goes before a wall and a short way round before either).
  //   SEARCH    target out of sight: aggro runs down, by the walker's OWN turns (so not while nobody is on the map
  //             and the world stands still). It makes for where it last saw them (within aggro_range it still hears
  //             them through walls), breaking in if it must, then pokes around. At zero it gives up.
  // Once hunting it needs no player nearby. It ends by losing interest, by winning (target dead or destroyed), or dying.
  /**
   * What a monster is up to, for the page to show over its head: 2 = it is after someone it can see (!),
   * 1 = it is looking for someone it lost (?), 0 = neither. Only brains that keep such a state (the walker) say more than 0.
   */
  function alertOf(m) {
    var ai = m && m.ai; if (ai) return ai.k !== 's' ? (ai.s ? 2 : 1) : 0;
    return !m ? 0 : m.chase ? 2 : m.hear || m.goTo ? 1 : 0;   // the other brains: after someone it saw (!), listening or going to a sound (?)
  }
  var WALKER_PATH = 24, WALKER_NODES = 320, WALKER_REACH = 18, WALKER_MAXCOST = 160;
  var WALKER_PLANS = 8;                                       // ways worked out per map per turn, whatever the size of the horde: the rest wait their turn
  function walkerCtx(c, ws, mapId, map) {
    var b = c.config.walkers_attack_buildings;
    return { map: map, stale: false, built: null, prey: null, obst: {}, budget: WALKER_PLANS, stateFn: function (e) { return stateOf(c, ws, mapId, e); },
      wake: cfgNum(c, 'walker_wake_radius', 24), buildings: b === undefined || b === '' || yes(b) };
  }
  /** Can something standing at (x, y) strike this wall or object (tg from resolveOn)? */
  function structReach(c, map, x, y, tg) {
    var cells = structCells(tg);
    if (tg.t === 'wall' || (tg.obj && isWallFixture(tg.obj))) return cells.some(function (q) { return q.x === x && q.y === y; });
    var d = cheb(x, y, tg.x, tg.y);
    return d === 0 || (d === 1 && !moveBlockedEdge(c, map, x, y, tg.x, tg.y));
  }
  /** How many of a monster's blows (dmg each) a wall or object takes to break; 0 = it cannot be broken that way. */
  function blowsToBreak(c, map, t, dmg) {
    var tg = resolveOn(c, map, map._struct, t); if (!tg || !tg.can || tg.hp <= 0) return 0;
    var mult = MULT.monster[tg.material]; if (mult === undefined) mult = 1;
    var dealt = Math.max(0, Math.round(dmg * mult) - tg.armor);
    return dealt > 0 ? Math.ceil(tg.hp / dealt) : 0;
  }
  /**
   * A step from (x, y) towards dir failed with answer r: what would have to be broken to make it, as
   * {t: target, hits} — the shut door or window on that edge, else the wall, else the object in the way — or null.
   */
  function obstacleFor(c, map, x, y, dir, r, dmg, ctx) {
    var k = x + ',' + y + dir + dmg; if (ctx.obst[k] !== undefined) return ctx.obst[k];
    var cands = [], R = Rl(), d = R.DIRS[dir];
    if (r.reason === 'wall' || r.reason === 'door') {
      var ed = R.wallEdge(x, y, dir), ov = map._edgeOv && map._edgeOv[R.edgeKey(ed.orient, ed.x, ed.y)];
      var tt = R.terrainAt(c, map, x + d.dx, y + d.dy);
      if (tt && (tt.pass.n || tt.pass.e || tt.pass.s || tt.pass.w)) {          // (nothing to gain with no ground behind it)
        if (ov && ov.key) cands.push({ t: 'ent', key: ov.key });
        cands.push({ t: 'wall', orient: ed.orient, x: ed.x, y: ed.y });
      }
    } else if (r.reason === 'object' && r.entity) cands.push({ t: 'ent', key: r.entity });
    var best = null;
    cands.forEach(function (t) { var n = blowsToBreak(c, map, t, dmg); if (n > 0 && (!best || n < best.hits)) best = { t: t, hits: n }; });
    return (ctx.obst[k] = best);
  }
  /**
   * The cheapest way from the monster to a cell where at(x, y) holds, as a string of steps ("NNE"), '' when it is
   * there already, or null when there is none within reach. Four-way. With dmg > 0, a step blocked by something it
   * can break is allowed and costs its blows; with dmg 0 it only walks. Other creatures are not in the way here:
   * the walk itself deals with them. Bounded (WALKER_NODES cells, WALKER_REACH tiles out) so a horde stays cheap.
   */
  function findPath(c, ws, mapId, map, m, at, dmg, ctx) {
    if (at(m.x, m.y)) return '';
    var R = Rl(), W = map.width, start = m.y * W + m.x, cost = {}, prev = {}, how = {}, done = {}, buckets = [[start]], n = 0, DIRS4 = ['N', 'E', 'S', 'W'];
    var opts = { mapOf: function (id) { return liveMap(c, ws, id); }, walkable: function (e) { return walkableEntity(c, ws, mapId, e); } };
    cost[start] = 0;
    for (var cc = 0; cc < buckets.length && cc <= WALKER_MAXCOST; cc++) {
      var b = buckets[cc]; if (!b) continue;
      for (var i = 0; i < b.length; i++) {
        var id = b[i]; if (done[id] || cost[id] !== cc) continue;
        done[id] = 1;
        var x = id % W, y = (id - x) / W;
        if (id !== start && at(x, y)) {
          var out = '';
          while (id !== start) { out = how[id] + out; id = prev[id]; }
          return out.slice(0, WALKER_PATH);
        }
        if (++n > WALKER_NODES) return null;
        for (var k = 0; k < 4; k++) {
          var dir = DIRS4[k], d = R.DIRS[dir], nx = x + d.dx, ny = y + d.dy, nid = ny * W + nx, step = 1;
          if (nx < 0 || ny < 0 || nx >= W || ny >= map.height || done[nid] || cheb(nx, ny, m.x, m.y) > WALKER_REACH) continue;
          var r = R.tryMove(c, map, x, y, dir, opts);
          if (r.map) continue;                                  // (stairs to another floor: not a way it plans)
          if (!r.ok) {
            var ob = dmg > 0 ? obstacleFor(c, map, x, y, dir, r, dmg, ctx) : null;
            if (!ob) continue;
            step = 1 + Math.min(60, Math.ceil(ob.hits / 2));
          } else if (r.x !== nx || r.y !== ny) continue;
          var nc = cc + step;
          if (cost[nid] === undefined || nc < cost[nid]) { cost[nid] = nc; prev[nid] = id; how[nid] = dir; (buckets[nc] = buckets[nc] || []).push(nid); }
        }
      }
    }
    return null;
  }
  /** The nearest thing players built that the walker can see from where it stands (a target for resolveOn), or null. */
  function builtInSight(c, map, m, sight, ctx) {
    if (!ctx.built) {
      var list = [], st = map._struct;
      if (st) {
        Object.keys(st.walls || {}).forEach(function (k) { var ed = edgeOfKey(k); if (ed) list.push({ t: { t: 'wall', orient: ed.orient, x: ed.x, y: ed.y }, cells: edgeCells(ed) }); });
        (st.ents || []).forEach(function (e) {
          var o = objOf(c, e); if (!o || NO_HP_KINDS[o.kind] || !(Number(e.max) > 0) || !(Number(e.hp) > 0)) return;
          var cells = [{ x: e.x, y: e.y }];
          if (isWallFixture(o)) { cells = []; fixtureEdges(o, e).forEach(function (q) { edgeCells(q).forEach(function (cl) { cells.push(cl); }); }); }
          list.push({ t: { t: 'ent', key: e.key }, cells: cells });
        });
      }
      ctx.built = list;
    }
    var near = [];
    ctx.built.forEach(function (b) {
      var d = 1e9; b.cells.forEach(function (q) { d = Math.min(d, cheb(q.x, q.y, m.x, m.y)); });
      if (d <= sight) near.push({ b: b, d: d });
    });
    near.sort(function (p, q) { return p.d - q.d; });
    for (var i = 0; i < near.length && i < 4; i++) {
      var b = near[i].b, tg = resolveOn(c, map, map._struct, b.t);
      if (!tg || !tg.can || tg.hp <= 0) continue;
      if (b.cells.some(function (q) { return (q.x === m.x && q.y === m.y) || canSee(c, map, m.x, m.y, q.x, q.y, ctx.stateFn); })) return b.t;
    }
    return null;
  }
  /** A blow at a wall or object. */
  function walkerBash(c, ws, mapId, m, def, ms2, t, now, ev, ctx) {
    var res = damageStructure(c, ws, mapId, t, def.structureDmg > 0 ? def.structureDmg : ms2.atk, { kind: 'monster', by: m.id, now: now }, ev);
    ctx.stale = true;                                         // the map changed: everyone after this one looks again
    if (t.t === 'wall') m.facing = t.orient === 'h' ? (m.y >= t.y ? 'N' : 'S') : (m.x >= t.x ? 'W' : 'E');
    else if (res && res.tg) m.facing = Math.abs(res.tg.x - m.x) >= Math.abs(res.tg.y - m.y) ? (res.tg.x > m.x ? 'E' : res.tg.x < m.x ? 'W' : m.facing) : (res.tg.y > m.y ? 'S' : 'N');
    return res;
  }
  /**
   * One turn of a walker. Answers 'stop' (it struck: no more steps this turn), 'gone' (it left this floor), or nothing.
   */
  function walkerStep(c, ws, mapId, ms, m, def, ms2, here, now, rng, ev, stepMs, ctx) {
    if (ctx.stale) { ctx.map = liveMap(c, ws, mapId); ctx.obst = {}; ctx.built = null; ctx.stale = false; }
    var map = ctx.map, sight = lookRange(def, m, now), full = (def.aggroS > 0 ? def.aggroS : 30) * 1000;
    function sees(x, y) { return cheb(m.x, m.y, x, y) <= sight && canSee(c, map, m.x, m.y, x, y, ctx.stateFn); }   // (a prey animal)
    function aware(q) { return notices(c, map, m, def, q, now, sight, ctx.stateFn, { los: true }); }        // (a player: seen, heard or neither)
    var stealth = stealthOn(c);
    function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
    var ai = m.ai || null, tgt = null, seen = false;
    if (m.engaged) {                                          // struck by someone, or it came up the stairs after them
      var who = byId(here, m.engaged);
      if (who) ai = m.ai = { k: 'p', id: who.id, a: full, x: who.x, y: who.y, spot: 1 };   // spot: it knows them (chasedBy)
      m.engaged = null;
    }
    if (m.hear && !(ai && ai.k === 'p')) {                    // it heard something (senseStep): ? — a moment, then it goes to look there
      if (now - m.hear.at < hearDelay(c)) return;             // surprised: frozen, facing as it was
      faceToward(m, m.hear.x, m.hear.y);
      ai = m.ai = { k: 'p', id: m.hear.id, a: full, x: m.hear.x, y: m.hear.y, w: 1 }; delete m.hear;
    }
    if (ai && ai.k === 'p') tgt = byId(here, ai.id);
    else if (ai && ai.k === 'm') { tgt = byId(ms.monsters, ai.id); if (!tgt || tgt.dead) { delete m.ai; ai = tgt = null; } }      // it won
    else if (ai && ai.k === 's') { tgt = resolveOn(c, map, map._struct, ai.t); if (!tgt || !tgt.can || tgt.hp <= 0) { delete m.ai; ai = tgt = null; } }
    if (ai && ai.k === 'p' && !tgt && m.follow && now < m.follow.until) {                // they took the stairs: after them
      return followStairs(c, ws, mapId, map, ms, m, here, now) ? 'gone' : undefined;
    }
    if (ai && ai.k !== 's') {
      var how = !tgt ? '' : ai.k === 'p' ? aware(tgt) : sees(tgt.x, tgt.y) ? 'seen' : '';
      if (how === 'seen') {
        seen = true; ai.a = full; ai.x = tgt.x; ai.y = tgt.y; ai.s = 1; delete ai.w;          // s: it has them in sight (alertOf)
        if (ai.k === 'p') { ai.spot = 1; spotted(c, tgt, m, ev); }                            // (a search it heard its way into: now it has seen them)
      }
      else {
        ai.a -= stepMs; delete ai.s;
        // out of sight but heard: it knows where they are now. (Stealth off: anyone within aggro_range is heard, through
        // walls, and it breaks in after them. Stealth on: only their noise tells it, and a sound alone — ai.w — sends it
        // to look, never to break anything.)
        if (stealth ? how === 'heard' : tgt && cheb(m.x, m.y, tgt.x, tgt.y) <= def.aggro) { ai.x = tgt.x; ai.y = tgt.y; if (!stealth) delete ai.w; }
        if (ai.a <= 0) { delete m.ai; ai = tgt = null; }
      }
    }
    // Looking for something (new) to go after — only with a player around to set it off.
    var awake = here.some(function (q) { return cheb(q.x, q.y, m.x, m.y) <= ctx.wake; });
    if (awake && !seen) {
      var found = null, fk = '', fd = 1e9, heard = null, hd = 1e9;
      here.forEach(function (q) {
        var d = cheb(q.x, q.y, m.x, m.y); if (d >= fd && d >= hd) return;
        var hw = aware(q);
        if (hw === 'seen' && d < fd) { fd = d; found = q; fk = 'p'; }
        else if (hw === 'heard' && d < hd) { hd = d; heard = q; }
      });
      if (!ctx.prey) ctx.prey = ms.monsters.filter(function (q) { var qd = c.monsters[q.ref]; return qd && qd.prey; });
      if (!def.prey) ctx.prey.forEach(function (q) { if (q.dead || q === m) return; var d = cheb(q.x, q.y, m.x, m.y); if (d < fd && sees(q.x, q.y)) { fd = d; found = q; fk = 'm'; } });
      if (found) {
        ai = m.ai = { k: fk, id: found.id, a: full, x: found.x, y: found.y, s: 1 }; tgt = found; seen = true;
        if (fk === 'p') { ai.spot = 1; spotted(c, found, m, ev); }
      }
      else if (heard && !stealth) {                            // (stealth on, a sound is senseStep's: ? first, then it goes to look)
        ai = m.ai = { k: 'p', id: heard.id, a: full, x: heard.x, y: heard.y, w: 1 }; tgt = heard;
      }
      else if (!ai && ctx.buildings) {
        var bt = builtInSight(c, map, m, sight, ctx);
        if (bt) { ai = m.ai = { k: 's', t: bt, a: full }; tgt = resolveOn(c, map, map._struct, bt); }
      }
    }
    if (!ai) { if (awake) roamStep(c, ws, mapId, map, m, here, rng); return; }
    ws.dirty = true;
    if (m.guest) m.idleUntil = now + GUEST_IDLE_MS;
    var goal;
    if (ai.k === 's') {
      if (structReach(c, map, m.x, m.y, tgt)) { walkerBash(c, ws, mapId, m, def, ms2, ai.t, now, ev, ctx); return 'stop'; }
      goal = { s: tgt };
    } else {
      if (tgt) {
        if (ai.k === 'p' && monsterShot(c, ws, mapId, map, m, def, ms2, tgt, Math.abs(tgt.x - m.x) + Math.abs(tgt.y - m.y), now, rng, ev)) return 'stop';
        if (cheb(m.x, m.y, tgt.x, tgt.y) === 1 && !moveBlockedEdge(c, map, m.x, m.y, tgt.x, tgt.y)) {
          if (ai.k === 'p') { if (monsterSwing(c, ws, mapId, m, def, ms2, tgt, now, rng, ev)) delete m.ai; }
          else {
            m.facing = tgt.x > m.x ? 'E' : tgt.x < m.x ? 'W' : tgt.y > m.y ? 'S' : 'N';
            hitMonster(c, ws, mapId, null, tgt, damage(ms2.atk, monStats(c, tgt).def, rng), now, rng, ev, '');
            if (tgt.dead) delete m.ai;
          }
          return 'stop';
        }
      }
      goal = { x: ai.x, y: ai.y, adj: !!(tgt && tgt.x === ai.x && tgt.y === ai.y) };
    }
    return walkerMove(c, ws, mapId, ms, m, def, ms2, here, now, rng, ev, stepMs, ctx, ai, goal, seen);
  }
  function walkerMove(c, ws, mapId, ms, m, def, ms2, here, now, rng, ev, stepMs, ctx, ai, goal, seen) {
    var map = ctx.map, R = Rl(), opts = moveOpts(c, ws, mapId, here, m), dmg = def.structureDmg > 0 ? def.structureDmg : ms2.atk, r, i;
    function at(x, y) {
      if (goal.s) return structReach(c, map, x, y, goal.s);
      // (goal.adj = its target stands there. The way still leads INTO that cell, so that a wall right beside the target
      // is part of it; the walker never arrives, it strikes as soon as it is beside them with nothing between.)
      return x === goal.x && y === goal.y;
    }
    if (!goal.s && !goal.adj && at(m.x, m.y)) {                 // it is where it last knew them to be, and they are not: poke around
      ai.x = Math.max(0, Math.min(map.width - 1, m.x + rint(rng, -4, 4))); ai.y = Math.max(0, Math.min(map.height - 1, m.y + rint(rng, -4, 4)));
      ai.w = 1; ai.p = ''; delete ai.n;
      return;
    }
    // a way it worked out is kept between turns, and followed, while it still leads where it wants to go
    var gk = goal.s ? goal.s.key : null, same = goal.s ? ai.g === gk : !!(ai.g && typeof ai.g === 'object' && cheb(ai.g[0], ai.g[1], goal.x, goal.y) <= (goal.adj ? 2 : 0));
    if (seen && !goal.s && !(same && ai.p)) {                   // it sees them and is on no such way: straight at them, as far as that goes
      // (the corner cut and the long way of the two only: a sidestep along something in the way is the worked-out way's job,
      // or it would walk off from a wall it has nearly broken through)
      var dirs = stepsToward(m, goal.x, goal.y); if (dirs.length > 2) dirs.length = 2; else if (dirs.length === 2 && !R.DIAG[dirs[0]]) dirs.length = 1;
      for (i = 0; i < dirs.length; i++) {
        r = R.tryMove(c, map, m.x, m.y, dirs[i], opts);
        if (r.ok && !r.map) { m.x = r.x; m.y = r.y; m.facing = R.faceFor(dirs[i], m.facing); m.last += (R.stepCost(dirs[i], c, map, m.x, m.y) - 1) * stepMs; ai.p = ''; return; }
      }
    }
    // …otherwise along a way it works out
    if (!same || !ai.p) {
      if (same && ai.n > 0) { ai.n--; millStep(c, ws, mapId, map, m, here, rng); return; }
      if (ctx.budget <= 0) return;                              // enough thinking on this map for one turn: it stands a moment
      ctx.budget--;
      var path = findPath(c, ws, mapId, map, m, at, ai.w ? 0 : dmg, ctx);
      ai.g = goal.s ? gk : [goal.x, goal.y];
      if (!path) {                                              // no way there for now: mill about, look again in a few turns
        ai.p = ''; ai.n = 5;
        if (ai.w) { ai.x = m.x; ai.y = m.y; }                   // (a poke-around spot it cannot walk to: pick another)
        if (ai.k === 's') { ai.a -= 4 * stepMs; if (ai.a <= 0) delete m.ai; }
        millStep(c, ws, mapId, map, m, here, rng);
        return;
      }
      ai.p = path; delete ai.n;
    }
    var d = ai.p.charAt(0);
    r = R.tryMove(c, map, m.x, m.y, d, opts);
    if (r.ok && !r.map) { m.x = r.x; m.y = r.y; m.facing = d; ai.p = ai.p.slice(1); return; }
    if (r.reason === 'occupied') {
      var pl = r.who && r.who.player;
      if (pl && !moveBlockedEdge(c, map, m.x, m.y, pl.x, pl.y)) { monsterSwing(c, ws, mapId, m, def, ms2, pl, now, rng, ev); return 'stop'; }   // someone in its way
      if (rng() < 0.25) ai.p = '';                              // stuck behind another one: now and then, think again
      return;
    }
    var ob = ai.w || r.map ? null : obstacleFor(c, map, m.x, m.y, d, r, dmg, ctx);
    if (ob) { walkerBash(c, ws, mapId, m, def, ms2, ob.t, now, ev, ctx); return 'stop'; }
    ai.p = '';
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
      if (t.regrow) {
        // A harvested object grows back — but never on top of someone: a tree that came back where a walker (or a
        // player) stood shut it inside, unseen and unable to see. It waits until the spot is clear.
        var ge = entity(c, mapId, k);
        var onIt = ge && (ms.monsters.some(function (m) { return !m.dead && m.x === ge.x && m.y === ge.y; }) || players.some(function (p) { return p.map === mapId && p.hp > 0 && p.x === ge.x && p.y === ge.y; }));
        if (onIt) { t.at = now + 3000; return; }
        var stg = structOf(ws, mapId); delete stg.gone[k]; touchStruct(stg);
      }
      else if (t.rot) { var str2 = structOf(ws, mapId), ri = -1; str2.ents.forEach(function (b, i) { if (b.key === k) ri = i; }); if (ri >= 0) { str2.ents.splice(ri, 1); touchStruct(str2); ws.dirty = true; } }   // a carcass nobody took is gone
      else setState(ws, mapId, k, t.state);
      delete ms.timers[k];
    });
    growStep(c, ws, mapId, map, ms, now, rng);                 // branches under trees, fibres in the grass
    if (ms.cookers) Object.keys(ms.cookers).forEach(function (k) { if (ms.cookers[k].lit) cookTick(c, ws, mapId, k, now); });
    var here = players.filter(function (p) { return p.map === mapId && p.hp > 0; });
    giveCredits(c, ws, mapId, ms, players.filter(function (p) { return p.map === mapId; }), now, rng, ev);   // kills others finished while these players had a hand in them
    var engageRange = Number(c.config.engage_range) || 24;       // how far a hit monster will chase before giving up
    var hDecay = Number(c.config.hunger_decay_per_min) || 0, tDecay = Number(c.config.thirst_decay_per_min) || 0;
    var starveDmg = Number(c.config.starve_damage) || 0, starveMs = Math.max(1000, (Number(c.config.starve_tick_s) || 5) * 1000);
    here.forEach(function (p) {
      var st = stats(c, p);
      if (p.lastRegen && st.mpRegen) p.mp = Math.min(st.maxMp, (Number(p.mp) || 0) + st.mpRegen * Math.max(0, now - p.lastRegen) / 1000);
      p.lastRegen = now;
      finishReload(c, p, now, ev);
      craftTick(c, ws, p, now, ev);
      if (watching(c, p, now)) {                                     // watching a scene: hunger, thirst and what ails them wait
        p.lastSurvival = now;
        (p.statuses || []).forEach(function (st) { if (st.next != null && st.next < now) st.next = now; });
        return;
      }
      survivalTick(c, ws, p, now, hDecay, tDecay, starveDmg, starveMs, ev);
      if (p.craft) questSweep(c, ws, p, now, ev);                    // (something being made may just have been finished)
      tickStatuses(c, ws, mapId, p, false, now, rng, ev, players);
    });
    ms.monsters.forEach(function (m) { if (!m.dead && m.statuses && m.statuses.length) tickStatuses(c, ws, mapId, m, true, now, rng, ev, players); });
    here = here.filter(function (p) { return p.map === mapId && p.hp > 0; });
    here.forEach(function (p) {
      Rl().entitiesAt(map, p.x, p.y).forEach(function (e) {
        var o = objOf(c, e), pr = o && props(c, e);
        if (o && o.kind === 'trap' && isTimed(c, e, pr) && p.map === mapId && !watching(c, p, now)) timedTrapHit(c, ws, p, e, o, pr, now, ev);
      });
    });
    var wctx = null;                                            // what the walkers of this map share for this turn
    var sfn = function (e) { return stateOf(c, ws, mapId, e); };  // (doors open or shut, for line of sight)
    senseStep(c, ws, mapId, map, ms, here, now, sfn, ev);         // seen: at once; heard: ? and a moment's wait (see PERCEPTION)
    ms.monsters.forEach(function (m) {
      var def = c.monsters[m.ref]; if (!def) return;
      if (m.dead) {
        if (m.ai) delete m.ai;
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
      if (m.wait) { if (now < m.wait) { m.last = now; return; } delete m.wait; ws.dirty = true; }   // a scene just left it here: a moment before it acts
      var steps = Math.floor((now - m.last) / stepMs);
      if (steps <= 0) return;
      m.last = steps > 2 ? now : m.last + steps * stepMs;
      steps = Math.min(steps, 2);
      for (var s = 0; s < steps; s++) {
        if (def.brain === 'walker') {                           // its own brain (see walkerStep)
          wctx = wctx || walkerCtx(c, ws, mapId, map);
          var wr = walkerStep(c, ws, mapId, ms, m, def, ms2, here, now, rng, ev, stepMs, wctx);
          map = wctx.map;
          if (wr === 'gone') return;
          if (wr === 'stop') break;
          continue;
        }
        if (def.brain === 'animal') { animalStep(c, ws, mapId, map, ms, m, def, here, now, rng, stepMs, sfn, ev); continue; }
        if (def.brain === 'hunter') { if (hunterStep(c, ws, mapId, map, ms, m, def, ms2, here, now, rng, ev, stepMs, engageRange, sfn) === 'stop') break; continue; }
        var target = null, best = 1e9, heardOnly = false;
        var eng = m.engaged ? here.filter(function (q) { return q.id === m.engaged && !watching(c, q, now); })[0] : null;   // chase whoever hit it
        if (eng) {
          var ed = Math.abs(eng.x - m.x) + Math.abs(eng.y - m.y);
          if (ed <= engageRange) { target = eng; best = ed; } else m.engaged = null;                // fled too far: give up
        }
        if (!target) here.forEach(function (q) {
          if (q.hp <= 0 || q.map !== mapId) return;
          var d = Math.abs(q.x - m.x) + Math.abs(q.y - m.y); if (d >= best) return;
          var how = notices(c, map, m, def, q, now, lookRange(def, m, now), sfn, { manhattan: true });
          // heard: only someone it is already after (it lost sight of them); any other sound is senseStep's (? then go and look)
          if (how === 'seen' || (how === 'heard' && (m.chase === q.id || !stealthOn(c)))) { best = d; target = q; heardOnly = how === 'heard'; }
        });
        chaseNote(c, m, target, !!target && !heardOnly, ev);
        if (target && m.guest) m.idleUntil = now + GUEST_IDLE_MS;
        if (target) {
          if (!heardOnly && monsterShot(c, ws, mapId, map, m, def, ms2, target, best, now, rng, ev)) break;
          if (cheb(m.x, m.y, target.x, target.y) === 1 && !moveBlockedEdge(c, map, m.x, m.y, target.x, target.y)) {
            // beside its target (diagonals count) with no wall between: swing. (A wall on the edge makes it try to move around instead.)
            monsterSwing(c, ws, mapId, m, def, ms2, target, now, rng, ev);
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
              m.last += (Rl().stepCost(dirs[i], c, map, m.x, m.y) - 1) * stepMs;                                   // a diagonal takes longer, as it does for players
              break;
            }
          }
        } else if (m.follow && now < m.follow.until) {
          if (followStairs(c, ws, mapId, map, ms, m, here, now)) return;      // gone to the other floor
        } else if (listening(c, m, def, now)) break;                          // ? — it heard something, and waits a moment
        else if (!goToStep(c, ws, mapId, map, m, here, now, stepMs)) roamStep(c, ws, mapId, map, m, here, rng);   // …then goes to look
      }
    });
    // who is chased (no sneaking for them), and who has just shaken off the last one after them (they are told)
    here.forEach(function (p) {
      if (chasedBy(ms, p)) p.chased = true;
      else if (p.chased) {
        delete p.chased;
        if (p.wasSneak) { delete p.wasSneak; ev.push({ type: 'info', to: p.id, text: 'Nothing is after you any more: you can sneak again (Z).' }); }   // (only for one who was spotted sneaking)
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
    p.map = map.id; p.x = at.x; p.y = at.y; p.facing = r.facing || 'S'; p.hp = stats(c, p).maxHp; p.tox = 0;
  }
  function toxSickAt(c) { return cfgNum(c, 'toxicity_sick_at', 50); }
  /** Adds to (or, negative, clears) the toxicity gauge; says so when it tips you over into being ill. */
  function addTox(c, p, n, ev) {
    n = Number(n) || 0; if (!n) return;
    var was = Number(p.tox) || 0, at = toxSickAt(c);
    p.tox = Math.max(0, Math.min(100, was + n));
    if (n > 0 && was < at && p.tox >= at) ev.push({ type: 'info', to: p.id, text: 'You feel sick: too much bad water. It wears off with time.' });
  }
  // ---- water: drinking from it, filling what holds it
  function waterAt(c, map, x, y) { var t = map && inMap(map, x, y) ? Rl().terrainAt(c, map, x, y) : null; return t && t.water ? t : null; }
  /** The items in the bag that can be filled at water, the one in hand first: [{id, qty, into}]. */
  function fillables(c, p) {
    var seen = {}, out = [], inHand = p.held >= 0 ? beltOf(p)[p.held] : '';
    (p.inventory || []).forEach(function (st) {
      var it = c.items[st.item]; if (!it || !it.fillsInto || !c.items[it.fillsInto] || seen[st.item]) return;
      seen[st.item] = 1; out.push({ id: st.item, qty: count(p, st.item), into: it.fillsInto });
    });
    out.sort(function (a, b) { return (b.id === inHand) - (a.id === inHand); });
    return out;
  }
  /** Water right there (drink / fill): what the player does with it. verb '' = fill what is in hand, else drink. */
  function useWater(c, p, wt, verb, ev) {
    var say = function (t) { ev.push({ type: 'info', to: p.id, text: t }); }, fl = fillables(c, p), name = lower(wt.name);
    var inHand = p.held >= 0 ? beltOf(p)[p.held] : '';
    var fm = /^fill:(.+)$/.exec(verb || ''), f = fm ? fl.filter(function (g) { return g.id === fm[1]; })[0] : (verb !== 'drink' && fl[0] && fl[0].id === inHand ? fl[0] : null);
    if (fm && !f) return say('You have nothing to fill.');
    if (f) {
      var slot = beltOf(p).indexOf(f.id), hadHeld = p.held;
      take(p, f.id, f.qty); give(c, p, f.into, f.qty, ev);
      if (slot >= 0 && !beltStack(p, slot)) {                     // it stays where it was on the belt
        var fs = p.inventory.filter(function (x) { return x.item === f.into; }).sort(function (a, b) { return onBeltCell(b.s) - onBeltCell(a.s); })[0];
        if (fs) toBelt(p, fs, slot);
      }
      syncLoadout(c, p);
      if (hadHeld === slot && slot >= 0) holdSlot(c, p, slot, ev);
      return say('You fill the ' + lower(itemName(c, f.id)) + (f.qty > 1 ? ' (×' + f.qty + ')' : '') + ' at the ' + name + '.');
    }
    var thi = Number(p.thirst) || 0;
    if (Math.round(thi) >= 100) return say('You are not thirsty.');      // (the gauge reads full: no sip for a fraction, and its toxicity)
    p.thirst = Math.min(100, thi + cfgNum(c, 'water_thirst', 25));
    var tox = wt.toxicity == null ? cfgNum(c, 'water_toxicity', 8) : wt.toxicity;
    say('You drink from the ' + name + '.' + (tox > 0 ? ' It is not clean.' : ''));
    questCount(c, p, 'drink', '', Date.now(), ev);              // (from a stream: no item, so only "drink anything" counts)
    addTox(c, p, tox, ev);
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
    if (p.lastSurvival != null && Number(p.tox) > 0) p.tox = Math.max(0, Number(p.tox) - cfgNum(c, 'toxicity_decay_per_min', 1.5) * Math.max(0, now - p.lastSurvival) / 60000);
    p.lastSurvival = now;
    var sickDmg = cfgNum(c, 'toxicity_damage', 2);
    if (!sickDmg || !((Number(p.tox) || 0) >= toxSickAt(c))) p.nextSick = 0;
    else {
      if (!p.nextSick || p.nextSick > now + starveMs) p.nextSick = now + starveMs;
      while (p.nextSick <= now && p.hp > 0) { p.nextSick += starveMs; hurt(c, ws, p, sickDmg, 'Poisoned by what you drank, you lose ', ev); }
    }
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
    noteAct(p, 'm', m.x, m.y, dmg);
    hitMonster(c, ws, mapId, p, m, dmg, now, rng, ev, 'You hit the ' + lower(def.name) + ' for ' + dmg + '.');
    wear(c, p, heldItem(c, p), ev, def.material || 'flesh');   // a creature is flesh (unless the monster says otherwise)
    return true;
  }
  // WHO TOOK PART. A monster remembers who has hit it (m.hits = {playerId: when}, the last HIT_MAX of them); a blow
  // older than Config kill_credit_s (30) no longer counts. When it dies, EVERYONE who took part gets the kill for
  // their quests, the full XP, their own gold and their own roll of its loot table (killShare). What it always
  // gives (Monsters `loot`: meat, hide) is not multiplied: it lies in the carcass for whoever takes it, or with no
  // carcass goes to the one who struck the last blow.
  // The one who struck that blow is at hand and gets their share at once. The others are not handed to this
  // function, so their share waits in the map's record (ms.credits) and is given on the map's next turn (advance),
  // which is at most a moment later while they are there; a share nobody came for within a minute is dropped.
  var HIT_MAX = 12, CREDIT_KEEP_MS = 60000;
  function noteHit(c, m, p, now) {
    var h = m.hits = m.hits || {};
    h[p.id] = now;
    var ids = Object.keys(h);
    if (ids.length > HIT_MAX) { ids.sort(function (a, b) { return h[a] - h[b]; }); delete h[ids[0]]; }
  }
  /** One participant's share of a kill. share = { ref, key: the carcass left ('' = none), x, y }. */
  function killShare(c, ws, mapId, p, share, now, rng, ev) {
    var def = c.monsters[share.ref]; if (!def) return;
    ev.push({ type: 'kill', map: mapId, x: share.x, y: share.y, to: p.id, text: 'The ' + lower(def.name) + ' is defeated. +' + def.xp + ' XP' });
    var gold = rint(rng, def.goldMin, def.goldMax);
    if (gold > 0) give(c, p, 'gold', gold, ev);
    // their own roll of the loot table (quest drops included): into their part of the carcass, or straight to them
    var drops = roll(c, def.lootTable, rng, p).filter(function (g) { return g.qty > 0 && (g.item === 'gold' || c.items[g.item]); });
    var body = share.key ? structOf(ws, mapId).ents.filter(function (b) { return b.key === share.key && b.wild && Array.isArray(b.inv); })[0] : null;
    if (!body && drops.some(function (g) { return g.item !== 'gold'; })) {
      // nothing lies there (it left no body, or the body was emptied since): a loot bag where it fell, never straight
      // into the bag. The others still owed a share of this kill find theirs in the same one.
      body = lootBox(c, ws, mapId, share.x, share.y, lootBagOf(c, def), now);
      if (body) (mapState(ws, mapId).credits || []).forEach(function (cr) {
        if (cr !== share && cr.ref === share.ref && cr.x === share.x && cr.y === share.y && cr.at === share.at) cr.key = body.key;
      });
    }
    drops.forEach(function (g) {
      if (g.item === 'gold' || !body) { give(c, p, g.item, g.qty, ev); return; }
      var mine = body.inv.filter(function (st) { return st.own === p.id; }), cell = body.inv.filter(function (st) { return !st.own; }).length;
      var same = mine.filter(function (st) { return st.item === g.item; })[0];
      if (same) same.qty += g.qty; else body.inv.push({ item: g.item, qty: g.qty, s: cell + mine.length, own: p.id });   // (own = only this player finds it there)
    });
    gainXp(c, p, def.xp, ev);
    questCount(c, p, 'kill', share.ref, now, ev);
  }
  /** Shares waiting for players on this map (see WHO TOOK PART): given to whoever is here now, dropped when stale. */
  function giveCredits(c, ws, mapId, ms, here, now, rng, ev) {
    if (!ms.credits || !ms.credits.length) return;
    ms.credits = ms.credits.filter(function (cr) {
      var p = here.filter(function (q) { return q.id === cr.to; })[0];
      if (p) { killShare(c, ws, mapId, p, cr, now, rng, ev); questSweep(c, ws, p, now, ev); ws.dirty = true; return false; }
      return now - cr.at < CREDIT_KEEP_MS;
    });
    if (!ms.credits.length) delete ms.credits;
  }
  /** Something shot into a monster that can be had back (an arrow): it stays in it until it dies (hitMonster). */
  function stickIn(c, m, id, qty) {
    if (!c.items[id] || !(qty > 0)) return;
    m.stuck = m.stuck || [];
    var same = m.stuck.filter(function (g) { return g.item === id; })[0];
    if (same) same.qty += qty; else m.stuck.push({ item: id, qty: qty });
  }
  /** Lays qty of an item on the ground (a pickup, the built-in _drop) on the last of these cells it can lie on: joined to
   *  the same thing already lying there, else on a free tile. None of them will do: it is lost. */
  function layOnGround(c, ws, mapId, cells, id, qty, now) {
    var drop = c.objects._drop, map = liveMap(c, ws, mapId); if (!drop || !map || !c.items[id] || !(qty > 0)) return false;
    var st = structOf(ws, mapId);
    for (var i = cells.length - 1; i >= 0; i--) {
      var x = cells[i].x, y = cells[i].y;
      var here = st.ents.filter(function (b) { return b.ref === drop.id && b.x === x && b.y === y && b.data && String(b.data.pickup || '').split(':')[0] === id; })[0];
      if (here) {
        var pk = String(here.data.pickup).split(':');
        here.data.pickup = id + ':' + ((Number(pk[1]) || 1) + qty);
      } else {
        if (!Rl().standable(c, map, x, y) || Rl().entitiesAt(map, x, y).length) continue;
        st.ents.push({ key: mapId + '.b' + (++st.n), x: x, y: y, ref: drop.id, data: { pickup: id + ':' + qty }, hp: 0, max: 0, bp: '', by: null, built: now, prog: 0, need: 0, wild: true });
      }
      touchStruct(st); ws.dirty = true;
      return true;
    }
    return false;
  }
  /**
   * Is monster m caught unawares by player p's blow? (Stealth on, the player on its floor.) Nobody is fighting it
   * (m.engaged), it has nobody in sight (a walker's ai.s), and it does not SEE p (notices: having heard them does
   * not spoil it — it knows something is there, not where). A blow from behind, or a shot from out of its sight.
   */
  function unaware(c, ws, mapId, m, def, p, now) {
    if (!def || !stealthOn(c) || p.map !== mapId || m.engaged || (m.ai && m.ai.s)) return false;
    var map = liveMap(c, ws, mapId), sfn = function (e) { return stateOf(c, ws, mapId, e); };
    return notices(c, map, m, def, p, now, lookRange(def, m, now), sfn, { manhattan: !def.brain, los: def.brain === 'walker' }) !== 'seen';
  }
  /** Damages a monster; if it dies, everyone who took part gets their share (see WHO TOOK PART above). */
  function hitMonster(c, ws, mapId, p, m, dmg, now, rng, ev, text) {
    var def = c.monsters[m.ref];
    if (p && unaware(c, ws, mapId, m, def, p, now)) {                // caught unawares: a sneak attack (docs/STEALTH.md stage 3)
      var amb = Math.max(1, Math.round(dmg * Math.max(1, cfgNum(c, 'ambush_mult', 2))));
      text = String(text || '').replace(' for ' + dmg + '.', ' for ' + amb + '.') + ' A sneak attack!';
      dmg = amb;
    }
    m.hp -= dmg; ws.dirty = true;
    if (p) { noteHit(c, m, p, now); questCount(c, p, 'hit', '*', now, ev); }
    if (p && m.hp > 0) { m.engaged = p.id; spotted(c, p, m, ev); }   // being hit (even from range) makes it come after you (and a sneaking attacker is found out)
    ev.push({ type: 'hit', map: mapId, x: m.x, y: m.y, amount: dmg, to: p ? p.id : undefined, text: p ? text : '' });
    if (m.hp > 0) return;
    m.dead = true; m.statuses = [];
    ev.push({ type: 'die', map: mapId, x: m.x, y: m.y, id: m.id });   // for everyone on the map: the page bursts the figure (deathFx in main.js)
    var keep = cfgNum(c, 'kill_credit_s', 30) * 1000, hits = m.hits || {};
    var part = Object.keys(hits).filter(function (id) { return now - hits[id] <= keep && !(p && id === p.id); });
    delete m.hits;
    // Everything it leaves lies in a loot bag where it fell (lootBox), for whoever takes it: what it always gives
    // (Monsters loot), what was shot into it and can be had back (stickIn), and, killed with no player in the fight
    // (a wolf's kill), one roll of its loot table. The players' own rolls join it in killShare. Nothing to leave: no bag.
    var stuck = (m.stuck || []).filter(function (g) { return c.items[g.item] && g.qty > 0; }); delete m.stuck;
    var alone = !p && !part.length, key = '';
    var inside = list(def.loot).concat(alone ? roll(c, def.lootTable, rng) : []).filter(function (g) { return c.items[g.item] && g.qty > 0; }).concat(stuck);
    if (inside.length) {
      var lb = lootBox(c, ws, mapId, m.x, m.y, lootBagOf(c, def), now);
      if (lb) { inside.forEach(function (g) { addStacks(c, lb.inv, g.item, g.qty, 0, g); }); key = lb.key; }
    }
    var share = { ref: m.ref, key: key || '', x: m.x, y: m.y, at: now };
    if (part.length) {
      var ms0 = mapState(ws, mapId); ms0.credits = ms0.credits || [];
      part.forEach(function (id) { ms0.credits.push({ to: id, ref: share.ref, key: share.key, x: share.x, y: share.y, at: now }); });
    }
    if (m.free) m.gone = true;                                 // a tamed animal has no spawner to come back at
    // Respawn delay: the spawn point's own respawn_after_s wins (set per spawner); 0/blank falls back
    // to the monster's respawn_s. The monster reappears that many seconds after it's killed.
    var se = m.spawn && entity(c, mapId, m.spawn);
    var rs = se ? (Number(props(c, se).respawn_after_s) || 0) : 0;
    m.respawnAt = now + (rs > 0 ? rs : def.respawnS) * 1000;
    if (p) killShare(c, ws, mapId, p, share, now, rng, ev);
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
  /** Walls (terrain nobody can cross), closed doors and objects marked blocks_sight stop sight, skills and shots.
   *  Ground that cannot be crossed but lies flat (water, lava, a pit: the terrain's see_through) stops none of them. */
  function blocksSight(c, map, x, y, stateFn) {
    var t = Rl().terrainAt(c, map, x, y);
    if (!t || (!(t.pass.n || t.pass.e || t.pass.s || t.pass.w) && !t.seeThrough)) return true;
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
  // Raised ground (Rules `elev`) hides what lies behind it. The eye of each end is Config `eye_height` (0.75 of a
  // height step; a wall is 2) above its own ground, and the line runs straight from one eye to the other: a cell in
  // between whose ground rises above that line stops it. Level ground never does, so flat maps are unchanged; from
  // high ground you see far, from below you see only the edge of a ledge taller than you. The same both ways.
  function eyeHeight(c) { var v = cfgNum(c, 'eye_height', 0.75); return v >= 0 ? v : 0.75; }
  function hillBetween(c, map, cells) {
    if (!map || !map.elev || !map.elev.length || cells.length < 3) return false;
    var R = Rl(), eye = eyeHeight(c), n = cells.length - 1, a = cells[0], b = cells[n];
    var ha = R.groundHeight(map, a.x + 0.5, a.y + 0.5) + eye, hb = R.groundHeight(map, b.x + 0.5, b.y + 0.5) + eye;
    for (var i = 1; i < n; i++) {
      var g = R.groundHeight(map, cells[i].x + 0.5, cells[i].y + 0.5);
      if (g > ha + (hb - ha) * i / n + 1e-6) return true;
    }
    return false;
  }
  // LOOKING UP A LEDGE (owner, 26 Nov 2026): ground higher than the viewer's eye is out of sight, and so is whoever
  // stands on it — unless they stand on its VERY EDGE: the first cell of that higher ground along the line. The line
  // runs from (x0, y0), the one looking (or shooting, or the blast), to (x1, y1). Looking DOWN is not touched, so the
  // one above sees the one below who cannot see them: high ground is an advantage.
  function upLedge(c, map, cells) {                       // (cells run from the one looking to what is looked at)
    if (!map || !map.elev || !map.elev.length || cells.length < 2) return false;
    var R = Rl(), n = cells.length - 1, from = cells[0], to = cells[n], before = cells[n - 1];
    var eye = R.groundHeight(map, from.x + 0.5, from.y + 0.5) + eyeHeight(c) + 1e-6;
    if (R.groundHeight(map, to.x + 0.5, to.y + 0.5) <= eye) return false;
    return R.groundHeight(map, before.x + 0.5, before.y + 0.5) > eye;
  }
  // Is the straight line between two cells clear? `edgeFn` picks the wall rule: sight for seeing/shooting,
  // movement for a thrown item's flight and a blast's reach (an explosion is stopped by any solid wall).
  function clearLine(c, map, x0, y0, x1, y1, stateFn, edgeFn, noPeek) {
    // The same line both ways: a stepped line from A to B is not always the one from B to A, so round a corner one
    // could see the other unseen (a monster you cannot see seeing you). The line is always drawn from the lesser end.
    var flip = x0 > x1 || (x0 === x1 && y0 > y1), cells = flip ? lineCells(x1, y1, x0, y0).reverse() : lineCells(x0, y0, x1, y1);
    for (var i = 1; i < cells.length - 1; i++) if (blocksSight(c, map, cells[i].x, cells[i].y, stateFn)) return false;
    if (hillBetween(c, map, cells) || upLedge(c, map, cells)) return false;
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
  // GROUND ABOVE YOUR EYES IS NOT SEEN (owner, 26 Nov 2026): a cell whose ground is higher than the viewer's eye
  // (their own ground + Config eye_height) is never in view: it keeps the fog. Lower ground is seen as far as the
  // sight line goes. So a ramp is seen from its foot, the level above only from on the ramp. The one exception is
  // WHO stands on the very edge of the ledge (upLedge, the same rule as for monsters and shots): such a cell gets
  // the value 3 = its ground is not seen, a creature on it is (perceive; the page's fog treats 3 as out of sight).
  function visibleCells(c, map, px, py, radius, stateFn) {
    var out = {}, r = radius > 0 ? radius : 16, x, y;
    var xa = Math.max(0, px - r), xb = Math.min(map.width - 1, px + r), ya = Math.max(0, py - r), yb = Math.min(map.height - 1, py + r);
    var hills = !!(map.elev && map.elev.length), eyeAt = hills ? Rl().groundHeight(map, px + 0.5, py + 0.5) + eyeHeight(c) + 1e-6 : 0;
    function above(ax, ay) { return hills && Rl().groundHeight(map, ax + 0.5, ay + 0.5) > eyeAt; }
    for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++)
      if (canSee(c, map, px, py, x, y, stateFn, true)) out[x + ',' + y] = above(x, y) ? 3 : 1;
    var add = [];
    for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++) {
      if (out[x + ',' + y] || above(x, y)) continue;
      var d = Math.abs(x - px) + Math.abs(y - py), nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (var i = 0; i < 4; i++) {
        var nx = nb[i][0], ny = nb[i][1];
        if (!out[nx + ',' + ny] || Math.abs(nx - px) + Math.abs(ny - py) >= d) continue;
        if (blocksSight(c, map, nx, ny, stateFn) || Rl().blockedBetween(c, map, nx, ny, x, y, 'sight')) continue;
        if (map.elev && map.elev.length && hillBetween(c, map, lineCells(px, py, x, y))) continue;   // hidden by the ground itself: not a notch
        add.push(x + ',' + y); break;
      }
    }
    add.forEach(function (k) { out[k] = 1; });
    var ov = map._edgeOv || {}, R = Rl();                     // standing at a window? add the peek cone
    var atWindow = [['h', px, py], ['h', px, py + 1], ['v', px, py], ['v', px + 1, py]].some(function (q) { var o = ov[R.edgeKey(q[0], q[1], q[2])]; return o && o.peek; });
    if (atWindow) for (y = ya; y <= yb; y++) for (x = xa; x <= xb; x++)
      if (!out[x + ',' + y] && !above(x, y) && canSee(c, map, px, py, x, y, stateFn)) out[x + ',' + y] = 2;
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
      return { id: q.id, name: q.name, 'class': q['class'], equipment: q.equipment || {}, hair: q.hair || '', hairColor: q.hairColor || '', beard: q.beard || '', beardColor: q.beardColor || '', body: q.body || '', skin: q.skin || '',
        x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: stats(c, q).maxHp, level: q.level, act: q.act || '', wst: weaponState(c, q), hand: handOf(c, q), sn: q.sneak ? 1 : 0 };
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
  // Up onto higher ground it reaches only the EDGE (owner, 27 Nov 2026): the first tile that stands a level above the
  // thrower is where it lands, never further in; ground more than a level up is a cliff face that stops it at its foot.
  // A ramp on the way is no step. Level ground and throwing down are untouched.
  function throwLanding(c, map, px, py, tx, ty, stateFn) {
    var line = lineCells(px, py, tx, ty), land = { x: px, y: py };
    var R = Rl(), hilly = !!(map && map.elev && map.elev.length), h0 = hilly ? R.groundHeight(map, px + 0.5, py + 0.5) : 0;
    for (var i = 1; i < line.length; i++) {
      if (edgeBlocksMove(c, map, line[i - 1], line[i])) break;            // a wall stops it at the previous cell
      if (blocksSight(c, map, line[i].x, line[i].y, stateFn)) break;      // can't land inside a solid cell
      var up = hilly ? R.groundHeight(map, line[i].x + 0.5, line[i].y + 0.5) - h0 : 0;
      if (up > 1.75) break;                                               // too high a face: it drops at its foot
      land = line[i];
      if (up > 0.75) break;                                               // the edge of the level above: no further
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
  /** How the weapon in hand stands, for its picture: 'reload' (being reloaded), 'empty' (a magazine with nothing in it) or ''. */
  /** What a player holds that is NOT the weapon they fight with (food, a bottle, a grenade, a bedroll…), for the others to
   *  draw in their hand: its item id, or ''. (The weapon is already told in `equipment`.) */
  function handOf(c, p) {
    var id = typeof p.held === 'number' && p.held >= 0 ? beltOf(p)[p.held] || '' : '';
    return id && c.items[id] && id !== (p.equipment || {}).weapon ? id : '';
  }
  function weaponState(c, p) {
    var w = c.items[(p.equipment || {}).weapon];
    if (!w || !itemCan(w, 'shoot') || !(Number(w.clip) > 0)) return '';
    if (p.reload && p.reload.id === w.id) return 'reload';
    return ((p.mags && p.mags[w.id]) || 0) < (Number(w.ammoCost) || 1) ? 'empty' : '';
  }
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
    // Shooting up a ledge: the shot ends in the first cell whose ground is above the shooter's eyes (the cliff). Who
    // stands there, on the very edge, can be hit; nothing further back can (the same rule as seeing: upLedge).
    var hills = !!(map.elev && map.elev.length), eyeAt = hills ? Rl().groundHeight(map, p.x + 0.5, p.y + 0.5) + eyeHeight(c) + 1e-6 : 0;
    for (var i = 0; i < line.length; i++) {
      var cx = line[i].x, cy = line[i].y;
      if (cheb(p.x, p.y, cx, cy) > w.range) break;
      if (edgeBlocksSight(c, map, prev, line[i])) { stop = { edge: Rl().sharedEdge(prev.x, prev.y, cx, cy) }; break; }   // an edge wall stops the shot before this cell
      cells.push(line[i]);
      if (hills && Rl().groundHeight(map, cx + 0.5, cy + 0.5) > eyeAt) break;   // into the cliff: no further
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
  // Reloading takes time: the gun's reload_ms, else Config reload_ms (1500; 0 = at once). While it lasts the player
  // carries p.reload = {id: the gun, at, until}; the rounds go in when it is over (finishReload, run before every
  // action and on every turn of the world), so a reload that is dropped — by changing what is in hand — costs nothing.
  function reloadMsOf(c, w) { var v = Number(w && w.reloadMs); return v > 0 ? v : Math.max(0, cfgNum(c, 'reload_ms', 1500)); }
  function finishReload(c, p, now, ev) {
    var r = p.reload; if (!r) return;
    var w = rangedWeapon(c, p);
    if (!w || w.id !== r.id) { delete p.reload; return; }
    if (now < r.until) return;
    delete p.reload;
    if (loadMag(c, p, w) > 0 && ev) ev.push({ type: 'info', to: p.id, text: 'You reload the ' + lower(w.name) + '. ' + p.mags[w.id] + '/' + w.clip });
  }
  /** Reload the equipped gun (R, or a click on an empty magazine): pull rounds from the ammo stack into its magazine. */
  function reload(c, ws, p, a, now, ev) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var w = rangedWeapon(c, p);
    if (p.reload) return;                                       // already at it
    if (!w) return say('You have no gun to reload.');
    if (!(Number(w.clip) > 0)) return say('The ' + lower(w.name) + ' has no magazine.');
    if (((p.mags && p.mags[w.id]) || 0) >= w.clip) return say('The ' + lower(w.name) + ' is already loaded.');
    if (count(p, w.ammo) <= 0) return say('Out of ' + lower(itemName(c, w.ammo)) + '.');
    var ms = reloadMsOf(c, w);
    ev.push({ type: 'reload', to: p.id, map: p.map, x: p.x, y: p.y, ms: ms });
    if (ms > 0) { p.reload = { id: w.id, at: now, until: now + ms }; return; }
    loadMag(c, p, w);
    say('You reload the ' + lower(w.name) + '. ' + p.mags[w.id] + '/' + w.clip);
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
    if (now < ((p.cooldowns || {})._shoot || 0) || p.reload) return;
    var theirs = liveMap(c, ws, String(a.map)), tx = Math.round(Number(a.x)), ty = Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a target.');
    var chk = shotAcross(c, p, liveMap(c, ws, p.map), theirs, tx, ty, function (e) { return stateOf(c, ws, p.map, e); });
    if (!chk.ok) return say(chk.reason);
    var ammoId = w.ammo, cost = w.ammoCost || 1, clip = Number(w.clip) || 0;
    if (clip > 0) {
      p.mags = p.mags || {};
      if ((p.mags[w.id] || 0) < cost) return count(p, ammoId) >= cost ? reload(c, ws, p, a, now, ev) : say('Out of ' + lower(itemName(c, ammoId)) + '.');   // empty: the click reloads
    } else if (ammoId && count(p, ammoId) < cost) return say('Out of ' + lower(itemName(c, ammoId)) + '.');
    faceTo(p, tx, ty);
    if (clip > 0) p.mags[w.id] = (p.mags[w.id] || 0) - cost; else if (ammoId) take(p, ammoId, cost);
    p.cooldowns = p.cooldowns || {}; p.cooldowns._shoot = now + (Number(w.fireMs) || Number(c.config.attack_ms) || 0);
    questCount(c, p, 'shoot', '*', now, ev);
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
    if (now < ((p.cooldowns || {})._shoot || 0) || p.reload) return;   // still cycling, or reloading: ignore quietly
    var map = liveMap(c, ws, p.map), lk = serverLookup(c, ws, p.map, players);
    var tx = Math.round(Number(a.x)), ty = Math.round(Number(a.y));
    if (isNaN(tx) || isNaN(ty)) return say('Pick a target.');
    var reach = shotReach(c, map, p, tx, ty, lk);
    if (!reach.ok) return say(reach.reason);
    var ammoId = w.ammo, cost = w.ammoCost || 1, ammoIt = ammoId && c.items[ammoId], clip = Number(w.clip) || 0;
    if (clip > 0) {                                             // magazine: fire from loaded rounds (reload with R)
      p.mags = p.mags || {};
      if ((p.mags[w.id] || 0) < cost) return count(p, ammoId) >= cost ? reload(c, ws, p, a, now, ev) : say('Out of ' + lower(itemName(c, ammoId)) + '.');   // empty: the click reloads
    } else if (ammoId && count(p, ammoId) < cost) return say('Out of ' + lower(itemName(c, ammoId)) + '.');
    faceTo(p, tx, ty);
    if (clip > 0) p.mags[w.id] = (p.mags[w.id] || 0) - cost;
    else if (ammoId) take(p, ammoId, cost);
    p.cooldowns = p.cooldowns || {}; p.cooldowns._shoot = now + fire;
    questCount(c, p, 'shoot', '*', now, ev);
    wear(c, p, w, ev);
    var pen = ammoIt ? (ammoIt.penetration || 1) : 1, fall = ammoIt ? (ammoIt.falloff || 0) : 0;
    var base = stats(c, p).atk, ms = mapState(ws, p.map), hits = 0, end = { x: p.x, y: p.y }, endAt = -1;
    // What was spent that can be had back (the ammo's recover chance, rolled per round): stuck in the monster the shot
    // ends in (it goes into its carcass or loot bag when it dies), else lying where the shot stopped.
    var back = 0, rec = ammoIt ? Number(ammoIt.recover) || 0 : 0;
    for (var ri = 0; rec > 0 && ri < cost; ri++) if (rng() < rec) back++;
    for (var i = 0; i < reach.cells.length; i++) {
      end = reach.cells[i]; endAt = i;
      if (hits >= pen) break;
      var m = monsterAt(ms, end.x, end.y); if (!m) continue;
      var dmg = Math.max(1, Math.round(damage(base, monStats(c, m).def, rng) * Math.pow(1 - fall, hits)));
      if (!hits) noteAct(p, 'r', m.x, m.y, dmg);
      if (back && hits + 1 >= pen) { stickIn(c, m, ammoId, back); back = 0; }   // the shot ends in this one
      hitMonster(c, ws, p.map, p, m, dmg, now, rng, ev, 'You shoot the ' + lower(c.monsters[m.ref].name) + ' for ' + dmg + '.');
      hits++;
    }
    ev.push({ type: 'shoot', map: p.map, by: p.id, from: { x: p.x, y: p.y }, to: { x: end.x, y: end.y },
      aim: { x: tx, y: ty }, color: w.tint || '#ffd36b' });
    if (back) layOnGround(c, ws, p.map, reach.cells.slice(0, endAt + 1), ammoId, back, now);   // it hit nothing: it lies where it stopped
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
    noteAct(p, 't', tx, ty, 0);                                  // (the others see the arm swing)
    p.cooldowns = p.cooldowns || {}; p.cooldowns._throw = now + (Number(it.fireMs) || 0);
    faceTo(p, tx, ty);
    var ms = mapState(ws, blastMap), area = Number(it.throwArea) || 0;
    // Splash from where it detonates, onto only the monsters the blast can actually reach (not through walls).
    var mons = (ms.monsters || []).filter(function (m) {
      return !m.dead && cheb(m.x, m.y, land.x, land.y) <= area && clearLine(c, map, land.x, land.y, m.x, m.y, stateFn, edgeBlocksMove);
    });
    ev.push({ type: 'throw', map: blastMap, by: p.id, item: id, from: { x: p.x, y: p.y }, to: { x: land.x, y: land.y },
      area: area, color: it.tint || '#ff8c3b', fromMap: far ? p.map : undefined, noise: throwNoise(c, it) || undefined });
    soundAt(c, ws, blastMap, land.x, land.y, throwNoise(c, it), now, p);   // it lands: whoever hears it comes to look there
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
    if (!mons.length && !broke) say('The ' + lower(it.name) + (area > 0 ? ' goes off, hitting nothing.' : ' hits nothing.'));
  }

  /** Rearrange a bar. bar 'ability' = the 2 Q/E skill slots; 'belt' = the BELT_SIZE item slots. */
  // On the belt, entry = an item: a stack of it moves onto that slot (cell = the bag cell it comes from, if given),
  // what was there going back where it came from; entry '' = what is there goes back into the bag.
  function setLoadout(c, p, bar, slot, entry, ev, cell) {
    slot = Number(slot); entry = String(entry || '');
    if (bar === 'belt') {
      if (!(slot >= 0 && slot < BELT_SIZE) || slot !== Math.floor(slot)) return;
      var there = beltStack(p, slot);
      if (!entry) {
        if (!there) return;
        var fc = freeCell(p.inventory);
        if (fc >= bagSlots(c)) { ev.push({ type: 'info', to: p.id, text: 'Your bag is full.' }); return; }
        there.s = fc;
      } else {
        if (!c.items[entry]) { ev.push({ type: 'info', to: p.id, text: 'That cannot go on the belt.' }); return; }
        var from = cell != null && cell !== '' ? stackAt(p.inventory, Math.floor(Number(cell))) : null;
        var st = from && from.item === entry ? from : (p.inventory.filter(function (x) { return x.item === entry && onBeltCell(x.s); })[0] || bagStackOf(p, entry));
        if (!st) { ev.push({ type: 'info', to: p.id, text: 'You have none.' }); return; }
        toBelt(p, st, slot);
      }
      if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);   // what is in hand may have just changed
      return;
    }
    var ab = true, arr = p.abilities, lim = 2;
    if (!arr || !(slot >= 0 && slot < lim)) return;
    if (entry && ab && usableSkills(c, p).indexOf(entry) < 0) { ev.push({ type: 'info', to: p.id, text: 'You can\'t use that skill.' }); return; }
    if (entry && !ab && !c.items[entry]) { ev.push({ type: 'info', to: p.id, text: 'That can\'t go on the belt.' }); return; }
    var was = arr.indexOf(entry);
    if (entry && was >= 0) arr[was] = arr[slot];               // swap if it was already on the bar
    arr[slot] = entry;
    if (!ab && typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);   // what is in hand may have just changed
  }

  // ------------------------------------------------------------ data-driven actions
  /** "flag:met_mayor, has:iron_key, !flag:done, level:3, quest:first_steps, quest_active:rats" -> all must hold */
  // In a dialogue (dlg = its id) two more read the character's memory of it: `talked` (they have spoken before) and
  // `said:<line>` (the NPC has said that line to them). Elsewhere they are written in full: talked:<dialogue>,
  // said:<dialogue>/<line>.
  function check(c, p, cond, dlg) {
    return String(cond || '').split(',').every(function (part) {
      part = part.trim(); if (!part) return true;
      var not = part.charAt(0) === '!'; if (not) part = part.slice(1);
      var a = part.split(':'), ok;
      if (a[0] === 'flag') ok = !!(p.flags || {})[a[1]];
      else if (a[0] === 'has') ok = count(p, a[1]) >= (Number(a[2]) || 1);
      else if (a[0] === 'level') ok = p.level >= Number(a[1]);
      else if (a[0] === 'quest') ok = !!(p.questsDone || {})[a[1]];              // that quest has been handed in
      else if (a[0] === 'quest_active') ok = !!(p.quests || {})[a[1]];         // that quest is in the log
      else if (a[0] === 'talked') ok = !!(p.talk || {})[a[1] || dlg || ''];
      else if (a[0] === 'said') {
        var sd = String(a[1] || '').split('/'), mem = (p.talk || {})[sd.length > 1 ? sd[0] : (dlg || '')];
        ok = !!mem && (mem.n || []).indexOf(sd[sd.length - 1]) >= 0;
      }
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
    return (p.inventory || []).some(function (s) { var it = c.items[s.item]; return it && it.tools && !isBroken(c, s) && tags.some(function (g) { return it.tools.indexOf(g) >= 0; }); });
  }
  function toolsText(tag) { return toolTags(tag).map(aAn).join(' or '); }
  /** The crafting stations in reach: {stationId: object name}. A station is an object of kind craft; its id as a
   *  station is its `station` setting (several objects may share one) or, with none, the object's own id. */
  function stationsNear(c, map, p, lk) {
    var out = {}, range = Number(c.config.station_range) || 2;
    (map.entities || []).forEach(function (e) {
      var o = objOf(c, e), id = o && o.kind === 'craft' && (props(c, e).station || o.id);
      if (!id || cheb(p.x, p.y, e.x, e.y) > range) return;
      if (e.need && (e.prog || 0) < e.need) return;                      // still being built
      if (isBuiltEnt(map, e) && !mayUse(c, map, p, e.x, e.y)) return;    // in someone else's base
      if (!(p.x === e.x && p.y === e.y) && !canSee(c, map, p.x, p.y, e.x, e.y, lk.stateOf)) return;
      out[id] = o.name;
    });
    return out;
  }
  function stationName(c, id) {
    var k = Object.keys(c.objects).filter(function (x) { var o = c.objects[x]; return o.kind === 'craft' && ((o.properties && o.properties.station) || x) === id; })[0];
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
  // ---- repair and take apart (a weapon or tool; the bag's item card). The page asks the same two questions to show
  // the buttons, so both agree. Neither looks at whether the recipe is unlocked: knowing how to use it is enough.
  /** The first recipe that makes this item, or null. */
  function recipeMaking(c, id) {
    var recs = c.recipes || {}, k = Object.keys(recs).filter(function (x) { return list(recs[x].outputs).some(function (g) { return g.item === id; }); })[0];
    return k ? recs[k] : null;
  }
  /** Half of a recipe's inputs (up = rounded up), as [{item, qty}] with qty > 0. */
  function halfOf(r, up) { return r ? list(r.inputs).map(function (g) { return { item: g.item, qty: up ? Math.ceil(g.qty / 2) : Math.floor(g.qty / 2) }; }).filter(function (g) { return g.qty > 0; }) : []; }
  /** May p repair this stack here? {ok, reason, cost: [{item, qty, have}], station}. map/lk = the live map and its lookup. */
  function repairInfo(c, map, p, lk, st) {
    var it = st && c.items[st.item], d = durOf(c, st), r = it && recipeMaking(c, it.id);
    var cost = (it && list(it.repairCost).length ? list(it.repairCost) : halfOf(r, true)).filter(function (g) { return c.items[g.item] && g.qty > 0; })
      .map(function (g) { return { item: g.item, qty: g.qty, have: count(p, g.item) }; });
    // where: its own repair_station, else its recipe's station, else anywhere. An item no recipe makes is mended with its
    // own repair_cost (a repair kit); with neither it cannot be.
    var station = (it && it.repairStation) || (r && r.station) || '';
    var out = { ok: false, reason: '', cost: cost, station: station };
    if (!d) out.reason = 'It does not wear out.';
    else if (d.left >= d.max) out.reason = 'It is not worn.';
    else if (!cost.length) out.reason = 'Nothing you know can mend it.';
    else if (station && !stationsNear(c, map, p, lk)[station]) out.reason = 'Needs ' + aAn(stationName(c, station)) + ' nearby.';
    else if (cost.some(function (g) { return g.have < g.qty; })) out.reason = 'Not enough ' + cost.filter(function (g) { return g.have < g.qty; }).map(function (g) { return lower(itemName(c, g.item)); }).join(', ') + '.';
    else out.ok = true;
    return out;
  }
  /** What taking this stack apart gives: {ok, reason, gives: [{item, qty}]}. */
  function salvageInfo(c, st) {
    var it = st && c.items[st.item];
    var gives = (it && list(it.salvage).length ? list(it.salvage) : halfOf(it && recipeMaking(c, it.id), false)).filter(function (g) { return c.items[g.item] && g.qty > 0; });
    return { ok: gives.length > 0, reason: gives.length ? '' : 'Nothing can be got out of it.', gives: gives };
  }
  /** Every recipe this player knows, with whether it can be made here and now. For the crafting panel. */
  function recipesFor(c, map, p, lk) {
    var stations = stationsNear(c, map, p, lk), recs = c.recipes || {}, cooked = {};
    Object.keys(c.objects).forEach(function (id) { var o = c.objects[id], pr = o.properties || {}; if (o.kind === 'craft' && yes(pr.cooks)) cooked[pr.station || o.id] = 1; });   // what a cooker makes is made IN it, over time
    return Object.keys(recs).map(function (id) { return recs[id]; })
      .filter(function (r) { return (!r.unlock || check(c, p, r.unlock)) && !(r.station && cooked[r.station]); })
      .map(function (r) {
        var chk = recipeCheck(c, r, p, stations, 1);
        return { id: r.id, name: r.name, category: r.category, station: r.station, tool: r.tool, timeS: r.timeS,
          inputs: list(r.inputs).map(function (g) { return { item: g.item, qty: g.qty, have: count(p, g.item) }; }),
          outputs: list(r.outputs), can: chk.ok, reason: chk.reason, here: !r.station || !!stations[r.station] };
      });
  }
  // Making something takes time (the recipe's time_s, per piece; 0 = at once). The materials go in at the start and
  // the player carries the job: p.craft = {id, qty, made, ms: work done on the piece in hand, at: when work was last
  // counted, on: was the player at the station then}. Work only counts while they stay within reach of the station
  // (a recipe made by hand counts anywhere); walk away and it waits, come back and it goes on. craftTick runs before
  // every action and on every turn of the world. Time between two counts is capped (CRAFT_GAP), so a page that
  // stopped asking — a closed tab — does not keep working.
  var CRAFT_GAP = 30000;
  function craftingHere(c, map, p, lk, r) {
    return !!r && p.hp > 0 && (!r.station || !!stationsNear(c, map, p, lk)[r.station]);
  }
  function craftTick(c, ws, p, now, ev) {
    var j = p.craft; if (!j) return;
    var r = (c.recipes || {})[j.id];
    if (!r || !c.maps[p.map]) { if (!r) delete p.craft; return; }
    var here = craftingHere(c, liveMap(c, ws, p.map), p, serverLookup(c, ws, p.map, [p]), r);
    if (j.on && here) j.ms = (Number(j.ms) || 0) + Math.min(CRAFT_GAP, Math.max(0, now - (Number(j.at) || now)));
    j.at = now; j.on = here;
    var need = Math.max(1, r.timeS * 1000), made = list(r.outputs), n = 0;
    while (j.made < j.qty && j.ms >= need) { j.ms -= need; j.made++; n++; }
    if (n) {
      made.forEach(function (g) { give(c, p, g.item, g.qty * n, ev); questCount(c, p, 'craft', g.item, now, ev, g.qty * n); });
    }
    if (j.made >= j.qty) delete p.craft;
  }
  var CRAFT_MAX = 99;                                          // the most of one recipe asked for in one go
  function craft(c, ws, p, a, now, ev) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    if (a.cancel) {                                           // stop: what was not made yet comes back
      var j = p.craft, jr = j && (c.recipes || {})[j.id];
      if (!j) return;
      delete p.craft;
      if (jr) list(jr.inputs).forEach(function (g) { give(c, p, g.item, g.qty * (j.qty - j.made), ev); });
      return say('You stop. What you had not used is back in your bag.');
    }
    var r = (c.recipes || {})[String(a.recipe || '')];
    if (!r || (r.unlock && !check(c, p, r.unlock))) return say('You don\'t know how to make that.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (p.craft) return say('You are already making something.');
    var qty = Math.max(1, Math.min(CRAFT_MAX, Math.round(Number(a.qty)) || 1));
    var map = liveMap(c, ws, p.map), chk = recipeCheck(c, r, p, stationsNear(c, map, p, serverLookup(c, ws, p.map, [p])), qty);
    if (!chk.ok) return say(chk.reason);
    list(r.inputs).forEach(function (g) { take(p, g.item, g.qty * qty); });
    var made = list(r.outputs);
    if (r.timeS > 0) {
      p.craft = { id: r.id, qty: qty, made: 0, ms: 0, at: now, on: true };
      return say('You start on ' + (qty > 1 ? qty + ' × ' : '') + lower(r.name || itemName(c, (made[0] || {}).item)) + '.');
    }
    made.forEach(function (g) { give(c, p, g.item, g.qty * qty, ev); questCount(c, p, 'craft', g.item, now, ev, g.qty * qty); });
  }

  /** "give:potion:2; gold:10; heal:20; flag:x; teleport:map_1:3:4; set_state:map_3.e7:open; message:Hello" */
  // by = the quest whose on_start / goal on_done is running it: a quest it starts remembers that (closed with it on abandon)
  function run(c, ws, p, script, now, ev, by) {
    var cmds = String(script || '').split(';');
    for (var ci = 0; ci < cmds.length; ci++) if (one(cmds[ci])) return;
    // scene:<id> plays a scene for this player; the rest of the list waits for it to end (sceneEnd runs it then,
    // watched or skipped). A scene already seen, missing or queued is passed over and the list goes straight on.
    function one(cmd) {
      cmd = cmd.trim(); if (!cmd) return false;
      if (cmd.indexOf('scene:') === 0) return sceneQueue(c, ws, p, cmd.slice(6).trim(), cmds.slice(ci + 1).join(';'), now, by);
      cmdRun(cmd); return false;
    }
    function cmdRun(cmd) {
      var i = cmd.indexOf(':'), verb = i < 0 ? cmd : cmd.slice(0, i), arg = i < 0 ? '' : cmd.slice(i + 1), a = arg.split(':');
      if (verb === 'give') give(c, p, a[0], Number(a[1]) || 1, ev);
      else if (verb === 'take') take(p, a[0], Number(a[1]) || 1);
      else if (verb === 'gold') { var g = Number(a[0]) || 0; if (g > 0) give(c, p, 'gold', g, ev); else p.gold = Math.max(0, p.gold + g); }
      else if (verb === 'heal') p.hp = Math.min(stats(c, p).maxHp, p.hp + (Number(a[0]) || 0));
      else if (verb === 'damage') { if (ws) { p.hp -= Number(a[0]) || 0; if (p.hp <= 0) die(c, ws, p, ev); } }   // (no world = a new character's first quest: nothing to die in)
      else if (verb === 'flag') p.flags[a[0]] = true;
      else if (verb === 'unflag') delete p.flags[a[0]];
      else if (verb === 'teleport') teleport(c, p, arg, ev);
      else if (verb === 'set_state') { if (ws) setState(ws, p.map, a[0], a[1] || null); }
      else if (verb === 'xp') gainXp(c, p, Number(a[0]) || 0, ev);
      else if (verb === 'cure') {
        var which = a[0] || 'infection', before = (p.statuses || []).length;
        p.statuses = (p.statuses || []).filter(function (s) { return s.id !== which; });
        if (p.statuses.length < before) ev.push({ type: 'info', to: p.id, text: which === 'infection' ? 'The infection fades.' : 'You feel better.' });
      }
      else if (verb === 'quest') questStart(c, ws, p, a[0], now, ev, { announce: true, by: by });   // start a quest (from an object, an item, a trigger, another quest's rewards or hooks): the page shows it in its "New quest" window
      else if (verb === 'message') ev.push({ type: 'info', to: p.id, text: arg });
    }
  }

  // ------------------------------------------------------------ emotes (CLAUDE.md "Emotes")
  // A player's emote: {type: 'emote', id} → p.em / p.emAt. Others are sent "id@when" for EMOTE_SEND_MS after it was
  // made (players in the view, publicPlayer); the page shows it for its own time (client/js/emotes.js) and drops it after.
  var EMOTE_SEND_MS = 10000;
  function Ct() { return typeof Content !== 'undefined' ? Content : require('./content.js'); }
  function emoteKnown(id) { return (Ct().EMOTES || []).some(function (e) { return e.id === id; }); }
  function emoteOf(p, now) { return p && p.em && now - (Number(p.emAt) || 0) < EMOTE_SEND_MS ? p.em + '@' + p.emAt : undefined; }

  // ------------------------------------------------------------ scenes (cinematics; CLAUDE.md "Scenes")
  // A scene (Content: c.scenes[id] = {name, steps}) is PLAYED by the page (client/js/scene.js); the referee only keeps
  // who is watching what. p.sceneQ = [{id, then, by, at}]: the first is the one playing (at = when it started, or was
  // started again by a page that came back), the rest wait their turn; `then` = the rest of the action list that
  // started it, held until it ends, so the world changes the same whether it is watched or skipped. p.scenes[id] =
  // when it was seen: each scene plays once per character. While watching (watching(), for at most Config
  // scene_max_s) nobody notices them, nothing hurts them, hunger and thirst wait, and they do nothing themselves.
  function sceneMaxMs(c) { return Math.max(5, cfgNum(c, 'scene_max_s', 120)) * 1000; }
  function watching(c, p, now) {
    var q = p && p.sceneQ && p.sceneQ[0];
    return !!q && (now == null ? Date.now() : now) - (Number(q.at) || 0) < sceneMaxMs(c);
  }
  function sceneBegin(c, ws, p, now) {
    p.sceneQ[0].at = now;
    delete p.sneak;
    var ms = ws && ws.maps && ws.maps[p.map];                  // whatever was after them gives up
    ((ms && ms.monsters) || []).forEach(function (m) {
      if (m.engaged === p.id) m.engaged = null;
      if (m.chase === p.id) delete m.chase;
      if (m.ai && m.ai.k === 'p' && m.ai.id === p.id) delete m.ai;
    });
    delete p.chased;
  }
  // ---- actors that STAY (owner, 27 Nov 2026). A scene is only drawn, so an actor ticked "stays" (on its Show or Walk
  // step) is made real when the scene ends, watched or skipped: a monster becomes a real one on the tile the scene left
  // it on (the last tile it was shown on or walked to; the nearest free one if that is taken), nobody's (m.free: no
  // spawner, gone for good when killed), standing still for SCENE_STAY_WAIT_MS before it acts like its kind; the player
  // really ends up where their figure was left. Worked out from the scene's own steps, never from what the page says.
  // Its look is rolled when the scene is queued (q.cast, sent as publicPlayer.sceneCast) so the page shows the very one
  // that stays. NPCs never stay: that is light phasing (docs/QUESTS_INSTANCES_SERVER.md, Part 3).
  var SCENE_STAY_WAIT_MS = 2000, SCENE_STAY_REACH = 3;
  function sceneStays(sc) {
    var at = {}, out = {};
    ((sc && sc.steps) || []).forEach(function (s) {
      var a = s.a; if (!a || (a !== 'me' && a.indexOf('mon:') !== 0)) return;
      var rec = at[a];
      if (s.type === 'show') rec = at[a] = { on: true, stay: !!(rec && rec.stay), n: a === 'me' ? 1 : Math.max(1, Math.min(12, Math.round(Number(s.count) || 1))) };
      else if (s.type === 'walk') { if (!rec && a === 'me') rec = at[a] = { on: true, stay: false }; if (!rec || !rec.on) return; }
      else { if (s.type === 'leave' && rec) rec.on = false; return; }
      rec.x = Math.round(Number(s.x) || 0); rec.y = Math.round(Number(s.y) || 0);
      if (s.stay) rec.stay = true;
    });
    Object.keys(at).forEach(function (a) { if (at[a].on && at[a].stay && at[a].x !== undefined) out[a] = { x: at[a].x, y: at[a].y, n: at[a].n || 1 }; });
    return out;
  }
  // An actor's ref is mon:<id> or mon:<id>#<copy>; a pack's members are <ref>, <ref>|2, <ref>|3… (client/js/scene.js).
  function sceneMonster(c, ref) { return c.monsters[String(ref).slice(4).split('#')[0].split('|')[0]]; }
  function sceneMembers(ref, n) { var out = [ref]; for (var k = 2; k <= n; k++) out.push(ref + '|' + k); return out; }
  /** Where a pack of n stands round a tile: the tile itself, then the nearest tiles that can be WALKED to from it
   *  (eight ways, as players walk; `opts` = the move options, with nobody counted as in the way). The page (the pack in
   *  the scene) and the referee (the pack that stays) both ask this, so a pack stays where it was seen. */
  function packSpots(c, map, at, n, opts) {
    var R = Rl(), dirs = Object.keys(R.DIRS).concat(Object.keys(R.DIAG || {})), seen = {}, out = [], guard = 0;
    var q = [{ x: Math.round(at.x), y: Math.round(at.y) }]; seen[q[0].x + ',' + q[0].y] = 1;
    while (q.length && out.length < n && guard++ < 400) {
      var cur = q.shift(); out.push(cur);
      for (var i = 0; i < dirs.length; i++) {
        var r = R.tryMove(c, map, cur.x, cur.y, dirs[i], opts);
        if (!r.ok || r.map || seen[r.x + ',' + r.y]) continue;
        seen[r.x + ',' + r.y] = 1; q.push({ x: r.x, y: r.y });
      }
    }
    return out;
  }
  function sceneSpot(c, ws, p, x, y, self) {                    // the free tile nearest (x, y) with no player on it, or null
    var best = null, bd = Infinity;
    for (var dy = -SCENE_STAY_REACH; dy <= SCENE_STAY_REACH; dy++) for (var dx = -SCENE_STAY_REACH; dx <= SCENE_STAY_REACH; dx++) {
      var cx = x + dx, cy = y + dy, d = Math.abs(dx) + Math.abs(dy);
      if (d >= bd || !free(c, ws, p.map, cx, cy, self)) continue;
      if (self !== p && cx === p.x && cy === p.y) continue;
      best = { x: cx, y: cy }; bd = d;
    }
    return best;
  }
  function sceneLeave(c, ws, p, q, now) {
    var stays = sceneStays((c.scenes || {})[q.id]), n = 0;
    if (stays.me) { var sp = sceneSpot(c, ws, p, stays.me.x, stays.me.y, p); if (sp) { p.x = sp.x; p.y = sp.y; } }   // (first: the monsters keep off that tile)
    Object.keys(stays).forEach(function (ref) {
      if (ref === 'me') return;
      var def = sceneMonster(c, ref); if (!def) return;
      // a pack: each on its own tile of the pack's spots (the same the page showed), or the nearest one still free
      var nobody = Object.assign(moveOpts(c, ws, p.map, [], null), { occupied: function () { return null; } });
      var spots = stays[ref].n > 1 ? packSpots(c, liveMap(c, ws, p.map), stays[ref], stays[ref].n, nobody) : [];
      sceneMembers(ref, stays[ref].n).forEach(function (mref, k) {
        var ms = mapState(ws, p.map), want = spots[k] || stays[ref];
        var at = sceneSpot(c, ws, p, want.x, want.y, null); if (!at) return;
        var m = { id: 'scene_' + q.id + '_' + p.id + '_' + now.toString(36) + '_' + (n++), ref: def.id, spawn: '', x: at.x, y: at.y, hp: def.hp, dead: false,
          last: now, respawnAt: 0, facing: at.x > p.x ? 'W' : at.x < p.x ? 'E' : 'S', free: true, wait: now + SCENE_STAY_WAIT_MS };
        var look = (q.cast && q.cast[mref]) || rollLook(c, def, Math.random);
        if (look) m.look = look;
        (ms.monsters = ms.monsters || []).push(m);
        ws.dirty = true;
      });
    });
  }
  function sceneQueue(c, ws, p, id, then, now, by) {
    var sc = (c.scenes || {})[id];
    if (!sc || !sc.steps.length || (p.scenes || {})[id] || (p.sceneQ || []).some(function (q) { return q.id === id; })) return false;
    p.sceneQ = p.sceneQ || [];
    var cast = null;                                            // the looks of the monsters that will stay, rolled now
    var staying = sceneStays(sc);
    Object.keys(staying).forEach(function (ref) {
      if (ref === 'me') return;
      sceneMembers(ref, staying[ref].n).forEach(function (mref) {        // (each its own look, as monsters have when they spawn)
        var look = rollLook(c, sceneMonster(c, ref), Math.random);
        if (look) (cast = cast || {})[mref] = look;
      });
    });
    p.sceneQ.push({ id: id, then: String(then || '').trim(), by: by || '', at: 0, cast: cast || undefined });
    if (p.sceneQ.length === 1) sceneBegin(c, ws, p, now);
    if (p.talkAt) delete p.talkAt;                            // (a conversation that plays a scene is over)
    return true;
  }
  function sceneEnd(c, ws, p, now, ev) {
    var q = (p.sceneQ || []).shift(); if (!q) return;
    (p.scenes = p.scenes || {})[q.id] = now;
    sceneLeave(c, ws, p, q, now);                              // who stays: made real now (before what the list held)
    if (p.sceneQ.length) sceneBegin(c, ws, p, now); else delete p.sceneQ;
    if (q.then) run(c, ws, p, q.then, now, ev, q.by || undefined);
  }
  /** {type: 'scene', op: 'play' | 'end', id} from the page: it (re)started the scene, or it is over (watched or skipped). */
  function sceneAct(c, ws, p, action, now, ev) {
    var q = p.sceneQ && p.sceneQ[0];
    if (!q || String(action.id || '') !== q.id) return;      // (an old message about a scene already over)
    if (action.op === 'play') q.at = now;
    else if (action.op === 'end') sceneEnd(c, ws, p, now, ev);
  }

  // ------------------------------------------------------------ quests
  // A quest (Content: c.quests[id], with goals [{type: kill|have|talk, ref, need}]) is offered by its giver, lives in
  // the player's log while it is being done, and is handed in to its ender. The log is p.quests[id] = { n: [count per
  // goal], at }; p.questsDone[id] = when it was handed in. `have` goals are never counted: they are whatever is in
  // the bag right now (and are taken at hand-in). questState is the one question, for the referee and for what the
  // page is told (publicPlayer: quests + questsOpen); the page never works a state out itself.
  //   closed  not offered (requires not met)        open    could be accepted now
  //   active  in the log, not finished              ready   in the log, every goal met: hand it in
  //   done    handed in, not repeatable             wait    handed in, repeatable, not yet again
  var QUEST_LOG_MAX = 25, QUIET_GOALS = { walk: 1 };          // (quiet = counted without a line in the log each time)
  var UI_GOALS = { bag: 1, quests: 1, craft: 1, build: 1 };  // the windows a `ui` goal may name (Content.UI_PARTS)
  function goalCount(p, q, i) {
    var g = q.goals[i], st = (p.quests || {})[q.id];
    var kept = Number(((st && st.n) || [])[i]) || 0;
    // have = what is in the bag right now (it is taken at hand-in). own = the most that was ever in the bag at once
    // while on the quest (questSweep keeps the mark): once had, it stays ticked even if the item is then eaten or used.
    return Math.min(g.need, g.type === 'have' ? count(p, g.ref) : g.type === 'own' ? Math.max(kept, count(p, g.ref)) : kept);
  }
  function questState(c, p, q, now) {
    if ((p.quests || {})[q.id]) return q.goals.every(function (g, i) { return g.opt || goalCount(p, q, i) >= g.need; }) ? 'ready' : 'active';   // (an optional goal never holds it back)
    var done = (p.questsDone || {})[q.id];
    if (done) { if (!(q.repeatS > 0)) return 'done'; if (now < done + q.repeatS * 1000) return 'wait'; }
    return check(c, p, q.requires) ? 'open' : 'closed';
  }
  /** The log as the page shows it: [{id, s: 'active'|'ready', n: [count per goal]}], oldest first. */
  function questLog(c, p, now) {
    var qs = c.quests || {};
    return Object.keys(p.quests || {}).filter(function (id) { return qs[id]; }).sort(function (a, b) { return (p.quests[a].at || 0) - (p.quests[b].at || 0); }).map(function (id) {
      var q = qs[id];
      var e = { id: id, s: questState(c, p, q, now), n: q.goals.map(function (g, i) { return goalCount(p, q, i); }) };
      if (p.quests[id].hide) e.hide = 1;                       // not followed: kept out of the tracker (quest op follow)
      return e;
    });
  }
  /** The quests this player could accept right now (ids, in the order they were written). */
  function questsOpen(c, p, now) {
    var qs = c.quests || {};
    return Object.keys(qs).filter(function (id) { return questState(c, p, qs[id], now) === 'open'; }).sort(function (a, b) { return qs[a].order - qs[b].order; });
  }
  /** What a goal is about, in words: its own label if it was given one, else the name of its target. */
  function goalText(c, g) {
    if (g.label) return g.label;
    if (g.type === 'kill' || g.type === 'tame') return (c.monsters[g.ref] ? c.monsters[g.ref].name : g.ref);
    if (g.type === 'have' || g.type === 'own' || g.type === 'use' || g.type === 'craft') return itemName(c, g.ref);
    if (g.type === 'build') return ((c.blueprints || {})[g.ref] ? c.blueprints[g.ref].name : g.ref);
    if (g.type === 'goto') return (c.maps[g.ref] ? c.maps[g.ref].name : g.ref);
    if (g.type === 'drink') return g.ref === '*' ? 'Drink some water' : 'Drink ' + lower(itemName(c, g.ref));
    if (g.type === 'eat') return g.ref === '*' ? 'Eat something' : 'Eat ' + lower(itemName(c, g.ref));
    if (g.type === 'walk') return 'Walk around';
    if (g.type === 'hit') return 'Hit something';
    if (g.type === 'shoot') return 'Fire a shot';
    if (g.type === 'hold') return g.ref === '*' ? 'Take something in hand' : 'Take the ' + lower(itemName(c, g.ref)) + ' in hand';
    if (g.type === 'ui') return 'Open the ' + ({ bag: 'bag', quests: 'quest log', craft: 'crafting window', build: 'build bar' }[g.ref] || g.ref);
    if (g.type === 'interact') return (c.objects[g.ref] ? c.objects[g.ref].name : g.ref);
    return 'Talk to ' + (c.objects[g.ref] ? c.objects[g.ref].name : g.ref);
  }
  function npcName(c, id) { return c.objects[id] ? c.objects[id].name : 'someone'; }
  /** Tell the player once when the last goal of a quest is met. */
  function questReady(c, p, q, was, now, ev) {
    if (was !== 'ready' && questState(c, p, q, now) === 'ready')
      ev.push({ type: 'quest', to: p.id, ready: q.id, text: q.tutorial ? '' : q.name + ': done.' + (q.ender ? ' Return to ' + npcName(c, q.ender) + '.' : '') });   // (a tutorial step is never tracked where the player sees it)
  }
  /**
   * Something a quest may ask for happened — a kill of `ref`, a talk with npc object `ref`, an item used, crafted,
   * a blueprint built, an animal tamed, an object used: every quest in the log that asks for it moves on (by
   * `amount`, 1 unless said). The kinds are Content.GOAL_TYPES; `have` and `goto` are not counted here.
   */
  function questCount(c, p, type, ref, now, ev, amount) {
    var qs = c.quests || {};
    if (!p || !p.quests) return;
    Object.keys(p.quests).forEach(function (id) {
      var q = qs[id], st = p.quests[id]; if (!q) return;
      q.goals.forEach(function (g, i) {
        if (g.type !== type || (g.ref !== ref && g.ref !== '*')) return;   // ("*" = anything will do)
        st.n = Array.isArray(st.n) ? st.n : [];
        var have = Number(st.n[i]) || 0; if (have >= g.need) return;
        var was = questState(c, p, q, now);
        st.n[i] = Math.min(g.need, have + Math.max(1, Math.round(Number(amount) || 1)));
        if (g.need > 1 && !QUIET_GOALS[g.type] && !q.tutorial) ev.push({ type: 'quest', to: p.id, text: goalText(c, g) + ': ' + st.n[i] + '/' + g.need });
        questReady(c, p, q, was, now, ev);
      });
    });
  }
  /** Places to reach: after anything the player did, are they standing within reach of one a quest asks for? */
  function questPlaces(c, p, now, ev) {
    var qs = c.quests || {};
    if (!p || !p.quests) return;
    Object.keys(p.quests).forEach(function (id) {
      var q = qs[id], st = p.quests[id]; if (!q) return;
      q.goals.forEach(function (g, i) {
        if (g.type !== 'goto' || g.ref !== p.map || cheb(p.x, p.y, g.x, g.y) > g.r) return;
        st.n = Array.isArray(st.n) ? st.n : [];
        if (Number(st.n[i]) >= 1) return;
        var was = questState(c, p, q, now);
        st.n[i] = 1;
        if (questState(c, p, q, now) !== 'ready' && !q.tutorial) ev.push({ type: 'quest', to: p.id, text: q.name + ': ' + goalText(c, g) + ' reached.' });
        questReady(c, p, q, was, now, ev);
      });
    });
  }
  /**
   * Start a quest. o.announce = the page shows it in its "New quest" window (p.intro); o.by = the quest whose hook
   * (on_start, a goal's on_done) starts it: it remembers that, and such a start says nothing when it cannot happen
   * (a tutorial step already done, say). A tutorial step for a player who skipped the tutorial is skipped too.
   */
  function questStart(c, ws, p, id, now, ev, o) {
    o = o || {};
    var q = (c.quests || {})[id]; if (!q) return false;
    function say(x) { if (!o.by) ev.push({ type: 'info', to: p.id, text: x }); }
    var s = questState(c, p, q, now);
    if (s === 'active' || s === 'ready') { say('You are already on "' + q.name + '".'); return false; }
    if (s === 'done') { say('You have already done that.'); return false; }
    if (s === 'wait') { say('Not yet: come back later.'); return false; }
    if (s !== 'open') { say('You can\'t take that on yet.'); return false; }
    if (q.tutorial && p.tutOff) { skipSteps(c, ws, p, [id], now, ev); return false; }
    if (Object.keys(p.quests).length >= cfgNum(c, 'quest_log_max', QUEST_LOG_MAX)) { say('Your quest log is full.'); return false; }
    questBegin(c, ws, p, q, now, ev, o);
    return true;
  }
  /**
   * Into the log; announced (in the order things started). Two hooks: before_start runs now, BEFORE its "New quest"
   * window (a scene there plays first, the window waits for it); on_start runs once that window has been read (quest op
   * seen; marked meanwhile as st.os) — or now, when it has no window (taken from an NPC, whose window already showed it).
   */
  function questBegin(c, ws, p, q, now, ev, o) {
    p.quests[q.id] = { n: q.goals.map(function () { return 0; }), at: now };
    if (o.by) p.quests[q.id].by = o.by;
    if (!q.tutorial) ev.push({ type: 'quest', to: p.id, text: 'New quest: ' + q.name });
    if (o.announce) (p.intro = p.intro || []).push(q.id);
    if (q.beforeStart) run(c, ws, p, q.beforeStart, now, ev, q.id);
    if (q.onStart && p.quests[q.id]) { if (o.announce) p.quests[q.id].os = 1; else run(c, ws, p, q.onStart, now, ev, q.id); }
  }
  /** A quest's on_start, if it is still waiting for its window to be read (st.os): run it now, once. */
  function startHook(c, ws, p, id, now, ev) {
    var st = p.quests[id], q = (c.quests || {})[id];
    if (!st || !st.os) return;
    delete st.os;
    if (q && q.onStart) run(c, ws, p, q.onStart, now, ev, q.id);
  }
  /** Out of the log, not done (it can be taken again), with every quest its hooks started that is still open (and theirs). */
  function questDrop(p, id) {
    var gone = [id];
    delete p.quests[id];
    for (var k = 0; k < gone.length && k < 200; k++) Object.keys(p.quests).forEach(function (x) {
      if (p.quests[x] && p.quests[x].by === gone[k]) { delete p.quests[x]; gone.push(x); }
    });
    if (p.intro) { p.intro = p.intro.filter(function (x) { return gone.indexOf(x) < 0; }); if (!p.intro.length) delete p.intro; }
  }
  /** Is one of that NPC object standing next to the player (any of the eight tiles, or the same one)? */
  function npcNear(c, ws, p, objId) {
    var map = liveMap(c, ws, p.map);
    return !!objId && !!map && (map.entities || []).some(function (e) { return e.ref === objId && near(p, e.x, e.y); });
  }
  /** {type: 'quest', op: 'accept' | 'turnin' | 'abandon' | 'follow' | 'seen' | 'did' | 'skip', id, choice?, on?} — choice = which of the choose-one rewards (its place in the list); on = follow it or not. */
  function questAct(c, ws, p, a, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    if (a.op === 'seen') {                                     // a "New quest" window has been read: that one (id), or all of them (an older page)
      var read = a.id ? [String(a.id)] : (p.intro || []).slice();
      if (a.id && p.intro) p.intro = p.intro.filter(function (x) { return x !== String(a.id); });
      if (!a.id || (p.intro && !p.intro.length)) delete p.intro;
      read.forEach(function (id) { startHook(c, ws, p, id, now, ev); });   // its on_start: what comes after the window
      return;
    }
    if (a.op === 'did') { if (UI_GOALS[String(a.what)]) questCount(c, p, 'ui', String(a.what), now, ev); return; }   // the page opened one of its windows (only the page can know)
    if (a.op === 'skip') return questSkip(c, ws, p, now, ev);
    var q = (c.quests || {})[String(a.id || '')];
    if (!q) return say('There is no such quest.');
    if (a.op === 'follow') {                                 // the player's own pick of what the tracker shows (on = shown; the default)
      if (!p.quests[q.id]) return;
      if (a.on === false || a.on === 0) p.quests[q.id].hide = 1; else delete p.quests[q.id].hide;
      return;
    }
    if (a.op === 'abandon') {
      if (!p.quests[q.id]) return;
      if (q.noAbandon) return say('"' + q.name + '" cannot be given up.');
      questDrop(p, q.id);
      return say('You give up on "' + q.name + '".');
    }
    if (a.op === 'accept') {
      if (!q.giver) return say('Nobody offers that.');
      if (!npcNear(c, ws, p, q.giver)) return say('You need to be with ' + npcName(c, q.giver) + '.');
      questStart(c, ws, p, q.id, now, ev);
      return;
    }
    if (a.op !== 'turnin') return;
    if (!p.quests[q.id]) return say('You are not on that quest.');
    if (q.ender && !npcNear(c, ws, p, q.ender)) return say('You need to be with ' + npcName(c, q.ender) + '.');
    if (questState(c, p, q, now) !== 'ready') return say('That is not done yet.');
    var picks = list(q.choice).filter(function (g) { return g.item === 'gold' || c.items[g.item]; }), pick = null;
    if (picks.length) { pick = picks[Math.floor(Number(a.choice))]; if (!pick || a.choice === undefined || a.choice === null || a.choice === '') return say('Choose your reward first.'); }
    questFinish(c, ws, p, q, pick, now, ev);
  }
  /** Hand a ready quest in: what was asked for is taken, it is marked done, the rewards are given. */
  function questFinish(c, ws, p, q, pick, now, ev) {
    q.goals.forEach(function (g) { if (g.type === 'have' && (!g.opt || count(p, g.ref) >= g.need)) take(p, g.ref, g.need); });   // (an optional bring-me is taken only if it was brought in full)
    startHook(c, ws, p, q.id, now, ev);                       // (done before its window was read: its on_start still happens, nothing it starts is lost)
    delete p.quests[q.id];
    p.questsDone[q.id] = now;
    if (p.intro) { p.intro = p.intro.filter(function (x) { return x !== q.id; }); if (!p.intro.length) delete p.intro; }   // (finished before its window was read: nothing left to announce)
    ev.push({ type: 'quest', to: p.id, done: q.id, text: q.tutorial ? '' : 'Quest complete: ' + q.name });
    run(c, ws, p, q.rewards, now, ev);
    if (pick) give(c, p, pick.item, pick.qty, ev);
    if (typeof p.held === 'number' && p.held >= 0) holdSlot(c, p, p.held, ev);   // (what was in hand may have been handed over)
  }
  /**
   * After anything that may have moved a quest on (every action, every turn of the map): places reached. A quest
   * with nobody to hand it to (no giver, no ender) does NOT finish by itself: it waits, ready, and the page shows
   * its done text with a Claim button (the same `turnin`, which needs no NPC when there is no ender).
   */
  function questSweep(c, ws, p, now, ev) {
    if (!p || !p.quests) return;
    questPlaces(c, p, now, ev);
    var qs0 = c.quests || {};
    Object.keys(p.quests).forEach(function (id) {                // `own` goals: remember the most that was in the bag
      var q = qs0[id], st = p.quests[id]; if (!q) return;
      q.goals.forEach(function (g, i) {
        if (g.type !== 'own') return;
        st.n = Array.isArray(st.n) ? st.n : [];
        var has = Math.min(g.need, count(p, g.ref));
        if (has > (Number(st.n[i]) || 0)) st.n[i] = has;
      });
    });
    // A TUTORIAL step with nobody to hand it to (and nothing to choose) does finish by itself: the next step, started
    // by its rewards, opens at once. (Bounded: a step may finish the one it starts, never round in a ring for ever.)
    // A goal's on_done runs once, the first time the goal is met (st.f marks it): one at a time, so what it starts is
    // announced in the order things happened, and anything it moves on is seen by the next round.
    var qs = c.quests || {};
    for (var turn = 0; turn < 20; turn++) {
      if (goalHook(c, ws, p, now, ev)) continue;
      var id = Object.keys(p.quests).filter(function (k) {
        var q = qs[k];
        return q && q.tutorial && !q.ender && q.goals.length && !list(q.choice).length && questState(c, p, q, now) === 'ready';
      })[0];
      if (!id) break;
      questFinish(c, ws, p, qs[id], null, now, ev);
    }
  }
  function goalHook(c, ws, p, now, ev) {
    var qs = c.quests || {}, ids = Object.keys(p.quests);
    for (var k = 0; k < ids.length; k++) {
      var q = qs[ids[k]], st = p.quests[ids[k]]; if (!q || !st) continue;
      for (var i = 0; i < q.goals.length; i++) {
        var g = q.goals[i];
        if (!g.onDone || (st.f && st.f[i]) || goalCount(p, q, i) < g.need) continue;
        st.f = Array.isArray(st.f) ? st.f : [];
        st.f[i] = 1;
        run(c, ws, p, g.onDone, now, ev, q.id);
        return true;
      }
    }
    return false;
  }
  /**
   * Skip tutorial: every tutorial step in the log is closed as done, with no reward, and so is each step it would
   * have started; a quest that is NOT a tutorial step and would have been started by one (the real first quest at
   * the end of the chain) starts now.
   */
  // The choice stays with the character (p.tutOff): a tutorial step a quest's hook would show later is skipped the same way.
  function questSkip(c, ws, p, now, ev) {
    var qs = c.quests || {};
    p.tutOff = true;
    if (skipSteps(c, ws, p, Object.keys(p.quests).filter(function (id) { return qs[id] && qs[id].tutorial; }), now, ev))
      ev.push({ type: 'quest', to: p.id, text: 'Tutorial skipped.' });
  }
  /** Close these tutorial steps as done, unrewarded, and each step they lead to (rewards, before_start, on_start, a goal's on_done). */
  function skipSteps(c, ws, p, todo, now, ev) {
    var qs = c.quests || {}, any = false, guard = 0;
    todo = todo.slice();
    while (todo.length && guard++ < 200) {
      var q = qs[todo.shift()];
      if (!q || (p.questsDone[q.id] && !p.quests[q.id])) continue;
      delete p.quests[q.id]; p.questsDone[q.id] = now; any = true;
      if (p.intro) p.intro = p.intro.filter(function (x) { return x !== q.id; });
      [q.rewards, q.beforeStart, q.onStart].concat(q.goals.map(function (g) { return g.onDone; })).join(';').split(';').forEach(function (cmd) {
        var a = cmd.trim().split(':'), next = a[0] === 'quest' && qs[a[1]];
        if (!next) return;
        if (next.tutorial) todo.push(next.id);
        else questStart(c, ws, p, next.id, now, ev, { announce: true });
      });
    }
    if (p.intro && !p.intro.length) delete p.intro;
    return any;
  }
  /** Talking to an NPC: quests that ask for a word with them move on, and the page is told to open their window. */
  function talkTo(c, ws, p, e, o, pr, now, ev) {
    questCount(c, p, 'talk', o.id, now, ev);
    delete p.sneak;                                            // talking to someone: you stand up (docs/STEALTH.md)
    delete p.talkAt;
    var d = (c.dialogues || {})[String(pr.dialogue || '')], first = d && dlgStart(c, p, d);
    if (first) return dlgSay(c, p, e, o, d, first, ev, true);  // a conversation (below)
    ev.push({ type: 'npc', to: p.id, key: e.key, ref: o.id, name: o.name, text: String(pr.text || ''),
      shop: (c.shops || {})[String(pr.shop || '')] ? 1 : undefined });   // no conversation to open it from: the page shows a Trade button
  }
  // ---- dialogue (Content: c.dialogues[id] = {nodes: {id: {text, start, cond, answers: [{id, text, cond, run, to, once}]}}, order})
  // A conversation opens on the first `start` line whose condition holds (so a first meeting can differ: !talked) and
  // moves by the answers the player picks: an answer may ask a condition, run an action list (the same lists quests and
  // objects use), lead to another line or end the talk, and be offered only once. The character remembers each
  // dialogue: p.talk[dialogue] = {n: [lines said], a: [once-answers used, "line/answer"]}. Where the talk stands is
  // p.talkAt = {k: entity key, d: dialogue, n: line} — the page can only answer the line it was shown.
  function dlgStart(c, p, d) {
    for (var i = 0; i < d.order.length; i++) { var n = d.nodes[d.order[i]]; if (n.start && check(c, p, n.cond, d.id)) return n; }
    return null;
  }
  function dlgAnswers(c, p, d, node) {
    var used = ((p.talk || {})[d.id] || {}).a || [];
    return node.answers.filter(function (a) { return a.text && !(a.once && used.indexOf(node.id + '/' + a.id) >= 0) && check(c, p, a.cond, d.id); });
  }
  /** The NPC says this line: answers are worked out BEFORE the line is remembered (so "!said:this" works on its own answers). */
  function dlgSay(c, p, e, o, d, node, ev, opening) {
    var answers = dlgAnswers(c, p, d, node).map(function (a) { return { a: a.id, text: a.text, end: a.to ? undefined : 1 }; });
    p.talk = p.talk || {};
    var mem = p.talk[d.id] = p.talk[d.id] || { n: [], a: [] };
    if (mem.n.indexOf(node.id) < 0) mem.n.push(node.id);
    p.talkAt = { k: e.key, d: d.id, n: node.id };
    ev.push({ type: 'npc', to: p.id, key: e.key, ref: o.id, name: o.name, text: node.text,
      dlg: { id: d.id, node: node.id, hub: node.start ? 1 : undefined, open: opening ? 1 : undefined, answers: answers } });
  }
  /** {type: 'talk', key, a} — the answer picked (a = its id) to the line this NPC last said; no a = walk away. */
  function talkAct(c, ws, p, action, now, ev) {
    var at = p.talkAt; if (!at) return;
    function end() { delete p.talkAt; ev.push({ type: 'npc', to: p.id, key: at.k, end: 1 }); }
    if (String(action.key || '') !== at.k || action.a == null || action.a === '') { delete p.talkAt; return; }
    var map = liveMap(c, ws, p.map), e = map && (map.entities || []).filter(function (en) { return en.key === at.k; })[0];
    var o = e && objOf(c, e), d = (c.dialogues || {})[at.d], node = d && d.nodes[at.n];
    if (!e || !o || !node || !near(p, e.x, e.y)) return end();
    var ans = dlgAnswers(c, p, d, node).filter(function (a) { return a.id === String(action.a); })[0];
    if (!ans) return dlgSay(c, p, e, o, d, node, ev);          // no longer on offer (things changed meanwhile): the line again, as it stands now
    if (ans.once) { var mem = p.talk[d.id]; if (mem.a.indexOf(node.id + '/' + ans.id) < 0) mem.a.push(node.id + '/' + ans.id); }
    var mapWas = p.map;
    if (ans.run) run(c, ws, p, ans.run, now, ev);
    if (watching(c, p, now)) return end();                      // the answer plays a scene: the talk ends there
    var shop = ans.shop && shopOf(c, e);
    if (shop && p.map === mapWas && near(p, e.x, e.y)) { delete p.talkAt; return shopShow(c, p, e, o, shop, now, ev); }   // "show me what you have"
    var next = ans.to && d.nodes[ans.to];
    if (!next || p.map !== mapWas || !near(p, e.x, e.y) || p.hp <= 0) return end();   // said its last, or the answer took you elsewhere
    dlgSay(c, p, e, o, d, next, ev);
  }
  // ---- shops (Content: c.shops[id] = {name, offers: [{id, gives, costs, sell, stock, restockS, cond}]}; an NPC's
  // properties.shop names one). An offer is one trade: the player gives `costs`, gets `gives` (item lists; gold is
  // "gold"). Stock is per CHARACTER: p.shops[shop][offer] = {n: taken, at: when the first of them was}; restockS after
  // `at` the offer is whole again for them (0 = never). An offer with a condition that does not hold is not shown.
  function shopOf(c, e) { return (c.shops || {})[String(props(c, e).shop || '')] || null; }
  function shopLeft(p, shop, of, now) {
    if (!(of.stock > 0)) return { left: null, back: 0 };
    var m = ((p.shops || {})[shop.id] || {})[of.id];
    if (m && of.restockS > 0 && now >= m.at + of.restockS * 1000) m = null;
    return { left: Math.max(0, of.stock - (m ? m.n : 0)), back: m && of.restockS > 0 ? m.at + of.restockS * 1000 - now : 0, m: m };
  }
  function shopShow(c, p, e, o, shop, now, ev) {
    ev.push({ type: 'shop', to: p.id, key: e.key, ref: o.id, id: shop.id, name: shop.name || o.name,
      offers: shop.offers.filter(function (of) { return check(c, p, of.cond); }).map(function (of) {
        var s = shopLeft(p, shop, of, now), out = { id: of.id, gives: of.gives, costs: of.costs };
        if (of.sell) out.sell = 1;
        if (s.left !== null) { out.left = s.left; if (s.back > 0) out.back = Math.ceil(s.back / 1000); }   // back = seconds until it is whole again
        return out;
      }) });
  }
  /** {type: 'shop', key, op: 'open' | 'trade', offer, qty} — key = the NPC; every trade answers with the shop as it now stands. */
  function shopAct(c, ws, p, a, now, ev) {
    function say(x) { ev.push({ type: 'info', to: p.id, text: x }); }
    var map = liveMap(c, ws, p.map), e = map && (map.entities || []).filter(function (en) { return en.key === String(a.key || ''); })[0];
    var o = e && objOf(c, e), shop = o && o.kind === 'npc' && shopOf(c, e);
    if (!shop) return say('There is nothing to trade here.');
    if (!near(p, e.x, e.y)) return say('You need to be with ' + (o.name || 'them') + '.');
    if (a.op !== 'trade') return shopShow(c, p, e, o, shop, now, ev);
    var of = shop.offers.filter(function (x) { return x.id === String(a.offer || ''); })[0];
    var qty = Math.max(1, Math.min(99, Math.round(Number(a.qty)) || 1));
    if (!of || !check(c, p, of.cond)) return shopShow(c, p, e, o, shop, now, ev);
    var s = shopLeft(p, shop, of, now), costs = list(of.costs).filter(function (g) { return g.qty > 0; });
    if (s.left !== null && s.left < qty) { say(s.left ? 'There ' + (s.left === 1 ? 'is' : 'are') + ' only ' + s.left + ' left.' : 'There is none left.'); return shopShow(c, p, e, o, shop, now, ev); }
    if (!costs.every(function (g) { return count(p, g.item) >= g.qty * qty; })) { say('You don\'t have enough for that.'); return shopShow(c, p, e, o, shop, now, ev); }
    costs.forEach(function (g) { take(p, g.item, g.qty * qty); });
    list(of.gives).forEach(function (g) { if (g.qty > 0 && (g.item === 'gold' || c.items[g.item])) give(c, p, g.item, g.qty * qty, ev); });
    if (s.left !== null) {
      p.shops = p.shops || {};
      var mem = p.shops[shop.id] = p.shops[shop.id] || {};
      if (!s.m) mem[of.id] = { n: 0, at: now };                 // the first of a fresh stock: its clock starts
      mem[of.id].n += qty;
    }
    shopShow(c, p, e, o, shop, now, ev);
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

  // ---- picking (a berry bush): an object with properties.pick (an item list) hands that list over each time it is
  // used, pick_times times (1), then stands EMPTY (state 'empty': its sprite_states "empty=" picture, nothing to do
  // with it) until it is full again pick_s seconds after it was emptied (Config pick_refill_s, 300). It is shared:
  // one count per bush (ms.picks[key]), whoever picks. Never damaged, never gone; nothing runs while it waits but its
  // one timer. Any kind that has no use of its own may carry it (deco, the owner's own kinds).
  /** Is this placed object one that is picked when used? */
  /** A bed that was put down from an item (a bedroll) is a place to come back to and nothing more: it is not used, only picked up. */
  function comeBackOnly(c, e, o) { o = o || objOf(c, e); return !!(e && e.item && o && o.kind === 'rest'); }
  function isPick(c, e, o) { o = o || objOf(c, e); return !!o && !INTERACTIVE[o.kind] && !!props(c, e).pick; }
  /** The thing at (x, y) that p could pick from right now (beside it, something left on it), or null. map = a live
   *  map, lk = serverLookup / viewLookup. The page asks this for as long as the button is held. */
  function pickAt(c, map, lk, p, x, y) {
    if (!map || !near(p, x, y) || ((x !== p.x || y !== p.y) && moveBlockedEdge(c, map, p.x, p.y, x, y))) return null;
    return Rl().entitiesAt(map, x, y).filter(function (e) {
      return isPick(c, e) && lk.stateOf(e) !== 'empty' && !(isBuiltEnt(map, e) && e.need && (e.prog || 0) < e.need);
    })[0] || null;
  }
  /** One pick: the list goes to the player, and the last one leaves it empty until it refills. Paced by Config pick_ms. */
  function pickFrom(c, ws, p, e, o, pr, now, ev) {
    if (now < (p.nextPick || 0)) return;                     // (a held button asks faster than it gives: no words)
    var name = lower(o.name), ms = mapState(ws, p.map);
    if (stateOf(c, ws, p.map, e) === 'empty') { ev.push({ type: 'info', to: p.id, text: 'There is nothing left on the ' + name + '.' }); return; }
    p.nextPick = now + Math.max(0, cfgNum(c, 'pick_ms', 600));
    list(pr.pick).forEach(function (g) { give(c, p, g.item, g.qty, ev); });
    var times = Math.max(1, Math.round(Number(pr.pick_times) || 1)), picks = ms.picks || (ms.picks = {}), n = (Number(picks[e.key]) || 0) + 1;
    if (n >= times) {
      delete picks[e.key];
      setState(ws, p.map, e.key, 'empty');
      ms.timers[e.key] = { at: now + Math.max(1, Number(pr.pick_s) || cfgNum(c, 'pick_refill_s', 300)) * 1000, state: null };
    } else picks[e.key] = n;
    ws.dirty = true;
    if (o.onInteract && (!pr['if'] || check(c, p, pr['if']))) run(c, ws, p, o.onInteract, now, ev);
    questCount(c, p, 'interact', o.id, now, ev);
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
      // Yours alone: the same grid, but what is in it is kept with you — everyone finds their own share of the loot
      // there (put in the first time you open it, and again when it refills), and what you leave is still yours.
      var when = p.flags[flag], mine = mapBox(c, ws, p.map, e.key, true, p);
      if (mine) {
        if (!(when && (!refill || now < when + refill * 1000))) {
          p.flags[flag] = now;
          (pr.contents ? list(pr.contents) : roll(c, pickLootTable(pr, rng), rng, p)).forEach(function (g) {
            if (g.item === 'gold') give(c, p, 'gold', g.qty, ev); else if (c.items[g.item]) addStacks(c, mine.inv, g.item, g.qty, 0);
          });
        }
        ev.push({ type: 'info', to: p.id, text: 'You open the ' + name + '.' });
        storageEvent(c, p, mine, ev);
        return;
      }
      if (when && (!refill || now < when + refill * 1000)) { ev.push({ type: 'info', to: p.id, text: 'It is empty.' }); return; }
      p.flags[flag] = now;
    } else {
      // Everyone's container: it opens as a grid you can take from and put into. What it holds as loot is put inside
      // the first time it is opened (and again each time it refills) — never straight into the bag.
      var bx = mapBox(c, ws, p.map, e.key, true, p);
      if (bx) {
        if (!(st === 'empty' || st === 'open')) {
          setState(ws, p.map, e.key, 'empty');
          if (refill) mapState(ws, p.map).timers[e.key] = { at: now + refill * 1000, state: null };
          (pr.contents ? list(pr.contents) : roll(c, pickLootTable(pr, rng), rng, p)).forEach(function (g) {
            if (g.item === 'gold') give(c, p, 'gold', g.qty, ev); else if (c.items[g.item]) addStacks(c, bx.inv, g.item, g.qty, 0);
          });
        }
        ws.dirty = true;
        ev.push({ type: 'info', to: p.id, text: 'You open the ' + name + '.' });
        storageEvent(c, p, bx, ev);
        return;
      }
      if (st === 'empty' || st === 'open') { ev.push({ type: 'info', to: p.id, text: 'It is empty.' }); return; }
      setState(ws, p.map, e.key, 'empty');
      if (refill) mapState(ws, p.map).timers[e.key] = { at: now + refill * 1000, state: null };
    }
    var got = pr.contents ? list(pr.contents) : roll(c, pickLootTable(pr, rng), rng, p);
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

  var INTERACTIVE = { container: 1, door: 1, teleport: 1, 'switch': 1, rest: 1, sign: 1, craft: 1, npc: 1, trap: 1, claim: 1, pickup: 1, coop: 1 };

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
    var md = m && c.monsters[m.ref];
    if (m && md && md.tameWith && verb !== 'picklock') {       // an animal that can be kept: using it feeds it
      var mname = lower(md.name);
      if (m.tame) { ev.push({ type: 'info', to: p.id, text: m.owner === p.id ? 'Your ' + mname + (m.home && m.home.coop ? ' lives at the coop.' : ' has no coop to live at yet.') : 'That ' + mname + ' belongs to someone.' }); return; }
      if (count(p, md.tameWith) < 1) { ev.push({ type: 'info', to: p.id, text: 'It would take ' + lower(itemName(c, md.tameWith)) + ' to tame the ' + mname + '.' }); return; }
      take(p, md.tameWith, 1);
      var housed = tame(c, ws, p.map, map, ms, m, md, p, now);
      questCount(c, p, 'tame', m.ref, now, ev);
      ev.push({ type: 'info', to: p.id, text: 'The ' + mname + ' is yours now.' + (housed ? ' It settles at the coop.' : ' Build a coop nearby for it to live at.') });
      return;
    }
    if (m && verb !== 'picklock') { ev.push({ type: 'info', to: p.id, text: 'Hold right-click to aim, then click to attack.' }); return; }
    var e = wm;
    if (!e) {
      var fced = blocked ? [] : Rl().entitiesAt(map, f.x, f.y);
      var cells = target ? fced : fced.concat(Rl().entitiesAt(map, p.x, p.y));
      var ents = cells.filter(function (en) { var o = objOf(c, en); return o && !comeBackOnly(c, en, o) && (INTERACTIVE[o.kind] || isPick(c, en, o)); });
      e = ents[0];
    }
    if (!e) {
      var wt = !verb ? structAt(c, map, p, f.x, f.y, needsWork) : null;     // a frame to finish or something to repair
      if (wt) { work(c, ws, p, wt, now, ev); return; }
      var wtr = blocked ? null : waterAt(c, map, f.x, f.y);
      if (wtr && near(p, f.x, f.y)) { useWater(c, p, wtr, verb, ev); return; }
      ev.push({ type: 'info', to: p.id, text: blocked ? (Rl().cliffReach(map, p.x, p.y, f.x, f.y) ? 'You can\'t reach it: the ground is at another height.' : 'A wall is in the way.') : 'Nothing to use here.' }); return;
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
    if (isPick(c, e, o)) { pickFrom(c, ws, p, e, o, pr, now, ev); return; }      // a berry bush: using it picks it
    if (o.onInteract && (!pr['if'] || check(c, p, pr['if']))) run(c, ws, p, o.onInteract, now, ev);
    questCount(c, p, 'interact', o.id, now, ev);
    switch (o.kind) {
      case 'claim':
        if (!isBuiltEnt(map, e)) ev.push({ type: 'info', to: p.id, text: o.name + '.' });
        else if (e.by === p.id) claimEvent(c, p, e, ev);                   // the owner's client opens the members panel
        else ev.push({ type: 'info', to: p.id, text: 'This is ' + claimOwner(e) + '\'s base.' + (isMember(e, p) ? ' You are a member.' : '') });
        break;
      case 'container':
        if (isBuiltEnt(map, e)) {                                          // a storage container someone built: never loot, always a grid
          var brec = structOf(ws, p.map).ents.filter(function (b) { return b.key === e.key; })[0] || e;
          if (!brec.inv) brec.inv = [];
          if (brec.wild && !boxInv(c, brec, p).length) { ev.push({ type: 'info', to: p.id, text: 'There is nothing on the ' + lower(o.name) + '.' }); emptiedWild(c, ws, p, brec, ev); break; }
          storageEvent(c, p, brec, ev);
        }
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
      case 'craft': {
        var ckr = cookerOf(c, e);
        if (ckr) { var cb = cookBox(c, ws, p.map, e, ckr); cookTick(c, ws, p.map, e.key, now); storageEvent(c, p, cb, ev); }   // a cooker: its three cells
        else ev.push({ type: 'craft', to: p.id, key: e.key, station: pr.station || o.id || '' });   // the client opens its crafting panel
        break;
      }
      case 'npc': talkTo(c, ws, p, e, o, pr, now, ev); break;
      case 'pickup': {                                         // something lying on the ground (an egg): into the bag, and it is gone
        list(pr.pickup || (o.properties || {}).pickup).forEach(function (g) { give(c, p, g.item, g.qty, ev); });
        var pst = structOf(ws, p.map), pi = -1; pst.ents.forEach(function (b, i) { if (b.key === e.key) pi = i; });
        if (pi >= 0) pst.ents.splice(pi, 1);
        else {                                               // one the map editor placed: it may come back (respawn_s, else Config pickup_respawn_s)
          var back2 = Number(pr.respawn_s) || cfgNum(c, 'pickup_respawn_s', 0);
          pst.gone[e.key] = back2 > 0 ? 2 : 1;
          if (back2 > 0) ms.timers[e.key] = { at: now + back2 * 1000, regrow: true };
        }
        touchStruct(pst); ws.dirty = true;
        break;
      }
      case 'coop': {
        var birds = (ms.monsters || []).filter(function (q) { return q.tame && !q.dead && q.home && q.home.coop === e.key; });
        var mineN = birds.filter(function (q) { return q.owner === p.id; }).length;
        ev.push({ type: 'info', to: p.id, text: !birds.length ? 'Nobody lives here yet. Tame an animal near it.' : birds.length + ' live' + (birds.length === 1 ? 's' : '') + ' here' + (mineN ? ' (' + mineN + ' yours).' : '.') });
        break;
      }
      case 'trap': ev.push({ type: 'info', to: p.id, text: 'A trap. Better not step on it.' }); break;
    }
  }

  // ---- what is worn. An item's `slot` says where it goes: 'weapon' (in hand: holdSlot), one of WORN_SLOTS, any other
  // name the content uses, or 'accessory' — of which ACC_SLOTS are worn at once, in p.equipment.accessory1…N.
  // p.equipment[place] = item id, as ever; wornAt / slotFor are the only two that know about the accessory places.
  var WORN_SLOTS = [{ id: 'helm', name: 'Head' }, { id: 'armor', name: 'Chest' }, { id: 'pants', name: 'Pants' }, { id: 'feet', name: 'Feet' },
    { id: 'gloves', name: 'Gloves' }, { id: 'back', name: 'Back' }, { id: 'belt', name: 'Belt' }, { id: 'face', name: 'Face', late: true }], ACC_SLOTS = 2;   // (owner, 26 Nov 2026: a belt place, two accessories; 27 Nov: a face place — masks, glasses)
  function accKeys() { var out = []; for (var i = 1; i <= ACC_SLOTS; i++) out.push('accessory' + i); return out; }
  /** Where p wears this item ('' = nowhere). */
  function wornAt(p, it) {
    var eq = (p && p.equipment) || {}; if (!it || !it.slot) return '';
    if (it.slot !== 'accessory') return eq[it.slot] === it.id ? it.slot : '';
    return accKeys().filter(function (k) { return eq[k] === it.id; })[0] || '';
  }
  /** Where it would go: its slot; an accessory = the place asked for, else the first free one, else the first. */
  function slotFor(p, it, want) {
    if (it.slot !== 'accessory') return it.slot;
    var ks = accKeys(), eq = p.equipment || {};
    return ks.indexOf(want) >= 0 ? want : (ks.filter(function (k) { return !eq[k]; })[0] || ks[0]);
  }
  // want (the action's `slot`) = which accessory place; a worn accessory dropped on another place moves there.
  // from (the action's `from`) = where it was used from: {w: 'bag', s: cell} or {w: 'belt', s: slot} (see leaveItem).
  function useItem(c, ws, p, id, now, ev, want, from) {
    var it = c.items[id];
    if (!it || count(p, id) < 1) { ev.push({ type: 'info', to: p.id, text: 'You don\'t have that.' }); return; }
    var mx = stats(c, p).maxHp;
    if (itemCan(it, 'consume')) {
      var ready = (p.cooldowns || {})['use:' + id] || 0;
      if (now < ready) { ev.push({ type: 'info', to: p.id, text: 'You can use the ' + lower(it.name) + ' again in ' + Math.ceil((ready - now) / 1000) + ' s.' }); return; }
      var mm = stats(c, p).maxMp, hun = Number(p.hunger) || 0, thi = Number(p.thirst) || 0;
      var fullHp = !it.heal || p.hp >= mx, fullMp = !it.mp || p.mp >= mm, fullHun = !it.hunger || hun >= 100, fullThi = !it.thirst || thi >= 100;
      var cures = it.toxicity < 0, fullTox = !cures || !(Number(p.tox) > 0);
      if (!it.onUse && fullHp && fullMp && fullHun && fullThi && fullTox) {
        if (cures && !it.heal && !it.mp && !it.hunger && !it.thirst) { ev.push({ type: 'info', to: p.id, text: 'You do not need it.' }); return; }
        ev.push({ type: 'info', to: p.id, text: it.hunger && !it.heal && !it.mp ? 'You are not hungry.' :
          it.thirst && !it.heal && !it.mp && !it.hunger ? 'You are not thirsty.' :
          it.mp && !it.heal ? 'Your mana is already full.' : 'You are already at full health.' }); return;
      }
      var gone = takeOne(p, id, from);                           // (the cell it was used from, when that stack is now empty)
      noteAct(p, 'u', p.x, p.y, 0);                              // (the others see it lifted to the mouth)
      questCount(c, p, 'use', id, now, ev);
      if (it.leaves && c.items[it.leaves]) leaveItem(c, p, it.leaves, gone, from, ev);   // the empty bottle stays: where the full one was
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
        var fe = Math.min(it.hunger, 100 - hun); if (fe > 0) { p.hunger = hun + fe; ev.push({ type: 'info', to: p.id, text: 'You eat the ' + lower(it.name) + '.' }); questCount(c, p, 'eat', it.id, now, ev); }
      }
      if (it.thirst) {
        var dr = Math.min(it.thirst, 100 - thi); if (dr > 0) { p.thirst = thi + dr; ev.push({ type: 'info', to: p.id, text: 'You drink the ' + lower(it.name) + '.' }); questCount(c, p, 'drink', it.id, now, ev); }
      }
      if (it.toxicity) { if (cures && !it.heal && !it.mp && !it.hunger && !it.thirst) ev.push({ type: 'info', to: p.id, text: 'You use the ' + lower(it.name) + '.' }); addTox(c, p, it.toxicity, ev); }
      if (it.onUse) run(c, ws, p, it.onUse, now, ev);
    } else if (it.slot && it.slot !== 'weapon' && wornCell(slotFor(p, it, want)) >= 0) {
      // Worn things have places of their own: on = out of the bag into its place (what was there goes back where it came
      // from), off = back into the bag. from {w: 'bag', s} = put THAT one on (one of the same may be worn already).
      var inv = p.inventory, s0 = from && from.w === 'bag' ? stackAt(inv, Math.floor(Number(from.s))) : null, mine = s0 && s0.item === id && s0.s < BELT_AT ? s0 : null;
      var wat = wornAt(p, it), moveTo = !mine && wat && it.slot === 'accessory' && accKeys().indexOf(want) >= 0 && want !== wat;
      if (moveTo) {                                            // a worn accessory to another accessory place (swapping with what is there)
        var other = p.equipment[want];
        putOn(p, stackAt(inv, wornCell(wat)), want);
        delete p.equipment[wat]; if (other) p.equipment[wat] = other; p.equipment[want] = id;
      } else if (wat && !mine) {                               // take it off
        var ws0 = stackAt(inv, wornCell(wat));
        if (ws0) { var fc = freeCell(inv); if (fc >= bagSlots(c)) { ev.push({ type: 'info', to: p.id, text: 'Your bag is full.' }); return; } ws0.s = fc; }
        delete p.equipment[wat]; ev.push({ type: 'info', to: p.id, text: 'You take off the ' + lower(it.name) + '.' });
      } else {
        if (it.equipIf && !check(c, p, it.equipIf)) {
          var req0 = /level:(\d+)/.exec(it.equipIf);
          ev.push({ type: 'info', to: p.id, text: 'You cannot equip the ' + lower(it.name) + ' yet.' + (req0 ? ' (Requires level ' + req0[1] + '.)' : '') });
          return;
        }
        var wk = slotFor(p, it, want), wst = mine || bagStackOf(p, id);
        if (!wst) { ev.push({ type: 'info', to: p.id, text: 'You don\'t have that.' }); return; }
        putOn(p, wst, wk); wornSync(p);
        ev.push({ type: 'info', to: p.id, text: 'You equip the ' + lower(it.name) + '.' });
      }
      p.hp = Math.min(p.hp, stats(c, p).maxHp);
    } else if (it.slot) {
      var at = wornAt(p, it), moving = at && it.slot === 'accessory' && accKeys().indexOf(want) >= 0 && want !== at;
      if (moving) { delete p.equipment[at]; p.equipment[want] = id; }
      else if (at) { delete p.equipment[at]; if (it.slot === 'weapon') p.held = -1; ev.push({ type: 'info', to: p.id, text: 'You put away the ' + lower(it.name) + '.' }); }
      else {
        if (it.equipIf && !check(c, p, it.equipIf)) {
          var req = /level:(\d+)/.exec(it.equipIf);
          ev.push({ type: 'info', to: p.id, text: 'You cannot equip the ' + lower(it.name) + ' yet.' + (req ? ' (Requires level ' + req[1] + '.)' : '') });
          return;
        }
        if (it.slot === 'weapon') p.held = beltSlotFor(p, id);            // a weapon is worn by holding its belt slot
        p.equipment[slotFor(p, it, want)] = id; ev.push({ type: 'info', to: p.id, text: 'You equip the ' + lower(it.name) + '.' });
        if (itemCan(it, 'shoot') && Number(it.clip) > 0 && (!p.mags || p.mags[id] == null)) loadMag(c, p, it);   // a gun drawn for the first time comes loaded (an emptied one is reloaded the slow way)
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
    if (p.sceneQ && p.sceneQ.length) {                    // watching a scene (see "scenes")
      if (action.type === 'scene') { sceneAct(c, ws, p, action, now, ev); questSweep(c, ws, p, now, ev); return ev; }
      if (watching(c, p, now)) return ev;                 // nothing else is done meanwhile (a step already on its way is dropped)
      while (p.sceneQ && p.sceneQ.length) sceneEnd(c, ws, p, now, ev);   // past scene_max_s: it is over, and what it held happens
    }
    syncEdges(c, ws, p.map);                              // refresh the opening overlay this action reads
    finishReload(c, p, now, ev);
    craftTick(c, ws, p, now, ev);
    if (action.type === 'move') {
      // Walking speed is the referee's to enforce, not the page's. Each player has a budget of steps that refills
      // with time (one per move_ms, with some slack for uneven connections) up to move_burst; a straight step
      // costs 1, a diagonal 1.4 (times Config shallow_slow into shallow water). Steps the budget cannot pay for are dropped, so a doctored page gains nothing.
      var dirs = (action.dirs || []).slice(0, 20), walked = 0;
      var perStep = Math.max(20, cfgNum(c, 'move_ms', 140)) * 0.85, burst = Math.max(2, cfgNum(c, 'move_burst', 6));
      p.mvB = Math.min(burst, (p.mvB == null ? burst : Number(p.mvB) || 0) + Math.max(0, now - (Number(p.mvT) || now)) / perStep);
      p.mvT = now;
      for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i]; if (!Rl().isDir(dir)) continue;
        var dd = Rl().DIRS[dir] || Rl().DIAG[dir], cost = Rl().stepCost(dir, c, liveMap(c, ws, p.map), p.x + dd.dx, p.y + dd.dy, p);   // (wading into shallow water, or sneaking, costs more)
        if (p.mvB < cost) break;
        p.facing = Rl().faceFor(dir, p.facing);
        var r = Rl().tryMove(c, liveMap(c, ws, p.map), p.x, p.y, dir, moveOpts(c, ws, p.map, players, p));
        if (r.ok && r.map && r.map !== p.map) {            // walked off the head (or into the well) of a staircase: now on another floor
          var leftMap = p.map, leftX = p.x, leftY = p.y;
          p.map = r.map; p.x = r.x; p.y = r.y; p.mvB -= cost; markExplored(c, p, liveMap(c, ws, p.map));
          tagFollowers(c, ws, leftMap, p, r.stairs, leftX, leftY, dir, now);
          break;                                           // the rest of this batch was aimed at the floor just left
        }
        if (r.ok) { p.x = r.x; p.y = r.y; p.mvB -= cost; walked++; if (onStep(c, ws, p, now, ev)) break; }
        // (walking into a creature does nothing: an attack is a deliberate click, never a bump)
      }
      if (walked) { p.stepAt = now; questCount(c, p, 'walk', '*', now, ev, walked); }   // (stepAt: the noise of walking, noiseOf)
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
      else if (wallHere) ev.push({ type: 'info', to: p.id, text: Rl().cliffReach(amap, p.x, p.y, ax, ay) ? 'You can\'t reach it: the ground is at another height.' : 'A wall is in the way.' });
      else { faceTo(p, ax, ay); attack(c, ws, p.map, p, am, now, rng, ev); }
    }
    else if (action.type === 'use') useItem(c, ws, p, action.item, now, ev, action.slot, action.from);
    else if (action.type === 'face' && Rl().DIRS[action.dir]) p.facing = action.dir;
    else if (action.type === 'cast') cast(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'shoot') shoot(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'throw') throwItem(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'reload') reload(c, ws, p, action, now, ev);
    else if (action.type === 'craft') craft(c, ws, p, action, now, ev);
    else if (action.type === 'place') placeItem(c, ws, p, action, now, ev, players);
    else if (action.type === 'build') { delete p.sneak; build(c, ws, p, action, now, ev, players); }   // (building is never done sneaking: docs/STEALTH.md)
    else if (action.type === 'relocate') { var mvT = cleanTarget(action.target); if (mvT) relocate(c, ws, p, Object.assign({}, action, { target: mvT }), now, ev, players); else ev.push({ type: 'info', to: p.id, text: 'Pick something.' }); }
    else if (action.type === 'work' || action.type === 'dismantle' || action.type === 'upgrade' || action.type === 'shift' || action.type === 'turn') {
      var stT = cleanTarget(action.target); delete p.sneak;
      if (!stT) ev.push({ type: 'info', to: p.id, text: 'Pick something.' });
      else if (action.type === 'work') work(c, ws, p, stT, now, ev);
      else if (stT.t === 'tile' || stT.t === 'roof') { if (action.type === 'dismantle') (stT.t === 'roof' ? liftRoof : liftTile)(c, ws, p, stT, now, ev, players); else ev.push({ type: 'info', to: p.id, text: 'Pick something.' }); }
      else if (action.type === 'dismantle') dismantle(c, ws, p, stT, now, ev, players);
      else if (action.type === 'shift') shiftWall(c, ws, p, stT, action.off, now, ev);
      else if (action.type === 'turn') turnObj(c, ws, p, stT, action.facing, now, ev);
      else upgrade(c, ws, p, stT, action.bp, now, ev);
    }
    else if (action.type === 'store') storeAct(c, ws, p, action, now, ev);
    else if (action.type === 'inv') invAct(c, ws, p, action, now, ev);
    else if (action.type === 'claim') claimAct(c, ws, p, action, now, ev, players);
    else if (action.type === 'loadout') setLoadout(c, p, action.bar, action.slot, action.entry, ev, action.s);
    else if (action.type === 'hold') { holdSlot(c, p, action.slot, ev); if (heldItem(c, p)) questCount(c, p, 'hold', heldItem(c, p).id, now, ev); }
    else if (action.type === 'quest') questAct(c, ws, p, action, now, ev);
    else if (action.type === 'talk') talkAct(c, ws, p, action, now, ev);
    else if (action.type === 'shop') shopAct(c, ws, p, action, now, ev);
    else if (action.type === 'sneak') {                        // (docs/STEALTH.md) never while something is after you
      if (!action.on || !stealthOn(c)) delete p.sneak;
      else if (chasedBy(mapState(ws, p.map), p)) { p.chased = true; delete p.sneak; ev.push({ type: 'info', to: p.id, text: 'You can\'t hide while something is after you.' }); }
      else p.sneak = true;
    }
    else if (action.type === 'emote') {                        // an emote over your head for everyone around (Content.EMOTES); none = take it down
      var emId = String(action.id || '');
      if (emId === 'none' || !emId) { delete p.em; delete p.emAt; }
      else if (emoteKnown(emId)) { p.em = emId; p.emAt = now; }
    }
    questSweep(c, ws, p, now, ev);                             // wherever that left them: a place a quest sends them to? a quest that is simply done?
    return ev;
  }

  /**
   * Everything a player could do with a cell, default first: [{verb, label, type}].
   * type 'attack' | 'interact' | 'walk'. Built from what the client sees (lk = viewLookup).
   */
  function actionsAt(c, map, lk, p, x, y) {
    var out = [], m = lk.monsterAt(x, y);
    if (m) {
      var amd = c.monsters[m.ref];                          // an animal that can be kept: a click feeds it (or tells you about yours)
      if (amd && amd.tameWith && near(p, x, y)) out.push({ type: 'interact', verb: '', label: 'Feed the ' + lower(amd.name) });
      return out;                                           // nothing else a plain click does to a creature: attacks are aimed (right-click held), then clicked
    }
    var ents = Rl().entitiesAt(map, x, y).filter(function (e) { var o = objOf(c, e); return o && !comeBackOnly(c, e, o) && (INTERACTIVE[o.kind] || isPick(c, e, o)); });
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
      else if (isPick(c, e, o)) { if (st !== 'empty') out.push({ type: 'interact', verb: '', pick: true, label: 'Pick the ' + name }); }   // (empty: nothing to do with it)
      else if (o.kind === 'door') out.push({ type: 'interact', verb: '', label: pr.target ? 'Go through the ' + name : (st === 'open' ? 'Close the ' : 'Open the ') + name });
      else {
        var verbs = { teleport: 'Enter', 'switch': 'Pull', rest: 'Rest at', sign: 'Read', craft: 'Use', npc: 'Talk to', trap: 'Look at', claim: 'Look at', pickup: 'Pick up', coop: 'Look at' };
        var lies = o.kind === 'pickup' ? list(pr.pickup)[0] : null;                 // an item on the ground is called by its own name
        out.push({ type: 'interact', verb: '', label: (verbs[o.kind] || 'Use') + ' the ' + (lies ? lower(itemName(c, lies.item)) : name) });
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
          if (bi.t === 'ent' && bi.built && !bi.rec.item && !isWallFixture(bi.obj) && Rl().turnable(bi.obj)) out.push({ type: 'turn', verb: '', target: bt2, label: 'Turn the ' + bi.name });
          out.push({ type: 'dismantle', verb: '', target: bt2, pickup: !!(bi.rec && bi.rec.item) || undefined, label: bi.rec && bi.rec.item ? 'Pick up the ' + bi.name : 'Take the ' + bi.name + ' apart' });
        }
      }
    }
    // Water beside you: drink from it, fill what holds it (what is in hand goes first).
    var wsrc = !e && near(p, x, y) ? waterAt(c, map, x, y) : null;
    if (wsrc && !moveBlockedEdge(c, map, p.x, p.y, x, y)) {
      var wl = [{ type: 'interact', verb: 'drink', label: 'Drink from the ' + lower(wsrc.name) }], hand = p.held >= 0 ? beltOf(p)[p.held] : '';
      fillables(c, p).forEach(function (g) {
        var a = { type: 'interact', verb: 'fill:' + g.id, label: 'Fill the ' + lower(itemName(c, g.id)) + (g.qty > 1 ? ' (' + g.qty + ')' : '') };
        if (g.id === hand) wl.unshift(a); else wl.push(a);
      });
      out = wl.concat(out);
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
          statuses: (m.statuses || []).map(function (st) { return st.id; }), alert: alertOf(m) || undefined,
          look: m.look || undefined };     // random paper-doll layers [{path, tint}], when the monster has an Appearance set
      }),
      players: (players || []).filter(function (q) { return q.id !== p.id && q.map === mapId; }).map(function (q) {
        // class + equipment + hair let other clients draw this player's paper-doll (base body, hair, worn gear)
        return { id: q.id, name: q.name, 'class': q['class'], equipment: q.equipment || {},
          hair: q.hair || '', hairColor: q.hairColor || '', beard: q.beard || '', beardColor: q.beardColor || '', body: q.body || '', skin: q.skin || '', x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: stats(c, q).maxHp, level: q.level, act: q.act || '', wst: weaponState(c, q), hand: handOf(c, q), sn: q.sneak ? 1 : 0, wt: watching(c, q, now) ? 1 : undefined, em: emoteOf(q, now) };   // sn: sneaking; wt: watching a scene (a mark over their head); em: an emote
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
      hair: p.hair || '', hairColor: p.hairColor || '', beard: p.beard || '', beardColor: p.beardColor || '', body: p.body || '', skin: p.skin || '',
      hp: p.hp, maxHp: s.maxHp, mp: Math.floor(Number(p.mp) || 0), maxMp: s.maxMp, atk: s.atk, def: s.def, level: p.level, xp: p.xp,
      hunger: Math.round(Number(p.hunger) == null || isNaN(Number(p.hunger)) ? 100 : Number(p.hunger)),
      thirst: Math.round(Number(p.thirst) == null || isNaN(Number(p.thirst)) ? 100 : Number(p.thirst)),
      tox: Math.ceil((Number(p.tox) || 0) - 1e-6), toxSick: toxSickAt(c),
      buildLocked: buildUnlocked(c, p) ? undefined : buildLockedText(c),      // set = building is not unlocked yet (Config build_if); the text to tell them

      skills: usableSkills(c, p), abilities: p.abilities, belt: beltOf(p), held: p.held, mags: p.mags || {}, reload: p.reload || undefined,
      craft: p.craft && (c.recipes || {})[p.craft.id] ? { id: p.craft.id, qty: p.craft.qty, made: p.craft.made, ms: p.craft.ms, at: p.craft.at, on: !!p.craft.on, need: Math.max(1, c.recipes[p.craft.id].timeS * 1000) } : undefined,
      cooldowns: p.cooldowns || {},
      statuses: (p.statuses || []).map(function (st) { return { id: st.id, until: st.until }; }),
      xpNext: xpFor(c, p.level + 1), xpThis: xpFor(c, p.level) || 0, gold: p.gold,
      // rooms this player has entered (per map) — the client needs it so `roof_reveal: permanent` keeps
      // explored rooms revealed across reloads, not just within one session's live accumulation.
      explored: p.explored || {}, claims: p.claims || [],
      quests: questLog(c, p, Date.now()), questsOpen: questsOpen(c, p, Date.now()), questIntro: p.intro && p.intro.length ? p.intro : undefined,   // questIntro = starting quests the page has yet to welcome the player with
        // the quest log as the page shows it, and what could be accepted now
      // stealth: sneaking or not, and how loud they are (0-1 of noiseMax; the page works its own meter out as it walks)
      sneak: p.sneak ? true : undefined, chased: p.chased ? true : undefined,
      noise: stealthOn(c) ? noiseOf(c, p, Date.now()) / noiseMax(c) : undefined,
      sceneCast: p.sceneQ && p.sceneQ.length ? p.sceneQ[0].cast : undefined,   // the looks of the monsters that scene leaves behind ({ref: look})
      scene: p.sceneQ && p.sceneQ.length ? p.sceneQ[0].id : undefined,      // the scene to play now (client/js/scene.js); it ends with {type: 'scene', op: 'end'}
      em: emoteOf(p, Date.now()),                                         // an emote over their head ("heart@<when>"; Content.EMOTES)
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
    stealthOn: stealthOn, throwNoise: throwNoise, soundAt: soundAt, notices: notices, sightArea: sightArea, lookRange: lookRange, noiseOf: noiseOf, noiseRadius: noiseRadius, noiseMax: noiseMax, NOISE_LINGER_MS: NOISE_LINGER_MS,
    roofZoneAt: roofZoneAt, roofZones: roofZones, covered: covered, asRoof: asRoof, roofSteps: roofSteps, roofSpan: roofSpan, roofSupport: roofSupport,
    liveMap: liveMap, liveMapFromStruct: liveMapFromStruct, structOf: structOf, publicStruct: publicStruct,
    structInfo: structInfo, strikeTarget: strikeTarget, damageStructure: damageStructure,
    WORN_SLOTS: WORN_SLOTS, ACC_SLOTS: ACC_SLOTS, wornAt: wornAt,
    recipesFor: recipesFor, hasTool: hasTool, craftingHere: craftingHere, CRAFT_MAX: CRAFT_MAX, heldItem: heldItem, weaponState: weaponState, handOf: handOf, cookRecipe: cookRecipe, COOK_S: COOK_S, hitMonster: hitMonster, bagSlots: bagSlots, stackMaxOf: stackMaxOf, durOf: durOf, stackInUse: stackInUse, isBroken: isBroken, repairInfo: repairInfo, salvageInfo: salvageInfo, recipeMaking: recipeMaking, take: take, harvestWith: harvestWith, pickAt: pickAt, placeBp: placeBp, canPlace: canPlace, stationName: stationName,
    canBuild: canBuild, buildUnlocked: buildUnlocked, blueprintsFor: blueprintsFor, noBuild: noBuild, buildSpot: buildSpot,
    claimsOn: claimsOn, claimAt: claimAt, mayUse: mayUse, isMember: isMember, mayDismantle: mayDismantle, canRemove: canRemove, canMove: canMove, leaveBag: leaveBag, bagObject: bagObject, waterAt: waterAt, fillables: fillables, itemCan: itemCan, beltItems: beltItems, beltOf: beltOf, beltStack: beltStack, BELT_AT: BELT_AT, WORN_AT: WORN_AT, wornCell: wornCell, BELT_SIZE: BELT_SIZE, skillsOn: skillsOn, holdSlot: holdSlot,
    groundId: groundId, floorId: floorId, floorsOf: floorsOf, deliver: deliver,
    sightRadius: sightRadius, seesAcross: seesAcross, peek: peek, advanceFloors: advanceFloors, findPath: findPath, reloadMsOf: reloadMsOf, alertOf: alertOf, hairChoices: hairChoices, blocksSight: blocksSight, bodySprite: bodySprite, fixtureStates: fixtureStates,
    applyNotice: applyNotice, shotAcross: shotAcross, throwAcross: throwAcross, tileMine: tileMine,
    questState: questState, questLog: questLog, questsOpen: questsOpen, goalText: goalText, watching: watching, emoteOf: emoteOf, packSpots: packSpots };
})();
if (typeof module !== 'undefined') module.exports = World;
