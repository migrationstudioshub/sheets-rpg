/**
 * Talks to the server. Two interchangeable backends with the same methods; every
 * call answers { player, world, events, seq }.
 *   Offline: runs shared/world.js right here, saves in this browser (localStorage).
 *   Online:  the Apps Script web app runs the same shared/world.js and has the final say.
 */
var Api = (function () {
  var TOKEN_KEY = 'sheetsrpg.token', OFFLINE_KEY = 'sheetsrpg.offline', OLD_OFFLINE_KEY = 'sheetsrpg.offlinePlayer';

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { return null; }
  }

  // ---------- offline ----------
  function Offline() { this.mode = 'offline'; }
  Offline.prototype.loadContent = function () {
    // A draft saved by the map editor in this browser wins over the repository data, so you can play-test edits.
    // A draft made from older data (missing newer maps, monsters...) is ignored, and the game says so.
    var draft = store('sheetsrpg.editorDraft');
    return fetch(GAME_CONFIG.OFFLINE_TABLES, { cache: 'no-cache' }).then(function (r) { return r.json(); })
      .then(function (repo) {
        this.usingDraft = !!draft && draft._version === repo._version;
        this.staleDraft = !!draft && !this.usingDraft;
        return (this.content = Content.build(this.usingDraft ? draft : repo));
      }.bind(this));
  };
  Offline.prototype.save = function () { if (this.p) store(OFFLINE_KEY, { player: this.p, world: this.ws }); };
  Offline.prototype.step = function (action, since) {
    var c = this.content, p = this.p, ws = this.ws, now = Date.now(), ev = [], from = p.map;
    World.advance(c, ws, p.map, [p], now, Math.random, ev);
    if (action) ev = ev.concat(World.act(c, ws, p, action, now, Math.random, [p]));
    if (p.map !== from) World.advance(c, ws, p.map, [p], now, Math.random, ev);
    World.record(ws, ev);
    this.save();
    return Promise.resolve({ player: World.publicPlayer(c, p), world: World.view(c, ws, p.map, p, [p]),
      events: World.eventsFor(ws, since, p), seq: ws.seq });
  };
  Offline.prototype.resume = function () {
    var saved = store(OFFLINE_KEY), old = store(OLD_OFFLINE_KEY);
    if (!saved && old) saved = { player: { id: 'me', name: old.name, map: old.map, x: old.x, y: old.y, facing: old.facing }, world: {} };
    if (!saved || !saved.player) return Promise.resolve(null);
    this.p = World.normalize(this.content, saved.player);
    this.ws = saved.world || {};
    return this.step(null, -1);
  };
  Offline.prototype.join = function (name, cls) {
    this.p = World.newPlayer(this.content, 'me', name, cls);
    this.ws = (store(OFFLINE_KEY) || {}).world || {};
    return this.step(null, -1);
  };
  Offline.prototype.act = function (action, since) { return this.step(action, since); };
  Offline.prototype.poll = function (since) { return this.step(null, since); };
  Offline.prototype.warp = function (mapId) {
    var map = this.content.maps[mapId];
    var at = Rules.nearestStandable(this.content, map, Math.floor(map.width / 2), Math.floor(map.height / 2));
    this.p.map = mapId; this.p.x = at.x; this.p.y = at.y;
    return this.step(null, -1);
  };
  Offline.prototype.leave = function () { if (this.p) this.save(); };
  // drop the in-memory player too, so a save on reload/pagehide can't resurrect the character we just forgot
  Offline.prototype.forget = function () { this.p = null; localStorage.removeItem(OFFLINE_KEY); localStorage.removeItem(OLD_OFFLINE_KEY); };

  // ---------- online ----------
  function Online(url) { this.mode = 'online'; this.url = url; this.tokenKey = TOKEN_KEY; }
  Online.prototype.call = function (body) {
    // text/plain keeps this a "simple" request, which Apps Script web apps accept cross-origin
    return fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  };
  Online.prototype.loadContent = function () {
    return fetch(this.url + '?action=content').then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return (this.content = res.content); }.bind(this));
  };
  Online.prototype.resume = function () {
    var token = store(this.tokenKey);
    if (!token) return Promise.resolve(null);
    this.token = token;
    return this.call({ action: 'load', token: token }).catch(function () { return null; });
  };
  Online.prototype.join = function (name, cls) {
    return this.call({ action: 'join', name: name, 'class': cls }).then(function (r) {
      this.token = r.token; store(this.tokenKey, r.token);
      return this.call({ action: 'load', token: r.token });
    }.bind(this));
  };
  Online.prototype.act = function (action, since) { return this.call({ action: 'act', token: this.token, 'do': action, since: since }); };
  Online.prototype.poll = function (since) { return this.call({ action: 'poll', token: this.token, since: since }); };
  /**
   * Listen for live updates to one map (monsters and players), pushed by the server through Firebase.
   * onWorld({map, now, seq, monsters, players}) runs on every change. Returns a function that stops listening.
   * Does nothing (polling still works) if FIREBASE_URL is unset or the browser has no EventSource.
   */
  Online.prototype.watchMap = function (mapId, onWorld) {
    if (!GAME_CONFIG.FIREBASE_URL || typeof EventSource === 'undefined') return function () {};
    var url = GAME_CONFIG.FIREBASE_URL.replace(/\/+$/, '') + '/world/' + encodeURIComponent(mapId) + '.json';
    var es = new EventSource(url);
    function handle(ev) {
      try {
        var msg = JSON.parse(ev.data);                 // Realtime DB streaming sends { path, data }
        if (!msg || msg.data == null) return;          // null = the node is empty (no one on this map yet)
        if (msg.path === '/') onWorld(msg.data);        // we always PUT the whole node, so the change arrives at '/'
      } catch (e) { /* keep-alive and auth-revoked frames aren't JSON we care about */ }
    }
    es.addEventListener('put', handle);
    es.addEventListener('patch', handle);
    return function () { es.close(); };
  };
  Online.prototype.warp = function () { return Promise.reject(new Error('Map jumping is offline-only')); };
  Online.prototype.leave = function () {
    if (this.token && navigator.sendBeacon) navigator.sendBeacon(this.url, JSON.stringify({ action: 'save', token: this.token }));
  };
  Online.prototype.forget = function () { localStorage.removeItem(this.tokenKey); };

  // ---------- fast referee (Cloud Functions) ----------
  // Same protocol as Online, but live play goes to a Firebase Cloud Function (~300 ms) instead of
  // Apps Script (~1.5 s). Content still comes from Apps Script; the live world still comes over
  // Firebase (watchMap, inherited). Enabled by GAME_CONFIG.FUNCTIONS_URL.
  function Functions(url) { Online.call(this, url); }
  Functions.prototype = Object.create(Online.prototype);
  Functions.prototype.constructor = Functions;
  Functions.prototype.call = function (body) {
    return fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  };
  Functions.prototype.loadContent = function () {        // content still lives in the Game Data sheet
    return fetch(GAME_CONFIG.API_URL + '?action=content').then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return (this.content = res.content); }.bind(this));
  };

  // ---------- LAN host (same room / same WiFi) ----------
  // Served by host/server.js: one player's computer is the referee. Same protocol as Online, but
  // same-origin JSON and no Firebase — the host is right there on the network, so we just poll fast
  // (mode 'lan' keeps the game loop on the quick 250 ms poll, not the Firebase heartbeat). Activated
  // only by window.GAME_LAN, which the host injects into the page it serves; the live site never sets it.
  function Lan() { Online.call(this, ''); this.mode = 'lan'; this.tokenKey = 'sheetsrpg.lanToken'; }
  Lan.prototype = Object.create(Online.prototype);
  Lan.prototype.constructor = Lan;
  Lan.prototype.call = function (body) {
    return fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  };
  Lan.prototype.loadContent = function () {
    return fetch('/?action=content').then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return (this.content = res.content); }.bind(this));
  };
  Lan.prototype.watchMap = function () { return function () {}; };   // no Firebase on the LAN; poll sees others

  function create() {
    // Add ?offline to the URL to force offline mode (runs shared/world.js here against
    // data/tables.json), handy for play-testing changes before the server is updated.
    if (typeof location !== 'undefined' && /[?&]offline(\b|=)/.test(location.search)) return new Offline();
    if (typeof window !== 'undefined' && window.GAME_LAN) return new Lan();
    if (GAME_CONFIG.FUNCTIONS_URL) return new Functions(GAME_CONFIG.FUNCTIONS_URL);
    return GAME_CONFIG.API_URL ? new Online(GAME_CONFIG.API_URL) : new Offline();
  }
  return { create: create };
})();
