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
  Offline.prototype.save = function () { store(OFFLINE_KEY, { player: this.p, world: this.ws }); };
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
  Offline.prototype.forget = function () { localStorage.removeItem(OFFLINE_KEY); localStorage.removeItem(OLD_OFFLINE_KEY); };

  // ---------- online ----------
  function Online(url) { this.mode = 'online'; this.url = url; }
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
    var token = store(TOKEN_KEY);
    if (!token) return Promise.resolve(null);
    this.token = token;
    return this.call({ action: 'load', token: token }).catch(function () { return null; });
  };
  Online.prototype.join = function (name, cls) {
    return this.call({ action: 'join', name: name, 'class': cls }).then(function (r) {
      this.token = r.token; store(TOKEN_KEY, r.token);
      return this.call({ action: 'load', token: r.token });
    }.bind(this));
  };
  Online.prototype.act = function (action, since) { return this.call({ action: 'act', token: this.token, 'do': action, since: since }); };
  Online.prototype.poll = function (since) { return this.call({ action: 'poll', token: this.token, since: since }); };
  Online.prototype.warp = function () { return Promise.reject(new Error('Map jumping is offline-only')); };
  Online.prototype.leave = function () {
    if (this.token && navigator.sendBeacon) navigator.sendBeacon(this.url, JSON.stringify({ action: 'save', token: this.token }));
  };
  Online.prototype.forget = function () { localStorage.removeItem(TOKEN_KEY); };

  function create() { return GAME_CONFIG.API_URL ? new Online(GAME_CONFIG.API_URL) : new Offline(); }
  return { create: create };
})();
