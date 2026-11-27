/**
 * Emotes: small pixel-art signs over a head (zzz, !, ?, a heart...). Draw-only. The list of ids and names is
 * Content.EMOTES (the Studio and the referee read it); the pictures are here, as rows of letters (one letter = one
 * art pixel, the colours in PAL), drawn crisp at the view's scale. Where they are used:
 *   - scene steps of kind `emote` (client/js/scene.js: over the player, an NPC or a tile)
 *   - an NPC's standing emote (Objects properties.emote: a sleeping guard always shows zzz)
 *   - a player's own ({type: 'emote', id}, the G key in main.js): the others see it for SHOW_MS
 *
 *   Emotes.draw(g, id, x, y, t, k, left)   x = the middle, y = the bottom (the tip of the bubble's tail), canvas
 *                                          pixels; t = ms since it went up; k = canvas pixels per art pixel;
 *                                          left = ms it has left (Infinity = it stays), for the fade at the end
 *   Emotes.icon(id, k)                     a small canvas of it (pickers: the Studio, the G bar)
 *   Emotes.SHOW_MS                         how long a player's emote shows
 * A new emote = a row in Content.EMOTES and its picture in ART. A classic script, like the others.
 */
var Emotes = (function () {
  var PAL = { k: '#2a2335', w: '#f6f1e4', r: '#d6453b', b: '#4f8fd8', B: '#cfe6ff', g: '#6b6475', y: '#f2c94c' };
  var SHOW_MS = 3000, POP_MS = 180, FADE_MS = 300;
  // the bubble the icons sit in (13 x 13 art pixels; the icon's 9 x 7 go at column 2, row 2)
  var BUBBLE = [
    '..kkkkkkkkk..',
    '.kwwwwwwwwwk.',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    'kwwwwwwwwwwwk',
    '.kwwwwwwwwwk.',
    '..kkkwkkkkk..',
    '....kwk......',
    '.....k.......'
  ];
  // frames: one or more pictures; ms = how long each shows (they loop)
  var ART = {
    alert: { frames: [[
      '....r....',
      '...rrr...',
      '...rrr...',
      '...rrr...',
      '....r....',
      '.........',
      '....r....']] },
    question: { frames: [[
      '..bbbbb..',
      '.bb...bb.',
      '......bb.',
      '....bbb..',
      '....bb...',
      '.........',
      '....bb...']] },
    heart: { ms: 260, frames: [[
      '.rr...rr.',
      'rrrr.rrrr',
      'rwrrrrrrr',
      '.rrrrrrr.',
      '..rrrrr..',
      '...rrr...',
      '....r....'], [
      '.........',
      '.rr...rr.',
      'rwrr.rrrr',
      '.rrrrrrr.',
      '..rrrrr..',
      '...rrr...',
      '....r....']], seq: [0, 1, 0, 0, 0] },
    dots: { ms: 350, frames: [
      ['.........', '.........', '.........', '.gg......', '.gg......', '.........', '.........'],
      ['.........', '.........', '.........', '.gg.gg...', '.gg.gg...', '.........', '.........'],
      ['.........', '.........', '.........', '.gg.gg.gg', '.gg.gg.gg', '.........', '.........']], seq: [0, 1, 2, 2], icon: 2 },
    angry: { ms: 300, frames: [[
      '..r...r..',
      '.rr...rr.',
      'rr.....rr',
      '.........',
      'rr.....rr',
      '.rr...rr.',
      '..r...r..'], [
      '.........',
      '...r.r...',
      '..rr.rr..',
      '.........',
      '..rr.rr..',
      '...r.r...',
      '.........']] },
    sweat: { ms: 400, frames: [[
      '....b....',
      '...bb....',
      '...bbb...',
      '..bbbbb..',
      '..bBbbb..',
      '..bbbbb..',
      '...bbb...'], [
      '.........',
      '....b....',
      '...bb....',
      '...bbb...',
      '..bbbbb..',
      '..bBbbb..',
      '...bbb...']] },
    // (not in Content.EMOTES: the mark over whoever is saying a line in a scene)
    talk: { ms: 300, frames: [[
      '.........',
      '.gggggg..',
      '.........',
      '.gggg....',
      '.........',
      '.ggggg...',
      '.........'], [
      '.........',
      '.gggg....',
      '.........',
      '.gggggg..',
      '.........',
      '.ggg.....',
      '.........']] },
    note: { ms: 400, frames: [[
      '...kkkkkk',
      '...k....k',
      '...k....k',
      '...k....k',
      '.kkk..kkk',
      'kkkk.kkkk',
      '.kk...kk.'], [
      '..kkkkkk.',
      '..k....k.',
      '..k....k.',
      '..k....k.',
      'kkk..kkk.',
      'kkk.kkkk.',
      'kk...kk..']] }
  };
  // zzz: no bubble, letters that rise and fade, each with a dark edge
  var Z_BIG = ['BBBBB', '...B.', '..B..', '.B...', 'BBBBB'], Z_SMALL = ['BBBB', '..B.', '.B..', 'BBBB'];
  var Z_CYCLE = 1800;

  var cache = {};
  function sheet(rows, edge) {                                   // rows of letters → a canvas, 1 px per art pixel (edge: a dark rim round it)
    var h = rows.length, w = rows[0].length, pad = edge ? 1 : 0;
    var cv = document.createElement('canvas'); cv.width = w + pad * 2; cv.height = h + pad * 2;
    var x = cv.getContext('2d');
    function at(c, r) { return r >= 0 && r < h && c >= 0 && c < w && rows[r].charAt(c) !== '.'; }
    for (var r = -pad; r < h + pad; r++) for (var c = -pad; c < w + pad; c++) {
      var ch = at(c, r) ? rows[r].charAt(c) : '';
      if (!ch && edge) { for (var dr = -1; dr <= 1 && !ch; dr++) for (var dc = -1; dc <= 1; dc++) if (at(c + dc, r + dr)) { ch = 'k'; break; } }
      if (!ch) continue;
      x.fillStyle = PAL[ch] || ch; x.fillRect(c + pad, r + pad, 1, 1);
    }
    return cv;
  }
  function framePic(id, n) {
    var key = id + ':' + n;
    if (cache[key]) return cache[key];
    var a = ART[id], icon = a.frames[n], rows = BUBBLE.map(function (row, r) {
      if (r < 2 || r > 8) return row;
      return row.slice(0, 2) + icon[r - 2].split('').map(function (ch, i) { return ch === '.' ? row.charAt(2 + i) : ch; }).join('') + row.slice(11);
    });
    return (cache[key] = sheet(rows, false));
  }
  function zPic(big) { var key = big ? 'Z' : 'z'; return cache[key] || (cache[key] = sheet(big ? Z_BIG : Z_SMALL, true)); }
  function frameAt(a, t) {
    if (a.frames.length < 2) return 0;
    var seq = a.seq || a.frames.map(function (f, i) { return i; });
    return seq[Math.floor(t / (a.ms || 300)) % seq.length];
  }

  function known(id) { return id === 'sleep' || !!ART[id]; }
  function draw(g, id, x, y, t, k, left) {
    if (!known(id)) return;
    k = Math.max(1, Math.round(k || 1)); t = Math.max(0, t || 0);
    var fade = left === undefined || left === Infinity ? 1 : Math.max(0, Math.min(1, left / FADE_MS));
    g.save(); g.imageSmoothingEnabled = false;
    if (id === 'sleep') {                                        // three letters, each rising from the head and fading
      for (var i = 0; i < 3; i++) {
        var local = t - i * Z_CYCLE / 3;
        if (local < 0) continue;                                 // (not yet: they come one by one)
        var p = (local % Z_CYCLE) / Z_CYCLE;
        var pic = zPic(p > 0.45), al = p < 0.15 ? p / 0.15 : p > 0.7 ? (1 - p) / 0.3 : 1;
        var zx = Math.round(x / k + Math.round(p * 7) - 2), zy = Math.round(y / k - Math.round(p * 15) - pic.height);
        g.globalAlpha = Math.max(0, al) * fade;
        g.drawImage(pic, zx * k, zy * k, pic.width * k, pic.height * k);
      }
      g.restore(); return;
    }
    var a = ART[id], pc = framePic(id, frameAt(a, t));
    var pop = t < POP_MS ? Math.ceil(3 * (1 - t / POP_MS)) : 0;          // it pops up: a few art pixels low at first
    var bob = t >= POP_MS && Math.sin(t / 320) > 0.6 ? 1 : 0;
    g.globalAlpha = Math.min(1, 0.3 + t / POP_MS) * fade;
    var bx = Math.round(x / k - (pc.width - 1) / 2 - 0.5), by = Math.round(y / k - pc.height + pop - bob);
    g.drawImage(pc, bx * k, by * k, pc.width * k, pc.height * k);
    g.restore();
  }
  function icon(id, k) {
    k = k || 2;
    var pic = id === 'sleep' ? null : known(id) ? framePic(id, ART[id].icon || 0) : null;   // (icon: the frame that says it best)
    var cv = document.createElement('canvas'); cv.width = 13 * k; cv.height = 13 * k;
    var x = cv.getContext('2d'); x.imageSmoothingEnabled = false;
    if (pic) x.drawImage(pic, 0, 0, pic.width * k, pic.height * k);
    else if (id === 'sleep') { var zb = zPic(true), zs = zPic(false); x.drawImage(zs, 1 * k, 7 * k, zs.width * k, zs.height * k); x.drawImage(zb, 6 * k, 1 * k, zb.width * k, zb.height * k); }
    return cv;
  }
  return { draw: draw, icon: icon, known: known, SHOW_MS: SHOW_MS };
})();
if (typeof module !== 'undefined') module.exports = Emotes;
