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
    return String(s || '').split(',').map(function (p) {
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
  function yes(v) { return v === true || v === 1 || /^(true|1|yes)$/i.test(String(v)); }
  function rint(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }
  function damage(atk, def, rng) { return Math.max(1, atk - def + rint(rng, -1, 2)); }
  function lower(s) { return String(s || '').toLowerCase(); }

  function mapState(ws, id) {
    ws.maps = ws.maps || {};
    var m = ws.maps[id] || (ws.maps[id] = {});
    m.states = m.states || {}; m.timers = m.timers || {};
    if (m.monsters === undefined) m.monsters = null;
    return m;
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

  function newPlayer(c, id, name, cls) {
    var p = { id: id, name: name, 'class': c.classes[cls] ? cls : (c.config.start_class || Object.keys(c.classes)[0] || ''),
      map: '', x: 0, y: 0, facing: 'S', level: 1, xp: 0, gold: 0, inventory: [], equipment: {}, flags: {}, respawn: '',
      // cosmetic paper-doll choices (character creation will let players pick these)
      hair: c.config.start_hair || '', hairColor: c.config.start_hair_color || 'hair_brown' };
    var map = c.maps[c.config.start_map] || c.maps[Object.keys(c.maps)[0]];
    var at = Rl().nearestStandable(c, map, Number(c.config.start_x) || 0, Number(c.config.start_y) || 0);
    p.map = map.id; p.x = at.x; p.y = at.y;
    p.hp = stats(c, p).maxHp; p.mp = stats(c, p).maxMp;
    p.cooldowns = {}; p.statuses = []; p.loadout = ['', '', '', '', ''];
    list(classOf(c, p).startItems).forEach(function (s) { give(c, p, s.item, s.qty, [], true); });
    fillLoadout(c, p);
    return p;
  }
  /** Fills in anything missing (e.g. a character saved before milestone 3). */
  function normalize(c, p) {
    function obj(v, d) { if (v && typeof v === 'object') return v; try { return v ? JSON.parse(v) : d; } catch (e) { return d; } }
    p.inventory = obj(p.inventory, []); if (!Array.isArray(p.inventory)) p.inventory = [];
    p.equipment = obj(p.equipment, {}); p.flags = obj(p.flags, {});
    p.cooldowns = obj(p.cooldowns, {}); p.statuses = obj(p.statuses, []); if (!Array.isArray(p.statuses)) p.statuses = [];
    p.loadout = obj(p.loadout, null);
    if (!Array.isArray(p.loadout)) { p.loadout = ['', '', '', '', '']; p._fill = true; }
    while (p.loadout.length < 5) p.loadout.push('');
    p.level = Number(p.level) || 1; p.xp = Number(p.xp) || 0; p.gold = Number(p.gold) || 0;
    p.x = Number(p.x) || 0; p.y = Number(p.y) || 0; p.facing = p.facing || 'S'; p.respawn = p.respawn || '';
    if (!p['class'] || !c.classes[p['class']]) p['class'] = c.config.start_class || Object.keys(c.classes)[0] || '';
    if (p.hair == null) p.hair = c.config.start_hair || '';
    if (!p.hairColor) p.hairColor = c.config.start_hair_color || 'hair_brown';
    var mx = stats(c, p).maxHp, hp = Number(p.hp);
    p.hp = !hp || hp <= 0 || isNaN(hp) ? mx : Math.min(hp, mx);
    var mm = stats(c, p).maxMp, mp = Number(p.mp);
    p.mp = p.mp === '' || p.mp == null || isNaN(mp) ? mm : Math.max(0, Math.min(mp, mm));
    if (p._fill) { delete p._fill; fillLoadout(c, p); }
    if (!c.maps[p.map]) { var np = newPlayer(c, p.id, p.name, p['class']); p.map = np.map; p.x = np.x; p.y = np.y; }
    return p;
  }

  /** Skills this character knows at their level. */
  function knownSkills(c, p) {
    return (classOf(c, p).skills || []).filter(function (s) { return p.level >= s.level && c.skills && c.skills[s.skill]; })
      .map(function (s) { return s.skill; });
  }
  /** Puts known skills (and a potion) into empty bar slots. */
  function fillLoadout(c, p) {
    var have = p.loadout.join(',');
    knownSkills(c, p).forEach(function (id) {
      if (have.indexOf('skill:' + id) >= 0) return;
      var i = p.loadout.indexOf(''); if (i >= 0) { p.loadout[i] = 'skill:' + id; have += ',skill:' + id; }
    });
    ['potion', 'mana_potion'].forEach(function (it) {
      if (count(p, it) > 0 && have.indexOf('item:' + it) < 0) {
        var j = p.loadout.lastIndexOf('');
        if (j >= 0) { p.loadout[j] = 'item:' + it; have += ',item:' + it; }
      }
    });
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

  // ------------------------------------------------------------ space
  function walkableEntity(c, ws, mapId, e) {
    var o = objOf(c, e); if (!o) return true;
    if (o.kind === 'spawn' || o.kind === 'trigger') return true;        // invisible markers
    if (o.kind === 'door') return stateOf(c, ws, mapId, e) === 'open';
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
    var map = c.maps[mapId];
    if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    var t = Rl().terrainAt(c, map, x, y);
    if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return false;
    if (Rl().entitiesAt(map, x, y).some(function (e) { return !walkableEntity(c, ws, mapId, e); })) return false;
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
  /**
   * Makes the map's monsters match its spawn points. Runs whenever the spawn points change
   * (edited in the editor or in Game Data): unchanged monsters stay where they are.
   */
  function ensureMonsters(c, ws, mapId, now) {
    var ms = mapState(ws, mapId), map = c.maps[mapId];
    if (!map) { ms.monsters = ms.monsters || []; return ms; }
    var want = [];
    map.entities.forEach(function (e) {
      var o = objOf(c, e); if (!o || o.kind !== 'spawn') return;
      var pr = props(c, e), def = c.monsters[pr.monster]; if (!def) return;
      for (var i = 0; i < (Number(pr.count) || 1); i++) want.push({ id: e.key + '#' + i, ref: def.id, e: e, radius: Number(pr.radius) || 0, i: i });
    });
    var sig = want.map(function (w) { return w.id + '=' + w.ref + '@' + w.e.x + ',' + w.e.y; }).join(';');
    if (ms.monsters && ms.spawnSig === sig) return ms;
    var old = {};
    (ms.monsters || []).forEach(function (m) { old[m.id] = m; });
    ms.monsters = want.map(function (w) {
      var m = old[w.id];
      if (m && m.ref === w.ref) return m;
      m = { id: w.id, ref: w.ref, spawn: w.e.key, x: w.e.x, y: w.e.y, hp: c.monsters[w.ref].hp, dead: false, last: now, respawnAt: 0, facing: 'S' };
      place(c, ws, mapId, m, w.e, w.radius, w.i);
      return m;
    });
    ms.spawnSig = sig;
    ws.dirty = true;
    return ms;
  }

  /** Moves the world on to `now`: timers, respawns, monsters wandering, chasing and attacking. */
  function advance(c, ws, mapId, players, now, rng, ev) {
    var map = c.maps[mapId]; if (!map) return;
    var ms = ensureMonsters(c, ws, mapId, now);
    Object.keys(ms.timers).forEach(function (k) {
      var t = ms.timers[k]; if (now >= t.at) { setState(ws, mapId, k, t.state); delete ms.timers[k]; }
    });
    var here = players.filter(function (p) { return p.map === mapId && p.hp > 0; });
    here.forEach(function (p) {
      var st = stats(c, p);
      if (p.lastRegen && st.mpRegen) p.mp = Math.min(st.maxMp, (Number(p.mp) || 0) + st.mpRegen * Math.max(0, now - p.lastRegen) / 1000);
      p.lastRegen = now;
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
          m.dead = false; m.hp = def.hp; m.last = now; ws.dirty = true;
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
        here.forEach(function (p) {
          if (p.hp <= 0 || p.map !== mapId) return;
          var d = Math.abs(p.x - m.x) + Math.abs(p.y - m.y);
          if (d <= def.aggro && d < best) { best = d; target = p; }
        });
        if (target) {
          if (best === 1) {
            var dmg = damage(ms2.atk, stats(c, target).def, rng);
            target.hp -= dmg;
            m.facing = target.x > m.x ? 'E' : target.x < m.x ? 'W' : target.y > m.y ? 'S' : 'N';
            ev.push({ type: 'hit', map: mapId, x: target.x, y: target.y, amount: dmg, to: target.id, text: 'The ' + lower(def.name) + ' hits you for ' + dmg + '.' });
            if (target.hp <= 0) die(c, ws, target, ev);
            break;
          }
          var dx = target.x - m.x, dy = target.y - m.y, dirs = [];
          if (Math.abs(dx) >= Math.abs(dy)) { dirs.push(dx > 0 ? 'E' : 'W'); if (dy) dirs.push(dy > 0 ? 'S' : 'N'); }
          else { dirs.push(dy > 0 ? 'S' : 'N'); if (dx) dirs.push(dx > 0 ? 'E' : 'W'); }
          for (var i = 0; i < dirs.length; i++) {
            var r = Rl().tryMove(c, map, m.x, m.y, dirs[i], moveOpts(c, ws, mapId, here, m));
            if (r.ok) { m.x = r.x; m.y = r.y; m.facing = dirs[i]; break; }
          }
        } else if (rng() < 0.5) {
          var dir = 'NESW'.charAt(rint(rng, 0, 3));
          var r2 = Rl().tryMove(c, map, m.x, m.y, dir, moveOpts(c, ws, mapId, here, m));
          var sp = entity(c, mapId, m.spawn), rad = sp ? (Number(props(c, sp).radius) || 0) + 2 : 3;
          if (r2.ok && (!sp || (Math.abs(r2.x - sp.x) <= rad && Math.abs(r2.y - sp.y) <= rad))) { m.x = r2.x; m.y = r2.y; m.facing = dir; }
        }
      }
    });
  }

  function respawnPoint(c, p) {
    var pos = String(p.respawn || '').split(':');
    if (pos.length === 3 && c.maps[pos[0]]) return { map: pos[0], x: Number(pos[1]), y: Number(pos[2]) };
    return { map: c.config.start_map, x: Number(c.config.start_x) || 0, y: Number(c.config.start_y) || 0 };
  }
  function die(c, ws, p, ev) {
    var lost = Math.floor(p.gold * (Number(c.config.death_gold_loss) || 0));
    p.gold -= lost;
    ev.push({ type: 'death', map: p.map, x: p.x, y: p.y, to: p.id, text: 'You were defeated' + (lost ? ' and lost ' + lost + ' gold' : '') + '.' });
    var r = respawnPoint(c, p), map = c.maps[r.map] || c.maps[Object.keys(c.maps)[0]];
    var at = Rl().nearestStandable(c, map, r.x, r.y);
    p.map = map.id; p.x = at.x; p.y = at.y; p.facing = 'S'; p.hp = stats(c, p).maxHp;
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
        ev.push({ type: 'level', to: p.id, text: 'You learned ' + c.skills[id].name + '.' });
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
    ev.push({ type: 'hit', map: mapId, x: m.x, y: m.y, amount: dmg, to: p ? p.id : undefined, text: p ? text : '' });
    if (m.hp > 0) return;
    m.dead = true; m.statuses = []; m.respawnAt = now + def.respawnS * 1000;
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
  /** Damage/healing over time, then expiry. Monsters killed by a status reward whoever applied it. */
  function tickStatuses(c, ws, mapId, t, isMonster, now, rng, ev, players) {
    var keep = [];
    (t.statuses || []).forEach(function (st) {
      var d = c.statuses && c.statuses[st.id]; if (!d) return;
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
    return Rl().entitiesAt(map, x, y).some(function (e) {
      var o = objOf(c, e); if (!o) return false;
      if (o.kind === 'door') return stateFn(e) !== 'open';
      return o.blocksSight;
    });
  }
  function canSee(c, map, x0, y0, x1, y1, stateFn) {
    var cells = lineCells(x0, y0, x1, y1);
    for (var i = 1; i < cells.length - 1; i++) if (blocksSight(c, map, cells[i].x, cells[i].y, stateFn)) return false;
    return true;
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
        if (Rl().entitiesAt(map, x, y).some(function (e) {
          var o = objOf(c, e); if (!o || o.kind === 'spawn' || o.kind === 'trigger') return false;
          return o.kind === 'door' ? st(e) !== 'open' : !o.walkable;
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

  function cast(c, ws, p, a, now, rng, ev, players) {
    function say(t) { ev.push({ type: 'info', to: p.id, text: t }); }
    var sk = c.skills && c.skills[a.skill];
    if (!sk || knownSkills(c, p).indexOf(sk.id) < 0) return say('You don\'t know that skill.');
    if (hasStatus(p, 'stun')) return say('You are stunned.');
    if (now < ((p.cooldowns || {})[sk.id] || 0)) return say(sk.name + ' is not ready yet.');
    if ((Number(p.mp) || 0) < sk.mp) return say('Not enough mana for ' + sk.name + '.');
    var mapId = p.map, map = c.maps[mapId], lk = serverLookup(c, ws, mapId, players);
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
    function monstersNear(x, y, r) { return mons.filter(function (m) { return !m.dead && cheb(m.x, m.y, x, y) <= r; }); }
    if (sk.target === 'enemy') targets = sk.area > 0 ? monstersNear(tx, ty, sk.area) : [lk.monsterAt(tx, ty)];
    else if (sk.target === 'around') targets = monstersNear(p.x, p.y, Math.max(1, sk.area));
    else if (sk.target === 'tile') targets = sk.area > 0 ? monstersNear(tx, ty, sk.area) : [];
    else if (sk.target === 'ally') targets = [tx === p.x && ty === p.y ? p : lk.playerAt(tx, ty)];
    else if (sk.target === 'self') targets = [p];
    targets = targets.filter(Boolean);

    p.mp = (Number(p.mp) || 0) - sk.mp;
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

  function setLoadout(c, p, slot, entry, ev) {
    slot = Number(slot);
    if (!(slot >= 0 && slot < 5)) return;
    entry = String(entry || '');
    var kind = entry.split(':')[0], id = entry.slice(kind.length + 1);
    if (entry && !(kind === 'skill' && knownSkills(c, p).indexOf(id) >= 0) && !(kind === 'item' && c.items[id])) {
      ev.push({ type: 'info', to: p.id, text: 'That can\'t go on the bar.' }); return;
    }
    var was = p.loadout.indexOf(entry);
    if (entry && was >= 0) p.loadout[was] = p.loadout[slot];   // swap if it was already on the bar
    p.loadout[slot] = entry;
  }

  // ------------------------------------------------------------ data-driven actions
  /** "flag:met_mayor, has:iron_key, !flag:done, level:3" -> all must hold */
  function check(c, p, cond) {
    return String(cond || '').split(',').every(function (part) {
      part = part.trim(); if (!part) return true;
      var not = part.charAt(0) === '!'; if (not) part = part.slice(1);
      var a = part.split(':'), ok;
      if (a[0] === 'flag') ok = !!p.flags[a[1]];
      else if (a[0] === 'has') ok = count(p, a[1]) >= (Number(a[2]) || 1);
      else if (a[0] === 'level') ok = p.level >= Number(a[1]);
      else ok = true;
      return not ? !ok : ok;
    });
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
  function onStep(c, ws, p, now, ev) {
    var map = c.maps[p.map], moved = false;
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
    var got = pr.contents ? list(pr.contents) : roll(c, pr.loot_table, rng);
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
      var opts = moveOpts(c, ws, p.map, players, null);
      if (opts.occupied(e.x, e.y)) { ev.push({ type: 'info', to: p.id, text: 'Something is in the way.' }); return; }
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

  var INTERACTIVE = { container: 1, door: 1, teleport: 1, 'switch': 1, rest: 1, sign: 1, craft: 1, npc: 1, trap: 1 };

  function near(p, x, y) { return Math.abs(p.x - x) + Math.abs(p.y - y) <= 1; }
  function faceTo(p, x, y) {
    if (x === p.x && y === p.y) return;
    p.facing = Math.abs(x - p.x) >= Math.abs(y - p.y) ? (x > p.x ? 'E' : 'W') : (y > p.y ? 'S' : 'N');
  }
  /**
   * Use something: target = {x, y} (a clicked cell next to you, or your own cell); without a target,
   * whatever you face. verb '' = the default action; 'picklock' = try to pick its lock.
   */
  function interact(c, ws, p, now, rng, ev, players, target, verb) {
    var map = c.maps[p.map], f = target || facingCell(p);
    if (target && !near(p, f.x, f.y)) { ev.push({ type: 'info', to: p.id, text: 'Too far away.' }); return; }
    if (target) faceTo(p, f.x, f.y);
    var ms = mapState(ws, p.map), m = monsterAt(ms, f.x, f.y);
    if (m && verb !== 'picklock') { attack(c, ws, p.map, p, m, now, rng, ev); return; }
    var cells = target ? Rl().entitiesAt(map, f.x, f.y) : Rl().entitiesAt(map, f.x, f.y).concat(Rl().entitiesAt(map, p.x, p.y));
    var ents = cells.filter(function (e) {
      var o = objOf(c, e); return o && INTERACTIVE[o.kind];
    });
    var e = ents[0];
    if (!e) { ev.push({ type: 'info', to: p.id, text: 'Nothing to use here.' }); return; }
    var o = objOf(c, e), pr = props(c, e);
    if (verb === 'picklock') {
      if (o.kind !== 'door' && o.kind !== 'container') { ev.push({ type: 'info', to: p.id, text: 'There is no lock.' }); return; }
      pickLock(c, ws, p, e, o, pr, rng, ev); return;
    }
    if (o.onInteract && (!pr['if'] || check(c, p, pr['if']))) run(c, ws, p, o.onInteract, now, ev);
    switch (o.kind) {
      case 'container': openContainer(c, ws, p, e, o, pr, now, rng, ev); break;
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
      case 'craft': ev.push({ type: 'info', to: p.id, text: 'The ' + lower(o.name) + ' crackles. (Crafting comes later.)' }); break;
      case 'npc': ev.push({ type: 'info', to: p.id, text: o.name + ' has nothing to say yet.' }); break;
      case 'trap': ev.push({ type: 'info', to: p.id, text: 'A trap. Better not step on it.' }); break;
    }
  }

  function useItem(c, ws, p, id, now, ev) {
    var it = c.items[id];
    if (!it || count(p, id) < 1) { ev.push({ type: 'info', to: p.id, text: 'You don\'t have that.' }); return; }
    var mx = stats(c, p).maxHp;
    if (it.type === 'consumable') {
      var mm = stats(c, p).maxMp;
      if (!it.onUse && (!it.heal || p.hp >= mx) && (!it.mp || p.mp >= mm)) {
        ev.push({ type: 'info', to: p.id, text: it.mp && !it.heal ? 'Your mana is already full.' : 'You are already at full health.' }); return;
      }
      take(p, id, 1);
      if (it.heal) {
        var h = Math.min(it.heal, mx - p.hp); p.hp += h;
        ev.push({ type: 'heal', to: p.id, map: p.map, x: p.x, y: p.y, amount: h, text: 'You use the ' + lower(it.name) + '. +' + h + ' HP' });
      }
      if (it.mp) {
        var g = Math.min(it.mp, mm - p.mp); p.mp += g;
        ev.push({ type: 'mana', to: p.id, map: p.map, x: p.x, y: p.y, amount: Math.round(g), text: 'You use the ' + lower(it.name) + '. +' + Math.round(g) + ' MP' });
      }
      if (it.onUse) run(c, ws, p, it.onUse, now, ev);
    } else if (it.slot) {
      if (p.equipment[it.slot] === id) { delete p.equipment[it.slot]; ev.push({ type: 'info', to: p.id, text: 'You put away the ' + lower(it.name) + '.' }); }
      else { p.equipment[it.slot] = id; ev.push({ type: 'info', to: p.id, text: 'You equip the ' + lower(it.name) + '.' }); }
      p.hp = Math.min(p.hp, stats(c, p).maxHp);
    } else ev.push({ type: 'info', to: p.id, text: 'You can\'t use that.' });
  }

  /** Runs one player action. players = everyone on the map (including p). Returns events. */
  function act(c, ws, p, action, now, rng, players) {
    var ev = [];
    if (!action || !c.maps[p.map]) return ev;
    players = players || [p];
    if (action.type === 'move') {
      var dirs = (action.dirs || []).slice(0, 20);
      for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i]; if (!Rl().DIRS[dir]) continue;
        p.facing = dir;
        var r = Rl().tryMove(c, c.maps[p.map], p.x, p.y, dir, moveOpts(c, ws, p.map, players, p));
        if (r.ok) { p.x = r.x; p.y = r.y; if (onStep(c, ws, p, now, ev)) break; }
        else if (r.reason === 'occupied' && r.who.monster) attack(c, ws, p.map, p, r.who.monster, now, rng, ev);
      }
    } else if (action.type === 'interact') {
      var tgt = action.x != null && action.y != null ? { x: Math.round(Number(action.x)), y: Math.round(Number(action.y)) } : null;
      interact(c, ws, p, now, rng, ev, players, tgt, action.verb || '');
    } else if (action.type === 'attack') {
      var ax = Math.round(Number(action.x)), ay = Math.round(Number(action.y)), am = monsterAt(mapState(ws, p.map), ax, ay);
      if (!am) ev.push({ type: 'info', to: p.id, text: 'Nothing to attack there.' });
      else if (!near(p, ax, ay)) ev.push({ type: 'info', to: p.id, text: 'Too far away.' });
      else { faceTo(p, ax, ay); attack(c, ws, p.map, p, am, now, rng, ev); }
    }
    else if (action.type === 'use') useItem(c, ws, p, action.item, now, ev);
    else if (action.type === 'face' && Rl().DIRS[action.dir]) p.facing = action.dir;
    else if (action.type === 'cast') cast(c, ws, p, action, now, rng, ev, players);
    else if (action.type === 'loadout') setLoadout(c, p, action.slot, action.entry, ev);
    return ev;
  }

  /**
   * Everything a player could do with a cell, default first: [{verb, label, type}].
   * type 'attack' | 'interact' | 'walk'. Built from what the client sees (lk = viewLookup).
   */
  function actionsAt(c, map, lk, p, x, y) {
    var out = [], m = lk.monsterAt(x, y);
    if (m) {
      var md = c.monsters[m.ref] || { name: m.ref };
      out.push({ type: 'attack', verb: '', label: 'Attack the ' + lower(md.name) });
      return out;
    }
    var ents = Rl().entitiesAt(map, x, y).filter(function (e) { var o = objOf(c, e); return o && INTERACTIVE[o.kind]; });
    var e = ents[0];
    if (e) {
      var o = objOf(c, e), pr = props(c, e), st = lk.stateOf(e), name = lower(o.name), has = function (id) { return count(p, id) > 0; };
      var locked = st === 'locked' && (o.kind === 'door' || o.kind === 'container');
      if (locked) {
        if (pr.locked_by && has(pr.locked_by)) out.push({ type: 'interact', verb: '', label: 'Unlock the ' + name + ' (' + itemName(c, pr.locked_by) + ')' });
        else out.push({ type: 'interact', verb: '', label: 'Locked' + (pr.locked_by ? ': needs ' + itemName(c, pr.locked_by) : '') });
        if (has('lockpick')) out.push({ type: 'interact', verb: 'picklock', label: 'Pick the lock (' + Math.round(100 * lockpickChance(c, p, pr)) + '%)' });
      } else if (o.kind === 'container') out.push({ type: 'interact', verb: '', label: (st === 'empty' || st === 'open' ? 'Search the ' : 'Open the ') + name });
      else if (o.kind === 'door') out.push({ type: 'interact', verb: '', label: pr.target ? 'Go through the ' + name : (st === 'open' ? 'Close the ' : 'Open the ') + name });
      else {
        var verbs = { teleport: 'Enter', 'switch': 'Pull', rest: 'Rest at', sign: 'Read', craft: 'Use', npc: 'Talk to', trap: 'Look at' };
        out.push({ type: 'interact', verb: '', label: (verbs[o.kind] || 'Use') + ' the ' + name });
      }
    }
    if (lk.free(x, y, p) && !(x === p.x && y === p.y)) out.push({ type: 'walk', verb: '', label: 'Walk here' });
    return out;
  }

  // ------------------------------------------------------------ what a player sees
  function view(c, ws, mapId, p, players) {
    var ms = mapState(ws, mapId), states = {}, map = c.maps[mapId], now = Date.now();
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
    return {
      map: mapId, states: states, now: now,
      monsters: (ms.monsters || []).filter(function (m) { return !m.dead; }).map(function (m) {
        var d = c.monsters[m.ref];
        return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing,
          statuses: (m.statuses || []).map(function (st) { return st.id; }) };
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
      walkable: function (e) {
        var o = c.objects[e.ref]; if (!o) return true;
        if (o.kind === 'spawn' || o.kind === 'trigger') return true;
        if (o.kind === 'door') return v.states[e.key] === 'open';
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
      skills: knownSkills(c, p), loadout: p.loadout, cooldowns: p.cooldowns || {},
      statuses: (p.statuses || []).map(function (st) { return { id: st.id, until: st.until }; }),
      xpNext: xpFor(c, p.level + 1), xpThis: xpFor(c, p.level) || 0, gold: p.gold,
      inventory: p.inventory, equipment: p.equipment, respawn: p.respawn };
  }

  return { list: list, props: props, stats: stats, newPlayer: newPlayer, normalize: normalize, advance: advance,
    act: act, view: view, viewOpts: viewOpts, record: record, eventsFor: eventsFor, publicPlayer: publicPlayer,
    stateOf: stateOf, mapState: mapState, check: check, run: run, give: give, count: count,
    liveState: liveState, trapPhase: trapPhase, knownSkills: knownSkills, checkTarget: checkTarget,
    viewLookup: viewLookup, canSee: canSee, snapTarget: snapTarget, actionsAt: actionsAt, lineCells: lineCells, applyStatus: applyStatus };
})();
if (typeof module !== 'undefined') module.exports = World;
