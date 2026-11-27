/**
 * Draws a map in layers, bottom to top:
 *   1 base colour  2 terrain tile (sprite or autotile)  3 objects
 *   4 ground items (later)  5 characters  6 effects (later)
 * Layers 1-2 never change while on a map, so they are painted once into an
 * offscreen canvas; objects and characters are drawn every frame on top.
 */
var Render = (function () {
  // frame (optional): an animated tileset's image holds ts.frames whole sheets side by side; this picks one.
  function tileFromSheet(img, ts, n, g, dx, dy, size, frame) {
    var i = n - 1, sx = (i % ts.columns) * ts.tileSize, sy = Math.floor(i / ts.columns) * ts.tileSize;
    if (frame) sx += frame * ts.columns * ts.tileSize;
    g.drawImage(img, sx, sy, ts.tileSize, ts.tileSize, dx, dy, size, size);
  }
  /** The sheet a terrain's autotile is cut from: the tileset's image, in the terrain's tint if it has one. */
  function groundSheet(content, t, ts) {
    var img = ts && Assets.get(ts.image);
    if (!img || !t || !t.tint || typeof Tint === 'undefined' || !Tint.tintedOver) return img;
    return Tint.tintedOver(img, Assets.get(ts.image.replace(/\.png$/i, '.tint.png')), Tint.TINTS[t.tint]);
  }
  // ---- ground height, drawn raised (stage 2) ----
  // A tile at height h is drawn h tiles higher on the screen; where the ground drops to the south its cliff face
  // fills the gap. Everything that stands on the ground is drawn with the same lift (liftAt), but keeps its place in
  // the back-to-front order by where it stands on the map. The baked ground has a margin on top for the lift
  // (canvas.pad). A ramp climbing north is its tile stretched over two; climbing east or west it is sheared;
  // climbing south it is seen edge-on, so it takes no room on the screen at all.
  function elevOn(map) { return !!(map && map.elev && map.elev.length && typeof Rules !== 'undefined' && Rules.groundHeight); }
  function maxElev(map) {
    var top = 0;
    if (elevOn(map)) for (var y = 0; y < map.height; y++) for (var x = 0; x < map.width; x++) {
      var h = Rules.heightAt(map, x, y) + (Rules.rampAt(map, x, y) ? 1 : 0); if (h > top) top = h;
    }
    return top;
  }
  /** How many pixels higher something standing at (x, y) is drawn (x, y = the tile, fractions allowed while walking). */
  function liftAt(map, x, y, T) { return elevOn(map) ? Math.round(Rules.groundHeight(map, x + 0.5, y + 0.5) * T) : 0; }
  function liftIn(map, x, y, T) { return elevOn(map) ? liftAt(map, Math.max(0, Math.min(map.width - 1, x)), Math.max(0, Math.min(map.height - 1, y)), T) : 0; }
  /** Which tile is under a point of the raised picture (px, py in map pixels, before any lift): the one drawn there. */
  function pickCell(map, px, py, T) { return pickCells(map, px, py, T)[0]; }
  /** Every tile whose picture covers that point, the one drawn on top first. Raised ground is drawn over the ground
   *  behind it, so one spot of the screen can belong to several tiles of different heights: a click may mean any of them. */
  function pickCells(map, px, py, T) {
    var x = Math.floor(px / T), flat = { x: x, y: Math.floor(py / T) }, out = [];
    if (!elevOn(map) || x < 0 || x >= map.width) return [flat];
    var u = px / T - x, top = maxElev(map);
    for (var y = Math.min(map.height - 1, flat.y + top + 1); y >= Math.max(0, flat.y); y--) {      // the nearest one wins: it is drawn last
      var h = Rules.heightAt(map, x, y), r = Rules.rampAt(map, x, y);
      if (r === 'S') continue;                                                                    // edge-on: no room on the screen
      var hi = r === 'N' ? h + 1 : r === 'E' ? h + u : r === 'W' ? h + 1 - u : h;                   // its far (north) edge…
      var lo = r === 'N' ? h : hi;                                                                // …and its near one
      var below = Rules.groundHeight(map, x + u, y + 1.001);                                      // the ground just south: the face reaches down to it
      var y0 = (y - hi) * T, y1 = (y + 1 - Math.min(lo, below)) * T;
      if (py >= y0 && py < y1) out.push({ x: x, y: y });
    }
    return out.length ? out : [flat];
  }

  // ---- waterfalls ----
  // Where water lies on raised ground and the ground drops away to the south, the water falls down the cliff face.
  // A fall is a moving strip drawn over the (baked, still) face: frames side by side, each frame four tiles wide
  // (single, left, middle, right), one tile high and repeated down the face. Which tiles have one:
  //   - by itself: a terrain that is water (or has its own 'fall' picture), unless Config waterfalls = off;
  //   - by hand: map.falls[y][x] (the map editor) = '1' a fall here whatever the ground, a tint name = a fall in
  //     that colour, '0' = none here even over water. '' = by itself.
  // The picture is the terrain's 'fall', else Config waterfall_sprite, else FALL_SPRITE; its colour the terrain's tint.
  // Foam: three more strips next to the fall's own (same frames, same four pieces, never tinted), found by name:
  // <fall>_foam_top_anim.png (a tile, on the top of the fall), <fall>_foam_bottom_small_anim.png and
  // <fall>_foam_bottom_anim.png (a tile and a half each way: on the ground tile at the foot of the fall, reaching
  // half a tile up over it and a quarter out to the sides). A fall of Config waterfall_foam_tall (4) tiles or more
  // gets the big one, a lower fall the small one. Config waterfall_foam = off: none. A missing picture: none of that one.
  var FALL_SPRITE = 'art/tilesets/waterfall_anim.png';
  function foamPaths(sprite) {
    var b = String(sprite || '').replace(/(_anim)?[.]png$/i, '');
    return { top: b + '_foam_top_anim.png', small: b + '_foam_bottom_small_anim.png', big: b + '_foam_bottom_anim.png' };
  }
  function isOff(v) { return v === false || /^(off|false|0|no)$/i.test(String(v == null ? '' : v)); }
  /** How far the ground falls at the south edge of a tile: [left, right, own left, own right] (in tiles). */
  function southDrop(map, x, y) {
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return [0, 0, 0, 0];
    var oL = Rules.groundHeight(map, x + 0.001, y + 0.999), oR = Rules.groundHeight(map, x + 0.999, y + 0.999);
    var sL = y + 1 < map.height ? Rules.groundHeight(map, x + 0.001, y + 1.001) : 0, sR = y + 1 < map.height ? Rules.groundHeight(map, x + 0.999, y + 1.001) : 0;
    return [Math.max(0, oL - sL), Math.max(0, oR - sR), oL, oR];
  }
  /** The fall at a tile, if it has one: { sprite, tint, hand } (hand = put there in the map editor). */
  function fallAt(content, map, x, y) {
    if (!elevOn(map) || x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
    var d = southDrop(map, x, y); if (!(d[0] > 0.01 || d[1] > 0.01)) return null;       // no face to fall down
    var mark = (map.falls && map.falls[y] && map.falls[y][x]) || '';
    if (mark === '0') return null;
    var cfg = content.config || {}, def = cfg.waterfall_sprite || FALL_SPRITE;
    var bt = content.terrain[map.terrain[y] && map.terrain[y][x]], ot = map.overlay && map.overlay.length ? content.terrain[map.overlay[y] && map.overlay[y][x]] : null;
    var t = ot && (ot.fall || ot.water) ? ot : bt, own = t ? (t.fall || (t.water ? def : '')) : '';
    if (!mark && (!own || isOff(cfg.waterfalls))) return null;
    return { sprite: own || def, tint: mark && mark !== '1' ? mark : (own && t.tint) || '', hand: !!mark };
  }
  /** Every fall of a map, with the piece of the strip each one uses (listed once per map, like animatedCells). */
  function fallCells(content, map) {
    var out = [];
    if (!elevOn(map)) return out;
    for (var y = 0; y < map.height; y++) for (var x = 0; x < map.width; x++) {
      var f = fallAt(content, map, x, y); if (!f) continue;
      var l = !!fallAt(content, map, x - 1, y), r = !!fallAt(content, map, x + 1, y);
      out.push({ x: x, y: y, col: (!l && !r) ? 0 : (!l && r) ? 1 : (l && r) ? 2 : 3, sprite: f.sprite, tint: f.tint, hand: f.hand });
    }
    return out;
  }
  /** Draws the falls at their frame for `now`, over the raised ground (ox, oy = where the map's flat origin is on screen). */
  function drawFalls(g, content, map, cells, ox, oy, size, now, x0, y0, x1, y1, shade) {   // shade(x, y) = brightness under 1 (out of sight, indoors), or 0
    if (!cells || !cells.length) return;
    var canF = typeof g.filter === 'string';
    var cfgF = content.config || {}, ms = Number(cfgF.waterfall_ms) || 110, foam = !isOff(cfgF.waterfall_foam), tall = Number(cfgF.waterfall_foam_tall) || 4;
    for (var i = 0; i < cells.length; i++) {
      var a = cells[i];
      if (x0 != null && (a.x < x0 || a.x > x1 || a.y < y0 - 1 || a.y > y1 + 12)) continue;
      var img = Assets.get(a.sprite), plain = img; if (!img) continue;
      var ramp = a.tint && typeof Tint !== 'undefined' && Tint.tintedOver ? Tint.TINTS[a.tint] : null;
      if (ramp) img = Tint.tintedOver(img, Assets.get(a.sprite.replace(/\.png$/i, '.tint.png')), ramp);
      var n = Math.max(1, Math.round(img.width / (4 * NT))), fr = Math.floor((now || 0) / ms) % n;
      var d = southDrop(map, a.x, a.y), X = ox + a.x * size;
      var Yl = oy + (a.y + 1 - d[2]) * size, Yr = oy + (a.y + 1 - d[3]) * size, Bl = Yl + d[0] * size, Br = Yr + d[1] * size;
      var topY = Math.round(Math.min(Yl, Yr)), botY = Math.round(Math.max(Bl, Br)), fullBot = botY;
      for (var y2 = a.y + 2; y2 < map.height && y2 <= a.y + 12; y2++) {                 // nearer raised ground stands in front of it
        var top2 = Math.round(oy + (y2 - Rules.heightAt(map, a.x, y2) - (Rules.rampAt(map, a.x, y2) ? 1 : 0)) * size);
        if (top2 < botY) botY = top2;
      }
      if (botY <= topY) continue;
      var sh = shade && canF ? shade(a.x, a.y) : 0;
      if (sh) g.filter = 'brightness(' + sh + ')';
      g.save(); g.beginPath(); g.moveTo(X, Yl); g.lineTo(X + size, Yr); g.lineTo(X + size, Math.min(Br, botY)); g.lineTo(X, Math.min(Bl, botY)); g.closePath(); g.clip();
      for (var fy = topY; fy < botY; fy += size) g.drawImage(img, fr * 4 * NT + a.col * NT, 0, NT, Math.min(NT, img.height), X, fy, size, size);
      g.restore();
      if (!foam) { if (sh) g.filter = 'none'; continue; }
      var fp = foamPaths(a.sprite), k = size / NT, tImg = Assets.get(fp.top);
      if (tImg) { var tw = tImg.width / n / 4; g.drawImage(tImg, (fr * 4 + a.col) * tw, 0, tw, tImg.height, X, topY - Math.round(3 * k), tw * k, tImg.height * k); }   // (3 px up: the foam line sits on the edge the water goes over)
      var bImg = botY < fullBot ? null : Assets.get((fullBot - topY) / size >= tall - 0.01 ? fp.big : fp.small) || Assets.get(fp.small) || Assets.get(fp.big);   // (its foot hidden behind nearer ground: no splash)
      if (bImg) { var bw = bImg.width / n / 4, bh = bImg.height; g.drawImage(bImg, (fr * 4 + a.col) * bw, 0, bw, bh, Math.round(X - (bw - NT) / 2 * k), fullBot + size - bh * k, bw * k, bh * k); }
      if (sh) g.filter = 'none';
    }
    if (canF) g.filter = 'none';
  }

  // ---- things on cliff faces (layer:'cliff') ----
  // An object whose definition has properties.layer = 'cliff' is a decoration ON a cliff face: vines, rocks, a cave
  // mouth. Its placement names the raised tile whose south face it is on (x, y) and where on that face:
  // data.dx = sideways from the middle of the tile (in tiles), data.up = how far its foot is above the foot of the
  // cliff (in tiles), data.flip = mirrored. Any number may share a face; they are drawn in the order they were placed.
  // Draw-only: the rules see a walkable object standing on the tile above.
  /** Where the foot of the cliff under a tile's south edge is drawn (y, in the same space as oy), and where nearer raised ground starts covering it. */
  function cliffFoot(map, x, y, oy, size) {
    var d = southDrop(map, x, y), foot = oy + (y + 1 - ((d[2] + d[3]) / 2 - (d[0] + d[1]) / 2)) * size, cover = Infinity;
    for (var y2 = y + 2; y2 < map.height && y2 <= y + 12; y2++) {
      var top2 = oy + (y2 - Rules.heightAt(map, x, y2) - (Rules.rampAt(map, x, y2) ? 1 : 0)) * size;
      if (top2 < cover) cover = top2;
    }
    return { foot: foot, top: foot - (d[0] + d[1]) / 2 * size, drop: (d[0] + d[1]) / 2, cover: cover };
  }
  /** The picture of a cliff thing and the rectangle it is drawn in: { img, sx, sw, sh, x, y, w, h, cover } or null. */
  function cliffRect(map, o, e, ox, oy, size, now) {
    if (!elevOn(map) || !o) return null;
    var path = (typeof Rules !== 'undefined' && Rules.lookSprite && Rules.lookSprite(o, e)) || o.sprite, img = path ? Assets.get(path) : null;
    var n = Math.max(1, o.frames || 1), fw = img ? img.width / n : NT, ih = img ? img.height : NT, k = size / NT;
    var f = cliffFoot(map, e.x, e.y, oy, size), dt = e.data || {};
    var w = fw * k, h = ih * k, cx = ox + (e.x + 0.5 + (Number(dt.dx) || 0)) * size, by = f.foot - (Number(dt.up) || 0) * size;
    return { img: img, sx: (n > 1 ? Math.floor((now || 0) / (o.frameMs || 200)) % n : 0) * fw, sw: fw, sh: ih, x: Math.round(cx - w / 2), y: Math.round(by - h), w: w, h: h, cover: f.cover, flip: !!dt.flip };
  }
  function drawCliffThing(g, map, o, e, ox, oy, size, now) {
    var r = cliffRect(map, o, e, ox, oy, size, now); if (!r) return;
    g.save();
    if (r.cover < r.y + r.h) { g.beginPath(); g.rect(r.x - 2, r.y - 2, r.w + 4, Math.max(0, r.cover - r.y + 2)); g.clip(); }   // raised ground nearer the camera stands in front
    if (!r.img) g.drawImage(Assets.placeholder(o.name || '?', '#667', NT), r.x, r.y, r.w, r.h);
    else if (r.flip) { g.translate(r.x + r.w, r.y); g.scale(-1, 1); g.drawImage(r.img, r.sx, 0, r.sw, r.sh, 0, 0, r.w, r.h); }
    else g.drawImage(r.img, r.sx, 0, r.sw, r.sh, r.x, r.y, r.w, r.h);
    g.restore();
  }
  /** Every cliff thing of a map, over the raised ground. hidden(e) = leave this one out. */
  function drawCliffThings(g, content, map, ox, oy, size, now, hidden, shade) {
    if (!elevOn(map)) return;
    var canF = typeof g.filter === 'string';
    for (var i = 0; i < map.entities.length; i++) {
      var e = map.entities[i], o = content.objects[e.ref];
      if (!o || !o.properties || o.properties.layer !== 'cliff' || (hidden && hidden(e))) continue;
      var sh = shade && canF ? shade(e.x, e.y) : 0;
      if (sh) g.filter = 'brightness(' + sh + ')';
      drawCliffThing(g, map, o, e, ox, oy, size, now);
      if (sh) g.filter = 'none';
    }
  }

  // ---- ground height, shown flat (the map editor) ----
  // Until the ground is drawn raised, height reads as relief on the flat map: higher ground a touch lighter, a dark
  // line with a shadow on the low side wherever two tiles do not meet (a cliff), and arrows up every ramp. The same
  // picture in the game and in the map editor (labels = the height written on each raised tile, for the editor).
  function drawRelief(g, map, ox, oy, size, x0, y0, x1, y1, labels) {
    if (!map.elev || !map.elev.length || typeof Rules === 'undefined' || !Rules.heightAt) return;
    x0 = Math.max(0, x0 == null ? 0 : x0); y0 = Math.max(0, y0 == null ? 0 : y0);
    x1 = Math.min(map.width - 1, x1 == null ? map.width - 1 : x1); y1 = Math.min(map.height - 1, y1 == null ? map.height - 1 : y1);
    var lw = Math.max(2, Math.round(size / 10)), sh = Math.max(3, Math.round(size / 4));
    g.save();
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) {
      var h = Rules.heightAt(map, x, y), r = Rules.rampAt(map, x, y), dx = ox + x * size, dy = oy + y * size;
      if (h || r) { g.fillStyle = 'rgba(255,255,255,' + Math.min(0.3, 0.07 * (h + (r ? 0.5 : 0))) + ')'; g.fillRect(dx, dy, size, size); }
      if (r) {                                                // arrows pointing up the slope
        g.save(); g.translate(dx + size / 2, dy + size / 2); g.rotate(r === 'N' ? 0 : r === 'E' ? Math.PI / 2 : r === 'S' ? Math.PI : -Math.PI / 2);
        g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = Math.max(1.5, size / 16); g.lineCap = 'round'; g.lineJoin = 'round';
        [-0.18, 0.12].forEach(function (k) { g.beginPath(); g.moveTo(-size * 0.22, size * (k + 0.14)); g.lineTo(0, size * (k - 0.08)); g.lineTo(size * 0.22, size * (k + 0.14)); g.stroke(); });
        g.restore();
      }
      // the east and south sides of this tile (each boundary is looked at once)
      [['E', x + 1, y], ['S', x, y + 1]].forEach(function (q) {
        if (q[1] >= map.width || q[2] >= map.height || !Rules.cliffBetween(map, x, y, q[0])) return;
        var mine = Rules.groundHeight(map, x + (q[0] === 'E' ? 0.99 : 0.5), y + (q[0] === 'S' ? 0.99 : 0.5));
        var theirs = Rules.groundHeight(map, q[1] + (q[0] === 'E' ? 0.01 : 0.5), q[2] + (q[0] === 'S' ? 0.01 : 0.5));
        var lowIsOther = theirs <= mine, bx = dx + (q[0] === 'E' ? size : 0), by = dy + (q[0] === 'S' ? size : 0);
        g.fillStyle = 'rgba(0,0,0,.28)';
        if (q[0] === 'E') g.fillRect(lowIsOther ? bx : bx - sh, by, sh, size); else g.fillRect(bx, lowIsOther ? by : by - sh, size, sh);
        g.fillStyle = 'rgba(20,16,12,.9)';
        if (q[0] === 'E') g.fillRect(bx - lw / 2, by, lw, size); else g.fillRect(bx, by - lw / 2, size, lw);
      });
      if (labels && (h || r)) {
        g.fillStyle = 'rgba(255,255,255,.9)'; g.font = 'bold ' + Math.max(9, Math.round(size * 0.34)) + 'px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
        g.fillText(String(h) + (r ? '▲' : ''), dx + 2, dy + 1);
      }
    }
    g.restore();
  }
  // ---- shallow water ----
  // The map's `shallow` grid marks overlay water that can be waded through (Rules.terrainAt). It is drawn see-through,
  // so the ground painted under it shows: Config shallow_alpha (0.45) of the water shows over shallow ground. Where
  // shallow meets deep water the two fade into each other over Config shallow_blend (2) tiles, half on each side of
  // the line you can walk to, and the fade wobbles a little so it never runs straight along the grid. Built from a
  // signed distance per water cell (+ inside the shallows, - out in the deep), smoothed across tiles, plus a fixed
  // noise (worked out from where it is, never chance). Shoreline shapes are the water's own autotile, untouched.
  // Each see-through cell is drawn live (in the moving-ground list), never into the bake, so the water is laid once
  // over the baked ground and never twice over itself.
  function shallowAlpha(content) {
    var raw = content.config.shallow_alpha, v = Number(raw);
    if (raw === '' || raw == null || !isFinite(v)) v = 0.45;
    if (v > 1) v /= 100;                                            // (written as a percentage)
    return Math.max(0, Math.min(1, v));
  }
  function nHash(ix, iy) { var n = (ix * 374761393 + iy * 668265263) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; }
  function vNoise(u, v) {                                           // smooth value noise, -1..1
    var i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    fu = fu * fu * (3 - 2 * fu); fv = fv * fv * (3 - 2 * fv);
    var a = nHash(i, j), b = nHash(i + 1, j), c = nHash(i, j + 1), d = nHash(i + 1, j + 1);
    return (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv) * 2 - 1;
  }
  /** The overlay water cells drawn see-through: { "x,y": {a} (all of it at one strength) or {mask} (a tile-sized
   *  alpha picture) }, or null when the map has none. */
  function shallowCells(content, map) {
    var sg = map.shallow, ov = map.overlay && map.overlay.length ? map.overlay : null;
    if (!sg || !sg.length || !ov || typeof Rules === 'undefined' || !Rules.isWater) return null;
    var W = map.width, H = map.height, wet = new Uint8Array(W * H), sh = new Uint8Array(W * H), any = false, x, y, i;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = content.terrain[ov[y] && ov[y][x]]; i = y * W + x;
      if (t && Rules.isWater(t)) { wet[i] = 1; if (sg[y] && sg[y][x] === '1') { sh[i] = 1; any = true; } }
    }
    if (!any) return null;
    var cfg = content.config, blend = Number(cfg.shallow_blend); if (!(blend > 0)) blend = 2;
    var half = blend / 2, NZ = Math.min(0.35, half * 0.4), LIM = half + NZ + 1, SA = shallowAlpha(content), T = cfg.tile_size || 32;
    var S = new Float32Array(W * H), rad = Math.ceil(LIM) + 1;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {               // signed distance to the shallow / deep line
      i = y * W + x; if (!wet[i]) continue;
      var best = Infinity;
      for (var dy = -rad; dy <= rad; dy++) for (var dx = -rad; dx <= rad; dx++) {
        var nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        var j = ny * W + nx; if (!wet[j] || sh[j] === sh[i]) continue;
        var d = Math.sqrt(dx * dx + dy * dy); if (d < best) best = d;
      }
      var s = Math.min(LIM, best - 0.5); S[i] = sh[i] ? s : -s;
    }
    var N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {               // land by the water: what the water beside it says (so the smoothing ignores the shore)
      i = y * W + x; if (wet[i]) continue;
      var sum = 0, n = 0;
      for (var q4 = 0; q4 < 4; q4++) { var ax = x + N4[q4][0], ay = y + N4[q4][1]; if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue; var k = ay * W + ax; if (wet[k]) { sum += S[k]; n++; } }
      S[i] = n ? sum / n : -LIM;
    }
    function at(ax, ay) { ax = ax < 0 ? 0 : ax >= W ? W - 1 : ax; ay = ay < 0 ? 0 : ay >= H ? H - 1 : ay; return S[ay * W + ax]; }
    function smooth(e0, e1, v) { var k = Math.max(0, Math.min(1, (v - e0) / (e1 - e0))); return k * k * (3 - 2 * k); }
    var out = {};
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!wet[y * W + x]) continue;
      var lo = Infinity, hi = -Infinity;
      for (var qy = -1; qy <= 1; qy++) for (var qx = -1; qx <= 1; qx++) { var q = at(x + qx, y + qy); if (q < lo) lo = q; if (q > hi) hi = q; }
      if (hi <= -half - NZ) continue;                               // deep all over: drawn as it always was
      if (lo >= half + NZ) { out[x + ',' + y] = { a: SA }; continue; }   // shallow all over: one strength
      if (typeof document === 'undefined') continue;
      var cv = document.createElement('canvas'); cv.width = cv.height = T;
      var cg = cv.getContext('2d'), img = cg.createImageData(T, T), px = img.data;
      for (var py = 0; py < T; py++) for (var pq = 0; pq < T; pq++) {
        var u = x + (pq + 0.5) / T, v = y + (py + 0.5) / T, gu = u - 0.5, gv = v - 0.5, i0 = Math.floor(gu), j0 = Math.floor(gv), fu = gu - i0, fv = gv - j0;
        var sv = (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
        sv += NZ * (0.7 * vNoise(u * 1.7, v * 1.7) + 0.3 * vNoise(u * 4.1 + 17, v * 4.1 + 31));
        var o = (py * T + pq) * 4; px[o] = px[o + 1] = px[o + 2] = 255;
        px[o + 3] = Math.round(255 * (1 - smooth(-half, half, sv) * (1 - SA)));
      }
      cg.putImageData(img, 0, 0);
      out[x + ',' + y] = { mask: cv };
    }
    return out;
  }
  var shScratch = null;
  /** Draws one see-through water cell: draw(ctx, x, y, size) paints it as usual, sc says how much of it shows. */
  function drawShallow(g, sc, dx, dy, size, draw) {
    if (!sc.mask) { var ga = g.globalAlpha; g.globalAlpha = ga * sc.a; draw(g, dx, dy, size); g.globalAlpha = ga; return; }
    var n = Math.max(1, Math.ceil(size));
    if (!shScratch) shScratch = document.createElement('canvas');
    if (shScratch.width < n || shScratch.height < n) { shScratch.width = Math.max(n, shScratch.width); shScratch.height = Math.max(n, shScratch.height); }
    var s = shScratch.getContext('2d');
    s.setTransform(1, 0, 0, 1, 0, 0); s.globalCompositeOperation = 'source-over'; s.clearRect(0, 0, n, n); s.imageSmoothingEnabled = false;
    draw(s, 0, 0, size);
    s.globalCompositeOperation = 'destination-in'; s.imageSmoothingEnabled = true;
    s.drawImage(sc.mask, 0, 0, sc.mask.width, sc.mask.height, 0, 0, size, size);
    s.globalCompositeOperation = 'source-over';
    g.drawImage(shScratch, 0, 0, size, size, dx, dy, size, size);
  }

  // ---- animated ground (water, lava…) ----
  // The baked ground holds every cell's first frame. The cells that move are listed once per map (animatedCells) and
  // drawn again every frame over the bake (drawAnimated), all on one clock so a whole lake ripples together. A cell
  // moves when its base terrain is an animated strip (sprite + frames), or when its base or overlay terrain is cut
  // from an animated tileset (frames > 1). Whatever lies over a moving base is listed with it and redrawn on top.
  function animatedCells(content, map) {
    var out = [], edgeSame = content.config.autotile_edge_same !== false;
    var overlay = (map.overlay && map.overlay.length) ? map.overlay : null, auto = null, autoOv = null;
    // (the frames may be written on the tileset or, for an autotiled terrain, on the terrain itself: either works)
    function moving(t) { var ts = t && t.autotile && content.tilesets[t.autotile]; return !!(ts && (ts.frames > 1 || t.frames > 1)); }
    function part(grids, grid, x, y) {                          // one layer of a cell, ready to draw (null = nothing there)
      var tid = grid[y] && grid[y][x], t = tid && content.terrain[tid]; if (!t) return null;
      if (t.autotile) {
        var ag = grids(), a = ag[y] && ag[y][x], ts = a && content.tilesets[a.tileset];
        return ts ? { t: t, ts: ts, tile: a.tile } : null;
      }
      return t.sprite ? { t: t } : null;
    }
    function baseGrid() { return auto || (auto = Autotile.gridFor(content, map.terrain, edgeSame, map.shapes)); }
    function overGrid() { return autoOv || (autoOv = Autotile.gridFor(content, overlay, edgeSame, map.overlayShapes)); }
    var shal = shallowCells(content, map);                      // shallow water: drawn see-through, here and never in the bake
    for (var y = 0; y < map.height; y++) for (var x = 0; x < map.width; x++) {
      var bt = content.terrain[map.terrain[y] && map.terrain[y][x]], ot = overlay ? content.terrain[overlay[y] && overlay[y][x]] : null;
      var baseMoves = !!bt && (moving(bt) || (bt.frames > 1 && !!bt.sprite && !bt.autotile)), overMoves = moving(ot);
      var sc = shal && shal[x + ',' + y];
      if (!baseMoves && !overMoves && !sc) continue;
      var parts = [];
      if (baseMoves) { var bp = part(baseGrid, map.terrain, x, y); if (bp) parts.push(bp); }
      if (ot && (overMoves || baseMoves || sc)) { var op = part(overGrid, overlay, x, y); if (op) { if (sc) op.sh = sc; parts.push(op); } }
      if (parts.length) out.push({ x: x, y: y, parts: parts });
    }
    return out;
  }
  /** Draws the moving cells at their frame for `now`. size = a tile on screen; x0..y1 (optional) = the cells in view. */
  function drawAnimated(g, content, cells, ox, oy, size, now, x0, y0, x1, y1, lift) {   // lift(x, y) = pixels higher (raised ground), or nothing
    for (var i = 0; i < cells.length; i++) {
      var a = cells[i];
      if (x0 != null && (a.x < x0 || a.x > x1 || a.y < y0 || a.y > y1)) continue;
      var dx = ox + a.x * size, dy = oy + a.y * size - (lift ? lift(a.x, a.y) : 0);
      for (var k = 0; k < a.parts.length; k++) {
        var p = a.parts[k];
        if (p.sh) drawShallow(g, p.sh, dx, dy, size, partDrawer(content, p, now));   // see-through shallow water
        else partDrawer(content, p, now)(g, dx, dy, size);
      }
    }
  }
  function partDrawer(content, p, now) {                   // one layer of a moving cell, at its frame for `now`
    return function (g, dx, dy, size) {
      if (p.ts) {
        var sheet = groundSheet(content, p.t, p.ts); if (!sheet) return;
        var own = p.ts.frames > 1, n = Math.max(1, (own ? p.ts.frames : p.t.frames) || 1), ms = (own ? p.ts.frameMs : p.t.frameMs) || 200;
        if (sheet.width < n * p.ts.columns * p.ts.tileSize) n = 1;                 // the picture does not hold that many sheets: a still one
        tileFromSheet(sheet, p.ts, p.tile, g, dx, dy, size, n > 1 ? Math.floor(now / ms) % n : 0);
      } else {
        var img = Assets.get(p.t.sprite); if (!img) return;
        var f = frameOf(img, p.t.frames, p.t.frameMs, now);
        g.drawImage(img, f.sx, 0, f.sw, f.fh, dx, dy, size, size);
      }
    };
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
  var WALL_H = typeof Rules !== 'undefined' && Rules.WALL_H ? Rules.WALL_H : 2;   // wall height = storey height, in tiles
  function parseWallTok(tok) {
    if (!tok) return null;
    var p = String(tok).split(':');
    return { style: p[0], height: WALL_H, side: p[2] || 'c' };   // every wall is one storey high, whatever number the token carries
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
    function seen(x, y) { var v = vis && vis[x + ',' + y]; return !vis || (!!v && v !== 3); }   // (3 = the edge of a ledge above you: who stands there is seen, its ground is not)
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
  // ---- windows in E-W walls: the wall is cut open to the window's shape ----
  // The mask is the sprite's SILHOUETTE: everything inside its outer contour, i.e. every pixel that is not
  // see-through background reachable from the image's border. Punching the wall face with it and then
  // drawing the sprite on top leaves real holes wherever the art is transparent inside its own outline
  // (the panes), whatever the window looks like. Built once per image; null if the pixels cannot be read
  // (an image from another site) — then the wall is simply left whole.
  var _sil = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function silhouette(img, fw) {
    if (!_sil || typeof document === 'undefined') return null;
    if (_sil.has(img)) return _sil.get(img);
    var out = null;
    try {
      var w = Math.max(1, Math.round(fw)), h = img.height, cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var cg = cv.getContext('2d'); cg.drawImage(img, 0, 0, w, h, 0, 0, w, h);
      var id = cg.getImageData(0, 0, w, h), d = id.data, outside = new Uint8Array(w * h), stack = [], i, x, y;
      function seed(px, py) { var k = py * w + px; if (!outside[k] && d[k * 4 + 3] < 128) { outside[k] = 1; stack.push(k); } }
      for (x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
      for (y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
      while (stack.length) {
        i = stack.pop(); x = i % w; y = (i - x) / w;
        if (x > 0) seed(x - 1, y); if (x < w - 1) seed(x + 1, y); if (y > 0) seed(x, y - 1); if (y < h - 1) seed(x, y + 1);
      }
      for (i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = outside[i] ? 0 : 255; }
      cg.putImageData(id, 0, 0); out = cv;
    } catch (e) { out = null; }
    _sil.set(img, out); return out;
  }
  /** How many tiles wide the footprint under a picture is: the object's width, or its height when the picture is its
   *  side view (turned east or west, the footprint turns with it — Rules.footprintOf). */
  function footW(o, path) {
    var side = typeof Rules !== 'undefined' && Rules.sidePic(o, path) && layerOf(o) !== 'wall';
    return Math.max(1, (side ? o.footprintH : o.footprintW) || 1);
  }
  /** Where drawObject puts an object's whole image (base + overflow) on screen: {x, y, w, h}, plus its frame width. */
  function objRect(o, img, dx, dy, size, path) {
    var fw = img.width / Math.max(1, o.frames || 1), sc = size / NT, w = Math.max(1, Math.round(fw / NT));
    var x = dx + (footW(o, path) - w) * size / 2 + Number((o.properties && o.properties.offset_x) || 0) * sc;
    var hgt = img.height * sc;
    return { x: x, y: dy + size + (o.offsetY || 0) * sc - hgt, w: w * size, h: hgt, fw: fw };
  }
  /** Draw an E-W wall face with window-shaped holes punched in it. holes = [{mask, x, y, w, h}] in screen px. */
  function drawFaceWithHoles(g, content, p, ox, oy, S, dark, holes) {
    var H = p.h * S, fx = ox + p.x * S, fy = oy + p.y * S - H;
    var off = doorCanvas(S, H); if (!off) return false;
    var og = off.getContext('2d'); og.imageSmoothingEnabled = false;
    drawPrim25(og, content, p, -p.x * S, H - p.y * S, S, false, dark);
    og.globalCompositeOperation = 'destination-out';
    holes.forEach(function (hl) { og.drawImage(hl.mask, hl.x - fx, hl.y - fy, hl.w, hl.h); });
    og.globalCompositeOperation = 'source-over';
    g.drawImage(off, fx, fy);
    return true;
  }
  /** Cracks over a damaged E-W wall face: more and longer as health (pct, 0-1) drops. Same cracks every frame. */
  function drawCracks(g, p, ox, oy, S, pct) {
    var n = pct < 0.33 ? 5 : pct < 0.66 ? 3 : 1, H = p.h * S, fx = ox + p.x * S, fy = oy + p.y * S - H;
    var seed = (p.x * 73856093) ^ (p.y * 19349663);
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    g.save(); g.beginPath(); g.rect(fx, fy, S, H); g.clip();
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.beginPath();
    for (var i = 0; i < n; i++) {
      var x = fx + rnd() * S, y = fy + rnd() * H * 0.6, steps = 3 + Math.floor(rnd() * 3);
      g.moveTo(Math.round(x) + 0.5, Math.round(y) + 0.5);
      for (var k = 0; k < steps; k++) { x += (rnd() - 0.5) * S * 0.45; y += rnd() * H * 0.22; g.lineTo(Math.round(x) + 0.5, Math.round(y) + 0.5); }
    }
    g.stroke();
    if (pct < 0.33) { g.fillStyle = 'rgba(0,0,0,.55)';                               // breached: dark holes
      for (var j = 0; j < 3; j++) g.fillRect(Math.round(fx + rnd() * (S - 6)), Math.round(fy + rnd() * (H - 8)), 3 + Math.round(rnd() * 4), 4 + Math.round(rnd() * 5)); }
    g.restore();
  }
  /** A small health bar centred on (cx, cy). */
  function drawHpBar(g, cx, cy, pct, color) {
    var w = 22, x = Math.round(cx - w / 2), y = Math.round(cy);
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x - 1, y - 1, w + 2, 5);
    g.fillStyle = color || (pct < 0.33 ? '#e0563f' : pct < 0.66 ? '#e0a83f' : '#7bcf62');
    g.fillRect(x, y, Math.max(1, Math.round(w * Math.max(0, Math.min(1, pct)))), 3);
  }
  /** How much of a resource (a tree, a wreck…) is left: a see-through ring that empties as it is worked. */
  function drawRing(g, cx, cy, pct) {
    var r = 8, a0 = -Math.PI / 2;
    g.save();
    g.lineWidth = 4; g.lineCap = 'butt';
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(cx, cy, r, a0, a0 + Math.PI * 2 * Math.max(0, Math.min(1, pct))); g.stroke();
    g.restore();
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
  // A staircase (kind 'stairs') runs along Rules.STAIR_LEN tiles and climbs a whole storey, so each tile of the
  // run is one STEP TILE, drawn one tile higher on the screen than the one before. Its picture is a single step
  // tile, repeated: the main sprite climbs NORTH; sprite_states "side=" climbs east (mirrored for west) and
  // "south=" climbs south; a direction without its own picture uses the main sprite. With no picture at all it
  // is drawn as plain steps, so it works before there is art.
  function stairRise(i, T) { var R = Rules; return Math.round(i * (R.WALL_H / R.stairLen()) * T); }
  /** Draw step tile i (0 = the foot) of a staircase. */
  function drawStairStep(g, c, o, e, i, ox, oy, T, now) {
    var R = typeof Rules !== 'undefined' ? Rules : null; if (!R) return;
    var dir = R.stairDir(e), d = R.DIRS[dir], n = R.stairLen();
    var st = o.spriteStates || {}, path = (dir === 'N' ? '' : dir === 'S' ? st.south : st.side) || o.sprite, img = path && Assets.get(path);
    var x = ox + (e.x + i * d.dx) * T, y = oy + (e.y + i * d.dy) * T - stairRise(i, T);
    if (img && img.width) {
      drawObject(g, o, path, x, y, T, 'base', now, dir === 'W');
      drawObject(g, o, path, x, y, T, 'top', now, dir === 'W');
      return;
    }
    var steps = 4;
    g.fillStyle = '#4a3b2c'; g.fillRect(x, y, T, T);
    for (var k = 0; k < steps; k++) {
      var t = (i * steps + k) / (n * steps), lum = Math.round(92 + 70 * t), w = T / steps;      // lighter as it climbs
      g.fillStyle = 'rgb(' + lum + ',' + Math.round(lum * 0.8) + ',' + Math.round(lum * 0.62) + ')';
      if (dir === 'N') g.fillRect(x + 2, y + T - (k + 1) * w + 1, T - 4, w - 2);
      else if (dir === 'S') g.fillRect(x + 2, y + k * w + 1, T - 4, w - 2);
      else if (dir === 'E') g.fillRect(x + k * w + 1, y + 2, w - 2, T - 4);
      else g.fillRect(x + T - (k + 1) * w + 1, y + 2, w - 2, T - 4);
    }
  }
  /** The whole staircase, far steps first (the editor, the build ghost, floors seen from above). */
  function drawStairs(g, c, o, e, ox, oy, T, now) {
    if (typeof Rules === 'undefined') return;
    var n = Rules.stairLen(), north = Rules.stairDir(e) === 'N';
    for (var k = 0; k < n; k++) drawStairStep(g, c, o, e, north ? n - 1 - k : k, ox, oy, T, now);
  }
  // A door in a N-S wall is seen edge-on, so it is shown as a doorstep lying on the floor across the wall line.
  // A door can carry its own doorstep pictures (sprite_states "step=" closed, "step_open=" open; the Content
  // Studio's doorstep pickers); without them its ordinary closed / open pictures are laid down instead.
  function doorstepPath(o, open) {
    var st = o.spriteStates || {};
    if (st.step || st.step_open) return open ? (st.step_open || st.step) : (st.step || st.step_open);
    return objPath(o, open ? 'open' : null, null);
  }
  /** Draw that doorstep for the N-S edge at (qx,qy): natural size, centred on the wall line. False when there is no picture yet. */
  function drawDoorstep(g, map, o, open, ox, oy, qx, qy, T) {
    var sImg = Assets.get(doorstepPath(o, open));
    if (!sImg || !sImg.width) return false;
    var ssc = T / NT, sw = Math.round(sImg.width * ssc), sh = Math.round(sImg.height * ssc), pp = o.properties || {};
    g.drawImage(sImg, 0, 0, sImg.width, sImg.height,
      Math.round(ox + qx * T - sw / 2 + vWallOff(map, qx, qy, T) + Number(pp.offset_x || 0) * ssc),
      Math.round(oy + qy * T + (T - sh) / 2 + Number(pp.offset_y || 0) * ssc), sw, sh);
    return true;
  }
  /** The N-S edges a wall-mounted door stands in, or [] when it is on an E-W wall (or is not a door). */
  function sideDoorEdges(o, e) {
    if (!o || layerOf(o) !== 'wall' || openingOf(o) !== 'door') return [];
    return fixtureEdges(o, e).filter(function (q) { return q.orient === 'v'; });
  }
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

  /**
   * The things on the walls of ANOTHER floor of the building (doors, windows, arches, shelves…), for the floors
   * drawn below or above the one you stand on, shown as they are on their own floor: a door open or shut (states =
   * that floor's {key: state}), a window as a see-through hole in its wall, an opening in a N-S wall as a gap, a
   * slab or glass. Returns { list: [{ x, y, sortY (within that floor), draw(g, now) }], doorFaces, vDoor, winHoles }
   * — the last three tell drawOtherPrim how to draw that floor's walls. (ox, fy) = where the floor's origin is drawn.
   */
  function otherFloorFixtures(c, fm, ox, fy, T, states) {
    var out = { list: [], doorFaces: {}, vDoor: {}, winHoles: {} };
    states = states || {};
    (fm.entities || []).forEach(function (e) {
      var o = c.objects[e.ref]; if (!o || layerOf(o) !== 'wall') return;
      var opening = openingOf(o), edges = fixtureEdges(o, e), ed0 = edges[0], isH = ed0.orient === 'h', st = states[e.key];
      var open = opening === 'arch' || st === 'open';
      if (isH && (opening === 'door' || opening === 'arch')) {
        edges.forEach(function (q) { out.doorFaces[q.x + ',' + q.y] = 1; });       // the door draws this stretch of wall face itself
        out.list.push({ x: e.x, y: e.y, sortY: ed0.y * T + 0.6, draw: function (g) { drawDoor(g, c, fm, { o: o, e: e, ed: ed0, W: edges.length, open: open, cut: false }, ox, fy, T, 1); } });
        return;
      }
      if (!isH && opening) {                                             // edge-on in a N-S wall: a gap, a slab or glass, and a door's doorstep on the floor
        edges.forEach(function (q) { out.vDoor[q.x + ',' + q.y] = opening === 'window' ? 'glass' : open ? 'open' : 'shut'; });
        return;                                                          // (its doorstep picture is an icon for those ON that floor: not drawn from another one)
      }
      var p = objPath(o, st, null), mp = wallMountPlace(fm, o, e, ox, fy, T); if (!p) return;
      if (opening === 'window') {                                        // its panes are holes in the wall face
        var wImg = Assets.get(p);
        if (wImg && wImg.width) {
          var wr = objRect(o, wImg, mp.dx, mp.dy, T), wMask = silhouette(wImg, wr.fw);
          if (wMask) {
            var hole = { mask: wMask, x: wr.x, y: wr.y, w: wr.w, h: wr.h };
            for (var hx = Math.floor((wr.x - ox) / T); hx <= Math.floor((wr.x + wr.w - 1 - ox) / T); hx++)
              (out.winHoles[hx + ',' + ed0.y] || (out.winHoles[hx + ',' + ed0.y] = [])).push(hole);
          }
        }
      }
      out.list.push({ x: e.x, y: e.y, sortY: mp.sortY - fy, draw: function (g, now) {
        drawObject(g, o, p, mp.dx, mp.dy, T, 'base', now, mp.flip);
        if (hasTop(o, p)) drawObject(g, o, p, mp.dx, mp.dy, T, 'top', now, mp.flip);
      } });
    });
    return out;
  }
  /** One wall piece of another floor, with what otherFloorFixtures found on it (fx): door gaps, window holes, glass. */
  function drawOtherPrim(g, c, p, ox, fy, T, fx) {
    var isCap = p.kind === 'hcap' || p.kind === 'vcap', isV = p.kind === 'vface' || p.kind === 'vcap', k = p.x + ',' + p.y;
    var vd = isV ? fx.vDoor[k] : null;
    if (vd === 'open') return;                                           // an open door or an arch in a thin wall: a gap
    if (p.kind === 'hface' && fx.doorFaces[k]) return;                   // the door draws it
    var holes = p.kind === 'hface' ? fx.winHoles[k] : null;
    if (!(holes && drawFaceWithHoles(g, c, p, ox, fy, T, 0, holes))) drawPrim25(g, c, p, ox, fy, T, false, 0);
    if (vd === 'shut' && !isCap) primRectFill(g, p, ox, fy, T, 'rgba(46,30,16,.55)');
    if (vd === 'glass' && !isCap) primRectFill(g, p, ox, fy, T, 'rgba(190,228,255,.55)');
  }

  /** The object layer: 'object' (y-sorted, default), 'wall' (hung on an edge face), 'ground_decal' (flat) or 'cliff' (on a cliff face). */
  function layerOf(o) { return (o.properties && o.properties.layer) || 'object'; }

  /** Which sprite to show: an active state (open/empty…) wins, else the facing view, else the base sprite. */
  function objPath(o, st, facing) {
    if (st && o.spriteStates[st]) return o.spriteStates[st];
    if (facing && o.spriteStates[facing]) return o.spriteStates[facing];   // a state named exactly like the facing (older maps)
    return facing && typeof Rules !== 'undefined' ? Rules.facingSprite(o, String(facing)).path : o.sprite;
  }

  /**
   * Draws one object whose footprint is cell (dx, dy). An object is `w` tiles wide (from its image
   * width), centred over its footprint width and bottom-anchored on the footprint row; everything
   * above that row overflows upward. A per-object offset_y nudges it vertically.
   * part 'base' = the footprint row (the part that can block); part 'top' = the overflow above it,
   * drawn after characters so they can walk behind it. `flip` mirrors the whole object (side→left).
   * `lean` (screen pixels, signed; swayOf) = foliage in the wind: the picture stays planted at its foot and its
   * top is that far to one side. Drawn as a few bands of rows, each moved a whole number of pixels, so the art
   * stays crisp and both parts bend as one.
   */
  function drawObject(g, o, path, dx, dy, size, part, now, flip, lean) {
    var img = path && Assets.get(path);
    if (!img) { if (part === 'base' && path) g.drawImage(Assets.placeholder(o.name, '#7a5a3a', size), dx, dy, size, size); return; }
    // The object's frames apply to a picture wide enough to hold them; a narrower one is a still. So one object can
    // have an animated state (a lit fire: a strip of 3) next to plain ones (the empty pit: a single tile).
    var nfr = Math.max(1, o.frames || 1), f = frameOf(img, img.width >= nfr * NT ? nfr : 1, o.frameMs, now), fw = f.sw, ih = img.height;
    var sc = size / NT, w = Math.max(1, Math.round(fw / NT)), destW = w * size;
    // Centre the sprite over its footprint width, so a sprite wider (or narrower) than its footprint
    // straddles the footprint tiles instead of growing rightward from the anchor.
    dx += (footW(o, path) - w) * size / 2;
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
    lean = Math.round(lean || 0);
    if (lean) {
      var r0 = part === 'base' ? ih - baseSrcH : 0, r1 = part === 'base' ? ih : topSrcH;   // this part's rows of the picture
      var n = Math.abs(lean), sgn = lean < 0 ? -1 : 1, x0 = dx, hi = ih, bx = inkBox(img);   // hi = the row the band above ends on
      var inkH = bx.bot - bx.top;
      if (swayLow(bx)) {
        // A small plant (a bush, a tuft) is cut TWICE: its foot (SWAY_FOOT art pixels) never moves; the top goes one art
        // pixel to the side first, then the middle follows it. Never further than that one pixel.
        var unit = Math.max(1, Math.round(sc)), lvl = Math.min(2, Math.round(n / unit)), c1 = bx.bot - SWAY_FOOT, c2 = Math.round(bx.top + (c1 - bx.top) / 2);
        [[c1, ih, 0], [c2, c1, lvl >= 2 ? 1 : 0], [0, c2, lvl >= 1 ? 1 : 0]].forEach(function (bd) {
          var a = Math.max(bd[0], r0), b = Math.min(bd[1], r1);
          if (b > a) { dx = x0 + bd[2] * unit * sgn; blit(a, b - a, baseDstY + (a - (ih - baseSrcH)) * sc, (b - a) * sc); }
        });
        return;
      }
      for (var s = 0; s <= n; s++) {                          // band s = the rows moved s pixels; rows higher up move more (a curve: the foot stays put)
        var lo = s === n ? 0 : Math.round(bx.bot - inkH * Math.pow((s + 0.5) / n, 1 / SWAY_CURVE));
        var a = Math.max(lo, r0), b = Math.min(hi, r1);
        if (b > a) { dx = x0 + s * sgn; blit(a, b - a, baseDstY + (a - (ih - baseSrcH)) * sc, (b - a) * sc); }
        hi = lo;
      }
      return;
    }
    if (part === 'base') {
      blit(ih - baseSrcH, baseSrcH, baseDstY, baseDstH);
    } else {
      blit(0, topSrcH, baseDstY - topSrcH * sc, topSrcH * sc);
    }
  }
  // Foliage in the wind (draw-only). What sways: an object with properties.sway (true, or a number = how strongly),
  // and an item lying on the ground whose Items `sway` is ticked. The answer is how far its top leans right now, in
  // screen pixels: two slow waves, each thing on its own beat (from where it stands, so a wood never moves as one),
  // taller pictures leaning further. Config foliage_sway = the strength of it all (1; 0 = off).
  var SWAY_CURVE = 1.6, SWAY_MS = 3400, SWAY_FOOT = 4, SWAY_LOW = 48;   // (art pixels: the planted foot of a small plant; how tall "small" is)
  function swayLow(bx) { var hgt = bx.bot - bx.top; return hgt <= SWAY_LOW && hgt > SWAY_FOOT; }
  /** The rows of a picture that have anything drawn on them ({top, bot}): the sway bends that, not the empty rows
   *  above a small plant. Worked out once per picture; one that cannot be read (art from another site) = all of it. */
  function inkBox(img) {
    if (img._ink) return img._ink;
    var box = { top: 0, bot: img.height };
    try {
      var cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      var cg = cv.getContext('2d'); cg.drawImage(img, 0, 0);
      var d = cg.getImageData(0, 0, img.width, img.height).data, w4 = img.width * 4, top = -1, bot = -1;
      for (var y = 0; y < img.height; y++) for (var i = y * w4 + 3, e = i + w4; i < e; i += 4) if (d[i] > 24) { if (top < 0) top = y; bot = y + 1; break; }
      if (top >= 0 && bot - top >= 2) box = { top: top, bot: bot };
    } catch (err) { /* tainted: keep the whole picture */ }
    try { img._ink = box; } catch (err2) { /* */ }
    return box;
  }
  function swayOf(cfg, o, item, path, x, y, size, now) {
    var k = item ? (item.sway ? 1 : 0) : (o.properties && o.properties.sway);
    if (!k || !now) return 0;
    k = k === true ? 1 : Number(k) || 0;
    var cv = cfg && cfg.foliage_sway; k *= cv === undefined || cv === '' ? 1 : (Number(cv) > 0 ? Number(cv) : 0);
    var img = k > 0 && path && Assets.get(path); if (!img) return 0;
    var ph = (x * 12.9898 + y * 78.233) % 6.2832, t = now / SWAY_MS * 6.2832;
    var wave = 0.65 * Math.sin(t + ph) + 0.35 * Math.sin(t * 2.3 + ph * 1.7);
    var bx = inkBox(img);
    if (swayLow(bx)) return Math.max(-2, Math.min(2, Math.round(wave * 2.4 * k))) * Math.max(1, Math.round(size / NT));   // a small plant: how far gone, 0 upright, 1 the top, 2 the middle too (drawObject)
    var px = Math.sqrt((bx.bot - bx.top) / NT) * 1.25 * size / NT;   // a tree leans further than a tuft
    return wave * k * Math.max(1.3, px);                           // (never less than one screen pixel at the top, or a small plant would not move at all)
  }
  function hasTop(o, path) {
    var img = path && Assets.get(path); if (!img) return false;
    return img.height > NT + 1;                             // taller than one footprint tile = overflow above
  }
  /** A state with no art of its own. The tile is no longer darkened for an opened or emptied thing (the art is
   *  final now: a state that should look different gets its own picture); only a switched-on lever keeps its glow. */
  function drawStateMark(g, o, st, dx, dy, S) {
    if (!st || o.spriteStates[st]) return;
    if (st === 'on') { g.fillStyle = 'rgba(255,210,80,.35)'; g.fillRect(dx, dy, S, S); }
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
  // `swing` (0..1, or null) is how far through a melee swing the figure is: the weapon is raised, brought down in
  // front and returned, turning about the hand (the weapon's pivot from the Content Studio, else a point at the grip).
  function swingTurn(p) {                                  // radians; negative = raised (for a figure facing right)
    var UP = -1.5, DOWN = 1.0;
    if (p < 0.25) return UP * (p / 0.25);
    if (p < 0.6) { var q = (p - 0.25) / 0.35; return UP + (DOWN - UP) * q * q; }
    return DOWN * (1 - (p - 0.6) / 0.4);
  }
  /** An NPC's outfit: object properties.outfit = [{path, tint}], bottom to top (Content Studio → NPCs). Answers the layers
   *  that have a picture, or null (then the NPC is its plain sprite). The game, the map editor and its palette all ask this. */
  function outfitOf(o) {
    var f = o && o.kind === 'npc' && o.properties && o.properties.outfit;
    if (!Array.isArray(f)) return null;
    f = f.filter(function (l) { return l && l.path; });
    return f.length ? f : null;
  }
  /** An outfit as paper-doll layers ({path, mask, ramp}), starting the loads of what is not loaded yet. */
  function outfitLayers(fit) {
    var tone = typeof Tint !== 'undefined' && Tint.lookSkin ? Tint.lookSkin(fit) : '';   // the body's skin tone (and the hands' in what it holds)
    return (fit || []).map(function (l) {
      var sk = tone ? Tint.skinFor(l.path, tone) : null;
      // a garment's cloth is all in its colour mask: one with no colour given gets the default (Tint.lookTint), never half drawn
      var tint = typeof Tint !== 'undefined' && Tint.lookTint ? Tint.lookTint(l.path, l.tint) : l.tint;
      var ramp = tint && typeof Tint !== 'undefined' ? Tint.TINTS[tint] : null, mask = ramp ? l.path.replace(/\.png$/i, '.tint.png') : '';
      if (!Assets.get(l.path)) Assets.load(l.path);
      if (mask && !Assets.get(mask)) Assets.load(mask);
      return { path: l.path, mask: mask, ramp: ramp, skin: sk ? sk.tone : '', skinAll: sk ? sk.all : false };
    });
  }
  /** Draw an outfit standing on the tile whose top-left is (ax, ay); answers the top of the figure. */
  function drawOutfit(g, fit, ax, ay, T, flip) { return drawLayers(g, outfitLayers(fit), ax, ay, T, flip); }
  /** The figure of one character (a player or a monster) alone, its tile's top-left at (ax, ay), on gg; answers the top of what was drawn. */
  function figureOn(gg, a, ax, ay, T) {
    var top = ay;                                                    // top of the drawn figure (busts rise above the tile)
    if (a.layers && a.layers.length) {
      top = drawLayers(gg, a.layers, ax, ay, T, a.facing === 'W', a.aim, a.swing);
    } else if (a.sprite !== undefined) {
      var img = a.sprite && Assets.get(a.sprite);
      if (img) {
        gg.save();
        if (a.facing === 'W') { gg.translate(ax + T, ay); gg.scale(-1, 1); gg.drawImage(img, 0, 0, T, T); }
        else gg.drawImage(img, ax, ay, T, T);
        gg.restore();
      } else gg.drawImage(Assets.placeholder(a.name, '#8a2f2f', T), ax, ay);
    } else gg.drawImage(Assets.hero(a.facing, a.tint || '#3d6fb6', T), ax, ay);
    return top;
  }
  /** A death: the figure of actor `a` taken apart into its own pixels, each with a way to fly (drawFx, kind 'burst'),
   *  and the drops of blood it throws (`blood` = how many; they land as a stain, Renderer.draw o2.stains).
   *  Answers {p: [{x, y, vx, vy, c, s, l}], drops: [{dx, dy, t, s, a}]} — p in screen pixels from the tile's top-left,
   *  speeds per second, l = the share of the effect's life it lasts; drops in tiles from the tile, t = ms in the air. */
  var burstCv = null;
  function burst(a, T, blood) {
    var W3 = 3 * T, H5 = 5 * T, u = Math.max(1, Math.round(T / NT)), p = [], data = null, i;
    if (!burstCv) burstCv = document.createElement('canvas');
    if (burstCv.width !== W3 || burstCv.height !== H5) { burstCv.width = W3; burstCv.height = H5; }
    var sg = burstCv.getContext('2d', { willReadFrequently: true });
    sg.clearRect(0, 0, W3, H5); sg.imageSmoothingEnabled = false;
    try { figureOn(sg, a, T, 4 * T, T); data = sg.getImageData(0, 0, W3, H5).data; } catch (e) { data = null; }   // (a picture from another site cannot be read: plain bits instead)
    var pts = [], sy = 0, x, y;
    if (data) for (y = 0; y < H5; y += u) for (x = 0; x < W3; x += u) {
      var k = (y * W3 + x) * 4;
      if (data[k + 3] > 60) { pts.push([x - T, y - 4 * T, 'rgb(' + data[k] + ',' + data[k + 1] + ',' + data[k + 2] + ')']); sy += y - 4 * T; }
    }
    if (!pts.length) for (y = 0; y < T; y += 2 * u) for (x = 0; x < T; x += 2 * u) { pts.push([x, y, '#8a2f2f']); sy += y; }
    var keep = pts.length > 1400 ? 1400 / pts.length : 1, cx = T / 2, cy = sy / pts.length;
    for (i = 0; i < pts.length; i++) {
      if (keep < 1 && Math.random() > keep) continue;
      var q = pts[i], ang = Math.atan2(q[1] - cy, q[0] - cx) + (Math.random() - 0.5) * 1.2, sp = T * (1.2 + Math.random() * 4.6);
      p.push({ x: q[0], y: q[1], vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - T * 1.6, c: q[2], s: u, l: 0.45 + Math.random() * 0.55 });
    }
    var drops = [];
    for (i = 0; i < (blood || 0); i++) {
      var da = Math.random() * Math.PI * 2, dr = i < 4 ? Math.random() * 0.25 : 0.3 + Math.random() * 1.1;
      drops.push({ dx: 0.5 + Math.cos(da) * dr, dy: 0.7 + Math.sin(da) * dr * 0.6, t: i < 4 ? 0 : 160 + dr * 260, s: u * (i < 4 ? 3 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 3)), a: 0.6 + Math.random() * 0.35 });
    }
    return { p: p, drops: drops, cy: cy / T };
  }
  function drawLayers(g, layers, ax, ay, T, flip, aim, swing) {
    var topY = ay, turn = swing != null && swing >= 0 && swing < 1 ? swingTurn(swing) : 0;
    layers.forEach(function (l) {
      var base = Assets.get(l.path); if (!base) return;
      var img = (l.mask && l.ramp) ? Tint.getTintedLayer(base, Assets.get(l.mask), l.ramp) : base;
      if (l.skin) img = Tint.skinned(img, l.skin, !l.skinAll);   // the character's skin tone: the body, and the hands drawn into what it holds
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
        if (turn) g.rotate(turn);                           // (mirrored with the weapon when it points left)
        g.drawImage(img, -px * T, -py * h, T, h);
        g.restore();
      } else if (turn && l.slot === 'weapon') {             // not aiming: the same swing, the way the figure faces
        var sp = l.aimPoints || null, sx = sp && sp.px != null ? sp.px : 0.5, sy = sp && sp.py != null ? sp.py : 0.6;
        g.save();
        if (flip) { g.translate(ax + T, 0); g.scale(-1, 1); g.translate(sx * T, dy + sy * h); }
        else g.translate(ax + sx * T, dy + sy * h);
        g.rotate(turn);
        g.drawImage(img, -sx * T, -sy * h, T, h);
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
  function bakeGround(content, map, raised, live) {           // raised: draw the ground's height (the game); the editor keeps it flat. live: the caller draws the moving ground (animatedCells) over it
    var T = content.config.tile_size || 32, sc = T / NT;
    var c = document.createElement('canvas');
    var up = raised && elevOn(map), pad = up ? maxElev(map) * T : 0;
    c.width = map.width * T; c.height = map.height * T + pad; c.pad = pad;
    var g = c.getContext('2d'), G = g;                        // G = where drawCell paints (a scratch tile while a raised one is made)
    g.imageSmoothingEnabled = false;
    var edgeSame = content.config.autotile_edge_same !== false;
    var base = map.terrain, overlay = (map.overlay && map.overlay.length) ? map.overlay : null;
    var auto = Autotile.gridFor(content, base, edgeSame, map.shapes);           // shapes = frozen overrides
    var autoOv = overlay ? Autotile.gridFor(content, overlay, edgeSame, map.overlayShapes) : null;
    var Sc = typeof Scatter !== 'undefined' ? Scatter : null;
    // Shallow water is see-through: live, it is left out here (the moving-ground list lays it over this bake);
    // otherwise (a floor seen from above) it is baked see-through, still.
    var shal = overlay ? shallowCells(content, map) : null;
    function drawOver(x, y, dx, dy) {
      var sc = shal && shal[x + ',' + y];
      if (!sc) return drawCell(overlay, autoOv, x, y, dx, dy, false, map.overlayShapes);
      if (live) return;
      var into = G;
      drawShallow(into, sc, dx, dy, T, function (cg, X, Y) { G = cg; drawCell(overlay, autoOv, x, y, X, Y, false, map.overlayShapes); G = into; });
    }

    // Draw one terrain layer at a cell. `underlay` = this is the opaque ground layer (draws the base-tile
    // underlay so edges aren't holes, and a flat-colour fallback for artless terrain). The overlay layer
    // passes underlay=false, so its autotile is transparent outside its shape and reveals the ground below.
    function drawCell(cells, autoGrid, x, y, dx, dy, underlay, overrides) {
      var tid = cells[y] && cells[y][x]; if (!tid) return;
      var t = content.terrain[tid]; if (!t) return;
      var a = autoGrid[y][x];
      if (a) {
        var ts = content.tilesets[a.tileset], img = groundSheet(content, t, ts);   // (an animated sheet: its first frame)
        var info = Sc && Sc.tileInfo(ts.image);
        if (underlay && info && info.baseTile) {               // underlay: texture shows at ragged edges
          var bimg = Assets.get(info.baseTile);
          if (bimg) G.drawImage(bimg, 0, 0, bimg.width, bimg.height, dx, dy, T, T);
        }
        if (img) tileFromSheet(img, ts, a.tile, G, dx, dy, T);
        if (info && info.scatterKey && Sc) {                   // variety layer (baked, so it's free per frame)
          var interior = Autotile.effectiveMask(cells, x, y, edgeSame, overrides) === 255;
          Sc.scatterFor(info.scatterKey, x, y, interior).forEach(function (s) {
            var sh = Assets.get(Sc.sheetPath(info.dir, s.sheet)); if (!sh) return;
            G.save();
            if (s.flip) { G.translate(dx + T, dy); G.scale(-1, 1); G.drawImage(sh, s.sx, s.sy, NT, NT, 0, 0, T, T); }
            else G.drawImage(sh, s.sx, s.sy, NT, NT, dx, dy, T, T);
            G.restore();
          });
        }
      } else if (t.sprite) {
        var timg = Assets.get(t.sprite);
        if (timg) { var f0 = frameOf(timg, t.frames, t.frameMs, 0); G.drawImage(timg, 0, 0, f0.sw, f0.fh, dx, dy, T, T); }
      }
      // no art → nothing drawn (an artless terrain shows empty, so missing art is obvious)
    }

    if (!up) for (var y = 0; y < map.height; y++) {
      for (var x = 0; x < map.width; x++) {
        var dx = x * T, dy = y * T;
        drawCell(base, auto, x, y, dx, dy, true, map.shapes);            // ground layer (opaque)
        if (autoOv) drawOver(x, y, dx, dy);                               // overlay (transparent; shallow water see-through)
      }
    }
    else {
      // Raised: row by row from the far side, so nearer ground covers what is behind it. Each tile is painted on
      // a scratch square first, then put down lifted (or stretched / sheared, for a ramp), then its cliff face.
      var scr = document.createElement('canvas'); scr.width = scr.height = T;
      var sg = scr.getContext('2d'); sg.imageSmoothingEnabled = false;
      var cliffOf = function (x, y) {                         // the face picture of the ground at a tile, if its art has one
        var t = content.terrain[base[y] && base[y][x]] || (overlay && content.terrain[overlay[y] && overlay[y][x]]);
        var ts = t && t.autotile && content.tilesets[t.autotile], info = Sc && ts && Sc.tileInfo(ts.image);
        if (info && info.cliff) return Assets.get(info.cliff);
        // a plain tile (no tileset): the same rule on its own picture, <name>.png -> <name>_face.png
        return t && t.sprite && !/^https?:/i.test(t.sprite) ? Assets.get(t.sprite.replace(/\.png$/i, '_face.png')) : null;
      };
      // The outline of raised ground: a rough dark line, a few pixels thick, never the same twice along its length
      // (but always the same for a given tile: it is worked out from where the tile is, not from chance).
      var rough = function (x, y, side, i) { var n = (x * 73856093) ^ (y * 19349663) ^ (side * 83492791) ^ (i * 2654435761); n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) % 1000 / 1000; };
      var edge = function (x, y, side, X0, Y0, len, horiz, inward) {      // inward: +1 = the line thickens right / down from (X0, Y0), -1 = left / up
        var u = Math.max(1, Math.round(T / 16)), i = 0;
        for (var a = 0; a < len; a += 2 * u, i++) {
          var r = rough(x, y, side, i), th = u * (r < 0.2 ? 1 : r < 0.6 ? 2 : r < 0.9 ? 3 : 4), seg = Math.min(2 * u, len - a);
          g.fillStyle = 'rgba(0,0,0,.42)';
          if (horiz) g.fillRect(X0 + a, inward > 0 ? Y0 : Y0 - th, seg, th); else g.fillRect(inward > 0 ? X0 : X0 - th, Y0 + a, th, seg);
          if (r > 0.75) { g.fillStyle = 'rgba(0,0,0,.2)'; if (horiz) g.fillRect(X0 + a, inward > 0 ? Y0 + th : Y0 - th - u, seg, u); else g.fillRect(inward > 0 ? X0 + th : X0 - th - u, Y0 + a, u, seg); }
        }
      };
      var drop = function (x, y) { return southDrop(map, x, y); };   // how far the ground falls at the south edge of a tile
      for (var ry = 0; ry < map.height; ry++) for (var rx = 0; rx < map.width; rx++) {
        var eh = Rules.heightAt(map, rx, ry), er = Rules.rampAt(map, rx, ry), X = rx * T;
        if ((base[ry] && base[ry][rx]) || (overlay && overlay[ry] && overlay[ry][rx])) {
          sg.clearRect(0, 0, T, T); G = sg;
          drawCell(base, auto, rx, ry, 0, 0, true, map.shapes);
          if (autoOv) drawOver(rx, ry, 0, 0);
          G = g;
          if (!er) g.drawImage(scr, X, pad + (ry - eh) * T);
          else if (er === 'N') g.drawImage(scr, 0, 0, T, T, X, pad + (ry - eh - 1) * T, T, 2 * T);
          else if (er === 'E' || er === 'W') {
            // slanted: the square sheared up toward its high side. It is drawn a pixel taller than it is, top and
            // bottom, so the slanted joins between the tiles of one slope close up (a slanted edge is never drawn
            // crisp, and the gap showed as a dark diagonal line on every row). Only the slope's TOP edge gets a line.
            g.save();
            if (er === 'E') g.transform(1, -1, 0, 1, X, pad + (ry - eh) * T); else g.transform(1, 1, 0, 1, X, pad + (ry - eh - 1) * T);
            g.drawImage(scr, 0, 0, T, T, 0, -1, T, T + 2);
            g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(0, -1, T, T + 2);
            if (!(ry > 0 && map.elev[ry - 1] && map.elev[ry - 1][rx] === map.elev[ry][rx])) { g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, -1, T, 2); }   // where the slope ends, at the top
            if (ry > 0 && Rules.cliffBetween(map, rx, ry, 'N')) edge(rx, ry, 3, 0, 0, T, true, 1);                       // its sides, where nobody can step on or off it
            if (ry + 1 < map.height && Rules.cliffBetween(map, rx, ry, 'S')) edge(rx, ry, 0, 0, T, T, true, -1);
            g.restore();
          }
          if (er === 'N') {
            g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(X, pad + (ry - eh - 1) * T, T, 2 * T);                     // a slope catches a little more light
            if (rx > 0 && Rules.cliffBetween(map, rx, ry, 'W')) edge(rx, ry, 1, X, pad + (ry - eh - 1) * T, 2 * T, false, 1);          // its sides, where nobody can step on or off it
            if (rx + 1 < map.width && Rules.cliffBetween(map, rx, ry, 'E')) edge(rx, ry, 2, X + T, pad + (ry - eh - 1) * T, 2 * T, false, -1);
          }
          else if (er === 'S') {
            // A slope climbing south (away from the camera) is seen edge-on: its near and far edges land on the same
            // line of the screen, so it has no room of its own. So that it shows at all, it is drawn as a lighter
            // band lying just above that line (over the last quarter of the tile it climbs from).
            var sY = pad + (ry - eh) * T, sH = Math.max(4, Math.round(T / 4));
            g.drawImage(scr, 0, 0, T, T, X, sY - sH, T, sH);
            g.fillStyle = 'rgba(255,255,255,.2)'; g.fillRect(X, sY - sH, T, sH);
            g.fillStyle = 'rgba(0,0,0,.3)'; g.fillRect(X, sY - sH, T, 1);
            if (rx > 0 && Rules.cliffBetween(map, rx, ry, 'W')) edge(rx, ry, 1, X, sY - sH, sH, false, 1);
            if (rx + 1 < map.width && Rules.cliffBetween(map, rx, ry, 'E')) edge(rx, ry, 2, X + T, sY - sH, sH, false, -1);
          }
        }
        // the cliff face under its south edge
        var d = drop(rx, ry);
        if (d[0] > 0.01 || d[1] > 0.01) {
          var Yl = pad + (ry + 1 - d[2]) * T, Yr = pad + (ry + 1 - d[3]) * T, Bl = Yl + d[0] * T, Br = Yr + d[1] * T, topY = Math.min(Yl, Yr), botY = Math.max(Bl, Br);
          g.save(); g.beginPath(); g.moveTo(X, Yl); g.lineTo(X + T, Yr); g.lineTo(X + T, Br); g.lineTo(X, Bl); g.closePath(); g.clip();
          var fimg = cliffOf(rx, ry), dl = drop(rx - 1, ry), dr = drop(rx + 1, ry), hasL = dl[0] > 0.01 || dl[1] > 0.01, hasR = dr[0] > 0.01 || dr[1] > 0.01;
          if (fimg) {
            var cols = Math.max(1, Math.round(fimg.width / NT));                       // single, left, middle, right; a 5th piece = a second middle, to vary a long face
            var run = 0;                                                                // how many tiles of this face lie to the left
            if (hasL && hasR && cols >= 5) for (var lx = rx - 1; lx >= 0 && run < 64; lx--, run++) { var dq = drop(lx, ry); if (!(dq[0] > 0.01 || dq[1] > 0.01)) break; }
            var col = (!hasL && !hasR) ? 0 : (!hasL && hasR) ? 1 : (hasL && !hasR) ? 3 : (cols >= 5 && run % 2 === 0 ? 4 : 2);   // (two middles: they take turns, counted from the left end)
            for (var fy = topY; fy < botY; fy += T) g.drawImage(fimg, Math.min(col, cols - 1) * NT, 0, NT, Math.min(NT, fimg.height), X, fy, T, T);
          } else {                                                                     // no art for it yet: a plain earth bank
            g.fillStyle = '#4b3d2e'; g.fillRect(X, topY, T, botY - topY);
            g.fillStyle = 'rgba(0,0,0,.18)'; for (var by2 = topY + 6; by2 < botY; by2 += 9) g.fillRect(X, by2, T, 2);
          }
          var shd = g.createLinearGradient(0, topY, 0, botY); shd.addColorStop(0, 'rgba(0,0,0,0)'); shd.addColorStop(1, 'rgba(0,0,0,.28)');
          g.fillStyle = shd; g.fillRect(X, topY, T, botY - topY);                      // darker toward its foot
          g.restore();
          if (Math.abs(Yl - Yr) < 0.5) edge(rx, ry, 0, X, Math.round(Yl), T, true, 1);   // the lip (level ground only: under a slanted tile a level line would cut across its foot)
        }
        // a dark edge where this tile stands above its west / east / north neighbour (no face to see there)
        if (!er && eh) {
          if (Rules.cliffBetween(map, rx, ry, 'W') && Rules.groundHeight(map, rx - 0.5, ry + 0.5) < eh) edge(rx, ry, 1, X, pad + (ry - eh) * T, T, false, 1);
          if (Rules.cliffBetween(map, rx, ry, 'E') && Rules.groundHeight(map, rx + 1.5, ry + 0.5) < eh) edge(rx, ry, 2, X + T, pad + (ry - eh) * T, T, false, -1);
          if (ry > 0 && Rules.cliffBetween(map, rx, ry, 'N') && Rules.groundHeight(map, rx + 0.5, ry - 0.5) < eh) edge(rx, ry, 3, X, pad + (ry - eh) * T, T, true, 1);
        }
      }
    }
    function bakeLift(x, y) { return up ? liftAt(map, x, y, T) : 0; }

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
        g.drawImage(face, col * NT, 0, NT, face.height, wx * T, pad + (wy + 1) * T - bakeLift(wx, wy), T, face.height * sc);
      }
    }

    // ground decals (blood etc.): one flat 32x32 cell from the sheet, under objects and characters.
    map.entities.forEach(function (e) {
      var o = content.objects[e.ref];
      if (!o || layerOf(o) !== 'ground_decal') return;
      var dimg = o.sprite && Assets.get(o.sprite); if (!dimg) return;
      var cell = (e.data && e.data.cell) | 0, cols = Math.max(1, Math.round(dimg.width / NT));
      g.drawImage(dimg, (cell % cols) * NT, Math.floor(cell / cols) * NT, NT, NT, e.x * T, pad + e.y * T - bakeLift(e.x, e.y), T, T);
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

  Renderer.prototype.setMap = function (map, floorMaps) {   // floorMaps = { floorId: that floor's live map } (optional)
    this.map = map;
    this.mapId = map.id;
    this.ground = bakeGround(this.content, map, true, true);    // (with the ground's height drawn; the moving ground, shallow water too, is drawn live over it)
    this.elevTop = maxElev(map);
    var content = this.content;
    this.wall25 = wall25(content, map);                                              // every wall as cap + face pieces
    // Floors (docs/FLOORS.md, stage 1): standing on an upper floor, the floors beneath are drawn first, each lower
    // on the screen by its height and dimmed. Each is baked once, and again when its live map changes (something
    // was built or broken there).
    var below = [], cache = this._floorBakes || (this._floorBakes = {});
    function bakeOf(id) {
      var fm = (floorMaps && floorMaps[id]) || content.maps[id]; if (!fm) return null;
      if (fm.auto && !(fm._struct && (Object.keys(fm._struct.floor || {}).length || Object.keys(fm._struct.walls || {}).length || (fm._struct.ents || []).length))) return null;   // a storey the game supplied, still empty: nothing to draw
      var b = cache[id];
      if (!b || b.map !== fm) b = cache[id] = { map: fm, ground: bakeGround(content, fm), prims: wall25(content, fm) };
      return b;
    }
    if (map.z > 0 && map.floors) Object.keys(map.floors).forEach(function (k) {
      var fz = Number(k), b = bakeOf(map.floors[k]), fm = b && b.map;
      if (!fm || fz < 0 || fz >= map.z) return;                                      // basements are never seen from above
      below.push({ dz: map.z - fz, map: fm, ground: b.ground, prims: b.prims });
    });
    below.sort(function (a, b) { return b.dz - a.dz; });                             // lowest floor first
    this.below = below;
    // Stage 3: from the ground or a lower floor, the floors ABOVE show as the upper part of the building — their
    // walls, and a roof over whatever is marked roofed up there (an unroofed part, a terrace, shows its floor).
    var above = [];
    if ((map.z || 0) >= 0 && map.floors) Object.keys(map.floors).forEach(function (k) {
      var fz = Number(k), b = bakeOf(map.floors[k]), fm = b && b.map;
      if (!fm || fz <= (map.z || 0)) return;
      if (!b.sorted) b.sorted = b.prims.slice().sort(function (p, q) { return prim25SortY(p, 0, 32) - prim25SortY(q, 0, 32); });
      above.push({ dz: fz - (map.z || 0), map: fm, ground: b.ground, prims: b.sorted });
    });
    above.sort(function (a, b) { return a.dz - b.dz; });                             // nearest floor first, higher ones over it
    this.above = above;
    this.animated = animatedCells(this.content, map);          // the ground that moves: water, lava…
    this.falls = fallCells(this.content, map);                 // …and the water falling down its cliffs
  };

  /**
   * cam = top-left of the view in pixels (may be fractional while walking).
   * actors = [{x, y (tiles, fractional while moving), facing, name?, sprite?, tint?, hp?, maxHp?, me?}]
   * opts = {states: {entityKey: state}, hidden: function(entity) -> true to skip drawing it,
   *         vis, memory, explored, sensed: what the local player sees / remembers (see makeSight)}
   */
  Renderer.prototype.draw = function (cam, actors, opts) {
    var c = this.content, map = this.map, g = this.g, T = c.config.tile_size || 32;
    // names over characters are not painted here: the page lays them over the view as text in the UI's own font, sharp at any
    // size (main.js nameTags). This frame's list: {x, y (canvas pixels: the middle, the bottom of the name), text, color}.
    var nameTags = this.nameTags = [];
    var emoteTags = this.emoteTags = [];       // emotes over heads (a.emote): {x, y (canvas pixels: the middle, just above the head), named (a name tag sits there), emote}; main.js draws them on top
    var hits = this.hits = [];                 // this frame's objects and where each is drawn: what objectAt (below) is asked about
    var states = (opts && opts.states) || {}, hidden = opts && opts.hidden;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000'; g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    var ox = Math.round(-cam.x), oy = Math.round(-cam.y);
    if (this.below && this.below.length) {
      var storey = WALL_H;                                                           // a floor is one wall-height above the one below
      var nowB = performance.now(), fStates = (opts && opts.floorStates) || {};
      this.below.forEach(function (f) {
        var yy = oy + Math.round(f.dz * storey * T), items = [];
        g.drawImage(f.ground, ox, yy);
        (f.map.entities || []).forEach(function (e) {
          var o = c.objects[e.ref]; if (!o) return;
          if (o.kind === 'stairs') { drawStairs(g, c, o, e, ox, yy, T, nowB); return; }
          if (layerOf(o) === 'wall' || layerOf(o) === 'ground_decal' || layerOf(o) === 'cliff' || !o.sprite) return;
          var fs = e.data && e.data.facing && typeof Rules !== 'undefined' ? Rules.facingSprite(o, e) : { path: o.sprite, flip: false };
          items.push({ sortY: e.y * T + T, o: o, path: fs.path, flip: fs.flip, dx: ox + e.x * T, dy: yy + e.y * T });
        });
        f.prims.forEach(function (p) { items.push({ sortY: prim25SortY(p, 0, T) + 0.25, prim: p }); });
        var bfx = otherFloorFixtures(c, f.map, ox, yy, T, fStates[f.map.id]);   // its doors, windows and the rest on its walls, as they are
        bfx.list.forEach(function (fx) { items.push({ sortY: fx.sortY, fix: fx }); });
        // whoever you can see on this floor is part of it: behind its walls where they stand behind them, and UNDER
        // everything of the floors above, which are drawn after
        ((opts && opts.floorActors) || []).forEach(function (fa) {
          if (fa.dz !== -f.dz) return;
          fa.actors.forEach(function (a) { items.push({ sortY: Math.round(a.y * T) + T, actor: a }); });
        });
        items.sort(function (a, b) { return a.sortY - b.sortY; });
        items.forEach(function (it) {
          if (it.actor) paintActor(it.actor, Math.round(ox + it.actor.x * T), Math.round(yy + it.actor.y * T), false);
          else if (it.fix) it.fix.draw(g, nowB);
          else if (it.prim) drawOtherPrim(g, c, it.prim, ox, yy, T, bfx);
          else { drawObject(g, it.o, it.path, it.dx, it.dy, T, 'base', nowB, it.flip); drawObject(g, it.o, it.path, it.dx, it.dy, T, 'top', nowB, it.flip); }
        });
      });
      // What is below is dimmer than where you stand — except the ground you have a clear view of (opts.floorSight:
      // over a balcony edge, out of a window you stand at), which is left clear: your cone of view down there.
      var lit = {};
      g.beginPath(); g.rect(0, 0, this.canvas.width, this.canvas.height);
      ((opts && opts.floorSight) || []).forEach(function (f) {
        if (f.dz >= 0) return;
        Object.keys(f.cells).forEach(function (k) {
          var q = k.split(','), sx = Number(q[0]), sy = Number(q[1]) - f.dz * storey, sk = sx + ',' + sy;
          if (lit[sk]) return;                                                       // two floors may show through the same spot: one hole, not two
          lit[sk] = 1; g.rect(ox + sx * T, oy + sy * T, T, T);
        });
      });
      ((opts && opts.floorActors) || []).forEach(function (f) {
        if (f.dz >= 0) return;
        f.actors.forEach(function (a) {
          var ax = Math.round(a.x), ay = Math.round(a.y) - f.dz * storey;
          [ay, ay - 1].forEach(function (sy) { var sk = ax + ',' + sy; if (lit[sk]) return; lit[sk] = 1; g.rect(ox + ax * T, oy + sy * T, T, T); });
        });
      });
      g.fillStyle = 'rgba(6,8,14,0.5)'; g.fill('evenodd');
      // What is below is also a little out of focus (Config floor_blur, in pixels; 0 = off). Browsers without
      // canvas filters simply skip it.
      var blurPx = c.config.floor_blur === undefined || c.config.floor_blur === '' ? 0.6 : Number(c.config.floor_blur) || 0;
      if (blurPx > 0 && typeof g.filter === 'string') {
        g.filter = 'blur(' + blurPx + 'px)';
        g.drawImage(this.canvas, 0, 0);
        g.filter = 'none';
      }
    }
    // On an upper floor a cell with no terrain is open air: nothing of this floor (fog, roof, indoor shade) is drawn there.
    var sparse = map.z > 0;
    function hasFloor(x, y) { return !sparse || !!(map.terrain[y] && map.terrain[y][x]); }
    g.drawImage(this.ground, ox, oy - (this.ground.pad || 0));
    var EL = elevOn(map), elevTop = this.elevTop || 0, ground = this.ground;
    function L(x, y) { return EL ? liftAt(map, x, y, T) : 0; }       // how much higher what stands at (x, y) is drawn

    var x0 = Math.floor(cam.x / T) - 1, y0 = Math.floor(cam.y / T) - 1;
    var x1 = x0 + Math.ceil(this.canvas.width / T) + 2, y1 = y0 + Math.ceil(this.canvas.height / T) + 3 + (this.elevTop || 0);
    var now = performance.now();

    // layer 2b: animated terrain (water, lava...) is drawn live over the baked ground
    if (this.animated.length) drawAnimated(g, this.content, this.animated, ox, oy, T, now, x0, y0, x1, y1, EL ? L : null);

    // ---- sight: what the local player sees / knows this frame (see makeSight) ----
    var cfg = c.config || {}, o2 = opts || {};
    var meActor = null; actors.forEach(function (a) { if (a.me) meActor = a; });
    var cutR = Number(cfg.wall_cut_radius); if (!(cutR >= 0)) cutR = 3;
    var cutA = Number(cfg.wall_cut_alpha); if (!(cutA > 0 && cutA <= 1)) cutA = 0.45;
    var fogA = cfg.fog_alpha === undefined || cfg.fog_alpha === '' ? 0.32 : Number(cfg.fog_alpha); if (!(fogA >= 0 && fogA <= 1)) fogA = 0.32;
    var roofCol = (map.roof_color) || cfg.roof_color || '#15121c';
    var sight = makeSight(map, meActor, o2, cutR);
    if (o2.cutAll) sight.cutH = function () { return true; };   // the remove tool's "walls down" view: every E-W wall a stub
    var prims = this.wall25 || [];
    var dark = cfg.indoor_dark === undefined || cfg.indoor_dark === '' ? 0.25 : Number(cfg.indoor_dark); if (!(dark >= 0 && dark < 1)) dark = 0.25;
    // the falls and what hangs on the cliff faces: darker out of sight and indoors, like what stands on the ground (shadeAt)
    if (this.falls && this.falls.length) drawFalls(g, this.content, map, this.falls, ox, oy, T, now, x0, y0, x1, y1, shadeAt);
    if (EL) drawCliffThings(g, this.content, map, ox, oy, T, now, null, shadeAt);

    // layer 2c: the soft shadow each E-W wall drops on the floor south of it
    var strip = shadowStrip(T);
    if (strip) prims.forEach(function (p) {
      if (p.kind !== 'hface' || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1 || p.y >= map.height) return;
      if (sight.edgeKnown('h', p.x, p.y)) g.drawImage(strip, ox + p.x * T, oy + p.y * T - L(p.x, p.y));
    });
    // layer 2d: fog and roof over the ground — a dim veil on cells out of sight, the roof on unknown interiors
    var cx, cy, xa = Math.max(0, x0), xb = Math.min(map.width - 1, x1), ya = Math.max(0, y0), yb = Math.min(map.height - 1, y1);
    // Each spot of the screen gets its veil ONCE, from the tile that is actually seen there. Raised ground is drawn
    // over what lies behind it, so a column is walked from the near side: a tile shows from its lifted top down to
    // its foot (its top and its cliff face), less what nearer, higher ground already stands in front of (`sky`).
    // Without this a ledge would also take the veil of every hidden tile behind it, one more per level of height.
    if (sight.vis) {
      var fogCol = 'rgba(0,0,0,' + fogA + ')', ybx = Math.min(map.height - 1, y1 + (EL ? elevTop + 1 : 0));
      for (cx = xa; cx <= xb; cx++) {
        var sky = Infinity;
        for (cy = ybx; cy >= ya; cy--) {
          if (!hasFloor(cx, cy)) continue;
          var vt = oy + cy * T - L(cx, cy), vb = Math.min(oy + (cy + 1) * T, sky);
          if (vt < sky) sky = vt;
          if (vb <= vt) continue;
          if (!sight.known(cx, cy)) g.fillStyle = roofCol;
          else if (fogA > 0 && !sight.seen(cx, cy)) g.fillStyle = fogCol;
          else continue;
          g.fillRect(ox + cx * T, vt, T, vb - vt);
        }
      }
    }
    // layer 2e: indoors is darker (config indoor_dark, 0-1; 0 = off). The floor gets a veil here; whatever
    // stands indoors — objects, characters, the wall surfaces facing into the room — is drawn darker to match
    // in the sorted pass below (see dim), so a room reads as one dim space while outside stays bright.
    if (dark > 0) { g.fillStyle = 'rgba(0,0,0,' + dark + ')';
      for (cy = ya; cy <= yb; cy++) for (cx = xa; cx <= xb; cx++) if (sight.indoor(cx, cy) && sight.known(cx, cy) && hasFloor(cx, cy)) g.fillRect(ox + cx * T, oy + cy * T - L(cx, cy), T, T); }
    var canFilter = typeof g.filter === 'string', shadeNow = false;   // shadeNow: a sneaking figure is being painted (a shadow)
    // dim(on): on = true (indoors), a number (the brightness shadeAt worked out) or false (as drawn).
    function dim(on) {
      if (!canFilter) return;
      var b = on === true ? 1 - dark : typeof on === 'number' && on > 0 ? on : 1;
      var f = (b < 1 ? 'brightness(' + b + ') ' : '') + (shadeNow ? 'brightness(0.3) saturate(0.3)' : '');
      g.filter = f || 'none';
    }
    function inDark(x, y) { return dark > 0 && sight.indoor(Math.round(x), Math.round(y)); }
    // How bright what stands on a cell is drawn: darker indoors, and darker out of sight by the fog's own veil
    // (fog_alpha), so a known place you cannot see now reads as one dim area, things and ground alike. 0 = full.
    function shadeAt(x, y) {
      var rx = Math.round(x), ry = Math.round(y), b = 1;
      if (inDark(rx, ry)) b *= 1 - dark;
      if (fogA > 0 && sight.vis && !sight.seen(rx, ry) && sight.known(rx, ry)) b *= 1 - fogA;
      return b < 1 ? b : 0;
    }
    // layer 2e: blood on the ground where something died (o2.stains from main.js deathFx: [{x, y, t0, life, color,
    // drops}], Render.burst). Each drop shows once it has landed; the whole stain fades out over its last quarter.
    if (o2.stains && o2.stains.length) {
      var tS = performance.now();
      o2.stains.forEach(function (s) {
        var ageS = tS - s.t0, rx = Math.round(s.x), ry = Math.round(s.y);
        if (ageS < 0 || ageS >= s.life || rx < x0 || rx > x1 || ry < y0 || ry > y1) return;
        var fade = Math.min(1, (s.life - ageS) / (s.life * 0.25)), by = oy - L(Math.max(0, Math.min(map.width - 1, rx)), Math.max(0, Math.min(map.height - 1, ry)));
        g.fillStyle = s.color;
        s.drops.forEach(function (d) {
          if (ageS < d.t) return;
          g.globalAlpha = d.a * fade;
          g.fillRect(Math.round(ox + (s.x + d.dx) * T - d.s / 2), Math.round(by + (s.y + d.dy) * T - d.s / 4), d.s, Math.max(1, Math.round(d.s / 2)));
        });
      });
      g.globalAlpha = 1;
    }
    // layer 2f: while you sneak, where the monsters in view would see you (docs/STEALTH.md; o2.watch from main.js
    // sightAreas, each [{cells: {"x,y": 1}, hot}] worked out by World.sightArea). Amber = it has not noticed
    // anyone, red = it is after someone. A soft fill, and a line round the edge.
    if (o2.watch && o2.watch.length) {
      var wat = {};
      o2.watch.forEach(function (w) { Object.keys(w.cells).forEach(function (k) { wat[k] = Math.max(wat[k] || 1, w.hot ? 2 : 1); }); });
      var lw = Math.max(1, Math.round(T / 16));
      [1, 2].forEach(function (lvl) {
        var rgb = lvl === 2 ? '224,74,58' : '232,180,70', edges = [];
        g.fillStyle = 'rgba(' + rgb + ',' + (lvl === 2 ? 0.2 : 0.14) + ')';
        Object.keys(wat).forEach(function (k) {
          if (wat[k] !== lvl) return;
          var p = k.split(','), x = +p[0], y = +p[1]; if (x < x0 || x > x1 || y < y0 || y > y1) return;
          var px = ox + x * T, py = oy + y * T - L(x, y);
          g.fillRect(px, py, T, T);
          if (!wat[x + ',' + (y - 1)]) edges.push([px, py, T, lw]);
          if (!wat[x + ',' + (y + 1)]) edges.push([px, py + T - lw, T, lw]);
          if (!wat[(x - 1) + ',' + y]) edges.push([px, py, lw, T]);
          if (!wat[(x + 1) + ',' + y]) edges.push([px + T - lw, py, lw, T]);
        });
        g.fillStyle = 'rgba(' + rgb + ',0.6)';
        edges.forEach(function (e) { g.fillRect(e[0], e[1], e[2], e[3]); });
      });
    }

    // layer 3: collect objects for the merged back-to-front pass (layer 5). 'auto' = the WHOLE object (base +
    // tall overflow) y-sorts by its south edge with walls and characters, so a thing north of a wall is drawn
    // entirely behind it (cap included) and a thing south of it entirely in front. 'under' = whole object
    // drawn now (always behind everyone); 'over' = saved for the foreground. Ground decals are baked in.
    // Anything on an unknown (roofed, never seen) cell is not drawn at all.
    function wallH(q) { var t = parseWallTok(((q.orient === 'h' ? map.hWalls : map.vWalls) || [])[q.y] && ((q.orient === 'h' ? map.hWalls : map.vWalls)[q.y][q.x])); return t ? t.height : 2; }
    var overs = [], renderables = [], doorFaces = {}, doorGap = {}, vDoor = {}, winHoles = {};
    // is the wall on this edge still an unfinished frame? (drawn faint until it is built)
    function wallFrame(orient, x, y) { var w = map._struct.walls[orient + x + ',' + y]; return !!w && (w.prog || 0) < (w.need || 0); }
    // how much of an E-W wall segment's health is left (0 = unharmed / not tracked), for the crack overlay
    function wallHurt(x, y) {
      var st = map._struct; if (!st || (st.dmg['h' + x + ',' + y] === undefined && !st.walls['h' + x + ',' + y])) return 0;
      var info = World.structInfo(c, map, { t: 'wall', orient: 'h', x: x, y: y });
      if (info && info.rec && (info.rec.prog || 0) < (info.rec.need || 0)) return 0;   // a frame is not damaged, just unfinished
      return info && info.max > 0 && info.hp < info.max ? Math.max(0.01, info.hp / info.max) : 0;
    }
    map.entities.forEach(function (e) {
      if (e.x < x0 - 4 || e.x > x1 || e.y < y0 - 3 || e.y > y1) return;   // wide/tall objects reach beyond their cell
      var o = c.objects[e.ref]; if (!o || (hidden && hidden(e)) || layerOf(o) === 'ground_decal' || (EL && layerOf(o) === 'cliff')) return;   // (cliff things are drawn with the ground, above)
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
            renderables.push({ sortY: oy + ed0.y * T + 0.6, dark: shadeAt(ed0.x, ed0.y), lift: L(ed0.x, ed0.y), door: { o: o, e: e, ed: ed0, W: edges.length, open: dOpen, cut: cut } });
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
            if (drawDoorstep(g, map, o, dOpen, ox, oy, q.x, q.y, T)) { g.restore(); return; }
            var tw = Math.round(T * 1.1), tx = Math.round(ox + q.x * T - tw / 2) + wOff, ty = Math.round(oy + q.y * T) + 2, th = T - 4;
            g.fillStyle = 'rgba(214,200,170,.30)'; g.fillRect(tx, ty, tw, th);
            g.strokeStyle = 'rgba(235,225,200,.55)'; g.lineWidth = 1; g.strokeRect(tx + 0.5, ty + 0.5, tw - 1, th - 1);
            g.restore();
          });
          return;
        }
        // A window in a thin N-S wall is seen edge-on, so it is not drawn as a picture: its stretch of wall
        // gets a glassy tint and daylight spills from it across the floor of the room(s) it lights — the
        // indoor side, or both sides when neither (or both) is indoors. The light lies on the ground, only on
        // tiles in sight right now.
        if (opening === 'window' && !isH) {
          edges.forEach(function (q) {
            vDoor[q.x + ',' + q.y] = 'glass';
            var inW = sight.indoor(q.x - 1, q.y), inE = sight.indoor(q.x, q.y), both = inW === inE;
            var lx = ox + q.x * T + vWallOff(map, q.x, q.y, T), ly = oy + q.y * T + 3, lh = T - 6, reach = Math.round(T * 1.7);
            [[-1, inW || both], [1, inE || both]].forEach(function (sd) {
              if (!sd[1]) return;
              var dir = sd[0], c1 = dir < 0 ? q.x - 1 : q.x, c2 = c1 + dir;
              var k1 = sight.seen(c1, q.y), k2 = sight.seen(c2, q.y); if (!k1 && !k2) return;
              g.save(); g.beginPath();
              if (k1) g.rect(ox + c1 * T, oy + q.y * T, T, T);
              if (k2) g.rect(ox + c2 * T, oy + q.y * T, T, T);
              g.clip();
              var gr = g.createLinearGradient(lx, 0, lx + dir * reach, 0);
              gr.addColorStop(0, 'rgba(255,238,175,.42)'); gr.addColorStop(1, 'rgba(255,238,175,0)');
              g.fillStyle = gr; g.fillRect(dir < 0 ? lx - reach : lx, ly, reach, lh);
              g.restore();
            });
          });
          return;
        }
        // On a cut wall, windows stay standing (solid) and things you can use stay too (faint); pure decoration drops with the wall.
        if (cut && !opening && o.kind === 'deco') return;
        var wlf = L(e.x, e.y), wst = states[e.key], wp = objPath(o, wst, null), mp = wallMountPlace(map, o, e, ox, oy - wlf, T);
        mp.sortY += wlf;                                                   // (lifted on the screen, but sorted where it stands)
        // A window in an E-W wall that still stands: cut the wall face open to the window's outline, so
        // whatever is see-through inside the art really shows what is behind the wall.
        if (opening === 'window' && isH && !cut) {
          var wImg = wp && Assets.get(wp);
          if (wImg && wImg.width) {
            var wr = objRect(o, wImg, mp.dx, mp.dy, T), wMask = silhouette(wImg, wr.fw);
            if (wMask) {
              var hole = { mask: wMask, x: wr.x, y: wr.y, w: wr.w, h: wr.h };
              for (var hx = Math.floor((wr.x - ox) / T); hx <= Math.floor((wr.x + wr.w - 1 - ox) / T); hx++)
                (winHoles[hx + ',' + ed0.y] || (winHoles[hx + ',' + ed0.y] = [])).push(hole);
            }
          }
        }
        renderables.push({ sortY: mp.sortY, alpha: cut && !opening ? cutA : 1, dark: shadeAt(e.x, e.y),   // a window stands solid like a door; other fixtures go faint
          obj: { o: o, path: wp, dx: mp.dx, dy: mp.dy, flip: mp.flip, st: wst, tall: hasTop(o, wp) } });
        return;
      }
      if (!sight.known(e.x, e.y)) return;                                 // inside a room never seen
      if (o.kind === 'stairs') {                                          // each step tile sorts with its own row: over the wall behind it, under whoever stands on it
        var sdd = Rules.DIRS[Rules.stairDir(e)];
        for (var si = 0; si < Rules.stairLen(); si++)
          renderables.push({ sortY: Math.round(oy + (e.y + si * sdd.dy) * T) + T - 0.5, dark: shadeAt(e.x, e.y), lift: L(e.x, e.y), step: { o: o, e: e, i: si } });
        return;
      }
      var st = states[e.key], facing = (e.data && e.data.facing) || null;
      var path = objPath(o, st, facing), flip = facing === 'left' || (!!facing && Rules.facingOf(String(facing)) === 'W');
      var lookP = !(st && o.spriteStates[st]) && !facing ? Rules.lookSprite(o, e) : '';
      if (lookP) path = lookP;                                        // one of the object's other looks (a differently drawn tree)
      var lit = null;
      if (o.id === '_drop') { var lying = World.list((e.data || {}).pickup)[0]; lit = (lying && c.items[lying.item]) || null; if (lit && lit.sprite) path = lit.sprite; else lit = null; }   // an item on the ground: its own picture
      var lean = swayOf(c.config, o, lit, path, e.x, e.y, T, now);   // foliage in the wind
      if (!path && e.bp !== undefined) path = '#built';              // something a player built with no art yet: show a lettered box, never nothing
      var dx = ox + e.x * T, dy = oy + e.y * T - L(e.x, e.y), dz = o.draw || 'auto';
      hits.push({ e: e, o: o, path: path, dx: dx, dy: dy, flip: flip });
      if (dz === 'over') {
        overs.push({ o: o, path: path, y: e.y, dx: dx, dy: dy, flip: flip, shade: shadeAt(e.x, e.y), lean: lean });
      } else if (dz === 'under') {
        dim(shadeAt(e.x, e.y));
        drawObject(g, o, path, dx, dy, T, 'base', now, flip, lean);                  // always behind everyone
        if (hasTop(o, path)) drawObject(g, o, path, dx, dy, T, 'top', now, flip, lean);
        drawStateMark(g, o, st, dx, dy, T);
        dim(false);
      } else {
        // Seen from behind (facing north) a seat's back is on the camera side of whoever is on it, so on the SAME
        // tile it draws after the character (+0.1: still under a wall on that line, which is +0.25). Any other
        // facing keeps the tie as it was: the character on the tile is drawn over the object.
        var back = facing && Rules.turnable(o) && Rules.facingOf(String(facing)) === 'N' ? 0.1 : 0;
        renderables.push({ sortY: Math.round(oy + e.y * T) + T + back, dark: shadeAt(e.x, e.y), alpha: e.need && (e.prog || 0) < e.need ? 0.5 : 1, at: EL ? { x: e.x, y: e.y, w: Rules.footprintOf(o, e).w } : null, obj: { o: o, path: path, dx: dx, dy: dy, flip: flip, st: st, tall: hasTop(o, path), lean: lean } });
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
      renderables.push({ sortY: prim25SortY(p, oy, T) + (isCap ? 0.5 : 0.25), prim: p, lift: L(Math.min(p.x, map.width - 1), Math.min(p.y, map.height - 1)),
        cut: !isV && sight.cutH(p.x, p.y, p.h), shut: vd === 'shut' && !isCap, glass: vd === 'glass' && !isCap,
        holes: p.kind === 'hface' ? winHoles[p.x + ',' + p.y] : null,
        hurt: p.kind === 'hface' && map._struct ? wallHurt(p.x, p.y) : 0,
        frame: !!map._struct && wallFrame(isV ? 'v' : 'h', p.x, p.y),
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
      // (an NPC is a fixed thing, shown like the objects are: wherever the place is known)
      var how = a.me || !sight.vis ? 'seen' : a.fixed ? (sight.known(Math.round(a.x), Math.round(a.y)) ? 'seen' : 'hidden') : World.perceive(sight.vis, o2.sensed, a.x, a.y);
      if (how === 'hidden') return;
      renderables.push({ sortY: Math.round(oy + a.y * T) + T, actor: a, sensed: how === 'sensed', dark: shadeAt(a.x, a.y) });
    });
    renderables.sort(function (p, q) { return p.sortY - q.sortY; });
    renderables.forEach(function (r) {
      var oyL = oy - (r.lift || 0);                                    // this thing's own ground height
      if (r.door) { dim(r.dark); drawDoor(g, c, map, r.door, ox, oyL, T, cutA); dim(false); return; }
      if (r.prim) {
        if (r.frame) g.globalAlpha = 0.5;
        if (r.roofed && !r.cut) primRectFill(g, r.prim, ox, oyL, T, roofCol);
        else if (!(r.holes && !r.cut && drawFaceWithHoles(g, c, r.prim, ox, oyL, T, r.dark, r.holes))) drawPrim25(g, c, r.prim, ox, oyL, T, r.cut, r.dark);
        if (r.hurt && !r.cut && !r.roofed) drawCracks(g, r.prim, ox, oyL, T, r.hurt);
        if (r.shut) primRectFill(g, r.prim, ox, oyL, T, 'rgba(46,30,16,.55)');
        if (r.glass) primRectFill(g, r.prim, ox, oyL, T, 'rgba(190,228,255,.55)');     // a window in a thin wall: glassy
        if (r.frame) g.globalAlpha = 1;
        return;
      }
      if (r.step) { dim(r.dark); drawStairStep(g, c, r.step.o, r.step.e, r.step.i, ox, oyL, T, now); dim(false); return; }
      if (r.obj) {
        if (r.alpha < 1) g.globalAlpha = r.alpha;
        dim(r.dark);
        drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'base', now, r.obj.flip, r.obj.lean);
        if (r.obj.tall) drawObject(g, r.obj.o, r.obj.path, r.obj.dx, r.obj.dy, T, 'top', now, r.obj.flip, r.obj.lean);
        drawStateMark(g, r.obj.o, r.obj.st, r.obj.dx, r.obj.dy, T);
        dim(false);
        g.globalAlpha = 1;
        if (r.at) behindRise(r.at.x, r.at.y, r.at.w, r.obj.dy - 2 * T, r.obj.dy + T);
        return;
      }
      var a = r.actor;
      var aL = L(a.x, a.y);
      if (r.sensed) { drawSensed(g, Math.round(ox + a.x * T), Math.round(oy + a.y * T) - aL, T); return; }
      // climbing a staircase: drawn part-way up to the floor above
      var aY = Math.round(oy + a.y * T) - Math.round(Rules.stairHeight(c, map, a.x, a.y) * WALL_H * T) - aL;
      paintActor(a, Math.round(ox + a.x * T), aY, r.dark);
      if (EL) behindRise(a.x, a.y, 1, aY - T, aY + T);
    });
    // Raised ground hides what stands behind it. The ground is one picture drawn before everything, so the hiding is
    // done afterwards: straight after a thing is drawn, the pieces of higher ground that lie nearer the camera are
    // painted over it again from that picture — solid, or see-through close to the player (the cut-away walls get).
    // (x, y) = where it stands, w = tiles wide; top..bottom = the screen rows its picture covers.
    function behindRise(x, y, w, top, bottom) {
      if (!EL || !elevTop) return;
      // Every tile nearer the camera than the thing (a row further south) whose ground reaches above the ground the
      // thing stands on covers it from its far edge — level, or slanted for a ramp — down to where ground at the
      // thing's own height would begin. Those shapes are gathered into one outline, and the ground picture is
      // painted again inside it. (Ground at the same height, such as the tile being walked onto, covers nothing.)
      var hA = Rules.groundHeight(map, x + 0.5, y + 0.5), row = Math.floor(y + 0.5), pad = ground.pad || 0;
      var left = Math.round(ox + x * T), wide = Math.round(w * T), any = false, near = false, pieces = [];
      var c0 = Math.max(0, Math.floor(x + 0.001)), c1 = Math.min(map.width - 1, Math.ceil(x + w - 0.001) - 1 + (x !== Math.floor(x) ? 1 : 0));
      g.save(); g.beginPath();
      for (var cx2 = c0; cx2 <= c1; cx2++) for (var k = 1; k <= elevTop + 2; k++) {
        var cy2 = row + k; if (cy2 >= map.height) break;
        var hL = Rules.groundHeight(map, cx2 + 0.001, cy2 + 0.001), hR = Rules.groundHeight(map, cx2 + 0.999, cy2 + 0.001);   // its far edge, left and right
        if (Math.max(hL, hR) <= hA + 0.01) continue;
        var yLim = oy + (cy2 - hA) * T, yL = oy + (cy2 - Math.max(hL, hA)) * T, yR = oy + (cy2 - Math.max(hR, hA)) * T;
        if (Math.min(yL, yR) >= bottom || yLim <= top) continue;                       // does not reach the thing's picture
        var X0 = ox + cx2 * T;
        g.moveTo(X0, yL); g.lineTo(X0 + T, yR); g.lineTo(X0 + T, yLim); g.lineTo(X0, yLim); g.closePath();
        any = true; pieces.push({ x: cx2, y: cy2, X: X0, y0: Math.min(yL, yR), y1: yLim });
        if (meActor && Math.abs(cx2 - meActor.x) <= cutR && Math.abs(cy2 - meActor.y) <= cutR + elevTop) near = true;
      }
      if (any) {
        g.clip();
        g.globalAlpha = 1;                                                             // raised ground is solid: it hides what is behind it, the player too
        var sy = Math.max(0, pad + top - oy), sh = Math.min(ground.height - sy, bottom - top);
        var sx = Math.max(0, left - ox), sw = Math.min(ground.width - sx, wide + (left - ox < 0 ? left - ox : 0));
        if (sw > 0 && sh > 0) g.drawImage(ground, sx, sy, sw, sh, ox + sx, oy + sy - pad, sw, sh);
        // The ground picture has no fog in it: ground that is out of sight gets its veil again (as layer 2d laid it
        // on its top), so what stands behind a ledge never lights the ledge up. Nearest first, column by column: a
        // nearer piece hides the part of a farther one it stands in front of.
        if (sight.vis) for (var pi = pieces.length - 1, col = -1, floorY = Infinity; pi >= 0; pi--) {
          var pc = pieces[pi];
          if (pc.x !== col) { col = pc.x; floorY = Infinity; }
          var fy0 = Math.max(pc.y0, oy + sy - pad), fy1 = Math.min(pc.y1, floorY, oy + sy - pad + sh);   // (top and face alike, as layer 2d)
          floorY = Math.min(floorY, pc.y0);
          var fx0 = Math.max(pc.X, ox + sx), fx1 = Math.min(pc.X + T, ox + sx + sw);   // only where the ground was painted again (a thing between two tiles covers part of each)
          if (fy1 <= fy0 || fx1 <= fx0 || !(sw > 0 && sh > 0) || !hasFloor(pc.x, pc.y)) continue;
          if (!sight.known(pc.x, pc.y)) g.fillStyle = roofCol;
          else if (fogA > 0 && !sight.seen(pc.x, pc.y)) g.fillStyle = 'rgba(0,0,0,' + fogA + ')';
          else continue;
          g.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
        }
      }
      g.restore();
    }
    /** Draw one character (a player or a monster) with its tile's top-left at (ax, ay): figure, status tint, health bar, name. */
    /** The figure alone, its tile's top-left at (ax, ay), on gg; answers the top of what was drawn. */
    function drawFigure(gg, a, ax, ay) { return figureOn(gg, a, ax, ay, T); }
    // Wading: how deep a character stands in shallow water, 0..1 — smooth while it glides in or out (the shallow
    // tiles around where it is drawn, weighed by how near it is to each).
    function wadeAt(x, y) {
      if (!map.shallow || !map.shallow.length || !Rules.shallowAt) return 0;
      var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      function s(ax2, ay2) { return Rules.shallowAt(c, map, ax2, ay2) ? 1 : 0; }
      var a00 = s(x0, y0), a10 = fx ? s(x0 + 1, y0) : a00, a01 = fy ? s(x0, y0 + 1) : a00, a11 = fx && fy ? s(x0 + 1, y0 + 1) : (fx ? a10 : a01);
      return (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
    }
    function waterColour(x, y) {
      var t = Rules.terrainAt(c, map, Math.round(x), Math.round(y)), ramp = t && t.tint && typeof Tint !== 'undefined' && Tint.TINTS[t.tint];
      return (ramp && ramp[2]) || (t && t.color) || '#2a4a4a';
    }
    var wadeCv = null;
    /** A character standing in shallow water: the figure drawn on a scratch canvas, its part under the waterline
     *  faded and tinted the water's colour, then a ripple ring where it meets the water. Config wade_depth (0.22: up to where the bust's pedestal meets its chest) =
     *  how much of the figure, from its feet, is under. Answers the top of the figure. */
    function drawWading(a, ax, ay, wade, isDark, bob, wb) {
      var W3 = 3 * T, H5 = 5 * T;                                    // room for busts and weapons: the tile sits at (T, 4T)
      if (!wadeCv) wadeCv = document.createElement('canvas');
      if (wadeCv.width !== W3 || wadeCv.height !== H5) { wadeCv.width = W3; wadeCv.height = H5; }
      var sg = wadeCv.getContext('2d');
      sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, W3, H5); sg.imageSmoothingEnabled = false;
      var top0;
      if (wb) {                                                      // wading on: it sways as it walks (wobbleOf), the waterline stays level
        sg.save(); sg.translate(1.5 * T, 5 * T); sg.rotate(wb.ang); sg.translate(-1.5 * T, -5 * T);
        top0 = drawFigure(sg, a, T, 4 * T - wb.lift) + wb.lift;
        sg.restore();
      } else top0 = drawFigure(sg, a, T, 4 * T - (bob || 0)) + (bob || 0);
      var dep = Number(c.config.wade_depth); if (!(dep > 0)) dep = 0.22;
      var line = Math.round(H5 - Math.min(H5 - top0, 2 * T) * Math.min(0.9, dep) * wade);   // the waterline, on the scratch canvas
      sg.globalCompositeOperation = 'destination-out'; sg.fillStyle = 'rgba(0,0,0,' + (0.5 * wade) + ')'; sg.fillRect(0, line, W3, H5 - line);   // under water: faded…
      sg.globalCompositeOperation = 'source-atop'; sg.globalAlpha = 0.6 * wade; sg.fillStyle = waterColour(a.x, a.y); sg.fillRect(0, line, W3, H5 - line);   // …and the water's colour
      sg.globalAlpha = 1; sg.globalCompositeOperation = 'source-over';
      dim(isDark);
      g.drawImage(wadeCv, ax - T, ay - 4 * T);
      dim(false);
      var wy = ay - 4 * T + line, t = performance.now() / 600, cx = ax + T / 2, rw = T * (0.34 + 0.03 * Math.sin(t)), rh = Math.max(2, T * 0.09);
      g.save();                                                      // the ring where the body meets the water
      g.globalAlpha = 0.55 * wade; g.strokeStyle = 'rgba(220,240,245,.9)'; g.lineWidth = Math.max(1, T / 32);
      g.beginPath(); g.ellipse(cx, wy, rw, rh, 0, 0, Math.PI); g.stroke();   // (the front half only: the back half would show through the body)
      g.globalAlpha = 0.25 * wade; g.beginPath(); g.ellipse(cx, wy + 1, rw * (1.25 + 0.08 * Math.sin(t * 1.7)), rh * 1.4, 0, 0, Math.PI); g.stroke();
      g.restore();
      return ay - 4 * T + top0;
    }
    // Breathing: a figure standing still (a.idle) rises one art pixel and sinks again, slowly, each in its own time
    // (a.ph). Config idle_bob = off stops it. Its health bar and name stay where they are.
    var bobPx;                                                       // (worked out on first use: figures are painted from above this line)
    function bobOf(a) {
      if (!a.idle) return 0;
      if (bobPx === undefined) bobPx = String(cfg.idle_bob || '').toLowerCase() === 'off' ? 0 : Math.max(1, Math.round(T / NT));
      return bobPx && Math.sin(now / 380 + (a.ph || 0)) > 0 ? bobPx : 0;
    }
    // Walking sway: a figure on its way between two tiles leans a few degrees to one side and lifts one art pixel,
    // most at mid-step and none on the tile; the next step leans the other way (by which tile it left). It comes
    // from where the figure is drawn, so it keeps time with the steps, slow when sneaking or wading. Config
    // walk_wobble = the lean in degrees (2.5; 0 = off). Players and monsters alike.
    var wobDeg;
    function wobbleOf(a) {
      if (a.idle || a.fixed) return null;                          // (aiming too: the aimed arm and weapon lean with the body)
      if (wobDeg === undefined) { var wv = cfg.walk_wobble; wobDeg = wv === undefined || wv === '' ? 2.5 : (Number(wv) > 0 ? Number(wv) : 0); }
      if (!wobDeg) return null;
      var fx = a.x - Math.floor(a.x), fy = a.y - Math.floor(a.y);
      var s = Math.max(Math.sin(Math.PI * fx), Math.sin(Math.PI * fy));
      if (!(s > 0.02)) return null;
      var side = (Math.floor(a.x) + Math.floor(a.y)) % 2 ? 1 : -1;
      return { ang: side * s * wobDeg * Math.PI / 180, lift: s > 0.5 ? Math.max(1, Math.round(T / NT)) : 0 };
    }
    function paintActor(a, ax, ay, isDark) {
      var top, wade = wadeAt(a.x, a.y), bob = bobOf(a);
      // sneaking (docs/STEALTH.md): the figure turns into a shadow — dark, washed of colour, see-through (Config sneak_alpha, 0.55)
      if (a.sneak) { shadeNow = true; var sa = Number(cfg.sneak_alpha); g.globalAlpha = sa > 0 && sa <= 1 ? sa : 0.55; }
      var fading = a.alpha != null && a.alpha < 1;                   // a scene's actor fading in or out
      if (fading) g.globalAlpha = Math.max(0, a.alpha);
      var wb = wobbleOf(a);
      if (wade > 0.02) top = drawWading(a, ax, ay, wade, isDark, bob, wb);
      else if (wb) {                                                 // walking: the figure leans a little, about its feet, and lifts a pixel
        var wx = ax + T / 2, wy = ay + T;
        dim(isDark); g.save(); g.translate(wx, wy); g.rotate(wb.ang); g.translate(-wx, -wy);
        top = drawFigure(g, a, ax, ay - wb.lift) + wb.lift;
        g.restore(); dim(false);
      }
      else { dim(isDark); top = drawFigure(g, a, ax, ay - bob) + bob; dim(false); }
      if (a.sneak) { shadeNow = false; g.globalAlpha = 1; dim(false); }
      if (fading) g.globalAlpha = 1;
      if (a.statusColor) {                                           // tinted while burning, chilled, stunned...
        g.globalAlpha = .35; g.fillStyle = a.statusColor; g.fillRect(ax + 4, top + 4, T - 8, ay + T - top - 8); g.globalAlpha = 1;
      }
      if (a.maxHp && a.hp < a.maxHp && !a.me) {                       // health bar, just above the figure
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(ax + 4, top - 4, T - 8, 4);
        g.fillStyle = a.sprite !== undefined ? '#e04a3a' : '#4ec36a';
        g.fillRect(ax + 5, top - 3, Math.max(0, (T - 10) * a.hp / a.maxHp), 2);
      }
      if (a.name && a.sprite === undefined) nameTags.push({ x: ax + T / 2, y: top - 3, text: a.name, color: a.me ? '' : (a.nameColor || '#bfe0ff') });
      if (a.emote) emoteTags.push({ x: ax + T / 2, y: top - 3, named: !!(a.name && a.sprite === undefined), emote: a.emote });
    }

    // layer 5c: 'over' objects — the whole sprite sits in front of everything (foreground foliage, railings)
    // Anything damaged and in sight shows how much it has left.
    var stD = map._struct;
    if (stD && typeof World !== 'undefined' && World.structInfo) {
      var barKeys = Object.keys(stD.dmg || {}), meA = (actors || []).filter(function (a) { return a.me; })[0];
      // a resource's ring shows only to someone within reach of it: their own tile, or one of the eight around its footprint
      function reachable(e, o) {
        if (!meA) return false;
        var mx = Math.round(meA.x), my = Math.round(meA.y), fp = Rules.footprintOf(o, e), fw = fp.w, fh = fp.h;
        return mx >= e.x - 1 && mx <= e.x + fw && my >= e.y - 1 && my <= e.y + fh;
      }
      Object.keys(stD.walls || {}).forEach(function (k) { var w = stD.walls[k]; if ((w.prog || 0) < (w.need || 0) || w.hp < w.max) barKeys.push(k); });
      (stD.ents || []).forEach(function (b) { if ((b.prog || 0) < (b.need || 0) || b.hp < b.max) barKeys.push(b.key); });
      barKeys.forEach(function (k) {
        var em = /^([hv])(\d+),(\d+)$/.exec(k), info, bx, by;
        if (em) {
          var ex = Number(em[2]), ey = Number(em[3]);
          if (em[1] === 'h') { if (!sight.seen(ex, ey) && !sight.seen(ex, ey - 1)) return; }
          else if (!sight.seen(ex, ey) && !sight.seen(ex - 1, ey)) return;
          info = World.structInfo(c, map, { t: 'wall', orient: em[1], x: ex, y: ey }); if (!info) return;
          bx = ox + (em[1] === 'h' ? ex + 0.5 : ex) * T; by = oy + (em[1] === 'h' ? ey * T - 10 : (ey + 0.5) * T) - L(Math.min(ex, map.width - 1), Math.min(ey, map.height - 1));
        } else {
          info = World.structInfo(c, map, { t: 'ent', key: k }); if (!info) return;
          var en = info.e, eo = c.objects[en.ref], onWall = layerOf(eo) === 'wall';
          if (!sight.seen(en.x, en.y) && !(onWall && sight.seen(en.x, en.y - 1))) return;
          bx = ox + (en.x + (onWall ? Math.max(1, eo.footprintW || 1) : Rules.footprintOf(eo, en).w) / 2) * T; by = oy + en.y * T - (onWall ? 10 : 6) - L(en.x, en.y);
        }
        var fr = info.rec && (info.rec.prog || 0) < (info.rec.need || 0);
        if (fr) drawHpBar(g, bx, by, info.rec.prog / info.rec.need, '#6fb7ff');          // a frame: how far along it is
        else if (info.max > 0 && !em && (!info.built || (info.rec && info.rec.wild)) && info.obj && ((info.rec && info.rec.data && info.rec.data.harvest) || (info.obj.properties && info.obj.properties.harvest))) { if (reachable(info.e, info.obj)) drawRing(g, bx, oy + (info.e.y + 0.5) * T - L(info.e.x, info.e.y), info.hp / info.max); }   // a resource: a ring, not a health bar (and only within reach)
        else if (info.max > 0) drawHpBar(g, bx, by, info.hp / info.max);
      });
    }
    overs.sort(function (a, b) { return a.y - b.y; }).forEach(function (t) {
      dim(t.shade);
      drawObject(g, t.o, t.path, t.dx, t.dy, T, 'base', now, t.flip, t.lean);
      if (hasTop(t.o, t.path)) drawObject(g, t.o, t.path, t.dx, t.dy, T, 'top', now, t.flip, t.lean);
      dim(false);
    });

    // layer 6: the floors above (docs/FLOORS.md stage 3). Seen from outside they are the upper part of the
    // building, each a wall-height higher on the screen. Standing indoors, or under one of them, they are not
    // drawn at all — like a roof, they would only hide the room you are in. Outside, the part that would cover
    // the player's surroundings goes faint (the same cut-away walls get), so a tall building never hides you.
    var ups = this.above || [];
    if (ups.length) {
      var mx = meActor ? Math.round(meActor.x) : -999, my = meActor ? Math.round(meActor.y) : -999;
      var beneath = !!meActor && (sight.indoor(mx, my) || ups.some(function (f) { return !!(f.map.terrain[my] && f.map.terrain[my][mx]); }));
      if (!beneath) ups.forEach(function (f) {
        var lift = f.dz * WALL_H, fy = oy - Math.round(lift * T), fm = f.map, fr = fm.roof || [];
        function faint(x, y) { return !!meActor && Math.abs(x - mx) <= cutR && Math.abs(y - lift - my) <= cutR + 1; }
        var ra = Math.max(0, y0 + lift), rb = Math.min(fm.height - 1, y1 + lift + 1), ca = Math.max(0, x0), cb = Math.min(fm.width - 1, x1);
        for (var ry = ra; ry <= rb; ry++) for (var rx = ca; rx <= cb; rx++) {
          if (!(fm.terrain[ry] && fm.terrain[ry][rx])) continue;
          g.globalAlpha = faint(rx, ry) ? cutA * 0.5 : 1;
          var rf = fr[ry] && fr[ry][rx];
          if (rf && rf !== '0') { g.fillStyle = (fm.roof_color) || roofCol; g.fillRect(ox + rx * T, fy + ry * T, T, T); }
          else g.drawImage(f.ground, rx * T, ry * T, T, T, ox + rx * T, fy + ry * T, T, T);
        }
        var ufx = otherFloorFixtures(c, fm, ox, fy, T, (o2.floorStates || {})[fm.id]);
        f.prims.forEach(function (p) {
          if (p.x < ca - 1 || p.x > cb + 1 || p.y < ra - 1 || p.y > rb + 3) return;
          g.globalAlpha = faint(p.x, p.y) ? cutA * 0.5 : 1;
          drawOtherPrim(g, c, p, ox, fy, T, ufx);
        });
        ufx.list.sort(function (a, b) { return a.sortY - b.sortY; }).forEach(function (fx) {   // the windows and doors of the upper storeys
          if (fx.x < ca - 2 || fx.x > cb + 2 || fx.y < ra - 2 || fx.y > rb + 3) return;
          g.globalAlpha = faint(fx.x, fx.y) ? cutA * 0.5 : 1;
          fx.draw(g, now);
        });
        g.globalAlpha = 1;
      });
      // whoever stands up there in plain view (at a balcony's edge, at a window) is drawn whether or not the floor is
      (o2.floorActors || []).forEach(function (f) {
        if (f.dz <= 0) return;
        var ay2 = oy - Math.round(f.dz * WALL_H * T);
        f.actors.forEach(function (a) { paintActor(a, Math.round(ox + a.x * T), Math.round(ay2 + a.y * T), false); });
      });
    }
  };

  /** Aiming: cells in range, the line to the cursor, the cell under it (green = can cast) and the area it would hit. */
  /**
   * Build mode: the ghost of the blueprint at the spot under the cursor — the wall or object drawn faint,
   * outlined green where it may go and red where it may not, with the reason. gh = {bp, x, y, side, ok, reason}.
   */
  /** While building: whose land is whose. Bases you belong to get a green outline, others a red wash. */
  /** The object whose PICTURE is under a point of the view (canvas pixels), as drawn in the last frame: {x, y} = its own
   *  tile, or null. So a thing bigger than its tile (a tree, a wide bench) is picked by any pixel of it, see-through
   *  pixels apart. Of several, the one nearest the camera. Draw-only: what may be done there is still the rules' call. */
  Renderer.prototype.objectAt = function (px, py) {
    var T = this.content.config.tile_size || 32, best = null, list = this.hits || [];
    for (var i = 0; i < list.length; i++) {
      var h = list[i], img = h.path && Assets.get(h.path); if (!img) continue;
      var r = objRect(h.o, img, h.dx, h.dy, T, h.path);
      if (px < r.x || py < r.y || px >= r.x + r.w || py >= r.y + r.h) continue;
      if (best && h.e.y < best.e.y) continue;
      var sx = Math.floor((px - r.x) * NT / T), sy = Math.floor((py - r.y) * NT / T);
      if (h.flip) sx = Math.round(r.fw) - 1 - sx;
      if (!solidAt(img, sx, sy)) continue;
      best = h;
    }
    return best ? { x: best.e.x, y: best.e.y } : null;
  };
  /** Does a thing drawn bigger than a tile stand on that tile (its own tile), with nothing smaller sharing it? Then only
   *  its picture's pixels mean it (objectAt), not the tile's whole square. */
  Renderer.prototype.bigOn = function (x, y) {
    var T = this.content.config.tile_size || 32, list = this.hits || [], big = false;
    for (var i = 0; i < list.length; i++) {
      var h = list[i]; if (h.e.x !== x || h.e.y !== y) continue;
      var img = h.path && Assets.get(h.path); if (!img) return false;
      var r = objRect(h.o, img, h.dx, h.dy, T, h.path);
      if (r.w > T || r.h > T) big = true; else return false;         // (a small thing on the same tile: the tile is its too)
    }
    return big;
  };
  // Is that pixel of a picture drawn (not see-through)? The picture's pixels are read once and kept; one that cannot be
  // read (from another site) counts as solid everywhere.
  var _px = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function solidAt(img, sx, sy) {
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) return false;
    if (!_px || typeof document === 'undefined') return true;
    var d = _px.get(img);
    if (d === undefined) {
      try { var cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; var cg = cv.getContext('2d'); cg.drawImage(img, 0, 0); d = cg.getImageData(0, 0, img.width, img.height).data; }
      catch (e) { d = null; }
      _px.set(img, d);
    }
    return !d || d[(sy * img.width + sx) * 4 + 3] > 24;
  }
  Renderer.prototype.drawClaims = function (cam, claims, me, gh) {
    var g = this.g, c = this.content, T = c.config.tile_size || 32, ox = -cam.x, oy = -cam.y;
    var cmap = this.map;
    function box(x, y, r) { return [ox + (x - r) * T, oy + (y - r) * T - liftIn(cmap, x, y, T), (2 * r + 1) * T, (2 * r + 1) * T]; }   // (at the height of the flag's own ground)
    g.save(); g.lineWidth = 2;
    (claims || []).forEach(function (q) {
      var b = box(q.x, q.y, q.r), mine = World.isMember(q.e, me);
      if (!mine) { g.fillStyle = 'rgba(220,70,60,0.16)'; g.fillRect(b[0], b[1], b[2], b[3]); }
      g.strokeStyle = mine ? 'rgba(111,224,138,0.9)' : 'rgba(255,107,91,0.9)'; g.setLineDash([]);
      g.strokeRect(b[0] + 1, b[1] + 1, b[2] - 2, b[3] - 2);
    });
    var o = gh && gh.bp && gh.bp.places === 'object' ? c.objects[gh.bp.object] : null;
    if (o && o.kind === 'claim') {                                       // the land this flag would take
      var r = Number((o.properties || {}).claim_radius) || 8, nb = box(gh.x, gh.y, r);
      g.strokeStyle = gh.ok ? 'rgba(111,224,138,0.9)' : 'rgba(255,107,91,0.9)'; g.setLineDash([6, 5]);
      g.strokeRect(nb[0] + 1, nb[1] + 1, nb[2] - 2, nb[3] - 2);
    }
    g.restore();
  };
  Renderer.prototype.drawGhost = function (cam, gh) {
    if (!gh) return;
    var g = this.g, c = this.content, T = c.config.tile_size || 32, ox = -cam.x, map = this.map, oy = -cam.y - liftIn(this.map, gh.x, gh.y, T);   // on raised ground: drawn at its height
    // a roof (or a floor upstairs) says how safe the spot is: green = well held, yellow = as far from a wall as it can go, red = it would fall
    var edgy = gh.ok && gh.risk === 'edge';
    var bp = gh.bp, col = edgy ? '#ffd65a' : gh.ok ? '#6fe08a' : '#ff6b5b', o = bp.places === 'object' ? c.objects[bp.object] : null;
    g.save(); g.globalAlpha = 0.55;
    var x0, y0, x1, y1;                                                 // the outline: a line for an edge, a box for a tile
    if (bp.places === 'tile' || bp.places === 'roof') {                 // a piece of floor or roof: the terrain's colour of intent, and a box
      var tt = c.terrain[bp.terrain], ti = tt && tt.sprite && Assets.get(tt.sprite);
      if (ti) g.drawImage(ti, 0, 0, Math.min(ti.width, NT), Math.min(ti.height, NT), ox + gh.x * T, oy + gh.y * T, T, T);
      g.fillStyle = edgy ? 'rgba(255,214,90,.40)' : gh.ok ? 'rgba(111,224,138,.30)' : 'rgba(255,107,91,.30)'; g.fillRect(ox + gh.x * T, oy + gh.y * T, T, T);
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(ox + gh.x * T + 1, oy + gh.y * T + 1, T - 2, T - 2);
      x0 = null;
    } else if (o && o.kind === 'stairs') {                                 // stairs: the run, and a dashed box where they land upstairs
      var sge = { x: gh.x, y: gh.y, data: { facing: gh.facing || 'N' } }, sgd = Rules.DIRS[Rules.stairDir(sge)], sgn = Rules.stairLen();
      drawStairs(g, c, o, sge, ox, oy, T, 0);
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2;
      for (var sgi = 0; sgi < sgn; sgi++) g.strokeRect(ox + (gh.x + sgi * sgd.dx) * T + 1, oy + (gh.y + sgi * sgd.dy) * T + 1, T - 2, T - 2);
      g.setLineDash([4, 3]); g.strokeRect(ox + (gh.x + sgn * sgd.dx) * T + 2, oy + (gh.y + sgn * sgd.dy) * T + 2, T - 4, T - 4); g.setLineDash([]);
      x0 = null;
    } else if (bp.places === 'wall') {
      var v = gh.side === 'W', h = WALL_H;
      (v ? ['vface', 'vcap'] : ['hface', 'hcap']).forEach(function (kind) { drawPrim25(g, c, { kind: kind, x: gh.x, y: gh.y, h: h, style: bp.wallStyle, side: gh.off || 'c' }, ox, oy, T, false, 0); });
      var gHd = Math.round(Math.max(4, Math.round(T * 0.32)) / 2), gOff = gh.off === 'r' ? gHd : gh.off === 'l' ? -gHd : 0;   // same nudge the wall is drawn with
      x0 = ox + gh.x * T + gOff; y0 = oy + gh.y * T; x1 = v ? x0 : x0 + T; y1 = v ? y0 + T : y0;
    } else if (o && layerOf(o) === 'wall') {
      var gEnt = { x: gh.x, y: gh.y, data: { side: gh.side || 'N' } }, gSide = sideDoorEdges(o, gEnt);
      var mp = wallMountPlace(map, o, gEnt, ox, oy, T);
      if (!gSide.length || !gSide.every(function (q) { return drawDoorstep(g, map, o, false, ox, oy, q.x, q.y, T); })) {
        drawObject(g, o, o.sprite, mp.dx, mp.dy, T, 'base', 0, mp.flip); drawObject(g, o, o.sprite, mp.dx, mp.dy, T, 'top', 0, mp.flip);
      }
      var w2 = Math.max(1, o.footprintW || 1), hh2 = Math.max(1, o.footprintH || 1), vv = gh.side === 'W';
      x0 = ox + gh.x * T; y0 = oy + gh.y * T; x1 = vv ? x0 : x0 + w2 * T; y1 = vv ? y0 + T : y0;
      if (vv) { y0 = oy + (gh.y - hh2 + 1) * T; }
    } else if (o) {
      var gfs = Rules.facingSprite(o, gh.facing || 'S'), gpath = gfs.path || '#built';      // the ghost shows the way it faces
      drawObject(g, o, gpath, ox + gh.x * T, oy + gh.y * T, T, 'base', 0, gfs.flip); drawObject(g, o, gpath, ox + gh.x * T, oy + gh.y * T, T, 'top', 0, gfs.flip);
      var gfp = Rules.footprintOf(o, gh.facing), fw = gfp.w, fh = gfp.h;
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = 2;
      g.fillStyle = edgy ? 'rgba(255,214,90,.30)' : gh.ok ? 'rgba(111,224,138,.30)' : 'rgba(255,107,91,.38)';
      g.fillRect(ox + gh.x * T, oy + (gh.y - fh + 1) * T, fw * T, fh * T);
      g.strokeRect(ox + gh.x * T + 1, oy + (gh.y - fh + 1) * T + 1, fw * T - 2, fh * T - 2);
      x0 = null;
    }
    g.globalAlpha = 1;
    if (x0 != null) { g.strokeStyle = col; g.lineWidth = Math.max(3, Math.round(T * 0.14)); g.lineCap = 'round'; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
    var note = !gh.ok ? gh.reason : edgy ? 'As far from a wall as it can go' : '';
    if (note) {
      gh = { x: gh.x, y: gh.y, reason: note, warn: edgy };
      g.font = '11px sans-serif'; g.textAlign = 'center';
      var tx = ox + (gh.x + 0.5) * T, ty = oy + (gh.y + 1) * T + 12;
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(tx - g.measureText(gh.reason).width / 2 - 4, ty - 10, g.measureText(gh.reason).width + 8, 14);
      g.fillStyle = gh.warn ? '#ffe9a6' : '#ffb4a8'; g.fillText(gh.reason, tx, ty);
    }
    g.restore();
  };
  /** While laying roof or floor, or removing: the cells of this storey that already have a built roof over them, tinted. */
  Renderer.prototype.drawRoofs = function (cam, map) {
    var roof = map && map._struct && map._struct.roof; if (!roof) return;
    var g = this.g, T = this.content.config.tile_size || 32, ox = -cam.x, oy = -cam.y;
    g.save(); g.fillStyle = 'rgba(120,170,255,.22)'; g.strokeStyle = 'rgba(160,200,255,.55)'; g.lineWidth = 1;
    Object.keys(roof).forEach(function (k) {
      var q = k.split(','), px = ox + Number(q[0]) * T, py = oy + Number(q[1]) * T - liftIn(map, Number(q[0]), Number(q[1]), T);
      if (px < -T || py < -T || px > g.canvas.width || py > g.canvas.height) return;
      g.fillRect(px, py, T, T);
      g.beginPath(); g.moveTo(px, py + T); g.lineTo(px + T, py); g.stroke();                       // a diagonal: "something overhead"
    });
    g.restore();
  };
  /** The remove tool's outline (main.js removeTarget): red = a click takes it apart, grey = not now (with why). */
  Renderer.prototype.drawRemove = function (cam, rt, low, move) {      // move: the same outline for the move tool (blue, its own words)
    var g = this.g, c = this.content, T = c.config.tile_size || 32, ox = -cam.x, oy = -cam.y;
    var hint = move ? 'Move tool · drag something you built to its new spot · Esc: stop' : 'Remove tool · H: walls ' + (low ? 'down' : 'up') + ' · Esc: stop';   // always on screen while the tool is
    g.save(); g.font = '12px sans-serif'; g.textAlign = 'center';
    var hw = g.measureText(hint).width, hx = this.canvas.width / 2;
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(hx - hw / 2 - 8, 6, hw + 16, 20); g.fillStyle = move ? '#b9dcff' : '#ffb4a8'; g.fillText(hint, hx, 20); g.restore();
    if (!rt || !rt.info) return;
    var i = rt.info;
    oy -= liftIn(this.map, i.x, i.y, T);                         // on raised ground: drawn at its height
    var col = !rt.ok ? '#9aa0a8' : move ? '#6fb7ff' : '#ff5a4a', fill = !rt.ok ? 'rgba(154,160,168,.22)' : move ? 'rgba(111,183,255,.28)' : 'rgba(255,90,74,.28)';
    g.save(); g.strokeStyle = col; g.fillStyle = fill; g.lineWidth = 2; g.lineCap = 'round';
    function box(x, y, w, h) { g.fillRect(ox + x * T, oy + y * T, w * T, h * T); g.strokeRect(ox + x * T + 1, oy + y * T + 1, w * T - 2, h * T - 2); }
    function edge(q) {                                      // the wall's face above its line, and the line itself
      if (low) { /* walls are down: the line alone */ }
      else if (q.orient === 'h') box(q.x, q.y - WALL_H, 1, WALL_H);
      else { g.fillRect(ox + q.x * T - 4, oy + (q.y - WALL_H) * T, 8, (WALL_H + 1) * T); g.strokeRect(ox + q.x * T - 4, oy + (q.y - WALL_H) * T, 8, (WALL_H + 1) * T); }
      g.lineWidth = Math.max(3, Math.round(T * 0.14)); g.beginPath(); g.moveTo(ox + q.x * T, oy + q.y * T);
      g.lineTo(ox + (q.x + (q.orient === 'h' ? 1 : 0)) * T, oy + (q.y + (q.orient === 'h' ? 0 : 1)) * T); g.stroke(); g.lineWidth = 2;
    }
    var lx = i.x, ly = i.y;
    if (i.t === 'tile' || i.t === 'roof') box(i.x, i.y, 1, 1);
    else if (i.t === 'wall') edge(i);
    else if (rt.edges) { rt.edges.forEach(edge); lx = rt.edges[0].x; ly = rt.edges[0].y; }
    else if (i.obj && i.obj.kind === 'stairs') {
      var d = Rules.DIRS[Rules.stairDir(i.e)], n = Rules.stairLen();
      for (var k = 0; k < n; k++) box(i.x + k * d.dx, i.y + k * d.dy, 1, 1);
    } else {
      var ifp = Rules.footprintOf(i.obj, i.e), fw = ifp.w, fh = ifp.h;
      box(i.x, i.y - fh + 1, fw, fh);
    }
    var text = rt.ok ? (move ? 'Move ' : 'Remove ') + i.name : rt.reason;
    if (text) {
      g.font = '11px sans-serif'; g.textAlign = 'center';
      var tx = ox + (lx + (i.t === 'wall' && i.orient === 'v' ? 0 : 0.5)) * T, ty = oy + (ly + 1) * T + 12, tw = g.measureText(text).width;
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(tx - tw / 2 - 4, ty - 10, tw + 8, 14);
      g.fillStyle = rt.ok ? '#ffb4a8' : '#d5d8dc'; g.fillText(text, tx, ty);
    }
    g.restore();
  };
  Renderer.prototype.drawAim = function (cam, aim) {
    var g = this.g, T = this.content.config.tile_size || 32, amap = this.map;
    function up(x, y) { return liftIn(amap, Math.round(x), Math.round(y), T); }   // each tile at the height of its ground
    g.fillStyle = 'rgba(255,255,255,.10)';
    aim.cells.forEach(function (c) { g.fillRect(Math.round(c.x * T - cam.x) + 1, Math.round(c.y * T - cam.y) + 1 - up(c.x, c.y), T - 2, T - 2); });
    var h = aim.hover; if (!h) return;
    var col = h.ok ? '#6fe08a' : '#ff6b5b';
    g.strokeStyle = col; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(aim.from.x * T + T / 2 - cam.x, aim.from.y * T + T / 2 - cam.y - up(aim.from.x, aim.from.y)); g.lineTo(h.x * T + T / 2 - cam.x, h.y * T + T / 2 - cam.y - up(h.x, h.y)); g.stroke();
    g.setLineDash([]);
    if (h.ok && aim.blast) {                                  // explicit cells (a blast that stops at walls)
      g.fillStyle = 'rgba(255,170,80,.18)';
      aim.blast.forEach(function (c) { g.fillRect(Math.round(c.x * T - cam.x) + 1, Math.round(c.y * T - cam.y) + 1 - up(c.x, c.y), T - 2, T - 2); });
    } else if (h.ok && aim.area) {
      g.fillStyle = 'rgba(255,170,80,.18)';
      g.fillRect(Math.round((h.x - aim.area) * T - cam.x), Math.round((h.y - aim.area) * T - cam.y) - up(h.x, h.y), (2 * aim.area + 1) * T, (2 * aim.area + 1) * T);
    }
    g.lineWidth = 2; g.strokeRect(Math.round(h.x * T - cam.x) + 1, Math.round(h.y * T - cam.y) + 1 - up(h.x, h.y), T - 2, T - 2);
  };

  /** Layer 6: projectiles, spell flashes, floating numbers and words (damage, healing, loot, level up). */
  Renderer.prototype.drawFx = function (cam, fx, now) {
    var g = this.g, T = this.content.config.tile_size || 32, fmap = this.map;
    var cam0 = cam; cam = { x: cam0.x, y: cam0.y };                 // (shifted per effect by the height of the ground it is on)
    function hOf(x, y) { return liftAt(fmap, Math.max(0, Math.min(fmap.width - 1, Math.round(x))), Math.max(0, Math.min(fmap.height - 1, Math.round(y))), T); }   // how high the ground at a tile is drawn
    function onGround(x, y) { cam.y = cam0.y + liftAt(fmap, Math.max(0, Math.min(fmap.width - 1, x)), Math.max(0, Math.min(fmap.height - 1, y)), T); }
    g.textAlign = 'center';
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i], age = (now - f.t0) / (f.life || 900);
      if (age >= 1) { fx.splice(i, 1); continue; }
      if (age < 0) continue;
      onGround(f.x != null ? f.x : f.to ? f.to.x : 0, f.y != null ? f.y : f.to ? f.to.y : 0);
      if (f.kind === 'proj') {
        var h0 = hOf(f.from.x, f.from.y), h1 = hOf(f.to.x, f.to.y);   // from the height it leaves at to the height it lands at
        var px = (f.from.x + (f.to.x - f.from.x) * age) * T + T / 2 - cam.x, py = (f.from.y + (f.to.y - f.from.y) * age) * T + T / 2 - cam0.y - (h0 + (h1 - h0) * age);
        g.fillStyle = f.color; g.globalAlpha = .35; g.beginPath(); g.arc(px, py, 7, 0, 7); g.fill();
        g.globalAlpha = 1; g.beginPath(); g.arc(px, py, 3.5, 0, 7); g.fill();
        continue;
      }
      if (f.kind === 'tracer') {                                      // a bullet streak that fades fast
        g.strokeStyle = f.color; g.globalAlpha = .9 * (1 - age); g.lineWidth = 2;
        g.beginPath(); g.moveTo(f.from.x * T + T / 2 - cam.x, f.from.y * T + T / 2 - cam0.y - hOf(f.from.x, f.from.y)); g.lineTo(f.to.x * T + T / 2 - cam.x, f.to.y * T + T / 2 - cam0.y - hOf(f.to.x, f.to.y)); g.stroke();
        g.globalAlpha = 1;
        continue;
      }
      if (f.kind === 'burst') {
        // a death (Render.burst): the figure's own pixels thrown outwards, falling and fading, and its blood in the air
        var ts = (now - f.t0) / 1000, bx = f.x * T - cam.x, by2 = f.y * T - cam.y, GR = T * 9;
        for (var pi = 0; pi < f.p.length; pi++) {
          var q = f.p[pi], qa = age / q.l; if (qa >= 1) continue;
          g.globalAlpha = 1 - qa * qa; g.fillStyle = q.c;
          g.fillRect(Math.round(bx + q.x + q.vx * ts), Math.round(by2 + q.y + q.vy * ts + GR * ts * ts / 2), q.s, q.s);
        }
        g.fillStyle = f.color || '#a01818';
        for (var di = 0; f.color && di < f.drops.length; di++) {
          var d = f.drops[di], dk = d.t ? (now - f.t0) / d.t : 1; if (dk >= 1) continue;          // landed: it is in the stain now
          g.globalAlpha = d.a + 0.1;
          g.fillRect(Math.round(bx + (0.5 + (d.dx - 0.5) * dk) * T), Math.round(by2 + (f.cy + (d.dy - f.cy) * dk) * T - Math.sin(Math.PI * dk) * T * 0.45), d.s, d.s);
        }
        g.globalAlpha = 1;
        continue;
      }
      if (f.kind === 'sound') {
        // a step's noise while sneaking (docs/STEALTH.md): a ring that grows out to how far it carries (f.r tiles) and
        // fades. Square with round corners, as hearing reaches: every tile within f.r steps, diagonals too.
        var hw = (0.5 + f.r * Math.sqrt(age)) * T, cx = f.x * T + T / 2 - cam.x, cy = f.y * T + T / 2 - cam.y;
        g.globalAlpha = .55 * (1 - age); g.strokeStyle = f.color || '#cfe3ff'; g.lineWidth = Math.max(1, Math.round(T / 16));
        g.beginPath();
        if (g.roundRect) g.roundRect(Math.round(cx - hw), Math.round(cy - hw), Math.round(2 * hw), Math.round(2 * hw), Math.round(hw * 0.45));
        else g.rect(Math.round(cx - hw), Math.round(cy - hw), Math.round(2 * hw), Math.round(2 * hw));
        g.stroke();
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

  return { burst: burst, figureOn: figureOn, outfitOf: outfitOf, outfitLayers: outfitLayers, drawOutfit: drawOutfit, Renderer: Renderer, bakeGround: bakeGround, animatedCells: animatedCells, shallowCells: shallowCells, drawAnimated: drawAnimated, fallCells: fallCells, fallAt: fallAt, cliffFoot: cliffFoot, cliffRect: cliffRect, drawCliffThing: drawCliffThing, drawCliffThings: drawCliffThings, drawFalls: drawFalls, southDrop: southDrop, FALL_SPRITE: FALL_SPRITE, foamPaths: foamPaths, elevOn: elevOn, maxElev: maxElev, drawRelief: drawRelief, pickCell: pickCell, pickCells: pickCells, liftAt: liftAt, groundSheet: groundSheet, drawObject: drawObject, frameOf: frameOf,
    parseWallTok: parseWallTok, wall25: wall25, prim25SortY: prim25SortY, drawPrim25: drawPrim25, makeSight: makeSight,
    layerOf: layerOf, wallMountPlace: wallMountPlace, drawStairs: drawStairs, doorstepPath: doorstepPath, drawDoorstep: drawDoorstep, sideDoorEdges: sideDoorEdges };
})();
