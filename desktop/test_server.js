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
  console.log('\n' + passed + ' checks passed.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
