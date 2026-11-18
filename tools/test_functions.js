/**
 * Tests the Cloud Function's game step (functions/referee.js) against a fake Realtime Database.
 * Run: node tools/test_functions.js
 *
 * The fake database behaves like the real one where it matters here: values live in a tree addressed by
 * path, and transaction() calls its update function first with null (the real client has no cached value
 * either), then again with the stored value, and once more whenever the value changed underneath it.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const tables = JSON.parse(fs.readFileSync(path.join(root, 'data/tables.json'), 'utf8'));
const Content = require('../shared/content.js');
const Rules = require('../shared/rules.js'); global.Rules = Rules;
const World = require('../shared/world.js');
const Referee = require('../functions/referee.js');

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function fakeDb() {
  const tree = {};
  const stats = { sets: [], txAttempts: 0 };
  let beforeCommit = null;                       // test hook: runs once just before a transaction commits
  function parts(p) { return String(p || '').split('/').filter(Boolean); }
  function read(p) { let n = tree; for (const k of parts(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : n; }
  function write(p, v) {
    const ks = parts(p); let n = tree;
    for (let i = 0; i < ks.length - 1; i++) { if (n[ks[i]] == null || typeof n[ks[i]] !== 'object') n[ks[i]] = {}; n = n[ks[i]]; }
    if (v == null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
    stats.sets.push(p);
  }
  function ref(p) {
    return {
      get: async () => ({ val: () => { const v = read(p); return v == null ? null : JSON.parse(JSON.stringify(v)); } }),
      set: async (v) => write(p, v),
      remove: async () => write(p, null),
      update: async (obj) => { Object.keys(obj).forEach(k => write((p ? p + '/' : '') + k, obj[k])); },
      transaction: async (fn) => {
        stats.txAttempts++;
        fn(null);                                               // first run: no cached value, like the real client
        for (let tries = 0; tries < 10; tries++) {
          const cur = read(p);
          stats.txAttempts++;
          const next = fn(cur);
          if (next === undefined) return { committed: false, snapshot: { val: () => cur } };
          if (beforeCommit) { const h = beforeCommit; beforeCommit = null; h(); }
          if (read(p) !== cur) continue;                         // changed underneath: run it again
          write(p, next);
          return { committed: true, snapshot: { val: () => next } };
        }
        throw new Error('transaction gave up');
      }
    };
  }
  return { ref, tree, stats, read, write, onBeforeCommit: (h) => { beforeCommit = h; } };
}

function setup() {
  const content = Content.build(JSON.parse(JSON.stringify(tables)));
  const db = fakeDb();
  let now = 1000000;
  const referee = Referee.create({ db, World, getContent: async () => content, now: () => now, random: () => 0.5 });
  return { content, db, referee, tick: (ms) => { now += ms; }, now: () => now };
}
function mapRec(db, mapId) { const v = db.read('state/maps/' + mapId); return v == null ? null : JSON.parse(v); }
function playerRec(db, token) { return JSON.parse(db.read('players/' + token)); }

test('joining and loading stores the world per map, not as one record', async () => {
  const s = setup();
  const j = await s.referee.join('Ana', '');
  const r = await s.referee.step(j.token, null, -1);
  assert.strictEqual(r.player.name, 'Ana');
  const rec = mapRec(s.db, r.player.map);
  assert.ok(rec && Array.isArray(rec.monsters), 'the map has its own record with its monsters');
  assert.strictEqual(typeof rec.seq, 'number');
  assert.strictEqual(s.db.read('state/world'), null, 'no single world record any more');
  assert.strictEqual(r.seq, rec.seq, 'the answer carries this map\'s event number');
  assert.ok(s.db.read('world/' + r.player.map), 'the public view was pushed');
});

test('moving is saved, and an idle heartbeat pushes nothing public', async () => {
  const s = setup();
  const j = await s.referee.join('Ana', '');
  const r0 = await s.referee.step(j.token, null, -1);
  const map = s.content.maps[r0.player.map];
  const dir = ['N', 'E', 'S', 'W'].filter(d => Rules.tryMove(s.content, map, r0.player.x, r0.player.y, d, {}).ok)[0];
  assert.ok(dir, 'the spawn has somewhere to walk');
  const r1 = await s.referee.step(j.token, { type: 'move', dirs: [dir] }, r0.seq);
  assert.ok(r1.player.x !== r0.player.x || r1.player.y !== r0.player.y, 'the player moved');
  const saved = playerRec(s.db, j.token);
  assert.strictEqual(saved.x, r1.player.x); assert.strictEqual(saved.y, r1.player.y);
  s.db.stats.sets.length = 0;
  await s.referee.step(j.token, null, r1.seq);                     // nothing moved since
  assert.ok(!s.db.stats.sets.some(p => p.indexOf('world/') === 0), 'no public push when nothing changed');
});

test('two actions landing at once on one map both keep their effect', async () => {
  const s = setup();
  const a = await s.referee.join('Ana', ''), b = await s.referee.join('Ben', '');
  const ra = await s.referee.step(a.token, null, -1);
  await s.referee.step(b.token, null, -1);
  const mapId = ra.player.map;
  // While Ana's step is about to commit, another step (Ben's) changes the same map record underneath it.
  s.db.onBeforeCommit(() => {
    const rec = mapRec(s.db, mapId);
    rec.states = rec.states || {}; rec.states['test.marker'] = 'set-by-the-other-step';
    rec.seq = (rec.seq || 0) + 1;
    s.db.write('state/maps/' + mapId, JSON.stringify(rec));
  });
  const before = s.db.stats.txAttempts;
  const map = s.content.maps[mapId];
  const dir = ['N', 'E', 'S', 'W'].filter(d => Rules.tryMove(s.content, map, ra.player.x, ra.player.y, d, {}).ok)[0];
  const r = await s.referee.step(a.token, { type: 'move', dirs: [dir] }, ra.seq);
  assert.ok(s.db.stats.txAttempts - before >= 3, 'the step was run again on the fresh state');
  const rec = mapRec(s.db, mapId);
  assert.strictEqual(rec.states['test.marker'], 'set-by-the-other-step', 'the other step\'s change survived');
  const saved = playerRec(s.db, a.token);
  assert.strictEqual(saved.x, r.player.x); assert.strictEqual(saved.y, r.player.y);
  const step1 = Rules.tryMove(s.content, map, ra.player.x, ra.player.y, dir, {});
  assert.deepStrictEqual([saved.x, saved.y], [step1.x, step1.y], 'the move was applied exactly once, not once per attempt');
});

test('the old single world record is split per map once, then removed', async () => {
  const s = setup();
  const j = await s.referee.join('Ana', '');
  const mapId = playerRec(s.db, j.token).map;
  const legacy = { seq: 41, log: [{ seq: 41, map: mapId, type: 'info', text: 'old' }], maps: {} };
  legacy.maps[mapId] = { states: { 'legacy.door': 'open' }, timers: {}, monsters: null };
  legacy.maps.some_other_map = { states: { 'x.e1': 'empty' }, timers: {}, monsters: null };
  s.db.write('state/world', JSON.stringify(legacy));
  const r = await s.referee.step(j.token, null, -1);
  assert.strictEqual(s.db.read('state/world'), null, 'the old record is gone');
  assert.strictEqual(mapRec(s.db, mapId).states['legacy.door'], 'open', 'its door state carried over');
  assert.strictEqual(mapRec(s.db, 'some_other_map').states['x.e1'], 'empty', 'other maps carried over too');
  assert.ok(r.seq >= 41, 'event numbers continue from the old counter');
});

test('walking to another map answers with that map\'s event number and view', async () => {
  const s = setup();
  const ids = Object.keys(s.content.maps);
  const j = await s.referee.join('Ana', '');
  const r0 = await s.referee.step(j.token, null, -1);
  const from = r0.player.map, to = ids.filter(id => id !== from)[0];
  assert.ok(to, 'the seed data has a second map');
  // Give the destination a much lower event number than the map we leave, and send the player there
  // through a real action: stand them next to a teleport is map-specific, so use the rules directly —
  // a data-driven "teleport" script run by an interaction is what a door does.
  for (let i = 0; i < 5; i++) { s.tick(100); await s.referee.step(j.token, { type: 'face', dir: 'N' }, 0); }
  const dest = Rules.nearestStandable(s.content, s.content.maps[to], 1, 1);
  const realAct = World.act;
  World.act = function (c, ws, p, action, now, rng, players) {
    if (action && action.type === 'test-teleport') { p.map = to; p.x = dest.x; p.y = dest.y; return [{ type: 'info', to: p.id, text: 'You step through.' }]; }
    return realAct.apply(World, arguments);
  };
  let r;
  try { r = await s.referee.step(j.token, { type: 'test-teleport' }, r0.seq); } finally { World.act = realAct; }
  assert.strictEqual(r.player.map, to);
  assert.strictEqual(r.world.map, to, 'the view is of the new map');
  assert.strictEqual(r.seq, mapRec(s.db, to).seq, 'the event number is the new map\'s');
  assert.ok(r.events.some(e => e.text === 'You step through.'), 'this step\'s own events are handed over directly');
  assert.strictEqual(playerRec(s.db, j.token).map, to);
  const left = s.db.read('world/' + from);
  assert.ok(!left.players || !left.players.some(q => q.id === r.player.id), 'the map just left no longer lists the player');
  const r2 = await s.referee.step(j.token, null, r.seq);
  assert.strictEqual(r2.player.map, to); assert.ok(r2.seq >= r.seq);
});

test('floors: a monster following a player upstairs is handed from one floor\'s record to the other\'s', async () => {
  // a two-floor hall with a staircase: foot (4,6), run to (4,5), landing (4,4) on the floor above
  const t = JSON.parse(JSON.stringify(tables));
  const full = Array(10).fill(Array(10).fill('til_1'));
  const upper = Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => (x >= 2 && x <= 7 && y >= 1 && y <= 6 && !(x === 4 && (y === 6 || y === 5)) ? 'til_1' : '')));
  t.Objects.push({ id: 'obj_stairs', name: 'Stairs', kind: 'stairs', sprite: '', walkable: false, properties: JSON.stringify({ length: 2 }) });
  t.Maps.push({ id: 'hall', name: 'Hall', width: 10, height: 10, terrain: JSON.stringify(full) });
  t.Maps.push({ id: 'hall_z1', name: 'Hall', width: 10, height: 10, terrain: JSON.stringify(upper), floor_of: 'hall', z: 1 });
  t.MapEntities.push({ map: 'hall', key: 'hall.e1', x: 4, y: 6, ref: 'obj_stairs', data: '' });
  const content = Content.build(t), db = fakeDb();
  let now = 2000000;
  const referee = Referee.create({ db, World, getContent: async () => content, now: () => now, random: () => 0.5 });
  const j = await referee.join('Ana', '');
  const rec = playerRec(db, j.token);
  Object.assign(rec, { map: 'hall', x: 4, y: 5, facing: 'N' });           // standing on the head of the stairs
  await db.ref('players/' + j.token).set(JSON.stringify(rec));
  now += 1000; await referee.step(j.token, null, -1);                    // the ground floor's record now exists
  const ref = Object.keys(content.monsters)[0], def = content.monsters[ref];
  const ground = mapRec(db, 'hall');
  ground.monsters = (ground.monsters || []).concat([{ id: 'hall.m1', ref, x: 4, y: 8, hp: def.hp, last: now, facing: 'N', spawn: '', engaged: rec.id }]);
  await db.ref('state/maps/hall').set(JSON.stringify(ground));

  now += 1000;
  const up = await referee.step(j.token, { type: 'move', dirs: ['N'] }, 0);
  assert.deepStrictEqual([up.player.map, up.player.x, up.player.y], ['hall_z1', 4, 4], 'the player is upstairs');
  assert.strictEqual(playerRec(db, j.token).wake.map, 'hall', 'and the floor they left is to be kept moving');
  assert.ok(mapRec(db, 'hall').monsters.find(m => m.id === 'hall.m1').follow, 'the monster was told to follow');
  // the player walks on upstairs; each of their steps also moves the floor below, though nobody is on it
  now += 1000; await referee.step(j.token, { type: 'move', dirs: ['N', 'N'] }, 0);
  let guest = null;
  for (let i = 0; i < 12 && !guest; i++) {
    now += def.moveMs + 50;
    const r = await referee.step(j.token, null, 0);
    guest = (r.world.monsters || []).find(m => /^hall\.m1~/.test(m.id)) || null;
  }
  assert.ok(guest, 'it arrives on the floor above and is in the player\'s view');
  const upRec = mapRec(db, 'hall_z1');
  assert.ok(upRec.monsters.some(m => m.guest && m.engaged === rec.id) && !(upRec.arrivals || []).length, 'it is in the upper floor\'s record, taken in');
  assert.ok(mapRec(db, 'hall').monsters.find(m => m.id === 'hall.m1').dead, 'and counts as lost on the floor below');
});

(async () => {
  for (const t of queue) { await t.fn(); passed++; console.log('ok -', t.name); }
  console.log(`\n${passed} function tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
