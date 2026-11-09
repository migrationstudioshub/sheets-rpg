/**
 * Sheets RPG — LAN host (prototype).
 *
 * Lets one computer be the referee for a same-room / same-WiFi game, with NO internet needed.
 * It runs the SAME rules as the cloud (shared/world.js), keeps the game in memory, and ALSO serves
 * the game page — so other players just open the printed http://<this-pc>:<port> address in a browser.
 *
 *   node host/server.js            # port 3000
 *   PORT=4000 node host/server.js  # pick a port
 *
 * Content comes from data/tables.json (the starting content snapshot), so this works fully offline.
 * The game is saved to host/save.json, so stopping and restarting this host keeps everyone's
 * characters and the world (set SAVE_FILE=off for a throwaway in-memory session instead).
 *
 * Nothing here touches the live cloud game. The page it serves sets window.GAME_LAN, which tells
 * client/js/api.js to talk to this host instead of Apps Script / the Cloud Function / Firebase.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Same load order as the Cloud Function: Rules must be a global before world.js runs (it looks it up lazily).
const Content = require(path.join(ROOT, 'shared', 'content.js'));
const Rules = require(path.join(ROOT, 'shared', 'rules.js')); global.Rules = Rules;
const World = require(path.join(ROOT, 'shared', 'world.js'));

const tables = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tables.json'), 'utf8'));
const CONTENT = Content.build(tables);

// ---- the game state ----
// Held in memory while running, and saved to a JSON file so a session survives a restart of THIS
// host. The state is already plain JSON (the same shape the cloud stores), so saving is just writing
// it out. Set SAVE_FILE=off to run a throwaway in-memory session that leaves nothing behind.
let PLAYERS = {};                                     // token -> player
let WORLD = { seq: 0, log: [], maps: {} };            // monsters, object states, event log

const SAVE_FILE = process.env.SAVE_FILE === 'off' ? null
  : (process.env.SAVE_FILE || path.join(__dirname, 'save.json'));

function loadSave() {
  if (!SAVE_FILE) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (raw.players) PLAYERS = raw.players;           // reassigning is fine: the handlers read these vars live
    if (raw.world) WORLD = raw.world;
    return Object.keys(PLAYERS).length;
  } catch (e) { /* no save yet (first run), or unreadable — just start fresh */ }
}

function writeSave() {
  if (!SAVE_FILE) return;
  try {
    const tmp = SAVE_FILE + '.tmp';                   // write-then-rename, so a crash never leaves a half-written file
    fs.writeFileSync(tmp, JSON.stringify({ players: PLAYERS, world: WORLD }));
    fs.renameSync(tmp, SAVE_FILE);
  } catch (e) { console.error('  Could not save game:', e.message); }
}

// A burst of moves shouldn't be a burst of disk writes: coalesce changes into one write a second.
let saveTimer = null;
function scheduleSave() {
  if (!SAVE_FILE || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeSave(); }, 1000);
}

function presentOn(all, mapId, now) {
  return Object.keys(all).map(tok => all[tok])
    .filter(q => q.map === mapId && now - (q._seen || 0) < 60000);
}

/** One game step: catch the world up, run the player's action (if any), report back. */
function step(token, action, since) {
  const now = Date.now();
  const p = PLAYERS[token];
  if (!p) throw new Error('unknown character');
  Object.keys(PLAYERS).forEach(tok => World.normalize(CONTENT, PLAYERS[tok]));
  const ws = WORLD;

  let players = presentOn(PLAYERS, p.map, now);
  if (!players.includes(p)) players.push(p);
  const startMap = p.map, ev = [];
  World.advance(CONTENT, ws, p.map, players, now, Math.random, ev);
  if (action) ev.push(...World.act(CONTENT, ws, p, action, now, Math.random, players));
  p._seen = now;
  if (p.map !== startMap) {                            // walked through a door/teleport
    players = presentOn(PLAYERS, p.map, now);
    if (!players.includes(p)) players.push(p);
    World.advance(CONTENT, ws, p.map, players, now, Math.random, ev);
  }
  World.record(ws, ev);
  if (ws.log && ws.log.length > 50) ws.log = ws.log.slice(-50);
  scheduleSave();                                      // movement, combat, monster ticks — all persisted

  // The poll/act answer already carries everyone on the map (World.view), so on a LAN we just poll —
  // no Firebase, no separate pushed world view needed.
  return { player: World.publicPlayer(CONTENT, p), world: World.view(CONTENT, ws, p.map, p, players),
    events: World.eventsFor(ws, since, p), seq: ws.seq };
}

function join(name, cls) {
  name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
  if (!name) throw new Error('pick a name (letters and numbers)');
  const p = World.newPlayer(CONTENT, crypto.randomUUID().slice(0, 8), name, cls);
  p.token = crypto.randomUUID();
  p.created = new Date().toISOString();
  p._seen = Date.now();
  PLAYERS[p.token] = p;
  scheduleSave();                                      // remember the new character
  return { token: p.token, player: World.publicPlayer(CONTENT, p) };
}

function handleGame(body) {
  switch (body.action) {
    case 'join': return join(body.name, body['class']);
    case 'load': return step(body.token, null, -1);
    case 'poll': return step(body.token, null, body.since);
    case 'act':  return step(body.token, body['do'], body.since);
    case 'save': return { ok: true };                  // nothing to persist; state is already in memory
    default: return { error: 'unknown action' };
  }
}

// ---- serving the game files ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

// The page lives in client/ but is served at "/", so its relative links resolve to these repo folders.
const MOUNTS = { '/js/': 'client/js/', '/shared/': 'shared/', '/data/': 'data/', '/art/': 'art/', '/editor/': 'editor/' };

function serveStatic(urlPath, res) {
  let rel = null;
  for (const prefix in MOUNTS) {
    if (urlPath.startsWith(prefix)) { rel = MOUNTS[prefix] + urlPath.slice(prefix.length); break; }
  }
  if (rel == null) { res.writeHead(404).end('not found'); return; }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }   // no climbing out of the repo
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveIndex(res) {
  fs.readFile(path.join(ROOT, 'client', 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(500).end('no index.html'); return; }
    // Flip the client into LAN mode before any of its scripts load. Nothing in the repo is changed.
    html = html.replace('<body>', '<body>\n<script>window.GAME_LAN=true;</script>');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;

  if (req.method === 'GET') {
    if (urlPath === '/' && url.searchParams.get('action') === 'content') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: CONTENT }));
      return;
    }
    if (urlPath === '/' || urlPath === '/index.html') { serveIndex(res); return; }
    serveStatic(urlPath, res);
    return;
  }

  if (req.method === 'POST') {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out;
      try { out = handleGame(data ? JSON.parse(data) : {}); }
      catch (err) { out = { error: String((err && err.message) || err) }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  res.writeHead(405).end('method not allowed');
});

// Flush the latest state and exit cleanly when the host presses Ctrl+C (or the process is told to stop).
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeSave();
  if (SAVE_FILE) console.log('\n  Game saved to ' + SAVE_FILE + '. Bye.\n');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const restored = loadSave();

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  const ips = [].concat(...Object.values(os.networkInterfaces()))
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  Sheets RPG LAN host is running.\n');
  console.log('  On THIS computer:      http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Others on your WiFi:   http://' + ip + ':' + PORT));
  console.log('\n  Everyone opens one of those addresses in a browser to play.');
  if (!SAVE_FILE) console.log('  (SAVE_FILE=off: this session is not being saved.)');
  else if (restored) console.log('  Resumed a saved game with ' + restored + ' character(s).');
  else console.log('  New game. It will be saved to ' + SAVE_FILE + '.');
  console.log('  Press Ctrl+C to stop (characters and the world are kept for next time).\n');
});
