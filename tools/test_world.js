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
// Most fights here count plain damage, and a monster that has not seen its attacker would take a sneak attack's
// (docs/STEALTH.md stage 3). The stealth tests set Config ambush_mult back themselves.
// Likewise most monsters here are placed facing nowhere in particular: they see all round unless a test says otherwise.
tables.Config = tables.Config.filter(r => r.key !== 'ambush_mult' && r.key !== 'sight_cone').concat([{ key: 'ambush_mult', value: 1 }, { key: 'sight_cone', value: 360 }]);
// Walls muffle sound since stage 2 (Config sound_muffle, 2 tiles a wall): the older tests were written with sound
// passing through walls at full strength, and keep that; the "stealth: sound" tests turn it back on.
tables.Config = tables.Config.filter(r => r.key !== 'sound_muffle').concat([{ key: 'sound_muffle', value: 0 }]);
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

// deterministic dice: cycles through these values
function dice(seq) { let i = 0; return () => seq[i++ % seq.length]; }
const mid = dice([0.5]);
// Loot never goes straight into a bag: it lies in a body or a loot bag. This picks up everything player p finds in
// the ones on a map (the shared part and their own), and clears away the ones left empty, as taking it all does.
function scoop(c, ws, mapId, p) {
  const st = World.structOf(ws, mapId);
  st.ents.filter(b => b.wild && Array.isArray(b.inv)).forEach(b => {
    b.inv.filter(g => !g.own || g.own === p.id).forEach(g => World.give(c, p, g.item, g.qty, []));
    b.inv = b.inv.filter(g => g.own && g.own !== p.id);
  });
  st.ents = st.ents.filter(b => !(b.wild && Array.isArray(b.inv) && !b.inv.length));
  st.rev = (st.rev || 0) + 1;
}

function fresh() {
  const c = Content.build(tables);
  const ws = { maps: {} };
  const p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  return { c, ws, p };
}
function act(s, action, now, rng) { return World.act(s.c, s.ws, s.p, action, now || 1000, rng || mid, [s.p]); }
function texts(ev) { return ev.map(e => e.text).join(' | '); }
// The belt is a place of its own: its slots are cells of the bag's list from World.BELT_AT (what is there is not in
// the backpack). onBelt puts a stack of an item into a slot (what was there takes its cell); clearBelt empties it into the bag.
function onBelt(p, i, id) {
  const at = World.BELT_AT + i, inv = p.inventory, was = inv.find(st => st.s === at);
  const st = (was && was.item === id) ? was : inv.filter(st => st.item === id).sort((a, b) => ((a.s >= World.BELT_AT) - (b.s >= World.BELT_AT)) || a.s - b.s)[0];
  if (!st) throw new Error('no ' + id + ' to put on the belt');
  if (was && was !== st) was.s = st.s;
  st.s = at;
}
function clearBelt(p) { p.inventory.filter(st => st.s >= World.BELT_AT).forEach(st => { let k = 0; while (p.inventory.some(x => x.s === k)) k++; st.s = k; }); }
function put(s, map, x, y, facing) { s.p.map = map; s.p.x = x; s.p.y = y; s.p.facing = facing || 'S'; }

test('a new warrior starts at the start point with class stats and items', () => {
  const { c, p } = fresh();
  assert.deepStrictEqual([p.map, p.x, p.y], ['map_3', 9, 15]);
  const st = World.stats(c, p);
  // the warrior auto-equips the weapon/armor/helm in its start kit (wooden_sword +3 atk, leather_armor +2 def, army_helmet +2 def)
  assert.deepStrictEqual([p.hp, st.maxHp, st.atk, st.def], [120, 120, 9, 6]);
  // (the potion and the sword belong on the belt, the armour and helmet are worn: none of it is in the backpack)
  assert.deepStrictEqual(p.inventory, [{ item: 'potion', qty: 2, s: World.BELT_AT }, { item: 'wooden_sword', qty: 1, s: World.BELT_AT + 1 }, { item: 'leather_armor', qty: 1, s: World.wornCell('armor') }, { item: 'army_helmet', qty: 1, s: World.wornCell('helm') }]);
  assert.deepStrictEqual(p.equipment, { weapon: 'wooden_sword', armor: 'leather_armor', helm: 'army_helmet' });
});

test('what is worn is not in the backpack: wearing moves it to its place, taking it off moves it back', () => {
  const s = fresh(), p = s.p, inv = () => p.inventory.filter(st => /armor|helmet/.test(st.item)).map(st => st.item + '@' + st.s).sort().join(' ');
  const H = World.wornCell('helm'), A = World.wornCell('armor');
  assert.strictEqual(inv(), 'army_helmet@' + H + ' leather_armor@' + A);
  act(s, { type: 'use', item: 'army_helmet' });                                   // take it off
  assert.strictEqual(inv(), 'army_helmet@0 leather_armor@' + A);
  assert.strictEqual(p.equipment.helm, undefined);
  act(s, { type: 'use', item: 'army_helmet', from: { w: 'bag', s: 0 } });       // put it back on
  assert.strictEqual(inv(), 'army_helmet@' + H + ' leather_armor@' + A);
  assert.strictEqual(p.equipment.helm, 'army_helmet');
  // a second helmet from the backpack: it goes on, the first takes its cell
  p.inventory.push({ item: 'army_helmet', qty: 1, s: 5, dur: 1 });
  act(s, { type: 'use', item: 'army_helmet', from: { w: 'bag', s: 5 } });
  assert.strictEqual(p.inventory.find(st => st.s === H).dur, 1, 'that one is worn now');
  assert.strictEqual(p.inventory.find(st => st.s === 5 && st.item === 'army_helmet').dur, undefined, 'the other is in its cell');
  // the bag's own moves never reach what is worn, Sort leaves it, and what is worn is taken last
  assert.strictEqual(texts(act(s, { type: 'inv', from: { w: 'bag', s: A }, to: { w: 'bag', s: 9 } })), '');
  act(s, { type: 'inv', op: 'sort' });
  assert.ok(p.inventory.some(st => st.s === A) && p.inventory.some(st => st.s === H));
  World.take(p, 'army_helmet', 1);
  assert.strictEqual(p.equipment.helm, 'army_helmet', 'the one in the backpack went');
  World.take(p, 'army_helmet', 1);
  assert.strictEqual(p.equipment.helm, undefined, 'the last one: nothing is worn there now');
  // a character saved when worn things stayed in the bag: they move to their places once
  p.inventory = [{ item: 'leather_armor', qty: 1, s: 3 }]; p.equipment = { armor: 'leather_armor' }; delete p.wornV;
  World.normalize(s.c, p);
  assert.deepStrictEqual([p.inventory[0].s, p.equipment.armor, p.wornV], [A, 'leather_armor', 2]);
  // saved with four accessory places: the first two keep theirs, the other two go back into the backpack
  s.c.items.ringx = Object.assign({}, s.c.items.leather_armor, { id: 'ringx', name: 'Ring', slot: 'accessory' });
  p.inventory = [{ item: 'leather_armor', qty: 1, s: World.WORN_AT + 1 }, { item: 'ringx', qty: 1, s: World.WORN_AT + 7 }, { item: 'ringx', qty: 1, s: World.WORN_AT + 9 }];
  p.equipment = { armor: 'leather_armor', accessory2: 'ringx', accessory4: 'ringx' }; p.wornV = 1;
  World.normalize(s.c, p);
  assert.deepStrictEqual(p.inventory.map(st => st.s), [A, World.wornCell('accessory2'), 0]);
  assert.deepStrictEqual(Object.keys(p.equipment).sort(), ['accessory2', 'armor']);
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

test('the hut chest holds its contents once for each player, in a grid of their own', () => {
  const s = fresh();
  const held = inv => inv.reduce((o, st) => { o[st.item] = (o[st.item] || 0) + st.qty; return o; }, {});
  put(s, 'map_3', 9, 7, 'E');
  let ev = act(s, { type: 'interact' });
  assert.match(texts(ev), /You open the wooden chest/);
  assert.deepStrictEqual(held(ev.find(e => e.type === 'storage').inv), { potion: 2, wooden_sword: 1 }, 'it opens as a grid with the loot inside');
  assert.deepStrictEqual([World.count(s.p, 'potion'), World.count(s.p, 'wooden_sword')], [2, 1], 'nothing jumps into the bag (these are the start kit)');
  act(s, { type: 'inv', key: 'map_3.e14', from: { w: 'box', s: 0 }, to: { w: 'bag' } });
  assert.strictEqual(World.count(s.p, 'potion'), 4);
  ev = act(s, { type: 'interact' });
  assert.deepStrictEqual(held(ev.find(e => e.type === 'storage').inv), { wooden_sword: 1 }, 'opened again: what was left, and no second helping');
  const v = World.view(s.c, s.ws, 'map_3', s.p, [s.p]);
  assert.strictEqual(v.states['map_3.e14'], 'empty');               // the chest shows as opened to this player
  // another player still finds it full, and cannot reach into the first one's
  const q = World.newPlayer(s.c, 'p2', 'Other', 'rogue'); q.map = 'map_3'; q.x = 9; q.y = 7; q.facing = 'E';
  const ev2 = World.act(s.c, s.ws, q, { type: 'interact' }, 1000, mid, [q]);
  assert.deepStrictEqual(held(ev2.find(e => e.type === 'storage').inv), { potion: 2, wooden_sword: 1 });
  World.act(s.c, s.ws, q, { type: 'inv', key: 'map_3.e14', from: { w: 'box', s: 1 }, to: { w: 'bag' } }, 2000, mid, [q]);
  assert.deepStrictEqual(held(s.p.boxes['map_3:map_3.e14']), { wooden_sword: 1 }, 'the first player\'s is untouched');
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
  assert.strictEqual(World.count(s.p, 'slime_gel'), 0, 'the loot is not put in the bag');
  const sbag = World.structOf(s.ws, 'map_3').ents.find(b => b.ref === '_bag');
  assert.deepStrictEqual([sbag.x, sbag.y, sbag.inv.some(g => g.item === 'slime_gel' && g.own === s.p.id)], [slime.x, slime.y, true], 'it lies in a loot bag where the slime fell, theirs');   // dice 0.0 always passes the 60% roll
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
  assert.ok(ev.find(e => e.type === 'storage').inv.some(st => st.item === 'iron_armor' && st.qty === 1), 'the armour is inside, for you to take');
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
    assert.ok(World.beltOf(p).includes('potion'), cls + ' has a potion on the belt');
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
  assert.strictEqual(World.beltOf(s.p)[0], 'potion');                         // consumables go on the belt
  // the belt is ten slots; a character saved when the belt only named things in the bag (five slots, once): one stack
  // of each moves onto it, out of the backpack
  assert.strictEqual(World.BELT_SIZE, 10);
  s.p.inventory = [{ item: 'potion', qty: 2, s: 0 }, { item: 'wood', qty: 3, s: 1 }]; delete s.p.beltV; s.p.belt = ['potion', '', '', '', ''];
  World.normalize(s.c, s.p);
  assert.deepStrictEqual(World.beltOf(s.p), ['potion', '', '', '', '', '', '', '', '', '']);
  assert.deepStrictEqual(s.p.inventory.map(st => st.item + '@' + st.s), ['potion@' + World.BELT_AT, 'wood@1']);
  assert.strictEqual(s.p.belt, undefined); assert.strictEqual(s.p.beltV, 2);
  World.normalize(s.c, s.p);                                                   // (only once)
  assert.deepStrictEqual(World.beltOf(s.p)[0], 'potion');
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 9, entry: 'potion' }, 0, mid, [s.p]);
  assert.deepStrictEqual([World.beltOf(s.p)[0], World.beltOf(s.p)[9]], ['', 'potion'], 'it moves: never in two places');
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 10, entry: 'potion' }, 0, mid, [s.p]);
  assert.strictEqual(World.beltOf(s.p).length, 10);                            // no eleventh slot
  World.act(s.c, s.ws, s.p, { type: 'loadout', bar: 'belt', slot: 9, entry: '' }, 0, mid, [s.p]);
  assert.deepStrictEqual(s.p.inventory.map(st => st.item + '@' + st.s), ['potion@0', 'wood@1'], 'taken off the belt: back into the backpack');
  // Shift+click: a belt slot into the backpack with no cell named — onto a stack of it with room, else the first free cell
  const inv = () => s.p.inventory.map(st => st.item + st.qty + '@' + st.s).sort().join(' ');
  World.act(s.c, s.ws, s.p, { type: 'inv', from: { w: 'bag', s: 0 }, to: { w: 'belt', s: 4 } }, 0, mid, [s.p]);
  s.p.inventory.push({ item: 'potion', qty: 1, s: 7 });
  World.act(s.c, s.ws, s.p, { type: 'inv', from: { w: 'belt', s: 4 }, to: { w: 'bag' } }, 0, mid, [s.p]);
  assert.strictEqual(inv(), 'potion3@7 wood3@1', 'joined to the potion already in the backpack');
  World.act(s.c, s.ws, s.p, { type: 'inv', from: { w: 'bag', s: 1 }, to: { w: 'belt', s: 2 } }, 0, mid, [s.p]);
  World.act(s.c, s.ws, s.p, { type: 'inv', from: { w: 'belt', s: 2 }, to: { w: 'bag' } }, 0, mid, [s.p]);
  assert.strictEqual(inv(), 'potion3@7 wood3@0', 'the first free cell');
  // anything received that belongs on the belt goes there while a slot is free, even with some of it in the backpack
  World.give(s.c, s.p, 'potion', 2, []);
  assert.strictEqual(inv(), 'potion2@' + World.BELT_AT + ' potion3@7 wood3@0', 'a free belt slot, not the stack in the backpack');
  World.give(s.c, s.p, 'potion', 1, []);
  assert.strictEqual(inv(), 'potion3@' + World.BELT_AT + ' potion3@7 wood3@0', 'then onto that belt stack');
  World.give(s.c, s.p, 'wood', 2, []);
  assert.strictEqual(inv(), 'potion3@' + World.BELT_AT + ' potion3@7 wood5@0', 'materials go into the backpack');
});

test('the belt slot you hold decides the weapon; holding food puts the weapon away and eats nothing until used', () => {
  const s = hero('survivor', 3), p = s.p, act = a => World.act(s.c, s.ws, p, a, 0, mid, [p]);
  const at = id => World.beltOf(p).indexOf(id);
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
  const old = hero('warrior').p; delete old.held; clearBelt(old); delete old.beltV; old.belt = ['potion', '', '', '', ''];
  World.normalize(s.c, old);
  assert.strictEqual(World.beltOf(old)[old.held], 'wooden_sword');
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

test('a swing leaves a mark on the player that the others can see: a new number each time, where and how much', () => {
  const s = hero('warrior');
  const m = monster(s, 'skeleton', 10, 13);
  s.p.x = 9; s.p.y = 13;
  assert.ok(!s.p.act);
  const hp = m.hp;
  act(s, { type: 'attack', x: 10, y: 13 }, 1000);
  assert.deepStrictEqual(s.p.act.split(','), ['1', 'm', '10', '13', String(hp - m.hp)]);
  act(s, { type: 'attack', x: 10, y: 13 }, 1100);                      // too soon: no swing, no new mark
  assert.strictEqual(s.p.act.split(',')[0], '1');
  act(s, { type: 'attack', x: 10, y: 13 }, 2000);
  assert.strictEqual(s.p.act.split(',')[0], '2');
  act(s, { type: 'attack', x: 12, y: 13 }, 3000);                      // nothing there: nothing to show
  assert.strictEqual(s.p.act.split(',')[0], '2');
  // someone else on the map is told with the list of players
  const other = World.newPlayer(s.c, 'o', 'Other', 'warrior'); other.map = s.p.map;
  const seen = World.view(s.c, s.ws, other.map, other, [s.p, other]).players.find(q => q.id === s.p.id);
  assert.strictEqual(seen.act, s.p.act);
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

test('reloading takes the gun its time; a click on an empty clip starts it; the rounds go in at the end', () => {
  const s = hero('survivor');                                                     // pistol: clip 12, reserve 28
  s.p.x = 9; s.p.y = 13; monster(s, 'skeleton', 12, 13);
  s.c.items.pistol.reloadMs = 2000;
  s.p.mags.pistol = 0;                                                            // empty the magazine
  const ev = act(s, { type: 'shoot', x: 12, y: 13 }, 1000);                        // the click that finds it empty reloads
  assert.ok(ev.some(e => e.type === 'reload' && e.ms === 2000));
  assert.deepStrictEqual(s.p.reload, { id: 'pistol', at: 1000, until: 3000 });
  assert.deepStrictEqual(World.publicPlayer(s.c, s.p).reload, s.p.reload, 'the page is told, to draw the circle');
  assert.deepStrictEqual([s.p.mags.pistol, World.count(s.p, 'ammo_pistol')], [0, 28], 'nothing is in yet');
  assert.strictEqual(texts(act(s, { type: 'shoot', x: 12, y: 13 }, 2000)), '', 'no shooting while reloading');
  assert.strictEqual(s.p.mags.pistol, 0);
  const done = []; World.advance(s.c, s.ws, s.p.map, [s.p], 3000, mid, done);     // the world turning is enough to finish it
  assert.match(texts(done), /You reload the pistol\. 12\/12/);
  assert.strictEqual(s.p.reload, undefined);
  assert.strictEqual(s.p.mags.pistol, 12);                                        // refilled to the clip
  assert.strictEqual(World.count(s.p, 'ammo_pistol'), 16);                        // 28 - 12
  assert.match(texts(act(s, { type: 'reload' }, 4000)), /already loaded/);         // a full clip can't reload
  // R works the same; changing what is in hand drops it and costs nothing; an emptied gun is not refilled by drawing it again
  s.p.mags.pistol = 3;
  act(s, { type: 'reload' }, 5000);
  assert.strictEqual(s.p.reload.until, 7000);
  const slot = s.p.held;
  act(s, { type: 'hold', slot: -1 }, 5500); act(s, { type: 'hold', slot: slot }, 5600);
  act(s, { type: 'poll' }, 9000);
  assert.deepStrictEqual([s.p.reload, s.p.mags.pistol, World.count(s.p, 'ammo_pistol')], [undefined, 3, 16]);
  // with no time of its own a gun takes the Config's (1500 when unset), and 0 there means at once
  s.c.items.pistol.reloadMs = 0;
  assert.strictEqual(World.reloadMsOf(s.c, s.c.items.pistol), 1500);
  s.c.config.reload_ms = 0;
  act(s, { type: 'reload' }, 10000);
  assert.strictEqual(s.p.mags.pistol, 12);
  delete s.c.config.reload_ms;
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

test('shallow water (the map\'s shallow grid) is walked through; deep water and marked land are unchanged', () => {
  const c = Content.build({
    Terrain: [
      { id: 'grass', name: 'Grass', color: '#3a5', pass_n: 1, pass_e: 1, pass_s: 1, pass_w: 1 },
      { id: 'rock', name: 'Rock', color: '#555', pass_n: 0, pass_e: 0, pass_s: 0, pass_w: 0 },
      { id: 'water', name: 'Water', color: '#36c', pass_n: 0, pass_e: 0, pass_s: 0, pass_w: 0 }
    ],
    Maps: [{ id: 'm', name: 'M', width: 5, height: 1,
      terrain: JSON.stringify([['grass', 'grass', 'grass', 'grass', 'rock']]),
      overlay: JSON.stringify([['', 'water', 'water', '', '']]),
      shallow: JSON.stringify([['', '1', '', '', '1']]) }]
  });
  const map = c.maps.m;
  assert.ok(Rules.tryMove(c, map, 0, 0, 'E').ok, 'onto the shallow water');
  assert.ok(Rules.standable(c, map, 1, 0) && Rules.shallowAt(c, map, 1, 0), 'it can be stood in');
  assert.ok(!Rules.tryMove(c, map, 1, 0, 'E').ok, 'the deep water next to it still blocks');
  assert.ok(!Rules.standable(c, map, 4, 0), 'a shallow mark on ground that is not water changes nothing');
  assert.strictEqual(Rules.terrainAt(c, map, 1, 0).id, 'water', 'it is still that water');
  assert.ok(Rules.terrainAt(c, map, 1, 0).water, '…and still a water source');
  assert.ok(!c.terrain.water.pass.e, 'the terrain itself is not changed');
  assert.strictEqual(Rules.stepCost('E', c, map, 1, 0), 2, 'wading in costs twice a step (Config shallow_slow not said)');
  assert.strictEqual(Rules.stepCost('E', c, map, 0, 0), 1, 'dry ground costs one');
  assert.strictEqual(Rules.stepCost('NE', c, map, 1, 0), 2.8, 'a diagonal into it, 1.4 times that');
  c.config.shallow_slow = 1.5;
  assert.strictEqual(Rules.stepCost('E', c, map, 1, 0), 1.5, 'Config shallow_slow sets it');
});

test('a player wading into shallow water pays for the slower step out of the walking budget', () => {
  const s = fresh();
  const map = s.c.maps.map_3, x = s.p.x, y = s.p.y;
  map.shallow = map.terrain.map(r => r.map(() => ''));
  map.shallow[y][x + 1] = '1'; map.shallow[y][x + 2] = '1';
  const ov = map.overlay && map.overlay.length ? map.overlay : (map.overlay = map.terrain.map(r => r.map(() => '')));
  ov[y][x + 1] = 'water'; ov[y][x + 2] = 'water';
  if (!s.c.terrain.water) s.c.terrain.water = { id: 'water', name: 'Water', water: true, pass: { n: false, e: false, s: false, w: false } };
  map._at = null; map._block = null;
  assert.ok(Rules.tryMove(s.c, map, x, y, 'E').ok, 'the shallow water east of the start can be walked into');
  s.p.mvB = 3; s.p.mvT = 1000;
  act(s, { type: 'move', dirs: ['E', 'E', 'E'] }, 1000);
  assert.strictEqual(s.p.x, x + 1, 'a budget of 3 pays for one step into the water (2) but not the next (2)');
  assert.ok(Math.abs(s.p.mvB - 1) < 1e-9, 'one left');
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
  assert.strictEqual(Rules.tryMove(s.c, liveOf(s), 1, 3, 'N', {}).ok, true, 'and the doorway is open: the stretch of wall it hung in went with it');
  assert.strictEqual(World.structInfo(s.c, liveOf(s), { t: 'wall', orient: 'h', x: 1, y: 3 }), null);
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
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_hammer' })), /[+]1 Hammer/i);
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
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails', qty: 3 })), /[+]12 Nails/i);
  assert.deepStrictEqual([World.count(s.p, 'nails'), World.count(s.p, 'scrap'), World.count(s.p, 'hammer')], [12, 7, 1], 'the tool is not used up');
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails', qty: 20 })), /Not enough scrap metal/, 'all or nothing');
  assert.strictEqual(World.count(s.p, 'scrap'), 7);
});

test('a craft object with no station id is a station by its own id', () => {
  const s = camp();
  delete s.c.objects.t_bench.properties.station;
  s.c.recipes.r_nails.station = 't_bench';
  World.give(s.c, s.p, 'scrap', 10, []); World.give(s.c, s.p, 'hammer', 1, []);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails' })), /Needs a workbench nearby/, 'named after the object');
  put(s, 'camp', 4, 5, 'E');
  assert.strictEqual(recipe(s, 'r_nails').here, true);
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails' })), /[+]4 Nails/i);
});

test('crafting takes time: work counts only at the station, waits while you are away, and can be stopped', () => {
  const s = camp();
  s.c.recipes.r_nails.timeS = 4;
  World.give(s.c, s.p, 'scrap', 10, []); World.give(s.c, s.p, 'hammer', 1, []);
  put(s, 'camp', 4, 5, 'E');
  const tick = (t) => texts(act(s, { type: 'face', dir: 'E' }, t));
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_nails', qty: 2 }, 1000)), /You start on 2 × nails/);
  assert.deepStrictEqual([World.count(s.p, 'nails'), World.count(s.p, 'scrap')], [0, 8], 'the materials go in at the start');
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_hammer' }, 1500)), /already making something/);
  tick(4000);
  assert.strictEqual(World.count(s.p, 'nails'), 0, 'not yet');
  assert.match(tick(5100), /[+]4 Nails/i);
  assert.deepStrictEqual([s.p.craft.made, World.publicPlayer(s.c, s.p).craft.need], [1, 4000]);
  put(s, 'camp', 1, 1, 'N'); tick(6000); tick(30000);                 // away from the bench: nothing happens, however long
  assert.strictEqual(World.count(s.p, 'nails'), 4);
  assert.strictEqual(s.p.craft.on, false);
  put(s, 'camp', 4, 5, 'E'); tick(31000); tick(34000);
  assert.strictEqual(World.count(s.p, 'nails'), 4, 'the time away did not count');
  assert.match(tick(35000), /[+]4 Nails/i);
  assert.ok(!s.p.craft, 'done');
  // stopping gives back what was not used
  act(s, { type: 'craft', recipe: 'r_nails', qty: 3 }, 40000);
  tick(44100);
  assert.deepStrictEqual([World.count(s.p, 'nails'), World.count(s.p, 'scrap')], [12, 5]);
  assert.match(texts(act(s, { type: 'craft', cancel: true }, 45000)), /You stop/);
  assert.deepStrictEqual([World.count(s.p, 'scrap'), !!s.p.craft], [7, false]);
  // a page that stopped asking does not keep working: one gap counts for half a minute at most
  s.c.recipes.r_nails.timeS = 100;
  act(s, { type: 'craft', recipe: 'r_nails' }, 50000);
  tick(50000 + 3600000);
  assert.strictEqual(s.p.craft.ms, 30000);
});

test('what is in hand may be good against a material: an axe on wood', () => {
  const s = camp();
  s.c.objects.t_tree.properties.hp = 200;
  World.give(s.c, s.p, 'axe', 1, []);
  onBelt(s.p, 0, 'axe'); World.holdSlot(s.c, s.p, 0);
  assert.strictEqual(World.heldItem(s.c, s.p).id, 'axe');
  const blow = (t) => act(s, { type: 'attack', x: 1, y: 0 }, t).filter(e => e.type === 'hit')[0].amount;
  s.c.items.axe.vsMaterial = {}; s.c.items.axe.structureDmg = 3;
  const plain = blow(1000);
  s.c.items.axe.vsMaterial = { wood: 3 };
  assert.strictEqual(blow(5000), plain * 3);
  s.c.items.axe.vsMaterial = { stone: 8 };
  assert.strictEqual(blow(9000), plain, 'only against the material named');
  assert.deepStrictEqual(Content.build(Object.assign({}, tables, { Items: tables.Items.map(i => i.id === 'axe' ? Object.assign({}, i, { material_dmg: 'wood:3, stone:0.5' }) : i) })).items.axe.vsMaterial, { wood: 3, stone: 0.5 });
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

test('harvesting: the yield comes out as the resource is worked, and holding the button needs its tool in hand', () => {
  const s = camp();
  Object.assign(s.c.objects.t_tree.properties, { hp: 12, harvest: 'wood:6' });
  s.c.items.axe.vsMaterial = {}; s.c.items.axe.structureDmg = 3;
  World.give(s.c, s.p, 'axe', 1, []);
  const live = () => World.liveMap(s.c, s.ws, 'camp');
  assert.strictEqual(World.harvestWith(s.c, live(), s.p, 1, 0), null, 'the axe is in the bag, not in hand');
  onBelt(s.p, 0, 'axe'); World.holdSlot(s.c, s.p, 0);
  assert.strictEqual(World.harvestWith(s.c, live(), s.p, 1, 0).key, 'camp.e2');
  assert.strictEqual(World.harvestWith(s.c, live(), s.p, 5, 5), null, 'not a resource, and not next to you');
  let now = 1000, got = [];
  while (World.structInfo(s.c, live(), { t: 'ent', key: 'camp.e2' }) && got.length < 20) { now += 2000; act(s, { type: 'attack', x: 1, y: 0 }, now); got.push(World.count(s.p, 'wood')); }
  assert.ok(got.length >= 3, 'it takes several blows');
  assert.ok(got[0] < 6 && got[got.length - 2] < 6 && got[got.length - 2] > 0, 'some of it before the end: ' + got.join(','));
  assert.strictEqual(got[got.length - 1], 6, 'and all of it, no more, when it falls');
  assert.strictEqual(World.harvestWith(s.c, live(), s.p, 1, 0), null, 'nothing left to work');
  s.c.objects.t_tree.properties.harvest_tool = '';
  World.advance(s.c, s.ws, 'camp', [s.p], now + 61000, mid, []);
  World.holdSlot(s.c, s.p, -1);
  assert.ok(World.harvestWith(s.c, live(), s.p, 1, 0), 'a resource that asks for no tool can be worked with anything');
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

test('nothing is built on ground nobody can walk on (water), whichever layer it is painted on; a wall may follow the shore', () => {
  const s = yard(), m = s.c.maps.yard;
  assert.ok(s.c.terrain.l_water, 'the yard knows water');
  m.overlay = m.terrain.map(r => r.map(() => ''));
  m.overlay[4][5] = 'l_water'; m.overlay[4][6] = 'l_water';
  const lk = () => World.viewLookup(s.c, yardMap(s), { states: {}, monsters: [], players: [] }, s.p);
  const ghost = (bp, x, y, side) => World.canBuild(s.c, yardMap(s), lk(), s.p, s.c.blueprints[bp], x, y, side);
  assert.strictEqual(ghost('bp_crate', 5, 4).reason, "You can't build on water.");
  assert.match(doAct(s, { type: 'build', bp: 'bp_crate', x: 5, y: 4 }), /can't build on water/);
  assert.strictEqual(ghost('bp_wood_wall', 6, 4, 'W').reason, "You can't build on water.", 'water on both sides of the wall');
  assert.strictEqual(ghost('bp_wood_wall', 5, 4, 'N').ok, true, 'along the shore is fine');
  m.overlay = null;
  assert.strictEqual(ghost('bp_crate', 5, 4).ok, true);
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

const boxOf = inv => inv.reduce((o, st) => { o[st.item] = (o[st.item] || 0) + st.qty; return o; }, {});   // what a container holds, per item
test('a container placed on the map opens as a grid: its loot is inside, and what you leave stays for the next visitor', () => {
  const c = Content.build(tables), ws = { maps: {} }, m = c.maps[c.config.start_map];
  const e = m.entities.find(en => c.objects[en.ref] && c.objects[en.ref].kind === 'container' && !World.props(c, en).per_player && !World.props(c, en).locked);
  assert.ok(e, 'the start map has an open container');
  e.data = Object.assign({}, e.data, { contents: 'wood:3, potion:1' });
  const p = World.newPlayer(c, 'p1', 'Ana', c.config.start_class), q = World.newPlayer(c, 'p2', 'Ben', c.config.start_class);
  [p, q].forEach(x => Object.assign(x, { map: m.id, x: e.x, y: e.y + 1, facing: 'N', inventory: [] }));
  let now = 1000;
  const go = (who, act1) => World.act(c, ws, who, act1, now += 3000, mid, [p, q]);
  let ev = go(p, { type: 'interact', x: e.x, y: e.y });
  const box = ev.find(x => x.type === 'storage');
  assert.ok(box && box.key === e.key && box.slots === 8, 'it opens as storage, with its capacity as cells');
  assert.deepStrictEqual(boxOf(box.inv), { wood: 3, potion: 1 });
  assert.strictEqual(World.count(p, 'wood'), 0, 'nothing went straight into the bag');
  go(p, { type: 'inv', key: e.key, from: { w: 'box', s: 0 }, to: { w: 'bag' } });
  assert.strictEqual(World.count(p, 'wood'), 3);
  World.give(c, p, 'nails', 4, []);
  go(p, { type: 'inv', key: e.key, from: { w: 'bag', s: p.inventory.find(st => st.item === 'nails').s }, to: { w: 'box', s: 5 } });
  ev = go(q, { type: 'interact', x: e.x, y: e.y });
  assert.deepStrictEqual(boxOf(ev.find(x => x.type === 'storage').inv), { potion: 1, nails: 4 }, 'the next one finds what is left, and no second helping of loot');
  Object.assign(q, { x: e.x + 5 });
  assert.match(texts(go(q, { type: 'inv', key: e.key, from: { w: 'box', s: 5 }, to: { w: 'bag' } })), /Too far away/);
});

test('stacks sit in cells: an item fills its stack and starts another; things given are never lost', () => {
  const s = yard();
  s.p.inventory = [];
  s.c.items.wood.stackMax = 20; s.c.config.bag_slots = 4;
  World.give(s.c, s.p, 'wood', 45, []);
  assert.deepStrictEqual(s.p.inventory, [{ item: 'wood', qty: 20, s: 0 }, { item: 'wood', qty: 20, s: 1 }, { item: 'wood', qty: 5, s: 2 }]);
  assert.strictEqual(World.count(s.p, 'wood'), 45);
  assert.ok(World.take(s.p, 'wood', 30));
  assert.deepStrictEqual(s.p.inventory, [{ item: 'wood', qty: 15, s: 0 }], 'taken from the last stacks first');
  World.give(s.c, s.p, 'nails', 1, []); World.give(s.c, s.p, 'hammer', 1, []); World.give(s.c, s.p, 'axe', 1, []);
  assert.deepStrictEqual(World.beltOf(s.p).slice(0, 2), ['hammer', 'axe'], 'tools go on the belt, not into the bag');
  World.give(s.c, s.p, 'leather_armor', 1, []); World.give(s.c, s.p, 'army_helmet', 1, []);
  const ev = [];
  World.give(s.c, s.p, 'scrap', 2, ev);
  assert.match(texts(ev), /Your bag is overfull/);
  assert.strictEqual(s.p.inventory.find(st => st.item === 'scrap').s, 4, 'past the last cell, but not lost');
  // a save from before cells: every stack gets one, and one over its limit is split
  const old = { inventory: [{ item: 'wood', qty: 50 }, { item: 'nails', qty: 3 }] };
  World.normalize(s.c, Object.assign(s.p, old));
  assert.deepStrictEqual(s.p.inventory.map(st => st.item + st.qty + '@' + st.s).sort(), ['nails3@3', 'wood10@0', 'wood20@1', 'wood20@2']);
});

test('moving stacks: to a cell, onto the same item, swapping, splitting, and in and out of a crate', () => {
  const s = yard();
  doAct(s, { type: 'build', bp: 'bp_crate', x: 5, y: 4 });
  const crate = yardMap(s).entities.filter(e => e.ref === 'obj_crate')[0];
  for (let i = 0; i < 3; i++) doAct(s, { type: 'work', target: { t: 'ent', key: crate.key } });
  s.c.items.wood.stackMax = 20; s.c.items.nails.stackMax = 50;
  s.p.inventory = []; s.p.equipment = {};
  World.give(s.c, s.p, 'wood', 30, []); World.give(s.c, s.p, 'nails', 8, []);          // wood 20 @0, wood 10 @1, nails 8 @2
  const bag = () => s.p.inventory.map(st => st.item + st.qty + '@' + st.s).sort().join(' ');
  const box = () => crate.inv.map(st => st.item + st.qty + '@' + st.s).sort().join(' ');
  const mv = (from, to, qty) => doAct(s, { type: 'inv', key: crate.key, from, to, qty });
  mv({ w: 'bag', s: 2 }, { w: 'bag', s: 7 });
  assert.strictEqual(bag(), 'nails8@7 wood10@1 wood20@0', 'to an empty cell');
  mv({ w: 'bag', s: 1 }, { w: 'bag', s: 5 }, 4);
  assert.strictEqual(bag(), 'nails8@7 wood20@0 wood4@5 wood6@1', 'part of a stack: split');
  mv({ w: 'bag', s: 5 }, { w: 'bag', s: 1 });
  assert.strictEqual(bag(), 'nails8@7 wood10@1 wood20@0', 'onto the same item: joined');
  mv({ w: 'bag', s: 1 }, { w: 'bag', s: 0 });
  assert.strictEqual(bag(), 'nails8@7 wood10@0 wood20@1', 'onto a full stack of the same: they change places');
  mv({ w: 'bag', s: 7 }, { w: 'bag', s: 0 });
  assert.strictEqual(bag(), 'nails8@0 wood10@7 wood20@1', 'onto something else: they change places');
  assert.match(mv({ w: 'bag', s: 0 }, { w: 'bag', s: 1 }, 3), /That cell is taken/);
  assert.match(mv({ w: 'bag', s: 0 }, { w: 'bag', s: 99 }), /no room there/);
  // the crate (12 cells)
  mv({ w: 'bag', s: 1 }, { w: 'box', s: 3 });
  assert.deepStrictEqual([bag(), box()], ['nails8@0 wood10@7', 'wood20@3']);
  mv({ w: 'bag', s: 7 }, { w: 'box' }, 5);
  assert.deepStrictEqual([bag(), box()], ['nails8@0 wood5@7', 'wood20@3 wood5@0'], 'no cell named: wherever it fits');
  mv({ w: 'bag', s: 0 }, { w: 'box', s: 3 });
  assert.deepStrictEqual([bag(), box()], ['wood20@0 wood5@7', 'nails8@3 wood5@0'], 'a swap across the two');
  mv({ w: 'box', s: 3 }, { w: 'bag', s: 2 }, 3);
  assert.deepStrictEqual([bag(), box()], ['nails3@2 wood20@0 wood5@7', 'nails5@3 wood5@0']);
  assert.match(mv({ w: 'box', s: 9 }, { w: 'bag' }), /nothing there/);
  assert.match(mv({ w: 'bag', s: 0 }, { w: 'box', s: 12 }), /no room there/);
  s.c.config.bag_slots = 3;
  World.give(s.c, s.p, 'army_helmet', 1, []);                                            // cells 0,1,2 taken (7 is past the end)
  crate.inv.push({ item: 'scrap', qty: 2, s: 6 });
  assert.match(mv({ w: 'box', s: 6 }, { w: 'bag' }), /Your bag is full/);
  assert.strictEqual(World.count(s.p, 'scrap'), 0, 'a full bag takes nothing more…');
  mv({ w: 'box', s: 0 }, { w: 'bag' });
  assert.strictEqual(World.count(s.p, 'wood'), 30, '…unless it fits on a stack already there');
  // what you hold goes away with its last stack
  s.c.config.bag_slots = 32;
  World.give(s.c, s.p, 'wooden_sword', 1, []); onBelt(s.p, 0, 'wooden_sword'); World.holdSlot(s.c, s.p, 0);
  assert.strictEqual(s.p.equipment.weapon, 'wooden_sword');
  mv({ w: 'bag', s: s.p.inventory.find(st => st.item === 'wooden_sword').s }, { w: 'box' });
  assert.strictEqual(s.p.equipment.weapon, undefined);
  put(s, 'yard', 1, 1, 'N');
  assert.match(mv({ w: 'bag', s: 0 }, { w: 'box' }), /Too far away/);
});

test('any container a player builds is storage: no storage setting needed, its capacity is its cells, and it never comes with loot', () => {
  const s = yard();
  s.c.objects.obj_crate.properties = { loot_table: 'barrel', capacity: 20 };            // a container object as the map editor makes them
  doAct(s, { type: 'build', bp: 'bp_crate', x: 5, y: 4 });
  const crate = yardMap(s).entities.filter(e => e.ref === 'obj_crate')[0];
  for (let i = 0; i < 3; i++) doAct(s, { type: 'work', target: { t: 'ent', key: crate.key } });
  const rec = s.ws.maps.yard.struct.ents.find(b => b.key === crate.key);
  delete rec.inv;                                                                       // …and one built before this rule had no list of its own
  const bag0 = JSON.stringify(s.p.inventory), gold0 = s.p.gold;
  const ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 5, y: 4 }, clock += 5000, dice([0.0]), [s.p]);
  const box = ev.find(e => e.type === 'storage');
  assert.ok(box && box.slots === 20 && box.inv.length === 0, 'an empty grid of 20 cells');
  assert.deepStrictEqual([JSON.stringify(s.p.inventory), s.p.gold], [bag0, gold0], 'no loot from a crate you built yourself');
  const cell = s.p.inventory.find(st => st.item === 'wood').s;
  doAct(s, { type: 'inv', key: crate.key, from: { w: 'bag', s: cell }, to: { w: 'box', s: 19 } });
  assert.deepStrictEqual(rec.inv.map(st => st.item + '@' + st.s), ['wood@19']);
});

test('a storage crate keeps what you put in; smashed, it leaves the contents in a loot bag', () => {
  const s = yard();
  doAct(s, { type: 'build', bp: 'bp_crate', x: 5, y: 4 });
  const crate = yardMap(s).entities.filter(e => e.ref === 'obj_crate')[0];
  for (let i = 0; i < 3; i++) doAct(s, { type: 'work', target: { t: 'ent', key: crate.key } });
  let ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 5, y: 4 }, clock += 5000, mid, [s.p]);
  assert.ok(ev.some(e => e.type === 'storage' && e.key === crate.key && e.slots === 12), 'using it shows what is inside');
  const wood0 = World.count(s.p, 'wood');
  doAct(s, { type: 'store', key: crate.key, op: 'put', item: 'wood', qty: 10 });
  doAct(s, { type: 'store', key: crate.key, op: 'put', item: 'nails', qty: 5 });
  assert.deepStrictEqual(boxOf(crate.inv), { wood: 10, nails: 5 });
  assert.strictEqual(World.count(s.p, 'wood'), wood0 - 10);
  put(s, 'yard', 4, 4, 'E');
  ev = World.act(s.c, s.ws, s.p, { type: 'interact' }, clock += 5000, mid, [s.p]);
  assert.ok(ev.some(e => e.type === 'storage' && boxOf(e.inv).wood === 10), 'the use key opens the crate you face');
  doAct(s, { type: 'store', key: crate.key, op: 'take', item: 'wood', qty: 4 });
  assert.deepStrictEqual([boxOf(crate.inv).wood, World.count(s.p, 'wood')], [6, wood0 - 6]);
  assert.match(doAct(s, { type: 'store', key: crate.key, op: 'take', item: 'scrap', qty: 1 }), /none in there/);
  assert.match(doAct(s, { type: 'dismantle', target: { t: 'ent', key: crate.key } }), /Empty it first/);
  assert.strictEqual(World.view(s.c, s.ws, 'yard', s.p, [s.p], -1).struct.ents[0].inv, undefined, 'contents are not broadcast with the map');
  World.damageStructure(s.c, s.ws, 'yard', { t: 'ent', key: crate.key }, 999, { kind: 'blast', now: clock }, []);
  const left = yardMap(s).entities.filter(e => e.x === 5 && e.y === 4);
  assert.deepStrictEqual(left.map(e => e.ref), ['_bag']);
  assert.deepStrictEqual(boxOf(left[0].inv), { wood: 6, nails: 5 }, 'nothing was lost');
  assert.strictEqual(Rules.tryMove(s.c, yardMap(s), 4, 4, 'E', {}).ok, true, 'the bag can be walked over');
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
  assert.strictEqual(boxOf(crate.inv).wood, 5);
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
  assert.ok(World.beltOf(s.p).indexOf('apple') >= 0, 'it belongs on the belt like any consumable: it went there');
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

// ---------------------------------------------------------------- monster brains: the walker
// A walker dropped into a test map. `over` = settings of its monster def (sight, aggroS, ...).
function withWalker(s, mapId, x, y, over) {
  s.c.monsters.walker = Object.assign({}, s.c.monsters.walker, { brain: 'walker', sight: 8, aggroS: 30, infectChance: 0 }, over || {});
  const w = { ref: 'walker', id: 'walker#0', x, y, dead: false, hp: s.c.monsters.walker.hp, statuses: [], last: 0, facing: 'S' };
  const ms = World.mapState(s.ws, mapId);
  ms.monsters = [w]; ms.spawnSig = '';
  s.at = 0; s.mapId = mapId;
  return w;
}
// The world moves on one walker step at a time; returns everything that happened.
function turns(s, n, rng) {
  let ev = [];
  for (let i = 0; i < n; i++) { s.at += s.c.monsters.walker.moveMs; const e = []; World.advance(s.c, s.ws, s.mapId, [s.p], s.at, rng || mid, e); ev = ev.concat(e); }
  return ev;
}
const DOOR = { t: 'ent', key: 'arena.e1' };

test('walker: it must see you to come after you; a wall in between and it does not know you are there', () => {
  const s = arena();
  put(s, 'arena', 3, 5, 'N');                                  // south of the wall that crosses the arena, door shut
  const w = withWalker(s, 'arena', 3, 1);                      // north of it, 4 tiles away: well inside its range
  turns(s, 6);
  assert.strictEqual(w.ai, undefined, 'nothing to go after');
  assert.strictEqual(s.p.hp, World.stats(s.c, s.p).maxHp);
  // the plain brain, with stealth on, cannot see through the wall either, and you stand still (silent)
  s.c.monsters.walker.brain = '';
  w.x = 3; w.y = 1;
  turns(s, 2, dice([0.9]));                                    // (a die that never has it wander)
  assert.deepStrictEqual([w.x, w.y], [3, 1], 'stealth: it does not know you are there');
  // with Config stealth off it is drawn through the wall, as before
  s.c.config.stealth = 'off';
  turns(s, 2);
  assert.deepStrictEqual([w.x, w.y], [3, 2], 'pressed against the wall, as before');
});

test('walker: no player around and it is inert; one comes near and it wakes', () => {
  const s = arena();
  s.c.config.walker_wake_radius = 2;
  put(s, 'arena', 6, 0, 'S');
  const w = withWalker(s, 'arena', 0, 0);                      // in plain sight along the top row, but nobody is near it
  turns(s, 8, dice([0.1]));                                    // (this die would have it wander every turn)
  assert.deepStrictEqual([w.x, w.y, w.ai], [0, 0, undefined]);
  put(s, 'arena', 2, 0, 'S');
  turns(s, 1);
  assert.strictEqual(w.ai.k, 'p', 'now somebody is there to set it off');
});

test('walker: it hunts what it sees, keeps looking after losing sight, and gives up when its aggro has run out', () => {
  const s = arena();
  put(s, 'arena', 6, 0, 'S');
  const w = withWalker(s, 'arena', 0, 0, { aggroS: 5, aggro: 2 });
  turns(s, 2);
  assert.deepStrictEqual([w.ai.k, w.ai.id, w.ai.a, w.x], ['p', 'p1', 5000, 2], 'seen: full aggro, and on its way');
  const shownAs = () => (World.view(s.c, s.ws, 'arena', s.p, [s.p]).monsters[0] || {}).alert;
  assert.deepStrictEqual([World.alertOf(w), shownAs()], [2, 2], 'the page is told it has someone in sight (the ! over its head)');
  put(s, 'arena', 6, 6, 'S');                                  // gone behind the wall, too far to hear
  turns(s, 1);
  assert.ok(w.ai && w.ai.a < 5000, 'out of sight: the aggro starts to run down');
  assert.deepStrictEqual([World.alertOf(w), shownAs()], [1, 1], 'and that it is now looking for them (the ?)');
  assert.deepStrictEqual([w.ai.x, w.ai.y], [6, 0], 'it still makes for where it last saw them');
  // it survives being saved and loaded, and a night with nobody on the map costs it nothing
  const left = w.ai.a;
  s.ws = JSON.parse(JSON.stringify(s.ws));
  const w2 = World.mapState(s.ws, 'arena').monsters[0];
  s.at += 8 * 3600 * 1000;
  const e = []; World.advance(s.c, s.ws, 'arena', [s.p], s.at, mid, e);
  assert.ok(w2.ai && w2.ai.k === 'p' && w2.ai.a >= left - 2 * 1100, 'still hunting the next morning');
  turns(s, 6);
  assert.strictEqual(w2.ai, undefined, 'and after its few seconds of looking, it lets go');
  assert.deepStrictEqual([World.alertOf(w2), shownAs()], [0, undefined]);
});

test('walker: its target behind a shut door, it breaks the door down, comes through and attacks', () => {
  const s = arena();
  put(s, 'arena', 0, 0, 'S');
  const w = withWalker(s, 'arena', 2, 2, { aggro: 6 });        // door hp 12, plank wall hp 20, its blows do 6
  turns(s, 1);
  assert.strictEqual(w.ai.k, 'p');
  put(s, 'arena', 1, 5, 'N');                                  // the player slips to the far side; it hears them there
  s.p.stepAt = 1e15;                                           // (walking about all the while: making noise, World.noiseOf)
  const ev = turns(s, 8);
  const hits = ev.filter(e => e.type === 'hit' && e.struct);
  assert.deepStrictEqual(hits.map(e => e.struct), ['arena.e1', 'arena.e1'], 'two blows, both on the door: the weakest way in');
  assert.strictEqual(World.structInfo(s.c, liveOf(s), DOOR), null, 'the door is gone');
  assert.strictEqual(World.structInfo(s.c, liveOf(s), WALL(2)).hp, 20, 'the wall beside it was never touched');
  assert.ok(w.y >= 3, 'it came through the doorway');
  assert.match(texts(ev), /The walker hits you for/);
});

test('walker: the way it works out counts blows as steps: a weak door before a wall, and never what it cannot break', () => {
  const s = arena();
  const w = withWalker(s, 'arena', 2, 2);
  const to = (x, y) => (ax, ay) => ax === x && ay === y;
  assert.strictEqual(World.findPath(s.c, s.ws, 'arena', liveOf(s), w, to(1, 4), 6, { obst: {} }), 'WSS', 'through the door');
  assert.strictEqual(World.findPath(s.c, s.ws, 'arena', liveOf(s), w, to(3, 4), 6, { obst: {} }), 'ESS', 'through the planks when the door is the long way');
  assert.strictEqual(World.findPath(s.c, s.ws, 'arena', liveOf(s), w, to(1, 4), 0, { obst: {} }), null, 'on foot alone there is no way');
  w.x = 5; w.y = 2;
  assert.strictEqual(World.findPath(s.c, s.ws, 'arena', liveOf(s), w, to(5, 3), 6, { obst: {} }), 'WWSEE', 'never through brick it cannot break: along to the planks');
});

function walkerYard(cfg) {
  const s = yard();
  Object.assign(s.c.config, cfg || {});
  doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' });
  const rec = World.structInfo(s.c, yardMap(s), N44).rec;
  rec.prog = rec.need; rec.hp = rec.max;                       // a finished wall north of the builder: 40 health
  return s;
}

test('walker: what players built draws it like a player would, and it tears it down to get at who is behind', () => {
  const s = walkerYard();
  const w = withWalker(s, 'yard', 4, 1);                       // the wall hides the builder from it
  turns(s, 1);
  assert.deepStrictEqual([w.ai.k, w.ai.t], ['s', N44]);
  let ev = turns(s, 3);
  assert.deepStrictEqual([w.x, w.y], [4, 3], 'it walks up to the wall');
  assert.ok(ev.some(e => e.type === 'hit' && e.struct === 'h4,4'), 'and starts on it');
  ev = ev.concat(turns(s, 8));
  assert.strictEqual(World.structInfo(s.c, yardMap(s), N44), null, 'seven blows and the wall is down');
  assert.strictEqual(w.ai.k, 'p', 'through the hole it had beaten in it, it saw the builder');
  assert.match(texts(ev), /The walker hits you for/);
});

test('walker: Config walkers_attack_buildings = off leaves buildings alone', () => {
  const s = walkerYard({ walkers_attack_buildings: 'off' });
  const w = withWalker(s, 'yard', 4, 1);
  turns(s, 6);
  assert.strictEqual(w.ai, undefined);
  assert.strictEqual(World.structInfo(s.c, yardMap(s), N44).hp, 40);
});

test('walker: a living target comes before a building, and a building is left when one shows up', () => {
  const s = walkerYard();
  const w = withWalker(s, 'yard', 4, 1);
  turns(s, 2);
  assert.strictEqual(w.ai.k, 's');
  put(s, 'yard', 1, 1, 'S');                                   // the builder steps out into the open
  turns(s, 1);
  assert.deepStrictEqual([w.ai.k, w.ai.id], ['p', 'p1']);
});

test('walker: it hunts prey animals too, once a player is around to see it start, and stops when it has won', () => {
  const s = arena();
  s.c.config.walker_wake_radius = 3;
  s.c.monsters.deer = Object.assign({}, s.c.monsters.rat, { id: 'deer', name: 'Deer', prey: true, hp: 10, aggro: 0, moveMs: 600000 });
  put(s, 'arena', 6, 6, 'N');                                  // the player is south of the wall, out of sight and far away
  const w = withWalker(s, 'arena', 0, 0);
  const deer = { ref: 'deer', id: 'deer#0', x: 3, y: 0, dead: false, hp: 10, statuses: [], last: 0, respawnAt: 0 };
  World.mapState(s.ws, 'arena').monsters.push(deer);
  turns(s, 3);
  assert.strictEqual(w.ai, undefined, 'nobody near: inert');
  s.c.config.walker_wake_radius = 24;
  turns(s, 1);
  assert.deepStrictEqual([w.ai.k, w.ai.id], ['m', 'deer#0']);
  turns(s, 6);
  assert.strictEqual(deer.dead, true, 'it caught the deer');
  assert.strictEqual(w.ai, undefined, 'and with that it is done');
});

// ---------------------------------------------------------------- stealth (docs/STEALTH.md, stage 1)
test('stealth: a monster SEES a player in its range with a clear line, HEARS one who walks, and notices nothing else', () => {
  const s = arena(), map = liveOf(s), def = { aggro: 6, hearing: 1 }, m = { x: 3, y: 1 };
  const at = (x, y, o) => Object.assign({ x, y }, o || {});
  const N = (p, o) => World.notices(s.c, map, m, def, p, 10000, 6, stOf(s), o);
  assert.strictEqual(N(at(3, 0)), 'seen', 'in the open, in range');
  assert.strictEqual(N(at(3, 5)), '', 'behind the wall, standing still: nothing at all');
  assert.strictEqual(N(at(3, 5, { stepAt: 9500 })), 'heard', 'behind the wall, walking: heard (noise_walk 6 tiles, walls or not)');
  assert.strictEqual(N(at(3, 5, { stepAt: 9500, sneak: true })), '', 'sneaking: only 2 tiles of noise');
  assert.strictEqual(N(at(3, 3, { stepAt: 9500, sneak: true })), 'heard', '…which carries that far');
  assert.strictEqual(N(at(3, 5, { stepAt: 8000 })), '', 'a moment after the last step it is quiet again');
  assert.strictEqual(N(at(0, 1, { sneak: true })), 'seen', 'sneaking in the open, 3 tiles off: seen (sight 6 × Config sneak_sight 0.6 = 3.6)');
  m.x = 0; m.y = 0;
  assert.strictEqual(N(at(4, 0, { sneak: true })), '', 'sneaking 4 tiles off in the open: not seen');
  assert.strictEqual(N(at(4, 0)), 'seen', 'walking there: seen');
  m.x = 3; m.y = 1;
  assert.strictEqual(World.notices(s.c, map, m, { aggro: 6, hearing: 0 }, at(3, 5, { stepAt: 9500 }), 10000, 6, stOf(s)), '', 'Monsters hearing 0: deaf');
  assert.strictEqual(World.notices(s.c, map, m, { aggro: 6, hearing: 2 }, at(3, 6, { stepAt: 9500, sneak: true }), 10000, 6, stOf(s)), '', 'hearing 2: sneaking reaches 4 tiles, not 5');
  assert.strictEqual(World.notices(s.c, map, m, { aggro: 6, hearing: 2 }, at(3, 5, { stepAt: 9500, sneak: true }), 10000, 6, stOf(s)), 'heard');
  s.c.config.stealth = 'off';
  assert.strictEqual(N(at(3, 5)), 'seen', 'stealth off: within range is enough, through walls (the old plain brain)');
  assert.strictEqual(N(at(3, 5), { los: true }), '', '…but a walker still has to see');
});

test('stealth: the sight area drawn while sneaking is exactly where notices would say seen', () => {
  const s = arena(), map = liveOf(s);
  ['walker', '', 'hunter', 'animal'].forEach(brain => {
    const def = Object.assign({}, s.c.monsters.rat, { brain, aggro: 6, sight: 6, fleeRange: 6 }), m = { x: 3, y: 1 };
    const area = World.sightArea(s.c, map, m, def, true, stOf(s), 0);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const how = World.notices(s.c, map, m, def, { x, y, sneak: true }, 0, World.lookRange(def, m, 0), stOf(s), { manhattan: !brain, los: brain === 'walker' });
      assert.strictEqual(!!area[x + ',' + y], how === 'seen', (brain || 'plain') + ' at ' + x + ',' + y);
    }
    assert.ok(!area['3,5'], 'nothing behind the wall');
  });
});

test('stealth: a monster sees its full range only in a cone in front of it (Config sight_cone, back_sight)', () => {
  const s = arena(), map = liveOf(s), def = { aggro: 6, hearing: 1 };
  s.c.config.sight_cone = 120; s.c.config.cone_reach = 1;      // (a wide cone with no extra reach; the tests' fixture says 360)
  const m = { x: 3, y: 1, facing: 'W' };
  const N = (x, y) => World.notices(s.c, map, m, def, { x, y }, 0, 6, stOf(s));
  assert.strictEqual(N(0, 1), 'seen', 'straight ahead');
  assert.strictEqual(N(1, 0), 'seen', 'ahead and a little aside (within 60 degrees)');
  assert.strictEqual(N(3, 0), '', 'beside it: not seen');
  assert.strictEqual(N(4, 1), '', 'right behind it, next to it: not seen (back_sight 0)');
  s.c.config.back_sight = 0.5;
  assert.strictEqual(N(4, 1), 'seen', 'back_sight 0.5: three tiles behind it');
  assert.strictEqual(N(6, 0), '', '(a cone counts straight-line distance: that is 3.2 tiles)');
  m.x = 0; assert.strictEqual(N(4, 1), '', '…but not four');
  m.x = 3; s.c.config.back_sight = 0;
  const area = World.sightArea(s.c, map, m, Object.assign({}, def, { brain: 'walker', sight: 6 }), false, stOf(s), 0);
  assert.ok(area['0,1'] && area['1,2'] && !area['4,1'] && !area['3,2'] && !area['6,0'], 'the area drawn is the same cone');
  m.facing = 'E';
  assert.strictEqual(N(4, 1), 'seen', 'it turns round: now it does');
  s.c.config.stealth = 'off';
  m.facing = 'W';
  assert.strictEqual(N(4, 1), 'seen', 'stealth off: no cone, as before');
});

test('stealth: the cone is long rather than wide: 60 degrees, and 1.5 times the range straight ahead', () => {
  const s = arena(), map = liveOf(s), def = { aggro: 4, hearing: 1 };
  delete s.c.config.sight_cone;                                // (the defaults; the tests' fixture says 360)
  const m = { x: 0, y: 0, facing: 'E' };
  const N = (x, y) => World.notices(s.c, map, m, def, { x, y }, 0, 4, stOf(s));
  assert.strictEqual(N(6, 0), 'seen', 'six tiles straight ahead, with a range of 4');
  assert.strictEqual(N(1, 2), '', 'two tiles off, but too far to the side');
  s.c.config.cone_reach = 1;
  assert.strictEqual(N(6, 0), '', 'Config cone_reach 1: only its range');
});

test('stealth: a roaming monster that cannot step a way still turns to look that way', () => {
  const s = arena();
  const rat = { ref: 'rat', id: 'rat#0', x: 6, y: 0, dead: false, hp: 5, statuses: [], last: 0, respawnAt: 0, facing: 'S' };
  const ms = World.mapState(s.ws, 'arena'); ms.monsters = [rat]; ms.spawnSig = '';
  put(s, 'arena', 0, 6, 'N');                                  // far off, behind the wall: nothing to go after
  World.advance(s.c, s.ws, 'arena', [s.p], s.c.monsters.rat.moveMs, dice([0.1, 0.3]), []);   // wander, east: off the map
  assert.deepStrictEqual([rat.x, rat.y, rat.facing], [6, 0, 'E']);
});

test('stealth: a blow on a monster that has not seen you is a sneak attack (Config ambush_mult)', () => {
  function fight(face, cfg) {
    const s = arena(); Object.assign(s.c.config, { sight_cone: 120, ambush_mult: 2 }, cfg || {});
    s.c.monsters.rat = Object.assign({}, s.c.monsters.rat, { hp: 99, def: 0 });
    const rat = { ref: 'rat', id: 'rat#0', x: 3, y: 1, dead: false, hp: 99, statuses: [], last: 1e15, respawnAt: 0, facing: face };
    const ms = World.mapState(s.ws, 'arena'); ms.monsters = [rat]; ms.spawnSig = '';
    put(s, 'arena', 3, 2, 'N');                                // right behind it, when it faces north
    const ev = act(s, { type: 'attack', x: 3, y: 1 }, 5000);
    return { dmg: 99 - rat.hp, text: texts(ev), rat, s };
  }
  const plain = fight('S').dmg;                                // it faces you: an ordinary blow
  const back = fight('N');
  assert.strictEqual(back.dmg, plain * 2, 'from behind: twice the damage');
  assert.match(back.text, new RegExp('for ' + back.dmg + '\\. A sneak attack!'));
  assert.strictEqual(fight('N', { stealth: 'off' }).dmg, plain, 'stealth off: no such thing');
  const again = back.s, rat = back.rat, hp = rat.hp;
  again.p.nextAttack = 0; act(again, { type: 'attack', x: 3, y: 1 }, 9000);
  assert.strictEqual(hp - rat.hp, plain, 'once struck it knows you are there: the next blow is an ordinary one');
});

test('stealth: spotted while sneaking, you stand up, and cannot sneak again until nothing is after you', () => {
  const s = arena();
  put(s, 'arena', 3, 0, 'W');
  s.p.sneak = true;
  const w = withWalker(s, 'arena', 0, 0, { aggroS: 2 });      // 3 tiles off in the open: within 8 × 0.6
  let ev = turns(s, 1);
  assert.strictEqual(s.p.sneak, undefined, 'seen: no longer sneaking');
  assert.match(texts(ev), /The walker spotted you!/);
  assert.strictEqual(World.publicPlayer(s.c, s.p).chased, true, 'the page is told something is after them');
  assert.match(texts(act(s, { type: 'sneak', on: true }, s.at)), /can't hide while something is after you/);
  assert.strictEqual(s.p.sneak, undefined);
  put(s, 'arena', 3, 5, 'N');                                  // away behind the wall, standing still
  ev = turns(s, 6, dice([0.9]));
  assert.strictEqual(w.ai, undefined, 'it gave up');
  assert.match(texts(ev), /Nothing is after you any more: you can sneak again/);
  assert.strictEqual(s.p.chased, undefined);
  act(s, { type: 'sneak', on: true }, s.at);
  assert.strictEqual(s.p.sneak, true, 'and now they can');
});

test('stealth: a sneaking player who strikes and does not kill is found out; building stands you up', () => {
  const s = arena(); s.c.config.ambush_mult = 1;
  s.c.monsters.rat = Object.assign({}, s.c.monsters.rat, { hp: 99 });
  const rat = { ref: 'rat', id: 'rat#0', x: 3, y: 1, dead: false, hp: 99, statuses: [], last: 1e15, respawnAt: 0, facing: 'N' };
  const ms = World.mapState(s.ws, 'arena'); ms.monsters = [rat]; ms.spawnSig = '';
  put(s, 'arena', 3, 2, 'N'); s.p.sneak = true;
  assert.match(texts(act(s, { type: 'attack', x: 3, y: 1 }, 5000)), /spotted you/);
  assert.strictEqual(s.p.sneak, undefined);
  ms.monsters = []; s.p.sneak = true;
  act(s, { type: 'build', bp: 'nothing', x: 0, y: 0 }, 6000);
  assert.strictEqual(s.p.sneak, undefined, 'a build action: standing');
});

test('sight is the same both ways: if a monster can see you, you can see it (and the other way round)', () => {
  const s = fresh(), c = s.c, map = c.maps.map_3, sf = () => '';
  let n = 0;
  for (let ax = 0; ax < map.width; ax++) for (let ay = 0; ay < map.height; ay++) for (let dx = -6; dx <= 6; dx += 3) for (let dy = -5; dy <= 5; dy += 2) {
    const bx = ax + dx, by = ay + dy; if (bx < 0 || by < 0 || bx >= map.width || by >= map.height) continue;
    assert.strictEqual(World.canSee(c, map, ax, ay, bx, by, sf, true), World.canSee(c, map, bx, by, ax, ay, sf, true), ax + ',' + ay + ' and ' + bx + ',' + by);
    n++;
  }
  assert.ok(n > 1000);
});

test('stealth: a plain monster going to a sound shows ?, one after someone it saw shows !', () => {
  const s = arena();
  const rat = { ref: 'rat', id: 'rat#0', x: 3, y: 1, dead: false, hp: 5, statuses: [], last: 0, respawnAt: 0, facing: 'S' };
  const ms = World.mapState(s.ws, 'arena'); ms.monsters = [rat]; ms.spawnSig = '';
  s.c.monsters.rat = Object.assign({}, s.c.monsters.rat, { aggro: 6, moveMs: 500 });
  put(s, 'arena', 3, 5, 'N'); s.p.stepAt = 1e15;               // behind the wall, walking about
  World.advance(s.c, s.ws, 'arena', [s.p], 500, dice([0.9]), []);
  assert.strictEqual(World.alertOf(rat), 1, 'heard: ?');
  put(s, 'arena', 3, 0, 'N');
  World.advance(s.c, s.ws, 'arena', [s.p], 1000, dice([0.9]), []);
  assert.strictEqual(World.alertOf(rat), 2, 'seen: !');
});

test('perception: seen = at once, its turn or not; heard = ? at once, a 2 s wait, then off to the spot of the sound', () => {
  function rig(over) {
    const s = arena();
    s.c.monsters.rat = Object.assign({}, s.c.monsters.rat, { aggro: 6, moveMs: 500 }, over || {});
    const rat = { ref: 'rat', id: 'rat#0', x: 3, y: 1, dead: false, hp: 5, statuses: [], last: 10000, respawnAt: 0, facing: 'S' };
    const ms = World.mapState(s.ws, 'arena'); ms.monsters = [rat]; ms.spawnSig = '';
    const at = (now) => { const ev = []; World.advance(s.c, s.ws, 'arena', [s.p], now, dice([0.9]), ev); return ev; };
    return { s, rat, at };
  }
  // seen: it was not due to move for a while, yet it reacts on this very update
  const a = rig(); put(a.s, 'arena', 0, 1, 'E'); a.s.p.sneak = true; a.s.p.stepAt = 0;
  const ev = a.at(10100);
  assert.deepStrictEqual([World.alertOf(a.rat), a.rat.chase, a.rat.x, a.s.p.sneak], [2, 'p1', 2, undefined], 'the ! , a step towards them, and spotted');
  assert.match(texts(ev), /spotted you/);
  // heard, out of sight behind the wall
  const b = rig(); put(b.s, 'arena', 3, 5, 'N'); b.s.p.stepAt = 1e15;
  b.at(10500);
  assert.deepStrictEqual([World.alertOf(b.rat), b.rat.x, b.rat.y, b.rat.hear.x, b.rat.hear.y], [1, 3, 1, 3, 5], 'the ? at once, standing');
  b.s.p.stepAt = 0; put(b.s, 'arena', 0, 6, 'N');              // they slip away quietly
  b.at(11500);
  assert.deepStrictEqual([b.rat.x, b.rat.y], [3, 1], 'still listening a second later');
  b.at(12600);
  assert.ok(b.rat.goTo && b.rat.goTo.x === 3 && b.rat.goTo.y === 5, 'two seconds on: it goes to where the sound WAS, not where they are');
  assert.strictEqual(World.alertOf(b.rat), 1);
  // an animal: ? , then it runs from the spot of the sound
  const d = rig({ brain: 'animal', fleeRange: 6 }); put(d.s, 'arena', 3, 4, 'N'); d.s.p.stepAt = 1e15;
  d.at(10500);
  assert.deepStrictEqual([World.alertOf(d.rat), d.rat.x, d.rat.y], [1, 3, 1], 'heard: it lifts its head');
  d.at(12600);
  assert.ok(Math.max(Math.abs(d.rat.x - 3), Math.abs(d.rat.y - 4)) > 3, 'then runs from the sound');
});

test('stealth: Z sneaks — the step costs Config sneak_slow, out of the same walking budget; stealth off refuses it', () => {
  const s = arena();
  put(s, 'arena', 0, 0, 'E');
  assert.strictEqual(Rules.stepCost('E', s.c, liveOf(s), 1, 0, { sneak: true }), 2, 'twice a step (sneak_slow not said)');
  assert.strictEqual(Rules.stepCost('E', s.c, liveOf(s), 1, 0, { sn: 1 }), 2, 'another player, as the page is sent them');
  act(s, { type: 'sneak', on: true }, 1000);
  assert.strictEqual(s.p.sneak, true);
  assert.strictEqual(World.publicPlayer(s.c, s.p).sneak, true);
  const other = World.newPlayer(s.c, 'p2', 'Other', 'warrior'); other.map = 'arena'; other.x = 6; other.y = 0;
  assert.strictEqual(World.view(s.c, s.ws, 'arena', other, [s.p, other]).players[0].sn, 1, 'the others see them crouched');
  s.p.mvB = 6; s.p.mvT = 2000;
  act(s, { type: 'move', dirs: ['E', 'E', 'E', 'E'] }, 2000);
  assert.strictEqual(s.p.x, 3, 'a budget of 6 pays for three sneaking steps');
  assert.strictEqual(s.p.stepAt, 2000, 'walking leaves its noise (World.noiseOf)');
  assert.strictEqual(World.noiseOf(s.c, s.p, 2500), 2, 'sneaking: 2 tiles');
  assert.strictEqual(World.noiseOf(s.c, s.p, 4000), 0, 'standing still again: silent');
  act(s, { type: 'sneak', on: false }, 5000);
  assert.strictEqual(s.p.sneak, undefined);
  s.c.config.stealth = 'off';
  act(s, { type: 'sneak', on: true }, 6000);
  assert.strictEqual(s.p.sneak, undefined, 'stealth off: there is no sneaking');
  assert.strictEqual(World.publicPlayer(s.c, s.p).noise, undefined, 'and no noise meter');
});

test('stealth: a walker that only HEARS someone goes to look, and breaks nothing on the way', () => {
  const s = arena();
  put(s, 'arena', 2, 5, 'N');                                  // behind the wall, south of the door
  s.p.stepAt = 1e15;                                           // (walking about: making noise)
  const w = withWalker(s, 'arena', 2, 1);
  const ev = turns(s, 8);
  assert.ok(w.ai && w.ai.w === 1 && World.alertOf(w) === 1, 'it is looking about (the ?)');
  assert.ok(!ev.some(e => e.type === 'hit' && e.struct), 'the door is left whole: a sound alone never makes it break in');
  // in the open, out of sight behind the crate: it walks round to where the sound was, sees them and goes for them
  const s2 = arena();
  put(s2, 'arena', 5, 2, 'N'); s2.p.stepAt = 1e15;
  const w2 = withWalker(s2, 'arena', 5, 0);
  w2.facing = 'N';
  turns(s2, 1);
  assert.deepStrictEqual([w2.ai, World.alertOf(w2), w2.x, w2.y, w2.facing], [undefined, 1, 5, 0, 'N'], 'heard: the ? at once; surprised, it freezes, facing as it was');
  turns(s2, 1);
  assert.deepStrictEqual([w2.ai, w2.x, w2.y, w2.facing], [undefined, 5, 0, 'N'], 'still frozen (Config hear_delay_s 2)');
  turns(s2, 1);
  assert.deepStrictEqual([w2.ai.x, w2.ai.y, w2.ai.w], [5, 2, 1], 'two seconds on: it turns and goes to where the sound came from');
  turns(s2, 3);
  assert.strictEqual(World.alertOf(w2), 2, 'round the crate it sees them: now it hunts (the !)');
  s.p.stepAt = 0;                                              // they stand still: nothing more to go on
  delete w.ai; turns(s, 3, dice([0.9]));
  assert.strictEqual(w.ai, undefined, 'silent and out of sight: it does not know they are there');
});

test('stealth: an animal lets a sneaking player come closer than a walking one', () => {
  const s = arena();
  s.c.monsters.deer = Object.assign({}, s.c.monsters.rat, { id: 'deer', name: 'Deer', brain: 'animal', prey: true, hp: 10, fleeRange: 5, moveMs: 500 });
  const deer = { ref: 'deer', id: 'deer#0', x: 1, y: 0, dead: false, hp: 10, statuses: [], last: 0, respawnAt: 0, facing: 'S' };
  const ms = World.mapState(s.ws, 'arena'); ms.monsters = [deer]; ms.spawnSig = '';
  const step = (now) => World.advance(s.c, s.ws, 'arena', [s.p], now, dice([0.9]), []);   // (a die that never has it wander)
  put(s, 'arena', 5, 0, 'W'); s.p.sneak = true;                // 4 tiles off: within its 5, beyond 5 × 0.6
  step(500);
  assert.deepStrictEqual([deer.x, deer.y], [1, 0], 'sneaking 4 tiles off: it grazes on');
  delete s.p.sneak;
  step(1000);
  assert.ok(Math.max(Math.abs(deer.x - 5), Math.abs(deer.y)) > 4, 'walking (seen): it runs');
});

test('walker: struck from out of sight, it turns on whoever struck it', () => {
  const s = arena();
  put(s, 'arena', 3, 5, 'N');
  const w = withWalker(s, 'arena', 3, 1);
  w.engaged = 'p1';                                            // what World.hitMonster leaves on a monster a player hurt
  turns(s, 1);
  assert.deepStrictEqual([w.ai.k, w.ai.id, w.engaged], ['p', 'p1', null]);
});


test('a new character takes the hair and colour chosen on the character screen, if they are on offer', () => {
  const c = Content.build(tables), ch = World.hairChoices(c);
  assert.ok(ch.styles.length > 3 && ch.styles.includes('') && ch.colors.includes('hair_blonde'));
  assert.ok(ch.styles.includes(c.config.start_hair), 'the starting hair is one of them');
  const pick = ch.styles.find(x => x && x !== c.config.start_hair);
  const p = World.newPlayer(c, 'a', 'Ana', 'warrior', { hair: pick, hairColor: 'hair_blonde' });
  assert.deepStrictEqual([p.hair, p.hairColor], [pick, 'hair_blonde']);
  assert.strictEqual(World.newPlayer(c, 'b', 'Ben', 'warrior', { hair: '', hairColor: 'hair_grey' }).hair, '', 'bald is a choice');
  // the body: a man's unless a woman's was chosen; the same two for every class, named in Config
  const f = World.newPlayer(c, 'f', 'Fay', 'mage', { body: 'female' });
  assert.deepStrictEqual([f.body, World.publicPlayer(c, f).body, World.bodySprite(c, f)], ['female', 'female', c.config.body_female]);
  assert.deepStrictEqual([p.body, World.publicPlayer(c, p).body, World.bodySprite(c, p)], [undefined, '', c.config.body_male]);
  assert.strictEqual(World.newPlayer(c, 'g', 'Gil', 'warrior', { body: 'dragon' }).body, undefined);
  // a woman's slim build: a body of its own (Config body_female_slim, or the built-in picture)
  const sl = World.newPlayer(c, 's', 'Sia', 'mage', { body: 'female_slim' });
  assert.deepStrictEqual([sl.body, World.publicPlayer(c, sl).body], ['female_slim', 'female_slim']);
  assert.ok(/body_survivor_female_slim.png$/.test(World.bodySprite(c, sl)) || World.bodySprite(c, sl) === c.config.body_female_slim);
  // the skin: one of the tones on offer; the art's own tone is simply not recorded
  assert.ok(ch.skins.length >= 5 && ch.skins.includes('skin_dark'));
  const k = World.newPlayer(c, 'k', 'Kai', 'warrior', { skin: 'skin_dark' });
  assert.deepStrictEqual([k.skin, World.publicPlayer(c, k).skin], ['skin_dark', 'skin_dark']);
  assert.strictEqual(World.newPlayer(c, 'l', 'Lee', 'warrior', { skin: 'skin_light' }).skin, undefined);
  assert.strictEqual(World.newPlayer(c, 'm', 'Moe', 'warrior', { skin: 'green' }).skin, undefined);
  const bare = Content.build(tables); delete bare.config.body_male; delete bare.config.body_female;
  assert.strictEqual(World.bodySprite(bare, p), bare.classes.warrior.bodySprite, 'no Config row: the class picture still serves for a man');
  assert.match(World.bodySprite(bare, f), /body_survivor_female.png$/);
  const q = World.newPlayer(c, 'c', 'Cai', 'warrior', { hair: 'art/somewhere/else.png', hairColor: 'red; drop' });
  assert.deepStrictEqual([q.hair, q.hairColor], [c.config.start_hair, c.config.start_hair_color], 'anything else is ignored');
  const d = World.newPlayer(c, 'd', 'Dee', 'warrior');
  assert.deepStrictEqual([d.hair, d.hairColor], [c.config.start_hair, c.config.start_hair_color], 'no choice = the starting look');
  // facial hair: none unless one on offer is picked; its own colour, or the hair's
  assert.ok(ch.beards[0] === '' && ch.beards.length > 3);
  const b = World.newPlayer(c, 'h', 'Hal', 'warrior', { hairColor: 'hair_blonde', beard: ch.beards[1], beardColor: 'hair_grey' });
  assert.deepStrictEqual([b.beard, World.publicPlayer(c, b).beardColor], [ch.beards[1], 'hair_grey']);
  assert.deepStrictEqual([d.beard, World.publicPlayer(c, d).beard], [undefined, '']);
  assert.strictEqual(World.newPlayer(c, 'i', 'Ian', 'warrior', { beard: 'art/else.png', beardColor: 'hair_grey' }).beard, undefined);
  c.config.hair_styles = 'art/a.png, art/b.png'; c.config.hair_colors = 'hair_black';
  assert.deepStrictEqual(World.hairChoices(c).styles, [c.config.start_hair, 'art/a.png', 'art/b.png', ''], 'the Config can name its own');
});

test('the face is a worn place of its own (masks, glasses), numbered after the accessories so old saves keep their cells', () => {
  const t = JSON.parse(JSON.stringify(tables));
  t.Items.push({ id: 'shades', name: 'Shades', type: 'armor', slot: 'face', def: 1 });
  const c = Content.build(t), p = World.newPlayer(c, 'a', 'Ana', 'warrior'), ws = { maps: {} };
  assert.strictEqual(World.wornCell('accessory1'), World.WORN_AT + 7, 'the accessories did not move');
  assert.strictEqual(World.wornCell('face'), World.WORN_AT + 9);
  World.give(c, p, 'shades', 1, [], true);
  World.act(c, ws, p, { type: 'use', item: 'shades' }, 1000, mid, [p]);
  assert.strictEqual(p.equipment.face, 'shades');
  assert.ok(p.inventory.some(st => st.item === 'shades' && st.s === World.wornCell('face')));
});


test('animated ground: a tileset may hold several frames and a terrain may carry a tint; both are optional', () => {
  const c = Content.build(tables);
  assert.deepStrictEqual([c.tilesets.ts_water.frames, c.tilesets.ts_water.frameMs], [8, 140]);
  assert.deepStrictEqual([c.terrain.l_toxic.autotile, c.terrain.l_toxic.tint], ['ts_water', 'water_toxic']);
  assert.deepStrictEqual([c.tilesets.fields.frames, c.terrain.l_water.tint], [1, '']);   // nothing said = a still sheet, as drawn
  assert.ok(!c.terrain.l_lava.pass.n && !c.terrain.l_lava.pass.s);                        // not for walking on
  // …but flat: you see across it, where other ground nobody can cross hides what is behind
  const open = Object.keys(c.terrain).find(id => c.terrain[id].pass.n && c.terrain[id].pass.s && c.terrain[id].pass.e && c.terrain[id].pass.w);
  const wall = Object.keys(c.terrain).find(id => !c.terrain[id].pass.n && !c.terrain[id].pass.s && !c.terrain[id].seeThrough);
  const flat = { width: 5, height: 1, terrain: [[open, open, 'l_water', open, open]], entities: [], hWalls: [], vWalls: [] };
  const solid = Object.assign({}, flat, { terrain: [[open, open, wall, open, open]] });
  const none = () => '';
  assert.strictEqual(World.blocksSight(c, flat, 2, 0, none), false);
  assert.strictEqual(World.blocksSight(c, solid, 2, 0, none), true);
});

// ---------------------------------------------------------------- ground height
test('raised ground hides what is behind it; from high ground you see over low ground; the same both ways', () => {
  const tb = JSON.parse(JSON.stringify(tables)), row = Array(11).fill('til_1'), el = Array(1).fill(0).map(() => Array(11).fill(''));
  tb.Maps.push({ id: 'ridge', name: 'Ridge', width: 11, height: 1, terrain: JSON.stringify([row]), elev: JSON.stringify(el) });
  const c = Content.build(tb), m = c.maps.ridge, none = () => '', see = (a, b) => World.canSee(c, m, a, 0, b, 0, none, true);
  assert.ok(see(0, 10), 'level ground: nothing hides anything');
  m.elev[0][5] = '1';
  assert.ok(!see(0, 10) && !see(10, 0), 'a ledge taller than the eye between two on level ground hides each from the other');
  m.elev[0][0] = '2';
  assert.ok(see(0, 10) && see(10, 0), 'from higher ground the eye passes over it');
  m.elev[0][0] = ''; m.elev[0][8] = '1'; m.elev[0][9] = '1'; m.elev[0][10] = '1'; m.elev[0][5] = '';
  assert.ok(see(0, 8) && !see(0, 9) && !see(0, 10), 'looking up a ledge: only who stands on its very edge is seen');
  assert.ok(see(9, 0) && see(10, 0), 'looking down from it: the one below is seen, by one who is not');
  ['3', '3', '3'].forEach((v, i) => { m.elev[0][8 + i] = v; });
  assert.ok(see(6, 8) && !see(6, 10) && !see(10, 6), 'at the foot of a tall cliff, only who stands at its edge is seen');
  // what a PLAYER sees: never ground above their eyes (not even the edge of the ledge); lower ground, yes
  const vis = World.visibleCells(c, m, 6, 0, 20, none);
  assert.deepStrictEqual([vis['7,0'], vis['8,0'], vis['9,0'], vis['10,0']], [1, 3, undefined, undefined], 'from the foot of the cliff: none of the ground above (3 = who stands on its very edge is seen, the ground is not)');
  assert.deepStrictEqual([World.perceive(vis, null, 8, 0), World.perceive(vis, null, 9, 0)], ['seen', 'hidden']);
  const down = World.visibleCells(c, m, 8, 0, 20, none);
  assert.ok(down['9,0'] && down['7,0'] && down['0,0'], 'from its edge: the level you are on, and all the low ground');
  ['1', '1', '1'].forEach((v, i) => { m.elev[0][8 + i] = v; });
  assert.strictEqual(World.visibleCells(c, m, 6, 0, 20, none)['8,0'], 3, 'a ledge one step up is above the eye too');
  m.elev[0][7] = '0E';                                               // a ramp up to it, climbing east
  const foot = World.visibleCells(c, m, 6, 0, 20, none), onRamp = World.visibleCells(c, m, 7, 0, 20, none);
  assert.deepStrictEqual([foot['7,0'], foot['8,0'], foot['9,0']], [1, 3, undefined], 'from the foot of a ramp: the ramp, not the level above');
  assert.ok(onRamp['8,0'] && onRamp['10,0'] && onRamp['0,0'], 'from on the ramp: both levels');
  // shots follow the same rule: up a ledge, only who stands on its very edge can be hit; down it, anyone
  m.elev[0][7] = '';
  const gun = x => ({ x, y: 0, map: 'ridge', inventory: [{ item: 'pistol', qty: 1, s: 0 }], equipment: { weapon: 'pistol' }, belt: ['pistol'], held: 0 });
  c.items.pistol.range = 12;
  const lkAt = mx => ({ stateOf: none, monsterAt: (x, y) => (x === mx && y === 0 ? { x, y } : null) });
  const shot = (from, to) => World.shotReach(c, m, gun(from), to, 0, lkAt(to));
  assert.deepStrictEqual([shot(4, 8).ok, shot(4, 9).ok, shot(4, 9).reason], [true, false, 'Something is in the way.'], 'from below: the one on the edge, not the one behind them');
  assert.deepStrictEqual([shot(9, 4).ok, shot(10, 2).ok, World.shotReach(c, m, gun(4), 10, 0, lkAt(-1)).cells.map(q => q.x).join()], [true, true, '5,6,7,8'], 'from above: anyone below; a shot up ends in the cliff');
});

test('ground height: a change of height is a cliff, a ramp joins two levels, and its flanks stay closed', () => {
  const tb = JSON.parse(JSON.stringify(tables)), row = Array(6).fill('til_1'), el = Array(6).fill(0).map(() => Array(6).fill(''));
  // a 2x2 plateau at level 1 (cells 2..3, 1..2), reached by a ramp at (2,3) climbing north
  el[1][2] = '1'; el[1][3] = '1'; el[2][2] = '1'; el[2][3] = '1'; el[3][2] = '0N';
  tb.Maps.push({ id: 'hill', name: 'Hill', width: 6, height: 6, terrain: JSON.stringify(Array(6).fill(row)), elev: JSON.stringify(el) });
  const c = Content.build(tb), m = c.maps.hill, go = (x, y, d) => Rules.tryMove(c, m, x, y, d, {});
  assert.deepStrictEqual([Rules.heightAt(m, 2, 1), Rules.heightAt(m, 0, 0), Rules.rampAt(m, 2, 3), Rules.rampAt(m, 2, 2)], [1, 0, 'N', '']);
  assert.deepStrictEqual([go(1, 1, 'E').ok, go(1, 1, 'E').reason], [false, 'cliff'], 'up a cliff');
  assert.strictEqual(go(2, 1, 'W').reason, 'cliff', 'nor down it');
  assert.strictEqual(go(2, 1, 'E').ok, true, 'along the top');
  assert.strictEqual(go(3, 3, 'N').reason, 'cliff', 'the plateau from the south, beside the ramp');
  assert.strictEqual(go(2, 4, 'N').ok, true, 'onto the foot of the ramp');
  assert.strictEqual(go(2, 3, 'N').ok, true, 'and off its top onto the plateau');
  assert.strictEqual(go(2, 2, 'S').ok, true, 'back down the same way');
  assert.strictEqual(go(1, 3, 'E').reason, 'cliff', 'not onto the ramp from its flank');
  assert.strictEqual(go(2, 3, 'E').reason, 'cliff', 'nor off it sideways');
  assert.strictEqual(go(1, 4, 'NE').ok, false, 'no cutting the corner onto the ramp');
  el[3][3] = '0N'; m.elev = el;                                                       // a second ramp beside it: one wide ramp
  assert.strictEqual(go(2, 3, 'E').ok, true);
  assert.deepStrictEqual([Rules.groundHeight(m, 2.5, 3.99), Rules.groundHeight(m, 2.5, 3.5), Rules.groundHeight(m, 2.5, 1.5), Rules.groundHeight(m, 0.5, 0.5)].map(v => Math.round(v * 100) / 100), [0.01, 0.5, 1, 0]);
  // reach: nothing on another level is used or hit — a tree up on the plateau, a monster below a ledge
  assert.deepStrictEqual([Rules.reachBlocked(c, m, 1, 1, 2, 1), Rules.reachBlocked(c, m, 2, 1, 3, 1), Rules.reachBlocked(c, m, 1, 0, 2, 1), Rules.reachBlocked(c, m, 2, 4, 2, 3)], [true, false, true, false]);
  tb.Objects.push({ id: 't_oak', name: 'Oak', kind: 'deco', walkable: false, properties: '{"hp":10,"material":"wood","harvest":"wood:3"}' });
  tb.MapEntities.push({ map: 'hill', key: 'hill.e1', x: 2, y: 1, ref: 't_oak', data: '' });
  const c2 = Content.build(tb), ws2 = { maps: {} }, p2 = World.newPlayer(c2, 'p1', 'Ana', c2.config.start_class);
  Object.assign(p2, { map: 'hill', x: 1, y: 1, facing: 'E' });
  assert.match(texts(World.act(c2, ws2, p2, { type: 'attack', x: 2, y: 1 }, 5000, mid, [p2])), /Nothing to attack/, 'the oak is up on the plateau');
  assert.strictEqual(World.harvestWith(c2, World.liveMap(c2, ws2, 'hill'), p2, 2, 1), null);
  Object.assign(p2, { x: 3, y: 1, facing: 'W' });
  assert.match(texts(World.act(c2, ws2, p2, { type: 'attack', x: 2, y: 1 }, 9000, mid, [p2])), /You hit the oak/, 'from beside it on the plateau it can be worked');
  // a map with no heights behaves as before, and monsters obey the same cliffs (they move with tryMove)
  assert.strictEqual(Rules.cliffBetween(c.maps[c.config.start_map], 1, 1, 'E'), false);
});

// ---------------------------------------------------------------- animals
// An open 12x12 field; the player stands at (1,1). Animals are put straight into the map's monsters.
function meadow() {
  const tb = JSON.parse(JSON.stringify(tables)), row = Array(12).fill('til_1');
  tb.Maps.push({ id: 'field', name: 'Field', width: 12, height: 12, terrain: JSON.stringify(Array(12).fill(row)) });
  const c = Content.build(tb), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Ana', 'warrior');
  c.config.move_burst = 999;
  Object.assign(p, { map: 'field', x: 1, y: 1, facing: 'S' });
  World.advance(c, ws, 'field', [p], 1000, mid, []);
  const s = { c, ws, p, t: 1000 };
  s.put = (ref, x, y, extra) => { const m = Object.assign({ id: ref + '#' + ws.maps.field.monsters.length, ref, x, y, hp: c.monsters[ref].hp, dead: false, last: s.t, respawnAt: 0, facing: 'S', spawn: '' }, extra || {}); ws.maps.field.monsters.push(m); return m; };
  s.run = (ms, rng) => { const ev = []; for (let k = 0; k < ms / 100; k++) { s.t += 100; World.advance(c, ws, 'field', [p], s.t, rng || mid, ev); } return ev; };
  return s;
}
const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

test('animals: a deer runs from a player who comes close, and never attacks', () => {
  const s = meadow(), deer = s.put('deer', 4, 4);
  const hp = s.p.hp, d0 = dist(deer, s.p);
  s.run(3000);
  assert.ok(dist(deer, s.p) > d0, 'it put distance between them: ' + dist(deer, s.p));
  assert.strictEqual(s.p.hp, hp);
  const far = s.put('deer', 10, 10), at = [far.x, far.y];
  s.run(1000, () => 0.99);                                             // out of its flee range, and the dice say stand still
  assert.deepStrictEqual([far.x, far.y], at);
});

test('animals: a wolf goes for a player in range and bites; one that has just eaten leaves distant players alone', () => {
  const s = meadow(), wolf = s.put('wolf', 5, 1);
  const hp = s.p.hp;
  s.run(4000);
  assert.ok(dist(wolf, s.p) === 1 && s.p.hp < hp, 'it closed in and bit');
  const s2 = meadow(), w2 = s2.put('wolf', 6, 6), rabbit = s2.put('rabbit', 7, 6);
  Object.assign(s2.p, { x: 0, y: 0 }); s2.c.monsters.wolf.aggro = 3; s2.c.monsters.rabbit.moveMs = 99999;   // the player is out of range; the rabbit cannot get away
  s2.run(6000);
  assert.ok(rabbit.dead, 'the wolf killed the rabbit');
  assert.ok(w2.fedUntil > s2.t, 'and has eaten');
  const carcass = s2.ws.maps.field.struct.ents.find(b => b.ref === 'carcass_rabbit');
  assert.ok(carcass && carcass.wild && carcass.x === rabbit.x, 'the rabbit left a carcass where it fell');
});

test('animals: a carcass is a container with the loot inside; emptied it is gone, and it rots away if left', () => {
  const s = meadow(), deer = s.put('deer', 2, 1);
  s.c.monsters.deer.moveMs = 99999;
  World.hitMonster(s.c, s.ws, 'field', s.p, deer, 999, s.t, mid, []);
  const body = () => s.ws.maps.field.struct.ents.find(b => b.ref === 'carcass_deer');
  assert.ok(deer.dead && body(), 'a carcass lies there');
  assert.strictEqual(World.count(s.p, 'raw_meat'), 0, 'nothing straight into the bag');
  const go = a2 => World.act(s.c, s.ws, s.p, a2, s.t += 1000, mid, [s.p]);
  let ev = go({ type: 'interact', x: 2, y: 1 });
  const box = ev.find(e => e.type === 'storage');
  assert.deepStrictEqual(box.inv.map(st => st.item + ':' + st.qty).sort(), ['leather:2', 'raw_meat:4'], 'opened like any container');
  World.give(s.c, s.p, 'wood', 1, []);
  assert.match(texts(go({ type: 'inv', key: box.key, from: { w: 'bag', s: s.p.inventory.find(st => st.item === 'wood').s }, to: { w: 'box' } })), /can't put things in that/);
  assert.strictEqual(box.takeOnly, true);
  const woodCell = s.p.inventory.find(st => st.item === 'wood').s;
  go({ type: 'inv', key: box.key, from: { w: 'box', s: 0 }, to: { w: 'bag', s: woodCell } });      // dropped onto the wood: no swap into the carcass
  assert.ok(body() && !body().inv.some(st => st.item === 'wood') && World.count(s.p, 'wood') === 1, 'half taken: still there, and nothing went in');
  ev = go({ type: 'inv', key: box.key, from: { w: 'box', s: 1 }, to: { w: 'bag' } });
  assert.deepStrictEqual([World.count(s.p, 'raw_meat'), World.count(s.p, 'leather'), !!body()], [4, 2, false], 'taken clean, it is gone');
  assert.ok(ev.some(e => e.type === 'storage' && e.gone && e.key === box.key), 'and the page is told to close it');
  const s2 = meadow(), d2 = s2.put('deer', 6, 6);
  World.hitMonster(s2.c, s2.ws, 'field', s2.p, d2, 999, s2.t, mid, []);
  assert.ok(s2.ws.maps.field.struct.ents.some(b => b.ref === 'carcass_deer'));
  World.advance(s2.c, s2.ws, 'field', [s2.p], s2.t + 301000, mid, []);
  assert.ok(s2.ws.maps.field.struct.ents.some(b => b.ref === 'carcass_deer'), 'a body is a loot bag: it lasts as long as one (15 minutes), not 5');
  World.advance(s2.c, s2.ws, 'field', [s2.p], s2.t + 901000, mid, []);
  assert.ok(!s2.ws.maps.field.struct.ents.some(b => b.ref === 'carcass_deer'), 'fifteen minutes on it has rotted away');
  // a monster with only a loot table leaves a body too, with what the table rolled inside; an empty one is gone when looked at
  const s4 = meadow(), rat = s4.put('rat', 2, 1);
  s4.c.monsters.rat.carcass = 'carcass_rabbit'; s4.c.monsters.rat.moveMs = 99999;
  s4.c.loot.rat = [{ item: 'bone', chance: 1, min: 2, max: 2 }];
  World.hitMonster(s4.c, s4.ws, 'field', s4.p, rat, 999, s4.t, mid, []);
  const b4 = s4.ws.maps.field.struct.ents.find(b => b.ref === 'carcass_rabbit');
  assert.deepStrictEqual([b4.inv.map(st => st.item + ':' + st.qty).join(), World.count(s4.p, 'bone')], ['bone:2', 0], 'the table drop is in the body, not in the bag');
  const s5 = meadow(), rat5 = s5.put('rat', 2, 1);
  s5.c.monsters.rat.carcass = 'carcass_rabbit'; s5.c.loot.rat = [];
  World.hitMonster(s5.c, s5.ws, 'field', s5.p, rat5, 999, s5.t, mid, []);
  assert.ok(!(s5.ws.maps.field.struct || { ents: [] }).ents.some(b => b.ref === 'carcass_rabbit'), 'nothing to leave: no bag at all');
  // a bag already lies where it falls: the loot joins it, and its time to rot starts again
  const s6 = meadow(), d6 = s6.put('deer', 6, 6), d7 = s6.put('deer', 6, 6);
  World.hitMonster(s6.c, s6.ws, 'field', s6.p, d6, 999, s6.t, mid, []);
  World.hitMonster(s6.c, s6.ws, 'field', s6.p, d7, 999, s6.t + 60000, mid, []);
  const b6 = s6.ws.maps.field.struct.ents.filter(b => b.ref === 'carcass_deer');
  assert.deepStrictEqual([b6.length, b6[0].x, b6[0].y, b6[0].inv.find(g => g.item === 'raw_meat').qty], [1, 6, 6, 8], 'one bag, holding both');
  assert.strictEqual(World.count(s6.p, 'raw_meat'), 0, 'and nothing went straight into the bag');
  assert.strictEqual(s6.ws.maps.field.timers[b6[0].key].at, s6.t + 60000 + 900000, 'which now rots fifteen minutes from the second kill');
  // an animal with loot but no carcass leaves it in a loot bag when a player kills it: never straight into the bag
  const s3 = meadow(), d3 = s3.put('deer', 6, 6);
  s3.c.monsters.deer.carcass = '';
  World.hitMonster(s3.c, s3.ws, 'field', s3.p, d3, 999, s3.t, mid, []);
  const bags3 = () => s3.ws.maps.field.struct.ents.filter(b => b.ref === '_bag');
  assert.deepStrictEqual([World.count(s3.p, 'raw_meat'), bags3().length, bags3()[0].x, bags3()[0].y], [0, 1, 6, 6]);
  assert.deepStrictEqual(bags3()[0].inv.filter(g => !g.own).map(g => g.item + ':' + g.qty).sort(), ['leather:2', 'raw_meat:4']);
  s3.c.monsters.rabbit.carcass = '';
  World.hitMonster(s3.c, s3.ws, 'field', null, s3.put('rabbit', 7, 7), 999, s3.t, mid, []);          // killed by a wolf: its bag lies there all the same
  assert.deepStrictEqual([bags3().length, bags3()[1].x, bags3()[1].y, World.count(s3.p, 'raw_meat')], [2, 7, 7, 0]);
  // loot and the ground (the owner's rules): a dispensable item where it falls goes into the bag put there; one that
  // is not sends the bag to the nearest free tile, else to the nearest tile of dispensable things, else into the nearest bag
  const s7 = meadow(), st7 = () => World.structOf(s7.ws, 'field');
  s7.c.monsters.deer.carcass = '';
  s7.c.items.wood.dispensable = true;
  const lay = (x, y, what) => { const st = st7(); st.ents.push({ key: 'field.b' + (++st.n), x, y, ref: '_drop', data: { pickup: what }, hp: 0, max: 0, wild: true }); st.rev++; };
  const fill = what => { for (let y = 3; y <= 9; y++) for (let x = 3; x <= 9; x++)
    if (Math.abs(x - 6) + Math.abs(y - 6) <= 3 && !st7().ents.some(b => b.x === x && b.y === y)) lay(x, y, what); };
  const bag7 = () => st7().ents.filter(b => b.ref === '_bag');
  const at7 = (x, y) => st7().ents.filter(b => b.x === x && b.y === y).map(b => b.ref === '_drop' ? b.data.pickup : b.ref).sort().join();
  const in7 = b => b.inv.map(g => g.item + ':' + g.qty).sort().join();
  const kill7 = () => World.hitMonster(s7.c, s7.ws, 'field', s7.p, s7.put('deer', 6, 6), 999, s7.t, mid, []);
  lay(6, 6, 'wood:3');
  kill7();
  assert.deepStrictEqual([bag7().length, at7(6, 6), in7(bag7()[0])], [1, '_bag', 'leather:2,raw_meat:4,wood:3'], 'dispensable where it fell: the bag is put there, the wood inside it');
  scoop(s7.c, s7.ws, 'field', s7.p);
  lay(6, 6, 'bone:1');
  kill7();
  assert.deepStrictEqual([bag7().length, at7(6, 6), Math.abs(bag7()[0].x - 6) + Math.abs(bag7()[0].y - 6)], [1, 'bone:1', 1], 'not dispensable: the bone stays, the bag on a free tile next to it');
  scoop(s7.c, s7.ws, 'field', s7.p);
  lay(6, 5, 'wood:1'); lay(8, 6, 'wood:2'); fill('bone:1');              // every tile near holds a bone, but two: wood
  kill7();
  assert.deepStrictEqual([bag7().length, at7(6, 5), at7(6, 6), at7(8, 6), in7(bag7()[0])], [1, '_bag', 'bone:1', 'wood:2', 'leather:2,raw_meat:4,wood:1'], 'no free tile: the NEAREST tile of dispensable things, which go into the bag');
  kill7();
  assert.deepStrictEqual([bag7().length, at7(8, 6), in7(bag7()[1])], [2, '_bag', 'leather:2,raw_meat:4,wood:2']);
  kill7();
  assert.deepStrictEqual([bag7().length, in7(bag7()[0])], [2, 'leather:4,raw_meat:8,wood:1'], 'no such tile left: it joins the nearest bag');
  scoop(s7.c, s7.ws, 'field', s7.p); fill('bone:1');
  kill7();
  assert.deepStrictEqual([at7(6, 6), World.count(s7.p, 'raw_meat')], ['_bag,bone:1', 20], 'nowhere at all: a bag where it fell, beside the bone; still nothing straight into the bag');
});

test('animals: a chicken is tamed with seeds, settles at a coop, lays eggs there, and its spawner grows a new wild one', () => {
  const s = meadow(), hen = s.put('chicken', 2, 2, { spawn: 'field.e9', id: 'field.e9#0' });
  s.c.monsters.chicken.layS = 10;
  const st = World.structOf ? World.structOf(s.ws, 'field') : (s.ws.maps.field.struct = s.ws.maps.field.struct || { rev: 1, n: 0, walls: {}, ents: [], dmg: {}, gone: {}, floor: {}, hole: {}, shadow: {}, roof: {} });
  st.ents.push({ key: 'field.b' + (++st.n), x: 4, y: 4, ref: 'obj_coop', data: {}, hp: 30, max: 30, bp: 'bp_coop', by: 'p1', built: 1, prog: 4, need: 4 }); st.rev = (st.rev || 0) + 1;
  const use = () => texts(World.act(s.c, s.ws, s.p, { type: 'interact', x: hen.x, y: hen.y }, s.t += 1000, mid, [s.p]));
  s.run(2000);
  assert.ok(dist(hen, s.p) > 1, 'empty-handed, it keeps away');
  World.give(s.c, s.p, 'seeds', 2, []); onBelt(s.p, 1, 'seeds'); World.holdSlot(s.c, s.p, 1);
  Object.assign(hen, { x: 2, y: 1 });
  s.run(1500, () => 0.99);
  assert.deepStrictEqual([hen.x, hen.y], [2, 1], 'with seeds in hand it does not run');
  assert.match(use(), /The chicken is yours now\. It settles at the coop/);
  assert.deepStrictEqual([World.count(s.p, 'seeds'), hen.tame, hen.owner, !!hen.free, hen.home.x, hen.home.y], [1, true, 'p1', true, 4, 4]);
  assert.match(use(), /Your chicken lives at the coop/);
  const again = s.ws.maps.field.monsters.find(q => q.id === 'field.e9#0');
  assert.ok(again && again !== hen && again.dead && again.respawnAt > s.t, 'the spawner will grow another');
  World.holdSlot(s.c, s.p, -1);
  s.run(40000);
  assert.ok(dist(hen, { x: 4, y: 4 }) <= 3, 'it went to live by the coop: ' + hen.x + ',' + hen.y);
  const eggs = () => s.ws.maps.field.struct.ents.filter(b => b.ref === '_drop' && b.data.pickup === 'egg:1');
  assert.ok(eggs().length >= 1 && eggs().length <= 6, 'eggs lie around: ' + eggs().length);
  const egg = eggs()[0], n = eggs().length;
  Object.assign(s.p, { x: egg.x, y: egg.y });
  World.act(s.c, s.ws, s.p, { type: 'interact' }, s.t += 1000, mid, [s.p]);
  assert.deepStrictEqual([World.count(s.p, 'egg'), eggs().length], [1, n - 1], 'picked up');
  World.hitMonster(s.c, s.ws, 'field', null, hen, 999, s.t, mid, []);
  World.advance(s.c, s.ws, 'field', [s.p], s.t += 500, mid, []);
  assert.ok(!s.ws.maps.field.monsters.includes(hen), 'killed, a tame one does not come back');
});

// ---------------------------------------------------------------- what is worn
test('worn: pants, feet, gloves, back and belt each hold one thing; two accessories are worn at once, each where it was put', () => {
  const s = hero('warrior'), eq = () => Object.keys(s.p.equipment).filter(k => !/weapon|armor|helm/.test(k)).sort().map(k => k + '=' + s.p.equipment[k]).join(' ');
  const mk = (id, slot) => { s.c.items[id] = Object.assign({}, s.c.items.leather_armor, { id, name: id, slot, def: 1 }); World.give(s.c, s.p, id, 1, []); };
  const def0 = World.stats(s.c, s.p).def;
  mk('jeans', 'pants'); mk('boots', 'feet'); mk('mitts', 'gloves'); mk('pack', 'back'); mk('strap', 'belt');
  ['ring1', 'ring2', 'ring3', 'ring4'].forEach(id => mk(id, 'accessory'));
  ['jeans', 'boots', 'mitts', 'pack', 'strap', 'ring1'].forEach(id => act(s, { type: 'use', item: id }));
  assert.strictEqual(eq(), 'accessory1=ring1 back=pack belt=strap feet=boots gloves=mitts pants=jeans');
  assert.strictEqual(World.stats(s.c, s.p).def, def0 + 6, 'everything worn counts');
  act(s, { type: 'use', item: 'ring1', slot: 'accessory2' });                 // a worn one, dragged to the other place
  assert.strictEqual(eq(), 'accessory2=ring1 back=pack belt=strap feet=boots gloves=mitts pants=jeans');
  act(s, { type: 'use', item: 'ring2' }); act(s, { type: 'use', item: 'ring3' });   // the free place, then — both taken — the first
  assert.strictEqual(eq(), 'accessory1=ring3 accessory2=ring1 back=pack belt=strap feet=boots gloves=mitts pants=jeans');
  assert.strictEqual(World.wornAt(s.p, s.c.items.ring2), '', 'the one it took the place of is back in the bag');
  act(s, { type: 'use', item: 'ring1' }); act(s, { type: 'use', item: 'jeans' });   // used again: taken off
  assert.strictEqual(eq(), 'accessory1=ring3 back=pack belt=strap feet=boots gloves=mitts');
});

// ---------------------------------------------------------------- cookers
test('a campfire cooks: fuel and food go in their cells, lit it burns and cooks over time, and goes out with the fuel', () => {
  const tb = JSON.parse(JSON.stringify(tables)), row = Array(5).fill('til_1');
  tb.Maps.push({ id: 'kitchen', name: 'Kitchen', width: 5, height: 5, terrain: JSON.stringify(Array(5).fill(row)) });
  tb.MapEntities.push({ map: 'kitchen', key: 'kitchen.e1', x: 2, y: 1, ref: 'obj_24', data: '' });
  const c = Content.build(tb), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Ana', 'warrior');
  Object.assign(p, { map: 'kitchen', x: 2, y: 2, facing: 'N', inventory: [] });
  let now = 100000;
  const go = a => World.act(c, ws, p, a, now += 100, mid, [p]);
  const fire = { key: 'kitchen.e1' }, state = () => World.stateOf(c, ws, 'kitchen', fire) || '';
  const cells = () => { const o = {}; ws.maps.kitchen.cookers['kitchen.e1'].inv.forEach(st => { o[st.s] = st.item + ':' + st.qty; }); return o; };
  const cellOf = id => p.inventory.find(st => st.item === id).s;
  let ev = go({ type: 'interact', x: 2, y: 1 });
  const box = ev.find(e => e.type === 'storage');
  assert.ok(box && box.slots === 60 && box.cook && !box.cook.lit && box.cook.cells.join() === '20,20,20' && box.cook.recipes.includes('r_cooked_meat'), 'using it opens its cells: raw, fuel, cooked');
  assert.ok(!ev.some(e => e.type === 'craft'), 'not the crafting panel');
  assert.strictEqual(state(), 'empty');
  World.give(c, p, 'raw_meat', 3, []); World.give(c, p, 'wood', 2, []); World.give(c, p, 'seeds', 1, []);
  const goals = Content.parseGoals('craft:cooked_meat:2; craft:raw_meat:1');   // a quest that asks for cooked meat to be made
  c.quests = { q: { id: 'q', name: 'Q', giver: '', ender: 'x', goals, requires: '', rewards: '', choice: '' } }; p.quests = { q: { n: [0, 0], at: 1 } }; p.questsDone = {};
  const made = () => World.questLog(c, p, 1e15)[0].s + ':' + World.questLog(c, p, 1e15)[0].n.join('/');
  assert.match(texts(go({ type: 'store', key: fire.key, op: 'light' })), /nothing in it to burn/);
  go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('raw_meat') }, to: { w: 'box' } });
  go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('wood') }, to: { w: 'box' } });
  assert.deepStrictEqual(cells(), { 0: 'raw_meat:3', 20: 'wood:2' }, 'each to its own run of cells');
  assert.match(texts(go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('seeds') }, to: { w: 'box' } })), /Nothing can be made of that here/);
  assert.match(texts(go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('seeds') }, to: { w: 'box', s: 21 } })), /will not burn/);
  assert.match(texts(go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('seeds') }, to: { w: 'box', s: 40 } })), /where things come out/);
  assert.strictEqual(state(), 'fueled');
  ev = go({ type: 'store', key: fire.key, op: 'light' });
  assert.ok(ev.find(e => e.type === 'storage').cook.lit);
  assert.strictEqual(state(), 'burning');
  assert.strictEqual(World.view(c, ws, 'kitchen', p, [p], -1).states['kitchen.e1'], 'burning', 'the page is told, for the picture');
  World.advance(c, ws, 'kitchen', [p], now += 9000, mid, []);
  assert.deepStrictEqual(cells(), { 0: 'raw_meat:3', 20: 'wood:1' }, 'lit, but told to make nothing: what lies in it is not cooked by itself');
  ev = go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_cooked_meat', qty: 9 });   // the Cook button: what is already in it counts
  assert.deepStrictEqual([ev.find(e => e.type === 'storage').cook.rid, ev.find(e => e.type === 'storage').cook.left], ['r_cooked_meat', 3]);
  ev = go({ type: 'store', key: fire.key, op: 'cancel' });
  assert.strictEqual(ev.find(e => e.type === 'storage').cook.rid, '', 'and it can be told to stop');
  go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_cooked_meat', qty: 9 });
  World.advance(c, ws, 'kitchen', [p], now += 9000, mid, []);
  assert.deepStrictEqual(cells(), { 0: 'raw_meat:2', 20: 'wood:1', 40: 'cooked_meat:1' }, 'nine seconds on: one cooked, one piece of wood burning');
  World.advance(c, ws, 'kitchen', [p], now += 3600000, mid, []);                          // left alone for an hour
  assert.deepStrictEqual(cells(), { 40: 'cooked_meat:3' }, 'all cooked, the fuel spent');
  assert.deepStrictEqual([state(), ws.maps.kitchen.cookers['kitchen.e1'].lit], ['empty', false], 'and the fire went out');
  assert.strictEqual(made(), 'active:0/0', 'cooked, but still in the fire: nobody has made it yet');
  go({ type: 'inv', key: fire.key, from: { w: 'box', s: 40 }, to: { w: 'bag' } });
  assert.strictEqual(World.count(p, 'cooked_meat'), 3);
  assert.strictEqual(made(), 'active:2/0', 'taken out of the fire: whoever takes it made it (raw meat put in and taken back would not count)');
  // the Cook button: what a recipe takes goes from the bag into the raw cells, and the fire is lit when there is fuel
  World.give(c, p, 'raw_meat', 5, []); World.give(c, p, 'wood', 1, []);
  assert.match(texts(go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_hammer' })), /can't be made here/);
  assert.match(texts(ev = go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_cooked_meat', qty: 2 })), /needs fuel/);
  assert.deepStrictEqual([cells(), World.count(p, 'raw_meat'), ev.find(e => e.type === 'storage').cook.lit], [{ 0: 'raw_meat:2' }, 3, false]);
  go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('wood') }, to: { w: 'box', s: 25 } });
  go({ type: 'inv', key: fire.key, from: { w: 'bag', s: cellOf('raw_meat') }, to: { w: 'box', s: 3 }, qty: 1 });
  go({ type: 'inv', key: fire.key, from: { w: 'box', s: 3 }, to: { w: 'box', s: 7 } });
  go({ type: 'inv', key: fire.key, from: { w: 'box', s: 7 }, to: { w: 'box', s: 22 } });
  assert.deepStrictEqual(cells(), { 0: 'raw_meat:2', 7: 'raw_meat:1', 25: 'wood:1' }, 'a stack moves inside its own run of cells, never to another');
  ev = go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_cooked_meat', qty: 9 });
  const ck = ev.find(e => e.type === 'storage').cook;
  assert.deepStrictEqual([ck.lit, ck.rid, ck.left, World.count(p, 'raw_meat')], [true, 'r_cooked_meat', 5, 0], 'as many as the bag and its cells have, and it is lit');
  assert.match(texts(go({ type: 'store', key: fire.key, op: 'load', recipe: 'r_cooked_meat' })), /Not enough raw meat/);
  // what it takes is taken back out of the raw cells: the job fails and stops (it never cooks on with nothing to cook)
  const raws = () => ws.maps.kitchen.cookers['kitchen.e1'].inv.filter(st => st.s < 20).map(st => st.s);
  raws().slice(1).forEach(s => go({ type: 'inv', key: fire.key, from: { w: 'box', s }, to: { w: 'bag' } }));
  assert.strictEqual(go({ type: 'store', key: fire.key, op: 'look' }).find(e => e.type === 'storage').cook.rid, 'r_cooked_meat', 'one piece left: it goes on');
  go({ type: 'inv', key: fire.key, from: { w: 'box', s: raws()[0] }, to: { w: 'bag' } });
  ev = go({ type: 'store', key: fire.key, op: 'look' });
  assert.deepStrictEqual([ev.find(e => e.type === 'storage').cook.rid, ws.maps.kitchen.cookers['kitchen.e1'].prog], ['', 0], 'none left: it has stopped');
  World.advance(c, ws, 'kitchen', [p], now += 60000, mid, []);
  assert.ok(!ws.maps.kitchen.cookers['kitchen.e1'].job, 'and stays stopped');
  // a fire saved when it had three cells: its stacks move to their runs when it is next opened
  ws.maps.kitchen.cookers['kitchen.e1'] = { inv: [{ item: 'raw_meat', qty: 1, s: 0 }, { item: 'wood', qty: 2, s: 1 }, { item: 'cooked_meat', qty: 4, s: 2 }], lit: false, burn: 0, prog: 0, at: 0, st: 'campfire' };
  go({ type: 'store', key: fire.key, op: 'look' });
  assert.deepStrictEqual(cells(), { 0: 'raw_meat:1', 20: 'wood:2', 40: 'cooked_meat:4' });
  // what a cooker makes is not made by hand
  const recs = World.recipesFor(c, World.liveMap(c, ws, 'kitchen'), p, World.viewLookup(c, c.maps.kitchen, { states: {}, monsters: [], players: [] }, p));
  assert.ok(!recs.some(r => r.id === 'r_cooked_meat') && recs.some(r => r.id === 'r_hammer'));
});

test('a bow: one arrow on the string, drawing the next takes time, and others are told how it is held', () => {
  const s = hero('warrior');
  World.give(s.c, s.p, 'bow', 1, []); World.give(s.c, s.p, 'arrow', 3, []);
  onBelt(s.p, 0, 'bow'); World.holdSlot(s.c, s.p, 0);
  assert.strictEqual(s.p.equipment.weapon, 'bow');
  assert.strictEqual(World.weaponState(s.c, s.p), '', 'drawn for the first time it comes with an arrow nocked');
  const m = monster(s, 'skeleton', 12, 13); s.p.x = 9; s.p.y = 13;
  const hp = m.hp;
  act(s, { type: 'shoot', x: 12, y: 13 }, 10000);
  assert.ok(m.hp < hp, 'the arrow hit');
  assert.strictEqual(World.weaponState(s.c, s.p), 'empty');
  act(s, { type: 'shoot', x: 12, y: 13 }, 11000);                      // the next click draws another
  assert.strictEqual(World.weaponState(s.c, s.p), 'reload');
  const other = World.newPlayer(s.c, 'o', 'Other', 'warrior'); other.map = s.p.map;
  assert.strictEqual(World.view(s.c, s.ws, other.map, other, [s.p, other]).players.find(q => q.id === s.p.id).wst, 'reload');
  act(s, { type: 'face', dir: 'E' }, 11000 + 950);
  assert.deepStrictEqual([World.weaponState(s.c, s.p), World.count(s.p, 'arrow')], ['', 1], 'drawn: one arrow shot, one on the string, one left');
});

test('inventory: Take all empties a container into the bag as far as it fits, and Sort joins and orders the stacks', () => {
  const s = fresh();
  put(s, 'map_3', 9, 7, 'E');
  const box = act(s, { type: 'interact' }).find(e => e.type === 'storage');
  const before = [World.count(s.p, 'potion'), World.count(s.p, 'wooden_sword')];
  const ev = act(s, { type: 'inv', op: 'takeall', key: box.key });
  assert.deepStrictEqual([World.count(s.p, 'potion'), World.count(s.p, 'wooden_sword')], [before[0] + 2, before[1] + 1]);
  assert.deepStrictEqual(ev.find(e => e.type === 'storage').inv, [], 'the container is shown empty');
  // a full bag takes only what fits
  act(s, { type: 'inv', key: box.key, from: { w: 'bag', s: s.p.inventory.find(st => st.item === 'wooden_sword').s }, to: { w: 'box' } });
  s.p.inventory = [{ item: 'iron_key', qty: 1, s: 0 }]; s.c.config.bag_slots = 1;
  act(s, { type: 'inv', op: 'takeall', key: box.key });
  assert.strictEqual(World.beltOf(s.p)[0], 'wooden_sword', 'a weapon goes onto a free belt slot, full bag or not');
  act(s, { type: 'inv', key: box.key, from: { w: 'belt', s: 0 }, to: { w: 'box' } });
  for (let i = 0; i < World.BELT_SIZE; i++) s.p.inventory.push({ item: 'potion', qty: World.stackMaxOf(s.c, 'potion'), s: World.BELT_AT + i });
  assert.match(texts(act(s, { type: 'inv', op: 'takeall', key: box.key })), /Your bag is full/, 'belt and bag full: it stays');
  // sort: scattered part stacks of one thing become full ones, from the first cell
  s.c.config.bag_slots = 32;
  const max = World.stackMaxOf(s.c, 'potion');
  s.p.inventory = [{ item: 'potion', qty: 1, s: 20 }, { item: 'iron_key', qty: 1, s: 3 }, { item: 'potion', qty: max - 1, s: 7 }, { item: 'potion', qty: 2, s: 11 }];
  act(s, { type: 'inv', op: 'sort' });
  const pots = s.p.inventory.filter(st => st.item === 'potion').map(st => st.qty);
  assert.deepStrictEqual(pots, [max, 2]);
  assert.deepStrictEqual(s.p.inventory.map(st => st.s), [0, 1, 2], 'laid out from the first cell');
  assert.strictEqual(World.count(s.p, 'iron_key'), 1);
});

test('the belt: a slot whose item has run out is free again', () => {
  const s = fresh();
  const slot = World.beltOf(s.p).indexOf('potion');
  assert.ok(slot >= 0, 'the start potions sit on the belt');
  World.take(s.p, 'potion', World.count(s.p, 'potion') - 1);
  assert.strictEqual(World.beltOf(s.p)[slot], 'potion', 'one left: still there');
  World.take(s.p, 'potion', 1);
  assert.strictEqual(World.beltOf(s.p)[slot], '');
});

test('building: an object you built can be moved to a free spot, keeping what it is; others may not, and not onto something', () => {
  const s = chairs();
  roomAct(s, s.p, { type: 'build', bp: 'bp_chair', x: 7, y: 4, facing: 'N' });
  const chair = roomMap(s).entities.filter(e => e.ref === 'obj_chair' && e.x === 7)[0], T = { t: 'ent', key: chair.key }, key = chair.key;
  const lk = () => World.viewLookup(s.c, roomMap(s), World.view(s.c, s.ws, 'room', s.p, [s.p, s.q], -1), s.p);
  assert.ok(World.canMove(s.c, roomMap(s), lk(), s.p, T).ok, 'it may be picked up');
  assert.match(World.canMove(s.c, roomMap(s), lk(), s.p, T, 7, 4).reason, /already there/);
  const spot = [[6, 4], [8, 4], [7, 3], [7, 5]].filter(q => World.canMove(s.c, roomMap(s), lk(), s.p, T, q[0], q[1]).ok)[0];
  assert.ok(spot, 'a free cell next to it: ' + World.canMove(s.c, roomMap(s), lk(), s.p, T, 8, 4).reason);
  assert.match(roomAct(s, s.q, { type: 'relocate', target: T, x: spot[0], y: spot[1] }), /not yours|Too far|belongs/);
  assert.match(roomAct(s, s.p, { type: 'relocate', target: T, x: spot[0], y: spot[1], facing: 'W' }), /You move the chair/);
  const now = roomMap(s).entities.filter(e => e.key === key)[0];
  assert.deepStrictEqual([now.x, now.y, now.data.facing], [spot[0], spot[1], 'W'], 'same thing, new spot, turned');
  roomAct(s, s.p, { type: 'build', bp: 'bp_chair', x: 7, y: 4 });
  assert.match(roomAct(s, s.p, { type: 'relocate', target: T, x: 7, y: 4 }), /already there|not clear/);
});

test('a harvested tree does not grow back on top of someone standing there: it waits until the spot is clear', () => {
  const s = meadow();
  const map = s.c.maps.field, ref = Object.keys(s.c.objects).find(k => (s.c.objects[k].properties || {}).harvest), tree = { key: 'field.t1', x: 5, y: 5, ref, data: {} };
  map.entities = (map.entities || []).concat([tree]);
  World.advance(s.c, s.ws, 'field', [s.p], s.t, mid, []);
  s.ws.maps.field.struct = s.ws.maps.field.struct || {}; s.ws.maps.field.struct.gone = s.ws.maps.field.struct.gone || {}; s.ws.maps.field.struct.gone[tree.key] = 2;
  s.ws.maps.field.timers[tree.key] = { at: s.t + 1000, regrow: true };
  const w = s.put('deer', tree.x, tree.y); s.c.monsters.deer.moveMs = 9e9;
  World.advance(s.c, s.ws, 'field', [s.p], s.t + 2000, mid, []);
  assert.ok(s.ws.maps.field.struct.gone[tree.key], 'someone is on it: not yet');
  w.x = tree.x + 1;
  World.advance(s.c, s.ws, 'field', [s.p], s.t + 6000, mid, []);
  assert.ok(!s.ws.maps.field.struct.gone[tree.key], 'clear: it is back');
});

test('water: drinking from it quenches and adds toxicity; too much makes you ill, and it wears off', () => {
  const s = meadow(), map = s.c.maps.field;
  map.terrain[1][2] = 'l_water';                                        // right beside the player (1,1)
  const lk = () => World.viewLookup(s.c, map, World.view(s.c, s.ws, 'field', s.p, [s.p]), s.p);
  assert.deepStrictEqual(World.actionsAt(s.c, map, lk(), s.p, 2, 1).map(a => a.verb), ['drink']);
  assert.strictEqual(World.actionsAt(s.c, map, lk(), s.p, 1, 2).length, 0, 'plain ground offers nothing');
  s.p.thirst = 40;
  let ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1, verb: 'drink' }, s.t, mid, [s.p]);
  assert.strictEqual(s.p.thirst, 65); assert.strictEqual(s.p.tox, 8);
  assert.match(texts(ev), /drink from the water/);
  s.p.thirst = 100;
  assert.match(texts(World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1, verb: 'drink' }, s.t, mid, [s.p])), /not thirsty/);
  assert.strictEqual(s.p.tox, 8);
  s.p.facing = 'E'; s.p.thirst = 10;                                    // F, facing it: the same
  World.act(s.c, s.ws, s.p, { type: 'interact' }, s.t, mid, [s.p]);
  assert.strictEqual(s.p.thirst, 35); assert.strictEqual(s.p.tox, 16);
  s.p.tox = 49; s.p.thirst = 10;
  ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1, verb: 'drink' }, s.t, mid, [s.p]);
  assert.match(texts(ev), /feel sick/);
  const hp = s.p.hp; s.c.config.thirst_decay_per_min = 0; s.c.config.hunger_decay_per_min = 0;
  s.run(13000);                                                         // two ticks of 6 s
  assert.strictEqual(s.p.hp, hp - 4);
  s.p.tox = 10; s.run(60000 * 2);
  assert.ok(Math.abs(s.p.tox - 7) < 0.01, 'wears off 1.5 a minute: ' + s.p.tox);
  assert.strictEqual(World.publicPlayer(s.c, s.p).tox, 7);
});

test('water: a used bottle leaves an empty one, which is filled at water and drunk again (not clean)', () => {
  const s = meadow(), map = s.c.maps.field;
  map.terrain[1][2] = 'l_water';
  const n = id => World.count(s.p, id), lk = () => World.viewLookup(s.c, map, World.view(s.c, s.ws, 'field', s.p, [s.p]), s.p);
  s.p.inventory = []; s.p.held = -1;
  World.give(s.c, s.p, 'water', 2, []); World.give(s.c, s.p, 'ration', 1, []);
  s.p.thirst = 0; s.p.hunger = 0;
  World.act(s.c, s.ws, s.p, { type: 'use', item: 'water' }, s.t, mid, [s.p]);
  World.act(s.c, s.ws, s.p, { type: 'use', item: 'ration' }, s.t, mid, [s.p]);
  assert.strictEqual(n('water'), 1); assert.strictEqual(n('bottle'), 1); assert.strictEqual(n('empty_can'), 1);
  assert.strictEqual(s.p.tox, 0, 'bottled water is clean');
  s.p.thirst = 0; World.act(s.c, s.ws, s.p, { type: 'use', item: 'water' }, s.t, mid, [s.p]);
  assert.strictEqual(n('bottle'), 2);
  assert.deepStrictEqual(World.actionsAt(s.c, map, lk(), s.p, 2, 1).map(a => a.verb), ['drink', 'fill:bottle']);
  const ev = World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1, verb: 'fill:bottle' }, s.t, mid, [s.p]);
  assert.match(texts(ev), /fill the empty bottle ..2/);
  assert.strictEqual(n('bottle'), 0); assert.strictEqual(n('dirty_water'), 2);
  assert.match(texts(World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1, verb: 'fill:bottle' }, s.t, mid, [s.p])), /nothing to fill/);
  s.p.thirst = 0; World.act(s.c, s.ws, s.p, { type: 'use', item: 'dirty_water' }, s.t, mid, [s.p]);
  assert.strictEqual(s.p.thirst, 60); assert.strictEqual(s.p.tox, 12); assert.strictEqual(n('bottle'), 1);
  // an empty bottle in hand: the click (and F) fills it rather than drinking
  onBelt(s.p, 0, 'bottle'); s.p.held = 0;
  assert.strictEqual(World.actionsAt(s.c, map, lk(), s.p, 2, 1)[0].verb, 'fill:bottle');
  s.p.facing = 'E'; World.act(s.c, s.ws, s.p, { type: 'interact' }, s.t, mid, [s.p]);
  assert.strictEqual(n('bottle'), 0); assert.strictEqual(n('dirty_water'), 2);
  // content from before these columns: nothing left behind, water found by its name
  const old = JSON.parse(JSON.stringify(tables));
  old.Items.forEach(r => { delete r.leaves; delete r.fills_into; delete r.toxicity; }); old.Terrain.forEach(r => { delete r.water; delete r.toxicity; });
  const c2 = Content.build(old);
  assert.strictEqual(c2.items.water.leaves, ''); assert.strictEqual(c2.terrain.l_water.water, true); assert.strictEqual(c2.terrain.l_lava.water, false);
});

// ------------------------------------------------------------ quests, and who took part in a kill
function village(quests, extra) {
  const tb = JSON.parse(JSON.stringify(tables)), row = Array(12).fill('til_1');
  tb.Maps.push({ id: 'field', name: 'Field', width: 12, height: 12, terrain: JSON.stringify(Array(12).fill(row)) });
  tb.Objects.push({ id: 'npc_marta', name: 'Marta', kind: 'npc', properties: JSON.stringify({ text: 'Mind the rats.' }) }, { id: 'npc_tom', name: 'Tom', kind: 'npc' });
  tb.MapEntities.push({ map: 'field', key: 'field.e1', x: 3, y: 1, ref: 'npc_marta', data: '' }, { map: 'field', key: 'field.e2', x: 9, y: 9, ref: 'npc_tom', data: '' });
  tb.Quests = quests;
  if (extra) extra(tb);
  const c = Content.build(tb), ws = { maps: {} };
  c.config.move_burst = 999;
  const mk = (id, name, x, y) => Object.assign(World.newPlayer(c, id, name, 'warrior'), { map: 'field', x, y, facing: 'S' });
  const s = { c, ws, p: mk('p1', 'Ana', 2, 1), q: mk('p2', 'Ben', 2, 2), r: mk('p3', 'Cy', 6, 6), t: 1000 };
  World.advance(c, ws, 'field', [s.p, s.q, s.r], s.t, mid, []);
  s.put = (ref, x, y) => { const m = { id: ref + '#' + ws.maps.field.monsters.length, ref, x, y, hp: c.monsters[ref].hp, dead: false, last: s.t, respawnAt: 0, facing: 'S', spawn: '' }; ws.maps.field.monsters.push(m); return m; };
  s.as = (who, a) => World.act(c, ws, who, a, s.t += 1000, mid, [s.p, s.q, s.r]);
  s.turn = () => { const ev = []; World.advance(c, ws, 'field', [s.p, s.q, s.r], s.t += 100, mid, ev); return ev; };
  s.kill = (who, ref) => { const m = s.put(ref, 5, 5), ev = []; c.monsters[ref].moveMs = 99999; World.hitMonster(c, ws, 'field', who, m, 9999, s.t += 100, mid, ev); return ev; };
  s.log = who => World.questLog(c, who, s.t).map(x => x.id + ':' + x.s + ':' + x.n.join('/')).join(' ');
  s.open = who => World.questsOpen(c, who, s.t).join(' ');
  return s;
}
const RATS = { id: 'rats', name: 'Rat trouble', giver: 'npc_marta', text: 'Kill two rats.', objectives: 'kill:rat:2', rewards: 'xp:7; gold:5; give:wood:2' };

test('quests: offered by an NPC, accepted beside them, counted by kills, handed in for the rewards, and chained', () => {
  const s = village([RATS, { id: 'more', name: 'More rats', giver: 'npc_marta', objectives: 'kill:rat:1', requires: 'quest:rats' }]);
  s.c.monsters.rat.carcass = ''; s.c.monsters.rat.loot = ''; s.c.loot.rat = [];
  assert.strictEqual(s.open(s.p), 'rats', 'the second one waits for the first');
  const talk = s.as(s.p, { type: 'interact', x: 3, y: 1 }).find(e => e.type === 'npc');
  assert.deepStrictEqual([talk.key, talk.ref, talk.name, talk.text], ['field.e1', 'npc_marta', 'Marta', 'Mind the rats.'], 'talking opens her window');
  assert.match(texts(s.as(s.r, { type: 'quest', op: 'accept', id: 'rats' })), /need to be with Marta/, 'not from across the field');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'accept', id: 'rats' })), /New quest: Rat trouble/);
  assert.deepStrictEqual([s.log(s.p), s.open(s.p)], ['rats:active:0', ''], 'in the log, no longer offered');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'accept', id: 'rats' })), /already on/);
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'rats' })), /not done yet/);
  assert.match(texts(s.kill(s.p, 'rat')), /Rat: 1\/2/);
  const last = texts(s.kill(s.p, 'rat'));
  assert.match(last, /Rat: 2\/2/); assert.match(last, /Rat trouble: done\. Return to Marta/);
  s.kill(s.p, 'rat');
  assert.strictEqual(s.log(s.p), 'rats:ready:2', 'a third rat is not counted');
  Object.assign(s.p, { x: 8, y: 8 });
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'rats' })), /need to be with Marta/);
  Object.assign(s.p, { x: 2, y: 1 });
  const xp = s.p.xp, gold = s.p.gold, wood = World.count(s.p, 'wood');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'rats' })), /Quest complete: Rat trouble/);
  assert.deepStrictEqual([s.p.xp - xp, s.p.gold - gold, World.count(s.p, 'wood') - wood, s.log(s.p)], [7, 5, 2, ''], 'the rewards');
  assert.strictEqual(s.open(s.p), 'more', 'done once: not offered again, and the next in the chain is');
  assert.ok(World.check(s.c, s.p, 'quest:rats, !quest_active:rats') && !World.check(s.c, s.q, 'quest:rats'), 'conditions can ask about quests');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'accept', id: 'rats' })), /already done/);
  assert.match(texts(s.as(s.q, { type: 'quest', op: 'accept', id: 'more' })), /can't take that on yet/, 'another player has their own log');
});

test('quests: things to bring are counted in the bag and taken at hand-in; quest drops only fall for those who need them; choose-one rewards', () => {
  const s = village([{ id: 'tails', name: 'Tails', giver: 'npc_marta', ender: 'npc_tom', objectives: 'have:bone:2', choice: 'wood:3, scrap:1' }],
    tb => { tb.LootTables = tb.LootTables.filter(r => r.table !== 'rat'); tb.LootTables.push({ table: 'rat', item: 'bone', chance: 1, min: 1, max: 1, quest: 'tails' }); });
  s.c.monsters.rat.lootTable = 'rat'; s.c.monsters.rat.carcass = ''; s.c.monsters.rat.loot = '';
  const had = { bone: World.count(s.p, 'bone'), scrap: World.count(s.p, 'scrap'), wood: World.count(s.p, 'wood') };
  const n = id => World.count(s.p, id) - had[id];
  const kill = () => { s.kill(s.p, 'rat'); scoop(s.c, s.ws, 'field', s.p); };   // (and picks up what it left)
  kill();
  assert.strictEqual(n('bone'), 0, 'not on the quest: no quest drop');
  s.as(s.p, { type: 'quest', op: 'accept', id: 'tails' });
  kill();
  assert.deepStrictEqual([n('bone'), s.log(s.p)], [1, 'tails:active:1']);
  kill(); kill();
  assert.deepStrictEqual([n('bone'), s.log(s.p)], [2, 'tails:ready:2'], 'enough: no more fall');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'tails' })), /need to be with Tom/, 'handed in to someone else');
  Object.assign(s.p, { x: 8, y: 9 });
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'tails' })), /Choose your reward first/);
  assert.strictEqual(n('bone'), 2, 'nothing taken yet');
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'tails', choice: 1 });
  assert.deepStrictEqual([n('bone'), n('scrap'), n('wood'), s.log(s.p)], [0, 1, 0, ''], 'the bones are taken, the chosen reward given');
});

test('quests: a word with someone, giving up, repeatable missions, and quests started by an action', () => {
  const s = village([{ id: 'word', name: 'A word', giver: 'npc_marta', ender: 'npc_marta', objectives: 'talk:npc_tom', repeat_h: 1 },
    { id: 'found', name: 'A strange note', objectives: '', rewards: 'gold:1' }]);
  assert.strictEqual(s.open(s.p), 'word found');
  s.as(s.p, { type: 'quest', op: 'accept', id: 'word' });
  s.as(s.p, { type: 'interact', x: 3, y: 1 });
  assert.strictEqual(s.log(s.p), 'word:active:0', 'talking to the wrong one counts for nothing');
  Object.assign(s.p, { x: 8, y: 9 });
  assert.match(texts(s.as(s.p, { type: 'interact', x: 9, y: 9 })), /A word: done\. Return to Marta/);
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'abandon', id: 'word' })), /give up/);
  assert.deepStrictEqual([s.log(s.p), s.open(s.p)], ['', 'word found'], 'given up: offered again, from the start');
  Object.assign(s.p, { x: 2, y: 1 }); s.as(s.p, { type: 'quest', op: 'accept', id: 'word' });
  Object.assign(s.p, { x: 8, y: 9 }); s.as(s.p, { type: 'interact', x: 9, y: 9 });
  Object.assign(s.p, { x: 2, y: 1 }); s.as(s.p, { type: 'quest', op: 'turnin', id: 'word' });
  assert.strictEqual(s.open(s.p), 'found', 'a repeatable one is not offered again at once');
  assert.strictEqual(World.questState(s.c, s.p, s.c.quests.word, s.t + 3600 * 1000 + 1), 'open', 'but it is an hour later');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'accept', id: 'found' })), /Nobody offers that/);
  World.run(s.c, s.ws, s.p, 'quest:found', s.t, []);
  assert.strictEqual(s.log(s.p), 'found:ready:', 'started by an action; with nothing to do it is ready at once');
  const gold = s.p.gold;
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'found' });
  assert.strictEqual(s.p.gold, gold + 1, 'with no ender it is handed in anywhere');
  // content with no Quests tab at all
  const old = JSON.parse(JSON.stringify(tables)); delete old.Quests;
  const c2 = Content.build(old), p2 = World.newPlayer(c2, 'x', 'X', 'warrior');
  assert.deepStrictEqual([World.publicPlayer(c2, p2).quests, World.publicPlayer(c2, p2).questsOpen], [[], []]);
  delete p2.quests; delete p2.questsDone; World.normalize(c2, p2);
  assert.deepStrictEqual([p2.quests, p2.questsDone], [{}, {}], 'a character from before quests gets an empty log');
});

test('who took part: everyone who hit it gets the kill, the full XP and their own loot; a stale blow and a bystander get nothing', () => {
  const s = village([RATS]);
  s.c.monsters.rat.carcass = ''; s.c.monsters.rat.loot = 'wood:1'; s.c.monsters.rat.lootTable = 'rat'; s.c.monsters.rat.moveMs = 99999;
  s.c.loot.rat = [{ item: 'bone', chance: 1, min: 1, max: 1 }];
  s.as(s.p, { type: 'quest', op: 'accept', id: 'rats' }); s.as(s.q, { type: 'quest', op: 'accept', id: 'rats' });
  const rat = s.put('rat', 5, 5), rxp = s.c.monsters.rat.xp;
  const base = who => ({ xp: who.xp, bone: World.count(who, 'bone'), wood: World.count(who, 'wood') });
  const b = { p: base(s.p), q: base(s.q), r: base(s.r) };
  const got = k => { const who = s[k], was = b[k]; return [who.xp - was.xp, World.count(who, 'bone') - was.bone, World.count(who, 'wood') - was.wood]; };
  World.hitMonster(s.c, s.ws, 'field', s.q, rat, 1, s.t += 100, mid, []);
  assert.deepStrictEqual(Object.keys(rat.hits), ['p2'], 'the monster remembers who hit it');
  World.hitMonster(s.c, s.ws, 'field', s.p, rat, 9999, s.t += 100, mid, []);
  assert.deepStrictEqual(got('p'), [rxp, 0, 0], 'the last blow: a share at once — the loot in a bag on the ground, not in theirs');
  scoop(s.c, s.ws, 'field', s.p);
  assert.deepStrictEqual([got('p'), s.log(s.p)], [[rxp, 1, 1], 'rats:active:1'], 'their own roll, and what it always gives');
  assert.deepStrictEqual([got('q'), !!rat.hits], [[0, 0, 0], false], 'the other is not at hand yet');
  const ev2 = s.turn();
  scoop(s.c, s.ws, 'field', s.q);                                  // (the first bag was emptied and is gone: theirs lies in a new one)
  assert.deepStrictEqual([got('q'), s.log(s.q)], [[rxp, 1, 0], 'rats:active:1'], 'on the next turn: full XP, their own roll, the kill for their quest — not a second helping of what it always gives');
  assert.ok(ev2.some(e => e.type === 'kill' && e.to === 'p2'), 'and they are told (which also has the referee save them)');
  assert.deepStrictEqual([got('r'), !!s.ws.maps.field.credits], [[0, 0, 0], false], 'a bystander gets nothing; nothing is left waiting');
  s.turn();
  assert.deepStrictEqual(got('q'), [rxp, 1, 0], 'a share is given once');
  // a blow from long ago does not count
  const rat2 = s.put('rat', 5, 5);
  World.hitMonster(s.c, s.ws, 'field', s.q, rat2, 1, s.t += 100, mid, []);
  s.t += 31000;
  World.hitMonster(s.c, s.ws, 'field', s.p, rat2, 9999, s.t, mid, []);
  s.turn();
  assert.deepStrictEqual([got('q')[0], s.log(s.q), s.log(s.p)], [rxp, 'rats:active:1', 'rats:ready:2'], 'Ben hit it more than 30 s before it died');
  // someone who took part but has left the map: their share waits a minute, then is dropped
  const rat3 = s.put('rat', 5, 5);
  World.hitMonster(s.c, s.ws, 'field', s.q, rat3, 1, s.t += 100, mid, []);
  s.q.map = 'elsewhere';
  World.hitMonster(s.c, s.ws, 'field', s.p, rat3, 9999, s.t += 100, mid, []);
  s.turn();
  assert.strictEqual(s.ws.maps.field.credits.length, 1, 'kept for now');
  s.t += 61000; s.turn();
  assert.ok(!s.ws.maps.field.credits, 'and then forgotten');
});

test('who took part: in a carcass each finds the shared part and their own roll, and it stays until the last of it is taken', () => {
  const s = village([]);
  s.c.loot.deer = [{ item: 'bone', chance: 1, min: 2, max: 2 }]; s.c.monsters.deer.lootTable = 'deer'; s.c.monsters.deer.moveMs = 99999;
  const had = who => ({ bone: World.count(who, 'bone'), raw_meat: World.count(who, 'raw_meat'), leather: World.count(who, 'leather') });
  const hp = had(s.p), hq = had(s.q);
  const deer = s.put('deer', 3, 2);
  World.hitMonster(s.c, s.ws, 'field', s.q, deer, 1, s.t += 100, mid, []);
  World.hitMonster(s.c, s.ws, 'field', s.p, deer, 9999, s.t += 100, mid, []);
  s.turn();
  const body = () => s.ws.maps.field.struct.ents.find(e => e.ref === 'carcass_deer');
  const look = who => s.as(who, { type: 'interact', x: 3, y: 2 });
  const sees = who => { const box = look(who).find(e => e.type === 'storage'); return box && box.inv ? box.inv.map(st => st.item + ':' + st.qty).sort().join() : 'nothing'; };
  assert.deepStrictEqual([World.count(s.p, 'bone') - hp.bone, World.count(s.q, 'bone') - hq.bone], [0, 0], 'nothing straight into a bag');
  assert.strictEqual(sees(s.p), 'bone:2,leather:2,raw_meat:4', 'Ana: the shared meat and hide, and her bones');
  assert.strictEqual(sees(s.q), 'bone:2,leather:2,raw_meat:4', 'Ben: the same shared part, and bones of his own');
  Object.assign(s.r, { x: 4, y: 2 });
  assert.strictEqual(sees(s.r), 'leather:2,raw_meat:4', 'Cy took no part: only the shared part');
  assert.strictEqual(body().inv.filter(st => st.item === 'bone').length, 2, 'two lots of bones lie there');
  const key = body().key;
  const ev = s.as(s.p, { type: 'inv', op: 'takeall', key });
  assert.deepStrictEqual([World.count(s.p, 'bone') - hp.bone, World.count(s.p, 'raw_meat') - hp.raw_meat, World.count(s.p, 'leather') - hp.leather], [2, 4, 2], 'Ana takes all she sees');
  assert.ok(ev.some(e => e.type === 'storage' && e.gone) && body(), 'her window closes; the body stays, with the bones that are Ben’s');
  assert.match(texts(look(s.p)), /nothing on the/, 'nothing more for her');
  assert.strictEqual(sees(s.q), 'bone:2', 'the shared part went to who took it first; his own is untouched');
  assert.match(texts(look(s.r)), /nothing on the/);
  const cell = body().inv.find(st => st.own === 'p2').s;
  s.as(s.q, { type: 'inv', key, from: { w: 'box', s: cell }, to: { w: 'bag' } });
  assert.deepStrictEqual([World.count(s.q, 'bone') - hq.bone, !!body()], [2, false], 'the last of it taken: the body is gone');
  // killed with no player in the fight (a wolf's kill): the body holds one roll of the table, for anyone
  const d2 = s.put('deer', 7, 2);
  World.hitMonster(s.c, s.ws, 'field', null, d2, 9999, s.t += 100, mid, []);
  assert.deepStrictEqual(body().inv.map(st => st.item + ':' + st.qty + ':' + (st.own || '')).sort(), ['bone:2:', 'leather:2:', 'raw_meat:4:']);
});

test('quests: a new character starts with the quests named in Config start_quests, and is welcomed with them once', () => {
  const s = village([{ id: 'hello', name: 'Hello', ender: 'npc_marta', text: 'Find Marta.', rewards: 'gold:3' }, RATS],
    tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); tb.Config.push({ key: 'start_quests', value: 'hello, nope, rats' }); });
  assert.deepStrictEqual(Object.keys(s.p.quests), ['hello', 'rats'], 'both in the log from the start; an id that is no quest is skipped');
  assert.strictEqual(s.log(s.p), 'hello:ready: rats:active:0', 'in the order they are listed');
  assert.deepStrictEqual(World.publicPlayer(s.c, s.p).questIntro, ['hello', 'rats'], 'the page is told to welcome them');
  s.as(s.p, { type: 'quest', op: 'seen' });
  assert.strictEqual(World.publicPlayer(s.c, s.p).questIntro, undefined, 'read once, never shown again');
  assert.strictEqual(s.log(s.p), 'hello:ready: rats:active:0', 'the quests stay');
  const gold = s.p.gold;
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'hello' });
  assert.strictEqual(s.p.gold, gold + 3, 'handed in to its ender like any other');
  // a game with no start_quests, and a character from before: nothing
  const t = village([RATS], tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); });
  assert.deepStrictEqual([Object.keys(t.p.quests), World.publicPlayer(t.c, t.p).questIntro], [[], undefined]);
});

// Put one quest with these objectives straight into a scenario's content and its player's log.
function onQuest(s, objectives) {
  const goals = Content.parseGoals(objectives);
  s.c.quests = { q: { id: 'q', name: 'Q', giver: '', ender: 'someone', text: '', goals, requires: '', rewards: '', choice: '', repeatS: 0, order: 0 } };
  s.p.quests = { q: { n: goals.map(() => 0), at: 1 } }; s.p.questsDone = {};
  return () => World.questLog(s.c, s.p, 1e15)[0].s + ':' + World.questLog(s.c, s.p, 1e15)[0].n.join('/');
}

test('quests: objectives are a list of kinds — written as text or as the list the Content Studio saves, with their own wording', () => {
  assert.deepStrictEqual(Content.GOAL_TYPES.map(k => k.id), ['kill', 'have', 'own', 'talk', 'use', 'drink', 'eat', 'goto', 'interact', 'craft', 'build', 'tame', 'walk', 'hit', 'shoot', 'hold', 'ui']);
  assert.deepStrictEqual(Content.parseGoals('kill:rat:5; have:bone:2; talk:npc_tom; goto:field:8:7:2; nonsense:x:1; kill'),
    [{ type: 'kill', ref: 'rat', need: 5 }, { type: 'have', ref: 'bone', need: 2 }, { type: 'talk', ref: 'npc_tom', need: 1 }, { type: 'goto', ref: 'field', need: 1, x: 8, y: 7, r: 2 }],
    'text, as written by hand: what is not a kind, or names nothing, is dropped');
  const saved = JSON.stringify([{ type: 'use', ref: 'potion', need: 2, label: 'Patch yourself up' }, { type: 'goto', ref: 'field', x: 8, y: 8, r: 1, label: 'Reach the far corner' }, { type: 'talk', ref: 'npc_tom', need: 9 }]);
  assert.deepStrictEqual(Content.parseGoals(saved),
    [{ type: 'use', ref: 'potion', need: 2, label: 'Patch yourself up' }, { type: 'goto', ref: 'field', need: 1, x: 8, y: 8, r: 1, label: 'Reach the far corner' }, { type: 'talk', ref: 'npc_tom', need: 1 }],
    'the list the Content Studio saves: a kind that is not counted is always once');
  assert.deepStrictEqual([Content.parseGoals(''), Content.parseGoals(undefined), Content.parseGoals('[oops')], [[], [], []]);
  const s = village([{ id: 'both', name: 'Both', giver: 'npc_marta', objectives: saved }]);
  assert.deepStrictEqual(s.c.quests.both.goals.map(g => World.goalText(s.c, g)), ['Patch yourself up', 'Reach the far corner', 'Talk to Tom'], 'a goal reads as its label, or is named after its target');
});

test('quests: using an item, reaching a place and using an object count', () => {
  const s = village([{ id: 'trip', name: 'Trip', giver: 'npc_marta', objectives: 'use:potion:2; goto:field:8:8:1; interact:npc_tom' }]);
  s.as(s.p, { type: 'quest', op: 'accept', id: 'trip' });
  World.give(s.c, s.p, 'potion', 3, []);
  assert.match(texts(s.as(s.p, { type: 'use', item: 'potion' })), /already at full health/);
  assert.strictEqual(s.log(s.p), 'trip:active:0/0/0', 'a potion that was not used does not count');
  s.p.hp -= 60;
  assert.match(texts(s.as(s.p, { type: 'use', item: 'potion' })), /Potion: 1\/2/);
  s.p.cooldowns = {}; s.as(s.p, { type: 'use', item: 'potion' });
  s.p.cooldowns = {}; s.p.hp -= 30; s.as(s.p, { type: 'use', item: 'potion' });
  assert.strictEqual(s.log(s.p), 'trip:active:2/0/0', 'two asked for: a third changes nothing');
  Object.assign(s.p, { x: 5, y: 8 });
  s.as(s.p, { type: 'move', dirs: ['E'] });
  assert.strictEqual(s.log(s.p), 'trip:active:2/0/0', 'two tiles off: not there yet');
  assert.match(texts(s.as(s.p, { type: 'move', dirs: ['E'] })), /Trip: Field reached/);
  assert.strictEqual(s.log(s.p), 'trip:active:2/1/0', 'within one tile of the spot');
  Object.assign(s.p, { x: 2, y: 1 }); s.as(s.p, { type: 'face', dir: 'N' });
  assert.strictEqual(s.log(s.p), 'trip:active:2/1/0', 'having been there is enough: walking off does not undo it');
  Object.assign(s.p, { x: 8, y: 9 });
  assert.match(texts(s.as(s.p, { type: 'interact', x: 9, y: 9 })), /Trip: done/);
  assert.strictEqual(s.log(s.p), 'trip:ready:2/1/1');
  // a place on another map does not count here; arriving by a teleport does
  const t = village([{ id: 'far', name: 'Far', giver: 'npc_marta', objectives: 'goto:elsewhere:2:1:0' }]);
  t.as(t.p, { type: 'quest', op: 'accept', id: 'far' });
  assert.strictEqual(t.log(t.p), 'far:active:0', 'the same spot, on the wrong map');
  t.c.maps.elsewhere = Object.assign({}, t.c.maps.field, { id: 'elsewhere', name: 'Elsewhere', entities: [] });
  World.run(t.c, t.ws, t.p, 'teleport:elsewhere:2:1', t.t, []);
  t.as(t.p, { type: 'face', dir: 'N' });
  assert.strictEqual(t.log(t.p), 'far:ready:1');
});

test('quests: crafting, building and taming count', () => {
  const s = camp(), made = onQuest(s, 'craft:hammer:2');
  [['wood', 9], ['scrap', 9]].forEach(g => World.give(s.c, s.p, g[0], g[1], []));
  s.c.recipes.r_hammer.station = ''; s.c.recipes.r_hammer.timeS = 0;
  assert.match(texts(act(s, { type: 'craft', recipe: 'r_hammer' })), /Hammer: 1\/2/);
  act(s, { type: 'craft', recipe: 'r_hammer' }, 9000);
  assert.strictEqual(made(), 'ready:2', 'made by hand, one at a time');
  const s1 = camp(), slow = onQuest(s1, 'craft:hammer:1');
  [['wood', 9], ['scrap', 9]].forEach(g => World.give(s1.c, s1.p, g[0], g[1], []));
  s1.c.recipes.r_hammer.station = ''; s1.c.recipes.r_hammer.timeS = 2;
  act(s1, { type: 'craft', recipe: 'r_hammer' }, 1000);
  assert.strictEqual(slow(), 'active:0', 'one that takes time is not made yet');
  World.advance(s1.c, s1.ws, 'camp', [s1.p], 2000, mid, []); World.advance(s1.c, s1.ws, 'camp', [s1.p], 3500, mid, []);
  assert.strictEqual(slow(), 'ready:1', 'counted when it is finished');

  const b = yard(), built = onQuest(b, 'build:bp_wood_wall:1');
  assert.match(doAct(b, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' }), /set up the frame/);
  assert.strictEqual(built(), 'active:0', 'a frame is not a wall yet');
  for (let i = 0; i < 12 && built() !== 'ready:1'; i++) doAct(b, { type: 'work', target: { t: 'wall', orient: 'h', x: 4, y: 4 } });
  assert.strictEqual(built(), 'ready:1', 'finished: built');

  const m = meadow(), hen = m.put('chicken', 2, 1), tamed = onQuest(m, 'tame:chicken:1');
  m.c.monsters.chicken.moveMs = 99999;
  World.give(m.c, m.p, 'seeds', 2, []); onBelt(m.p, 1, 'seeds'); World.holdSlot(m.c, m.p, 1);
  World.act(m.c, m.ws, m.p, { type: 'interact', x: hen.x, y: hen.y }, m.t += 1000, mid, [m.p]);
  assert.deepStrictEqual([hen.tame, tamed()], [true, 'ready:1']);
});

test('quests: drinking and eating count from any source; a quest with nobody to hand it to waits to be claimed, and can start the next', () => {
  const s = village([
    { id: 'awake', name: 'You are finally awake', text: 'Your throat burns.', done_text: 'Better.', objectives: 'drink', rewards: 'xp:5; quest:clean' },
    { id: 'clean', name: 'Not so fast', ender: 'npc_marta', text: 'That water is not safe.', objectives: 'eat:2' }],
    tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests' && r.key !== 'start_thirst' && r.key !== 'start_hunger');
      tb.Config.push({ key: 'start_quests', value: 'awake' }, { key: 'start_thirst', value: 30 }, { key: 'start_hunger', value: 55 }); });
  assert.deepStrictEqual(s.c.quests.awake.goals, [{ type: 'drink', ref: '*', need: 1 }], 'a goal with no target');
  assert.deepStrictEqual([s.p.thirst, s.p.hunger, s.log(s.p)], [30, 55, 'awake:active:0'], 'a new character starts thirsty, with the quest');
  s.c.maps.field.terrain[1][1] = 'l_water';                             // a stream right beside Ana (2,1)
  const xp = s.p.xp;
  const ev = s.as(s.p, { type: 'interact', x: 1, y: 1, verb: 'drink' });
  assert.match(texts(ev), /drink from the/); assert.match(texts(ev), /You are finally awake: done\.$/m);
  assert.ok(ev.some(e => e.type === 'quest' && e.ready === 'awake'), 'the page is told which quest is ready');
  assert.deepStrictEqual([s.p.xp - xp, s.log(s.p), !!s.p.questsDone.awake], [0, 'awake:ready:1', false], 'done, but not finished by itself: it waits to be claimed');
  s.turn();
  assert.strictEqual(s.log(s.p), 'awake:ready:1', 'and goes on waiting');
  Object.assign(s.p, { x: 7, y: 7 });
  const ev2 = s.as(s.p, { type: 'quest', op: 'turnin', id: 'awake' });
  assert.ok(ev2.some(e => e.type === 'quest' && e.done === 'awake'), 'claimed wherever the player stands: there is nobody to go back to');
  assert.deepStrictEqual([s.p.xp - xp, s.log(s.p), !!s.p.questsDone.awake], [5, 'clean:active:0', true], 'its reward given, and the next one started by it');
  assert.ok(s.p.intro.indexOf('clean') >= 0 && World.publicPlayer(s.c, s.p).questIntro.indexOf('clean') >= 0, 'the next one is announced');
  // eating: any food, counted each time something is actually eaten
  World.give(s.c, s.p, 'ration', 3, []);
  s.p.hunger = 100;
  s.as(s.p, { type: 'use', item: 'ration' });
  assert.strictEqual(s.log(s.p), 'clean:active:0', 'not hungry: nothing eaten, nothing counted');
  s.p.hunger = 10; s.p.cooldowns = {};
  assert.match(texts(s.as(s.p, { type: 'use', item: 'ration' })), /Eat something: 1\/2/);
  s.p.hunger = 10; s.p.cooldowns = {};
  s.as(s.p, { type: 'use', item: 'ration' });
  assert.strictEqual(s.log(s.p), 'clean:ready:2');
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'turnin', id: 'clean' })), /need to be with Marta/, 'this one has someone to return to');
  // a drink from a bottle counts as well as one from a stream
  const t = village([{ id: 'awake', name: 'Awake', objectives: 'drink:2' }]);
  World.run(t.c, t.ws, t.p, 'quest:awake', t.t, []);
  World.give(t.c, t.p, 'water', 2, []); t.p.thirst = 20;
  t.as(t.p, { type: 'use', item: 'water' }); t.p.thirst = 20; t.p.cooldowns = {};
  assert.strictEqual(t.log(t.p), 'awake:active:1');
  t.as(t.p, { type: 'use', item: 'water' });
  assert.strictEqual(t.log(t.p), 'awake:ready:2');
  // claiming one with a reward to choose
  const u = village([{ id: 'pick', name: 'Pick', objectives: 'drink', choice: 'wood:1, bone:1' }]);
  World.run(u.c, u.ws, u.p, 'quest:pick', u.t, []);
  World.give(u.c, u.p, 'water', 1, []); u.p.thirst = 20;
  const bones = World.count(u.p, 'bone');
  u.as(u.p, { type: 'use', item: 'water' });
  assert.match(texts(u.as(u.p, { type: 'quest', op: 'turnin', id: 'pick' })), /Choose your reward first/);
  u.as(u.p, { type: 'quest', op: 'turnin', id: 'pick', choice: 1 });
  assert.deepStrictEqual([u.log(u.p), World.count(u.p, 'bone') - bones], ['', 1]);
});
test('water does not block the view: you see across it even when see_through was never ticked', () => {
  const tb = JSON.parse(JSON.stringify(tables));
  tb.Terrain.forEach(r => { r.see_through = false; delete r.water; });
  const c = Content.build(tb);
  assert.strictEqual(c.terrain.l_water.seeThrough, true); assert.strictEqual(c.terrain.l_swamp.seeThrough, true);
  assert.strictEqual(c.terrain.til_2.seeThrough, false, 'a stone wall still hides');
});

test('dropping: items leave the bag for a loot bag at your feet; more goes in the same one; emptied it is gone, left it rots', () => {
  const s = meadow(), n = id => World.count(s.p, id), ents = () => s.ws.maps.field.struct.ents;
  const A = a => World.act(s.c, s.ws, s.p, a, s.t, mid, [s.p]);
  s.p.inventory = []; s.p.held = -1;
  World.give(s.c, s.p, 'wood', 10, []); World.give(s.c, s.p, 'ration', 2, []);
  const woodCell = s.p.inventory.find(g => g.item === 'wood').s, foodCell = s.p.inventory.find(g => g.item === 'ration').s;
  assert.match(texts(A({ type: 'inv', op: 'drop', s: woodCell, qty: 4 })), /drop 4/);
  assert.strictEqual(n('wood'), 6);
  assert.deepStrictEqual(ents().map(e => [e.ref, e.x, e.y, e.wild]), [['_bag', 1, 1, true]]);
  A({ type: 'inv', op: 'drop', s: foodCell });                               // no number = the whole stack
  assert.strictEqual(n('ration'), 0); assert.strictEqual(ents().length, 1, 'the same bag');
  assert.ok(!World.beltOf(s.p).includes('ration'), 'its belt slot is free');
  assert.match(texts(A({ type: 'inv', op: 'drop', s: 31 })), /nothing there/);
  const bag = ents()[0];
  assert.deepStrictEqual(bag.inv.map(g => g.item + ':' + g.qty).sort(), ['ration:2', 'wood:4']);
  let ev = A({ type: 'interact', x: 1, y: 1 });                               // it opens like a carcass: take only
  assert.ok(ev.some(e => e.type === 'storage' && e.key === bag.key && e.takeOnly));
  assert.match(texts(A({ type: 'store', key: bag.key, op: 'put', item: 'wood', qty: 1 })), /can't put/);
  A({ type: 'inv', op: 'takeall', key: bag.key });
  assert.deepStrictEqual([n('wood'), n('ration'), ents().length], [10, 2, 0]);
  A({ type: 'inv', op: 'drop', s: s.p.inventory.find(g => g.item === 'wood').s, qty: 1 });
  assert.strictEqual(ents().length, 1);
  s.run(901000);
  assert.strictEqual(ents().length, 0, 'nobody came for it');
});

test('a chest of the map that is smashed spills what it held into a loot bag', () => {
  const s = meadow(), map = s.c.maps.field;
  const ref = Object.keys(s.c.objects).find(k => s.c.objects[k].kind === 'container' && k !== '_bag');
  map.entities = (map.entities || []).concat([{ key: 'field.c1', x: 5, y: 5, ref, data: {} }]); delete map._at;
  s.ws.maps.field.boxes = { 'field.c1': [{ item: 'wood', qty: 3, s: 0 }] };
  s.c.objects[ref].properties.hp = 10; delete s.c.objects[ref].properties.indestructible;
  const res = World.damageStructure(s.c, s.ws, 'field', { t: 'ent', key: 'field.c1' }, 999, { kind: 'blast', now: s.t }, []);
  assert.ok(res && res.destroyed, 'it broke');
  const left = s.ws.maps.field.struct.ents;
  assert.deepStrictEqual(left.map(e => [e.ref, e.x, e.y]), [['_bag', 5, 5]]);
  assert.deepStrictEqual(left[0].inv.map(g => g.item + ':' + g.qty), ['wood:3']);
  assert.strictEqual(s.ws.maps.field.boxes['field.c1'], undefined);
});

test('an item laid on the ground in the map editor is picked up; with respawn_s it comes back', () => {
  const s = meadow(), map = s.c.maps.field;
  map.entities = (map.entities || []).concat([{ key: 'field.i1', x: 2, y: 1, ref: '_drop', data: { pickup: 'wood:2' } }, { key: 'field.i2', x: 1, y: 2, ref: '_drop', data: { pickup: 'ration:1', respawn_s: 60 } }]); delete map._at;
  const n = id => World.count(s.p, id), w0 = n('wood'), r0 = n('ration'), live = () => World.liveMap(s.c, s.ws, 'field').entities.map(e => e.key);
  const lk = World.viewLookup(s.c, map, World.view(s.c, s.ws, 'field', s.p, [s.p]), s.p);
  assert.match(World.actionsAt(s.c, World.liveMap(s.c, s.ws, 'field'), lk, s.p, 2, 1)[0].label, /Pick up the wood/);
  World.act(s.c, s.ws, s.p, { type: 'interact', x: 2, y: 1 }, s.t, mid, [s.p]);
  World.act(s.c, s.ws, s.p, { type: 'interact', x: 1, y: 2 }, s.t, mid, [s.p]);
  assert.deepStrictEqual([n('wood') - w0, n('ration') - r0], [2, 1]);
  assert.ok(!live().includes('field.i1') && !live().includes('field.i2'));
  s.p.x = 8; s.p.y = 8; s.run(61000);
  assert.ok(!live().includes('field.i1'), 'no respawn set: gone for good');
  assert.ok(live().includes('field.i2'), 'it is back');
  assert.ok(s.c.kinds.pickup.props.respawn_s, 'the editor has its settings');
});

test('looks: an object may have several pictures (v1, v2…); a placement picks one, and they go round in order', () => {
  const tb = JSON.parse(JSON.stringify(tables)), row = tb.Objects.find(r => r.sprite);
  row.sprite_states = (row.sprite_states ? row.sprite_states + '; ' : '') + 'v2=b.png; v1=a.png; v10=c.png';
  const o = Content.build(tb).objects[row.id];
  assert.deepStrictEqual(Rules.looks(o), ['v1', 'v2', 'v10']);
  assert.strictEqual(Rules.lookSprite(o, { data: { look: 'v2' } }), 'b.png');
  assert.strictEqual(Rules.lookSprite(o, { data: {} }), ''); assert.strictEqual(Rules.lookSprite(o, { data: { look: 'v7' } }), '', 'a look it no longer has: the main sprite');
  assert.deepStrictEqual(['', 'v1', 'v2', 'v10'].map(k => Rules.nextLook(o, k, 1)), ['v1', 'v2', 'v10', '']);
  assert.strictEqual(Rules.nextLook(o, '', -1), 'v10');
  assert.deepStrictEqual(Rules.looks(Content.build(tables).objects[row.id]), []);
});

test('building can be locked until something happens (Config build_if): refused with the text, then open once the condition holds', () => {
  const s = yard();
  const lk = () => World.viewLookup(s.c, yardMap(s), { states: {}, monsters: [], players: [] }, s.p);
  const ghost = () => World.canBuild(s.c, yardMap(s), lk(), s.p, s.c.blueprints.bp_wood_wall, 4, 4, 'N');
  assert.strictEqual(World.publicPlayer(s.c, s.p).buildLocked, undefined, 'no condition: open to all');
  s.c.config.build_if = 'flag:can_build';
  assert.deepStrictEqual(ghost(), { ok: false, reason: "You don't know how to build yet." });
  assert.match(doAct(s, { type: 'build', bp: 'bp_wood_wall', x: 4, y: 4, side: 'N' }), /don't know how to build yet/);
  s.c.config.build_locked_text = 'Talk to the mayor first.';
  assert.strictEqual(World.publicPlayer(s.c, s.p).buildLocked, 'Talk to the mayor first.');
  assert.strictEqual(ghost().reason, 'Talk to the mayor first.');
  s.p.flags.can_build = 1;
  assert.strictEqual(World.publicPlayer(s.c, s.p).buildLocked, undefined);
  assert.strictEqual(ghost().ok, true);
  s.c.config.build_if = 'quest:first_steps'; assert.strictEqual(World.buildUnlocked(s.c, s.p), false);
  s.p.questsDone = { first_steps: 1 }; assert.strictEqual(World.buildUnlocked(s.c, s.p), true);
});

test('harvesting: with a bare-hands yield a tree is picked by hand without being hurt, and cut down with the axe in hand', () => {
  const start = (withAxe) => {
    const s = camp();
    Object.assign(s.c.objects.t_tree.properties, { hp: 12, harvest: 'wood:6', harvest_bare: 'potion:2, ration:1', harvest_bare_hits: 4 });
    s.c.items.axe.vsMaterial = {}; s.c.items.axe.structureDmg = 3;
    s.p.inventory = []; s.p.held = -1; s.p.equipment = {};
    if (withAxe) World.give(s.c, s.p, 'axe', 1, []);
    if (withAxe === true) { onBelt(s.p, 0, 'axe'); World.holdSlot(s.c, s.p, 0); }
    s.live = () => World.liveMap(s.c, s.ws, 'camp');
    s.hp = () => { const i = World.structInfo(s.c, s.live(), { t: 'ent', key: 'camp.e2' }); return i ? i.hp : 0; };
    s.got = () => ['wood', 'potion', 'ration'].map(id => World.count(s.p, id));
    s.now = 1000; s.hit = () => { s.now += 2000; return texts(act(s, { type: 'attack', x: 1, y: 0 }, s.now)); };
    return s;
  };
  ['bag', false].forEach(axe => {                             // an axe in the bag is not an axe in hand
    const s = start(axe);
    assert.ok(World.harvestWith(s.c, s.live(), s.p, 1, 0), 'holding the button works');
    let said = ''; for (let k = 0; k < 4; k++) said += s.hit();
    assert.ok(!/You need/.test(said), said);
    assert.deepStrictEqual(s.got(), [0, 2, 1]);
    assert.strictEqual(s.hp(), 12, 'not a scratch');
    for (let k = 0; k < 8; k++) s.hit();                        // and it never runs out
    assert.deepStrictEqual(s.got(), [0, 6, 3]);
    assert.strictEqual(s.hp(), 12);
    assert.strictEqual(s.ws.maps.camp.bare, undefined, 'nothing kept per tree');
  });
  const s = start(true);                                      // the axe cuts it down, for the wood
  let n = 0; while (s.hp() > 0 && n++ < 30) s.hit();
  assert.deepStrictEqual(s.got(), [6, 0, 0]);
  const o = camp();                                           // no bare-hands yield: as before, no tool, no harvest
  o.p.inventory = []; o.p.equipment = {}; o.p.held = -1;
  assert.strictEqual(World.harvestWith(o.c, World.liveMap(o.c, o.ws, 'camp'), o.p, 1, 0), null);
  assert.match(texts(act(o, { type: 'attack', x: 1, y: 0 }, 5000)), /You need/);
});

test('tutorial: steps count the basics, finish by themselves, lead into the first real quest, and can be skipped', () => {
  const STEPS = [
    { id: 't_move', name: 'Getting around', tutorial: 'TRUE', image: 'art/tutorial/move.gif', text: 'Walk with [W] [A] [S] [D].', objectives: 'walk:3', rewards: 'xp:1; quest:t_bag' },
    { id: 't_bag', name: 'Your bag', tutorial: true, objectives: 'ui:bag; hold', rewards: 'quest:t_hit' },
    { id: 't_hit', name: 'Hitting', tutorial: true, objectives: JSON.stringify([{ type: 'hit', need: 2 }, { type: 'shoot', need: 1 }]), rewards: 'quest:real' },
    { id: 'real', name: 'The real thing', objectives: 'drink', rewards: 'xp:5' }];
  const cfg = tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); tb.Config.push({ key: 'start_quests', value: 't_move' }); };
  const s = village(STEPS, cfg);
  assert.deepStrictEqual([s.c.quests.t_move.tutorial, s.c.quests.t_move.image, s.c.quests.real.tutorial, s.c.quests.real.image], [true, 'art/tutorial/move.gif', false, '']);
  assert.deepStrictEqual(s.c.quests.t_bag.goals, [{ type: 'ui', ref: 'bag', need: 1 }, { type: 'hold', ref: '*', need: 1 }]);
  assert.deepStrictEqual(s.c.quests.t_hit.goals.map(g => World.goalText(s.c, g)), ['Hit something', 'Fire a shot']);
  assert.strictEqual(s.log(s.p), 't_move:active:0');
  // walking: steps taken are counted (quietly), a step into a wall is not
  Object.assign(s.p, { x: 0, y: 5 });
  const ev0 = s.as(s.p, { type: 'move', dirs: ['W', 'E', 'E'] });
  assert.strictEqual(s.log(s.p), 't_move:active:2', 'two steps taken, one refused');
  assert.doesNotMatch(texts(ev0), /2\/3/, 'no line in the log for every step');
  const xp = s.p.xp, ev1 = s.as(s.p, { type: 'move', dirs: ['E', 'E'] });
  assert.ok(ev1.some(e => e.type === 'quest' && e.done === 't_move'), 'done: it finishes by itself, with no window to claim it in');
  assert.deepStrictEqual([s.log(s.p), s.p.xp - xp, s.p.intro.join()], ['t_bag:active:0/0', 1, 't_bag'], 'its reward given and the next step started and announced');
  // a window of the page: only the page can say it was opened; a made-up one counts for nothing
  s.as(s.p, { type: 'quest', op: 'did', what: 'nonsense' }); s.as(s.p, { type: 'quest', op: 'did', what: 'craft' });
  assert.strictEqual(s.log(s.p), 't_bag:active:0/0');
  s.as(s.p, { type: 'quest', op: 'did', what: 'bag' });
  assert.strictEqual(s.log(s.p), 't_bag:active:1/0');
  // taking something in hand: an empty slot is nothing in hand
  clearBelt(s.p); s.as(s.p, { type: 'hold', slot: 3 });
  assert.strictEqual(s.log(s.p), 't_bag:active:1/0');
  World.give(s.c, s.p, 'bow', 1, []); World.give(s.c, s.p, 'arrow', 5, []); onBelt(s.p, 0, 'bow');
  s.as(s.p, { type: 'hold', slot: 0 });
  assert.strictEqual(s.log(s.p), 't_hit:active:0/0', 'both done: on to the next step');
  // a shot fired counts as a shot; one that lands is also a blow
  s.c.monsters.rat.moveMs = 99999; s.c.monsters.rat.hp = 9999;
  const rat = s.put('rat', s.p.x + 3, s.p.y); rat.hp = 9999;
  s.as(s.p, { type: 'shoot', x: rat.x, y: rat.y });
  assert.strictEqual(s.log(s.p), 't_hit:active:1/1');
  Object.assign(rat, { x: s.p.x + 1 }); s.p.cooldowns = {}; s.p.nextAttack = 0;
  s.as(s.p, { type: 'hold', slot: -1 });
  const ev2 = s.as(s.p, { type: 'attack', x: rat.x, y: rat.y });
  assert.ok(ev2.some(e => e.done === 't_hit'));
  assert.deepStrictEqual([s.log(s.p), !!s.p.questsDone.t_hit], ['real:active:0', true], 'the last step starts the first real quest');
  // an ordinary quest still waits to be claimed
  s.c.maps.field.terrain[s.p.y][s.p.x - 1] = 'l_water';
  s.p.thirst = 20; s.as(s.p, { type: 'interact', x: s.p.x - 1, y: s.p.y, verb: 'drink' });
  assert.strictEqual(s.log(s.p), 'real:ready:1');

  // skipping: every step is closed with no reward, and the real quest at the end of the chain starts
  const k = village(STEPS, cfg), xp2 = k.p.xp;
  assert.match(texts(k.as(k.p, { type: 'quest', op: 'skip' })), /Tutorial skipped/);
  assert.deepStrictEqual([k.log(k.p), k.p.xp - xp2, ['t_move', 't_bag', 't_hit'].every(id => k.p.questsDone[id]), k.p.intro.join()], ['real:active:0', 0, true, 'real']);
  assert.strictEqual(texts(k.as(k.p, { type: 'quest', op: 'skip' })), '', 'nothing left to skip');
  // a tutorial step with someone to return to is handed in like any other
  const e = village([{ id: 't_talk', name: 'Say hello', tutorial: true, ender: 'npc_marta', objectives: 'walk:1' }]);
  World.run(e.c, e.ws, e.p, 'quest:t_talk', e.t, []);
  Object.assign(e.p, { x: 6, y: 6 }); e.as(e.p, { type: 'move', dirs: ['E'] });
  assert.strictEqual(e.log(e.p), 't_talk:ready:1');
});

test('quests: a main quest cannot be given up; the player picks what to follow; tutorial steps say nothing in the log', () => {
  const Q = [
    { id: 'main', name: 'The story', no_abandon: 'TRUE', before_start: 'quest:t_walk', objectives: 'walk:2; drink' },
    { id: 'side', name: 'An errand', objectives: 'kill:rat:3' },
    { id: 't_walk', name: 'Walking', tutorial: true, objectives: 'walk:2' }];
  const cfg = tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); tb.Config.push({ key: 'start_quests', value: 'main side' }); };
  const s = village(Q, cfg);
  assert.deepStrictEqual([s.c.quests.main.noAbandon, s.c.quests.side.noAbandon], [true, false]);
  assert.match(texts(s.as(s.p, { type: 'quest', op: 'abandon', id: 'main' })), /cannot be given up/);
  assert.ok(s.p.quests.main, 'still on it');
  // follow: every quest is followed when it starts; the player may stop, and start again
  const log = () => World.publicPlayer(s.c, s.p).quests.map(x => x.id + (x.hide ? ':hidden' : '')).sort().join(' ');
  assert.strictEqual(log(), 'main side t_walk'.split(' ').sort().join(' '));
  s.as(s.p, { type: 'quest', op: 'follow', id: 'side', on: false });
  assert.strictEqual(log(), 'main side:hidden t_walk'.split(' ').sort().join(' '));
  s.as(s.p, { type: 'quest', op: 'follow', id: 'side', on: true });
  assert.strictEqual(log(), 'main side t_walk'.split(' ').sort().join(' '));
  // a tutorial step is counted and finishes, with no line in the log; the real quest still speaks
  Object.assign(s.p, { x: 0, y: 5 });
  const ev = s.as(s.p, { type: 'move', dirs: ['E', 'E'] });
  assert.ok(s.p.questsDone.t_walk, 'the step is done');
  assert.ok(!/Walking/.test(texts(ev)), 'nothing said about it: ' + texts(ev));
  assert.ok(ev.some(e => e.done === 't_walk'), 'the page is still told it finished');
  s.as(s.p, { type: 'quest', op: 'abandon', id: 'side' });
  assert.ok(!s.p.quests.side, 'an ordinary quest can be given up');
});

test('quest hooks: before_start and an objective\'s on_done start tutorial steps, one window at a time; abandon closes them; skip stays skipped', () => {
  const Q = [
    { id: 'q0', name: 'Water', before_start: 'quest:t_move', rewards: 'quest:q1',
      objectives: JSON.stringify([{ type: 'goto', ref: 'field', x: 3, y: 5, r: 0, label: 'Reach the river bank', on_done: 'quest:t_click' }, { type: 'drink' }]) },
    { id: 't_move', name: 'Move', tutorial: true, objectives: 'walk:2' },
    { id: 't_click', name: 'Click', tutorial: true, objectives: 'drink' },
    { id: 'q1', name: 'Next', objectives: 'kill:rat:1' }];
  const cfg = tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); tb.Config.push({ key: 'start_quests', value: 'q0' }); };
  const s = village(Q, cfg);
  assert.deepStrictEqual([s.c.quests.q0.beforeStart, s.c.quests.q0.goals[0].onDone, s.c.quests.q0.goals[1].onDone], ['quest:t_move', 'quest:t_click', undefined]);
  assert.deepStrictEqual(s.p.intro, ['q0', 't_move'], 'the quest, then the tutorial its start shows');
  assert.strictEqual(s.p.quests.t_move.by, 'q0');
  s.as(s.p, { type: 'quest', op: 'seen', id: 'q0' });
  assert.deepStrictEqual(s.p.intro, ['t_move'], 'read one window: the next still waits');
  Object.assign(s.p, { x: 0, y: 5 });
  s.as(s.p, { type: 'move', dirs: ['E', 'E'] });
  assert.ok(s.p.questsDone.t_move && !s.p.quests.t_click, 'walked: the movement step is done; not at the bank yet');
  s.as(s.p, { type: 'move', dirs: ['E'] });
  assert.strictEqual((s.p.quests.t_click || {}).by, 'q0', 'the bank reached: the click step starts');
  s.as(s.p, { type: 'move', dirs: ['W', 'E'] });
  assert.strictEqual(s.p.intro.filter(x => x === 't_click').length, 1, 'an objective\'s hook runs once');
  s.c.maps.field.terrain[5][4] = 'l_water'; s.p.thirst = 20;
  s.as(s.p, { type: 'interact', x: 4, y: 5, verb: 'drink' });
  assert.ok(s.p.questsDone.t_click, 'one drink finishes the click step...');
  assert.strictEqual(s.log(s.p), 'q0:ready:1/1', '...and the quest\'s own drink');
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'q0' });
  assert.ok(s.p.questsDone.q0 && s.p.quests.q1 && s.p.intro.indexOf('q1') >= 0, 'claimed: the next quest starts');

  // giving the quest up closes the steps it started (not done: they come back with it)
  const a = village(Q, cfg);
  a.as(a.p, { type: 'quest', op: 'abandon', id: 'q0' });
  assert.deepStrictEqual([Object.keys(a.p.quests), a.p.intro, !!a.p.questsDone.t_move], [[], undefined, false]);
  World.run(a.c, a.ws, a.p, 'quest:q0', a.t, []);
  assert.deepStrictEqual([Object.keys(a.p.quests).sort(), a.p.intro], [['q0', 't_move'], ['q0', 't_move']]);

  // Skip tutorial: the quest goes on, and a step its hooks start later is skipped too, with no window
  const k = village(Q, cfg);
  k.as(k.p, { type: 'quest', op: 'skip' });
  assert.deepStrictEqual([Object.keys(k.p.quests), k.p.intro, k.p.tutOff], [['q0'], ['q0'], true]);
  Object.assign(k.p, { x: 2, y: 5 }); k.as(k.p, { type: 'move', dirs: ['E'] });
  assert.deepStrictEqual([Object.keys(k.p.quests), k.p.intro, !!k.p.questsDone.t_click], [['q0'], ['q0'], true]);
});

test('quest hooks: on_start waits for the quest\'s window to be read; before_start does not; no window = at once', () => {
  const Q = [
    { id: 'q0', name: 'Water', before_start: 'flag:before', on_start: 'flag:after; quest:t_move', objectives: 'drink' },
    { id: 't_move', name: 'Move', tutorial: true, objectives: 'walk:2' },
    { id: 'q2', name: 'Asked', giver: 'npc_marta', on_start: 'flag:asked', objectives: 'drink' }];
  const cfg = tb => { tb.Config = tb.Config.filter(r => r.key !== 'start_quests'); tb.Config.push({ key: 'start_quests', value: 'q0' }); };
  const s = village(Q, cfg);
  assert.deepStrictEqual([!!s.p.flags.before, !!s.p.flags.after, s.p.intro, !!s.p.quests.t_move], [true, false, ['q0'], false], 'started: before_start has run, on_start waits');
  s.as(s.p, { type: 'quest', op: 'seen', id: 'q0' });
  assert.deepStrictEqual([!!s.p.flags.after, s.p.intro, s.p.quests.t_move && s.p.quests.t_move.by], [true, ['t_move'], 'q0'], 'its window read: on_start runs, and its tutorial window is next');
  s.as(s.p, { type: 'quest', op: 'seen', id: 'q0' });
  assert.strictEqual(Object.keys(s.p.quests).filter(x => x === 't_move').length, 1, 'runs once');
  // a quest with no window (taken from an NPC): on_start runs at once
  s.as(s.p, { type: 'quest', op: 'accept', id: 'q2' });
  assert.ok(s.p.flags.asked && !s.p.quests.q2.os);
  // done before its window was read: its on_start still happens at the hand-in
  const d = village(Q, cfg);
  d.p.quests.q0.n = [1];
  d.as(d.p, { type: 'quest', op: 'turnin', id: 'q0' });
  assert.ok(d.p.questsDone.q0 && d.p.flags.after && d.p.quests.t_move);
});

test('quests: an optional objective is counted and shown, but the quest is ready without it', () => {
  assert.deepStrictEqual(Content.parseGoals('kill:rat:2; ?have:bone:2; ?drink'),
    [{ type: 'kill', ref: 'rat', need: 2 }, { type: 'have', ref: 'bone', need: 2, opt: true }, { type: 'drink', ref: '*', need: 1, opt: true }]);
  assert.deepStrictEqual(Content.parseGoals(JSON.stringify([{ type: 'kill', ref: 'rat', need: 1, opt: true }, { type: 'eat', opt: false }])),
    [{ type: 'kill', ref: 'rat', need: 1, opt: true }, { type: 'eat', ref: '*', need: 1 }]);
  const s = village([{ id: 'job', name: 'Job', giver: 'npc_marta', objectives: 'kill:rat:1; ?kill:slime:2; ?have:bone:2', rewards: 'xp:3' }]);
  s.c.monsters.rat.carcass = ''; s.c.monsters.rat.loot = ''; s.c.loot.rat = []; s.c.monsters.slime.carcass = ''; s.c.monsters.slime.loot = ''; s.c.loot.slime = [];
  s.as(s.p, { type: 'quest', op: 'accept', id: 'job' });
  s.kill(s.p, 'slime');
  assert.strictEqual(s.log(s.p), 'job:active:0/1/0', 'the optional one is counted, and is not enough');
  assert.match(texts(s.kill(s.p, 'rat')), /Job: done/);
  assert.strictEqual(s.log(s.p), 'job:ready:1/1/0', 'ready with only what must be done');
  s.kill(s.p, 'slime');
  assert.strictEqual(s.log(s.p), 'job:ready:1/2/0', 'and the optional one still counts afterwards');
  World.give(s.c, s.p, 'bone', 1, []);
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'job' });
  assert.deepStrictEqual([s.log(s.p), World.count(s.p, 'bone'), !!s.p.questsDone.job], ['', 1, true], 'handed in; an optional bring-me not brought in full is left alone');
  const t = village([{ id: 'job', name: 'Job', giver: 'npc_marta', objectives: 'talk:npc_marta; ?have:bone:2' }]);
  t.as(t.p, { type: 'quest', op: 'accept', id: 'job' }); t.as(t.p, { type: 'interact', x: 3, y: 1 });
  World.give(t.c, t.p, 'bone', 3, []);
  t.as(t.p, { type: 'quest', op: 'turnin', id: 'job' });
  assert.strictEqual(World.count(t.p, 'bone'), 1, 'brought in full: taken');
});

test('quests: drinking, eating and taking in hand may ask for anything, or for one item', () => {
  assert.deepStrictEqual(Content.parseGoals('drink; drink:2; drink:water; eat:ration:2; hold:bow; hold'),
    [{ type: 'drink', ref: '*', need: 1 }, { type: 'drink', ref: '*', need: 2 }, { type: 'drink', ref: 'water', need: 1 }, { type: 'eat', ref: 'ration', need: 2 }, { type: 'hold', ref: 'bow', need: 1 }, { type: 'hold', ref: '*', need: 1 }]);
  assert.deepStrictEqual(Content.parseGoals(JSON.stringify([{ type: 'eat' }, { type: 'eat', ref: '*' }, { type: 'eat', ref: 'ration', need: 3 }])).map(g => g.ref + g.need), ['*1', '*1', 'ration3']);
  const s = village([{ id: 'q', name: 'Q', giver: 'npc_marta', objectives: 'drink:water; drink; eat:ration; hold:bow; hold' }]);
  assert.deepStrictEqual(s.c.quests.q.goals.map(g => World.goalText(s.c, g)), ['Drink ' + s.c.items.water.name.toLowerCase(), 'Drink some water', 'Eat ' + s.c.items.ration.name.toLowerCase(), 'Take the ' + s.c.items.bow.name.toLowerCase() + ' in hand', 'Take something in hand']);
  s.as(s.p, { type: 'quest', op: 'accept', id: 'q' });
  s.c.maps.field.terrain[1][1] = 'l_water'; s.p.thirst = 20;
  s.as(s.p, { type: 'interact', x: 1, y: 1, verb: 'drink' });
  assert.strictEqual(s.log(s.p), 'q:active:0/1/0/0/0', 'a stream is a drink, but not a bottle of water');
  World.give(s.c, s.p, 'water', 1, []); s.p.thirst = 20;
  s.as(s.p, { type: 'use', item: 'water' });
  assert.strictEqual(s.log(s.p), 'q:active:1/1/0/0/0');
  World.give(s.c, s.p, 'wood', 1, []); World.give(s.c, s.p, 'bow', 1, []); onBelt(s.p, 0, 'wood'); onBelt(s.p, 1, 'bow');
  s.as(s.p, { type: 'hold', slot: 0 });
  assert.strictEqual(s.log(s.p), 'q:active:1/1/0/0/1', 'anything in hand is something; it is not the bow');
  s.as(s.p, { type: 'hold', slot: 1 });
  assert.strictEqual(s.log(s.p), 'q:active:1/1/0/1/1');
  World.give(s.c, s.p, 'ration', 1, []); s.p.hunger = 10; s.p.cooldowns = {};
  s.as(s.p, { type: 'use', item: 'ration' });
  assert.strictEqual(s.log(s.p), 'q:ready:1/1/1/1/1');
});

test('quests: having an item in the bag is enough, and it is kept when the quest is handed in', () => {
  const s = village([{ id: 'q', name: 'Q', objectives: 'own:wood:2; have:bone:1', rewards: 'xp:1' }]);
  World.run(s.c, s.ws, s.p, 'quest:q', s.t, []);
  const w0 = World.count(s.p, 'wood'), b0 = World.count(s.p, 'bone');
  World.take(s.p, 'wood', w0); World.take(s.p, 'bone', b0);
  World.give(s.c, s.p, 'wood', 1, []); World.give(s.c, s.p, 'bone', 1, []);
  assert.strictEqual(s.log(s.p), 'q:active:1/1');
  World.give(s.c, s.p, 'wood', 2, []);
  assert.strictEqual(s.log(s.p), 'q:ready:2/1', 'what is in the bag right now');
  s.as(s.p, { type: 'face', dir: 'N' });                      // (anything done: the mark is kept from here on)
  World.take(s.p, 'wood', 2);
  assert.strictEqual(s.log(s.p), 'q:ready:2/1', 'used up afterwards: it was had, and stays ticked');
  World.give(s.c, s.p, 'wood', 4, []);
  s.as(s.p, { type: 'quest', op: 'turnin', id: 'q' });
  assert.deepStrictEqual([!!s.p.questsDone.q, World.count(s.p, 'wood'), World.count(s.p, 'bone')], [true, 5, 0], 'the wood is kept; what was to be brought is taken');
});

const rng = (seed) => { let v = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => (v = (v * 16807) % 2147483647) / 2147483647; };
test('growth: a tree lets branches fall nearby up to its cap, and not while it is cut down', () => {
  const s = camp();
  Object.assign(s.c.objects.t_tree.properties, { drops: 'potion:1', drop_s: 20, drop_radius: 2, drop_max: 3 });
  const drops = () => World.structOf(s.ws, 'camp').ents.filter(b => b.ref === '_drop');
  let now = 1000; const run = (secs) => { for (let k = 0; k < secs / 10; k++) { now += 10000; World.advance(s.c, s.ws, 'camp', [s.p], now, rng(now), []); } };
  run(600);
  assert.strictEqual(drops().length, 3, 'never more than drop_max');
  drops().forEach(b => { assert.ok(Math.max(Math.abs(b.x - 1), Math.abs(b.y - 0)) <= 2, 'within its radius'); assert.strictEqual(b.data.pickup, 'potion:1'); assert.ok(!(b.x === 1 && b.y === 0)); });
  const st0 = World.structOf(s.ws, 'camp'); st0.ents.splice(st0.ents.indexOf(drops()[0]), 1);   // one is picked up: another falls in time
  assert.strictEqual(drops().length, 2);
  run(600); assert.strictEqual(drops().length, 3);
  const st = World.structOf(s.ws, 'camp'); st.ents = st.ents.filter(b => b.ref !== '_drop'); st.gone['camp.e2'] = 2;   // felled
  put(s, 'camp', 6, 6, 'N'); run(600);
  assert.strictEqual(drops().length, 0, 'a felled tree drops nothing');
});

test('growth: what a tree drops lands on ground at its own height when there is any', () => {
  const s = camp();
  Object.assign(s.c.objects.t_tree.properties, { drops: 'potion:1', drop_s: 20, drop_radius: 2, drop_max: 6 });
  s.c.maps.camp.elev = Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => (y === 0 ? '1' : '')));   // the tree stands on a ledge along the top row
  let now = 1000; for (let k = 0; k < 120; k++) { now += 10000; World.advance(s.c, s.ws, 'camp', [s.p], now, rng(now), []); }
  const d = World.structOf(s.ws, 'camp').ents.filter(b => b.ref === '_drop');
  assert.ok(d.length >= 3, 'some fell: ' + d.length);
  assert.ok(d.slice(0, 3).every(b => b.y === 0), 'the first ones are on the ledge: ' + d.map(b => b.x + ',' + b.y).join(' '));
});

test('growth: grass grows items on the base and on the overlay, thinly, and catches up after time away', () => {
  const t = JSON.parse(JSON.stringify(tables)), W = 30;
  t.Terrain.push({ id: 't_grass', name: 'Grass', sprite: '', pass_n: true, pass_e: true, pass_s: true, pass_w: true, grows: 'potion:1', grow_s: 30, grow_max: 2 });
  const base = [], over = [];
  for (let y = 0; y < W; y++) { base.push(Array(W).fill(y < 10 ? 't_grass' : 'til_1')); over.push(Array(W).fill(y >= 20 ? 't_grass' : '')); }
  for (let x = 0; x < W; x++) over[0][x] = 'til_1';                        // grass with something else laid over it grows nothing
  t.Maps.push({ id: 'meadow', name: 'Meadow', width: W, height: W, terrain: JSON.stringify(base), overlay: JSON.stringify(over) });
  t.Config.push({ key: 'ground_item_cap', value: '40' });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Tester', 'warrior');
  p.map = 'meadow'; p.x = 15; p.y = 15;
  const drops = () => World.structOf(ws, 'meadow').ents.filter(b => b.ref === '_drop');
  World.advance(c, ws, 'meadow', [p], 1000, rng(1), []);
  assert.strictEqual(drops().length, 0);
  World.advance(c, ws, 'meadow', [p], 1000 + 3600 * 1000, rng(2), []);      // an hour away: caught up in one go
  const d = drops();
  assert.ok(d.length > 8 && d.length <= 40, 'some, never past the cap: ' + d.length);
  assert.ok(d.some(b => b.y >= 1 && b.y < 10) && d.some(b => b.y >= 20), 'on the base grass and on the overlay grass');
  assert.ok(d.every(b => (b.y >= 1 && b.y < 10) || b.y >= 20), 'only where grass is the ground you see');
  d.forEach(a => assert.ok(d.filter(b => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 5).length <= 6, 'thin: ' + a.x + ',' + a.y));
});

test('what a used item leaves goes where the used one was: its belt slot, a stack of it, its cell, else a free cell', () => {
  function setup(inv) {
    const s = fresh();
    s.c.items.water = Object.assign({}, s.c.items.potion, { id: 'water', name: 'Water', heal: 0, mp: 0, hunger: 0, thirst: 30, onUse: '', cooldownMs: 0, leaves: 'bottle', stackMax: 20 });
    s.c.items.bottle = { id: 'bottle', name: 'Bottle', type: 'material', stackMax: 20 };
    s.p.thirst = 0; s.p.inventory = inv.map(a => ({ item: a[0], qty: a[1], s: a[2] }));
    return s;
  }
  const at = (s, id) => s.p.inventory.filter(x => x.item === id).map(x => x.s + ':' + x.qty).join(',');
  // from the belt, the last one: the empty bottle takes its belt slot
  let s = setup([['water', 1, 3]]); onBelt(s.p, 2, 'water'); s.p.held = 2;
  act(s, { type: 'use', item: 'water', from: { w: 'belt', s: 2 } });
  assert.strictEqual(World.beltOf(s.p)[2], 'bottle', 'the belt slot holds the bottle now');
  assert.strictEqual(at(s, 'bottle'), (World.BELT_AT + 2) + ':1', 'there, and not in the bag');
  // from the belt with water left: the slot keeps the water, the bottle goes to the bag
  s = setup([['water', 2, 3]]); onBelt(s.p, 2, 'water');
  act(s, { type: 'use', item: 'water', from: { w: 'belt', s: 2 } });
  assert.strictEqual(World.beltOf(s.p)[2], 'water');
  assert.strictEqual(at(s, 'bottle'), '0:1', 'a free cell (cell 3 still holds water)');
  // from the bag: 1. onto a stack of bottles
  s = setup([['water', 1, 5], ['bottle', 2, 7]]);
  act(s, { type: 'use', item: 'water', from: { w: 'bag', s: 5 } });
  assert.strictEqual(at(s, 'bottle'), '7:3');
  // 2. into the cell the water emptied (the one it was used from, not another stack of water)
  s = setup([['water', 1, 5], ['water', 4, 9]]);
  act(s, { type: 'use', item: 'water', from: { w: 'bag', s: 5 } });
  assert.strictEqual(at(s, 'water'), '9:4', 'taken from the cell it was used from');
  assert.strictEqual(at(s, 'bottle'), '5:1');
  // 3. that cell still holds water: a free cell
  s = setup([['water', 3, 5]]);
  act(s, { type: 'use', item: 'water', from: { w: 'bag', s: 5 } });
  assert.strictEqual(at(s, 'water'), '5:2'); assert.strictEqual(at(s, 'bottle'), '0:1');
});

test('ammo with a recover chance: a shot that ends in a monster stays in it (carcass or loot bag), a miss lies where it stopped', () => {
  function archer(recover) {
    const s = hero('survivor');
    s.c.items.arrow = { id: 'arrow', name: 'Arrow', type: 'ammo', stackMax: 99, penetration: 1, falloff: 0, recover: recover };
    s.c.items.bow = Object.assign({}, s.c.items.pistol, { id: 'bow', name: 'Bow', ammo: 'arrow', ammoCost: 1, clip: 0 });
    s.p.inventory = [{ item: 'bow', qty: 1, s: 0 }, { item: 'arrow', qty: 10, s: 1 }];
    s.p.equipment = { weapon: 'bow' }; onBelt(s.p, 0, 'bow'); s.p.held = 0;
    s.p.x = 9; s.p.y = 13; s.p.facing = 'E';
    return s;
  }
  const bagsAt = (s, x, y) => World.structOf(s.ws, 'map_3').ents.filter(b => b.x === x && b.y === y && Array.isArray(b.inv));
  const dropsAt = (s, x, y) => World.structOf(s.ws, 'map_3').ents.filter(b => b.x === x && b.y === y && b.ref === '_drop');
  // always recovered (100 %): the arrow is in the skeleton, and in the loot bag where it dies (no carcass)
  let s = archer(1), m = monster(s, 'skeleton', 12, 13);
  m.hp = 1;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000);
  assert.ok(m.dead, 'the shot killed it');
  assert.strictEqual(World.count(s.p, 'arrow'), 9, 'one arrow spent');
  assert.deepStrictEqual(bagsAt(s, 12, 13).map(b => b.inv.filter(g => g.item === 'arrow').map(g => g.item + ':' + g.qty).join()), ['arrow:1'], 'a loot bag holds it');
  // it stays in a monster that lives on, and comes out with the next arrow when it dies
  s = archer(1); m = monster(s, 'skeleton', 12, 13); m.hp = 1000;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000); act(s, { type: 'shoot', x: 12, y: 13 }, 5000);
  assert.deepStrictEqual(m.stuck, [{ item: 'arrow', qty: 2 }]);
  // a monster with a carcass keeps them in its body
  s = archer(1); m = monster(s, 'deer', 12, 13); m.hp = 1;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000);
  const body = World.structOf(s.ws, 'map_3').ents.filter(b => b.ref === s.c.monsters.deer.carcass)[0];
  assert.ok(body && body.inv.some(g => g.item === 'arrow' && g.qty === 1), 'in the carcass');
  // a miss: it lies on the ground where the shot ended, and the next one joins it
  s = archer(1);
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000); act(s, { type: 'shoot', x: 12, y: 13 }, 5000);
  const all = World.structOf(s.ws, 'map_3').ents.filter(b => b.ref === '_drop' && /^arrow:/.test(b.data.pickup));
  assert.strictEqual(all.length, 1, 'one pile'); assert.strictEqual(all[0].data.pickup, 'arrow:2');
  // 0 %: never
  s = archer(0); m = monster(s, 'skeleton', 12, 13); m.hp = 1;
  act(s, { type: 'shoot', x: 12, y: 13 }, 1000);
  assert.ok(!bagsAt(s, 12, 13).some(b => b.inv.some(g => g.item === 'arrow'))); assert.strictEqual(m.stuck, undefined);   // (a bag with its loot, no arrow in it)
  assert.strictEqual(dropsAt(s, 12, 13).length + dropsAt(s, 11, 13).length, 0);
});

test('weapons, tools and gear never stack; a weapon wears out with use and breaks, and keeps its wear when moved', () => {
  const s = hero('warrior');
  s.c.items.club = { id: 'club', name: 'Club', type: 'weapon', slot: 'weapon', stackMax: 99, atk: 1, durability: 3, can: { equip: true } };
  assert.strictEqual(World.stackMaxOf(s.c, 'club'), 1, 'a weapon never stacks, whatever its stack_max');
  assert.strictEqual(World.stackMaxOf(s.c, 'potion'), s.c.items.potion.stackMax || 99, 'a potion still does');
  s.p.inventory = [{ item: 'club', qty: 1, s: World.BELT_AT }, { item: 'club', qty: 1, s: 7 }];
  s.p.held = 0; s.p.equipment = { weapon: 'club' };
  const m = monster(s, 'skeleton', s.p.x + 1, s.p.y); m.hp = 1000;
  const inUse = () => World.beltStack(s.p, 0);
  assert.deepStrictEqual(World.durOf(s.c, inUse()), { left: 3, max: 3 }, 'a new one is whole');
  act(s, { type: 'attack', x: m.x, y: m.y }, 1000);
  assert.strictEqual(inUse().dur, 2, 'one blow, one use (the one in hand)');
  assert.strictEqual(s.p.inventory.find(x => x.s === 7).dur, undefined, 'not the one in the bag');
  // moved off the belt into the bag, sorted, it keeps its wear
  act(s, { type: 'inv', from: { w: 'belt', s: 0 }, to: { w: 'bag', s: 0 } }, 1100);
  assert.deepStrictEqual(World.beltOf(s.p)[0], '');
  act(s, { type: 'inv', op: 'sort' }, 1200);
  assert.deepStrictEqual(s.p.inventory.map(x => x.dur).sort(), [2, undefined], 'still worn after a move and a sort');
  // back on the belt and used up: it breaks, the other one is still there
  const worn = s.p.inventory.filter(x => x.dur === 2)[0];
  act(s, { type: 'inv', from: { w: 'bag', s: worn.s }, to: { w: 'belt', s: 0 } }, 1300);
  assert.strictEqual(inUse(), worn); assert.strictEqual(s.p.equipment.weapon, 'club');
  let t = 5000, ev = [];
  for (let i = 0; i < 2; i++, t += 5000) ev = ev.concat(act(s, { type: 'attack', x: m.x, y: m.y }, t));
  assert.match(texts(ev), /Your club is broken\./);
  assert.strictEqual(World.count(s.p, 'club'), 2, 'a broken one is not destroyed');
  const broken = s.p.inventory.filter(x => x.dur === 0)[0];
  assert.ok(broken && World.isBroken(s.c, broken));
  assert.strictEqual(World.beltOf(s.p)[0], 'club', 'still on the belt');
  assert.strictEqual(World.heldItem(s.c, s.p), null, 'broken in hand: nothing in hand (the whole one in the bag is not swung)');
  // with only the broken one left, nothing is in hand
  s.p.inventory = s.p.inventory.filter(x => x === broken); World.holdSlot(s.c, s.p, 0);
  assert.strictEqual(World.heldItem(s.c, s.p), null); assert.strictEqual(s.p.equipment.weapon, undefined, 'a broken weapon is not a weapon');
  // repair: half its recipe (rounded up) by default, or its own repair_cost; then it is whole and in hand again
  s.c.recipes = { r_club: { id: 'r_club', name: 'Club', inputs: 'potion:3', outputs: 'club:1', station: '' } };
  World.give(s.c, s.p, 'potion', 5, [], true);
  assert.deepStrictEqual(World.repairInfo(s.c, s.c.maps.map_3, s.p, { stateOf: () => '' }, broken).cost.map(g => g.item + ':' + g.qty), ['potion:2']);
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: broken.s }, 30000)), /You repair the club/);
  assert.strictEqual(broken.dur, undefined); assert.strictEqual(World.count(s.p, 'potion'), 3);
  assert.strictEqual(s.p.equipment.weapon, 'club', 'in hand again');
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: broken.s }, 31000)), /It is not worn/);
  // a recipe that needs a station: only next to it
  s.c.recipes.r_club.station = 'anvil'; broken.dur = 1;
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: broken.s }, 32000)), /nearby/);
  // salvage: half its recipe (rounded down), or its own salvage list; the item is gone
  s.c.items.club.salvage = '';
  act(s, { type: 'inv', op: 'salvage', s: broken.s }, 33000);
  assert.strictEqual(World.count(s.p, 'club'), 0); assert.strictEqual(World.count(s.p, 'potion'), 4, 'one potion back (3 / 2, down)');
  s.c.items.club.salvage = 'potion:2'; World.give(s.c, s.p, 'club', 1, [], true);
  act(s, { type: 'inv', op: 'salvage', s: s.p.inventory.filter(x => x.item === 'club')[0].s }, 34000);
  assert.strictEqual(World.count(s.p, 'potion'), 6, 'its own salvage list');
  // no recipe makes it: its own repair_cost (a repair kit) mends it, anywhere or at its repair_station; with neither, it cannot be
  s.c.recipes = {}; s.c.items.club.salvage = '';
  World.give(s.c, s.p, 'club', 1, [], true);
  const gun = s.p.inventory.filter(x => x.item === 'club')[0]; gun.dur = 1;
  s.c.items.club.repairCost = '';
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: gun.s }, 40000)), /Nothing you know can mend it/);
  s.c.items.club.repairCost = 'potion:4';
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: gun.s }, 41000)), /You repair the club/);
  assert.strictEqual(World.count(s.p, 'potion'), 2, 'the kit is used up');
  gun.dur = 1; s.c.items.club.repairStation = 'anvil';
  assert.match(texts(act(s, { type: 'inv', op: 'repair', s: gun.s }, 42000)), /nearby/, 'its own repair_station');
});

test('wear depends on what is hit: the item\'s material_wear (wood 1, stone 2, metal 3; a creature is flesh; not listed = 1)', () => {
  const s = camp();
  s.c.objects.t_tree.properties.hp = 1000;
  World.give(s.c, s.p, 'axe', 1, []);
  onBelt(s.p, 0, 'axe'); World.holdSlot(s.c, s.p, 0);
  const axe = s.c.items.axe; axe.durability = 50; axe.wearVs = { stone: 2, metal: 3 };
  const left = () => World.durOf(s.c, World.stackInUse(s.p, 'axe')).left;
  act(s, { type: 'attack', x: 1, y: 0 }, 1000);
  assert.strictEqual(left(), 49, 'the pine is wood: not listed, 1');
  s.c.objects.t_tree.properties.material = 'stone'; s.c.objects.t_tree.material = 'stone';
  act(s, { type: 'attack', x: 1, y: 0 }, 5000);
  assert.strictEqual(left(), 47, 'stone: 2');
  axe.wearVs = { wood: 0, stone: 2 }; s.c.objects.t_tree.properties.material = 'wood'; s.c.objects.t_tree.material = 'wood';
  act(s, { type: 'attack', x: 1, y: 0 }, 9000);
  assert.strictEqual(left(), 47, 'wood: 0 = no wear');
  assert.deepStrictEqual(Content.build(Object.assign({}, tables, { Items: tables.Items.map(i => i.id === 'axe' ? Object.assign({}, i, { material_wear: 'stone:2, metal:3' }) : i) })).items.axe.wearVs, { stone: 2, metal: 3 });
});

// ------------------------------------------------------------ dialogue
test('dialogue: opens on the first start line that fits, moves by answers, runs their actions, and remembers', () => {
  const nodes = [
    { id: 'hello', start: true, if: '!talked', text: 'A new face.', answers: [
      { id: 'who', text: 'Who are you?', to: 'me' },
      { id: 'gift', text: 'Got anything for me?', do: 'give:wood:2; flag:gifted', once: true, to: 'here' },
      { id: 'key', text: 'About this key…', if: 'has:iron_key', to: 'me' },
      { id: 'bye', text: 'Bye.' }] },
    { id: 'again', start: true, text: 'You again.', answers: [{ id: 'told', text: 'You told me your name.', if: 'said:me' }, { id: 'bye', text: 'Bye.' }] },
    { id: 'me', text: 'I am Marta.', answers: [{ id: 'back', text: 'I see.', to: 'hello' }] },
    { id: 'here', text: 'Here.', answers: [{ id: 'back', text: 'Thanks.', to: 'hello' }] }
  ];
  const s = village([RATS], tb => {
    tb.Dialogues = [{ id: 'marta', name: 'Marta', nodes: JSON.stringify(nodes) }];
    tb.Objects.find(o => o.id === 'npc_marta').properties = JSON.stringify({ text: 'Mind the rats.', dialogue: 'marta' });
  });
  const npc = ev => ev.find(e => e.type === 'npc'), ids = e => e.dlg.answers.map(a => a.a).join(' ');
  const n = id => s.p.inventory.filter(i => i.item === id).reduce((t, i) => t + i.qty, 0), had = n('wood');
  let e = npc(s.as(s.p, { type: 'interact', x: 3, y: 1 }));
  assert.deepStrictEqual([e.text, e.dlg.node, e.dlg.hub, ids(e)], ['A new face.', 'hello', 1, 'who gift bye'], 'a first meeting; the key answer waits for the key');
  e = npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'who' }));
  assert.deepStrictEqual([e.text, ids(e)], ['I am Marta.', 'back']);
  assert.strictEqual(npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'gift' })).dlg.node, 'me', 'an answer of another line is not taken: the line again');
  assert.strictEqual(n('wood'), had);
  e = npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'back' }));
  e = npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'gift' }));
  assert.strictEqual(e.text, 'Here.'); assert.strictEqual(n('wood'), had + 2); assert.ok(s.p.flags.gifted);
  e = npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'back' }));
  assert.strictEqual(ids(e), 'who bye', 'asked once only');
  e = npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'bye' }));
  assert.strictEqual(e.end, 1); assert.strictEqual(s.p.talkAt, undefined);
  assert.strictEqual(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'gift' }).length, 0, 'nothing to answer once it has ended');
  e = npc(s.as(s.p, { type: 'interact', x: 3, y: 1 }));
  assert.deepStrictEqual([e.text, ids(e)], ['You again.', 'told bye'], 'she remembers the meeting, and what she said');
  // across the field: the talk ends, nothing runs
  s.p.x = 8; s.p.y = 8;
  assert.strictEqual(npc(s.as(s.p, { type: 'talk', key: 'field.e1', a: 'told' })).end, 1);
  // another player meets her for the first time; an NPC with no dialogue says its one line, as before
  assert.strictEqual(npc(s.as(s.q, { type: 'interact', x: 3, y: 1 })).dlg.node, 'hello');
  s.r.x = 9; s.r.y = 8;
  const tom = npc(s.as(s.r, { type: 'interact', x: 9, y: 9 }));
  assert.strictEqual(tom.dlg, undefined); assert.strictEqual(tom.name, 'Tom');
  // a dialogue that is named but missing, or has no line to open on: the plain line
  s.c.objects.npc_marta.properties.dialogue = 'nobody';
  s.p.x = 2; s.p.y = 1;
  assert.strictEqual(npc(s.as(s.p, { type: 'interact', x: 3, y: 1 })).text, 'Mind the rats.');
});

// ------------------------------------------------------------ shops
test('shops: offers trade items and gold both ways, stock is per character and comes back, a dialogue answer opens it', () => {
  const offers = [
    { id: 'wood', gives: 'wood:2', costs: 'gold:5', stock: 3, restock_h: 1 },
    { id: 'swap', gives: 'gold:4', costs: 'wood:1', sell: true },
    { id: 'secret', gives: 'wood:10', costs: 'gold:1', if: 'flag:friend' }
  ];
  const s = village([RATS], tb => {
    tb.Shops = [{ id: 'store', name: 'Marta\'s store', offers: JSON.stringify(offers) }];
    tb.Dialogues = [{ id: 'marta', nodes: JSON.stringify([{ id: 'hello', start: true, text: 'Yes?', answers: [{ id: 'buy', text: 'Show me.', shop: true }] }]) }];
    tb.Objects.find(o => o.id === 'npc_marta').properties = JSON.stringify({ dialogue: 'marta', shop: 'store' });
    tb.Objects.find(o => o.id === 'npc_tom').properties = JSON.stringify({ shop: 'store' });
  });
  const shop = ev => ev.find(e => e.type === 'shop'), n = (who, id) => World.count(who, id);
  const K = 'field.e1', wood0 = n(s.p, 'wood');
  s.p.gold = 20;
  s.as(s.p, { type: 'interact', x: 3, y: 1 });
  let v = shop(s.as(s.p, { type: 'talk', key: K, a: 'buy' }));
  assert.deepStrictEqual([v.name, v.offers.map(o => o.id + ':' + (o.left === undefined ? '∞' : o.left)).join(' ')], ['Marta\'s store', 'wood:3 swap:∞'], 'the answer opens it; the locked offer is not shown');
  assert.strictEqual(s.p.talkAt, undefined);
  v = shop(s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'wood', qty: 2 }));
  assert.deepStrictEqual([s.p.gold, n(s.p, 'wood') - wood0, v.offers[0].left], [10, 4, 1]);
  assert.ok(v.offers[0].back > 3000 && v.offers[0].back <= 3600, 'and says when it is back');
  assert.match(texts(s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'wood', qty: 2 })), /only 1 left/);
  s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'wood', qty: 1 });
  assert.match(texts(s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'wood' })), /none left/);
  assert.match(texts(s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'secret' })), /^$/, 'a locked offer is not traded');
  assert.strictEqual(s.p.gold, 5);
  // selling: the same thing the other way
  s.as(s.p, { type: 'shop', op: 'trade', key: K, offer: 'swap', qty: 3 });
  assert.deepStrictEqual([s.p.gold, n(s.p, 'wood') - wood0], [17, 3]);
  // another character has their own stock; with nothing to pay with, nothing changes hands
  s.q.gold = 3;
  v = shop(s.as(s.q, { type: 'shop', op: 'open', key: K }));
  assert.strictEqual(v.offers[0].left, 3);
  assert.match(texts(s.as(s.q, { type: 'shop', op: 'trade', key: K, offer: 'wood' })), /don't have enough/);
  assert.strictEqual(s.q.gold, 3);
  assert.match(texts(s.as(s.r, { type: 'shop', op: 'open', key: K })), /need to be with Marta/);
  // an hour on, it is whole again; unlocked offers show
  s.t += 3600 * 1000; s.p.flags.friend = true;
  v = shop(s.as(s.p, { type: 'shop', op: 'open', key: K }));
  assert.deepStrictEqual(v.offers.map(o => o.id + ':' + o.left).join(' '), 'wood:3 swap:undefined secret:undefined');
  // an NPC with a shop and no dialogue: its window is told there is one
  s.r.x = 9; s.r.y = 8;
  assert.strictEqual(s.as(s.r, { type: 'interact', x: 9, y: 9 }).find(e => e.type === 'npc').shop, 1);
});

// ------------------------------------------------------------ scenes (cinematics)
test('scenes: scene:<id> plays once per character, holds the rest of its list until it ends, and keeps the watcher safe', () => {
  const steps = JSON.stringify([{ type: 'say', text: 'The gate creaks.' }, { type: 'camera', x: 5, y: 5, with: true }, { type: 'nonsense' }]);
  const s = village([RATS], tb => {
    tb.Scenes = [{ id: 'gate', name: 'The gate', steps }, { id: 'a', steps }, { id: 'b', steps }, { id: 'empty', steps: '[]' }];
    tb.Dialogues = [{ id: 'marta', nodes: JSON.stringify([{ id: 'hello', start: true, text: 'Yes?', answers: [{ id: 'open', text: 'Open the gate.', do: 'scene:gate; flag:gate_open; gold:3', to: 'hello' }] }]) }];
    tb.Objects.find(o => o.id === 'npc_marta').properties = JSON.stringify({ dialogue: 'marta' });
  });
  assert.deepStrictEqual(s.c.scenes.gate.steps.map(x => x.type + (x.with ? '+' : '')), ['say', 'camera+'], 'unknown steps are left out');
  assert.deepStrictEqual([s.c.scenes.gate.steps[0].s, s.c.scenes.gate.steps[1].zoom], [0, 1], 'missing fields take their defaults');
  s.c.config.sight_cone = 360;
  const rat = s.put('rat', 1, 1); rat.engaged = 'p1';
  const gold0 = s.p.gold;
  s.as(s.p, { type: 'interact', x: 3, y: 1 });
  const ev = s.as(s.p, { type: 'talk', key: 'field.e1', a: 'open' });
  assert.ok(ev.some(e => e.type === 'npc' && e.end), 'the talk ends when the answer plays a scene');
  assert.strictEqual(World.publicPlayer(s.c, s.p).scene, 'gate');
  assert.deepStrictEqual([!!s.p.flags.gate_open, s.p.gold - gold0], [false, 0], 'what follows waits for the scene');
  assert.strictEqual(rat.engaged, null, 'whatever was after them gives up');
  // safe: the rat beside them does nothing, nothing else is done for them meanwhile, others see the mark
  rat.engaged = 'p1';
  const hp0 = s.p.hp;
  for (let i = 0; i < 30; i++) s.turn();
  assert.strictEqual(s.p.hp, hp0, 'nothing hurts them');
  s.as(s.p, { type: 'move', dirs: ['E'] });
  assert.deepStrictEqual([s.p.x, s.p.y], [2, 1], 'a step while watching is dropped');
  const seenNow = Object.assign({}, s.p, { sceneQ: [{ id: 'gate', at: Date.now() }] });   // (a view reads the real clock)
  assert.strictEqual(World.view(s.c, s.ws, 'field', s.q, [seenNow, s.q]).players.find(x => x.id === 'p1').wt, 1);
  // an old message about another scene changes nothing; the end runs what was held
  s.as(s.p, { type: 'scene', op: 'end', id: 'a' });
  assert.strictEqual(World.publicPlayer(s.c, s.p).scene, 'gate');
  s.as(s.p, { type: 'scene', op: 'end', id: 'gate' });
  assert.deepStrictEqual([!!s.p.flags.gate_open, s.p.gold - gold0, World.publicPlayer(s.c, s.p).scene, !!s.p.scenes.gate], [true, 3, undefined, true]);
  // once: seen, it is passed over and the list goes on at once; an empty or missing scene too
  World.run(s.c, s.ws, s.p, 'scene:gate; flag:again; scene:empty; scene:nope; flag:on', s.t, []);
  assert.deepStrictEqual([!!s.p.flags.again, !!s.p.flags.on, s.p.sceneQ], [true, true, undefined]);
  // two in one list play one after the other, each with what follows it
  World.run(s.c, s.ws, s.p, 'scene:a; flag:x; scene:b; flag:y', s.t, []);
  assert.deepStrictEqual([World.publicPlayer(s.c, s.p).scene, !!s.p.flags.x], ['a', false]);
  s.as(s.p, { type: 'scene', op: 'end', id: 'a' });
  assert.deepStrictEqual([World.publicPlayer(s.c, s.p).scene, !!s.p.flags.x, !!s.p.flags.y], ['b', true, false]);
  // past scene_max_s it is over: the next action ends it (what it held happens) and is done
  s.t += 121 * 1000;
  assert.strictEqual(World.watching(s.c, s.p, s.t), false);
  s.as(s.p, { type: 'move', dirs: ['N'] });
  assert.deepStrictEqual([!!s.p.flags.y, s.p.sceneQ, s.p.y], [true, undefined, 0]);
  // and once nothing protects them, the rat bites
  rat.x = 1; rat.y = 0; rat.engaged = 'p1'; rat.last = s.t;
  for (let i = 0; i < 30; i++) s.turn();
  assert.ok(s.p.hp < hp0, 'unprotected again');
});

test('scenes: an actor ticked "stays" is made real when the scene ends: a monster where it was left, the player where they were walked to', () => {
  const steps = JSON.stringify([
    { type: 'show', a: 'mon:rat', x: 7, y: 4, stay: true }, { type: 'walk', a: 'mon:rat', x: 5, y: 4 },   // stays where it walked to
    { type: 'show', a: 'mon:slime', x: 8, y: 8, stay: true }, { type: 'leave', a: 'mon:slime' },            // left: it does not stay
    { type: 'show', a: 'mon:rat', x: 5, y: 4 },                                                          // (shown again: still the one that stays)
    { type: 'walk', a: 'me', x: 3, y: 4, stay: true }, { type: 'walk', a: 'npc:npc_marta', x: 1, y: 1, stay: true }]);
  const s = village([RATS], tb => { tb.Scenes = [{ id: 'fight', steps }, { id: 'none', steps: JSON.stringify([{ type: 'show', a: 'mon:rat', x: 9, y: 2 }]) }]; });
  s.c.config.sight_cone = 360;
  const count = () => s.ws.maps.field.monsters.filter(m => !m.dead).length, n0 = count();
  World.run(s.c, s.ws, s.p, 'scene:fight; flag:after', s.t, []);
  assert.deepStrictEqual([count(), s.p.x, s.p.y], [n0, 2, 1], 'nothing is real while the scene plays');
  s.as(s.p, { type: 'scene', op: 'end', id: 'fight' });              // (ended at once: skipped or watched, the same)
  const rat = s.ws.maps.field.monsters[s.ws.maps.field.monsters.length - 1];
  assert.deepStrictEqual([count(), rat.ref, rat.x, rat.y, rat.free, rat.spawn], [n0 + 1, 'rat', 5, 4, true, ''], 'the rat is real, where the scene left it, and nobody\'s');
  assert.deepStrictEqual([s.p.x, s.p.y, !!s.p.flags.after], [3, 4, true], 'the player really stands where they were walked to');
  assert.deepStrictEqual(s.ws.maps.field.entities, undefined, 'no NPC was moved');
  // it stands still for a moment, then acts like its kind
  const hp0 = s.p.hp; s.p.x = 4; s.p.y = 4;
  for (let i = 0; i < 15; i++) s.turn();                              // 1.5 s
  assert.deepStrictEqual([rat.x, rat.y, s.p.hp], [5, 4, hp0], 'a pause first');
  for (let i = 0; i < 40; i++) s.turn();
  assert.ok(s.p.hp < hp0 && !rat.wait, 'then it fights');
  // the kill counts, and it never comes back
  World.act(s.c, s.ws, s.p, { type: 'quest', op: 'accept', id: 'rats' }, s.t, mid, [s.p]); s.p.x = 2; s.p.y = 1;
  World.questLog(s.c, s.p, s.t);
  World.hitMonster(s.c, s.ws, 'field', s.p, rat, 9999, s.t += 100, mid, []);
  for (let i = 0; i < 5; i++) s.turn();
  assert.ok(!s.ws.maps.field.monsters.includes(rat) || rat.gone || rat.dead, 'killed: gone for good');
  // a scene with nobody ticked leaves nothing
  const n1 = count();
  World.run(s.c, s.ws, s.p, 'scene:none', s.t, []); s.as(s.p, { type: 'scene', op: 'end', id: 'none' });
  assert.strictEqual(count(), n1);
});

test('scenes: several of the same monster (numbered copies, and packs) each stay as a monster of their own', () => {
  const steps = JSON.stringify([
    { type: 'show', a: 'mon:rat', x: 6, y: 6, count: 3, stay: true },        // a pack of three
    { type: 'show', a: 'mon:rat#2', x: 9, y: 3, stay: true },                // another rat, on its own
    { type: 'show', a: 'mon:rat#3', x: 1, y: 9 },                            // a third kind of copy that does not stay
    { type: 'walk', a: 'mon:rat', x: 8, y: 8 }]);
  const s = village([RATS], tb => { tb.Scenes = [{ id: 'pack', steps }]; });
  const live = () => s.ws.maps.field.monsters.filter(m => !m.dead), n0 = live().length;
  World.run(s.c, s.ws, s.p, 'scene:pack', s.t, []);
  s.as(s.p, { type: 'scene', op: 'end', id: 'pack' });
  const made = live().slice(n0);
  assert.strictEqual(made.length, 4, 'three of the pack and the second rat');
  assert.ok(made.every(m => m.ref === 'rat' && m.free), 'all rats, nobody\'s');
  assert.strictEqual(new Set(made.map(m => m.x + ',' + m.y)).size, 4, 'each on a tile of its own');
  assert.strictEqual(new Set(made.map(m => m.id)).size, 4, 'each with an id of its own');
  const pack = made.filter(m => Math.abs(m.x - 8) + Math.abs(m.y - 8) <= 3), lone = made.filter(m => m.x === 9 && m.y === 3);
  assert.deepStrictEqual([pack.length, lone.length], [3, 1], 'the pack round where it walked to, the other where it was shown');
  assert.ok(pack.some(m => m.x === 8 && m.y === 8), 'one of the pack on the very tile');
});

// ---------------------------------------------------------------- stealth, stage 2: loud events, and walls that muffle
test('stealth: sound - every wall between takes Config sound_muffle tiles off how far it carries', () => {
  const s = arena(), map = liveOf(s); s.c.config.sound_muffle = 2;
  const C = (lx, ly, r) => World.soundCarries(s.c, map, 3, 5, lx, ly, r, stOf(s));      // a sound south of the arena's wall
  assert.strictEqual(C(3, 4, 2), true, 'the same side: nothing in the way');
  assert.strictEqual(C(3, 1, 6), true, 'across the wall, 4 tiles off: 6 - 2 still reaches');
  assert.strictEqual(C(3, 1, 5), false, '5 - 2 does not');
  assert.strictEqual(C(3, 6, 0), false, 'no sound at all');
  // footsteps are a sound like any other
  const def = { aggro: 1, hearing: 1 }, walker = { x: 3, y: 5, stepAt: 9500 };
  const N = (mx, my) => World.notices(s.c, map, { x: mx, y: my }, def, walker, 10000, 1, stOf(s));
  assert.strictEqual(N(3, 1), 'heard', 'walking (6 tiles), 4 off behind the wall');
  assert.strictEqual(N(3, 0), '', '5 off behind it: muffled');
  s.c.config.sound_muffle = 0;
  assert.deepStrictEqual([C(3, 1, 5), N(3, 0)], [true, 'heard'], 'Config sound_muffle 0: walls muffle nothing');
});

test('stealth: sound - a fight, a blow on a wall and a door are heard; whoever made it does not hear itself', () => {
  const s = arena(); s.c.config.sound_muffle = 0;
  const ms = World.mapState(s.ws, 'arena');
  const mk = (id, x, y) => ({ id, ref: 'rat', x, y, hp: 999, dead: false, last: 1e12, respawnAt: 0, facing: 'N', spawn: '' });
  const hit = mk('a', 2, 2), near = mk('b', 5, 2), far = mk('c', 6, 0);
  ms.monsters = [hit, near, far]; ms.spawnSig = '';
  s.c.config.noise_melee = 3;                                         // (so the far one is out of earshot)
  put(s, 'arena', 2, 3, 'N'); World.mapState(s.ws, 'arena').states['arena.e1'] = 'open';
  s.p.x = 2; s.p.y = 1; s.p.facing = 'S';
  act(s, { type: 'attack', x: 2, y: 2 }, 5000);
  assert.ok(hit.engaged, 'the one struck knows who did it');
  assert.ok(near.hear && near.hear.x === 2 && near.hear.y === 2 && !near.hear.loud, 'the one nearby hears the fight (a quiet noise)');
  assert.strictEqual(far.hear, undefined, 'out of earshot: nothing');
  // a blow on something is loud, and heard from where it was struck
  delete near.hear;
  const res = World.damageStructure(s.c, s.ws, 'arena', { t: 'ent', key: 'arena.e2' }, 3, { kind: 'melee', by: 'p1', player: s.p, now: 6000 }, []);
  assert.ok(res && res.dealt > 0);
  assert.deepStrictEqual([near.hear && near.hear.x, near.hear && near.hear.y, near.hear && near.hear.loud], [5, 1, 1], 'heard, and loud');
  assert.ok(far.hear && far.hear.loud, 'and from further off (Config noise_break, 10)');
  // a monster breaking something does not go looking for its own blows
  delete near.hear; delete far.hear;
  World.damageStructure(s.c, s.ws, 'arena', { t: 'ent', key: 'arena.e2' }, 3, { kind: 'monster', by: 'b', monster: near, now: 7000 }, []);
  assert.deepStrictEqual([near.hear, !!far.hear], [undefined, true]);
  // a noise of your own making, straight from the rules
  delete far.hear;
  World.soundAt(s.c, s.ws, 'arena', 6, 1, 14, 8000, s.p);
  assert.ok(far.hear && far.hear.loud && far.hear.id === 'p1', 'a shot (14 tiles): loud, and it remembers whose');
});

test('stealth: sound - a LOUD noise brings a walker through a shut door; a quiet one only sends it to look', () => {
  const damaged = s => Object.keys(World.structOf(s.ws, 'arena').dmg || {}).length + (World.structOf(s.ws, 'arena').gone ? Object.keys(World.structOf(s.ws, 'arena').gone).length : 0);
  const run = radius => {
    const s = arena(); s.c.config.sound_muffle = 0;
    put(s, 'arena', 6, 6, 'N');                                       // you, far off in a corner south of the wall, standing still
    const w = withWalker(s, 'arena', 3, 1, { sight: 1 });             // north of it, nearly blind: only the noise can bring it
    World.soundAt(s.c, s.ws, 'arena', 3, 5, radius, s.at, null);
    const loud = !!(w.hear && w.hear.loud);
    turns(s, 30);
    return { loud, broke: damaged(s) > 0 || w.y >= 3, w };
  };
  const quiet = run(6), loud = run(14);
  assert.deepStrictEqual([quiet.loud, quiet.broke], [false, false], 'a quiet noise: it looks about on its own side');
  assert.deepStrictEqual([loud.loud, loud.broke], [true, true], 'a loud one: it breaks its way to where the noise was');
});

test('emotes: a player emote is sent to everyone around for a while; unknown ones are refused; scenes take an emote step', () => {
  const s = village([RATS], tb => { tb.Scenes = [{ id: 'nap', steps: JSON.stringify([{ type: 'emote', emote: 'sleep', over: 'npc', npc: 'npc_marta', s: 0 }]) }]; });
  assert.deepStrictEqual(s.c.scenes.nap.steps[0], { type: 'emote', 'with': false, emote: 'sleep', over: 'npc', npc: 'npc_marta', a: '', x: 0, y: 0, s: 0 });
  // actors (stage 2): the step kinds and their defaults
  const acts = Content.build(Object.assign({}, s.tables || {}, { Scenes: [{ id: 'act', steps: JSON.stringify([{ type: 'show', a: 'mon:rat', x: 3, y: 2 }, { type: 'walk', a: 'mon:rat', x: 6, y: 2 }, { type: 'face', a: 'me' }, { type: 'leave', a: 'mon:rat' }, { type: 'say', a: 'npc:npc_marta', text: 'Shoo!' }]) }] })).scenes.act.steps;
  assert.deepStrictEqual(acts.map(x => x.type), ['show', 'walk', 'face', 'leave', 'say']);
  assert.deepStrictEqual([acts[0].dir, acts[1].speed, acts[1].straight, acts[1].wait, acts[2].dir, acts[4].a], ['E', 1, false, true, 'player', 'npc:npc_marta']);
  const now = Date.now();                                        // (a view reads the real clock)
  World.act(s.c, s.ws, s.p, { type: 'emote', id: 'nope' }, now);
  assert.strictEqual(s.p.em, undefined, 'not an emote: nothing');
  World.act(s.c, s.ws, s.p, { type: 'emote', id: 'heart' }, now);
  assert.strictEqual(World.publicPlayer(s.c, s.p).em, 'heart@' + now);
  assert.strictEqual(World.view(s.c, s.ws, 'field', s.q, [s.p, s.q]).players.find(x => x.id === 'p1').em, 'heart@' + now, 'the others see it');
  s.p.emAt = now - 11000;
  assert.strictEqual(World.publicPlayer(s.c, s.p).em, undefined, 'and after a while it is no longer sent');
  World.act(s.c, s.ws, s.p, { type: 'emote', id: 'none' }, now);
  assert.strictEqual(s.p.em, undefined, 'none takes it down');
});

test('picking: a berry bush gives its list each time it is used, stands empty after the last pick and is full again later', () => {
  const s = camp();
  s.c.objects.t_tree.properties = { pick: 'potion:2', pick_times: 3, pick_s: 60 };       // no health: it cannot be hit
  s.p.inventory = [];
  const live = () => World.liveMap(s.c, s.ws, 'camp');
  const lk = () => World.viewLookup(s.c, live(), World.view(s.c, s.ws, 'camp', s.p, [s.p]), s.p);
  const acts = () => World.actionsAt(s.c, live(), lk(), s.p, 1, 0).map(a => a.label);
  const state = () => World.view(s.c, s.ws, 'camp', s.p, [s.p]).states['camp.e2'];
  let now = 1000; const pick = () => { now += 2000; return texts(act(s, { type: 'interact', x: 1, y: 0 }, now)); };
  assert.deepStrictEqual(acts(), ['Pick the pine']);
  assert.ok(World.pickAt(s.c, live(), lk(), s.p, 1, 0), 'holding the button works');
  pick(); pick();
  assert.strictEqual(World.count(s.p, 'potion'), 4);
  assert.strictEqual(state(), undefined, 'still something on it');
  // asked again at once (a held button): nothing, and no words
  assert.strictEqual(texts(act(s, { type: 'interact', x: 1, y: 0 }, now + 10)), '');
  assert.strictEqual(World.count(s.p, 'potion'), 4);
  pick();
  assert.strictEqual(World.count(s.p, 'potion'), 6);
  assert.strictEqual(state(), 'empty');
  assert.deepStrictEqual(acts(), [], 'nothing to do with an empty one');
  assert.strictEqual(World.pickAt(s.c, live(), lk(), s.p, 1, 0), null);
  assert.match(pick(), /nothing left on the pine/);
  assert.strictEqual(World.count(s.p, 'potion'), 6);
  assert.ok(World.structInfo(s.c, live(), { t: 'ent', key: 'camp.e2' }), 'it never goes away');
  // a minute after it was emptied it is full again, for three more
  World.advance(s.c, s.ws, 'camp', [s.p], now + 30 * 1000, mid, []);
  assert.strictEqual(state(), 'empty');
  now += 61 * 1000; World.advance(s.c, s.ws, 'camp', [s.p], now, mid, []);
  assert.strictEqual(state(), undefined);
  pick(); pick(); pick();
  assert.strictEqual(World.count(s.p, 'potion'), 12);
  assert.strictEqual(state(), 'empty');
  // from two tiles away it cannot be picked
  now += 61 * 1000; World.advance(s.c, s.ws, 'camp', [s.p], now, mid, []);
  put(s, 'camp', 1, 2, 'N');
  assert.strictEqual(World.pickAt(s.c, live(), lk(), s.p, 1, 0), null);
  assert.match(pick(), /Too far/);
});

test('placing: an item that is put down becomes its object where the player points, and picking that up gives it back', () => {
  const t = JSON.parse(JSON.stringify(tables));
  const row = Array(7).fill('til_1');
  t.ItemTypes = [{ id: 'placeable', name: 'Placeable', place: true }, { id: 'consumable', name: 'Consumable', consume: true }];
  t.Items.push({ id: 'bedroll', name: 'Bedroll', type: 'placeable', places: 't_bed', stack_max: 1 });
  t.Items.push({ id: 'nothing', name: 'Odd thing', type: 'placeable', places: '' });
  t.Objects.push({ id: 't_bed', name: 'Bedroll', kind: 'rest', walkable: false, sprite_states: 'side=bed_side.png', properties: '{"width":1,"height":2,"sets_respawn":true}' });
  t.Objects.push({ id: 't_rock', name: 'Rock', kind: 'deco', walkable: false });
  t.Maps.push({ id: 'camp', name: 'Camp', width: 7, height: 7, terrain: JSON.stringify(Array(7).fill(row)) });
  t.MapEntities.push({ map: 'camp', key: 'camp.e1', x: 4, y: 3, ref: 't_rock', data: '' });
  const c = Content.build(t), ws = { maps: {} }, p = World.newPlayer(c, 'p1', 'Tester', 'warrior'), q = World.newPlayer(c, 'p2', 'Other', 'warrior');
  c.config.build_if = 'flag:never';                             // building is locked: putting a bedroll down is not building
  const s = { c, ws, p };
  put(s, 'camp', 2, 3, 'E'); q.map = 'camp'; q.x = 6; q.y = 6;
  p.inventory = []; World.give(c, p, 'bedroll', 1, []); World.give(c, p, 'nothing', 1, []);
  const live = () => World.liveMap(c, ws, 'camp');
  const lk = () => World.viewLookup(c, live(), World.view(c, ws, 'camp', p, [p, q]), p);
  const as = (who, a, now) => texts(World.act(c, ws, who, a, now || 1000, mid, [p, q]));
  assert.strictEqual(World.itemCan(c.items.bedroll, 'place'), true);
  assert.strictEqual(World.itemCan(c.items.nothing, 'place'), false, 'it names no object');
  assert.strictEqual(World.placeBp(c, 'nothing'), null);
  // the ghost: standing it takes (3,3) and (3,2); lying east it takes (3,3) and (4,3), where the rock is
  assert.strictEqual(World.canPlace(c, live(), lk(), p, 'bedroll', 3, 3, 'S').ok, true);
  assert.strictEqual(World.canPlace(c, live(), lk(), p, 'bedroll', 3, 3, 'E').ok, false);
  assert.strictEqual(World.canPlace(c, live(), lk(), p, 'bedroll', 6, 0, 'S').ok, false, 'too far');
  assert.match(as(p, { type: 'place', item: 'nothing', x: 3, y: 3 }), /can't be put down/);
  assert.match(as(p, { type: 'place', item: 'bedroll', x: 3, y: 4, facing: 'N' }), /put down the bedroll.*return here/);
  assert.strictEqual(p.respawn, 'camp:2:3', 'it is where you come back to at once (not walkable: where you stood)');
  assert.strictEqual(World.count(p, 'bedroll'), 0);
  const bed = live().entities.filter(e => e.ref === 't_bed')[0];
  assert.deepStrictEqual([bed.x, bed.y, bed.data.facing, bed.item, bed.by], [3, 4, 'N', 'bedroll', 'p1']);
  assert.match(as(p, { type: 'place', item: 'bedroll', x: 1, y: 3 }), /no bedroll/);
  // it is not used (no rest, no healing), turned or moved: only picked up
  put(s, 'camp', 2, 4, 'E'); p.hp = 1;
  as(p, { type: 'interact', x: 3, y: 4 });
  assert.strictEqual(p.hp, 1);
  assert.match(as(p, { type: 'turn', target: { t: 'ent', key: bed.key } }), /Pick it up/);
  assert.match(as(p, { type: 'relocate', target: { t: 'ent', key: bed.key }, x: 1, y: 5 }), /Pick it up/);
  const labels = () => World.actionsAt(c, live(), lk(), p, 3, 4).map(a => a.label);
  assert.deepStrictEqual(labels(), ['Pick up the bedroll']);
  // somebody else may not take it; its owner picks it up whole, and no longer returns there
  q.x = 3; q.y = 5;
  assert.match(as(q, { type: 'dismantle', target: { t: 'ent', key: bed.key } }), /not yours/);
  assert.match(as(p, { type: 'dismantle', target: { t: 'ent', key: bed.key } }), /pick up the bedroll/);
  assert.strictEqual(World.count(p, 'bedroll'), 1);
  assert.strictEqual(live().entities.filter(e => e.ref === 't_bed').length, 0);
  assert.strictEqual(p.respawn, '');
});

console.log(`\n${passed} world tests passed`);
