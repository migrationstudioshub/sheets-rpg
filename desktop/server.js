/**
 * Desktop fallback static server.
 *
 * The desktop app's PRIMARY server is the repo's Python `tools/asset_server.py` (static files + the
 * art-generation APIs). This module is the FALLBACK used when the bundled/found Python can't start:
 * it serves the project folder statically — exactly like `tools/serve.js` — so the Map Editor, Content
 * Studio and offline Play still work, but the art routes (/gear, /tile, /object) return a friendly
 * "art engine unavailable" instead of generating anything.
 *
 * Plain Node (runs under Electron's own Node), no dependencies. Exported for reuse + tests.
 */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

const ART_PREFIXES = ['/gear/', '/tile/', '/object/'];

/**
 * Build the fallback static server for `root` (the project folder).
 * Returns an http.Server (not yet listening).
 */
function createServer(root) {
  const ROOT = path.resolve(root);

  return http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
    catch (e) { res.writeHead(400); res.end('bad request'); return; }

    // Art endpoints need Python; this fallback can't run them. Answer clearly (same JSON shape the
    // views check for) rather than 404, so the Asset Studio can show a helpful message.
    if (ART_PREFIXES.some((p) => urlPath.startsWith(p))) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'art engine unavailable (Python not found) — install Python 3 with Pillow + numpy, or use the packaged build.' }));
      return;
    }

    // Local mode: the game saved as project files in data/game/ (same routes as tools/asset_server.py).
    if (urlPath === '/data/ping' || (req.method === 'POST' && urlPath.startsWith('/data/'))) { dataRoute(ROOT, req, res, urlPath); return; }

    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(ROOT, path.normalize(urlPath));
    // Keep requests inside the project folder (no climbing out with ../).
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

// ---- the game as project files (local mode; layout in client/js/localdata.js, same answers as asset_server.py) ----
// Writes stay inside data/game/. Node runs one request's handler at a time and these use sync calls, so two saves
// never interleave; each file is written to a temp file, then renamed.
const MAP_ID = /^[A-Za-z0-9_]+$/;
function dataRoute(ROOT, req, res, urlPath) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(obj)); };
  const dir = path.join(ROOT, 'data', 'game'), maps = path.join(dir, 'maps');
  if (urlPath === '/data/ping') { send(200, { ok: true, local: true, game: fs.existsSync(path.join(dir, 'tables.json')) }); return; }
  let LocalData;
  try { LocalData = require(path.join(ROOT, 'client', 'js', 'localdata.js')); }
  catch (e) { send(500, { error: 'this project has no client/js/localdata.js' }); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { send(400, { error: 'bad json' }); return; }
    const write = (fp, text) => { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp + '.tmp', text); fs.renameSync(fp + '.tmp', fp); };
    const readJson = (fp, dflt) => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return dflt; } };
    const ixFile = path.join(maps, 'index.json');
    try {
      if (urlPath === '/data/save-tabs') {
        const tabs = body.tabs;
        if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) throw new Error('save-tabs needs tabs');
        if (tabs.Maps || tabs.MapEntities) throw new Error('maps are saved one by one (save-map), not as a tab');
        const fp = path.join(dir, 'tables.json');
        const defs = Object.assign(body.all ? {} : readJson(fp, {}), tabs);
        write(fp, LocalData.tablesText(defs));
        send(200, { ok: true, tabs: Object.keys(tabs) });
      } else if (urlPath === '/data/save-map') {
        const doc = body.map;
        if (!doc || !MAP_ID.test(String(doc.id || ''))) throw new Error('bad map id');
        const id = String(doc.id);
        write(path.join(maps, id + '.json'), LocalData.mapText(doc));
        const ids = (readJson(ixFile, { maps: [] }).maps || []).map(String);
        if (ids.indexOf(id) < 0) { ids.push(id); write(ixFile, JSON.stringify({ maps: ids }, null, 1) + '\n'); }
        send(200, { ok: true, id });
      } else if (urlPath === '/data/delete-map') {
        const id = String(body.id || '');
        if (!MAP_ID.test(id)) throw new Error('bad map id');
        fs.rmSync(path.join(maps, id + '.json'), { force: true });
        const ids = (readJson(ixFile, { maps: [] }).maps || []).map(String).filter((x) => x !== id);
        write(ixFile, JSON.stringify({ maps: ids }, null, 1) + '\n');
        send(200, { ok: true, id });
      } else send(404, { error: 'not found' });
    } catch (e) { send(200, { error: String((e && e.message) || e) }); }
  });
}

/** Resolve true if nothing is listening on `port` (localhost). */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

/** First free port at or after `preferred` (tries up to `tries` ports). */
async function findPort(preferred, tries = 20) {
  for (let p = preferred; p < preferred + tries; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port near ' + preferred);
}

module.exports = { createServer, isPortFree, findPort, TYPES, ART_PREFIXES };

// CLI: `node desktop/server.js <projectRoot> [port]` — handy for sandbox testing without Electron.
if (require.main === module) {
  const root = process.argv[2] || path.resolve(__dirname, '..');
  const port = Number(process.argv[3]) || 8766;
  createServer(root).listen(port, '127.0.0.1', () => {
    console.log('Desktop fallback server on http://localhost:' + port);
    console.log('  Root:   ' + path.resolve(root));
    console.log('  Home:   http://localhost:' + port + '/desktop/home.html');
    console.log('  Content http://localhost:' + port + '/content/');
    console.log('  Editor  http://localhost:' + port + '/editor/');
    console.log('  Studio  http://localhost:' + port + '/studio/   (art disabled in fallback)');
    console.log('  Play    http://localhost:' + port + '/client/?offline');
    console.log('  Stop with Ctrl+C');
  });
}
