/**
 * Draws a map in layers, bottom to top:
 *   1 base colour  2 terrain tile (sprite or autotile)  3 objects
 *   4 ground items (later)  5 characters  6 effects (later)
 * Layers 1-2 never change while on a map, so they are painted once into an
 * offscreen canvas; objects and characters are drawn every frame on top.
 */
var Render = (function () {
  function tileFromSheet(img, ts, n, g, dx, dy, size) {
    var i = n - 1, sx = (i % ts.columns) * ts.tileSize, sy = Math.floor(i / ts.columns) * ts.tileSize;
    g.drawImage(img, sx, sy, ts.tileSize, ts.tileSize, dx, dy, size, size);
  }

  function drawSprite(g, path, label, color, dx, dy, size) {
    var img = path ? Assets.get(path) : null;
    if (img) g.drawImage(img, dx, dy, size, size);
    else if (path) g.drawImage(Assets.placeholder(label, color, size), dx, dy);
  }

  /** Which part of an image to show now: animated sprites are horizontal strips of `frames` frames. */
  function frameOf(img, frames, frameMs, now) {
    var n = Math.max(1, frames || 1), fw = img.width / n;
    var i = n > 1 ? Math.floor((now || 0) / (frameMs || 200)) % n : 0;
    return { sx: i * fw, sw: fw, fh: Math.min(img.height, fw) };
  }

  var NT = 32;   // sprites are authored at 32 px per tile; the footprint is the bottom 32 px

  // ---- edge walls: walls painted on cell boundaries, extruded upward by a per-segment height ----
  // Token: "style:height[:side]". side ('l'|'r', N-S walls only) shifts a vertical wall fully onto the
  // left/right tile instead of straddling its grid line; absent/anything else = centred ('c').
  function parseWallTok(tok) {
    if (!tok) return null;
    var p = String(tok).split(':');
    return { style: p[0], height: Math.max(1, parseInt(p[1], 10) || 1), side: p[2] || 'c' };
  }
  /** Every wall segment on a map as {orient:'h'|'v', x, y, style, height}. */
  function wallSegments(map) {
    var out = [], h = map.hWalls || [], v = map.vWalls || [], y, x, row, p;
    for (y = 0; y < h.length; y++) { row = h[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (p) out.push({ orient: 'h', x: x, y: y, style: p.style, height: p.height }); } }
    for (y = 0; y < v.length; y++) { row = v[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (p) out.push({ orient: 'v', x: x, y: y, style: p.style, height: p.height }); } }
    return out;
  }
  // Nudge a #rrggbb colour lighter (f>0) or darker (f<0), for cap vs face contrast.
  function shade(hex, f) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex || '#8a8f98';
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
    function a(v) { return Math.max(0, Math.min(255, Math.round(v + 255 * f))); }
    return 'rgb(' + a(r) + ',' + a(gg) + ',' + a(b) + ')';
  }
  // The screen y a segment sorts by (its southernmost / nearest-camera point), for occlusion ordering.
  function wallBaseY(seg, oy, S) { return oy + (seg.orient === 'h' ? seg.y : seg.y + 1) * S; }
  /**
   * Draw one wall segment. Horizontal (E-W) segments show a front face rising `height` tiles above the
   * grid line plus a cap; vertical (N-S) segments show a thin raised slab seen edge-on. Art (face strip +
   * cap) is used when loaded, else the style colour. S = cell size in px; (ox,oy) = map origin on screen.
   */
  function drawWall(g, content, seg, ox, oy, S) {
    var st = content.wallStyles && content.wallStyles[seg.style];
    var col = (st && st.color) || '#8a8f98', H = seg.height * S, capH = Math.max(2, Math.round(S * 0.16));
    var faceImg = st && st.face && Assets.get(st.face), capImg = st && st.cap && Assets.get(st.cap);
    if (seg.orient === 'h') {
      var x = ox + seg.x * S, yl = oy + seg.y * S, top = yl - H;
      if (faceImg) { for (var yy = top; yy < yl; yy += S) { var hh = Math.min(S, yl - yy); g.drawImage(faceImg, 0, 0, faceImg.width, Math.max(1, Math.round(faceImg.height * hh / S)), x, yy, S, hh); } }
      else { g.fillStyle = shade(col, -0.08); g.fillRect(x, top, S, H); g.strokeStyle = shade(col, -0.25); g.lineWidth = 1; g.strokeRect(x + 0.5, top + 0.5, S - 1, H - 1); }
      if (capImg) g.drawImage(capImg, x, top - capH, S, capH * 2);
      else { g.fillStyle = shade(col, 0.22); g.fillRect(x, top - capH, S, capH); }
    } else {
      var b = Math.max(2, Math.round(S * 0.14)), vx = ox + seg.x * S, yt = oy + seg.y * S, vtop = yt - H;
      g.fillStyle = shade(col, -0.08); g.fillRect(vx - b, vtop, 2 * b, S + H);
      g.strokeStyle = shade(col, -0.25); g.lineWidth = 1; g.strokeRect(vx - b + 0.5, vtop + 0.5, 2 * b - 1, S + H - 1);
      if (capImg) g.drawImage(capImg, vx - b, vtop - capH, 2 * b, capH * 2);
      else { g.fillStyle = shade(col, 0.22); g.fillRect(vx - b, vtop - capH, 2 * b, capH); }
    }
  }

  // ---- connection autotiling for edge walls ----
  // A wall style with a `tiles` sheet is drawn top-down and autotiled at grid NODES: one tile per node
  // where walls meet, chosen by which of the node's four directions carry a wall (N=1,E=2,S=4,W=8). The
  // sheet is 4x4 (16 tiles; tile index = the mask). This joins straights, corners, T-junctions, crosses
  // and end-caps without any neighbour-blob cell logic.
  function styleHasTiles(content, style) {
    var s = content.wallStyles && content.wallStyles[style];
    return s && s.tiles ? s : null;
  }
  // The four edges incident on node (nx,ny): N = vWall above, S = vWall below, E = hWall right, W = hWall
  // left. filter(token) keeps only edges that count (e.g. only connector-style walls).
  function nodeAt(map, nx, ny, filter) {
    function tok(orient, x, y) {
      var grid = orient === 'h' ? map.hWalls : map.vWalls, row = grid && grid[y], t = (row && row[x]) || '';
      return t && (!filter || filter(t)) ? t : '';
    }
    var N = tok('v', nx, ny - 1), E = tok('h', nx, ny), S = tok('v', nx, ny), W = tok('h', nx - 1, ny);
    return { mask: (N ? 1 : 0) | (E ? 2 : 0) | (S ? 4 : 0) | (W ? 8 : 0), token: N || E || S || W };
  }
  /** Every grid node that a connector-style wall touches, as {nx, ny, mask, style}. */
  function connectorNodes(content, map) {
    var out = [];
    function keep(t) { return !!styleHasTiles(content, parseWallTok(t).style); }
    for (var ny = 0; ny <= map.height; ny++) for (var nx = 0; nx <= map.width; nx++) {
      var n = nodeAt(map, nx, ny, keep);
      if (n.mask) out.push({ nx: nx, ny: ny, mask: n.mask, style: parseWallTok(n.token).style });
    }
    return out;
  }
  /** Draw the autotiled top-down connector tiles (one per node), centred on grid intersections. */
  function drawWallNodes(g, content, nodes, ox, oy, S) {
    nodes.forEach(function (n) {
      var st = content.wallStyles && content.wallStyles[n.style]; if (!st) return;
      var img = st.tiles && Assets.get(st.tiles);
      var dx = ox + (n.nx - 0.5) * S, dy = oy + (n.ny - 0.5) * S;
      if (img) {
        var ts = img.width / 4, col = n.mask % 4, row = Math.floor(n.mask / 4);
        g.drawImage(img, col * ts, row * ts, ts, ts, dx, dy, S, S);
      } else {   // sheet not loaded yet: a colour band in the connected directions keeps the shape visible
        var hw = Math.max(2, Math.round(S * 0.18)), cx = dx + S / 2, cy = dy + S / 2;
        g.fillStyle = st.color || '#8a8f98';
        if (n.mask & 1) g.fillRect(cx - hw, dy, 2 * hw, S / 2 + hw);
        if (n.mask & 4) g.fillRect(cx - hw, cy - hw, 2 * hw, S / 2 + hw);
        if (n.mask & 2) g.fillRect(cx - hw, cy - hw, S / 2 + hw, 2 * hw);
        if (n.mask & 8) g.fillRect(dx, cy - hw, S / 2 + hw, 2 * hw);
        if (!n.mask) g.fillRect(cx - hw, cy - hw, 2 * hw, 2 * hw);
      }
    });
  }

  // ---- 2.5D cap + face walls (the height-field look) ----
  // A wall style WITHOUT a connector `tiles` sheet is drawn in 2.5D: each segment is a FACE (its height in
  // tiles, hanging south toward the camera) plus a 1-tile CAP on top. E-W segments are full cell width; N-S
  // segments are thin. Contiguous N-S segments overlap, each offset one tile south, the southern drawn on
  // top — so their caps stack upward and only the southernmost face stays fully visible (the receding look).
  /** 2.5D draw primitives (cap/face pieces) for every wall whose style has no connector sheet. */
  function wall25(content, map) {
    function flat(s) { var st = content.wallStyles && content.wallStyles[s]; return st && st.tiles; }
    var out = [], h = map.hWalls || [], v = map.vWalls || [], y, x, row, p;
    for (y = 0; y < h.length; y++) { row = h[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (!p || flat(p.style)) continue;
      out.push({ kind: 'hcap', x: x, y: y, h: p.height, style: p.style });
      out.push({ kind: 'hface', x: x, y: y, h: p.height, style: p.style });
    } }
    for (y = 0; y < v.length; y++) { row = v[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (!p || flat(p.style)) continue;
      // Every N-S segment is a full face + 1-tile cap; contiguous ones overlap and the southern draws on top.
      out.push({ kind: 'vface', x: x, y: y, h: p.height, style: p.style, side: p.side });
      out.push({ kind: 'vcap', x: x, y: y, h: p.height, style: p.style, side: p.side });
    } }
    return out;
  }
  // The base (south-most, nearest-camera) screen y of a primitive — the drawn edge — for painter sorting.
  function prim25SortY(p, oy, S) {
    if (p.kind === 'hcap' || p.kind === 'hface') return oy + p.y * S;      // E-W: the drawn line
    return oy + (p.y + 1) * S;                                             // N-S: south edge of the drawn cell
  }
  function drawPrim25(g, content, p, ox, oy, S) {
    var st = (content.wallStyles && content.wallStyles[p.style]) || {}, col = st.color || '#8a8f98';
    var capImg = st.cap && Assets.get(st.cap), faceImg = st.face && Assets.get(st.face);
    // d = the cap's thickness AND the N-S wall's width (uniform): E-W cap lip is d tall, N-S wall/cap is d wide.
    var d = Math.max(4, Math.round(S * 0.32)), hd = Math.round(d / 2);
    function face(x0, y0, x1, y1) {
      if (faceImg) { for (var yy = y0; yy < y1; yy += S) { var hh = Math.min(S, y1 - yy); g.drawImage(faceImg, 0, 0, faceImg.width, Math.max(1, Math.round(faceImg.height * hh / S)), x0, yy, x1 - x0, hh); } }
      else { g.fillStyle = shade(col, -0.06); g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeStyle = shade(col, -0.24); g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); }
    }
    function cap(x0, y0, x1, y1) {
      if (capImg) g.drawImage(capImg, x0, y0, x1 - x0, y1 - y0);
      else { g.fillStyle = shade(col, 0.24); g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeStyle = shade(col, 0.42); g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); }
    }
    // The drawn edge is the BASE; the face rises UP (north) by height; the cap is a thin lip of thickness d.
    // N-S walls can be shifted fully onto the left/right tile: side 'r' → body in the right tile (near edge on
    // the line), 'l' → left tile, else straddles the line centred. Offset is purely visual (collision stays on the line).
    var bx = ox + p.x * S, vx = ox + p.x * S;
    var voff = p.side === 'r' ? hd : p.side === 'l' ? -hd : 0;
    if (p.kind === 'hface') { var hb = oy + p.y * S; face(bx, hb - p.h * S, bx + S, hb); }
    else if (p.kind === 'hcap') { var ht = oy + p.y * S - p.h * S; cap(bx, ht - d, bx + S, ht); }
    else if (p.kind === 'vface') { var vb = oy + (p.y + 1) * S; face(vx - hd + voff, vb - p.h * S, vx + hd + voff, vb); }   // thin face, rising h tiles north
    else if (p.kind === 'vcap') { var vt = oy + (p.y + 1) * S - p.h * S; cap(vx - hd + voff, vt - S, vx + hd + voff, vt); } // 1-tile cap on top of the face
  }

  // Walls that currently hide the player, to draw see-through. Only E-W (horizontal) walls ever fade — the
  // thin N-S walls don't occlude. Mode: 'tiles' (just the cells over the player), 'run' (the whole contiguous
  // E-W run the player is behind), 'radius' (E-W walls within `radius` tiles, but only to the SOUTH of the
  // player — a wall north of the player never hides it). A face at line y, column x, height ht covers the
  // player when me.x === x and me.y is in [y-ht, y-1]. Returns a set keyed 'h:x:y' matching a prim's x,y.
  function wallFadeCells(map, me, mode, radius) {
    var set = {};
    if (!me || mode === 'off') return set;
    var mx = Math.round(me.x), my = Math.round(me.y), h = map.hWalls || [], x, y, row;
    if (mode === 'radius') {                                             // E-W walls south of the player, within the box
      for (y = my + 1; y <= my + radius && y < h.length; y++) { row = h[y] || []; for (x = mx - radius; x <= mx + radius; x++) if (row[x]) set['h:' + x + ':' + y] = 1; }
      return set;
    }
    for (y = my + 1; y < h.length && y <= my + 12; y++) {                 // E-W walls south of the player
      var tok = (h[y] && h[y][mx]) ? parseWallTok(h[y][mx]) : null;
      if (!tok || my < y - tok.height) continue;                          // its face doesn't rise over the player's cell
      if (mode === 'run') {                                               // fade the whole contiguous run at this line
        var x0 = mx; while (x0 - 1 >= 0 && h[y] && h[y][x0 - 1]) x0--;
        var x1 = mx; while (h[y] && h[y][x1 + 1]) x1++;
        for (x = x0; x <= x1; x++) set['h:' + x + ':' + y] = 1;
      } else set['h:' + mx + ':' + y] = 1;                                // 'tiles': just the covering cell
    }
    return set;
  }

  // ---- wall-mounted objects (layer:'wall') ----
  // A wall object hangs on ONE edge of its cell: side N/S = the horizontal wall on the cell's north/south
  // grid line, W/E = the vertical wall on its west/east line. It renders centred on that wall's visible face,
  // raised toward the middle of the wall's height (data.mount nudges it up in tiles; negative lowers it), and
  // sorts just after the face so it sits ON the wall. Collision is unchanged — the wall edge already blocks and
  // the object's own tile stays walkable (author wall objects walkable). Interaction uses the object's cell.
  function mountSide(e) { return String((e.data && (e.data.side || e.data.facing)) || 'N').toUpperCase().charAt(0); }
  function mountEdge(x, y, side) {
    if (side === 'S') return { orient: 'h', ex: x, ey: y + 1 };
    if (side === 'W') return { orient: 'v', ex: x, ey: y };
    if (side === 'E') return { orient: 'v', ex: x + 1, ey: y };
    return { orient: 'h', ex: x, ey: y };                        // 'N' (default)
  }
  function wallHeightAt(map, ed) {
    var grid = ed.orient === 'h' ? map.hWalls : map.vWalls, row = grid && grid[ed.ey];
    var p = row ? parseWallTok(row[ed.ex]) : null;
    return p ? p.height : 0;                                     // 0 = no wall there (mount one tile high)
  }
  /** Screen placement {dx, dy, sortY, flip} for a wall-mounted object entity. (ox,oy)=map origin, S=cell px. */
  function wallMountPlace(map, o, e, ox, oy, S) {
    var side = mountSide(e), ed = mountEdge(e.x, e.y, side), H = wallHeightAt(map, ed) || 1;
    var mount = Number((e.data && e.data.mount != null) ? e.data.mount : (o.properties && o.properties.mount)) || 0;
    if (ed.orient === 'h') {
      var line = oy + ed.ey * S;                                 // the wall's grid line (face rises north of it)
      var bottom = line - H * S / 2 + S / 2 - mount * S;         // centre a 1-tile sprite on the face
      return { dx: ox + ed.ex * S, dy: bottom - S, sortY: line + 0.26, flip: false };
    }
    var vline = ox + ed.ex * S, vbase = oy + (ed.ey + 1) * S;    // vertical wall rises from the cell's south edge
    var vb = vbase - H * S / 2 + S / 2 - mount * S;
    return { dx: vline - S / 2, dy: vb - S, sortY: vbase + 0.26, flip: side === 'E' };
  }

  /** The object layer: 'object' (y-sorted, default), 'wall' (hung on an edge face) or 'ground_decal' (flat). */
  function layerOf(o) { return (o.properties && o.properties.layer) || 'object'; }

  /** Which sprite to show: an active state (open/empty…) wins, else the facing view, else the base sprite. */
  function objPath(o, st, facing) {
    if (st && o.spriteStates[st]) return o.spriteStates[st];
    if (facing) {
      var key = (facing === 'left' || facing === 'right' || facing === 'W' || facing === 'E') ? 'side' : facing;
      if (o.spriteStates[key]) return o.spriteStates[key];
    }
    return o.sprite;
  }

  /**
   * Draws one object whose footprint is cell (dx, dy). An object is `w` tiles wide (from its image
   * width), centred over its footprint width and bottom-anchored on the footprint row; everything
   * above that row overflows upward. A per-object offset_y nudges it vertically.
   * part 'base' = the footprint row (the part that can block); part 'top' = the overflow above it,
   * drawn after characters so they can walk behind it. `flip` mirrors the whole object (side→left).
   */
  function drawObject(g, o, path, dx, dy, size, part, now, flip) {
    var img = path && Assets.get(path);
    if (!img) { if (part === 'base' && path) g.drawImage(Assets.placeholder(o.name, '#7a5a3a', size), dx, dy, size, size); return; }
    var f = frameOf(img, o.frames, o.frameMs, now), fw = f.sw, ih = img.height;
    var sc = size / NT, w = Math.max(1, Math.round(fw / NT)), destW = w * size;
    // Centre the sprite over its footprint width, so a sprite wider (or narrower) than its footprint
    // straddles the footprint tiles instead of growing rightward from the anchor.
    dx += (Math.max(1, o.footprintW || 1) - w) * size / 2;
    // Per-object vertical nudge (offset_y, authored in 32px pixels; negative = up, positive = down).
    var offY = (o.offsetY || 0) * sc;
    var baseSrcH = Math.min(NT, ih), baseDstH = baseSrcH * sc, baseDstY = dy + size - baseDstH + offY;
    var topSrcH = ih - baseSrcH;
    function blit(srcY, srcH, dstY, dstH) {
      if (srcH <= 0) return;
      g.save();
      if (flip) { g.translate(dx + destW, 0); g.scale(-1, 1); g.drawImage(img, f.sx, srcY, fw, srcH, 0, dstY, destW, dstH); }
      else g.drawImage(img, f.sx, srcY, fw, srcH, dx, dstY, destW, dstH);
      g.restore();
    }
    if (part === 'base') {
      blit(ih - baseSrcH, baseSrcH, baseDstY, baseDstH);
    } else {
      blit(0, topSrcH, baseDstY - topSrcH * sc, topSrcH * sc);
      var top = o.spriteTop && Assets.get(o.spriteTop);     // legacy: a separate stacked top image
      if (top) {
        var ft = frameOf(top, o.frames, o.frameMs, now), rows = top.height / ft.sw;
        g.drawImage(top, ft.sx, 0, ft.sw, top.height, dx, baseDstY - topSrcH * sc - rows * size, destW, rows * size);
      }
    }
  }
  function hasTop(o, path) {
    if (o.spriteTop) return true;
    var img = path && Assets.get(path); if (!img) return false;
    return img.height > NT + 1;                             // taller than one footprint tile = overflow above
  }
  /** A state with no art yet (open door, emptied chest, sprung trap, lit switch) shown as a simple mark. */
  function drawStateMark(g, o, st, dx, dy, S) {
    if (!st || o.spriteStates[st]) return;
    if (st === 'open' && o.kind === 'door') { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(dx + 4, dy + 2, S - 8, S - 4); }
    else if (st === 'empty' || st === 'open') { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(dx, dy, S, S); }
    else if (st === 'down' && o.kind === 'trap') { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(dx, dy, S, S); }
    else if (st === 'on') { g.fillStyle = 'rgba(255,210,80,.35)'; g.fillRect(dx, dy, S, S); }
  }

  /**
   * Paper-doll character: draws an ordered list of layer images (base body first, then
   * equipment, lowest slot first). Every layer is one tile wide and bottom-anchored on the
   * character's tile, so busts taller than a tile stand up out of their square. The whole
   * stack flips together when facing west (the only turn there is). Returns the top y of the
   * tallest layer, so health bars and names can sit just above the figure, not the tile.
   */
  // A layer is { path, mask?, ramp? }: the base sprite, plus an optional tint mask + colour
  // ramp for recolourable cloth/hair. Every layer shares the 32x48 skeleton, so each is drawn
  // bottom-anchored at the tile's foot and scaled to the tile width; the whole stack flips as one.
  // `aim` (radians, world space) rotates the weapon layer so the gun points at the crosshair; null = no aim.
  // The pivot is a rough shoulder/hand point — a per-gun "forward" setup is a future tool.
  function drawLayers(g, layers, ax, ay, T, flip, aim) {
    var topY = ay;
    layers.forEach(function (l) {
      var base = Assets.get(l.path); if (!base) return;
      var img = (l.mask && l.ramp) ? Tint.getTintedLayer(base, Assets.get(l.mask), l.ramp) : base;
      var h = Math.round(T * base.height / base.width), dy = ay + T - h;
      if (dy < topY) topY = dy;
      if (aim != null && l.slot === 'weapon') {            // the equipped weapon swings to track the crosshair
        // Pivot + barrel tip are normalised to the sprite box (set in the Content Studio); default to a
        // centre pivot firing right when unset. The sprite is rotated so pivot→tip points along `aim`.
        var ap = l.aimPoints || null;
        var px = ap && ap.px != null ? ap.px : 0.5, py = ap && ap.py != null ? ap.py : 0.52;
        var mx = ap && ap.mx != null ? ap.mx : 0.95, my = ap && ap.my != null ? ap.my : 0.52;
        var pivotX = ax + px * T, pivotY = dy + py * h;               // dy = ay + T - h is the sprite box top
        var intrinsic = Math.atan2((my - py) * h, (mx - px) * T);     // the barrel's angle in the unrotated sprite
        g.save();
        g.translate(pivotX, pivotY);
        // Pointing left would draw the gun upside-down; mirror it across the aim axis (not the sprite's own
        // axis) so it turns upright while the barrel keeps pointing exactly at the cursor.
        if (Math.cos(aim) < 0) { g.rotate(aim); g.scale(1, -1); g.rotate(-aim); }
        g.rotate(aim - intrinsic);
        g.drawImage(img, -px * T, -py * h, T, h);
        g.restore();
      } else {
        g.save();
        if (flip) { g.translate(ax + T, 0); g.scale(-1, 1); g.drawImage(img, 0, dy, T, h); }
        else g.drawImage(img, ax, dy, T, h);
        g.restore();
      }
    });
    return topY;
  }

  /** Paints base colours, terrain, the variety layer, wall faces and flat ground decals once. */
  function bakeGround(content, map) {
    var T = content.config.tile_size || 32, sc = T / NT;
    var c = document.createElement('canvas');
    c.width = map.width * T; c.height = map.height * T;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    var edgeSame = content.config.autotile_edge_same !== false;
    var base = map.terrain, overlay = (map.overlay && map.overlay.length) ? map.overlay : null;
    var auto = Autotile.gridFor(content, base, edgeSame, map.shapes);           // shapes = frozen overrides
    var autoOv = overlay ? Autotile.gridFor(content, overlay, edgeSame, map.overlayShapes) : null;
    var Sc = typeof Scatter !== 'undefined' ? Scatter : null;

    // Draw one terrain layer at a cell. `underlay` = this is the opaque ground layer (draws the base-tile
    // underlay so edges aren't holes, and a flat-colour fallback for artless terrain). The overlay layer
    // passes underlay=false, so its autotile is transparent outside its shape and reveals the ground below.
    function drawCell(cells, autoGrid, x, y, dx, dy, underlay, overrides) {
      var tid = cells[y] && cells[y][x]; if (!tid) return;
      var t = content.terrain[tid]; if (!t) return;
      var a = autoGrid[y][x];
      if (a) {
        var ts = content.tilesets[a.tileset], img = Assets.get(ts.image);
        var info = Sc && Sc.tileInfo(ts.image);
        if (underlay && info && info.baseTile) {               // underlay: texture shows at ragged edges
          var bimg = Assets.get(info.baseTile);
          if (bimg) g.drawImage(bimg, 0, 0, bimg.width, bimg.height, dx, dy, T, T);
        }
        if (img) tileFromSheet(img, ts, a.tile, g, dx, dy, T);
        if (info && info.scatterKey && Sc) {                   // variety layer (baked, so it's free per frame)
          var interior = Autotile.effectiveMask(cells, x, y, edgeSame, overrides) === 255;
          Sc.scatterFor(info.scatterKey, x, y, interior).forEach(function (s) {
            var sh = Assets.get(Sc.sheetPath(info.dir, s.sheet)); if (!sh) return;
            g.save();
            if (s.flip) { g.translate(dx + T, dy); g.scale(-1, 1); g.drawImage(sh, s.sx, s.sy, NT, NT, 0, 0, T, T); }
            else g.drawImage(sh, s.sx, s.sy, NT, NT, dx, dy, T, T);
            g.restore();
          });
        }
      } else if (t.sprite) {
        var timg = Assets.get(t.sprite);
        if (timg) { var f0 = frameOf(timg, t.frames, t.frameMs, 0); g.drawImage(timg, 0, 0, f0.sw, f0.fh, dx, dy, T, T); }
      }
      // no art → nothing drawn (an artless terrain shows empty, so missing art is obvious)
    }

    for (var y = 0; y < map.height; y++) {
      for (var x = 0; x < map.width; x++) {
        var dx = x * T, dy = y * T;
        drawCell(base, auto, x, y, dx, dy, true, map.shapes);            // ground layer (opaque)
        if (autoOv) drawCell(overlay, autoOv, x, y, dx, dy, false, map.overlayShapes);   // overlay (transparent)
      }
    }

    // wall faces: a 2-tile front face under every wall cell whose south neighbour is not the same wall.
    for (var wy = 0; wy < map.height; wy++) {
      for (var wx = 0; wx < map.width; wx++) {
        var tid = map.terrain[wy][wx], wt = content.terrain[tid];
        if (!wt || !wt.autotile) continue;
        var wts = content.tilesets[wt.autotile], winfo = Sc && wts && Sc.tileInfo(wts.image);
        if (!winfo || !winfo.isWall) continue;
        if (wy + 1 < map.height && map.terrain[wy + 1][wx] === tid) continue;   // wall continues down
        var face = Assets.get(winfo.face); if (!face) continue;
        var l = hasFace(content, map, Sc, wx - 1, wy, tid), r = hasFace(content, map, Sc, wx + 1, wy, tid);
        var col = (!l && !r) ? 0 : (!l && r) ? 1 : (l && r) ? 2 : 3;            // single / left / middle / right
        g.drawImage(face, col * NT, 0, NT, face.height, wx * T, (wy + 1) * T, T, face.height * sc);
      }
    }

    // ground decals (blood etc.): one flat 32x32 cell from the sheet, under objects and characters.
    map.entities.forEach(function (e) {
      var o = content.objects[e.ref];
      if (!o || layerOf(o) !== 'ground_decal') return;
      var dimg = o.sprite && Assets.get(o.sprite); if (!dimg) return;
      var cell = (e.data && e.data.cell) | 0, cols = Math.max(1, Math.round(dimg.width / NT));
      g.drawImage(dimg, (cell % cols) * NT, Math.floor(cell / cols) * NT, NT, NT, e.x * T, e.y * T, T, T);
    });
    return c;
  }

  /** A neighbour wall cell that itself shows a face (same wall terrain, its south neighbour is not). */
  function hasFace(content, map, Sc, x, y, tid) {
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
    if (map.terrain[y][x] !== tid) return false;
    return !(y + 1 < map.height && map.terrain[y + 1][x] === tid);
  }

  function Renderer(canvas, content) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.content = content;
    this.ground = null;
    this.mapId = null;
  }

  Renderer.prototype.setMap = function (map) {
    this.map = map;
    this.mapId = map.id;
    this.ground = bakeGround(this.content, map);
    var content = this.content;
    this.wallNodes = connectorNodes(content, map);                                   // connector-style walls (flat top-down autotiled)
    this.wall25 = wall25(content, map);                                              // the rest: 2.5D cap + face pieces
    var c = this.content, animated = [];
    map.terrain.forEach(function (row, y) { row.forEach(function (tid, x) {
      var t = c.terrain[tid]; if (t && t.frames > 1 && t.sprite && !t.autotile) animated.push({ x: x, y: y, t: t });
    }); });
    this.animated = animated;
  };

  /**
   * cam = top-left of the view in pixels (may be fractional while walking).
   * actors = [{x, y (tiles, fractional while moving), facing, name?, sprite?, tint?, hp?, maxHp?, me?}]
   * opts = {states: {entityKey: state}, hidden: function(entity) -> true to skip drawing it}
   */
  Renderer.prototype.draw = function (cam, actors, opts) {
    var c = this.content, map = this.map, g = this.g, T = c.config.tile_size || 32;
    var states = (opts && opts.states) || {}, hidden = opts && opts.hidden;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    var ox = Math.round(-cam.x), oy = Math.round(-cam.y);
    g.drawImage(this.ground, ox, oy);

    var x0 = Math.floor(cam.x / T) - 1, y0 = Math.floor(cam.y / T) - 1;
    var x1 = x0 + Math.ceil(this.canvas.width / T) + 2, y1 = y0 + Math.ceil(this.canvas.height / T) + 3;
    var now = performance.now();

    // layer 2b: animated terrain (water, lava...) is drawn live over the baked ground
    if (this.animated.length) this.animated.forEach(function (a) {
      if (a.x < x0 || a.x > x1 || a.y < y0 || a.y > y1) return;
      var img = Assets.get(a.t.sprite); if (!img) return;
      var f = frameOf(img, a.t.frames, a.t.frameMs, now);
      g.drawImage(img, f.sx, 0, f.sw, f.fh, ox + a.x * T, oy + a.y * T, T, T);
    });

    // layer 3: collect objects for the merged back-to-front pass (layer 5). 'auto' = the WHOLE object (base +
    // tall overflow) y-sorts by its south edge with walls and characters, so a thing north of a wall is drawn
    // entirely behind it (cap included) and a thing south of it entirely in front. 'under' = whole object
    // drawn now (always behind everyone); 'over' = saved for the foreground. Ground decals are baked in.
    var overs = [], renderables = [];
    map.entities.forEach(function (e) {
      if (e.x < x0 - 4 || e.x > x1 || e.y < y0 - 3 || e.y > y1) return;   // wide/tall objects reach beyond their cell
      var o = c.objects[e.ref]; if (!o || (hidden && hidden(e)) || layerOf(o) === 'ground_decal') return;
      if (layerOf(o) === 'wall') {                                                      // hung on an edge face
        var wst = states[e.key], wp = objPath(o, wst, null), mp = wallMountPlace(map, o, e, ox, oy, T);
        renderables.push({ sortY: mp.sortY, obj: { o: o, path: wp, dx: mp.dx, dy: mp.dy, flip: mp.flip, st: wst, tall: hasTop(o, wp) } });
        return;
      }
      var st = states[e.key], facing = (e.data && e.data.facing) || null;
      var path = objPath(o, st, facing), flip = facing === 'left' || facing === 'W';
      var dx = ox + e.x * T, dy = oy + e.y * T, dz = o.draw || 'auto';
      if (dz === 'over') {
        overs.push({ o: o, path: path, y: e.y, dx: dx, dy: dy, flip: flip });
      } else if (dz === 'under') {
        drawObject(g, o, path, dx, dy, T, 'base', now, flip);                        // always behind everyone
        if (hasTop(o, path)) drawObject(g, o, path, dx, dy, T, 'top', now, flip);
        drawStateMark(g, o, st, dx, dy, T);
      } else {
        renderables.push({ sortY: Math.round(oy + e.y * T) + T, obj: { o: o, path: path, dx: dx, dy: dy, flip: flip, st: st, tall: hasTop(o, path) } });
      }
    });

    // layer 4b: connector-style walls, drawn top-down (autotiled) over the ground, under characters
    if (this.wallNodes && this.wallNodes.length) {
      var vis = this.wallNodes.filter(function (n) { return n.nx >= x0 - 1 && n.nx <= x1 + 1 && n.ny >= y0 - 1 && n.ny <= y1 + 2; });
      drawWallNodes(g, c, vis, ox, oy, T);
    }

    // layer 5: whole objects, 2.5D wall segments (face + cap), and characters, merged and drawn back-to-front
    // by their nearest-camera (south) edge. A wall gets a sub-pixel bias (face +0.25, cap +0.5) so that, at the
    // SAME base line, it draws after — and therefore over — an object or character sharing that line: anyone
    // standing right against a wall is one row north of it, i.e. behind it, so the wall must win that tie.
    // (Anything genuinely in front of the wall is a full tile further south, so the bias never flips it.)
    var prims = this.wall25 || [];
    prims.forEach(function (p) {
      if (p.x < x0 - 1 || p.x > x1 + 1 || p.y < y0 - 2 || p.y > y1 + 4) return;
      var isCap = p.kind === 'hcap' || p.kind === 'vcap';
      renderables.push({ sortY: prim25SortY(p, oy, T) + (isCap ? 0.5 : 0.25), prim: p });
    });
    actors.forEach(function (a) { renderables.push({ sortY: Math.round(oy + a.y * T) + T, actor: a }); });
    renderables.sort(function (p, q) { return p.sortY - q.sortY; });
    // Walls that hide the local player are drawn see-through (config: wall_fade off|tiles|run|radius,
    // wall_fade_radius tiles, wall_fade_alpha 0-1). Defaults: off / 3 / 0.35.
    var cfg = c.config || {}, fadeMode = cfg.wall_fade || 'off', fadeCells = null, fadeAlpha = 0.35;
    if (fadeMode !== 'off') {
      var meA = null; actors.forEach(function (a) { if (a.me) meA = a; });
      var fr = Number(cfg.wall_fade_radius); if (!(fr > 0)) fr = 3;
      if (cfg.wall_fade_alpha !== undefined && cfg.wall_fade_alpha !== '') fadeAlpha = Number(cfg.wall_fade_alpha);
      fadeCells = wallFadeCells(map, meA, fadeMode, fr);
    }
    renderables.forEach(function (r) {
      if (r.prim) {
        var fk = fadeCells && fadeCells[(r.prim.kind.charAt(0) === 'h' ? 'h:' : 'v:') + r.prim.x + ':' + r.prim.y];
        if (fk) g.globalAlpha = fadeAlpha;
        drawPrim25(g, c, r.prim, ox, oy, T);
        if (fk) g.globalAlpha = 1;
        return;
      }
      if (r.obj) {
        drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'base', now, r.obj.flip);
        if (r.obj.tall) drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'top', now, r.obj.flip);
        drawStateMark(g, r.obj.o, r.obj.st, r.obj.dx, r.obj.dy, T);
        return;
      }
      var a = r.actor;
      var ax = Math.round(ox + a.x * T), ay = Math.round(oy + a.y * T);
      var top = ay;                                                  // top of the drawn figure (busts rise above the tile)
      if (a.layers && a.layers.length) {
        top = drawLayers(g, a.layers, ax, ay, T, a.facing === 'W', a.aim);
      } else if (a.sprite !== undefined) {
        var img = a.sprite && Assets.get(a.sprite);
        if (img) {
          g.save();
          if (a.facing === 'W') { g.translate(ax + T, ay); g.scale(-1, 1); g.drawImage(img, 0, 0, T, T); }
          else g.drawImage(img, ax, ay, T, T);
          g.restore();
        } else g.drawImage(Assets.placeholder(a.name, '#8a2f2f', T), ax, ay);
      } else g.drawImage(Assets.hero(a.facing, a.tint || '#3d6fb6', T), ax, ay);
      if (a.statusColor) {                                           // tinted while burning, chilled, stunned...
        g.globalAlpha = .35; g.fillStyle = a.statusColor; g.fillRect(ax + 4, top + 4, T - 8, ay + T - top - 8); g.globalAlpha = 1;
      }
      if (a.maxHp && a.hp < a.maxHp && !a.me) {                       // health bar, just above the figure
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(ax + 4, top - 4, T - 8, 4);
        g.fillStyle = a.sprite !== undefined ? '#e04a3a' : '#4ec36a';
        g.fillRect(ax + 5, top - 3, Math.max(0, (T - 10) * a.hp / a.maxHp), 2);
      }
      if (a.name && a.sprite === undefined) {
        g.font = '8px sans-serif'; g.textAlign = 'center';
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(a.name, ax + T / 2 + 1, top - 5);
        g.fillStyle = a.me ? '#fff' : '#bfe0ff'; g.fillText(a.name, ax + T / 2, top - 6);
      }
    });

    // layer 5c: 'over' objects — the whole sprite sits in front of everything (foreground foliage, railings)
    overs.sort(function (a, b) { return a.y - b.y; }).forEach(function (t) {
      drawObject(g, t.o, t.path, t.dx, t.dy, T, 'base', now, t.flip);
      if (hasTop(t.o, t.path)) drawObject(g, t.o, t.path, t.dx, t.dy, T, 'top', now, t.flip);
    });
  };

  /** Aiming: cells in range, the line to the cursor, the cell under it (green = can cast) and the area it would hit. */
  Renderer.prototype.drawAim = function (cam, aim) {
    var g = this.g, T = this.content.config.tile_size || 32;
    g.fillStyle = 'rgba(255,255,255,.10)';
    aim.cells.forEach(function (c) { g.fillRect(Math.round(c.x * T - cam.x) + 1, Math.round(c.y * T - cam.y) + 1, T - 2, T - 2); });
    var h = aim.hover; if (!h) return;
    var col = h.ok ? '#6fe08a' : '#ff6b5b';
    g.strokeStyle = col; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(aim.from.x * T + T / 2 - cam.x, aim.from.y * T + T / 2 - cam.y); g.lineTo(h.x * T + T / 2 - cam.x, h.y * T + T / 2 - cam.y); g.stroke();
    g.setLineDash([]);
    if (h.ok && aim.blast) {                                  // explicit cells (a blast that stops at walls)
      g.fillStyle = 'rgba(255,170,80,.18)';
      aim.blast.forEach(function (c) { g.fillRect(Math.round(c.x * T - cam.x) + 1, Math.round(c.y * T - cam.y) + 1, T - 2, T - 2); });
    } else if (h.ok && aim.area) {
      g.fillStyle = 'rgba(255,170,80,.18)';
      g.fillRect(Math.round((h.x - aim.area) * T - cam.x), Math.round((h.y - aim.area) * T - cam.y), (2 * aim.area + 1) * T, (2 * aim.area + 1) * T);
    }
    g.lineWidth = 2; g.strokeRect(Math.round(h.x * T - cam.x) + 1, Math.round(h.y * T - cam.y) + 1, T - 2, T - 2);
  };

  /** Layer 6: projectiles, spell flashes, floating numbers and words (damage, healing, loot, level up). */
  Renderer.prototype.drawFx = function (cam, fx, now) {
    var g = this.g, T = this.content.config.tile_size || 32;
    g.textAlign = 'center';
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i], age = (now - f.t0) / (f.life || 900);
      if (age >= 1) { fx.splice(i, 1); continue; }
      if (age < 0) continue;
      if (f.kind === 'proj') {
        var px = (f.from.x + (f.to.x - f.from.x) * age) * T + T / 2 - cam.x, py = (f.from.y + (f.to.y - f.from.y) * age) * T + T / 2 - cam.y;
        g.fillStyle = f.color; g.globalAlpha = .35; g.beginPath(); g.arc(px, py, 7, 0, 7); g.fill();
        g.globalAlpha = 1; g.beginPath(); g.arc(px, py, 3.5, 0, 7); g.fill();
        continue;
      }
      if (f.kind === 'tracer') {                                      // a bullet streak that fades fast
        g.strokeStyle = f.color; g.globalAlpha = .9 * (1 - age); g.lineWidth = 2;
        g.beginPath(); g.moveTo(f.from.x * T + T / 2 - cam.x, f.from.y * T + T / 2 - cam.y); g.lineTo(f.to.x * T + T / 2 - cam.x, f.to.y * T + T / 2 - cam.y); g.stroke();
        g.globalAlpha = 1;
        continue;
      }
      if (f.kind === 'flash') {
        g.globalAlpha = .45 * (1 - age); g.fillStyle = f.color;
        if (f.cells) f.cells.forEach(function (c) { g.fillRect(Math.round(c.x * T - cam.x), Math.round(c.y * T - cam.y), T, T); });
        else g.fillRect(Math.round((f.x - f.r) * T - cam.x), Math.round((f.y - f.r) * T - cam.y), (2 * f.r + 1) * T, (2 * f.r + 1) * T);
        g.globalAlpha = 1;
        continue;
      }
      var x = Math.round(f.x * T + T / 2 - cam.x), y = Math.round(f.y * T - cam.y - age * 18);
      g.globalAlpha = 1 - age * age;
      g.font = 'bold ' + (f.big ? 12 : 10) + 'px sans-serif';
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillText(f.text, x + 1, y + 1);
      g.fillStyle = f.color; g.fillText(f.text, x, y);
    }
    g.globalAlpha = 1;
  };

  return { Renderer: Renderer, bakeGround: bakeGround, drawObject: drawObject, frameOf: frameOf,
    drawWall: drawWall, wallSegments: wallSegments, wallBaseY: wallBaseY, parseWallTok: parseWallTok,
    connectorNodes: connectorNodes, drawWallNodes: drawWallNodes, styleHasTiles: styleHasTiles,
    wall25: wall25, prim25SortY: prim25SortY, drawPrim25: drawPrim25,
    layerOf: layerOf, wallMountPlace: wallMountPlace };
})();
