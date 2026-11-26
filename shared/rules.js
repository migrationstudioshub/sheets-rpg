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
  // What a step costs, in straight steps of time. Given where it lands (content, map, x, y), wading into shallow water
  // costs Config shallow_slow times as much (2 when not said; 1 = no slower). Players' walking budget, the page's
  // pace and the monsters' turns all ask this, so they agree. who = the one stepping: a player who sneaks
  // (who.sneak, or who.sn as other players are sent) pays Config sneak_slow (2) times as much (docs/STEALTH.md).
  function stepCost(dir, content, map, x, y, who) {
    var k = DIAG[dir] ? DIAG_COST : 1;
    if (who && (who.sneak || who.sn) && content) k *= sneakSlow(content);
    return content && map && shallowAt(content, map, x, y) ? k * wadeSlow(content) : k;
  }
  function sneakSlow(content) { var v = Number(content.config && content.config.sneak_slow); return v > 0 ? v : 2; }
  function wadeSlow(content) { var v = Number(content.config && content.config.shallow_slow); return v > 0 ? v : 2; }
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
  // Shallow water: the map's `shallow` grid ('1' = shallow, painted in the map editor) marks water anyone can wade
  // through. It changes nothing for any other ground. terrainAt answers a shallow water cell with the same terrain
  // made walkable on every side (and flagged `shallow`), so every rule that asks "can this be crossed" agrees.
  function terrainAt(content, map, x, y) {
    var ov = map.overlay && map.overlay[y] && map.overlay[y][x], t;
    if (ov && content.terrain[ov]) t = content.terrain[ov];
    else { var row = map.terrain[y]; t = row ? content.terrain[row[x]] : undefined; }
    return t && map.shallow && map.shallow[y] && map.shallow[y][x] === '1' && isWater(t) ? shallowOf(t) : t;
  }
  /** Water (a water source, or a terrain drawn from the tinted water sheets) — the ground that can be made shallow. */
  function isWater(t) { return !!t && (!!t.water || /^water/.test(t.tint || '')); }
  /** Is this cell shallow water (wadeable)? */
  function shallowAt(content, map, x, y) { if (x < 0 || y < 0 || x >= map.width || y >= map.height || !map.shallow || !map.shallow.length) return false; var t = terrainAt(content, map, x, y); return !!(t && t.shallow); }
  function shallowOf(t) {
    if (!Object.prototype.hasOwnProperty.call(t, '_shallow')) {
      var s = {}; for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) s[k] = t[k];
      s.pass = { n: true, e: true, s: true, w: true }; s.shallow = true; s.seeThrough = true;
      Object.defineProperty(t, '_shallow', { value: s, enumerable: false });   // (kept off JSON and key lists)
    }
    return t._shallow;
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
  /** Is there a change of ground height between cell A and a NEIGHBOURING cell B? Straight neighbours: the edge
   *  between them; diagonal ones: any of the four edges at the corner they share (as reachBlocked does for walls). */
  function cliffReach(map, ax, ay, bx, by) {
    if (!map || !map.elev || !map.elev.length) return false;
    function side(x0, y0, x1, y1) { return cliffBetween(map, x0, y0, x1 > x0 ? 'E' : x1 < x0 ? 'W' : y1 > y0 ? 'S' : 'N'); }
    if (Math.abs(bx - ax) === 1 && Math.abs(by - ay) === 1) return side(ax, ay, bx, ay) || side(bx, ay, bx, by) || side(ax, ay, ax, by) || side(ax, by, bx, by);
    if (Math.abs(bx - ax) + Math.abs(by - ay) !== 1) return false;
    return side(ax, ay, bx, by);
  }
  function reachBlocked(content, map, ax, ay, bx, by, what) {
    what = what || 'move';
    if (what === 'move' && cliffReach(map, ax, ay, bx, by)) return true;   // nobody uses or hits what is on another level of ground
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
  // ---- looks: one object, several pictures (a tree drawn five ways). They are the sprite_states entries v1, v2, …;
  // a placement says which with data.look ('' = the main sprite). Only the picture changes, never what the object is.
  /** The looks an object has besides its main sprite, in order: ['v1', 'v2', …]. */
  function looks(o) {
    return Object.keys((o && o.spriteStates) || {}).filter(function (k) { return /^v\d+$/.test(k) && o.spriteStates[k]; })
      .sort(function (a, b) { return Number(a.slice(1)) - Number(b.slice(1)); });
  }
  /** The picture of the look a placement (or a look's name) asks for; '' = it has none, use the usual one. */
  function lookSprite(o, e) {
    var k = e && typeof e === 'object' ? (e.data && e.data.look) : e;
    return k && /^v\d+$/.test(String(k)) && o && o.spriteStates && o.spriteStates[k] ? o.spriteStates[k] : '';
  }
  /** The look after this one (dir 1) or before it (dir -1), going round through the main sprite (''). */
  function nextLook(o, cur, dir) {
    var all = [''].concat(looks(o)), i = Math.max(0, all.indexOf(cur || ''));
    return all[(i + (dir < 0 ? all.length - 1 : 1)) % all.length];
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

  // ---- staircases (docs/FLOORS.md §4.2) ----
  // A staircase is an object of kind 'stairs' on the LOWER of the two floors it joins. It lies along a straight
  // run of tiles starting at its own cell (the bottom) and climbing in its direction — data.facing, north when
  // unset — for properties.length tiles (default 2). You get on at the bottom walking the way it climbs, walk up
  // the run, and stepping off the top puts you on the floor above, one tile further on (the landing). From the
  // landing, stepping back toward the run — a cell with no floor up there, the stairwell — puts you on the top
  // tile below. The run cannot be entered or left by its sides, nor crossed diagonally.
  var BACK = { N: 'S', S: 'N', E: 'W', W: 'E' };
  function stairDir(e) { return e && e.data && e.data.facing ? facingOf(e) : 'N'; }
  // Every staircase runs along STAIR_LEN tiles (2): with a storey WALL_H (2) high, each tile of the run climbs one
  // tile. Like a wall's height it is fixed, not a setting; an older `length` on an object is ignored.
  var STAIR_LEN = 2;
  function stairLen() { return STAIR_LEN; }
  function stairsOn(content, map) {
    if (map._stairs && map._stairsOf === map.entities) return map._stairs;
    var out = [];
    (map.entities || []).forEach(function (e) {
      var o = content.objects[e.ref]; if (!o || o.kind !== 'stairs') return;
      var dir = stairDir(e), d = DIRS[dir], n = stairLen();
      out.push({ e: e, o: o, dir: dir, n: n, x: e.x, y: e.y, dx: d.dx, dy: d.dy });
    });
    map._stairs = out; map._stairsOf = map.entities;
    return out;
  }
  /** The staircase whose run covers (x,y) and how far up it that tile is: { s, i } (i = 0 at the bottom), or null. */
  function stairAt(content, map, x, y) {
    var L = stairsOn(content, map);
    for (var k = 0; k < L.length; k++) {
      var s = L[k];
      for (var i = 0; i < s.n; i++) if (s.x + i * s.dx === x && s.y + i * s.dy === y) return { s: s, i: i };
    }
    return null;
  }
  /** How high something at (fx,fy) — fractional while walking — stands on a staircase: 0 at its foot to 1 (a whole storey) at its head; 0 off any stairs. */
  function stairHeight(content, map, fx, fy) {
    var L = stairsOn(content, map);
    for (var k = 0; k < L.length; k++) {
      var s = L[k], along = (fx - s.x) * s.dx + (fy - s.y) * s.dy, across = Math.abs((fx - s.x) * s.dy - (fy - s.y) * s.dx);
      if (across < 0.5 && along > -0.5 && along < s.n - 0.5) return Math.max(0, Math.min(1, (along + 0.5) / s.n));
    }
    return 0;
  }
  // The floor dz above (+1) or below (-1) this one, as a map; opts.mapOf(id) lets the caller hand over its live version.
  function otherFloor(content, map, dz, opts) {
    var id = map.floors && map.floors[(map.z || 0) + dz];
    return id ? ((opts && opts.mapOf && opts.mapOf(id)) || content.maps[id] || null) : null;
  }
  function onOther(opts, mapId, x, y) { return opts && opts.occupiedOn ? opts.occupiedOn(mapId, x, y) : null; }
  // A straight step that starts or ends on a run. Returns the answer when the stairs decide it (refused, or it
  // changes floor), or null when it is an ordinary step along the run and the usual checks apply.
  function stairStep(content, map, x, y, dir, nx, ny, here, there, opts) {
    function no(why) { return { ok: false, x: x, y: y, reason: why || 'stairs' }; }
    if (!here) return there.i === 0 && dir === there.s.dir ? null : no();          // onto a run: only its foot, walking the way it climbs
    var s = here.s;
    if (dir === BACK[s.dir]) return null;                                           // down the run, or off its foot
    if (dir !== s.dir) return no();                                                 // off its side
    if (here.i < s.n - 1) return null;                                              // up the run
    var up = otherFloor(content, map, 1, opts), we = wallEdge(x, y, dir);
    if (!up) return no('no floor above');
    if (!standable(content, up, nx, ny) || edgeBlocked(content, up, we.orient, we.x, we.y, 'move')) return no('blocked');
    var who = onOther(opts, up.id, nx, ny);
    if (who) return { ok: false, x: x, y: y, reason: 'occupied', who: who, tx: nx, ty: ny };
    return { ok: true, x: nx, y: ny, map: up.id, stairs: 'up' };
  }
  // A step into a cell with no floor: the stairwell, if the floor below has the head of a staircase there and you
  // are walking the way it descends.
  function stairDown(content, map, x, y, dir, nx, ny, opts) {
    var low = otherFloor(content, map, -1, opts); if (!low) return null;
    var hit = stairAt(content, low, nx, ny);
    if (!hit || hit.i !== hit.s.n - 1 || dir !== BACK[hit.s.dir]) return null;
    var we = wallEdge(x, y, dir);
    if (edgeBlocked(content, map, we.orient, we.x, we.y, 'move')) return { ok: false, x: x, y: y, reason: 'wall' };
    var who = onOther(opts, low.id, nx, ny);
    if (who) return { ok: false, x: x, y: y, reason: 'occupied', who: who, tx: nx, ty: ny };
    return { ok: true, x: nx, y: ny, map: low.id, stairs: 'down' };
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
      if (r1.ok && r1.map) return { ok: false, reason: 'stairs' };                  // stairs are walked straight
      var r2 = r1.ok ? tryMove(content, map, r1.x, r1.y, second, free) : r1;
      return r2.ok && r2.map ? { ok: false, reason: 'stairs' } : r2;
    }
    var w = way(g.a, g.b); if (w.ok) w = way(g.b, g.a);
    if (!w.ok) return { ok: false, x: x, y: y, reason: w.reason, entity: w.entity, corner: true };
    var nx = x + g.dx, ny = y + g.dy, who = opts && opts.occupied ? opts.occupied(nx, ny) : null;
    if (who) return { ok: false, x: x, y: y, reason: 'occupied', who: who, tx: nx, ty: ny };
    return { ok: true, x: nx, y: ny };
  }
  // ------------------------------------------------------------ ground height (docs/UNDERGROUND_AND_ELEVATION.md §4)
  // A map may carry `elev`: a W×H grid of tokens, '' = level ground. A token is the tile's height in whole steps
  // ('1', '2'… one step = one tile on the screen, two = a storey), optionally followed by the way a RAMP on it
  // climbs ('1N' = from height 1 at its south side up to 2 at its north side; '0E' = from 0 up to 1 going east).
  // Between two tiles that do not meet at the same height there is a cliff: nobody steps across it, either way.
  // A ramp meets its low neighbour at its foot and its high neighbour at its top; its two flanks are cliffs, except
  // against another ramp just like it (a wide ramp). Diagonal steps obey the usual both-ways-round rule.
  var OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
  function elevTok(map, x, y) { var g = map && map.elev, row = g && g[y]; return row && row[x] ? String(row[x]) : ''; }
  function heightAt(map, x, y) { return parseInt(elevTok(map, x, y), 10) || 0; }
  function rampAt(map, x, y) { var t = elevTok(map, x, y), d = t.charAt(t.length - 1); return OPP[d] ? d : ''; }
  /** The height a tile presents on one of its four sides, as text: two neighbours join when these are equal. */
  function sideLevel(map, x, y, side) {
    var h = heightAt(map, x, y), r = rampAt(map, x, y);
    if (!r) return String(h);
    return side === r ? String(h + 1) : side === OPP[r] ? String(h) : h + r;
  }
  function cliffBetween(map, x, y, dir) {
    var d = DIRS[dir];
    if (!d || !map || !map.elev || !map.elev.length) return false;
    return sideLevel(map, x, y, dir) !== sideLevel(map, x + d.dx, y + d.dy, OPP[dir]);
  }
  /** How high the ground is at a point (fx, fy in tiles, fractions allowed: the middle of tile 3,4 is 3.5,4.5). */
  function groundHeight(map, fx, fy) {
    if (!map || !map.elev || !map.elev.length) return 0;
    var x = Math.floor(fx), y = Math.floor(fy), h = heightAt(map, x, y), r = rampAt(map, x, y);
    if (!r) return h;
    var u = fx - x, v = fy - y;
    return h + (r === 'N' ? 1 - v : r === 'S' ? v : r === 'E' ? u : 1 - u);
  }
  function tryMove(content, map, x, y, dir, opts) {
    if (DIAG[dir]) return tryDiag(content, map, x, y, DIAG[dir], opts);
    var d = DIRS[dir];
    if (!d) return { ok: false, x: x, y: y, reason: 'bad direction' };
    var nx = x + d.dx, ny = y + d.dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) return { ok: false, x: x, y: y, reason: 'edge' };
    var from = terrainAt(content, map, x, y), to = terrainAt(content, map, nx, ny);
    var sHere = stairAt(content, map, x, y), sThere = stairAt(content, map, nx, ny);
    if (sHere || sThere) { var sr = stairStep(content, map, x, y, dir, nx, ny, sHere, sThere, opts); if (sr) return sr; }
    if (!to) return stairDown(content, map, x, y, dir, nx, ny, opts) || { ok: false, x: x, y: y, reason: 'no terrain' };
    if (map.elev && map.elev.length && cliffBetween(map, x, y, dir)) return { ok: false, x: x, y: y, reason: 'cliff' };   // a change of height with no ramp
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
      if (r.ok) { p.x = r.x; p.y = r.y; if (r.map && content.maps[r.map]) { p.map = r.map; map = content.maps[r.map]; } }   // stairs: onto another floor
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

  return { WALL_H: WALL_H, DIRS: DIRS, DIAG: DIAG, isDir: isDir, stepCost: stepCost, wadeSlow: wadeSlow, faceFor: faceFor, tryMove: tryMove, applyMoves: applyMoves, entitiesAt: entitiesAt, blockersAt: blockersAt,
    heightAt: heightAt, rampAt: rampAt, cliffBetween: cliffBetween, groundHeight: groundHeight, cliffReach: cliffReach,
    terrainAt: terrainAt, isWater: isWater, shallowAt: shallowAt, standable: standable, nearestStandable: nearestStandable,
    parseWall: parseWall, wallAt: wallAt, wallEdge: wallEdge, wallBetween: wallBetween, wallBetweenCells: wallBetweenCells,
    wallStyleOf: wallStyleOf, wallBlocksMove: wallBlocksMove, wallBlocksSight: wallBlocksSight,
    edgeKey: edgeKey, edgeBlocked: edgeBlocked, sharedEdge: sharedEdge, blockedBetween: blockedBetween, reachBlocked: reachBlocked,
    STAIR_LEN: STAIR_LEN, stairLen: stairLen, stairDir: stairDir, stairsOn: stairsOn, stairAt: stairAt, stairHeight: stairHeight,
    facingOf: facingOf, turnable: turnable, facingSprite: facingSprite, nextFacing: nextFacing, looks: looks, lookSprite: lookSprite, nextLook: nextLook, passOf: passOf };
})();
if (typeof module !== 'undefined') module.exports = Rules;
