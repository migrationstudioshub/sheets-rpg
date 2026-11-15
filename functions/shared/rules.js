// GENERATED from shared/rules.js by tools/sync_server.sh. Edit the original, not this copy.
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

  // ------------------------------------------------------------ edge walls
  // Walls live on cell boundaries (grid lines), not tiles. A map carries two grids of "styleId:height"
  // tokens ('' = no wall): hWalls (horizontal lines, hWalls[y][x] = north edge of cell x,y; height+1 rows)
  // and vWalls (vertical lines, vWalls[y][x] = west edge of cell x,y; width+1 cols). Collision and sight
  // consult these so client prediction and the server agree. Height is purely visual (see render.js).
  function parseWall(tok) {
    if (!tok) return null;
    var s = String(tok), i = s.indexOf(':');
    if (i < 0) return { style: s, height: 1 };
    return { style: s.slice(0, i), height: Math.max(1, parseInt(s.slice(i + 1), 10) || 1) };
  }
  function wallAt(map, orient, x, y) {
    var grid = orient === 'h' ? map.hWalls : map.vWalls;
    var row = grid && grid[y];
    return (row && row[x]) || '';
  }
  // The edge crossed when leaving (x, y) in direction dir: {orient, x, y} into the matching wall grid.
  function wallEdge(x, y, dir) {
    if (dir === 'N') return { orient: 'h', x: x, y: y };
    if (dir === 'S') return { orient: 'h', x: x, y: y + 1 };
    if (dir === 'W') return { orient: 'v', x: x, y: y };
    if (dir === 'E') return { orient: 'v', x: x + 1, y: y };
    return null;
  }
  function wallBetween(map, x, y, dir) {
    var e = wallEdge(x, y, dir);
    return e ? wallAt(map, e.orient, e.x, e.y) : '';
  }
  // The wall token on the shared edge of two orthogonally-adjacent cells ('' if none / not adjacent).
  function wallBetweenCells(map, ax, ay, bx, by) {
    if (ax === bx && Math.abs(ay - by) === 1) return wallAt(map, 'h', ax, Math.max(ay, by));
    if (ay === by && Math.abs(ax - bx) === 1) return wallAt(map, 'v', Math.max(ax, bx), ay);
    return '';
  }
  function wallStyleOf(content, tok) {
    var p = parseWall(tok);
    return p && content.wallStyles ? content.wallStyles[p.style] : null;
  }
  // An unknown style still blocks (safer); a known style blocks unless its flag is explicitly off.
  function wallBlocksMove(content, tok) {
    if (!tok) return false;
    var s = wallStyleOf(content, tok);
    return s ? s.blocksMove !== false : true;
  }
  function wallBlocksSight(content, tok) {
    if (!tok) return false;
    var s = wallStyleOf(content, tok);
    return s ? s.blocksSight !== false : true;
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
    // Edge wall on the boundary blocks the step; a door on that edge overrides it (open = pass, closed = block).
    // map._doorEdges is a transient overlay the world sets each action/tick (keyed 'h'/'v' + x + ',' + y).
    var dEdge = wallEdge(x, y, dir), de = map._doorEdges;
    var door = dEdge && de ? de[dEdge.orient + dEdge.x + ',' + dEdge.y] : null;
    if (door ? door === 'closed' : wallBlocksMove(content, wallBetween(map, x, y, dir))) return { ok: false, x: x, y: y, reason: door ? 'door' : 'wall' };
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
    terrainAt: terrainAt, standable: standable, nearestStandable: nearestStandable,
    parseWall: parseWall, wallAt: wallAt, wallEdge: wallEdge, wallBetween: wallBetween, wallBetweenCells: wallBetweenCells,
    wallStyleOf: wallStyleOf, wallBlocksMove: wallBlocksMove, wallBlocksSight: wallBlocksSight };
})();
if (typeof module !== 'undefined') module.exports = Rules;
