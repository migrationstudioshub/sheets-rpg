/**
 * Sheets RPG — the referee's game step, kept free of Firebase imports so it can be tested with a fake
 * database (tools/test_functions.js). functions/index.js wires it to the real Realtime Database.
 *
 * Realtime Database layout it reads and writes:
 *   players/<token>       full player state (private), a JSON string
 *   state/maps/<mapId>    ONE MAP's live state (private), a JSON string:
 *                         { states, timers, monsters, ..., log: [recent events], seq: last event number }
 *   world/<mapId>         the public view clients subscribe to (monsters + players on that map)
 *
 * Why per map, and why a transaction: the whole world used to be one record (state/world) written
 * last-write-wins, so two actions landing in the same ~200 ms overwrote each other's changes. Now each
 * step runs inside a transaction on its map's record: if someone else changed the map meanwhile, the step
 * is simply run again on the fresh state. Players on different maps never touch the same record.
 *
 * Event numbers (seq) are therefore PER MAP. A client just stores the seq of the last answer and sends it
 * back as `since`; when a step moves the player to another map, the answer carries the new map's seq and
 * the events of that step directly.
 *
 * The transaction callback may run more than once, so it must not touch anything captured from outside:
 * it works on fresh copies of the players (parsed from a JSON snapshot) every attempt, and only the
 * attempt that commits is kept.
 */
const crypto = require('crypto');

function create(deps) {
  const db = deps.db, getContent = deps.getContent, World = deps.World;
  const clock = deps.now || Date.now, rng = deps.random || Math.random;
  const lastView = {};   // per warm instance: last public view written per map, so identical pushes are skipped
  let migrating = null;

  // Records are stored as JSON strings because their keys (entity ids like "map_3.e9", flag names)
  // contain characters the Realtime Database forbids in keys (".", "#", ...).
  function parseVal(v, fallback) {
    if (v == null) return fallback;
    return typeof v === 'string' ? JSON.parse(v) : v;        // tolerate records written as plain objects
  }
  async function readPlayers() {
    const snap = await db.ref('players').get();
    const raw = snap.val() || {}, out = {};
    Object.keys(raw).forEach(tok => { try { out[tok] = parseVal(raw[tok]); } catch (e) { /* skip unreadable */ } });
    return out;
  }
  function presentOn(all, mapId, now) {
    return Object.keys(all).map(tok => all[tok])
      .filter(q => q.map === mapId && now - (q._seen || 0) < 60000);
  }

  /** The fast-moving, fully-global part of a map's state: all monsters and all players present. */
  function firebaseView(content, ms, mapId, players, now) {
    // doors = which doors (and other things on the walls) are not in their usual state, for players watching this
    // floor from another one. A JSON string: entity keys hold '.', which the database forbids in keys.
    const one = { maps: {} }; one.maps[mapId] = ms;
    const fst = World.fixtureStates(content, one, mapId);
    return {
      map: mapId, now: now, seq: ms.seq || 0, doors: Object.keys(fst).length ? JSON.stringify(fst) : null,
      monsters: (ms.monsters || []).filter(m => !m.dead).map(m => {
        const d = content.monsters[m.ref];
        return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing,
          statuses: (m.statuses || []).map(st => st.id), look: m.look || undefined };
      }),
      players: (players || []).filter(q => q.map === mapId).map(q => ({
        id: q.id, name: q.name, x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: World.stats(content, q).maxHp, level: q.level
      }))
    };
  }
  // What players built or broke on a floor of a multi-storey building, for those watching it from another floor:
  // world/s~<groundId>/<floorId> = { rev, json }, written only when the layer's revision changes. (A JSON string:
  // its keys hold '.', which the database forbids in keys.)
  const lastStruct = {};
  async function pushStruct(content, ms, mapId) {
    const rev = (ms.struct && ms.struct.rev) || 0;
    if (!rev || lastStruct[mapId] === rev || World.floorsOf(content, mapId).length < 2) return;
    lastStruct[mapId] = rev;
    await db.ref('world/s~' + World.groundId(content, mapId) + '/' + mapId).set({ rev: rev, json: JSON.stringify(World.publicStruct(ms.struct)) });
  }
  /** Push a map's public view, but only when the moving things actually changed (an idle heartbeat writes nothing). */
  async function pushView(content, ms, mapId, players, now) {
    await pushStruct(content, ms, mapId);
    const view = firebaseView(content, ms, mapId, players, now);
    const signature = JSON.stringify(view.monsters) + '|' + JSON.stringify(view.players) + '|' + (view.doors || '');
    if (lastView[mapId] === signature) return;
    lastView[mapId] = signature;
    await db.ref('world/' + mapId).set(view);
  }

  /**
   * One-off: split the old single world record (state/world) into per-map records, then remove it.
   * Checked once per warm instance. A map record that already exists is left alone.
   */
  function migrateLegacy() {
    if (migrating) return migrating;
    migrating = (async () => {
      const snap = await db.ref('state/world').get();
      const raw = snap.val();
      if (raw == null) return;
      const old = parseVal(raw, null) || {}, maps = old.maps || {};
      for (const id of Object.keys(maps)) {
        if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;                       // not a usable database key
        const rec = JSON.stringify(Object.assign({}, maps[id], { seq: old.seq || 0, log: [] }));
        await db.ref('state/maps/' + id).transaction(cur => (cur == null ? rec : undefined), undefined, false);
      }
      await db.ref('state/world').remove();
    })().catch(err => { migrating = null; throw err; });
    return migrating;
  }

  /**
   * Run one map's part of a step inside a transaction on that map's record: catch the map up, then the
   * player's action (if any). `allJson` is a JSON snapshot of every player; each attempt parses its own
   * copy. Returns the committed attempt: { all, p, players, ev, ms }.
   */
  async function runOnMap(content, mapId, allJson, token, action, now, absent) {
    let out = null;
    const result = await db.ref('state/maps/' + mapId).transaction(cur => {
      const ms = parseVal(cur, null) || {};
      const all = JSON.parse(allJson), p = all[token];
      const ws = { seq: ms.seq || 0, log: ms.log || [], maps: {} };
      ws.maps[mapId] = ms;
      // absent = the acting player is NOT on this map: it is a floor they just left, kept moving so the monsters
      // following them reach the stairs. Nobody there is touched (no players are handed to the rules).
      // absent = 'remote': the player is on another floor of this building and their action lands HERE (a shot at
      // something they can see on this floor). The floor runs as usual for whoever is on it; the player is not added.
      const remote = absent === 'remote';
      const players = absent && !remote ? [] : presentOn(all, mapId, now);
      if (!absent && !players.includes(p)) players.push(p);
      const ev = [];
      World.advance(content, ws, mapId, players, now, rng, ev);
      if (action && (!absent || remote)) ev.push(...World.act(content, ws, p, action, now, rng, players));
      if (!absent) p._seen = now;
      World.record(ws, ev);
      ms.seq = ws.seq;
      ms.log = (ws.log || []).slice(-50);                    // keep recent events only, to keep the record small
      out = { all, p, players, ev, ms, transfers: ws.transfers || [] };   // transfers = monsters that took the stairs to another floor
      return JSON.stringify(ms);
    }, undefined, false);
    if (!result || !result.committed || !out) throw new Error('the world is busy — try again');
    return out;
  }

  /**
   * Monsters that changed floor (docs/FLOORS.md): each floor is its own record, so they are handed over by
   * adding them to the other floor's `arrivals`, which that floor takes in on its next step.
   */
  async function deliver(content, transfers) {
    const byMap = {};
    (transfers || []).forEach(t => { if (t && t.map) (byMap[t.map] = byMap[t.map] || []).push(t); });
    for (const mapId of Object.keys(byMap)) {
      await db.ref('state/maps/' + mapId).transaction(cur => {
        const ms = parseVal(cur, null) || {};
        byMap[mapId].forEach(t => World.applyNotice(content, mapId, ms, t));   // a monster arriving, a claim's shadow, floor laid or opened
        return JSON.stringify(ms);
      }, undefined, false);
    }
  }

  // The other floors of the building a player is in are kept moving too, so what they watch from a window or a
  // balcony is alive (docs/FLOORS.md). Each floor is its own record: one with somebody on it is moved by them; an
  // empty one is moved here, at most every floor_tick_ms, and left alone for a while when nothing lives on it.
  const floorRun = {}, floorQuiet = {};
  async function tickFloors(content, all, token, startMap, skip, now) {
    const every = Number(content.config.floor_tick_ms) || 1000;
    const due = World.floorsOf(content, startMap).map(f => f.id).filter(id => id !== startMap && !skip.includes(id) && content.maps[id] &&
      now - (floorRun[id] || 0) >= every && now >= (floorQuiet[id] || 0) && !presentOn(all, id, now).length);
    if (!due.length) return;
    const json = JSON.stringify(all);
    await Promise.all(due.map(async id => {
      floorRun[id] = now;
      try {
        const r = await runOnMap(content, id, json, token, null, now, true);
        if (!(r.ms.monsters || []).length && !(r.ms.arrivals || []).length) floorQuiet[id] = now + 30000;
        await deliver(content, r.transfers);
        await pushView(content, r.ms, id, [], now);
      } catch (e) { /* that floor is busy: it catches up on the next step */ }
    }));
  }

  /** One game step: catch the world up, run the player's action (if any), persist, report back. */
  async function step(token, action, since, structRev) {
    const content = await getContent();
    const now = clock();
    const all = await readPlayers();
    if (!all[token]) throw new Error('unknown character');
    Object.keys(all).forEach(tok => World.normalize(content, all[tok]));   // stats/fields, as on every load
    await migrateLegacy();

    const startMap = all[token].map;
    // Monsters following this player by the stairs are on the floor they left; nobody may be there to move it on,
    // so for a short while (player.wake) this player's steps move that floor too.
    const wake = all[token].wake;
    if (wake && wake.map && wake.map !== startMap && now < wake.until && content.maps[wake.map]) {
      const w = await runOnMap(content, wake.map, JSON.stringify(all), token, null, now, true);
      await deliver(content, w.transfers);
      await pushView(content, w.ms, wake.map, presentOn(all, wake.map, now), now);
    }
    // A shot at another floor of the building runs on THAT floor's record, where what it hits lives.
    const far = action && (action.type === 'shoot' || action.type === 'throw') && action.map && String(action.map) !== startMap && content.maps[action.map] &&
      World.groundId(content, String(action.map)) === World.groundId(content, startMap) ? String(action.map) : null;
    const others = tickFloors(content, all, token, startMap, [far, wake && wake.map], now);   // runs alongside; awaited before the answer
    const first = await runOnMap(content, startMap, JSON.stringify(all), token, far ? null : action, now);
    await deliver(content, first.transfers);
    let last = first, events, shot = null;
    if (far) {
      shot = await runOnMap(content, far, JSON.stringify(first.all), token, action, now, 'remote');
      await deliver(content, shot.transfers);
    }
    const touched = new Set(first.ev.filter(e => e.to).map(e => e.to));
    if (first.p.map !== startMap) {                             // walked through a door/teleport: arrive on the new map
      last = await runOnMap(content, first.p.map, JSON.stringify(first.all), token, null, now);
      last.ev.filter(e => e.to).forEach(e => touched.add(e.to));
      // The event numbers of the two maps are unrelated, so hand this step's events over directly.
      const me = last.p.id;
      events = first.ev.concat(last.ev).filter(e => (e.to ? e.to === me : true));
    } else {
      events = World.eventsFor({ log: first.ms.log }, since, first.p);
    }
    if (shot) {                                                 // what the shot did is told to the shooter directly (it is in the other floor's log)
      shot.ev.filter(e => e.to).forEach(e => touched.add(e.to));
      events = events.concat(shot.ev.filter(e => e.to === shot.p.id || e.type === 'shoot' || e.type === 'throw'));
    }
    const fin = shot || last, p = fin.p;

    // Persist the actor and anyone combat touched this step — but NOT idle bystanders, so a simultaneous
    // action by another player can't overwrite their position. Also writes fewer records.
    const updates = {};
    updates['players/' + token] = JSON.stringify(p);
    Object.keys(fin.all).forEach(tok => {
      const q = fin.all[tok];
      if (tok !== token && q && touched.has(q.id)) updates['players/' + tok] = JSON.stringify(q);
    });
    await db.ref().update(updates);

    if (last !== first) await pushView(content, first.ms, startMap, first.players.filter(q => q.id !== p.id), now);   // the map just left
    await pushView(content, last.ms, p.map, last.players, now);
    if (shot) await pushView(content, shot.ms, far, shot.players, now);

    await others;
    const ws = { seq: last.ms.seq, log: last.ms.log, maps: {} };
    ws.maps[p.map] = last.ms;
    // structRev = the structure-layer revision the client already has; after a map change it knows nothing
    return { player: World.publicPlayer(content, p), world: World.view(content, ws, p.map, p, last.players, last !== first ? -1 : structRev),
      events: events, seq: last.ms.seq };
  }

  async function join(name, cls) {
    const content = await getContent();
    name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
    if (!name) throw new Error('pick a name (letters and numbers)');
    const p = World.newPlayer(content, crypto.randomUUID().slice(0, 8), name, cls);
    p.token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    p.created = new Date().toISOString();
    p._seen = clock();
    await db.ref('players/' + p.token).set(JSON.stringify(p));
    return { token: p.token, player: World.publicPlayer(content, p) };
  }

  /** Owner tool: wipe everything built, damaged or destroyed on one map, back to the authored map. */
  async function resetStructures(mapId) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(mapId || ''))) throw new Error('bad map id');
    const result = await db.ref('state/maps/' + mapId).transaction(cur => {
      const ms = parseVal(cur, null); if (!ms) return cur == null ? undefined : cur;
      const old = ms.struct || {};
      ms.struct = { rev: (old.rev || 0) + 1, n: old.n || 0, walls: {}, ents: [], dmg: {}, gone: {} };
      return JSON.stringify(ms);
    }, undefined, false);
    return { ok: true, map: mapId, changed: !!(result && result.committed) };
  }

  return { step: step, join: join, migrateLegacy: migrateLegacy, resetStructures: resetStructures };
}

module.exports = { create: create };
