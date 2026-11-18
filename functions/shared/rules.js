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
  // Diagonal steps. DIRS stays the four straight ones (facing, walls and "next to" are all four-way); a diagonal is
  // only ever a way to MOVE, made of the two straight steps a and b, and allowed only when both ways round the
  // corner are open (see tryDiag). It covers ~1.4 tiles, so it costs 1.4 steps of time.
  var DIAG = {
    NE: { dx: 1, dy: -1, a: 'N', b: 'E' }, SE: { dx: 1, dy: 1, a: 'S', b: 'E' },
    SW: { dx: -1, dy: 1, a: 'S', b: 'W' }, NW: { dx: -1, dy: -1, a: 'N', b: 'W' }
  };
  var DIAG_COST = 1.4;
  function isDir(dir) { return !!(DIRS[dir] || DIAG[dir]); }
  function stepCost(dir) { return DIAG[dir] ? DIAG_COST : 1; }
  /** Which of the four ways a character faces after stepping dir: a diagonal keeps a facing it already agrees with, else looks sideways. */
  function faceFor(dir, cur) { var g = DIAG[dir]; if (!g) return dir; return cur === g.a || cur === g.b ? cur : g.b; }

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
  // Every wall is WALL_H tiles high — one storey. A floor of a building is drawn that much higher than the one
  // below (docs/FLOORS.md). Wall tokens still read "style:height[:side]", but the number is ignored: a low wall
  // is not a wall with a small number, it is an object (a fence, a gate).
  var WALL_H = 2;
  function parseWall(tok) {
    if (!tok) return null;
    var s = String(tok), i = s.indexOf(':');
    return { style: i < 0 ? s : s.slice(0, i), height: WALL_H };
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

  // THE edge question. Does the grid-line edge (orient 'h'|'v', x, y) block `what` ('move' | 'sight')?
  // An opening fixture on the edge (door / window / archway) overrides the wall under it: map._edgeOv is a
  // transient overlay {key: {move, sight}} (true = blocked) that World.syncEdges rebuilds from the current
  // door states. Everything — walking, line of sight, shots, visibility — asks this one function.
  function edgeKey(orient, x, y) { return orient + x + ',' + y; }
  // A window is a PEEK opening (ov.peek): it only passes sight for a viewer standing right at it — in one of
  // the two cells the window's edge separates — and only along a narrow cone straight out from the window:
  // a target may sit one cell off the window's line per PEEK_SLOPE cells of distance. `from` = the viewer's
  // cell and what they look at, {x, y, tx, ty}; without it a window is opaque.
  var PEEK_SLOPE = 4;
  function edgeBlocked(content, map, orient, x, y, what, from) {
    var ov = map._edgeOv && map._edgeOv[edgeKey(orient, x, y)];
    if (ov && what === 'sight' && ov.peek) {
      if (!from) return true;
      var at = orient === 'h' ? from.x === x && (from.y === y || from.y === y - 1)
                              : from.y === y && (from.x === x || from.x === x - 1);
      if (!at) return true;
      if (from.tx == null) return false;
      var off = orient === 'h' ? Math.abs(from.tx - x) : Math.abs(from.ty - y);          // sideways from the window's line
      var out = orient === 'h' ? Math.abs(from.ty - from.y) : Math.abs(from.tx - from.x); // distance straight out
      return off * PEEK_SLOPE > out;
    }
    if (ov) return what === 'sight' ? ov.sight : ov.move;
    var tok = wallAt(map, orient, x, y);
    return what === 'sight' ? wallBlocksSight(content, tok) : wallBlocksMove(content, tok);
  }
  // The edge shared by two orthogonally-adjacent cells, as {orient, x, y} (null if not adjacent).
  function sharedEdge(ax, ay, bx, by) {
    if (ax === bx && Math.abs(ay - by) === 1) return { orient: 'h', x: ax, y: Math.max(ay, by) };
    if (ay === by && Math.abs(ax - bx) === 1) return { orient: 'v', x: Math.max(ax, bx), y: ay };
    return null;
  }
  function blockedBetween(content, map, ax, ay, bx, by, what, from) {
    var e = sharedEdge(ax, ay, bx, by);
    return e ? edgeBlocked(content, map, e.orient, e.x, e.y, what, from) : false;
  }

  /**
   * Is reaching from cell A to a NEIGHBOURING cell B (to use or hit what is there) stopped by a wall or shut door?
   * Straight neighbours: the edge between them. Diagonal neighbours: any of the four edges that meet at the
   * corner they share — the same "both ways round must be open" rule a diagonal step obeys, so nobody swings or
   * reaches round the end of a wall. (blockedBetween itself stays straight-only: sight asks it about diagonals.)
   */
  function reachBlocked(content, map, ax, ay, bx, by, what) {
    what = what || 'move';
    if (Math.abs(bx - ax) === 1 && Math.abs(by - ay) === 1)
      return blockedBetween(content, map, ax, ay, bx, ay, what) || blockedBetween(content, map, bx, ay, bx, by, what) ||
             blockedBetween(content, map, ax, ay, ax, by, what) || blockedBetween(content, map, ax, by, bx, by, what);
    return blockedBetween(content, map, ax, ay, bx, by, what);
  }
  /**
   * Can something at (x, y) on map step in direction dir? Returns {ok, x, y, reason}.
   * opts (optional): walkable(entity) overrides object walkability (e.g. an open door);
   *                  occupied(x, y) returns who stands there (a monster or player), which blocks.
   */
  // ---- objects that can be turned (a chair seen from the north, the south or the side) ----
  // An object is authored FACING SOUTH: its main picture and its blocked sides (pass_n/e/s/w) describe that view.
  // sprite_states may add "north=" and "side=" pictures (side = facing east; west is the same picture mirrored).
  // A placed one carries data.facing N|E|S|W, and its blocked sides turn with it.
  var TURN = ['S', 'W', 'N', 'E'];                          // clockwise, starting from the authored view
  var OLD_FACING = { DOWN: 'S', UP: 'N', LEFT: 'W', RIGHT: 'E', SIDE: 'E', SOUTH: 'S', NORTH: 'N', WEST: 'W', EAST: 'E' };
  /** Normalised facing of a placed object ('S' when it has none). Accepts the older words (down, side, left…). */
  function facingOf(e) {
    var f = String((e && e.data && e.data.facing) || (typeof e === 'string' ? e : '') || '').toUpperCase();
    return OLD_FACING[f] || (TURN.indexOf(f) >= 0 ? f : 'S');
  }
  function turnPics(o) {
    var st = (o && o.spriteStates) || {};
    return { north: st.north || st.N || st.up || '', south: st.south || st.S || st.down || '', side: st.side || st.E || st.east || '' };
  }
  /** Can this object be turned? Only if it has a picture for another direction. */
  function turnable(o) { var t = turnPics(o); return !!(t.north || t.side); }
  /** The picture for a facing, and whether to mirror it: {path, flip}. */
  function facingSprite(o, facing) {
    var t = turnPics(o), f = facingOf(facing);
    if (f === 'N' && t.north) return { path: t.north, flip: false };
    if ((f === 'E' || f === 'W') && t.side) return { path: t.side, flip: f === 'W' };
    return { path: (f === 'S' && t.south) || o.sprite, flip: false };
  }
  /** The next facing, clockwise (dir 1) or anticlockwise (dir -1). */
  function nextFacing(f, dir) { return TURN[(TURN.indexOf(facingOf(f)) + (dir < 0 ? 3 : 1)) % 4]; }
  /** The sides of a placed object you may cross, turned with it: {n, e, s, w}. */
  function passOf(o, e) {
    var p = o.pass, k = TURN.indexOf(facingOf(e));
    if (!k || !p) return p;
    var side = ['n', 'e', 's', 'w'], out = {};
    side.forEach(function (a, i) { out[side[(i + k) % 4]] = p[a]; });   // a quarter turn clockwise moves north's rule to the east
    return out;
  }

  // A diagonal step is allowed only if you could also get there by either pair of straight steps (a then b, and
  // b then a): no wall, shut door, solid object or blocked side on either way round. So nobody slips between two
  // walls that meet at a corner or past a door frame. Creatures standing on the two side cells are not walls:
  // only the cell you land on must be free.
  function tryDiag(content, map, x, y, g, opts) {
    var free = null, k;
    if (opts) { free = {}; for (k in opts) if (k !== 'occupied') free[k] = opts[k]; }
    function way(first, second) {
      var r1 = tryMove(content, map, x, y, first, free);
      return r1.ok ? tryMove(content, map, r1.x, r1.y, second, free) : r1;
    }
    var w = way(g.a, g.b); if (w.ok) w = way(g.b, g.a);
    if (!w.ok) return { ok: false, x: x, y: y, reason: w.reason, entity: w.entity, corner: true };
    var nx = x + g.dx, ny = y + g.dy, who = opts && opts.occupied ? opts.occupied(nx, ny) : null;
    if (who) return { ok: false, x: x, y: y, reason: 'occupied', who: who, tx: nx, ty: ny };
    return { ok: true, x: nx, y: ny };
  }
  function tryMove(content, map, x, y, dir, opts) {
    if (DIAG[dir]) return tryDiag(content, map, x, y, DIAG[dir], opts);
    var d = DIRS[dir];
    if (!d) return { ok: false, x: x, y: y, reason: 'bad direction' };
    var nx = x + d.dx, ny = y + d.dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) return { ok: false, x: x, y: y, reason: 'edge' };
    var from = terrainAt(content, map, x, y), to = terrainAt(content, map, nx, ny);
    if (!to) return { ok: false, x: x, y: y, reason: 'no terrain' };
    // The edge being crossed: a wall blocks the step unless an opening on it says otherwise (see edgeBlocked).
    var dEdge = wallEdge(x, y, dir);
    if (edgeBlocked(content, map, dEdge.orient, dEdge.x, dEdge.y, 'move')) {
      var isOv = map._edgeOv && map._edgeOv[edgeKey(dEdge.orient, dEdge.x, dEdge.y)];
      return { ok: false, x: x, y: y, reason: isOv ? 'door' : 'wall' };
    }
    if (from && !from.pass[d.out]) return { ok: false, x: x, y: y, reason: 'blocked side' };
    if (!to.pass[d.into]) return { ok: false, x: x, y: y, reason: 'blocked' };
    // Leaving the current cell: a walkable object here can block one of its edges (one-way).
    var hereObjs = blockersAt(content, map, x, y);
    for (var h = 0; h < hereObjs.length; h++) {
      var ho = content.objects[hereObjs[h].ref];
      var hwalk = opts && opts.walkable ? opts.walkable(hereObjs[h]) : !(ho && !ho.walkable);
      if (hwalk && ho && ho.pass && !passOf(ho, hereObjs[h])[d.out]) return { ok: false, x: x, y: y, reason: 'object side', entity: hereObjs[h].key };
    }
    var ents = blockersAt(content, map, nx, ny);
    for (var i = 0; i < ents.length; i++) {
      var o = content.objects[ents[i].ref];
      var walk = opts && opts.walkable ? opts.walkable(ents[i]) : !(o && !o.walkable);
      if (!walk) return { ok: false, x: x, y: y, reason: 'object', entity: ents[i].key, tx: nx, ty: ny };
      // Entering the target cell: a walkable object there can block the edge you'd come in through.
      if (o && o.pass && !passOf(o, ents[i])[d.into]) return { ok: false, x: x, y: y, reason: 'object side', entity: ents[i].key, tx: nx, ty: ny };
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
      if (!isDir(dir)) return;
      p.facing = faceFor(dir, p.facing);
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

  return { WALL_H: WALL_H, DIRS: DIRS, DIAG: DIAG, isDir: isDir, stepCost: stepCost, faceFor: faceFor, tryMove: tryMove, applyMoves: applyMoves, entitiesAt: entitiesAt, blockersAt: blockersAt,
    terrainAt: terrainAt, standable: standable, nearestStandable: nearestStandable,
    parseWall: parseWall, wallAt: wallAt, wallEdge: wallEdge, wallBetween: wallBetween, wallBetweenCells: wallBetweenCells,
    wallStyleOf: wallStyleOf, wallBlocksMove: wallBlocksMove, wallBlocksSight: wallBlocksSight,
    edgeKey: edgeKey, edgeBlocked: edgeBlocked, sharedEdge: sharedEdge, blockedBetween: blockedBetween, reachBlocked: reachBlocked,
    facingOf: facingOf, turnable: turnable, facingSprite: facingSprite, nextFacing: nextFacing, passOf: passOf };
})();
if (typeof module !== 'undefined') module.exports = Rules;
