/**
 * Plays through the milestone 3 systems on the real Game Data.
 * Run: node tools/test_world.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Content = require('../shared/content.js');
const Rules = require('../shared/rules.js');
global.Rules = Rules;
const World = require('../shared/world.js');

const tables = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/tables.json'), 'utf8'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

// deterministic dice: cycles through these values
function dice(seq) { let i = 0; return () => seq[i++ % seq.length]; }
const mid = dice([0.5]);

function fresh() {
  const c = Content.build(tables);
  const ws = { maps: {} };
  const p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  return { c, ws, p };
}
function act(s, action, now, rng) { return World.act(s.c, s.ws, s.p, action, now || 1000, rng || mid, [s.p]); }
function texts(ev) { return ev.map(e => e.text).join(' | '); }
function put(s, map, x, y, facing) { s.p.map = map; s.p.x = x; s.p.y = y; s.p.facing = facing || 'S'; }

test('a new warrior starts at the start point with class stats and items', () => {
  const { c, p } = fresh();
  assert.deepStrictEqual([p.map, p.x, p.y], ['map_3', 9, 15]);
  const st = World.stats(c, p);
  assert.deepStrictEqual([p.hp, st.maxHp, st.atk, st.def], [120, 120, 6, 2]);
  assert.deepStrictEqual(p.inventory, [{ item: 'potion', qty: 2 }]);
});

test('the hut door is closed, opens on interact, and can then be walked through', () => {
  const s = fresh();
  act(s, { type: 'move', dirs: ['N', 'N', 'N', 'N', 'N', 'N'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [9, 10]);          // stopped by the closed door
  act(s, { type: 'interact' });
  act(s, { type: 'move', dirs: ['N', 'N'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [9, 8]);
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.strictEqual(v.states['map_3.e9'], 'open');
});

test('the hut chest gives its contents once per player, then is empty', () => {
  const s = fresh();
  put(s, 'map_3', 9, 7, 'E');
  let ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /You open the wooden chest/);
  assert.strictEqual(World.count(s.p, 'potion'), 4);
  assert.strictEqual(World.count(s.p, 'wooden_sword'), 1);
  ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /It is empty/);
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.strictEqual(v.states['map_3.e14'], 'empty');               // the chest shows as empty to this player
  // another player still finds it full
  const q = World.newPlayer(s.c, 'p2', 'Other', 'rogue'); q.map = 'map_3'; q.x = 9; q.y = 7; q.facing = 'E';
  World.act(s.c, s.ws, q, { type: 'interact' }, 1000, mid, [q]);
  assert.strictEqual(World.count(q, 'wooden_sword'), 1);
});

test('equipping a sword raises attack; using a potion heals and is consumed', () => {
  const s = fresh();
  World.give(s.c, s.p, 'wooden_sword', 1, []);
  act(s, { type: 'use', item: 'wooden_sword' });
  assert.strictEqual(World.stats(s.c, s.p).atk, 9);
  let ev = act(s, { type: 'use', item: 'potion' });
  assert.match(texts(ev), /already at full health/);
  s.p.hp = 50;
  ev = act(s, { type: 'use', item: 'potion' });
  assert.strictEqual(s.p.hp, 90);
  assert.strictEqual(World.count(s.p, 'potion'), 1);
  act(s, { type: 'use', item: 'wooden_sword' });      // unequip
  assert.strictEqual(World.stats(s.c, s.p).atk, 6);
});

test('resting at the record table heals and sets the respawn point', () => {
  const s = fresh();
  put(s, 'map_3', 10, 5, 'N'); s.p.hp = 10;
  const ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /You rest/);
  assert.strictEqual(s.p.hp, 120);
  assert.strictEqual(s.p.respawn, 'map_3:10:5');
});

test('slimes and rats spawn from the spawn markers within their radius', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const ms = World.mapState(s.ws, 'map_3').monsters;
  assert.strictEqual(ms.filter(m => m.ref === 'slime').length, 3);
  assert.strictEqual(ms.filter(m => m.ref === 'rat').length, 2);
  ms.filter(m => m.ref === 'slime').forEach(m => assert.ok(Math.abs(m.x - 4) <= 3 && Math.abs(m.y - 13) <= 3));
});

test('bumping into a monster attacks it; killing it gives XP, gold and loot', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const slime = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'slime');
  put(s, 'map_3', slime.x + 1, slime.y, 'W');
  let ev = [];
  for (let i = 0; i < 5 && !slime.dead; i++) ev = ev.concat(act(s, { type: 'move', dirs: ['W'] }, 1000 + i * 600, dice([0.0])));
  assert.ok(slime.dead, 'slime should be dead');
  assert.match(texts(ev), /You hit the slime/);
  assert.match(texts(ev), /The slime is defeated. \+6 XP/);
  assert.strictEqual(s.p.xp, 6);
  assert.ok(s.p.gold >= 1);
  assert.ok(World.count(s.p, 'slime_gel') >= 1);                 // dice 0.0 always passes the 60% roll
  assert.deepStrictEqual([s.p.x, s.p.y], [slime.x + 1, slime.y]); // attacking does not move you
});

test('adding a spawn point later adds its monsters; untouched monsters stay put', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const slime = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'slime');
  slime.x = 2; slime.y = 15;                                   // it wandered somewhere
  s.c.maps.map_3.entities.push({ key: 'map_3.new', x: 12, y: 14, ref: 'obj_8', data: { monster: 'skeleton', count: 2, radius: 1 } });
  delete s.c.maps.map_3._at;
  World.advance(s.c, s.ws, 'map_3', [s.p], 100, mid, []);
  const ms = World.mapState(s.ws, 'map_3').monsters;
  assert.strictEqual(ms.filter(m => m.ref === 'skeleton').length, 2);
  assert.deepStrictEqual([slime.x, slime.y], [2, 15]);
  assert.ok(ms.includes(slime));
});

test('dead monsters respawn after their delay', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const slime = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'slime');
  slime.dead = true; slime.respawnAt = 30000;
  World.advance(s.c, s.ws, 'map_3', [s.p], 29000, mid, []);
  assert.ok(slime.dead);
  World.advance(s.c, s.ws, 'map_3', [s.p], 30000, mid, []);
  assert.ok(!slime.dead); assert.strictEqual(slime.hp, 14);
});

test('monsters chase a nearby player and attack when next to them', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const rat = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'rat');
  World.mapState(s.ws, 'map_3').monsters.forEach(m => { if (m !== rat) m.dead = true, m.respawnAt = 1e12; });
  put(s, 'map_3', rat.x - 3, rat.y);
  const ev = [];
  for (let t = 600; t <= 6000; t += 600) World.advance(s.c, s.ws, 'map_3', [s.p], t, mid, ev);
  assert.strictEqual(Math.abs(rat.x - s.p.x) + Math.abs(rat.y - s.p.y), 1);
  assert.ok(s.p.hp < 120, 'the rat should have bitten');
  assert.match(texts(ev), /The rat hits you for \d+/);
});

test('dying sends you to your respawn point with full health and some gold lost', () => {
  const s = fresh();
  s.p.gold = 100; s.p.respawn = 'map_3:10:5'; s.p.hp = 1;
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const rat = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'rat');
  put(s, 'map_3', rat.x + 1, rat.y);
  if (!Rules.standable(s.c, s.c.maps.map_3, s.p.x, s.p.y)) put(s, 'map_3', rat.x, rat.y + 1);
  const ev = [];
  World.advance(s.c, s.ws, 'map_3', [s.p], 5000, mid, ev);
  assert.match(texts(ev), /You were defeated and lost 10 gold/);
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y, s.p.hp, s.p.gold], ['map_3', 10, 5, 120, 90]);
});

test('the cave door leads to the Arena and the arena gate leads back', () => {
  const s = fresh();
  put(s, 'map_3', 14, 11, 'N');
  let ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /You arrive at Arena/);
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['map_1', 7, 14]);
  s.p.facing = 'S';
  ev = act(s, { type: 'interact' });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['map_3', 14, 11]);
});

test('the arena chest is locked until you carry the iron key', () => {
  const s = fresh();
  put(s, 'map_1', 11, 3, 'N');
  let ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /It is locked. You need: Iron key/);
  World.give(s.c, s.p, 'iron_key', 1, []);
  ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /You unlock the chest with the iron key/);
  assert.strictEqual(World.count(s.p, 'iron_armor'), 1);
  assert.strictEqual(s.p.gold, 50);
});

test('timed spike traps go up and down every second and only hurt while up', () => {
  const s = fresh();
  const e = s.c.maps.map_1.entities.find(e => e.x === 5 && e.y === 1);   // obj_5: the "opposite" trap
  assert.strictEqual(e.ref, 'obj_5');
  // offset 1000: down during [0,1000), up during [1000,2000) of each 2 s cycle
  assert.strictEqual(World.liveState(s.c, e, 500), 'down');
  assert.strictEqual(World.liveState(s.c, e, 1500), 'up');
  const twin = s.c.maps.map_1.entities.find(e => e.x === 6 && e.y === 1 || e.ref === 'obj_6');
  assert.strictEqual(World.liveState(s.c, twin, 500), 'up');            // the neighbours take turns
  put(s, 'map_1', 4, 1, 'E');
  let ev = act(s, { type: 'move', dirs: ['E'] }, 2500);                  // step on while down: safe
  assert.deepStrictEqual([s.p.x, s.p.y, s.p.hp], [5, 1, 120]);
  ev = [];
  World.advance(s.c, s.ws, 'map_1', [s.p], 3200, mid, ev);              // it rises under you
  assert.strictEqual(s.p.hp, 110);
  assert.match(texts(ev), /spike trap \(opposite\) hits you for 10/);
  World.advance(s.c, s.ws, 'map_1', [s.p], 3800, mid, []);              // same up-phase: only once
  assert.strictEqual(s.p.hp, 110);
  World.advance(s.c, s.ws, 'map_1', [s.p], 5100, mid, []);              // next cycle: again
  assert.strictEqual(s.p.hp, 100);
});

test('step traps spring when stepped on, then re-arm', () => {
  const s = fresh();
  const map = s.c.maps.map_3;
  map.entities.push({ key: 'map_3.trap', x: 13, y: 2, ref: 'obj_6', data: { trigger: 'step' } });
  delete map._at;
  put(s, 'map_3', 12, 2, 'E');                                         // far from any monster spawn
  act(s, { type: 'move', dirs: ['E'] }, 1000);
  assert.strictEqual(s.p.hp, 110);
  act(s, { type: 'move', dirs: ['W', 'E'] }, 2000);
  assert.strictEqual(s.p.hp, 110);                                     // sprung (down)
  World.advance(s.c, s.ws, 'map_3', [], 6001, mid, []);                // re-armed after 5 s
  act(s, { type: 'move', dirs: ['W', 'E'] }, 7000);
  assert.strictEqual(s.p.hp, 100);
});

test('a lever opens the door it is linked to', () => {
  const s = fresh();
  const map = s.c.maps.map_3;
  map.entities.push({ key: 'map_3.lever', x: 12, y: 11, ref: 'obj_44', data: { targets: 'map_3.e9' } });
  delete map._at;
  put(s, 'map_3', 12, 12, 'N');
  act(s, { type: 'interact' });
  put(s, 'map_3', 9, 10);
  act(s, { type: 'move', dirs: ['N'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [9, 9]);                 // walked into the open doorway
});

test('levelling up raises stats and refills health', () => {
  const s = fresh();
  s.p.hp = 30;
  const ev = [];
  World.run(s.c, s.ws, s.p, 'xp:25', 0, ev);
  assert.strictEqual(s.p.level, 2);
  assert.deepStrictEqual([s.p.hp, World.stats(s.c, s.p).atk], [132, 8]);
  assert.match(texts(ev), /Level up/);
});

test('data actions and conditions work', () => {
  const s = fresh();
  const ev = [];
  World.run(s.c, s.ws, s.p, 'give:bone:3; gold:15; flag:met_mayor; message:Hello there', 0, ev);
  assert.ok(World.check(s.c, s.p, 'flag:met_mayor, has:bone:3, !flag:other, level:1'));
  assert.ok(!World.check(s.c, s.p, 'has:bone:4'));
  assert.strictEqual(s.p.gold, 15);
  assert.match(texts(ev), /Hello there/);
});

test('events: private ones go to their player only; public ones to the map', () => {
  const ws = {};
  World.record(ws, [{ type: 'hit', to: 'p1', map: 'm', text: 'a' }, { type: 'kill', map: 'm', text: 'b' }, { type: 'kill', map: 'x', text: 'c' }]);
  assert.deepStrictEqual(World.eventsFor(ws, 0, { id: 'p2', map: 'm' }).map(e => e.text), ['b']);
  assert.deepStrictEqual(World.eventsFor(ws, 0, { id: 'p1', map: 'm' }).map(e => e.text), ['a', 'b']);
  assert.deepStrictEqual(World.eventsFor(ws, 1, { id: 'p1', map: 'm' }).map(e => e.text), ['b']);
  assert.deepStrictEqual(World.eventsFor(ws, -1, { id: 'p1', map: 'm' }), []);
});

test('an old saved character (before milestone 3) is filled in', () => {
  const s = fresh();
  const old = { id: 'x', name: 'Old', map: 'map_3', x: '9', y: '12', facing: 'N', hp: '', level: '', xp: '' };
  World.normalize(s.c, old);
  assert.deepStrictEqual([old.class, old.hp, old.level, old.gold, old.x], ['warrior', 120, 1, 0, 9]);
  assert.deepStrictEqual(old.inventory, []);
});

test('client prediction agrees with the server about doors and monsters', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const map = s.c.maps.map_3;
  let v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.ok(!Rules.tryMove(s.c, map, 9, 10, 'N', World.viewOpts(s.c, map, v, s.p.id)).ok);
  World.mapState(s.ws, 'map_3').states['map_3.e9'] = 'open';
  v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.ok(Rules.tryMove(s.c, map, 9, 10, 'N', World.viewOpts(s.c, map, v, s.p.id)).ok);
  const m = v.monsters[0];
  const r = Rules.tryMove(s.c, map, m.x + 1, m.y, 'W', World.viewOpts(s.c, map, v, s.p.id));
  assert.strictEqual(r.reason, 'occupied');
});

// ---------------------------------------------------------------- skills (milestone 4)
function hero(cls, level) {
  const c = Content.build(tables), ws = { maps: {} };
  const p = World.newPlayer(c, 'p1', 'Caster', cls);
  if (level) { p.level = level; p.hp = World.stats(c, p).maxHp; p.mp = World.stats(c, p).maxMp; }
  World.advance(c, ws, 'map_3', [p], 0, mid, []);                 // spawns monsters
  const mons = World.mapState(ws, 'map_3').monsters;
  mons.forEach(m => { m.x = -10; m.y = -10; m.dead = true; m.respawnAt = 1e15; });   // clear the field
  return { c, ws, p, mons };
}
function monster(s, ref, x, y) {
  const m = s.mons.find(m => m.ref === ref && m.dead) || s.mons.find(m => m.dead);
  Object.assign(m, { ref, x, y, dead: false, hp: s.c.monsters[ref].hp, statuses: [], last: 0 });
  return m;
}
function cast(s, skill, x, y, now) { return World.act(s.c, s.ws, s.p, { type: 'cast', skill, x, y }, now || 1000, mid, [s.p]); }

test('each class starts with its skills, mana and a filled bar', () => {
  const c = Content.build(tables);
  const want = { warrior: ['charge', 'cleave'], rogue: ['throw_dagger', 'poison_strike'], mage: ['fireball', 'frost_bolt'],
    paladin: ['holy_strike', 'blessing'], priest: ['heal', 'smite'], barbarian: ['whirlwind', 'rage'] };
  Object.entries(want).forEach(([cls, skills]) => {
    const p = World.newPlayer(c, 'x', 'X', cls);
    assert.deepStrictEqual(World.knownSkills(c, p), skills, cls);
    assert.deepStrictEqual(p.loadout.slice(0, 2), skills.map(k => 'skill:' + k), cls);
    assert.ok(p.loadout.includes('item:potion'), cls + ' has a potion on the bar');
    assert.strictEqual(p.mp, World.stats(c, p).maxMp);
  });
});

test('fireball: costs mana, hits the target and its neighbours, burns, and has a cooldown', () => {
  const s = hero('mage');
  const a = monster(s, 'slime', 9, 11), b = monster(s, 'rat', 10, 11);
  s.p.x = 9; s.p.y = 15;
  const ev = cast(s, 'fireball', 9, 11);
  assert.strictEqual(s.p.mp, 60);
  assert.strictEqual(a.hp, 14 - 13);                                   // 10 + 3 x level 1, no defence
  assert.ok(b.dead || b.hp < 9, 'the rat next to it is hit too');
  assert.ok(a.statuses.some(st => st.id === 'burn'));
  assert.ok(ev.some(e => e.type === 'cast' && e.skill === 'fireball'));
  assert.match(texts(cast(s, 'fireball', 9, 11, 1500)), /Fireball is not ready yet/);
  const ev2 = [];
  World.advance(s.c, s.ws, 'map_3', [s.p], 2100, mid, ev2);            // the burn ticks and finishes the slime
  assert.ok(a.dead);
  assert.match(texts(ev2), /The slime is defeated/);
  assert.strictEqual(s.p.xp >= 6, true);
});

test('walls and trees block skills; open space does not; range is limited', () => {
  const s = hero('mage');
  monster(s, 'slime', 5, 7);                                           // inside the hut
  s.p.x = 5; s.p.y = 11;
  assert.match(texts(cast(s, 'frost_bolt', 5, 7)), /Something is in the way/);   // the hut wall
  monster(s, 'rat', 1, 10);
  s.p.x = 1; s.p.y = 14;                                               // tree trunks at (1,12) and (0,13)
  assert.match(texts(cast(s, 'frost_bolt', 1, 10)), /Something is in the way/);
  monster(s, 'bat', 12, 12);
  s.p.x = 12; s.p.y = 4;
  assert.match(texts(cast(s, 'frost_bolt', 12, 12)), /Out of range/);
  s.p.y = 6;
  assert.doesNotMatch(texts(cast(s, 'frost_bolt', 12, 12)), /way|range/);
  assert.strictEqual(s.p.mp, 64);
});

test('the aiming preview (client) agrees with the server', () => {
  const s = hero('mage');
  const m = monster(s, 'slime', 5, 7);
  s.p.x = 5; s.p.y = 11;
  const map = s.c.maps.map_3, sk = s.c.skills.frost_bolt;
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  const lk = World.viewLookup(s.c, map, v, s.p);
  assert.strictEqual(World.checkTarget(s.c, map, s.p, sk, 5, 7, lk).reason, 'Something is in the way.');
  World.mapState(s.ws, 'map_3').states['map_3.e9'] = 'open';          // open the hut door: still the wall at x=5
  m.x = 9; m.y = 7; s.p.x = 9; s.p.y = 12;                             // straight through the open doorway
  const v2 = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.ok(World.checkTarget(s.c, map, s.p, sk, 9, 7, World.viewLookup(s.c, map, v2, s.p)).ok);
  assert.doesNotMatch(texts(cast(s, 'frost_bolt', 9, 7)), /way|range/);
});

test('an enemy skill aimed one tile off still finds the monster (it moved while you aimed)', () => {
  const s = hero('mage');
  const m = monster(s, 'slime', 6, 13);
  s.p.x = 9; s.p.y = 13;
  cast(s, 'frost_bolt', 5, 13);                                        // aimed where it was a moment ago
  assert.ok(m.hp < 14 && m.statuses.some(st => st.id === 'chill'));
  assert.match(texts(cast(s, 'frost_bolt', 3, 13, 5000)), /No enemy there/);   // two tiles off: a miss
});

test('frost bolt chills: the monster moves half as often', () => {
  const s = hero('mage');
  const m = monster(s, 'rat', 14, 13);
  s.p.x = 9; s.p.y = 13;
  cast(s, 'frost_bolt', 14, 13, 0);
  assert.ok(m.statuses.some(st => st.id === 'chill'));
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.deepStrictEqual(v.monsters.find(x => x.id === m.id).statuses, ['chill']);
  m.last = 0;
  World.advance(s.c, s.ws, 'map_3', [s.p], 1199, mid, []);            // rat: 600 ms a step, chilled 1200
  assert.deepStrictEqual([m.x, m.y], [14, 13]);
  World.advance(s.c, s.ws, 'map_3', [s.p], 1200, mid, []);
  assert.deepStrictEqual([m.x, m.y], [13, 13]);
});

test('charge dashes next to the enemy, hits and stuns it', () => {
  const s = hero('warrior');
  const m = monster(s, 'skeleton', 13, 13);
  s.p.x = 9; s.p.y = 13;
  cast(s, 'charge', 13, 13, 0);
  assert.deepStrictEqual([s.p.x, s.p.y], [12, 13]);
  assert.ok(m.statuses.some(st => st.id === 'stun'));
  const hp = s.p.hp;
  World.advance(s.c, s.ws, 'map_3', [s.p], 1100, mid, []);            // stunned: no bite
  assert.strictEqual(s.p.hp, hp);
});

test('whirlwind and cleave hit everything next to you', () => {
  const s = hero('barbarian');
  const a = monster(s, 'slime', 8, 5), b = monster(s, 'rat', 10, 6), far = monster(s, 'slime', 12, 5);
  s.p.x = 9; s.p.y = 5;
  cast(s, 'whirlwind', 0, 0);
  assert.ok(a.hp < 14 && (b.dead || b.hp < 9));
  assert.strictEqual(far.hp, 14);
});

test('rage raises attack for 8 seconds, then wears off', () => {
  const s = hero('barbarian');
  const atk = World.stats(s.c, s.p).atk;
  cast(s, 'rage', 0, 0, 1000);
  assert.strictEqual(World.stats(s.c, s.p).atk, atk + 6);
  World.advance(s.c, s.ws, 'map_3', [s.p], 9001, mid, []);
  assert.strictEqual(World.stats(s.c, s.p).atk, atk);
});

test('heal and renew work on yourself; healing empty ground does nothing', () => {
  const s = hero('priest');
  s.p.x = 9; s.p.y = 14; s.p.hp = 20;
  assert.match(texts(cast(s, 'heal', 10, 14)), /No ally there/);
  cast(s, 'heal', 9, 14, 1000);
  assert.strictEqual(s.p.hp, 56);                                      // 30 + 6 x level 1
  s.p.level = 3; s.p.hp = 20;
  cast(s, 'renew', 9, 14, 5000);
  World.advance(s.c, s.ws, 'map_3', [s.p], 5000, mid, []);
  World.advance(s.c, s.ws, 'map_3', [s.p], 8000, mid, []);
  assert.strictEqual(s.p.hp, 35);                                      // 3 ticks of 5
});

test('leap (level 3) lands on a free spot and stuns enemies around it', () => {
  const s = hero('barbarian', 3);
  const m = monster(s, 'slime', 13, 14);
  s.p.x = 9; s.p.y = 13;
  assert.match(texts(cast(s, 'leap', 13, 14)), /cannot land/);
  cast(s, 'leap', 12, 13, 1000);
  assert.deepStrictEqual([s.p.x, s.p.y], [12, 13]);
  assert.ok(m.statuses.some(st => st.id === 'stun') && m.hp < 14);
});

test('mana comes back over time; mana potions restore it', () => {
  const s = hero('mage');
  s.p.mp = 10;
  World.advance(s.c, s.ws, 'map_3', [s.p], 1000, mid, []);
  World.advance(s.c, s.ws, 'map_3', [s.p], 11000, mid, []);
  assert.strictEqual(Math.round(s.p.mp), 40);                          // 3 per second
  World.act(s.c, s.ws, s.p, { type: 'use', item: 'mana_potion' }, 11000, mid, [s.p]);
  assert.strictEqual(Math.round(s.p.mp), 70);
});

test('reaching level 3 teaches the third skill and puts it on the bar; the bar can be rearranged', () => {
  const s = hero('mage');
  const ev = [];
  World.run(s.c, s.ws, s.p, 'xp:60', 0, ev);
  assert.strictEqual(s.p.level, 3);
  assert.match(texts(ev), /You learned Frost nova/);
  assert.ok(s.p.loadout.includes('skill:frost_nova'));
  World.act(s.c, s.ws, s.p, { type: 'loadout', slot: 0, entry: 'item:potion' }, 0, mid, [s.p]);
  assert.strictEqual(s.p.loadout[0], 'item:potion');
  assert.ok(s.p.loadout.includes('skill:fireball'), 'swapped, not lost');
  assert.match(texts(World.act(s.c, s.ws, s.p, { type: 'loadout', slot: 1, entry: 'skill:heal' }, 0, mid, [s.p])), /can't go on the bar/);
});

// ---------------------------------------------------------------- mouse interactions
test('basic attacks have a delay: spamming does not attack faster', () => {
  const s = hero('warrior');
  const m = monster(s, 'skeleton', 10, 13);
  s.p.x = 9; s.p.y = 13;
  act(s, { type: 'attack', x: 10, y: 13 }, 1000);
  const hp = m.hp;
  act(s, { type: 'attack', x: 10, y: 13 }, 1200);                      // too soon
  assert.strictEqual(m.hp, hp);
  act(s, { type: 'attack', x: 10, y: 13 }, 1500);
  assert.ok(m.hp < hp);
  assert.match(texts(act(s, { type: 'attack', x: 12, y: 13 }, 3000)), /Nothing to attack/);
  m.x = 11;
  assert.match(texts(act(s, { type: 'attack', x: 11, y: 13 }, 3000)), /Too far away/);
});

test('clicking a chest next to you opens it, wherever you face; far away it does nothing', () => {
  const s = fresh();
  put(s, 'map_3', 10, 6, 'N');                                         // chest is at (10, 7): south
  assert.match(texts(act(s, { type: 'interact', x: 10, y: 9 })), /Too far away/);
  const ev = act(s, { type: 'interact', x: 10, y: 7 });
  assert.match(texts(ev), /You open the wooden chest/);
  assert.strictEqual(s.p.facing, 'S');
});

test('locked door: message without a key; lockpick from the menu; rogues are better at it', () => {
  const s = fresh();
  put(s, 'map_2', 14, 7, 'W');                                         // locked storeroom door just north, at (14, 6)
  let ev = act(s, { type: 'interact', x: 14, y: 6 });
  assert.match(texts(ev), /^It is locked\.$/);
  ev = act(s, { type: 'interact', x: 14, y: 6, verb: 'picklock' });
  assert.match(texts(ev), /You need a lockpick/);
  World.give(s.c, s.p, 'lockpick', 2, []);
  assert.match(texts(act(s, { type: 'interact', x: 14, y: 6 })), /Right-click to pick the lock/);
  ev = act(s, { type: 'interact', x: 14, y: 6, verb: 'picklock' }, 1000, dice([0.9, 0.1]));   // fail, and it breaks
  assert.match(texts(ev), /lockpick breaks/);
  assert.strictEqual(World.count(s.p, 'lockpick'), 1);
  ev = act(s, { type: 'interact', x: 14, y: 6, verb: 'picklock' }, 1000, dice([0.1]));        // success
  assert.match(texts(ev), /You pick the lock/);
  act(s, { type: 'interact', x: 14, y: 6 });                           // now a normal click opens it
  act(s, { type: 'move', dirs: ['N'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [14, 6]);
  // success chances: base 0.5 - difficulty 0.1; rogue +0.3
  const map = s.c.maps.map_2, door = map.entities.find(e => e.x === 14 && e.y === 6);
  const lk = { stateOf: () => 'locked', monsterAt: () => null, free: () => false };
  const warrior = World.newPlayer(s.c, 'w', 'W', 'warrior'), rogue = World.newPlayer(s.c, 'r', 'R', 'rogue');
  World.give(s.c, warrior, 'lockpick', 1, []);
  assert.match(World.actionsAt(s.c, map, lk, warrior, 14, 6)[1].label, /Pick the lock \(40%\)/);
  assert.match(World.actionsAt(s.c, map, lk, rogue, 14, 6)[1].label, /Pick the lock \(70%\)/);
});

test('action list: default first, for monsters, chests, keys, signs and empty ground', () => {
  const s = hero('warrior');
  monster(s, 'slime', 5, 13);
  s.p.x = 9; s.p.y = 13;
  const map = s.c.maps.map_3, v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]), lk = World.viewLookup(s.c, map, v, s.p);
  const labels = (x, y) => World.actionsAt(s.c, map, lk, s.p, x, y).map(a => a.label);
  assert.deepStrictEqual(labels(5, 13), ['Attack the slime']);
  assert.deepStrictEqual(labels(10, 7), ['Open the wooden chest']);
  assert.deepStrictEqual(labels(8, 11), ['Read the sign', 'Walk here'].slice(0, 1));
  assert.deepStrictEqual(labels(9, 9), ['Open the wooden door']);
  assert.deepStrictEqual(labels(12, 12), ['Walk here']);
  const arena = s.c.maps.map_1, lk1 = World.viewLookup(s.c, arena, { states: {}, monsters: [], players: [] }, s.p);
  assert.deepStrictEqual(World.actionsAt(s.c, arena, lk1, s.p, 11, 2).map(a => a.label), ['Locked: needs Iron key']);
  World.give(s.c, s.p, 'iron_key', 1, []);
  assert.deepStrictEqual(World.actionsAt(s.c, arena, lk1, s.p, 11, 2).map(a => a.label), ['Unlock the chest (Iron key)']);
});

// ---------------------------------------------------------------- survival (M-Zombie Z1)
test('hunger and thirst drain over time; eating and drinking restore them', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);                 // sets the clock, no decay yet
  World.advance(s.c, s.ws, 'map_3', [s.p], 60000, mid, []);            // one minute later
  assert.ok(Math.abs(s.p.hunger - 99.4) < 1e-6, 'hunger 0.6/min');     // 100 - 0.6
  assert.ok(Math.abs(s.p.thirst - 99.1) < 1e-6, 'thirst 0.9/min');     // 100 - 0.9
  s.p.hunger = 20; World.give(s.c, s.p, 'ration', 1, []);
  act(s, { type: 'use', item: 'ration' });
  assert.strictEqual(s.p.hunger, 80);                                   // +60
  s.p.thirst = 10; World.give(s.c, s.p, 'water', 1, []);
  act(s, { type: 'use', item: 'water' });
  assert.strictEqual(s.p.thirst, 70);                                   // +60
  s.p.hunger = 100; World.give(s.c, s.p, 'ration', 1, []);
  assert.match(texts(act(s, { type: 'use', item: 'ration' })), /not hungry/);
});

test('an empty stomach gnaws at your health', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 60000, mid, []);            // clock now at 60 s
  s.p.hunger = 0; s.p.nextStarve = 0;
  const hp0 = s.p.hp;
  World.advance(s.c, s.ws, 'map_3', [s.p], 66000, mid, []);            // schedules the first tick
  assert.strictEqual(s.p.hp, hp0);
  const ev = [];
  World.advance(s.c, s.ws, 'map_3', [s.p], 72000, mid, ev);            // 6 s later it bites
  assert.strictEqual(s.p.hp, hp0 - 3);
  assert.match(texts(ev), /Starving, you lose 3/);
});

test('equipping a gun grants its shot and spends ammo; the shot vanishes when unequipped', () => {
  const s = hero('survivor');
  const m = monster(s, 'skeleton', 12, 13);
  s.p.x = 9; s.p.y = 13;
  assert.match(texts(cast(s, 'gunshot', 12, 13, 0)), /don't know that skill/);   // not equipped yet
  act(s, { type: 'use', item: 'pistol' });                                        // equip -> grants gunshot
  assert.ok(World.publicPlayer(s.c, s.p).skills.includes('gunshot'));
  assert.ok(s.p.loadout.includes('skill:gunshot'), 'auto-added to the bar');
  const ammo0 = World.count(s.p, 'ammo');
  cast(s, 'gunshot', 12, 13, 1000);
  assert.strictEqual(World.count(s.p, 'ammo'), ammo0 - 1);
  assert.ok(m.hp < 32, 'the shot connected');
  s.p.inventory = s.p.inventory.filter(x => x.item !== 'ammo');                   // run dry
  assert.match(texts(cast(s, 'gunshot', 12, 13, 2500)), /Out of ammo/);
  act(s, { type: 'use', item: 'pistol' });                                        // unequip
  assert.ok(!s.p.loadout.includes('skill:gunshot'));
  assert.match(texts(cast(s, 'gunshot', 12, 13, 4000)), /don't know that skill/);
});

test('equipping a gun is gated by level, but firing it is not', () => {
  const s = hero('survivor');
  assert.match(texts(act(s, { type: 'use', item: 'rifle' })), /Requires level 3/);
  assert.strictEqual(s.p.equipment.weapon, undefined);
  s.p.level = 3;
  assert.match(texts(act(s, { type: 'use', item: 'rifle' })), /You equip the rifle/);
  assert.strictEqual(s.p.equipment.weapon, 'rifle');
  assert.ok(s.p.loadout.includes('skill:rifle_shot'));                            // usable immediately, no skill level gate
});

test('a spitter attacks from range with line of sight, but walls stop it', () => {
  const s = hero('warrior');
  const m = monster(s, 'spitter', 13, 13); m.last = 0; m.nextShot = 0;
  s.p.x = 10; s.p.y = 13; s.p.hp = 120;                                 // three tiles away, clear line
  const ev = [];
  World.advance(s.c, s.ws, 'map_3', [s.p], 1000, mid, ev);
  assert.ok(s.p.hp < 120, 'hit from range');
  assert.match(texts(ev), /spits at you/);
  assert.ok(ev.some(e => e.type === 'cast' && e.skill === '_ranged'));
  const s2 = hero('warrior');
  const m2 = monster(s2, 'spitter', 5, 7); m2.last = 0; m2.nextShot = 0;   // inside the hut
  s2.p.x = 5; s2.p.y = 11; s2.p.hp = 120;                              // the hut wall is between them
  World.advance(s2.c, s2.ws, 'map_3', [s2.p], 1000, mid, []);
  assert.strictEqual(s2.p.hp, 120, 'the wall blocks the spit');
});

test('a walker bite can infect; infection worsens each tick until an antidote cures it', () => {
  const s = hero('warrior');
  const m = monster(s, 'walker', 10, 13); m.last = 0;                  // infect_chance 0.5
  s.p.x = 9; s.p.y = 13; s.p.hp = 120;
  const ev = [];
  World.advance(s.c, s.ws, 'map_3', [s.p], 1200, dice([0.2]), ev);     // 0.2 < 0.5 -> infected
  assert.match(texts(ev), /infected/i);
  assert.ok(s.p.statuses.some(st => st.id === 'infection'));
  m.dead = true; m.respawnAt = 1e15;                                   // remove the walker to isolate the infection
  const hpA = s.p.hp;
  World.advance(s.c, s.ws, 'map_3', [s.p], 4200, mid, []);             // first tick: 2 damage
  assert.strictEqual(s.p.hp, hpA - 2);
  World.advance(s.c, s.ws, 'map_3', [s.p], 7200, mid, []);             // worse: 3 damage
  assert.strictEqual(s.p.hp, hpA - 5);
  assert.ok(s.p.statuses.some(st => st.id === 'infection'), 'never fades on its own');
  World.give(s.c, s.p, 'antidote', 1, []);
  assert.match(texts(act(s, { type: 'use', item: 'antidote' }, 7200)), /infection fades/);
  assert.ok(!s.p.statuses.some(st => st.id === 'infection'), 'cured');
});

console.log(`\n${passed} world tests passed`);
