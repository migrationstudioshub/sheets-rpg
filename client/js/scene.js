/**
 * Scenes (cinematics) on the game page: plays one scene's steps (Content: c.scenes[id].steps, the kinds are
 * Content.SCENE_STEPS) over the view, for this player only. The referee only knows who is watching what
 * (World.sceneQueue / sceneEnd, publicPlayer.scene); everything seen here is drawn by the page.
 *
 *   Scene.start(scene, {at: {x, y}, done: fn(skipped)})   at = where the camera starts (the player as drawn)
 *   Scene.playing()            a scene is on: main.js locks the controls, hides the HUD and the live creatures
 *   Scene.update(now, me)      every frame; me = the player as drawn ({x, y}), for camera steps that look at "me"
 *   Scene.view(me)             the camera: {x, y, zoom, sx, sy} (tiles; sx/sy = shake in canvas pixels), or null
 *   Scene.puppets(now)         the actors it moves ({ref: {x, y, facing, alpha, on, moving, key}}; main.js draws them
 *                              in place of the real figures) and Scene.speaker() = the ref of who is saying a line
 *   Scene.emotes(now)          the emotes its `emote` steps put up (main.js draws them over the player, an NPC or a tile)
 *   Scene.key(code) / click()  the player: Space / Enter / a click moves a line or a picture on; Esc twice skips
 *
 * Steps run one after another; a step with `with` starts together with the one before. A group of steps is over
 * when every step in it is: a line or a picture with no time (s = 0) waits for a click, the rest take their time.
 * A classic script, like the others.
 */
var Scene = (function () {
  // cam.l = how high the camera is lifted (canvas pixels: raised ground is drawn higher up). A move blends it from where
  // it starts to where it ends, so the camera glides in a straight line, whatever hills lie between. liftOf(x, y) = the
  // ground's lift at a tile (Scene.start's `lift`, from main.js).
  var cur = null, root = null, els = {}, cam = { x: 0, y: 0, z: 1, l: 0 }, back = null, escAt = 0, liftOf = function () { return 0; }, host = null;
  var BARS_MS = 400, BACK_MS = 500, ESC_MS = 2000;

  function el(tag, cls, parent) { var d = document.createElement(tag); if (cls) d.className = cls; if (parent) parent.appendChild(d); return d; }
  function build() {
    if (root) return;
    var frame = document.getElementById('frame') || document.body;
    root = el('div', '', frame); root.id = 'scene'; root.hidden = true;
    els.fade = el('div', 'sc-fade', root);
    els.top = el('div', 'sc-bar sc-top', root); els.bot = el('div', 'sc-bar sc-bot', root);
    els.pic = el('div', 'sc-pic', root); els.img = el('img', '', els.pic); els.picText = el('div', 'sc-ptext', els.pic);
    els.img.alt = ''; els.img.onerror = function () { els.img.hidden = true; };
    els.line = el('div', 'sc-line', root); els.face = el('div', 'sc-face', els.line); els.words = el('div', 'sc-words', els.line);
    els.name = el('div', 'sc-name', els.words); els.text = el('div', 'sc-text', els.words);
    els.more = el('div', 'sc-more', root); els.more.textContent = '▸';
    els.skip = el('button', 'sc-skip', root); els.skip.type = 'button'; els.skip.textContent = 'Skip';
    els.hint = el('div', 'sc-hint', root); els.hint.textContent = 'Esc again to skip';
    els.skip.onclick = function (e) { e.stopPropagation(); skip(); };
    // (pointerdown is the click: blocking it also stops the browser's mousedown, so that one is never listened to)
    root.addEventListener('pointerdown', function (e) { if (e.target === els.skip) return; e.preventDefault(); e.stopPropagation(); if (e.button === 0) click(); });
    ['mousedown', 'mouseup', 'click', 'contextmenu', 'wheel'].forEach(function (t) { root.addEventListener(t, function (e) { if (e.target !== els.skip) { e.preventDefault(); e.stopPropagation(); } }, { passive: false }); });
  }

  function ease(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
  function secs(v) { return Math.max(0, Number(v) || 0) * 1000; }

  function start(sc, o) {
    build(); o = o || {};
    var at = o.at || { x: 0, y: 0 };
    liftOf = o.lift || function () { return 0; };
    host = { actor: o.actor || function () { return null; }, path: o.path || function () { return null; }, portrait: o.portrait || function () { return null; },
      nameOf: o.nameOf || function () { return ''; }, pace: o.pace > 0 ? o.pace : 5 };
    cur = { sc: sc, i: 0, run: [], done: o.done || function () {}, moves: null, emotes: {}, puppets: {}, speaker: '' };
    cam = { x: at.x, y: at.y, z: 1, l: liftOf(at.x, at.y) }; back = null; escAt = 0;
    root.hidden = false; root.className = '';
    els.fade.style.transition = 'none'; els.fade.style.opacity = '0';
    els.pic.hidden = true; els.line.hidden = true; els.more.hidden = true; els.hint.hidden = true;
    bars(true);
    document.body.classList.add('scene-on');
  }
  function playing() { return !!cur; }
  // ---- actors (puppets). A puppet is a figure the scene moves: {x, y (tiles, fractions on the way), facing E|W,
  // on (shown), a0/a1/at/as (a fade), key (the map NPC it stands in for)}. An NPC on the map (host.actor says where it
  // stands) and the player become one the first time a step names them; anyone else needs a Show step.
  function puppet(ref, make) {
    if (!ref || !cur) return null;
    var p = cur.puppets[ref];
    if (p) return p;
    var init = host.actor(ref);
    if (!init && !make) return null;
    p = cur.puppets[ref] = init ? { x: init.x, y: init.y, facing: init.facing || 'E', key: init.key || '', on: true, a0: 1, a1: 1, at: 0, as: 0 }
                                : { x: 0, y: 0, facing: 'E', key: '', on: false, a0: 1, a1: 1, at: 0, as: 0 };
    return p;
  }
  function alphaOf(p, now) { return !p.as || now >= p.at + p.as ? p.a1 : p.a0 + (p.a1 - p.a0) * Math.max(0, (now - p.at) / p.as); }
  function turnTo(p, x) { if (x > p.x + 0.05) p.facing = 'E'; else if (x < p.x - 0.05) p.facing = 'W'; }
  /** The actors as they stand now: {ref: {x, y, facing, alpha, on, moving, key}}. */
  function puppets(now) {
    var out = {}; if (!cur) return out;
    now = now === undefined ? performance.now() : now;
    Object.keys(cur.puppets).forEach(function (ref) {
      var p = cur.puppets[ref], al = alphaOf(p, now);
      out[ref] = { x: p.x, y: p.y, facing: p.facing, alpha: al, on: p.on && al > 0.01, moving: !!p.walk, key: p.key };
    });
    return out;
  }
  function speaker() { return cur ? cur.speaker : ''; }
  function bars(on) { els.top.classList.toggle('on', !!on); els.bot.classList.toggle('on', !!on); }

  /** Start the next group: the step at cur.i and every step after it marked `with`. */
  function nextGroup(now) {
    var steps = cur.sc.steps || [];
    if (cur.i >= steps.length) return finish(false);
    var g = [steps[cur.i++]];
    while (cur.i < steps.length && steps[cur.i]['with']) g.push(steps[cur.i++]);
    cur.run = g.map(function (s) { return begin(s, now); });
  }
  function begin(s, now) {
    var r = { s: s, t0: now, until: now, click: false };
    if (s.type === 'bars') {                                           // (already so, as at the start of a scene: no time spent)
      var was = els.top.classList.contains('on'); bars(s.on); r.until = was === !!s.on ? now : now + BARS_MS;
    }
    else if (s.type === 'fade') {
      var d = secs(s.s);
      els.fade.style.background = s.color || '#000';
      els.fade.style.transition = 'opacity ' + d + 'ms linear';
      void els.fade.offsetWidth;                                       // (so the new time applies to this change)
      els.fade.style.opacity = s.out ? '1' : '0';
      r.until = now + d;
    } else if (s.type === 'camera') {
      r.from = { x: cam.x, y: cam.y, z: cam.z, l: cam.l };
      r.to = s.to === 'me' ? null : { x: Number(s.x) || 0, y: Number(s.y) || 0 };
      if (r.to) r.to.l = liftOf(r.to.x, r.to.y);
      r.z = Number(s.zoom) > 0 ? Number(s.zoom) : 1;
      r.dur = secs(s.s);
      r.shake = Math.max(0, Number(s.shake) || 0);
      r.until = now + Math.max(r.dur, r.shake && !r.dur ? 500 : 0);
      cur.moves = r;
    } else if (s.type === 'picture') {
      els.pic.hidden = false; els.pic.style.background = s.bg || '#000';
      els.img.hidden = !s.image; if (s.image) els.img.src = typeof Assets !== 'undefined' ? Assets.resolve(s.image) : s.image;
      els.picText.textContent = s.text || ''; els.picText.hidden = !s.text;
      els.pic.classList.toggle('card', !s.image);
      r.click = !secs(s.s); r.until = r.click ? Infinity : now + secs(s.s);
    } else if (s.type === 'say') {
      var sp = s.a ? puppet(s.a) : null, who = s.name || (s.a ? host.nameOf(s.a) : '');
      els.line.hidden = false; els.line.classList.toggle('caption', !who);
      els.name.textContent = who; els.name.hidden = !who;
      els.face.innerHTML = ''; var pic = s.a ? host.portrait(s.a) : null;
      if (pic) els.face.appendChild(pic); els.line.classList.toggle('faced', !!pic);
      cur.speaker = sp && sp.on ? s.a : '';
      els.text.textContent = s.text || '';
      r.click = !secs(s.s); r.until = r.click ? Infinity : now + secs(s.s);
    } else if (s.type === 'wait') r.until = now + secs(s.s);
    else if (s.type === 'emote') {                                     // a sign over someone's head; the scene goes straight on
      // (ref = the actor it is over: me, npc:<id>, mon:<id>; a tile has none)
      var eref = s.over === 'npc' ? 'npc:' + (s.npc || '') : s.over === 'actor' ? (s.a || '') : s.over === 'tile' ? '' : 'me';
      var key = s.over === 'tile' ? 'tile:' + (Number(s.x) || 0) + ',' + (Number(s.y) || 0) : eref;
      if (!s.emote || s.emote === 'none') delete cur.emotes[key];
      else cur.emotes[key] = { id: s.emote, over: s.over || 'me', ref: eref, npc: s.npc || '', x: Number(s.x) || 0, y: Number(s.y) || 0, t0: now, until: secs(s.s) ? now + secs(s.s) : Infinity };
    } else if (s.type === 'show') {                                    // an actor appears on a tile
      var ps = puppet(s.a, true); if (!ps) return r;
      ps.x = Number(s.x) || 0; ps.y = Number(s.y) || 0; ps.facing = s.dir === 'W' ? 'W' : 'E'; ps.on = true; ps.walk = null;
      ps.a0 = secs(s.s) ? 0 : 1; ps.a1 = 1; ps.at = now; ps.as = secs(s.s);
      r.until = now + secs(s.s);
    } else if (s.type === 'leave') {                                   // and goes
      var pl = puppet(s.a); if (!pl) return r;
      pl.a0 = alphaOf(pl, now); pl.a1 = 0; pl.at = now; pl.as = secs(s.s); pl.walk = null;
      if (!pl.as) pl.on = false;
      r.until = now + secs(s.s);
    } else if (s.type === 'face') {
      var pf = puppet(s.a); if (!pf) return r;
      if (s.dir === 'E' || s.dir === 'W') pf.facing = s.dir;
      else { var tgt = s.dir === 'actor' ? puppet(s.to) : puppet('me'); if (tgt) turnTo(pf, tgt.x); }
    } else if (s.type === 'walk') {                                    // it walks to a tile: round what is in the way, or straight
      var pw = puppet(s.a); if (!pw || !pw.on) return r;
      var to = { x: Number(s.x) || 0, y: Number(s.y) || 0 }, from = { x: Math.round(pw.x), y: Math.round(pw.y) };
      var pts = s.straight ? null : host.path(from, to);
      pw.walk = { pts: pts && pts.length ? pts : [to], i: 0, v: host.pace * (Number(s.speed) > 0 ? Number(s.speed) : 1), last: now };
      r.walker = pw; r.walk = pw.walk;
      r.until = s.wait === false ? now : Infinity;                     // (until it arrives: update() says when)
    }
    return r;
  }
  function endStep(r) {
    if (r.s.type === 'picture') els.pic.hidden = true;
    if (r.s.type === 'say') { els.line.hidden = true; cur.speaker = ''; }
    if (r.s.type === 'leave') { var p = cur.puppets[r.s.a]; if (p && p.a1 === 0) p.on = false; }
  }
  /** Every walking actor a little further along its way (tiles per second, tile by tile). */
  function stepWalkers(now) {
    Object.keys(cur.puppets).forEach(function (ref) {
      var p = cur.puppets[ref], w = p.walk; if (!w) return;
      var left = w.v * Math.min(100, now - w.last) / 1000; w.last = now;
      while (left > 0 && w.i < w.pts.length) {
        var t = w.pts[w.i], dx = t.x - p.x, dy = t.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
        turnTo(p, t.x);
        if (d <= left) { p.x = t.x; p.y = t.y; left -= d; w.i++; }
        else { p.x += dx / d * left; p.y += dy / d * left; left = 0; }
      }
      if (w.i >= w.pts.length) p.walk = null;
    });
  }

  function update(now, me) {
    if (!cur) return;
    // Steps that take no time (a camera cut, an emote, bars that are already there) are all done within this frame, so
    // nothing is ever drawn half-way through them: a scene that opens with a cut never shows where the player stands.
    var waiting = false;
    for (var guard = 0; guard < 60; guard++) {
      if (!cur.run.length) { nextGroup(now); if (!cur) return; }
      stepWalkers(now);
      waiting = false;
      cur.run = cur.run.filter(function (r) {
        if (r.walk && r.until === Infinity && r.walker.walk !== r.walk) r.until = 0;   // it has arrived (or was sent elsewhere)
        if (now < r.until) { if (r.click) waiting = true; return true; }
        endStep(r); return false;
      });
      camNow(now, me);                                                 // (before the next group: a move starts from where the last one ended)
      if (cur.run.length) break;
    }
    els.more.hidden = !waiting;
  }
  function camNow(now, me) {
    if (cur.puppets.me) me = cur.puppets.me;                           // (the scene moved your figure: "the player" is where it is drawn)
    var m = cur.moves;
    if (m) {                                                           // the camera glides (towards the player, for "me")
      var to = m.to || { x: me.x, y: me.y, l: liftOf(me.x, me.y) }, k = m.dur ? ease((now - m.t0) / m.dur) : 1;
      cam.x = m.from.x + (to.x - m.from.x) * k; cam.y = m.from.y + (to.y - m.from.y) * k; cam.z = m.from.z + (m.z - m.from.z) * k;
      cam.l = m.from.l + (to.l - m.from.l) * k;                          // (the height too: start to end, never the ground in between)
    } else { cam.x = me.x; cam.y = me.y; cam.l = liftOf(me.x, me.y); }   // no camera step yet: it stays on the player (wherever a scene walks them)
                                                                       // (the last camera step keeps holding: on its tile, or on the player)
  }
  function view(me) {
    var now = performance.now();
    if (cur) {
      var m = cur.moves, sx = 0, sy = 0;
      if (m && m.shake && now < m.until) { var a = m.shake * 1.5; sx = (Math.random() * 2 - 1) * a; sy = (Math.random() * 2 - 1) * a; }
      return { x: cam.x, y: cam.y, zoom: cam.z, sx: sx, sy: sy, lift: cam.l };
    }
    if (back) {                                                        // after a scene the camera comes back to the player
      var k = ease((now - back.t0) / BACK_MS);
      if (k >= 1) { back = null; return null; }
      return { x: back.x + (me.x - back.x) * k, y: back.y + (me.y - back.y) * k, zoom: back.z + (1 - back.z) * k, sx: 0, sy: 0, lift: back.l + (liftOf(me.x, me.y) - back.l) * k };
    }
    return null;
  }

  /** The emotes this scene has put up and that still show: [{id, over: me|npc|tile, npc, x, y, t (ms up), left (ms, or Infinity)}]. */
  function emotes(now) {
    if (!cur) return [];
    now = now === undefined ? performance.now() : now;
    return Object.keys(cur.emotes).map(function (k) { var e = cur.emotes[k]; return { id: e.id, over: e.over, ref: e.ref, npc: e.npc, x: e.x, y: e.y, t: now - e.t0, left: e.until - now }; })
      .filter(function (e) { return e.left > 0; });
  }

  function click() {
    if (!cur) return;
    cur.run.forEach(function (r) { if (r.click && r.until === Infinity) r.until = 0; });   // (the next frame moves on)
  }
  function key(code) {
    if (!cur) return;
    if (code === 'Escape') {
      var now = performance.now();
      if (now - escAt < ESC_MS) return skip();
      escAt = now; els.hint.hidden = false;
      setTimeout(function () { if (performance.now() - escAt >= ESC_MS - 50) els.hint.hidden = true; }, ESC_MS);
    } else if (code === 'Space' || code === 'Enter' || code === 'KeyF' || code === 'NumpadEnter') click();
  }
  function skip() { if (cur) finish(true); }
  function finish(skipped) {
    var done = cur.done;
    cur = null;
    back = { x: cam.x, y: cam.y, z: cam.z, l: cam.l, t0: performance.now() };
    bars(false); els.pic.hidden = true; els.line.hidden = true; els.more.hidden = true; els.hint.hidden = true;
    els.fade.style.transition = 'opacity ' + BACK_MS + 'ms linear'; els.fade.style.opacity = '0';
    root.className = 'leaving';
    setTimeout(function () { if (!cur) { root.hidden = true; root.className = ''; } }, BARS_MS);
    document.body.classList.remove('scene-on');
    done(!!skipped);
  }

  return { start: start, playing: playing, update: update, view: view, emotes: emotes, puppets: puppets, speaker: speaker, key: key, click: click, skip: skip };
})();
if (typeof module !== 'undefined') module.exports = Scene;
