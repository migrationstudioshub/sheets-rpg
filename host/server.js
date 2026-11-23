/**
 * Sheets RPG — host (one player's computer is the referee).
 *
 * Lets one computer be the referee for a same-room / same-WiFi game, or for friends elsewhere over a private
 * network such as Tailscale (they open this computer's Tailscale address).
 * It runs the SAME rules as the cloud (shared/world.js), keeps the game in memory, and ALSO serves
 * the game page — so other players just open the printed http://<this-pc>:<port> address in a browser.
 *
 *   node host/server.js            # port 3000
 *   PORT=4000 node host/server.js  # pick a port
 *
 * Content: the LIVE game's content, read once at start-up from the Cloud Function (the same read the game page
 * does — nothing is ever written there), so you host your real maps and monsters. With no internet it falls back to
 * the copy kept from the last good read (host/content.cache.json), then to data/tables.json (the starting content).
 *   CONTENT=local node host/server.js     # always data/tables.json
 *   CONTENT_URL=<url> node host/server.js # another content server
 * The game is saved to host/save.live.json (host/save.json when playing the starting content), so stopping and restarting this host keeps everyone's
 * characters and the world (set SAVE_FILE=off for a throwaway in-memory session instead).
 *
 * The world runs in a loop here ("the loop", below), and each page keeps a socket open ("the socket"): this is the
 * first stage of the game server planned in docs/QUESTS_INSTANCES_SERVER.md.
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
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// Same load order as the Cloud Function: Rules must be a global before world.js runs (it looks it up lazily).
const Content = require(path.join(ROOT, 'shared', 'content.js'));
const Rules = require(path.join(ROOT, 'shared', 'rules.js')); global.Rules = Rules;
const World = require(path.join(ROOT, 'shared', 'world.js'));

// ---- the content ----
// Read once at start-up (loadContent, below). Live content arrives built, as the game page gets it; like the page,
// the host tidies it and adds the empty storeys above every map (roofs, upper floors).
let CONTENT = null, CONTENT_FROM = '';
const CACHE_FILE = path.join(__dirname, 'content.cache.json');
function liveUrl() {
  if (process.env.CONTENT_URL) return process.env.CONTENT_URL;
  try { const m = /FUNCTIONS_URL:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'client', 'js', 'config.js'), 'utf8')); return m ? m[1] : ''; }
  catch (e) { return ''; }
}
function prepared(c) { if (Content.tidyMaps) Content.tidyMaps(c); return Content.autoFloors(c); }
async function loadContent() {
  const url = String(process.env.CONTENT || '').toLowerCase() === 'local' ? '' : liveUrl();
  if (url && typeof fetch === 'function') {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'action=content', { signal: ctl.signal });
      const body = await res.json(); clearTimeout(timer);
      if (body.error || !body.content || !body.content.maps) throw new Error(body.error || 'no content in the answer');
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify(body.content)); } catch (e) { /* no copy kept: not fatal */ }
      CONTENT = prepared(body.content); CONTENT_FROM = 'live';
      return;
    } catch (e) { console.log('  Could not read the live content (' + ((e && e.message) || e) + ').'); }
    try { CONTENT = prepared(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); CONTENT_FROM = 'cache'; return; } catch (e) { /* none kept yet */ }
  }
  CONTENT = Content.autoFloors(Content.build(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tables.json'), 'utf8'))));
  CONTENT_FROM = 'local';
}

// ---- the game state ----
// Held in memory while running, and saved to a JSON file so a session survives a restart of THIS
// host. The state is already plain JSON (the same shape the cloud stores), so saving is just writing
// it out. Set SAVE_FILE=off to run a throwaway in-memory session that leaves nothing behind.
let PLAYERS = {};                                     // token -> player
let WORLD = { seq: 0, log: [], maps: {} };            // monsters, object states, event log

// One save per kind of content: a world made on the live maps makes no sense on the starting ones, and the other way round.
let SAVE_FILE = null;
function pickSaveFile() {
  SAVE_FILE = process.env.SAVE_FILE === 'off' ? null
    : (process.env.SAVE_FILE || path.join(__dirname, CONTENT_FROM === 'local' ? 'save.json' : 'save.live.json'));
}

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
function step(token, action, since, structRev, floorRevs) {
  const now = Date.now();
  const p = PLAYERS[token];
  if (!p) throw new Error('unknown character');
  Object.keys(PLAYERS).forEach(tok => World.normalize(CONTENT, PLAYERS[tok]));
  const ws = WORLD;

  let players = presentOn(PLAYERS, p.map, now);
  if (!players.includes(p)) players.push(p);
  const startMap = p.map, ev = [];
  // Monsters following this player by the stairs are on the floor they left: keep it moving while they come.
  if (p.wake && p.wake.map !== p.map && now < p.wake.until && CONTENT.maps[p.wake.map]) World.advance(CONTENT, ws, p.wake.map, presentOn(PLAYERS, p.wake.map, now), now, Math.random, ev);
  World.deliver(CONTENT, ws);
  World.advance(CONTENT, ws, p.map, players, now, Math.random, ev);
  if (action) ev.push(...World.act(CONTENT, ws, p, action, now, Math.random, players));
  p._seen = now;
  if (p.map !== startMap) {                            // walked through a door/teleport
    players = presentOn(PLAYERS, p.map, now);
    if (!players.includes(p)) players.push(p);
    World.advance(CONTENT, ws, p.map, players, now, Math.random, ev);
  }
  World.advanceFloors(CONTENT, ws, p.map, id => presentOn(PLAYERS, id, now), now, Math.random, ev);   // the rest of the building stays alive
  World.deliver(CONTENT, ws);
  World.record(ws, ev);
  if (ws.log && ws.log.length > 50) ws.log = ws.log.slice(-50);
  scheduleSave();                                      // movement, combat, monster ticks — all persisted

  // The poll/act answer already carries everyone on the map (World.view), so on a LAN we just poll —
  // no Firebase, no separate pushed world view needed.
  return { player: World.publicPlayer(CONTENT, p), world: World.view(CONTENT, ws, p.map, p, players, p.map !== startMap ? -1 : structRev,
      Object.keys(PLAYERS).map(tok => PLAYERS[tok]).filter(q => now - (q._seen || 0) < 60000), floorRevs),
    events: World.eventsFor(ws, since, p), seq: ws.seq };
}

// ---- the loop ----
// The world moves on its own, TICK_MS apart, for as long as somebody is playing — not only when a request arrives.
// Each turn: every map with a player on it (and the other floors of its building) is advanced once, then every
// player with a live connection (the socket, further down) is sent what changed for them. Actions are not held
// for the turn: this is one thread, so each is applied the moment it arrives, in the order they come.
//   TICK_MS=50 node host/server.js   # a faster loop (default 100 = ten turns a second)
//   LAG_MS=150 node host/server.js   # delay every socket message this long each way, to feel a slow connection
const TICK_MS = Math.max(20, Number(process.env.TICK_MS) || 100);
const LAG_MS = Math.max(0, Number(process.env.LAG_MS) || 0);
const CONNS = new Set();                                // live sockets (see "the socket")
const STATS = { ticks: 0, pushes: 0, bytes: 0, slowest: 0 };
function livePlayers(now) { return Object.keys(PLAYERS).map(tok => PLAYERS[tok]).filter(q => now - (q._seen || 0) < 60000); }

function tick() {
  const now = Date.now(), t0 = process.hrtime.bigint(), live = livePlayers(now);
  if (!live.length) return;                              // nobody playing: the world waits, and catches up when they return
  const ev = [], done = {};
  const run = id => {
    if (done[id] || !CONTENT.maps[id]) return;
    done[id] = true;
    World.advance(CONTENT, WORLD, id, presentOn(PLAYERS, id, now), now, Math.random, ev);
  };
  World.deliver(CONTENT, WORLD);
  live.forEach(p => {
    if (p.wake && p.wake.map !== p.map && now < p.wake.until) run(p.wake.map);   // monsters coming after them by the stairs
    run(p.map);
    World.floorsOf(CONTENT, p.map).forEach(f => run(f.id));                    // the rest of the building stays alive
  });
  World.deliver(CONTENT, WORLD);
  if (ev.length) World.record(WORLD, ev);
  if (WORLD.log && WORLD.log.length > 50) WORLD.log = WORLD.log.slice(-50);
  scheduleSave();
  CONNS.forEach(conn => { try { push(conn, now, live); } catch (e) { console.error('  push failed:', (e && e.message) || e); } });
  STATS.ticks++;
  STATS.slowest = Math.max(STATS.slowest, Number(process.hrtime.bigint() - t0) / 1e6);
}

// What one connection is told. Every message is cut down to what this connection has not been sent yet: conn.sent
// holds the JSON of each part of the world view as last sent, and only parts that differ go out (a part that is
// gone goes out as null). An answer to a request (reply) carries everything and starts that record afresh.
function worldParts(conn, world, full) {
  const out = [], seen = {};
  Object.keys(world).forEach(k => {
    if (k === 'now') return;
    const j = JSON.stringify(world[k]);
    if (j === undefined) return;
    seen[k] = true;
    if (full || conn.sent[k] !== j) out.push(JSON.stringify(k) + ':' + j);
    conn.sent[k] = j;
  });
  Object.keys(conn.sent).forEach(k => { if (!seen[k]) { delete conn.sent[k]; if (!full) out.push(JSON.stringify(k) + ':null'); } });
  return out;
}
/** Remember which structure layers this connection now holds, so they are not sent again. */
function noteRevs(conn, world) {
  conn.structRev = world.structRev || 0;
  const revs = {};
  Object.keys(world.floors || {}).forEach(id => { revs[id] = world.floors[id].structRev || 0; });
  conn.floorRevs = revs;
}
function push(conn, now, live) {
  const p = conn.token && PLAYERS[conn.token];
  if (!p || now - (p._seen || 0) >= 60000) return;       // away (a hidden tab stops asking): nothing until they are back
  if (conn.sock.writableLength > 1e6) return;            // a connection that cannot keep up: skip, it gets the difference later
  const players = presentOn(PLAYERS, p.map, now);
  const world = World.view(CONTENT, WORLD, p.map, p, players, conn.structRev, live, conn.floorRevs);
  const pj = JSON.stringify(World.publicPlayer(CONTENT, p));
  const events = World.eventsFor(WORLD, conn.since, p);
  const parts = worldParts(conn, world, false);
  noteRevs(conn, world);
  conn.since = WORLD.seq;
  if (pj === conn.pj && !parts.length && !events.length) return;
  let text = '{"push":1,"now":' + world.now + ',"seq":' + (WORLD.seq || 0);
  if (pj !== conn.pj) { conn.pj = pj; text += ',"player":' + pj; }
  if (parts.length) text += ',"world":{' + parts.join(',') + '}';
  if (events.length) text += ',"events":' + JSON.stringify(events);
  sendText(conn, text + '}');
  STATS.pushes++;
}
/** The answer to a request that came by the socket: n = the number the page gave the request. */
function reply(conn, n, out) {
  if (!out || out.error || !out.world) { sendText(conn, JSON.stringify(Object.assign({ re: n }, out || { error: 'no answer' }))); return; }
  conn.pj = JSON.stringify(out.player);
  const parts = worldParts(conn, out.world, true);
  noteRevs(conn, out.world);
  conn.since = out.seq;
  sendText(conn, '{"re":' + JSON.stringify(n) + ',"seq":' + (out.seq || 0) + ',"player":' + conn.pj + ',"world":{"now":' + out.world.now +
    (parts.length ? ',' + parts.join(',') : '') + '},"events":' + JSON.stringify(out.events || []) + '}');
}

function join(name, cls, look) {
  name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
  if (!name) throw new Error('pick a name (letters and numbers)');
  const p = World.newPlayer(CONTENT, crypto.randomUUID().slice(0, 8), name, cls, look);
  p.token = crypto.randomUUID();
  p.created = new Date().toISOString();
  p._seen = Date.now();
  PLAYERS[p.token] = p;
  scheduleSave();                                      // remember the new character
  return { token: p.token, player: World.publicPlayer(CONTENT, p) };
}

// conn = the socket the request came by (none for a plain POST). A socket is told about events once, whichever
// message carries them, so the host keeps count for it (conn.since) instead of trusting the page's number.
function handleGame(body, conn) {
  if (conn && body.token && (body.action === 'load' || body.action === 'poll' || body.action === 'act')) conn.token = body.token;
  const since = conn && conn.since !== undefined ? conn.since : body.since;
  switch (body.action) {
    case 'join': return join(body.name, body['class'], { body: body.body, skin: body.skin, hair: body.hair, hairColor: body.hairColor });
    case 'load': return step(body.token, null, -1);
    case 'poll': return step(body.token, null, since, body.structRev, body.floorRevs);
    case 'act':  return step(body.token, body['do'], since, body.structRev, body.floorRevs);
    case 'save': return { ok: true };                  // nothing to persist; state is already in memory
    case 'stats': return Object.assign({ players: livePlayers(Date.now()).length, sockets: CONNS.size, tickMs: TICK_MS }, STATS);
    default: return { error: 'unknown action' };
  }
}

// ---- the socket ----
// A WebSocket, by hand (built-in modules only, like the rest of this host): the page keeps one open, sends its
// requests through it (the same bodies a POST carries, plus a number n) and is sent the changes of every turn
// without asking. Text frames only, no compression. A page that cannot open one keeps using POST, as before.
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function later(fn) { if (LAG_MS) setTimeout(fn, LAG_MS); else fn(); }
function sendText(conn, text) {
  const data = frame(1, Buffer.from(text, 'utf8'));
  STATS.bytes += data.length;
  later(() => { if (!conn.sock.destroyed) conn.sock.write(data); });
}
function onMessage(conn, text) {
  let body = null, out;
  try { body = JSON.parse(text); out = handleGame(body || {}, conn); }
  catch (err) { out = { error: String((err && err.message) || err) }; }
  reply(conn, body && body.n, out);
}
function readFrames(conn) {
  for (;;) {
    const b = conn.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, at = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); at = 10; }
    if (len > 1e6 || !masked) { conn.sock.destroy(); return; }       // too big, or not a browser's frame
    if (b.length < at + 4 + len) return;
    const mask = b.subarray(at, at + 4), data = Buffer.from(b.subarray(at + 4, at + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    conn.buf = b.subarray(at + 4 + len);
    if (op === 8) { conn.sock.end(frame(8, Buffer.alloc(0))); return; }
    if (op === 9) { conn.sock.write(frame(10, data)); continue; }     // ping → pong
    if (op !== 0 && op !== 1) continue;                               // pong, binary: nothing to do
    conn.parts.push(data);
    if (!fin) continue;
    const text = Buffer.concat(conn.parts).toString('utf8');
    conn.parts = [];
    later(() => onMessage(conn, text));
  }
}
function acceptSocket(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const conn = { sock: sock, token: '', since: undefined, structRev: undefined, floorRevs: undefined, sent: {}, pj: '', buf: Buffer.alloc(0), parts: [] };
  CONNS.add(conn);
  sock.on('data', d => { conn.buf = conn.buf.length ? Buffer.concat([conn.buf, d]) : d; readFrames(conn); });
  sock.on('close', () => CONNS.delete(conn));
  sock.on('error', () => CONNS.delete(conn));
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

function sendJson(req, res, obj) {
  const text = JSON.stringify(obj);
  if (text.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(text, { level: 1 }));
  } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(text); }
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const urlPath = url.pathname;

  if (req.method === 'GET') {
    if (urlPath === '/' && url.searchParams.get('action') === 'content') {
      sendJson(req, res, { content: CONTENT });
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
      sendJson(req, res, out);
    });
    return;
  }

  res.writeHead(405).end('method not allowed');
});
server.on('upgrade', acceptSocket);

// Flush the latest state and exit cleanly when the host presses Ctrl+C (or the process is told to stop).
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeSave();
  if (SAVE_FILE) console.log('\n  Game saved to ' + SAVE_FILE + '. Bye.\n');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const PORT = Number(process.env.PORT) || 3000;
const isTailscale = ip => { const q = ip.split('.').map(Number); return q[0] === 100 && q[1] >= 64 && q[1] <= 127; };
loadContent().then(() => {
 pickSaveFile();
 const restored = loadSave();
 server.listen(PORT, () => {
  const ips = [].concat(...Object.values(os.networkInterfaces()))
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n  Sheets RPG host is running.\n');
  console.log('  Content: ' + (CONTENT_FROM === 'live' ? 'the live game, read just now' : CONTENT_FROM === 'cache' ? 'the live game, as last read (no connection now)' : 'the starting content (data/tables.json)')
    + ': ' + Object.keys(CONTENT.maps).filter(id => !CONTENT.maps[id].auto).length + ' maps, start on ' + CONTENT.config.start_map + '.\n');
  console.log('  On THIS computer:      http://localhost:' + PORT);
  ips.forEach(ip => console.log((isTailscale(ip) ? '  Friends on Tailscale:  ' : '  Others on your WiFi:   ') + 'http://' + ip + ':' + PORT));
  console.log('\n  Everyone opens one of those addresses in a browser to play.');
  console.log('  The world runs ' + Math.round(1000 / TICK_MS) + ' turns a second' + (LAG_MS ? ', with ' + LAG_MS + ' ms of pretend lag each way' : '') + '.');
  setInterval(() => { try { tick(); } catch (e) { console.error('  A turn of the loop failed:', (e && e.stack) || e); } }, TICK_MS);
  if (!SAVE_FILE) console.log('  (SAVE_FILE=off: this session is not being saved.)');
  else if (restored) console.log('  Resumed a saved game with ' + restored + ' character(s).');
  else console.log('  New game. It will be saved to ' + SAVE_FILE + '.');
  console.log('  Press Ctrl+C to stop (characters and the world are kept for next time).\n');
 });
}).catch(e => { console.error('  The host could not start: ' + ((e && e.stack) || e)); process.exit(1); });
