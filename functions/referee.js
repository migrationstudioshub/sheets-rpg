/**
 * Sheets RPG — the referee's game step, kept free of Firebase imports so it can be tested with a fake
 * database (tools/test_functions.js). functions/index.js wires it to the real Realtime Database.
 *
 * Realtime Database layout it reads and writes:
 *   players/<token>       full player state (private), a JSON string
 *   state/maps/<mapId>    ONE MAP's live state (private), a JSON string:
 *                         { states, timers, monsters, ..., log: [recent events], seq: last event number }
 *   world/<mapId>         the public view clients subscribe to, written PIECE BY PIECE (see pushView):
 *                         { map, v: 2, now, seq, doors, players: [...],
 *                           m: { <monster key>: "x,y,hp,facing,statuses" }   what moves — only the ones that changed are written
 *                           d: { <monster key>: JSON {ref, maxHp, look} } }  what does not (its looks) — written once
 *   here/<groundId>/<token> = when that player last acted in that building (a map and its floors): who is around,
 *                         so a step reads those characters
 *                         and not every character ever made
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
  const INSTANCE = crypto.randomUUID().slice(0, 8);   // this warm instance: a map record remembers who ran its last step (pi)
  const pushed = {};     // per warm instance and map: what this instance last wrote to world/<mapId> (see pushView)
  let migrating = null;

  // Records are stored as JSON strings because their keys (entity ids like "map_3.e9", flag names)
  // contain characters the Realtime Database forbids in keys (".", "#", ...).
  function parseVal(v, fallback) {
    if (v == null) return fallback;
    return typeof v === 'string' ? JSON.parse(v) : v;        // tolerate records written as plain objects
  }
  async function readOne(token) {
    const snap = await db.ref('players/' + token).get(), raw = snap.val();
    if (raw == null) return null;
    try { return parseVal(raw); } catch (e) { return null; }
  }
  /**
   * Adds to `all` ({token: player}) whoever is in these buildings according to here/<groundId> and has acted in the last
   * minute. One read per map, then one per character found — all at once. `stale` collects index entries a day old.
   */
  async function loadPresent(all, mapIds, now, stale, skip) {
    const lists = await Promise.all(mapIds.map(id => db.ref('here/' + id).get().then(sn => sn.val() || {})));
    const want = {};
    lists.forEach((h, i) => Object.keys(h).forEach(tok => {
      const seen = Number(h[tok]) || 0;
      if (now - seen < 60000) { if (!all[tok] && tok !== skip) want[tok] = 1; }   // (skip: the one whose step this is, read already)
      else if (stale && now - seen > 86400000 && stale.length < 20) stale.push('here/' + mapIds[i] + '/' + tok);
    }));
    const recs = await Promise.all(Object.keys(want).map(tok => readOne(tok).then(r => [tok, r])));
    recs.forEach(([tok, r]) => { if (r && !all[tok]) all[tok] = r; });
  }
  function presentOn(all, mapId, now) {
    return Object.keys(all).map(tok => all[tok])
      .filter(q => q.map === mapId && now - (q._seen || 0) < 60000);
  }

  /** A monster's id as a database key (ids hold '.', which keys may not). The game page decodes it. */
  function mKey(id) { return encodeURIComponent(String(id)).replace(/\./g, '%2E'); }
  /**
   * A map's public view, split the way it is stored: head = the small things (players present, door states),
   * m = each living monster's moving part as a short string, d = each one's fixed part (kind, full health, looks).
   */
  function viewParts(content, ms, mapId, players) {
    // doors = which doors (and other things on the walls) are not in their usual state, for players watching this
    // floor from another one. A JSON string: entity keys hold '.', which the database forbids in keys.
    const one = { maps: {} }; one.maps[mapId] = ms;
    const fst = World.fixtureStates(content, one, mapId);
    const m = {}, d = {};
    (ms.monsters || []).forEach(mo => {
      if (mo.dead) return;
      const def = content.monsters[mo.ref], k = mKey(mo.id);
      // x, y, health, facing, statuses, and what it is up to (World.alertOf: 2 after someone in sight, 1 looking for them)
      const al = World.alertOf ? World.alertOf(mo) : 0;
      m[k] = [mo.x, mo.y, mo.hp, mo.facing || 'S', (mo.statuses || []).map(st => st.id).join('|')].concat(al ? [al] : []).join(',');
      d[k] = JSON.stringify({ id: mo.id, ref: mo.ref, maxHp: def ? def.hp : mo.hp, look: mo.look || undefined });
    });
    return {
      doors: Object.keys(fst).length ? JSON.stringify(fst) : null,
      players: (players || []).filter(q => q.map === mapId).map(q => ({
        // class + equipment + hair: what the others need to draw this player as they are (the same fields an answer carries)
        id: q.id, name: q.name, 'class': q['class'] || '', equipment: q.equipment || {}, hair: q.hair || '', hairColor: q.hairColor || '', body: q.body || '', skin: q.skin || '',
        x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: World.stats(content, q).maxHp, level: q.level,
        wst: World.weaponState ? World.weaponState(content, q) : '',   // weapon in hand: '' | empty | reload (its picture)
        act: q.act || ''                                       // their last swing or shot, for the others to draw (World.noteAct)
      })),
      m: m, d: d
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
  /**
   * Push a map's public view — only what changed since this instance last wrote it (an idle heartbeat writes
   * nothing; a step in which three monsters moved writes three short strings). The whole view is written instead
   * when this instance has no picture of what is stored: its first push for the map, another instance ran the
   * map's last step (the record's `pi`), a push failed, or a minute has passed (so a slip never lasts).
   * Pushes for one map go one after another, and one made from an older state than the last is dropped, so two
   * steps finishing out of order cannot leave old positions behind.
   */
  function pushView(content, ms, mapId, players, now) {
    const st = pushed[mapId] || (pushed[mapId] = { pv: -1, base: null, fullAt: 0, chain: Promise.resolve() });
    const job = () => doPush(content, ms, mapId, players, now, st).catch(() => { st.base = null; });
    st.chain = st.chain.then(job, job);
    return st.chain;
  }
  async function doPush(content, ms, mapId, players, now, st) {
    await pushStruct(content, ms, mapId);
    const info = ms._push || { pv: st.pv + 1, prev: INSTANCE };
    if (st.base && info.pv <= st.pv && st.pv - info.pv < 50) return;            // an older state than the one already pushed
    const v = viewParts(content, ms, mapId, players);
    const head = JSON.stringify(v.players) + '|' + (v.doors || '');
    const full = !st.base || info.prev !== INSTANCE || now - st.fullAt > 60000 || info.pv <= st.pv;
    if (full) {
      const same = st.base && st.base.head === head && sameKeys(st.base.m, v.m) && sameKeys(st.base.d, v.d);
      st.pv = info.pv;
      if (same && info.prev === INSTANCE) { st.fullAt = now; return; }          // the minute's check found nothing out of place
      st.base = { head: head, m: v.m, d: v.d }; st.fullAt = now;
      await db.ref('world/' + mapId).set({ map: mapId, v: 2, now: now, seq: ms.seq || 0, doors: v.doors, players: v.players, m: v.m, d: v.d });
      return;
    }
    // Each branch is patched on its own (m, d, the head), so what reaches the game page is always "these children of
    // this node changed" — never a path inside a key, which not every reader takes the same way.
    const mp = {}, dp = {}, writes = [], at = 'world/' + mapId;
    Object.keys(v.m).forEach(k => { if (st.base.m[k] !== v.m[k]) mp[k] = v.m[k]; });
    Object.keys(st.base.m).forEach(k => { if (!(k in v.m)) mp[k] = null; });
    Object.keys(v.d).forEach(k => { if (st.base.d[k] !== v.d[k]) dp[k] = v.d[k]; });
    Object.keys(st.base.d).forEach(k => { if (!(k in v.d)) dp[k] = null; });
    const headChanged = st.base.head !== head;
    st.pv = info.pv; st.base = { head: head, m: v.m, d: v.d };
    if (Object.keys(dp).length) writes.push(db.ref(at + '/d').update(dp));
    if (Object.keys(mp).length) writes.push(db.ref(at + '/m').update(mp));
    if (headChanged) writes.push(db.ref(at).update({ players: v.players, doors: v.doors, now: now, seq: ms.seq || 0 }));
    await Promise.all(writes);
  }
  function sameKeys(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => a[k] === b[k]);
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
    if (deps.warm) deps.warm('state/maps/' + mapId);          // keep this record cached here: see index.js (warm)
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
      const prevInst = ms.pi;                                // pv counts this map's steps, pi names the instance that ran the last one:
      ms.pv = (ms.pv || 0) + 1; ms.pi = INSTANCE;            // pushView uses them to know whether its picture of world/<map> still holds
      out = { all, p, players, ev, ms, transfers: ws.transfers || [], push: { pv: ms.pv, prev: prevInst } };   // transfers = monsters that took the stairs to another floor
      return JSON.stringify(ms);
    }, undefined, false);
    if (!result || !result.committed || !out) throw new Error('the world is busy — try again');
    Object.defineProperty(out.ms, '_push', { value: out.push, enumerable: false });
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
  /**
   * opts (from the game page, both optional): at = the map it believes the player is on, so the characters around
   * can be read alongside the player's own record; live = the map whose pushed view it is receiving, so the answer
   * need not carry that map's monsters a second time.
   */
  async function step(token, action, since, structRev, opts) {
    const content = await getContent();
    const now = clock();
    const hint = opts && opts.at && content.maps[opts.at] ? String(opts.at) : '';
    const all = {}, loaded = {}, stale = [];
    // whoever is in the building of this map (its other floors are kept moving too), unless already read
    const around = async (into, mapId) => {
      const g = World.groundId(content, mapId);               // the index is kept per building: all its floors in one read
      if (loaded[g]) return;
      loaded[g] = 1;
      const ids = [g];
      const before = Object.keys(into);
      await loadPresent(into, ids, now, stale, token);
      Object.keys(into).forEach(tok => { if (before.indexOf(tok) < 0) World.normalize(content, into[tok]); });
    };
    const got = await Promise.all([readOne(token), hint ? around(all, hint) : null, migrateLegacy()]);
    if (!got[0]) throw new Error('unknown character');
    all[token] = got[0];
    World.normalize(content, all[token]);                    // stats/fields, as on every load
    await around(all, all[token].map);                       // (nothing to do when the hint was right)

    const startMap = all[token].map;
    // Monsters following this player by the stairs are on the floor they left; nobody may be there to move it on,
    // so for a short while (player.wake) this player's steps move that floor too.
    const wake = all[token].wake;
    if (wake && wake.map && wake.map !== startMap && now < wake.until && content.maps[wake.map]) {
      await around(all, wake.map);
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
      await around(first.all, first.p.map);                     // …among whoever is already there
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
    const hereNow = World.groundId(content, p.map), hereWas = World.groundId(content, startMap);
    updates['here/' + hereNow + '/' + token] = now;             // where this player is (which building), for the others' steps
    if (hereNow !== hereWas) updates['here/' + hereWas + '/' + token] = null;
    stale.forEach(path => { updates[path] = null; });

    // saving and telling everyone go side by side: none of them waits for another
    const jobs = [db.ref().update(updates), pushView(content, last.ms, p.map, last.players, now), others];
    if (last !== first) jobs.push(pushView(content, first.ms, startMap, first.players.filter(q => q.id !== p.id), now));   // the map just left
    if (shot) jobs.push(pushView(content, shot.ms, far, shot.players, now));
    await Promise.all(jobs);
    const ws = { seq: last.ms.seq, log: last.ms.log, maps: {} };
    ws.maps[p.map] = last.ms;
    // structRev = the structure-layer revision the client already has; after a map change it knows nothing
    const world = World.view(content, ws, p.map, p, last.players, last !== first ? -1 : structRev);
    // The page is already being pushed this map's monsters: do not send the whole list again with every answer.
    if (opts && opts.live && String(opts.live) === p.map && last === first) { delete world.monsters; world.pushed = 1; }
    return { player: World.publicPlayer(content, p), world: world, events: events, seq: last.ms.seq };
  }

  async function join(name, cls, look) {
    const content = await getContent();
    name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
    if (!name) throw new Error('pick a name (letters and numbers)');
    const p = World.newPlayer(content, crypto.randomUUID().slice(0, 8), name, cls, look);
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
