/**
 * Game loop: input -> predicted move (instant) -> server check (queued, batched) -> draw.
 * The server (or offline mode) answers every call with {player, world, events, seq}.
 */
(function () {
  var canvas = document.getElementById('view');
  var $ = function (id) { return document.getElementById(id); };
  var api = Api.create(), content, renderer;
  var me = null;                         // this player (position predicted locally)
  var seenZones = {};                    // rooms the local player has stepped into, per map (merged with the server's record)
  var seenCells = {};                    // cells the local player has had in sight this session, per map — what they remember
  var sight = { key: '', at: 0, vis: null };   // the current line-of-sight set (World.visibleCells), recomputed when something changes
  var view = { states: {}, monsters: [], players: [] };
  var since = -1;                        // last event number seen
  var shown = { x: 0, y: 0 };            // drawn position, eases toward me.x/y
  var shownOthers = {};                  // drawn positions of monsters and other players
  var queue = [], inFlight = false, lastReply = 0;
  var held = [], tap = null, holdSince = 0, lastStep = 0, lastFrame = 0, HOLD_MS = 220;
  var fx = [], bagOpen = false, craftOpen = false;
  // building: buildOpen = the blueprint list is showing; building = the blueprint id you are placing (a ghost
  // follows the cursor until Esc); storage = the built container whose contents panel is open
  var buildOpen = false, building = null, storage = null;
  var armed = null;                      // {slot, id, skill} while an ability (Q/E) waits for a target
  var throwing = null;                   // belt item id armed for a throw (click to throw, Esc to cancel)
  // mouse: right-button held = aiming; left = interact (tap) / action list (hold) / fire (while aiming)
  var aiming = false, leftHeld = false, holdFired = false, pendingCell = null, holdMenuEvt = null, holdTimer = 0;
  var lastHoldShot = 0, aimAngle = 0, HOLD_CLICK_MS = 250;   // left-press longer than this opens the action list
  var hover = null, lastCam = { x: 0, y: 0 };
  // Aim lean: while the right button is held the camera drifts toward the cursor so you see further that way.
  // lastPtr = where the cursor last was (client px), so the hovered cell and aim follow the moving camera.
  var lean = { x: 0, y: 0 }, lastPtr = null;
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
      out.push({ z: SLOT_Z[slot] != null ? SLOT_Z[slot] : 9, path: it.wornSprite, slot: slot,
        mask: ramp ? maskOf(it.wornSprite) : '', ramp: ramp, aimPoints: it.aim || null });
    });
    out.sort(function (a, b) { return a.z - b.z; });
    out.forEach(function (l) {                                           // make sure late-arriving layers load
      if (!Assets.get(l.path)) Assets.load(l.path);
      if (l.mask && !Assets.get(l.mask)) Assets.load(l.mask);
    });
    return out;
  }

  /** Paper-doll layers for a monster, from the look the server rolled for this instance. `m.look` is
   *  [{path, tint}] already in draw order (base body first); tint is a Tint ramp name recolouring the
   *  sprite's sibling .tint.png mask. Returns null for plain-sprite monsters (slimes, rats...). */
  function monsterLayers(m) {
    if (!m.look || !m.look.length) return null;
    var out = m.look.map(function (l) {
      var ramp = l.tint ? Tint.TINTS[l.tint] : null;
      return { path: l.path, mask: ramp ? maskOf(l.path) : '', ramp: ramp };
    });
    out.forEach(function (l) {                                           // make sure late-arriving layers load
      if (!Assets.get(l.path)) Assets.load(l.path);
      if (l.mask && !Assets.get(l.mask)) Assets.load(l.mask);
    });
    return out;
  }

  function setNet(text, bad) { $('hud-net').textContent = text; $('hud-net').className = bad ? 'bad' : ''; }
  // The structure layer of the current map (walls/objects built, damaged or destroyed), as last sent by the
  // server; null = nothing changed from the authored map. mapOf() is the map with that layer applied — the
  // same function the referee uses, so prediction, sight and drawing all match it.
  var struct = null;
  function mapOf() {
    var base = content.maps[me.map];
    return struct && struct.rev ? World.liveMapFromStruct(content, base, struct) : base;
  }
  /** Take the layer from a server answer. True when what we hold changed. */
  function takeStruct(w) {
    if (!w) return false;
    var before = struct ? struct.rev : 0;
    if (w.struct) struct = w.struct; else if (!w.structRev) struct = null;
    api.structRev = w.structRev || 0;
    return (struct ? struct.rev : 0) !== before;
  }

  // ---------------------------------------------------------------- server replies
  function apply(res) {
    lastReply = performance.now();
    if (res.world && res.world.now) clockOffset = res.world.now - Date.now();
    if (typeof res.seq === 'number') since = res.seq;
    var p = res.player;
    var moving = queue.some(function (a) { return a.type === 'move'; });
    if (!me || p.map !== me.map) {
      floorWait = 0;
      me = p; view = res.world; struct = null; takeStruct(res.world); handleEvents(res.events);
      return enterMap();
    }
    // keep our predicted position while moves are still on their way; otherwise trust the server
    me = moving ? Object.assign({}, p, { x: me.x, y: me.y, facing: me.facing }) : p;
    view = res.world;
    if (takeStruct(res.world)) { renderer.setMap(mapOf()); sight.key = ''; }   // something was built or broken: redraw walls, re-check sight
    handleEvents(res.events);
    hud();
    if (bagOpen) bag();
    if (craftOpen) craftPanel();
    if (buildOpen) buildPanel();
    if (storage) storePanel();
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
  // The other floors of the building you are in: what stands on each, so the ones you have a clear view of can be
  // drawn. Online each floor's public view is pushed on its own; offline and on a LAN it comes with the answer.
  var floorWorlds = {}, floorUnwatch = [];
  function watchLive() {
    if (liveUnwatch) { liveUnwatch(); liveUnwatch = null; }
    floorUnwatch.forEach(function (stop) { stop(); }); floorUnwatch = []; floorWorlds = {};
    if (!api.watchMap || !me) return;
    liveUnwatch = api.watchMap(me.map, mergeLiveWorld);
    World.floorsOf(content, me.map).forEach(function (f) {
      if (f.id !== me.map) floorUnwatch.push(api.watchMap(f.id, function (w) { if (w && w.map === f.id) floorWorlds[f.id] = w; }));
    });
  }
  /** Creatures on other floors that you can see from where you stand: [{ dz, actors }] for the renderer. */
  function floorActors() {
    var out = [], map = mapOf(), myZ = map.z || 0, fam = World.floorsOf(content, me.map);
    if (fam.length < 2) return out;
    var sf = lookup().stateOf;
    fam.forEach(function (f) {
      if (f.id === me.map) return;
      var w = floorWorlds[f.id] || (view.floors && view.floors[f.id]); if (!w) return;
      var fm = content.maps[f.id], dz = f.z - myZ, list = [];
      if (!fm._edgeOv) World.syncEdgesView(content, fm, function () { return ''; });   // its windows and arches, so sight through them works both ways
      var rad = World.sightRadius(content, dz < 0 ? map : fm);
      function inView(x, y) { return dz < 0 ? World.seesAcross(content, map, me.x, me.y, fm, x, y, rad, sf) : World.seesAcross(content, fm, x, y, map, me.x, me.y, rad); }
      (w.monsters || []).forEach(function (m) {
        if (!inView(m.x, m.y)) return;
        var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, lay = monsterLayers(m);
        list.push({ x: m.x, y: m.y, facing: m.facing, name: d.name, sprite: lay ? '' : (d.sprite || ''), layers: lay || undefined, hp: m.hp, maxHp: m.maxHp });
      });
      (w.players || []).forEach(function (q) {
        if (q.id === me.id || !inView(q.x, q.y)) return;
        list.push({ x: q.x, y: q.y, facing: q.facing, name: q.name, tint: '#b6553d', layers: playerLayers(q) || undefined, hp: q.hp, maxHp: q.maxHp });
      });
      if (list.length) out.push({ dz: dz, actors: list });
    });
    return out;
  }

  var COLORS = { hit: '#ff6b5b', heal: '#6fe08a', loot: '#ffd65a', level: '#ffd65a', kill: '#ffffff', death: '#ff6b5b' };
  function handleEvents(events) {
    var now = performance.now();
    (events || []).forEach(function (e, i) {
      if (e.text) log(e.text, e.type);
      if (e.type === 'craft') { if (!craftOpen) toggleCraft(); return; }   // you used a workbench / campfire: show what can be made
      if (e.type === 'claim') { claim = e; $('claimp').hidden = false; claimPanel(); return; }       // your claim flag: who belongs to the base
      if (e.type === 'storage') { storage = e; $('store').hidden = false; storePanel(); return; }   // you opened (or changed) a storage container
      if (e.map && e.map !== me.map) return;
      var t0 = now + i * 120;
      if (e.type === 'cast') {
        if (e.by === me.id && performance.now() - lastOwnCast < 6000) return;   // already shown when you cast it
        var sk = content.skills[e.skill] || { color: e.color || '#fff', area: 0, projectile: !!e.projectile };
        var area = sk.target === 'around' ? Math.max(1, sk.area) : sk.area;
        var at = sk.target === 'around' || sk.target === 'self' ? e.from : e.to;
        if (sk.projectile) fx.push({ kind: 'proj', from: e.from, to: e.to, color: sk.color, t0: t0, life: 260 });
        var acells = area > 0 ? World.blastCells(content, mapOf(), at.x, at.y, area, lookup().stateOf) : null;
        fx.push({ kind: 'flash', x: at.x, y: at.y, r: area, cells: acells, color: sk.color, t0: t0 + (sk.projectile ? 240 : 0), life: 450 });
        return;
      }
      if (e.type === 'shoot') {                                  // a bullet tracer (ours was drawn on click)
        if (e.by !== me.id) fx.push({ kind: 'tracer', from: e.from, to: e.to, color: e.color || '#ffd36b', t0: t0, life: 160 });
        return;
      }
      if (e.type === 'throw') {                                  // a thrown grenade/molotov arc + blast
        if (e.by !== me.id) {
          fx.push({ kind: 'proj', from: e.from, to: e.to, color: e.color || '#ff8c3b', t0: t0, life: 300 });
          fx.push({ kind: 'flash', x: e.to.x, y: e.to.y, r: e.area || 0, cells: World.blastCells(content, mapOf(), e.to.x, e.to.y, e.area || 0, lookup().stateOf), color: e.color || '#ff8c3b', t0: t0 + 280, life: 450 });
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

  var floorWait = 0;                                      // when a step onto another floor was sent (no stepping until it lands)
  var lastCost = 1;                                       // what the last step cost (1 straight, 1.4 diagonal): paces the next one
  /** The direction the held movement keys add up to: the latest vertical and the latest horizontal key, together a diagonal. */
  function heldDir() {
    var v = '', hz = '';
    for (var i = held.length - 1; i >= 0; i--) {
      var d = held[i];
      if (!v && (d === 'N' || d === 'S')) v = d;
      if (!hz && (d === 'E' || d === 'W')) hz = d;
    }
    return v && hz ? v + hz : (v || hz);
  }
  function step(dir) {
    var opts = World.viewOpts(content, mapOf(), view, me.id), r = Rules.tryMove(content, mapOf(), me.x, me.y, dir, opts), g = Rules.DIAG[dir];
    if (!r.ok && g) {                                     // a diagonal that is blocked slides along whichever straight way is open
      var ra = Rules.tryMove(content, mapOf(), me.x, me.y, g.a, opts), rb = ra.ok ? null : Rules.tryMove(content, mapOf(), me.x, me.y, g.b, opts);
      if (ra.ok) { dir = g.a; r = ra; } else if (rb.ok) { dir = g.b; r = rb; }
    }
    if (r.ok && r.map) {                                  // off a staircase onto another floor: the referee moves us; wait for its answer
      floorWait = performance.now(); me = Object.assign({}, me, { facing: dir });
      send({ type: 'move', dirs: [dir] });
      return;
    }
    if (!r.ok && r.who && r.who.monster && Rules.DIRS[dir]) { var d = Rules.DIRS[dir]; attackFx(me.x + d.dx, me.y + d.dy); }   // bumped a monster: the server turns this move into an attack
    me = Object.assign({}, me, { facing: Rules.faceFor(dir, me.facing) }, r.ok ? { x: r.x, y: r.y } : {});
    lastCost = r.ok ? Rules.stepCost(dir) : 1;
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
    else if (e.code === 'KeyI') toggleBag();
    else if (e.code === 'KeyB') { if (building) stopBuilding(); else toggleBuild(); }
    else if (e.code === 'KeyC') toggleCraft();
    else if (e.code === 'KeyT') turnBuild(1);
    else if (e.code === 'Escape') { closeMenu(); if (armed) disarm(); else if (throwing) cancelThrow(); else if (claim) closeClaim(); else if (storage) closeStore(); else if (buildOpen) toggleBuild(); else if (building) stopBuilding(); else if (craftOpen) toggleCraft(); else if (bagOpen) toggleBag(); }
    else if (e.code === 'KeyQ') ability(0);
    else if (e.code === 'KeyE') ability(1);
    else if (e.code === 'KeyR') { if (World.rangedWeapon(content, me)) send({ type: 'reload' }); }
    else if (/^Digit[1-5]$/.test(e.code) && me) beltKey(Number(e.code.slice(5)) - 1);
  });
  addEventListener('keyup', function (e) {
    var d = KEYS[e.code]; if (d) held = held.filter(function (h) { return h !== d; });
  });
  addEventListener('blur', function () { held = []; aiming = false; leftHeld = false; buildHold = null; clearTimeout(holdTimer); updateCursor(); });
  function cellAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    var px = (e.clientX - r.left) * canvas.width / r.width + lastCam.x, py = (e.clientY - r.top) * canvas.height / r.height + lastCam.y;
    return { x: Math.floor(px / T), y: Math.floor(py / T) };
  }
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointermove', function (e) {
    if (!content) return;
    lastPtr = { clientX: e.clientX, clientY: e.clientY };
    hover = cellAt(e); hoverLabel(e);
    if (aiming && me) aimAt(e);                           // keep facing + gun angle tracking the cursor
    if (buildHold) buildDrag();
  });
  canvas.addEventListener('pointerleave', function () { hover = null; lastPtr = null; $('tip').hidden = true; });
  // mousedown/up (not pointerdown) so a left-click still fires while the right button is held to aim —
  // a pointer only fires one 'down' per gesture, reporting extra buttons as moves, which swallowed the shot.
  canvas.addEventListener('mousedown', function (e) {
    if (!me) return;
    var cell = cellAt(e);
    if (e.button === 2) {                                 // right-button (held): aim — fire/attack toward the cursor
      e.preventDefault(); closeMenu();
      aiming = true; aimAt(e); updateCursor();
      return;
    }
    if (e.button !== 0) return;
    closeMenu();
    hover = cell;
    if (building) {                                       // build mode: a click places the blueprint where the ghost is
      var bt = buildTarget();
      if (bt) { if (bt.ok) send({ type: 'build', bp: building, x: bt.x, y: bt.y, side: bt.side, off: bt.off, facing: bt.facing }); else log(bt.reason, 'info'); }
      if (bt && bt.side) buildHold = { side: bt.side, x: bt.x, y: bt.y, off: bt.off, repeat: bt.bp.places === 'wall', last: bt.x + ',' + bt.y };
      return;
    }
    if (armed) { castAt(cell); return; }                  // an armed ability still aims + casts on left-click
    if (throwing) { throwAt(cell); return; }
    if (aiming) { leftHeld = true; fireToward(cell); return; }   // fire/attack while aiming
    // not aiming: left-click interacts. A quick tap does the default action; holding opens the action list.
    leftHeld = true; holdFired = false; pendingCell = cell; holdMenuEvt = e;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      if (!leftHeld || aiming) return;
      var acts = World.actionsAt(content, mapOf(), lookup(), me, cell.x, cell.y);
      if (acts.length) { holdFired = true; openMenu(holdMenuEvt, cell, acts); }
    }, HOLD_CLICK_MS);
  });

  // ---------------------------------------------------------------- mouse: a click acts; it never walks you there
  function lookup() { return World.viewLookup(content, mapOf(), view, me); }
  var TOO_FAR = 'Too far away. Move there with the movement keys.';
  function near(x, y) { return Math.abs(me.x - x) <= 1 && Math.abs(me.y - y) <= 1; }   // your cell or any of the eight around it
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
    if (a.type === 'work' || a.type === 'dismantle') { send({ type: a.type, target: a.target }); return; }
    if (a.type === 'shift') { send({ type: 'shift', target: a.target, off: a.off }); return; }
    if (a.type === 'turn') { send({ type: 'turn', target: a.target }); return; }
    if (a.type === 'interact') {
      var tc = a.at || cell;                                   // wall objects act from a footprint cell, not the clicked face/hole
      if (!near(tc.x, tc.y)) { log(TOO_FAR, 'info'); return; }
      send({ type: 'interact', x: tc.x, y: tc.y, verb: a.verb });
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
    if (!aiming) me.facing = facingToward(cell.x, cell.y);   // while aiming, facing already follows the cursor (W/E)
    lastHoldShot = performance.now();
    send({ type: 'shoot', x: cell.x, y: cell.y });
    var end = reach.cells[reach.cells.length - 1] || me;
    fx.push({ kind: 'tracer', from: { x: me.x, y: me.y }, to: { x: end.x, y: end.y }, color: w.tint || '#ffd36b', t0: performance.now(), life: 160 });
  }
  /** While aiming (right-button held): fire the gun, or swing melee at the tile toward the cursor. */
  function fireToward(cell) {
    if (World.rangedWeapon(content, me)) { shootAt(cell); return; }
    // melee swings at whichever of the eight tiles around you lies toward the cursor
    var ddx = cell.x - me.x, ddy = cell.y - me.y, oct = Math.round(Math.atan2(ddy, ddx) / (Math.PI / 4));
    var fd = Rules.DIRS[me.facing] || { dx: 0, dy: 0 };                                  // cursor on your own tile: swing the way you face
    var tx = me.x + (ddx || ddy ? Math.round(Math.cos(oct * Math.PI / 4)) : fd.dx), ty = me.y + (ddx || ddy ? Math.round(Math.sin(oct * Math.PI / 4)) : fd.dy);
    send({ type: 'attack', x: tx, y: ty }); attackFx(tx, ty);
    lastHoldShot = performance.now();
  }
  /** Point the aim at the cursor: the sprite looks to the cursor's side (W/E), the gun angle tracks it. */
  function aimAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    var cx = (e.clientX - r.left) * canvas.width / r.width;
    var cy = (e.clientY - r.top) * canvas.height / r.height;
    var dx = cx - ((shown.x + 0.5) * T - lastCam.x), dy = cy - ((shown.y + 0.5) * T - lastCam.y);
    aimAngle = Math.atan2(dy, dx);
    if (dx || dy) me.facing = dx < 0 ? 'W' : 'E';
  }
  /** Throw the armed belt item (grenade/molotov) at a cell within its range. */
  function throwAt(cell) {
    var it = content.items[throwing]; if (!it) { cancelThrow(); return; }
    if (count(throwing) < 1) { log('Out of ' + it.name.toLowerCase() + '.', 'info'); cancelThrow(); return; }
    if (cheb(me.x, me.y, cell.x, cell.y) > (it.throwRange || 4)) { log(TOO_FAR, 'info'); return; }
    me.facing = facingToward(cell.x, cell.y);
    send({ type: 'throw', item: throwing, x: cell.x, y: cell.y });
    // Predict where it actually lands (stops at a wall) and which cells the blast reaches, so the
    // animation matches the server instead of sailing through walls.
    var map = mapOf(), sf = lookup().stateOf;
    var land = World.throwLanding(content, map, me.x, me.y, cell.x, cell.y, sf);
    var t0 = performance.now();
    fx.push({ kind: 'proj', from: { x: me.x, y: me.y }, to: { x: land.x, y: land.y }, color: it.tint || '#ff8c3b', t0: t0, life: 300 });
    fx.push({ kind: 'flash', x: land.x, y: land.y, r: it.throwArea || 0, cells: World.blastCells(content, map, land.x, land.y, it.throwArea || 0, sf), color: it.tint || '#ff8c3b', t0: t0 + 280, life: 450 });
    cancelThrow();
  }
  function cancelThrow() { if (throwing) { throwing = null; updateCursor(); hotbar(); } }
  function updateCursor() {
    canvas.style.cursor = (aiming || armed || throwing || building) ? 'crosshair' : '';
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
  addEventListener('mousedown', function (e) { if (!$('menu').contains(e.target) && e.target !== canvas) closeMenu(); });

  /** Just the cursor hint: a pointer over something you can act on, a crosshair while aiming, else default. */
  function hoverLabel() {
    $('tip').hidden = true;                                 // no hover tooltip
    if (!me || aiming || armed || throwing) { updateCursor(); return; }
    if (!hover) { canvas.style.cursor = ''; return; }
    canvas.style.cursor = World.actionsAt(content, mapOf(), lookup(), me, hover.x, hover.y)[0] ? 'pointer' : 'default';
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
    if (World.itemCan(it, 'throw')) {
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
    var cells = area > 0 ? World.blastCells(content, mapOf(), at.x, at.y, area, lookup().stateOf) : null;
    fx.push({ kind: 'flash', x: at.x, y: at.y, r: area, cells: cells, color: sk.color, t0: t0 + (sk.projectile ? 240 : 0), life: 450 });
  }

  /** Cells to light up while aiming an ability: in range and in sight. */
  function aimOverlay() {
    var sk = content.skills[armed.skill], map = mapOf(), lk = World.viewLookup(content, map, view, me), cells = [];
    var reach = Object.assign({}, sk, { target: 'tile', dash: false });
    for (var y = me.y - sk.range; y <= me.y + sk.range; y++) for (var x = me.x - sk.range; x <= me.x + sk.range; x++) {
      if (World.checkTarget(content, map, me, reach, x, y, lk).ok) cells.push({ x: x, y: y });
    }
    var hc = hover && aimCheck(hover), h = hc && { x: hc.x, y: hc.y, ok: hc.ok };
    var blast = (h && h.ok && sk.area > 0 && sk.target !== 'around' && sk.target !== 'self')
      ? World.blastCells(content, map, h.x, h.y, sk.area, lk.stateOf) : null;
    return { cells: cells, hover: h, area: sk.area, blast: blast, from: me, color: sk.color };
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
  /** Throw-aim overlay: the cells you can actually reach, plus the blast the grenade would make. */
  function throwOverlay() {
    var it = content.items[throwing], rng = it.throwRange || 4, map = mapOf(), sf = lookup().stateOf;
    // only cells a clear throw can land on — a wall stops the grenade, so tiles behind it aren't shown
    var cells = ringCells(rng).filter(function (c) {
      var l = World.throwLanding(content, map, me.x, me.y, c.x, c.y, sf);
      return l.x === c.x && l.y === c.y;
    });
    if (!hover) return { cells: cells, hover: null, from: me, color: it.tint || '#ff8c3b' };
    var land = World.throwLanding(content, map, me.x, me.y, hover.x, hover.y, sf);
    var inRange = cheb(me.x, me.y, hover.x, hover.y) <= rng;
    var blast = inRange ? World.blastCells(content, map, land.x, land.y, it.throwArea || 0, sf) : null;
    return { cells: cells, hover: { x: land.x, y: land.y, ok: inRange }, blast: blast, from: me, color: it.tint || '#ff8c3b' };
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
      b.title = it ? it.name + (World.itemCan(it, 'throw') ? ' (throw)' : ' (use)') : 'Empty: assign an item from the bag (I)';
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
  addEventListener('mouseup', function (e) {
    // note: don't touch `held` here — those are the keyboard movement keys; a mouse release must not stop walking
    if (!me || !content) return;
    if (e.button === 2) { if (aiming) { me.facing = Math.cos(aimAngle) < 0 ? 'W' : 'E'; aiming = false; leftHeld = false; updateCursor(); } return; }
    if (e.button !== 0) return;
    buildHold = null;
    var was = leftHeld; leftHeld = false; clearTimeout(holdTimer);
    if (!was || aiming) return;                            // was firing while aiming, or not our press
    if (holdFired) { holdFired = false; return; }          // the hold already opened the action list
    if (pendingCell) {                                     // quick tap → the default interaction
      var acts = World.actionsAt(content, mapOf(), lookup(), me, pendingCell.x, pendingCell.y);
      if (acts.length) doAction(acts[0], pendingCell);
    }
  });
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
  // ---- build mode (B): pick a blueprint, then click where it goes. Whether a spot is allowed is decided by
  // World.canBuild — the same check the referee runs — so a green ghost means the server will say yes.
  function toggleBuild() { buildOpen = !buildOpen; $('buildp').hidden = !buildOpen; if (buildOpen) buildPanel(); }
  function stopBuilding() { building = null; buildHold = null; updateCursor(); }
  // While the button is held on a wall blueprint, the ghost stays on the grid line the press started on
  // (same direction, same line): dragging lays wall after wall along it instead of hopping between lines.
  var buildHold = null;                                   // {side, x, y, repeat, last} from the press
  // Which way the thing being placed faces (objects with pictures for other directions): T or Shift+wheel turns it.
  var buildFacing = 'S';
  function turnBuild(dir) {
    var bp = building && content.blueprints && content.blueprints[building], o = bp && bp.places === 'object' ? content.objects[bp.object] : null;
    if (!o || World.isWallFixture(o) || !Rules.turnable(o)) return false;
    buildFacing = Rules.nextFacing(buildFacing, dir);
    return true;
  }
  canvas.addEventListener('wheel', function (e) {
    if (e.shiftKey && building && turnBuild((e.deltaY || e.deltaX) > 0 ? 1 : -1)) e.preventDefault();
  }, { passive: false });
  function buildDrag() {
    if (!buildHold || !buildHold.repeat || !building) return;
    var bt = buildTarget(), k = bt && bt.x + ',' + bt.y;
    if (!bt || k === buildHold.last) return;
    buildHold.last = k;
    if (bt.ok) send({ type: 'build', bp: building, x: bt.x, y: bt.y, side: bt.side, off: bt.off });
  }
  function buildPanel() {
    var box = $('build-items'); box.innerHTML = '';
    var bps = World.blueprintsFor(content, me), groups = {}, order = [];
    if (!bps.length) box.insertAdjacentHTML('beforeend', '<div class="empty">You don\'t know how to build anything yet.</div>');
    bps.forEach(function (b) { if (!groups[b.category]) { groups[b.category] = []; order.push(b.category); } groups[b.category].push(b); });
    order.forEach(function (g) {
      var h4 = document.createElement('h4'); h4.textContent = g.charAt(0).toUpperCase() + g.slice(1); box.appendChild(h4);
      groups[g].forEach(function (b) {
        var o = b.places === 'object' ? content.objects[b.object] : null, can = b.afford && b.toolOk;
        var row = document.createElement('div'); row.className = 'slot' + (can ? '' : ' cant');
        var img = o && Assets.get(o.sprite), pic = img ? img.cloneNode() : Assets.placeholder(b.name, '#555', 32);
        pic.className = 'pic';
        var name = document.createElement('div'); name.className = 'name';
        var bb = document.createElement('b'); bb.textContent = b.name; name.appendChild(bb);
        b.cost.forEach(function (g2, i) {
          var sp = document.createElement('span');
          sp.textContent = (i ? ', ' : '') + g2.qty + ' ' + ((content.items[g2.item] || {}).name || g2.item).toLowerCase() + ' (' + g2.have + ')';
          if (g2.have < g2.qty) sp.className = 'lack';
          name.appendChild(sp);
        });
        if (!b.toolOk) { var why = document.createElement('span'); why.className = 'lack'; why.textContent = ' — needs a ' + b.tool; name.appendChild(why); }
        var bt = document.createElement('button'); bt.textContent = 'Place';
        bt.onclick = function () { building = b.id; buildFacing = 'S'; toggleBuild(); updateCursor(); };
        row.appendChild(pic); row.appendChild(name); row.appendChild(bt); box.appendChild(row);
      });
    });
  }
  /** Where the cursor is in tiles, with fractions (so the nearest grid line can be found). */
  function pointAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    return { fx: ((e.clientX - r.left) * canvas.width / r.width + lastCam.x) / T, fy: ((e.clientY - r.top) * canvas.height / r.height + lastCam.y) / T };
  }
  /** Where the blueprint being placed would go right now, and whether that is allowed: {bp, x, y, side, ok, reason}. */
  function buildTarget() {
    var bp = building && content.blueprints && content.blueprints[building];
    if (!bp || !lastPtr || !me) return null;
    var pt = pointAt(lastPtr), map = mapOf(), o = bp.places === 'object' ? content.objects[bp.object] : null;
    var x, y, side, off = '';
    if (bp.places === 'wall' || (o && World.isWallFixture(o))) {        // snaps to the nearest grid line, like the map editor
      var hC = { x: Math.floor(pt.fx), y: Math.round(pt.fy), side: 'N' }, vC = { x: Math.round(pt.fx), y: Math.floor(pt.fy), side: 'W' }, pick = null;
      if (o) {                                                         // a door or window prefers the line that has a wall
        var hW = !!Rules.wallAt(map, 'h', hC.x, hC.y), vW = !!Rules.wallAt(map, 'v', vC.x, vC.y);
        if (hW !== vW) pick = hW ? hC : vC;
      }
      if (!pick) pick = Math.abs(pt.fx - vC.x) < Math.abs(pt.fy - hC.y) ? vC : hC;
      x = pick.x; y = pick.y; side = pick.side;
      if (buildHold) {                                                 // held: stay on the line the press chose
        side = buildHold.side;
        if (side === 'N') { y = buildHold.y; x = Math.floor(pt.fx); } else { x = buildHold.x; y = Math.floor(pt.fy); }
      }
      // a N-S wall sits on the side of the line the cursor is on (like the map editor), kept while the button is held
      if (bp.places === 'wall' && side === 'W') off = buildHold ? buildHold.off : (pt.fx >= x ? 'r' : 'l');
    } else { x = Math.floor(pt.fx); y = Math.floor(pt.fy); }
    var chk = World.canBuild(content, map, lookup(), me, bp, x, y, side);
    var facing = o && !World.isWallFixture(o) && Rules.turnable(o) ? buildFacing : '';
    return { bp: bp, x: x, y: y, side: side, off: off, facing: facing, ok: chk.ok, reason: chk.reason || '' };
  }
  // ---- storage panel: a container you built. Left = what is in it (Take), below = your bag (Put).
  function closeStore() { storage = null; $('store').hidden = true; }
  // The members panel of your own claim flag (the referee sends a 'claim' event when you use it).
  var claim = null;
  function closeClaim() { claim = null; $('claimp').hidden = true; }
  function claimPanel() {
    var box = $('claim-body'); box.innerHTML = '';
    function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
    $('claim-title').textContent = 'Your base';
    box.appendChild(el('div', 'empty', 'The land ' + claim.radius + ' tiles around this flag is yours. Only you and your members can build here, open the doors and crates built here, or damage anything.'));
    box.appendChild(el('h4', '', 'Members'));
    if (!claim.members.length) box.appendChild(el('div', 'empty', 'No members yet.'));
    claim.members.forEach(function (m) {
      var r = el('div', 'slot'), name = el('div', 'name'), btns = el('div', 'btns'), bt = el('button', '', 'Remove');
      name.appendChild(el('b', '', m.name));
      bt.onclick = function () { send({ type: 'claim', key: claim.key, op: 'remove', id: m.id }); };
      btns.appendChild(bt); r.appendChild(name); r.appendChild(btns); box.appendChild(r);
    });
    box.appendChild(el('h4', '', 'Add a member'));
    var row = el('div', 'slot'), inp = document.createElement('input'), add = el('button', '', 'Add');
    inp.type = 'text'; inp.placeholder = 'Their name'; inp.maxLength = 24; inp.style.cssText = 'flex:1; min-width:0; width:auto';
    row.style.display = 'flex'; row.style.gap = '6px'; add.style.cssText = 'flex:none; width:auto';
    function go() { var v = inp.value.trim(); if (v) send({ type: 'claim', key: claim.key, op: 'add', name: v }); }
    add.onclick = go;
    inp.onkeydown = function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') go(); else if (ev.key === 'Escape') closeClaim(); };
    inp.onkeyup = function (ev) { ev.stopPropagation(); };
    row.appendChild(inp); row.appendChild(add); box.appendChild(row);
    box.appendChild(el('div', 'empty', 'They have to be in this area with you when you add them.'));
  }
  function storePanel() {
    var box = $('store-items'); box.innerHTML = '';
    var keys = Object.keys(storage.inv || {});
    $('store-title').textContent = storage.name + (storage.slots ? ' (' + keys.length + '/' + storage.slots + ')' : '');
    function row(id, qty, label, op) {
      var it = content.items[id] || { name: id, sprite: '' };
      var r = document.createElement('div'); r.className = 'slot';
      var img = Assets.get(it.sprite), pic;
      if (img) pic = img.cloneNode();
      else { pic = document.createElement('canvas'); pic.width = pic.height = 32; pic.getContext('2d').drawImage(Assets.placeholder(it.name, '#555', 32), 0, 0); }   // its own copy: the same item can be listed twice
      pic.className = 'pic';
      var name = document.createElement('div'); name.className = 'name';
      var b = document.createElement('b'); b.textContent = it.name + (qty > 1 ? ' ×' + qty : ''); name.appendChild(b);
      var btns = document.createElement('div'); btns.className = 'btns';
      [[label, 1], ['All', qty]].forEach(function (q) {
        if (q[1] === 1 && qty === 1 && q[0] === 'All') return;
        var bt = document.createElement('button'); bt.textContent = q[0];
        bt.onclick = function () { send({ type: 'store', key: storage.key, op: op, item: id, qty: q[1] }); };
        btns.appendChild(bt);
      });
      r.appendChild(pic); r.appendChild(name); r.appendChild(btns); box.appendChild(r);
    }
    var h1 = document.createElement('h4'); h1.textContent = 'Inside'; box.appendChild(h1);
    if (!keys.length) box.insertAdjacentHTML('beforeend', '<div class="empty">Empty.</div>');
    keys.forEach(function (id) { row(id, storage.inv[id], 'Take', 'take'); });
    var h2 = document.createElement('h4'); h2.textContent = 'Your bag'; box.appendChild(h2);
    me.inventory.forEach(function (st) { row(st.item, st.qty, 'Put', 'put'); });
  }
  // ---- crafting panel (C, or use a crafting station): every recipe you know, what it needs, and Make buttons.
  // What can be made here is decided by World.recipesFor — the same check the referee runs on the craft action.
  function toggleCraft() { craftOpen = !craftOpen; $('craft').hidden = !craftOpen; if (craftOpen) craftPanel(); }
  function craftPanel() {
    var box = $('craft-items'); box.innerHTML = '';
    var recs = World.recipesFor(content, mapOf(), me, lookup());
    var near = recs.filter(function (r) { return r.station && r.here; }).map(function (r) { return r.station; });
    $('craft-note').textContent = !recs.length ? 'You don\'t know any recipes yet.'
      : near.length ? '' : 'Stand next to a workbench or campfire to make the things that need one.';
    var groups = {}, order = [];
    recs.forEach(function (r) { var g = r.category || 'Other'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(r); });
    order.forEach(function (g) {
      var h4 = document.createElement('h4'); h4.textContent = g; box.appendChild(h4);
      groups[g].sort(function (a, b) { return (b.can ? 1 : 0) - (a.can ? 1 : 0); }).forEach(function (r) {
        var out = r.outputs[0] || { item: '', qty: 1 }, it = content.items[out.item] || { name: r.name, sprite: '' };
        var row = document.createElement('div'); row.className = 'slot' + (r.can ? '' : ' cant');
        var img = Assets.get(it.sprite), pic = img ? img.cloneNode() : Assets.placeholder(it.name, '#555', 32);
        pic.className = 'pic';
        var name = document.createElement('div'); name.className = 'name';
        var b = document.createElement('b'); b.textContent = r.name + (out.qty > 1 ? ' ×' + out.qty : ''); name.appendChild(b);
        r.inputs.forEach(function (g2, i) {
          var sp = document.createElement('span');
          sp.textContent = (i ? ', ' : '') + g2.qty + ' ' + ((content.items[g2.item] || {}).name || g2.item).toLowerCase() + ' (' + g2.have + ')';
          if (g2.have < g2.qty) sp.className = 'lack';
          name.appendChild(sp);
        });
        if (!r.can && r.reason && !/^Not enough/.test(r.reason)) { var why = document.createElement('span'); why.className = 'lack'; why.textContent = ' — ' + r.reason; name.appendChild(why); }
        var btns = document.createElement('div'); btns.className = 'btns';
        [1, 5].forEach(function (n) {
          var bt = document.createElement('button'); bt.textContent = n === 1 ? 'Make' : '×5';
          bt.disabled = !r.can || (n > 1 && r.inputs.some(function (g3) { return g3.have < g3.qty * n; }));
          bt.onclick = function () { send({ type: 'craft', recipe: r.id, qty: n }); };
          btns.appendChild(bt);
        });
        row.title = r.reason || '';
        row.appendChild(pic); row.appendChild(name); row.appendChild(btns); box.appendChild(row);
      });
    });
  }
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
      var eats = World.itemCan(it, 'consume');
      if (eats || World.itemCan(it, 'throw')) name.appendChild(slots(s.item, 'belt'));
      if (eats || it.slot) {
        var b = document.createElement('button');
        b.textContent = eats ? 'Use' : (equipped ? 'Unequip' : 'Equip');
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
  $('craft-close').onclick = toggleCraft;
  $('build-close').onclick = toggleBuild;
  $('store-close').onclick = closeStore;
  $('claim-close').onclick = closeClaim;

  // ---------------------------------------------------------------- map and loop
  function enterMap() {
    armed = null; throwing = null;
    watchLive();                          // (re)subscribe to live monster/player pushes for this map
    hud();
    setNet('loading art…');
    // the art of every floor of this building: the floors below are drawn too when you stand upstairs
    var famMaps = World.floorsOf(content, me.map).map(function (f) { return content.maps[f.id]; }).filter(function (m) { return m && m.id !== me.map; });
    return Promise.all([Assets.loadForMap(content, mapOf())].concat(famMaps.map(function (m) { return Assets.loadForMap(content, m); }))).then(function () {
      renderer.setMap(mapOf());
      timed = mapOf().entities.filter(function (e) {
        var o = content.objects[e.ref]; return o && o.kind === 'trap' && World.props(content, e).trigger === 'timed';
      });
      shown.x = me.x; shown.y = me.y; shownOthers = {};
      setNet(api.mode !== 'offline' ? 'connected' : api.usingDraft ? 'offline: playing your editor draft' : 'offline: progress saved in this browser');
      $('map-pick').value = me.map;
    });
  }

  var TAP_JOIN_MS = 35;
  // Glide towards where the character really is, k tiles of DISTANCE per call: a diagonal step is longer, so it
  // takes longer (about 1.4 times), which is also what the referee charges for it.
  function ease(cur, target, k) {
    var dx = target.x - cur.x, dy = target.y - cur.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) { cur.x = target.x; cur.y = target.y; return; }
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= k || dist < 1e-6) { cur.x = target.x; cur.y = target.y; return; }
    cur.x += dx / dist * k; cur.y += dy / dist * k;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!renderer || !renderer.map || !me) return;
    var moveMs = content.config.move_ms || 140;
    var dt = Math.min(100, lastFrame ? now - lastFrame : 16); lastFrame = now;
    var moving = Math.abs(shown.x - me.x) > 0.01 || Math.abs(shown.y - me.y) > 0.01;
    if (floorWait && now - floorWait > 1500) floorWait = 0;      // the answer never came: carry on
    if (!moving && !bagOpen && !floorWait) {
      // A tap waits a moment before stepping, so two keys pressed together count as one diagonal step, not an L.
      if (tap) { if (performance.now() - holdSince >= TAP_JOIN_MS) { step(heldDir() || tap); tap = null; lastStep = now; } }
      else if (held.length && now - holdSince >= HOLD_MS && now - lastStep >= moveMs * lastCost) { step(heldDir()); lastStep = now; }
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
    // hold-to-fire: while aiming with the left button down, a semi/auto weapon keeps firing on its cadence
    if (aiming && leftHeld && hover) {
      var hw = World.rangedWeapon(content, me);
      if (hw && (hw.fireMode === 'semi' || hw.fireMode === 'auto')) {
        var cost = hw.ammoCost || 1, clip = Number(hw.clip) || 0, mag = (me.mags && me.mags[hw.id]) || 0;
        var canFire = clip > 0 ? mag >= cost : (hw.ammo ? count(hw.ammo) >= cost : true);
        var cd = Math.max(120, Number(hw.fireMs) || 300);
        if (canFire && now - lastHoldShot >= cd) shootAt(hover);   // shootAt sets lastHoldShot + facing
      }
    }
    var myst = me.statuses && me.statuses.length && content.statuses[me.statuses[0].id];
    // while aiming, the body faces the cursor's side derived from the aim angle — not me.facing, which a
    // poll can briefly reset to the server's value (it never hears the aim), which would flicker the flip.
    var myFacing = aiming ? (Math.cos(aimAngle) < 0 ? 'W' : 'E') : me.facing;
    var actors = [{ x: shown.x, y: shown.y, facing: myFacing, name: me.name, hp: me.hp, maxHp: me.maxHp, me: true, layers: playerLayers(me) || undefined, aim: aiming ? aimAngle : null, statusColor: myst ? myst.color : '' }];
    var seen = {};
    view.monsters.forEach(function (m) {
      var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, s = shownOthers[m.id] || (shownOthers[m.id] = { x: m.x, y: m.y });
      ease(s, m, dt / 250); seen[m.id] = 1;
      var stc = m.statuses && m.statuses.length && content.statuses[m.statuses[0]];
      var lay = monsterLayers(m);                                        // paper-doll zombies carry a rolled look
      // sprite '' (not undefined) keeps the monster health-bar colour + no name label even when layered
      actors.push({ x: s.x, y: s.y, facing: m.facing, name: d.name, sprite: lay ? '' : (d.sprite || ''),
        layers: lay || undefined, hp: m.hp, maxHp: m.maxHp, statusColor: stc ? stc.color : '' });
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
    // Aim lean (config aim_lean, 0-1, default 0.25; 0 = off): the camera eases toward the cursor by that share
    // of the cursor's distance from the screen centre, and eases back when the button is released.
    var leanK = content.config.aim_lean === undefined || content.config.aim_lean === '' ? 0.25 : Number(content.config.aim_lean);
    if (!(leanK >= 0 && leanK <= 1)) leanK = 0.25;
    var lt = { x: 0, y: 0 };
    if (aiming && lastPtr && leanK > 0) {
      var cr = canvas.getBoundingClientRect();
      lt.x = ((lastPtr.clientX - cr.left) * canvas.width / cr.width - canvas.width / 2) * leanK;
      lt.y = ((lastPtr.clientY - cr.top) * canvas.height / cr.height - canvas.height / 2) * leanK;
    }
    var lk0 = Math.min(1, (dt || 16) / 140);
    lean.x += (lt.x - lean.x) * lk0; lean.y += (lt.y - lean.y) * lk0;
    if (Math.abs(lean.x) < 0.5 && !lt.x) lean.x = 0; if (Math.abs(lean.y) < 0.5 && !lt.y) lean.y = 0;
    cam.x = Math.round(cam.x + lean.x); cam.y = Math.round(cam.y + lean.y);
    if (map.width * T >= canvas.width) cam.x = clamp(cam.x, 0, map.width * T - canvas.width);      // never past the map's edge
    if (map.height * T >= canvas.height) cam.y = clamp(cam.y, 0, map.height * T - canvas.height);
    var states = view.states;
    if (timed.length) {
      states = Object.assign({}, view.states);
      var clock = Date.now() + clockOffset;
      timed.forEach(function (e) { states[e.key] = World.liveState(content, e, clock, view.states); });
    }
    lastCam = cam;
    if ((lean.x || lean.y) && lastPtr) { hover = cellAt(lastPtr); if (aiming && me) aimAt(lastPtr); }   // the world moved under a still cursor
    // Remember the room the local player is standing in — immediately and without waiting on the server,
    // merged with the server's persisted `explored`.
    if (me && World.roofZoneAt) {
      var curZ = World.roofZoneAt(map, Math.round(me.x), Math.round(me.y));
      if (curZ) (seenZones[me.map] || (seenZones[me.map] = {}))[curZ] = 1;
    }
    var explored = Object.assign({}, me && me.explored && me.explored[me.map], me && seenZones[me.map]);
    // What the player can see right now. Config `sight` = off turns the whole system off (everything shown).
    // Recomputed when the player changes cell or the world's states change (and at least every 250 ms, so a
    // door predicted open is picked up); the opening overlay it reads also keeps move prediction honest.
    var vis = null, mem = null;
    if (me && String(content.config.sight || 'on') !== 'off') {
      var sKey = me.map + ':' + me.x + ',' + me.y, tNow = Date.now();
      if (sight.key !== sKey || sight.states !== view.states || tNow - sight.at > 250) {
        var lkS = World.viewLookup(content, map, view, me);
        World.syncEdgesView(content, map, lkS.stateOf);
        var sr = World.sightRadius(content, map);                    // further from an upper floor
        sight = { key: sKey, states: view.states, at: tNow, vis: World.visibleCells(content, map, me.x, me.y, sr, lkS.stateOf) };
        mem = seenCells[me.map] || (seenCells[me.map] = {});
        for (var vk in sight.vis) if (sight.vis[vk] === 1) mem[vk] = 1;   // 2 = a peek through a window: seen now, not remembered
      }
      vis = sight.vis; mem = seenCells[me.map];
    }
    renderer.draw(cam, actors, { states: states, hidden: hiddenEntity, explored: explored, vis: vis, memory: mem, sensed: null, floorActors: floorActors() });
    if (building) { var gh0 = buildTarget(); renderer.drawClaims(cam, World.claimsOn(content, mapOf()), me, gh0); renderer.drawGhost(cam, gh0); }
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
    if ((o.kind === 'spawn' || o.kind === 'trigger') && !o.sprite) return true;   // spriteless markers are editor-only; a sprited one (a nest, portal…) is a visible spawner
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
      var o = document.createElement('option'); o.value = id; o.textContent = content.maps[id].name + (content.maps[id].z ? ' (floor ' + content.maps[id].z + ')' : ''); sel.appendChild(o);
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
    // …unless the character is already somewhere in that building: a floor is a map of its own, and reopening the
    // page must leave you on the floor and the spot you were on, not send you back to the ground floor's start.
    if (want && api.mode === 'offline' && content.maps[want] && World.groundId(content, want) !== World.groundId(content, res.player.map)) return api.warp(want);
    return res;
  }).then(apply).then(function () {
    setupDebug();
    log('WASD / arrows move · hold right-click to aim (left-click fires toward the cursor; R reloads) · left-click to interact, hold it for options · F/Space to use or attack what you face · Q/E abilities · 1-5 belt · I bag · C craft · B build.', 'info');
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
    aim: function () { return { aiming: aiming, aimAngle: aimAngle, facing: me && me.facing, armed: armed, throwing: throwing, hover: hover, check: armed && hover ? aimCheck(hover) : null }; } };
})();
