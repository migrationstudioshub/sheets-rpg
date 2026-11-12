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
