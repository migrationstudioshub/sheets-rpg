/**
 * Sheets RPG server (Apps Script web app).
 *
 * Script properties (Project Settings -> Script properties):
 *   GAME_DATA_ID  id of the Game Data spreadsheet
 *   SERVER_ID     id of the Server spreadsheet
 *
 * API
 *   GET  ?action=content          -> { content }   (all game data, built by shared/content.js)
 *   GET  ?action=reload           -> clears the content cache after you edit Game Data
 *   GET  ?action=tables           -> { tables }    (raw Game Data rows, for the map editor)
 *   POST {action:'join', name, class} -> { token, player }
 *   POST {action:'load', token}            -> { player, world, events, seq }
 *   POST {action:'poll', token, since}     -> same; the world moves on (monsters act) on every call
  *   POST {action:'act', token, do, since}  do = {type:'move', dirs} | {type:'interact'} | {type:'use', item}
 *                                              | {type:'cast', skill, x, y} | {type:'loadout', slot, entry}
 *     All game rules are in shared/world.js (also used by offline mode).
 *   POST {action:'save', token}   -> { ok }        (sent when a player closes the page)
 *
 * Editor actions (need key = the EDITOR_KEY script property):
 *   POST {action:'saveMap', key, map:{id,name,width,height,terrain,...}, entities:[rows]}
 *   POST {action:'deleteMap', key, id}
 *   POST {action:'saveTab', key, tab:'Objects'|'Terrain'|..., rows:[records]}
 *
 * The shared_*.js files in this project are copies of /shared in the repository
 * (tools/sync_server.sh); edit the originals, not the copies.
 */

var CONTENT_TABS = ['Config', 'Tilesets', 'Autotile', 'Terrain', 'Kinds', 'Objects', 'Maps', 'MapEntities',
  'Items', 'Monsters', 'LootTables', 'Classes', 'Levels', 'Skills', 'Statuses', 'Appearances'];
var PLAYER_COLS = ['id', 'token', 'name', 'class', 'map', 'x', 'y', 'facing', 'hp', 'mp', 'level', 'xp', 'gold',
  'inventory', 'equipment', 'abilities', 'belt', 'mags', 'cooldowns', 'statuses', 'flags', 'respawn', 'created', 'last_seen'];
var CACHE_S = 21600; // 6 hours, the CacheService maximum

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'content') return out({ content: getContent() });
    if (action === 'reload') { clearContentCache(); return out({ ok: true, reloaded: true }); }
    if (action === 'tables') return out({ tables: readTables() });
    if (action === 'firebaseTest') return out(firebaseTest());
    return out({ ok: true, game: 'sheets-rpg', hint: 'use ?action=content' });
  } catch (err) {
    return out({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ error: 'bad request' }); }
  try {
    switch (body.action) {
      case 'join': return out(join(body.name, body['class']));
      case 'load': return out(step(body.token, null, -1));
      case 'poll': return out(step(body.token, null, body.since));
      case 'act': return out(step(body.token, body['do'], body.since));
      case 'move': return out(step(body.token, { type: 'move', dirs: body.dirs }, body.since));
      case 'save': savePlayer(requirePlayer(body.token), true); return out({ ok: true });
      case 'saveMap': requireEditor(body.key); return out(saveMap(body.map, body.entities, body.base, body.force));
      case 'deleteMap': requireEditor(body.key); return out(deleteMap(body.id));
      case 'saveTab': requireEditor(body.key); return out(saveTab(body.tab, body.rows, body.base, body.force));
      default: return out({ error: 'unknown action' });
    }
  } catch (err) {
    return out({ error: String(err && err.message || err), conflict: !!(err && err.conflict) || undefined });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- content

function prop(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Script property ' + name + ' is not set (see docs/SETUP.md)');
  return v;
}

function readTables() {
  var ss = SpreadsheetApp.openById(prop('GAME_DATA_ID')), tables = {};
  CONTENT_TABS.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    tables[name] = sh ? Content.recordsFromValues(sh.getDataRange().getValues()) : [];
  });
  return tables;
}

/** Built content, cached in pieces (each cache value is limited to 100 KB). */
function getContent() {
  var cache = CacheService.getScriptCache(), n = Number(cache.get('content.n') || 0);
  if (n) {
    var keys = [];
    for (var i = 0; i < n; i++) keys.push('content.' + i);
    var parts = cache.getAll(keys), text = '';
    for (var j = 0; j < n; j++) { if (parts['content.' + j] == null) { text = null; break; } text += parts['content.' + j]; }
    if (text) return JSON.parse(text);
  }
  var content = Content.build(readTables());
  var json = JSON.stringify(content), size = 90000, put = {};
  for (var k = 0; k * size < json.length; k++) put['content.' + k] = json.slice(k * size, (k + 1) * size);
  put['content.n'] = String(k);
  cache.putAll(put, CACHE_S);
  return content;
}

function clearContentCache() {
  var cache = CacheService.getScriptCache(), n = Number(cache.get('content.n') || 0), keys = ['content.n'];
  for (var i = 0; i < n; i++) keys.push('content.' + i);
  cache.removeAll(keys);
}

// ---------------------------------------------------------------- players

var JSON_COLS = ['inventory', 'equipment', 'abilities', 'belt', 'mags', 'cooldowns', 'statuses', 'flags'];

function playersSheet() {
  var ss = SpreadsheetApp.openById(prop('SERVER_ID'));
  var sh = ss.getSheetByName('Players');
  if (!sh) { sh = ss.insertSheet('Players'); sh.appendRow(PLAYER_COLS); }
  return sh;
}

/** Header name -> column index; adds any columns the game needs that the sheet lacks. Cached for 10 minutes. */
function headerIndex(sh) {
  var cache = CacheService.getScriptCache(), ck = 'hdr:' + sh.getName(), hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var missing = PLAYER_COLS.filter(function (c) { return head.indexOf(c) < 0; });
  if (missing.length && sh.getName() === 'Players') {
    while (head.length && !head[head.length - 1]) head.pop();
    head = head.concat(missing);
    sh.getRange(1, 1, 1, head.length).setValues([head]);
  }
  var idx = {};
  head.forEach(function (h, i) { if (h) idx[h] = i; });
  cache.put(ck, JSON.stringify(idx), 600);
  return idx;
}

function findRow(sh, token) {
  var idx = headerIndex(sh);
  if (idx.token == null) throw new Error('Players tab has no token column');
  var cell = sh.getRange(2, idx.token + 1, Math.max(1, sh.getLastRow() - 1), 1)
    .createTextFinder(token).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

function requirePlayer(token) {
  if (!token || typeof token !== 'string' || token.length < 20) throw new Error('not signed in');
  var cache = CacheService.getScriptCache(), cached = cache.get('p:' + token);
  if (cached) return JSON.parse(cached);
  var sh = playersSheet(), row = findRow(sh, token);
  if (!row) throw new Error('unknown character');
  var idx = headerIndex(sh), vals = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0], p = {};
  Object.keys(idx).forEach(function (k) { p[k] = vals[idx[k]]; });
  World.normalize(getContent(), p);   // only on a cache miss
  p._row = row; p._savedAt = Date.now();
  cache.put('p:' + token, JSON.stringify(p), CACHE_S);
  return p;
}

/** Keeps the player in cache on every change; writes the sheet row at most every save_every_s (or now, if force). */
function savePlayer(p, force, content) {
  content = content || getContent();
  var every = Math.max(10, Number(content.config.save_every_s || 30)) * 1000;   // at least 10 s between sheet writes
  p.last_seen = new Date().toISOString();
  if (force || !p._savedAt || Date.now() - p._savedAt >= every) {
    var sh = playersSheet(), idx = headerIndex(sh);
    var row = p._row && sh.getRange(p._row, idx.token + 1).getValue() === p.token ? p._row : findRow(sh, p.token);
    var vals = [];
    Object.keys(idx).forEach(function (k) {
      var v = p[k];
      if (JSON_COLS.indexOf(k) >= 0) v = JSON.stringify(v || (k === 'inventory' || k === 'abilities' || k === 'belt' || k === 'statuses' ? [] : {}));
      vals[idx[k]] = v == null ? '' : v;
    });
    for (var i = 0; i < vals.length; i++) if (vals[i] === undefined) vals[i] = '';
    if (row) sh.getRange(row, 1, 1, vals.length).setValues([vals]);
    else { sh.appendRow(vals); row = sh.getLastRow(); }
    p._row = row; p._savedAt = Date.now();
  }
  CacheService.getScriptCache().put('p:' + p.token, JSON.stringify(p), CACHE_S);
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw new Error('server busy, try again');
  try { return fn(); } finally { lock.releaseLock(); }
}

function join(name, cls) {
  name = String(name || '').replace(/[^\p{L}\p{N} _\-']/gu, '').trim().slice(0, 16);
  if (!name) throw new Error('pick a name (letters and numbers)');
  var content = getContent();
  var p = World.newPlayer(content, Utilities.getUuid().slice(0, 8), name, cls);
  p.token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  p.created = new Date().toISOString();
  withLock(function () { savePlayer(p, true, content); });
  return { token: p.token, player: World.publicPlayer(content, p) };
}

// ---------------------------------------------------------------- world

/** Live world (monsters, object states, recent events) lives in the cache; object states are also kept in WorldState. */
function getWorld() {
  var cached = CacheService.getScriptCache().get('world');
  if (cached) return JSON.parse(cached);
  var ws = { seq: 0, log: [], maps: {}, presence: {} };
  var sh = SpreadsheetApp.openById(prop('SERVER_ID')).getSheetByName('WorldState');
  if (sh) Content.recordsFromValues(sh.getDataRange().getValues()).forEach(function (r) {
    if (!r.map || !r.key) return;
    World.mapState(ws, String(r.map)).states[String(r.key)] = String(r.state);
  });
  return ws;
}

function saveWorld(ws, force) {
  var now = Date.now();
  if (ws.dirty && (force || now - (ws.savedAt || 0) > 15000)) {
    var rows = [];
    Object.keys(ws.maps).forEach(function (m) {
      var ms = ws.maps[m];
      Object.keys(ms.states || {}).forEach(function (k) {
        if (ms.timers && ms.timers[k]) return;                 // temporary (a sprung trap): not worth keeping
        rows.push({ map: m, key: k, state: ms.states[k], updated: new Date(now).toISOString() });
      });
    });
    var ss = SpreadsheetApp.openById(prop('SERVER_ID'));
    var sh = ss.getSheetByName('WorldState') || ss.insertSheet('WorldState');
    if (sh.getLastRow() < 1) sh.appendRow(['map', 'key', 'state', 'updated']);
    writeRecords(sh, rows, null);
    ws.dirty = false; ws.savedAt = now;
  }
  CacheService.getScriptCache().put('world', JSON.stringify(ws), CACHE_S);
}

// ---------------------------------------------------------------- live push (Firebase, optional)
// If the FIREBASE_URL script property is set, after each step we also write the map's live view
// (monsters and players) to the Realtime Database, so other clients on that map get it pushed in
// ~100 ms instead of waiting for their next poll. The server stays the referee; this is read-only
// smoothing. Clients read it (public read rules); only the server writes, using FIREBASE_SECRET.
function firebaseBase() { return PropertiesService.getScriptProperties().getProperty('FIREBASE_URL'); }

/** The fast-moving, fully-global part of a map's state: all monsters and all players present. */
function firebaseView(content, ws, mapId, players) {
  var ms = World.mapState(ws, mapId);
  return {
    map: mapId, now: Date.now(), seq: ws.seq || 0,
    monsters: (ms.monsters || []).filter(function (m) { return !m.dead; }).map(function (m) {
      var d = content.monsters[m.ref];
      return { id: m.id, ref: m.ref, x: m.x, y: m.y, hp: m.hp, maxHp: d ? d.hp : m.hp, facing: m.facing,
        statuses: (m.statuses || []).map(function (st) { return st.id; }) };
    }),
    players: (players || []).filter(function (q) { return q.map === mapId; }).map(function (q) {
      return { id: q.id, name: q.name, x: q.x, y: q.y, facing: q.facing, hp: q.hp, maxHp: World.stats(content, q).maxHp, level: q.level };
    })
  };
}

function firebaseUrl(secret, path) {
  var base = firebaseBase();
  return base.replace(/\/+$/, '') + '/world/' + path + '.json' + (secret ? '?auth=' + encodeURIComponent(secret) : '');
}

/**
 * Write one map's live view to the Realtime Database. Never lets a failed push break a game step:
 * if a write errors or runs slow, we log why and switch the push off for a couple of minutes
 * (a circuit breaker) so the game falls back to plain polling instead of hanging on every move.
 */
function pushWorld(mapId, payload) {
  var base = firebaseBase(); if (!base) return;
  var cache = CacheService.getScriptCache();
  if (cache.get('fb.off')) return;                          // a recent write failed or was slow: stay off, keep the game fast
  var secret = PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET') || '';
  var started = Date.now();
  try {
    var res = UrlFetchApp.fetch(firebaseUrl(secret, encodeURIComponent(mapId)),
      { method: 'put', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
    var code = res.getResponseCode(), ms = Date.now() - started;
    if (code >= 300 || ms > 3000) {
      cache.put('fb.off', '1', 120);
      Logger.log('Firebase push disabled for 120s — HTTP ' + code + ' in ' + ms + 'ms: ' + String(res.getContentText()).slice(0, 200));
    }
  } catch (e) {
    cache.put('fb.off', '1', 120);
    Logger.log('Firebase push disabled for 120s — ' + String(e && e.message || e) + ' (after ' + (Date.now() - started) + 'ms)');
  }
}

/**
 * One-shot check of the Firebase setup. Open <API_URL>?action=firebaseTest (or Run this in the editor):
 * it writes a tiny world/_diag node and reports exactly what came back, so a broken URL or secret is
 * obvious instead of a silent hang. code 200 = working; 401 = wrong/missing FIREBASE_SECRET; a long
 * ms with an error = wrong FIREBASE_URL (unreachable host).
 */
/**
 * Run this ONCE from the Apps Script editor (pick it in the toolbar dropdown → Run) to grant the
 * project permission to make external web requests, which it needs to push to Firebase. It does NOT
 * catch the error on purpose, so the "Authorization required" dialog appears — approve it and you're
 * done. (firebaseTest catches its error, which is why running THAT never prompted.)
 */
function authorizeExternal() {
  return UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true }).getResponseCode();
}

function firebaseTest() {
  var base = firebaseBase();
  if (!base) return { ok: false, reason: 'FIREBASE_URL script property is not set on the server' };
  var secret = PropertiesService.getScriptProperties().getProperty('FIREBASE_SECRET') || '';
  var host = base.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  var started = Date.now();
  try {
    var res = UrlFetchApp.fetch(firebaseUrl(secret, '_diag'),
      { method: 'put', contentType: 'application/json', payload: JSON.stringify({ at: new Date().toISOString() }), muteHttpExceptions: true });
    var code = res.getResponseCode();
    return { ok: code < 300, code: code, ms: Date.now() - started, host: host, secret_set: !!secret,
      response: String(res.getContentText()).slice(0, 300) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, host: host, secret_set: !!secret, error: String(e && e.message || e) };
  }
}

// written to the sheet right away (everything else waits for save_every_s; the cache always has the latest)
var IMPORTANT = { level: 1, death: 1, teleport: 1 };

/** One game step for a player: catch the world up, run their action (if any), report back. */
function step(token, action, since) {
  var live = null;                                           // what to push to Firebase, sent after the lock is released
  var result = withLock(function () {
    var content = getContent(), p = requirePlayer(token), ws = getWorld(), now = Date.now();
    ws.presence = ws.presence || {};
    Object.keys(ws.presence).forEach(function (t) { if (now - ws.presence[t].t > 60000) delete ws.presence[t]; });
    function onMap(mapId) {
      var list = [p];
      Object.keys(ws.presence).forEach(function (t) {
        if (t === token || ws.presence[t].map !== mapId) return;
        try { list.push(requirePlayer(t)); } catch (e) { delete ws.presence[t]; }
      });
      return list;
    }
    var startMap = p.map, players = onMap(p.map), ev = [];
    World.advance(content, ws, p.map, players, now, Math.random, ev);
    if (action) ev = ev.concat(World.act(content, ws, p, action, now, Math.random, players));
    ws.presence[token] = { map: p.map, t: now };
    if (p.map !== startMap) { players = onMap(p.map); World.advance(content, ws, p.map, players, now, Math.random, ev); }
    World.record(ws, ev);
    var force = ev.some(function (e) { return IMPORTANT[e.type] && (!e.to || e.to === p.id); });
    savePlayer(p, force, content);
    players.forEach(function (q) { if (q !== p) savePlayer(q, false, content); });
    saveWorld(ws, false);
    if (firebaseBase()) live = { map: p.map, view: firebaseView(content, ws, p.map, players) };
    return { player: World.publicPlayer(content, p), world: World.view(content, ws, p.map, p, players),
      events: World.eventsFor(ws, since, p), seq: ws.seq };
  });
  if (live) pushWorld(live.map, live.view);                  // outside the lock: the HTTP write must not block other players
  return result;
}

/** Run once from the editor to check the setup: reads both spreadsheets and logs a summary. */
function checkSetup() {
  var content = Content.build(readTables());
  Logger.log('Maps: ' + Object.keys(content.maps).join(', '));
  Logger.log('Terrain: ' + Object.keys(content.terrain).length + ', Objects: ' + Object.keys(content.objects).length);
  Logger.log('Items: ' + Object.keys(content.items).length + ', Monsters: ' + Object.keys(content.monsters).length);
  Logger.log('Players tab columns: ' + Object.keys(headerIndex(playersSheet())).join(', '));
  clearContentCache();
  Logger.log('Setup looks good.');
}

// ---------------------------------------------------------------- editor

var EDITABLE_TABS = ['Config', 'Tilesets', 'Autotile', 'Terrain', 'Kinds', 'Objects', 'Items', 'Monsters',
  'LootTables', 'Classes', 'Levels', 'Skills', 'Statuses'];

function requireEditor(key) {
  var want = PropertiesService.getScriptProperties().getProperty('EDITOR_KEY');
  if (!want) throw new Error('Saving from the editor is off: set the EDITOR_KEY script property (see docs/SETUP.md)');
  if (!key || key !== want) throw new Error('wrong editor key');
}

function gameData() { return SpreadsheetApp.openById(prop('GAME_DATA_ID')); }

/** Writes records into a sheet by header name, keeping any extra columns the sheet has. */
function writeRecords(sh, records, keepRow) {
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  // add columns the records have but the sheet doesn't
  records.forEach(function (r) { Object.keys(r).forEach(function (k) { if (k && head.indexOf(k) < 0) head.push(k); }); });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  var existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues() : [];
  var kept = keepRow ? existing.filter(function (row) {
    return row.some(function (v) { return v !== '' && v != null; }) && keepRow(row, head);
  }) : [];
  var rows = kept.concat(records.map(function (r) { return head.map(function (h) { return r[h] == null ? '' : r[h]; }); }));
  if (existing.length) sh.getRange(2, 1, existing.length, head.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  return rows.length;
}

function readTab(name) {
  var sh = gameData().getSheetByName(name);
  return sh ? Content.recordsFromValues(sh.getDataRange().getValues()) : [];
}
/**
 * The editor sends the fingerprint of what it loaded (base). If the sheet changed since then
 * (someone edited it by hand), saving would silently throw that away, so refuse unless forced.
 */
function conflictCheck(current, base, force, what) {
  if (!base || force || current === base) return;
  var e = new Error(what + ' was changed in the spreadsheet after the editor loaded it.');
  e.conflict = true;
  throw e;
}

function validMapId(id) {
  if (!/^[A-Za-z0-9_\-]{1,40}$/.test(String(id || ''))) throw new Error('bad map id');
  return String(id);
}

function saveMap(map, entities, base, force) {
  var id = validMapId(map && map.id);
  var grid = typeof map.terrain === 'string' ? JSON.parse(map.terrain) : map.terrain;
  if (!Array.isArray(grid) || !grid.length) throw new Error('map has no terrain');
  var row = { id: id, name: String(map.name || id), width: grid[0].length, height: grid.length,
    terrain: JSON.stringify(grid), notes: map.notes == null ? '' : map.notes };
  if (row.terrain.length > 49000) throw new Error('map too big for one cell (' + row.terrain.length + ' characters)');
  var ents = (entities || []).map(function (e) {
    return { map: id, key: String(e.key), x: Number(e.x), y: Number(e.y), ref: String(e.ref),
      data: typeof e.data === 'string' ? e.data : (e.data && Object.keys(e.data).length ? JSON.stringify(e.data) : '') };
  });
  return withLock(function () {
    var ss = gameData();
    conflictCheck(Content.mapHash({ Maps: readTab('Maps'), MapEntities: readTab('MapEntities') }, id), base, force, 'Map ' + id);
    writeRecords(ss.getSheetByName('Maps'), [row], function (r, head) { return String(r[head.indexOf('id')]) !== id; });
    writeRecords(ss.getSheetByName('MapEntities'), ents, function (r, head) { return String(r[head.indexOf('map')]) !== id; });
    clearContentCache();
    return { ok: true, map: id, entities: ents.length, hash: Content.mapHash({ Maps: readTab('Maps'), MapEntities: readTab('MapEntities') }, id) };
  });
}

function deleteMap(id) {
  id = validMapId(id);
  return withLock(function () {
    var ss = gameData();
    writeRecords(ss.getSheetByName('Maps'), [], function (r, head) { return String(r[head.indexOf('id')]) !== id; });
    writeRecords(ss.getSheetByName('MapEntities'), [], function (r, head) { return String(r[head.indexOf('map')]) !== id; });
    clearContentCache();
    return { ok: true, deleted: id };
  });
}

function saveTab(tab, rows, base, force) {
  if (EDITABLE_TABS.indexOf(tab) < 0) throw new Error('tab ' + tab + ' cannot be saved from the editor');
  if (!Array.isArray(rows)) throw new Error('rows must be a list');
  return withLock(function () {
    var sh = gameData().getSheetByName(tab);
    if (!sh) throw new Error('Game Data has no ' + tab + ' tab');
    conflictCheck(Content.hash(readTab(tab)), base, force, 'The ' + tab + ' tab');
    var n = writeRecords(sh, rows, null);
    clearContentCache();
    return { ok: true, tab: tab, rows: n, hash: Content.hash(readTab(tab)) };
  });
}
