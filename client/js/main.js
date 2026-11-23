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
  var buildRoof = false;                 // placing a floor blueprint as a ROOF over the storey you stand on (V switches)
  var moveTool = null;                                      // the move tool (the Build panel): null | {key: null} picking something you built | {key, bp} carrying it to its new spot
  var removing = false, wallsDown = false;                // wallsDown (H, while removing): walls drawn as stubs so what is behind can be picked                                   // the remove tool (X, or the Build panel): a click takes apart what you built
  var armed = null;                      // {slot, id, skill} while an ability (Q/E) waits for a target
  var throwing = null;                   // belt item id armed for a throw (click to throw, Esc to cancel)
  // mouse: right-button held = aiming; left = interact (tap) / action list (hold) / fire (while aiming)
  var aiming = false, leftHeld = false, holdFired = false, pendingCell = null, holdMenuEvt = null, holdTimer = 0;
  var lastHoldShot = 0, aimAngle = 0, aimFar = null, HOLD_CLICK_MS = 250;   // left-press longer than this opens the action list
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
    var cls = p && content.classes[p['class']], body = cls && (World.bodySprite ? World.bodySprite(content, p) : cls.bodySprite);   // the man's or the woman's
    if (!body) return null;
    var eq = p.equipment || {}, out = [{ z: SLOT_Z.body, path: body, skin: p.skin || '', skinAll: true }];
    if (p.hair && !eq.helm) {                                            // hair is whole-tintable; a helm hides it
      out.push({ z: SLOT_Z.head, path: p.hair, mask: maskOf(p.hair), ramp: Tint.TINTS[p.hairColor] });
    }
    Object.keys(eq).forEach(function (slot) {
      var it = content.items[eq[slot]];
      if (!it || !it.wornSprite) return;
      var ramp = it.defaultTint ? Tint.TINTS[it.defaultTint] : null;     // item is tintable iff it names a default tint
      // A weapon with a magazine may look different empty or being reloaded (a bow: no arrow / being drawn). Yours is
      // known from your own magazine and reload; another player's comes with them (wst).
      var wpath = it.wornSprite;
      if (slot === 'weapon' && (it.wornEmpty || it.wornReload || it.wornAim)) {
        var wst = p.mags ? (World.weaponState ? World.weaponState(content, p) : '') : (p.wst || '');
        if (wst === 'reload') wpath = it.wornReload || it.wornEmpty || wpath; else if (wst === 'empty') wpath = it.wornEmpty || wpath;
        else if (p === me && aiming && it.wornAim) wpath = it.wornAim;   // loaded and aimed (yours only: nobody is told where another player aims)
      }
      out.push({ z: SLOT_Z[slot] != null ? SLOT_Z[slot] : 9, path: wpath, slot: slot, skin: slot === 'weapon' || slot === 'offhand' ? (p.skin || '') : '',
        mask: ramp ? maskOf(wpath) : '', ramp: ramp, aimPoints: it.aim || null });
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
  // The same layer for the OTHER floors of the building you are in ({floorId: struct}), so they are drawn, seen
  // through and aimed at as they really are. Offline and on a LAN it comes with the answers (only when it
  // changed: api.floorRevs says what we hold); online each building's floors are pushed (api.watchStructs).
  var floorStructs = {}, floorVer = 0, floorBuilding = '';
  function floorMap(id) {
    if (me && id === me.map) return mapOf();
    var st = floorStructs[id], base = content.maps[id];
    return st && st.rev ? World.liveMapFromStruct(content, base, st) : base;
  }
  function floorMaps() {
    var out = {};
    World.floorsOf(content, me.map).forEach(function (f) { if (f.id !== me.map) out[f.id] = floorMap(f.id); });
    return out;
  }
  function setFloorStruct(id, st) {
    if (((floorStructs[id] || {}).rev || 0) === ((st && st.rev) || 0)) return false;
    if (st && st.rev) floorStructs[id] = st; else delete floorStructs[id];
    var revs = {}; Object.keys(floorStructs).forEach(function (k) { revs[k] = floorStructs[k].rev; });
    api.floorRevs = revs; floorVer++;
    return true;
  }
  /** A floor's layer changed: load any new art, then bake that floor again. */
  function floorChanged(id) {
    if (!me || !renderer || !renderer.map || id === me.map) return;
    var at = me.map;
    Assets.loadForMap(content, floorMap(id)).then(function () { if (me && me.map === at) renderer.setMap(mapOf(), floorMaps()); });
  }
  function takeFloorStructs(w) {
    var g = World.groundId(content, me.map);
    if (g !== floorBuilding) { floorBuilding = g; floorStructs = {}; api.floorRevs = {}; floorVer++; }
    if (!w || !w.floors) return;
    Object.keys(w.floors).forEach(function (id) {
      var f = w.floors[id];
      if (f.struct ? setFloorStruct(id, f.struct) : (!f.structRev && setFloorStruct(id, null))) floorChanged(id);
    });
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
    api.at = p && p.map;                                    // told to the referee with the next request (who to read around you)
    // An answer without monsters = the referee knows they are being pushed to us: keep the ones we hold.
    if (res.world && !res.world.monsters) res.world.monsters = (view && me && p && view.map === res.world.map && view.monsters) || [];
    if (res.world) rememberLooks(res.world.players);
    var holdQ = queue.filter(function (a) { return a.type === 'hold'; }).pop();
    if (holdQ && p && typeof p.held === 'number') p = predictHold(p, holdQ.slot);   // a slot choice still on its way: keep showing it
    var moving = queue.some(function (a) { return a.type === 'move'; });
    if (!me || p.map !== me.map) {
      floorWait = 0;
      me = p; view = res.world; struct = null; takeStruct(res.world); takeFloorStructs(res.world); handleEvents(res.events);
      questsChanged();
      return enterMap();
    }
    // keep our predicted position while moves are still on their way; otherwise trust the server
    me = moving ? Object.assign({}, p, { x: me.x, y: me.y, facing: me.facing }) : p;
    view = res.world;
    takeFloorStructs(res.world);
    if (takeStruct(res.world)) { renderer.setMap(mapOf(), floorMaps()); sight.key = ''; }   // something was built or broken: redraw walls, re-check sight
    handleEvents(res.events);
    hud();
    if (bagOpen) bag();
    if (craftOpen) craftPanel();
    if (buildOpen) buildPanel();
    if (storage) storePanel();
    questsChanged();
    return Promise.resolve();
  }

  /**
   * A live world update pushed from Firebase (online, when FIREBASE_URL is set): refresh the moving
   * things — monsters and other players — between polls, so they glide in near-real-time. Your own
   * player, object states and events still come from the poll/act replies (authoritative, per-player).
   */
  // How each other player looks (class, gear, hair), for as long as this page is open. An answer stops listing someone
  // who has been still for a minute, and a push may name them again before the next answer does: without this they
  // came back as the plain figure. What an answer or a push says about looks always replaces what is remembered.
  var playerLooks = {};
  function rememberLooks(list) {
    (list || []).forEach(function (q) {
      if (q['class']) playerLooks[q.id] = { 'class': q['class'], equipment: q.equipment || {}, hair: q.hair || '', hairColor: q.hairColor || '', body: q.body || '', skin: q.skin || '' };
      else if (playerLooks[q.id]) Object.assign(q, playerLooks[q.id]);
    });
  }
  function mergeLiveWorld(w) {
    if (!me || !w || w.map !== me.map) return;                 // ignore a push for a map we've already left
    if (w.monsters) view.monsters = w.monsters;
    if (w.players) {
      // A push says where the others are; how they LOOK (class, gear, hair) may only have come with an answer.
      // Keep what we know of each, or they flicker to the plain figure on every push.
      var known = {}; (view.players || []).forEach(function (q) { known[q.id] = q; });
      view.players = w.players.filter(function (q) { return q.id !== me.id; }).map(function (q) {
        var out = Object.assign({}, known[q.id] || {}, q);
        if (!out.equipment) out.equipment = {};               // (the database drops an empty one)
        return out;
      });
      rememberLooks(view.players);
    }
    if (w.now) clockOffset = w.now - Date.now();
  }
  /**
   * A host that runs a loop (host/server.js) sends every turn's changes down its socket, unasked: the same thing an
   * answer carries. With nothing of ours on its way it is taken as an answer. While an action is still out, its own
   * answer has the last word on us (what we predicted must not be undone), so only the others are refreshed.
   */
  function takePush(res) {
    if (!me || !view || !res || !res.player || !res.world) return;
    if (inFlight || queue.length) {
      var w = res.world;
      if (typeof res.seq === 'number') since = res.seq;
      if (w.map === me.map) {
        mergeLiveWorld(w);
        takeFloorStructs(w);
        if (takeStruct(w) && renderer) { renderer.setMap(mapOf(), floorMaps()); sight.key = ''; }
      }
      handleEvents(res.events);
      return;
    }
    var asked = lastReply;                                  // a push is not an answer: keep asking now and then, so the host knows we are here
    apply(res);
    lastReply = asked;
  }
  // The other floors of the building you are in: what stands on each, so the ones you have a clear view of can be
  // drawn. Online each floor's public view is pushed on its own; offline and on a LAN it comes with the answer.
  var floorWorlds = {}, floorUnwatch = [];
  function watchLive() {
    if (liveUnwatch) { liveUnwatch(); liveUnwatch = null; }
    floorUnwatch.forEach(function (stop) { stop(); }); floorUnwatch = []; floorWorlds = {};
    if (!api.watchMap || !me) return;
    liveUnwatch = api.watchMap(me.map, mergeLiveWorld, true);
    if (api.watchStructs && World.floorsOf(content, me.map).length > 1) floorUnwatch.push(api.watchStructs(World.groundId(content, me.map), function (id, rec) {
      var st = null; try { st = rec && rec.json ? JSON.parse(rec.json) : null; } catch (e) { st = null; }
      if (content.maps[id] && setFloorStruct(id, st)) floorChanged(id);
    }));
    World.floorsOf(content, me.map).forEach(function (f) {
      if (f.id !== me.map) floorUnwatch.push(api.watchMap(f.id, function (w) { if (w && w.map === f.id) floorWorlds[f.id] = w; }));
    });
  }
  /**
   * The ground you can see on the floors BELOW from where you stand (over a balcony edge, out of a window you are
   * at): [{ dz, cells: {"x,y": 1} }]. The renderer shows those cells clearly and leaves the rest dim. Worked out
   * again only when you move or a moment has passed (a door upstairs may have opened).
   */
  // The floors below are drawn lower on the screen, one wall-height per floor, so a cell of a lower floor can land
  // on the same spot of the screen as a cell of a HIGHER one (a floor in between, or your own) — and the higher
  // one is nearer the camera: it covers it. Is the cell (x,y) of floor z hidden like that?
  function coveredFrom(z, x, y) {
    var myZ = mapOf().z || 0;
    return World.floorsOf(content, me.map).some(function (g) {
      if (g.z <= z || g.z > myZ) return false;
      var gm = floorMap(g.id), gy = y + (g.z - z) * Rules.WALL_H;
      return !!(gm && gm.terrain[gy] && gm.terrain[gy][x]);
    });
  }
  var floorSightMemo = { key: '', t: 0, out: [] };
  function floorSight() {
    var map = mapOf(), myZ = map.z || 0;
    if (myZ <= 0) return [];
    var key = me.map + ':' + me.x + ',' + me.y + ':' + floorVer, nowT = performance.now();
    if (floorSightMemo.key === key && nowT - floorSightMemo.t < 400) return floorSightMemo.out;
    var out = [], sf = lookup().stateOf, rad = World.sightRadius(content, map);
    World.floorsOf(content, me.map).forEach(function (f) {
      if (f.z >= myZ || f.z < 0) return;
      var fm = floorMap(f.id), cells = {}, any = false;
      var xa = Math.max(0, me.x - rad), xb = Math.min(fm.width - 1, me.x + rad), ya = Math.max(0, me.y - rad), yb = Math.min(fm.height - 1, me.y + rad);
      for (var y = ya; y <= yb; y++) for (var x = xa; x <= xb; x++)
        if (World.seesAcross(content, map, me.x, me.y, fm, x, y, rad, sf) && !coveredFrom(f.z, x, y)) { cells[x + ',' + y] = 1; any = true; }
      if (any) out.push({ dz: f.z - myZ, cells: cells });
    });
    floorSightMemo = { key: key, t: nowT, out: out };
    return out;
  }
  /** Which doors stand open (and the like) on the other floors of the building: { floorId: {entityKey: state} }. */
  var doorsMemo = {};
  function floorStates() {
    var out = {};
    World.floorsOf(content, me.map).forEach(function (f) {
      if (f.id === me.map) return;
      var w = floorWorlds[f.id] || (view.floors && view.floors[f.id]); if (!w) return;
      var st = w.states;
      if (!st && w.doors) {                                              // online it comes as text; read it once per change
        var memo = doorsMemo[f.id];
        if (!memo || memo.text !== w.doors) { memo = doorsMemo[f.id] = { text: w.doors, st: null }; try { memo.st = JSON.parse(w.doors); } catch (e) { memo.st = null; } }
        st = memo.st;
      }
      if (st) out[f.id] = st;
    });
    return out;
  }
  /** Creatures on other floors that you can see from where you stand: [{ dz, actors }] for the renderer. */
  var shownFloor = {};
  function floorActors(dt) {
    var keep = {};
    function glide(key, a, k) { var q = shownFloor[key] || (shownFloor[key] = { x: a.x, y: a.y }); ease(q, a, k); keep[key] = 1; return q; }
    var out = [], map = mapOf(), myZ = map.z || 0, fam = World.floorsOf(content, me.map);
    if (fam.length < 2) return out;
    var sf = lookup().stateOf;
    fam.forEach(function (f) {
      if (f.id === me.map) return;
      var w = floorWorlds[f.id] || (view.floors && view.floors[f.id]); if (!w) return;
      var fm = floorMap(f.id), dz = f.z - myZ, list = [];
      if (!Object.prototype.hasOwnProperty.call(fm, '_edgeOv')) World.syncEdgesView(content, fm, function () { return ''; });   // its windows and arches, so sight through them works both ways
      var rad = World.sightRadius(content, dz < 0 ? map : fm);
      function inView(x, y) { return dz < 0 ? World.seesAcross(content, map, me.x, me.y, fm, x, y, rad, sf) && !coveredFrom(f.z, x, y) : World.seesAcross(content, fm, x, y, map, me.x, me.y, rad); }
      (w.monsters || []).forEach(function (m) {
        if (!inView(m.x, m.y)) return;
        var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, lay = monsterLayers(m);
        var gm = glide(f.id + ':' + m.id, m, (dt || 16) / 250);            // drawn gliding; tx,ty = the tile it is really on
        list.push({ x: gm.x, y: gm.y, tx: m.x, ty: m.y, facing: m.facing, name: d.name, sprite: lay ? '' : (d.sprite || ''), layers: lay || undefined, hp: m.hp, maxHp: m.maxHp, fmap: f.id, monster: true });
      });
      (w.players || []).forEach(function (q) {
        if (q.id === me.id || !inView(q.x, q.y)) return;
        var gq = glide(f.id + ':p:' + q.id, q, (dt || 16) / (content.config.move_ms || 140));
        list.push({ x: gq.x, y: gq.y, tx: q.x, ty: q.y, facing: q.facing, name: q.name, tint: '#b6553d', layers: playerLayers(q['class'] || !playerLooks[q.id] ? q : Object.assign({}, q, playerLooks[q.id])) || undefined, hp: q.hp, maxHp: q.maxHp });   // (someone on another floor is known by pushes only)
      });
      if (list.length) out.push({ dz: dz, actors: list });
    });
    Object.keys(shownFloor).forEach(function (k) { if (!keep[k]) delete shownFloor[k]; });
    seenOnFloors = out;
    return out;
  }
  // A creature on another floor is DRAWN a wall-height up or down the screen per floor, so the tile under the
  // cursor (on your own floor's grid) stands for a different tile of that floor: the same x, and y + dz storeys.
  var seenOnFloors = [];
  /** The monster on another floor that is drawn at this cell of your view, if you can see one there: {map, x, y, name}. */
  function floorTargetAt(cell) {
    for (var i = 0; i < seenOnFloors.length; i++) {
      var f = seenOnFloors[i];
      for (var k = 0; k < f.actors.length; k++) {
        var a = f.actors[k];
        if (a.monster && a.tx === cell.x && a.ty === cell.y + f.dz * Rules.WALL_H) return { map: a.fmap, x: a.tx, y: a.ty, name: a.name, dz: f.dz };
      }
    }
    return null;
  }
  /** Shoot something seen on another floor of the building. `cell` is where it is drawn (for the tracer). */
  function shootFloor(ft, cell) {
    var chk = World.shotAcross(content, me, mapOf(), floorMap(ft.map), ft.x, ft.y, lookup().stateOf);
    if (!chk.ok) { log(chk.reason, 'info'); return; }
    var w = chk.weapon, cost = w.ammoCost || 1, ammoName = content.items[w.ammo] ? content.items[w.ammo].name.toLowerCase() : w.ammo;
    if (me.reload) return;
    if (Number(w.clip) > 0) {
      if (((me.mags && me.mags[w.id]) || 0) < cost) { if (count(w.ammo) >= cost) startReload(); else log('Out of ' + ammoName + '.', 'info'); return; }
    } else if (w.ammo && count(w.ammo) < cost) { log('Out of ' + ammoName + '.', 'info'); return; }
    if (!aiming) me.facing = facingToward(cell.x, cell.y);
    lastHoldShot = performance.now();
    send({ type: 'shoot', map: ft.map, x: ft.x, y: ft.y });
    fx.push({ kind: 'tracer', from: { x: me.x, y: me.y }, to: { x: cell.x, y: cell.y }, color: w.tint || '#ffd36b', t0: performance.now(), life: 160 });
  }

  var COLORS = { hit: '#ff6b5b', heal: '#6fe08a', loot: '#ffd65a', level: '#ffd65a', kill: '#ffffff', death: '#ff6b5b' };
  function handleEvents(events) {
    var now = performance.now();
    (events || []).forEach(function (e, i) {
      if (e.type === 'npc') { openNpc(e); return; }            // you talked to someone: their window (or, with nothing to offer, a line)
      if (e.text) log(e.text, e.type);
      if (e.type === 'craft') { if (!craftOpen) toggleCraft(); return; }   // you used a workbench / campfire: show what can be made
      if (e.type === 'claim') { claim = e; $('claimp').hidden = false; claimPanel(); return; }       // your claim flag: who belongs to the base
      if (e.type === 'storage' && e.gone) { if (storage && storage.key === e.key) closeStore(); return; }   // a carcass taken clean: it is gone
      if (e.type === 'storage') { storage = e; storePanel(); return; }   // you opened (or changed) a storage container
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
      if (e.type === 'hit' && e.amount && e.by && e.by !== me.id) return;   // another player's swing: drawn from their `act` (othersAct), sooner than this
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
    else if (action.type === 'hold' && last && last.type === 'hold' && !last.sent) last.slot = action.slot;   // scrolling past slots: only the last one matters
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
    // (an action sent while this was on its way is waiting in the queue: send it as soon as the answer is in)
    api.poll(since).then(function (res) { inFlight = false; return apply(res); }).then(flush)
      .catch(function (e) { inFlight = false; setNet('connection problem: ' + e.message, true); if (queue.length) setTimeout(flush, 2000); });
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
    me = Object.assign({}, me, { facing: Rules.faceFor(dir, me.facing) }, r.ok ? { x: r.x, y: r.y } : {});
    lastCost = r.ok ? Rules.stepCost(dir) : 1;
    send({ type: 'move', dirs: [dir] });
  }
  function interact() { if (me) send({ type: 'interact' }); }
  function useItem(id) { send({ type: 'use', item: id }); }

  // ---------------------------------------------------------------- input
  // when the player last did anything (see the heartbeat in the loop)
  var lastInput = performance.now();
  ['keydown', 'mousedown', 'wheel', 'pointermove', 'touchstart'].forEach(function (t) { addEventListener(t, function () { lastInput = performance.now(); }, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) lastInput = performance.now(); });
  function press(d) { held = held.filter(function (h) { return h !== d; }).concat(d); tap = d; holdSince = performance.now(); }
  addEventListener('keydown', function (e) {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
    var d = KEYS[e.code];
    if (d) { e.preventDefault(); if (!e.repeat) press(d); return; }
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF') { e.preventDefault(); interact(); }
    else if (e.code === 'KeyI') toggleBag();
    else if (e.code === 'KeyB') toggleBuild();
    else if (e.code === 'KeyX') { if (removing) stopBuilding(); else startRemoving(); }
    else if (e.code === 'KeyH' && removing) { wallsDown = !wallsDown; log(wallsDown ? 'Walls shown low: point at the base of a wall to pick it.' : 'Walls shown whole: point at the face of a wall to pick it.', 'info'); }
    else if (e.code === 'KeyC') toggleCraft();
    else if (e.code === 'KeyL') toggleQuests();
    else if (e.code === 'KeyT') turnBuild(1);
    else if (e.code === 'KeyV' && building && content.blueprints[building] && content.blueprints[building].places === 'tile') {
      buildRoof = !buildRoof; if (buildOpen) buildPanel(); log(buildRoof ? 'Roof: click cells of this storey to cover them (V: back to floor).' : 'Floor: click where it should be laid (V: as a roof).', 'info');
    }
    else if (e.code === 'Escape') { closeMenu(); if (armed) disarm(); else if (throwing) { if (holdMode()) selectSlot(-1); else cancelThrow(); } else if (introOpen) closeIntro(); else if (claimQuest) closeClaimQuest(); else if (npcTalk) closeNpc(); else if (questOpen) toggleQuests(); else if (claim) closeClaim(); else if (storage) closeStore(); else if (buildOpen) toggleBuild(); else if (building || removing || moveTool) stopBuilding(); else if (craftOpen) toggleCraft(); else if (bagOpen) toggleBag(); }
    else if (e.code === 'KeyQ' && skillsOn()) ability(0);
    else if (e.code === 'KeyE' && skillsOn()) ability(1);
    else if (e.code === 'KeyR') startReload();
    else if (/^Digit[0-9]$/.test(e.code) && me && (Number(e.code.slice(5)) + 9) % 10 < BELT) beltKey((Number(e.code.slice(5)) + 9) % 10);   // 1-9, then 0 = the tenth
  });
  addEventListener('keyup', function (e) {
    var d = KEYS[e.code]; if (d) held = held.filter(function (h) { return h !== d; });
  });
  addEventListener('blur', function () { held = []; aiming = false; leftHeld = false; buildHold = null; clearTimeout(holdTimer); updateCursor(); });
  function cellAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    var px = (e.clientX - r.left) * canvas.width / r.width + lastCam.x, py = (e.clientY - r.top) * canvas.height / r.height + lastCam.y;
    if (!Render.pickCells) return { x: Math.floor(px / T), y: Math.floor(py / T) };
    return sameLevelPick(Render.pickCells(mapOf(), px, py, T));                 // (raised ground: the tile drawn under the cursor)
  }
  /** Raised ground is drawn over the ground behind it, so the cursor may be on several tiles at once (the one on top
   *  first). The one on top is meant, unless there is nothing to do there and a tile under it that is ON YOUR OWN LEVEL
   *  has something (a creature, a chest): then that one — higher ground does not get in the way of what is beside you. */
  function sameLevelPick(cells) {
    if (cells.length < 2 || !me || !view) return cells[0];
    var map = mapOf(), lk = lookup(), mine = Rules.groundHeight(map, me.x + 0.5, me.y + 0.5);
    function busy(c) { return !!lk.monsterAt(c.x, c.y) || World.actionsAt(content, map, lk, me, c.x, c.y).length > 0; }   // a creature, or something to use
    if (busy(cells[0])) return cells[0];
    for (var i = 1; i < cells.length; i++) {
      if (Math.abs(Rules.groundHeight(map, cells[i].x + 0.5, cells[i].y + 0.5) - mine) < 1 && busy(cells[i])) return cells[i];
    }
    return cells[0];
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
      if (buildOpen || building || removing || moveTool) { buildBack(); return; }   // build mode: a right-click goes one step back, wherever it lands
      aiming = true; aimAt(e); updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (buildOpen && !building && !removing && !moveTool) { buildClick(); return; }   // build mode, nothing in hand yet: the click is the bar's, wherever it lands
    closeMenu();
    hover = cell; lastPtr = { clientX: e.clientX, clientY: e.clientY };   // the click itself says where (no move may have come first)
    if (moveTool) {                                         // move tool: a click picks what is outlined, the next one puts it down
      if (!moveTool.key) {                                // press on it and hold: it is in hand until the button is let go
        var mt = moveTarget();
        if (mt) { if (mt.ok) { moveTool = { key: mt.target.key, bp: mt.bp }; buildFacing = Rules.facingOf(mt.info.e || mt.info.rec || {}); buildPanel(); } else log(mt.reason, 'info'); }
      }
      return;
    }
    if (removing) {                                       // remove tool: a click takes apart what is outlined
      var rt = removeTarget();
      if (rt) { if (rt.ok) send({ type: 'dismantle', target: rt.target }); else log(rt.reason, 'info'); }
      return;
    }
    if (building) {                                       // build mode: a click places the blueprint where the ghost is
      var bt = buildTarget();
      if (bt) { if (bt.ok) send({ type: 'build', bp: building, x: bt.x, y: bt.y, side: bt.side, off: bt.off, facing: bt.facing, roof: bt.roof || undefined }); else log(bt.reason, 'info'); }
      if (bt && bt.side) buildHold = { side: bt.side, x: bt.x, y: bt.y, off: bt.off, repeat: bt.bp.places === 'wall', last: bt.x + ',' + bt.y };
      return;
    }
    if (armed) { castAt(cell); return; }                  // an armed ability still aims + casts on left-click
    if (throwing) { throwAt(cell); return; }
    if (aiming && heldUse()) { useHeld(); return; }       // food, a bandage… in hand: the click uses it
    if (aiming) { leftHeld = true; fireToward(cell); return; }   // fire/attack while aiming
    if (World.harvestWith && World.harvestWith(content, mapOf(), me, cell.x, cell.y)) {
      leftHeld = true; holdFired = false; pendingCell = null; clearTimeout(holdTimer);
      harvesting = { x: cell.x, y: cell.y }; harvestSwing();
      return;
    }
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
  function count(id) { var n = 0; (me.inventory || []).forEach(function (x) { if (x.item === id) n += x.qty; }); return n; }   // (an item may be in several stacks)
  function facingToward(x, y) {
    var dx = x - me.x, dy = y - me.y;
    if (!dx && !dy) return me.facing;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
  }
  /** What a quick click (or the pointer cursor) goes for: the first action that is not a change to something built —
   *  taking apart, sliding, turning, and hitting your own work are deliberate (the held-click list, or the remove tool). */
  function tapAction(acts) { return acts.filter(function (a) { return a.type !== 'dismantle' && a.type !== 'shift' && a.type !== 'turn' && !(a.type === 'attack' && a.own); })[0] || null; }
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
  /**
   * Reload the gun in hand (R, or a click on an empty magazine). It takes the gun's reload time: the referee holds
   * the rounds back until then (me.reload = {id, at, until}, in the referee's clock) and the circle by the ammo
   * count fills meanwhile. The reload is shown from the moment it is asked for; the referee's answer confirms it.
   */
  function startReload() {
    var w = me && World.rangedWeapon(content, me);
    if (!w || me.reload) return;
    if (Number(w.clip) > 0 && ((me.mags && me.mags[w.id]) || 0) < Number(w.clip) && count(w.ammo) > 0) {
      var ms = World.reloadMsOf ? World.reloadMsOf(content, w) : 0, t = serverNow();
      if (ms > 0) me.reload = { id: w.id, at: t, until: t + ms };
    }
    send({ type: 'reload' });                                   // (also when there is nothing to load: the referee says why)
  }
  // ---- marks over heads: small signs above a character that follow it (the reload ring over you, "!" over a
  // monster that has just seen someone, "?" over one that has just lost them). One place for all of them: give
  // setMarks the list for this frame — {id, kind, x, y: the character's tile (fractions while it moves),
  // up: how far above the tile's top, in view pixels, p: 0..1 for kinds that fill} — and it keeps the page in step.
  var MARKS = {
    reload: '<svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="16"/><circle class="arc" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"/>' +
      '<path class="round" d="M20 10.500c2.300 2.700 3 5.300 3 8v7.500h-6V18.500c0-2.700.7-5.300 3-8zM17 27.500h6v2h-6z"/></svg>',
    craft: '<svg viewBox="0 0 40 40"><circle class="track" cx="20" cy="20" r="16"/><circle class="arc" cx="20" cy="20" r="16" transform="rotate(-90 20 20)"/>' +
      '<path class="round" d="M13 14h11v5h-4v10h-3V19h-4z"/></svg>',   // the same ring, with a hammer
    alert: '!', search: '?',
    quest: '!', questdone: '?', questgo: '?'      // over an NPC: has a quest for you / one to hand in / one of theirs under way
  };
  var markEls = {};
  function setMarks(list) {
    var box = $('marks'), T = content.config.tile_size || 32, k = canvas.getBoundingClientRect().width / canvas.width, live = {};
    list.forEach(function (mk) {
      var el = markEls[mk.id];
      if (!el || el._kind !== mk.kind) {
        if (el) el.remove();
        el = markEls[mk.id] = document.createElement('div'); el._kind = mk.kind; el.className = 'mark ' + (mk.kind === 'craft' ? 'reload craft' : mk.kind); el.innerHTML = MARKS[mk.kind] || '';
        box.appendChild(el);
      }
      live[mk.id] = 1;
      el.style.left = (((mk.x + 0.5) * T - lastCam.x) * k).toFixed(1) + 'px';
      el.style.top = ((mk.y * T - lastCam.y - (mk.up || 0) - (Render.liftAt ? Render.liftAt(mapOf(), mk.x, mk.y, T) : 0)) * k).toFixed(1) + 'px';
      if (mk.kind === 'craft') el.style.opacity = mk.paused ? 0.2 : '';
      if (mk.kind === 'reload' || mk.kind === 'craft') el.querySelector('.arc').style.strokeDashoffset = (100.53 * (1 - (mk.p || 0))).toFixed(1);
    });
    Object.keys(markEls).forEach(function (id) { if (!live[id]) { markEls[id].remove(); delete markEls[id]; } });
  }
  // Your reload, as a mark. When its time is up the page asks the referee how things stand, which is when the
  // rounds show up in the count.
  var reloadAsked = 0;
  function reloadMark(marks, T) {
    var r = me && me.reload;
    if (!r || !(r.until > r.at)) return;
    var p = Math.max(0, Math.min(1, (serverNow() - r.at) / (r.until - r.at)));
    marks.push({ id: 'me', kind: 'reload', x: shown.x, y: shown.y, up: T * 0.5 + 14, p: p });
    if (p >= 1 && performance.now() - reloadAsked > 400) { reloadAsked = performance.now(); poll(); }
  }
  // What you are making, as the same kind of ring: it fills while you stay at the station and waits (dimmed) while
  // you are away. How far along comes from the referee (me.craft); between its answers the page counts on by itself.
  var craftAsked = 0, craftHereAt = 0, craftHere = true, craftSig = "", craftTries = 0;
  function craftFrac() {
    var j = me && me.craft; if (!j) return null;
    var now = performance.now();
    if (now - craftHereAt > 250) {
      craftHereAt = now;
      craftHere = World.craftingHere ? World.craftingHere(content, mapOf(), me, lookup(), content.recipes && content.recipes[j.id]) : !!j.on;
    }
    var on = j.on && craftHere;
    return { p: Math.max(0, Math.min(1, ((Number(j.ms) || 0) + (on ? Math.max(0, serverNow() - j.at) : 0)) / (j.need || 1))), on: craftHere };
  }
  function craftMark(marks, T) {
    var f = craftFrac(); if (!f) return;
    marks.push({ id: 'craft', kind: 'craft', x: shown.x, y: shown.y, up: T * 0.5 + (me.reload ? 34 : 14), p: f.p, paused: !f.on });
    // a piece is due, or you came back / walked off: ask the referee, so its count starts or stops with you
    // (a few times at most while nothing changes: the page and the referee may disagree about "at the station")
    var sig = me.craft.made + "|" + me.craft.on;
    if (sig !== craftSig) { craftSig = sig; craftTries = 0; }
    var due = f.p >= 1 || f.on !== !!me.craft.on;
    if (due && craftTries < 4 && performance.now() - craftAsked > 500) { craftAsked = performance.now(); craftTries++; poll(); }
  }
  // What each monster was last seen doing (World.alertOf), to show "!" / "?" for a moment when that changes.
  var alertSt = {}, ALERT_MS = 1500;
  /** Fire the equipped ranged weapon at a cell (an enemy, or anywhere). */
  function shootAt(cell) {
    var ft = lookup().monsterAt(cell.x, cell.y) ? null : floorTargetAt(cell);   // nothing on your floor there, but something seen on another
    if (ft) return shootFloor(ft, cell);
    var map = mapOf(), reach = World.shotReach(content, map, me, cell.x, cell.y, lookup());
    if (!reach.ok) { log(reach.reason, 'info'); return; }
    var w = reach.weapon, cost = w.ammoCost || 1, ammoName = content.items[w.ammo] ? content.items[w.ammo].name.toLowerCase() : w.ammo;
    if (me.reload) return;                                      // reloading: the circle by the ammo count says so
    if (Number(w.clip) > 0) {                                   // fire from the loaded magazine, not the reserve
      if (((me.mags && me.mags[w.id]) || 0) < cost) { if (count(w.ammo) >= cost) startReload(); else log('Out of ' + ammoName + '.', 'info'); return; }   // empty: this click reloads
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
    if (aiming && aimFar != null) { ddx = aimFar ? 1 : 0; ddy = 0; oct = Math.round(aimAngle / (Math.PI / 4)); }   // by the screen: raised ground under the cursor is not where it looks on the map
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
    var dx = cx - ((shown.x + 0.5) * T - lastCam.x), dy = cy - ((shown.y + 0.5) * T - lastCam.y - (Render.liftAt ? Render.liftAt(mapOf(), shown.x, shown.y, T) : 0));   // (from where you are drawn: raised ground lifts you)
    aimAngle = Math.atan2(dy, dx); aimFar = Math.abs(dx) > T / 2 || Math.abs(dy) > T / 2;   // aimFar = the cursor is off your own tile
    if (dx || dy) me.facing = dx < 0 ? 'W' : 'E';
  }
  // Throwing down from an upper floor. The floors below are DRAWN a wall-height lower on the screen per floor, so
  // a cursor cell where your own floor has nothing (open air) stands for a cell of a floor below: same x, y + dz storeys.
  function ownFloorAt(x, y) { var m = mapOf(); return !!(m.terrain[y] && m.terrain[y][x]); }
  function floorsBelow() {
    var myZ = mapOf().z || 0;
    if (myZ <= 0) return [];
    return World.floorsOf(content, me.map).filter(function (f) { return f.z < myZ && f.z >= 0; }).sort(function (a, b) { return b.z - a.z; })
      .map(function (f) { return { map: floorMap(f.id), dz: f.z - myZ }; });
  }
  /** Where a throw aimed at this cell of your view would land on a floor below: {map, x, y, dz}, or null. */
  function throwFloorAt(cell, it) {
    if (ownFloorAt(cell.x, cell.y)) return null;
    var below = floorsBelow(), sf = lookup().stateOf;
    for (var i = 0; i < below.length; i++) {
      var f = below[i], x = cell.x, y = cell.y + f.dz * Rules.WALL_H;
      if (World.throwAcross(content, me, it, mapOf(), f.map, x, y, sf).ok) return { map: f.map, x: x, y: y, dz: f.dz };
      if (f.map.terrain[y] && f.map.terrain[y][x]) return null;             // that floor is what you are pointing at there: nothing lower shows through it
    }
    return null;
  }
  /** A floor's blast cells, moved to where that floor is drawn in your view. */
  function blastOnFloor(ft, it) {
    return World.blastCells(content, ft.map, ft.x, ft.y, it.throwArea || 0, function () { return ''; })
      .map(function (c) { return { x: c.x, y: c.y - ft.dz * Rules.WALL_H }; });
  }
  /** Throw the armed belt item (grenade/molotov) at a cell within its range. */
  function throwAt(cell) {
    var it = content.items[throwing]; if (!it) { cancelThrow(); return; }
    if (count(throwing) < 1) { log('Out of ' + it.name.toLowerCase() + '.', 'info'); cancelThrow(); return; }
    var ft = throwFloorAt(cell, it);
    if (ft) {                                                                 // down onto a floor below
      me.facing = facingToward(cell.x, cell.y);
      send({ type: 'throw', item: throwing, map: ft.map.id, x: ft.x, y: ft.y });
      var tf = performance.now();
      fx.push({ kind: 'proj', from: { x: me.x, y: me.y }, to: { x: cell.x, y: cell.y }, color: it.tint || '#ff8c3b', t0: tf, life: 300 });
      fx.push({ kind: 'flash', x: cell.x, y: cell.y, r: it.throwArea || 0, cells: blastOnFloor(ft, it), color: it.tint || '#ff8c3b', t0: tf + 280, life: 450 });
      cancelThrow();
      return;
    }
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
  function cancelThrow() { if (throwing && !holdMode()) { throwing = null; updateCursor(); hotbar(); } }   // (a held grenade stays in hand: see hotbar)
  function updateCursor() {
    canvas.style.cursor = (aiming || armed || throwing || building || removing || moveTool) ? 'crosshair' : '';
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
    if (!me || aiming || armed || throwing || removing || moveTool) { updateCursor(); return; }
    if (!hover) { canvas.style.cursor = ''; return; }
    var hft = floorTargetAt(hover);
    canvas.style.cursor = tapAction(World.actionsAt(content, mapOf(), lookup(), me, hover.x, hover.y)) ? 'pointer' : 'default';
    canvas.title = hft ? hft.name + (hft.dz < 0 ? ' — on the floor below' : ' — on the floor above') : '';
  }

  // ---------------------------------------------------------------- the belt (keys 1-9, 0), and abilities (Q/E) when skills are on
  var BELT = World.BELT_SIZE || 5;
  function skillsOn() { return !!content && String(content.config.skills || '').toLowerCase() === 'on'; }   // off for now: no Q/E, no abilities in the bag, no mana bar
  function slotKey(i) { return String((i + 1) % 10); }
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
  // ---- what you hold: one belt slot is in your hands (me.held, the referee's World.holdSlot). The wheel and 1-8 choose it.
  // A weapon there is the weapon you fight with; a grenade is ready to throw; food and the like wait for a click.
  /** False against a referee from before held slots (it sends no `held`): the belt then works the old way. */
  function holdMode() { return !!me && typeof me.held === 'number'; }
  function heldId() { return holdMode() && me.held >= 0 ? (me.belt || [])[me.held] || '' : ''; }
  /** The thing in hand if a click should use it up (eat, drink, bandage), else null. */
  function heldUse() { var it = content.items[heldId()]; return it && World.itemCan(it, 'consume') ? it : null; }
  function useHeld() {
    var it = heldUse(); if (!it) return;
    if (count(it.id) < 1) { log('No ' + it.name.toLowerCase() + ' left.', 'info'); return; }
    useItem(it.id);
  }
  /** What the referee will answer to choosing a slot, so the choice shows at once. */
  function predictHold(p, i) {
    var id = i >= 0 ? (p.belt || [])[i] : '', it = id && content.items[id], eq = Object.assign({}, p.equipment);
    var has = it && (p.inventory || []).some(function (s) { return s.item === id && s.qty > 0; });
    if (it && it.slot === 'weapon' && has) eq.weapon = id; else delete eq.weapon;
    return Object.assign({}, p, { held: i, equipment: eq });
  }
  function selectSlot(i) {
    if (!holdMode() || me.held === i) return;
    if (armed) disarm();
    me = predictHold(me, i);
    send({ type: 'hold', slot: i });
    hud(); if (bagOpen) bag();
  }
  var lastWheel = 0;
  canvas.addEventListener('wheel', function (e) {
    if (e.shiftKey || !holdMode() || buildOpen || building || removing || moveTool) return;      // Shift+wheel turns the thing being built; with the build bar up the wheel is the bar's
    e.preventDefault();
    var d = (e.deltaY || e.deltaX) > 0 ? 1 : -1, now = performance.now();
    if (now - lastWheel < 50) return;                                   // a touchpad sends a stream of these
    lastWheel = now;
    selectSlot(me.held < 0 ? (d > 0 ? 0 : BELT - 1) : (me.held + d + BELT) % BELT);
  }, { passive: false });
  /** 1-8: take that belt slot in hand. (Old referee: a throwable arms throw-aim; anything else is used at once.) */
  function beltKey(i) {
    if (!me) return;
    if (holdMode()) { selectSlot(i); return; }
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
  var lastAttackFx = 0, swingT0 = -1e9, SWING_MS = 300;   // swingT0: when your weapon last started its swing (drawn by the renderer)
  function attackFx(tx, ty) {
    var now = performance.now();
    if (now - lastAttackFx < (content.config.attack_ms || 500) * 0.9) return;   // don't out-flash the real attack rate
    lastAttackFx = now; swingT0 = now;
    var dx = tx - me.x, dy = ty - me.y;
    if (dx || dy) me.facing = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');   // matches the server's faceTo
    fx.push({ kind: 'flash', x: tx, y: ty, r: 0, color: '#ffd9a0', t0: now, life: 260 });
  }
  // What the OTHER players do, seen from here. Each one carries `act` = "n,kind,x,y,amount" (World.noteAct): their last
  // melee swing (m) or shot that hurt something (r). A new n = it just happened: swing their weapon, flash the tile,
  // float the number. The first value seen of a player is only remembered (it may be minutes old).
  var actSt = {};
  function othersAct(q, now) {
    var a = String(q.act || '').split(','), n = Number(a[0]) || 0, st = actSt[q.id];
    if (!st) return (actSt[q.id] = { n: n, t0: -1e9 });
    var ahead = (n - st.n + 999) % 999;
    if (!n || !ahead || ahead > 500) return st;                // nothing new (or an older answer arriving late)
    st.n = n;
    var x = Number(a[2]), y = Number(a[3]), amount = Number(a[4]) || 0;
    if (a[1] === 'm') { st.t0 = now; fx.push({ kind: 'flash', x: x, y: y, r: 0, color: '#ffd9a0', t0: now, life: 260 }); }
    if (amount) fx.push({ x: x, y: y, text: '-' + amount, color: '#ffffff', t0: now + (a[1] === 'm' ? SWING_MS * 0.4 : 0) });
    return st;
  }
  // Working a resource (a tree with the axe in hand…): one swing per attack_ms for as long as the left button is
  // held, until it is gone, you step away, or the tool leaves your hand (World.harvestWith says when).
  var harvesting = null, lastHarvest = 0;
  function harvestSwing() {
    var h = harvesting; if (!h) return;
    if (!leftHeld || aiming || !World.harvestWith(content, mapOf(), me, h.x, h.y)) { harvesting = null; return; }
    var now = performance.now();
    if (now - lastHarvest < (Number(content.config.attack_ms) || 500) + 30) return;
    if (queue.some(function (q) { return q.type === 'attack'; })) { flush(); return; }   // the last swing has not been answered yet
    lastHarvest = now;
    me.facing = facingToward(h.x, h.y);
    send({ type: 'attack', x: h.x, y: h.y }); attackFx(h.x, h.y);
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
    // …and, from an upper floor, the ground below that you can drop it on (shown where that floor is drawn)
    var storeys = floorsBelow().reduce(function (n, f) { return Math.max(n, -f.dz); }, 0) * Rules.WALL_H;
    if (storeys) for (var yy = me.y - rng; yy <= me.y + rng + storeys; yy++) for (var xx = me.x - rng; xx <= me.x + rng; xx++)
      if (throwFloorAt({ x: xx, y: yy }, it)) cells.push({ x: xx, y: yy });
    if (!hover) return { cells: cells, hover: null, from: me, color: it.tint || '#ff8c3b' };
    var hft = throwFloorAt(hover, it);
    if (hft) return { cells: cells, hover: { x: hover.x, y: hover.y, ok: true }, blast: blastOnFloor(hft, it), from: me, color: it.tint || '#ff8c3b' };
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
      var it = content.items[entry.id] || { name: entry.id }, im = itemImageUrl(it);
      el.style.background = im ? 'url(' + im + ') center/contain no-repeat' : '#555';
      if (!im) el.textContent = it.name.slice(0, 2);
    }
    return el;
  }
  function hotbar() {
    if (!me) return;
    var ab = $('abilities'); ab.innerHTML = '';
    (skillsOn() ? ['Q', 'E'] : []).forEach(function (lab, i) {
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
    if (holdMode()) {                                      // a grenade in hand is aimed and thrown with a click
      var hIt = content.items[heldId()], th = hIt && World.itemCan(hIt, 'throw') && count(hIt.id) > 0 ? hIt.id : null;
      if (th !== throwing) { throwing = th; updateCursor(); }
    }
    if (invDrag) { invDirty = true; return; }             // never rebuild the belt under a drag
    var belt = $('belt'); belt.innerHTML = '';
    for (var i = 0; i < BELT; i++) (function (i) {
      var id = (me.belt || [])[i], it = id && content.items[id], b = document.createElement('div');
      var inHand = holdMode() && me.held === i;
      b.className = 'hk' + (inHand ? ' held' : !holdMode() && throwing && throwing === id ? ' armed' : '') + (it ? '' : ' empty');
      b.title = !it ? 'Empty: assign an item from the bag (I)' : !holdMode() ? it.name + (World.itemCan(it, 'throw') ? ' (throw)' : ' (use)')
        : it.name + (!inHand ? '' : World.itemCan(it, 'consume') ? ' — in hand: click to use it' : World.itemCan(it, 'throw') ? ' — in hand: click where to throw it' : ' — in hand');
      var key = document.createElement('span'); key.className = 'key'; key.textContent = slotKey(i); b.appendChild(key);
      if (it) {
        b.appendChild(icon({ kind: 'item', id: id }));
        var q = document.createElement('span'); q.className = 'qty';
        var st = count(id);
        q.textContent = st ? '×' + st : '0'; b.appendChild(q);
        if (!st) b.classList.add('low');
      }
      b.onclick = function () { if (holdMode() && me.held === i && heldUse()) useHeld(); else beltKey(i); };
      // With the inventory window open the belt is part of it: drop a stack on a slot to carry it there (out of a
      // container it is taken into the bag first), drag a slot onto the bag to clear it, or onto another slot.
      invTarget(b, function (g) { return bagOpen && g.from !== 'worn'; }, function (g) {
        if (g.from === 'box') invMove('box', g.slot, 'bag');
        if (g.from === 'belt' && g.slot === i) return;
        send({ type: 'loadout', bar: 'belt', slot: i, entry: g.item });
      });
      if (it && bagOpen) {
        b.draggable = true;
        b.onmousedown = function () { invPress = true; };
        b.ondragstart = function (e) { invDrag = { from: 'belt', item: id, slot: i, qty: 1 }; try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* older browsers */ } };
        b.ondragend = function () { invDrag = null; invPress = false; invDirty = false; hotbar(); bag(); };
      }
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
    if (moveTool && moveTool.key) {                       // the move tool: let go = put it down where the ghost is
      lastPtr = { clientX: e.clientX, clientY: e.clientY };
      var mb = buildTarget();
      if (mb && mb.ok) send({ type: 'relocate', target: { t: 'ent', key: moveTool.key }, x: mb.x, y: mb.y, facing: mb.facing || undefined });
      else if (mb && mb.reason && !/already there/.test(mb.reason)) log('It stays where it was: ' + mb.reason, 'info');
      moveTool = { key: null }; buildPanel();
      return;
    }
    buildHold = null;
    var was = leftHeld; leftHeld = false; clearTimeout(holdTimer);
    if (harvesting) { harvesting = null; return; }         // the press was the work itself
    if (!was || aiming) return;                            // was firing while aiming, or not our press
    if (holdFired) { holdFired = false; return; }          // the hold already opened the action list
    if (pendingCell) {                                     // quick tap → the default interaction
      var acts = World.actionsAt(content, mapOf(), lookup(), me, pendingCell.x, pendingCell.y);
      var tapA = tapAction(acts);
      if (tapA) doAction(tapA, pendingCell);
      else if (heldUse()) useHeld();                       // nothing to act on there: the click uses what is in hand
    }
  });
  // the chevron over the log folds it away (remembered in this browser)
  function setLogShut(shut) { $('logbox').classList.toggle('shut', shut); $('log-toggle').innerHTML = shut ? '&#9652;' : '&#9662;'; }
  $('log-toggle').onclick = function () {
    var shut = !$('logbox').classList.contains('shut'); setLogShut(shut);
    try { localStorage.setItem('sheetsrpg.logShut', shut ? '1' : ''); } catch (e) { /* private mode */ }
  };
  try { setLogShut(localStorage.getItem('sheetsrpg.logShut') === '1'); } catch (e) { /* private mode */ }
  $('btn-use').onclick = interact;
  $('btn-bag').onclick = toggleBag;
  $('btn-help').onclick = function () { $('help').hidden = !$('help').hidden; };
  $('help-close').onclick = $('help').onclick = function () { $('help').hidden = true; };

  // ---------------------------------------------------------------- HUD and bag
  function hud() {
    if (!me) return;
    buildLockWatch();
    $('hud-map').textContent = mapOf().name;
    $('hp-fill').style.width = Math.max(0, 100 * me.hp / me.maxHp) + '%';
    $('hp-text').textContent = Math.max(0, me.hp) + ' / ' + me.maxHp;
    var span = me.xpNext ? me.xpNext - me.xpThis : 0;
    $('xp-fill').style.width = span ? Math.min(100, 100 * (me.xp - me.xpThis) / span) + '%' : '100%';
    $('xp-text').textContent = 'Lv ' + me.level + (me.xpNext ? ' · ' + me.xp + ' / ' + me.xpNext + ' XP' : ' · max');
    $('gold').textContent = me.gold + ' gold';
    $('mp-fill').style.width = me.maxMp ? Math.max(0, 100 * me.mp / me.maxMp) + '%' : '0%';
    $('mp-text').textContent = 'MP ' + me.mp + ' / ' + me.maxMp;
    $('mp-bar').hidden = !skillsOn();                      // mana only pays for skills
    var food = me.hunger == null ? 100 : me.hunger, water = me.thirst == null ? 100 : me.thirst;
    $('food-fill').style.height = Math.max(0, Math.min(100, food)) + '%';        // round gauges: they drain from the top
    $('food-bar').title = 'Food ' + Math.round(food) + '%';
    $('food-bar').classList.toggle('low', food <= 25);
    $('water-fill').style.height = Math.max(0, Math.min(100, water)) + '%';
    $('water-bar').title = 'Water ' + Math.round(water) + '%';
    $('water-bar').classList.toggle('low', water <= 25);
    var tox = Number(me.tox) || 0, sickAt = me.toxSick || 50;                    // toxicity: only there while there is some; it fills as it rises
    $('tox-bar').hidden = tox <= 0;
    $('tox-fill').style.height = Math.max(0, Math.min(100, tox)) + '%';
    $('tox-bar').title = 'Toxicity ' + Math.round(tox) + '%' + (tox >= sickAt ? ' · it is hurting you' : ' · harmful from ' + sickAt + '%') + '. It wears off with time.';
    $('tox-bar').classList.toggle('low', tox >= sickAt);
    var rw = World.rangedWeapon(content, me), wset = $('weapon-set');          // equipped gun: magazine + reserve
    if (rw) {
      var reserve = count(rw.ammo);
      var clip = Number(rw.clip) || 0, loaded = (me.mags && me.mags[rw.id]) || 0;
      // bottom right of the view: "in the gun / in the bag" over the rounds themselves (one shape per round it holds)
      var wl = $('weapon'); wl.innerHTML = '';
      var line = document.createElement('div'); line.className = 'wline'; wl.appendChild(line);
      var nm = document.createElement('span'); nm.className = 'wname'; nm.textContent = rw.name; line.appendChild(nm);
      if (clip > 0) {
        var dry = loaded < (rw.ammoCost || 1);
        if (dry) { var rl = document.createElement('span'); rl.className = 'wreload'; rl.textContent = 'R'; line.appendChild(rl); }
        var mag = document.createElement('span'); mag.className = 'wammo' + (dry ? ' low' : ''); mag.textContent = loaded + ' / ' + reserve; line.appendChild(mag);
        wl.title = loaded + ' of ' + clip + ' in the ' + rw.name.toLowerCase() + ', ' + reserve + ' more in the bag';
        if (clip <= 40) {
          var rounds = document.createElement('div'); rounds.className = 'rounds';
          for (var ri = 0; ri < clip; ri++) { var rd = document.createElement('i'); rd.className = 'round' + (ri < clip - loaded ? ' spent' : ''); rounds.appendChild(rd); }
          wl.appendChild(rounds);
        }
      } else {
        var am = document.createElement('span'); am.className = 'wammo' + (reserve < (rw.ammoCost || 1) ? ' low' : ''); am.textContent = '×' + reserve; line.appendChild(am);
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
  function toggleBag() { bagOpen = !bagOpen; $('bag').hidden = !bagOpen; if (bagOpen) { bag(); didUi('bag'); } else { storage = null; invSel = -1; } bagHud(); }
  /** While the inventory window is open the belt on screen stays above it: things are dragged onto its slots. */
  function bagHud() { $('hud-bc').classList.toggle('above', bagOpen); hotbar(); }
  // ---- build mode (B): pick a blueprint, then click where it goes. Whether a spot is allowed is decided by
  // World.canBuild — the same check the referee runs — so a green ghost means the server will say yes.
  var wasLocked = null;                                       // building locked last time we looked (null = not looked yet)
  /** Building may be locked until something happens (Config build_if): shut the bar when it is, say so when it opens up. */
  function buildLockWatch() {
    if (!me) return;
    var locked = !!me.buildLocked;
    if (locked && buildOpen) toggleBuild(true);
    if (wasLocked === true && !locked) log('You can build now: press B.', 'info');
    wasLocked = locked;
  }
  function toggleBuild(quiet) {
    if (!buildOpen && me && me.buildLocked) { if (quiet !== true) log(me.buildLocked, 'info'); return; }
    buildOpen = !buildOpen && !!me;
    $('buildbar').hidden = !buildOpen; $('frame').classList.toggle('building', buildOpen);
    bbSig = '';
    if (buildOpen) { buildPanel(); didUi('build'); } else stopBuilding();   // closing the bar puts away whatever was in hand
  }
  function stopBuilding() { building = null; removing = false; moveTool = null; buildHold = null; updateCursor(); if (buildOpen) buildPanel(); }
  function startRemoving() {
    if (!me) return;
    building = null; buildHold = null; moveTool = null; removing = true; wallsDown = true;   // walls start down: what you see is what a click picks
    if (buildOpen) buildPanel();
    log('Remove tool: click something you built to take it apart. Walls are shown low so you can reach behind them (H shows them whole). Esc or X stops.', 'info');
    updateCursor();
  }
  function startMoving() {
    if (!me) return;
    building = null; buildHold = null; removing = false; moveTool = { key: null };
    if (buildOpen) buildPanel();
    log('Move tool: drag an object you built to where it should go (T turns it while you hold it). Green = it fits, red = it does not. Esc stops.', 'info');
    updateCursor();
  }
  /** What the move tool would pick up where the cursor is: {target, info, ok, reason, bp}. World.canMove — the referee's own check — says whether it may. */
  function moveTarget() {
    if (!moveTool || moveTool.key || !lastPtr || !me) return null;
    var pt = pointAt(lastPtr), map = mapOf(), st = map._struct, cx = Math.floor(pt.fx), cy = Math.floor(pt.fy), lk = lookup(), first = null;
    if (!st) return null;
    var seen = {}, list = Rules.blockersAt(content, map, cx, cy).concat(Rules.entitiesAt(map, cx, cy)).filter(function (e) { if (seen[e.key]) return false; seen[e.key] = 1; return true; });
    for (var i = 0; i < list.length; i++) {
      var chk = World.canMove(content, map, lk, me, { t: 'ent', key: list[i].key });
      if (!chk.info) continue;
      var out = { target: { t: 'ent', key: list[i].key }, info: chk.info, ok: chk.ok, reason: chk.reason || '', bp: chk.bp, edges: null };
      if (chk.ok) return out;
      first = first || out;
    }
    return first;
  }
  /**
   * What the remove tool would take apart where the cursor is: {target, info, ok, reason, edges}. Only things that
   * were built count. Tried in the order a player means them: a wall or door on the grid line the cursor is right on,
   * an object standing in the tile, something hung on the wall whose picture is there, the wall whose face is there
   * (an east-west wall rises above its line), the nearest line of the tile, and last the laid floor underfoot.
   * World.canRemove — the referee's own check — says whether it may go.
   */
  function removeTarget() {
    if (!removing || !lastPtr || !me) return null;
    var pt = pointAt(lastPtr), map = mapOf(), st = map._struct, cx = Math.floor(pt.fx), cy = Math.floor(pt.fy), list = [], lk = lookup();
    if (!st) return null;
    function onEdge(orient, x, y) {
      (st.ents || []).forEach(function (e) {
        var o = content.objects[e.ref];
        if (World.isWallFixture(o) && World.fixtureEdges(o, e).some(function (q) { return q.orient === orient && q.x === x && q.y === y; })) list.push({ t: 'ent', key: e.key });
      });
      list.push({ t: 'wall', orient: orient, x: x, y: y });
    }
    var hy = Math.round(pt.fy), vx = Math.round(pt.fx), dh = Math.abs(pt.fy - hy), dv = Math.abs(pt.fx - vx), NEAR = 0.28;
    function lines(limit) {
      var h = dh <= limit, v = dv <= limit;
      if (h && v) { if (dv < dh) { onEdge('v', vx, cy); onEdge('h', cx, hy); } else { onEdge('h', cx, hy); onEdge('v', vx, cy); } }
      else if (h) onEdge('h', cx, hy); else if (v) onEdge('v', vx, cy);
    }
    lines(NEAR);
    Rules.blockersAt(content, map, cx, cy).concat(Rules.entitiesAt(map, cx, cy)).forEach(function (e) { if (!World.isWallFixture(content.objects[e.ref])) list.push({ t: 'ent', key: e.key }); });
    if (!wallsDown) {                                       // walls down (H): their faces are not in the way, so not picked by them
      var wm = World.wallMountAt(content, map, cx, cy); if (wm) list.push({ t: 'ent', key: wm.key });
      for (var up = 1; up <= Rules.WALL_H; up++) list.push({ t: 'wall', orient: 'h', x: cx, y: cy + up });
    }
    if (wallsDown) list.push({ t: 'tile', x: cx, y: cy });   // …and the floor comes before a line that is merely the nearest
    lines(0.5);
    list.push({ t: 'tile', x: cx, y: cy });
    list.push({ t: 'roof', x: cx, y: cy });                 // last: the piece of roof over that cell (shown tinted while the tool is out)
    var first = null;
    for (var i = 0; i < list.length; i++) {
      var chk = World.canRemove(content, map, lk, me, list[i]);
      if (!chk.info) continue;                              // nothing built there
      var out = { target: list[i], info: chk.info, ok: chk.ok, reason: chk.reason || '',
        edges: chk.info.t === 'ent' && World.isWallFixture(chk.info.obj) ? World.fixtureEdges(chk.info.obj, chk.info.e) : null };
      if (chk.ok) return out;
      first = first || out;
    }
    return first;
  }
  // While the button is held on a wall blueprint, the ghost stays on the grid line the press started on
  // (same direction, same line): dragging lays wall after wall along it instead of hopping between lines.
  var buildHold = null;                                   // {side, x, y, repeat, last} from the press
  // Which way the thing being placed faces (objects with pictures for other directions): T or Shift+wheel turns it.
  var buildFacing = 'S';
  function turnBuild(dir) {
    var bp = moveTool && moveTool.key ? moveTool.bp : building && content.blueprints && content.blueprints[building], o = bp && bp.places === 'object' ? content.objects[bp.object] : null;
    if (!o || World.isWallFixture(o) || !(o.kind === 'stairs' || Rules.turnable(o))) return false;     // stairs turn too: the way they climb
    buildFacing = Rules.nextFacing(buildFacing, dir);
    return true;
  }
  canvas.addEventListener('wheel', function (e) {
    if (e.shiftKey && (building || moveTool) && turnBuild((e.deltaY || e.deltaX) > 0 ? 1 : -1)) e.preventDefault();
  }, { passive: false });
  function buildDrag() {
    if (!buildHold || !buildHold.repeat || !building) return;
    var bt = buildTarget(), k = bt && bt.x + ',' + bt.y;
    if (!bt || k === buildHold.last) return;
    buildHold.last = k;
    if (bt.ok) send({ type: 'build', bp: building, x: bt.x, y: bt.y, side: bt.side, off: bt.off });
  }
  // ---- the build bar (B): part of the view, not a window. Top left, the materials you own; along the top, the
  // kinds of construction (the wheel moves along them, a click opens one); under that, the blueprints of the open
  // kind (the wheel moves along them and unfolds the one it is on: what it costs, the tool it needs; a click on the
  // unfolded one takes it in hand). The game goes on underneath.
  var bbType = null, bbHot = 0, bbFocus = null, bbSig = '';   // open kind, the kind the wheel is on, the unfolded blueprint, what is drawn
  function bbEl(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function bbTitle(s) { s = String(s || 'other'); return s.charAt(0).toUpperCase() + s.slice(1); }
  // ---- an item's picture. Clothes and armour are drawn in two parts: the picture itself holds what never changes
  // colour, and a mask next to it (foo.tint.png) holds the cloth, coloured by the item's default_tint. An icon
  // shows both, one over the other, exactly as the item looks when worn.
  /** The item's picture with its tinted part: an image, or a canvas; null when it has none loaded. */
  function itemImage(it) {
    var img = it && it.sprite && Assets.get(it.sprite);
    if (!img || !img.width) return null;
    var ramp = it.defaultTint && typeof Tint !== 'undefined' ? Tint.TINTS[it.defaultTint] : null, mask = ramp && Assets.get(maskOf(it.sprite));
    return ramp && mask && mask.complete && mask.width ? Tint.getTintedLayer(img, mask, ramp) : img;
  }
  /** That picture as an address (for a CSS background). */
  function itemImageUrl(it) {
    var im = itemImage(it); if (!im) return '';
    if (im.src) return im.src;
    if (!im._url) { try { im._url = im.toDataURL(); } catch (e) { im._url = Assets.get(it.sprite).src; } }
    return im._url;
  }
  /** That picture as an element of its own to put on the page (a placeholder when there is none). */
  function itemPicEl(it, size) {
    var im = itemImage(it), pic;
    if (!im) pic = Assets.placeholder((it && it.name) || '?', '#555', size || 24);
    else if (im.src) pic = im.cloneNode();
    else { pic = document.createElement('canvas'); pic.width = im.width; pic.height = im.height; pic.getContext('2d').drawImage(im, 0, 0); }
    pic.className = 'pic'; return pic;
  }
  function itemPic(id, size) { return itemPicEl(content.items[id] || { name: id }, size); }
  /** A blueprint's picture: its own icon, else what it builds (the object, or one tile of the floor it lays). */
  function bpPic(b) {
    var o = b.places === 'object' ? content.objects[b.object] : null;
    var img = (b.icon && Assets.get(b.icon)) || (o && Assets.get(o.sprite)), pic = null;
    var flo = !img && (b.places === 'tile' || b.places === 'roof') ? content.terrain[b.terrain] : null;
    if (flo) {
      var bts = flo.autotile && content.tilesets[flo.autotile], bti = bts && typeof Scatter !== 'undefined' && Scatter.tileInfo(bts.image);
      var tim = (flo.sprite && Assets.get(flo.sprite)) || (bti && bti.baseTile && Assets.get(bti.baseTile));
      if (tim) {                                                       // a strip of frames or a big picture: its first tile only
        var ts = Math.min(tim.width, tim.height);
        pic = document.createElement('canvas'); pic.width = pic.height = 32;
        var pg = pic.getContext('2d'); pg.imageSmoothingEnabled = false; pg.drawImage(tim, 0, 0, ts, ts, 0, 0, 32, 32);
      }
    }
    if (!pic) pic = img ? img.cloneNode() : Assets.placeholder(b.name, '#555', 32);
    pic.className = 'pic';
    return pic;
  }
  function pickBp(b, roof) {
    var o = b.places === 'object' ? content.objects[b.object] : null;
    removing = false; building = b.id; buildRoof = !!roof; buildHold = null;
    buildFacing = o && o.kind === 'stairs' ? 'N' : 'S';       // stairs climb north unless turned (T)
    if (roof) log('Roof: click cells of this storey to cover them. Green = well held, yellow = as far from a wall as it can go, red = it would fall. V switches to floor.', 'info');
    updateCursor(); buildPanel();
  }
  function bbCentre(row, child) { if (row && child) row.scrollLeft = child.offsetLeft - (row.clientWidth - child.offsetWidth) / 2; }
  function buildPanel() {
    if (!me || !content) return;
    var bps = World.blueprintsFor(content, me), groups = {}, order = [];
    bps.forEach(function (b) { var g = b.category || 'other'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(b); });
    if (bbType && !groups[bbType]) bbType = null;
    bbHot = Math.max(0, Math.min(order.length + 1, bbHot));    // (order.length = the Remove chip, + 1 = the Move chip, at the end)
    var shown = bbType ? groups[bbType] : [];
    if (shown.length && !shown.some(function (b) { return b.id === bbFocus; })) bbFocus = shown[0].id;
    var focus = shown.filter(function (b) { return b.id === bbFocus; })[0] || null;
    var sig = JSON.stringify([bps.map(function (b) { return [b.id, b.toolOk, b.cost.map(function (g) { return g.have; })]; }), bbType, bbHot, bbFocus, building, removing, buildRoof, moveTool && (moveTool.key || 1)]);
    if (sig === bbSig) return;                                 // nothing to redraw (and a click in progress keeps its button)
    bbSig = sig;

    // materials: everything some blueprint you know is made of, with how much of it you carry
    var mats = $('bb-mats'), seen = {}, need = {};
    mats.innerHTML = '';
    if (focus) focus.cost.forEach(function (g) { need[g.item] = g.qty; });
    bps.forEach(function (b) { b.cost.forEach(function (g) {
      if (seen[g.item]) return; seen[g.item] = 1;
      var row = bbEl('div', 'bb-mat' + (need[g.item] > g.have ? ' lack' : need[g.item] ? ' used' : ''));
      row.title = (content.items[g.item] || {}).name || g.item;
      row.appendChild(itemPic(g.item, 24)); row.appendChild(bbEl('b', '', String(g.have)));
      mats.appendChild(row);
    }); });

    // kinds of construction
    var types = $('bb-types'), hotEl = null;
    types.innerHTML = '';
    order.forEach(function (g, i) {
      var chip = bbEl('button', 'bb-type' + (g === bbType ? ' on' : '') + (i === bbHot ? ' hot' : ''), bbTitle(g));
      chip.onclick = function () { bbHot = i; bbType = bbType === g ? null : g; bbFocus = null; buildPanel(); };
      if (i === bbHot) hotEl = chip;
      types.appendChild(chip);
    });
    var rm = bbEl('button', 'bb-type rm' + (removing ? ' on' : '') + (bbHot === order.length ? ' hot' : ''), 'Remove');
    rm.title = 'Take apart walls, doors, objects and floor you built (X)';
    rm.onclick = function () { bbHot = order.length; if (removing) stopBuilding(); else startRemoving(); buildPanel(); };
    if (bbHot === order.length) hotEl = rm;
    types.appendChild(rm);
    var mvc = bbEl('button', 'bb-type mv' + (moveTool ? ' on' : '') + (bbHot === order.length + 1 ? ' hot' : ''), 'Move');
    mvc.title = 'Move an object you built to another spot. It keeps what is in it, and costs nothing';
    mvc.onclick = function () { bbHot = order.length + 1; if (moveTool) stopBuilding(); else startMoving(); buildPanel(); };
    if (bbHot === order.length + 1) hotEl = mvc;
    types.appendChild(mvc);
    if (!bps.length) types.insertBefore(bbEl('span', 'bb-none', 'You don\'t know how to build anything yet.'), rm);

    // the blueprints of the open kind
    var row = $('bb-bps'), focusEl = null;
    row.innerHTML = ''; row.hidden = !shown.length;
    shown.forEach(function (b) {
      var can = b.afford && b.toolOk, open = b.id === bbFocus;
      var card = bbEl('div', 'bb-bp' + (open ? ' focus' : '') + (b.id === building ? ' sel' : '') + (can ? '' : ' cant'));
      var head = bbEl('div', 'bb-head'); head.appendChild(bpPic(b)); head.appendChild(bbEl('b', '', b.name)); card.appendChild(head);
      if (open) {
        var body = bbEl('div', 'bb-body');
        if (!b.cost.length) body.appendChild(bbEl('div', 'bb-cost', 'Costs nothing'));
        b.cost.forEach(function (g) {
          var line = bbEl('div', 'bb-cost' + (g.have < g.qty ? ' lack' : ''));
          line.appendChild(itemPic(g.item, 16));
          line.appendChild(bbEl('span', '', g.qty + ' ' + ((content.items[g.item] || {}).name || g.item).toLowerCase() + '  (' + g.have + ')'));
          body.appendChild(line);
        });
        body.appendChild(bbEl('div', 'bb-tool' + (b.tool && !b.toolOk ? ' lack' : ''), b.tool ? 'Needs a ' + String(b.tool).split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean).join(' or a ') : 'No tool needed'));
        if (b.places === 'tile') {                              // a floor is also a roof: the same piece, put up over the storey you stand on
          var br = bbEl('button', 'bb-roof' + (b.id === building && buildRoof ? ' on' : ''), 'As a roof');
          br.title = 'Put it up as a roof over where you stand. It becomes the floor of the storey above, and must rest on walls. (V switches)';
          br.onclick = function (e) { e.stopPropagation(); pickBp(b, true); };
          body.appendChild(br);
        }
        body.appendChild(bbEl('div', 'bb-go', b.id === building ? 'In hand: click the ground to place' : 'Click to build'));
        card.appendChild(body);
        focusEl = card;
      }
      card.onclick = function () { if (bbFocus !== b.id) { bbFocus = b.id; buildPanel(); } else pickBp(b, false); };
      row.appendChild(card);
    });
    $('bb-hint').textContent = moveTool ? (moveTool.key ? 'Move: let go where it should go (green = it fits). T turns it. Right-click puts it back.' : 'Move: drag an object you built to its new spot. Esc stops.')
      : removing ? 'Remove: click something you built. H shows walls whole or low. Esc stops.'
      : building ? 'Click to place. T turns it. F works on a frame until it is finished. Right-click puts it away, Esc or B closes.'
      : bbType ? 'Wheel to look through the list, click to take the open one in hand. Right-click goes a step back.'
      : 'Wheel to move along the kinds, click to open the lit one. Right-click, Esc or B closes.';
    bbCentre(types, hotEl); bbCentre(row, focusEl);
  }
  // the wheel, over the bar: along the kinds, or along the blueprints of the open one
  function bbWheel(which) {
    return function (e) {
      e.preventDefault(); e.stopPropagation();
      var d = (e.deltaY || e.deltaX) > 0 ? 1 : -1, now = performance.now();
      if (now - lastWheel < 50 || !me) return;
      lastWheel = now;
      var bps = World.blueprintsFor(content, me), cats = [];
      bps.forEach(function (b) { var g = b.category || 'other'; if (cats.indexOf(g) < 0) cats.push(g); });
      if (which === 'types') bbHot = Math.max(0, Math.min(cats.length + 1, bbHot + d));
      else {
        var shown = bps.filter(function (b) { return (b.category || 'other') === bbType; }), i = 0;
        shown.forEach(function (b, k) { if (b.id === bbFocus) i = k; });
        if (shown.length) bbFocus = shown[Math.max(0, Math.min(shown.length - 1, i + d))].id;
      }
      buildPanel();
    };
  }
  /** One step forward, for a click that lands anywhere on the view: open the kind the wheel is on, then take the unfolded blueprint in hand. */
  function buildClick() {
    var bps = World.blueprintsFor(content, me), cats = [];
    bps.forEach(function (b) { var g = b.category || 'other'; if (cats.indexOf(g) < 0) cats.push(g); });
    if (!bbType) {
      if (bbHot > cats.length) startMoving();                  // the Move chip
      else if (bbHot === cats.length) startRemoving();         // the Remove chip
      else { bbType = cats[bbHot]; bbFocus = null; buildPanel(); }
      return;
    }
    var b = bps.filter(function (q) { return q.id === bbFocus; })[0];
    if (b) pickBp(b, false);
  }
  /** One step back in the build bar: what is in hand is put away, then the open kind is folded, then the bar closes. */
  function buildBack() {
    if (moveTool && moveTool.key) { moveTool = { key: null }; buildPanel(); }   // what is carried goes back where it was
    else if (building || removing || moveTool) stopBuilding();
    else if (bbType) { bbType = null; bbFocus = null; buildPanel(); }
    else if (buildOpen) toggleBuild();
  }
  // a right-click on the bar goes one step back, as one on the ground does while the bar is up
  $('buildbar').addEventListener('contextmenu', function (e) { e.preventDefault(); buildBack(); });
  // …and anywhere else on the view while the bar is up: along the blueprints when a kind is open, else along the kinds
  // (Shift+wheel stays the turning of what is in hand)
  canvas.addEventListener('wheel', function (e) { if (buildOpen && !e.shiftKey) bbWheel(bbType ? 'bps' : 'types')(e); }, { passive: false });
  $('bb-types').addEventListener('wheel', bbWheel('types'), { passive: false });
  $('bb-bps').addEventListener('wheel', bbWheel('bps'), { passive: false });
  /** Where the cursor is in tiles, with fractions (so the nearest grid line can be found). */
  function pointAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    return { fx: ((e.clientX - r.left) * canvas.width / r.width + lastCam.x) / T, fy: ((e.clientY - r.top) * canvas.height / r.height + lastCam.y) / T };
  }
  /** Where the blueprint being placed would go right now, and whether that is allowed: {bp, x, y, side, ok, reason}. */
  function buildTarget() {
    var mv = moveTool && moveTool.key ? moveTool : null;
    var bp = mv ? mv.bp : building && content.blueprints && content.blueprints[building];
    if (!bp || !lastPtr || !me) return null;
    var asRoof = buildRoof && bp.places === 'tile' && !!World.asRoof;
    if (asRoof) bp = World.asRoof(bp);
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
    var stairs = !!o && o.kind === 'stairs';
    var chk = mv ? World.canMove(content, map, lookup(), me, { t: 'ent', key: mv.key }, x, y) : World.canBuild(content, map, lookup(), me, bp, x, y, side, stairs ? buildFacing : undefined);
    var facing = stairs ? buildFacing : (o && !World.isWallFixture(o) && Rules.turnable(o) ? buildFacing : '');
    return { bp: bp, x: x, y: y, side: side, off: off, facing: facing, ok: chk.ok, reason: chk.reason || '', risk: chk.risk || '', roof: asRoof };   // risk: a roof's safe | edge | fall
  }
  // ---- storage panel: a container you built. Left = what is in it (Take), below = your bag (Put).
  function closeStore() { storage = null; if (bagOpen) toggleBag(); }   // the container shows in the inventory window: closing it closes that
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
  function storePanel() { if (!bagOpen) { bagOpen = true; $('bag').hidden = false; bagHud(); } bag(); }   // a container: the inventory window, with its grid beside the bag
  // ---- quests ----
  // The rules are the referee's (World.questState / questAct). The page only shows what it is told with every
  // answer: me.quests = [{id, s: 'active' | 'ready', n: [count per goal]}] and me.questsOpen = [ids that could be
  // accepted now]. Three places show it: the window of the NPC you talk to (accept, hand in), the quest log (L)
  // and the tracker in the corner; and a mark floats over every NPC who has something for you.
  var npcTalk = null, npcQuest = '', npcPick = -1, questOpen = false, abandonArmed = '';
  function qel(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
  /** Text with keys in it: "[W]" or "[Left click]" is drawn as a key cap. */
  function qtext(cls, text) {
    var d = qel('div', cls), parts = String(text == null ? '' : text).split(/\[([^\[\]\n]{1,16})\]/);
    parts.forEach(function (part, i) { if (i % 2) d.appendChild(qel('kbd', '', part)); else if (part) d.appendChild(document.createTextNode(part)); });
    return d;
  }
  /** A quest's picture (a GIF plays by itself), or nothing. */
  function questPic(q) {
    if (!q.image) return null;
    var img = document.createElement('img');
    img.className = 'qimg'; img.alt = ''; img.onerror = function () { img.remove(); };
    img.src = Assets.resolve(q.image);
    return img;
  }
  function isTutorial(id) { var q = (content.quests || {})[id]; return !!(q && q.tutorial); }
  function skipTutorial() { introOpen = false; introAck = ''; $('npcp').hidden = true; send({ type: 'quest', op: 'skip' }); }
  /** A window of the page was opened: a quest that asks for exactly that (a `ui` goal) is told, as only the page knows. */
  function didUi(what) {
    var qs = content.quests || {};
    var wanted = myQuests().some(function (x) {
      var q = qs[x.id];
      return q && q.goals.some(function (g, i) { return g.type === 'ui' && g.ref === what && !(Number(x.n[i]) >= 1); });
    });
    if (wanted) send({ type: 'quest', op: 'did', what: what });
  }
  function myQuests() { return (me && me.quests) || []; }
  function questEntry(id) { return myQuests().filter(function (x) { return x.id === id; })[0] || null; }
  function objName(id) { return (content.objects[id] || {}).name || 'someone'; }
  /** What one NPC (an object id) has for you: quests to hand in, quests on offer, quests of theirs still under way. */
  function npcQuests(ref) {
    var qs = content.quests || {}, out = { ready: [], open: [], active: [] };
    myQuests().forEach(function (x) {
      var q = qs[x.id]; if (!q) return;
      if (x.s === 'ready' && q.ender === ref) out.ready.push(q);
      else if (x.s !== 'ready' && (q.ender === ref || q.giver === ref)) out.active.push(q);
    });
    ((me && me.questsOpen) || []).forEach(function (id) { var q = qs[id]; if (q && q.giver === ref) out.open.push(q); });
    return out;
  }
  /** "100 XP · 20 gold · 2 Wood", from a quest's reward actions (what is not a gift is left out). */
  function rewardText(q) {
    var out = [];
    String(q.rewards || '').split(';').forEach(function (cmd) {
      var a = cmd.trim().split(':');
      if (a[0] === 'xp' && Number(a[1]) > 0) out.push(a[1] + ' XP');
      else if (a[0] === 'gold' && Number(a[1]) > 0) out.push(a[1] + ' gold');
      else if (a[0] === 'give' && a[1]) out.push((Number(a[2]) || 1) + ' ' + itemName(a[1]));
    });
    return out.join(' · ');
  }
  function itemName(id) { return id === 'gold' ? 'gold' : (content.items[id] || {}).name || id; }
  function choiceList(q) { return World.list(q.choice).filter(function (g) { return g.item === 'gold' || content.items[g.item]; }); }
  /** One goal in words: "Kill Rat 1/3", "Bring Bone 0/2", "Talk to Tom", "Go to Old Mill" — or its own label, with the count. */
  var GOAL_VERB = { kill: 'Kill ', have: 'Bring ', use: 'Use ', craft: 'Make ', build: 'Build ', tame: 'Tame ', interact: 'Use ', goto: 'Go to ', talk: '', drink: '', eat: '' };
  function goalLabel(g, have) {
    var text = (g.label ? '' : GOAL_VERB[g.type] || '') + World.goalText(content, g);
    return g.need > 1 || g.type === 'have' ? text + ' ' + have + '/' + g.need : text;
  }
  /** A quest's goals as lines, ticked when met. counts = the entry's n (none = not started). */
  function goalLines(q, counts) {
    var box = qel('div', 'qgoals');
    q.goals.forEach(function (g, i) {
      var have = counts ? Number(counts[i]) || 0 : 0, done = !!counts && have >= g.need;
      box.appendChild(qtext(done ? 'done' : '', (done ? '✓ ' : '• ') + goalLabel(g, have)));
    });
    return box;
  }
  function openNpc(e) {
    var has = npcQuests(e.ref);
    if (!has.ready.length && !has.open.length && !has.active.length) {      // nothing between you: just what they say
      log(e.text ? e.name + ': ' + e.text : e.name + ' has nothing to say yet.', 'info');
      return;
    }
    if (introOpen) closeIntro();
    closeClaimQuest();
    npcTalk = e; npcQuest = ''; npcPick = -1;
    $('npcp').hidden = false; npcPanel();
  }
  function closeNpc() { npcTalk = null; npcQuest = ''; $('npcp').hidden = true; claimPanel(); }   // (a finished quest may have been waiting for this window)
  function npcPanel() {
    if (!npcTalk) return;
    // walked away (or they are gone): the window closes
    var ent = (mapOf().entities || []).filter(function (en) { return en.key === npcTalk.key; })[0];
    if (!ent || Math.abs(ent.x - me.x) > 1 || Math.abs(ent.y - me.y) > 1) { closeNpc(); return; }
    var box = $('npc-body'), has = npcQuests(npcTalk.ref), q = npcQuest && (content.quests || {})[npcQuest];
    box.innerHTML = ''; $('npc-title').textContent = npcTalk.name;
    var entry = q && questEntry(q.id), offered = q && ((me.questsOpen || []).indexOf(q.id) >= 0);
    if (q && !entry && !offered) { q = null; npcQuest = ''; }                // accepted, handed in or no longer on offer: back to the list
    if (!q) {
      if (npcTalk.text) box.appendChild(qtext('qsay', npcTalk.text));
      if (!has.ready.length && !has.open.length && !has.active.length) { box.appendChild(qel('div', 'empty', 'Nothing more for now.')); return; }
      [['ready', 'Ready to hand in', '?'], ['open', 'New', '!'], ['active', 'Under way', '…']].forEach(function (grp) {
        if (!has[grp[0]].length) return;
        box.appendChild(qel('h4', '', grp[1]));
        has[grp[0]].forEach(function (one) {
          var b = qel('button', 'qrow ' + grp[0]);
          b.appendChild(qel('span', 'qmark', grp[2])); b.appendChild(qel('span', '', one.name));
          b.onclick = function () { npcQuest = one.id; npcPick = -1; npcPanel(); };
          box.appendChild(b);
        });
      });
      return;
    }
    var ready = entry && entry.s === 'ready' && q.ender === npcTalk.ref;
    box.appendChild(qel('h4', '', q.name));
    if (!ready && questPic(q)) box.appendChild(questPic(q));
    box.appendChild(qtext('qsay', ready ? (q.doneText || 'Well done.') : entry ? (q.progressText || q.text || 'Not done yet.') : (q.text || '')));
    if (q.goals.length) box.appendChild(goalLines(q, entry ? entry.n : null));
    var rw = rewardText(q), picks = choiceList(q);
    if (rw) box.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
    if (picks.length) {
      box.appendChild(qel('div', 'qreward', ready ? 'Choose one:' : 'And one of:'));
      var row = qel('div', 'qpicks');
      picks.forEach(function (g, i) {
        var b = qel('button', ready && npcPick === i ? 'on' : '', g.qty + ' ' + itemName(g.item));
        if (ready) b.onclick = function () { npcPick = i; npcPanel(); }; else b.disabled = true;
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    var btns = qel('div', 'qbtns'), back = qel('button', '', 'Back');
    back.onclick = function () { npcQuest = ''; npcPanel(); };
    if (ready) {
      var done = qel('button', 'primary', 'Hand in');
      done.disabled = picks.length > 0 && npcPick < 0;
      done.onclick = function () { send({ type: 'quest', op: 'turnin', id: q.id, choice: picks.length ? npcPick : undefined }); };
      btns.appendChild(done);
    } else if (!entry) {
      var take = qel('button', 'primary', 'Accept');
      take.onclick = function () { send({ type: 'quest', op: 'accept', id: q.id }); };
      btns.appendChild(take);
    }
    btns.appendChild(back); box.appendChild(btns);
  }
  function toggleQuests() { questOpen = !questOpen; abandonArmed = ''; $('questp').hidden = !questOpen; if (questOpen) { questPanel(); didUi('quests'); } }
  function questPanel() {
    var box = $('quest-body'), qs = content.quests || {}, list = myQuests().filter(function (x) { return qs[x.id]; });
    box.innerHTML = '';
    if (!list.length) { box.appendChild(qel('div', 'empty', 'No quests yet. Talk to people: someone with work for you has a ! over their head.')); return; }
    list.forEach(function (x) {
      var q = qs[x.id], card = qel('div', 'qcard' + (x.s === 'ready' ? ' ready' : ''));
      card.appendChild(qel('b', '', q.tutorial ? 'Tutorial: ' + q.name : q.name));
      if (questPic(q)) card.appendChild(questPic(q));
      if (q.text) card.appendChild(qtext('qsay', q.text));
      if (q.goals.length) card.appendChild(goalLines(q, x.n));
      if (x.s === 'ready') card.appendChild(qel('div', 'qreturn', q.ender ? (q.goals.length ? 'Done: return to ' : 'Find ') + objName(q.ender) + '.' : 'Done.'));
      var rw = rewardText(q), pk = choiceList(q);
      if (pk.length) rw += (rw ? ' · ' : '') + 'one of: ' + pk.map(function (g) { return g.qty + ' ' + itemName(g.item); }).join(' / ');
      if (rw) card.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
      var btns = qel('div', 'qbtns');
      if (x.s === 'ready' && !q.ender) {                           // nobody to hand it to: it is claimed right here
        var fin = qel('button', 'primary', 'Claim');
        fin.onclick = function () { toggleQuests(); claimPanel(q.id); };
        btns.appendChild(fin);
      }
      var drop = qel('button', '', q.tutorial ? 'Skip tutorial' : abandonArmed === q.id ? 'Really give up?' : 'Give up');   // (a tutorial step is not given up: the whole tutorial is skipped)
      drop.onclick = function () { if (q.tutorial) skipTutorial(); else if (abandonArmed === q.id) { abandonArmed = ''; send({ type: 'quest', op: 'abandon', id: q.id }); } else { abandonArmed = q.id; questPanel(); } };
      btns.appendChild(drop); card.appendChild(btns);
      box.appendChild(card);
    });
  }
  /** The corner tracker: what you are on and how far along, without opening anything. */
  var trackerSig = '';
  function tracker() {
    var box = $('tracker'), qs = content.quests || {}, list = myQuests().filter(function (x) { return qs[x.id]; });
    var sig = JSON.stringify(list);
    if (sig === trackerSig) return;
    trackerSig = sig; box.innerHTML = '';
    list.slice(0, 5).forEach(function (x) {
      var q = qs[x.id], one = qel('div', 'tq' + (x.s === 'ready' ? ' ready' : ''));
      one.appendChild(qel('b', '', q.name));
      if (x.s === 'ready') one.appendChild(qel('div', '', q.ender ? (q.goals.length ? 'Return to ' : 'Find ') + objName(q.ender) : 'Done: claim it (L)'));
      else q.goals.forEach(function (g, i) {
        var have = Number(x.n[i]) || 0;
        one.appendChild(qtext(have >= g.need ? 'done' : '', goalLabel(g, have)));
      });
      box.appendChild(one);
    });
    if (list.length > 5) box.appendChild(qel('div', 'tq', '+' + (list.length - 5) + ' more (L)'));
  }
  /** Which NPCs on this map have something for you, worked out when your quests change (not every frame). */
  var questMarkList = [], questMarkSig = '';
  function questMarksUpdate() {
    var sig = me.map + '|' + JSON.stringify(myQuests().map(function (x) { return x.id + x.s; })) + '|' + (me.questsOpen || []).join() + '|' + (struct ? struct.rev : 0);
    if (sig === questMarkSig) return;
    questMarkSig = sig; questMarkList = [];
    if (!content.quests || !Object.keys(content.quests).length) return;
    (mapOf().entities || []).forEach(function (e) {
      var o = content.objects[e.ref]; if (!o || o.kind !== 'npc') return;
      var has = npcQuests(e.ref), kind = has.ready.length ? 'questdone' : has.open.length ? 'quest' : has.active.length ? 'questgo' : '';
      if (kind) questMarkList.push({ id: 'q:' + e.key, kind: kind, x: e.x, y: e.y });
    });
  }
  function questMarks(marks, T) {
    questMarkList.forEach(function (mk) {
      if (sight.vis && !sight.vis[mk.x + ',' + mk.y]) return;        // only over someone you can see
      marks.push({ id: mk.id, kind: mk.kind, x: mk.x, y: mk.y, up: T * 0.5 + 4 });
    });
  }
  // The welcome: quests a new character starts with (Config start_quests) are shown once, in a window, the first
  // time they enter the game. me.questIntro lists them until the referee hears the window was read.
  var introOpen = false, introAck = '';                     // introAck = the list last read (a new one may come later: a quest started by an action)
  function introPanel() {
    var ids = ((me && me.questIntro) || []).filter(function (id) { return (content.quests || {})[id]; });
    if (introOpen || !ids.length || ids.join() === introAck) return;
    introOpen = true; claimQuest = ''; npcTalk = null; npcQuest = '';
    var box = $('npc-body'); box.innerHTML = '';
    var teach = ids.some(isTutorial);
    $('npc-title').textContent = ids.every(isTutorial) ? 'Tutorial' : ids.length > 1 ? 'New quests' : 'New quest';
    ids.forEach(function (id) {
      var q = content.quests[id], rw = rewardText(q);
      box.appendChild(qel('h4', '', q.name));
      if (questPic(q)) box.appendChild(questPic(q));
      if (q.text) box.appendChild(qtext('qsay', q.text));
      if (q.goals.length) box.appendChild(goalLines(q, (questEntry(id) || {}).n || null));
      else if (q.ender) box.appendChild(qel('div', 'qgoals', '• Find ' + objName(q.ender)));
      if (rw) box.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
    });
    var btns = qel('div', 'qbtns'), go = qel('button', 'primary', 'Begin');
    go.onclick = closeIntro;
    if (teach) { var skip = qel('button', '', 'Skip tutorial'); skip.onclick = skipTutorial; btns.appendChild(skip); }
    btns.appendChild(go); box.appendChild(btns);
    $('npcp').hidden = false;
  }
  function closeIntro() {
    if (!introOpen) return;
    introOpen = false; introAck = ((me && me.questIntro) || []).join(); $('npcp').hidden = true;
    send({ type: 'quest', op: 'seen' });
    claimPanel();
  }
  // Quest complete: a quest with nobody to hand it to (no giver, no ender) is finished right where you stand. When
  // its last objective is met this window opens by itself with its done text and a Claim button; closed without
  // claiming, it stays ready in the quest log (L), from where it can be opened again.
  var claimQuest = '', claimPick = -1, claimSkipped = {};
  function claimPanel(openId) {
    var qs = content.quests || {};
    if (openId) { delete claimSkipped[openId]; claimQuest = openId; claimPick = -1; }
    if (introOpen || npcTalk) return;                          // one window at a time: this one waits its turn
    if (claimQuest) {
      var cur = questEntry(claimQuest);
      if (!cur || cur.s !== 'ready' || !qs[claimQuest]) { claimQuest = ''; $('npcp').hidden = true; }   // claimed (or no longer done)
    }
    if (!claimQuest) {
      var next = myQuests().filter(function (x) { var q0 = qs[x.id]; return x.s === 'ready' && q0 && !q0.ender && q0.goals.length && !claimSkipped[x.id]; })[0];
      if (!next) return;
      claimQuest = next.id; claimPick = -1;
    }
    var q = qs[claimQuest], entry = questEntry(claimQuest), box = $('npc-body'), rw = rewardText(q), picks = choiceList(q);
    box.innerHTML = ''; $('npc-title').textContent = 'Quest complete';
    box.appendChild(qel('h4', '', q.name));
    box.appendChild(qtext('qsay', q.doneText || 'Done.'));
    if (q.goals.length) box.appendChild(goalLines(q, entry.n));
    if (rw) box.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
    if (picks.length) {
      box.appendChild(qel('div', 'qreward', 'Choose one:'));
      var row = qel('div', 'qpicks');
      picks.forEach(function (g, i) {
        var b = qel('button', claimPick === i ? 'on' : '', g.qty + ' ' + itemName(g.item));
        b.onclick = function () { claimPick = i; claimPanel(); };
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    var btns = qel('div', 'qbtns'), go = qel('button', 'primary', rw || picks.length ? 'Claim' : 'Done');
    go.disabled = picks.length > 0 && claimPick < 0;
    go.onclick = function () { send({ type: 'quest', op: 'turnin', id: q.id, choice: picks.length ? claimPick : undefined }); };
    btns.appendChild(go); box.appendChild(btns);
    $('npcp').hidden = false;
  }
  function closeClaimQuest() { if (!claimQuest) return; claimSkipped[claimQuest] = 1; claimQuest = ''; $('npcp').hidden = true; }
  /** After every answer: the tracker, the marks, and whichever quest window is open. */
  function questsChanged() {
    if (!me) return;
    introPanel();
    claimPanel();
    tracker(); questMarksUpdate();
    if (npcTalk) npcPanel();
    if (questOpen) questPanel();
  }

  // ---- crafting panel (C, or use a crafting station): every recipe you know, what it needs, and Make buttons.
  // What can be made here is decided by World.recipesFor — the same check the referee runs on the craft action.
  var craftQty = {};                                           // how many of each recipe was last picked (the panel is redrawn often)
  function toggleCraft() { craftOpen = !craftOpen; $('craft').hidden = !craftOpen; if (craftOpen) { craftPanel(); didUi('craft'); } }
  function craftPanel() {
    var box = $('craft-items'); box.innerHTML = '';
    var recs = World.recipesFor(content, mapOf(), me, lookup());
    var near = recs.filter(function (r) { return r.station && r.here; }).map(function (r) { return r.station; });
    $('craft-note').textContent = !recs.length ? 'You don\'t know any recipes yet.'
      : near.length ? '' : 'Stand next to a workbench or campfire to make the things that need one.';
    var job = me.craft, jr = job && content.recipes && content.recipes[job.id];
    if (job) {
      var f = craftFrac() || { p: 0, on: false }, jrow = document.createElement('div'); jrow.className = 'slot';
      var jn = document.createElement('div'); jn.className = 'name';
      var jb = document.createElement('b'); jb.textContent = 'Making ' + ((jr && jr.name) || job.id) + (job.qty > 1 ? ' (' + (job.made + 1) + ' of ' + job.qty + ')' : '');
      var js = document.createElement('span'); js.textContent = f.on ? Math.round(f.p * 100) + '%' : 'waiting: go back to the ' + World.stationName(content, jr && jr.station);
      if (!f.on) js.className = 'lack';
      jn.appendChild(jb); jn.appendChild(js);
      var jbt = document.createElement('div'); jbt.className = 'btns';
      var stop = document.createElement('button'); stop.textContent = 'Stop'; stop.title = 'Stop and take back what was not used';
      stop.onclick = function () { send({ type: 'craft', cancel: true }); };
      var jp = document.createElement('div'); jp.className = 'pic';   // (keeps the row's columns in line with the recipes below)
      jbt.appendChild(stop); jrow.appendChild(jp); jrow.appendChild(jn); jrow.appendChild(jbt); box.appendChild(jrow);
    }
    var groups = {}, order = [];
    recs.forEach(function (r) { var g = r.category || 'Other'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(r); });
    order.forEach(function (g) {
      var h4 = document.createElement('h4'); h4.textContent = g; box.appendChild(h4);
      groups[g].sort(function (a, b) { return (b.can ? 1 : 0) - (a.can ? 1 : 0); }).forEach(function (r) {
        box.appendChild(recipeRow(r, job));
      });
    });
  }
  /** One recipe as a row: what it makes, what it needs (and how much of each you carry), how many, Make. A recipe
   *  you cannot make right now is still shown, with what is missing in red and its buttons off. */
  function recipeRow(r, job) {
    var out = r.outputs[0] || { item: '', qty: 1 }, it = content.items[out.item] || { name: r.name, sprite: '' };
    var row = document.createElement('div'); row.className = 'slot rcp' + (r.can ? '' : ' cant');
    var pic = itemPicEl(it, 32);
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
    // How many: arrows (or the wheel) from 1 up to what the ingredients in the bag allow, Max, then Make.
    var most = !r.can ? 0 : Math.min.apply(null, [World.CRAFT_MAX || 20].concat(r.inputs.map(function (g3) { return g3.qty > 0 ? Math.floor(g3.have / g3.qty) : Infinity; })));
    var n = Math.max(1, Math.min(most || 1, craftQty[r.id] || 1)), off = !!job || most < 1;
    var num = document.createElement('span'); num.className = 'qty'; num.textContent = n;
    function setN(v) {
      n = Math.max(1, Math.min(most || 1, v)); craftQty[r.id] = n; num.textContent = n;
      dn.disabled = off || n <= 1; up.disabled = mx.disabled = off || n >= most;
    }
    function mk(text, title, fn) { var bt = document.createElement('button'); bt.textContent = text; bt.title = title; bt.onclick = fn; return bt; }
    var dn = mk('▼', 'One less', function () { setN(n - 1); }), up = mk('▲', 'One more', function () { setN(n + 1); });
    var mx = mk('Max', 'As many as your ingredients allow', function () { setN(most); });
    var go = mk('Make', '', function () { send({ type: 'craft', recipe: r.id, qty: n }); });
    dn.className = up.className = 'step'; go.disabled = off;
    btns.onwheel = function (e) { if (off) return; e.preventDefault(); setN(n + (e.deltaY < 0 ? 1 : -1)); };
    [dn, num, up, mx, go].forEach(function (x) { btns.appendChild(x); });
    setN(n);
    row.title = r.reason || '';
    row.appendChild(pic); row.appendChild(name); row.appendChild(btns);
    return row;
  }
  // ---- the inventory window (I, or opening a storage container) ----
  // Grids of cells: your bag, the open container beside it, and the belt under them. A stack sits in the cell the
  // referee says (stack.s). Dragging one onto a cell sends the 'inv' action — put down, joined to more of the same,
  // or swapped with what is there, as World.invAct decides; Shift while dropping moves half of it, Ctrl just one.
  // Dropped on a belt slot it is assigned to it ('loadout'; out of a container it is taken into the bag first); a
  // belt slot dragged onto the bag is cleared. Shift+click sends a stack across at once; double-click uses or equips.
  // Nothing is decided here: every drop is an action the referee checks, and the window is redrawn from its answer.
  var EQUIP_CELLS = [{ slot: 'helm', label: 'Head' }, { slot: 'armor', label: 'Chest' }];   // the worn slots shown in the inventory window
  var invDrag = null, invDirty = false, invSel = -1, INV_COLS = 8, invPress = false, invSig = '';
  addEventListener('mouseup', function () { if (invPress) { invPress = false; if (invDirty && !invDrag) { invDirty = false; bag(); } } });
  setInterval(function () { if (bagOpen && storage && storage.cook && storage.cook.lit && !invDrag && !document.hidden) send({ type: 'store', key: storage.key, op: 'look' }); }, 1500);
  function invCell(id, qty, from, slot) {
    var it = id ? (content.items[id] || { name: id, type: '' }) : null, d = document.createElement('div');
    d.className = 'icell' + (it ? ' has' : '') + (from === 'bag' && it && slot === invSel ? ' sel' : '');
    if (!it) return d;
    d.appendChild(icon({ kind: 'item', id: id }));
    if (qty !== 1 || from === 'belt') { var q = document.createElement('span'); q.className = 'qty'; q.textContent = qty > 0 ? '×' + qty : '0'; d.appendChild(q); }
    if (from !== 'belt' && it.slot && me.equipment[it.slot] === id) d.classList.add('equipped');
    d.title = it.name + ' — ' + describe(it);
    d.draggable = true;
    d.onmousedown = function () { invPress = true; };
    d.ondragstart = function (e) { invDrag = { from: from, item: id, slot: slot, qty: qty }; try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* older browsers */ } };
    d.ondragend = function () { invDrag = null; invPress = false; if (invDirty) { invDirty = false; hotbar(); bag(); } };
    return d;
  }
  function invTarget(el, accepts, onDrop) {                 // el takes what is being dragged when accepts(drag) says so
    el.ondragover = function (e) { if (invDrag && accepts(invDrag)) { e.preventDefault(); el.classList.add('over'); } };
    el.ondragleave = function () { el.classList.remove('over'); };
    el.ondrop = function (e) { e.preventDefault(); el.classList.remove('over'); var g = invDrag; if (g && accepts(g)) onDrop(g, e); };
  }
  // Dragged out of the window (let go on the darkened screen around it): it is dropped, into a loot bag at your feet.
  (function () {
    var ov = $('bag');
    ov.addEventListener('dragover', function (e) { if (invDrag && invDrag.from === 'bag' && e.target === ov) e.preventDefault(); });
    ov.addEventListener('drop', function (e) {
      var g = invDrag; if (!g || g.from !== 'bag' || e.target !== ov) return;
      e.preventDefault(); invSel = -1;
      send({ type: 'inv', op: 'drop', s: g.slot, qty: g.qty });
    });
  })();
  /** Move a stack (or part of it) from one grid's cell to another's; no cell = wherever it fits. */
  function invMove(fromW, fromS, toW, toS, qty) {
    var a = { type: 'inv', from: { w: fromW, s: fromS }, to: { w: toW } };
    if (toS != null) a.to.s = toS;
    if (qty) a.qty = qty;
    if (storage) a.key = storage.key;
    send(a);
  }
  function invPart(g, e) { return e && e.shiftKey ? Math.ceil(g.qty / 2) : e && e.ctrlKey ? 1 : 0; }   // Shift = half, Ctrl = one, else all
  function invGrid(stacks, w, size) {
    var g = document.createElement('div'); g.className = 'igrid';
    var at = {}, top = -1;
    (stacks || []).forEach(function (st, i) { var c = st.s >= 0 ? st.s : i; at[c] = st; if (c > top) top = c; });
    var n = Math.max(INV_COLS, Math.ceil(Math.max(size || 0, top + 1) / INV_COLS) * INV_COLS);
    for (var i = 0; i < n; i++) (function (i) {
      var st = at[i], c = invCell(st && st.item, st && st.qty, w, i);
      if (size && i >= size) c.classList.add(st ? 'extra' : 'off');             // past the last cell: overflow, or not a cell at all
      if (!(size && i >= size)) invTarget(c, function (d) { return (d.from === 'bag' && !(w === 'box' && storage && storage.takeOnly)) || d.from === 'box' || ((d.from === 'belt' || d.from === 'worn') && w === 'bag'); }, function (d, e) {   // (nothing is dropped into a take-only container)
        if (d.from === 'belt') send({ type: 'loadout', bar: 'belt', slot: d.slot, entry: '' });
        else if (d.from === 'worn') useItem(d.item);
        else invMove(d.from, d.slot, w, i, invPart(d, e));
      });
      if (st) {
        c.onclick = function (e) {
          if (e.shiftKey && storage && !(w === 'bag' && storage.takeOnly)) { invMove(w, i, w === 'bag' ? 'box' : 'bag'); return; }
          if (w === 'bag') { invSel = invSel === i ? -1 : i; bag(); }
        };
        if (w === 'bag') c.ondblclick = function () { var it = content.items[st.item]; if (it && (World.itemCan(it, 'consume') || it.slot)) useItem(st.item); };
      }
      g.appendChild(c);
    })(i);
    return g;
  }
  function bag() {
    if (invDrag || invPress) { invDirty = true; return; }    // never redraw under a drag (or a press about to become one): the thing held would vanish
    // …nor when nothing it shows has changed: answers arrive several times a second
    var sig = JSON.stringify([me.inventory, me.belt, me.held, me.equipment, me.atk, me.def, me.gold, me.abilities, me.skills, storage && [storage.key, storage.inv, storage.slots, storage.cook, storage.takeOnly], invSel, me.craft && [me.craft.id, me.craft.qty, me.craft.made]]);
    var box = $('bag-items');
    if (sig === invSig && box.firstChild) return;
    invSig = sig; box.innerHTML = '';
    function el(tag, cls, text) { var d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
    var bagSize = World.bagSlots ? World.bagSlots(content) : INV_COLS * 4, used = (me.inventory || []).length;
    $('bag-title').textContent = storage ? storage.name : 'Inventory';
    $('bag-stats').textContent = (content.classes[me['class']] ? content.classes[me['class']].name + ' · ' : '') +
      'Attack ' + me.atk + ' · Defence ' + me.def + ' · ' + me.gold + ' gold';
    var cols = el('div', 'inv-cols');
    // your bag
    var mine = el('div', 'inv-col'), mh = el('h4', '', 'Bag (' + used + '/' + bagSize + ')');
    if (used > bagSize) mh.className = 'lack';
    function headBtn(h4, text, title, fn) { var hb = el('button', 'hbtn', text); hb.title = title; hb.onclick = fn; h4.appendChild(hb); return hb; }
    headBtn(mh, 'Sort', 'Put the bag in order: the same things joined into full stacks, kinds together', function () { invSel = -1; send({ type: 'inv', op: 'sort' }); }).disabled = !used;
    mine.appendChild(mh); mine.appendChild(invGrid(me.inventory, 'bag', bagSize));
    mine.appendChild(el('div', 'empty', 'Drag something out of the window to drop it.'));
    cols.appendChild(mine);
    // the open container
    if (storage) {
      var inv = Array.isArray(storage.inv) ? storage.inv : Object.keys(storage.inv || {}).map(function (id, i) { return { item: id, qty: storage.inv[id], s: i }; });   // (an older referee sends {item: qty})
      var theirs = el('div', 'inv-col');
      theirs.appendChild(el('h4', '', storage.name + (storage.slots ? ' (' + inv.length + '/' + storage.slots + ')' : '')));
      if (!storage.cook) headBtn(theirs.firstChild, 'Take all', 'Everything in it, into your bag', function () { send({ type: 'inv', op: 'takeall', key: storage.key }); }).disabled = !inv.length;
      var sgrid = invGrid(inv, 'box', storage.slots || INV_COLS * 2);
      if (storage.cook) {                                       // a cooker: three named cells, and the fire
        ['In', 'Fuel', 'Out'].forEach(function (lab, ci) { if (sgrid.children[ci]) sgrid.children[ci].appendChild(el('span', 'key', lab)); });
        sgrid.classList.add('cook');
        theirs.firstChild.textContent = storage.name + (storage.cook.lit ? ' — burning' : '');
      }
      theirs.appendChild(sgrid);
      if (storage.cook) {
        var ck = storage.cook, fire = el('div', 'inv-info'), note = el('span', 'empty', !ck.lit ? 'Put fuel in the middle cell and something to cook in the first, then light it.'
          : 'Fuel piece: ' + Math.ceil(ck.burn / 1000) + ' s left' + (ck.need ? ' · cooking ' + Math.min(100, Math.round(100 * ck.prog / ck.need)) + '%' : ' · nothing to cook'));
        var fb = el('button', '', ck.lit ? 'Put out' : 'Light');
        fb.onclick = function () { send({ type: 'store', key: storage.key, op: ck.lit ? 'douse' : 'light' }); };
        fire.appendChild(note); fire.appendChild(fb); theirs.appendChild(fire);
      }
      cols.appendChild(theirs);
    } else {
      // what you wear, and what you can make with your hands
      var side = el('div', 'inv-col inv-side');
      side.appendChild(el('h4', '', 'Equipment'));
      var worn = el('div', 'igrid worn');
      EQUIP_CELLS.forEach(function (q) {
        var id = (me.equipment || {})[q.slot], c = invCell(id && content.items[id] ? id : '', 1, 'worn', q.slot);
        c.classList.remove('equipped');
        c.appendChild(el('span', 'key', q.label));
        if (!id) c.title = q.label + ': drag something you can wear here';
        else c.ondblclick = function () { useItem(id); };                    // take it off (it stays in the bag)
        invTarget(c, function (d) { var it = content.items[d.item]; return d.from === 'bag' && !!it && it.slot === q.slot; }, function (d) { if (me.equipment[q.slot] !== d.item) useItem(d.item); });
        worn.appendChild(c);
      });
      side.appendChild(worn);
      var hand = World.recipesFor(content, mapOf(), me, lookup()).filter(function (r) { return !r.station; });
      side.appendChild(el('h4', '', 'Make by hand'));
      var list = el('div', 'inv-craft'), job = me.craft, jr = job && content.recipes && content.recipes[job.id];
      if (job) {
        var jrow = el('div', 'slot rcp'), jn = el('div', 'name'), jbt = el('div', 'btns'), stop = el('button', '', 'Stop');
        jn.appendChild(el('b', '', 'Making ' + ((jr && jr.name) || job.id) + (job.qty > 1 ? ' (' + (job.made + 1) + ' of ' + job.qty + ')' : '')));
        stop.title = 'Stop and take back what was not used'; stop.onclick = function () { send({ type: 'craft', cancel: true }); };
        jbt.appendChild(stop); jrow.appendChild(el('div', 'pic')); jrow.appendChild(jn); jrow.appendChild(jbt); list.appendChild(jrow);
      }
      hand.sort(function (x, y) { return (y.can ? 1 : 0) - (x.can ? 1 : 0); }).forEach(function (r) { list.appendChild(recipeRow(r, job)); });
      if (!hand.length) list.appendChild(el('div', 'empty', 'You know nothing that can be made without a workbench.'));
      side.appendChild(list);
      cols.appendChild(side);
    }
    box.appendChild(cols);
    // what is picked in the bag: what it is, and what can be done with it
    var info = el('div', 'inv-info'), sel = invSel >= 0 ? (me.inventory || []).filter(function (s) { return s.s === invSel; })[0] : null;
    if (!sel) { invSel = -1; info.appendChild(el('span', 'empty', (storage && storage.takeOnly ? 'Drag what you want out of the ' + storage.name.toLowerCase() + ' into your bag. Nothing can be put in it; emptied, it is gone.' : storage ? 'Drag things between your bag and the ' + storage.name.toLowerCase() + ', onto another cell, or onto a slot of the belt at the bottom of the screen.' : 'Drag a stack to another cell, or onto a slot of the belt at the bottom of the screen to carry it there.') + ' Hold Shift while dropping to move half, Ctrl for one.' + (storage ? ' Shift+click sends a stack across.' : ' Double-click uses or equips.'))); }
    else {
      var it = content.items[sel.item] || { name: sel.item, type: '' }, equipped = it.slot && me.equipment[it.slot] === sel.item;
      var nm = el('div', 'name'); nm.appendChild(el('b', '', it.name + (sel.qty > 1 ? ' ×' + sel.qty : ''))); nm.appendChild(el('span', '', describe(it) + (equipped ? ' · equipped' : '') + (World.stackMaxOf ? ' · stacks to ' + World.stackMaxOf(content, sel.item) : '')));
      info.appendChild(nm);
      var eats = World.itemCan(it, 'consume');
      if (eats || it.slot) { var ub = el('button', '', eats ? 'Use' : (equipped ? 'Unequip' : 'Equip')); ub.onclick = function () { useItem(sel.item); }; info.appendChild(ub); }
      if (storage && !storage.takeOnly) { var pb = el('button', '', 'Store'); pb.onclick = function () { invMove('bag', sel.s, 'box'); }; info.appendChild(pb); }
    }
    box.appendChild(info);
    // abilities (only with Config skills on): which two sit on Q and E
    if (skillsOn()) {
      box.appendChild(el('h4', '', 'Abilities (Q / E)'));
      (me.skills || []).forEach(function (id) {
        var sk = content.skills[id]; if (!sk) return;
        var row = el('div', 'sk'); row.appendChild(icon({ kind: 'skill', id: id }));
        var inf = el('div', 'name'); inf.appendChild(el('b', '', sk.name)); inf.appendChild(el('span', '', describeSkill(sk).split('\n')[1]));
        var wrap = el('div', 'slots');
        ['Q', 'E'].forEach(function (lab, i) {
          var b = el('button', (me.abilities || [])[i] === id ? 'on' : '', lab); b.title = 'Put in slot ' + lab;
          b.onclick = function () { send({ type: 'loadout', bar: 'ability', slot: i, entry: (me.abilities || [])[i] === id ? '' : id }); };
          wrap.appendChild(b);
        });
        inf.appendChild(wrap); row.title = describeSkill(sk); row.appendChild(inf); box.appendChild(row);
      });
      var cls = content.classes[me['class']], next = cls && cls.skills.filter(function (x) { return x.level > me.level; })[0];
      if (next && content.skills[next.skill]) box.appendChild(el('div', 'empty', 'Next: ' + content.skills[next.skill].name + ' at level ' + next.level));
    }
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
  $('npc-close').onclick = function () { if (introOpen) closeIntro(); else if (claimQuest) closeClaimQuest(); else closeNpc(); };
  $('quest-close').onclick = toggleQuests;
  $('btn-quests').onclick = toggleQuests;
  $('store-close').onclick = closeStore;
  $('claim-close').onclick = closeClaim;

  // ---------------------------------------------------------------- map and loop
  function enterMap() {
    armed = null; throwing = null;
    watchLive();                          // (re)subscribe to live monster/player pushes for this map
    hud();
    setNet('loading art…');
    // the art of every floor of this building: the floors below are drawn too when you stand upstairs
    var famMaps = World.floorsOf(content, me.map).map(function (f) { return floorMap(f.id); }).filter(function (m) { return m && m.id !== me.map; });
    return Promise.all([Assets.loadForMap(content, mapOf())].concat(famMaps.map(function (m) { return Assets.loadForMap(content, m); }))).then(function () {
      renderer.setMap(mapOf(), floorMaps());
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
    var pollMs = api.mode !== 'online' ? (api.pushed ? 5000 : 250)   // a host with a loop sends the world itself: just say we are here
      : livePush ? (content.config.heartbeat_ms || 3000)
      : (content.config.poll_ms || 500);
    // Every heartbeat is a paid request. Nobody watching (the tab is hidden) = none at all; nobody playing (no key or
    // mouse for a minute) = a slow one. The first input, or coming back to the tab, asks at once.
    if (livePush) {
      if (document.hidden) pollMs = Infinity;
      else if (performance.now() - lastInput > (content.config.idle_after_ms || 60000)) pollMs = content.config.idle_heartbeat_ms || 20000;
    }
    if (now - lastReply > pollMs) poll();

    ease(shown, me, dt / moveMs);
    if (harvesting) harvestSwing();
    // hold-to-fire: while aiming with the left button down, a semi/auto weapon keeps firing on its cadence
    if (aiming && leftHeld && hover) {
      var hw = World.rangedWeapon(content, me);
      if (hw && (hw.fireMode === 'semi' || hw.fireMode === 'auto')) {
        var cost = hw.ammoCost || 1, clip = Number(hw.clip) || 0, mag = (me.mags && me.mags[hw.id]) || 0;
        var canFire = !me.reload && (clip > 0 ? mag >= cost : (hw.ammo ? count(hw.ammo) >= cost : true));
        var cd = Math.max(120, Number(hw.fireMs) || 300);
        if (canFire && now - lastHoldShot >= cd) shootAt(hover);   // shootAt sets lastHoldShot + facing
      }
    }
    var myst = me.statuses && me.statuses.length && content.statuses[me.statuses[0].id];
    // while aiming, the body faces the cursor's side derived from the aim angle — not me.facing, which a
    // poll can briefly reset to the server's value (it never hears the aim), which would flicker the flip.
    var myFacing = aiming ? (Math.cos(aimAngle) < 0 ? 'W' : 'E') : me.facing;
    var actors = [{ x: shown.x, y: shown.y, facing: myFacing, name: me.name, hp: me.hp, maxHp: me.maxHp, me: true, layers: playerLayers(me) || undefined, aim: aiming ? aimAngle : null, swing: (performance.now() - swingT0) / SWING_MS, statusColor: myst ? myst.color : '' }];
    var seen = {}, marks = [], tMark = performance.now(), TM = content.config.tile_size || 32;
    reloadMark(marks, TM); craftMark(marks, TM); questMarks(marks, TM);
    view.monsters.forEach(function (m) {
      var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, s = shownOthers[m.id] || (shownOthers[m.id] = { x: m.x, y: m.y });
      ease(s, m, dt / 250); seen[m.id] = 1;
      var stc = m.statuses && m.statuses.length && content.statuses[m.statuses[0]];
      var lay = monsterLayers(m);                                        // paper-doll zombies carry a rolled look
      // sprite '' (not undefined) keeps the monster health-bar colour + no name label even when layered
      actors.push({ x: s.x, y: s.y, facing: m.facing, name: d.name, sprite: lay ? '' : (d.sprite || ''),
        layers: lay || undefined, hp: m.hp, maxHp: m.maxHp, statusColor: stc ? stc.color : '' });
      // "!" when it starts after someone it sees, "?" when it loses them — for a moment, and only if you can see it
      var al = m.alert || 0, ar = alertSt[m.id] || (alertSt[m.id] = { a: al, until: 0, kind: '' });
      if (al !== ar.a) {
        if (al === 2) { ar.kind = 'alert'; ar.until = tMark + ALERT_MS; }
        else if (al === 1 && ar.a === 2) { ar.kind = 'search'; ar.until = tMark + ALERT_MS; }
        else ar.until = 0;
        ar.a = al;
      }
      if (tMark < ar.until && (!sight.vis || sight.vis[m.x + ',' + m.y])) marks.push({ id: 'm:' + m.id, kind: ar.kind, x: s.x, y: s.y, up: lay ? TM * 0.5 + 4 : 4 });
    });
    Object.keys(alertSt).forEach(function (id) { if (!seen[id]) delete alertSt[id]; });
    setMarks(marks);
    view.players.forEach(function (q) {
      var s = shownOthers['p:' + q.id] || (shownOthers['p:' + q.id] = { x: q.x, y: q.y });
      ease(s, q, dt / moveMs); seen['p:' + q.id] = 1;
      var act = othersAct(q, tMark);
      actors.push({ x: s.x, y: s.y, facing: q.facing, name: q.name, tint: '#b6553d', layers: playerLayers(q) || undefined, hp: q.hp, maxHp: q.maxHp, swing: (tMark - act.t0) / SWING_MS });
    });
    Object.keys(shownOthers).forEach(function (k) { if (!seen[k]) delete shownOthers[k]; });

    var T = content.config.tile_size || 32, map = renderer.map;
    var cam = {
      x: clamp((shown.x + 0.5) * T - canvas.width / 2, 0, map.width * T - canvas.width),
      y: 0
    };
    // The view is centred on where you are DRAWN: on raised ground that is higher up the screen than your tile.
    var myLift = Render.liftAt ? Render.liftAt(map, clamp(shown.x, 0, map.width - 1), clamp(shown.y, 0, map.height - 1), T) : 0;
    cam.y = clamp((shown.y + 0.5) * T - myLift - canvas.height / 2, -myLift, map.height * T - canvas.height);
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
    if (map.height * T >= canvas.height) cam.y = clamp(cam.y, -myLift, map.height * T - canvas.height);
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
    renderer.draw(cam, actors, { states: states, hidden: hiddenEntity, explored: explored, vis: vis, memory: mem, sensed: null, cutAll: removing && wallsDown, floorActors: floorActors(dt), floorStates: floorStates(), floorSight: floorSight() });
    if (removing) renderer.drawRemove(cam, removeTarget(), wallsDown);
    if (moveTool && !moveTool.key) renderer.drawRemove(cam, moveTarget(), false, true);
    if (moveTool && moveTool.key) renderer.drawGhost(cam, buildTarget());
    var bpNow = building && content.blueprints && content.blueprints[building];
    if (removing || (bpNow && (bpNow.places === 'roof' || bpNow.places === 'tile'))) renderer.drawRoofs(cam, mapOf());   // where roof already is: you stand under it and cannot see it
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
    if (moveTool && moveTool.key && moveTool.key === e.key) return true;        // in hand (the move tool): only its ghost is drawn
    if ((o.kind === 'spawn' || o.kind === 'trigger') && !o.sprite) return true;   // spriteless markers are editor-only; a sprited one (a nest, portal…) is a visible spawner
    if (o.kind === 'trap') { var pr = World.props(content, e); return Content.bool(pr.hidden) && pr.trigger !== 'timed' && view.states[e.key] !== 'down'; }
    return false;
  }

  // ---------------------------------------------------------------- start
  // The character screen: a name, a class when there is more than one, and how the character looks — hair shape and
  // colour, from World.hairChoices (the same list the referee accepts) — with the figure drawn as you choose.
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
      cls.parentNode.hidden = Object.keys(content.classes).length < 2;
      var ch = World.hairChoices ? World.hairChoices(content) : { styles: [content.config.start_hair || ''], colors: [content.config.start_hair_color || 'hair_brown'], style: content.config.start_hair || '', color: content.config.start_hair_color || 'hair_brown' };
      var look = { body: '', skin: ch.skin || 'skin_light', hair: ch.style, hairColor: ch.color };
      // one figure: the class's body with a hair shape in a colour, scaled up without smoothing
      function bodyOf(kind) { return World.bodySprite ? World.bodySprite(content, { 'class': cls.value, body: kind }) : ((content.classes[cls.value] || {}).bodySprite || ''); }
      function doll(cv, hair, color, kind) {
        var g = cv.getContext('2d'), bp = bodyOf(kind === undefined ? look.body : kind), body = bp && Assets.get(bp);
        g.clearRect(0, 0, cv.width, cv.height); g.imageSmoothingEnabled = false;
        if (body) g.drawImage(Tint.skinned ? Tint.skinned(body, look.skin, false) : body, 0, 0, cv.width, cv.height);
        var img = hair && Assets.get(hair);
        if (img) g.drawImage(Tint.getTintedLayer(img, Assets.get(maskOf(hair)), Tint.TINTS[color]) || img, 0, 0, cv.width, cv.height);
      }
      function draw() {
        doll($('join-preview'), look.hair, look.hairColor);
        var hs = $('join-hair'), cs = $('join-color'), bs = $('join-body-pick'); hs.innerHTML = ''; cs.innerHTML = ''; bs.innerHTML = '';
        [['', 'Male'], ['female', 'Female']].forEach(function (kind) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jbody' + (kind[0] === look.body ? ' on' : ''); b.textContent = kind[1];
          b.onclick = function () { look.body = kind[0]; draw(); };
          bs.appendChild(b);
        });
        ch.styles.forEach(function (path) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jpick' + (path === look.hair ? ' on' : '');
          b.title = path ? path.replace(/^.*\/hair_?/, '').replace(/\.png$/i, '').replace(/_/g, ' ') : 'bald';
          var cv = document.createElement('canvas'); cv.width = 32; cv.height = 48; doll(cv, path, look.hairColor); b.appendChild(cv);
          b.onclick = function () { look.hair = path; draw(); };
          hs.appendChild(b);
        });
        var ss = $('join-skin'); ss.innerHTML = '';
        (ch.skins || []).forEach(function (name) {
          var col = Tint.SKINS && Tint.SKINS[name]; if (!col) return;
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jswatch' + (name === look.skin ? ' on' : '');
          b.title = name.replace(/^skin_/, ''); b.style.background = col;
          b.onclick = function () { look.skin = name; draw(); };
          ss.appendChild(b);
        });
        ch.colors.forEach(function (name) {
          var ramp = Tint.TINTS[name]; if (!ramp) return;
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jswatch' + (name === look.hairColor ? ' on' : '');
          b.title = name.replace(/^hair_/, ''); b.style.background = 'linear-gradient(135deg, ' + ramp[3] + ', ' + ramp[1] + ')';
          b.onclick = function () { look.hairColor = name; draw(); };
          cs.appendChild(b);
        });
      }
      cls.onchange = draw;
      draw();
      // the pictures come in as they load: draw again when they have
      var need = [];
      Object.keys(content.classes).forEach(function (id) { if (content.classes[id].bodySprite) need.push(content.classes[id].bodySprite); });
      ['', 'female'].forEach(function (kind) { var bp = bodyOf(kind); if (bp) need.push(bp); });
      ch.styles.forEach(function (path) { if (path) { need.push(path); need.push(maskOf(path)); } });
      Promise.all(need.map(function (path) { return Assets.load(path); })).then(function () { if (!box.hidden) draw(); });
      box.hidden = false; input.focus();
      $('join-form').onsubmit = function (e) {
        e.preventDefault();
        var name = input.value.trim().slice(0, 16);
        if (!name) { input.focus(); return; }
        box.hidden = true; done({ name: name, cls: cls.value, look: look });
      };
    });
  }

  function setupDebug() {
    var sel = $('map-pick');
    if (api.mode !== 'offline') { sel.hidden = true; return; }
    Object.keys(content.maps).forEach(function (id) {
      if (content.maps[id].auto) return;                   // the empty storeys the game supplies: nowhere to stand
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
  api.onPush = takePush;
  api.loadContent().then(function (c) {
    if (Content.tidyMaps) Content.tidyMaps(c);              // (settings of map objects sent as text by an older referee: parsed here)
    if (Content.autoFloors) Content.autoFloors(c);          // the empty storeys above every map, for roofs and upper floors (same ids as the referee's)
    content = c;
    var T = c.config.tile_size || 32;
    canvas.width = (c.config.view_w || 15) * T;
    canvas.height = (c.config.view_h || 11) * T;
    $('frame').style.setProperty('--ar', (canvas.width / canvas.height).toFixed(4));   // the view fills the window, keeping its shape (index.html)
    renderer = new Render.Renderer(canvas, c);
    return api.resume();
  }).then(function (res) {
    if (res && res.player && content.maps[res.player.map]) return res;
    return askName().then(function (a) { return api.join(a.name, a.cls, a.look); });
  }).then(function (res) {
    // ?map=<id> (from the editor's Play-test button) starts on that map, offline only
    var want = new URLSearchParams(location.search).get('map');
    // …unless the character is already somewhere in that building: a floor is a map of its own, and reopening the
    // page must leave you on the floor and the spot you were on, not send you back to the ground floor's start.
    if (want && api.mode === 'offline' && content.maps[want] && World.groundId(content, want) !== World.groundId(content, res.player.map)) return api.warp(want);
    return res;
  }).then(apply).then(function () {
    setupDebug();
    log('WASD / arrows move · hold right-click to aim (left-click fires toward the cursor; R reloads) · left-click to interact, hold it for options · F/Space to use what you face · ' + (skillsOn() ? 'Q/E abilities · ' : '') + 'mouse wheel or 1-9, 0 choose what you hold from the belt (click to use food and the like) · I bag · C craft · B build.', 'info');
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
