/**
 * Game rules shared by the client (to predict moves instantly) and the server
 * (which has the final say). Anything that decides what is allowed lives here.
 */
var Rules = (function () {
  var DIRS = {
    N: { dx: 0, dy: -1, out: 'n', into: 's' },
    E: { dx: 1, dy: 0, out: 'e', into: 'w' },
    S: { dx: 0, dy: 1, out: 's', into: 'n' },
    W: { dx: -1, dy: 0, out: 'w', into: 'e' }
  };

  function entitiesAt(map, x, y) {
    if (!map._at) {
      map._at = {};
      map.entities.forEach(function (e) { (map._at[e.x + ',' + e.y] = map._at[e.x + ',' + e.y] || []).push(e); });
    }
    return map._at[x + ',' + y] || [];
  }

  function terrainAt(content, map, x, y) {
    var row = map.terrain[y];
    return row ? content.terrain[row[x]] : undefined;
  }

  /**
   * Can something at (x, y) on map step in direction dir? Returns {ok, x, y, reason}.
   * opts (optional): walkable(entity) overrides object walkability (e.g. an open door);
   *                  occupied(x, y) returns who stands there (a monster or player), which blocks.
   */
  function tryMove(content, map, x, y, dir, opts) {
    var d = DIRS[dir];
    if (!d) return { ok: false, x: x, y: y, reason: 'bad direction' };
    var nx = x + d.dx, ny = y + d.dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) return { ok: false, x: x, y: y, reason: 'edge' };
    var from = terrainAt(content, map, x, y), to = terrainAt(content, map, nx, ny);
    if (!to) return { ok: false, x: x, y: y, reason: 'no terrain' };
    if (from && !from.pass[d.out]) return { ok: false, x: x, y: y, reason: 'blocked side' };
    if (!to.pass[d.into]) return { ok: false, x: x, y: y, reason: 'blocked' };
    var ents = entitiesAt(map, nx, ny);
    for (var i = 0; i < ents.length; i++) {
      var o = content.objects[ents[i].ref];
      var walk = opts && opts.walkable ? opts.walkable(ents[i]) : !(o && !o.walkable);
      if (!walk) return { ok: false, x: x, y: y, reason: 'object', entity: ents[i].key, tx: nx, ty: ny };
    }
    if (opts && opts.occupied) {
      var who = opts.occupied(nx, ny);
      if (who) return { ok: false, x: x, y: y, reason: 'occupied', who: who, tx: nx, ty: ny };
    }
    return { ok: true, x: nx, y: ny };
  }

  /** Applies a list of directions to a player, in order. Turns always apply; steps only when allowed. */
  function applyMoves(content, player, dirs) {
    var map = content.maps[player.map];
    if (!map) return player;
    var p = { map: player.map, x: player.x, y: player.y, facing: player.facing || 'S' };
    (dirs || []).slice(0, 20).forEach(function (dir) {
      if (!DIRS[dir]) return;
      p.facing = dir;
      var r = tryMove(content, map, p.x, p.y, dir);
      if (r.ok) { p.x = r.x; p.y = r.y; }
    });
    return p;
  }

  /** Is (x, y) a cell a player may stand on? */
  function standable(content, map, x, y) {
    var t = terrainAt(content, map, x, y);
    if (!t || !(t.pass.n || t.pass.e || t.pass.s || t.pass.w)) return false;
    return !entitiesAt(map, x, y).some(function (e) {
      var o = content.objects[e.ref]; return o && !o.walkable;
    });
  }

  /** Nearest standable cell to (x, y), searching outward. */
  function nearestStandable(content, map, x, y) {
    for (var r = 0; r < Math.max(map.width, map.height); r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (standable(content, map, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
    return { x: x, y: y };
  }

  return { DIRS: DIRS, tryMove: tryMove, applyMoves: applyMoves, entitiesAt: entitiesAt,
    terrainAt: terrainAt, standable: standable, nearestStandable: nearestStandable };
})();
if (typeof module !== 'undefined') module.exports = Rules;
