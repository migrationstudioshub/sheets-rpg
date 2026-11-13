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

  // Objects can be bigger than one tile. A placed object's footprint is w×h tiles (from its object's
  // footprintW/footprintH, default 1), anchored at the entity cell as the bottom-left corner and
  // reaching right and upward. blockersAt lists every entity whose footprint covers (x, y) — used for
  // collision, so a wide/tall object blocks its whole footprint, not just the one anchor tile. (entitiesAt
  // keeps anchor-only semantics, which is what interaction and targeting want.)
  function blockersAt(content, map, x, y) {
    if (!map._block) {
      map._block = {};
      map.entities.forEach(function (e) {
        var o = content.objects[e.ref];
        var w = Math.max(1, (o && o.footprintW) || 1), h = Math.max(1, (o && o.footprintH) || 1);
        for (var ax = e.x; ax < e.x + w; ax++)
          for (var ay = e.y; ay > e.y - h; ay--)
            (map._block[ax + ',' + ay] = map._block[ax + ',' + ay] || []).push(e);
      });
    }
    return map._block[x + ',' + y] || [];
  }

  // The terrain that governs a cell: the overlay terrain if one sits here, else the base. So a walkable
  // overlay (decorative grass) changes nothing, but a blocking overlay (water over ground) blocks.
  function terrainAt(content, map, x, y) {
    var ov = map.overlay && map.overlay[y] && map.overlay[y][x];
    if (ov && content.terrain[ov]) return content.terrain[ov];
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
    // Leaving the current cell: a walkable object here can block one of its edges (one-way).
    var hereObjs = blockersAt(content, map, x, y);
    for (var h = 0; h < hereObjs.length; h++) {
      var ho = content.objects[hereObjs[h].ref];
      var hwalk = opts && opts.walkable ? opts.walkable(hereObjs[h]) : !(ho && !ho.walkable);
      if (hwalk && ho && ho.pass && !ho.pass[d.out]) return { ok: false, x: x, y: y, reason: 'object side', entity: hereObjs[h].key };
    }
    var ents = blockersAt(content, map, nx, ny);
    for (var i = 0; i < ents.length; i++) {
      var o = content.objects[ents[i].ref];
      var walk = opts && opts.walkable ? opts.walkable(ents[i]) : !(o && !o.walkable);
      if (!walk) return { ok: false, x: x, y: y, reason: 'object', entity: ents[i].key, tx: nx, ty: ny };
      // Entering the target cell: a walkable object there can block the edge you'd come in through.
      if (o && o.pass && !o.pass[d.into]) return { ok: false, x: x, y: y, reason: 'object side', entity: ents[i].key, tx: nx, ty: ny };
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
    return !blockersAt(content, map, x, y).some(function (e) {
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

  return { DIRS: DIRS, tryMove: tryMove, applyMoves: applyMoves, entitiesAt: entitiesAt, blockersAt: blockersAt,
    terrainAt: terrainAt, standable: standable, nearestStandable: nearestStandable };
})();
if (typeof module !== 'undefined') module.exports = Rules;
