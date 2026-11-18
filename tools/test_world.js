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
  assert.deepStrictEqual(labels(5, 13), ['Attack the slime']);   // no ranged weapon: melee
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
  assert.match(World.actionsAt(s.c, map, lk, s.p, 12, 13)[0].label, /^Shoot/);     // shooting is the default
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

test('wall openings: a window passes sight but not feet, an archway passes both, the plain wall neither', () => {
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
  assert.ok(World.canSee(c, map, 1, 2, 1, 1, st), 'you can see through a window');
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

console.log(`\n${passed} world tests passed`);
