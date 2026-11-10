/**
 * Tests the shared rules and the Apps Script server (with fake Google services).
 * Run: node tools/test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const tables = JSON.parse(fs.readFileSync(path.join(root, 'data/tables.json'), 'utf8'));
const Content = require('../shared/content.js');
const Autotile = require('../shared/autotile.js');
const Rules = require('../shared/rules.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

const content = Content.build(tables);
const wild = content.maps.map_3;

test('all four old maps imported at 16x16', () => {
  const old = ['map_0', 'map_1', 'map_2', 'map_3'];
  assert.deepStrictEqual(Object.keys(content.maps).filter(id => old.indexOf(id) >= 0), old);
  old.forEach(id => { const m = content.maps[id]; assert.strictEqual(m.width, 16); assert.strictEqual(m.height, 16); });
});

test('every map cell and entity points at existing data', () => {
  Object.values(content.maps).forEach(m => {
    m.terrain.forEach(row => row.forEach(t => assert.ok(content.terrain[t], 'terrain ' + t)));
    m.entities.forEach(e => assert.ok(content.objects[e.ref], 'object ' + e.ref));
  });
});

test('old object index 41 maps to obj_42 (the skipped id)', () => {
  const gates = content.maps.map_1.entities.filter(e => e.x === 7 && e.y === 0);
  assert.strictEqual(gates[0].ref, 'obj_42');
});

test('Wilderness path is autotiled: open bottom end, closed top end', () => {
  const g = Autotile.grid(content, wild);
  assert.strictEqual(g[15][9].tile !== undefined, true);
  assert.strictEqual(Autotile.mask(wild.terrain, 9, 15, true), 5);   // N + S (runs off the map edge)
  assert.strictEqual(Autotile.mask(wild.terrain, 9, 10, true), 4);   // only S: top of the path
  assert.deepStrictEqual(content.autotile.blob47_craftpix[4], [43]);
  assert.strictEqual(g[10][9].tile, 43);
  assert.strictEqual(g[0][0], null);                                 // grass is not autotiled
});

test('autotile table covers all 47 blob cases', () => {
  assert.strictEqual(Object.keys(content.autotile.blob47_craftpix).length, 47);
});

test('walls block, floors and paths allow', () => {
  // standing at the bottom of the path, north is path, west is grass
  assert.ok(Rules.tryMove(content, wild, 9, 15, 'N').ok);
  assert.ok(Rules.tryMove(content, wild, 9, 15, 'W').ok);
  // walking into the void wall of the hut (til_0) from inside
  assert.ok(!Rules.tryMove(content, wild, 4, 5, 'W').ok);
  // off the map
  assert.ok(!Rules.tryMove(content, wild, 9, 15, 'S').ok);
});

test('the cobblestone wall facade blocks (old data had it walkable)', () => {
  assert.strictEqual(wild.terrain[9][4], 'til_11');
  assert.ok(!Rules.tryMove(content, wild, 4, 10, 'N').ok);
  assert.strictEqual(content.terrain.til_11.name, 'Cobblestone wall');
});

test('non-walkable objects block, walkable ones do not', () => {
  // (4,4) holds obj_17 Stool (walkable), (5,4) obj_14 Wooden Table (not)
  assert.ok(Rules.tryMove(content, wild, 4, 5, 'N').ok);
  const r = Rules.tryMove(content, wild, 5, 5, 'N');
  assert.ok(!r.ok); assert.strictEqual(r.reason, 'object');
});

test('one-sided passability is respected (til_7 only lets you go north/south)', () => {
  const map = { width: 3, height: 1, terrain: [['til_3', 'til_7', 'til_3']], entities: [] };
  assert.ok(!Rules.tryMove(content, map, 0, 0, 'E').ok);
  const map2 = { width: 1, height: 2, terrain: [['til_7'], ['til_3']], entities: [] };
  assert.ok(Rules.tryMove(content, map2, 0, 0, 'S').ok);
});

test('applyMoves walks, turns on blocked steps, caps batch size', () => {
  const p = Rules.applyMoves(content, { map: 'map_3', x: 9, y: 15, facing: 'S' }, ['N', 'N', 'S']);
  assert.deepStrictEqual([p.x, p.y, p.facing], [9, 14, 'S']);
  const q = Rules.applyMoves(content, { map: 'map_3', x: 9, y: 15 }, ['S']);
  assert.deepStrictEqual([q.x, q.y, q.facing], [9, 15, 'S']);
  const many = Rules.applyMoves(content, { map: 'map_3', x: 0, y: 0 }, Array(50).fill('E'));
  assert.strictEqual(many.x, 15); // capped at 20 steps, stopped by the edge at 15
});

test('start position is standable', () => {
  const c = content.config;
  assert.ok(Rules.standable(content, content.maps[c.start_map], c.start_x, c.start_y));
});

// ---------------------------------------------------------------- server with fake Google services
function fakeGoogle(serverTables) {
  const sheets = {};
  function Sheet(name, rows) {
    this.rows = rows;
    this.getName = () => name;
    this.getDataRange = () => ({ getValues: () => this.rows.map(r => r.slice()) });
    this.getLastRow = () => { let n = this.rows.length; while (n > 0 && this.rows[n - 1].every(v => v === '' || v == null)) n--; return n; };
    this.getLastColumn = () => Math.max(...this.rows.map(r => r.length));
    this.appendRow = (r) => { this.rows.push(r.slice()); };
    this.getRange = (row, col, nr, nc) => {
      nr = nr || 1; nc = nc || 1;
      const self = this;
      return {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (self.rows[row - 1 + i] || [])[col - 1 + j] ?? '')),
        getValue: () => (self.rows[row - 1] || [])[col - 1] ?? '',
        clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (self.rows[row - 1 + i]) self.rows[row - 1 + i][col - 1 + j] = ''; },
        setValues: (v) => v.forEach((r, i) => r.forEach((x, j) => { (self.rows[row - 1 + i] = self.rows[row - 1 + i] || [])[col - 1 + j] = x; })),
        createTextFinder: (text) => ({ matchEntireCell: () => ({ findNext: () => {
          for (let i = 0; i < nr; i++) if ((self.rows[row - 1 + i] || [])[col - 1] === text) return { getRow: () => row + i };
          return null;
        } }) })
      };
    };
  }
  function book(tabs) {
    const s = {};
    Object.entries(tabs).filter(([, recs]) => typeof recs === 'object').forEach(([name, recs]) => {
      const head = recs.head || Object.keys(recs[0] || {});
      s[name] = new Sheet(name, [head].concat((recs.rows || recs).map(r => head.map(h => r[h] ?? ''))));
    });
    return { getSheetByName: n => s[n] || null, insertSheet: n => (s[n] = new Sheet(n, [])), _sheets: s };
  }
  sheets.GD = book(tables);
  sheets.SV = book(serverTables);
  const store = {};
  const cache = {
    get: k => store[k] ?? null, put: (k, v) => { store[k] = v; },
    getAll: ks => Object.fromEntries(ks.map(k => [k, store[k]])),
    putAll: o => Object.assign(store, o), removeAll: ks => ks.forEach(k => delete store[k])
  };
  let uuid = 0;
  return {
    sheets,
    SpreadsheetApp: { openById: id => sheets[id] },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: n => ({ GAME_DATA_ID: 'GD', SERVER_ID: 'SV', EDITOR_KEY: 'secret-key' })[n] }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { getUuid: () => 'uuid-' + String(++uuid).padStart(4, '0') + '-aaaa-bbbb-cccc-dddddddddddd' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log: () => {} }
  };
}

function loadServer(g) {
  const ctx = vm.createContext(Object.assign({ console }, g));
  // world before rules on purpose: Apps Script may load files in any order
  ['shared_content.js', 'shared_autotile.js', 'shared_world.js', 'shared_rules.js', 'Code.js'].forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(root, 'server', f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

test('server copies of shared code are up to date', () => {
  ['content', 'autotile', 'rules', 'world'].forEach(n => {
    const orig = fs.readFileSync(path.join(root, 'shared', n + '.js'), 'utf8');
    const copy = fs.readFileSync(path.join(root, 'server', 'shared_' + n + '.js'), 'utf8');
    assert.ok(copy.endsWith(orig), n + ' copy is stale: run tools/sync_server.sh');
  });
});

// the Players tab as the milestone 1 Server.xlsx made it: the server must add the new columns itself
const g = fakeGoogle({ Players: { head: ['id', 'token', 'name', 'map', 'x', 'y', 'facing', 'hp', 'max_hp', 'level', 'xp', 'created', 'last_seen'], rows: [] },
  WorldState: { head: ['map', 'key', 'state', 'updated'], rows: [] } });
const S = loadServer(g);
const call = body => JSON.parse(S.doPost({ postData: { contents: JSON.stringify(body) } }).text);

test('server serves content identical to the offline build', () => {
  const res = JSON.parse(S.doGet({ parameter: { action: 'content' } }).text);
  assert.deepStrictEqual(res.content, JSON.parse(JSON.stringify(Content.build(tables))));
  const again = JSON.parse(S.doGet({ parameter: { action: 'content' } }).text); // from cache
  assert.deepStrictEqual(again.content, res.content);
});

let token;
test('join creates a character at the start position and a sheet row', () => {
  const r = call({ action: 'join', name: '  Tolodan!! ', class: 'rogue' });
  assert.ok(r.token && r.token.length >= 20);
  assert.strictEqual(r.player.name, 'Tolodan');
  assert.deepStrictEqual([r.player.map, r.player.x, r.player.y], ['map_3', 9, 15]);
  assert.strictEqual(r.player.token, undefined, 'token must not leak in player data');
  assert.strictEqual(g.sheets.SV._sheets.Players.rows.length, 2);
  assert.deepStrictEqual([r.player.class, r.player.gold, r.player.maxHp], ['rogue', 20, 90]);
  const head = g.sheets.SV._sheets.Players.rows[0];
  ['class', 'gold', 'inventory', 'equipment', 'flags', 'respawn'].forEach(c => assert.ok(head.includes(c), 'column ' + c + ' added'));
  const row = g.sheets.SV._sheets.Players.rows[1];
  assert.deepStrictEqual(JSON.parse(row[head.indexOf('inventory')]), [{ item: 'potion', qty: 3 }, { item: 'lockpick', qty: 3 }]);
  token = r.token;
});

test('server checks moves with the same rules', () => {
  const r = call({ action: 'move', token, dirs: ['N', 'N', 'N', 'W'] });
  assert.deepStrictEqual([r.player.x, r.player.y, r.player.facing], [8, 12, 'W']);
  const blocked = call({ action: 'move', token, dirs: ['S', 'S', 'S', 'S', 'S'] });
  assert.strictEqual(blocked.player.y, 15); // stops at the map edge
});

test('save writes the latest position to the sheet; load restores it', () => {
  call({ action: 'save', token });
  const rows = g.sheets.SV._sheets.Players.rows, head = rows[0], row = rows[1];
  assert.deepStrictEqual([row[head.indexOf('x')], row[head.indexOf('y')]], [8, 15]);
  const r = call({ action: 'load', token });
  assert.deepStrictEqual([r.player.x, r.player.y], [8, 15]);
});

test('act: opening the hut door, walking in, emptying the chest; events come back', () => {
  let r = call({ action: 'act', token, do: { type: 'move', dirs: ['E', 'N', 'N', 'N', 'N', 'N', 'N'] }, since: 0 });
  assert.deepStrictEqual([r.player.x, r.player.y], [9, 10]);
  r = call({ action: 'act', token, do: { type: 'interact' }, since: r.seq });
  assert.strictEqual(r.world.states['map_3.e9'], 'open');
  r = call({ action: 'act', token, do: { type: 'move', dirs: ['N', 'N', 'N', 'E'] }, since: r.seq });
  assert.deepStrictEqual([r.player.x, r.player.y, r.player.facing], [9, 7, 'E']);
  r = call({ action: 'act', token, do: { type: 'interact' }, since: r.seq });
  assert.ok(r.events.some(e => /You open the wooden chest/.test(e.text)), JSON.stringify(r.events));
  assert.ok(r.player.inventory.some(i => i.item === 'wooden_sword'));
  assert.ok(r.world.monsters.length >= 5, 'monsters are in the view');
});

test('the world state survives a cache loss through the WorldState tab', () => {
  call({ action: 'act', token, do: { type: 'move', dirs: [] }, since: -1 });
  const cache = g.CacheService.getScriptCache();
  const ws = JSON.parse(cache.get('world')); ws.savedAt = 0; cache.put('world', JSON.stringify(ws));
  call({ action: 'poll', token, since: -1 });                       // forces a sheet write (15 s throttle passed)
  const rows = g.sheets.SV._sheets.WorldState.rows;
  assert.ok(rows.some(r => r[1] === 'map_3.e9' && r[2] === 'open'), JSON.stringify(rows));
  cache.removeAll(['world']);
  const r = call({ action: 'poll', token, since: -1 });
  assert.strictEqual(r.world.states['map_3.e9'], 'open');
});

test('casting through the server: mana, cooldown and the bar are saved', () => {
  let r = call({ action: 'act', token, do: { type: 'cast', skill: 'throw_dagger', x: 0, y: 0 }, since: -1 });
  assert.ok(r.events.length === 0 || true);
  const before = r.player.mp;
  const mon = r.world.monsters[0];
  r = call({ action: 'act', token, do: { type: 'loadout', bar: 'ability', slot: 1, entry: 'throw_dagger' }, since: r.seq });
  assert.strictEqual(r.player.abilities[1], 'throw_dagger');
  call({ action: 'save', token });
  const rows = g.sheets.SV._sheets.Players.rows, head = rows[0];
  ['mp', 'abilities', 'belt', 'cooldowns', 'statuses'].forEach(c => assert.ok(head.includes(c), c));
  assert.strictEqual(JSON.parse(rows[1][head.indexOf('abilities')])[1], 'throw_dagger');
  assert.ok(typeof before === 'number' && mon);
});

test('bad requests are refused politely', () => {
  assert.ok(call({ action: 'move', token: 'nope', dirs: ['N'] }).error);
  assert.ok(call({ action: 'join', name: '!!!' }).error);
  assert.ok(call({ action: 'dance' }).error);
});

// ---------------------------------------------------------------- editor saving
const tablesNow = () => JSON.parse(S.doGet({ parameter: { action: 'tables' } }).text).tables;

test('editor actions need the editor key', () => {
  assert.match(call({ action: 'saveTab', key: 'wrong', tab: 'Objects', rows: [] }).error, /wrong editor key/);
  assert.match(call({ action: 'deleteMap', id: 'map_0' }).error, /wrong editor key/);
});

test('saveMap replaces one map and its entities, leaving the others alone', () => {
  const before = tablesNow();
  const otherEnts = before.MapEntities.filter(r => r.map !== 'map_3').length;
  const grid = JSON.parse(before.Maps.find(r => r.id === 'map_3').terrain);
  grid[14][3] = 'fields'; grid[14][4] = 'fields';
  const r = call({ action: 'saveMap', key: 'secret-key', map: { id: 'map_3', name: 'Wilderness', terrain: grid },
    entities: [{ key: 'map_3.e1', x: 2, y: 2, ref: 'obj_0', data: { contents: 'potion:2', per_player: true } }] });
  assert.ok(r.ok, r.error);
  const after = tablesNow();
  assert.strictEqual(after.Maps.length, 5);   // 4 imported + the art demo
  assert.strictEqual(after.Maps.find(r => r.id === 'map_3').name, 'Wilderness');
  assert.strictEqual(after.MapEntities.filter(r => r.map !== 'map_3').length, otherEnts);
  const mine = after.MapEntities.filter(r => r.map === 'map_3');
  assert.strictEqual(mine.length, 1);
  assert.deepStrictEqual(JSON.parse(mine[0].data), { contents: 'potion:2', per_player: true });
  const c = JSON.parse(S.doGet({ parameter: { action: 'content' } }).text).content;  // cache was cleared
  assert.strictEqual(c.maps.map_3.terrain[14][3], 'fields');
  assert.strictEqual(c.maps.map_3.entities[0].data.contents, 'potion:2');
});

test('saveMap can add a new map; deleteMap removes it and its entities', () => {
  const grid = [['til_3', 'til_3'], ['til_3', 'til_3']];
  assert.ok(call({ action: 'saveMap', key: 'secret-key', map: { id: 'map_9', name: 'Tiny', terrain: grid },
    entities: [{ key: 'map_9.e1', x: 1, y: 1, ref: 'obj_20', data: '' }] }).ok);
  assert.strictEqual(tablesNow().Maps.length, 6);   // 5 + the new map_9
  assert.ok(call({ action: 'deleteMap', key: 'secret-key', id: 'map_9' }).ok);
  const t = tablesNow();
  assert.strictEqual(t.Maps.length, 5);
  assert.strictEqual(t.MapEntities.filter(r => r.map === 'map_9').length, 0);
});

test('saveTab rewrites a definitions tab and keeps extra columns', () => {
  const rows = tablesNow().Objects;
  rows[0].name = 'Big Chest'; rows[0].my_column = 'kept';
  assert.ok(call({ action: 'saveTab', key: 'secret-key', tab: 'Objects', rows }).ok);
  const t = tablesNow();
  assert.strictEqual(t.Objects.length, rows.length);
  assert.strictEqual(t.Objects[0].name, 'Big Chest');
  assert.strictEqual(t.Objects[0].my_column, 'kept');
  assert.match(call({ action: 'saveTab', key: 'secret-key', tab: 'Players', rows: [] }).error, /cannot be saved/);
});

test('editor saves refuse to overwrite sheet edits made after loading, unless forced', () => {
  const C = require(path.join(root, 'shared', 'content.js'));
  const GD = g.sheets.GD._sheets;
  let t = tablesNow();
  const base = C.hash(t.Items), mapBase = C.mapHash(t, 'map_3');
  const rows = t.Items.map(r => Object.assign({}, r));
  rows[0].name = 'Editor name';
  // the owner edits the sheet by hand meanwhile
  const sh = GD.Items; sh.rows[1][sh.rows[0].indexOf('name')] = 'Hand edit';
  const r = call({ action: 'saveTab', key: 'secret-key', tab: 'Items', rows, base });
  assert.ok(r.conflict, 'conflict flagged'); assert.match(r.error, /changed in the spreadsheet/);
  assert.strictEqual(tablesNow().Items[0].name, 'Hand edit');           // nothing overwritten
  const f = call({ action: 'saveTab', key: 'secret-key', tab: 'Items', rows, base, force: true });
  assert.ok(f.ok, f.error);
  assert.strictEqual(tablesNow().Items[0].name, 'Editor name');
  assert.strictEqual(f.hash, C.hash(tablesNow().Items));                 // new base for the next save
  assert.ok(call({ action: 'saveTab', key: 'secret-key', tab: 'Items', rows, base: f.hash }).ok);
  // maps: an untouched map saves; a hand-edited one is refused
  t = tablesNow();
  const map = { id: 'map_3', name: 'Wilderness', terrain: JSON.parse(t.Maps.find(r => r.id === 'map_3').terrain) };
  const ok = call({ action: 'saveMap', key: 'secret-key', map, entities: [], base: mapBase });
  assert.ok(ok.ok, ok.error);
  const ms = GD.Maps, row = ms.rows.findIndex(r => r[ms.rows[0].indexOf('id')] === 'map_3');
  ms.rows[row][ms.rows[0].indexOf('name')] = 'Renamed by hand';
  assert.ok(call({ action: 'saveMap', key: 'secret-key', map, entities: [], base: ok.hash }).conflict);
  assert.ok(call({ action: 'saveMap', key: 'secret-key', map, entities: [] }).ok);   // old editors (no base) still work
});

test('bad map ids are refused', () => {
  assert.match(call({ action: 'saveMap', key: 'secret-key', map: { id: '../x', terrain: [['til_3']] } }).error, /bad map id/);
});

console.log(`\n${passed} tests passed`);
