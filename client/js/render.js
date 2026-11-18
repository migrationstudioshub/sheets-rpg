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
  // Nudge a #rrggbb colour lighter (f>0) or darker (f<0), for cap vs face contrast.
  function shade(hex, f) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex || '#8a8f98';
    var n = parseInt(m[1], 16), r = (n >> 16) & 255, gg = (n >> 8) & 255, b = n & 255;
    function a(v) { return Math.max(0, Math.min(255, Math.round(v + 255 * f))); }
    return 'rgb(' + a(r) + ',' + a(gg) + ',' + a(b) + ')';
  }
  // ---- walls with height (cap + face) ----
  // Every wall segment is a FACE (its height in tiles, rising north from its grid line, seen from the
  // south) plus a CAP on top. E-W segments are full cell width; N-S segments are thin. Contiguous N-S
  // segments overlap, each one tile further south and drawn on top, so their caps stack into a receding
  // top and only the southernmost face shows. Depth is faked: the cap is lit, the face darkens toward the
  // floor and under the cap's lip, side (N-S) faces are darker, and E-W walls drop a soft shadow south.
  /** Draw primitives (cap/face pieces) for every wall on the map. */
  function wall25(content, map) {
    var out = [], h = map.hWalls || [], v = map.vWalls || [], y, x, row, p;
    for (y = 0; y < h.length; y++) { row = h[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (!p) continue;
      out.push({ kind: 'hcap', x: x, y: y, h: p.height, style: p.style });
      out.push({ kind: 'hface', x: x, y: y, h: p.height, style: p.style });
    } }
    for (y = 0; y < v.length; y++) { row = v[y] || []; for (x = 0; x < row.length; x++) { p = parseWallTok(row[x]); if (!p) continue;
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
  /** Height in px of a CUT wall: the low stub left when a wall is dropped so you can see past it. */
  function stubPx(S) { return Math.max(3, Math.round(S * 0.28)); }
  /** Draw one wall piece. cut = draw it as a low stub instead of at its full height; dark (0-1) = how much
   *  darker to draw it (a wall surface that is indoors). */
  function drawPrim25(g, content, p, ox, oy, S, cut, dark) {
    function shadeOver(x0, y0, w, hgt) { if (dark > 0) { g.fillStyle = 'rgba(0,0,0,' + dark + ')'; g.fillRect(x0, y0, w, hgt); } }
    var st = (content.wallStyles && content.wallStyles[p.style]) || {}, col = st.color || '#8a8f98';
    var capImg = st.cap && Assets.get(st.cap), faceImg = st.face && Assets.get(st.face);
    // d = the cap's thickness AND the N-S wall's width (uniform): E-W cap lip is d tall, N-S wall/cap is d wide.
    var d = Math.max(4, Math.round(S * 0.32)), hd = Math.round(d / 2), H = cut ? stubPx(S) : p.h * S;
    function face(x0, y0, x1, y1, side) {
      var w = x1 - x0, hgt = y1 - y0; if (hgt <= 0) return;
      if (faceImg) { for (var yy = y0; yy < y1; yy += S) { var hh = Math.min(S, y1 - yy); g.drawImage(faceImg, 0, 0, faceImg.width, Math.max(1, Math.round(faceImg.height * hh / S)), x0, yy, w, hh); } }
      else { g.fillStyle = shade(col, -0.06); g.fillRect(x0, y0, w, hgt); g.strokeStyle = shade(col, -0.24); g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, hgt - 1); }
      shadeOver(x0, y0, w, hgt);
      if (side) { g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x0, y0, w, hgt); return; }      // a side face sits in shade
      var sh = Math.min(hgt, Math.round(S * 0.55)), gr = g.createLinearGradient(0, y1 - sh, 0, y1);   // darker toward the floor
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.26)');
      g.fillStyle = gr; g.fillRect(x0, y1 - sh, w, sh);
      g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(x0, y0, w, Math.max(1, Math.round(S * 0.06)));      // the cap lip's shadow
    }
    function cap(x0, y0, x1, y1) {
      if (capImg) g.drawImage(capImg, x0, y0, x1 - x0, y1 - y0);
      else { g.fillStyle = shade(col, 0.24); g.fillRect(x0, y0, x1 - x0, y1 - y0); g.strokeStyle = shade(col, 0.42); g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1); }
      shadeOver(x0, y0, x1 - x0, y1 - y0);
      g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(x0, y0, x1 - x0, 1);                         // a lit top edge
    }
    // The drawn edge is the BASE; the face rises UP (north) by its height; the cap is a lip of thickness d.
    // N-S walls can be shifted fully onto the left/right tile: side 'r' → body in the right tile (near edge on
    // the line), 'l' → left tile, else straddles the line centred. Offset is purely visual (collision stays on the line).
    var bx = ox + p.x * S, vx = ox + p.x * S;
    var voff = p.side === 'r' ? hd : p.side === 'l' ? -hd : 0;
    if (p.kind === 'hface') { var hb = oy + p.y * S; face(bx, hb - H, bx + S, hb, false); }
    else if (p.kind === 'hcap') { var ht = oy + p.y * S - H; cap(bx, ht - d, bx + S, ht); }
    else if (p.kind === 'vface') { var vb = oy + (p.y + 1) * S; face(vx - hd + voff, vb - H, vx + hd + voff, vb, true); }   // thin face, rising north
    else if (p.kind === 'vcap') { var vt = oy + (p.y + 1) * S - H; cap(vx - hd + voff, vt - S, vx + hd + voff, vt); }      // 1-tile cap on top of the face
  }
  // The soft shadow an E-W wall drops on the floor just south of it (one cached strip per cell size).
  var _shadow = {};
  function shadowStrip(S) {
    if (_shadow[S] || typeof document === 'undefined') return _shadow[S];
    var cv = document.createElement('canvas'), hh = Math.max(2, Math.round(S * 0.36)); cv.width = S; cv.height = hh;
    var sg = cv.getContext('2d'), gr = sg.createLinearGradient(0, 0, 0, hh);
    gr.addColorStop(0, 'rgba(0,0,0,.34)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = gr; sg.fillRect(0, 0, S, hh);
    return (_shadow[S] = cv);
  }

  // ---- what the local player sees and knows (the ONE place occlusion is decided) ----
  // opts.vis      {"x,y":1} cells in the player's line of sight right now (World.visibleCells); null = no
  //               sight system, everything counts as seen.
  // opts.memory   {"x,y":1} cells seen earlier this session.
  // opts.explored {zoneId:1} rooms the player has been inside (persisted by the referee).
  // A map's roof grid marks INDOOR cells. Each cell is then one of:
  //   seen     in sight now — drawn normally, creatures included
  //   known    not in sight, but outdoors or remembered — layout drawn dimmed, creatures hidden
  //   unknown  indoors and never seen — covered by the roof
  // cutH answers the one cutaway question: should this E-W wall drop to a stub? Yes when it stands south of
  // the player (between them and the camera) and its face would cover a cell the player currently sees that
  // is either in the player's own room or within `radius` tiles of them. So the front wall of the room you
  // are in drops, the wall you are standing behind drops, and a building you look at from outside stays whole.
  function makeSight(map, me, opts, radius) {
    var vis = opts.vis || null, memory = opts.memory, explored = opts.explored;
    var zoneOf = (map.roof && typeof World !== 'undefined' && World.roofZones) ? World.roofZones(map) : {};
    var mx = me ? Math.round(me.x) : -99, my = me ? Math.round(me.y) : -99;
    var curZone = me ? (zoneOf[mx + ',' + my] || null) : null;
    function seen(x, y) { return !vis || !!vis[x + ',' + y]; }
    function known(x, y) {
      var k = x + ',' + y, z = zoneOf[k];
      if (!vis || !z) return true;
      return !!(vis[k] || (memory && memory[k]) || (explored && explored[z]));
    }
    function edgeKnown(orient, x, y) {                      // a wall shows when either cell beside it is known
      return orient === 'h' ? (known(x, y - 1) || known(x, y)) : (known(x - 1, y) || known(x, y));
    }
    function cutH(x, y, h) {
      if (!me || y <= my) return false;
      for (var yy = y - 1; yy >= y - h && yy >= 0; yy--) {
        if (!seen(x, yy)) continue;
        if (Math.max(Math.abs(x - mx), Math.abs(yy - my)) <= radius) return true;
        if (curZone && zoneOf[x + ',' + yy] === curZone) return true;
      }
      return false;
    }
    function indoor(x, y) { return !!zoneOf[x + ',' + y]; }
    return { vis: vis, seen: seen, known: known, edgeKnown: edgeKnown, cutH: cutH, indoor: indoor };
  }
  /** Something the player cannot see but senses (heard, say): a faint outline that gives no detail away. */
  function drawSensed(g, ax, ay, T) {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1; if (g.setLineDash) g.setLineDash([3, 3]);
    g.beginPath(); g.ellipse(ax + T / 2, ay + T * 0.35, T * 0.28, T * 0.55, 0, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  // ---- doors and archways in E-W walls ----
  // A door / archway fixture renders as the wall-face span it covers (W tiles wide) with the door asset
  // composited in: drawn over the face when CLOSED, and punched OUT of the face (exact sprite shape, via
  // destination-out) when OPEN — so an open door is a real see-through hole the shape of the door. When its
  // wall is CUT the stub is left out across the door's whole width, so the doorway reads as a gap; a closed
  // door stands in that gap, solid, and an open one leaves it empty. job = {o, e, ed (its first edge), W, open, cut}.
  var _doorCv = null;
  function doorCanvas(w, h) {
    if (!_doorCv && typeof document !== 'undefined') _doorCv = document.createElement('canvas');
    if (!_doorCv) return null;
    _doorCv.width = Math.max(1, w); _doorCv.height = Math.max(1, h);     // setting size also clears it
    return _doorCv;
  }
  function drawDoor(g, content, map, job, ox, oy, S, cutA) {
    var o = job.o, ed = job.ed, W = job.W, open = job.open;
    var tok = parseWallTok((map.hWalls && map.hWalls[ed.y] && map.hWalls[ed.y][ed.x]) || '');
    var H = (tok && tok.height) || 2, st = (tok && content.wallStyles && content.wallStyles[tok.style]) || {};
    var faceImg = st.face && Assets.get(st.face), col = st.color || '#8a8f98';
    var line = oy + ed.y * S, fx = ox + ed.x * S, fw = W * S, fh = H * S, faceTop = line - fh;
    // The door asset at its NATURAL size (32px/tile), centred over the opening's width and BOTTOM-ANCHORED on
    // the wall's base line, with the same offset_x/offset_y pixel nudges as other wall objects. One rect, reused
    // for both the closed panel and the open cutout, so the punched hole always lines up with the drawn door.
    var sc = S / NT, dImg0 = o.sprite && Assets.get(o.sprite);
    var offX = Number((o.properties && o.properties.offset_x) || 0) * sc;
    var offY = Number((o.properties && o.properties.offset_y) || 0) * sc;
    var dw = dImg0 ? Math.round(dImg0.width * sc) : S;
    var dh = dImg0 ? Math.round(dImg0.height * sc) : Math.min(fh, 2 * S);
    var doorLeft = fx + (fw - dw) / 2 + offX, doorBottom = line + offY, doorTop = doorBottom - dh;
    // An open door with its own picture (sprite_states "open=…", e.g. the frame with the leaf swung away) shows
    // that picture in the doorway; without one an open door is just the hole. Placed like the closed door.
    var oImg = open && o.spriteStates && o.spriteStates.open && Assets.get(o.spriteStates.open);
    function drawOpen() {
      if (!oImg) return;
      var ow = Math.round(oImg.width * sc), oh = Math.round(oImg.height * sc);
      g.drawImage(oImg, 0, 0, oImg.width, oImg.height, fx + (fw - ow) / 2 + offX, doorBottom - oh, ow, oh);
    }
    if (job.cut) {                                        // the wall pass leaves the doorway clear of stub
      if (open) { drawOpen(); return; }                   // open: the open-door picture, or just the gap
      if (dImg0) g.drawImage(dImg0, 0, 0, dImg0.width, dImg0.height, doorLeft, doorTop, dw, dh);
      else { g.fillStyle = shade(col, -0.32); g.fillRect(doorLeft, doorTop, dw, dh); g.strokeStyle = shade(col, -0.5); g.strokeRect(doorLeft + 0.5, doorTop + 0.5, dw - 1, dh - 1); }
      return;
    }
    // Buffer sized to the union of the wall face and the door rect, so a nudge never clips the cutout.
    var uL = Math.min(fx, doorLeft), uT = Math.min(faceTop, doorTop);
    var uR = Math.max(fx + fw, doorLeft + dw), uB = Math.max(line, doorBottom);
    var off = doorCanvas(Math.ceil(uR - uL), Math.ceil(uB - uT)); if (!off) return;
    var og = off.getContext('2d'); og.imageSmoothingEnabled = false;
    var faceX = fx - uL, faceY = faceTop - uT;                                // the wall face within the buffer
    if (faceImg) { for (var yy = 0; yy < fh; yy += S) { var hh = Math.min(S, fh - yy); for (var xx = 0; xx < fw; xx += S) og.drawImage(faceImg, 0, 0, faceImg.width, Math.max(1, Math.round(faceImg.height * hh / S)), faceX + xx, faceY + yy, S, hh); } }
    else { og.fillStyle = shade(col, -0.06); og.fillRect(faceX, faceY, fw, fh); }
    var dX = doorLeft - uL, dY = doorTop - uT;
    if (dImg0) {
      og.globalCompositeOperation = open ? 'destination-out' : 'source-over';       // open punches the exact door shape out of the face
      og.drawImage(dImg0, 0, 0, dImg0.width, dImg0.height, dX, dY, dw, dh);
      og.globalCompositeOperation = 'source-over';
    } else if (open) og.clearRect(dX, dY, dw, dh);                                   // no art: a plain rectangular hole / panel
    else { og.fillStyle = shade(col, -0.32); og.fillRect(dX, dY, dw, dh); og.strokeStyle = shade(col, -0.5); og.strokeRect(dX + 0.5, dY + 0.5, dw - 1, dh - 1); }
    g.drawImage(off, uL, uT);
    drawOpen();
  }

  // Fill a colour over a wall prim's drawn area (mirrors drawPrim25's rects) — used to tint a closed door
  // set in a thin N-S wall, and to put the roof over an interior wall face that has not been seen.
  function primRectFill(g, p, ox, oy, S, col) {
    var d = Math.max(4, Math.round(S * 0.32)), hd = Math.round(d / 2), voff = p.side === 'r' ? hd : p.side === 'l' ? -hd : 0;
    g.fillStyle = col;
    if (p.kind === 'hface') { var hb = oy + p.y * S; g.fillRect(ox + p.x * S, hb - p.h * S, S, p.h * S); }
    else if (p.kind === 'hcap') { var ht = oy + p.y * S - p.h * S; g.fillRect(ox + p.x * S, ht - d, S, d + 1); }
    else if (p.kind === 'vface') { var vb = oy + (p.y + 1) * S; g.fillRect(ox + p.x * S - hd + voff, vb - p.h * S, d, p.h * S); }
    else if (p.kind === 'vcap') { var vt = oy + (p.y + 1) * S - p.h * S; g.fillRect(ox + p.x * S - hd + voff, vt - S, d, S + 1); }
  }


  // ---- wall fixtures (layer:'wall') ----
  /** What kind of opening a fixture is: 'door' | 'window' | 'arch' | '' (same rule as World.openingOf). */
  function openingOf(o) {
    if (layerOf(o) !== 'wall') return '';
    if (o.kind === 'door') return 'door';
    var t = o.properties && o.properties.opening;
    return t === 'window' || t === 'arch' ? t : '';
  }
  /** Every edge a fixture spans, as [{orient, x, y}] (same rule as World.fixtureEdges). */
  function fixtureEdges(o, e) {
    var ed = mountEdge(e.x, e.y, mountSide(e)), out = [], k;
    if (ed.orient === 'h') { var w = Math.max(1, o.footprintW || 1); for (k = 0; k < w; k++) out.push({ orient: 'h', x: ed.ex + k, y: ed.ey }); }
    else { var hh = Math.max(1, o.footprintH || 1); for (k = 0; k < hh; k++) out.push({ orient: 'v', x: ed.ex, y: ed.ey - k }); }
    return out;
  }
  // A wall object hangs on ONE edge of its cell: side N/S = the horizontal wall on the cell's north/south
  // grid line, W/E = the vertical wall on its west/east line. Its sprite is drawn at its natural size (like a
  // floor object, 32px/tile) with its BOTTOM EDGE anchored on that wall's base grid line — so it stands on the
  // floor regardless of wall height, and a tall door/shelf never floats. data.mount raises it in whole tiles
  // (coarse); offset_x/offset_y (px, on the object) fine-tune. It sorts just after the face so it sits ON the
  // wall. Collision is unchanged — the wall edge already blocks and the object's own tile stays walkable.
  function mountSide(e) { return String((e.data && (e.data.side || e.data.facing)) || 'N').toUpperCase().charAt(0); }
  function mountEdge(x, y, side) {
    if (side === 'S') return { orient: 'h', ex: x, ey: y + 1 };
    if (side === 'W') return { orient: 'v', ex: x, ey: y };
    if (side === 'E') return { orient: 'v', ex: x + 1, ey: y };
    return { orient: 'h', ex: x, ey: y };                        // 'N' (default)
  }
  /** How far (px) the N-S wall on the west edge of cell (x,y) is drawn off its grid line: a wall painted
   *  "cursor side" sits half its thickness to the left ('l') or right ('r'); a centred wall, or none, is 0.
   *  Anything standing on that wall shifts by the same amount so it stays on the wall. */
  function vWallOff(map, x, y, S) {
    var t = parseWallTok(map && map.vWalls && map.vWalls[y] && map.vWalls[y][x]);
    if (!t || t.side === 'c') return 0;
    var hd = Math.round(Math.max(4, Math.round(S * 0.32)) / 2);
    return t.side === 'r' ? hd : t.side === 'l' ? -hd : 0;
  }
  /** Screen placement {dx, dy, sortY, flip} for a wall-mounted object entity. (ox,oy)=map origin, S=cell px.
   *  dy is the footprint-cell origin: drawObject bottom-anchors the sprite at dy+S, i.e. on the wall's base. */
  function wallMountPlace(map, o, e, ox, oy, S) {
    var side = mountSide(e), ed = mountEdge(e.x, e.y, side);
    var mount = Number((e.data && e.data.mount != null) ? e.data.mount : (o.properties && o.properties.mount)) || 0;
    if (ed.orient === 'h') {
      var baseLine = oy + ed.ey * S;                             // the wall's grid line = the base the sprite stands on
      return { dx: ox + ed.ex * S, dy: baseLine - S - mount * S, sortY: baseLine + 0.26, flip: false };
    }
    var vline = ox + ed.ex * S + vWallOff(map, ed.ex, ed.ey, S), vbase = oy + (ed.ey + 1) * S;    // foot of the vertical (N-S) wall, following an off-centre wall
    return { dx: vline - S / 2, dy: vbase - S - mount * S, sortY: vbase + 0.26, flip: side === 'E' };
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
    // Per-object pixel nudges (authored at 32px/tile): offset_x (+ = right) and offset_y (+ = down, − = up).
    var offY = (o.offsetY || 0) * sc;
    var offX = Number((o.properties && o.properties.offset_x) || 0) * sc;
    dx += offX;
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
    }
  }
  function hasTop(o, path) {
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
    this.wall25 = wall25(content, map);                                              // every wall as cap + face pieces
    var c = this.content, animated = [];
    map.terrain.forEach(function (row, y) { row.forEach(function (tid, x) {
      var t = c.terrain[tid]; if (t && t.frames > 1 && t.sprite && !t.autotile) animated.push({ x: x, y: y, t: t });
    }); });
    this.animated = animated;
  };

  /**
   * cam = top-left of the view in pixels (may be fractional while walking).
   * actors = [{x, y (tiles, fractional while moving), facing, name?, sprite?, tint?, hp?, maxHp?, me?}]
   * opts = {states: {entityKey: state}, hidden: function(entity) -> true to skip drawing it,
   *         vis, memory, explored, sensed: what the local player sees / remembers (see makeSight)}
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

    // ---- sight: what the local player sees / knows this frame (see makeSight) ----
    var cfg = c.config || {}, o2 = opts || {};
    var meActor = null; actors.forEach(function (a) { if (a.me) meActor = a; });
    var cutR = Number(cfg.wall_cut_radius); if (!(cutR >= 0)) cutR = 3;
    var cutA = Number(cfg.wall_cut_alpha); if (!(cutA > 0 && cutA <= 1)) cutA = 0.45;
    var fogA = cfg.fog_alpha === undefined || cfg.fog_alpha === '' ? 0.32 : Number(cfg.fog_alpha); if (!(fogA >= 0 && fogA <= 1)) fogA = 0.32;
    var roofCol = (map.roof_color) || cfg.roof_color || '#15121c';
    var sight = makeSight(map, meActor, o2, cutR);
    var prims = this.wall25 || [];

    // layer 2c: the soft shadow each E-W wall drops on the floor south of it
    var strip = shadowStrip(T);
    if (strip) prims.forEach(function (p) {
      if (p.kind !== 'hface' || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1 || p.y >= map.height) return;
      if (sight.edgeKnown('h', p.x, p.y)) g.drawImage(strip, ox + p.x * T, oy + p.y * T);
    });
    // layer 2d: fog and roof over the ground — a dim veil on cells out of sight, the roof on unknown interiors
    var cx, cy, xa = Math.max(0, x0), xb = Math.min(map.width - 1, x1), ya = Math.max(0, y0), yb = Math.min(map.height - 1, y1);
    if (sight.vis) {
      if (fogA > 0) { g.fillStyle = 'rgba(0,0,0,' + fogA + ')';
        for (cy = ya; cy <= yb; cy++) for (cx = xa; cx <= xb; cx++) if (!sight.seen(cx, cy) && sight.known(cx, cy)) g.fillRect(ox + cx * T, oy + cy * T, T, T); }
      g.fillStyle = roofCol;
      for (cy = ya; cy <= yb; cy++) for (cx = xa; cx <= xb; cx++) if (!sight.known(cx, cy)) g.fillRect(ox + cx * T, oy + cy * T, T, T);
    }
    // layer 2e: indoors is darker (config indoor_dark, 0-1; 0 = off). The floor gets a veil here; whatever
    // stands indoors — objects, characters, the wall surfaces facing into the room — is drawn darker to match
    // in the sorted pass below (see dim), so a room reads as one dim space while outside stays bright.
    var dark = cfg.indoor_dark === undefined || cfg.indoor_dark === '' ? 0.25 : Number(cfg.indoor_dark); if (!(dark >= 0 && dark < 1)) dark = 0.25;
    if (dark > 0) { g.fillStyle = 'rgba(0,0,0,' + dark + ')';
      for (cy = ya; cy <= yb; cy++) for (cx = xa; cx <= xb; cx++) if (sight.indoor(cx, cy) && sight.known(cx, cy)) g.fillRect(ox + cx * T, oy + cy * T, T, T); }
    var canFilter = dark > 0 && typeof g.filter === 'string';
    function dim(on) { if (canFilter) g.filter = on ? 'brightness(' + (1 - dark) + ')' : 'none'; }
    function inDark(x, y) { return dark > 0 && sight.indoor(Math.round(x), Math.round(y)); }

    // layer 3: collect objects for the merged back-to-front pass (layer 5). 'auto' = the WHOLE object (base +
    // tall overflow) y-sorts by its south edge with walls and characters, so a thing north of a wall is drawn
    // entirely behind it (cap included) and a thing south of it entirely in front. 'under' = whole object
    // drawn now (always behind everyone); 'over' = saved for the foreground. Ground decals are baked in.
    // Anything on an unknown (roofed, never seen) cell is not drawn at all.
    function wallH(q) { var t = parseWallTok(((q.orient === 'h' ? map.hWalls : map.vWalls) || [])[q.y] && ((q.orient === 'h' ? map.hWalls : map.vWalls)[q.y][q.x])); return t ? t.height : 2; }
    var overs = [], renderables = [], doorFaces = {}, doorGap = {}, vDoor = {};
    map.entities.forEach(function (e) {
      if (e.x < x0 - 4 || e.x > x1 || e.y < y0 - 3 || e.y > y1) return;   // wide/tall objects reach beyond their cell
      var o = c.objects[e.ref]; if (!o || (hidden && hidden(e)) || layerOf(o) === 'ground_decal') return;
      if (layerOf(o) === 'wall') {                                        // a fixture on a wall edge
        var opening = openingOf(o), edges = fixtureEdges(o, e), ed0 = edges[0], isH = ed0.orient === 'h';
        // A plain mount belongs to the cell it is seen from (its own); an opening shows from either side.
        var show = sight.known(e.x, e.y) || (opening && edges.some(function (q) { return sight.edgeKnown(q.orient, q.x, q.y); }));
        if (!show) return;
        var cut = isH && edges.some(function (q) { return sight.cutH(q.x, q.y, wallH(q)); });
        // An opening in an inside face the player has never seen (the cell south of it is unknown) stays under
        // the roof with its wall; it only shows once that wall drops, i.e. when it is in the player's view.
        if (isH && opening && !cut && !sight.known(ed0.x, ed0.y)) return;
        if (opening === 'door' || opening === 'arch') {
          var dOpen = opening === 'arch' || states[e.key] === 'open';
          if (isH) {
            edges.forEach(function (q) { doorFaces[q.x + ',' + q.y] = 1; if (cut) doorGap[q.x + ',' + q.y] = 1; });   // the door draws these faces itself; on a cut wall its whole width is a gap in the stub
            renderables.push({ sortY: oy + ed0.y * T + 0.6, dark: inDark(ed0.x, ed0.y), door: { o: o, e: e, ed: ed0, W: edges.length, open: dOpen, cut: cut } });
          } else edges.forEach(function (q) {
            vDoor[q.x + ',' + q.y] = dOpen ? 'open' : 'shut';   // in a thin N-S wall: a gap, or a tinted slab
            // A side door is seen edge-on, so it is marked on the floor: a doorstep laid across the wall line,
            // reaching into the tile on either side. Drawn now, on the ground, under walls and characters.
            // The door's own picture is that doorstep when it has one: sprite (closed) / sprite_states open,
            // drawn flat on the floor at its natural size, centred on the wall line (a 64x32 image covers the
            // tile on each side), with the usual offset_x / offset_y nudges. Without art: a plain pale plate.
            var wOff = vWallOff(map, q.x, q.y, T);               // follow a wall painted to one side of its line
            // The doorstep reads as an icon, not as part of the building, so it only shows while you can see
            // it: each half (it lies across two tiles) is drawn only when its tile is in sight right now —
            // not from memory, and never on a tile still under the roof.
            var kW = sight.seen(q.x - 1, q.y), kE = sight.seen(q.x, q.y);
            if (!kW && !kE) return;
            g.save(); g.beginPath();
            if (kW) g.rect(ox + (q.x - 1) * T, oy + (q.y - 1) * T, T, T * 3);
            if (kE) g.rect(ox + q.x * T, oy + (q.y - 1) * T, T, T * 3);
            g.clip();
            var sImg = Assets.get(objPath(o, dOpen ? 'open' : null, null));
            if (sImg && sImg.width) {
              var ssc = T / NT, sw = Math.round(sImg.width * ssc), sh = Math.round(sImg.height * ssc);
              var pp = o.properties || {};
              g.drawImage(sImg, 0, 0, sImg.width, sImg.height,
                Math.round(ox + q.x * T - sw / 2 + wOff + Number(pp.offset_x || 0) * ssc),
                Math.round(oy + q.y * T + (T - sh) / 2 + Number(pp.offset_y || 0) * ssc), sw, sh);
              g.restore(); return;
            }
            var tw = Math.round(T * 1.1), tx = Math.round(ox + q.x * T - tw / 2) + wOff, ty = Math.round(oy + q.y * T) + 2, th = T - 4;
            g.fillStyle = 'rgba(214,200,170,.30)'; g.fillRect(tx, ty, tw, th);
            g.strokeStyle = 'rgba(235,225,200,.55)'; g.lineWidth = 1; g.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
            g.restore();
          });
          return;
        }
        // On a cut wall, windows stay standing (solid) and things you can use stay too (faint); pure decoration drops with the wall.
        if (cut && !opening && o.kind === 'deco') return;
        var wst = states[e.key], wp = objPath(o, wst, null), mp = wallMountPlace(map, o, e, ox, oy, T);
        renderables.push({ sortY: mp.sortY, alpha: cut && !opening ? cutA : 1, dark: inDark(e.x, e.y),   // a window stands solid like a door; other fixtures go faint
          obj: { o: o, path: wp, dx: mp.dx, dy: mp.dy, flip: mp.flip, st: wst, tall: hasTop(o, wp) } });
        return;
      }
      if (!sight.known(e.x, e.y)) return;                                 // inside a room never seen
      var st = states[e.key], facing = (e.data && e.data.facing) || null;
      var path = objPath(o, st, facing), flip = facing === 'left' || facing === 'W';
      var dx = ox + e.x * T, dy = oy + e.y * T, dz = o.draw || 'auto';
      if (dz === 'over') {
        overs.push({ o: o, path: path, y: e.y, dx: dx, dy: dy, flip: flip });
      } else if (dz === 'under') {
        dim(inDark(e.x, e.y));
        drawObject(g, o, path, dx, dy, T, 'base', now, flip);                        // always behind everyone
        if (hasTop(o, path)) drawObject(g, o, path, dx, dy, T, 'top', now, flip);
        drawStateMark(g, o, st, dx, dy, T);
        dim(false);
      } else {
        renderables.push({ sortY: Math.round(oy + e.y * T) + T, dark: inDark(e.x, e.y), obj: { o: o, path: path, dx: dx, dy: dy, flip: flip, st: st, tall: hasTop(o, path) } });
      }
    });

    // layer 5: whole objects, wall pieces (face + cap), and characters, merged and drawn back-to-front by
    // their nearest-camera (south) edge. A wall gets a sub-pixel bias (face +0.25, cap +0.5) so that, at the
    // SAME base line, it draws after — and therefore over — an object or character sharing that line: anyone
    // standing right against a wall is one row north of it, i.e. behind it, so the wall must win that tie.
    // (Anything genuinely in front of the wall is a full tile further south, so the bias never flips it.)
    prims.forEach(function (p) {
      if (p.x < x0 - 1 || p.x > x1 + 1 || p.y < y0 - 2 || p.y > y1 + 4) return;
      var isCap = p.kind === 'hcap' || p.kind === 'vcap', isV = p.kind === 'vface' || p.kind === 'vcap';
      var vd = isV ? vDoor[p.x + ',' + p.y] : null;
      if (vd === 'open') return;                                                // an open door / arch in a thin wall: a gap
      if (!sight.edgeKnown(isV ? 'v' : 'h', p.x, p.y)) return;                  // a wall wholly inside unknown rooms
      if (p.kind === 'hface' && doorFaces[p.x + ',' + p.y]) return;             // a door draws this face region itself
      if (p.kind === 'hcap' && doorGap[p.x + ',' + p.y]) return;                // a doorway in a cut wall: no stub across it
      renderables.push({ sortY: prim25SortY(p, oy, T) + (isCap ? 0.5 : 0.25), prim: p,
        cut: !isV && sight.cutH(p.x, p.y, p.h), shut: vd === 'shut' && !isCap,
        // An E-W wall's face is the side seen from the cell SOUTH of it. If that cell is an unknown interior,
        // the face is an inside wall the player has never seen: the roof covers it (the cap still outlines the building).
        // A thin N-S face is likewise seen from the two cells just south of its segment (either side of the
        // line): where an outer wall's run ends against the inside of the building, both are unknown interior.
        roofed: (p.kind === 'hface' && !sight.known(p.x, p.y)) ||
                (p.kind === 'vface' && !sight.known(p.x - 1, p.y + 1) && !sight.known(p.x, p.y + 1)),
        // An E-W wall's face and top are lit by the cell south of it; a thin N-S wall is indoors only when both
        // cells beside it are (an inner partition) — an outer wall keeps its daylight.
        dark: (isV ? (inDark(p.x - 1, p.y) && inDark(p.x, p.y)) : inDark(p.x, p.y)) ? dark : 0 });
    });
    actors.forEach(function (a) {
      // seen = drawn; sensed = an outline (the hook for a hearing sense); hidden = not drawn
      var how = a.me || !sight.vis ? 'seen' : World.perceive(sight.vis, o2.sensed, a.x, a.y);
      if (how === 'hidden') return;
      renderables.push({ sortY: Math.round(oy + a.y * T) + T, actor: a, sensed: how === 'sensed', dark: inDark(a.x, a.y) });
    });
    renderables.sort(function (p, q) { return p.sortY - q.sortY; });
    renderables.forEach(function (r) {
      if (r.door) { dim(r.dark); drawDoor(g, c, map, r.door, ox, oy, T, cutA); dim(false); return; }
      if (r.prim) {
        if (r.roofed && !r.cut) primRectFill(g, r.prim, ox, oy, T, roofCol);
        else drawPrim25(g, c, r.prim, ox, oy, T, r.cut, r.dark);
        if (r.shut) primRectFill(g, r.prim, ox, oy, T, 'rgba(46,30,16,.55)');
        return;
      }
      if (r.obj) {
        if (r.alpha < 1) g.globalAlpha = r.alpha;
        dim(r.dark);
        drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'base', now, r.obj.flip);
        if (r.obj.tall) drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'top', now, r.obj.flip);
        drawStateMark(g, r.obj.o, r.obj.st, r.obj.dx, r.obj.dy, T);
        dim(false);
        g.globalAlpha = 1;
        return;
      }
      var a = r.actor;
      if (r.sensed) { drawSensed(g, Math.round(ox + a.x * T), Math.round(oy + a.y * T), T); return; }
      var ax = Math.round(ox + a.x * T), ay = Math.round(oy + a.y * T);
      var top = ay;                                                  // top of the drawn figure (busts rise above the tile)
      dim(r.dark);
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
      dim(false);
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
    parseWallTok: parseWallTok, wall25: wall25, prim25SortY: prim25SortY, drawPrim25: drawPrim25, makeSight: makeSight,
    layerOf: layerOf, wallMountPlace: wallMountPlace };
})();
