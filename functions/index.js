/**
 * Sheets RPG — fast referee on Firebase Cloud Functions (Phase 1).
 *
 * This is the same game referee as the Apps Script server (server/Code.js), but it runs here in
 * ~100-300 ms instead of ~1.5 s, so online play feels close to instant. It runs the SAME rules
 * (functions/shared/*.js = copies of /shared), keeps game state in the Realtime Database, and
 * writes the live world that clients already listen to.
 *
 *   Content lives in Firestore (doc published/current + maps/<id> docs); this function serves it
 *   (?action=content), returns raw records for the Content Studio (?action=records / ?action=maps),
 *   and accepts key-gated writes (publish / publishMap / deleteMap). It also handles live play:
 *   join | load | poll | act | save. Apps Script is no longer in the loop.
 *
 * Realtime Database layout (the game step itself lives in ./referee.js — see the notes there):
 *   players/<token>      full player state (private; only this function reads/writes it)
 *   state/maps/<mapId>   one map's live state: monsters, object states, its event log and seq (private)
 *   world/<mapId>        the public view clients subscribe to (monsters + players on that map)
 *
 * Each step runs in a transaction on its map's record, so simultaneous actions no longer overwrite
 * each other. (The old single state/world record is split up automatically the first time this runs.)
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

const Content = require('./shared/content.js');
const Rules = require('./shared/rules.js'); global.Rules = Rules;   // world.js looks Rules up lazily
const World = require('./shared/world.js');
const MapCode = require('./shared/mapcode.js');                     // compact terrain encode/decode

// Content lives in Firestore (doc published/current = the full tables). The editor key gates writes.
const EDITOR_KEY = defineSecret('EDITOR_KEY');
let _content = null, _contentAt = 0;

async function getPublished() {           // the raw tables as last published to Firestore, or null
  const snap = await admin.firestore().doc('published/current').get();
  return snap.exists ? snap.data() : null;
}
// Maps live in their own Firestore docs (maps/<id>) so big ones aren't capped by anything; each is
// the map row + its entities, terrain compact-encoded. They override whatever the content blob holds.
async function mergeMaps(content) {
  const snap = await admin.firestore().collection('maps').get();
  if (snap.empty) return;
  content.maps = content.maps || {};
  snap.forEach(doc => {
    const m = doc.data(); if (!m || !m.id) return;
    content.maps[m.id] = { id: m.id, name: m.name || m.id, width: m.width, height: m.height,
      terrain: MapCode.decode(m.terrain), overlay: MapCode.decode(m.overlay || []),
      vWalls: MapCode.decode(m.vWalls || []), hWalls: MapCode.decode(m.hWalls || []),
      roof: MapCode.decode(m.roof || []), roof_color: m.roof_color || '', spawn: m.spawn || null,
      shapes: m.shapes || {}, overlayShapes: m.overlayShapes || {}, entities: m.entities || [] };
  });
}
async function getContent() {
  if (_content && Date.now() - _contentAt < 30 * 60 * 1000) return _content;   // content rarely changes; refetch rarely
  const pub = await getPublished();
  if (!pub || !pub.tables) throw new Error('no published content — seed it with tools/seed_firestore.js');
  const content = Content.build(pub.tables);
  await mergeMaps(content);
  _content = content; _contentAt = Date.now();
  return _content;
}

function requireEditor(key) {
  const want = EDITOR_KEY.value();
  if (!want) throw new Error('publishing is off: set the EDITOR_KEY secret on the function');
  if (!key || key !== want) throw new Error('wrong editor key');
}
/** Write a new content snapshot (the whole tables object) and bust the cache. Key-gated. */
async function publish(tables, key) {
  requireEditor(key);
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) throw new Error('publish needs a tables object');
  const version = Date.now().toString(36);
  await admin.firestore().doc('published/current').set({ tables, version, updatedAt: Date.now() });
  _content = null; _contentAt = 0;                 // next read rebuilds from Firestore
  return { ok: true, version, tabs: Object.keys(tables).length };
}
/** Raw records (the tables), for the Content Studio to load and edit. */
async function records() {
  const pub = await getPublished();
  return { tables: pub ? pub.tables : null, version: pub ? pub.version : null };
}
/** Every map doc as stored (terrain encoded), for the map editor to load. */
async function readMaps() {
  const snap = await admin.firestore().collection('maps').get();
  return { maps: snap.docs.map(d => d.data()) };
}
/** Save one map to maps/<id> (key-gated). `map` carries terrain (encoded) + its entities. */
async function publishMap(map, key) {
  requireEditor(key);
  if (!map || !/^[a-z0-9_]+$/i.test(String(map.id || ''))) throw new Error('bad map id');
  const doc = {
    id: String(map.id), name: String(map.name || map.id),
    width: Number(map.width) || 0, height: Number(map.height) || 0,
    terrain: map.terrain, overlay: map.overlay || null,
    vWalls: map.vWalls || null, hWalls: map.hWalls || null,
    roof: map.roof || null, roof_color: map.roof_color || null, spawn: map.spawn || null,
    shapes: map.shapes || null, overlayShapes: map.overlayShapes || null,
    entities: Array.isArray(map.entities) ? map.entities : [],
    updatedAt: Date.now()
  };
  await admin.firestore().doc('maps/' + doc.id).set(doc);
  _content = null; _contentAt = 0;
  return { ok: true, id: doc.id };
}
async function deleteMap(id, key) {
  requireEditor(key);
  if (!/^[a-z0-9_]+$/i.test(String(id || ''))) throw new Error('bad map id');
  await admin.firestore().doc('maps/' + id).delete();
  // A map can also live in the published content blob (a seed/legacy map never individually saved).
  // Strip it there too, or deleting it looks successful but the blob map reappears on the next load.
  const pub = await getPublished();
  if (pub && pub.tables && ((pub.tables.Maps || []).some(r => String(r.id) === String(id)) ||
      (pub.tables.MapEntities || []).some(r => String(r.map) === String(id)))) {
    const t = pub.tables;
    t.Maps = (t.Maps || []).filter(r => String(r.id) !== String(id));
    t.MapEntities = (t.MapEntities || []).filter(r => String(r.map) !== String(id));
    await admin.firestore().doc('published/current').set({ tables: t, version: Date.now().toString(36), updatedAt: Date.now() });
  }
  _content = null; _contentAt = 0;
  return { ok: true, id: id };
}

// Live play (join | load | poll | act): the step logic, bound to the real database.
const referee = require('./referee.js').create({ db, getContent, World });
const step = referee.step, join = referee.join;

function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

exports.game = onRequest({ region: 'us-central1', cors: true, secrets: [EDITOR_KEY] }, async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  try {
    // Content reads are allowed over GET too, so the client loads them with a simple fetch(url?action=content).
    if (req.method === 'GET') {
      const qa = (req.query && req.query.action) || '';
      if (qa === 'content') { res.json({ content: await getContent() }); return; }
      if (qa === 'records') { res.json(await records()); return; }
      if (qa === 'maps') { res.json(await readMaps()); return; }
      res.json({ error: 'unknown action' }); return;
    }
    const body = req.body || {};
    let out;
    switch (body.action) {
      case 'join': out = await join(body.name, body['class']); break;
      case 'load': out = await step(body.token, null, -1); break;
      case 'poll': out = await step(body.token, null, body.since, body.structRev); break;
      case 'act':  out = await step(body.token, body['do'], body.since, body.structRev); break;
      case 'resetStructures': requireEditor(body.key); out = await referee.resetStructures(body.map); break;
      case 'save': out = { ok: true }; break;                 // state is persisted every step already
      case 'content': out = { content: await getContent() }; break;
      case 'records': out = await records(); break;
      case 'maps': out = await readMaps(); break;
      case 'publish': out = await publish(body.tables, body.key); break;
      case 'publishMap': out = await publishMap(body.map, body.key); break;
      case 'deleteMap': out = await deleteMap(body.id, body.key); break;
      default: out = { error: 'unknown action' };
    }
    res.json(out);
  } catch (err) {
    res.json({ error: String((err && err.message) || err) });
  }
});
