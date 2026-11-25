/**
 * Tests for the fallback static server (desktop/server.js) — plain Node, no Electron.
 *   node desktop/test_server.js
 */
'use strict';
const http = require('http');
const path = require('path');
const assert = require('assert');
const server = require('./server');

const ROOT = path.resolve(__dirname, '..');   // the repo

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async function () {
  let passed = 0;
  const check = (name, cond) => { assert.ok(cond, name); console.log('  ok ' + name); passed++; };

  const port = await server.findPort(8790);
  const srv = server.createServer(ROOT);
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try {
    let r = await get(port, '/data/tables.json');
    check('serves data/tables.json', r.status === 200 && r.body.trim().startsWith('{'));

    r = await get(port, '/desktop/home.html');
    check('serves the launcher page', r.status === 200 && /Sheets RPG Studio/.test(r.body));

    r = await get(port, '/content/');
    check('directory maps to index.html', r.status === 200 && /<html/i.test(r.body));

    r = await get(port, '/client/js/config.js');
    check('serves nested static files', r.status === 200 && /GAME_CONFIG/.test(r.body));

    r = await get(port, '/gear/ping');
    check('art routes return 503 unavailable', r.status === 503 && /art engine unavailable/.test(r.body));

    r = await get(port, '/%2e%2e/%2e%2e/Windows/System32');
    check('blocks path escape (../)', r.status === 403 || r.status === 404);

    r = await get(port, '/does/not/exist.js');
    check('missing file is 404', r.status === 404);
  } finally {
    srv.close();
  }

  // Local mode: the game saved as project files (data/game/). Run against a throwaway project folder.
  const fs = require('fs'), os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srpg-local-'));
  fs.mkdirSync(path.join(tmp, 'client', 'js'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'shared'));
  fs.copyFileSync(path.join(ROOT, 'client', 'js', 'localdata.js'), path.join(tmp, 'client', 'js', 'localdata.js'));
  fs.copyFileSync(path.join(ROOT, 'shared', 'mapcode.js'), path.join(tmp, 'shared', 'mapcode.js'));
  const LocalData = require(path.join(ROOT, 'client', 'js', 'localdata.js'));
  const lport = await server.findPort(8810);
  const lsrv = server.createServer(tmp);
  await new Promise((res) => lsrv.listen(lport, '127.0.0.1', res));
  const post = (p, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port: lport, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    rq.on('error', reject); rq.end(data);
  });
  const game = (f) => path.join(tmp, 'data', 'game', f);
  try {
    let r = await get(lport, '/data/ping');
    check('local mode: ping says local, no game yet', r.status === 200 && JSON.parse(r.body).local === true && JSON.parse(r.body).game === false);

    let a = await post('/data/save-tabs', { tabs: { Items: [{ id: 'axe', name: 'Axe' }], Config: [{ key: 'start_map', value: 'm1' }] } });
    check('local mode: save-tabs writes tables.json', a.ok && fs.existsSync(game('tables.json')));
    a = await post('/data/save-tabs', { tabs: { Items: [{ id: 'axe', name: 'Big axe' }, { id: 'rope', name: 'Rope' }] } });
    let defs = JSON.parse(fs.readFileSync(game('tables.json'), 'utf8'));
    check('local mode: a tab replaces only itself (others kept)', defs.Items.length === 2 && defs.Config[0].value === 'm1');
    check('local mode: one row per line', fs.readFileSync(game('tables.json'), 'utf8').split('\n').filter((l) => /"id":"(axe|rope)"/.test(l)).length === 2);
    a = await post('/data/save-tabs', { tabs: { Maps: [] } });
    check('local mode: maps are refused as a tab', !!a.error);

    const grid = [['grass', 'grass', 'water'], ['grass', 'grass', 'grass']];
    const row = { id: 'm1', name: 'Meadow', width: 3, height: 2, terrain: JSON.stringify(grid), z: 0 };
    const ents = [{ map: 'm1', key: 'm1.e1', x: 1, y: 0, ref: 'chest', data: '{"loot":"gold:5"}' }];
    a = await post('/data/save-map', { map: LocalData.docOf(row, ents) });
    const ix = JSON.parse(fs.readFileSync(game('maps/index.json'), 'utf8'));
    check('local mode: save-map writes the map and lists it', a.ok && fs.existsSync(game('maps/m1.json')) && ix.maps.join() === 'm1');
    const doc = JSON.parse(fs.readFileSync(game('maps/m1.json'), 'utf8'));
    const back = LocalData.assemble(defs, [doc]);
    const MapCode = require(path.join(ROOT, 'shared', 'mapcode.js'));
    check('local mode: a map comes back as it went in (terrain packed in the file)', doc.terrain.e === 1 &&
      back.Maps[0].name === 'Meadow' && JSON.stringify(MapCode.decode(JSON.parse(back.Maps[0].terrain))) === JSON.stringify(grid) &&
      back.MapEntities.length === 1 && back.MapEntities[0].ref === 'chest' && back.MapEntities[0].data === '{"loot":"gold:5"}');
    a = await post('/data/save-map', { map: { id: '../evil' } });
    check('local mode: a bad map id is refused', !!a.error && !fs.existsSync(path.join(tmp, 'data', 'evil.json')));
    a = await post('/data/delete-map', { id: 'm1' });
    check('local mode: delete-map removes the file and the listing', a.ok && !fs.existsSync(game('maps/m1.json')) &&
      JSON.parse(fs.readFileSync(game('maps/index.json'), 'utf8')).maps.length === 0);
    r = await get(lport, '/data/ping');
    check('local mode: ping now says there is a game', JSON.parse(r.body).game === true);
  } finally {
    lsrv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + passed + ' checks passed.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
