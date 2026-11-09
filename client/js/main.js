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
  var armed = null;                      // {slot, skill} while a skill waits for a target
  var hover = null, lastCam = { x: 0, y: 0 };
  var plan = null;                       // a walk (and maybe an action) started by clicking: {path, goal, act, chase}
  var lastAttack = 0;
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
        var sk = content.skills[e.skill] || { color: '#fff', area: 0 };
        var area = sk.target === 'around' ? Math.max(1, sk.area) : sk.area;
        var at = sk.target === 'around' || sk.target === 'self' ? e.from : e.to;
        if (sk.projectile) fx.push({ kind: 'proj', from: e.from, to: e.to, color: sk.color, t0: t0, life: 260 });
        fx.push({ kind: 'flash', x: at.x, y: at.y, r: area, color: sk.color, t0: t0 + (sk.projectile ? 240 : 0), life: 450 });
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
  function press(d) { plan = null; held = held.filter(function (h) { return h !== d; }).concat(d); tap = d; holdSince = performance.now(); }
  addEventListener('keydown', function (e) {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
    var d = KEYS[e.code];
    if (d) { e.preventDefault(); if (!e.repeat) press(d); return; }
    if (e.repeat) return;
    if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); interact(); }
    else if (e.code === 'KeyI' || e.code === 'KeyB') toggleBag();
    else if (e.code === 'Escape') { closeMenu(); if (armed) disarm(); else if (plan) plan = null; else if (bagOpen) toggleBag(); }
    else if (/^Digit[1-5]$/.test(e.code) && me) hotkey(Number(e.code.slice(5)) - 1);
  });
  addEventListener('keyup', function (e) { var d = KEYS[e.code]; if (d) held = held.filter(function (h) { return h !== d; }); });
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
    closeMenu();
    var cell = cellAt(e);
    if (armed) {                                          // aiming: left click casts, right click cancels
      if (e.button === 2) disarm(); else { hover = cell; castAt(cell); }
      return;
    }
    var acts = World.actionsAt(content, mapOf(), lookup(), me, cell.x, cell.y);
    if (e.button === 2) { if (acts.length) openMenu(e, cell, acts); return; }
    if (e.button === 0 && acts.length) doAction(acts[0], cell);
  });

  // ---------------------------------------------------------------- mouse: actions, menu, walking there
  function lookup() { return World.viewLookup(content, mapOf(), view, me); }
  function doAction(a, cell) {
    if (a.type === 'walk') { plan = { goal: cell, exact: true }; return; }
    if (a.type === 'attack') {
      var m = view.monsters.filter(function (q) { return q.x === cell.x && q.y === cell.y; })[0];
      if (m) plan = { chase: m.id }; return;
    }
    plan = { goal: cell, act: { type: 'interact', x: cell.x, y: cell.y, verb: a.verb } };
  }
  function near(x, y) { return Math.abs(me.x - x) + Math.abs(me.y - y) <= 1; }

  /** Shortest walk (4 directions) to the goal cell, or next to it. Monsters and closed doors are in the way. */
  function findPath(gx, gy, exact) {
    var map = mapOf(), opts = World.viewOpts(content, map, view, me.id), lk = lookup();
    var walkable = opts.walkable, occupied = opts.occupied;
    // monsters move, so they don't block a planned route; one still in the way gets bumped (attacked) on arrival
    opts.occupied = function (x, y) { var w = occupied(x, y); return w && w.player ? w : null; };
    opts.walkable = function (e) {                        // plan through doors that are closed but not locked: they get opened on the way
      var o = content.objects[e.ref];
      if (o && o.kind === 'door' && !World.props(content, e).target) return lk.stateOf(e) !== 'locked';
      return walkable(e);
    };
    var key = function (x, y) { return x + ',' + y; }, from = {}, q = [[me.x, me.y]], seen = {};
    seen[key(me.x, me.y)] = 1;
    var done = function (x, y) { return exact ? x === gx && y === gy : Math.abs(x - gx) + Math.abs(y - gy) <= 1; };
    for (var n = 0; q.length && n < 4000; n++) {
      var cur = q.shift();
      if (done(cur[0], cur[1])) {
        var path = [], k = key(cur[0], cur[1]);
        while (from[k]) { path.unshift(from[k].dir); k = from[k].prev; }
        return path;
      }
      ['N', 'E', 'S', 'W'].forEach(function (d) {
        var r = Rules.tryMove(content, map, cur[0], cur[1], d, opts);
        if (!r.ok || seen[key(r.x, r.y)]) return;
        seen[key(r.x, r.y)] = 1; from[key(r.x, r.y)] = { prev: key(cur[0], cur[1]), dir: d };
        q.push([r.x, r.y]);
      });
    }
    return null;
  }
  /** One step of the current click-plan; called every frame when the character is standing still. */
  function followPlan(now) {
    if (!plan) return false;
    if (plan.chase) {                                     // keep attacking the clicked monster until it is gone
      var m = view.monsters.filter(function (q) { return q.id === plan.chase; })[0];
      if (!m) { plan = null; return false; }
      if (near(m.x, m.y)) {
        if (now - lastAttack >= (content.config.attack_ms || 500) && !queue.length) {
          lastAttack = now; send({ type: 'attack', x: m.x, y: m.y }); attackFx(m.x, m.y);
        }
        return true;
      }
      var p1 = findPath(m.x, m.y, false);
      if (!p1 || !p1.length) { plan = null; log('You can\'t reach it.', 'info'); return false; }
      return walkStep(p1[0], now);
    }
    if (!plan.exact && near(plan.goal.x, plan.goal.y)) { send(plan.act); plan = null; return true; }
    if (plan.exact && me.x === plan.goal.x && me.y === plan.goal.y) { plan = null; return false; }
    var path = findPath(plan.goal.x, plan.goal.y, plan.exact);
    if (!path && plan.exact) { plan.exact = false; path = findPath(plan.goal.x, plan.goal.y, false); }   // occupied: get next to it
    if (!path || !path.length) { plan = null; log('You can\'t get there.', 'info'); return false; }
    return walkStep(path[0], now);
  }
  /** Takes one step of a path; a closed door in the way is opened first. */
  function walkStep(dir, now) {
    var d = Rules.DIRS[dir], nx = me.x + d.dx, ny = me.y + d.dy, lk = lookup();
    var door = Rules.entitiesAt(mapOf(), nx, ny).filter(function (e) {
      var o = content.objects[e.ref]; return o && o.kind === 'door' && lk.stateOf(e) !== 'open';
    })[0];
    if (door) {
      if (!plan.opening || now - plan.opening > 1500) { plan.opening = now; send({ type: 'interact', x: nx, y: ny }); }
      return true;
    }
    step(dir);
    return true;
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

  /** What a click would do, next to the cursor; the cursor shape says it too. */
  function hoverLabel(e) {
    var tip = $('tip');
    if (!me || armed || !hover) { tip.hidden = true; canvas.style.cursor = armed ? 'crosshair' : ''; return; }
    var acts = World.actionsAt(content, mapOf(), lookup(), me, hover.x, hover.y), a = acts[0];
    canvas.style.cursor = !a ? 'default' : a.type === 'attack' ? 'crosshair' : a.type === 'interact' ? 'pointer' : 'default';
    if (!a || a.type === 'walk') { tip.hidden = true; return; }
    var r = $('frame').getBoundingClientRect();
    tip.textContent = a.label + (acts.length > (acts[acts.length - 1].type === 'walk' ? 2 : 1) ? '  · right-click for more' : '');
    tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 14) + 'px';
    tip.hidden = false;
  }

  // ---------------------------------------------------------------- skills and the bar
  function serverNow() { return Date.now() + clockOffset; }
  function slotEntry(i) { var e = (me.loadout || [])[i] || '', k = e.split(':')[0]; return { kind: k, id: e.slice(k.length + 1) }; }
  function readyIn(id) { return Math.max(0, ((me.cooldowns || {})[id] || 0) - serverNow()); }
  function hotkey(i) {
    var en = slotEntry(i);
    if (en.kind === 'item') { if (me.inventory.some(function (s) { return s.item === en.id; })) useItem(en.id); else log('You have no ' + (content.items[en.id] || { name: en.id }).name.toLowerCase() + ' left.', 'info'); return; }
    if (en.kind !== 'skill') return;
    var sk = content.skills[en.id]; if (!sk) return;
    if (readyIn(sk.id) > 0) { log(sk.name + ' is not ready yet.', 'info'); return; }
    if (me.mp < sk.mp) { log('Not enough mana for ' + sk.name + '.', 'info'); return; }
    if (sk.target === 'self' || sk.target === 'around') { disarm(); send({ type: 'cast', skill: sk.id, x: me.x, y: me.y }); castFx(sk.id, me, me); return; }
    if (armed && armed.slot === i) { if (hover) castAt(hover); return; }   // second press: cast at the cursor
    armed = { slot: i, skill: sk.id };
    hotbar();
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
  function disarm() { armed = null; hotbar(); }
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

  /** Cells to light up while aiming: in range and in sight. */
  function aimOverlay() {
    var sk = content.skills[armed.skill], map = mapOf(), lk = World.viewLookup(content, map, view, me), cells = [];
    var reach = Object.assign({}, sk, { target: 'tile', dash: false });
    for (var y = me.y - sk.range; y <= me.y + sk.range; y++) for (var x = me.x - sk.range; x <= me.x + sk.range; x++) {
      if (World.checkTarget(content, map, me, reach, x, y, lk).ok) cells.push({ x: x, y: y });
    }
    var hc = hover && aimCheck(hover), h = hc && { x: hc.x, y: hc.y, ok: hc.ok };
    return { cells: cells, hover: h, area: sk.area, from: me, color: sk.color };
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
    var bar = $('hotbar'); if (!me) return;
    bar.innerHTML = '';
    for (var i = 0; i < 5; i++) (function (i) {
      var en = slotEntry(i), b = document.createElement('div');
      b.className = 'hk' + (armed && armed.slot === i ? ' armed' : '') + (en.kind ? '' : ' empty');
      b.title = en.kind === 'skill' ? describeSkill(content.skills[en.id]) : en.kind === 'item' ? (content.items[en.id] || { name: en.id }).name : 'Empty: fill it from the bag (I)';
      var key = document.createElement('span'); key.className = 'key'; key.textContent = i + 1;
      b.appendChild(key);
      if (en.kind) b.appendChild(icon(en));
      if (en.kind === 'skill' && content.skills[en.id]) {
        var cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = content.skills[en.id].mp || '';
        b.appendChild(cost);
        var cd = document.createElement('div'); cd.className = 'cd'; b.appendChild(cd);
        var cdt = document.createElement('div'); cdt.className = 'cdt'; b.appendChild(cdt);
        b._cd = cd; b._cdt = cdt; b._skill = content.skills[en.id];
      } else if (en.kind === 'item') {
        var q = document.createElement('span'); q.className = 'qty';
        var st = me.inventory.filter(function (s) { return s.item === en.id; })[0];
        q.textContent = st ? '×' + st.qty : '0'; b.appendChild(q);
        if (!st) b.classList.add('low');
      }
      b.onclick = function () { hotkey(i); };
      bar.appendChild(b);
    })(i);
    tickHotbar();
  }
  /** Cooldown shading and "not enough mana", every frame. */
  function tickHotbar() {
    Array.prototype.forEach.call($('hotbar').children, function (b) {
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
    var sts = $('statuses'); sts.innerHTML = '';
    (me.statuses || []).forEach(function (st) {
      var d = content.statuses[st.id] || { name: st.id, color: '#888' }, el = document.createElement('span');
      el.className = 'st'; el.style.color = d.color;
      el.textContent = d.name + ' ' + Math.max(0, Math.ceil((st.until - serverNow()) / 1000)) + 's';
      sts.appendChild(el);
    });
    hotbar();
  }
  function toggleBag() { bagOpen = !bagOpen; $('bag').hidden = !bagOpen; if (bagOpen) bag(); }
  function bag() {
    var box = $('bag-items'); box.innerHTML = '';
    $('bag-stats').textContent = (content.classes[me['class']] ? content.classes[me['class']].name + ' · ' : '') +
      'Attack ' + me.atk + ' · Defence ' + me.def + ' · ' + me.gold + ' gold';
    function slots(entry) {
      var wrap = document.createElement('div'); wrap.className = 'slots';
      [0, 1, 2, 3, 4].forEach(function (i) {
        var b = document.createElement('button'); b.textContent = i + 1;
        b.title = 'Put in slot ' + (i + 1);
        if (me.loadout[i] === entry) b.className = 'on';
        b.onclick = function () { send({ type: 'loadout', slot: i, entry: me.loadout[i] === entry ? '' : entry }); };
        wrap.appendChild(b);
      });
      return wrap;
    }
    var h1 = document.createElement('h4'); h1.textContent = 'Skills (numbers = put on the bar)'; box.appendChild(h1);
    (me.skills || []).forEach(function (id) {
      var sk = content.skills[id]; if (!sk) return;
      var row = document.createElement('div'); row.className = 'sk';
      row.appendChild(icon({ kind: 'skill', id: id }));
      var info = document.createElement('div'); info.className = 'name';
      info.innerHTML = '<b></b><span></span>';
      info.firstChild.textContent = sk.name; info.lastChild.textContent = describeSkill(sk).split('\n')[1];
      info.appendChild(slots('skill:' + id));
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
      if (it.type === 'consumable') name.appendChild(slots('item:' + s.item));
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
    plan = null;
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
      else if (plan && !queue.some(function (a) { return a.type === 'move'; }) && now - lastStep >= moveMs * 0.9) { if (followPlan(now)) lastStep = now; }
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
  $('reset').onclick = function () { if (confirm('Start over with a new character?')) { api.forget(); location.reload(); } };

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
    log('Arrow keys / WASD to move, E to use, I for your bag.', 'info');
    if (api.staleDraft) log('Your map editor draft was made from older game data, so the game is using the latest data instead. Open the editor to update or discard the draft.', 'death');
    requestAnimationFrame(frame);
  }).catch(function (e) {
    setNet('could not start: ' + e.message, true);
    console.error(e);
  });

  addEventListener('pagehide', function () { api.leave(); });
  // read-only peek for tests and debugging in the browser console
  window.SheetsRPG = { state: function () { return { me: me, view: view, queue: queue.length }; },
    plan: function () { return plan; },
    layers: function () { return me ? playerLayers(me) : null; },
    camera: function () { return lastCam; },
    aim: function () { return { armed: armed, hover: hover, check: armed && hover ? aimCheck(hover) : null }; } };
})();
