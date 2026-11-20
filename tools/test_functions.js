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
  const stats = { sets: [], txAttempts: 0, ops: [], gets: [] };   // ops: [{type: 'put'|'patch', path, data}] as a stream would deliver them
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
      get: async () => { stats.gets.push(String(p)); return { val: () => { const v = read(p); return v == null ? null : JSON.parse(JSON.stringify(v)); } }; },
      set: async (v) => { stats.ops.push({ type: 'put', path: String(p), data: JSON.parse(JSON.stringify(v)) }); write(p, v); },
      remove: async () => write(p, null),
      update: async (obj) => { stats.ops.push({ type: 'patch', path: String(p || ''), data: JSON.parse(JSON.stringify(obj)) }); Object.keys(obj).forEach(k => write((p ? p + '/' : '') + k, obj[k])); },
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

// ---- the live push, as the game page receives it: client/js/api.js run here with a stand-in EventSource
function gamePage() {
  const vm = require('vm'), sources = [];
  function FakeES(url) { this.url = url; this.on = {}; sources.push(this); }
  FakeES.prototype.addEventListener = function (t, h) { this.on[t] = h; };
  FakeES.prototype.close = function () { this.closed = true; };
  const box = { GAME_CONFIG: { FIREBASE_URL: 'https://db.test', FUNCTIONS_URL: 'https://fn.test' }, EventSource: FakeES,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, JSON, Object, String, Number, Promise, encodeURIComponent };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(root, 'client/js/api.js'), 'utf8') + '\nthis.Api = Api;', box);
  const api = box.Api.create();
  return {
    api,
    /** Listen to a map; feed(db) hands over whatever the database has written to world/<mapId> since last time. */
    watch(mapId, main) {
      let world = null, fed = 0; const stop = api.watchMap(mapId, w => { world = w; }, main), es = sources[sources.length - 1], at = 'world/' + mapId;
      return {
        stop, world: () => world,
        feed(db) {
          const ops = db.stats.ops.slice(fed); fed = db.stats.ops.length; let n = 0, bytes = 0;
          ops.forEach(op => {
            if (op.path !== at && op.path.indexOf(at + '/') !== 0) return;
            const msg = JSON.stringify({ path: '/' + op.path.slice(at.length).replace(/^\//, ''), data: op.data });
            n++; bytes += msg.length; es.on[op.type]({ type: op.type, data: msg });
          });
          return { events: n, bytes };
        },
        start(db) { es.on.put({ type: 'put', data: JSON.stringify({ path: '/', data: db.read(at) }) }); fed = db.stats.ops.length; }   // what a new listener is sent first
      };
    }
  };
}
const byId = (list) => JSON.parse(JSON.stringify(list || [])).sort((a, b) => (a.id < b.id ? -1 : 1));   // (plain copies: the page runs in its own sandbox)

test('the live push sends only the monsters that changed, their looks once, and the game page rebuilds the same list', async () => {
  const s = setup();
  s.content.monsters[Object.keys(s.content.monsters)[0]].hp = 30;
  const j = await s.referee.join('Ana', '');
  const r0 = await s.referee.step(j.token, null, -1), mapId = r0.player.map;
  const total = r0.world.monsters.length;
  assert.ok(total >= 3, 'the start map has monsters');
  const first = s.db.read('world/' + mapId);
  assert.strictEqual(first.v, 2);
  assert.strictEqual(Object.keys(first.m).length, total, 'one short entry per monster');
  assert.ok(Object.keys(first.m).every(k => !/[.#$\[\]\/]/.test(k)), 'keys the database accepts');
  assert.ok(typeof first.m[Object.keys(first.m)[0]] === 'string' && first.m[Object.keys(first.m)[0]].length < 40);
  // a game page starts listening, then the world moves on
  const page = gamePage(), feed = page.watch(mapId, true);
  assert.strictEqual(page.api.liveMap, '', 'nothing has arrived yet');
  feed.start(s.db);
  assert.strictEqual(page.api.liveMap, mapId);
  assert.deepStrictEqual(byId(feed.world().monsters), byId(r0.world.monsters), 'the pieces add up to the list the answer carries');
  let seq = r0.seq, sawDelta = false, sawNoLooks = true;
  for (let i = 0; i < 25; i++) {
    s.tick(700);
    const rec = mapRec(s.db, mapId);
    if (i === 5) { rec.monsters[0].hp -= 3; s.db.write('state/maps/' + mapId, JSON.stringify(rec)); }          // one gets hurt
    if (i === 9) { rec.monsters[1].dead = true; rec.monsters[1].respawnAt = s.now() + 9e9; s.db.write('state/maps/' + mapId, JSON.stringify(rec)); }   // one dies
    const before = s.db.stats.ops.length;
    const r = await s.referee.step(j.token, null, seq); seq = r.seq;
    const ops = s.db.stats.ops.slice(before).filter(o => o.path.indexOf('world/' + mapId) === 0);
    if (ops.some(o => o.type === 'put')) continue;                                    // (a whole rewrite: the minute's check)
    const mOps = ops.filter(o => o.path === 'world/' + mapId + '/m');
    if (mOps.length) { sawDelta = true; assert.ok(Object.keys(mOps[0].data).length < total, 'not the whole list'); }
    if (ops.some(o => o.path === 'world/' + mapId + '/d' && Object.keys(o.data).some(k => o.data[k] != null))) sawNoLooks = false;
    feed.feed(s.db);
    const truth = World.view(s.content, { maps: { [mapId]: mapRec(s.db, mapId) } }, mapId, playerRec(s.db, j.token), []).monsters;
    assert.deepStrictEqual(byId(feed.world().monsters), byId(truth), 'after step ' + i + ' the page holds exactly what the referee does');
  }
  assert.ok(sawDelta, 'monsters moved and were sent as changes');
  assert.ok(sawNoLooks, 'no monster\'s looks were sent a second time');
  assert.strictEqual(feed.world().monsters.length, total - 1, 'the dead one left the list');
  feed.stop();
  assert.strictEqual(page.api.liveMap, '');
});

test('an answer leaves the monsters out for a page that is receiving the push, and only then', async () => {
  const s = setup();
  const j = await s.referee.join('Ana', '');
  const r0 = await s.referee.step(j.token, null, -1), mapId = r0.player.map;
  const plain = await s.referee.step(j.token, null, r0.seq, undefined, { at: mapId });
  assert.ok(Array.isArray(plain.world.monsters) && plain.world.monsters.length, 'a page that says nothing gets the list');
  const live = await s.referee.step(j.token, null, plain.seq, undefined, { at: mapId, live: mapId });
  assert.ok(!('monsters' in live.world) && live.world.pushed === 1);
  assert.ok(JSON.stringify(live).length < JSON.stringify(plain).length, 'and it is a smaller answer');
  const other = await s.referee.step(j.token, null, live.seq, undefined, { at: mapId, live: 'map_0' });
  assert.ok(Array.isArray(other.world.monsters), 'listening to some other map does not count');
});

test('a step reads the characters on its own map, not every character there is', async () => {
  const s = setup();
  const a = await s.referee.join('Ana', ''), b = await s.referee.join('Ben', ''), far = await s.referee.join('Cai', '');
  const ra = await s.referee.step(a.token, null, -1), mapId = ra.player.map;
  await s.referee.step(b.token, null, -1);
  // Cai is on another map; Dee was made long ago and never came back
  const cai = playerRec(s.db, far.token); cai.map = 'map_0'; cai.x = 1; cai.y = 1; s.db.write('players/' + far.token, JSON.stringify(cai));
  await s.referee.step(far.token, null, -1);
  const idle = await s.referee.join('Dee', '');
  assert.deepStrictEqual(Object.keys(s.db.read('here/' + mapId)).sort(), [a.token, b.token].sort(), 'who is on the map');
  assert.deepStrictEqual(Object.keys(s.db.read('here/map_0')), [far.token]);
  s.db.stats.gets.length = 0;
  const r = await s.referee.step(a.token, null, ra.seq, undefined, { at: mapId });
  const read = s.db.stats.gets.filter(p => p.indexOf('players/') === 0).map(p => p.slice(8)).sort();
  assert.deepStrictEqual(read, [a.token, b.token].sort(), 'Ana\'s step read Ana and Ben only');
  assert.ok(!s.db.stats.gets.includes('players'), 'never the whole list');
  assert.ok(r.world.players.some(q => q.name === 'Ben'), 'and Ben is there for her');
  const benPushed = s.db.read('world/' + mapId).players.filter(q => q.name === 'Ben')[0], benAnswer = r.world.players.filter(q => q.name === 'Ben')[0];
  ['class', 'equipment', 'hair', 'hairColor'].forEach(k => assert.deepStrictEqual(benPushed[k], benAnswer[k], 'the push draws Ben as the answer does: ' + k));
  assert.ok(benPushed['class']);
  assert.ok(idle.token);
  // a wrong guess about the map costs a second look, not a wrong answer
  const r2 = await s.referee.step(a.token, null, r.seq, undefined, { at: 'map_0' });
  assert.ok(r2.world.players.some(q => q.name === 'Ben'));
  // someone gone for over a minute is not read; gone for a day, their entry is cleared away
  s.tick(61000);
  s.db.stats.gets.length = 0;
  await s.referee.step(a.token, null, r2.seq, undefined, { at: mapId });
  assert.deepStrictEqual(s.db.stats.gets.filter(p => p.indexOf('players/') === 0), ['players/' + a.token]);
  s.tick(86400000);
  await s.referee.step(a.token, null, -1, undefined, { at: mapId });
  assert.deepStrictEqual(Object.keys(s.db.read('here/' + mapId)), [a.token]);
});

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

test('floors: a shot at another floor runs on that floor\'s record, and word between floors is delivered', async () => {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(30).fill('til_1');
  const upper = Array.from({ length: 13 }, (_, y) => Array.from({ length: 30 }, (_, x) => (x >= 8 && x <= 10 && y >= 5 && y <= 7 ? 'til_1' : '')));
  t.Maps.push({ id: 'plot', name: 'Plot', width: 30, height: 13, terrain: JSON.stringify(Array(13).fill(row)), spawn: JSON.stringify({ x: 29, y: 12 }) });
  t.Maps.push({ id: 'plot_z1', name: 'Plot', width: 30, height: 13, terrain: JSON.stringify(upper), floor_of: 'plot', z: 1 });
  const content = Content.build(t), db = fakeDb();
  let now = 3000000;
  const referee = Referee.create({ db, World, getContent: async () => content, now: () => now, random: () => 0.5 });
  const j = await referee.join('Ana', '');
  const save = async (rec) => db.ref('players/' + j.token).set(JSON.stringify(rec));
  let rec = playerRec(db, j.token);
  Object.assign(rec, { map: 'plot', x: 9, y: 9, facing: 'N' });
  World.give(content, rec, 'pistol', 1, []); World.give(content, rec, 'ammo_pistol', 30, []); World.give(content, rec, 'wood', 20, []); World.give(content, rec, 'cloth', 10, []);
  rec.equipment = Object.assign({}, rec.equipment, { weapon: 'pistol' }); rec.mags = { pistol: 12 };
  await save(rec);
  now += 1000; await referee.step(j.token, null, -1);                       // the ground floor's record exists now
  const ref = Object.keys(content.monsters)[0];
  const ground = mapRec(db, 'plot');
  ground.monsters = (ground.monsters || []).concat([{ id: 'plot.m1', ref, x: 12, y: 6, hp: 9999, last: 9e12, facing: 'S', spawn: '' }]);
  await db.ref('state/maps/plot').set(JSON.stringify(ground));

  // a claim planted on the ground reaches the floor above as a shadow
  now += 1000;
  const built = await referee.step(j.token, { type: 'build', bp: 'bp_claim', x: 9, y: 8 }, 0);
  assert.ok(built.events.some(e => /claim flag/.test(e.text || '')), 'the flag went up: ' + built.events.map(e => e.text).join(' | '));
  const sh = (mapRec(db, 'plot_z1').struct || {}).shadow || {};
  assert.deepStrictEqual(Object.keys(sh).map(k => [sh[k].x, sh[k].y, sh[k].by]), [[9, 8, rec.id]], 'the upper floor\'s record got the claim\'s shadow');

  // what was built is pushed for whoever watches this floor from another one
  const pushed = db.read('world/s~plot/plot');
  assert.ok(pushed && pushed.rev > 0 && JSON.parse(pushed.json).ents.some(e => e.x === 9 && e.y === 8), 'the ground floor\'s built layer is published for the building');
  const setsBefore = db.stats.sets.filter(k => k.startsWith('world/s~')).length;
  now += 1000; await referee.step(j.token, null, 0);
  assert.strictEqual(db.stats.sets.filter(k => k.startsWith('world/s~')).length, setsBefore, 'and not written again while nothing changes');

  // upstairs, at the edge, shooting the monster on the ground outside
  rec = playerRec(db, j.token);
  Object.assign(rec, { map: 'plot_z1', x: 10, y: 6, facing: 'E' });
  await save(rec);
  now += 1000; await referee.step(j.token, null, -1);
  now += 1000;
  const r = await referee.step(j.token, { type: 'shoot', map: 'plot', x: 12, y: 6 }, 0);
  assert.ok(r.events.some(e => /You shoot the/.test(e.text || '')), 'the shooter is told: ' + r.events.map(e => e.text).join(' | '));
  assert.ok(mapRec(db, 'plot').monsters.find(m => m.id === 'plot.m1').hp < 9999, 'the monster in the OTHER floor\'s record took the hit');
  assert.strictEqual(r.player.map, 'plot_z1', 'the shooter stays where they are');
  assert.strictEqual(playerRec(db, j.token).mags.pistol, 11, 'and the round is spent');
  assert.strictEqual(r.world.map, 'plot_z1');

  // and dropping a grenade on it from up there
  rec = playerRec(db, j.token);
  World.give(content, rec, 'grenade', 2, []);
  await save(rec);
  const hpBefore = mapRec(db, 'plot').monsters.find(m => m.id === 'plot.m1').hp;
  now += 5000;
  const g = await referee.step(j.token, { type: 'throw', item: 'grenade', map: 'plot', x: 12, y: 6 }, 0);
  assert.ok(g.events.some(e => /grenade hits the/.test(e.text || '')), 'the thrower is told: ' + g.events.map(e => e.text).join(' | '));
  assert.ok(mapRec(db, 'plot').monsters.find(m => m.id === 'plot.m1').hp < hpBefore, 'the blast landed in the other floor\'s record');
  assert.strictEqual((playerRec(db, j.token).inventory.find(s => s.item === 'grenade') || {}).qty, 1, 'and one grenade is spent');

  // while they stand upstairs doing nothing, the ground floor (nobody on it) is still moved on
  const g2 = mapRec(db, 'plot');
  g2.monsters.push({ id: 'plot.m2', ref, x: 20, y: 10, hp: 5, last: now, facing: 'S', spawn: '' });
  await db.ref('state/maps/plot').set(JSON.stringify(g2));
  const was = now;
  now += 4000; await referee.step(j.token, null, 0);
  assert.ok(mapRec(db, 'plot').monsters.find(m => m.id === 'plot.m2').last > was, 'a heartbeat from upstairs moved the floor below');
});

(async () => {
  for (const t of queue) { await t.fn(); passed++; console.log('ok -', t.name); }
  console.log(`\n${passed} function tests passed`);
})().catch(err => { console.error(err); process.exit(1); });
