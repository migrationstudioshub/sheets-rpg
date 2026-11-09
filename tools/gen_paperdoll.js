/**
 * Draws placeholder paper-doll layers for players: a base "bust" body and a few
 * equipment pieces, each a 32x48 transparent PNG (1 tile wide, 1.5 tall), authored
 * so every layer lines up when stacked. Our own drawings, safe for this public repo.
 *
 * The contract the engine expects (see client/js/render.js): every layer is the same
 * size, the figure stands on the bottom edge (bottom-anchored on its tile), and the
 * art for a piece sits exactly where it belongs on the body with the rest transparent.
 * The whole stack is flipped horizontally when the character faces west.
 *
 * Usage: node tools/gen_paperdoll.js [outDir]   (default art/sprites/paperdoll)
 */
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

var W = 32, H = 48;

// ---- tiny RGBA canvas -------------------------------------------------------
function Canvas() { this.buf = Buffer.alloc(W * H * 4, 0); }
Canvas.prototype.px = function (x, y, c) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  var i = (y * W + x) * 4, a = c[3] == null ? 255 : c[3];
  if (a >= 255) { this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255; return; }
  var sa = a / 255, da = this.buf[i + 3] / 255, oa = sa + da * (1 - sa);          // src-over blend
  if (oa <= 0) return;
  for (var k = 0; k < 3; k++) this.buf[i + k] = Math.round((c[k] * sa + this.buf[i + k] * da * (1 - sa)) / oa);
  this.buf[i + 3] = Math.round(oa * 255);
};
Canvas.prototype.rect = function (x, y, w, h, c) {
  for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) this.px(xx, yy, c);
};
Canvas.prototype.ellipse = function (cx, cy, rx, ry, c) {
  for (var yy = Math.floor(cy - ry); yy <= cy + ry; yy++)
    for (var xx = Math.floor(cx - rx); xx <= cx + rx; xx++) {
      var dx = (xx + 0.5 - cx) / rx, dy = (yy + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) this.px(xx, yy, c);
    }
};

// ---- PNG encoder (RGBA, one IDAT) ------------------------------------------
var CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(b) { var c = ~0; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return ~c; }
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
function toPng(canvas) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;                                           // 8-bit depth, colour type 6 = RGBA
  var raw = Buffer.alloc((W * 4 + 1) * H);
  for (var y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; canvas.buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- the layers -------------------------------------------------------------
var COL = {
  shadow: [0, 0, 0, 70], skin: [226, 180, 138], skinSh: [196, 150, 112], hair: [74, 53, 38],
  tunic: [106, 90, 70], tunicSh: [84, 70, 54], pants: [58, 48, 38], boots: [42, 28, 18], eye: [27, 27, 27],
  leather: [150, 96, 52], leatherSh: [110, 70, 38], leatherHi: [184, 126, 76],
  iron: [158, 168, 182], ironSh: [96, 104, 118], ironHi: [206, 214, 226],
  wood: [176, 138, 90], woodSh: [120, 90, 56], steel: [200, 208, 220], steelSh: [120, 128, 142], guard: [120, 94, 52],
};

function body() {
  var c = new Canvas();
  c.ellipse(16, 45.5, 9, 2.5, COL.shadow);                            // ground shadow
  c.rect(12, 34, 4, 11, COL.pants); c.rect(17, 34, 4, 11, COL.pants); // legs
  c.rect(11, 43, 5, 4, COL.boots); c.rect(17, 43, 5, 4, COL.boots);   // boots
  c.rect(6, 24, 4, 11, COL.tunicSh); c.rect(23, 24, 4, 11, COL.tunicSh); // arms (sleeves)
  c.rect(7, 33, 3, 3, COL.skin); c.rect(23, 33, 3, 3, COL.skin);      // hands
  c.rect(8, 22, 16, 5, COL.tunic);                                    // shoulders
  c.rect(10, 26, 12, 10, COL.tunic);                                  // torso
  c.rect(11, 30, 10, 2, COL.tunicSh);                                 // simple fold shading
  c.rect(14, 19, 4, 4, COL.skin);                                     // neck
  c.ellipse(16, 12, 8, 9, COL.skin);                                  // head (big: bust proportions)
  c.ellipse(16, 7.5, 8, 6, COL.hair);                                 // hair cap over the top
  c.rect(8, 12, 2, 6, COL.hair); c.rect(22, 12, 2, 6, COL.hair);      // hair at the sides
  c.px(12, 12, COL.eye); c.px(12, 13, COL.eye); c.px(19, 12, COL.eye); c.px(19, 13, COL.eye); // eyes
  c.ellipse(16, 20, 2.5, 1.5, COL.skinSh);                            // chin shading
  return c;
}

function chest(base, sh, hi, pauldrons) {
  var c = new Canvas();
  c.rect(10, 25, 12, 11, base);                                       // chest plate over the torso
  c.rect(8, 23, 16, 4, base);                                         // over the shoulders
  c.rect(10, 31, 12, 2, sh);                                          // belt line
  c.rect(15, 25, 2, 10, hi);                                          // centre highlight
  if (pauldrons) { c.ellipse(9, 24, 3, 2.5, hi); c.ellipse(23, 24, 3, 2.5, hi); } // metal shoulder caps
  return c;
}

function sword(blade, bladeSh) {
  var c = new Canvas();                                               // held at the figure's right (image right)
  c.rect(25, 9, 3, 23, blade); c.rect(25, 9, 1, 23, bladeSh);         // blade
  c.rect(22, 31, 9, 2, COL.guard);                                    // cross-guard
  c.rect(25, 33, 3, 5, COL.guard);                                    // grip
  c.rect(25, 38, 3, 2, COL.steelSh);                                  // pommel
  return c;
}

function main() {
  var out = process.argv[2] || path.join('art', 'sprites', 'paperdoll');
  fs.mkdirSync(out, { recursive: true });
  var files = {
    'body_base.png': body(),
    'chest_leather.png': chest(COL.leather, COL.leatherSh, COL.leatherHi, false),
    'chest_iron.png': chest(COL.iron, COL.ironSh, COL.ironHi, true),
    'sword_wooden.png': sword(COL.wood, COL.woodSh),
    'sword_iron.png': sword(COL.steel, COL.steelSh),
  };
  Object.keys(files).forEach(function (name) { fs.writeFileSync(path.join(out, name), toPng(files[name])); });
  console.log('wrote', Object.keys(files).length, 'paper-doll layers to', out);
}
main();
