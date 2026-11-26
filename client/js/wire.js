/**
 * What travels on the host's socket (host/server.js ⇄ client/js/api.js), both ends in one file so they cannot drift:
 * the host calls Wire.pack, the page Wire.unpack. A classic script, also loaded by Node (the host, tools/bots.js).
 *
 * The idea: a socket delivers everything, in order — so each end can keep what the other already has, and a message
 * need only carry what differs. For one connection the host remembers what it sent (a `state` from Wire.sender()),
 * the page what it holds (Wire.receiver()). A message is JSON:
 *
 *   { re: n | push: 1,      an answer to request n, or sent unasked after a turn of the loop
 *     full: 1,              forget what you hold first (the first message, and every `load`)
 *     now, seq,             the host's clock, and how many events there have been
 *     player: {key: value}, your own character: the fields that changed (null = that field is gone)
 *     world: {key: value},  the parts of the view that changed (null = gone); never monsters / players / floors
 *     mf: {id: {...}},      monsters: the part that stays (id, ref, maxHp, look) — once, when one comes into range
 *     mo: {id: [x, y, hp, facing, [statuses], alert]},   monsters: where they are now — only the ones that changed
 *     mx: [id, ...],        monsters that are gone (dead, or out of range)
 *     pf, po, px            the other players, the same three ways (po: [x, y, facing, hp, act, wst, sn])
 *     fl: {floorId: {world, mf, mo, mx, pf, po, px}},    the other floors of the building, each the same way
 *     flx: [floorId, ...],  floors that are no longer told about
 *     events: [...] }       what happened, each told once
 *
 * "In range": the host leaves out monsters and players too far from you to matter (host/server.js, interest).
 */
var Wire = (function () {
  var MON_STAYS = ['id', 'ref', 'maxHp', 'look'];
  var PLY_MOVES = ['x', 'y', 'facing', 'hp', 'act', 'wst', 'sn'];
  var APART = { now: 1, monsters: 1, players: 1, floors: 1 };      // parts of a view that do not go in `world`

  // ---------------------------------------------------------------- the host's end
  function scope() { return { sent: {}, mon: {}, ply: {} }; }
  function sender() { return { main: scope(), floors: {}, me: {}, started: false }; }
  function pick(o, keys) { var out = {}; keys.forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; }); return out; }
  function monStays(m) { return JSON.stringify(pick(m, MON_STAYS)); }
  function monMoves(m) { return JSON.stringify([m.x, m.y, m.hp, m.facing || 'S', m.statuses || [], m.alert || 0]); }
  function plyStays(q) { var o = {}; Object.keys(q).forEach(function (k) { if (PLY_MOVES.indexOf(k) < 0) o[k] = q[k]; }); return JSON.stringify(o); }
  function plyMoves(q) { return JSON.stringify(PLY_MOVES.map(function (k) { return q[k] === undefined ? '' : q[k]; })); }
  /** An object against what was sent of it, key by key: '"k":json,...' of the keys that differ (null = gone), or ''. */
  function keyParts(sent, obj, skip) {
    var parts = [], seen = {};
    Object.keys(obj || {}).forEach(function (k) {
      if (skip && skip[k]) return;
      var j = JSON.stringify(obj[k]);
      if (j === undefined) return;
      seen[k] = true;
      if (sent[k] !== j) { sent[k] = j; parts.push(JSON.stringify(k) + ':' + j); }
    });
    Object.keys(sent).forEach(function (k) { if (!seen[k]) { delete sent[k]; parts.push(JSON.stringify(k) + ':null'); } });
    return parts.join(',');
  }
  /** One list (monsters or players) against what this connection was sent: the three parts of the message, as text. */
  function listParts(known, list, staysOf, movesOf, names) {
    var stays = [], moves = [], gone = [], seen = {}, out = '';
    (list || []).forEach(function (e) {
      var id = String(e.id), k = known[id] || (known[id] = { s: '', m: '' }), s = staysOf(e), m = movesOf(e);
      seen[id] = true;
      if (k.s !== s) { k.s = s; stays.push(JSON.stringify(id) + ':' + s); }
      if (k.m !== m) { k.m = m; moves.push(JSON.stringify(id) + ':' + m); }
    });
    Object.keys(known).forEach(function (id) { if (!seen[id]) { delete known[id]; gone.push(id); } });
    if (stays.length) out += ',"' + names[0] + '":{' + stays.join(',') + '}';
    if (moves.length) out += ',"' + names[1] + '":{' + moves.join(',') + '}';
    if (gone.length) out += ',"' + names[2] + '":' + JSON.stringify(gone);
    return out;
  }
  /** A view (the map you are on, or another floor of the building) against what was sent of it: ',"world":{…},"mf":…' or ''. */
  function scopeParts(sc, w) {
    var keys = keyParts(sc.sent, w, APART);
    return (keys ? ',"world":{' + keys + '}' : '') +
      listParts(sc.mon, w.monsters, monStays, monMoves, ['mf', 'mo', 'mx']) +
      listParts(sc.ply, w.players, plyStays, plyMoves, ['pf', 'po', 'px']);
  }
  /**
   * The text of one message, or '' when it would say nothing (only for a push: an answer is always sent).
   * o = { re: n } or { push: true }; full; player (the public player); world (a World.view, with its monsters and
   * players already cut down to the ones in range); events; seq.
   */
  function pack(state, o) {
    var full = o.full || !state.started;
    if (full) { state.main = scope(); state.floors = {}; state.me = {}; }
    state.started = true;
    var w = o.world || {}, body = '';
    var mine = keyParts(state.me, o.player);
    if (mine) body += ',"player":{' + mine + '}';
    body += scopeParts(state.main, w);
    var fl = [], flx = [], floors = w.floors || {};
    Object.keys(floors).forEach(function (id) {
      var part = scopeParts(state.floors[id] || (state.floors[id] = scope()), floors[id]);
      if (part) fl.push(JSON.stringify(id) + ':{' + part.slice(1) + '}');
    });
    Object.keys(state.floors).forEach(function (id) { if (!floors[id]) { delete state.floors[id]; flx.push(id); } });
    if (fl.length) body += ',"fl":{' + fl.join(',') + '}';
    if (flx.length) body += ',"flx":' + JSON.stringify(flx);
    if (o.events && o.events.length) body += ',"events":' + JSON.stringify(o.events);
    if (o.push && !body) return '';
    return '{' + (o.push ? '"push":1' : '"re":' + JSON.stringify(o.re === undefined ? null : o.re)) + (full ? ',"full":1' : '') +
      ',"now":' + (w.now || 0) + ',"seq":' + (o.seq || 0) + body + '}';
  }

  // ---------------------------------------------------------------- the page's end
  function held() { return { keys: {}, mon: {}, ply: {} }; }
  function receiver() { return { main: held(), floors: {}, player: null, started: false }; }
  function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
  function putKeys(into, d) {
    var out = Object.assign({}, into);
    Object.keys(d || {}).forEach(function (k) { if (d[k] === null) delete out[k]; else out[k] = d[k]; });
    return out;
  }
  // (a changed monster or player becomes a NEW object: the game may still be holding, or have altered, the old one)
  function takeScope(h, part) {
    h.keys = putKeys(h.keys, part.world);
    Object.keys(part.mf || {}).forEach(function (id) { h.mon[id] = Object.assign({}, h.mon[id], part.mf[id]); });
    Object.keys(part.mo || {}).forEach(function (id) {
      var q = part.mo[id];
      h.mon[id] = Object.assign({}, h.mon[id], { x: q[0], y: q[1], hp: q[2], facing: q[3], statuses: q[4] || [], alert: q[5] || undefined });
    });
    (part.mx || []).forEach(function (id) { delete h.mon[id]; });
    Object.keys(part.pf || {}).forEach(function (id) { h.ply[id] = Object.assign({}, h.ply[id], part.pf[id]); });
    Object.keys(part.po || {}).forEach(function (id) {
      var q = part.po[id], moved = {};
      PLY_MOVES.forEach(function (k, i) { moved[k] = q[i]; });
      h.ply[id] = Object.assign({}, h.ply[id], moved);
    });
    (part.px || []).forEach(function (id) { delete h.ply[id]; });
  }
  function whole(h) { return Object.assign({}, h.keys, { monsters: values(h.mon), players: values(h.ply) }); }
  /** Take one message: what the page now holds, in the shape every backend answers with — { player, world, events, seq }. */
  function unpack(state, msg) {
    if (msg.full || !state.started) { state.main = held(); state.floors = {}; state.player = null; }
    state.started = true;
    takeScope(state.main, msg);
    Object.keys(msg.fl || {}).forEach(function (id) { takeScope(state.floors[id] || (state.floors[id] = held()), msg.fl[id]); });
    (msg.flx || []).forEach(function (id) { delete state.floors[id]; });
    if (msg.player) state.player = putKeys(state.player || {}, msg.player);
    var w = whole(state.main), ids = Object.keys(state.floors);
    w.now = msg.now;
    if (ids.length) { w.floors = {}; ids.forEach(function (id) { w.floors[id] = whole(state.floors[id]); }); }
    // a structure layer travels once: told now, it is not handed over again with every later message
    if (state.main.keys.struct) { state.main.keys = Object.assign({}, state.main.keys); delete state.main.keys.struct; }
    ids.forEach(function (id) { var k = state.floors[id].keys; if (k.struct) { k = state.floors[id].keys = Object.assign({}, k); delete k.struct; } });
    return { player: state.player, world: w, events: msg.events || [], seq: msg.seq };
  }

  return { sender: sender, pack: pack, receiver: receiver, unpack: unpack };
})();
if (typeof module !== 'undefined') module.exports = Wire;
