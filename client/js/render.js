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

  /**
   * Draws one object at cell (dx, dy). part 'base' = its own tile (the part that can block);
   * part 'top' = everything above it, drawn after characters so they can walk behind it.
   * Tall objects either have a sprite_top image (one tile up) or a base image taller than wide.
   */
  function drawObject(g, o, path, dx, dy, size, part, now) {
    var img = path && Assets.get(path);
    if (!img) { if (part === 'base' && path) g.drawImage(Assets.placeholder(o.name, '#7a5a3a', size), dx, dy, size, size); return; }
    var f = frameOf(img, o.frames, o.frameMs, now), tall = Math.round(img.height / f.sw) || 1;
    if (part === 'base') {
      g.drawImage(img, f.sx, img.height - f.sw * Math.min(1, img.height / f.sw), f.sw, Math.min(img.height, f.sw), dx, dy, size, size);
    } else {
      if (tall > 1) g.drawImage(img, f.sx, 0, f.sw, img.height - f.sw, dx, dy - (tall - 1) * size, size, (tall - 1) * size);
      var top = o.spriteTop && Assets.get(o.spriteTop);
      if (top) {
        var ft = frameOf(top, o.frames, o.frameMs, now), rows = top.height / ft.sw;   // sprite_top may itself be several tiles tall
        g.drawImage(top, ft.sx, 0, ft.sw, top.height, dx, dy - (tall - 1) * size - rows * size, size, rows * size);
      }
    }
  }
  function hasTop(o, path) {
    if (o.spriteTop) return true;
    var img = path && Assets.get(path); if (!img) return false;
    return img.height > img.width / Math.max(1, o.frames || 1) + 1;
  }

  /** Paints base colours and terrain for a whole map once. */
  function bakeGround(content, map) {
    var T = content.config.tile_size || 32;
    var c = document.createElement('canvas');
    c.width = map.width * T; c.height = map.height * T;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    var auto = Autotile.grid(content, map);
    for (var y = 0; y < map.height; y++) {
      for (var x = 0; x < map.width; x++) {
        var t = content.terrain[map.terrain[y][x]];
        var dx = x * T, dy = y * T;
        g.fillStyle = t ? t.color : '#ff00ff';                 // layer 1: base colour
        g.fillRect(dx, dy, T, T);
        if (!t) continue;
        var a = auto[y][x];                                    // layer 2: terrain tile
        if (a) {
          var ts = content.tilesets[a.tileset], img = Assets.get(ts.image);
          if (img) tileFromSheet(img, ts, a.tile, g, dx, dy, T);
        } else if (t.sprite) {
          var timg = Assets.get(t.sprite);
          if (timg) { var f0 = frameOf(timg, t.frames, t.frameMs, 0); g.drawImage(timg, 0, 0, f0.sw, f0.fh, dx, dy, T, T); }
        }
      }
    }
    return c;
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

    // layer 3: objects (sprite follows the entity's state when the object defines one)
    var tops = [];
    map.entities.forEach(function (e) {
      if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) return;
      var o = c.objects[e.ref]; if (!o || (hidden && hidden(e))) return;
      var st = states[e.key], path = (st && o.spriteStates[st]) || o.sprite;
      var dx = ox + e.x * T, dy = oy + e.y * T;
      drawObject(g, o, path, dx, dy, T, 'base', now);
      if (hasTop(o, path)) tops.push({ o: o, path: path, y: e.y, dx: dx, dy: dy });
      // no art for this state yet: show it with a simple mark
      if (st && !o.spriteStates[st]) {
        if (st === 'open' && o.kind === 'door') { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(dx + 4, dy + 2, T - 8, T - 4); }
        else if (st === 'empty' || st === 'open') { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(dx, dy, T, T); }
        else if (st === 'down' && o.kind === 'trap') { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(dx, dy, T, T); }
        else if (st === 'on') { g.fillStyle = 'rgba(255,210,80,.35)'; g.fillRect(dx, dy, T, T); }
      }
    });

    // layer 5: characters, back to front so lower ones overlap upper ones
    actors.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (a) {
      var ax = Math.round(ox + a.x * T), ay = Math.round(oy + a.y * T);
      if (a.sprite !== undefined) {
        var img = a.sprite && Assets.get(a.sprite);
        if (img) {
          g.save();
          if (a.facing === 'W') { g.translate(ax + T, ay); g.scale(-1, 1); g.drawImage(img, 0, 0, T, T); }
          else g.drawImage(img, ax, ay, T, T);
          g.restore();
        } else g.drawImage(Assets.placeholder(a.name, '#8a2f2f', T), ax, ay);
      } else g.drawImage(Assets.hero(a.facing, a.tint || '#3d6fb6', T), ax, ay);
      if (a.statusColor) {                                           // tinted while burning, chilled, stunned...
        g.globalAlpha = .35; g.fillStyle = a.statusColor; g.fillRect(ax + 4, ay + 4, T - 8, T - 6); g.globalAlpha = 1;
      }
      if (a.maxHp && a.hp < a.maxHp && !a.me) {                       // health bar
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(ax + 4, ay - 4, T - 8, 4);
        g.fillStyle = a.sprite !== undefined ? '#e04a3a' : '#4ec36a';
        g.fillRect(ax + 5, ay - 3, Math.max(0, (T - 10) * a.hp / a.maxHp), 2);
      }
      if (a.name && a.sprite === undefined) {
        g.font = '8px sans-serif'; g.textAlign = 'center';
        g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(a.name, ax + T / 2 + 1, ay - 5);
        g.fillStyle = a.me ? '#fff' : '#bfe0ff'; g.fillText(a.name, ax + T / 2, ay - 6);
      }
    });

    // layer 5b: tops of tall objects (tree crowns, roofs) cover characters behind them;
    // lower objects are drawn last, so a tree in front overlaps the one behind it
    tops.sort(function (a, b) { return a.y - b.y; }).forEach(function (t) { drawObject(g, t.o, t.path, t.dx, t.dy, T, 'top', now); });
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
