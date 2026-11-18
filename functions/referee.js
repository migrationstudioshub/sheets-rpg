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
    return {
      map: mapId, now: now, seq: ms.seq || 0,
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
  /** Push a map's public view, but only when the moving things actually changed (an idle heartbeat writes nothing). */
  async function pushView(content, ms, mapId, players, now) {
    const view = firebaseView(content, ms, mapId, players, now);
    const signature = JSON.stringify(view.monsters) + '|' + JSON.stringify(view.players);
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
  async function runOnMap(content, mapId, allJson, token, action, now) {
    let out = null;
    const result = await db.ref('state/maps/' + mapId).transaction(cur => {
      const ms = parseVal(cur, null) || {};
      const all = JSON.parse(allJson), p = all[token];
      const ws = { seq: ms.seq || 0, log: ms.log || [], maps: {} };
      ws.maps[mapId] = ms;
      const players = presentOn(all, mapId, now);
      if (!players.includes(p)) players.push(p);
      const ev = [];
      World.advance(content, ws, mapId, players, now, rng, ev);
      if (action) ev.push(...World.act(content, ws, p, action, now, rng, players));
      p._seen = now;
      World.record(ws, ev);
      ms.seq = ws.seq;
      ms.log = (ws.log || []).slice(-50);                    // keep recent events only, to keep the record small
      out = { all, p, players, ev, ms };
      return JSON.stringify(ms);
    }, undefined, false);
    if (!result || !result.committed || !out) throw new Error('the world is busy — try again');
    return out;
  }

  /** One game step: catch the world up, run the player's action (if any), persist, report back. */
  async function step(token, action, since) {
    const content = await getContent();
    const now = clock();
    const all = await readPlayers();
    if (!all[token]) throw new Error('unknown character');
    Object.keys(all).forEach(tok => World.normalize(content, all[tok]));   // stats/fields, as on every load
    await migrateLegacy();

    const startMap = all[token].map;
    const first = await runOnMap(content, startMap, JSON.stringify(all), token, action, now);
    let last = first, events;
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
    const p = last.p;

    // Persist the actor and anyone combat touched this step — but NOT idle bystanders, so a simultaneous
    // action by another player can't overwrite their position. Also writes fewer records.
    const updates = {};
    updates['players/' + token] = JSON.stringify(p);
    Object.keys(last.all).forEach(tok => {
      const q = last.all[tok];
      if (tok !== token && q && touched.has(q.id)) updates['players/' + tok] = JSON.stringify(q);
    });
    await db.ref().update(updates);

    if (last !== first) await pushView(content, first.ms, startMap, first.players.filter(q => q.id !== p.id), now);   // the map just left
    await pushView(content, last.ms, p.map, last.players, now);

    const ws = { seq: last.ms.seq, log: last.ms.log, maps: {} };
    ws.maps[p.map] = last.ms;
    return { player: World.publicPlayer(content, p), world: World.view(content, ws, p.map, p, last.players),
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

  return { step: step, join: join, migrateLegacy: migrateLegacy };
}

module.exports = { create: create };
