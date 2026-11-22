/**
 * Plays through the milestone 3 systems on the real Game Data.
 * Run: node tools/test_world.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const Content = require('../shared/content.js');
const Rules = require('../shared/rules.js');
const Autotile = require('../shared/autotile.js');
global.Rules = Rules;
const World = require('../shared/world.js');

const tables = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/tables.json'), 'utf8'));
// These tests replay many moves at one frozen instant; the referee's walking-speed limit would (rightly) refuse
// that, so it is switched off here and tested on its own further down.
tables.Config = tables.Config.filter(r => r.key !== 'move_burst').concat([{ key: 'move_burst', value: 9999 }]);
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
  // the warrior auto-equips the weapon/armor/helm in its start kit (wooden_sword +3 atk, leather_armor +2 def, army_helmet +2 def)
  assert.deepStrictEqual([p.hp, st.maxHp, st.atk, st.def], [120, 120, 9, 6]);
  assert.deepStrictEqual(p.inventory, [{ item: 'potion', qty: 2 }, { item: 'wooden_sword', qty: 1 }, { item: 'leather_armor', qty: 1 }, { item: 'army_helmet', qty: 1 }]);
  assert.deepStrictEqual(p.equipment, { weapon: 'wooden_sword', armor: 'leather_armor', helm: 'army_helmet' });
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
  assert.strictEqual(World.count(s.p, 'wooden_sword'), 2);          // one from the warrior's start kit + one from the chest
  ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /It is empty/);
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.strictEqual(v.states['map_3.e14'], 'empty');               // the chest shows as empty to this player
  // another player still finds it full
  const q = World.newPlayer(s.c, 'p2', 'Other', 'rogue'); q.map = 'map_3'; q.x = 9; q.y = 7; q.facing = 'E';
  World.act(s.c, s.ws, q, { type: 'interact' }, 1000, mid, [q]);
  assert.strictEqual(World.count(q, 'wooden_sword'), 1);
});

test('a container with several weighted loot tables picks one per open, by weight', () => {
  // zero-weight tables are never picked; a single positive weight is always picked
  assert.strictEqual(World.pickLootTable({ loot: [{ table: 'a', weight: 0 }, { table: 'b', weight: 1 }] }, dice([0.5])), 'b');
  assert.strictEqual(World.pickLootTable({ loot: [{ table: 'a', weight: 1 }, { table: 'b', weight: 0 }] }, dice([0.5])), 'a');
  // weight splits the 0..1 roll: 1:3 → first table below 0.25, second above
  const two = [{ table: 'a', weight: 1 }, { table: 'b', weight: 3 }];
  assert.strictEqual(World.pickLootTable({ loot: two }, dice([0.1])), 'a');
  assert.strictEqual(World.pickLootTable({ loot: two }, dice([0.9])), 'b');
  // a JSON-string list (as stored in object properties) is parsed; all-zero weights fall back to the first
  assert.strictEqual(World.pickLootTable({ loot: '[{"table":"x","weight":2}]' }, dice([0.5])), 'x');
  assert.strictEqual(World.pickLootTable({ loot: [{ table: 'a', weight: 0 }, { table: 'b', weight: 0 }] }, dice([0.5])), 'a');
  // no list: the legacy single loot_table still wins
  assert.strictEqual(World.pickLootTable({ loot_table: 'legacy' }, dice([0.5])), 'legacy');
  assert.strictEqual(World.pickLootTable({ loot: [], loot_table: 'legacy' }, dice([0.5])), 'legacy');
});

test('a paper-doll monster rolls a random layered look from its appearance set', () => {
  const { c } = fresh();
  // the walker references the seeded zombie_plain set (parsed into a weighted list of one)
  assert.deepStrictEqual(c.monsters.walker.appearance, [{ set: 'zombie_plain', weight: 1 }]);
  const set = c.appearances.zombie_plain;
  assert.ok(set && set.layers.length >= 2, 'zombie_plain has layers');
  // a roll yields layers in draw order, body first, with a path on each; tints map to Tint ramp names
  const look = World.rollLook(c, c.monsters.walker, dice([0.5]));
  assert.ok(Array.isArray(look) && look.length, 'rolled a look');
  assert.match(look[0].path, /body_zombie/, 'body layer first');
  look.forEach(l => assert.ok(l.path, 'every layer has a sprite path'));
  // a monster with no appearance rolls nothing (keeps its flat sprite)
  assert.strictEqual(World.rollLook(c, c.monsters.slime, dice([0.5])), null);
  // an always-empty layer is skipped; a single-option layer is deterministic
  const toy = { appearance: [{ set: 'toy', weight: 1 }] };
  const c2 = { appearances: { toy: { layers: [
    { name: 'body', empty: 0, options: [{ sprite: 'b.png', weight: 1 }], tints: [] },
    { name: 'hat', empty: 1, options: [], tints: [] },                       // nothing to pick -> skipped
    { name: 'coat', empty: 0, options: [{ sprite: 'c.png', weight: 1 }], tints: [{ tint: 'navy', weight: 1 }] }
  ] } } };
  assert.deepStrictEqual(World.rollLook(c2, toy, dice([0.5])),
    [{ path: 'b.png', tint: '' }, { path: 'c.png', tint: 'navy' }]);
});

test('a monster can list several appearance sets; one is picked per spawn by weight', () => {
  // the content layer: "male:1, female:3" parses into a weighted list
  const c = Content.build({ Appearances: [
    { id: 'male', name: 'M', layers: JSON.stringify([{ name: 'body', empty: 0, options: [{ sprite: 'bm.png', weight: 1 }], tints: [] }]) },
    { id: 'female', name: 'F', layers: JSON.stringify([{ name: 'body', empty: 0, options: [{ sprite: 'bf.png', weight: 1 }], tints: [] }]) }
  ], Monsters: [{ id: 'walker2', name: 'W', appearance: 'male:1, female:3' }] });
  assert.deepStrictEqual(c.monsters.walker2.appearance, [{ set: 'male', weight: 1 }, { set: 'female', weight: 3 }]);
  // the 1:3 split puts the male set below 0.25 of the roll, the female set above it
  assert.strictEqual(World.rollLook(c, c.monsters.walker2, dice([0.1]))[0].path, 'bm.png');
  assert.strictEqual(World.rollLook(c, c.monsters.walker2, dice([0.9]))[0].path, 'bf.png');
  // a single set (the common case) is always used, whatever the roll
  const one = Content.build({ Appearances: [{ id: 'z', name: 'z', layers: JSON.stringify([{ name: 'body', empty: 0, options: [{ sprite: 'bz.png', weight: 1 }], tints: [] }]) }],
    Monsters: [{ id: 'm', name: 'M', appearance: 'z' }] });
  assert.strictEqual(World.rollLook(one, one.monsters.m, dice([0.99]))[0].path, 'bz.png');
});

test('equipping a sword raises attack; using a potion heals and is consumed', () => {
  const s = fresh();
  // the warrior auto-equips its starting sword (atk 9); toggle it off and on to exercise equip/unequip
  assert.strictEqual(World.stats(s.c, s.p).atk, 9);
  act(s, { type: 'use', item: 'wooden_sword' });      // unequip
  assert.strictEqual(World.stats(s.c, s.p).atk, 6);
  act(s, { type: 'use', item: 'wooden_sword' });      // equip again
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

test('walking into a monster does not attack it; an attack does, and killing it gives XP, gold and loot', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  const slime = World.mapState(s.ws, 'map_3').monsters.find(m => m.ref === 'slime');
  put(s, 'map_3', slime.x + 1, slime.y, 'W');
  const hp0 = slime.hp;
  let ev = act(s, { type: 'move', dirs: ['W'] }, 400, dice([0.0]));
  assert.doesNotMatch(texts(ev), /You hit/);                       // a bump is not an attack
  assert.deepStrictEqual([slime.hp, s.p.x], [hp0, slime.x + 1]);
  assert.match(texts(act(s, { type: 'interact' }, 500, dice([0.0]))), /Hold right-click to aim/);   // nor is F / a plain click
  assert.strictEqual(slime.hp, hp0);
  for (let i = 0; i < 5 && !slime.dead; i++) ev = ev.concat(act(s, { type: 'attack', x: slime.x, y: slime.y }, 1000 + i * 600, dice([0.0])));
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
  ev = [];
  World.advance(s.c, s.ws, 'map_1', [s.p], 5100, mid, ev);              // next cycle: again
  assert.strictEqual(ev.filter(e => /spike trap/.test(e.text || '')).length, 1);   // (a bat cutting corners may have arrived by now too, so count the trap's own hit)
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
  assert.deepStrictEqual([s.p.hp, World.stats(s.c, s.p).atk], [132, 11]);   // level-2 base atk 8 + auto-equipped sword +3
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
// A 4x1 floor with a solid vertical wall between cell 0 and cell 1, plus a slime standing at (1,0).
// Used to check that walls stop melee and thrown attacks (collision already stops movement).
function wallArena() {
  const s = hero('warrior'), c = s.c;
  const floor = Object.keys(c.terrain).find(id => { const t = c.terrain[id]; return t.pass.n && t.pass.e && t.pass.s && t.pass.w; });
  const wallId = Object.keys(c.wallStyles).find(id => c.wallStyles[id].blocksMove !== false && c.wallStyles[id].blocksSight !== false);
  assert.ok(floor && wallId, 'need a passable terrain and a solid wall style in the data');
  c.maps.arena = { id: 'arena', name: 'Arena', width: 4, height: 1,
    terrain: [[floor, floor, floor, floor]], overlay: [],
    vWalls: [['', wallId + ':2', '', '', '']], hWalls: [], shapes: {}, overlayShapes: {}, entities: [] };
  const slime = { ref: 'slime', id: 'slime#0', x: 1, y: 0, dead: false, hp: c.monsters.slime.hp, statuses: [], last: 0 };
  const ms = World.mapState(s.ws, 'arena');
  ms.monsters = [slime];
  ms.spawnSig = '';                 // the arena has no spawners; match the empty signature so advance() keeps our slime
  return { s, slime };
}

test('each class starts with its abilities on Q/E, a potion on the belt, and full mana', () => {
  const c = Content.build(tables);
  const want = { warrior: ['charge', 'cleave'], rogue: ['throw_dagger', 'poison_strike'], mage: ['fireball', 'frost_bolt'],
    paladin: ['holy_strike', 'blessing'], priest: ['heal', 'smite'], barbarian: ['whirlwind', 'rage'] };
  Object.entries(want).forEach(([cls, skills]) => {
    const p = World.newPlayer(c, 'x', 'X', cls);
    assert.deepStrictEqual(World.knownSkills(c, p), skills, cls);
    assert.deepStrictEqual(p.abilities.slice(0, 2), skills, cls);        // first two known skills on Q and E
    assert.ok(p.belt.includes('potion'), cls + ' has a potion on the belt');
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

test('reaching level 3 teaches the third skill; the ability bar (Q/E) holds two and can be rearranged', () => {
  const s = hero('mage');
  const quiet = [], q = hero('mage');
  World.run(q.c, q.ws, q.p, 'xp:60', 0, quiet);
  assert.doesNotMatch(texts(quiet), /You learned/);                           // skills are switched off: nothing is said about them
  s.c.config.skills = 'on';
  const ev = [];
  World.run(s.c, s.ws, s.p, 'xp:60', 0, ev);
  assert.strictEqual(s.p.level, 3);
  assert.match(texts(ev), /You learned Frost nova/);
  assert.ok(World.knownSkills(s.c, s.p).includes('frost_nova'));
  assert.deepStrictEqual(s.p.abilities, ['fireball', 'frost_bolt']);          // two slots, the first two known
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'ability', slot: 0, entry: 'frost_nova' }, 0, mid, [s.p]);
  assert.strictEqual(s.p.abilities[0], 'frost_nova');                         // the new skill now on Q
  assert.match(texts(World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'ability', slot: 1, entry: 'heal' }, 0, mid, [s.p])), /can't use that skill/);
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 0, entry: 'potion' }, 0, mid, [s.p]);
  assert.strictEqual(s.p.belt[0], 'potion');                                  // consumables go on the belt
  // the belt is ten slots; a character saved with five grows, keeping what was on it
  assert.strictEqual(World.BELT_SIZE, 10);
  s.p.belt = ['potion', '', '', '', ''];
  World.normalize(s.c, s.p);
  assert.deepStrictEqual(s.p.belt, ['potion', '', '', '', '', '', '', '', '', '']);
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 9, entry: 'potion' }, 0, mid, [s.p]);
  assert.strictEqual(s.p.belt[9], 'potion');
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 10, entry: 'potion' }, 0, mid, [s.p]);
  assert.strictEqual(s.p.belt.length, 10);                                    // no eleventh slot
});

test('the belt slot you hold decides the weapon; holding food puts the weapon away and eats nothing until used', () => {
  const s = hero('survivor', 3), p = s.p, act = a => World.act(s.c, s.ws, p, a, 0, mid, [p]);
  const at = id => p.belt.indexOf(id);
  ['pistol', 'rifle', 'grenade', 'bandage'].forEach(id => assert.ok(at(id) >= 0, id + ' starts on the belt'));
  assert.strictEqual(p.held, at('pistol'));                                   // the pistol they spawn with is in hand
  assert.strictEqual(p.equipment.weapon, 'pistol');
  act({ type: 'hold', slot: at('rifle') });
  assert.strictEqual(p.equipment.weapon, 'rifle');
  assert.strictEqual(World.rangedWeapon(s.c, p).id, 'rifle');
  assert.ok(p.mags.rifle > 0, 'a freshly drawn gun is loaded');
  const rations = World.count(p, 'ration');
  p.hunger = 40;
  act({ type: 'hold', slot: at('ration') });
  assert.strictEqual(p.equipment.weapon, undefined);                          // food in hand: no weapon
  assert.strictEqual(World.rangedWeapon(s.c, p), null);
  assert.strictEqual(World.count(p, 'ration'), rations);                      // choosing it eats nothing
  act({ type: 'use', item: 'ration' });
  assert.strictEqual(World.count(p, 'ration'), rations - 1);                  // the click does
  assert.strictEqual(World.publicPlayer(s.c, p).held, at('ration'));
  act({ type: 'hold', slot: 99 });
  assert.strictEqual(p.held, -1);                                             // nothing in hand
  act({ type: 'use', item: 'pistol' });                                       // Equip in the bag = hold its belt slot
  assert.strictEqual(p.held, at('pistol'));
  assert.strictEqual(p.equipment.weapon, 'pistol');
  act({ type: 'loadout', bar: 'belt', slot: at('pistol'), entry: 'bandage' });   // swapping what sits in the held slot
  assert.strictEqual(p.equipment.weapon, undefined);
  // a character saved before held slots: the weapon they wear goes on the belt and into their hands
  const old = hero('warrior').p; delete old.held; old.belt = ['potion', '', '', '', ''];
  World.normalize(s.c, old);
  assert.strictEqual(old.belt[old.held], 'wooden_sword');
  assert.strictEqual(old.equipment.weapon, 'wooden_sword');
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
  assert.deepStrictEqual(labels(5, 13), []);                     // a creature: nothing by a plain click (attacks are aimed, then clicked)
  assert.deepStrictEqual(labels(10, 7), ['Open the wooden chest']);
  assert.deepStrictEqual(labels(8, 11), ['Read the sign']);
  assert.deepStrictEqual(labels(9, 9), ['Open the wooden door']);
  assert.deepStrictEqual(labels(12, 12), []);                    // empty ground: nothing to do (movement is keyboard-only)
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

test('time away from the game costs no food, water or health', () => {
  const s = fresh();
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);
  World.advance(s.c, s.ws, 'map_3', [s.p], 8 * 3600 * 1000, mid, []);  // back after eight hours logged out
  assert.strictEqual(s.p.hunger, 100); assert.strictEqual(s.p.thirst, 100);
  World.advance(s.c, s.ws, 'map_3', [s.p], 8 * 3600 * 1000 + 60000, mid, []);   // a minute of play drains as usual
  assert.ok(Math.abs(s.p.hunger - 99.4) < 1e-6);
  s.p.hunger = 0; const hp0 = s.p.hp;
  World.advance(s.c, s.ws, 'map_3', [s.p], 8 * 3600 * 1000 + 63000, mid, []);   // starving: first bite scheduled
  World.advance(s.c, s.ws, 'map_3', [s.p], 30 * 3600 * 1000, mid, []);          // ...then away for a day
  assert.strictEqual(s.p.hp, hp0, 'no starvation damage piles up while away');
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

test('a survivor spawns gun-in-hand with a loaded magazine; firing draws from the clip', () => {
  const s = hero('survivor');
  assert.strictEqual(s.p.equipment.weapon, 'pistol');                             // auto-equipped from start_items
  assert.strictEqual(s.p.mags.pistol, 12);                                        // clip loaded on spawn
  assert.strictEqual(World.count(s.p, 'ammo_pistol'), 28);                        // 40 pistol rounds - 12 in the mag
  const m = monster(s, 'skeleton', 12, 13);
  s.p.x = 9; s.p.y = 13;                                                          // 3 tiles away, clear line
  const map = s.c.maps.map_3, lk = World.viewLookup(s.c, map, World.view(s.c, s.ws, 'map_3', s.p, [s.p]), s.p);
  assert.deepStrictEqual(World.actionsAt(s.c, map, lk, s.p, 12, 13), []);           // a plain click does nothing to a creature: shots are aimed
  const hp0 = m.hp;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000);
  assert.strictEqual(s.p.mags.pistol, 11);                                        // spent from the clip
  assert.strictEqual(World.count(s.p, 'ammo_pistol'), 28);                        // reserve untouched
  assert.ok(m.hp < hp0, 'the shot connected');
  const w = hero('warrior');                                                      // no ranged weapon: shooting is refused
  assert.match(texts(act(w, { type: 'shoot', x: 0, y: 0 })), /no ranged weapon/i);
});

test('an empty clip must be reloaded with R, drawing from the reserve ammo', () => {
  const s = hero('survivor');                                                     // pistol: clip 12, reserve 28
  s.p.x = 9; s.p.y = 13; monster(s, 'skeleton', 12, 13);
  s.p.mags.pistol = 0;                                                            // empty the magazine
  assert.match(texts(act(s, { type: 'shoot', x: 12, y: 13 }, 1000)), /press R to reload/);
  act(s, { type: 'reload' });
  assert.strictEqual(s.p.mags.pistol, 12);                                        // refilled to the clip
  assert.strictEqual(World.count(s.p, 'ammo_pistol'), 16);                        // 28 - 12
  assert.match(texts(act(s, { type: 'reload' })), /already loaded/);              // a full clip can't reload
  s.p.inventory = s.p.inventory.filter(x => x.item !== 'ammo_pistol');            // no reserve left
  s.p.mags.pistol = 0;
  assert.match(texts(act(s, { type: 'reload' })), /Out of pistol ammo/);          // nothing to load
  assert.match(texts(act(s, { type: 'shoot', x: 12, y: 13 }, 5000)), /Out of pistol ammo\./);
});

test('equipping a gun is gated by level, but firing it is not', () => {
  const s = hero('survivor');                                                     // spawns with the pistol equipped
  assert.match(texts(act(s, { type: 'use', item: 'rifle' })), /Requires level 3/);
  assert.strictEqual(s.p.equipment.weapon, 'pistol');                             // rifle refused: still the pistol
  s.p.level = 3;
  assert.match(texts(act(s, { type: 'use', item: 'rifle' })), /You equip the rifle/);
  assert.strictEqual(s.p.equipment.weapon, 'rifle');
  const m = monster(s, 'skeleton', 12, 13); s.p.x = 9; s.p.y = 13; s.p.level = 1;  // drop back to level 1
  const hp0 = m.hp;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000);
  assert.ok(m.hp < hp0, 'fires regardless of level');
});

test('a shot pierces with damage falloff; a wall blocks it; off-map shots are refused', () => {
  const s = hero('survivor');                                                     // pistol equipped; ammo pierces 2, falloff 0.3
  s.p.x = 9; s.p.y = 13;
  const a = monster(s, 'skeleton', 11, 13), b = monster(s, 'skeleton', 12, 13);
  const ha = a.hp, hb = b.hp;
  act(s, { type: 'shoot', x: 13, y: 13 }, 1000);                                   // the ray passes through both
  assert.ok(a.hp < ha && b.hp < hb, 'both were hit');
  assert.ok((ha - a.hp) > (hb - b.hp), 'the second takes less (falloff)');
  assert.match(texts(act(s, { type: 'shoot', x: 9, y: 20 }, 3000)), /Out of the map/);  // beyond the map edge
  // a wall between shooter and target stops the shot (the hut on map_3)
  const s2 = hero('survivor');
  const w = monster(s2, 'skeleton', 5, 7); s2.p.x = 5; s2.p.y = 11;                // the hut wall is between them
  const hw = w.hp;
  assert.match(texts(act(s2, { type: 'shoot', x: 5, y: 7 }, 1000)), /in the way/);
  assert.strictEqual(w.hp, hw, 'the wall saved it');
});

test('shooting a monster from beyond its aggro range makes it engage and chase you', () => {
  const s = hero('survivor');
  s.p.x = 2; s.p.y = 13;
  const m = monster(s, 'skeleton', 12, 13); m.last = 0;          // 10 tiles off: past aggro (6), within pistol range (16)
  World.advance(s.c, s.ws, 'map_3', [s.p], 0, mid, []);          // baseline clock; too far to aggro, so it stays put
  const dist0 = Math.abs(m.x - s.p.x);
  act(s, { type: 'shoot', x: 12, y: 13 }, 100);                  // hit it from range
  assert.strictEqual(m.engaged, s.p.id, 'the hit marks it engaged');
  World.advance(s.c, s.ws, 'map_3', [s.p], 1000, mid, []);       // now it chases
  assert.ok(Math.abs(m.x - s.p.x) < dist0, 'the skeleton closed in after being shot');
});

test('throwing a grenade hits an area and a molotov sets the area burning', () => {
  const s = hero('survivor');
  s.p.x = 9; s.p.y = 13;
  const a = monster(s, 'skeleton', 10, 13), b = monster(s, 'skeleton', 11, 13);   // both within the blast (area 1) at (10,13)
  const ha = a.hp, hb = b.hp;
  act(s, { type: 'throw', item: 'grenade', x: 10, y: 13 }, 1000);
  assert.ok(a.hp < ha && b.hp < hb, 'both in the blast took damage');
  assert.strictEqual(World.count(s.p, 'grenade'), 2);                             // started with 3
  const c = monster(s, 'walker', 10, 15);
  World.give(s.c, s.p, 'molotov', 1, []);
  act(s, { type: 'throw', item: 'molotov', x: 10, y: 15 }, 3000);
  assert.ok(c.statuses.some(st => st.id === 'burn'), 'set on fire');
});

test('a click never walks you: a far target just warns; belt consumables use at once', () => {
  const s = hero('survivor');
  s.p.x = 9; s.p.y = 13;
  monster(s, 'skeleton', 12, 13);
  const before = [s.p.x, s.p.y];
  assert.match(texts(act(s, { type: 'attack', x: 12, y: 13 })), /Too far away/);   // melee a monster 3 tiles off
  assert.deepStrictEqual([s.p.x, s.p.y], before, 'did not move toward it');
  s.p.hp = 50; World.give(s.c, s.p, 'bandage', 1, []);
  act(s, { type: 'use', item: 'bandage' });
  assert.strictEqual(s.p.hp, 75);                                                 // +25, immediately
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

test('an overlay terrain governs passability: a blocking overlay over walkable ground blocks', () => {
  const c = Content.build({
    Terrain: [
      { id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 },
      { id: 'water', name: 'Water', color: '#36c', pass_n: 0, pass_e: 0, pass_s: 0, pass_w: 0 }
    ],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 1,
      terrain: JSON.stringify([['grass', 'grass', 'grass']]),
      overlay: JSON.stringify([['', 'water', '']]) }]
  });
  const map = c.maps.m;
  assert.ok(Rules.standable(c, map, 0, 0), 'plain grass is standable');
  assert.ok(!Rules.standable(c, map, 1, 0), 'a water overlay over grass is not standable');
  assert.ok(!Rules.tryMove(c, map, 0, 0, 'E').ok, 'cannot step onto the water overlay');
});

test('a walkable overlay does not block, and a map with no overlay is unchanged', () => {
  const c = Content.build({
    Terrain: [
      { id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 },
      { id: 'flowers', name: 'Flowers', color: '#5c5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }
    ],
    Maps: [
      { id: 'a', name: 'A', width: 2, height: 1, terrain: JSON.stringify([['grass', 'grass']]), overlay: JSON.stringify([['flowers', '']]) },
      { id: 'b', name: 'B', width: 2, height: 1, terrain: JSON.stringify([['grass', 'grass']]) }   // no overlay field
    ]
  });
  assert.ok(Rules.tryMove(c, c.maps.a, 1, 0, 'W').ok, 'a walkable overlay stays walkable');
  assert.deepStrictEqual(c.maps.b.overlay, [], 'a map without an overlay decodes to an empty overlay');
  assert.ok(Rules.tryMove(c, c.maps.b, 0, 0, 'E').ok, 'no-overlay maps behave exactly as before');
});

test('an edge wall blocks movement across the cell boundary it sits on, both ways', () => {
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 1,
      terrain: JSON.stringify([['grass', 'grass', 'grass']]),
      // vWalls has width+1 cols; a wall on the vertical line between cell 0 and cell 1 (col index 1)
      vWalls: JSON.stringify([['', 'brick:3', '', '']]) }]
  });
  const map = c.maps.m;
  assert.ok(!Rules.tryMove(c, map, 0, 0, 'E').ok, 'cannot cross the wall eastward');
  assert.strictEqual(Rules.tryMove(c, map, 0, 0, 'E').reason, 'wall');
  assert.ok(!Rules.tryMove(c, map, 1, 0, 'W').ok, 'cannot cross the wall westward');
  assert.ok(Rules.tryMove(c, map, 1, 0, 'E').ok, 'the next boundary (no wall) is open');
  assert.ok(Rules.standable(c, map, 0, 0) && Rules.standable(c, map, 1, 0), 'both cells stay standable floor');
});

test('a see-through wall (blocks_move, not sight) stops walking but not line of sight; height does not affect either', () => {
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [
      { id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true },
      { id: 'fence', name: 'Fence', blocks_move: true, blocks_sight: false }
    ],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 1,
      terrain: JSON.stringify([['grass', 'grass', 'grass']]),
      vWalls: JSON.stringify([['', 'fence:1', 'brick:2', '']]) }]
  });
  const map = c.maps.m, st = () => '';
  assert.ok(!Rules.tryMove(c, map, 0, 0, 'E').ok, 'the fence blocks walking');
  assert.ok(World.canSee(c, map, 0, 0, 1, 0, st), 'but you can see across the fence');
  assert.ok(!World.canSee(c, map, 1, 0, 2, 0, st), 'the brick wall blocks sight');
});

test('a frozen shape override (shift-click mapping) renders a fixed autotile tile regardless of neighbours', () => {
  const c = Content.build({
    Autotile: [{ layout: 'blob', mask: 0, tiles: '1' }, { layout: 'blob', mask: 255, tiles: '5' }],
    Tilesets: [{ id: 'gts', image: 'x.png', columns: 8, layout: 'blob' }],
    Terrain: [{ id: 'g', name: 'G', autotile: 'gts', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }]
  });
  const cells = [['g']];                               // one isolated cell; edgeSame=false → neighbour mask 0
  assert.strictEqual(Autotile.effectiveMask(cells, 0, 0, false, null), 0, 'isolated cell computes mask 0');
  assert.strictEqual(Autotile.effectiveMask(cells, 0, 0, false, { '0,0': 255 }), 255, 'an override wins over the neighbours');
  assert.strictEqual(Autotile.gridFor(c, cells, false, null)[0][0].tile, 1, 'no override → mask 0 → tile 1');
  assert.strictEqual(Autotile.gridFor(c, cells, false, { '0,0': 255 })[0][0].tile, 5, 'override 255 → the centre tile (5)');
});

test('a straight wall blocks a diagonal line across it; a wall end can still be seen past', () => {
  function arena(rows) {
    const c = Content.build({
      Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
      WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
      Maps: [{ id: 'm', name: 'M', width: 2, height: 2,
        terrain: JSON.stringify([['grass', 'grass'], ['grass', 'grass']]),
        vWalls: JSON.stringify(rows) }]
    });
    return { c, map: c.maps.m };
  }
  const st = () => '';
  // a vertical wall between columns 0 and 1 on BOTH rows: a straight N-S barrier
  const a = arena([['', 'brick:2', ''], ['', 'brick:2', '']]);
  assert.ok(!World.canSee(a.c, a.map, 0, 0, 1, 0, st), 'orthogonal across the wall is blocked');
  assert.ok(!World.canSee(a.c, a.map, 0, 0, 1, 1, st), 'a diagonal crossing the straight wall is blocked too');
  assert.ok(!World.canSee(a.c, a.map, 0, 1, 1, 0, st), 'the other diagonal across it is blocked');
  // only the row-0 segment present: the diagonal past its south end stays open (you can see around a wall's end)
  const b = arena([['', 'brick:2', ''], ['', '', '']]);
  assert.ok(World.canSee(b.c, b.map, 0, 1, 1, 0, st), 'you can still see diagonally past a wall end');
});

test('an edge door gates its wall: closed blocks move + sight, open lets both through (even over a wall)', () => {
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Kinds: [{ kind: 'door', property: 'states', default: 'closed|open' }],
    Objects: [{ id: 'door1', name: 'Door', kind: 'door', walkable: true, properties: '{"layer":"wall"}' }],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 3,
      terrain: JSON.stringify([['grass', 'grass', 'grass'], ['grass', 'grass', 'grass'], ['grass', 'grass', 'grass']]),
      hWalls: JSON.stringify([[], [], ['', 'brick:2', ''], []]) }]
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 1, y: 2, ref: 'door1', data: { side: 'N' } }];   // on edge hWalls[2][1]
  const ws = { maps: {} };
  const st = (e) => World.stateOf(c, ws, 'm', e);
  World.syncEdges(c, ws, 'm');                                       // default state = 'closed'
  assert.strictEqual(Rules.tryMove(c, map, 1, 2, 'N', {}).ok, false, 'closed door blocks the step north');
  assert.ok(!World.canSee(c, map, 1, 2, 1, 1, st), 'closed door blocks sight across its edge');
  World.mapState(ws, 'm').states['m.e1'] = 'open';
  World.syncEdges(c, ws, 'm');
  assert.strictEqual(Rules.tryMove(c, map, 1, 2, 'N', {}).ok, true, 'open door lets you walk through the wall');
  assert.ok(World.canSee(c, map, 1, 2, 1, 1, st), 'open door lets you see through');
});

test('a wide door opens from any tile it spans and from its face (hole), not just its anchor floor cell', () => {
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Kinds: [{ kind: 'door', property: 'states', default: 'closed|open' }],
    Objects: [{ id: 'garage', name: 'Garage Door', kind: 'door', walkable: true, properties: '{"layer":"wall","width":2}' }],
    Maps: [{ id: 'm', name: 'M', width: 4, height: 4,
      terrain: JSON.stringify(Array.from({ length: 4 }, () => ['grass', 'grass', 'grass', 'grass'])),
      hWalls: JSON.stringify([[], [], ['', 'brick:2', 'brick:2', ''], []]) }]   // wall on hWalls[2], cols 1 & 2
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 1, y: 2, ref: 'garage', data: { side: 'N' } }];  // 2-wide, anchored at col 1
  const ws = { maps: {} };
  const e = map.entities[0];
  // the click resolves to the door across BOTH its columns and up its face (the hole), but not off its span
  assert.strictEqual(World.wallMountAt(c, map, 1, 2), e, 'anchor floor cell');
  assert.strictEqual(World.wallMountAt(c, map, 2, 2), e, 'the far (non-anchor) column');
  assert.strictEqual(World.wallMountAt(c, map, 2, 1), e, 'the face/hole above the wall line');
  assert.strictEqual(World.wallMountAt(c, map, 3, 2), null, 'a cell past the door span is not the door');
  // actionsAt tags the interaction with a footprint cell to act from (not the clicked face/hole)
  const lk = { monsterAt: () => null, stateOf: (en) => World.stateOf(c, ws, 'm', en) };
  const p = { id: 'p1', map: 'm', x: 2, y: 3, facing: 'N', hp: 10, inventory: [], flags: {}, equipment: {} };
  const acts = World.actionsAt(c, map, lk, p, 2, 1);                 // click the hole, one tile north, from below
  assert.ok(acts[0] && acts[0].type === 'interact' && acts[0].at, 'clicking the hole offers "open", acting from a footprint cell');
  // and the full action path opens it when you click the non-anchor column
  assert.strictEqual(World.stateOf(c, ws, 'm', e), 'closed', 'starts closed');
  World.act(c, ws, p, { type: 'interact', x: 2, y: 2 }, 1000, Math.random, [p]);
  assert.strictEqual(World.stateOf(c, ws, 'm', e), 'open', 'clicking the far column opened the door');
});

test('you cannot interact with an object through a wall; the open side works', () => {
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Kinds: [{ kind: 'sign', property: 'states', default: '' }],
    Objects: [{ id: 'sign1', name: 'Sign', kind: 'sign', walkable: false, properties: '{"text":"Hello"}' }],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 3,
      terrain: JSON.stringify(Array.from({ length: 3 }, () => ['grass', 'grass', 'grass'])),
      hWalls: JSON.stringify([[], ['', 'brick:2', ''], [], []]) }]        // wall on hWalls[1], col 1 (between (1,1) and (1,0))
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 1, y: 0, ref: 'sign1' }];
  const ws = { maps: {} };
  const p = { id: 'p1', map: 'm', x: 1, y: 1, facing: 'N', hp: 10, inventory: [], flags: {}, equipment: {} };
  let ev = World.act(c, ws, p, { type: 'interact' }, 1000, Math.random, [p]);       // F-key: face the sign across the wall
  assert.match(texts(ev), /wall is in the way/i, 'the wall blocks reading the sign through it');
  assert.ok(!texts(ev).match(/Hello/), 'the sign text never shows through the wall');
  p.x = 2; p.y = 0; p.facing = 'W';                                                // beside the sign, no wall between
  ev = World.act(c, ws, p, { type: 'interact' }, 2000, Math.random, [p]);
  assert.match(texts(ev), /Hello/, 'reading it from the open side works');
});

test('roof rooms group by contiguity, and stepping inside records the room as explored', () => {
  // two separate roofed rooms: A = (1,1),(2,1),(1,2),(2,2); B = (4,1),(4,2). Column 3 is open between them.
  var roof = [['', '', '', '', '', ''], ['', '1', '1', '', '1', ''], ['', '1', '1', '', '1', ''], ['', '', '', '', '', '']];
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    Maps: [{ id: 'm', name: 'M', width: 6, height: 4,
      terrain: JSON.stringify(Array.from({ length: 4 }, () => Array.from({ length: 6 }, () => 'grass'))),
      roof: JSON.stringify(roof) }]
  });
  const map = c.maps.m;
  // contiguous tiles share one stable zone id (its top-left-most cell); separate rooms differ; open tiles are null
  assert.strictEqual(World.roofZoneAt(map, 1, 1), World.roofZoneAt(map, 2, 2), 'one room spans its contiguous tiles');
  assert.strictEqual(World.roofZoneAt(map, 1, 1), '1,1', 'the room id is its top-left-most cell');
  assert.notStrictEqual(World.roofZoneAt(map, 4, 1), World.roofZoneAt(map, 1, 1), 'the far room is a different zone');
  assert.strictEqual(World.roofZoneAt(map, 0, 0), null, 'an un-roofed tile has no zone');
  // stepping into room A records it on the player (persisted, per map); room B stays hidden
  const ws = { maps: {} };
  const p = { id: 'p1', map: 'm', x: 1, y: 0, facing: 'S', hp: 10, inventory: [], flags: {}, explored: {}, equipment: {} };
  World.act(c, ws, p, { type: 'move', dirs: ['S'] }, 1000, Math.random, [p]);
  assert.deepStrictEqual(p.explored.m, { '1,1': 1 }, 'walked into room A: it is now explored (room B is not)');
});

test('a wall stops a melee swing; attacking from the open side still connects', () => {
  const { s, slime } = wallArena();
  put(s, 'arena', 0, 0);
  const hp0 = slime.hp;
  assert.match(texts(act(s, { type: 'attack', x: 1, y: 0 }, 1000)), /in the way/i);
  assert.strictEqual(slime.hp, hp0, 'the wall saved the slime');
  put(s, 'arena', 2, 0);                                  // east of the wall: no wall between (2,0) and (1,0)
  act(s, { type: 'attack', x: 1, y: 0 }, 2000);
  assert.ok(slime.hp < hp0, 'attacking from the open side hits');
});

test('a thrown grenade is not refused by a wall: it detonates against it and the splash is blocked', () => {
  const { s, slime } = wallArena();
  put(s, 'arena', 0, 0);
  s.p.inventory = [{ item: 'grenade', qty: 2 }];
  const hp0 = slime.hp;
  const ev = act(s, { type: 'throw', item: 'grenade', x: 1, y: 0 }, 1000);        // aimed across the wall
  const te = ev.find(e => e.type === 'throw');
  assert.deepStrictEqual([te.to.x, te.to.y], [0, 0], 'the grenade lands against the wall, not past it');
  assert.strictEqual(slime.hp, hp0, 'the wall shields the slime from the blast');
  assert.strictEqual(s.p.inventory[0].qty, 1, 'the grenade is still thrown and consumed');
  put(s, 'arena', 2, 0);                                                          // open side: no wall between
  act(s, { type: 'throw', item: 'grenade', x: 1, y: 0 }, 20000);                  // well past the throw cooldown
  assert.ok(slime.hp < hp0, 'thrown from the open side it hits');
});

test('a monster cannot melee you through a wall, but can when adjacent in the open', () => {
  const { s, slime } = wallArena();
  const p = s.p;
  put(s, 'arena', 0, 0); p.hp = 100;
  const step = (s.c.monsters.slime.moveMs || 400) + 1;            // one monster step, small enough to avoid starve ticks
  slime.x = 1; slime.y = 0; slime.last = 0;                        // one tile east, wall between
  World.advance(s.c, s.ws, 'arena', [p], step, mid, []);
  assert.strictEqual(p.hp, 100, 'the wall blocks the monster\'s swing');
  s.c.maps.arena.vWalls = [['', '', '', '', '']];                  // tear the wall down
  slime.last = step;
  World.advance(s.c, s.ws, 'arena', [p], step * 2, mid, []);
  assert.ok(p.hp < 100, 'with no wall between, the adjacent monster hits');
});

test('wall openings: a window shows through only to someone standing at it, an archway passes both, the plain wall neither', () => {
  const row = ['grass', 'grass', 'grass', 'grass', 'grass'];
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Objects: [
      { id: 'win', name: 'Window', kind: 'deco', walkable: true, properties: '{"layer":"wall","opening":"window"}' },
      { id: 'arch', name: 'Arch', kind: 'deco', walkable: true, properties: '{"layer":"wall","opening":"arch"}' },
      { id: 'torch', name: 'Torch', kind: 'deco', walkable: true, properties: '{"layer":"wall"}' }],
    Maps: [{ id: 'm', name: 'M', width: 5, height: 5, terrain: JSON.stringify([row, row, row, row, row]),
      hWalls: JSON.stringify([[], [], ['brick:2', 'brick:2', 'brick:2', 'brick:2', 'brick:2'], [], [], []]) }]
  });
  const map = c.maps.m;
  map.entities = [
    { key: 'm.e1', x: 1, y: 2, ref: 'win', data: { side: 'N' } },
    { key: 'm.e2', x: 3, y: 2, ref: 'arch', data: { side: 'N' } },
    { key: 'm.e3', x: 4, y: 2, ref: 'torch', data: { side: 'N' } }];
  const ws = { maps: {} }, st = (e) => World.stateOf(c, ws, 'm', e);
  World.syncEdges(c, ws, 'm');
  assert.strictEqual(Rules.tryMove(c, map, 1, 2, 'N', {}).ok, false, 'you cannot climb through a window');
  assert.ok(World.canSee(c, map, 1, 2, 1, 1, st), 'standing at a window you can see through it');
  assert.ok(World.canSee(c, map, 1, 2, 1, 0, st), 'straight ahead');
  assert.ok(!World.canSee(c, map, 1, 2, 0, 1, st) && !World.canSee(c, map, 1, 2, 2, 0, st), 'but only a narrow cone: not off to the side');
  const pk = World.visibleCells(c, map, 1, 2, 8, st);
  assert.strictEqual(pk['1,1'], 2, 'cells seen through the window are marked as a peek');
  assert.strictEqual(pk['1,3'], 1, 'cells on your own side are plainly seen');
  assert.ok(World.canSee(c, map, 1, 1, 1, 3, st), 'from the other side too');
  assert.ok(!World.canSee(c, map, 1, 3, 1, 1, st), 'one step back from the window it is just wall');
  assert.ok(!World.canSee(c, map, 0, 2, 1, 1, st), 'and so it is from the next column');
  const vw = World.visibleCells(c, map, 1, 4, 8, st);
  assert.ok(!vw['1,1'] && !vw['1,0'], 'nothing behind the window is visible from a distance');
  assert.strictEqual(Rules.tryMove(c, map, 3, 2, 'N', {}).ok, true, 'an archway lets you walk through');
  assert.ok(World.canSee(c, map, 3, 2, 3, 1, st), 'and see through');
  assert.strictEqual(Rules.tryMove(c, map, 2, 2, 'N', {}).ok, false, 'the plain wall still blocks');
  assert.strictEqual(Rules.tryMove(c, map, 4, 2, 'N', {}).ok, false, 'a plain mount (torch) leaves its wall solid');
  assert.ok(!World.canSee(c, map, 4, 2, 4, 1, st), 'and opaque');
});

test('visibility: you see your side of a wall and through its openings, not through the wall itself', () => {
  const row = ['grass', 'grass', 'grass', 'grass', 'grass'];
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Kinds: [{ kind: 'door', property: 'states', default: 'closed|open' }],
    Objects: [{ id: 'door1', name: 'Door', kind: 'door', walkable: true, properties: '{"layer":"wall"}' }],
    Maps: [{ id: 'm', name: 'M', width: 5, height: 5, terrain: JSON.stringify([row, row, row, row, row]),
      hWalls: JSON.stringify([[], [], ['brick:2', 'brick:2', 'brick:2', 'brick:2', 'brick:2'], [], [], []]) }]
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 2, y: 2, ref: 'door1', data: { side: 'N' } }];
  const ws = { maps: {} }, st = (e) => World.stateOf(c, ws, 'm', e);
  World.syncEdges(c, ws, 'm');
  let vis = World.visibleCells(c, map, 2, 4, 8, st);
  assert.ok(vis['2,4'] && vis['0,2'] && vis['4,3'], 'everything on your side of the wall is visible');
  for (let x = 0; x < 5; x++) for (let y = 0; y < 2; y++) assert.ok(!vis[x + ',' + y], 'nothing beyond the closed wall: ' + x + ',' + y);
  World.mapState(ws, 'm').states['m.e1'] = 'open';
  World.syncEdges(c, ws, 'm');
  vis = World.visibleCells(c, map, 2, 4, 8, st);
  assert.ok(vis['2,1'] && vis['2,0'], 'the open door shows the strip beyond it');
  assert.ok(!vis['0,1'] && !vis['4,1'], 'but not the corners of the room behind the wall');
  assert.strictEqual(World.perceive(vis, null, 2, 1), 'seen');
  assert.strictEqual(World.perceive(vis, null, 0, 1), 'hidden');
  assert.strictEqual(World.perceive(vis, { '0,1': 1 }, 0, 1), 'sensed', 'another sense (hearing, later) turns hidden into an outline');
});

test('a door in a wall opens with the use key from either side of the wall', () => {
  const row = ['grass', 'grass', 'grass'];
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Kinds: [{ kind: 'door', property: 'states', default: 'closed|open' }],
    Objects: [{ id: 'door1', name: 'Door', kind: 'door', walkable: true, properties: '{"layer":"wall"}' }],
    Maps: [{ id: 'm', name: 'M', width: 3, height: 3, terrain: JSON.stringify([row, row, row]),
      hWalls: JSON.stringify([[], [], ['brick:2', 'brick:2', 'brick:2'], []]) }]
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 1, y: 2, ref: 'door1', data: { side: 'N' } }];
  const ws = { maps: {} };
  World.syncEdges(c, ws, 'm');
  const p = { id: 'p1', map: 'm', x: 1, y: 1, facing: 'S', hp: 10, maxHp: 10, inventory: {}, flags: {}, cooldowns: {} };
  World.act(c, ws, p, { type: "interact" }, 1000, mid, [p]);
  assert.strictEqual(World.mapState(ws, 'm').states['m.e1'], 'open', 'opened from the north side');
  p.x = 1; p.y = 2; p.facing = 'N';
  World.act(c, ws, p, { type: "interact" }, 5000, mid, [p]);
  assert.strictEqual(World.mapState(ws, 'm').states['m.e1'], 'closed', 'closed again from the south side');
});

test('a window in a N-S wall: you peek through it only when standing at it', () => {
  const row = ['grass', 'grass', 'grass', 'grass', 'grass'];
  const col = () => ['', '', 'brick:2', '', ''];
  const c = Content.build({
    Terrain: [{ id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 }],
    WallStyles: [{ id: 'brick', name: 'Brick', blocks_move: true, blocks_sight: true }],
    Objects: [{ id: 'win', name: 'Window', kind: 'deco', walkable: true, properties: '{"layer":"wall","opening":"window"}' }],
    Maps: [{ id: 'm', name: 'M', width: 5, height: 5, terrain: JSON.stringify([row, row, row, row, row]),
      vWalls: JSON.stringify([col(), col(), col(), col(), col()]) }]
  });
  const map = c.maps.m;
  map.entities = [{ key: 'm.e1', x: 2, y: 2, ref: 'win', data: { side: 'W' } }];
  const ws = { maps: {} }, st = (e) => World.stateOf(c, ws, 'm', e);
  World.syncEdges(c, ws, 'm');
  assert.strictEqual(Rules.tryMove(c, map, 1, 2, 'E', {}).ok, false, 'no walking through');
  assert.ok(World.canSee(c, map, 1, 2, 4, 2, st), 'at the window you see straight through, west to east');
  assert.ok(World.canSee(c, map, 2, 2, 0, 2, st), 'and east to west');
  assert.ok(!World.canSee(c, map, 1, 2, 3, 0, st), 'only a narrow cone');
  assert.ok(!World.canSee(c, map, 0, 2, 3, 2, st), 'a step back it is just wall');
  assert.ok(!World.canSee(c, map, 1, 1, 3, 1, st), 'and so is the next row');
});

// ---------------------------------------------------------------- structures: health, damage, destruction
// A small arena: 7x7 open ground, a wall along the north edge of row 3 — planks (breakable) on x 0-3, brick
// (not breakable) on x 4-6 — with a wooden door in the plank wall at x=1, and a crate standing at (5,1).
function arena() {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(7).fill('til_1');
  t.WallStyles.push({ id: 'planks', name: 'Plank wall', color: '#775533', blocks_move: true, blocks_sight: true, hp: 20, armor: 0, material: 'wood', breakable: true, salvage: 'potion:1' });
  t.WallStyles.push({ id: 'hardbrick', name: 'Old brick', color: '#884433', blocks_move: true, blocks_sight: true, hp: 100, armor: 0, material: 'stone', breakable: false });
  t.Objects.push({ id: 't_door', name: 'Shed door', kind: 'door', walkable: true, properties: '{"layer":"wall","hp":12,"material":"wood"}' });
  t.Objects.push({ id: 't_crate', name: 'Crate', kind: 'deco', walkable: false, blocks_sight: true, properties: '{"hp":10,"material":"wood"}' });
  t.Objects.push({ id: 't_rock', name: 'Boulder', kind: 'deco', walkable: false, blocks_sight: true, properties: '{}' });
  const wall = ['planks:2', 'planks:2', 'planks:2', 'planks:2', 'hardbrick:2', 'hardbrick:2', 'hardbrick:2'];
  t.Maps.push({ id: 'arena', name: 'Arena', width: 7, height: 7, terrain: JSON.stringify(Array(7).fill(row)),
    hWalls: JSON.stringify([[], [], [], wall, [], [], [], []]) });
  t.MapEntities.push({ map: 'arena', key: 'arena.e1', x: 1, y: 3, ref: 't_door', data: '{"side":"N"}' });
  t.MapEntities.push({ map: 'arena', key: 'arena.e2', x: 5, y: 1, ref: 't_crate', data: '' });
  t.MapEntities.push({ map: 'arena', key: 'arena.e3', x: 6, y: 5, ref: 't_rock', data: '' });
  const c = Content.build(t), ws = { maps: {} };
  const p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  const s = { c, ws, p };
  put(s, 'arena', 2, 3, 'N');
  return s;
}
const liveOf = (s) => { World.syncEdges(s.c, s.ws, 'arena'); return World.liveMap(s.c, s.ws, 'arena'); };
const stOf = (s) => (e) => World.stateOf(s.c, s.ws, 'arena', e);
const WALL = (x) => ({ t: 'wall', orient: 'h', x: x, y: 3 });

test('nothing built or broken: the rules use the authored map itself, untouched', () => {
  const s = arena(), base = s.c.maps.arena;
  assert.strictEqual(World.liveMap(s.c, s.ws, 'arena'), base);
  const before = JSON.stringify([base.hWalls, base.entities]);
  World.damageStructure(s.c, s.ws, 'arena', WALL(2), 5, { kind: 'melee' }, []);
  const live = World.liveMap(s.c, s.ws, 'arena');
  assert.notStrictEqual(live, base, 'once something changed, the rules get the map with the changes applied');
  assert.strictEqual(JSON.stringify([base.hWalls, base.entities]), before, 'the authored map is never altered');
  assert.strictEqual(JSON.stringify(s.c.maps).indexOf('_live'), -1, 'live state does not leak into the content sent to clients');
});

test('a breakable wall: cracks, then holes you can see through, then it is gone', () => {
  const s = arena(), ev = [];
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 2, 3, 'N', {}).ok, false);
  assert.ok(!World.canSee(s.c, liveOf(s), 2, 3, 2, 2, stOf(s)));
  World.damageStructure(s.c, s.ws, 'arena', WALL(2), 8, { kind: 'melee' }, ev);          // 12 of 20 left
  assert.strictEqual(World.structInfo(s.c, liveOf(s), WALL(2)).hp, 12);
  assert.ok(!World.canSee(s.c, liveOf(s), 2, 3, 2, 2, stOf(s)), 'cracked, still solid to the eye');
  World.damageStructure(s.c, s.ws, 'arena', WALL(2), 7, { kind: 'melee' }, ev);          // 5 of 20: under a third
  assert.ok(World.canSee(s.c, liveOf(s), 2, 3, 2, 2, stOf(s)), 'breached: you can see through the holes');
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 2, 3, 'N', {}).ok, false, 'but not walk through');
  const r = World.damageStructure(s.c, s.ws, 'arena', WALL(2), 9, { kind: 'melee', player: s.p }, ev);
  assert.ok(r.destroyed);
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 2, 3, 'N', {}).ok, true, 'destroyed: the way is open');
  assert.strictEqual(World.structInfo(s.c, liveOf(s), WALL(2)), null);
  assert.ok(World.count(s.p, 'potion') >= 3, 'whoever broke it gets its salvage');
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 3, 3, 'N', {}).ok, false, 'the segment next to it still stands');
});

test('a wall style that is not breakable takes no damage, whatever hits it', () => {
  const s = arena();
  assert.strictEqual(World.damageStructure(s.c, s.ws, 'arena', WALL(5), 500, { kind: 'blast' }, []), null);
  assert.strictEqual(World.structInfo(s.c, liveOf(s), WALL(5)).hp, 100);
  assert.strictEqual(World.liveMap(s.c, s.ws, 'arena'), s.c.maps.arena, 'and nothing was recorded');
});

test('swinging at a wall: the attack action hits what is in the way; a shut door goes down and stays down', () => {
  const s = arena();
  put(s, 'arena', 1, 3, 'N');
  assert.deepStrictEqual(World.strikeTarget(s.c, liveOf(s), s.p, 1, 2), { t: 'ent', key: 'arena.e1' }, 'the door on that edge, not the wall behind it');
  let now = 1000, ev = [];
  for (let i = 0; i < 5 && World.structInfo(s.c, liveOf(s), { t: 'ent', key: 'arena.e1' }); i++) { now += 2000; ev = ev.concat(act(s, { type: 'attack', x: 1, y: 2 }, now)); }
  assert.match(texts(ev), /You hit the shed door for 5/);           // warrior attack 9, half of it against structures
  assert.match(texts(ev), /The shed door breaks/);
  assert.strictEqual(World.structInfo(s.c, liveOf(s), { t: 'ent', key: 'arena.e1' }), null);
  assert.ok(!liveOf(s).entities.some(e => e.key === 'arena.e1'), 'the door is no longer on the map');
  assert.deepStrictEqual(Rules.entitiesAt(liveOf(s), 1, 3).map(e => e.key), [], 'nor can it be found on its tile any more');
  assert.match(texts(act(s, { type: 'interact' }, now + 3000)), /Nothing to use here|wall is in the way/, 'so there is nothing left to open');
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 1, 3, 'N', {}).ok, false, 'the wall it hung on still stands');
  put(s, 'arena', 5, 3, 'N');
  assert.match(texts(act(s, { type: 'attack', x: 5, y: 2 }, now + 5000)), /Nothing to attack there/, 'unbreakable brick is not a target');
  put(s, 'arena', 5, 2, 'N');
  assert.match(texts(act(s, { type: 'attack', x: 5, y: 1 }, now + 9000)), /You hit the crate for 5/, 'a solid object in the next tile is');
  put(s, 'arena', 6, 4, 'S');
  assert.match(texts(act(s, { type: 'attack', x: 6, y: 5 }, now + 12000)), /Nothing to attack there/, 'an object with no health is not');
});

test('breaking a wall takes the door hanging on it along', () => {
  const s = arena();
  World.mapState(s.ws, 'arena').states['arena.e1'] = 'open';
  World.damageStructure(s.c, s.ws, 'arena', WALL(1), 99, { kind: 'melee' }, []);
  const live = liveOf(s);
  assert.ok(!live.entities.some(e => e.key === 'arena.e1'));
  assert.strictEqual(World.mapState(s.ws, 'arena').states['arena.e1'], undefined, 'its state is forgotten too');
  assert.strictEqual(Rules.tryMove(s.c, live, 1, 3, 'N', {}).ok, true);
});

test('a blast batters what it reaches, and a wall shields what is behind it', () => {
  const s = arena();
  put(s, 'arena', 2, 6, 'N');
  World.give(s.c, s.p, 'grenade', 2, []);
  act(s, { type: 'throw', item: 'grenade', x: 2, y: 3 }, 1000);          // lands against the plank wall from the south
  const live = liveOf(s);
  assert.strictEqual(World.structInfo(s.c, live, WALL(2)), null, 'grenade 18 x2 against wood: the planks it reached are gone');
  assert.strictEqual(World.structInfo(s.c, live, WALL(5)).hp, 100, 'the brick is untouched');
  assert.strictEqual(World.structInfo(s.c, live, { t: 'ent', key: 'arena.e2' }).hp, 10, 'the crate beyond the wall was shielded');
});

test('a bullet stopped by a wall damages it; one spent on a creature does not', () => {
  const s = hero('survivor');
  const c = s.c, map = c.maps.map_3;
  c.wallStyles.planks = { id: 'planks', name: 'Plank wall', hp: 20, armor: 0, material: 'wood', breakable: true, blocksMove: true, blocksSight: true };
  // find a spot with three clear cells to the north, and wall off the edge two cells up
  let at = null;
  for (let y = 4; y < map.height && !at; y++) for (let x = 0; x < map.width && !at; x++) {
    const ok = [0, 1, 2, 3].every(d => Rules.standable(c, map, x, y - d) && !Rules.blockersAt(c, map, x, y - d).length) &&
      [0, 1, 2].every(d => !Rules.blockedBetween(c, map, x, y - d, x, y - d - 1, 'sight'));
    if (ok) at = { x, y };
  }
  assert.ok(at, 'the seed map has a clear lane');
  while (map.hWalls.length <= at.y) map.hWalls.push([]);
  map.hWalls[at.y - 1] = (map.hWalls[at.y - 1] || []).slice(); while (map.hWalls[at.y - 1].length < at.x) map.hWalls[at.y - 1].push('');
  map.hWalls[at.y - 1][at.x] = 'planks:2';                                // north edge of the cell one step north
  s.p.x = at.x; s.p.y = at.y;
  const wall = { t: 'wall', orient: 'h', x: at.x, y: at.y - 1 };
  World.act(c, s.ws, s.p, { type: 'shoot', x: at.x, y: at.y - 3 }, 5000, mid, [s.p]);
  const hp1 = World.structInfo(c, World.liveMap(c, s.ws, 'map_3'), wall).hp;
  assert.ok(hp1 < 20, 'the shot was stopped by the planks and chipped them');
  const m = World.mapState(s.ws, 'map_3').monsters[0];
  m.dead = false; m.hp = 999; m.x = at.x; m.y = at.y - 1;                  // a creature in front of the wall
  World.act(c, s.ws, s.p, { type: 'shoot', x: at.x, y: at.y - 1 }, 9000, mid, [s.p]);
  assert.ok(m.hp < 999, 'the creature took the bullet');
  assert.strictEqual(World.structInfo(c, World.liveMap(c, s.ws, 'map_3'), wall).hp, hp1, 'and the wall behind it took nothing');
});

test('the structure layer is sent to a client only when it is behind', () => {
  const s = arena();
  let v = World.view(s.c, s.ws, 'arena', s.p, [s.p], undefined);
  assert.strictEqual(v.structRev, 0); assert.strictEqual(v.struct, undefined);
  World.damageStructure(s.c, s.ws, 'arena', WALL(2), 5, { kind: 'melee' }, []);
  v = World.view(s.c, s.ws, 'arena', s.p, [s.p], 0);
  assert.strictEqual(v.structRev, 1);
  assert.strictEqual(v.struct.dmg['h2,3'], 5, 'behind: the layer comes along');
  assert.strictEqual(World.view(s.c, s.ws, 'arena', s.p, [s.p], 1).struct, undefined, 'up to date: just the revision number');
  const client = World.liveMapFromStruct(s.c, s.c.maps.arena, JSON.parse(JSON.stringify(v.struct)));
  assert.strictEqual(World.structInfo(s.c, client, WALL(2)).hp, 15, 'the client works out the same health from what it was sent');
});

// ---------------------------------------------------------------- crafting and harvesting
function camp() {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(7).fill('til_1');
  t.Objects.push({ id: 't_bench', name: 'Workbench', kind: 'craft', walkable: false, properties: '{"station":"workbench"}' });
  t.Objects.push({ id: 't_tree', name: 'Pine', kind: 'deco', walkable: false, properties: '{"hp":10,"material":"wood","harvest":"wood:3","harvest_tool":"axe","respawn_s":60}' });
  t.Maps.push({ id: 'camp', name: 'Camp', width: 7, height: 7, terrain: JSON.stringify(Array(7).fill(row)) });
  t.MapEntities.push({ map: 'camp', key: 'camp.e1', x: 5, y: 5, ref: 't_bench', data: '' });
  t.MapEntities.push({ map: 'camp', key: 'camp.e2', x: 1, y: 0, ref: 't_tree', data: '' });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  const s = { c, ws, p };
  put(s, 'camp', 1, 1, 'N');
  return s;
}
const recipe = (s, id) => World.recipesFor(s.c, World.liveMap(s.c, s.ws, 'camp'), s.p, World.viewLookup(s.c, s.c.maps.camp, { states: {}, monsters: [], players: [] }, s.p)).filter(r => r.id === id)[0];

test('crafting by hand: needs the materials, uses them up, gives the result', () => {
  const s = camp();
  assert.strictEqual(recipe(s, 'r_hammer').can, false);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_hammer' })), /Not enough wood, scrap metal/);
  World.give(s.c, s.p, 'wood', 3, []); World.give(s.c, s.p, 'scrap', 5, []);
  assert.strictEqual(recipe(s, 'r_hammer').can, true);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_hammer' })), /You make 1 hammer/);
  assert.deepStrictEqual([World.count(s.p, 'hammer'), World.count(s.p, 'wood'), World.count(s.p, 'scrap')], [1, 2, 3]);
  assert.match(texts(act(s, { type: 'craft', recipe: 'no_such_recipe' })), /don't know how/);
});

test('a station recipe needs the station nearby and the tool in the bag', () => {
  const s = camp();
  World.give(s.c, s.p, 'scrap', 10, []);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails' })), /Needs a workbench nearby/);
  put(s, 'camp', 4, 5, 'E');
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails' })), /Needs a hammer/);
  assert.strictEqual(recipe(s, 'r_nails').here, true);
  World.give(s.c, s.p, 'hammer', 1, []);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails', qty: 3 })), /You make 12 nails/);
  assert.deepStrictEqual([World.count(s.p, 'nails'), World.count(s.p, 'scrap'), World.count(s.p, 'hammer')], [12, 7, 1], 'the tool is not used up');
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails', qty: 20 })), /Not enough scrap metal/, 'all or nothing');
  assert.strictEqual(World.count(s.p, 'scrap'), 7);
});

test('harvesting: an object may list several tools, and any one of them will do', () => {
  const s = camp();
  s.c.objects.t_tree.properties.harvest_tool = 'axe, hammer';
  assert.match(texts(act(s, { type: 'attack', x: 1, y: 0 }, 1000)), /You need an axe or a hammer for the pine/);
  World.give(s.c, s.p, 'hammer', 1, []);
  assert.match(texts(act(s, { type: 'attack', x: 1, y: 0 }, 3000)), /You hit the pine|The pine breaks/);
});

test('an item of a tool type is a tool by its own id; a tag, when given, is what counts; weapons are not tools by themselves', () => {
  const t = JSON.parse(JSON.stringify(tables));
  t.ItemTypes = (t.ItemTypes || []).concat([{ id: 'gear', name: 'Gear', tool: true }]);
  t.Items.push({ id: 't_saw', name: 'Saw', type: 'tool' }, { id: 't_pick', name: 'Pick', type: 'gear' },
    { id: 't_hatchet', name: 'Hatchet', type: 'tool', tool: 'axe' }, { id: 't_club', name: 'Club', type: 'weapon' });
  const c = Content.build(t);
  assert.deepStrictEqual([c.items.t_saw.tools, c.items.t_pick.tools, c.items.t_hatchet.tools, c.items.t_club.tools], [['t_saw'], ['t_pick'], ['axe'], []]);
  const p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  assert.strictEqual(World.hasTool(c, p, 't_saw'), false);
  World.give(c, p, 't_saw', 1, []);
  assert.strictEqual(World.hasTool(c, p, 't_saw, axe'), true);
});

test('using a crafting station tells the client to open the crafting panel', () => {
  const s = camp();
  put(s, 'camp', 4, 5, 'E');
  const ev = act(s, { type: 'interact' });
  assert.ok(ev.some(e => e.type === 'craft' && e.station === 'workbench' && e.to === 'p1'));
});

test('harvesting: the right tool, the yield, and the tree grows back', () => {
  const s = camp();
  const tree = { t: 'ent', key: 'camp.e2' };
  assert.match(texts(act(s, { type: 'attack', x: 1, y: 0 }, 1000)), /You need an axe for the pine/);
  World.give(s.c, s.p, 'axe', 1, []);
  let now = 1000, ev = [];
  for (let i = 0; i < 6 && World.structInfo(s.c, World.liveMap(s.c, s.ws, 'camp'), tree); i++) { now += 2000; ev = ev.concat(act(s, { type: 'attack', x: 1, y: 0 }, now)); }
  assert.strictEqual(World.count(s.p, 'wood'), 3, 'felling it gives the wood');
  assert.ok(!World.liveMap(s.c, s.ws, 'camp').entities.some(e => e.key === 'camp.e2'), 'the tree is gone');
  assert.strictEqual(Rules.tryMove(s.c, World.liveMap(s.c, s.ws, 'camp'), 1, 1, 'N', {}).ok, true, 'and you can walk where it stood');
  World.advance(s.c, s.ws, 'camp', [s.p], now + 30000, mid, []);
  assert.ok(!World.liveMap(s.c, s.ws, 'camp').entities.some(e => e.key === 'camp.e2'), 'not back yet');
  World.advance(s.c, s.ws, 'camp', [s.p], now + 61000, mid, []);
  assert.ok(World.liveMap(s.c, s.ws, 'camp').entities.some(e => e.key === 'camp.e2'), 'a minute later it has grown back');
  assert.strictEqual(World.structInfo(s.c, World.liveMap(s.c, s.ws, 'camp'), tree).hp, 10, 'at full health');
});

// ---------------------------------------------------------------- building
// An open 9x9 yard; the builder stands at (4,4) with a hammer and plenty of materials. Tile (8,8) is no-build.
function yard() {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(9).fill('til_1');
  const nb = Array(9).fill(0).map(() => Array(9).fill(''));
  nb[8][8] = '1';
  t.Maps.push({ id: 'yard', name: 'Yard', width: 9, height: 9, terrain: JSON.stringify(Array(9).fill(row)), nobuild: JSON.stringify(nb) });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Builder', 'warrior');
  const s = { c, ws, p };
  put(s, 'yard', 4, 4, 'N');
  [['hammer', 1], ['wood', 60], ['nails', 40], ['scrap', 40]].forEach(g => World.give(c, p, g[0], g[1], []));
  return s;
}
const yardMap = (s) => { World.syncEdges(s.c, s.ws, 'yard'); return World.liveMap(s.c, s.ws, 'yard'); };
let clock = 100000;
const doAct = (s, a) => { clock += 5000; return texts(World.act(s.c, s.ws, s.p, a, clock, mid, [s.p])); };
const N44 = { t: 'wall', orient: 'h', x: 4, y: 4 };                       // the north edge of the builder's tile

test('building a wall: the frame blocks at once, work finishes it, and it costs the materials', () => {
  const s = yard();
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' }), /You set up the frame of a wooden wall/);
  assert.deepStrictEqual([World.count(s.p, 'wood'), World.count(s.p, 'nails')], [56, 38]);
  let info = World.structInfo(s.c, yardMap(s), N44);
  assert.deepStrictEqual([info.built, info.hp, info.max, info.rec.prog, info.rec.need], [true, 8, 40, 0, 4]);
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'N', {}).ok, false, 'a frame is already in the way');
  assert.match(doAct(s, { type: 'interact' }), /You work on the wooden wall \(1\/4\)/, 'the use key works on the frame you face');
  doAct(s, { type: 'work', target: N44 }); doAct(s, { type: 'work', target: N44 });
  assert.match(doAct(s, { type: 'work', target: N44 }), /The wooden wall is finished/);
  info = World.structInfo(s.c, yardMap(s), N44);
  assert.deepStrictEqual([info.hp, info.rec.prog], [40, 4]);
  assert.match(doAct(s, { type: 'work', target: N44 }), /Nothing to work on/);
  assert.ok(!World.canSee(s.c, yardMap(s), 4, 4, 4, 3, (e) => World.stateOf(s.c, s.ws, 'yard', e)), 'and it blocks sight like any wall');
});

test('building is refused, with the reason, when a rule says no — and the ghost gets the same answer', () => {
  const s = yard();
  const lk = () => World.viewLookup(s.c, yardMap(s), { states: {}, monsters: [], players: [] }, s.p);
  const ghost = (bp, x, y, side) => World.canBuild(s.c, yardMap(s), lk(), s.p, s.c.blueprints[bp], x, y, side);
  assert.strictEqual(ghost('bp_wood_wall', 4, 4, 'N').ok, true);
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 0, side: 'N' }), /Too far away/);
  assert.strictEqual(ghost('bp_wood_wall', 4, 0, 'N').reason, 'Too far away.');
  assert.match(doAct(s, { type: 'build', bp: 'nope', x: 4, y: 4, side: 'N' }), /don't know how to build/);
  assert.match(doAct(s, { type: 'build', bp: 'bp_door', x: 4, y: 4, side: 'N' }), /needs a wall to hang on/);
  doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' });
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' }), /already a wall there/);
  assert.strictEqual(ghost('bp_wood_wall', 4, 4, 'N').ok, false);
  assert.match(doAct(s, { type: 'build', bp: 'bp_crate', x: 4, y: 4 }), /not clear/, 'not on top of yourself');
  put(s, 'yard', 7, 8, 'E');
  assert.match(doAct(s, { type: 'build', bp: 'bp_crate', x: 8, y: 8 }), /can't build here/, 'a no-build tile');
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 8, side: 'W' }), /can't build here/, 'nor a wall along its edge');
  put(s, 'yard', 4, 4, 'N');
  World.act(s.c, s.ws, s.p, { type: 'use', item: 'hammer' }, clock += 5000, mid, [s.p]);
  s.p.inventory = s.p.inventory.filter(x => x.item !== 'hammer');
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'W' }), /Needs a hammer/);
  World.give(s.c, s.p, 'hammer', 1, []);
  s.p.inventory = s.p.inventory.filter(x => x.item !== 'wood');
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'W' }), /Not enough wood/);
  World.give(s.c, s.p, 'wood', 20, []);
  s.c.config.structure_cap_per_player = 1;
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'W' }), /built as much as you can/);
});

test('repair costs materials, taking apart refunds by condition, an upgrade keeps the condition', () => {
  const s = yard();
  doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' });
  for (let i = 0; i < 4; i++) doAct(s, { type: 'work', target: N44 });
  World.damageStructure(s.c, s.ws, 'yard', N44, 20, { kind: 'melee' }, []);          // 20 of 40 left
  const wood0 = World.count(s.p, 'wood'), nails0 = World.count(s.p, 'nails');
  assert.match(doAct(s, { type: 'work', target: N44 }), /You repair the wooden wall \(30\/40\)/);
  assert.deepStrictEqual([wood0 - World.count(s.p, 'wood'), nails0 - World.count(s.p, 'nails')], [1, 1], 'a quarter of half the cost, at least one of each');
  assert.match(doAct(s, { type: 'upgrade', target: N44, bp: 'bp_crate' }), /can't be upgraded that way/);
  assert.match(doAct(s, { type: 'upgrade', target: N44, bp: 'bp_metal_wall' }), /You upgrade it to a metal wall/);
  let info = World.structInfo(s.c, yardMap(s), N44);
  assert.deepStrictEqual([info.max, info.hp, info.material], [120, 90, 'metal'], 'three quarters before, three quarters after');
  const scrap0 = World.count(s.p, 'scrap');
  assert.match(doAct(s, { type: 'dismantle', target: N44 }), /You take the metal wall apart/);
  assert.strictEqual(World.count(s.p, 'scrap') - scrap0, 2, 'half of 6 scrap, times three quarters, rounded down');
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'N', {}).ok, true);
  assert.match(doAct(s, { type: 'dismantle', target: N44 }), /only take apart what was built/);
  const other = World.newPlayer(s.c, 'p2', 'Rival', 'warrior'); put({ p: other }, 'yard', 4, 4, 'N'); other.x = 4; other.y = 4; other.map = 'yard';
  World.give(s.c, other, 'hammer', 1, []);
  doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'W' });
  assert.match(texts(World.act(s.c, s.ws, other, { type: 'dismantle', target: { t: 'wall', orient: 'v', x: 4, y: 4 } }, clock += 5000, mid, [s.p, other])), /not yours to take apart/);
});

test('a door needs a wall; once built it opens, closes and gates the wall like any door', () => {
  const s = yard();
  doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' });
  assert.match(doAct(s, { type: 'build', bp: 'bp_door', x: 4, y: 4, side: 'N' }), /frame of a wooden door/);
  const door = yardMap(s).entities.filter(e => e.ref === 'obj_edge_door')[0];
  assert.ok(/^yard\.b\d+$/.test(door.key), 'built things get their own kind of key');
  assert.match(doAct(s, { type: 'build', bp: 'bp_door', x: 4, y: 4, side: 'N' }), /already on that wall/);
  assert.match(doAct(s, { type: 'dismantle', target: N44 }), /Take down what hangs on it first/);
  const stf = (e) => World.stateOf(s.c, s.ws, 'yard', e);
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'N', {}).ok, false);
  assert.match(doAct(s, { type: 'interact', x: 4, y: 4 }), /You work on the door \(1\/4\)/, 'a frame does not open: using it works on it');
  for (let i = 0; i < 3; i++) doAct(s, { type: 'work', target: { t: 'ent', key: door.key } });
  doAct(s, { type: 'interact', x: 4, y: 4 });                              // open it
  assert.strictEqual(stf(door), 'open');
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'N', {}).ok, true, 'open: you walk through the wall');
  assert.ok(World.canSee(s.c, yardMap(s), 4, 4, 4, 3, stf));
  doAct(s, { type: 'interact', x: 4, y: 4 });
  assert.ok(!World.canSee(s.c, yardMap(s), 4, 4, 4, 3, stf), 'shut: it blocks sight again');
});

test('a storage crate keeps what you put in; smashed, it leaves the contents in rubble', () => {
  const s = yard();
  doAct(s, { type: 'build', bp: 'bp_crate', x: 5, y: 4 });
  const crate = yardMap(s).entities.filter(e => e.ref === 'obj_crate')[0];
  for (let i = 0; i < 3; i++) doAct(s, { type: 'work', target: { t: 'ent', key: crate.key } });
  let ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 5, y: 4 }, clock += 5000, mid, [s.p]);
  assert.ok(ev.some(e => e.type === 'storage' && e.key === crate.key && e.slots === 12), 'using it shows what is inside');
  const wood0 = World.count(s.p, 'wood');
  doAct(s, { type: 'store', key: crate.key, op: 'put', item: 'wood', qty: 10 });
  doAct(s, { type: 'store', key: crate.key, op: 'put', item: 'nails', qty: 5 });
  assert.deepStrictEqual(crate.inv, { wood: 10, nails: 5 });
  assert.strictEqual(World.count(s.p, 'wood'), wood0 - 10);
  put(s, 'yard', 4, 4, 'E');
  ev = World.act(s.c, s.ws, s.p, { type: 'interact' }, clock += 5000, mid, [s.p]);
  assert.ok(ev.some(e => e.type === 'storage' && e.inv.wood === 10), 'the use key opens the crate you face');
  doAct(s, { type: 'store', key: crate.key, op: 'take', item: 'wood', qty: 4 });
  assert.deepStrictEqual([crate.inv.wood, World.count(s.p, 'wood')], [6, wood0 - 6]);
  assert.match(doAct(s, { type: 'store', key: crate.key, op: 'take', item: 'scrap', qty: 1 }), /none in there/);
  assert.match(doAct(s, { type: 'dismantle', target: { t: 'ent', key: crate.key } }), /Empty it first/);
  assert.strictEqual(World.view(s.c, s.ws, 'yard', s.p, [s.p], -1).struct.ents[0].inv, undefined, 'contents are not broadcast with the map');
  World.damageStructure(s.c, s.ws, 'yard', { t: 'ent', key: crate.key }, 999, { kind: 'blast', now: clock }, []);
  const left = yardMap(s).entities.filter(e => e.x === 5 && e.y === 4);
  assert.deepStrictEqual(left.map(e => e.ref), ['obj_rubble']);
  assert.deepStrictEqual(left[0].inv, { wood: 6, nails: 5 }, 'nothing was lost');
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'E', {}).ok, true, 'rubble can be walked over');
});

// ---- claims (base building Phase 4)
// A wide open field (30x13), an authored chest far to the east, two players: Builder (p) and Raider (q).
function land(cfg) {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(30).fill('til_1');
  t.Maps.push({ id: 'land', name: 'Land', width: 30, height: 13, terrain: JSON.stringify(Array(13).fill(row)), spawn: JSON.stringify({ x: 29, y: 12 }) });
  t.MapEntities.push({ map: 'land', key: 'land.e1', x: 27, y: 2, ref: 'obj_0', data: '' });
  Object.keys(cfg || {}).forEach(k => { const r = t.Config.find(x => x.key === k); if (r) r.value = cfg[k]; else t.Config.push({ key: k, value: cfg[k] }); });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Builder', 'warrior'), q = World.newPlayer(c, 'p2', 'Raider', 'warrior');
  const s = { c, ws, p, q };
  put(s, 'land', 8, 6, 'E');
  Object.assign(q, { map: 'land', x: 12, y: 6, facing: 'W' });
  [p, q].forEach(pl => [['hammer', 1], ['wood', 60], ['nails', 40], ['cloth', 10]].forEach(g => World.give(c, pl, g[0], g[1], [])));
  return s;
}
const landMap = (s) => { World.syncEdges(s.c, s.ws, 'land'); return World.liveMap(s.c, s.ws, 'land'); };
const actAs = (s, who, a) => { clock += 5000; return texts(World.act(s.c, s.ws, who, a, clock, mid, [s.p, s.q])); };
const finish = (s, who, target) => { for (let i = 0; i < 8; i++) actAs(s, who, { type: 'work', target }); };
function claimed(s) {                                   // Builder plants a flag at (9,6): radius 6 -> x 3..15, y 0..12
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 9, y: 6 }), /frame of a claim flag/);
  const flag = landMap(s).entities.filter(e => e.ref === 'obj_claim')[0];
  finish(s, s.p, { t: 'ent', key: flag.key });
  return flag;
}

test('a claim flag makes the land around it yours: others cannot build there, nor claim next to it', () => {
  const s = land(), flag = claimed(s);
  assert.deepStrictEqual([flag.owner, flag.members, s.p.claims], ['Builder', [], [{ map: 'land', key: flag.key }]]);
  assert.strictEqual(World.claimAt(s.c, landMap(s), 15, 12), flag);
  assert.strictEqual(World.claimAt(s.c, landMap(s), 16, 6), null);
  assert.ok(World.mayUse(s.c, landMap(s), s.p, 10, 6) && !World.mayUse(s.c, landMap(s), s.q, 10, 6));
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 12, y: 6, side: 'N' }), /This land belongs to Builder/);
  s.q.x = 16;
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 16, y: 6, side: 'W' }), /This land belongs to Builder/, 'a wall on the border touches claimed land');
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 17, y: 6, side: 'N' }), /frame of a wooden wall/, 'outside it, anyone builds');
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_claim', x: 17, y: 7 }), /Too close to another base/);
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 8, y: 5 }), /You already have a base/);
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' }), /frame of a wooden wall/, 'the owner builds at home');
});

test('a claim cannot swallow the map\'s own chests, the arrival point, or what someone else built', () => {
  const s = land();
  put(s, 'land', 21, 3, 'E');
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 22, y: 3 }), /Too close to the wooden chest/);
  put(s, 'land', 22, 10, 'E');
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 23, y: 11 }), /Too close to where people arrive/);
  s.q.x = 12;
  actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 12, y: 6, side: 'N' });
  put(s, 'land', 8, 6, 'E');
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 9, y: 6 }), /Someone else has built here/);
});

test('inside a base only its people open what was built, take it apart or damage it; members are added by name', () => {
  const s = land(), flag = claimed(s);
  actAs(s, s.p, { type: 'build', bp: 'bp_crate', x: 8, y: 5 });
  const crate = landMap(s).entities.filter(e => e.ref === 'obj_crate')[0], cT = { t: 'ent', key: crate.key };
  finish(s, s.p, cT);
  actAs(s, s.p, { type: 'store', key: crate.key, op: 'put', item: 'wood', qty: 5 });
  Object.assign(s.q, { x: 9, y: 5, facing: 'W' });
  assert.match(actAs(s, s.q, { type: 'interact', x: 8, y: 5 }), /belongs to Builder's base/);
  assert.match(actAs(s, s.q, { type: 'store', key: crate.key, op: 'take', item: 'wood', qty: 5 }), /belongs to Builder's base/);
  assert.strictEqual(crate.inv.wood, 5);
  assert.match(actAs(s, s.q, { type: 'dismantle', target: cT }), /not yours to take apart/);
  actAs(s, s.q, { type: 'attack', x: 8, y: 5 });
  assert.strictEqual(World.structInfo(s.c, landMap(s), cT).hp, 30, 'a raider\'s blows do nothing');
  const labels = World.actionsAt(s.c, landMap(s), World.viewLookup(s.c, landMap(s), World.view(s.c, s.ws, 'land', s.q, [s.p, s.q], -1), s.q), s.q, 8, 5).map(a => a.label);
  assert.ok(!labels.some(l => /Attack|Take/.test(l)), 'and the menu does not offer what would be refused: ' + labels);
  assert.match(actAs(s, s.q, { type: 'interact', x: 9, y: 6 }), /This is Builder's base\.$/);
  // members
  assert.match(actAs(s, s.q, { type: 'claim', key: flag.key, op: 'add', name: 'Raider' }), /Only Builder can do that/);
  let ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 9, y: 6 }, clock += 5000, mid, [s.p, s.q]);
  assert.ok(ev.some(e => e.type === 'claim' && e.mine && e.radius === 6), 'the owner gets the members panel');
  assert.match(actAs(s, s.p, { type: 'claim', key: flag.key, op: 'add', name: 'Nobody' }), /No one called "Nobody" is here/);
  assert.match(actAs(s, s.p, { type: 'claim', key: flag.key, op: 'add', name: 'raider' }), /Raider is now a member/);
  assert.deepStrictEqual(flag.members, [{ id: 'p2', name: 'Raider' }]);
  ev = World.act(s.c, s.ws, s.q, { type: 'interact', x: 8, y: 5 }, clock += 5000, mid, [s.p, s.q]);
  assert.ok(ev.some(e => e.type === 'storage'), 'a member opens the crate');
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 9, y: 5, side: 'N' }), /frame of a wooden wall/, 'and builds');
  assert.match(actAs(s, s.q, { type: 'dismantle', target: { t: 'ent', key: flag.key } }), /not yours to take apart/, 'but the flag is the owner\'s alone');
  actAs(s, s.p, { type: 'claim', key: flag.key, op: 'remove', id: 'p2' });
  assert.match(actAs(s, s.q, { type: 'interact', x: 8, y: 5 }), /belongs to Builder's base/, 'removed: locked out again');
});

test('outside a base anything built can be knocked down by anyone; pvp_structures opens bases to raids', () => {
  let s = land();
  put(s, 'land', 20, 6, 'N');
  actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 20, y: 6, side: 'N' });
  const W = { t: 'wall', orient: 'h', x: 20, y: 6 };
  finish(s, s.p, W);
  Object.assign(s.q, { x: 20, y: 5, facing: 'S' });
  actAs(s, s.q, { type: 'attack', x: 20, y: 6 });
  assert.ok(World.structInfo(s.c, landMap(s), W).hp < 40, 'no claim covers it: it takes the blow');
  assert.match(actAs(s, s.q, { type: 'dismantle', target: W }), /not yours to take apart/, 'but only its builder gets the materials back');
  s = land({ pvp_structures: 'on' });
  claimed(s);
  actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' });
  const H = { t: 'wall', orient: 'h', x: 8, y: 6 };
  finish(s, s.p, H);
  Object.assign(s.q, { x: 8, y: 5, facing: 'S' });
  actAs(s, s.q, { type: 'attack', x: 8, y: 6 });
  assert.ok(World.structInfo(s.c, landMap(s), H).hp < 40, 'with raids on, a base wall can be damaged');
  assert.match(actAs(s, s.q, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 5, side: 'N' }), /This land belongs to Builder/, 'though still not built on');
});

test('a destroyed claim dissolves: what stood there is nobody\'s, and its owner may claim again', () => {
  const s = land(), flag = claimed(s);
  actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' });
  const H = { t: 'wall', orient: 'h', x: 8, y: 6 };
  finish(s, s.p, H);
  World.damageStructure(s.c, s.ws, 'land', { t: 'ent', key: flag.key }, 999, { kind: 'monster', now: clock }, []);
  assert.strictEqual(World.claimAt(s.c, landMap(s), 9, 6), null);
  assert.strictEqual(World.structInfo(s.c, landMap(s), H).by, null);
  Object.assign(s.q, { x: 8, y: 5, facing: 'S' });
  assert.match(actAs(s, s.q, { type: 'dismantle', target: H }), /You take the wooden wall apart/, 'anyone may clear it away');
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 9, y: 6 }), /frame of a claim flag/);
  assert.strictEqual(s.p.claims.length, 1, 'the dead claim no longer counts');
  // taking your own flag apart frees the slot too
  const f2 = landMap(s).entities.filter(e => e.ref === 'obj_claim')[0];
  assert.match(actAs(s, s.p, { type: 'dismantle', target: { t: 'ent', key: f2.key } }), /You take the claim flag apart/);
  assert.deepStrictEqual(s.p.claims, []);
});

// ---- item types (Content Studio → Item Types): what an item can do comes from its type's ticks
function typed(types, items) {
  const t = JSON.parse(JSON.stringify(tables));
  t.ItemTypes = (t.ItemTypes || []).filter(r => !types.some(n => n.id === r.id)).concat(types);
  items.forEach(i => t.Items.push(i));
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  return { c, ws, p };
}
const useIt = (s, id) => { clock += 1000; return texts(World.act(s.c, s.ws, s.p, { type: 'use', item: id }, clock, mid)); };

test('an item type of your own can be consumable, with a cooldown from the type or the item', () => {
  const s = typed([{ id: 'food', name: 'Food', consume: true, cooldown_s: 10 }],
    [{ id: 'apple', name: 'Apple', type: 'food', heal: 5 }, { id: 'tea', name: 'Tea', type: 'food', heal: 5, cooldown_s: 0 }]);
  assert.deepStrictEqual([s.c.items.apple.can.consume, s.c.items.apple.cooldownMs, s.c.items.tea.cooldownMs], [true, 10000, 0]);
  World.give(s.c, s.p, 'apple', 3, []); World.give(s.c, s.p, 'tea', 3, []);
  s.p.hp = 1;
  assert.match(useIt(s, 'apple'), /You use the apple/);
  assert.match(useIt(s, 'apple'), /again in 9 s/);
  assert.strictEqual(World.count(s.p, 'apple'), 2, 'a refused use spends nothing');
  assert.match(useIt(s, 'tea'), /You use the tea/, 'the cooldown is per item');
  assert.match(useIt(s, 'tea'), /You use the tea/, 'and an item can switch its type\'s cooldown off');
  clock += 10000;
  assert.match(useIt(s, 'apple'), /You use the apple/);
  assert.ok(World.beltItems(s.c, s.p).indexOf('apple') >= 0, 'it belongs on the belt like any consumable');
});

test('unticking a behaviour on a type takes it away from its items; equip uses the type\'s slot', () => {
  const s = typed([{ id: 'consumable', name: 'Consumable', consume: false }, { id: 'hat', name: 'Hat', equip: true, slot: 'helm' }, { id: 'trinket', name: 'Trinket' }],
    [{ id: 'pill', name: 'Pill', type: 'consumable', heal: 5 }, { id: 'cap', name: 'Cap', type: 'hat', def: 1 }, { id: 'ring', name: 'Ring', type: 'trinket', slot: 'finger' }]);
  ['pill', 'cap', 'ring'].forEach(i => World.give(s.c, s.p, i, 1, []));
  s.p.hp = 1;
  assert.match(useIt(s, 'pill'), /can't use that/);
  assert.match(useIt(s, 'cap'), /You equip the cap/);
  assert.strictEqual(s.p.equipment.helm, 'cap');
  assert.match(useIt(s, 'ring'), /can't use that/, 'a type that cannot be equipped ignores an item\'s slot');
});

test('with no ItemTypes tab, and for content built before item types, the old type names still decide', () => {
  const t = JSON.parse(JSON.stringify(tables)); delete t.ItemTypes;
  const c = Content.build(t);
  const some = k => Object.keys(c.items).filter(id => c.items[id].type === k)[0];
  assert.ok(c.items[some('consumable')].can.consume && c.items[some('throwable')].can.throw && c.items[some('weapon')].can.shoot && c.items[some('weapon')].can.equip);
  assert.ok(!c.items[some('weapon')].can.consume);
  assert.ok(World.itemCan({ type: 'consumable' }, 'consume') && World.itemCan({ type: 'throwable' }, 'throw') && World.itemCan({ type: 'armor', slot: 'armor' }, 'equip'));
  assert.ok(!World.itemCan({ type: 'material' }, 'consume') && !World.itemCan(null, 'equip'));
});

test('a type\'s own properties reach its items, with the type\'s default unless the item sets one', () => {
  const s = typed([{ id: 'food', name: 'Food', consume: true, properties: JSON.stringify([{ name: 'spoils_after_h', type: 'number', def: 24 }, { name: 'cooked', type: 'bool', def: false }]) }],
    [{ id: 'apple', name: 'Apple', type: 'food' }, { id: 'stew', name: 'Stew', type: 'food', props: JSON.stringify({ cooked: true }) }]);
  assert.deepStrictEqual(s.c.items.apple.props, { spoils_after_h: 24, cooked: false });
  assert.deepStrictEqual(s.c.items.stew.props, { spoils_after_h: 24, cooked: true });
});

test('a N-S wall can be built to one side of its line and moved later; only its looks change', () => {
  const s = land();
  put(s, 'land', 20, 6, 'W');
  assert.match(actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 20, y: 6, side: 'W', off: 'r' }), /frame of a wooden wall/);
  const V = { t: 'wall', orient: 'v', x: 20, y: 6 };
  finish(s, s.p, V);
  assert.strictEqual(landMap(s).vWalls[6][20], 'wall_wood:2:r');
  assert.ok(Rules.edgeBlocked(s.c, landMap(s), 'v', 20, 6, 'move'), 'it still blocks on the grid line');
  const menu = who => World.actionsAt(s.c, landMap(s), World.viewLookup(s.c, landMap(s), World.view(s.c, s.ws, 'land', who, [s.p, s.q], -1), who), who, 19, 6).map(a => a.label);
  assert.deepStrictEqual(menu(s.p).filter(l => /^Move/.test(l)), ['Move the wooden wall left', 'Move the wooden wall to the middle']);
  assert.match(actAs(s, s.p, { type: 'shift', target: V, off: 'l' }), /You move the wooden wall to the left/);
  assert.strictEqual(landMap(s).vWalls[6][20], 'wall_wood:2:l');
  actAs(s, s.p, { type: 'shift', target: V, off: '' });
  assert.strictEqual(landMap(s).vWalls[6][20], 'wall_wood:2');
  // someone else may not move it, and is not offered to
  Object.assign(s.q, { x: 19, y: 6, facing: 'E' });
  assert.match(actAs(s, s.q, { type: 'shift', target: V, off: 'r' }), /not yours to move/);
  assert.ok(!menu(s.q).some(l => /^Move/.test(l)));
  // an E-W wall has no side to move to, and ignores one at building
  put(s, 'land', 22, 6, 'N');
  actAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 22, y: 6, side: 'N', off: 'r' });
  assert.strictEqual(landMap(s).hWalls[6][22], 'wall_wood:2');
  assert.match(actAs(s, s.p, { type: 'shift', target: { t: 'wall', orient: 'h', x: 22, y: 6 }, off: 'r' }), /running north to south/);
});

// ---- objects that can be turned: one object, pictures for the other directions, blocked sides turn with it
function chairs() {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(12).fill('til_1');
  t.Maps.push({ id: 'room', name: 'Room', width: 12, height: 9, terrain: JSON.stringify(Array(9).fill(row)), spawn: JSON.stringify({ x: 11, y: 8 }) });
  t.Objects.push({ id: 'obj_chair', name: 'Chair', kind: 'deco', sprite: 'chair_s.png', sprite_states: 'north=chair_n.png; side=chair_e.png', walkable: true,
    properties: JSON.stringify({ hp: 10, material: 'wood', pass_n: false }) });           // facing south, its back (north) is shut
  t.Objects.push({ id: 'obj_stool', name: 'Stool', kind: 'deco', sprite: 'stool.png', sprite_states: '', walkable: true, properties: JSON.stringify({ hp: 10, material: 'wood' }) });
  t.Blueprints.push({ id: 'bp_chair', name: 'Chair', category: 'furniture', places: 'object', object: 'obj_chair', cost: 'wood:1', work: 0, tool: '' });
  t.Blueprints.push({ id: 'bp_stool', name: 'Stool', category: 'furniture', places: 'object', object: 'obj_stool', cost: 'wood:1', work: 0, tool: '' });
  t.MapEntities.push({ map: 'room', key: 'room.e1', x: 2, y: 2, ref: 'obj_chair', data: JSON.stringify({ facing: 'W' }) });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Builder', 'warrior'), q = World.newPlayer(c, 'p2', 'Other', 'warrior');
  const s = { c, ws, p, q };
  put(s, 'room', 6, 4, 'E');
  Object.assign(q, { map: 'room', x: 10, y: 8, facing: 'W' });
  World.give(c, p, 'wood', 20, []);
  return s;
}
const roomMap = s => { World.syncEdges(s.c, s.ws, 'room'); return World.liveMap(s.c, s.ws, 'room'); };
const roomAct = (s, who, a) => { clock += 5000; return texts(World.act(s.c, s.ws, who, a, clock, mid, [s.p, s.q])); };

test('a turnable object shows the picture for the way it faces, and its blocked sides turn with it', () => {
  const s = chairs(), chair = s.c.objects.obj_chair;
  assert.ok(Rules.turnable(chair) && !Rules.turnable(s.c.objects.obj_stool));
  assert.deepStrictEqual(['S', 'W', 'N', 'E'].map(f => Rules.facingSprite(chair, f)),
    [{ path: 'chair_s.png', flip: false }, { path: 'chair_e.png', flip: true }, { path: 'chair_n.png', flip: false }, { path: 'chair_e.png', flip: false }]);
  assert.deepStrictEqual([Rules.nextFacing('S', 1), Rules.nextFacing('W', 1), Rules.nextFacing('E', 1), Rules.nextFacing('S', -1)], ['W', 'N', 'S', 'E']);
  assert.deepStrictEqual(['down', 'left', 'side', '', 'N'].map(f => Rules.facingOf({ data: { facing: f } })), ['S', 'W', 'E', 'S', 'N'], 'older words still read');
  // facing south the back is north; a quarter turn clockwise (facing west) puts the back to the east
  const shut = f => { const ps = Rules.passOf(chair, { data: { facing: f } }); return Object.keys(ps).filter(k => !ps[k]).join(''); };
  assert.deepStrictEqual([shut('S'), shut('W'), shut('N'), shut('E')], ['n', 'e', 's', 'w']);
  // the authored chair at (2,2) faces west: you cannot step onto it from the east, nor off it to the east
  const m = roomMap(s);
  assert.strictEqual(Rules.tryMove(s.c, m, 3, 2, 'W').ok, false);
  assert.strictEqual(Rules.tryMove(s.c, m, 2, 2, 'E').ok, false);
  assert.ok(Rules.tryMove(s.c, m, 2, 1, 'S').ok && Rules.tryMove(s.c, m, 2, 2, 'N').ok, 'its north side is open now');
});

test('players place a turnable object the way they chose, and turn it afterwards; others may not', () => {
  const s = chairs();
  assert.match(roomAct(s, s.p, { type: 'build', bp: 'bp_chair', x: 7, y: 4, facing: 'N' }), /You build|Chair|chair/);
  const chair = roomMap(s).entities.filter(e => e.ref === 'obj_chair' && e.x === 7)[0], T = { t: 'ent', key: chair.key };
  assert.strictEqual(chair.data.facing, 'N');
  assert.strictEqual(Rules.tryMove(s.c, roomMap(s), 7, 5, 'N').ok, false, 'facing north, its back is to the south');
  const menu = who => World.actionsAt(s.c, roomMap(s), World.viewLookup(s.c, roomMap(s), World.view(s.c, s.ws, 'room', who, [s.p, s.q], -1), who), who, 7, 4).map(a => a.label);
  assert.ok(menu(s.p).indexOf('Turn the chair') >= 0);
  assert.match(roomAct(s, s.p, { type: 'turn', target: T }), /You turn the chair/);
  assert.strictEqual(chair.data.facing, 'E', 'a quarter turn clockwise from north');
  roomAct(s, s.p, { type: 'turn', target: T });
  assert.strictEqual(chair.data.facing, undefined, 'back to south, the way it was drawn');
  roomAct(s, s.p, { type: 'turn', target: T, facing: 'W' });
  assert.strictEqual(chair.data.facing, 'W');
  Object.assign(s.q, { x: 7, y: 3, facing: 'S' });
  assert.match(roomAct(s, s.q, { type: 'turn', target: T }), /not yours to turn/);
  assert.ok(menu(s.q).indexOf('Turn the chair') < 0);
  // something with one picture has no other way to face
  roomAct(s, s.p, { type: 'build', bp: 'bp_stool', x: 6, y: 5, facing: 'N' });
  const stool = roomMap(s).entities.filter(e => e.ref === 'obj_stool')[0];
  assert.strictEqual(stool.data.facing, undefined);
  assert.match(roomAct(s, s.p, { type: 'turn', target: { t: 'ent', key: stool.key } }), /can't be turned/);
  assert.match(roomAct(s, s.p, { type: 'turn', target: { t: 'ent', key: 'room.e1' } }), /can't be turned/, 'nor can what the map came with');
});

// ---- walking: the referee's speed limit, and diagonal steps
// An open field with one wall corner in it: a wall along the north of (5,5) and one along its east side.
function field(cfg) {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(14).fill('til_1'), H = 12;
  const hW = Array.from({ length: H + 1 }, () => Array(14).fill('')), vW = Array.from({ length: H }, () => Array(15).fill(''));
  hW[5][5] = 'wall_wood:2'; vW[5][6] = 'wall_wood:2';
  t.Maps.push({ id: 'field', name: 'Field', width: 14, height: H, terrain: JSON.stringify(Array(H).fill(row)), hWalls: JSON.stringify(hW), vWalls: JSON.stringify(vW), spawn: JSON.stringify({ x: 13, y: 11 }) });
  t.Objects.push({ id: 'obj_block', name: 'Block', kind: 'deco', sprite: '', walkable: false, properties: '' });
  t.MapEntities.push({ map: 'field', key: 'field.e1', x: 9, y: 8, ref: 'obj_block', data: '' });
  t.MapEntities.push({ map: 'field', key: 'field.e2', x: 11, y: 9, ref: 'obj_0', data: '' });       // a chest, for reaching diagonally
  t.Config = t.Config.filter(r => r.key !== 'move_burst' && r.key !== 'move_ms').concat(Object.keys(cfg || {}).map(k => ({ key: k, value: cfg[k] })));
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Walker', 'warrior');
  const s = { c, ws, p };
  put(s, 'field', 2, 2, 'S');
  return s;
}
const walk = (s, dirs, at) => { World.act(s.c, s.ws, s.p, { type: 'move', dirs }, at, mid, [s.p]); return [s.p.x, s.p.y]; };

test('the referee limits walking speed: a burst, then one step per move_ms, whatever the page sends', () => {
  const s = field({ move_ms: 100, move_burst: 4 });
  assert.deepStrictEqual(walk(s, Array(20).fill('E'), 10000), [6, 2], 'twenty steps asked for, the burst of four given');
  assert.deepStrictEqual(walk(s, Array(20).fill('E'), 10000), [6, 2], 'asking again at once gives nothing');
  assert.deepStrictEqual(walk(s, Array(20).fill('E'), 10085), [7, 2], 'one more step once its time has passed');
  assert.deepStrictEqual(walk(s, ['E', 'E', 'E'], 10600), [10, 2], 'an honest batch that waited its turn goes through whole');
  // a diagonal covers more ground, so it costs more: 1.4 steps
  const d = field({ move_ms: 100, move_burst: 4 });
  assert.deepStrictEqual(walk(d, Array(10).fill('SE'), 10000), [4, 4], 'four steps of budget pay for two diagonals (2.8), not three');
  // turning on the spot and walking into something cost nothing, and time away does not pile up past the burst
  const w = field({ move_ms: 100, move_burst: 4 });
  put(w, 'field', 0, 0, 'S');
  walk(w, Array(10).fill('W'), 10000);
  assert.deepStrictEqual(walk(w, Array(20).fill('E'), 10000), [4, 0], 'bumping the map edge spent none of the budget');
  assert.deepStrictEqual(walk(w, Array(20).fill('E'), 99999), [8, 0], 'a long rest refills to the burst, no further');
});

test('diagonal steps: allowed in the open, never round a corner or onto something, facing stays four-way', () => {
  const s = field({ move_burst: 999 });
  assert.deepStrictEqual(walk(s, ['SE', 'NE', 'NW', 'SW'], 1000), [2, 2], 'all four diagonals, there and back');
  assert.strictEqual(s.p.facing, 'W', 'the last two (NW, SW) both agree with facing west, so it is kept');
  walk(s, ['NE'], 2000);
  assert.strictEqual(s.p.facing, 'E', 'else it looks sideways');
  // the corner at (5,5): wall on its north side and on its east side
  const m = World.liveMap(s.c, s.ws, 'field');
  const go = (x, y, dir) => Rules.tryMove(s.c, m, x, y, dir);
  assert.strictEqual(go(5, 5, 'NE').ok, false, 'from inside the corner: both ways round are walled');
  assert.strictEqual(go(6, 4, 'SW').ok, false, 'nor back in from outside');
  assert.strictEqual(go(5, 5, 'NW').ok, false, 'one way round is walled (north): refused even though the other is open');
  assert.strictEqual(go(5, 5, 'SE').ok, false, 'likewise past the east wall');
  assert.ok(go(5, 5, 'SW').ok && go(4, 6, 'NE').ok, 'the open corner of the same cell is fine');
  assert.strictEqual(go(5, 5, 'NE').corner, true);
  // a solid object: not onto it, and not squeezing past its corner
  assert.strictEqual(go(8, 7, 'SE').ok, false, 'onto the block');
  assert.strictEqual(go(8, 8, 'NE').ok, false, 'past its corner (the block is one of the two ways round)');
  assert.ok(go(8, 9, 'NE').ok === false && go(10, 9, 'NW').ok === false);
  assert.ok(go(7, 7, 'SE').ok, 'a diagonal that only touches the block corner to corner is fine');
  // the map edge, and a creature in the way
  assert.strictEqual(go(0, 0, 'NW').ok, false);
  const occ = { occupied: (x, y) => (x === 3 && y === 3 ? { monster: { id: 'm1' } } : x === 2 && y === 3 ? { monster: { id: 'm2' } } : null) };
  assert.strictEqual(Rules.tryMove(s.c, m, 2, 2, 'SE', occ).reason, 'occupied', 'the landing cell must be free');
  assert.ok(Rules.tryMove(s.c, m, 1, 2, 'SE', { occupied: (x, y) => (x === 1 && y === 3 ? { monster: {} } : null) }).ok, 'a creature beside the path is not a wall');
  assert.deepStrictEqual([Rules.stepCost('N'), Rules.stepCost('SW'), Rules.isDir('NE'), Rules.isDir('X')], [1, 1.4, true, false]);
});

test('a monster chasing you cuts corners the same way, and walking into one diagonally is not an attack', () => {
  const s = field({ move_burst: 999 });
  World.advance(s.c, s.ws, 'field', [s.p], 1000, mid, []);
  const ms = World.mapState(s.ws, 'field'), ref = Object.keys(s.c.monsters)[0], def = s.c.monsters[ref];
  def.aggro = 10;                                                     // make sure it notices the player from afar
  ms.monsters.push({ id: 'field.m1', ref, x: 3, y: 3, hp: def.hp, last: 1000, facing: 'S', spawn: '' });
  const hp0 = ms.monsters[0].hp;
  World.act(s.c, s.ws, s.p, { type: 'move', dirs: ['SE'] }, 1000, mid, [s.p]);
  assert.deepStrictEqual([s.p.x, s.p.y, ms.monsters[0].hp], [2, 2, hp0], 'blocked by the monster, and no blow struck');
  put(s, 'field', 6, 0, 'S');                                         // far away, straight up a diagonal from (3,3)
  World.advance(s.c, s.ws, 'field', [s.p], 1000 + def.moveMs + 1, mid, []);
  const mo = ms.monsters[0];
  assert.deepStrictEqual([mo.x, mo.y], [4, 2], 'it steps diagonally toward its target');
});

// ---- reaching diagonally: using and hitting what is on any of the eight tiles around you
test('you can hit and use things diagonally, but never round the end of a wall', () => {
  const s = field({ move_burst: 999 });
  World.advance(s.c, s.ws, 'field', [s.p], 1000, mid, []);
  const ms = World.mapState(s.ws, 'field'), ref = Object.keys(s.c.monsters)[0], def = s.c.monsters[ref];
  const mon = (id, x, y) => { const m = { id, ref, x, y, hp: 9999, last: 9e12, facing: 'S', spawn: '' }; ms.monsters.push(m); return m; };
  const say = a => { clock += 5000; return texts(World.act(s.c, s.ws, s.p, a, clock, mid, [s.p])); };
  const m = World.liveMap(s.c, s.ws, 'field');
  // the wall corner at (5,5): walls on its north and east sides
  assert.deepStrictEqual([[6, 4], [4, 4], [6, 6], [4, 6]].map(q => Rules.reachBlocked(s.c, m, 5, 5, q[0], q[1])), [true, true, true, false],
    'three of its diagonals pass a wall end; only the south-west one is clear');
  assert.strictEqual(Rules.reachBlocked(s.c, m, 5, 5, 5, 4), true);
  assert.strictEqual(Rules.reachBlocked(s.c, m, 5, 5, 5, 6), false);
  // melee
  const open = mon('field.m1', 3, 3), behind = mon('field.m2', 6, 4);
  put(s, 'field', 2, 2, 'S');
  assert.match(say({ type: 'attack', x: 3, y: 3 }), /You hit the/);
  assert.ok(open.hp < 9999);
  put(s, 'field', 5, 5, 'S');
  assert.match(say({ type: 'attack', x: 6, y: 4 }), /A wall is in the way/);
  assert.strictEqual(behind.hp, 9999);
  put(s, 'field', 1, 1, 'S');
  assert.match(say({ type: 'attack', x: 3, y: 3 }), /Too far away/, 'two tiles off is still out of reach');
  // a solid object on the diagonal can be struck, and things can be used from the diagonal
  put(s, 'field', 8, 7, 'S');
  const acts = World.actionsAt(s.c, m, World.viewLookup(s.c, m, World.view(s.c, s.ws, 'field', s.p, [s.p], -1), s.p), s.p, 10, 8).map(a => a.label);
  assert.ok(Array.isArray(acts));
  put(s, 'field', 10, 8, 'S');
  assert.match(say({ type: 'interact', x: 11, y: 9 }), /^(?!.*Too far away)/, 'the chest at (11,9) is in reach from (10,8)');
  assert.ok(World.actionsAt(s.c, m, World.viewLookup(s.c, m, World.view(s.c, s.ws, 'field', s.p, [s.p], -1), s.p), s.p, 11, 9).length > 0);
  put(s, 'field', 9, 7, 'S');
  assert.match(say({ type: 'interact', x: 11, y: 9 }), /Too far away/);
});

test('a monster beside you diagonally attacks instead of shuffling round, unless a wall end is between', () => {
  const s = field({ move_burst: 999 });
  World.advance(s.c, s.ws, 'field', [s.p], 1000, mid, []);
  const ms = World.mapState(s.ws, 'field'), ref = Object.keys(s.c.monsters)[0], def = s.c.monsters[ref];
  def.aggro = 10;
  const mo = { id: 'field.m1', ref, x: 3, y: 3, hp: def.hp, last: 1000, facing: 'S', spawn: '' };
  ms.monsters.push(mo);
  put(s, 'field', 2, 2, 'S');
  const hp0 = s.p.hp, ev = [];
  World.advance(s.c, s.ws, 'field', [s.p], 1000 + def.moveMs + 1, mid, ev);
  assert.ok(s.p.hp < hp0 && /hits you/.test(texts(ev)), 'it strikes from the diagonal');
  assert.deepStrictEqual([mo.x, mo.y], [3, 3], 'without moving first');
  // across the wall corner it cannot: it has to walk round
  s.p.hp = hp0; Object.assign(mo, { x: 6, y: 4, last: 50000 });
  put(s, 'field', 5, 5, 'S');
  World.advance(s.c, s.ws, 'field', [s.p], 50000 + def.moveMs + 1, mid, []);
  assert.strictEqual(s.p.hp, hp0, 'no blow through the corner');
});

// ---- floors (docs/FLOORS.md): a multi-storey map is a ground map plus one map per floor
function tower() {
  const t = JSON.parse(JSON.stringify(tables));
  const full = Array(8).fill(Array(8).fill('til_1'));
  const upper = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (x >= 2 && x <= 5 && y >= 2 && y <= 5 ? 'til_1' : '')));   // a 4x4 floor in the air
  const tp = Object.keys(Content.build(tables).objects).filter(k => Content.build(tables).objects[k].kind === 'teleport')[0];
  t.Maps.push({ id: 'tower', name: 'Tower', width: 8, height: 8, terrain: JSON.stringify(full), spawn: JSON.stringify({ x: 0, y: 0 }) });
  t.Maps.push({ id: 'tower_z1', name: 'Tower', width: 8, height: 8, terrain: JSON.stringify(upper), floor_of: 'tower', z: 1 });
  t.Maps.push({ id: 'tower_zm1', name: 'Tower', width: 8, height: 8, terrain: JSON.stringify(upper), floor_of: 'tower', z: -1 });
  t.Maps.push({ id: 'orphan', name: 'Orphan', width: 8, height: 8, terrain: JSON.stringify(full), floor_of: 'nowhere', z: 3 });
  t.Maps.push({ id: 'twin', name: 'Twin', width: 8, height: 8, terrain: JSON.stringify(full), floor_of: 'tower', z: 1 });          // level 1 is taken
  t.MapEntities.push({ map: 'tower', key: 'tower.e1', x: 3, y: 3, ref: tp, data: JSON.stringify({ target: 'tower_z1:3:4' }) });      // a ladder up
  t.MapEntities.push({ map: 'tower_z1', key: 'tower_z1.e1', x: 3, y: 3, ref: tp, data: JSON.stringify({ target: 'tower:3:4' }) });   // and down
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Climber', 'warrior');
  return { c, ws, p };
}

test('the floors of a building are tied together; a floor with no ground map, or a taken level, is a plain map', () => {
  const s = tower(), m = s.c.maps;
  assert.deepStrictEqual([m.tower.z, m.tower.floorOf, m.tower_z1.z, m.tower_z1.floorOf, m.tower_zm1.z], [0, '', 1, 'tower', -1]);
  assert.deepStrictEqual(m.tower.floors, { 0: 'tower', 1: 'tower_z1', '-1': 'tower_zm1' });
  assert.strictEqual(m.tower_z1.floors, m.tower.floors, 'one family object for all of them');
  assert.deepStrictEqual([m.orphan.z, m.orphan.floorOf, m.twin.z, m.twin.floorOf], [0, '', 0, '']);
  assert.deepStrictEqual(World.floorsOf(s.c, 'tower_z1'), [{ z: -1, id: 'tower_zm1' }, { z: 0, id: 'tower' }, { z: 1, id: 'tower_z1' }]);
  assert.deepStrictEqual([World.groundId(s.c, 'tower_zm1'), World.floorId(s.c, 'tower', 1), World.floorId(s.c, 'tower_z1', 0), World.floorId(s.c, 'tower', 2)],
    ['tower', 'tower_z1', 'tower', '']);
  assert.deepStrictEqual(World.floorsOf(s.c, 'map_3'), [{ z: 0, id: 'map_3' }], 'a map without floors is its own ground');
  assert.deepStrictEqual([World.groundId(s.c, 'map_3'), World.floorId(s.c, 'map_3', 0), World.floorId(s.c, 'map_3', 1)], ['map_3', 'map_3', '']);
  // linking again changes nothing
  Content.linkFloors(s.c);
  assert.deepStrictEqual(m.tower.floors, { 0: 'tower', 1: 'tower_z1', '-1': 'tower_zm1' });
});

test('a floor is a map: you cannot walk onto open air, and a teleport takes you between floors', () => {
  const s = tower();
  put(s, 'tower_z1', 2, 2, 'W');
  act(s, { type: 'move', dirs: ['W', 'N'] });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['tower_z1', 2, 2], 'no floor to the west or north: you stay');
  // wherever the step-on teleport left us, the ladder links the two floors both ways
  put(s, 'tower', 2, 3, 'E');
  act(s, { type: 'interact' });
  if (s.p.map === 'tower') act(s, { type: 'move', dirs: ['E'] });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['tower_z1', 3, 4], 'up the ladder');
  const v = World.view(s.c, s.ws, s.p.map, s.p, [s.p]);
  assert.ok(v && s.c.maps[s.p.map].z === 1, 'the view is that floor\'s');
  put(s, 'tower_z1', 2, 3, 'E');
  act(s, { type: 'interact' });
  if (s.p.map === 'tower_z1') act(s, { type: 'move', dirs: ['E'] });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['tower', 3, 4], 'and back down');
});

test('a floor that lost its floor fields (saved through an older referee) is taken back into its building', () => {
  const t = JSON.parse(JSON.stringify(tables));
  const g8 = JSON.stringify(Array(8).fill(Array(8).fill('til_1'))), g6 = JSON.stringify(Array(6).fill(Array(6).fill('til_1')));
  t.Maps.push({ id: 'keep', name: 'Keep', width: 8, height: 8, terrain: g8 });
  t.Maps.push({ id: 'keep_z1', name: 'Keep', width: 8, height: 8, terrain: g8 });               // no floor_of, no z: as the old referee stores it
  t.Maps.push({ id: 'keep_zm2', name: 'Keep', width: 8, height: 8, terrain: g8 });
  t.Maps.push({ id: 'keep_z3', name: 'Keep', width: 6, height: 6, terrain: g6 });               // another size: not a floor of it
  t.Maps.push({ id: 'ghost_z1', name: 'Ghost', width: 8, height: 8, terrain: g8 });             // no such ground map
  t.Maps.push({ id: 'keep_z1_z1', name: 'Odd', width: 8, height: 8, terrain: g8 });             // its "ground" is itself a floor
  const m = Content.build(t).maps;
  assert.deepStrictEqual(m.keep.floors, { 0: 'keep', 1: 'keep_z1', '-2': 'keep_zm2' });
  assert.deepStrictEqual([m.keep_z1.floorOf, m.keep_z1.z, m.keep_zm2.z], ['keep', 1, -2]);
  assert.deepStrictEqual([m.keep_z3.floorOf, m.ghost_z1.floorOf, m.keep_z1_z1.floorOf], ['', '', '']);
  assert.deepStrictEqual(m.map_3.floors, { 0: 'map_3' }, 'ordinary maps are untouched');
});

// ---- staircases (docs/FLOORS.md §4.2): walk up a run on one floor, arrive on the floor above
// Ground 'hall' 10x10. A staircase with its foot at (4,6) climbing north for 2 tiles: run (4,6),(4,5), landing (4,4)
// upstairs. Upstairs is a floor over x 2..7, y 1..6 with the stairwell — (4,6) and (4,5) — left open.
function hall(facing, mutate) {
  const t = JSON.parse(JSON.stringify(tables));
  const full = Array(10).fill(Array(10).fill('til_1'));
  const upper = Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => (x >= 2 && x <= 7 && y >= 1 && y <= 6 && !(x === 4 && (y === 6 || y === 5)) ? 'til_1' : '')));
  t.Objects.push({ id: 'obj_stairs', name: 'Stairs', kind: 'stairs', sprite: '', walkable: false, properties: JSON.stringify({ length: 2 }) });
  t.Maps.push({ id: 'hall', name: 'Hall', width: 10, height: 10, terrain: JSON.stringify(full), spawn: JSON.stringify({ x: 0, y: 9 }) });
  t.Maps.push({ id: 'hall_z1', name: 'Hall', width: 10, height: 10, terrain: JSON.stringify(upper), floor_of: 'hall', z: 1 });
  t.MapEntities.push({ map: 'hall', key: 'hall.e1', x: 4, y: 6, ref: 'obj_stairs', data: facing ? JSON.stringify({ facing }) : '' });
  if (mutate) mutate(t);
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Climber', 'warrior');
  const s = { c, ws, p };
  put(s, 'hall', 4, 8, 'N');
  return s;
}
const at = s => [s.p.map, s.p.x, s.p.y];
const go = (s, dirs) => { clock += 5000; World.act(s.c, s.ws, s.p, { type: 'move', dirs }, clock, mid, [s.p]); return at(s); };

test('a staircase: on at the foot, up the run, off the head onto the floor above, and back down the same way', () => {
  const s = hall();
  assert.ok(s.c.objects.obj_stairs.walkable, 'stairs are walked on whatever the object says');
  const m = s.c.maps.hall;
  assert.deepStrictEqual([Rules.stairAt(s.c, m, 4, 6).i, Rules.stairAt(s.c, m, 4, 5).i, Rules.stairAt(s.c, m, 4, 4), Rules.stairAt(s.c, m, 5, 6)], [0, 1, null, null]);
  assert.deepStrictEqual([0.01, 0.5, 0.99].map(f => Math.round(100 * Rules.stairHeight(s.c, m, 4, 6.5 - 2 * f)) / 100), [0.01, 0.5, 0.99], 'you rise evenly from the foot to the head');
  assert.strictEqual(Rules.stairHeight(s.c, m, 5, 6), 0);
  assert.deepStrictEqual(go(s, ['N', 'N']), ['hall', 4, 6], 'onto the foot');
  assert.deepStrictEqual(go(s, ['N']), ['hall', 4, 5], 'up the run');
  assert.deepStrictEqual(go(s, ['N', 'N', 'N']), ['hall_z1', 4, 4], 'off the head: the floor above, one tile on — and the batch stops there');
  assert.deepStrictEqual(go(s, ['N']), ['hall_z1', 4, 3], 'walking on upstairs');
  assert.deepStrictEqual(go(s, ['S']), ['hall_z1', 4, 4]);
  assert.deepStrictEqual(go(s, ['S']), ['hall', 4, 5], 'back into the stairwell: the head of the stairs below');
  assert.deepStrictEqual(go(s, ['S', 'S']), ['hall', 4, 7], 'down the run and off the foot');
});

test('a staircase cannot be entered or left by its sides, crossed diagonally, or climbed into a wall', () => {
  const s = hall();
  put(s, 'hall', 3, 6, 'E'); assert.deepStrictEqual(go(s, ['E']), ['hall', 3, 6], 'not onto the foot from the side');
  put(s, 'hall', 3, 5, 'E'); assert.deepStrictEqual(go(s, ['E']), ['hall', 3, 5], 'nor onto the run');
  put(s, 'hall', 4, 4, 'S'); assert.deepStrictEqual(go(s, ['S']), ['hall', 4, 4], 'nor onto its head from beyond, on the same floor');
  put(s, 'hall', 4, 5, 'N'); assert.deepStrictEqual(go(s, ['E']), ['hall', 4, 5], 'no stepping off the side');
  assert.deepStrictEqual(go(s, ['W']), ['hall', 4, 5]);
  put(s, 'hall', 3, 7, 'N'); assert.deepStrictEqual(go(s, ['NE']), ['hall', 3, 7], 'no cutting onto it diagonally');
  put(s, 'hall', 4, 5, 'N'); assert.deepStrictEqual(go(s, ['NE']), ['hall', 4, 5], 'nor off its head diagonally');
  // upstairs: the open stairwell is only a way down where the stairs come up, walking the way they descend
  put(s, 'hall_z1', 3, 5, 'E'); assert.deepStrictEqual(go(s, ['E']), ['hall_z1', 3, 5], 'not into the well from its side');
  put(s, 'hall_z1', 4, 7, 'N'); assert.strictEqual(Rules.tryMove(s.c, s.c.maps.hall_z1, 4, 7, 'N').ok, false);
  put(s, 'hall_z1', 2, 1, 'W'); assert.deepStrictEqual(go(s, ['W']), ['hall_z1', 2, 1], 'ordinary open air is still not a way down');
  // nowhere to land: no floor above the landing, or a wall across the head
  const noFloor = hall('', t => { const up = t.Maps.find(r => r.id === 'hall_z1'), g = JSON.parse(up.terrain); g[4][4] = ''; up.terrain = JSON.stringify(g); });
  put(noFloor, 'hall', 4, 5, 'N'); assert.deepStrictEqual(go(noFloor, ['N']), ['hall', 4, 5]);
  const walled = hall('', t => { const up = t.Maps.find(r => r.id === 'hall_z1'), hW = Array.from({ length: 11 }, () => Array(10).fill('')); hW[5][4] = 'wall_wood:2'; up.hWalls = JSON.stringify(hW); });
  put(walled, 'hall', 4, 5, 'N'); assert.deepStrictEqual(go(walled, ['N']), ['hall', 4, 5], 'a wall upstairs across the head of the stairs');
  put(walled, 'hall_z1', 4, 4, 'S'); assert.deepStrictEqual(go(walled, ['S']), ['hall_z1', 4, 4], 'and it stops the way down too');
  const lone = hall('', t => { t.Maps = t.Maps.filter(r => r.id !== 'hall_z1'); });
  put(lone, 'hall', 4, 5, 'N'); assert.deepStrictEqual(go(lone, ['N']), ['hall', 4, 5], 'stairs with no floor above lead nowhere');
});

test('a staircase climbs the way it was turned, and a monster with nobody to follow does not take it', () => {
  // climbing east: foot (4,6), run (5,6), landing (6,6) upstairs — give the floor above a matching stairwell
  const s = hall('E', t => { const up = t.Maps.find(r => r.id === 'hall_z1'), g = JSON.parse(up.terrain); g[6][4] = ''; g[6][5] = ''; g[5][4] = 'til_1'; up.terrain = JSON.stringify(g); });
  assert.strictEqual(Rules.stairDir(s.c.maps.hall.entities[0]), 'E');
  put(s, 'hall', 3, 6, 'E');
  assert.deepStrictEqual(go(s, ['E']), ['hall', 4, 6]);
  assert.deepStrictEqual(go(s, ['E']), ['hall', 5, 6]);
  assert.deepStrictEqual(go(s, ['E']), ['hall_z1', 6, 6]);
  assert.deepStrictEqual(go(s, ['W']), ['hall', 5, 6], 'and down again, walking west');
  put(s, 'hall', 4, 7, 'N'); assert.deepStrictEqual(go(s, ['N']), ['hall', 4, 7], 'its foot is no longer entered from the south');
  // a monster on the run chasing someone does not leave the floor
  const h = hall();
  World.advance(h.c, h.ws, 'hall', [h.p], 1000, mid, []);
  const ms = World.mapState(h.ws, 'hall'), ref = Object.keys(h.c.monsters)[0], def = h.c.monsters[ref];
  def.aggro = 20;
  const mo = { id: 'hall.m1', ref, x: 4, y: 5, hp: def.hp, last: 1000, facing: 'N', spawn: '' };
  ms.monsters.push(mo);
  put(h, 'hall', 4, 0, 'S');
  World.advance(h.c, h.ws, 'hall', [h.p], 1000 + def.moveMs * 3, mid, []);
  assert.ok(ms.monsters.indexOf(mo) >= 0 && mo.y >= 5, 'still on the ground floor, on or below the stairs');
});

test('a monster after you follows by the stairs: it leaves its floor as a guest of the next, and its spawner replaces it', () => {
  const s = hall();
  World.advance(s.c, s.ws, 'hall', [s.p], 1000, mid, []);
  const ms = World.mapState(s.ws, 'hall'), ref = Object.keys(s.c.monsters)[0], def = s.c.monsters[ref];
  def.aggro = 3;
  let now = 500000;
  const mo = { id: 'hall.m1', ref, x: 4, y: 8, hp: def.hp, last: now, facing: 'N', spawn: '', engaged: 'p1' };
  const far = { id: 'hall.m2', ref, x: 9, y: 0, hp: def.hp, last: now, facing: 'N', spawn: '' };        // minding its own business
  ms.monsters.push(mo, far);
  put(s, 'hall', 4, 5, 'N');
  World.act(s.c, s.ws, s.p, { type: 'move', dirs: ['N'] }, now, mid, [s.p]);
  assert.deepStrictEqual(at(s), ['hall_z1', 4, 4]);
  assert.deepStrictEqual([mo.follow.way, mo.follow.x, mo.follow.y, mo.follow.dir, mo.follow.who], ['up', 4, 6, 'N', 'p1'], 'the one after you is told which stairs');
  assert.strictEqual(far.follow, undefined, 'one that was not after you is not');
  assert.strictEqual(s.p.wake.map, 'hall', 'and the floor you left is kept moving for a while');
  s.p.y = 2;                                                           // you walk on upstairs
  // nobody is on the ground floor now; it still moves on, and the monster walks to the stairs and up them
  for (let i = 0; i < 10 && !(s.ws.transfers || []).length; i++) { now += def.moveMs + 1; World.advance(s.c, s.ws, 'hall', [], now, mid, []); }
  assert.strictEqual(s.ws.transfers.length, 1);
  const t = s.ws.transfers[0];
  assert.deepStrictEqual([t.map, t.monster.x, t.monster.y, t.monster.guest, t.monster.engaged, t.monster.hp], ['hall_z1', 4, 4, true, 'p1', def.hp]);
  assert.ok(mo.dead && mo.respawnAt > now && !mo.follow, 'downstairs it counts as lost: its spawner will bring another');
  assert.strictEqual(World.deliver(s.c, s.ws), 1);
  now += 10;
  World.advance(s.c, s.ws, 'hall_z1', [s.p], now, mid, []);
  const upstairs = World.mapState(s.ws, 'hall_z1').monsters;
  assert.deepStrictEqual(upstairs.map(m => [m.ref, m.guest, m.engaged]), [[ref, true, 'p1']], 'the floor above takes it in');
  // it comes back down after you the same way
  const g = upstairs[0];
  Object.assign(g, { x: 4, y: 2, last: now });
  put(s, 'hall_z1', 4, 4, 'S');
  World.act(s.c, s.ws, s.p, { type: 'move', dirs: ['S'] }, now, mid, [s.p]);
  assert.deepStrictEqual(at(s), ['hall', 4, 5]);
  assert.deepStrictEqual([g.follow.way, g.follow.x, g.follow.y, g.follow.dir], ['down', 4, 4, 'S']);
  s.p.y = 9;
  for (let i = 0; i < 10 && !(s.ws.transfers || []).length; i++) { now += def.moveMs + 1; World.advance(s.c, s.ws, 'hall_z1', [], now, mid, []); }
  assert.deepStrictEqual([s.ws.transfers[0].map, s.ws.transfers[0].monster.x, s.ws.transfers[0].monster.y], ['hall', 4, 5]);
  assert.strictEqual(World.mapState(s.ws, 'hall_z1').monsters.length, 0, 'a guest that moves on leaves nothing behind');
});

test('a guest monster that loses interest, or dies, is removed; a follower gives up after a while', () => {
  const s = hall();
  World.advance(s.c, s.ws, 'hall_z1', [], 1000, mid, []);
  const ms = World.mapState(s.ws, 'hall_z1'), ref = Object.keys(s.c.monsters)[0], def = s.c.monsters[ref];
  let now = 700000;
  ms.arrivals = [{ id: 'hall.m1~1', ref, x: 3, y: 3, hp: def.hp, last: now, facing: 'S', spawn: '', guest: true, engaged: 'p1', idleUntil: now + 90000 },
                 { id: 'hall.m2~1', ref, x: 6, y: 3, hp: def.hp, last: now, facing: 'S', spawn: '', guest: true, engaged: 'p1', idleUntil: now + 90000 }];
  World.advance(s.c, s.ws, 'hall_z1', [], now + 1, mid, []);
  assert.strictEqual(ms.monsters.length, 2);
  ms.monsters[0].dead = true;
  World.advance(s.c, s.ws, 'hall_z1', [], now + 2, mid, []);
  assert.deepStrictEqual(ms.monsters.map(m => m.id), ['hall.m2~1'], 'a dead guest is gone, not waiting to respawn');
  World.advance(s.c, s.ws, 'hall_z1', [], now + 95000, mid, []);
  assert.strictEqual(ms.monsters.length, 0, 'and one with nobody to chase for long enough leaves');
  // a follower that cannot reach the stairs in time stops trying
  World.advance(s.c, s.ws, 'hall', [], 1000, mid, []);
  const g = World.mapState(s.ws, 'hall');
  const mo = { id: 'hall.m9', ref, x: 0, y: 0, hp: def.hp, last: now, facing: 'N', spawn: '', follow: { way: 'up', x: 4, y: 6, dir: 'N', who: 'p1', until: now + 5 } };
  g.monsters.push(mo);
  World.advance(s.c, s.ws, 'hall', [], now + def.moveMs * 30, mid, []);
  assert.ok(g.monsters.indexOf(mo) >= 0 && !(s.ws.transfers || []).length, 'still downstairs');
});

// ---- seeing between floors (docs/FLOORS.md §6)
// Ground 'keep' 14x12, all open. Upstairs: a floor over x 3..8, y 3..8, plus a separate block at (11,5) (another
// building at the same height). The ground is roofed at (12,8). Optional walls upstairs via mutate.
function keep(mutate, cfg) {
  const t = JSON.parse(JSON.stringify(tables));
  const full = Array(12).fill(Array(14).fill('til_1'));
  const upper = Array.from({ length: 12 }, (_, y) => Array.from({ length: 14 }, (_, x) => ((x >= 3 && x <= 8 && y >= 3 && y <= 8) || (x === 11 && y === 5) ? 'til_1' : '')));
  const roof = Array.from({ length: 12 }, (_, y) => Array.from({ length: 14 }, (_, x) => (x === 12 && y === 8 ? '1' : '')));
  t.Maps.push({ id: 'keep', name: 'Keep', width: 14, height: 12, terrain: JSON.stringify(full), roof: JSON.stringify(roof) });
  t.Maps.push({ id: 'keep_z1', name: 'Keep', width: 14, height: 12, terrain: JSON.stringify(upper), floor_of: 'keep', z: 1 });
  t.Maps.push({ id: 'keep_zm1', name: 'Keep', width: 14, height: 12, terrain: JSON.stringify(full), floor_of: 'keep', z: -1 });
  Object.keys(cfg || {}).forEach(k => { t.Config = t.Config.filter(r => r.key !== k).concat([{ key: k, value: cfg[k] }]); });
  if (mutate) mutate(t);
  return Content.build(t);
}

test('from upstairs you see the ground outside past an open edge, never under your own floor or through a wall', () => {
  const c = keep(), up = c.maps.keep_z1, g = c.maps.keep;
  const sees = (ux, uy, lx, ly, r) => World.seesAcross(c, up, ux, uy, g, lx, ly, r);
  assert.strictEqual(sees(8, 5, 10, 5), true, 'standing at the edge: the ground just beyond');
  assert.strictEqual(sees(5, 5, 10, 6), true, 'from the middle of the floor too, with no wall in the way');
  assert.strictEqual(sees(5, 5, 5, 6), false, 'not what is beneath your own floor');
  assert.strictEqual(sees(5, 5, 8, 8), false);
  assert.strictEqual(sees(8, 5, 12, 5), false, 'a building at your height stands in the way');
  assert.strictEqual(sees(8, 4, 12, 4), true, 'but not one row over');
  assert.strictEqual(sees(8, 8, 12, 8), false, 'never into a roofed interior');
  assert.strictEqual(sees(8, 5, 13, 6, 3), false, 'nor beyond the radius');
  assert.strictEqual(sees(8, 5, 10, 5, 3), true);
  // direction and depth
  assert.strictEqual(World.seesAcross(c, g, 8, 5, up, 10, 5), false, 'it is asked upper-to-lower; the answer serves both ways');
  assert.strictEqual(World.seesAcross(c, up, 8, 5, c.maps.keep_zm1, 10, 5), false, 'nothing below ground is seen from above');
  assert.strictEqual(World.seesAcross(c, g, 2, 2, c.maps.keep_zm1, 2, 3), false);
  // a wall along the east edge of the upper floor at row 5 shuts that view; a window in it would open it again
  const walled = keep(t => { const u = t.Maps.find(r => r.id === 'keep_z1'), vW = Array.from({ length: 12 }, () => Array(15).fill('')); vW[5][9] = 'wall_wood:2'; u.vWalls = JSON.stringify(vW); });
  assert.strictEqual(World.seesAcross(walled, walled.maps.keep_z1, 8, 5, walled.maps.keep, 10, 5), false);
  assert.strictEqual(World.seesAcross(walled, walled.maps.keep_z1, 8, 4, walled.maps.keep, 10, 4), true, 'the next row has no wall');
});

test('an upstairs window shows the ground outside to someone standing at it, in a narrow cone', () => {
  const c = keep(t => {
    const u = t.Maps.find(r => r.id === 'keep_z1'), vW = Array.from({ length: 12 }, () => Array(15).fill(''));
    for (let y = 3; y <= 8; y++) vW[y][9] = 'wall_wood:2';                       // the whole east side of the upper floor is wall
    u.vWalls = JSON.stringify(vW);
    t.Objects.push({ id: 'test_win', name: 'Window', kind: 'deco', walkable: true, properties: '{"layer":"wall","opening":"window"}' });
    t.MapEntities.push({ key: 'keep_z1.e1', map: 'keep_z1', x: 8, y: 6, ref: 'test_win', data: '{"side":"E"}' });
  });
  const up = c.maps.keep_z1, g = c.maps.keep;
  World.syncEdgesView(c, up, () => '');
  const sees = (ux, uy, lx, ly) => World.seesAcross(c, up, ux, uy, g, lx, ly, 16);
  assert.strictEqual(sees(8, 6, 10, 6), true, 'at the window: the ground straight out');
  assert.strictEqual(sees(8, 6, 13, 6), true, 'and further along the same line');
  assert.strictEqual(sees(8, 6, 10, 9), false, 'but only a narrow cone');
  assert.strictEqual(sees(7, 6, 10, 6), false, 'a step back from the window it is just wall');
  assert.strictEqual(sees(8, 5, 10, 5), false, 'and so is the wall beside it');
  // the same view lets a shot through
  const p = { x: 8, y: 6, map: 'keep_z1', inventory: [], equipment: {}, mags: {} };
  World.give(c, p, 'pistol', 1, []); p.equipment.weapon = 'pistol'; p.mags.pistol = 5;
  assert.strictEqual(World.shotAcross(c, p, up, g, 10, 6, () => '').ok, true, 'you can shoot out of it');
  p.x = 7;
  assert.strictEqual(World.shotAcross(c, p, up, g, 10, 6, () => '').ok, false, 'not from a step back');
});

test('from the second floor up, the floor in between hides the ground beneath it', () => {
  // floor 1 covers x 3..8; floor 2 only x 3..5 — so from floor 2, x 6..8 is floor 1's open terrace
  const c = keep(t => {
    const top = Array.from({ length: 12 }, (_, y) => Array.from({ length: 14 }, (_, x) => (x >= 3 && x <= 5 && y >= 3 && y <= 8 ? 'til_1' : '')));
    t.Maps.push({ id: 'keep_z2', name: 'Keep', width: 14, height: 12, terrain: JSON.stringify(top), floor_of: 'keep', z: 2 });
  });
  const top = c.maps.keep_z2, mid = c.maps.keep_z1, g = c.maps.keep;
  assert.strictEqual(World.seesAcross(c, top, 5, 5, mid, 7, 5), true, 'the terrace of the floor below is in view');
  assert.strictEqual(World.seesAcross(c, top, 5, 5, g, 7, 5), false, 'the ground UNDER that terrace is not');
  assert.strictEqual(World.seesAcross(c, top, 5, 5, g, 6, 5), false);
  assert.strictEqual(World.seesAcross(c, top, 5, 5, g, 10, 5), false, 'nor the ground beyond it along that line: the terrace is in the way');
  assert.strictEqual(World.seesAcross(c, top, 5, 2 + 1, g, 5, 0), true, 'the ground past an edge with nothing below it is');
  assert.strictEqual(World.seesAcross(c, top, 5, 5, g, 4, 5), false, 'nor what is under both floors');
});

test('a monster left far from its spawn point does not freeze: it mills about and drifts home', () => {
  const c = keep(t => { t.MapEntities.push({ map: 'keep', key: 'keep.e90', x: 2, y: 9, ref: 'obj_8', data: JSON.stringify({ monster: Object.keys(Content.build(t).monsters)[0], count: 1, radius: 1 }) }); });
  const ws = { maps: {} };
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  World.advance(c, ws, 'keep', [], 1000, rnd, []);
  const m = World.mapState(ws, 'keep').monsters.find(k => k.spawn === 'keep.e90');
  Object.assign(m, { x: 12, y: 1, last: 1000 });                    // where a chase left it
  const far = () => Math.max(Math.abs(m.x - 2), Math.abs(m.y - 9));
  let moved = 0, px = m.x, py = m.y;
  for (let t = 2000; t < 200000; t += 1000) { World.advance(c, ws, 'keep', [], t, rnd, []); if (m.x !== px || m.y !== py) moved++; px = m.x; py = m.y; }
  assert.ok(moved > 20, 'it kept moving (' + moved + ' steps)');
  assert.ok(far() <= 3, 'and ended up back around its spawn point (' + m.x + ',' + m.y + ')');
});

test('the other floors of a building you are in keep moving, and their people are in your view', () => {
  const c = keep();
  const ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Watcher', 'warrior'), q = World.newPlayer(c, 'p2', 'Walker', 'warrior');
  Object.assign(p, { map: 'keep_z1', x: 8, y: 5 }); Object.assign(q, { map: 'keep', x: 11, y: 6 });
  const ref = Object.keys(c.monsters)[0];
  World.advance(c, ws, 'keep', [], 1000, mid, []);
  World.mapState(ws, 'keep').monsters.push({ id: 'keep.m1', ref, x: 10, y: 2, hp: 5, last: 1000, facing: 'S', spawn: '' });
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const spots = new Set();
  for (let t = 2000; t < 60000; t += 1000) {
    World.advance(c, ws, 'keep_z1', [p], t, rnd, []);
    World.advanceFloors(c, ws, 'keep_z1', () => [], t, rnd, []);
    const m = World.mapState(ws, 'keep').monsters.find(k => k.id === 'keep.m1');
    spots.add(m.x + ',' + m.y);
  }
  assert.ok(World.mapState(ws, 'keep').monsters.find(k => k.id === 'keep.m1').last > 50000, 'the ground floor was moved on though nobody stood on it');
  assert.ok(spots.size > 1, 'and its monster wandered');
  assert.ok(ws.maps.keep_zm1, 'every floor of the building is kept, the cellar too');
  const v = World.view(c, ws, 'keep_z1', p, [p], -1, [p, q]);
  assert.deepStrictEqual(v.floors.keep.players.map(k => [k.name, k.x, k.y]), [['Walker', 11, 6]], 'someone on the ground is in the view of the floor above');
  assert.deepStrictEqual(World.view(c, ws, 'keep', q, [q], -1, [p, q]).floors.keep_z1.players.map(k => k.name), ['Watcher'], 'and the other way round');
});

test('the view of another floor says which of its doors stand open', () => {
  const c = keep(t => {
    const door = t.Objects.find(o => o.kind === 'door');
    t.MapEntities.push({ map: 'keep', key: 'keep.e91', x: 12, y: 10, ref: door.id, data: '' }, { map: 'keep', key: 'keep.e92', x: 13, y: 10, ref: door.id, data: '' });
  });
  const ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Watcher', 'warrior');
  Object.assign(p, { map: 'keep_z1', x: 8, y: 5 });
  World.advance(c, ws, 'keep_z1', [p], 1000, mid, []); World.advance(c, ws, 'keep', [], 1000, mid, []);
  assert.deepStrictEqual(World.view(c, ws, 'keep_z1', p, [p]).floors.keep.states, {}, 'shut doors are the usual state: nothing to say');
  World.mapState(ws, 'keep').states['keep.e91'] = 'open';
  assert.deepStrictEqual(World.view(c, ws, 'keep_z1', p, [p]).floors.keep.states, { 'keep.e91': 'open' });
  assert.deepStrictEqual(World.fixtureStates(c, ws, 'keep'), { 'keep.e91': 'open' });
});

test('what players built on another floor travels with the view, only when the asker is behind', () => {
  const c = keep();
  const ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Watcher', 'warrior');
  Object.assign(p, { map: 'keep_z1', x: 8, y: 5 });
  World.advance(c, ws, 'keep_z1', [p], 1000, mid, []); World.advance(c, ws, 'keep', [], 1000, mid, []);
  let f = World.view(c, ws, 'keep_z1', p, [p]).floors.keep;
  assert.strictEqual(f.structRev, 0); assert.strictEqual(f.struct, undefined, 'nothing built: nothing sent');
  const st = World.structOf(ws, 'keep');
  st.floor['11,2'] = { t: 'til_1' }; st.rev = 3;
  f = World.view(c, ws, 'keep_z1', p, [p]).floors.keep;
  assert.strictEqual(f.structRev, 3); assert.ok(f.struct && f.struct.floor['11,2'], 'the layer comes along');
  f = World.view(c, ws, 'keep_z1', p, [p], -1, null, { keep: 3 }).floors.keep;
  assert.strictEqual(f.struct, undefined, 'up to date: only the revision number');
  assert.ok(World.view(c, ws, 'keep_z1', p, [p], -1, null, { keep: 2 }).floors.keep.struct, 'behind: sent again');
});

test('being higher widens your view, and the view carries the other floors when the world holds them', () => {
  const c = keep();
  assert.deepStrictEqual([World.sightRadius(c, c.maps.keep), World.sightRadius(c, c.maps.keep_z1), World.sightRadius(c, c.maps.keep_zm1)], [16, 19, 16]);
  const c2 = keep(null, { sight_radius: 10, sight_per_floor: 5 });
  assert.deepStrictEqual([World.sightRadius(c2, c2.maps.keep), World.sightRadius(c2, c2.maps.keep_z1)], [10, 15]);
  assert.strictEqual(World.sightRadius(c, c.maps.map_3), 16, 'a map without floors is unchanged');
  const ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Watcher', 'warrior');
  Object.assign(p, { map: 'keep_z1', x: 8, y: 5 });
  World.advance(c, ws, 'keep_z1', [p], 1000, mid, []);
  assert.strictEqual(World.view(c, ws, 'keep_z1', p, [p]).floors, undefined, 'a floor nobody has loaded is not sent');
  World.advance(c, ws, 'keep', [], 1000, mid, []);
  const ref = Object.keys(c.monsters)[0];
  World.mapState(ws, 'keep').monsters.push({ id: 'keep.m1', ref, x: 10, y: 5, hp: 5, last: 1000, facing: 'S', spawn: '' }, { id: 'keep.m2', ref, x: 1, y: 1, hp: 5, last: 1000, facing: 'S', spawn: '', dead: true });
  const v = World.view(c, ws, 'keep_z1', p, [p]);
  assert.deepStrictEqual(Object.keys(v.floors), ['keep']);
  assert.deepStrictEqual(v.floors.keep.monsters.map(m => [m.id, m.x, m.y]), [['keep.m1', 10, 5]], 'the living ones, where they stand');
  assert.strictEqual(World.view(c, ws, 'map_3', p, [p]).floors, undefined);
});

// ---- floors stage 4: claims by column, laying floor, building stairs, shooting between floors
// 'plot': open ground 30x13 (arrival point far east) with a floor above that so far is only a patch x 8..10, y 5..7.
function plot(cfg, mutate) {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(30).fill('til_1');
  const upper = Array.from({ length: 13 }, (_, y) => Array.from({ length: 30 }, (_, x) => (x >= 8 && x <= 10 && y >= 5 && y <= 7 ? 'til_1' : '')));
  t.Maps.push({ id: 'plot', name: 'Plot', width: 30, height: 13, terrain: JSON.stringify(Array(13).fill(row)), spawn: JSON.stringify({ x: 29, y: 12 }) });
  t.Maps.push({ id: 'plot_z1', name: 'Plot', width: 30, height: 13, terrain: JSON.stringify(upper), floor_of: 'plot', z: 1 });
  t.Objects.push({ id: 'obj_steps', name: 'Stairs', kind: 'stairs', sprite: '', walkable: false, properties: JSON.stringify({ length: 2, hp: 40, material: 'wood' }) });
  t.Blueprints.push({ id: 'bp_floor', name: 'Wooden floor', category: 'other', places: 'tile', terrain: 'til_1', cost: 'wood:2', work: 0, tool: '' });
  t.Blueprints.push({ id: 'bp_steps', name: 'Stairs', category: 'other', places: 'object', object: 'obj_steps', cost: 'wood:6', work: 0, tool: '' });
  Object.keys(cfg || {}).forEach(k => { t.Config = t.Config.filter(r => r.key !== k).concat([{ key: k, value: cfg[k] }]); });
  if (mutate) mutate(t);
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Builder', 'warrior'), q = World.newPlayer(c, 'p2', 'Raider', 'warrior');
  const s = { c, ws, p, q };
  put(s, 'plot', 8, 6, 'E');
  Object.assign(q, { map: 'plot', x: 12, y: 6, facing: 'W' });
  [p, q].forEach(pl => [['hammer', 1], ['wood', 80], ['nails', 40], ['cloth', 10]].forEach(g => World.give(c, pl, g[0], g[1], [])));
  return s;
}
const live = (s, id) => { World.syncEdges(s.c, s.ws, id); return World.liveMap(s.c, s.ws, id); };
const doAs = (s, who, a) => { clock += 5000; const out = texts(World.act(s.c, s.ws, who, a, clock, mid, [s.p, s.q])); World.deliver(s.c, s.ws); return out; };

test('a claim covers every floor of its building: the floors above and below are the base too', () => {
  const s = plot();
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_claim', x: 9, y: 6 }), /frame of a claim flag/);
  const flag = live(s, 'plot').entities.filter(e => e.ref === 'obj_claim')[0];
  const up = live(s, 'plot_z1');
  assert.deepStrictEqual(World.claimsOn(s.c, up).map(q => [q.x, q.y, q.r, !!q.shadow, q.e.by]), [[9, 6, 6, true, 'p1']], 'the floor above knows of it');
  assert.ok(World.mayUse(s.c, up, s.p, 9, 6) && !World.mayUse(s.c, up, s.q, 9, 6));
  Object.assign(s.q, { map: 'plot_z1', x: 10, y: 6, facing: 'E' });
  assert.match(doAs(s, s.q, { type: 'build', bp: 'bp_floor', x: 11, y: 6 }), /This land belongs to Builder/, 'an outsider cannot build upstairs in someone\'s base');
  Object.assign(s.q, { map: 'plot_z1', x: 10, y: 6 });
  put(s, 'plot_z1', 9, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 4 }), /You lay a wooden floor/, 'the owner can');
  // a second claim cannot be planted above or below the first
  assert.match(doAs(s, s.q, { type: 'build', bp: 'bp_claim', x: 10, y: 7 }), /belongs to Builder|Too close to another base/);
  // members are told to the other floors
  Object.assign(s.q, { map: 'plot', x: 10, y: 7 }); put(s, 'plot', 9, 7, 'N');
  for (let i = 0; i < 8; i++) doAs(s, s.p, { type: 'work', target: { t: 'ent', key: flag.key } });
  assert.match(doAs(s, s.p, { type: 'claim', key: flag.key, op: 'add', name: 'Raider' }), /Raider is now a member/);
  assert.ok(World.mayUse(s.c, live(s, 'plot_z1'), s.q, 9, 6), 'a member is a member on every floor');
  // and when the claim goes, so does its hold on the other floors
  World.damageStructure(s.c, s.ws, 'plot', { t: 'ent', key: flag.key }, 999, { kind: 'monster', now: clock }, []);
  World.deliver(s.c, s.ws);
  assert.deepStrictEqual(World.claimsOn(s.c, live(s, 'plot_z1')), []);
});

test('laying floor: only where there is none and joined to floor already there; it can be taken up again', () => {
  const s = plot();
  put(s, 'plot_z1', 10, 6, 'E'); Object.assign(s.q, { map: 'plot_z1', x: 8, y: 5 });
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 }), /already a floor there/);
  put(s, 'plot_z1', 10, 5, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 11, y: 4 }), /join onto one that is already there/, 'touching only at a corner is not joined');
  put(s, 'plot_z1', 10, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 12, y: 6 }), /can't reach there/, 'nor can you build across a gap');
  const wood = World.count(s.p, 'wood');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 11, y: 6 }), /You lay a wooden floor/);
  assert.strictEqual(World.count(s.p, 'wood'), wood - 2);
  assert.strictEqual(live(s, 'plot_z1').terrain[6][11], 'til_1');
  assert.strictEqual(s.c.maps.plot_z1.terrain[6][11], '', 'the map as authored is never changed');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 12, y: 6 }), /You lay/, 'floor can now go on from the new piece');
  doAs(s, s.p, { type: 'move', dirs: ['E'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [11, 6], 'and be walked on');
  // taking it up
  const acts = () => World.actionsAt(s.c, live(s, 'plot_z1'), World.viewLookup(s.c, live(s, 'plot_z1'), World.view(s.c, s.ws, 'plot_z1', s.p, [s.p, s.q], -1), s.p), s.p, 12, 6).map(a => a.label);
  assert.deepStrictEqual(acts(), ['Take up the floor']);
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 11, y: 6 } }), /Someone is standing on it/);
  Object.assign(s.q, { x: 11, y: 7 });
  assert.match(doAs(s, s.q, { type: 'dismantle', target: { t: 'tile', x: 12, y: 6 } }), /Too far away|not yours/);
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 12, y: 6 } }), /You take up the floor/);
  assert.strictEqual(live(s, 'plot_z1').terrain[6][12], '');
  assert.strictEqual(World.count(s.p, 'wood'), wood - 3, 'half the materials of that piece come back');
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 9, y: 6 } }), /only take up floor that was laid/, 'the map\'s own floor stays');
});

test('floor can be laid over open ground (terrain ticked build_over); taken up again, it leaves dirt', () => {
  const s = plot(null, t => {
    t.Terrain.forEach(r => { if (r.id === 'til_3') r.build_over = true; });       // grass
    const m = t.Maps.find(r => r.id === 'plot'), g = JSON.parse(m.terrain).map(r => r.slice());
    g[6][9] = 'til_3'; g[6][10] = 'til_3'; m.terrain = JSON.stringify(g);
    const ov = Array.from({ length: 13 }, () => Array(30).fill('')); ov[6][9] = 'til_3'; m.overlay = JSON.stringify(ov);
    t.Blueprints.find(b => b.id === 'bp_floor').terrain = 'til_10';
  });
  Object.assign(s.q, { x: 20, y: 10 });
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 8, y: 5 }), /already a floor there/, 'stone floor is not open ground');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 }), /You lay a wooden floor/, 'grass is');
  assert.strictEqual(live(s, 'plot').terrain[6][9], 'til_10');
  assert.strictEqual(live(s, 'plot').overlay[6][9], '', 'the grass painted on top is covered');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 }), /already a floor there/, 'not twice');
  // the remove tool asks World.canRemove — the referee's own check — from the map the client draws
  const lm = live(s, 'plot'), lk = World.viewLookup(s.c, lm, World.view(s.c, s.ws, 'plot', s.p, [s.p, s.q], -1), s.p);
  assert.strictEqual(World.canRemove(s.c, lm, lk, s.p, { t: 'tile', x: 9, y: 6 }).ok, true);
  assert.match(World.canRemove(s.c, lm, lk, s.p, { t: 'tile', x: 8, y: 5 }).reason, /only take up floor that was laid/);
  assert.strictEqual(World.canRemove(s.c, lm, lk, s.p, { t: 'wall', orient: 'h', x: 9, y: 6 }).info, null, 'nothing built there: nothing to outline');
  assert.match(World.canRemove(s.c, lm, lk, Object.assign({}, s.p, { x: 14, y: 6 }), { t: 'tile', x: 9, y: 6 }).reason, /Too far away/);
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 9, y: 6 } }), /You take up the floor/);
  assert.strictEqual(live(s, 'plot').terrain[6][9], 'g_dirt', 'bare earth, not the grass that was there');
  assert.strictEqual(live(s, 'plot').overlay[6][9], '');
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 9, y: 6 } }), /only take up floor that was laid/, 'the dirt is not a floor');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 }), /You lay a wooden floor/, 'and can be built on again');
  // Config floor_removed_terrain = none: the ground comes back as it was
  const s2 = plot({ floor_removed_terrain: 'none' }, t => {
    t.Terrain.forEach(r => { if (r.id === 'til_3') r.build_over = true; });
    const m = t.Maps.find(r => r.id === 'plot'), g = JSON.parse(m.terrain).map(r => r.slice()); g[6][9] = 'til_3'; m.terrain = JSON.stringify(g);
    t.Blueprints.find(b => b.id === 'bp_floor').terrain = 'til_10';
  });
  Object.assign(s2.q, { x: 20, y: 10 });
  doAs(s2, s2.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 });
  assert.match(doAs(s2, s2.p, { type: 'dismantle', target: { t: 'tile', x: 9, y: 6 } }), /You take up the floor/);
  assert.strictEqual(live(s2, 'plot').terrain[6][9], 'til_3');
});

test('building stairs opens the floor above and gives them somewhere to land', () => {
  const s = plot();
  put(s, 'plot', 9, 8, 'N');
  // foot (9,6), run to (9,5), landing (9,4): above, (9,6) and (9,5) are floor and (9,4) is open air
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_steps', x: 9, y: 7, facing: 'N' }), /You build a stairs|You build stairs|You build/);
  const up0 = live(s, 'plot_z1');
  assert.deepStrictEqual([up0.terrain[7][9], up0.terrain[6][9], up0.terrain[5][9]], ['', '', 'til_1'], 'the stairwell is open over the run, and it lands on floor');
  const st = live(s, 'plot').entities.filter(e => e.ref === 'obj_steps')[0];
  assert.deepStrictEqual([st.x, st.y, st.data.facing], [9, 7, 'N']);
  doAs(s, s.p, { type: 'move', dirs: ['N'] }); doAs(s, s.p, { type: 'move', dirs: ['N'] });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['plot', 9, 6]);
  doAs(s, s.p, { type: 'move', dirs: ['N'] });
  assert.deepStrictEqual([s.p.map, s.p.x, s.p.y], ['plot_z1', 9, 5], 'and you can walk up them');
  // where the landing has no floor, one is laid
  put(s, 'plot', 15, 8, 'N');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_steps', x: 15, y: 7, facing: 'E' }), /You build/);
  const up1 = live(s, 'plot_z1');
  assert.strictEqual(up1.terrain[7][17], 'til_1', 'a landing was laid at the head of the east-climbing stairs');
  // refusals
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_steps', x: 15, y: 7, facing: 'N' }), /already there|in the way/);
  put(s, 'plot_z1', 9, 5, 'N');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_steps', x: 8, y: 5, facing: 'N' }), /no floor above here/, 'nothing above the top floor to climb to');
});

test('you can shoot what you have a clear view of on another floor, and it can be shot back at', () => {
  const s = plot();
  World.advance(s.c, s.ws, 'plot', [], 1000, mid, []); World.advance(s.c, s.ws, 'plot_z1', [], 1000, mid, []);
  const ref = Object.keys(s.c.monsters)[0];
  const below = World.mapState(s.ws, 'plot').monsters, above = World.mapState(s.ws, 'plot_z1').monsters;
  const out = { id: 'plot.m1', ref, x: 12, y: 6, hp: 9999, last: 9e12, facing: 'S', spawn: '' }, under = { id: 'plot.m2', ref, x: 9, y: 6, hp: 9999, last: 9e12, facing: 'S', spawn: '' };
  const edge = { id: 'plot_z1.m1', ref, x: 10, y: 5, hp: 9999, last: 9e12, facing: 'S', spawn: '' };
  below.push(out, under); above.push(edge);
  World.give(s.c, s.p, 'pistol', 1, []); World.give(s.c, s.p, 'ammo_pistol', 30, []);
  put(s, 'plot_z1', 10, 6, 'E');
  doAs(s, s.p, { type: 'use', item: 'pistol' });
  assert.ok(World.rangedWeapon(s.c, s.p), 'pistol in hand');
  assert.match(doAs(s, s.p, { type: 'shoot', map: 'plot', x: 12, y: 6 }), /You shoot the/);
  assert.ok(out.hp < 9999, 'the one outside on the ground is hit');
  assert.strictEqual(out.engaged, 'p1');
  assert.match(doAs(s, s.p, { type: 'shoot', map: 'plot', x: 9, y: 6 }), /no clear shot/);
  assert.strictEqual(under.hp, 9999, 'the one under your own floor is not');
  assert.match(doAs(s, s.p, { type: 'shoot', map: 'plot', x: 29, y: 6 }), /Too far away/);
  assert.match(doAs(s, s.p, { type: 'shoot', map: 'map_3', x: 3, y: 3 }), /Pick a target/, 'only floors of the same building');
  // from the ground, up at the one standing at the edge
  put(s, 'plot', 12, 5, 'W');
  assert.match(doAs(s, s.p, { type: 'shoot', map: 'plot_z1', x: 10, y: 5 }), /You shoot the/);
  assert.ok(edge.hp < 9999);
  assert.strictEqual(World.shotAcross(s.c, s.p, s.c.maps.plot, s.c.maps.plot_z1, 10, 5).ok, true);
  put(s, 'plot', 9, 6, 'N');                                            // standing under the floor: no view of anyone on it
  assert.strictEqual(World.shotAcross(s.c, s.p, s.c.maps.plot, s.c.maps.plot_z1, 10, 5).reason, 'You have no clear shot.');
});

test('a grenade can be thrown down from an upper floor onto ground you can see, never up or under your own floor', () => {
  const s = plot();
  World.advance(s.c, s.ws, 'plot', [], 1000, mid, []); World.advance(s.c, s.ws, 'plot_z1', [], 1000, mid, []);
  const ref = Object.keys(s.c.monsters)[0], below = World.mapState(s.ws, 'plot').monsters;
  const out = { id: 'plot.m1', ref, x: 12, y: 6, hp: 9999, last: 9e12, facing: 'S', spawn: '' }, near = { id: 'plot.m3', ref, x: 13, y: 7, hp: 9999, last: 9e12, facing: 'S', spawn: '' };
  const under = { id: 'plot.m2', ref, x: 9, y: 6, hp: 9999, last: 9e12, facing: 'S', spawn: '' };
  below.push(out, near, under);
  World.give(s.c, s.p, 'grenade', 5, []);
  const have = () => (s.p.inventory.find(q => q.item === 'grenade') || { qty: 0 }).qty;
  put(s, 'plot_z1', 10, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'throw', item: 'grenade', map: 'plot', x: 9, y: 6 }), /no clear throw/, 'not under your own floor');
  assert.match(doAs(s, s.p, { type: 'throw', item: 'grenade', map: 'plot', x: 20, y: 6 }), /Too far away/);
  assert.match(doAs(s, s.p, { type: 'throw', item: 'grenade', map: 'map_3', x: 3, y: 3 }), /Pick a spot/, 'only floors of the same building');
  assert.strictEqual(have(), 5, 'a refused throw costs nothing');
  assert.match(doAs(s, s.p, { type: 'throw', item: 'grenade', map: 'plot', x: 12, y: 6 }), /grenade hits the/);
  assert.ok(out.hp < 9999, 'the one it lands on is hit');
  assert.ok(near.hp < 9999, 'and so is the one beside it, in the blast');
  assert.strictEqual(under.hp, 9999, 'the one under the floor is out of it');
  assert.strictEqual(have(), 4);
  // never upwards
  put(s, 'plot', 12, 5, 'W'); s.p.cooldowns = {};
  assert.match(doAs(s, s.p, { type: 'throw', item: 'grenade', map: 'plot_z1', x: 10, y: 5 }), /that far up/);
  assert.strictEqual(have(), 4);
});

// ---- roofs (docs/FLOORS.md stage 5): a roof over a storey is floor on the storey above; it rests on walls
// 'yard': open ground 30x13 with NO floor of its own above it — the game supplies the storeys (Content.autoFloors).
function roofYard(cfg) {
  const t = JSON.parse(JSON.stringify(tables));
  t.Maps.push({ id: 'yard', name: 'Yard', width: 30, height: 13, terrain: JSON.stringify(Array(13).fill(Array(30).fill('til_1'))), spawn: JSON.stringify({ x: 29, y: 12 }) });
  t.Objects.push({ id: 'obj_pillar', name: 'Pillar', kind: 'deco', sprite: '', walkable: false, properties: JSON.stringify({ support: true }) });
  t.Blueprints.push({ id: 'bp_roof', name: 'Wooden roof', category: 'roofs', places: 'roof', terrain: 'til_1', cost: 'wood:2', work: 0, tool: '' });
  t.Blueprints.push({ id: 'bp_floor', name: 'Wooden floor', category: 'other', places: 'tile', terrain: 'til_1', cost: 'wood:2', work: 0, tool: '' });
  Object.keys(cfg || {}).forEach(k => { t.Config = t.Config.filter(r => r.key !== k).concat([{ key: k, value: cfg[k] }]); });
  const c = Content.autoFloors(Content.build(t)), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Builder', 'warrior'), q = World.newPlayer(c, 'p2', 'Other', 'warrior');
  c.maps.yard.entities.push({ key: 'yard.e1', x: 20, y: 6, ref: 'obj_pillar', data: {} });
  const s = { c, ws, p, q };
  put(s, 'yard', 8, 7, 'N');
  Object.assign(q, { map: 'yard', x: 28, y: 12 });
  [['hammer', 1], ['wood', 80], ['nails', 40]].forEach(g => World.give(c, p, g[0], g[1], []));
  return s;
}

test('maps that arrive with the settings of their things as text (straight from a map document) are mended', () => {
  const c = Content.build(tables), m = c.maps.map_3;
  const door = m.entities.filter(e => s_kind(c, e) === 'door')[0];
  m.entities.push({ key: 'map_3.t1', x: '4', y: '5', ref: door.ref, data: JSON.stringify({ side: 'W', target: 'map_3:1:1' }) }, { key: 'map_3.t2', x: 1, y: 1, ref: door.ref, data: '' }, { key: 'junk' });
  m._block = { stale: 1 };
  Content.linkFloors(c);
  const t1 = m.entities.filter(e => e.key === 'map_3.t1')[0], t2 = m.entities.filter(e => e.key === 'map_3.t2')[0];
  assert.deepStrictEqual([t1.data.side, t1.data.target, t1.x, t1.y], ['W', 'map_3:1:1', 4, 5]);
  assert.deepStrictEqual(t2.data, {});
  assert.ok(!m.entities.some(e => e.key === 'junk') && !('_block' in m), 'no thing without a ref, no cache that came along');
});
function s_kind(c, e) { const o = c.objects[e.ref]; return o && o.kind; }

test('every map gets empty storeys above it to build on, unless it has its own or building is off', () => {
  const s = roofYard();
  assert.deepStrictEqual(World.floorsOf(s.c, 'yard').map(f => [f.z, f.id]), [[0, 'yard'], [1, 'yard_z1'], [2, 'yard_z2']]);
  assert.ok(s.c.maps.yard_z1.auto && s.c.maps.yard_z1.terrain[6][8] === '' && s.c.maps.yard_z1.width === 30);
  const before = Object.keys(s.c.maps).length;
  Content.autoFloors(s.c);
  assert.strictEqual(Object.keys(s.c.maps).length, before, 'running it again adds nothing');
  assert.deepStrictEqual(World.floorsOf(roofYard({ auto_floors: 0 }).c, 'yard').length, 1);
  assert.deepStrictEqual(World.floorsOf(roofYard({ build: 'off' }).c, 'yard').length, 1);
  const pl = plot(); Content.autoFloors(pl.c);
  assert.deepStrictEqual(World.floorsOf(pl.c, 'plot').map(f => f.id), ['plot', 'plot_z1', 'plot_z2'], 'a floor the owner made is kept; only the missing one is added');
  assert.ok(!pl.c.maps.plot_z1.auto);
});

test('a roof is built from below, rests on walls up to roof_support tiles away, and is the floor of the storey above', () => {
  const s = roofYard(), bp = s.c.blueprints.bp_roof;
  const chk = (x, y) => World.canBuild(s.c, live(s, 'yard'), World.viewLookup(s.c, live(s, 'yard'), World.view(s.c, s.ws, 'yard', s.p, [s.p, s.q], -1), s.p), s.p, bp, x, y);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 }), /has to rest on a wall/, 'nothing holds it yet');
  assert.strictEqual(chk(8, 6).risk, 'fall');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' }), /frame of a wooden wall/);
  assert.deepStrictEqual([chk(8, 6).risk, chk(8, 6).steps], ['safe', 1]);
  const wood = World.count(s.p, 'wood');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 }), /You put up a wooden roof\.$/);
  assert.strictEqual(World.count(s.p, 'wood'), wood - 2);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 }), /already a roof there/);
  // it is cover, a room, and floor upstairs
  assert.ok(World.covered(s.c, live(s, 'yard'), 8, 6) && !World.covered(s.c, live(s, 'yard'), 9, 6));
  assert.strictEqual(World.roofZoneAt(live(s, 'yard'), 8, 6), '8,6');
  assert.strictEqual(live(s, 'yard_z1').terrain[6][8], 'til_1');
  assert.strictEqual(s.c.maps.yard_z1.terrain[6][8], '', 'the map as authored is never changed');
  assert.deepStrictEqual(Object.keys(World.view(s.c, s.ws, 'yard', s.p, [s.p, s.q], -1).struct.roof), ['8,6'], 'the game page is told');
  // green, green, yellow, red
  put(s, 'yard', 9, 7, 'N');
  assert.deepStrictEqual([chk(9, 6).risk, chk(9, 6).steps], ['safe', 2]);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 9, y: 6 }), /You put up a wooden roof\.$/);
  assert.deepStrictEqual([chk(10, 6).risk, chk(10, 6).ok], ['edge', true]);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 10, y: 6 }), /as far from a wall as it can go/);
  put(s, 'yard', 11, 7, 'N');
  assert.deepStrictEqual([chk(11, 6).risk, chk(11, 6).ok], ['fall', false]);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 11, y: 6 }), /Too far from a wall: it would fall/);
  // a wall further along holds it after all
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 12, y: 6, side: 'N' }), /frame of a wooden wall/);
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 12, y: 6 }), /You put up a wooden roof/);
  assert.deepStrictEqual([chk(11, 6).risk, chk(11, 6).steps], ['safe', 2]);
  // a pillar (an object with properties.support) holds a roof like a wall does
  put(s, 'yard', 20, 7, 'N');
  assert.deepStrictEqual([chk(20, 6).risk, chk(20, 6).steps, chk(19, 6).risk], ['safe', 1, 'fall']);
  // taking it down from below: the floor upstairs goes too, half the materials come back
  put(s, 'yard', 10, 7, 'N');
  const lk = World.viewLookup(s.c, live(s, 'yard'), World.view(s.c, s.ws, 'yard', s.p, [s.p, s.q], -1), s.p);
  assert.strictEqual(World.canRemove(s.c, live(s, 'yard'), lk, s.p, { t: 'roof', x: 10, y: 6 }).ok, true);
  assert.match(World.canRemove(s.c, live(s, 'yard'), lk, s.q, { t: 'roof', x: 10, y: 6 }).reason, /Too far away/);
  assert.match(World.canRemove(s.c, live(s, 'yard'), lk, s.p, { t: 'roof', x: 10, y: 5 }).reason, /no roof there/);
  const w2 = World.count(s.p, 'wood');
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'roof', x: 10, y: 6 } }), /You take down the roof/);
  assert.strictEqual(World.count(s.p, 'wood'), w2 + 1);
  assert.strictEqual(live(s, 'yard_z1').terrain[6][10], '');
  assert.ok(!World.covered(s.c, live(s, 'yard'), 10, 6));
  // a FLOOR blueprint serves as a roof too (`roof: true`): one entry, both uses
  assert.strictEqual(World.asRoof(s.c.blueprints.bp_floor).places, 'roof');
  assert.strictEqual(World.asRoof(s.c.blueprints.bp_wood_wall).places, 'wall', 'only floors');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 10, y: 6, roof: true }), /You put up a roof of wooden floor/);
  assert.ok(World.covered(s.c, live(s, 'yard'), 10, 6) && live(s, 'yard_z1').terrain[6][10] === 'til_1');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 10, y: 6 }), /already a floor there/, 'without it, the same blueprint is a floor on the ground');
  // with the rule off (roof_support 0) a roof goes anywhere
  const free = roofYard({ roof_support: 0 });
  assert.match(doAs(free, free.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 }), /You put up a wooden roof/);
});

test('upstairs, floor laid or taken up is roof gained or lost below, and it obeys the same support rule', () => {
  const s = roofYard();
  doAs(s, s.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' });
  doAs(s, s.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 });
  put(s, 'yard_z1', 8, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 9, y: 6 }), /You lay a wooden floor/);
  assert.ok(World.covered(s.c, live(s, 'yard'), 9, 6), 'the storey below is covered there now');
  put(s, 'yard_z1', 9, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 10, y: 6 }), /You lay a wooden floor/);
  put(s, 'yard_z1', 10, 6, 'E');
  assert.match(doAs(s, s.p, { type: 'build', bp: 'bp_floor', x: 11, y: 6 }), /it would fall/, 'four from the wall is one too many');
  assert.match(doAs(s, s.p, { type: 'dismantle', target: { t: 'tile', x: 9, y: 6 } }), /You take up the floor/);
  assert.ok(!World.covered(s.c, live(s, 'yard'), 9, 6), 'and open to the sky again');
  // stairs open the roof over their run
  const s2 = roofYard();
  s2.c.objects.obj_steps = Object.assign({}, s2.c.objects.obj_pillar, { id: 'obj_steps', name: 'Stairs', kind: 'stairs', properties: { length: 2 } });
  s2.c.blueprints.bp_steps = Object.assign({}, s2.c.blueprints.bp_roof, { id: 'bp_steps', name: 'Stairs', places: 'object', object: 'obj_steps', terrain: '' });
  doAs(s2, s2.p, { type: 'build', bp: 'bp_wood_wall', x: 8, y: 6, side: 'N' });
  doAs(s2, s2.p, { type: 'build', bp: 'bp_roof', x: 8, y: 6 });
  assert.match(doAs(s2, s2.p, { type: 'build', bp: 'bp_steps', x: 8, y: 6, facing: 'E' }), /You build a stairs|Stairs|stairs/);
  assert.ok(!World.covered(s2.c, live(s2, 'yard'), 8, 6), 'the stairwell is open');
  assert.strictEqual(live(s2, 'yard_z1').terrain[6][8], '');
});

console.log(`\n${passed} world tests passed`);
