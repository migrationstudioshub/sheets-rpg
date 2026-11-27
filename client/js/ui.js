/**
 * The UI kit (art/ui/kit/, described piece by piece in art/ui/kit/PIECES.md): which picture every piece uses, how big
 * an art pixel is on this screen, which parts of the HUD are switched off, and the small things every screen is built
 * from (bars, vital chips, key caps, icons, toasts, the tooltip, the clock, the minimap).
 *
 * The page's stylesheet (client/css/ui.css) never names a picture file: it uses --k-<piece>, set here. And it never
 * uses screen pixels: 1rem = 1 art pixel (the root font size is --u screen pixels, a whole number).
 */
var UI = (function () {
  var KIT = '../art/ui/kit/';

  // ---- which set a piece comes from. A piece not listed here is the plain one (art/ui/kit/plain/); 'nb' = the Nano
  // Banana one (art/ui/kit/nb/, same name, same size). Moving a piece from one set to the other is one line here.
  var SET = {
    panel_metal: 'nb',
    header_plate: 'nb',
    panel_paper: 'nb',
    button_normal_idle: 'nb', button_normal_hover: 'nb', button_normal_pressed: 'nb', button_normal_disabled: 'nb',
    button_primary_idle: 'nb', button_primary_hover: 'nb', button_primary_pressed: 'nb',
    button_danger_idle: 'nb', button_danger_hover: 'nb', button_danger_pressed: 'nb'
  };
  // every piece the stylesheet uses
  var PIECES = ['icon_x', 'panel_metal', 'panel_plate', 'panel_inset', 'panel_paper', 'panel_tooltip', 'tape', 'header_plate', 'tab_active', 'tab_idle',
    'slot_empty', 'slot_hover', 'slot_selected', 'slot_locked', 'slot_warn', 'slot_hotbar', 'slot_hotbar_selected',
    'button_normal_idle', 'button_normal_hover', 'button_normal_pressed', 'button_normal_disabled',
    'button_primary_idle', 'button_primary_hover', 'button_primary_pressed',
    'button_danger_idle', 'button_danger_hover', 'button_danger_pressed',
    'bar_frame', 'bar_fill_hp', 'bar_fill_stamina', 'bar_fill_hunger', 'bar_fill_thirst', 'bar_fill_infection', 'bar_fill_xp', 'bar_fill_temp', 'bar_fill_fuel',
    'chip_frame', 'chip_frame_warn', 'clock', 'minimap_frame', 'keycap', 'checkbox_off', 'checkbox_on', 'toggle_off', 'toggle_on',
    'scrollbar_track', 'scrollbar_thumb', 'flow_arrow_empty', 'flow_arrow_full'];

  // ---- what is switched off. Each of these is built, and waits for the game to have the thing it shows: nothing
  // here draws a made-up number. Turn one on here once its data exists (what each one reads is said beside it), or
  // for a look, in the address: ...index.html?offline&ui=minimap,clock (ui=all = every one).
  var FLAGS = {
    minimap: false,      // top right: the land around you (works today, from the map on screen; off until wanted)
    clock: false,        // top right: day, hour, the day-night track.            Needs me.clock = {day, frac 0-1}
    nightfall: false,    // top left: "nightfall in 2h 10m".                      Needs me.clock.nightIn (game minutes)
    noise: true,         // top centre: how much noise you make (stealth, docs/STEALTH.md; main.js noiseMeter). Hidden with Config stealth off
    stamina: false,      // the bar under health.                                 Needs me.stamina / me.maxStamina
    temperature: false,  // a vital chip.                                         Needs me.temp 0-100
    condition: false,    // the weapon card's condition bar.                      Needs me.cond[itemId] 0-1
    load: false,         // the weight bar under the backpack.                    Needs me.load / me.maxLoad
    lockedRow: false,    // a row of locked cells under the backpack.             Needs bag upgrades
    queue: false         // the craft / cook queue cells.                         Needs a queue in the rules
  };
  (function () {
    var m = /[?&]ui=([^&]*)/.exec(typeof location !== 'undefined' ? location.search : '');
    if (!m) return;
    m[1].split(',').forEach(function (k) { if (k === 'all') Object.keys(FLAGS).forEach(function (f) { FLAGS[f] = true; }); else if (k in FLAGS) FLAGS[k] = true; });
  })();

  var COLOR = { ink: '#0e0d11', bone: '#e7ddc2', grey: '#837d7f', ghost: '#423f46', yellow: '#c49b2a', red: '#c1352d', green: '#a2a683', blue: '#86a3b8', paperGreen: '#3c4633', paperRed: '#8e1c22' };
  // a vital chip's liquid: [dark, the line on top]
  var CHIP = { thirst: ['#333f58', '#536884'], hunger: ['#5b3923', '#88582f'], infection: ['#586546', '#7c8862'], temp: ['#333f58', '#536884'], fuel: ['#5b3923', '#c1752d'] };

  var root = document.documentElement;
  function url(piece, set) { return new URL(KIT + (set || SET[piece] || 'plain') + '/' + piece + '.png', location.href).href; }
  function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }

  function setPieces() {
    PIECES.forEach(function (p) { root.style.setProperty('--k-' + p, 'url("' + url(p) + '")'); });
    // The Nano Banana notebook page has its tape drawn in (PIECES.md, 6): its top edge cannot be repeated along a wide
    // page as it is. So the page is made from it once (paperSheet): a clean top edge between the corners, and
    // the two ends with their tape laid over the corners (.kpaper::before / ::after in the stylesheet).
    root.classList.toggle('paper-taped', SET.panel_paper === 'nb');
    if (SET.panel_paper !== 'nb') return;
    var img = new Image();
    img.onload = function () {
      try {
        root.style.setProperty('--k-panel_paper', 'url("' + paperSheet(img).toDataURL() + '")');
        root.style.setProperty('--k-paper_ends', 'url("' + img.src + '")');
      } catch (e) { /* the picture as it is */ }
    };
    img.src = url('panel_paper');
  }

  // The page itself. The piece is 64x50, and its middle laid side by side shows the same stains over and over on a big
  // page. So a big sheet is made from it once (same edges, same corners, same colours): the middle is ruled paper drawn
  // here, with its dirt scattered unevenly, some parts grubby and some nearly clean, and never the same patch twice on a
  // page. Always the same sheet (the dice are seeded). Its middle is bigger than any page, so it never repeats.
  function paperSheet(img) {
    var L = 3, R = 3, TOP = 14, BOT = 3, MW = 256, MH = 384, EH = 32;      // EH: the piece's side edges repeat every 32 rows (4 ruled lines)
    var iw = img.width, ih = img.height, W = L + MW + R, H = TOP + MH + BOT;
    var cv = el('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d'), x, y, n;
    g.drawImage(img, 0, 0, L, TOP, 0, 0, L, TOP); g.drawImage(img, iw - R, 0, R, TOP, W - R, 0, R, TOP);                     // the four corners
    g.drawImage(img, 0, ih - BOT, L, BOT, 0, H - BOT, L, BOT); g.drawImage(img, iw - R, ih - BOT, R, BOT, W - R, H - BOT, R, BOT);
    var CLEAN = 25, CW = 16;                                   // a stretch of the top edge with no tape on it: 16 px from x = 25
    for (x = L; x < W - R; x += CW) { n = Math.min(CW, W - R - x); g.drawImage(img, CLEAN, 0, n, TOP, x, 0, n, TOP); }
    for (x = L; x < W - R; x += iw - L - R) { n = Math.min(iw - L - R, W - R - x); g.drawImage(img, L, ih - BOT, n, BOT, x, H - BOT, n, BOT); }
    for (y = TOP; y < H - BOT; y += EH) { n = Math.min(EH, H - BOT - y); g.drawImage(img, 0, TOP, L, n, 0, y, L, n); g.drawImage(img, iw - R, TOP, R, n, W - R, y, R, n); }
    // the middle, one art pixel at a time: 0 paper, 1 the ruled lines' tan (old stains are the same colour), 2 orange, 3 green, 4 brown
    var COL = [[216, 207, 194], [200, 177, 157], [214, 170, 131], [162, 166, 131], [163, 139, 122]], px = new Uint8Array(MW * MH);
    var seed = 20261126;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
    function put(X, Y, c) { px[((Y % MH + MH) % MH) * MW + ((X % MW + MW) % MW)] = c; }
    function at(X, Y) { return px[((Y % MH + MH) % MH) * MW + ((X % MW + MW) % MW)]; }
    for (y = 0; y < MH; y++) if (y % 8 === 7 || y % 8 === 0) for (x = 0; x < MW; x++) px[y * MW + x] = 1;      // ruled: 2 px every 8, in step with the piece's own
    for (y = 7; y < MH; y += 8) {                              // the lines are hand-ruled: thin stretches, and the pen's orange here and there
      for (x = ri(0, 30); x < MW; x += ri(14, 60)) { n = ri(2, 7); var row = y + ri(0, 1); for (var i = 0; i < n; i++) put(x + i, row, 0); }
      for (x = ri(0, 20); x < MW; x += ri(8, 42)) { n = ri(2, 8); var row2 = y + ri(0, 1); for (var j = 0; j < n; j++) put(x + j, row2, 2); }
    }
    // stains: smears that grow sideways more than up and down, most of them gathered round a few grubby places
    var spots = []; for (n = 0; n < 16; n++) spots.push([ri(0, MW - 1), ri(0, MH - 1), ri(12, 44)]);
    function place() {
      if (rnd() < 0.35) return [ri(0, MW - 1), ri(0, MH - 1)];
      var sp = spots[ri(0, spots.length - 1)], a = rnd() * 6.283, d = (rnd() + rnd()) / 2 * sp[2];
      return [Math.round(sp[0] + Math.cos(a) * d * 1.4), Math.round(sp[1] + Math.sin(a) * d)];
    }
    for (n = 0; n < 300; n++) {
      var p0 = place(), cells = [p0], size = rnd() < 0.25 ? ri(30, 90) : ri(5, 20);
      put(p0[0], p0[1], 1);
      for (var k = 1; k < size; k++) {
        var from = cells[ri(0, cells.length - 1)], side = rnd() < 0.68, q = [from[0] + (side ? (rnd() < 0.5 ? -1 : 1) : 0), from[1] + (side ? 0 : (rnd() < 0.5 ? -1 : 1))];
        put(q[0], q[1], 1); cells.push(q);
      }
      if (rnd() < 0.5) for (k = ri(1, 5); k > 0; k--) { var o = cells[ri(0, cells.length - 1)]; put(o[0], o[1], 2); }   // some carry a rusty fleck
      if (rnd() < 0.22) { var gr = cells[ri(0, cells.length - 1)]; put(gr[0], gr[1], rnd() < 0.5 ? 3 : 4); }             // a few, mould or dirt
    }
    for (n = 0; n < 600; n++) { var sp1 = rnd() < 0.5 ? place() : [ri(0, MW - 1), ri(0, MH - 1)]; put(sp1[0], sp1[1], rnd() < 0.75 ? 1 : 2); }   // specks
    for (n = 0; n < 14; n++) {                                 // a few short scratches, like the one on the piece
      var s0 = place(), len = ri(3, 6), dir = rnd() < 0.5 ? -1 : 1;
      for (k = 0; k < len; k++) put(s0[0] + k * dir, s0[1] - k, k === 0 || k === len - 1 ? 3 : 4);
    }
    var id = g.createImageData(MW, MH), d = id.data;
    for (n = 0; n < MW * MH; n++) { var c = COL[px[n]]; d[n * 4] = c[0]; d[n * 4 + 1] = c[1]; d[n * 4 + 2] = c[2]; d[n * 4 + 3] = 255; }
    g.putImageData(id, L, TOP);
    return cv;
  }

  // ---- the size of an art pixel: a whole number of screen pixels, from the room the view has (PIECES.md, 1)
  var scale = 2, viewAr = 1.6923;
  // Counted in the screen's REAL pixels (devicePixelRatio: Windows display scaling and browser zoom both shrink the
  // page's own pixel count), so an art pixel is always a whole number of real pixels. The player may pick the size
  // themselves (pick(), the UI size menu in the strip; kept in this browser): 0 = automatic.
  var DEFAULT_SIZE = 2;                                       // what a browser that never picked gets (the owner's choice; 0 = automatic)
  var chosen = DEFAULT_SIZE;
  try { var kept = localStorage.getItem('sheetsrpg.uiScale'); if (kept !== null) chosen = Number(kept) || 0; } catch (e) { /* private mode */ }
  function auto() {
    var dpr = window.devicePixelRatio || 1, u = 1;
    for (var t = 8; t >= 1; t--) {
      var w = Math.min(innerWidth, (innerHeight - Math.max(24, 18 * t / dpr)) * viewAr) * dpr, h = w / viewAr;
      if (Math.min(w / 720, h / 360) + 0.01 >= t) { u = t; break; }
    }
    return u;
  }
  function fit() {
    var dpr = window.devicePixelRatio || 1, ud = chosen > 0 ? chosen : auto();   // real pixels per art pixel
    scale = ud / dpr;                                                             // …in the page's own pixels
    root.style.setProperty('--u', scale);
    root.style.setProperty('--ico', ((ud >= 2 ? 32 * Math.floor(ud / 2) : 16) / dpr) + 'px');   // a 32 px item picture: 1 : 1 at scale 2, never a fraction
  }
  /** The UI size: 0 = automatic, else real pixels per art pixel. */
  function pick(n) {
    chosen = Math.max(0, Math.round(Number(n) || 0));
    try { localStorage.setItem('sheetsrpg.uiScale', chosen ? String(chosen) : ''); } catch (e) { /* private mode */ }
    fit();
  }
  function sizes() { return { chosen: chosen, auto: auto() }; }
  function setAspect(ar) { viewAr = ar || viewAr; fit(); sizeMenu(); }
  addEventListener('resize', fit);

  // ---- icons: 9 x 9, drawn in bone. Another colour = that one colour replaced (done once per colour).
  var iconCache = {};
  function iconUrl(name, color, done) {
    var key = name + '|' + (color || '');
    if (iconCache[key] && iconCache[key].url) { done(iconCache[key].url); return; }
    if (iconCache[key]) { iconCache[key].wait.push(done); return; }
    var rec = iconCache[key] = { url: '', wait: [done] }, img = new Image();
    img.onload = function () {
      var out = img.src;
      if (color && color !== COLOR.bone) {
        try {
          var cv = el('canvas'); cv.width = img.width; cv.height = img.height;
          var g = cv.getContext('2d'); g.drawImage(img, 0, 0);
          var d = g.getImageData(0, 0, cv.width, cv.height), c = [1, 3, 5].map(function (i) { return parseInt(color.slice(i, i + 2), 16); });
          for (var i = 0; i < d.data.length; i += 4) if (d.data[i + 3]) { d.data[i] = c[0]; d.data[i + 1] = c[1]; d.data[i + 2] = c[2]; }
          g.putImageData(d, 0, 0); out = cv.toDataURL();
        } catch (e) { /* bone it stays */ }
      }
      rec.url = out; rec.wait.forEach(function (f) { f(out); }); rec.wait = [];
    };
    img.src = url('icon_' + name);
  }
  /** A 9 x 9 icon as an element. color = '#rrggbb' (bone when not said); cls adds classes ('sh' = a shadow, for over the world). */
  function icon(name, color, cls) {
    var i = el('i', 'ki' + (cls ? ' ' + cls : ''));
    iconUrl(name, color, function (u) { i.style.backgroundImage = 'url("' + u + '")'; });
    return i;
  }

  // ---- bars: the trough, the fill cut off at the value, and (tail) the pale part just lost, which follows a moment later
  function bar(kind, opts) {
    opts = opts || {};
    var b = el('div', 'kbar' + (opts.cls ? ' ' + opts.cls : ''));
    if (opts.tail) { b._tail = el('div', 'tail'); b.appendChild(b._tail); }
    b._fill = el('div', 'fill'); b._fill.style.backgroundImage = 'var(--k-bar_fill_' + kind + ')';
    b.appendChild(b._fill);
    if (opts.text) { b._text = el('span', 'txt'); b.appendChild(b._text); }
    setBar(b, opts.value == null ? 0 : opts.value);
    return b;
  }
  function setBar(b, frac, text) {
    var cut = 'inset(0 ' + (100 - 100 * Math.max(0, Math.min(1, frac || 0))).toFixed(1) + '% 0 0)';
    b._fill.style.clipPath = cut;
    if (b._tail) b._tail.style.clipPath = cut;
    if (b._text && text != null) b._text.textContent = text;
  }

  // ---- vital chips: a square that fills from the bottom, its icon over it, a red rim when it is critical
  function chip(kind, iconName) {
    var c = el('div', 'kchip'), col = CHIP[kind] || CHIP.thirst;
    c._lv = el('div', 'lv'); c._lv.style.background = col[0]; c._lv.style.borderTopColor = col[1];
    c.appendChild(c._lv); c.appendChild(icon(iconName, '', 'sh'));
    return c;
  }
  function setChip(c, frac, warn, title) {
    c._lv.style.height = (14 * Math.max(0, Math.min(1, frac || 0))).toFixed(2) + 'rem';
    c._lv.style.borderTopWidth = frac > 0.04 ? '' : '0';
    c.classList.toggle('warn', !!warn);
    if (title != null) c.setAttribute('data-tip', title);              // (the kit's tooltip reads data-tip)
  }

  /** A key cap: [E], [SHIFT]. */
  function key(label) { return el('kbd', 'kkey', label); }
  /** Key hints along the bottom of a window: [[key, what it does], ...]. */
  function hints(list) {
    var row = el('div', 'whints');
    list.forEach(function (h) { var one = el('span', 'whint'); one.appendChild(key(h[0])); one.appendChild(el('span', '', h[1])); row.appendChild(one); });
    return row;
  }
  /** A column's title bar: the hazard-striped plate, the title, and something on the right (a count). */
  function head(title, right, bad) {
    var h = el('div', 'khead'); h.appendChild(el('b', '', title));
    if (right != null && right !== '') h.appendChild(el('span', bad ? 'bad' : '', right));
    return h;
  }
  /** A tick box with its label. */
  function check(label, on, fn) {
    var c = el('button', 'kcheck' + (on ? ' on' : ''), label);
    c.type = 'button'; c.onclick = function () { fn(!on); };
    return c;
  }
  /** - n + : pick a number from 1 to `most`. get() = the number now; onwheel on the element moves it too. */
  function stepper(n, most, onChange) {
    var box = el('div', 'kstep'), dn = el('button', '', ''), num = el('span', 'k kinset', ''), up = el('button', '', '');
    dn.type = up.type = 'button'; dn.appendChild(icon('minus')); up.appendChild(icon('plus'));
    dn.title = 'One less'; up.title = 'One more';
    function set(v, quiet) {
      n = Math.max(1, Math.min(most || 1, v)); num.textContent = n;
      dn.disabled = most < 1 || n <= 1; up.disabled = most < 1 || n >= most;
      if (onChange && !quiet) onChange(n);
    }
    dn.onclick = function () { set(n - 1); }; up.onclick = function () { set(n + 1); };
    box.onwheel = function (e) { if (most < 1) return; e.preventDefault(); set(n + (e.deltaY < 0 ? 1 : -1)); };
    box.appendChild(dn); box.appendChild(num); box.appendChild(up);
    box.get = function () { return n; };
    box.set = function (v) { set(v); };
    /** A Max button for this picker: sets it to the most there is room for (most). */
    box.maxButton = function () {
      var b = el('button', '', 'Max'); b.type = 'button'; b.title = 'As many as your materials allow'; b.disabled = most < 1;
      b.onclick = function () { set(most); };
      return b;
    };
    set(n, true);
    return box;
  }

  // ---- toasts: what you just picked up, stacked on the left, newest at the bottom; each fades after a few seconds
  // add = {key, n}: a count of something. A card with the same key still on screen (fading or not) takes the count
  // ("+2" then "+1" = "+3"), shows fully again, starts its time again and moves to the bottom (newest); else a new
  // card says "+n text".
  function toast(text, pic, add) {
    var box = document.getElementById('toasts'); if (!box) return;
    var t = add ? Array.prototype.filter.call(box.children, function (x) { return x._key === add.key; })[0] : null;
    if (t) { t._n += add.n; clearTimeout(t._fade); clearTimeout(t._gone); t.classList.remove('old'); }
    else {
      t = el('div', 'k kplate toast');
      if (pic) { pic.classList.add('pic'); t.appendChild(pic); }
      t._span = el('span', '', ''); t.appendChild(t._span);
      if (add) { t._key = add.key; t._n = add.n; }
    }
    t._span.textContent = add ? '+' + t._n + ' ' + text : text;
    box.appendChild(t);                                       // (an existing card moves to the bottom)
    while (box.children.length > 5) box.removeChild(box.firstChild);
    t._fade = setTimeout(function () { t.classList.add('old'); }, 2600);
    t._gone = setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3400);
  }

  // ---- the tooltip: anything in the view with a `title` shows it on the kit's card, by the cursor, in place of the
  // browser's own. "Name — the rest" or "Name: the rest" puts the name on a line of its own. An element with a
  // `_tipMore` function gets what it returns added to its card after MORE_MS of hovering (the gear comparison).
  var MORE_MS = 1000;
  function tooltips(frame, tip) {
    var cur = null, later = null, lastE = null;
    function hide() { tip.hidden = true; cur = null; clearTimeout(later); later = null; }
    function place(e) {
      var r = frame.getBoundingClientRect(), x = e.clientX - r.left + 8 * scale, y = e.clientY - r.top + 8 * scale;
      if (x + tip.offsetWidth > r.width) x = Math.max(0, e.clientX - r.left - tip.offsetWidth - 4 * scale);
      if (y + tip.offsetHeight > r.height) y = Math.max(0, e.clientY - r.top - tip.offsetHeight - 4 * scale);
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    }
    frame.addEventListener('mouseover', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[title], [data-tip]') : null;
      if (t && t.tagName === 'CANVAS' && t.id === 'view') t = null;      // (the game view words its own)
      if (t && t.getAttribute('title')) { t.setAttribute('data-tip', t.getAttribute('title')); t.removeAttribute('title'); }
      var text = t && t.getAttribute('data-tip');
      if (!text) { hide(); return; }
      if (t !== cur || tip._text !== text) {
        cur = t; tip._text = text; tip.innerHTML = '';
        var m = /^([^\n]{1,40}?)(?: — |: |\n)([\s\S]+)$/.exec(text);
        if (m) { tip.appendChild(el('b', '', m[1])); tip.appendChild(el('span', '', m[2])); } else tip.appendChild(el('span', '', text));
        clearTimeout(later); later = null;
        if (typeof t._tipMore === 'function') later = setTimeout(function () {
          later = null;
          if (cur !== t || tip.hidden || !t.isConnected) return;
          var more = t._tipMore(); if (!more) return;
          tip.appendChild(more); if (lastE) place(lastE);
        }, MORE_MS);
      }
      tip.hidden = false; lastE = e; place(e);
    });
    frame.addEventListener('mousemove', function (e) { lastE = e; if (cur) { if (!cur.isConnected) hide(); else place(e); } });
    frame.addEventListener('mouseleave', hide);
    frame.addEventListener('mousedown', hide);
    frame.addEventListener('dragstart', hide);
  }

  // ---- the clock (off: FLAGS.clock). day = the day's number, frac = how far through it (0 = midnight), text = "14:20"
  function setClock(box, day, frac, text) {
    if (!box._made) {
      box._made = true; box.innerHTML = '';
      box._ico = el('i', 'ki'); box._day = el('b', '', ''); box._time = el('span', '', ''); box._now = el('i', 'now');
      [box._ico, box._day, box._time, el('i', 'track'), box._now].forEach(function (x) { box.appendChild(x); });
    }
    var night = frac < 0.2 || frac >= 0.75;
    iconUrl(night ? 'moon' : 'sun', night ? COLOR.blue : COLOR.yellow, function (u) { box._ico.style.backgroundImage = 'url("' + u + '")'; });
    box._day.textContent = 'Day ' + day; box._time.textContent = text || '';
    box._now.style.left = 'calc(4rem + (100% - 8rem) * ' + Math.max(0, Math.min(1, frac)).toFixed(4) + ')';
  }

  // ---- the minimap (off: FLAGS.minimap): one art pixel per tile, you in the middle. o = {w, h, cx, cy (your tile),
  // colorAt(x, y) → '#rrggbb' or '' (off the map), dots: [{x, y, color}], marks: [{x, y}] (quest targets), facing}.
  function drawMinimap(cv, o) {
    var g = cv.getContext('2d'), W = cv.width, H = cv.height, x0 = Math.round(o.cx) - (W >> 1), y0 = Math.round(o.cy) - (H >> 1);
    g.fillStyle = '#141318'; g.fillRect(0, 0, W, H);
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) { var c = o.colorAt(x0 + x, y0 + y); if (c) { g.fillStyle = c; g.fillRect(x, y, 1, 1); } }
    (o.dots || []).forEach(function (d) { g.fillStyle = d.color; g.fillRect(Math.round(d.x) - x0, Math.round(d.y) - y0, 2, 2); });
    (o.marks || []).forEach(function (d) {
      var mx = Math.max(2, Math.min(W - 3, Math.round(d.x) - x0)), my = Math.max(2, Math.min(H - 3, Math.round(d.y) - y0));
      g.fillStyle = COLOR.ink; g.fillRect(mx - 2, my - 1, 5, 3); g.fillRect(mx - 1, my - 2, 3, 5);
      g.fillStyle = COLOR.yellow; g.fillRect(mx - 1, my, 3, 1); g.fillRect(mx, my - 1, 1, 3);
    });
    // you: a small arrow the way you face, outlined
    var px = W >> 1, py = H >> 1, A = { N: [[0, -2], [-1, -1], [0, -1], [1, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0]], S: [[0, 2], [-1, 1], [0, 1], [1, 1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0]],
      E: [[2, 0], [1, -1], [1, 0], [1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2]], W: [[-2, 0], [-1, -1], [-1, 0], [-1, 1], [0, -2], [0, -1], [0, 0], [0, 1], [0, 2]] }[o.facing] || [];
    g.fillStyle = COLOR.ink; A.forEach(function (p) { g.fillRect(px + p[0] - 1, py + p[1] - 1, 3, 3); });
    g.fillStyle = COLOR.bone; A.forEach(function (p) { g.fillRect(px + p[0], py + p[1], 1, 1); });
  }

  /** The UI size menu in the strip (#ui-size): Auto (and what that is now), then each whole size. */
  function sizeMenu() {
    var sel = document.getElementById('ui-size'); if (!sel) return;
    var s = sizes(), opts = [['0', 'UI: auto (' + s.auto + 'x)']];
    for (var n = 1; n <= 6; n++) opts.push([String(n), 'UI: ' + n + 'x']);
    sel.innerHTML = '';
    opts.forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; sel.appendChild(op); });
    sel.value = String(s.chosen);
    sel.onchange = function () { pick(sel.value); sel.blur(); sizeMenu(); };
  }
  addEventListener('resize', sizeMenu);
  setPieces(); fit(); sizeMenu();
  return { FLAGS: FLAGS, SET: SET, COLOR: COLOR, el: el, url: url, icon: icon, iconUrl: iconUrl, bar: bar, setBar: setBar, chip: chip, setChip: setChip, key: key, hints: hints,
    head: head, check: check, stepper: stepper, toast: toast, tooltips: tooltips, setClock: setClock, drawMinimap: drawMinimap, setAspect: setAspect, fit: fit, pick: pick, sizes: sizes, scale: function () { return scale; } };
})();
