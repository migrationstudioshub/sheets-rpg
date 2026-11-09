/**
 * Sheets RPG — fast referee on Firebase Cloud Functions (Phase 1).
 *
 * This is the same game referee as the Apps Script server (server/Code.js), but it runs here in
 * ~100-300 ms instead of ~1.5 s, so online play feels close to instant. It runs the SAME rules
 * (functions/shared/*.js = copies of /shared), keeps game state in the Realtime Database, and
 * writes the live world that clients already listen to.
 *
 *   Apps Script still serves content (?action=content) and the map editor — unchanged.
 *   This function handles live play: join | load | poll | act | save.
 *
 * Realtime Database layout:
 *   players/<token>   full player state (private; only this function reads/writes it)
 *   state/world       the live world: monsters, object states, event log, seq (private)
 *   world/<mapId>     the public view clients subscribe to (monsters + players on that map)
 *
 * Phase 1 caveat: concurrent actions use last-write-wins on state/world (fine for a few players
 * taking turns; proper concurrency comes in Phase 2).
 */
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.database();

const Content = require('./shared/content.js');
const Rules = require('./shared/rules.js'); global.Rules = Rules;   // world.js looks Rules up lazily
const World = require('./shared/world.js');

// Content still lives in the Game Data sheet; fetch it from the Apps Script endpoint and cache it.
const CONTENT_URL = process.env.CONTENT_URL ||
  'https://script.google.com/macros/s/AKfycbwgvNgUbURE4p27Po2XPiBjAorqIxKDv0wJxnC9sxowo9jSbO9o8SyeY0oL5OjbOoYXmA/exec';
let _content = null, _contentAt = 0;
const _lastView = {};   // per warm instance: last public view written per map, so we skip identical pushes
async function getContent() {
  if (_content && Date.now() - _contentAt < 30 * 60 * 1000) return _content;   // content rarely changes; refetch rarely
  const res = await fetch(CONTENT_URL + '?action=content');
  const j = await res.json();
  if (!j || !j.content) throw new Error('could not load content');
  _content = j.content; _contentAt = Date.now();
  return _content;
}

async function readWorld() {
  const snap = await db.ref('state/world').get();
  return snap.val() || { seq: 0, log: [], maps: {} };
}
async function readPlayers() {
  const snap = await db.ref('players').get();
  return snap.val() || {};
}

/** The fast-moving, fully-global part of a map's state: all monsters and all players present. */
function firebaseView(content, ws, mapId, players) {
  const ms = World.mapState(ws, mapId);
  return {
    map: mapId, now: Date.now(), seq: ws.seq || 0,
    monsters: (ms.monsters || []).filter(m => !m.dead).map(m => {
      const d = content.monsters[m.ref];
      return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing,
        statuses: (m.statuses || []).map(st => st.id) };
    }),
    players: (players || []).filter(q => q.map === mapId).map(q => ({
      id: q.id, name: q.name, x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: World.stats(content, q).maxHp, level: q.level
    }))
  };
}

function presentOn(all, mapId, now) {
  return Object.keys(all).map(tok => all[tok])
    .filter(q => q.map === mapId && now - (q._seen || 0) < 60000);
}

/** One game step: catch the world up, run the player's action (if any), persist, report back. */
async function step(token, action, since) {
  const content = await getContent();
  const now = Date.now();
  const all = await readPlayers();
  const p = all[token];
  if (!p) throw new Error('unknown character');
  Object.keys(all).forEach(tok => World.normalize(content, all[tok]));   // stats/fields, like Apps Script does per load
  const ws = await readWorld();

  let players = presentOn(all, p.map, now);
  if (!players.includes(p)) players.push(p);
  const startMap = p.map, ev = [];
  World.advance(content, ws, p.map, players, now, Math.random, ev);
  if (action) ev.push(...World.act(content, ws, p, action, now, Math.random, players));
  p._seen = now;
  if (p.map !== startMap) {                                   // walked through a door/teleport
    players = presentOn(all, p.map, now);
    if (!players.includes(p)) players.push(p);
    World.advance(content, ws, p.map, players, now, Math.random, ev);
  }
  World.record(ws, ev);
  if (ws.log && ws.log.length > 50) ws.log = ws.log.slice(-50);   // keep recent events only, to shrink the stored world

  // Persist the actor and anyone combat touched this step — but NOT idle bystanders, so a simultaneous
  // action by another player can't overwrite their position. Also writes fewer records.
  const touched = new Set(ev.filter(e => e.to).map(e => e.to));
  const updates = { 'state/world': ws, ['players/' + token]: p };
  players.forEach(q => { if (q.token && q.id !== p.id && touched.has(q.id)) updates['players/' + q.token] = q; });
  await db.ref().update(updates);

  // Only push the public view when the moving things actually changed — an idle heartbeat (no one
  // moved, no monster stirred) writes nothing, so listeners download nothing.
  const view = firebaseView(content, ws, p.map, players);
  const signature = JSON.stringify(view.monsters) + '|' + JSON.stringify(view.players);
  if (_lastView[p.map] !== signature) { _lastView[p.map] = signature; await db.ref('world/' + p.map).set(view); }

  return { player: World.publicPlayer(content, p), world: World.view(content, ws, p.map, p, players),
    events: World.eventsFor(ws, since, p), seq: ws.seq };
}

async function join(name, cls) {
  const content = await getContent();
  name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
  if (!name) throw new Error('pick a name (letters and numbers)');
  const p = World.newPlayer(content, crypto.randomUUID().slice(0, 8), name, cls);
  p.token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
  p.created = new Date().toISOString();
  p._seen = Date.now();
  await db.ref('players/' + p.token).set(p);
  return { token: p.token, player: World.publicPlayer(content, p) };
}

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

exports.game = onRequest({ region: 'us-central1', cors: true }, async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    const body = req.body || {};
    let out;
    switch (body.action) {
      case 'join': out = await join(body.name, body['class']); break;
      case 'load': out = await step(body.token, null, -1); break;
      case 'poll': out = await step(body.token, null, body.since); break;
      case 'act':  out = await step(body.token, body['do'], body.since); break;
      case 'save': out = { ok: true }; break;                 // state is persisted every step already
      default: out = { error: 'unknown action' };
    }
    res.json(out);
  } catch (err) {
    res.json({ error: String((err && err.message) || err) });
  }
});
