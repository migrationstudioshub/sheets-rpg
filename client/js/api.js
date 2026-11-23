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
    // The Content Studio's draft wins over everything, so Play-test runs the real rules on your edits.
    var cdraft = (typeof ContentStore !== 'undefined') ? ContentStore.getDraft() : null;
    if (cdraft && Object.keys(cdraft).length) { this.usingDraft = true; return Promise.resolve(this.content = Content.build(cdraft)); }
    // Otherwise a draft saved by the map editor in this browser wins over the repository data.
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
    // Monsters following you by the stairs are on the floor you left: keep it moving while they come, then hand them over.
    if (p.wake && p.wake.map !== p.map && now < p.wake.until && c.maps[p.wake.map]) World.advance(c, ws, p.wake.map, [], now, Math.random, []);
    World.deliver(c, ws);
    World.advance(c, ws, p.map, [p], now, Math.random, ev);
    if (action) ev = ev.concat(World.act(c, ws, p, action, now, Math.random, [p]));
    if (p.map !== from) World.advance(c, ws, p.map, [p], now, Math.random, ev);
    World.advanceFloors(c, ws, p.map, null, now, Math.random, []);   // the rest of the building you are in stays alive
    World.deliver(c, ws);
    World.record(ws, ev);
    this.save();
    return Promise.resolve({ player: World.publicPlayer(c, p), world: World.view(c, ws, p.map, p, [p], p.map !== from || since === -1 ? -1 : this.structRev, null, since === -1 ? null : this.floorRevs),
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
  Offline.prototype.join = function (name, cls, look) {
    this.p = World.newPlayer(this.content, 'me', name, cls, look);
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
  Online.prototype.join = function (name, cls, look) {       // look = {hair, hairColor} from the character screen
    return this.call({ action: 'join', name: name, 'class': cls, body: look && look.body, skin: look && look.skin, hair: look && look.hair, hairColor: look && look.hairColor }).then(function (r) {
      this.token = r.token; store(this.tokenKey, r.token);
      return this.call({ action: 'load', token: r.token });
    }.bind(this));
  };
  // structRev: the revision of the map's structure layer (built / damaged / destroyed things) this client
  // already holds — set by the game after each answer — so the server only re-sends the layer when it changed.
  // at: the map the game believes you are on (set by the game after each answer), so the referee can read the
  // characters around you alongside your own. live: the map whose pushed view is arriving (watchMap), so the
  // referee leaves that map's monsters out of its answers — they are already here.
  Online.prototype.act = function (action, since) { return this.call({ action: 'act', token: this.token, 'do': action, since: since, structRev: this.structRev, floorRevs: this.floorRevs, at: this.at, live: this.liveMap || undefined }); };
  Online.prototype.poll = function (since) { return this.call({ action: 'poll', token: this.token, since: since, structRev: this.structRev, floorRevs: this.floorRevs, at: this.at, live: this.liveMap || undefined }); };
  /**
   * Listen for live updates to one map (monsters and players), pushed by the server through Firebase.
   * onWorld({map, now, seq, monsters, players, doors}) runs on every change. Returns a function that stops listening.
   * Does nothing (polling still works) if FIREBASE_URL is unset or the browser has no EventSource.
   *
   * The server writes the record piece by piece (functions/referee.js, pushView): only the monsters that changed
   * arrive, as changes to a copy of the record kept here; the world handed to onWorld is rebuilt from that copy.
   * main = this is the map you stand on: while its pushes are arriving, this.liveMap names it (see act / poll).
   */
  Online.prototype.watchMap = function (mapId, onWorld, main) {
    if (!GAME_CONFIG.FIREBASE_URL || typeof EventSource === 'undefined') return function () {};
    var self = this, url = GAME_CONFIG.FIREBASE_URL.replace(/\/+$/, '') + '/world/' + encodeURIComponent(mapId) + '.json';
    var es = new EventSource(url), copy = null, fixed = {};       // fixed: each monster's unchanging part, parsed once
    if (main) self.liveMap = '';
    function setAt(path, data, merge) {                           // one change to the copy: replace (put) or merge (patch) at a path
      var ks = String(path || '/').split('/').filter(Boolean);
      if (!ks.length && !merge) { copy = data; fixed = {}; return; }
      if (copy == null || typeof copy !== 'object') copy = {};
      if (merge) {                                                // a patch: each key is a child, or a path to one ("m/abc")
        Object.keys(data || {}).forEach(function (k) { setAt(ks.concat(k.split('/')).join('/'), data[k], false); });
        return;
      }
      var n = copy;
      for (var i = 0; i < ks.length - 1; i++) { if (n[ks[i]] == null || typeof n[ks[i]] !== 'object') n[ks[i]] = {}; n = n[ks[i]]; }
      if (data == null) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = data;
      if (ks[0] === 'd') delete fixed[ks[1]];
    }
    function world() {
      var w = { map: copy.map || mapId, now: copy.now, seq: copy.seq, doors: copy.doors, players: copy.players || [] };
      if (!copy.m && copy.monsters) { w.monsters = copy.monsters; return w; }   // a referee from before pushes came in pieces
      var m = copy.m || {}, d = copy.d || {};
      w.monsters = Object.keys(m).map(function (k) {
        var f = fixed[k];
        if (!f) { try { f = JSON.parse(d[k] || 'null'); } catch (e) { f = null; } if (f) fixed[k] = f; }
        if (!f) return null;                                      // its fixed part has not arrived yet: next change
        var q = String(m[k]).split(',');
        return { id: f.id, ref: f.ref, x: Number(q[0]), y: Number(q[1]), hp: Number(q[2]), maxHp: f.maxHp, facing: q[3] || 'S',
          statuses: q[4] ? q[4].split('|') : [], alert: Number(q[5]) || undefined, look: f.look || undefined };
      }).filter(Boolean);
      return w;
    }
    function handle(ev) {
      try {
        var msg = JSON.parse(ev.data);                 // Realtime DB streaming sends { path, data }
        if (!msg) return;
        setAt(msg.path, msg.data, ev.type === 'patch');
        if (copy == null || typeof copy !== 'object') { copy = null; return; }   // null = the node is empty (no one on this map yet)
        if (main) self.liveMap = mapId;
        onWorld(world());
      } catch (e) { /* keep-alive and auth-revoked frames aren't JSON we care about */ }
    }
    es.addEventListener('put', handle);
    es.addEventListener('patch', handle);
    es.onerror = function () { if (main && self.liveMap === mapId) self.liveMap = ''; };   // lost the stream: answers carry the monsters again until it is back
    return function () { es.close(); if (main && self.liveMap === mapId) self.liveMap = ''; };
  };
  /**
   * Listen for what players built or broke on every floor of one building (pushed by the server, only when it
   * changes). onFloor(floorId, {rev, json} | null) runs once per floor at the start and again on each change.
   */
  Online.prototype.watchStructs = function (groundId, onFloor) {
    if (!GAME_CONFIG.FIREBASE_URL || typeof EventSource === 'undefined') return function () {};
    var es = new EventSource(GAME_CONFIG.FIREBASE_URL.replace(/\/+$/, '') + '/world/' + encodeURIComponent('s~' + groundId) + '.json');
    function handle(ev) {
      try {
        var msg = JSON.parse(ev.data); if (!msg) return;
        if (msg.path === '/') Object.keys(msg.data || {}).forEach(function (id) { onFloor(id, msg.data[id]); });
        else if (/^\/[^/]+$/.test(msg.path)) onFloor(msg.path.slice(1), msg.data);
      } catch (e) { /* keep-alive frames */ }
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
  Functions.prototype.loadContent = function () {        // content now comes from the function (Firestore)
    return fetch(this.url + '?action=content').then(function (r) { return r.json(); })
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
  // The host runs a loop and keeps a socket open to each page (host/server.js, "the socket"): requests go up it
  // (the same bodies a POST carries, plus a number n the answer comes back with) and the changes of every turn come
  // down it unasked. this.pushed is true while it is open — the game then only asks now and then, to say it is
  // still there. With no socket (an older host, a browser without one) everything goes by POST, as it always did.
  // What the messages hold, and how they are cut down to what changed, is client/js/wire.js (both ends).
  Lan.prototype.call = function (body) {
    var s = this.sock, self = this;
    if (s && s.readyState === 1) {
      return new Promise(function (resolve, reject) {
        var n = self.n = (self.n || 0) + 1;
        self.waiting[n] = { resolve: resolve, reject: reject };
        s.send(JSON.stringify(Object.assign({ n: n }, body)));
      });
    }
    return fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return res; });
  };
  Lan.prototype.connect = function () {
    if (typeof WebSocket === 'undefined' || typeof location === 'undefined') return;
    var self = this, s;
    self.waiting = self.waiting || {};
    try { s = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/'); } catch (e) { return; }
    self.sock = s;
    function lost() {
      if (self.sock !== s) return;
      self.sock = null; self.pushed = false;
      var w = self.waiting; self.waiting = {};
      Object.keys(w).forEach(function (n) { w[n].reject(new Error('the connection to the host dropped')); });
      setTimeout(function () { self.connect(); }, 2000);
    }
    s.onclose = lost;
    s.onerror = function () { try { s.close(); } catch (e) { /* already closed */ } };
    var held = Wire.receiver();                              // what this socket has been sent so far (client/js/wire.js)
    s.onmessage = function (m) {
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (!msg) return;
      // A message carries only what changed since the last one on this socket: Wire.unpack puts it over what we
      // hold and hands back the whole answer, in the shape every backend gives.
      var whole = msg.now !== undefined && !msg.error ? Wire.unpack(held, msg) : null;
      if (msg.push) { if (whole && whole.player && self.onPush) self.onPush(whole); return; }
      var wait = self.waiting[msg.re];
      if (!wait) return;
      delete self.waiting[msg.re];
      if (msg.error) { wait.reject(new Error(msg.error)); return; }
      if (whole) self.pushed = true;                         // from here on the host sends changes unasked
      wait.resolve(whole || msg);
    };
  };
  Lan.prototype.loadContent = function () {
    this.connect();
    return fetch('/?action=content').then(function (r) { return r.json(); })
      .then(function (res) { if (res.error) throw new Error(res.error); return (this.content = res.content); }.bind(this));
  };
  Lan.prototype.watchMap = function () { return function () {}; };
  Lan.prototype.watchStructs = function () { return function () {}; };   // no Firebase on the LAN; poll sees others

  function create() {
    // Add ?offline to the URL to force offline mode (runs shared/world.js here against
    // data/tables.json), handy for play-testing changes before the server is updated.
    if (typeof location !== 'undefined' && /[?&]offline(\b|=)/.test(location.search)) return new Offline();
    if (typeof window !== 'undefined' && window.GAME_LAN) return new Lan();
    if (GAME_CONFIG.FUNCTIONS_URL) return new Functions(GAME_CONFIG.FUNCTIONS_URL);
    return new Offline();   // the referee is the Cloud Function; Apps Script is retired
  }
  return { create: create };
})();
