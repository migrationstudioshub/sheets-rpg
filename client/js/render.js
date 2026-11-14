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

  /** The object layer: 'object' (y-sorted, default), 'wall' (over a wall face) or 'ground_decal' (flat). */
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

    // layer 3: objects (sprite follows the entity's state, then its facing; ground decals are baked)
    // draw order per object: 'auto' = base here (behind characters), tall overflow saved for after them;
    // 'under' = whole object here (always behind characters); 'over' = whole object saved for after them.
    var tops = [], overs = [];
    map.entities.forEach(function (e) {
      if (e.x < x0 - 4 || e.x > x1 || e.y < y0 - 3 || e.y > y1) return;   // wide/tall objects reach beyond their cell
      var o = c.objects[e.ref]; if (!o || (hidden && hidden(e)) || layerOf(o) === 'ground_decal') return;
      var st = states[e.key], facing = (e.data && e.data.facing) || null;
      var path = objPath(o, st, facing), flip = facing === 'left' || facing === 'W';
      var dx = ox + e.x * T, dy = oy + e.y * T, dz = o.draw || 'auto';
      if (dz === 'over') {
        overs.push({ o: o, path: path, y: e.y, dx: dx, dy: dy, flip: flip });
      } else {
        drawObject(g, o, path, dx, dy, T, 'base', now, flip);
        if (hasTop(o, path)) {
          if (dz === 'under') drawObject(g, o, path, dx, dy, T, 'top', now, flip);   // keep the overflow behind characters too
          else tops.push({ o: o, path: path, y: e.y, dx: dx, dy: dy, flip: flip });
        }
      }
      // no art for this state yet: show it with a simple mark
      if (dz !== 'over' && st && !o.spriteStates[st]) {
        if (st === 'open' && o.kind === 'door') { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(dx + 4, dy + 2, T - 8, T - 4); }
        else if (st === 'empty' || st === 'open') { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(dx, dy, T, T); }
        else if (st === 'down' && o.kind === 'trap') { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(dx, dy, T, T); }
        else if (st === 'on') { g.fillStyle = 'rgba(255,210,80,.35)'; g.fillRect(dx, dy, T, T); }
      }
    });

    // layer 5: characters, back to front so lower ones overlap upper ones
    actors.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (a) {
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

    // layer 5b: tops of tall objects (tree crowns, roofs) cover characters behind them;
    // lower objects are drawn last, so a tree in front overlaps the one behind it
    tops.sort(function (a, b) { return a.y - b.y; }).forEach(function (t) { drawObject(g, t.o, t.path, t.dx, t.dy, T, 'top', now, t.flip); });
    // layer 5c: 'over' objects — the whole sprite sits in front of characters (foreground foliage, railings)
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
    if (h.ok && aim.area) {
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
        g.fillRect(Math.round((f.x - f.r) * T - cam.x), Math.round((f.y - f.r) * T - cam.y), (2 * f.r + 1) * T, (2 * f.r + 1) * T);
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

  return { Renderer: Renderer, bakeGround: bakeGround, drawObject: drawObject, frameOf: frameOf };
})();
