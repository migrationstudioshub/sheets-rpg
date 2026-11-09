/**
 * Tiny zero-dependency static file server for local play-testing (no Python needed).
 *
 *   node tools/serve.js            # serves the repo on http://localhost:8765
 *   node tools/serve.js 3000       # ...on a different port
 *
 * Then open the game in OFFLINE mode (runs the game rules in your browser against
 * data/tables.json, so you can test changes before the server is updated):
 *
 *   http://localhost:8765/client/?offline        # the game
 *   http://localhost:8765/editor/                 # the map editor
 *
 * Offline progress is saved in that browser; use "New character" to start over.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const PORT = Number(process.argv[2]) || 8765;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  // keep requests inside the repo
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('Serving ' + ROOT);
  console.log('Play (offline):  http://localhost:' + PORT + '/client/?offline');
  console.log('Map editor:      http://localhost:' + PORT + '/editor/');
  console.log('Stop with Ctrl+C');
});
