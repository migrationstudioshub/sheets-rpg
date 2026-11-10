/**
 * Game loop: input -> predicted move (instant) -> server check (queued, batched) -> draw.
 * The server (or offline mode) answers every call with {player, world, events, seq}.
 */
(function () {
  var canvas = document.getElementById('view');
  var $ = function (id) { return document.getElementById(id); };
  var api = Api.create(), content, renderer;
  var me = null;                         // this player (position predicted locally)
  var view = { states: {}, monsters: [], players: [] };
  var since = -1;                        // last event number seen
  var shown = { x: 0, y: 0 };            // drawn position, eases toward me.x/y
  var shownOthers = {};                  // drawn positions of monsters and other players
  var queue = [], inFlight = false, lastReply = 0;
  var held = [], tap = null, holdSince = 0, lastStep = 0, lastFrame = 0, HOLD_MS = 220;
  var fx = [], bagOpen = false;
  var armed = null;                      // {slot, id, skill} while an ability (Q/E) waits for a target
  var throwing = null;                   // belt item id armed for a throw (click to throw, Esc to cancel)
  var hover = null, lastCam = { x: 0, y: 0 };
  var clockOffset = 0;                   // server clock minus ours, for timed traps
  var timed = [];                        // timed traps on this map, drawn from the clock
  var liveUnwatch = null;                // stops the Firebase live-world listener (online, when enabled)

  var KEYS = { ArrowUp: 'N', KeyW: 'N', ArrowRight: 'E', KeyD: 'E', ArrowDown: 'S', KeyS: 'S', ArrowLeft: 'W', KeyA: 'W' };

  // Paper-doll stacking order (low = drawn first / behind). The base body sits near the
  // bottom; worn gear draws over it, weapon last. Unknown slots land on top.
  var SLOT_Z = { back: 0, body: 1, legs: 2, armor: 3, head: 4, helm: 5, offhand: 6, weapon: 7 };
  function maskOf(path) { return path ? path.replace(/\.png$/i, '.tint.png') : ''; }   // sibling grey tint mask
  /** Ordered layer descriptors for a player, lowest slot first: the class base body, the hair
   *  (head slot, hidden when anything is worn in `helm`), then each equipped item with a worn
   *  sprite. A descriptor is { path, mask?, ramp? } — a tintable garment or hair carries its grey
   *  mask and a 4-colour ramp from Tint.TINTS. Returns null when the class has no body art (the
   *  renderer then falls back to the drawn hero). */
  function playerLayers(p) {
    var cls = p && content.classes[p['class']];
    if (!cls || !cls.bodySprite) return null;
    var eq = p.equipment || {}, out = [{ z: SLOT_Z.body, path: cls.bodySprite }];
    if (p.hair && !eq.helm) {                                            // hair is whole-tintable; a helm hides it
      out.push({ z: SLOT_Z.head, path: p.hair, mask: maskOf(p.hair), ramp: Tint.TINTS[p.hairColor] });
    }
    Object.keys(eq).forEach(function (slot) {
      var it = content.items[eq[slot]];
      if (!it || !it.wornSprite) return;
      var ramp = it.defaultTint ? Tint.TINTS[it.defaultTint] : null;     // item is tintable iff it names a default tint
      out.push({ z: SLOT_Z[slot] != null ? SLOT_Z[slot] : 9, path: it.wornSprite,
        mask: ramp ? maskOf(it.wornSprite) : '', ramp: ramp });
    });
    out.sort(function (a, b) { return a.z - b.z; });
    out.forEach(function (l) {                                           // make sure late-arriving layers load
      if (!Assets.get(l.path)) Assets.load(l.path);
      if (l.mask && !Assets.get(l.mask)) Assets.load(l.mask);
    });
    return out;
  }

  function setNet(text, bad) { $('hud-net').textContent = text; $('hud-net').className = bad ? 'bad' : ''; }
  function mapOf() { return content.maps[me.map]; }

  // ---------------------------------------------------------------- server replies
  function apply(res) {
    lastReply = performance.now();
    if (res.world && res.world.now) clockOffset = res.world.now - Date.now();
    if (typeof res.seq === 'number') since = res.seq;
    var p = res.player;
    var moving = queue.some(function (a) { return a.type === 'move'; });
    if (!me || p.map !== me.map) {
      me = p; view = res.world; handleEvents(res.events);
      return enterMap();
    }
    // keep our predicted position while moves are still on their way; otherwise trust the server
    me = moving ? Object.assign({}, p, { x: me.x, y: me.y, facing: me.facing }) : p;
    view = res.world;
    handleEvents(res.events);
    hud();
    if (bagOpen) bag();
    return Promise.resolve();
  }

  /**
   * A live world update pushed from Firebase (online, when FIREBASE_URL is set): refresh the moving
   * things — monsters and other players — between polls, so they glide in near-real-time. Your own
   * player, object states and events still come from the poll/act replies (authoritative, per-player).
   */
  function mergeLiveWorld(w) {
    if (!me || !w || w.map !== me.map) return;                 // ignore a push for a map we've already left
    if (w.monsters) view.monsters = w.monsters;
    if (w.players) view.players = w.players.filter(function (q) { return q.id !== me.id; });
    if (w.now) clockOffset = w.now - Date.now();
  }
  function watchLive() {
    if (liveUnwatch) { liveUnwatch(); liveUnwatch = null; }
    if (api.watchMap && me) liveUnwatch = api.watchMap(me.map, mergeLiveWorld);
  }

  var COLORS = { hit: '#ff6b5b', heal: '#6fe08a', loot: '#ffd65a', level: '#ffd65a', kill: '#ffffff', death: '#ff6b5b' };
  function handleEvents(events) {
    var now = performance.now();
    (events || []).forEach(function (e, i) {
      if (e.text) log(e.text, e.type);
      if (e.map && e.map !== me.map) return;
      var t0 = now + i * 120;
      if (e.type === 'cast') {
        if (e.by === me.id && performance.now() - lastOwnCast < 6000) return;   // already shown when you cast it
        var sk = content.skills[e.skill] || { color: e.color || '#fff', area: 0, projectile: !!e.projectile };
        var area = sk.target === 'around' ? Math.max(1, sk.area) : sk.area;
        var at = sk.target === 'around' || sk.target === 'self' ? e.from : e.to;
        if (sk.projectile) fx.push({ kind: 'proj', from: e.from, to: e.to, color: sk.color, t0: t0, life: 260 });
        fx.push({ kind: 'flash', x: at.x, y: at.y, r: area, color: sk.color, t0: t0 + (sk.projectile ? 240 : 0), life: 450 });
        return;
      }
      if (e.type === 'shoot') {                                  // a bullet tracer (ours was drawn on click)
        if (e.by !== me.id) fx.push({ kind: 'tracer', from: e.from, to: e.to, color: e.color || '#ffd36b', t0: t0, life: 160 });
        return;
      }
      if (e.type === 'throw') {                                  // a thrown grenade/molotov arc + blast
        if (e.by !== me.id) {
          fx.push({ kind: 'proj', from: e.from, to: e.to, color: e.color || '#ff8c3b', t0: t0, life: 300 });
          fx.push({ kind: 'flash', x: e.to.x, y: e.to.y, r: e.area || 0, color: e.color || '#ff8c3b', t0: t0 + 280, life: 450 });
        }
        return;
      }
      if (e.type === 'mana' && e.amount) { fx.push({ x: e.x, y: e.y, text: '+' + e.amount + ' MP', color: '#8fb6ff', t0: t0 }); return; }
      if (e.type === 'hit' && e.amount) fx.push({ x: e.x, y: e.y, text: '-' + e.amount, color: e.to === me.id && e.x === me.x && e.y === me.y ? '#ff6b5b' : '#ffffff', t0: t0 });
      else if (e.type === 'heal' && e.amount) fx.push({ x: e.x, y: e.y, text: '+' + e.amount, color: COLORS.heal, t0: t0 });
      else if (e.type === 'loot') fx.push({ x: me.x, y: me.y, text: e.text, color: COLORS.loot, t0: t0, life: 1300 });
      else if (e.type === 'level') fx.push({ x: me.x, y: me.y, text: 'LEVEL UP!', color: COLORS.level, t0: t0, life: 1800, big: true });
    });
  }
  function log(text, type) {
    var box = $('log'), line = document.createElement('div');
    line.textContent = text; line.className = 'msg ' + (type || '');
    box.appendChild(line);
    while (box.children.length > 6) box.removeChild(box.firstChild);
    setTimeout(function () { line.classList.add('old'); }, 8000);
  }

  // ---------------------------------------------------------------- actions
  function send(action) {
    var last = queue[queue.length - 1];
    if (action.type === 'move' && last && last.type === 'move' && !last.sent) last.dirs = last.dirs.concat(action.dirs);
    else queue.push(action);
    flush();
  }
  function flush() {
    if (inFlight || !queue.length) return;
    var a = queue[0]; a.sent = true;
    inFlight = true;
    var payload = Object.assign({}, a); delete payload.sent;
    api.act(payload, since).then(function (res) {
      queue.shift(); inFlight = false;
      return apply(res);
    }).then(function () {
      if (api.mode !== 'offline') setNet('connected');
      flush();
    }).catch(function (e) {
      inFlight = false; a.sent = false;
      setNet('connection problem: ' + e.message + ' (retrying)', true);
      setTimeout(flush, 2000);
    });
  }
  function poll() {
    if (inFlight || queue.length || !me) return;
    inFlight = true;
    api.poll(since).then(function (res) { inFlight = false; return apply(res); })
      .catch(function (e) { inFlight = false; setNet('connection problem: ' + e.message, true); });
  }

  function step(dir) {
    var r = Rules.tryMove(content, mapOf(), me.x, me.y, dir, World.viewOpts(content, mapOf(), view, me.id));
    if (!r.ok && r.who && r.who.monster) { var d = Rules.DIRS[dir]; attackFx(me.x + d.dx, me.y + d.dy); }   // bumped a monster: the server turns this move into an attack
    me = Object.assign({}, me, { facing: dir }, r.ok ? { x: r.x, y: r.y } : {});
    send({ type: 'move', dirs: [dir] });
  }
  function interact() { if (me) send({ type: 'interact' }); }
  function useItem(id) { send({ type: 'use', item: id }); }

  // ---------------------------------------------------------------- input
  function press(d) { held = held.filter(function (h) { return h !== d; }).concat(d); tap = d; holdSince = performance.now(); }
  addEventListener('keydown', function (e) {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
    var d = KEYS[e.code];
    if (d) { e.preventDefault(); if (!e.repeat) press(d); return; }
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF') { e.preventDefault(); interact(); }
    else if (e.code === 'KeyI' || e.code === 'KeyB') toggleBag();
    else if (e.code === 'Escape') { closeMenu(); if (armed) disarm(); else if (throwing) cancelThrow(); else if (bagOpen) toggleBag(); }
    else if (e.code === 'KeyQ') ability(0);
    else if (e.code === 'KeyE') ability(1);
    else if (e.code === 'KeyR') { if (World.rangedWeapon(content, me)) send({ type: 'reload' }); }
    else if (/^Digit[1-5]$/.test(e.code) && me) beltKey(Number(e.code.slice(5)) - 1);
  });
  addEventListener('keyup', function (e) {
    var d = KEYS[e.code]; if (d) held = held.filter(function (h) { return h !== d; });
  });
  addEventListener('blur', function () { held = []; });
  function cellAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    var px = (e.clientX - r.left) * canvas.width / r.width + lastCam.x, py = (e.clientY - r.top) * canvas.height / r.height + lastCam.y;
    return { x: Math.floor(px / T), y: Math.floor(py / T) };
  }
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointermove', function (e) { if (content) { hover = cellAt(e); hoverLabel(e); } });
  canvas.addEventListener('pointerleave', function () { hover = null; $('tip').hidden = true; });
  canvas.addEventListener('pointerdown', function (e) {
    if (!me) return;
    var cell = cellAt(e);
    if (e.button === 2) {                                 // right-click: cancel aiming, or open the action menu
      if (armed) { disarm(); return; }
      if (throwing) { cancelThrow(); return; }
      closeMenu();
      var acts = World.actionsAt(content, mapOf(), lookup(), me, cell.x, cell.y);
      if (acts.length) openMenu(e, cell, acts);
      return;
    }
    if (e.button !== 0) return;
    closeMenu();
    hover = cell;
    if (armed) { castAt(cell); return; }                  // left-click: aim + fire/throw/cast only — never walk or act
    if (throwing) { throwAt(cell); return; }
    if (World.rangedWeapon(content, me)) { shootAt(cell); return; }
    log('No ranged weapon equipped — press F to use or attack what you face (right-click for options).', 'info');
  });

  // ---------------------------------------------------------------- mouse: a click acts; it never walks you there
  function lookup() { return World.viewLookup(content, mapOf(), view, me); }
  var TOO_FAR = 'Too far away. Move there with the movement keys.';
  function near(x, y) { return Math.abs(me.x - x) + Math.abs(me.y - y) <= 1; }
  function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function count(id) { var s = me.inventory.filter(function (x) { return x.item === id; })[0]; return s ? s.qty : 0; }
  function facingToward(x, y) {
    var dx = x - me.x, dy = y - me.y;
    if (!dx && !dy) return me.facing;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
  }
  /** A click acts on the cell if it is in range; otherwise it tells you to walk there. Shooting is handled separately. */
  function doAction(a, cell) {
    if (a.type === 'shoot') return shootAt(cell);
    if (a.type === 'attack') {
      if (!near(cell.x, cell.y)) { log(TOO_FAR, 'info'); return; }
      me.facing = facingToward(cell.x, cell.y);
      send({ type: 'attack', x: cell.x, y: cell.y }); attackFx(cell.x, cell.y);
      return;
    }
    if (a.type === 'interact') {
      if (!near(cell.x, cell.y)) { log(TOO_FAR, 'info'); return; }
      send({ type: 'interact', x: cell.x, y: cell.y, verb: a.verb });
    }
  }
  /** Fire the equipped ranged weapon at a cell (an enemy, or anywhere). */
  function shootAt(cell) {
    var map = mapOf(), reach = World.shotReach(content, map, me, cell.x, cell.y, lookup());
    if (!reach.ok) { log(reach.reason, 'info'); return; }
    var w = reach.weapon, cost = w.ammoCost || 1, ammoName = content.items[w.ammo] ? content.items[w.ammo].name.toLowerCase() : w.ammo;
    if (Number(w.clip) > 0) {                                   // fire from the loaded magazine, not the reserve
      if (((me.mags && me.mags[w.id]) || 0) < cost) { log(count(w.ammo) >= cost ? 'Out of ammo — press R to reload.' : 'Out of ' + ammoName + '.', 'info'); return; }
    } else if (w.ammo && count(w.ammo) < cost) { log('Out of ' + ammoName + '.', 'info'); return; }
    me.facing = facingToward(cell.x, cell.y);
    send({ type: 'shoot', x: cell.x, y: cell.y });
    var end = reach.cells[reach.cells.length - 1] || me;
    fx.push({ kind: 'tracer', from: { x: me.x, y: me.y }, to: { x: end.x, y: end.y }, color: w.tint || '#ffd36b', t0: performance.now(), life: 160 });
  }
  /** Throw the armed belt item (grenade/molotov) at a cell within its range. */
  function throwAt(cell) {
    var it = content.items[throwing]; if (!it) { cancelThrow(); return; }
    if (count(throwing) < 1) { log('Out of ' + it.name.toLowerCase() + '.', 'info'); cancelThrow(); return; }
    if (cheb(me.x, me.y, cell.x, cell.y) > (it.throwRange || 4)) { log(TOO_FAR, 'info'); return; }
    me.facing = facingToward(cell.x, cell.y);
    send({ type: 'throw', item: throwing, x: cell.x, y: cell.y });
    var t0 = performance.now();
    fx.push({ kind: 'proj', from: { x: me.x, y: me.y }, to: { x: cell.x, y: cell.y }, color: it.tint || '#ff8c3b', t0: t0, life: 300 });
    fx.push({ kind: 'flash', x: cell.x, y: cell.y, r: it.throwArea || 0, color: it.tint || '#ff8c3b', t0: t0 + 280, life: 450 });
    cancelThrow();
  }
  function cancelThrow() { if (throwing) { throwing = null; updateCursor(); hotbar(); } }
  function updateCursor() {
    canvas.style.cursor = (armed || throwing || (me && World.rangedWeapon(content, me))) ? 'crosshair' : '';
  }

  function openMenu(e, cell, acts) {
    var menu = $('menu'), r = $('frame').getBoundingClientRect();
    menu.innerHTML = '';
    acts.forEach(function (a, i) {
      var b = document.createElement('button');
      b.textContent = a.label; if (i === 0) b.className = 'def';
      b.onclick = function (ev) { ev.stopPropagation(); closeMenu(); doAction(a, cell); };
      menu.appendChild(b);
    });
    menu.hidden = false;
    var x = e.clientX - r.left + 4, y = e.clientY - r.top + 4;          // keep it inside the game area
    if (x + menu.offsetWidth > r.width) x = Math.max(0, x - menu.offsetWidth - 8);
    if (y + menu.offsetHeight > r.height) y = Math.max(0, y - menu.offsetHeight - 8);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
  }
  function closeMenu() { $('menu').hidden = true; }
  addEventListener('pointerdown', function (e) { if (!$('menu').contains(e.target) && e.target !== canvas) closeMenu(); });

  /** Aiming a weapon → crosshair, no tip. Otherwise show what right-click (or F) would do here. */
  function hoverLabel(e) {
    var tip = $('tip');
    if (!me || armed || throwing || World.rangedWeapon(content, me)) { tip.hidden = true; updateCursor(); return; }
    if (!hover) { tip.hidden = true; canvas.style.cursor = ''; return; }
    var acts = World.actionsAt(content, mapOf(), lookup(), me, hover.x, hover.y), a = acts[0];
    canvas.style.cursor = a ? 'pointer' : 'default';
    if (!a) { tip.hidden = true; return; }
    var r = $('frame').getBoundingClientRect();
    tip.textContent = a.label + ' — right-click, or F if you face it';
    tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 14) + 'px';
    tip.hidden = false;
  }

  // ---------------------------------------------------------------- abilities (Q/E) and the belt (1-5)
  function serverNow() { return Date.now() + clockOffset; }
  function readyIn(id) { return Math.max(0, ((me.cooldowns || {})[id] || 0) - serverNow()); }
  /** Q/E: arm an ability, or fire it now if it needs no aim (or is already armed). */
  function ability(i) {
    if (!me) return;
    var id = (me.abilities || [])[i], sk = id && content.skills[id];
    if (!sk) { log('No ability on ' + (i === 0 ? 'Q' : 'E') + ' yet — set one from the bag (I).', 'info'); return; }
    if (readyIn(sk.id) > 0) { log(sk.name + ' is not ready yet.', 'info'); return; }
    if (me.mp < sk.mp) { log('Not enough energy for ' + sk.name + '.', 'info'); return; }
    cancelThrow();
    if (sk.target === 'self' || sk.target === 'around') { disarm(); send({ type: 'cast', skill: sk.id, x: me.x, y: me.y }); castFx(sk.id, me, me); return; }
    if (armed && armed.id === sk.id) { if (hover) castAt(hover); return; }    // second press: cast at the cursor
    armed = { slot: i, id: sk.id, skill: sk.id }; updateCursor(); hotbar();
  }
  /** 1-5: a throwable arms throw-aim; anything else (food/bandage/medkit) is used at once. */
  function beltKey(i) {
    if (!me) return;
    var id = (me.belt || [])[i];
    if (!id) { log('Belt slot ' + (i + 1) + ' is empty — set an item from the bag (I).', 'info'); return; }
    var it = content.items[id]; if (!it) return;
    if (count(id) < 1) { log('No ' + it.name.toLowerCase() + ' left.', 'info'); return; }
    if (it.type === 'throwable') {
      disarm();
      throwing = throwing === id ? null : id;                                 // toggle throw-aim
      if (throwing) log('Aim the ' + it.name.toLowerCase() + ' and click to throw (Esc to cancel).', 'info');
      updateCursor(); hotbar();
    } else useItem(id);
  }
  function aimCheck(cell) {
    var sk = content.skills[armed.skill], map = mapOf(), lk = World.viewLookup(content, map, view, me);
    var t = World.snapTarget(sk, cell.x, cell.y, lk, me);
    var r = World.checkTarget(content, map, me, sk, t.x, t.y, lk);
    r.x = t.x; r.y = t.y;
    return r;
  }
  function castAt(cell) {
    if (!armed || !cell) return;
    var chk = aimCheck(cell);
    if (!chk.ok) { log(chk.reason, 'info'); return; }
    send({ type: 'cast', skill: armed.skill, x: chk.x, y: chk.y });
    castFx(armed.skill, { x: me.x, y: me.y }, { x: chk.x, y: chk.y });
    disarm();
  }
  function disarm() { armed = null; updateCursor(); hotbar(); }
  /** Your own melee attacks land their swing instantly; the server's damage number follows when it answers. */
  var lastAttackFx = 0;
  function attackFx(tx, ty) {
    var now = performance.now();
    if (now - lastAttackFx < (content.config.attack_ms || 500) * 0.9) return;   // don't out-flash the real attack rate
    lastAttackFx = now;
    var dx = tx - me.x, dy = ty - me.y;
    if (dx || dy) me.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');   // matches the server's faceTo
    fx.push({ kind: 'flash', x: tx, y: ty, r: 0, color: '#ffd9a0', t0: now, life: 260 });
  }
  /** Your own spells animate the moment you cast them; the server's numbers follow when it answers. */
  var lastOwnCast = 0;
  function castFx(id, from, to) {
    var sk = content.skills[id]; if (!sk) return;
    var t0 = performance.now(), area = sk.target === 'around' ? Math.max(1, sk.area) : sk.area;
    var at = sk.target === 'around' || sk.target === 'self' ? from : to;
    lastOwnCast = t0;
    if (sk.projectile) fx.push({ kind: 'proj', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, color: sk.color, t0: t0, life: 260 });
    fx.push({ kind: 'flash', x: at.x, y: at.y, r: area, color: sk.color, t0: t0 + (sk.projectile ? 240 : 0), life: 450 });
  }

  /** Cells to light up while aiming an ability: in range and in sight. */
  function aimOverlay() {
    var sk = content.skills[armed.skill], map = mapOf(), lk = World.viewLookup(content, map, view, me), cells = [];
    var reach = Object.assign({}, sk, { target: 'tile', dash: false });
    for (var y = me.y - sk.range; y <= me.y + sk.range; y++) for (var x = me.x - sk.range; x <= me.x + sk.range; x++) {
      if (World.checkTarget(content, map, me, reach, x, y, lk).ok) cells.push({ x: x, y: y });
    }
    var hc = hover && aimCheck(hover), h = hc && { x: hc.x, y: hc.y, ok: hc.ok };
    return { cells: cells, hover: h, area: sk.area, from: me, color: sk.color };
  }
  /** Cells within a square range of the player (the throw/shoot reach ring). */
  function ringCells(range) {
    var map = mapOf(), cells = [];
    for (var y = me.y - range; y <= me.y + range; y++) for (var x = me.x - range; x <= me.x + range; x++) {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      if (cheb(me.x, me.y, x, y) <= range) cells.push({ x: x, y: y });
    }
    return cells;
  }
  /** Throw-aim overlay: reach ring + the blast area under the cursor. */
  function throwOverlay() {
    var it = content.items[throwing], rng = it.throwRange || 4;
    var h = hover ? { x: hover.x, y: hover.y, ok: cheb(me.x, me.y, hover.x, hover.y) <= rng } : null;
    return { cells: ringCells(rng), hover: h, area: it.throwArea || 0, from: me, color: it.tint || '#ff8c3b' };
  }
  function icon(entry) {
    var el = document.createElement('div'); el.className = 'ico';
    if (entry.kind === 'skill') {
      var sk = content.skills[entry.id] || { name: entry.id, color: '#888' };
      el.style.background = sk.color; el.textContent = sk.name.split(' ').map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      var img = sk.icon && Assets.get(sk.icon);
      if (img) { el.textContent = ''; el.style.background = 'url(' + img.src + ') center/cover'; }
    } else if (entry.kind === 'item') {
      var it = content.items[entry.id] || { name: entry.id }, im = it.sprite && Assets.get(it.sprite);
      el.style.background = im ? 'url(' + im.src + ') center/contain no-repeat' : '#555';
      if (!im) el.textContent = it.name.slice(0, 2);
    }
    return el;
  }
  function hotbar() {
    if (!me) return;
    var ab = $('abilities'); ab.innerHTML = '';
    ['Q', 'E'].forEach(function (lab, i) {
      var id = (me.abilities || [])[i], sk = id && content.skills[id], b = document.createElement('div');
      b.className = 'hk' + (armed && armed.slot === i && armed.id === id ? ' armed' : '') + (sk ? '' : ' empty');
      b.title = sk ? describeSkill(sk) : 'Empty: assign an ability from the bag (I)';
      var key = document.createElement('span'); key.className = 'key'; key.textContent = lab; b.appendChild(key);
      if (sk) {
        b.appendChild(icon({ kind: 'skill', id: id }));
        var cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = sk.mp || ''; b.appendChild(cost);
        var cd = document.createElement('div'); cd.className = 'cd'; b.appendChild(cd);
        var cdt = document.createElement('div'); cdt.className = 'cdt'; b.appendChild(cdt);
        b._cd = cd; b._cdt = cdt; b._skill = sk;
      }
      b.onclick = function () { ability(i); };
      ab.appendChild(b);
    });
    var belt = $('belt'); belt.innerHTML = '';
    for (var i = 0; i < 5; i++) (function (i) {
      var id = (me.belt || [])[i], it = id && content.items[id], b = document.createElement('div');
      b.className = 'hk' + (throwing && throwing === id ? ' armed' : '') + (it ? '' : ' empty');
      b.title = it ? it.name + (it.type === 'throwable' ? ' (throw)' : ' (use)') : 'Empty: assign an item from the bag (I)';
      var key = document.createElement('span'); key.className = 'key'; key.textContent = i + 1; b.appendChild(key);
      if (it) {
        b.appendChild(icon({ kind: 'item', id: id }));
        var q = document.createElement('span'); q.className = 'qty';
        var st = me.inventory.filter(function (s) { return s.item === id; })[0];
        q.textContent = st ? '×' + st.qty : '0'; b.appendChild(q);
        if (!st) b.classList.add('low');
      }
      b.onclick = function () { beltKey(i); };
      belt.appendChild(b);
    })(i);
    tickHotbar();
  }
  /** Cooldown shading and "not enough energy" on the ability bar, every frame. */
  function tickHotbar() {
    Array.prototype.forEach.call($('abilities').children, function (b) {
      var sk = b._skill; if (!sk) return;
      var left = readyIn(sk.id), frac = sk.cooldownMs ? Math.min(1, left / sk.cooldownMs) : 0;
      b._cd.style.height = (frac * 100) + '%';
      b._cdt.textContent = left > 0 ? (left / 1000).toFixed(left < 1000 ? 1 : 0) : '';
      b.classList.toggle('low', me.mp < sk.mp);
    });
  }
  function describeSkill(sk) {
    if (!sk) return '';
    var t = { enemy: 'an enemy', ally: 'an ally or yourself', self: 'yourself', tile: 'a spot', around: 'all around you' }[sk.target] || sk.target;
    return sk.name + ': ' + sk.description + '\n' + sk.mp + ' MP · ' + (sk.cooldownMs / 1000) + ' s cooldown · targets ' + t +
      (sk.range ? ' · range ' + sk.range : '') + (sk.area ? ' · area ' + sk.area : '') + (sk.los ? ' · needs a clear line' : '');
  }
  addEventListener('pointerup', function () { held = []; });
  $('btn-use').onclick = interact;
  $('btn-bag').onclick = toggleBag;

  // ---------------------------------------------------------------- HUD and bag
  function hud() {
    if (!me) return;
    $('hud-map').textContent = mapOf().name;
    $('hp-fill').style.width = Math.max(0, 100 * me.hp / me.maxHp) + '%';
    $('hp-text').textContent = 'HP ' + Math.max(0, me.hp) + ' / ' + me.maxHp;
    var span = me.xpNext ? me.xpNext - me.xpThis : 0;
    $('xp-fill').style.width = span ? Math.min(100, 100 * (me.xp - me.xpThis) / span) + '%' : '100%';
    $('xp-text').textContent = 'Lv ' + me.level + (me.xpNext ? ' · ' + me.xp + ' / ' + me.xpNext + ' XP' : ' · max');
    $('gold').textContent = me.gold + ' gold';
    $('mp-fill').style.width = me.maxMp ? Math.max(0, 100 * me.mp / me.maxMp) + '%' : '0%';
    $('mp-text').textContent = 'MP ' + me.mp + ' / ' + me.maxMp;
    var food = me.hunger == null ? 100 : me.hunger, water = me.thirst == null ? 100 : me.thirst;
    $('food-fill').style.width = Math.max(0, Math.min(100, food)) + '%';
    $('food-text').textContent = 'Food ' + Math.round(food) + '%';
    $('food-bar').classList.toggle('low', food <= 25);
    $('water-fill').style.width = Math.max(0, Math.min(100, water)) + '%';
    $('water-text').textContent = 'Water ' + Math.round(water) + '%';
    $('water-bar').classList.toggle('low', water <= 25);
    var rw = World.rangedWeapon(content, me), wset = $('weapon-set');          // equipped gun: magazine + reserve
    if (rw) {
      var reserve = (me.inventory.filter(function (s) { return s.item === rw.ammo; })[0] || {}).qty || 0;
      var clip = Number(rw.clip) || 0, loaded = (me.mags && me.mags[rw.id]) || 0;
      var wl = $('weapon'); wl.innerHTML = '';
      wl.appendChild(icon({ kind: 'item', id: me.equipment.weapon }));
      var nm = document.createElement('span'); nm.className = 'wname'; nm.textContent = rw.name; wl.appendChild(nm);
      if (clip > 0) {
        var mag = document.createElement('span'); mag.className = 'wammo' + (loaded < (rw.ammoCost || 1) ? ' low' : ''); mag.textContent = loaded + '/' + clip; wl.appendChild(mag);
        var rv = document.createElement('span'); rv.className = 'wreserve'; rv.textContent = reserve; wl.appendChild(rv);
        if (loaded < (rw.ammoCost || 1)) { var rl = document.createElement('span'); rl.className = 'wreload'; rl.textContent = 'R'; wl.appendChild(rl); }
      } else {
        var am = document.createElement('span'); am.className = 'wammo' + (reserve < (rw.ammoCost || 1) ? ' low' : ''); am.textContent = '×' + reserve; wl.appendChild(am);
      }
      wset.hidden = false;
    } else wset.hidden = true;
    var sts = $('statuses'); sts.innerHTML = '';
    (me.statuses || []).forEach(function (st) {
      var d = content.statuses[st.id] || { name: st.id, color: '#888' }, el = document.createElement('span');
      el.className = 'st'; el.style.color = d.color;
      var perm = d.kind === 'infection' || st.until > serverNow() + 1e10;   // infection has no timer — it just worsens
      el.textContent = d.name + (perm ? '' : ' ' + Math.max(0, Math.ceil((st.until - serverNow()) / 1000)) + 's');
      sts.appendChild(el);
    });
    hotbar();
    updateCursor();                 // keep the canvas cursor (crosshair when a gun is ready) in step with gear changes
  }
  function toggleBag() { bagOpen = !bagOpen; $('bag').hidden = !bagOpen; if (bagOpen) bag(); }
  function bag() {
    var box = $('bag-items'); box.innerHTML = '';
    $('bag-stats').textContent = (content.classes[me['class']] ? content.classes[me['class']].name + ' · ' : '') +
      'Attack ' + me.atk + ' · Defence ' + me.def + ' · ' + me.gold + ' gold';
    // bar 'ability' = the two Q/E skill slots; bar 'belt' = the five 1-5 item slots
    function slots(id, bar) {
      var arr = bar === 'ability' ? (me.abilities || []) : (me.belt || []), labels = bar === 'ability' ? ['Q', 'E'] : ['1', '2', '3', '4', '5'];
      var wrap = document.createElement('div'); wrap.className = 'slots';
      labels.forEach(function (lab, i) {
        var b = document.createElement('button'); b.textContent = lab;
        b.title = 'Put in slot ' + lab;
        if (arr[i] === id) b.className = 'on';
        b.onclick = function () { send({ type: 'loadout', bar: bar, slot: i, entry: arr[i] === id ? '' : id }); };
        wrap.appendChild(b);
      });
      return wrap;
    }
    var h1 = document.createElement('h4'); h1.textContent = 'Abilities (Q / E)'; box.appendChild(h1);
    (me.skills || []).forEach(function (id) {
      var sk = content.skills[id]; if (!sk) return;
      var row = document.createElement('div'); row.className = 'sk';
      row.appendChild(icon({ kind: 'skill', id: id }));
      var info = document.createElement('div'); info.className = 'name';
      info.innerHTML = '<b></b><span></span>';
      info.firstChild.textContent = sk.name; info.lastChild.textContent = describeSkill(sk).split('\n')[1];
      info.appendChild(slots(id, 'ability'));
      row.title = describeSkill(sk);
      row.appendChild(info); box.appendChild(row);
    });
    var cls = content.classes[me['class']];
    var next = cls && cls.skills.filter(function (s) { return s.level > me.level; })[0];
    if (next && content.skills[next.skill]) { var nx = document.createElement('div'); nx.className = 'empty'; nx.textContent = 'Next: ' + content.skills[next.skill].name + ' at level ' + next.level; box.appendChild(nx); }
    var h2 = document.createElement('h4'); h2.textContent = 'Items'; box.appendChild(h2);
    if (!me.inventory.length) box.insertAdjacentHTML('beforeend', '<div class="empty">Your bag is empty.</div>');
    me.inventory.forEach(function (s, i) {
      var it = content.items[s.item] || { name: s.item, type: '' };
      var equipped = it.slot && me.equipment[it.slot] === s.item;
      var row = document.createElement('div'); row.className = 'slot' + (equipped ? ' equipped' : '');
      var img = Assets.get(it.sprite);
      var pic = img ? img.cloneNode() : Assets.placeholder(it.name, '#555', 32);
      pic.className = 'pic';
      var name = document.createElement('div'); name.className = 'name';
      name.innerHTML = '<b></b><span></span>';
      name.firstChild.textContent = it.name + (s.qty > 1 ? ' ×' + s.qty : '');
      name.lastChild.textContent = describe(it) + (equipped ? ' · equipped' : '');
      row.appendChild(pic); row.appendChild(name);
      if (it.type === 'consumable' || it.type === 'throwable') name.appendChild(slots(s.item, 'belt'));
      if (it.type === 'consumable' || it.slot) {
        var b = document.createElement('button');
        b.textContent = it.slot ? (equipped ? 'Unequip' : 'Equip') : 'Use';
        b.onclick = function () { useItem(s.item); };
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }
  function describe(it) {
    var bits = [];
    if (it.heal) bits.push('+' + it.heal + ' HP');
    if (it.mp) bits.push('+' + it.mp + ' MP');
    if (it.atk) bits.push('+' + it.atk + ' attack');
    if (it.def) bits.push('+' + it.def + ' defence');
    if (!bits.length) bits.push(it.type || 'item');
    return bits.join(', ');
  }
  $('bag-close').onclick = toggleBag;

  // ---------------------------------------------------------------- map and loop
  function enterMap() {
    armed = null; throwing = null;
    watchLive();                          // (re)subscribe to live monster/player pushes for this map
    hud();
    setNet('loading art…');
    return Assets.loadForMap(content, mapOf()).then(function () {
      renderer.setMap(mapOf());
      timed = mapOf().entities.filter(function (e) {
        var o = content.objects[e.ref]; return o && o.kind === 'trap' && World.props(content, e).trigger === 'timed';
      });
      shown.x = me.x; shown.y = me.y; shownOthers = {};
      setNet(api.mode !== 'offline' ? 'connected' : api.usingDraft ? 'offline: playing your editor draft' : 'offline: progress saved in this browser');
      $('map-pick').value = me.map;
    });
  }

  function ease(cur, target, k) {
    if (Math.abs(target.x - cur.x) > 2 || Math.abs(target.y - cur.y) > 2) { cur.x = target.x; cur.y = target.y; return; }
    cur.x += Math.sign(target.x - cur.x) * Math.min(Math.abs(target.x - cur.x), k);
    cur.y += Math.sign(target.y - cur.y) * Math.min(Math.abs(target.y - cur.y), k);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!renderer || !renderer.map || !me) return;
    var moveMs = content.config.move_ms || 140;
    var dt = Math.min(100, lastFrame ? now - lastFrame : 16); lastFrame = now;
    var moving = Math.abs(shown.x - me.x) > 0.01 || Math.abs(shown.y - me.y) > 0.01;
    if (!moving && !bagOpen) {
      if (tap) { step(tap); tap = null; lastStep = now; }
      else if (held.length && now - holdSince >= HOLD_MS && now - lastStep >= moveMs) { step(held[held.length - 1]); lastStep = now; }
    }
    // When the live world is pushed over Firebase, polling is just a heartbeat (advance idle monsters,
    // refresh our own state) — not how we see others — so it can be slow, which keeps request and
    // download usage low. Without the push, polling is the only way to see others, so stay frequent.
    var livePush = api.mode === 'online' && GAME_CONFIG.FIREBASE_URL;
    var pollMs = api.mode !== 'online' ? 250
      : livePush ? (content.config.heartbeat_ms || 3000)
      : (content.config.poll_ms || 500);
    if (now - lastReply > pollMs) poll();

    ease(shown, me, dt / moveMs);
    var myst = me.statuses && me.statuses.length && content.statuses[me.statuses[0].id];
    var actors = [{ x: shown.x, y: shown.y, facing: me.facing, name: me.name, hp: me.hp, maxHp: me.maxHp, me: true, layers: playerLayers(me) || undefined, statusColor: myst ? myst.color : '' }];
    var seen = {};
    view.monsters.forEach(function (m) {
      var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, s = shownOthers[m.id] || (shownOthers[m.id] = { x: m.x, y: m.y });
      ease(s, m, dt / 250); seen[m.id] = 1;
      var stc = m.statuses && m.statuses.length && content.statuses[m.statuses[0]];
      actors.push({ x: s.x, y: s.y, facing: m.facing, name: d.name, sprite: d.sprite || '', hp: m.hp, maxHp: m.maxHp, statusColor: stc ? stc.color : '' });
    });
    view.players.forEach(function (q) {
      var s = shownOthers['p:' + q.id] || (shownOthers['p:' + q.id] = { x: q.x, y: q.y });
      ease(s, q, dt / moveMs); seen['p:' + q.id] = 1;
      actors.push({ x: s.x, y: s.y, facing: q.facing, name: q.name, tint: '#b6553d', layers: playerLayers(q) || undefined, hp: q.hp, maxHp: q.maxHp });
    });
    Object.keys(shownOthers).forEach(function (k) { if (!seen[k]) delete shownOthers[k]; });

    var T = content.config.tile_size || 32, map = renderer.map;
    var cam = {
      x: clamp((shown.x + 0.5) * T - canvas.width / 2, 0, map.width * T - canvas.width),
      y: clamp((shown.y + 0.5) * T - canvas.height / 2, 0, map.height * T - canvas.height)
    };
    if (map.width * T < canvas.width) cam.x = (map.width * T - canvas.width) / 2;
    if (map.height * T < canvas.height) cam.y = (map.height * T - canvas.height) / 2;
    var states = view.states;
    if (timed.length) {
      states = Object.assign({}, view.states);
      var clock = Date.now() + clockOffset;
      timed.forEach(function (e) { states[e.key] = World.liveState(content, e, clock, view.states); });
    }
    lastCam = cam;
    renderer.draw(cam, actors, { states: states, hidden: hiddenEntity });
    if (armed) renderer.drawAim(cam, aimOverlay());
    else if (throwing) renderer.drawAim(cam, throwOverlay());
    // a ready gun shows no on-canvas aim — the crosshair cursor is the aim (see updateCursor)
    renderer.drawFx(cam, fx, now);
    tickHotbar();
    $('hud-pos').textContent = '(' + me.x + ', ' + me.y + ')';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hiddenEntity(e) {
    var o = content.objects[e.ref]; if (!o) return false;
    if (o.kind === 'spawn' || o.kind === 'trigger') return true;     // markers for the editor only
    if (o.kind === 'trap') { var pr = World.props(content, e); return Content.bool(pr.hidden) && pr.trigger !== 'timed' && view.states[e.key] !== 'down'; }
    return false;
  }

  // ---------------------------------------------------------------- start
  function askName() {
    return new Promise(function (done) {
      var box = $('join'), input = $('join-name'), cls = $('join-class');
      cls.innerHTML = '';
      Object.keys(content.classes).forEach(function (id) {
        var k = content.classes[id], o = document.createElement('option');
        o.value = id; o.textContent = k.name + ' (HP ' + k.hp + ', attack ' + k.atk + ', defence ' + k.def + ')';
        if (id === content.config.start_class) o.selected = true;
        cls.appendChild(o);
      });
      cls.parentNode.hidden = !Object.keys(content.classes).length;
      box.hidden = false; input.focus();
      $('join-form').onsubmit = function (e) {
        e.preventDefault();
        var name = input.value.trim().slice(0, 16);
        if (!name) return;
        box.hidden = true; done({ name: name, cls: cls.value });
      };
    });
  }

  function setupDebug() {
    var sel = $('map-pick');
    if (api.mode !== 'offline') { sel.hidden = true; return; }
    Object.keys(content.maps).forEach(function (id) {
      var o = document.createElement('option'); o.value = id; o.textContent = content.maps[id].name; sel.appendChild(o);
    });
    sel.value = me.map;
    sel.onchange = function () { api.warp(sel.value).then(apply); sel.blur(); };
  }
  // In-page confirm (the in-app browser pane swallows native confirm() dialogs): click once to arm, again to reset.
  var resetArmed = 0;
  $('reset').onclick = function () {
    var b = $('reset'), now = Date.now();
    if (now - resetArmed < 4000) { me = null; api.forget(); location.reload(); return; }   // me=null stops the loop/poll from re-saving
    resetArmed = now; b.textContent = 'Click again to reset'; b.classList.add('arm');
    setTimeout(function () { if (Date.now() - resetArmed >= 4000) { b.textContent = 'New character'; b.classList.remove('arm'); } }, 4000);
  };

  $('hud-mode').textContent = api.mode;
  setNet('loading game data…');
  api.loadContent().then(function (c) {
    content = c;
    var T = c.config.tile_size || 32;
    canvas.width = (c.config.view_w || 15) * T;
    canvas.height = (c.config.view_h || 11) * T;
    canvas.style.width = canvas.width * GAME_CONFIG.SCALE + 'px';
    $('below').style.width = canvas.style.width;
    renderer = new Render.Renderer(canvas, c);
    return api.resume();
  }).then(function (res) {
    if (res && res.player && content.maps[res.player.map]) return res;
    return askName().then(function (a) { return api.join(a.name, a.cls); });
  }).then(function (res) {
    // ?map=<id> (from the editor's Play-test button) starts on that map, offline only
    var want = new URLSearchParams(location.search).get('map');
    if (want && api.mode === 'offline' && content.maps[want] && want !== res.player.map) return api.warp(want);
    return res;
  }).then(apply).then(function () {
    setupDebug();
    log('WASD / arrows move · left-click aims + fires your gun (R to reload) · right-click for actions · F/Space to use or attack what you face · Q/E abilities · 1-5 belt · I bag.', 'info');
    if (api.staleDraft) log('Your map editor draft was made from older game data, so the game is using the latest data instead. Open the editor to update or discard the draft.', 'death');
    requestAnimationFrame(frame);
  }).catch(function (e) {
    setNet('could not start: ' + e.message, true);
    console.error(e);
  });

  addEventListener('pagehide', function () { api.leave(); });
  // read-only peek for tests and debugging in the browser console
  window.SheetsRPG = { state: function () { return { me: me, view: view, queue: queue.length }; },
    plan: function () { return null; },    // kept for back-compat: there is no click-to-walk plan any more
    layers: function () { return me ? playerLayers(me) : null; },
    camera: function () { return lastCam; },
    aim: function () { return { armed: armed, throwing: throwing, hover: hover, check: armed && hover ? aimCheck(hover) : null }; } };
})();
