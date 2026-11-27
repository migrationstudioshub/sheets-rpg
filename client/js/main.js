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
  var fx = [], bagOpen = false;
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
  var lastHoldShot = 0, aimAngle = 0, aimFar = null, lookSide = '', HOLD_CLICK_MS = 250;   // left-press longer than this opens the action list
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
  var SLOT_Z = { back: 0, body: 1, legs: 2, pants: 2, feet: 2.5, armor: 3, belt: 3.2, gloves: 3.5, beard: 3.8, head: 4, face: 4.5, helm: 5, accessory: 5.5, offhand: 6, weapon: 7 };
  function maskOf(path) { return path ? path.replace(/\.png$/i, '.tint.png') : ''; }   // sibling grey tint mask
  /** Ordered layer descriptors for a player, lowest slot first: the class base body, the hair
   *  (head slot, hidden when anything is worn in `helm`, or anything worn hides the head — Items hides_head,
   *  a poncho's hood, which also leaves out the helm's picture), then each equipped item with a worn
   *  sprite. A descriptor is { path, mask?, ramp? } — a tintable garment or hair carries its grey
   *  mask and a 4-colour ramp from Tint.TINTS. Returns null when the class has no body art (the
   *  renderer then falls back to the drawn hero). */
  function playerLayers(p) {
    var cls = p && content.classes[p['class']], body = cls && (World.bodySprite ? World.bodySprite(content, p) : cls.bodySprite);   // the man's or the woman's
    if (!body) return null;
    var eq = p.equipment || {}, fem = p.body === 'female', out = [{ z: SLOT_Z.body, path: body, skin: p.skin || '', skinAll: true, jig: fem }];   // (jig: the layers a woman's chest moves in, see Render CHEST)
    function wornHas(what) { return Object.keys(eq).some(function (s) { var it = content.items[eq[s]]; return it && it[what] && it.slot === s.replace(/\d+$/, ''); }); }
    var hood = wornHas('hidesHead'), noBeard = wornHas('hidesBeard');     // (Items hides_head / hides_beard: draw-only ticks)
    if (p.hair && !eq.helm && !hood) {                                   // hair is whole-tintable; a helm (or a hood) hides it
      out.push({ z: SLOT_Z.head, path: p.hair, mask: maskOf(p.hair), ramp: Tint.TINTS[p.hairColor] });
    }
    if (p.beard && !noBeard) {                                                     // facial hair: its own colour (the hair's when none was picked); under the hair and whatever is worn on the face
      out.push({ z: SLOT_Z.beard, path: p.beard, mask: maskOf(p.beard), ramp: Tint.TINTS[p.beardColor || p.hairColor] });
    }
    Object.keys(eq).forEach(function (slot) {
      var it = content.items[eq[slot]];
      if (!it || !it.wornSprite) return;
      if (slot !== 'weapon' && it.slot !== slot.replace(/\d+$/, '')) return;   // (only what is worn in its own place is drawn)
      if (hood && slot === 'helm' && !it.hidesHead) return;              // under the hood
      var ramp = it.defaultTint ? Tint.TINTS[it.defaultTint] : null;     // item is tintable iff it names a default tint
      // A weapon with a magazine may look different empty or being reloaded (a bow: no arrow / being drawn). Yours is
      // known from your own magazine and reload; another player's comes with them (wst).
      var wpath = Assets.wornFor(it.wornSprite, p.body === 'female');   // (the woman's cut, when the garment has one)
      if (slot === 'weapon' && (it.wornEmpty || it.wornReload || it.wornAim)) {
        var wst = p.mags ? (World.weaponState ? World.weaponState(content, p) : '') : (p.wst || '');
        if (wst === 'reload') wpath = it.wornReload || it.wornEmpty || wpath; else if (wst === 'empty') wpath = it.wornEmpty || wpath;
        else if (p === me && aiming && it.wornAim) wpath = it.wornAim;   // loaded and aimed (yours only: nobody is told where another player aims)
      }
      var zk = SLOT_Z[slot] != null ? slot : slot.replace(/\d+$/, '');   // (accessory1…4)
      out.push({ z: SLOT_Z[zk] != null ? SLOT_Z[zk] : 9, path: wpath, slot: slot, skin: slot === 'weapon' || slot === 'offhand' ? (p.skin || '') : '',
        mask: ramp ? maskOf(wpath) : '', ramp: ramp, aimPoints: it.aim || null, jig: fem && slot === 'armor' });
    });
    // Whatever else is in hand (food, a bottle, a grenade, a bedroll, a tool with no held picture): its own icon, small, at the
    // hand (Render draws a layer marked `icon` that way). Yours is your belt slot in hand; another player's comes as `hand`.
    var hid = typeof p.held === 'number' ? (p.held >= 0 ? (p.belt || [])[p.held] || '' : '') : (p.hand || ''), hit = hid && content.items[hid];
    if (hit && hit.sprite && !(hit.slot === 'weapon' && hit.wornSprite) && !out.some(function (l) { return l.slot === 'weapon'; })) {
      var hr = hit.defaultTint ? Tint.TINTS[hit.defaultTint] : null;
      out.push({ z: SLOT_Z.weapon, path: hit.sprite, slot: 'hand', icon: true, mask: hr ? maskOf(hit.sprite) : '', ramp: hr });
    }
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
    var tone = Tint.lookSkin ? Tint.lookSkin(m.look) : '';                // a body rolled with a skin tone colours its hands too
    var fem = Tint.femaleLook && Tint.femaleLook(m.look);
    var out = m.look.map(function (l) {
      if (fem) l = { path: Assets.wornFor(l.path, true), tint: l.tint };   // a woman's body: the woman's cut of what it wears
      var sk = tone ? Tint.skinFor(l.path, tone) : null;
      var tint = Tint.lookTint ? Tint.lookTint(l.path, l.tint) : l.tint, ramp = tint ? Tint.TINTS[tint] : null;   // no colour given = the garment default
      return { path: l.path, mask: ramp ? maskOf(l.path) : '', ramp: ramp, skin: sk ? sk.tone : '', skinAll: sk ? sk.all : false, jig: fem && Tint.chestLayer(l.path) };
    });
    out.forEach(function (l) {                                           // make sure late-arriving layers load
      if (!Assets.get(l.path)) Assets.load(l.path);
      if (l.mask && !Assets.get(l.mask)) Assets.load(l.mask);
    });
    return out;
  }

  /** An NPC with an outfit — object properties.outfit = [{path, tint}], bottom to top (Content Studio → Objects, kind
   *  npc) — is drawn as a figure like a player, not as its object picture. Answers the layers that have a picture. */
  function outfitOf(o) { return Render.outfitOf ? Render.outfitOf(o) : null; }
  function phaseOf(id) { var s = String(id), n = 0; for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 6283; return n / 1000; }   // where in its breath a figure is (0..2π), fixed per id
  // The outfitted NPCs of the map you are on (looked up again only when the map or what is built on it changes).
  var npcEnts = [], npcSig = '', npcFace = {};
  function npcList() {
    var sig = me.map + '|' + (struct ? struct.rev : 0);
    if (sig === npcSig) return npcEnts;
    npcSig = sig; npcEnts = [];
    (mapOf().entities || []).forEach(function (e) {
      var o = content.objects[e.ref], fit = outfitOf(o);
      if (fit) npcEnts.push({ e: e, o: o, look: fit, ph: phaseOf(e.key) });
    });
    return npcEnts;
  }
  var NPC_NAME_R = 3;                                                    // tiles: this near, an NPC's name shows over its head (or with the mouse on it)
  /** The NPCs as figures for the renderer. Each always faces YOU (worked out here, so every player sees it turned
   *  towards themself); standing right above or below it, it keeps the way it last faced. */
  function npcActors(actors, at, sceneEm) {
    var list = npcList(), near1 = {};                                    // a scene's emote over an NPC goes on its placement nearest you
    (sceneEm || []).forEach(function (em) {
      if (em.over !== 'npc') return;
      var best = null, bd = Infinity;
      list.forEach(function (n) { if (n.e.ref !== em.npc) return; var d = Math.abs(n.e.x - at.x) + Math.abs(n.e.y - at.y); if (d < bd) { bd = d; best = n.e.key; } });
      if (best) near1[best] = em;
    });
    list.forEach(function (n) {
      if (scenePupKeys[n.e.key]) return;                                 // a scene moves this one (sceneActors draws it)
      var e = n.e, f = at.x < e.x - 0.05 ? 'W' : at.x > e.x + 0.05 ? 'E' : (npcFace[e.key] || 'E');
      npcFace[e.key] = f;
      var near = Math.max(Math.abs(at.x - e.x), Math.abs(at.y - e.y)) <= NPC_NAME_R || (hover && hover.x === e.x && hover.y === e.y);
      var stand = (e.data && e.data.emote) || (n.o.properties && n.o.properties.emote);   // its standing emote (a sleeping guard: zzz)
      actors.push({ x: e.x, y: e.y, facing: f, name: near ? ((e.data && e.data.name) || n.o.name || '') : '', nameColor: '#ffe9a8',
        layers: Render.outfitLayers(n.look), fixed: true, idle: true, ph: n.ph,
        emote: near1[e.key] || (stand && stand !== 'none' ? { id: stand, t: performance.now() + n.ph * 1000, left: Infinity } : null) });
    });
  }
  // ---- a scene's actors (client/js/scene.js, stage 2). Scene.puppets() says where each stands; here is who they are:
  // `me`, `npc:<object id>` (on the map: the placement nearest you is taken over and its real figure hidden; not on
  // the map: brought in by a Show step) or `mon:<monster id>`. Draw-only: when the scene ends they are gone.
  var scenePupKeys = {}, sceneLooks = {};
  function sceneActorAt(ref) {                                           // where an actor stands before the scene moves it
    if (ref === 'me') return { x: shown.x, y: shown.y, facing: me.facing === 'W' ? 'W' : 'E' };
    if (ref.indexOf('npc:') !== 0 || ref.indexOf('|') >= 0) return null;
    // (copy n of an NPC that stands on the map several times = the n-th nearest to you)
    var who = sceneRef(ref), list = (mapOf().entities || []).filter(function (e) { return e.ref === who.id; })
      .map(function (e) { return { e: e, d: Math.abs(e.x - shown.x) + Math.abs(e.y - shown.y) }; }).sort(function (a, b) { return a.d - b.d; });
    var best = list[who.n - 1] && list[who.n - 1].e;
    return best ? { x: best.x, y: best.y, key: best.key, facing: shown.x < best.x ? 'W' : 'E' } : null;
  }
  /** An actor's ref taken apart: "mon:rat#2|3" = {kind: 'mon', id: 'rat', n: 2 (which copy), base: 'mon:rat#2' (its pack)}. */
  function sceneRef(ref) {
    var base = String(ref).split('|')[0], m = /^(\w+):([^#]*)(?:#(\d+))?$/.exec(base);
    return m ? { kind: m[1], id: m[2], n: Math.max(1, Number(m[3]) || 1), base: base } : { kind: ref === 'me' ? 'me' : '', id: '', n: 1, base: base };
  }
  /** The n free tiles nearest a tile that can be walked to from it (the tile itself first): where a pack stands. */
  function sceneSpots(at, n) {
    // (World.packSpots: the referee asks the same when a pack stays, so it stays where it was seen)
    var map = mapOf(), opts = World.viewOpts(content, map, Object.assign({}, view, { monsters: [], players: [] }), me.id);
    var out = World.packSpots(content, map, at, n, opts);
    while (out.length < n) out.push(out[0]);
    return out;
  }
  function sceneFigure(ref) {                                            // how an actor looks: {layers} or {sprite}, and its name
    if (ref === 'me') return { layers: playerLayers(me) || undefined, name: me.name };
    var id = sceneRef(ref).id;
    if (ref.indexOf('npc:') === 0) {
      var o = content.objects[id]; if (!o) return null;
      var fit = outfitOf(o);
      if (!fit && o.sprite && !Assets.get(o.sprite)) Assets.load(o.sprite);
      return fit ? { layers: Render.outfitLayers(fit), name: o.name || id } : { sprite: o.sprite || '', name: o.name || id };
    }
    if (ref.indexOf('mon:') === 0) {
      var d = content.monsters[id]; if (!d) return null;
      // (rolled once: it looks the same all scene long; one that STAYS comes rolled by the referee, so the real one looks the same)
      if (!(ref in sceneLooks)) sceneLooks[ref] = (!sceneTry && me.sceneCast && me.sceneCast[ref]) || (World.rollLook ? World.rollLook(content, d) : null);
      var lay = sceneLooks[ref] ? monsterLayers({ look: sceneLooks[ref] }) : null;
      if (!lay && d.sprite && !Assets.get(d.sprite)) Assets.load(d.sprite);
      return { layers: lay || undefined, sprite: lay ? '' : (d.sprite || ''), name: d.name || id };
    }
    return null;
  }
  function sceneName(ref) { var f = sceneFigure(ref); return f ? f.name || '' : ''; }
  function scenePortrait(ref) {                                          // the speaker beside its line
    var f = sceneFigure(ref); if (!f || !Render.figureOn) return null;
    var cv = document.createElement('canvas'); cv.width = 64; cv.height = 96; cv.className = 'dface';
    (function paint(n) {
      var g = cv.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, 64, 96);
      var fig = sceneFigure(ref) || f;
      Render.figureOn(g, { layers: fig.layers, sprite: fig.sprite, name: fig.name, facing: 'E' }, 0, 32, 64);
      if (n < 5) setTimeout(function () { paint(n + 1); }, 400);          // (pictures still loading are drawn when they arrive)
    })(0);
    return cv;
  }
  /** A way from one tile to another round walls and objects (eight ways, as players walk), or null: then it goes straight. */
  function scenePath(from, to) {
    var map = mapOf(), opts = World.viewOpts(content, map, Object.assign({}, view, { monsters: [], players: [] }), me.id);
    var dirs = Object.keys(Rules.DIRS).concat(Object.keys(Rules.DIAG || {})), K = function (x, y) { return x + ',' + y; };
    var prev = {}, q = [from], n = 0; prev[K(from.x, from.y)] = null;
    while (q.length && n++ < 6000) {
      var c = q.shift();
      if (c.x === to.x && c.y === to.y) {
        var out = []; for (var k = c; k && !(k.x === from.x && k.y === from.y); k = prev[K(k.x, k.y)]) out.unshift({ x: k.x, y: k.y });
        return out;
      }
      for (var i = 0; i < dirs.length; i++) {
        var r = Rules.tryMove(content, map, c.x, c.y, dirs[i], opts);
        if (!r.ok || r.map || K(r.x, r.y) in prev) continue;
        prev[K(r.x, r.y)] = c; q.push({ x: r.x, y: r.y });
      }
    }
    return null;
  }
  /** The scene's actors as figures for the renderer (your own is actors[0], moved in frame()). */
  function sceneActors(actors, pups, emFor) {
    Object.keys(pups).forEach(function (ref) {
      var p = pups[ref]; if (ref === 'me' || !p.on) return;
      var f = sceneFigure(ref); if (!f) return;
      actors.push({ x: p.x, y: p.y, facing: p.facing, name: f.sprite !== undefined ? f.name : '', sprite: f.sprite, layers: f.layers, idle: !p.moving, ph: phaseOf(ref), alpha: p.alpha, emote: emFor(ref) });
    });
  }
  // ---- emotes (client/js/emotes.js; the ids are Content.EMOTES). A player's own: G opens the bar, a number or a click
  // picks one ({type: 'emote', id}); everyone near sees it for Emotes.SHOW_MS. "id@when" is how the referee sends it.
  function playerEmote(em) {
    if (!em || typeof Emotes === 'undefined') return null;
    var i = String(em).lastIndexOf('@'), id = i > 0 ? String(em).slice(0, i) : String(em), at = Number(String(em).slice(i + 1)) || 0;
    var t = serverNow() - at, left = Emotes.SHOW_MS - t;
    return left > 0 && t > -2000 ? { id: id, t: Math.max(0, t), left: left } : null;
  }
  /** Over the drawn frame: the emotes over heads (Render's emoteTags: only figures that were drawn) and a scene's over tiles. */
  function drawEmotes(cam, map, T, sceneEm) {
    if (typeof Emotes === 'undefined') return;
    // one emote pixel = one pixel of the UI (1rem: the same size as the HUD's pictures), so it reads at any view size
    var g = canvas.getContext('2d'), kc = canvas.getBoundingClientRect().width / canvas.width || 1;
    var u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--u')) || 1;
    var k = Math.max(1, Math.round(u / kc));
    var tag = nameEls.filter(function (el) { return !el.hidden; })[0], nameH = tag ? tag.getBoundingClientRect().height / kc : 0;
    (renderer.emoteTags || []).forEach(function (et) { Emotes.draw(g, et.emote.id, et.x, et.y - (et.named ? nameH : 0), et.emote.t, k, et.emote.left); });
    (sceneEm || []).forEach(function (em) {
      if (em.over !== 'tile') return;
      var lift = Render.liftAt ? Render.liftAt(map, clamp(em.x, 0, map.width - 1), clamp(em.y, 0, map.height - 1), T) : 0;
      Emotes.draw(g, em.id, (em.x + 0.5) * T - cam.x, em.y * T - cam.y - lift + T * 0.3, em.t, k, em.left);
    });
  }
  // The emote wheel (owner, 26 Nov 2026): the emotes in a ring round your figure. HOLD the mouse wheel button, point
  // towards one and let go = that one (let go in the middle = none). G opens the same ring to click, or 1-8; G / Esc shut it.
  var emoteWheel = null;                                                 // {el, cx, cy (screen: your figure), items, pick, held}
  function emoteList() { return (Content.EMOTES || []).filter(function (e) { return typeof Emotes !== 'undefined' && Emotes.known(e.id); }); }
  function figureOnScreen() {
    var T = content.config.tile_size || 32, r = canvas.getBoundingClientRect(), k = r.width / canvas.width;
    var lift = Render.liftAt ? Render.liftAt(mapOf(), clamp(shown.x, 0, mapOf().width - 1), clamp(shown.y, 0, mapOf().height - 1), T) : 0;
    return { x: r.left + ((shown.x + 0.5) * T - lastCam.x) * k, y: r.top + ((shown.y + 0.25) * T - lastCam.y - lift) * k };
  }
  function openEmotes(held) {
    closeEmotes();
    var list = emoteList(); if (!list.length || !me) return;
    var c = figureOnScreen(), el = document.createElement('div'); el.id = 'emotewheel';
    el.style.left = c.x.toFixed(1) + 'px'; el.style.top = c.y.toFixed(1) + 'px';
    var name = document.createElement('div'); name.className = 'ew-name'; el.appendChild(name);
    var items = list.map(function (em, i) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / list.length, b = document.createElement('button');
      b.type = 'button'; b.className = 'ew-item';
      b.style.left = 'calc(' + Math.cos(a).toFixed(3) + ' * var(--ew-r))'; b.style.top = 'calc(' + Math.sin(a).toFixed(3) + ' * var(--ew-r))';
      b.appendChild(Emotes.icon(em.id, 2));
      var n = document.createElement('span'); n.className = 'en'; n.textContent = String(i + 1); b.appendChild(n);
      b.onmouseenter = function () { wheelPick(i); };
      b.onclick = function (e) { e.stopPropagation(); closeEmotes(); doEmote(em.id); };
      el.appendChild(b);
      return { id: em.id, name: em.name, el: b };
    });
    document.body.appendChild(el);
    emoteWheel = { el: el, name: name, cx: c.x, cy: c.y, items: items, pick: -1, held: !!held };
  }
  function closeEmotes() { if (emoteWheel) { emoteWheel.el.remove(); emoteWheel = null; } }
  function wheelPick(i) {
    var w = emoteWheel; if (!w || w.pick === i) return;
    w.pick = i;
    w.items.forEach(function (it, n) { it.el.classList.toggle('on', n === i); });
    w.name.textContent = i >= 0 ? w.items[i].name : '';
  }
  function wheelAim(e) {                                                 // the slice the pointer is towards (none near the middle)
    var w = emoteWheel; if (!w) return;
    var dx = e.clientX - w.cx, dy = e.clientY - w.cy, u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--u')) || 1;
    if (Math.sqrt(dx * dx + dy * dy) < 12 * u) return wheelPick(-1);
    var n = w.items.length, s = Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (2 * Math.PI / n));
    wheelPick(((s % n) + n) % n);
  }
  addEventListener('mousemove', wheelAim);
  addEventListener('mouseup', function (e) {
    if (e.button !== 1 || !emoteWheel || !emoteWheel.held) return;
    var w = emoteWheel; closeEmotes();
    if (w.pick >= 0) doEmote(w.items[w.pick].id);
  });
  function doEmote(id) {
    closeEmotes();
    if (!me) return;
    me.em = id + '@' + Math.round(serverNow());                          // (shown at once; the referee tells the others)
    send({ type: 'emote', id: id });
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
      if (q['class']) playerLooks[q.id] = { 'class': q['class'], equipment: q.equipment || {}, hair: q.hair || '', hairColor: q.hairColor || '', beard: q.beard || '', beardColor: q.beardColor || '', body: q.body || '', skin: q.skin || '' };
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
  /** Blasts still in the air (owner, 27 Nov 2026: monsters died before the grenade came down). The referee settles a
   *  throw the moment it is made; the page holds back what the blast did — the numbers, the words, the deaths, and the
   *  figures themselves as they stood — until the thing it drew flying has landed. Draw-only. `tossFx` adds one. */
  var landings = [];
  function landingAt(x, y, now) {
    for (var i = landings.length - 1; i >= 0; i--) {
      var l = landings[i];
      if (l.until <= now) { landings.splice(i, 1); continue; }
      if (l.map === me.map && cheb(Math.round(x), Math.round(y), l.x, l.y) <= l.r) return l;
    }
    return null;
  }
  function handleEvents(events) {
    var now = performance.now(), holdTo = 0;
    (events || []).forEach(function (e, i) {
      if ((e.type === 'kill' || e.type === 'level') && !e._held && holdTo > now) {   // what a held death gave: said with it
        e._held = 1; setTimeout(function () { handleEvents([e]); }, holdTo - now); return;
      }
      if ((e.type === 'hit' || e.type === 'die') && !e._held && (!e.map || e.map === me.map)) {   // caught in a blast that has not landed yet
        var hl = landingAt(e.x, e.y, now);
        if (hl) { e._held = 1; if (e.type === 'die') holdTo = hl.until; setTimeout(function () { handleEvents([e]); }, Math.max(0, hl.until - now)); return; }
      }
      if (e.type === 'shop') { openShop(e); return; }          // a trader's offers, as they stand for you now
      if (e.type === 'npc') { openNpc(e); return; }            // you talked to someone: their window (or, with nothing to offer, a line)
      if (e.type === 'loot' && e.text) lootToast(e); else if (e.text) log(e.text, e.type);   // what reached your bag: a toast on the left
      if (e.type === 'craft') { openCrafting(); return; }   // you used a workbench: the inventory window, its recipes beside the bag
      if (e.type === 'claim') { claim = e; $('claimp').hidden = false; basePanel(); return; }       // your claim flag: who belongs to the base
      if (e.type === 'storage' && e.gone) { if (storage && storage.key === e.key) closeStore(); return; }   // a carcass taken clean: it is gone
      if (e.type === 'storage' && e.key === tookAll.key && tookAll.n > 0 && performance.now() - tookAll.at < 5000) { tookAll.n--; return; }   // the answer to Take all: the window stays shut
      if (e.type === 'storage') { storage = e; e._at = performance.now(); storePanel(); return; }   // (_at: when it came, for the countdowns)   // you opened (or changed) a storage container
      if (e.map && e.map !== me.map) return;
      if (e.type === 'die') { deathFx(e, now); return; }       // something died in view: it bursts
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
          var ea = cellPx(e.from.x, e.from.y), eb = cellPx(e.to.x, e.to.y);
          tossFx(e.item, ea.x, ea.y - tileSize() * 0.45, eb.x, eb.y, e.from, e.to, t0, e.noise);
        }
        return;
      }
      if (e.type === 'mana' && e.amount) { fx.push({ x: e.x, y: e.y, text: '+' + e.amount + ' MP', color: '#8fb6ff', t0: t0 }); return; }
      if (e.type === 'hit' && e.amount && e.by && e.by !== me.id) return;   // another player's swing: drawn from their `act` (othersAct), sooner than this
      if (e.type === 'hit' && e.amount) fx.push({ x: e.x, y: e.y, text: '-' + e.amount, color: e.to === me.id && e.x === me.x && e.y === me.y ? '#ff6b5b' : '#ffffff', t0: t0 });
      else if (e.type === 'heal' && e.amount) fx.push({ x: e.x, y: e.y, text: '+' + e.amount, color: COLORS.heal, t0: t0 });
      // (what reached your bag floats nothing over your head: it is a card at the side, lootToast)
      else if (e.type === 'level') fx.push({ x: me.x, y: me.y, text: 'LEVEL UP!', color: COLORS.level, t0: t0, life: 1800, big: true });
    });
  }
  /** Something died (the referee's `die` event, sent to everyone on the map): the figure as it was last drawn flies
   *  apart into its own pixels and leaves a little blood on the ground (Render.burst; drawFx kind 'burst'; the stain is
   *  drawn with the ground, renderer.draw `stains`). Only what you were looking at. Monsters `blood` = its colour
   *  ('' = red, none = no blood); Config death_fx = off: they just vanish, as before. Draw-only. */
  var monSnap = {}, stains = [];
  function deathFx(e, now) {
    var snap = monSnap[e.id]; delete monSnap[e.id];
    if (!snap || String(content.config.death_fx || '').toLowerCase() === 'off' || !Render.burst) return;
    if (sight.vis && !sight.vis[e.x + ',' + e.y]) return;
    var def = content.monsters[snap.ref] || {}, bl = String(def.blood || '').trim(), col = bl.toLowerCase() === 'none' ? '' : (bl || '#b01a1a');
    var a = Object.assign({}, snap.a, { idle: false }), b = Render.burst(a, content.config.tile_size || 32, col ? 26 : 0);
    fx.push({ kind: 'burst', x: a.x, y: a.y, p: b.p, drops: b.drops, cy: b.cy, color: col, t0: now, life: 900 });
    if (col) stains.push({ map: me.map, x: a.x, y: a.y, drops: b.drops, color: col, t0: now, life: 12000 });
    if (stains.length > 40) stains.shift();
  }
  function liveStains(now) {
    for (var i = stains.length - 1; i >= 0; i--) if (now - stains[i].t0 >= stains[i].life || stains[i].map !== me.map) stains.splice(i, 1);
    return stains;
  }
  /** Something reached your bag: a toast ("+3 Plant fiber", with the item's picture when the words name one). */
  // "+3 Plant fiber" again while its card is still showing adds to that card ("+5 Plant fiber") instead of a new one.
  // Every way into the bag (picked up, crafted, cooked, given) is the same card: picture, +n, name.
  function lootToast(e) {
    var text = e.text, m = /^\+(\d+) (.+)$/.exec(text), id = e.item && content.items[e.item] ? e.item : '';
    if (!id && m) id = Object.keys(content.items).filter(function (k) { return content.items[k].name === m[2]; })[0] || '';   // (an older referee names it only)
    var n = Number(e.qty) || (m ? Number(m[1]) : 0), name = id ? content.items[id].name : m ? m[2] : '';
    if (name && n) UI.toast(name, id ? itemPicEl(content.items[id], 16) : null, { key: id || name, n: n });
    else UI.toast(text.replace(/\.$/, ''), null);
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
    lastCost = r.ok ? Rules.stepCost(dir, content, mapOf(), r.x, r.y, me) : 1;   // (wading in shallow water, or sneaking, is slower)
    if (r.ok) { stepT = performance.now(); soundRing(r.x, r.y); }
    send({ type: 'move', dirs: [dir] });
  }
  // ---- stealth (docs/STEALTH.md): Z sneaks. The referee has the say; the page shows it at once, and works out its
  // own noise meter from its own steps (World.noiseRadius), as the referee does from its.
  var stepT = -1e9;                                       // when the last step was taken (performance.now)
  function toggleSneak() {
    if (!me || !World.stealthOn || !World.stealthOn(content)) return;
    var on = !me.sneak;
    if (on) {                                             // when you may not: the build tools out, someone talked to, or hunted
      if (buildOpen || building || removing || moveTool) { log('Put the build tools away to sneak.', 'info'); return; }
      if (questPop()) return;
      if (me.chased) { log('You can\'t hide while something is after you.', 'info'); return; }
    }
    me = Object.assign({}, me, { sneak: on || undefined });
    send({ type: 'sneak', on: on });
    log(on ? 'Sneaking: slower, quieter and harder to spot (Z to stand up).' : 'You stand up.', 'info');
    hud();
  }
  /** While sneaking, each step sends out a ring as far as its noise carries (World.noiseRadius: what monsters hear). */
  function soundRing(x, y) {
    if (!me || !me.sneak || !World.noiseRadius || String(content.config.stealth_rings || 'on') === 'off') return;
    var r = World.noiseRadius(content, true, true); if (!(r > 0)) return;
    var t0 = performance.now();
    fx.push({ kind: 'sound', x: x, y: y, r: r, t0: t0, life: 900 });
  }
  /** Opening the build tools or talking to someone ends sneaking at once (the referee does the same on its side). */
  function standUp() {
    if (!me || !me.sneak) return;
    me = Object.assign({}, me, { sneak: undefined });
    send({ type: 'sneak', on: false });
    log('You stand up.', 'info');
    hud();
  }
  function myNoise() {
    if (!me || !World.noiseRadius) return null;
    if (!World.stealthOn(content)) return null;
    return World.noiseRadius(content, !!me.sneak, performance.now() - stepT <= World.NOISE_LINGER_MS) / World.noiseMax(content);
  }
  // While sneaking: where each monster you can see would spot you (World.sightArea: the same reach and line of
  // sight the referee's World.notices uses), drawn on the ground (Render layer 2f). Worked out again only when the
  // monster moves, or every half second (doors). Off with Config stealth_areas = off.
  var watchCache = {};
  function sightAreas(map, vis) {
    if (!me || !me.sneak || !World.sightArea || !World.stealthOn(content) || String(content.config.stealth_areas || 'on') === 'off') { watchCache = {}; return null; }
    var out = [], tNow = Date.now(), keep = {}, lk = null;
    (view.monsters || []).forEach(function (m) {
      var def = content.monsters[m.ref]; if (!def) return;
      if (vis && !vis[m.x + ',' + m.y]) return;                                   // only the ones you can see
      if (Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) > 24) return;
      var k = me.map + ':' + m.x + ',' + m.y + ':' + (m.facing || 'S'), w = watchCache[m.id];   // (it turns: its cone turns)
      if (!w || w.k !== k || tNow - w.at > 500) {
        if (!lk) { lk = World.viewLookup(content, map, view, me); World.syncEdgesView(content, map, lk.stateOf); }
        w = { k: k, at: tNow, cells: World.sightArea(content, map, m, def, true, lk.stateOf, 0) };
      }
      keep[m.id] = w;
      out.push({ cells: w.cells, hot: m.alert === 2 });
    });
    watchCache = keep;
    return out;
  }
  // While sneaking: the edges of the screen darken softly (#sneak-veil, ui.css), fading in and out.
  function sneakVeil() { var v = $('sneak-veil'); if (v) v.classList.toggle('on', !!(me && me.sneak)); }
  var noiseShown = null;
  function noiseMeter() {
    if (!hudParts) return;
    var v = myNoise(), show = UI.FLAGS.noise && v != null && !!me.sneak;   // only while sneaking
    $('noise').hidden = !show;
    if (!show || v === noiseShown) return;
    noiseShown = v;
    UI.setBar(hudParts.noise, v);
    $('noise').setAttribute('data-tip', (me.sneak ? 'Sneaking' : 'Walking') + ': ' + (v ? 'monsters hear you within ' + Math.round(v * World.noiseMax(content)) + ' tiles' : 'silent while you stand still') + ' (Z: ' + (me.sneak ? 'stand up' : 'sneak') + ')');
  }
  /** F / Space: use what lies towards the CURSOR — your own tile when the cursor is on you, else the one of the eight
   *  tiles around you in its direction; nothing to use there, the tile a notch to either side of it (the nearer first),
   *  so a door straight ahead is still found with the cursor a little off. No cursor over the view: the tile you face. */
  function interact() {
    if (!me) return;
    if (!lastPtr || aimFar == null || !view) {
      var fd = Rules.DIRS[me.facing], fc = fd && { x: me.x + fd.dx, y: me.y + fd.dy };   // no pointer yet: the tile you face
      if (fc && view && World.pickAt && World.pickAt(content, mapOf(), lookup(), me, fc.x, fc.y)) { picking = fc; lastPick = performance.now(); }
      send({ type: 'interact' }); return;
    }
    aimAt(lastPtr);
    var cells = [];
    if (!aimFar) cells.push({ x: me.x, y: me.y });
    else {
      var turn = aimAngle / (Math.PI / 4), oct = Math.round(turn), side = turn >= oct ? 1 : -1;
      [oct, oct + side, oct - side].forEach(function (o) { cells.push({ x: me.x + Math.round(Math.cos(o * Math.PI / 4)), y: me.y + Math.round(Math.sin(o * Math.PI / 4)) }); });
    }
    for (var i = 0; i < cells.length; i++) {
      var a = actsOf(cells[i]).filter(function (q) { return q.type === 'interact'; })[0];
      if (a) { doAction(a, cells[i]); if (a.pick) { picking = { x: cells[i].x, y: cells[i].y }; lastPick = performance.now(); } return; }   // (held: it goes on picking)
    }
    send({ type: 'interact', x: cells[0].x, y: cells[0].y });   // nothing to use: the referee says so
  }
  // from = where it is used from, {w: 'bag' | 'belt', s}: what it leaves (an empty bottle) goes back there (World leaveItem)
  function useItem(id, from) { send(from ? { type: 'use', item: id, from: from } : { type: 'use', item: id }); }

  // ---------------------------------------------------------------- input
  // when the player last did anything (see the heartbeat in the loop)
  var lastInput = performance.now();
  ['keydown', 'mousedown', 'wheel', 'pointermove', 'touchstart'].forEach(function (t) { addEventListener(t, function () { lastInput = performance.now(); }, { passive: true, capture: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) lastInput = performance.now(); });
  function press(d) { held = held.filter(function (h) { return h !== d; }).concat(d); tap = d; holdSince = performance.now(); }
  addEventListener('keydown', function (e) {
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
    if (Scene.playing()) { e.preventDefault(); if (!e.repeat) Scene.key(e.code); return; }   // a scene: only moving it on, or skipping it
    var d = KEYS[e.code];
    if (d) { e.preventDefault(); if (!e.repeat) press(d); return; }
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyF') { e.preventDefault(); useDown[e.code] = 1; interact(); }
    else if (e.code === 'KeyI') toggleBag();
    else if (e.code === 'KeyB') toggleBuild();
    else if (e.code === 'KeyX') { if (removing) stopBuilding(); else startRemoving(); }
    else if (e.code === 'KeyH' && removing) { wallsDown = !wallsDown; log(wallsDown ? 'Walls shown low: point at the base of a wall to pick it.' : 'Walls shown whole: point at the face of a wall to pick it.', 'info'); }
    else if (e.code === 'KeyC') { if (bagOpen && !storage) toggleBag(); else openCrafting(); }   // C: the inventory window too (crafting is in it)
    else if (e.code === 'KeyL') toggleQuests();
    else if (e.code === 'KeyZ') toggleSneak();
    else if (e.code === 'KeyG') { if (emoteWheel) closeEmotes(); else if (!questPop()) openEmotes(false); }   // the emote wheel (not over a quest window)
    else if (emoteWheel && e.code === 'Escape') closeEmotes();
    else if (emoteWheel && /^Digit[1-9]$/.test(e.code)) { var emPick = emoteList()[Number(e.code.slice(5)) - 1]; if (emPick) doEmote(emPick.id); }
    else if (e.code === 'KeyT') turnBuild(1);
    else if (e.code === 'KeyV' && building && content.blueprints[building] && content.blueprints[building].places === 'tile') {
      buildRoof = !buildRoof; if (buildOpen) buildPanel(); log(buildRoof ? 'Roof: click cells of this storey to cover them (V: back to floor).' : 'Floor: click where it should be laid (V: as a roof).', 'info');
    }
    else if (e.code === 'Escape') { closeMenu(); if (armed) disarm(); else if (throwing) { if (holdMode()) selectSlot(-1); else cancelThrow(); } else if (introOpen) closeIntro(); else if (claimQuest) closeClaimQuest(); else if (npcTalk) closeNpc(); else if (questOpen) toggleQuests(); else if (claim) closeClaim(); else if (storage) closeStore(); else if (buildOpen) toggleBuild(); else if (building || removing || moveTool) stopBuilding(); else if (bagOpen) toggleBag(); }
    else if (e.code === 'KeyQ' && skillsOn()) ability(0);
    else if (e.code === 'KeyE' && skillsOn()) ability(1);
    else if (e.code === 'KeyR') { if (bagOpen && storage) takeAllOpen(); else startReload(); }   // a container open: R takes everything
    else if (/^Digit[1-9]$/.test(e.code) && npcTalk && npcTalk.dlg && !npcQuest) dlgKey(Number(e.code.slice(5)) - 1);   // in a conversation: the numbered answer
    else if (/^Digit[0-9]$/.test(e.code) && me && (Number(e.code.slice(5)) + 9) % 10 < BELT) beltKey((Number(e.code.slice(5)) + 9) % 10);   // 1-9, then 0 = the tenth
  });
  addEventListener('keyup', function (e) {
    var d = KEYS[e.code]; if (d) held = held.filter(function (h) { return h !== d; });
    delete useDown[e.code];
  });
  addEventListener('blur', function () { useDown = {}; held = []; aiming = false; leftHeld = false; buildHold = null; clearTimeout(holdTimer); updateCursor(); });
  function cellAt(e) {
    var r = canvas.getBoundingClientRect(), T = content.config.tile_size || 32;
    var px = (e.clientX - r.left) * canvas.width / r.width + lastCam.x, py = (e.clientY - r.top) * canvas.height / r.height + lastCam.y;
    // Raised ground: the tile DRAWN under the cursor, and only that one (owner, 26 Nov 2026). A ledge hides the ground
    // behind it, and what lies hidden there is not offered through the ledge (F / Space, by direction, still reach it).
    var cell = Render.pickCells ? Render.pickCells(mapOf(), px, py, T)[0]
                                : { x: Math.floor(px / T), y: Math.floor(py / T) };
    return bigPick(cell, px - lastCam.x, py - lastCam.y);
  }
  /** A thing drawn bigger than its tile (a tree, a wide bench) is meant by the solid pixels of its picture, and ONLY by
   *  them (the owner's rule): a click on any of them means the object's own tile, and a click on the empty part of its own
   *  tile means nothing (the cell comes back marked `miss`: actsOf gives no actions, no chopping starts). A creature on
   *  the tile, or a small thing lying there, is still meant. Not while building, removing, moving, aiming or throwing:
   *  those are about the ground. */
  function bigPick(cell, cx, cy) {
    if (!me || !view || !renderer || !renderer.objectAt || building || removing || moveTool || buildOpen || aiming || armed || throwing) return cell;
    var big = renderer.objectAt(cx, cy), map = mapOf();
    // (a picture standing BEHIND the raised ground under the cursor is hidden by it: the ledge is what is pointed at)
    if (big && cell.y > big.y && Rules.groundHeight(map, cell.x + 0.5, cell.y + 0.5) > Rules.groundHeight(map, big.x + 0.5, big.y + 0.5) + 0.01) big = null;
    if (big && big.x === cell.x && big.y === cell.y) return cell;
    var lk = lookup(), hollow = renderer.bigOn(cell.x, cell.y);   // (hollow: a big thing stands on this tile, and the cursor is not on its picture)
    function todo(c) { return World.actionsAt(content, map, lk, me, c.x, c.y).length > 0 || !!(World.harvestWith && World.harvestWith(content, map, me, c.x, c.y)); }   // something to use, or to chop / mine with what is in hand
    if (lk.monsterAt(cell.x, cell.y) || (!hollow && todo(cell))) return cell;
    if (big && todo(big)) return big;
    return hollow ? { x: cell.x, y: cell.y, miss: true } : cell;
  }
  /** What a click on that tile offers (nothing on the empty part of a big object's tile, see bigPick). */
  function actsOf(cell) {
    if (cell.miss) return [];
    // next to you but up or down a cliff: out of reach by the rules (Rules.reachBlocked), so nothing is offered at all
    if (me && near(cell.x, cell.y) && Rules.cliffReach(mapOf(), me.x, me.y, cell.x, cell.y)) return [];
    return World.actionsAt(content, mapOf(), lookup(), me, cell.x, cell.y);
  }
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointermove', function (e) {
    if (!content) return;
    lastPtr = { clientX: e.clientX, clientY: e.clientY };
    hover = cellAt(e); hoverLabel(e);
    if (me) aimAt(e);                                     // the figure looks at the cursor, always; aiming, the gun angle tracks it too
    if (buildHold) buildDrag();
  });
  canvas.addEventListener('pointerleave', function () { hover = null; lastPtr = null; $('tip').hidden = true; });
  // mousedown/up (not pointerdown) so a left-click still fires while the right button is held to aim —
  // a pointer only fires one 'down' per gesture, reporting extra buttons as moves, which swallowed the shot.
  canvas.addEventListener('mousedown', function (e) {
    if (!me) return;
    if (e.button === 1) {                                 // the wheel button (held): the emote wheel round your figure
      e.preventDefault();                                 // (no page autoscroll)
      if (!questPop() && !Scene.playing()) { closeMenu(); openEmotes(true); }
      return;
    }
    if (emoteWheel && !emoteWheel.held) { var wp = emoteWheel.pick; closeEmotes(); if (e.button === 0 && wp >= 0) doEmote(emoteList()[wp].id); return; }   // (opened with G: a click picks, or shuts it)
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
    if (throwing) { var ta = throwAim(); throwAt(ta && ta.cell ? ta.cell : cell, ta); return; }
    if (aiming && heldUse()) { leftHeld = true; eatHold = true; eatDone = false; return; }   // food, a bandage… in hand: the button HELD uses it (the frame loop)
    if (aiming) { leftHeld = true; fireToward(cell); return; }   // fire/attack while aiming
    if (!cell.miss && World.pickAt && World.pickAt(content, mapOf(), lookup(), me, cell.x, cell.y)) {   // a berry bush: held, it is picked until empty
      leftHeld = true; holdFired = false; pendingCell = null; clearTimeout(holdTimer);
      picking = { x: cell.x, y: cell.y }; pickSwing();
      return;
    }
    if (!cell.miss && World.harvestWith && World.harvestWith(content, mapOf(), me, cell.x, cell.y)) {
      leftHeld = true; holdFired = false; pendingCell = null; clearTimeout(holdTimer);
      harvesting = { x: cell.x, y: cell.y }; harvestSwing();
      return;
    }
    var plc = placeHeld();                                // a bedroll in hand: a click on ground with nothing to use puts it down
    if (plc && !cell.miss && !tapAction(actsOf(cell))) {
      var pt2 = buildTarget();
      if (pt2) { if (pt2.ok) send({ type: 'place', item: plc.id, x: pt2.x, y: pt2.y, facing: pt2.facing || undefined }); else log(pt2.reason, 'info'); }
      return;
    }
    // not aiming: left-click interacts. A quick tap does the default action; holding opens the action list.
    leftHeld = true; holdFired = false; pendingCell = cell; holdMenuEvt = e;
    eatHold = !!heldUse() && !actsOf(cell).length; eatDone = false;   // nothing to act on there: held, it uses what is in hand
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      if (!leftHeld || aiming) return;
      var acts = actsOf(cell);
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
  function tapAction(acts) { return acts.filter(function (a) { return (a.type !== 'dismantle' || a.pickup) && a.type !== 'shift' && a.type !== 'turn' && !(a.type === 'attack' && a.own); })[0] || null; }
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
    alert: '!', search: '?', watch: '…',          // watch: that player is watching a scene

    quest: '!', questdone: '?', questgo: '?'      // over an NPC: has a quest for you / one to hand in / one of theirs under way
  };
  var markEls = {};
  // The names over characters: text in the UI's font laid over the view (render.js only says where), so they are sharp at
  // any size. One element per name, kept from frame to frame; only what changed is touched.
  var nameEls = [];
  // How far the view may scroll past each of the map's four edges (the same on all, the owner's choice), in canvas pixels: the height of the HUD along the bottom (belt and
  // XP bar) plus half a tile, so a character on the map's last row still stands clear above it, and one at any other edge as far from it. Never more than keeps you
  // a tile above the middle of the view.
  function edgePad(T) {
    var hud = $('bcbox').getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    if (!hud.height || !cr.height) return 0;
    var pad = Math.round((cr.bottom - hud.top) * canvas.height / cr.height + T / 2);
    return Math.max(0, Math.min(pad, Math.floor(Math.min(canvas.width, canvas.height) / 2 - T)));
  }
  function nameTags(list) {
    var box = $('marks'), k = canvas.getBoundingClientRect().width / canvas.width;
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i], el = nameEls[i];
      if (!el) { el = nameEls[i] = document.createElement('div'); el.className = 'ntag'; box.appendChild(el); }
      if (el._t !== t.text) { el._t = t.text; el.textContent = t.text; }
      if (el._c !== t.color) { el._c = t.color; el.style.color = t.color; }
      el.hidden = false;
      el.style.left = (t.x * k).toFixed(1) + 'px'; el.style.top = (t.y * k).toFixed(1) + 'px';
    }
    for (var j = list.length; j < nameEls.length; j++) nameEls[j].hidden = true;
  }
  function setMarks(list) {
    var box = $('marks'), T = content.config.tile_size || 32, k = canvas.getBoundingClientRect().width / canvas.width, live = {};
    list.forEach(function (mk) {
      var el = markEls[mk.id];
      if (!el || el._kind !== mk.kind) {
        if (el) el.remove();
        el = markEls[mk.id] = document.createElement('div'); el._kind = mk.kind; el.className = 'mark ' + (mk.kind === 'craft' ? 'reload craft' : mk.kind); el.innerHTML = MARKS[mk.kind] || '';
        if (mk.kind === 'prompt') { if (mk.key) el.appendChild(UI.key(mk.key)); el._lab = UI.el('span', 'k kplate', ''); el.appendChild(el._lab); }   // a key and what it does
        box.appendChild(el);
      }
      live[mk.id] = 1;
      if (mk.kind === 'prompt' && el._text !== mk.label) { el._text = mk.label; el._lab.textContent = mk.label; }
      el.style.left = (((mk.x + 0.5 + (mk.ox || 0)) * T - lastCam.x) * k).toFixed(1) + 'px';   // (ox, oy: tiles aside of the spot)
      el.style.top = (((mk.y + (mk.oy || 0)) * T - lastCam.y - (mk.up || 0) - (Render.liftAt ? Render.liftAt(mapOf(), mk.x, mk.y, T) : 0)) * k).toFixed(1) + 'px';
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
    if (makingBar && makingBar.isConnected) UI.setBar(makingBar, f.p);   // the same, on the bar in the inventory window
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
    if (Math.abs(dx) > 2) lookSide = dx < 0 ? 'W' : 'E';        // the side the figure is drawn looking to (draw-only; a cursor straight above or below keeps the side)
    if (aiming && (dx || dy)) me.facing = dx < 0 ? 'W' : 'E';   // only aiming turns the character itself: F / Space still act on the tile you walked towards
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
  function throwAt(cell, ta) {
    var it = content.items[throwing]; if (!it) { cancelThrow(); return; }
    if (count(throwing) < 1) { log('Out of ' + it.name.toLowerCase() + '.', 'info'); cancelThrow(); return; }
    var ft = throwFloorAt(cell, it);
    if (ft) {                                                                 // down onto a floor below
      me.facing = facingToward(cell.x, cell.y);
      send({ type: 'throw', item: throwing, map: ft.map.id, x: ft.x, y: ft.y }); swingT0 = performance.now();
      var fa = cellPx(shown.x, shown.y), fb = ta && ta.ex != null ? { x: ta.ex + lastCam.x, y: ta.ey + lastCam.y } : cellPx(cell.x, cell.y);
      tossFx(throwing, fa.x, fa.y - tileSize() * 0.45, fb.x, fb.y, me, cell, performance.now(), 0, blastOnFloor(ft, it));
      cancelThrow();
      return;
    }
    if (cheb(me.x, me.y, cell.x, cell.y) > (it.throwRange || 4)) { log(TOO_FAR, 'info'); return; }
    me.facing = facingToward(cell.x, cell.y);
    send({ type: 'throw', item: throwing, x: cell.x, y: cell.y }); swingT0 = performance.now();   // (the arm swings)
    // Predict where it actually lands (stops at a wall) and which cells the blast reaches, so the
    // animation matches the server instead of sailing through walls.
    var map = mapOf(), sf = lookup().stateOf;
    var land = World.throwLanding(content, map, me.x, me.y, cell.x, cell.y, sf);
    // it flies the arc the aim drew, to the very point aimed at (the tile's middle when a wall or the range cut it short)
    var a0 = cellPx(shown.x, shown.y), same = ta && ta.ex != null && ta.cell && ta.cell.x === land.x && ta.cell.y === land.y;
    var a1 = same ? { x: ta.ex + lastCam.x, y: ta.ey + lastCam.y } : cellPx(land.x, land.y);
    tossFx(throwing, a0.x, a0.y - tileSize() * 0.45, a1.x, a1.y, me, land, performance.now(), World.throwNoise ? World.throwNoise(content, it) : 0);
    cancelThrow();
  }
  function tileSize() { return content.config.tile_size || 32; }
  /** The middle of a tile as it is drawn, in map pixels (raised ground lifts it). */
  function cellPx(x, y) {
    var T = tileSize(), m = mapOf(), rx = Math.max(0, Math.min(m.width - 1, Math.round(x))), ry = Math.max(0, Math.min(m.height - 1, Math.round(y)));
    return { x: (x + 0.5) * T, y: (y + 0.5) * T - (Render.liftAt ? Render.liftAt(m, rx, ry, T) : 0) };
  }
  /** A thrown thing in the air (owner, 27 Nov 2026; draw-only): a small copy of its picture, turning, along the very arc
   *  the aim drew — from (sx, sy) to (ex, ey), map pixels —; then what landing does. Something that bursts (a blast area)
   *  flashes there. Anything else bounces once towards the next tile the way it was going — on the spot when that tile is
   *  taken, walled off or up or down a ledge — and is gone: nothing is left on the ground. `noise` = the tiles its landing
   *  is heard from (a ring). from / land = the tiles thrown from and landed on; cells = the blast, when already known. */
  function tossFx(itemId, sx, sy, ex, ey, from, land, t0, noise, cells) {
    var it = content.items[itemId] || {}, T = tileSize(), map = mapOf(), dx = ex - sx, dy = ey - sy, d = Math.sqrt(dx * dx + dy * dy);
    var fly = Math.round(200 + d / T * 45), area = it.throwArea || 0, col = it.tint || '#ff8c3b', bx = ex, by = ey, hop = 0;
    if (it.sprite && !Assets.get(it.sprite)) Assets.load(it.sprite);
    if (!(area > 0)) {
      hop = 300;
      var ux = land.x - from.x, uy = land.y - from.y, ul = Math.max(Math.abs(ux), Math.abs(uy)) || 1;
      var nx = land.x + Math.round(ux / ul), ny = land.y + Math.round(uy / ul), sf = lookup().stateOf;
      var open = (nx !== land.x || ny !== land.y) && nx >= 0 && ny >= 0 && nx < map.width && ny < map.height;
      if (open) { var l2 = World.throwLanding(content, map, land.x, land.y, nx, ny, sf); open = l2.x === nx && l2.y === ny; }
      if (open && Rules.groundHeight && Math.abs(Rules.groundHeight(map, nx + 0.5, ny + 0.5) - Rules.groundHeight(map, land.x + 0.5, land.y + 0.5)) > 0.75) open = false;
      if (open && Rules.blockersAt && Rules.blockersAt(content, map, nx, ny).length) open = false;
      if (open && ((view.monsters || []).some(function (m) { return m.x === nx && m.y === ny; }) || (view.players || []).some(function (q) { return q.x === nx && q.y === ny; }) || (me.x === nx && me.y === ny))) open = false;
      if (open) { var np = cellPx(nx, ny), lp = cellPx(land.x, land.y); bx = ex + (np.x - lp.x) * 0.8; by = ey + (np.y - lp.y) * 0.8; }
    }
    fx.push({ kind: 'toss', path: it.sprite || '', color: col, sx: sx, sy: sy, ex: ex, ey: ey, rise: Math.max(T * 0.5, d * 0.35), bx: bx, by: by, fly: fly, hop: hop,
      spin: (dx < 0 ? -1 : 1) * (4 + d / T), t0: t0, life: fly + hop });
    if (area > 0) {                                                   // what it does shows when it lands: see `landings`
      var ld = { map: me.map, x: land.x, y: land.y, r: area, until: t0 + fly, was: {} };
      Object.keys(monSnap).forEach(function (id) { var sn = monSnap[id]; if (cheb(Math.round(sn.a.x), Math.round(sn.a.y), land.x, land.y) <= area) ld.was[id] = sn; });
      landings.push(ld);
    }
    if (area > 0) fx.push({ kind: 'flash', x: land.x, y: land.y, r: area, cells: cells || World.blastCells(content, map, land.x, land.y, area, lookup().stateOf), color: col, t0: t0 + fly, life: 450 });
    if (noise > 0) fx.push({ kind: 'sound', x: land.x, y: land.y, r: noise, t0: t0 + fly, life: 900 });
  }
  function cancelThrow() { if (throwing && !holdMode()) { throwing = null; updateCursor(); hotbar(); } }   // (a held grenade stays in hand: see hotbar)
  function updateCursor() {
    // the one place the view's cursor is decided (it is asked again on every answer, so the hand must be decided here too,
    // or it flickers back to the arrow while the mouse rests on something)
    var cur = (aiming || armed || throwing || building || removing || moveTool) ? 'crosshair' : me && hover && tapAction(actsOf(hover)) ? 'pointer' : '';
    if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
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
    updateCursor();
    canvas.title = hft ? hft.name + (hft.dz < 0 ? ' — on the floor below' : ' — on the floor above') : '';
  }

  // ---------------------------------------------------------------- the belt (keys 1-9, 0), and abilities (Q/E) when skills are on
  var BELT = World.BELT_SIZE || 5;
  // The belt is a place of its own: its slots are cells of the bag's list from World.BELT_AT (what is there is not in
  // the backpack). beltSt = the stack in a slot; bagStacks = the backpack's own stacks.
  var BELT_AT = World.BELT_AT || 1000;
  function beltSt(i) { var inv = (me && me.inventory) || []; for (var k = 0; k < inv.length; k++) if (inv[k].s === BELT_AT + i) return inv[k]; return null; }
  /** Shift+click in the backpack: the stack goes onto the belt — onto a slot holding the same thing with room, else the first empty one. */
  function toBelt(cell, st) {
    var max = World.stackMaxOf ? World.stackMaxOf(content, st.item) : 99, pick = -1;
    for (var k = 0; k < BELT && pick < 0; k++) { var b = beltSt(k); if (b && b.item === st.item && b.qty < max) pick = k; }
    for (k = 0; k < BELT && pick < 0; k++) if (!beltSt(k)) pick = k;
    if (pick < 0) { log('Your belt is full.', 'info'); return; }
    invMove('bag', cell, 'belt', pick);
  }
  function bagStacks() { return ((me && me.inventory) || []).filter(function (st) { return !(st.s >= BELT_AT); }); }
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
  /** The thing in hand if it is one that is put down (a bedroll: World.placeBp), and nothing else has the mouse. */
  function placeHeld() {
    if (!me || building || removing || moveTool || buildOpen || aiming || armed) return null;
    var it = content.items[heldId()];
    return it && World.itemCan(it, 'place') && World.placeBp && World.placeBp(content, it) && count(it.id) > 0 ? it : null;
  }
  /** The thing in hand if a click should use it up (eat, drink, bandage), else null. */
  function heldUse() { var it = content.items[heldId()]; return it && World.itemCan(it, 'consume') ? it : null; }
  // Food, drink, a bandage in hand is used by HOLDING the left button EAT_MS (owner, 27 Nov 2026): a click somewhere must not
  // eat it by accident, and one hold uses one, however long it lasts. eatProg (0..1) is the hold so far: the item goes
  // quickly to the mouth (the first EAT_UP of the hold), then is eaten in EAT_BITES bites, each throwing a few crumbs of
  // its own colours (Render.crumbs; the death burst's drawing, far gentler); the last bite is the moment it is used.
  // eatUp (0..1) = how far up it is drawn; it comes back down when the button is let go or the thing is used.
  var EAT_MS = 500, EAT_UP = 0.2, EAT_BITES = 3, eatHold = false, eatDone = false, eatProg = 0, eatUp = 0, eatBit = 0, eatT0 = 0;   // (eatT0: when this hold began to count — by the clock, not by frames)
  function bitesAt(prog) { return prog <= EAT_UP ? 0 : Math.min(EAT_BITES, Math.floor((prog - EAT_UP) / ((1 - EAT_UP) / EAT_BITES) + 1e-6)); }
  /** A bite: a few crumbs of that item fly from the mouth of the figure drawn at (x, y) tiles. */
  function crumbFx(itemId, x, y, facing, now) {
    var it = content.items[itemId], img = it && it.sprite && Assets.get(it.sprite);
    if (!img || !Render.crumbs) return;
    fx.push({ kind: 'burst', x: x, y: y, p: Render.crumbs(img, content.config.tile_size || 32, facing === 'W'), drops: [], t0: now, life: 520 });
  }
  /** ANOTHER player who just used theirs (their `act` u, t ms ago): the same eating, played after the fact → {lift, bite}. */
  function othersEat(q, st, s, now) {
    var t = now - (st.u0 || -1e9);
    if (t < 0 || t > EAT_MS + 150) { st.b = 0; return { lift: 0, bite: 0 }; }
    if (t > EAT_MS) return { lift: 1 - (t - EAT_MS) / 150, bite: 0 };
    var b = bitesAt(t / EAT_MS);
    if (b > (st.b || 0)) crumbFx(q.hand, s.x, s.y, q.facing, now);
    st.b = b;
    return { lift: Math.min(1, t / (EAT_MS * EAT_UP)), bite: b / EAT_BITES };
  }
  // A thing in hand is drawn as big as it is on the belt (owner, 27 Nov 2026): the belt's icon is 20 UI pixels, told to
  // the renderer in the canvas's own pixels (looked at again now and then: the UI scale or the window may change).
  var handPxAt = -1e9;
  function handSize(now) {
    if (now - handPxAt < 500 || !Render.setHandPx) return;
    handPxAt = now;
    var u = parseFloat(getComputedStyle(document.documentElement).fontSize) || 1, cw = canvas.clientWidth || canvas.width;
    Render.setHandPx(20 * u * canvas.width / cw);
  }
  function useHeld() {
    var it = heldUse(); if (!it) return;
    if (count(it.id) < 1) { log('No ' + it.name.toLowerCase() + ' left.', 'info'); return; }
    useItem(it.id, { w: 'belt', s: me.held });
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
    } else useItem(id, { w: 'belt', s: i });
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
  // The jolt of doing or taking something (owner, 27 Nov 2026: a woman's chest also bounces when she uses a tool or a
  // weapon, when she is hurt, and when she turns round): the ms since the figure last swung, shot, threw (usedAt), lost
  // health, or turned to face the other way — `jolt` on its actor, read by the renderer's chestOf. Health and facing are
  // watched here, per figure (the first values seen are only remembered).
  // The way a figure is going, from where it was drawn last frame: {dx, dy} of -1 | 0 | 1, kept while it stands (`go` on
  // its actor: the renderer times a step's motion by it — the figure itself may be looking the other way).
  var goSt = {};
  function goOf(id, x, y) {
    var st = goSt[id] || (goSt[id] = { x: x, y: y, dx: 0, dy: 0 });
    if (x !== st.x) st.dx = x > st.x ? 1 : -1;
    if (y !== st.y) st.dy = y > st.y ? 1 : -1;
    st.x = x; st.y = y;
    return st;
  }
  var joltSt = {};
  function joltMs(id, hp, usedAt, now, facing) {
    var left = facing === 'W', st = joltSt[id] || (joltSt[id] = { hp: hp, left: left, at: -1e9 });
    if (hp < st.hp || left !== st.left) st.at = now;
    st.hp = hp; st.left = left;
    return now - Math.max(st.at, usedAt == null ? -1e9 : usedAt);
  }
  var actSt = {};
  function othersAct(q, now) {
    var a = String(q.act || '').split(','), n = Number(a[0]) || 0, st = actSt[q.id];
    if (!st) return (actSt[q.id] = { n: n, t0: -1e9, u0: -1e9 });
    var ahead = (n - st.n + 999) % 999;
    if (!n || !ahead || ahead > 500) return st;                // nothing new (or an older answer arriving late)
    st.n = n;
    var x = Number(a[2]), y = Number(a[3]), amount = Number(a[4]) || 0;
    if (a[1] === 'm' || a[1] === 'r' || a[1] === 't') st.j0 = now;   // a blow, a shot or a throw: the jolt of it (joltMs)
    if (a[1] === 't') st.t0 = now;                             // a throw: the arm swings
    if (a[1] === 'u') st.u0 = now;                             // ate or drank: lifted to the mouth
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
  // Picking (a berry bush, World.pickAt): one pick per Config pick_ms for as long as the left button or the use key
  // is held, until it is empty or you step away.
  var picking = null, lastPick = 0, useDown = {};
  function pickSwing() {
    var h = picking; if (!h) return;
    if (!(leftHeld || Object.keys(useDown).length) || aiming || !World.pickAt(content, mapOf(), lookup(), me, h.x, h.y)) { picking = null; return; }
    var cfgPace = content.config.pick_ms, pace = cfgPace === undefined || cfgPace === '' || isNaN(Number(cfgPace)) ? 600 : Number(cfgPace);
    var now = performance.now();
    if (now - lastPick < pace + 30) return;
    if (queue.some(function (q) { return q.type === 'interact'; })) { flush(); return; }   // the last pick has not been answered yet
    lastPick = now;
    me.facing = facingToward(h.x, h.y);
    send({ type: 'interact', x: h.x, y: h.y, verb: '' });
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
  /** Is the thing in hand being aimed to throw? Only while the right button is held, like aiming a weapon — a grenade and
   *  a rock alike (owner, 27 Nov 2026): in hand it is otherwise just carried, and clicks do what they always do. */
  function syncThrow() {
    if (!holdMode()) return;
    var hIt = content.items[heldId()], th = hIt && World.itemCan(hIt, 'throw') && count(hIt.id) > 0 && aiming ? hIt.id : null;
    if (th !== throwing) { throwing = th; updateCursor(); }
  }
  /** The tiles a throw of `it` can land on from where you stand: within its range and not behind a wall (a wall stops it,
   *  so the tiles behind are left out); from an upper floor, also the ground below it can be dropped on (as drawn). */
  function throwCells(it) {
    var rng = it.throwRange || 4, map = mapOf(), sf = lookup().stateOf;
    var cells = ringCells(rng).filter(function (c) {
      var l = World.throwLanding(content, map, me.x, me.y, c.x, c.y, sf);
      return l.x === c.x && l.y === c.y;
    });
    var storeys = floorsBelow().reduce(function (n, f) { return Math.max(n, -f.dz); }, 0) * Rules.WALL_H;
    if (storeys) for (var yy = me.y - rng; yy <= me.y + rng + storeys; yy++) for (var xx = me.x - rng; xx <= me.x + rng; xx++)
      if (throwFloorAt({ x: xx, y: yy }, it)) cells.push({ x: xx, y: yy });
    return cells;
  }
  /** Where a throw is aimed, for the drawing and for the click (owner, 27 Nov 2026: no painted tiles — a pulsing white line
   *  round the tiles it can land on, which follows the grid, and an arc to the cursor that does not). {cells (those tiles),
   *  fx, fy (your figure), ex, ey (where the arc ends), blastR — canvas pixels —, cell (the tile a click would throw at)}.
   *  A cursor beyond the reach aims as far towards it as the throw goes; a wall in the way ends the arc where it lands. */
  function throwAim() {
    var it = content.items[throwing]; if (!it || !me) return null;
    var T = content.config.tile_size || 32, rng = it.throwRange || 4, map = mapOf(), area = it.throwArea || 0;
    function lift(x, y) { return Render.liftAt ? Render.liftAt(map, Math.max(0, Math.min(map.width - 1, Math.round(x))), Math.max(0, Math.min(map.height - 1, Math.round(y))), T) : 0; }
    var fx0 = (shown.x + 0.5) * T - lastCam.x, fy0 = (shown.y + 0.5) * T - lastCam.y - lift(shown.x, shown.y);
    var out = { fx: fx0, fy: fy0, cells: throwCells(it), blastR: area > 0 ? (area + 0.5) * T : 0, cell: null };
    if (!lastPtr) return out;
    var r = canvas.getBoundingClientRect();
    var px = (lastPtr.clientX - r.left) * canvas.width / r.width, py = (lastPtr.clientY - r.top) * canvas.height / r.height;
    var raw = cellAt(lastPtr), hft = raw && throwFloorAt(raw, it);
    if (hft) { out.ex = px; out.ey = py; out.cell = { x: raw.x, y: raw.y }; return out; }   // down onto a floor below: wherever it is pointed
    var cell = { x: raw.x, y: raw.y }, far = cheb(me.x, me.y, cell.x, cell.y);
    if (far > rng) cell = { x: me.x + Math.round((cell.x - me.x) * rng / far), y: me.y + Math.round((cell.y - me.y) * rng / far) };   // beyond its range: as far that way as it goes
    var land = World.throwLanding(content, map, me.x, me.y, cell.x, cell.y, lookup().stateOf);
    out.cell = cell; out.ex = px; out.ey = py;
    if (far > rng || land.x !== cell.x || land.y !== cell.y) {   // out of reach or stopped by a wall: the arc ends on the tile it comes down on
      out.ex = (land.x + 0.5) * T - lastCam.x; out.ey = (land.y + 0.5) * T - lastCam.y - lift(land.x, land.y);
    }
    return out;
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
      var it = content.items[entry.id] || { name: entry.id }, im = itemIconUrl(it);
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
    syncThrow();
    if (invDrag) { invDirty = true; return; }             // never rebuild the belt under a drag
    // (drawn again only when what it shows changed: a slot replaced under the mouse loses its click, see unchanged)
    var belt = $('belt'), bsts = [];
    // The belt only SHOWS what you carry (owner, 27 Nov 2026): a click on it goes to the game behind it, so nothing on the
    // map is out of reach under the bar. With the inventory window open it is part of that window (drag, Shift+click).
    $('bcbox').classList.toggle('through', !bagOpen);
    for (var bi = 0; bi < BELT; bi++) bsts.push(beltSt(bi));
    var bsig = JSON.stringify([me.held, holdMode(), throwing, bagOpen, bsts.map(function (st) { return st ? [st.item, st.qty, st.dur, !!itemImageUrl(content.items[st.item] || {})] : 0; })]);   // (the last: its picture has arrived — until then the slot shows letters)
    if (belt._sig === bsig && belt.firstChild) { tickHotbar(); return; }
    belt._sig = bsig; belt.innerHTML = '';
    for (var i = 0; i < BELT; i++) (function (i) {
      var bs = bsts[i], id = bs ? bs.item : '', it = id && content.items[id], b = document.createElement('div');
      var inHand = holdMode() && me.held === i;
      b.className = 'hk' + (inHand ? ' held' : !holdMode() && throwing && throwing === id ? ' armed' : '') + (it ? '' : ' empty');
      b.title = !it ? 'Empty: assign an item from the bag (I)' : !holdMode() ? it.name + (World.itemCan(it, 'throw') ? ' (throw)' : ' (use)')
        : it.name + (!inHand ? '' : World.itemCan(it, 'consume') ? ' — in hand: hold the click to use it' : World.itemCan(it, 'throw') ? ' — in hand: hold the right button to aim, click to throw it' : World.itemCan(it, 'place') ? ' — in hand: click the ground to put it down (T turns it)' : ' — in hand');
      var key = document.createElement('span'); key.className = 'key'; key.textContent = slotKey(i); b.appendChild(key);
      if (it) {
        b.appendChild(icon({ kind: 'item', id: id }));
        var st = bs.qty;
        if (!World.stackMaxOf || World.stackMaxOf(content, id) > 1 || st !== 1) { var q = document.createElement('span'); q.className = 'qty'; q.textContent = String(st); b.appendChild(q); }   // (one of a kind that does not stack: no number)
        if (!st) b.classList.add('low');
        var bdt = durMark(b, bs);
        if (bdt) b.title += '\n' + bdt;
      }
      b.onclick = function (e) {
        if (e && e.shiftKey && bagOpen && bs) { invMove('belt', i, storage && !storage.takeOnly ? 'box' : 'bag'); return; }   // into the open container or station, else into the backpack
        // (a plain click does nothing: the wheel and the number keys choose, a held click in the game uses)
      };
      // With the inventory window open the belt is part of it: drop a stack on a slot to move it there (out of the
      // backpack or a container: it is then no longer there), drag a slot back onto a cell, or onto another slot.
      invTarget(b, function (g) { return bagOpen && g.from !== 'worn'; }, function (g, e) {
        if (g.from === 'belt' && g.slot === i) return;
        invMove(g.from, g.slot, 'belt', i, g.from === 'belt' ? 0 : invPart(g, e));
      });
      if (it && bagOpen) {
        b.draggable = true;
        b.onmousedown = function () { invPress = true; };
        b.ondragstart = function (e) { invDrag = { from: 'belt', item: id, slot: i, qty: bs.qty }; try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* older browsers */ } };
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
    var was = leftHeld; leftHeld = false; eatHold = false; clearTimeout(holdTimer);
    if (harvesting) { harvesting = null; return; }         // the press was the work itself
    if (picking && was) { picking = null; return; }
    if (!was || aiming) return;                            // was firing while aiming, or not our press
    if (holdFired) { holdFired = false; return; }          // the hold already opened the action list
    if (pendingCell) {                                     // quick tap → the default interaction
      var acts = actsOf(pendingCell);
      var tapA = tapAction(acts);
      if (tapA) doAction(tapA, pendingCell);               // (food in hand is never used by a quick click: see eatHold)
    }
  });
  // the chevron over the log folds it away (remembered in this browser)
  function setLogShut(shut) { $('logbox').classList.toggle('shut', shut); $('log-toggle').innerHTML = shut ? '&#9652;' : '&#9662;'; }
  $('log-toggle').onclick = function () {
    var shut = !$('logbox').classList.contains('shut'); setLogShut(shut);
    try { localStorage.setItem('sheetsrpg.logShut', shut ? '1' : ''); } catch (e) { /* private mode */ }
  };
  try { setLogShut(localStorage.getItem('sheetsrpg.logShut') === '1'); } catch (e) { /* private mode */ }
  UI.tooltips($('frame'), $('tip'));                        // anything with a title shows it on the kit's card
  $('btn-use').onclick = interact;
  $('btn-bag').onclick = toggleBag;
  $('btn-help').onclick = function () { $('help').hidden = !$('help').hidden; };
  $('help-close').onclick = $('help').onclick = function () { $('help').hidden = true; };

  // ---------------------------------------------------------------- HUD and bag
  // The HUD's parts are made once (hudMake) and then only told their numbers; bars, chips and icons are the kit's
  // (client/js/ui.js). What the game has no number for yet is not drawn at all: UI.FLAGS says which, and what each
  // one would read.
  var hudParts = null, weaponSig = '', statusSig = '';
  function hudMake() {
    var P = hudParts = {}, chips = $('chips'), sts = $('statuses');
    P.water = UI.chip('thirst', 'drop'); P.food = UI.chip('hunger', 'meat'); P.temp = UI.chip('temp', 'temp'); P.tox = UI.chip('infection', 'skull');
    [P.water, P.food, P.temp, P.tox].forEach(function (c) { chips.insertBefore(c, sts); });
    P.temp.hidden = true; P.tox.hidden = true;
    P.hp = UI.bar('hp', { cls: 'hp', tail: true, text: true });
    $('hp-row').appendChild(UI.icon('heart', UI.COLOR.red, 'sh')); $('hp-row').appendChild(P.hp);
    P.st = UI.bar('stamina', { cls: 'mid' });
    $('st-row').appendChild(UI.icon('bolt', UI.COLOR.yellow, 'sh')); $('st-row').appendChild(P.st);
    P.mp = UI.bar('thirst', { cls: 'mid' });
    $('mp-row').appendChild(UI.icon('plus', UI.COLOR.blue, 'sh')); $('mp-row').appendChild(P.mp);
    P.xp = UI.bar('xp', { cls: 'thin' }); $('xp-slot').appendChild(P.xp);
    P.noise = UI.bar('stamina', { cls: 'thin' }); $('noise').appendChild(UI.icon('eye')); $('noise').appendChild(P.noise);
    P.night = UI.el('span', '', ''); $('nightfall').appendChild(UI.icon('moon', UI.COLOR.blue)); $('nightfall').appendChild(P.night);
  }
  function hud() {
    if (!me) return;
    if (!hudParts) hudMake();
    var P = hudParts, F = UI.FLAGS;
    buildLockWatch();
    $('hud-map').textContent = mapOf().name;
    UI.setBar(P.hp, me.hp / me.maxHp, Math.max(0, me.hp) + '/' + me.maxHp);
    var span = me.xpNext ? me.xpNext - me.xpThis : 0;
    UI.setBar(P.xp, span ? (me.xp - me.xpThis) / span : 1);
    $('gold').textContent = me.gold + ' gold';
    $('mp-row').hidden = !skillsOn();                      // mana only pays for skills
    if (skillsOn()) { UI.setBar(P.mp, me.maxMp ? me.mp / me.maxMp : 0); P.mp.setAttribute('data-tip', 'MP ' + me.mp + ' / ' + me.maxMp); }
    var food = me.hunger == null ? 100 : me.hunger, water = me.thirst == null ? 100 : me.thirst;
    UI.setChip(P.food, food / 100, food <= 25, 'Food ' + Math.round(food) + '%');
    UI.setChip(P.water, water / 100, water <= 25, 'Water ' + Math.round(water) + '%');
    var tox = Number(me.tox) || 0, sickAt = me.toxSick || 50;                    // toxicity: only there while there is some; it fills as it rises
    P.tox.hidden = tox <= 0;
    UI.setChip(P.tox, tox / 100, tox >= sickAt, 'Toxicity ' + Math.round(tox) + '%' + (tox >= sickAt ? ': it is hurting you' : ': harmful from ' + sickAt + '%') + '. It wears off with time.');
    // ---- waiting for the game to have them (UI.FLAGS): each shows only with its flag on AND its number there
    var stam = F.stamina && me.maxStamina > 0;
    $('st-row').hidden = !stam; if (stam) UI.setBar(P.st, me.stamina / me.maxStamina);
    var temp = F.temperature && me.temp != null;
    P.temp.hidden = !temp; if (temp) UI.setChip(P.temp, me.temp / 100, me.temp <= 20, 'Temperature');
    var ck = F.clock && me.clock;
    $('clock').hidden = !ck; if (ck) UI.setClock($('clock'), ck.day, ck.frac, ck.text);
    var night = F.nightfall && me.clock && me.clock.nightIn > 0 && me.clock.nightIn <= 180;
    $('nightfall').hidden = !night; if (night) P.night.textContent = 'Nightfall in ' + Math.floor(me.clock.nightIn / 60) + 'h ' + Math.round(me.clock.nightIn % 60) + 'm';
    noiseShown = null; noiseMeter();                       // (also every frame from the loop: it falls quiet when you stop)
    $('minimap').hidden = !F.minimap;
    weaponCard();
    // what ails you (and what helps): a chip in the status's colour, its name, the time it has left
    var list = me.statuses || [], ssig = JSON.stringify(list.map(function (st) { return [st.id, Math.ceil((st.until - serverNow()) / 1000)]; }));
    if (ssig !== statusSig) {
      statusSig = ssig;
      var sts = $('statuses'); sts.innerHTML = '';
      list.forEach(function (st) {
        var d = content.statuses[st.id] || { name: st.id, color: '#888' }, one = UI.el('div', 'st'), c = UI.el('div', 'kchip'), lv = UI.el('div', 'lv'), tx = UI.el('span', '');
        var perm = d.kind === 'infection' || st.until > serverNow() + 1e10;   // infection has no timer — it just worsens
        var left = Math.max(0, Math.ceil((st.until - serverNow()) / 1000));
        lv.style.background = d.color; c.appendChild(lv);
        c.appendChild(UI.icon(statusIcon(d, st), '', 'sh'));
        tx.style.color = d.color; tx.appendChild(document.createTextNode(d.name));
        if (!perm) tx.appendChild(UI.el('i', '', Math.floor(left / 60) + ':' + (left % 60 < 10 ? '0' : '') + left % 60));
        one.appendChild(c); one.appendChild(tx); sts.appendChild(one);
      });
    }
    hotbar();
    updateCursor();                 // keep the canvas cursor (crosshair when a gun is ready) in step with gear changes
  }
  /** The icon a status shows with (the HUD and the inventory's condition row). */
  function statusIcon(d, st) { return d.kind === 'infection' ? 'skull' : st.id === 'burn' ? 'flame' : d.kind === 'dot' ? 'drop' : d.kind === 'buff' || d.kind === 'hot' ? 'plus' : 'bolt'; }
  /** What ails you (or helps), as small icons with their words on hover: statuses, toxicity, thirst and hunger when low,
   *  and — once the game has them (UI.FLAGS) — freezing / too hot and too much to carry. [{icon, color, tip}] */
  function conditions() {
    var out = [], food = me.hunger == null ? 100 : me.hunger, water = me.thirst == null ? 100 : me.thirst, tox = Number(me.tox) || 0;
    (me.statuses || []).forEach(function (st) {
      var d = content.statuses[st.id] || { name: st.id, color: '#888' }, left = Math.max(0, Math.ceil((st.until - serverNow()) / 1000));
      var perm = d.kind === 'infection' || st.until > serverNow() + 1e10;
      out.push({ icon: statusIcon(d, st), color: d.color, tip: d.name + (perm ? '' : ' — ' + Math.floor(left / 60) + ':' + (left % 60 < 10 ? '0' : '') + left % 60 + ' left') });
    });
    if (tox > 0) { var sickAt = me.toxSick || 50; out.push({ icon: 'skull', color: tox >= sickAt ? UI.COLOR.red : UI.COLOR.green, tip: 'Toxicity — ' + Math.round(tox) + '%' + (tox >= sickAt ? ', it is hurting you' : ', harmful from ' + sickAt + '%') }); }
    if (water <= 25) out.push({ icon: 'drop', color: UI.COLOR.red, tip: 'Thirsty — water ' + Math.round(water) + '%' });
    if (food <= 25) out.push({ icon: 'meat', color: UI.COLOR.red, tip: 'Hungry — food ' + Math.round(food) + '%' });
    if (UI.FLAGS.temperature && me.temp != null) {
      if (me.temp <= 20) out.push({ icon: 'snow', color: UI.COLOR.blue, tip: 'Freezing — ' + Math.round(me.temp) + '%' });
      else if (me.temp >= 80) out.push({ icon: 'sun', color: UI.COLOR.yellow, tip: 'Too hot — ' + Math.round(me.temp) + '%' });
    }
    if (UI.FLAGS.load && me.maxLoad > 0 && me.load > me.maxLoad) out.push({ icon: 'weight', color: UI.COLOR.yellow, tip: 'Encumbered — carrying ' + me.load + ' / ' + me.maxLoad });
    return out;
  }
  /** Bottom right: what is in your hands when it shoots — its picture, its name, rounds in it / rounds in the bag. */
  function weaponCard() {
    var rw = World.rangedWeapon(content, me), wset = $('weapon-set');
    if (!rw) { wset.hidden = true; weaponSig = ''; return; }
    var reserve = count(rw.ammo), clip = Number(rw.clip) || 0, loaded = (me.mags && me.mags[rw.id]) || 0, cost = rw.ammoCost || 1;
    var cond = UI.FLAGS.condition && me.cond && me.cond[rw.id] != null ? Number(me.cond[rw.id]) : null;
    var sig = [rw.id, reserve, clip, loaded, cond, itemImageUrl(rw) ? 1 : 0].join('|');   // (the last: its picture has arrived)
    wset.hidden = false;
    if (sig === weaponSig) return;
    weaponSig = sig;
    var wl = $('weapon'), slot = UI.el('div', 'hk empty'), side = UI.el('div', 'wside'), line = UI.el('div', 'wline');
    wl.innerHTML = '';
    slot.appendChild(icon({ kind: 'item', id: rw.id })); wl.appendChild(slot); wl.appendChild(side);
    side.appendChild(UI.el('div', 'wname', rw.name)); side.appendChild(line);
    line.appendChild(UI.icon('ammo', UI.COLOR.yellow));
    if (clip > 0) {
      var dry = loaded < cost;
      line.appendChild(UI.el('span', 'wammo' + (dry ? ' low' : ''), loaded));
      line.appendChild(UI.el('span', 'wres', '/ ' + reserve));
      if (dry) line.appendChild(UI.key('R'));
      wset.setAttribute('data-tip', loaded + ' of ' + clip + ' in the ' + rw.name.toLowerCase() + ', ' + reserve + ' more in the bag');
    } else {
      line.appendChild(UI.el('span', 'wammo' + (reserve < cost ? ' low' : ''), reserve));
      wset.removeAttribute('data-tip');
    }
    if (cond != null) {
      var cr = UI.el('div', 'wcond'); cr.appendChild(UI.el('span', '', 'Cond')); cr.appendChild(UI.bar('xp', { cls: 'tiny', value: cond }));
      side.appendChild(cr);
    }
  }
  // ---- the minimap (off: UI.FLAGS.minimap). The land around you, one art pixel per tile, from the map on screen: the
  // ground's own colour (Terrain `color`), what you can see moving as dots, the people who have something for you as marks.
  var miniAt = 0;
  function minimap() {
    if (!UI.FLAGS.minimap || !me || performance.now() - miniAt < 400) return;
    miniAt = performance.now();
    var map = mapOf(), dots = [];
    view.monsters.forEach(function (m) { if (!sight.vis || sight.vis[m.x + ',' + m.y]) dots.push({ x: m.x, y: m.y, color: UI.COLOR.red }); });
    view.players.forEach(function (q) { dots.push({ x: q.x, y: q.y, color: UI.COLOR.bone }); });
    UI.drawMinimap($('minimap-cv'), { cx: me.x, cy: me.y, facing: me.facing, dots: dots, marks: questMarkList,
      colorAt: function (x, y) {
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) return '';
        var t = Rules.terrainAt(content, map, x, y);
        return (t && t.color) || '#2c2a31';
      } });
    $('minimap-name').textContent = map.name || '';
  }
  // ---- the prompt: what a click would do to the thing under the mouse, beside it. It shows only once the mouse has
  // rested on the same tile for PROMPT_MS (never at once, never for what you merely face). Worked out a few times a
  // second (World.actionsAt is the referee's own list), not every frame.
  var PROMPT_MS = 1000, promptAt = 0, promptIs = null, promptCell = '', promptSince = 0;
  function promptMark(marks) {
    var now = performance.now(), ck = hover ? hover.x + ',' + hover.y : '';
    if (ck !== promptCell) { promptCell = ck; promptSince = now; promptIs = null; }    // moved to another tile: wait again
    if (ck && now - promptSince >= PROMPT_MS && now - promptAt > 200) {
      promptAt = now; promptIs = null;
      // only within reach: your own tile or one of the eight around it, not round a wall end (the rules' own reach)
      var reach = Math.abs(hover.x - me.x) <= 1 && Math.abs(hover.y - me.y) <= 1 && !Rules.reachBlocked(content, mapOf(), me.x, me.y, hover.x, hover.y);
      if (reach && !aiming && !armed && !throwing && !building && !removing && !moveTool && !bagOpen && !questOpen && !questPop() && $('menu').hidden) {
        var a = tapAction(actsOf(hover));
        if (a && a.type !== 'attack') promptIs = { id: 'prompt', kind: 'prompt', x: hover.x, y: hover.y, ox: 0.6, oy: 0.5, label: a.label.replace(/\bthe\s+/gi, '') };   // "Pick up small rock", not "…the small rock"
      }
    }
    if (ck && promptIs) marks.push(promptIs);
  }
  /** Crafting has no window of its own: it is the inventory window's right-hand column (hand recipes, and those of the
   *  stations you stand next to). C and using a workbench open that window, and count as opening crafting (a ui goal). */
  function openCrafting() {
    if (questPop()) return;
    if (storage) { storage = null; invSel = -1; }
    if (!bagOpen) toggleBag(); else bag();
    didUi('craft');
  }
  function toggleBag() { if (!bagOpen && questPop()) return; bagOpen = !bagOpen; $('bag').hidden = !bagOpen; if (bagOpen) { bag(); didUi('bag'); } else { storage = null; invSel = -1; } bagHud(); }
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
    if (!buildOpen && questPop()) return;
    if (!buildOpen && me && me.buildLocked) { if (quiet !== true) log(me.buildLocked, 'info'); return; }
    buildOpen = !buildOpen && !!me;
    $('buildbar').hidden = !buildOpen; $('frame').classList.toggle('building', buildOpen);
    bbSig = '';
    if (buildOpen) { standUp(); buildPanel(); didUi('build'); } else stopBuilding();   // closing the bar puts away whatever was in hand
  }
  function stopBuilding() { building = null; removing = false; moveTool = null; buildHold = null; updateCursor(); if (buildOpen) buildPanel(); }
  function startRemoving() {
    if (!me) return;
    standUp();
    building = null; buildHold = null; moveTool = null; removing = true; wallsDown = true;   // walls start down: what you see is what a click picks
    if (buildOpen) buildPanel();
    log('Remove tool: click something you built to take it apart. Walls are shown low so you can reach behind them (H shows them whole). Esc or X stops.', 'info');
    updateCursor();
  }
  function startMoving() {
    if (!me) return;
    standUp();
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
    var plT = !building && !moveTool ? placeHeld() : null;
    var bp = moveTool && moveTool.key ? moveTool.bp : plT ? World.placeBp(content, plT) : building && content.blueprints && content.blueprints[building], o = bp && bp.places === 'object' ? content.objects[bp.object] : null;
    if (!o || World.isWallFixture(o) || !(o.kind === 'stairs' || Rules.turnable(o))) return false;     // stairs turn too: the way they climb
    buildFacing = Rules.nextFacing(buildFacing, dir);
    return true;
  }
  canvas.addEventListener('wheel', function (e) {
    if (e.shiftKey && (building || moveTool || placeHeld()) && turnBuild((e.deltaY || e.deltaX) > 0 ? 1 : -1)) e.preventDefault();
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
  /** That picture cut to what is drawn in it (a square round its painted pixels), for an icon that fills its cell:
   *  item art is often a 32x48 sprite with the thing in one corner. Falls back to the whole picture. */
  function itemIconUrl(it) {
    var im = itemImage(it); if (!im) return '';
    if (im._icon === undefined) {
      im._icon = '';
      try {
        var w = im.width, h = im.height, cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        var g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        var d = g.getImageData(0, 0, w, h).data, x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 >= 0 && (x1 - x0 + 1 < w || y1 - y0 + 1 < h)) {
          var bw = x1 - x0 + 1, bh = y1 - y0 + 1, n = Math.max(bw, bh), out = document.createElement('canvas'); out.width = out.height = n;
          out.getContext('2d').drawImage(cv, x0, y0, bw, bh, Math.floor((n - bw) / 2), Math.floor((n - bh) / 2), bw, bh);
          im._icon = out.toDataURL();
        }
      } catch (e) { im._icon = ''; }                          // (a picture from elsewhere that may not be read: shown whole)
    }
    return im._icon || itemImageUrl(it);
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
    standUp();
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
    var pl = !mv && !building ? placeHeld() : null;             // an item in hand that is put down: the same ghost
    var bp = mv ? mv.bp : pl ? World.placeBp(content, pl) : building && content.blueprints && content.blueprints[building];
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
    // A thing bigger than a tile pivots on the tile pointed at: as authored it reaches up from it, then each turn (T) swings it
    // a quarter round — right, below, left. Only where it is put: its own corner tile (what the rules know) is worked out here.
    if (o && !stairs && !World.isWallFixture(o)) { var pv = Rules.pivotCell(o, buildFacing, x, y); x = pv.x; y = pv.y; }
    var chk = mv ? World.canMove(content, map, lookup(), me, { t: 'ent', key: mv.key }, x, y) : World.canBuild(content, map, lookup(), me, bp, x, y, side, stairs || (o && !World.isWallFixture(o) && Rules.turnable(o)) ? buildFacing : undefined);
    var facing = stairs ? buildFacing : (o && !World.isWallFixture(o) && Rules.turnable(o) ? buildFacing : '');
    return { bp: bp, item: pl ? pl.id : '', x: x, y: y, side: side, off: off, facing: facing, ok: chk.ok, reason: chk.reason || '', risk: chk.risk || '', roof: asRoof };   // risk: a roof's safe | edge | fall
  }
  // ---- storage panel: a container you built. Left = what is in it (Take), below = your bag (Put).
  function closeStore() { storage = null; if (bagOpen) toggleBag(); }   // the container shows in the inventory window: closing it closes that
  // The members panel of your own claim flag (the referee sends a 'claim' event when you use it).
  var claim = null;
  function closeClaim() { claim = null; $('claimp').hidden = true; }
  function basePanel() {
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
  // A window drawn again from scratch on every answer (several a second) flickers, and loses clicks: the button pressed is
  // replaced before it is let go. So each one draws again only when what it shows changed: unchanged(box, sig) says so
  // (and remembers sig). The three that share the NPC window (#npc-body) put which one they are in their sig.
  function unchanged(box, sig) { if (box._sig === sig && box.firstChild) return true; box._sig = sig; return false; }
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
  function skipTutorial() {
    introOpen = false; $('npcp').hidden = true;
    var qs = content.quests || {};
    ((me && me.questIntro) || []).forEach(function (id) { if (qs[id] && qs[id].tutorial) introRead[id] = 1; });   // (the referee drops them all; other new quests still show)
    send({ type: 'quest', op: 'skip' });
    introPanel(); claimPanel();
  }
  /** A window of the page was opened: a quest that asks for exactly that (a `ui` goal) is told, as only the page knows. */
  function didUi(what) {
    var qs = content.quests || {};
    var wanted = myQuests().some(function (x) {
      var q = qs[x.id];
      return q && q.goals.some(function (g, i) { return g.type === 'ui' && g.ref === what && !(Number(x.n[i]) >= 1); });
    });
    if (wanted) send({ type: 'quest', op: 'did', what: what });
  }
  /** A quest window is about to show: every other view (quest log, a container, the bag, crafting, building) is shut first. */
  function questPop() { return !$('npcp').hidden; }          // a quest window is showing: nothing else opens over it
  function closeViews() {
    closeMenu();
    if (questOpen) toggleQuests();
    if (claim) closeClaim();
    if (storage) closeStore();
    if (buildOpen) toggleBuild(true); else if (building || removing || moveTool) stopBuilding();
    if (bagOpen) toggleBag();
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
  var GOAL_VERB = { kill: 'Kill ', have: 'Bring ', own: 'Have ', use: 'Use ', craft: 'Make ', build: 'Build ', tame: 'Tame ', interact: 'Use ', goto: 'Go to ', talk: '', drink: '', eat: '' };
  function goalLabel(g, have) {
    var text = (g.label ? '' : GOAL_VERB[g.type] || '') + World.goalText(content, g);
    return (g.need > 1 || g.type === 'have' || g.type === 'own' ? text + ' ' + have + '/' + g.need : text) + (g.opt ? ' (optional)' : '');
  }
  /** A quest's goals as lines, ticked when met. counts = the entry's n (none = not started). */
  function goalLines(q, counts) {
    var box = qel('div', 'qgoals');
    q.goals.forEach(function (g, i) {
      var have = counts ? Number(counts[i]) || 0 : 0, done = !!counts && have >= g.need;
      box.appendChild(qtext(done ? 'done' : '', (done ? '✓ ' : g.opt ? '◦ ' : '• ') + goalLabel(g, have)));
    });
    return box;
  }
  function openNpc(e) {
    if (e.end) { if (npcTalk && npcTalk.key === e.key && npcTalk.dlg) closeNpc(); return; }   // the conversation is over
    if (me && me.sneak) { me = Object.assign({}, me, { sneak: undefined }); hud(); }   // talking: you stand up (the referee already did)
    var has = npcQuests(e.ref);
    npcWait = false;
    if (!e.dlg && !e.shop && !has.ready.length && !has.open.length && !has.active.length) {      // nothing between you: just what they say
      log(e.text ? e.name + ': ' + e.text : e.name + ' has nothing to say yet.', 'info');
      return;
    }
    if (introOpen) closeIntro();
    closeClaimQuest();
    npcTalk = e; npcQuest = ''; npcPick = -1;
    closeViews(); $('npcp').hidden = false; npcPanel();
  }
  // ---- a conversation (an NPC with a dialogue: Content Studio → Story → Dialogues). The referee says each line and
  // which answers this character may give (the npc event's dlg = {node, answers: [{a, text}], hub}); the page shows
  // them and sends the one picked ({type: 'talk', key, a}). On a line that opens the talk (hub) the NPC's quests are
  // listed among the answers. Keys 1-9 pick an answer.
  var npcWait = false;                                       // an answer was sent: wait for the next line (no second click)
  function dlgRows() {
    if (!npcTalk || !npcTalk.dlg) return [];
    var rows = npcTalk.dlg.answers.map(function (a) { return { text: a.text, go: function () { if (npcWait) return; npcWait = true; send({ type: 'talk', key: npcTalk.key, a: a.a }); npcPanel(); } }; });
    if (npcTalk.dlg.hub) {
      var has = npcQuests(npcTalk.ref);
      [['ready', '?'], ['open', '!'], ['active', '…']].forEach(function (grp) {
        has[grp[0]].forEach(function (one) { rows.push({ text: one.name, mark: grp[1], cls: grp[0], go: function () { npcQuest = one.id; npcPick = -1; npcPanel(); } }); });
      });
    }
    if (!npcTalk.dlg.answers.length) rows.push({ text: 'Goodbye.', go: closeNpc });   // nothing to answer: you can still take your leave
    return rows;
  }
  function dlgKey(i) { var r = dlgRows()[i]; if (r) r.go(); }
  /** The NPC as a small figure beside what it says: its outfit, else its object picture. */
  function npcPortrait(ref) {
    var o = content.objects[ref]; if (!o) return null;
    var fit = Render.outfitOf ? Render.outfitOf(o) : null;
    if (!fit && !o.sprite) return null;
    var cv = document.createElement('canvas'); cv.width = 64; cv.height = 96; cv.className = 'dface';
    if (fit) {                                                     // a figure: alive while it is talked to — it breathes (liveFigure); two rows of room above for that
      cv.height = 100; cv.classList.add('live');
      liveFigure(cv, function () { return Render.outfitLayers(fit); }, { ph: phaseOf(ref) });
      return cv;
    }
    function paint() {
      if (!cv.isConnected && cv._tries) return;
      var g = cv.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, 64, 96);
      if (fit) Render.drawOutfit(g, fit, 0, 32, 64, false);
      else { var im = Assets.get(o.sprite); if (im) { var h = Math.min(96, Math.round(64 * im.height / (im.width / (o.frames || 1)))); g.drawImage(im, 0, 0, im.width / (o.frames || 1), im.height, 0, 96 - h, 64, h); } else Assets.load(o.sprite); }
      if ((cv._tries = (cv._tries || 0) + 1) < 5) setTimeout(paint, 400);   // (pictures still loading are drawn when they arrive)
    }
    paint();
    return cv;
  }
  function dlgView(box) {
    var top = qel('div', 'dlg'), face = npcPortrait(npcTalk.ref);
    if (face) top.appendChild(face);
    top.appendChild(qtext('qsay', npcTalk.text || '…'));
    box.appendChild(top);
    var list = qel('div', 'dans');
    dlgRows().forEach(function (r, i) {
      var b = qel('button', 'qrow ' + (r.cls || ''));
      b.appendChild(qel('span', 'qkey', i < 9 ? String(i + 1) : ''));
      if (r.mark) b.appendChild(qel('span', 'qmark', r.mark));
      b.appendChild(qtext('qans', r.text));
      b.disabled = npcWait; b.onclick = r.go;
      list.appendChild(b);
    });
    box.appendChild(list);
  }
  // ---- a shop (an NPC with one: Content Studio → Story → Shops). The referee sends the offers this character may take
  // (a shop event: {key, name, offers: [{id, gives, costs, sell, left, back}]}) and again after every trade; the page
  // lists them — what the trader sells, then what it buys — and sends {type: 'shop', op: 'trade', key, offer, qty}.
  // A click trades once, Shift+click five times (as many as you can pay for and are left).
  function openShop(e) {
    if (introOpen) closeIntro();
    closeClaimQuest();
    npcTalk = { key: e.key, ref: e.ref, name: e.name, text: '', offers: e.offers || [], at: Date.now() }; npcQuest = ''; npcWait = false;
    closeViews(); $('npcp').hidden = false; npcPanel();
  }
  function haveOf(id) { return id === 'gold' ? (me.gold || 0) : (me.inventory || []).reduce(function (t, s) { return t + (s && s.item === id ? s.qty : 0); }, 0); }
  function tradeList(text) {
    var d = qel('span', 'tlist');
    World.list(text).filter(function (g) { return g.qty > 0; }).forEach(function (g) {
      var one = qel('span', 'tone'), it = content.items[g.item], im = it && itemImageUrl(it);
      if (im) { var i = qel('i', 'tico'); i.style.backgroundImage = 'url(' + im + ')'; one.appendChild(i); }
      one.appendChild(document.createTextNode(g.qty + ' ' + itemName(g.item)));
      d.appendChild(one);
    });
    return d;
  }
  function backText(s) { return s >= 5400 ? Math.round(s / 3600) + ' h' : s >= 90 ? Math.round(s / 60) + ' min' : 'a minute'; }
  function shopView(box) {
    var offers = npcTalk.offers, any = false;
    [['Buy', false], ['Sell', true]].forEach(function (grp) {
      var mine = offers.filter(function (o) { return !!o.sell === grp[1]; });
      if (!mine.length) return;
      any = true;
      box.appendChild(qel('h4', '', grp[0]));
      mine.forEach(function (o) {
        var costs = World.list(o.costs).filter(function (g) { return g.qty > 0; });
        var can = Math.min.apply(null, [99].concat(costs.map(function (g) { return Math.floor(haveOf(g.item) / g.qty); })));
        if (o.left != null) can = Math.min(can, o.left);
        var row = qel('div', 'shoprow' + (can < 1 ? ' cant' : '')), what = qel('div', 'swhat');
        what.appendChild(tradeList(grp[1] ? o.costs : o.gives));          // (what moves is named first: the goods you get, or the goods you hand over)
        var price = qel('div', 'sprice'); if (!grp[1] && !costs.length) price.textContent = 'free'; else { price.appendChild(document.createTextNode(grp[1] ? 'for ' : 'costs ')); price.appendChild(tradeList(grp[1] ? o.gives : o.costs)); }
        what.appendChild(price);
        if (o.left != null) what.appendChild(qel('div', 'sleft', o.left > 0 ? o.left + ' left' : o.back ? 'None left: back in ' + backText(o.back) : 'None left'));
        var b = qel('button', can >= 1 ? 'primary' : '', grp[1] ? 'Sell' : 'Buy');
        b.disabled = can < 1; b.title = can < 1 ? (o.left === 0 ? 'None left' : 'You don\'t have what it costs') : 'Click: once. Shift+click: five times';
        b.onclick = function (ev) { send({ type: 'shop', op: 'trade', key: npcTalk.key, offer: o.id, qty: ev.shiftKey ? Math.min(5, can) : 1 }); };
        row.appendChild(what); row.appendChild(b);
        box.appendChild(row);
      });
    });
    if (!any) box.appendChild(qel('div', 'empty', 'Nothing to trade right now.'));
    var foot = qel('div', 'qbtns'), gold = qel('span', 'qreward', 'You have ' + (me.gold || 0) + ' gold'), shut = qel('button', '', 'Done');
    gold.style.marginRight = 'auto'; shut.onclick = closeNpc;
    foot.appendChild(gold); foot.appendChild(shut); box.appendChild(foot);
  }
  function closeNpc() { npcTalk = null; npcQuest = ''; npcWait = false; $('npcp').hidden = true; claimPanel(); }   // (a finished quest may have been waiting for this window)
  function npcPanel() {
    if (!npcTalk) return;
    // walked away (or they are gone): the window closes
    var ent = (mapOf().entities || []).filter(function (en) { return en.key === npcTalk.key; })[0];
    if (!ent || Math.abs(ent.x - me.x) > 1 || Math.abs(ent.y - me.y) > 1) { closeNpc(); return; }
    var box = $('npc-body'), has = npcQuests(npcTalk.ref), q = npcQuest && (content.quests || {})[npcQuest];
    if (unchanged(box, JSON.stringify(['npc', npcTalk.key, npcQuest, npcPick, myQuests(), me.questsOpen || [], me.inventory, npcTalk.dlg || 0, npcTalk.text, npcWait, npcTalk.offers || 0, me.gold]))) return;
    box.innerHTML = ''; $('npc-title').textContent = npcTalk.name;
    var entry = q && questEntry(q.id), offered = q && ((me.questsOpen || []).indexOf(q.id) >= 0);
    if (q && !entry && !offered) { q = null; npcQuest = ''; }                // accepted, handed in or no longer on offer: back to the list
    if (npcTalk.offers) return shopView(box);                                // a shop
    if (!q && npcTalk.dlg) return dlgView(box);                              // a conversation: the line, and what you can answer
    if (!q) {
      if (npcTalk.text) box.appendChild(qtext('qsay', npcTalk.text));
      if (npcTalk.shop) {                                                   // a trader with no conversation: straight to the offers
        var tb = qel('button', 'qrow'); tb.appendChild(qel('span', 'qmark', '$')); tb.appendChild(qel('span', '', 'Trade'));
        tb.onclick = function () { send({ type: 'shop', op: 'open', key: npcTalk.key }); };
        box.appendChild(tb);
      }
      if (!has.ready.length && !has.open.length && !has.active.length) { if (!npcTalk.shop) box.appendChild(qel('div', 'empty', 'Nothing more for now.')); return; }
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
  function toggleQuests() { if (!questOpen && questPop()) return; questOpen = !questOpen; abandonArmed = ''; $('questp').hidden = !questOpen; if (questOpen) { questPanel(); didUi('quests'); } }
  // The quest log (L): the quests you are on down the left, the one picked on the right. Tutorial steps are never here
  // (they teach through their own window; the referee still counts them). The box on each row = follow it: only the
  // followed ones show in the tracker (quest op follow; new quests are followed).
  var questPick = '';
  function logQuests() { var qs = content.quests || {}; return myQuests().filter(function (x) { return qs[x.id] && !qs[x.id].tutorial; }); }
  function followBox(x) {
    var b = qel('i', 'fbox' + (x.hide ? '' : ' on'));
    b.title = x.hide ? 'Not followed: click to show it in the tracker' : 'Followed: shown in the tracker. Click to hide it there';
    b.onclick = function (ev) { ev.stopPropagation(); send({ type: 'quest', op: 'follow', id: x.id, on: !!x.hide }); };
    return b;
  }
  function questPanel() {
    var box = $('quest-body'), qs = content.quests || {}, list = logQuests();
    if (unchanged(box, JSON.stringify([questPick, abandonArmed, list, me.inventory]))) return;
    box.innerHTML = '';
    if (!list.length) { box.appendChild(qel('div', 'empty', 'No quests yet. Talk to people: someone with work for you has a ! over their head.')); return; }
    if (!list.some(function (x) { return x.id === questPick; })) questPick = list[0].id;
    var wrap = qel('div', 'qlog'), side = qel('div', 'qlist kinset'), sum = qel('div', 'qsum');
    list.forEach(function (x) {
      var q = qs[x.id], row = qel('div', 'qli' + (x.id === questPick ? ' on' : '') + (x.s === 'ready' ? ' ready' : ''));
      row.appendChild(followBox(x));
      row.appendChild(qel('span', 'qn', q.name));
      if (x.s === 'ready') row.appendChild(qel('span', 'qst', '✓'));
      row.title = x.s === 'ready' ? 'Done' + (q.ender ? ': return to ' + objName(q.ender) : ': claim it') : 'Under way';
      row.onclick = function () { questPick = x.id; abandonArmed = ''; questPanel(); };
      side.appendChild(row);
    });
    var x = list.filter(function (e) { return e.id === questPick; })[0], q = qs[x.id];
    var head = qel('div', 'qshead');
    head.appendChild(qel('b', '', q.name));
    var fl = qel('label', 'qfollow'); fl.appendChild(followBox(x)); fl.appendChild(document.createTextNode('Follow'));
    fl.onclick = function () { send({ type: 'quest', op: 'follow', id: x.id, on: !!x.hide }); };
    head.appendChild(fl);
    sum.appendChild(head);
    if (questPic(q)) sum.appendChild(questPic(q));
    if (q.text) sum.appendChild(qtext('qsay', q.text));
    if (q.goals.length) sum.appendChild(goalLines(q, x.n));
    if (x.s === 'ready') sum.appendChild(qel('div', 'qreturn', q.ender ? (q.goals.length ? 'Done: return to ' : 'Find ') + objName(q.ender) + '.' : 'Done.'));
    var rw = rewardText(q), pk = choiceList(q);
    if (pk.length) rw += (rw ? ' · ' : '') + 'one of: ' + pk.map(function (g) { return g.qty + ' ' + itemName(g.item); }).join(' / ');
    if (rw) sum.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
    var btns = qel('div', 'qbtns');
    if (x.s === 'ready' && !q.ender) {                             // nobody to hand it to: it is claimed right here
      var fin = qel('button', 'primary', 'Claim');
      fin.onclick = function () { toggleQuests(); claimPanel(q.id); };
      btns.appendChild(fin);
    }
    if (!q.noAbandon) {                                            // (a main quest, ticked "cannot be given up" in the Studio, has no such button)
      var drop = qel('button', '', abandonArmed === q.id ? 'Really give up?' : 'Give up');
      drop.onclick = function () { if (abandonArmed === q.id) { abandonArmed = ''; send({ type: 'quest', op: 'abandon', id: q.id }); } else { abandonArmed = q.id; questPanel(); } };
      btns.appendChild(drop);
    }
    if (btns.children.length) sum.appendChild(btns);
    wrap.appendChild(side); wrap.appendChild(sum);
    box.appendChild(wrap);
  }
  /** The corner tracker: what you are on and how far along, without opening anything. */
  var trackerSig = '';
  function goalName(g) { return (g.label ? '' : GOAL_VERB[g.type] || '') + World.goalText(content, g) + (g.opt ? ' (optional)' : ''); }
  /** Top right: the quests you are on, a card each — its goals with a tick box, and a bar for the ones that count up. */
  function tracker() {
    var box = $('tracker'), qs = content.quests || {}, list = logQuests().filter(function (x) { return !x.hide; });   // followed ones only (quest log, L)
    var sig = JSON.stringify(list);
    if (sig === trackerSig) return;
    trackerSig = sig; box.innerHTML = '';
    list.slice(0, 5).forEach(function (x) {
      var q = qs[x.id], one = qel('div', 'k kplate tq' + (x.s === 'ready' ? ' ready' : ''));
      one.appendChild(qel('b', '', q.name));
      if (x.s === 'ready') {
        var rl = qel('div', 'tline done'); rl.appendChild(qel('i', 'box'));
        rl.appendChild(qel('span', '', q.ender ? (q.goals.length ? 'Return to ' : 'Find ') + objName(q.ender) : 'Done. Claim it'));
        if (!q.ender) rl.appendChild(UI.key('L'));
        one.appendChild(rl);
      } else q.goals.forEach(function (g, i) {
        var have = Number(x.n[i]) || 0, done = have >= g.need, counted = g.need > 1 || g.type === 'have' || g.type === 'own';
        var ln = qel('div', 'tline' + (done ? ' done' : '')); ln.appendChild(qel('i', 'box'));
        ln.appendChild(qtext('', counted && !done ? goalName(g) : goalLabel(g, have)));
        one.appendChild(ln);
        if (counted && !done) {
          var pr = qel('div', 'tprog'); pr.appendChild(UI.bar('stamina', { cls: 'tiny', value: have / g.need })); pr.appendChild(qel('span', '', have + '/' + g.need));
          one.appendChild(pr);
        }
      });
      box.appendChild(one);
    });
    if (list.length > 5) box.appendChild(qel('div', 'k kplate tq more', '+' + (list.length - 5) + ' more (L)'));
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
  // "New quest": quests a new character starts with (Config start_quests), and every quest started since by an action
  // or by another quest (its rewards, on_start, a goal's on_done). me.questIntro lists them in the order they started;
  // they are shown ONE window at a time, each closed one told to the referee (quest op `seen` + id), then the next.
  var introOpen = false, introId = '', introRead = {};      // introRead = closed here, until the referee's answer drops them from the list
  function introPanel() {
    if (Scene.playing()) return;                                // (after the scene)
    var all = (me && me.questIntro) || [];
    Object.keys(introRead).forEach(function (id) { if (all.indexOf(id) < 0) delete introRead[id]; });   // (gone from the list: a later start of it is shown again)
    var ids = all.filter(function (id) { return (content.quests || {})[id] && !introRead[id]; }).slice(0, 1);
    if (introOpen || !ids.length) return;
    introOpen = true; introId = ids[0]; claimQuest = ''; npcTalk = null; npcQuest = '';
    var box = $('npc-body'); box.innerHTML = ''; box._sig = 'intro';
    var teach = isTutorial(introId);
    $('npc-title').textContent = teach ? 'Tutorial' : 'New quest';
    ids.forEach(function (id) {
      var q = content.quests[id], rw = rewardText(q);
      box.appendChild(qel('h4', '', q.name));
      if (questPic(q)) box.appendChild(questPic(q));
      if (q.text) box.appendChild(qtext('qsay', q.text));
      if (q.goals.length && !q.tutorial) box.appendChild(goalLines(q, (questEntry(id) || {}).n || null));   // (a tutorial step's progress is never shown)
      else if (q.ender && !q.tutorial) box.appendChild(qel('div', 'qgoals', '• Find ' + objName(q.ender)));
      if (rw) box.appendChild(qel('div', 'qreward', 'Reward: ' + rw));
    });
    var btns = qel('div', 'qbtns'), go = qel('button', 'primary', 'Begin');
    go.onclick = closeIntro;
    if (teach) { var skip = qel('button', '', 'Skip tutorial'); skip.onclick = skipTutorial; btns.appendChild(skip); }
    btns.appendChild(go); box.appendChild(btns);
    closeViews(); $('npcp').hidden = false;
  }
  function closeIntro() {
    if (!introOpen) return;
    introOpen = false; introRead[introId] = 1; $('npcp').hidden = true;
    send({ type: 'quest', op: 'seen', id: introId });
    introPanel();                                               // the next one waiting, if any
    claimPanel();
  }
  // Quest complete: a quest with nobody to hand it to (no giver, no ender) is finished right where you stand. When
  // its last objective is met this window opens by itself with its done text and a Claim button; closed without
  // claiming, it stays ready in the quest log (L), from where it can be opened again.
  var claimQuest = '', claimPick = -1, claimSkipped = {};
  function claimPanel(openId) {
    var qs = content.quests || {};
    if (openId) { delete claimSkipped[openId]; claimQuest = openId; claimPick = -1; }
    if (introOpen || npcTalk || Scene.playing()) return;       // one window at a time: this one waits its turn
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
    if (unchanged(box, JSON.stringify(['claim', claimQuest, claimPick, entry, rw])) && !$('npcp').hidden) return;   // (showing, nothing new: leave it, and the other views, alone)
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
    closeViews(); $('npcp').hidden = false;
  }
  function closeClaimQuest() { if (!claimQuest) return; claimSkipped[claimQuest] = 1; claimQuest = ''; $('npcp').hidden = true; }
  /** After every answer: the tracker, the marks, and whichever quest window is open. */
  // ---- scenes (client/js/scene.js). The referee names the one to play now (me.scene, publicPlayer); the page plays it
  // and tells it when it is over ({type: 'scene', op: 'end'}), watched or skipped — then whatever the scene held
  // back happens. A page that comes back mid-scene plays it again from the start (op 'play' restarts its clock).
  var sceneEnded = '';                                          // the one just ended, until the referee's answer drops it
  var sceneTry = false;                                         // a try from the Content Studio (?scene=): the referee knows nothing of it
  function sceneCheck() {
    if (Scene.playing()) return true;
    var id = me && me.scene;
    if (!id) { sceneEnded = ''; return false; }
    if (id === sceneEnded) return false;
    var sc = (content.scenes || {})[id];
    if (!sc) { sceneEnded = id; send({ type: 'scene', op: 'end', id: id }); return false; }   // (gone from the content: nothing to show)
    send({ type: 'scene', op: 'play', id: id });
    playScene(sc, function () { sceneEnded = id; send({ type: 'scene', op: 'end', id: id }); questsChanged(); });
    return true;
  }
  function playScene(sc, done) {
    // every window shuts; a quest window that was showing comes back after (it was not read)
    closeViews();
    closeEmotes();
    if (npcTalk) closeNpc();
    if (introOpen) { introOpen = false; $('npcp').hidden = true; }
    if (claimQuest) { claimQuest = ''; $('npcp').hidden = true; }
    if (armed) disarm(); if (throwing && !holdMode()) cancelThrow();
    held = []; tap = null; aiming = false; leftHeld = false; harvesting = null; picking = null;
    sceneLooks = {};
    Scene.start(sc, { at: { x: shown.x, y: shown.y }, done: done, lift: sceneLift, actor: sceneActorAt, path: scenePath, portrait: scenePortrait, nameOf: sceneName, spots: sceneSpots,
      pace: 1000 / (content.config.move_ms || 140) });
  }
  function questsChanged() {
    if (!me) return;
    if (sceneCheck()) return;                                   // a scene first: quest windows wait until it is over
    introPanel();
    claimPanel();
    tracker(); questMarksUpdate();
    if (npcTalk) npcPanel();
    if (questOpen) questPanel();
  }

  var craftQty = {};                                           // how many of each recipe was last picked (the window is redrawn often)
  // ---- the inventory window (I, or opening a storage container) ----
  // Grids of cells: your bag, the open container beside it, and the belt under them. A stack sits in the cell the
  // referee says (stack.s). Dragging one onto a cell sends the 'inv' action — put down, joined to more of the same,
  // or swapped with what is there, as World.invAct decides; Shift while dropping moves half of it, Ctrl just one.
  // Dropped on a belt slot it moves there (the belt is cells of the same list: {w: 'belt', s: slot}), and back. Shift+click sends a stack across at once; double-click uses or equips.
  // Nothing is decided here: every drop is an action the referee checks, and the window is redrawn from its answer.
  var EQUIP_CELLS = [{ slot: 'helm', label: 'Head' }, { slot: 'armor', label: 'Chest' }];   // the worn slots shown in the inventory window
  var invDrag = null, invDirty = false, invSel = -1, INV_COLS = 6, invPress = false, invSig = '';
  addEventListener('mouseup', function () { if (invPress) { invPress = false; if (invDirty && !invDrag) { invDirty = false; bag(); } } });
  setInterval(function () { if (bagOpen && storage && storage.cook && storage.cook.lit && !invDrag && !document.hidden) send({ type: 'store', key: storage.key, op: 'look' }); }, 1500);
  /** Where you wear this item ('' = you do not): its slot, or one of the accessory places. */
  function wornKey(id) {
    var it = content.items[id], eq = (me && me.equipment) || {};
    if (!it || !it.slot) return '';
    return World.wornAt ? World.wornAt(me, it) : (eq[it.slot] === id ? it.slot : '');
  }
  /** A weapon's or tool's wear on its cell: a thin line along the bottom (how much is left), and "Durability 34/50" for
   *  the hover text. st = the stack ({item, dur}); returns that text, or '' for something that never wears out. */
  function durMark(el, st) {
    var d = st && World.durOf ? World.durOf(content, st) : null; if (!d) return '';
    if (d.left <= 0) el.classList.add('broken');
    var f = d.left / d.max, bar = document.createElement('i'), fill = document.createElement('i');
    bar.className = 'durb'; fill.style.width = (100 * f).toFixed(1) + '%';
    fill.style.background = f > 0.5 ? 'var(--green)' : f > 0.25 ? 'var(--yellow)' : 'var(--red)';
    bar.appendChild(fill); el.appendChild(bar);
    return d.left <= 0 ? 'Broken: repair it, or salvage it (durability 0/' + d.max + ')' : 'Durability ' + d.left + '/' + d.max;
  }
  /** What a piece of gear would change against what is worn in its place (a weapon: against the one in hand), for the
   *  tooltip after a second of hovering. Each number: worn → this one, and the difference in green / red. */
  var GEAR_STATS = [['atk', 'Attack'], ['def', 'Defence'], ['range', 'Range'], ['clip', 'Clip'], ['durability', 'Durability']];
  function gearCompare(it, st) {
    var eq = (me && me.equipment) || {}, k = it.slot, wid = '';
    if (k === 'weapon') wid = eq.weapon || '';
    else if (k === 'accessory') { var ks = []; for (var ai = 1; ai <= (World.ACC_SLOTS || 2); ai++) ks.push('accessory' + ai); wid = ks.some(function (a) { return !eq[a]; }) ? '' : eq.accessory1 || ''; }
    else wid = eq[k] || '';
    var w = wid && content.items[wid], box = document.createElement('div'); box.className = 'cmp';
    var head = document.createElement('i');
    head.textContent = w ? (w === it ? 'The same as ' + (k === 'weapon' ? 'in hand' : 'worn') : 'Against ' + (k === 'weapon' ? 'in hand' : 'worn') + ': ' + w.name) : (k === 'weapon' ? 'Nothing in hand' : 'Nothing worn there');
    box.appendChild(head);
    var rows = 0;
    GEAR_STATS.forEach(function (f) {
      var a = Number((w || {})[f[0]]) || 0, b = Number(it[f[0]]) || 0;
      if (!a && !b) return;
      var r = document.createElement('div'), lab = document.createElement('span'), val = document.createElement('span'), dif = document.createElement('b');
      lab.textContent = f[1]; val.textContent = (w ? a + ' → ' : '') + b;
      var dd = b - a; dif.textContent = dd ? (dd > 0 ? '+' : '') + dd : '='; dif.className = dd > 0 ? 'up' : dd < 0 ? 'down' : '';
      r.appendChild(lab); r.appendChild(val); r.appendChild(dif); box.appendChild(r); rows++;
    });
    if (!rows && !w) return null;
    return box;
  }
  function invCell(id, qty, from, slot, st) {
    var it = id ? (content.items[id] || { name: id, type: '' }) : null, d = document.createElement('div');
    d.className = 'icell' + (it ? ' has' : '') + (from === 'bag' && it && slot === invSel ? ' sel' : '');
    if (!it) return d;
    d.appendChild(icon({ kind: 'item', id: id }));
    if (qty !== 1 || from === 'belt') { var q = document.createElement('span'); q.className = 'qty'; q.textContent = String(Math.max(0, qty)); d.appendChild(q); }
    var dt = durMark(d, st);
    d.title = it.name + ' — ' + describe(it) + (dt ? '\n' + dt : '');
    if ((from === 'bag' || from === 'box') && it.slot) d._tipMore = function () { return gearCompare(it, st); };   // (after a second: against what is worn / in hand)
    d.draggable = true;
    d.onmousedown = function () { invPress = true; };
    d.ondragstart = function (e) { invDrag = { from: from, item: id, slot: slot, qty: qty }; if (from !== 'worn') dollHint(it); try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { /* older browsers */ } };
    d.ondragend = function () { invDrag = null; invPress = false; dollHint(null); if (invDirty) { invDirty = false; hotbar(); bag(); } };
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
    ov.addEventListener('dragover', function (e) { if (invDrag && (invDrag.from === 'bag' || invDrag.from === 'belt') && e.target === ov) e.preventDefault(); });
    ov.addEventListener('drop', function (e) {
      var g = invDrag; if (!g || (g.from !== 'bag' && g.from !== 'belt') || e.target !== ov) return;
      e.preventDefault(); invSel = -1;
      var a = { type: 'inv', op: 'drop', s: g.slot, qty: g.qty }; if (g.from === 'belt') a.w = 'belt';
      send(a);
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
  // cols = how many across (INV_COLS); lo = show only the `size` cells from cell lo on (one run of a cooker's cells).
  function invGrid(stacks, w, size, cols, lo) {
    var g = document.createElement('div'); g.className = 'igrid';
    var at = {}, top = -1, part = lo != null;
    cols = cols || INV_COLS; lo = lo || 0;
    g.style.gridTemplateColumns = 'repeat(' + cols + ', 30rem)';
    (stacks || []).forEach(function (st, i) { var c = st.s >= 0 ? st.s : i; at[c] = st; if (c > top) top = c; });
    var n = part ? size : Math.max(cols, Math.ceil(Math.max(size || 0, top + 1) / cols) * cols), end = size ? lo + size : 0;
    for (var k = 0; k < n; k++) (function (i) {
      var st = at[i], c = invCell(st && st.item, st && st.qty, w, i, st);
      if (w === 'bag' && st && !bagMatch(content.items[st.item])) c.classList.add('fade');   // not what the backpack's filter is showing
      if (end && i >= end) c.classList.add(st ? 'extra' : 'off');             // past the last cell: overflow, or not a cell at all
      if (!(end && i >= end)) invTarget(c, function (d) { return ((d.from === 'bag' || d.from === 'belt') && !(w === 'box' && storage && storage.takeOnly)) || d.from === 'box' || (d.from === 'worn' && w === 'bag'); }, function (d, e) {   // (nothing is dropped into a take-only container)
        if (d.from === 'worn') useItem(d.item);
        else invMove(d.from, d.slot, w, i, invPart(d, e));
      });
      if (st) {
        c.onclick = function (e) {
          if (e.shiftKey && storage && !(w === 'bag' && storage.takeOnly)) { invMove(w, i, w === 'bag' ? 'box' : 'bag'); return; }
          if (e.shiftKey && w === 'bag') { toBelt(i, st); return; }       // (no container or station open: onto the belt)
          if (w === 'bag') { invSel = invSel === i ? -1 : i; bag(); }
        };
        if (w === 'bag') c.ondblclick = function () { var it = content.items[st.item]; if (it && (World.itemCan(it, 'consume') || (it.slot && it.slot !== 'weapon'))) useItem(st.item, { w: 'bag', s: i }); };
      }
      g.appendChild(c);
    })(lo + k);
    return g;
  }
  // ---- the inventory window's parts. One window, three shapes (bag): your own (who you are | what you carry | what
  // you can make), a container's (what you carry | what it holds) and a cooker's (what you carry | the fire | its
  // recipes). They are built from the UI kit (client/js/ui.js; the pieces and their sizes: art/ui/kit/PIECES.md), in
  // art pixels (rem). Nothing is decided here: every button and every drop is an action the referee checks.
  var cookSt = { sel: '', enough: false, cat: '' }, handSt = { sel: '', enough: false, cat: '' }, BAG_COLS = 6;
  var bagFilter = 'all', listTop = {}, cookQty = {}, makingBar = null;
  function clock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return (s >= 3600 ? two(Math.floor(s / 3600)) + ':' : '') + two(Math.floor(s / 60) % 60) + ':' + two(s % 60);
  }
  function bagSizeNow() { return World.bagSlots ? World.bagSlots(content) : INV_COLS * 4; }
  // The backpack's filter only dims what it is not about: every stack stays in its cell, so dragging works as ever.
  var BAG_FILTERS = [['all', 'pack', 'Everything'], ['tools', 'hammer', 'Tools and materials'], ['food', 'meat', 'Food, drink and medicine'], ['weapons', 'sword', 'Weapons, ammunition and what you wear']];
  function bagMatch(it) {
    if (bagFilter === 'all' || !it) return true;
    var eat = World.itemCan(it, 'consume'), arm = !!it.slot || World.itemCan(it, 'shoot') || (World.itemCan(it, 'throw') && !it.ownThrow) || it.type === 'ammo';   // (a material that can be thrown is still a material)
    return bagFilter === 'food' ? eat : bagFilter === 'weapons' ? arm : !eat && !arm;
  }
  /** "+20 hunger, +5 attack": what an item gives, or nothing. */
  function gains(it) { var t = describe(it); return t === (it.type || 'item') ? '' : t; }
  /** The backpack: its title and count, the filter and Sort, the cells. */
  function bagColumn() {
    var size = bagSizeNow(), used = bagStacks().length, col = qel('div', 'wcol'), bar = qel('div', 'wbar');
    col.style.width = '190rem';
    col.appendChild(UI.head('Backpack', used + '/' + size, used > size));
    BAG_FILTERS.forEach(function (f) {
      var b = qel('button', bagFilter === f[0] ? 'on' : ''); b.type = 'button'; b.title = f[2]; b.appendChild(UI.icon(f[1]));
      b.onclick = function () { bagFilter = f[0]; bag(); };
      bar.appendChild(b);
    });
    bar.appendChild(qel('span', 'sp'));
    var sort = qel('button', '', 'Sort'); sort.title = 'Put the bag in order: the same things joined into full stacks, kinds together';
    sort.disabled = !used; sort.onclick = function () { invSel = -1; send({ type: 'inv', op: 'sort' }); };
    bar.appendChild(sort); col.appendChild(bar);
    var tray = qel('div', 'k kinset tray'); tray.appendChild(invGrid(bagStacks(), 'bag', size, BAG_COLS));
    if (UI.FLAGS.lockedRow) {                                  // (off: a row to be unlocked by a better bag)
      var lock = qel('div', 'igrid'); lock.style.marginTop = '1rem';
      for (var i = 0; i < BAG_COLS; i++) lock.appendChild(qel('div', 'icell locked'));
      tray.appendChild(lock);
    }
    col.appendChild(tray);
    if (UI.FLAGS.load && me.maxLoad > 0) {                     // (off: what you carry weighs nothing yet)
      var lr = qel('div', 'making'); lr.appendChild(qel('span', '', 'Load')); lr.appendChild(qel('span', '', me.load + '/' + me.maxLoad + ' kg'));
      lr.appendChild(UI.bar('xp', { cls: 'tiny', value: me.load / me.maxLoad })); col.appendChild(lr);
    }
    return col;
  }
  /** The stack picked in the backpack: what it is, and what can be done with it. */
  function itemCard() {
    var card = qel('div', 'k kplate icard'), sel = invSel >= 0 ? (me.inventory || []).filter(function (s) { return s.s === invSel; })[0] : null;
    if (!sel) {
      invSel = -1;
      card.appendChild(qel('div', 'tb', storage && storage.takeOnly ? 'Drag what you want out of the ' + storage.name.toLowerCase() + ' into your backpack. Nothing can be put in it; emptied, it is gone.'
        : storage ? 'Drag things between your backpack and the ' + storage.name.toLowerCase() + ', or onto a slot of the belt below.'
        : 'Click something in your backpack to see what it is. Drag it onto a slot of the belt below to keep it at hand, or out of the window to drop it.'));
      return card;
    }
    var it = content.items[sel.item] || { name: sel.item, type: '' }, equipped = !!wornKey(sel.item) && !(World.wornCell && World.wornCell(wornKey(sel.item)) >= 0), eats = World.itemCan(it, 'consume');
    var top = qel('div', 'top'), cell = qel('div', 'icell'), mid = qel('div'), btns = qel('div', 'btns');
    cell.appendChild(icon({ kind: 'item', id: sel.item }));
    mid.appendChild(qel('b', '', it.name)); mid.appendChild(qel('div', 'tb', it.description || gains(it) || ''));
    top.appendChild(cell); top.appendChild(mid); top.appendChild(qel('span', 'n', 'x' + sel.qty));
    card.appendChild(top);
    var held = it.slot === 'weapon', inHand = held && heldId() === sel.item && World.stackInUse && World.stackInUse(me, sel.item) === sel;   // (held things are never worn: the belt says what is in hand)
    var d = World.durOf ? World.durOf(content, sel) : null, max = World.stackMaxOf ? World.stackMaxOf(content, sel.item) : 99;
    card.appendChild(qel('div', 'meta', [it.type || 'item', it.description ? gains(it) : '', inHand && !(d && d.left <= 0) ? 'in hand' : !held && equipped ? 'worn' : '',
      d ? (d.left <= 0 ? 'broken' : 'durability ' + d.left + '/' + d.max) : max > 1 ? 'stacks to ' + max : ''].filter(Boolean).join(' / ')));
    if (eats || (it.slot && !held)) {                           // food and the like: Use; clothes: Wear / Take off
      var ub = qel('button', '', eats ? 'Use' : equipped ? 'Take off' : 'Wear');
      ub.onclick = function () { useItem(sel.item, { w: 'bag', s: sel.s }); }; btns.appendChild(ub);
    }
    if (d) {                                                    // mend it to full: what it takes, and where
      var ri = World.repairInfo(content, mapOf(), me, lookup(), sel), rb = qel('button', '', 'Repair');
      rb.disabled = !ri.ok;
      rb.title = 'Repair: back to ' + d.max + '/' + d.max + (ri.cost.length ? '\nTakes ' + ri.cost.map(function (g) { return g.qty + ' ' + itemName(g.item).toLowerCase() + ' (' + g.have + ')'; }).join(', ') : '') + (ri.ok ? '' : '\n' + ri.reason);
      rb.onclick = function () { send({ type: 'inv', op: 'repair', s: sel.s }); }; btns.appendChild(rb);
    }
    var sv = World.salvageInfo ? World.salvageInfo(content, sel) : { ok: false };
    if (sv.ok) {                                                // take it apart: some of what it was made of comes back
      var sb = qel('button', '', 'Salvage');
      sb.title = 'Salvage: take it apart (it is gone)\nGives ' + sv.gives.map(function (g) { return g.qty + ' ' + itemName(g.item).toLowerCase(); }).join(', ');
      sb.onclick = function () { invSel = -1; send({ type: 'inv', op: 'salvage', s: sel.s }); }; btns.appendChild(sb);
    }
    if (storage && !storage.takeOnly) { var pb = qel('button', '', 'Store'); pb.onclick = function () { invMove('bag', sel.s, 'box'); }; btns.appendChild(pb); }
    var db = qel('button', 'danger', 'Drop'); db.title = 'Drop: the whole stack, into a loot bag at your feet';
    db.onclick = function () { invSel = -1; send({ type: 'inv', op: 'drop', s: sel.s, qty: sel.qty }); }; btns.appendChild(db);
    card.appendChild(btns);
    return card;
  }
  /** What a recipe that cannot be made is short of: "missing 3 plant fiber" when one thing is short, else "missing ingredients". */
  function lackText(x) {
    var short = x.ins.filter(function (q) { return q.have < q.qty; }), g = short[0];
    if (short.length > 1) return 'missing ingredients';
    return g ? 'missing ' + (g.qty - g.have) + ' ' + itemName(g.item).toLowerCase() : (x.why || 'cannot be made now');
  }
  /**
   * Recipes, the same way in every window: a row of filters, the list (a row each: what it makes, "ready" or what is
   * missing), the picked one on a page of the notebook (what it takes and how much of each you have), and its buttons.
   * o = {key (to remember the list's scroll), recs: [{id, name, cat, ins: [{item, qty, have}], outs: [{item, qty}],
   * can, secs, why}], st: {sel, enough, cat} (the caller keeps it), cur (the one shown when none was picked),
   * enoughLabel, none (text with no recipes), action(wrap, sel) (puts the buttons in)}. Returns {bar, list, paper, act}.
   */
  function recipeBook(o) {
    var st = o.st, recs = o.recs, cats = [];
    recs.forEach(function (x) { if (x.cat && cats.indexOf(x.cat) < 0) cats.push(x.cat); });
    if (st.cat && cats.indexOf(st.cat) < 0) st.cat = '';
    var shown = recs.filter(function (x) { return (!st.enough || x.can) && (!st.cat || x.cat === st.cat); });
    function byId(id) { return id ? recs.filter(function (x) { return x.id === id; })[0] : null; }
    var sel = byId(st.sel) || byId(o.cur) || shown[0] || recs[0] || null;
    var bar = qel('div', 'wbar');
    if (cats.length > 1) [''].concat(cats.slice(0, 4)).forEach(function (c) {
      var b = qel('button', st.cat === c ? 'on' : '', c || 'All'); b.type = 'button';
      b.onclick = function () { st.cat = c; listTop[o.key] = 0; bag(); };
      bar.appendChild(b);
    });
    bar.appendChild(qel('span', 'sp'));
    bar.appendChild(UI.check(o.enoughLabel, st.enough, function (v) { st.enough = v; listTop[o.key] = 0; bag(); }));
    var list = qel('div', 'k kinset rlist');
    if (!shown.length) list.appendChild(qel('div', 'rnone', recs.length ? 'Nothing here that you have the things for.' : o.none));
    shown.forEach(function (x) {
      var row = qel('div', 'rrow' + (sel && x.id === sel.id ? ' sel' : '') + (x.can ? '' : ' cant')), cell = qel('div', 'icell'), tx = qel('div');
      var oit = content.items[(x.outs[0] || {}).item], gain = oit ? gains(oit) : '';
      cell.appendChild(icon({ kind: 'item', id: (x.outs[0] || {}).item }));
      tx.appendChild(qel('b', '', x.name)); tx.appendChild(qel('span', '', x.can ? 'ready' + (gain ? ', ' + gain : '') : lackText(x)));
      row.appendChild(cell); row.appendChild(tx);
      row.onclick = function () { st.sel = x.id; bag(); };
      list.appendChild(row);
    });
    list.onscroll = function () { listTop[o.key] = list.scrollTop; };
    setTimeout(function () { list.scrollTop = listTop[o.key] || 0; }, 0);    // (the list is rebuilt with the window: it stays where it was)
    var paper = qel('div', 'kpaper'), act = qel('div', 'ract');
    if (!sel) paper.appendChild(qel('div', 'tb', recs.length ? 'Pick a recipe from the list.' : ''));
    else {
      var out = sel.outs[0] || { item: '', qty: 1 }, it0 = content.items[out.item] || { name: sel.name };
      var hd = qel('div', 'phd'), hc = qel('div', 'icell'), ht = qel('div'), sub = qel('div', 'sub');
      hc.appendChild(icon({ kind: 'item', id: out.item }));
      ht.appendChild(qel('b', '', sel.name + (out.qty > 1 ? ' x' + out.qty : '')));
      sub.appendChild(qel('span', '', gains(it0) || it0.type || '')); sub.appendChild(qel('span', '', sel.secs > 0 ? sel.secs + ' sec' : 'instant'));
      ht.appendChild(sub); hd.appendChild(hc); hd.appendChild(ht); paper.appendChild(hd);
      paper.appendChild(qel('div', 'rule'));
      paper.appendChild(qel('div', 'lbl', 'Needs'));
      sel.ins.forEach(function (g) {
        var it = content.items[g.item] || { name: g.item }, ok = g.have >= g.qty, row = qel('div', 'need' + (ok ? '' : ' lack'));
        row.appendChild(itemPicEl(it, 16)); row.appendChild(qel('span', '', it.name)); row.appendChild(qel('span', 'cnt', g.have + '/' + g.qty));
        row.appendChild(UI.icon(ok ? 'check' : 'x', ok ? UI.COLOR.paperGreen : UI.COLOR.paperRed));
        paper.appendChild(row);
      });
      if (it0.description) paper.appendChild(qel('div', 'tb say', it0.description));
      if (sel.why) paper.appendChild(qel('div', 'tb why', sel.why));
      o.action(act, sel);
    }
    return { bar: bar, list: list, paper: paper, act: act };
  }
  /** What you are making by hand, under the recipe list: its name, how far along, Stop. */
  // ---- countdowns. live(el, fn): fn runs four times a second while el is on the page (the windows are only redrawn
  // when an answer changes them, which is not every second).
  var liveList = [];
  function live(el, fn) { liveList.push({ el: el, fn: fn }); }
  setInterval(function () { liveList = liveList.filter(function (x) { if (!x.el.isConnected) return false; x.fn(); return true; }); }, 250);
  /** A countdown that goes down one second a second: it follows its own clock and drifts towards the referee's figure
   *  (leftMs) by at most 0.1 s per call (4 calls a second), so a small disagreement never makes it skip a number. A
   *  big one (a new batch, a stop) is taken at once. */
  var smoothEnds = {};
  function smoothLeft(key, leftMs) {
    var now = performance.now(), e = smoothEnds[key], want = now + leftMs;
    if (e == null || Math.abs(want - e) > 3000) e = want;
    else e += Math.max(-100, Math.min(100, want - e));
    smoothEnds[key] = e;
    return Math.max(0, e - now);
  }
  /** "8s", "1:05": time left, rounded up to the second. */
  function leftText(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + s % 60 : s + 's'; }
  /** How long what you are making by hand has to go, every piece still to make included ("12s left"). */
  function craftLeftText() {
    var j = me && me.craft, f = craftFrac(); if (!j || !f) return '';
    // (counted on across the end of a piece, not stopped there until the referee says the next one has begun)
    var need = Number(j.need) || 0, work = (Number(j.ms) || 0) + (j.on && f.on ? Math.max(0, serverNow() - j.at) : 0);
    return need ? leftText(smoothLeft('craft:' + j.id, ((Number(j.qty) || 1) - (Number(j.made) || 0)) * need - work)) + ' left' : '';
  }
  function makingStrip(job, jr) {
    var f = craftFrac() || { p: 0, on: false }, box = qel('div', 'k kplate making'), t = qel('div');
    box.style.padding = '3rem 4rem';
    t.appendChild(qel('b', '', (jr && jr.name) || job.id)); if (job.qty > 1) t.appendChild(document.createTextNode(' ' + (job.made + 1) + '/' + job.qty));
    box.appendChild(t);
    var stop = qel('button', '', 'Stop'); stop.title = 'Stop and take back what was not used';
    stop.onclick = function () { send({ type: 'craft', cancel: true }); };
    box.appendChild(stop);
    makingBar = UI.bar('stamina', { cls: 'tiny', value: f.p });
    var left = qel('span', '', craftLeftText());
    if (f.on) { var prow = qel('div', 'prow'); prow.appendChild(makingBar); prow.appendChild(left); box.appendChild(prow); live(left, function () { left.textContent = craftLeftText(); var g = craftFrac(); if (g) UI.setBar(makingBar, g.p); }); } else box.appendChild(qel('div', 'bad', 'Waiting: go back to the ' + World.stationName(content, jr && jr.station)));
    return box;
  }
  // ---- your own window: who you are | what you carry | what you can make with your hands. A worn slot is a cell
  // beside the figure (DOLL_SLOTS: where each sits in the tray, in art pixels): drag something from the backpack onto
  // it ('use', with `slot` for the accessory places), drag it back or double-click it to take it off. What may go
  // where is the item's `slot`; the referee has the last word.
  var DOLL_SLOTS = [
    { key: 'helm', x: 6, y: 4, ghost: 'helm' }, { key: 'armor', x: 6, y: 44, ghost: 'shield' }, { key: 'pants', x: 6, y: 84, ghost: 'pants' }, { key: 'feet', x: 6, y: 124, ghost: 'boot' },
    { key: 'face', x: 124, y: 4, ghost: 'mask' }, { key: 'back', x: 124, y: 44, ghost: 'pack' }, { key: 'gloves', x: 124, y: 84, ghost: 'glove' }, { key: 'belt', x: 124, y: 124, ghost: 'belt' },
    { key: 'accessory1', x: 47, y: 124, ghost: 'ring' }, { key: 'accessory2', x: 83, y: 124, ghost: 'ring' }];   // (owner, 27 Nov 2026: the two accessories under the figure)
  var SLOT_NAMES = { helm: 'Head', face: 'Face', armor: 'Chest', pants: 'Pants', feet: 'Feet', gloves: 'Gloves', back: 'Back', belt: 'Belt', accessory: 'Acc' };
  /** While something is dragged, the worn place(s) it can go to pulse (owner): `on` = the item, null = the drag ended. */
  function dollHint(it) {
    var kind = it && it.slot;
    Array.prototype.forEach.call(document.querySelectorAll('.dslot'), function (c) { c.classList.toggle('fits', !!kind && c.dataset.kind === kind); });
  }
  /** You, as you look now (body, hair, what you wear), on a small canvas. */
  // A figure that is alive off the map (owner, 27 Nov 2026): the one in the inventory window, the character screen's
  // preview and an NPC's portrait in its dialogue. liveFigure redraws `cv` every frame for as long as it is on the page
  // (o.alive: another test), with the same pose (Render.pose) and the same drawing (Render.figureOn) as the map: it
  // breathes and a woman's chest moves. o.turn = {facing, at}: it also turns to the side of it the cursor is on (a
  // little room in the middle, so it does not flicker), turning round being its jolt. The canvas is as wide as the
  // figure is drawn (32 = 1:1) and a row or two taller than 1.5 x that: breathing lifts the head.
  var bustLook = { facing: 'E', at: -1e9 }, mouseX = null;
  document.addEventListener('mousemove', function (e) { mouseX = e.clientX; });
  function liveFigure(cv, layersOf, o) {
    o = o || {};
    var born = performance.now(), was = false;
    function paint() {
      var g = cv.getContext('2d'), now = performance.now(), T = cv.width, st = o.turn; g.imageSmoothingEnabled = false; g.clearRect(0, 0, cv.width, cv.height);
      if (st && mouseX != null && cv.isConnected) {
        var r = cv.getBoundingClientRect(), mid = r.left + r.width / 2, room = r.width * 0.12;
        var want = mouseX < mid - room ? 'W' : mouseX > mid + room ? 'E' : st.facing;
        if (want !== st.facing) { st.facing = want; st.at = now; }
      }
      var layers = layersOf(); if (!layers || !layers.length) return;
      var a = { layers: layers, facing: st ? st.facing : 'E', idle: true, ph: o.ph || 0, x: 0, y: 0, jolt: st ? now - st.at : undefined };
      Render.pose(a, now, content.config);
      Render.figureOn(g, a, 0, cv.height - T, T);
    }
    (function tick() {
      var on = o.alive ? o.alive() : cv.isConnected;
      if (on) was = true; else if (was || performance.now() - born > 3000) return;   // (taken off the page: its window was shut or drawn again)
      if (on) paint();
      requestAnimationFrame(tick);
    })();
  }
  /** You, as you look now (body, hair, what you wear), in the inventory window. */
  function bustLive(cv) {
    liveFigure(cv, function () { return (playerLayers(me) || []).filter(function (l) { return l.slot !== 'weapon' && !l.icon; }); },   // (what is in hand is not part of the figure here: the belt shows it)
      { turn: bustLook, ph: phaseOf(me.id) });
  }
  function invWindow(box) {
    var cols = qel('div', 'wcols');
    // who you are
    var who = qel('div', 'wcol'), doll = qel('div', 'k kinset doll'), bust = document.createElement('canvas');
    who.style.width = '160rem';
    who.appendChild(UI.head(me.name || 'Survivor', ''));
    bust.className = 'bust'; bust.width = 32; bust.height = 49; doll.appendChild(bust); bustLive(bust);   // (a row of room above: breathing lifts the head a pixel)
    DOLL_SLOTS.forEach(function (q) {
      var kind = q.key.replace(/\d+$/, ''), label = SLOT_NAMES[kind] || kind, id = (me.equipment || {})[q.key];
      var c = invCell(id && content.items[id] ? id : '', 1, 'worn', q.key);
      c.classList.remove('equipped'); c.classList.add('dslot'); c.dataset.kind = kind; c.style.left = q.x + 'rem'; c.style.top = q.y + 'rem';
      if (!c.firstChild) { c.title = label + ': drag something you can wear here'; if (q.ghost) c.appendChild(UI.icon(q.ghost, UI.COLOR.ghost, 'ghost')); }
      else c.ondblclick = function () { useItem(id); };                    // take it off (back into the backpack)
      if (q.lab !== 'none') { var lb = qel('span', 'lab' + (q.lab === 'up' ? ' up' : ''), label); if (q.lab === 'wide') { lb.style.left = '-2rem'; lb.style.width = '64rem'; } c.appendChild(lb); }
      invTarget(c, function (d) { var it = content.items[d.item]; return (d.from === 'bag' || d.from === 'worn') && !!it && it.slot === kind; },
        function (d) { if ((me.equipment || {})[q.key] !== d.item || d.from === 'bag') { var a = { type: 'use', item: d.item, slot: q.key }; if (d.from === 'bag') a.from = { w: 'bag', s: d.slot }; send(a); } });   // (out of the backpack: that one goes on)
      doll.appendChild(c);
    });
    who.appendChild(doll);
    // under the figure: the level and how far to the next one (owner)
    var lv = qel('div', 'dlevel'), span = me.xpNext ? me.xpNext - (me.xpThis || 0) : 0;
    lv.appendChild(qel('b', '', 'Lv ' + me.level));
    var xb = UI.bar('xp', { cls: 'tiny', value: span ? (me.xp - (me.xpThis || 0)) / span : 1 }); xb.setAttribute('data-tip', me.xpNext ? 'XP — ' + me.xp + ' / ' + me.xpNext + ' (' + (me.xpNext - me.xp) + ' to level ' + (me.level + 1) + ')' : 'XP — the highest level');
    lv.appendChild(xb);
    who.appendChild(lv);
    var stats = qel('div', 'k kplate stats');
    function stat(ic, label, val, cls) { var r = qel('div', 'stat'); r.appendChild(UI.icon(ic, UI.COLOR.grey)); r.appendChild(qel('span', '', label)); r.appendChild(qel('b', cls || '', val)); stats.appendChild(r); }
    if (content.classes[me['class']] && Object.keys(content.classes).length > 1) stat('marker', 'Class', content.classes[me['class']].name);
    stat('sword', 'Attack', me.atk); stat('shield', 'Defence', me.def); stat('coin', 'Gold', me.gold, 'gold');
    stats.classList.add('tail'); who.appendChild(stats);
    var food = me.hunger == null ? 100 : me.hunger, water = me.thirst == null ? 100 : me.thirst, mb = qel('div', 'mebars');
    function tipped(b, t) { b.setAttribute('data-tip', t); return b; }      // (hover: the numbers)
    mb.appendChild(tipped(UI.bar('hp', { cls: 'hp', value: me.hp / me.maxHp }), 'Health — ' + Math.max(0, me.hp) + ' / ' + me.maxHp));
    mb.appendChild(tipped(UI.bar('thirst', { cls: 'tiny', value: water / 100 }), 'Water — ' + Math.round(water) + '%'));
    mb.appendChild(tipped(UI.bar('hunger', { cls: 'tiny', value: food / 100 }), 'Food — ' + Math.round(food) + '%'));
    mb.appendChild(qel('span', '', 'Water')); mb.appendChild(qel('span', '', 'Food'));
    who.appendChild(mb);
    var conds = qel('div', 'dconds'), cl = conditions();                       // (what ails you, where the HP line was)
    cl.forEach(function (x) { var ch = qel('span', 'cond'); ch.appendChild(UI.icon(x.icon, x.color)); ch.setAttribute('data-tip', x.tip); conds.appendChild(ch); });
    if (!cl.length) conds.appendChild(qel('span', 'dim', 'No conditions'));
    who.appendChild(conds);
    cols.appendChild(who);
    // what you carry
    var mine = bagColumn(), card = itemCard(); card.classList.add('fill'); mine.appendChild(card); cols.appendChild(mine);
    // what you can make with your hands
    var job = me.craft, jr = job && content.recipes && content.recipes[job.id];
    var all = World.recipesFor(content, mapOf(), me, lookup()), near = all.filter(function (r) { return r.station && r.here; });
    var recs = all.filter(function (r) { return !r.station || r.here; }).map(function (r) {
      return { id: r.id, name: r.name, cat: r.category || '', ins: r.inputs, outs: r.outputs, can: r.can, secs: r.timeS, why: !r.can && r.reason && !/^Not enough/.test(r.reason) ? r.reason : '' };
    });
    var book = recipeBook({ key: 'hand', recs: recs, st: handSt, cur: job && job.id, enoughLabel: 'Can craft', none: 'You know nothing that can be made without a workbench.', action: function (wrap, sel) {
      if (job) { wrap.className = 'ract one'; wrap.appendChild(qel('div', 'wnote', 'One thing at a time: what you are making is under the list.')); return; }
      // how many: - and + (or the wheel), from 1 up to what the materials in the bag allow
      var most = !sel.can ? 0 : Math.min.apply(null, [World.CRAFT_MAX || 20].concat(sel.ins.map(function (g) { return g.qty > 0 ? Math.floor(g.have / g.qty) : Infinity; })));
      var step = UI.stepper(Math.max(1, Math.min(most || 1, craftQty[sel.id] || 1)), most, null), go = qel('button', 'primary big', 'Craft');
      go.insertBefore(UI.icon('hammer', UI.COLOR.ink), go.firstChild);
      go.disabled = most < 1; go.title = most < 1 ? (sel.why || 'You do not have what it takes') : '';
      go.onclick = function () { craftQty[sel.id] = step.get(); send({ type: 'craft', recipe: sel.id, qty: step.get() }); };
      wrap.appendChild(step); wrap.appendChild(step.maxButton()); wrap.appendChild(go);   // - n + | Max | Craft / Cook
    } });
    var make = qel('div', 'wcol'), two = qel('div', 'wcols'), lcol = qel('div', 'wcol'), pcol = qel('div', 'wcol');
    make.style.width = '308rem'; two.style.gap = '6rem'; lcol.style.width = '150rem'; pcol.style.width = '152rem';
    make.appendChild(UI.head('Crafting', near.length ? World.stationName(content, near[0].station) : 'Hands only')); make.appendChild(book.bar);
    book.list.classList.add('fill'); lcol.appendChild(book.list);
    makingBar = null;
    if (job) lcol.appendChild(makingStrip(job, jr));
    if (UI.FLAGS.queue) { var qu = qel('div', 'queue'); qu.appendChild(qel('span', '', 'Queue')); var qg = qel('div', 'igrid'); for (var i = 0; i < 5; i++) qg.appendChild(qel('div', 'icell')); qu.appendChild(qg); lcol.appendChild(qu); }   // (off: one thing is made at a time)
    book.paper.classList.add('fill'); pcol.appendChild(book.paper); pcol.appendChild(book.act);
    two.classList.add('fill'); two.appendChild(lcol); two.appendChild(pcol); make.appendChild(two); cols.appendChild(make);
    box.appendChild(cols);
    box.appendChild(UI.hints([['Drag', 'move'], ['Shift', 'half'], ['Ctrl', 'one'], ['2x click', 'use / wear'], ['Drag to belt', 'keep at hand']]));
  }
  // ---- a container is open: what you carry | what it holds
  /** R, or the Take all button: everything in the open container into the bag (a cooker: everything cooked). */
  var tookAll = { key: '', at: 0, n: 0 };                          // (the container just emptied with Take all: its answer must not reopen it)
  // A container (chest, carcass, loot bag) shuts at once: grab and go. A cooker stays open: you are working at it.
  function takeAllOpen() {
    if (!storage) return;
    if (storage.cook) {
      var ck = storage.cook, cells = ck.cells || [1, 1, 1], lo = cells[0] + cells[1], inv = Array.isArray(storage.inv) ? storage.inv : [];
      inv.filter(function (st) { return st.s >= lo && st.s < lo + cells[2]; }).forEach(function (st) { invMove('box', st.s, 'bag'); });
      return;
    }
    tookAll = { key: storage.key, at: performance.now(), n: 1 };   // n = the answers still to come (its answer must not reopen it)
    send({ type: 'inv', op: 'takeall', key: storage.key });
    closeStore();
  }
  function storeWindow(box) {
    var inv = Array.isArray(storage.inv) ? storage.inv : Object.keys(storage.inv || {}).map(function (id, i) { return { item: id, qty: storage.inv[id], s: i }; });   // (an older referee sends {item: qty})
    var cols = qel('div', 'wcols'), mine = bagColumn(), theirs = qel('div', 'wcol'), bar = qel('div', 'wbar'), tray = qel('div', 'k kinset tray');
    mine.appendChild(itemCard()); cols.appendChild(mine);
    theirs.style.minWidth = '190rem';
    theirs.appendChild(UI.head(storage.name, storage.slots ? inv.length + '/' + storage.slots : ''));
    bar.appendChild(qel('span', 'sp'));
    var all = qel('button', '', 'Take all'); all.title = 'Everything in it, into your backpack'; all.disabled = !inv.length;
    all.onclick = takeAllOpen; all.title += ' (R)';
    bar.appendChild(all); theirs.appendChild(bar);
    tray.appendChild(invGrid(inv, 'box', storage.slots || INV_COLS * 2, BAG_COLS)); theirs.appendChild(tray);
    cols.appendChild(theirs); box.appendChild(cols);
    box.appendChild(UI.hints(storage.takeOnly ? [['R', 'take all'], ['Drag', 'take'], ['Shift+click', 'take the stack'], ['Shift', 'half'], ['Ctrl', 'one']]
      : [['R', 'take all'], ['Drag', 'move'], ['Shift+click', 'send across'], ['Shift', 'half'], ['Ctrl', 'one'], ['2x click', 'use / equip']]));
  }
  // ---- a cooker is open (a campfire, a furnace): what you carry | the fire: raw > fire > cooked, its fuel, its
  // switch | its recipes. Cook is the 'store' op 'load', the switch 'light' / 'douse', every drag an 'inv' action;
  // what the fire is making and how far along it is comes with each answer (storage.cook: cells, rid, prog / need,
  // left, fuel, recipes). A referee that sends no `cells` has the old three cells, and no recipe list.
  /** The picture of the thing whose window is open (lit, when it has a picture for that), or null. */
  function stationPic(key, lit) {
    var e = (mapOf().entities || []).filter(function (x) { return x.key === key; })[0], o = e && content.objects[e.ref];
    var img = o && Assets.get((lit && o.spriteStates && o.spriteStates.burning) || o.sprite);
    if (!img || !img.width) return null;
    var fr = Number(o.frames) || 1, fw = fr > 1 && img.width % fr === 0 && img.width / fr >= 16 ? img.width / fr : img.width, cv = document.createElement('canvas');   // (a strip of frames: the first one)
    cv.width = fw; cv.height = img.height; cv.getContext('2d').drawImage(img, 0, 0, fw, img.height, 0, 0, fw, img.height);
    return cv;
  }
  function cookWindow(box) {
    var ck = storage.cook, cells = ck.cells || [1, 1, 1], inv = Array.isArray(storage.inv) ? storage.inv : [], key = storage.key;
    var los = [0, cells[0], cells[0] + cells[1]];             // the first cell of each run: raw, fuel, cooked
    function have(id) {                                       // in the bag, and already in its raw cells
      var n = 0; (me.inventory || []).forEach(function (st) { if (st.item === id) n += st.qty; });
      inv.forEach(function (st) { if (st.item === id && st.s < cells[0]) n += st.qty; });
      return n;
    }
    function run(z, across) { var tray = qel('div', 'tray'); tray.appendChild(invGrid(inv, 'box', cells[z], Math.min(cells[z], across), los[z])); return tray; }
    var cols = qel('div', 'wcols');
    // what you carry
    var mine = bagColumn(), tip = qel('div', 'k kplate tipbox');
    tip.appendChild(qel('b', '', 'Tip')); tip.appendChild(qel('div', '', 'Nothing cooks by itself: pick a recipe and press Cook. Shift+click sends a stack straight to the fire.'));
    mine.appendChild(tip); cols.appendChild(mine);
    // the fire
    var cur = ck.rid && content.recipes && content.recipes[ck.rid], pct = ck.need ? Math.max(0, Math.min(1, ck.prog / ck.need)) : 0;
    var mid = qel('div', 'wcol'), stn = qel('div', 'k kinset station'), flow = qel('div', 'flow'), fmid = qel('div', 'mid');
    mid.style.width = '240rem';
    mid.appendChild(UI.head(storage.name, ck.lit ? 'Burning' : 'Not lit'));
    var cbar = qel('div', 'wbar');                            // (its buttons in a bar under the title, as a container has them)
    cbar.appendChild(qel('span', 'sp')); mid.appendChild(cbar);
    function side(label, z) { var s = qel('div', 'side'); s.appendChild(qel('span', '', label)); s.appendChild(run(z, 2)); return s; }   // (two across: the cells are 30 wide)
    var a1 = qel('div', 'karrow'), a2 = qel('div', 'karrow'), f1 = qel('i'), f2 = qel('i'), fire = qel('div', 'fire' + (ck.lit ? '' : ' out'));
    f1.style.clipPath = 'inset(0 ' + (cur && ck.lit ? 0 : 100) + '% 0 0)'; f2.style.clipPath = 'inset(0 ' + (100 - 100 * pct).toFixed(0) + '% 0 0)';
    a1.appendChild(f1); a2.appendChild(f2);
    fire.appendChild(stationPic(key, ck.lit) || UI.icon('flame', '#c1752d'));
    fmid.appendChild(a1); fmid.appendChild(fire); fmid.appendChild(a2);
    flow.appendChild(side('Raw', 0)); flow.appendChild(fmid); flow.appendChild(side('Cooked', 2));
    stn.appendChild(flow);
    var now = qel('div', 'now'), jb = qel('div', 'job'), rt = qel('div', 'r');
    now.appendChild(qel('span', '', cur && ck.left > 1 ? (ck.left - 1) + ' more to go' : ''));
    if (cur) {
      var jname = qel('b', ''), jbar = UI.bar('fuel', { cls: 'tiny', value: pct });
      jb.appendChild(jname); jb.appendChild(jbar);
      var cookTick = function () {                           // counted on from the referee's last answer, so it goes down a second a second
        var gone = ck.lit ? performance.now() - (storage._at || performance.now()) : 0, prog = Math.min(ck.need || 0, (ck.prog || 0) + gone);
        jname.textContent = cur.name + (ck.lit && ck.need ? '  ' + leftText(smoothLeft('cook:' + storage.key + ':' + ck.rid, ck.need - prog)) : '');
        if (ck.need) { UI.setBar(jbar, prog / ck.need); f2.style.clipPath = 'inset(0 ' + (100 - 100 * prog / ck.need).toFixed(0) + '% 0 0)'; }
      };
      cookTick(); live(jname, cookTick);
      jb.title = cur.name + (ck.lit ? ': ' + Math.round(pct * 100) + '%' : ': the fire is not lit');
    } else jb.appendChild(qel('span', '', 'Nothing is cooking'));
    now.appendChild(jb);
    var done = inv.filter(function (st) { return st.s >= los[2] && st.s < los[2] + cells[2]; });
    if (cur) { var stopB = qel('button', '', 'Cancel'); stopB.title = 'Stop cooking this (what is in the cells stays there)'; stopB.onclick = function () { send({ type: 'store', key: key, op: 'cancel' }); }; cbar.appendChild(stopB); }
    var take = qel('button', '', 'Take all'); take.title = 'Everything cooked, into your backpack'; take.disabled = !done.length;
    take.onclick = takeAllOpen; take.title += ' (R)';
    cbar.appendChild(take);
    now.appendChild(rt); stn.appendChild(now); mid.appendChild(stn);
    // its fuel, and the switch
    var fuel = qel('div', 'k kplate fuel'), ft = qel('div', 'ft'), fb = qel('b'), fr = qel('div', 'fr'), ms = ck.fuel != null ? ck.fuel : ck.burn;
    fb.appendChild(UI.icon('flame', '#c1752d')); fb.appendChild(document.createTextNode('Fuel')); ft.appendChild(fb);
    fuel.appendChild(ft);
    var burn = qel('span', '');
    var burnTick = function () { var left = ms - (ck.lit ? performance.now() - (storage._at || performance.now()) : 0); if (ck.lit) left = smoothLeft('fuel:' + storage.key, left); burn.textContent = left > 0 ? 'Burns for ' + clock(left) : ms > 0 ? 'Burns for 00:00' : 'No fuel'; };
    burnTick(); if (ck.lit) live(burn, burnTick);
    fr.appendChild(run(1, 4)); fr.appendChild(burn);
    var sw = qel('div', 'sw' + (ck.lit ? ' on' : '')), tg = qel('button', 'bare ktoggle' + (ck.lit ? ' on' : ''));
    tg.title = ck.lit ? 'Put the fire out' : 'Light the fire (it needs fuel)';
    tg.onclick = function () { send({ type: 'store', key: key, op: ck.lit ? 'douse' : 'light' }); };
    sw.appendChild(tg); sw.appendChild(qel('span', '', ck.lit ? 'Lit' : 'Out')); fr.appendChild(sw);
    fuel.appendChild(fr); mid.appendChild(fuel);
    if (UI.FLAGS.queue) { var qu = qel('div', 'k kplate fuel queue'); qu.appendChild(qel('span', '', 'Queue')); var qg = qel('div', 'igrid'); for (var i = 0; i < 5; i++) qg.appendChild(qel('div', 'icell')); qu.appendChild(qg); mid.appendChild(qu); }   // (off: the fire has one job at a time)
    cols.appendChild(mid);
    // its recipes
    var recs = (ck.recipes || []).map(function (id) { return content.recipes && content.recipes[id]; }).filter(Boolean).map(function (r) {
      var ins = World.list(r.inputs).map(function (g) { return { item: g.item, qty: g.qty, have: have(g.item) }; });
      return { id: r.id, name: r.name, cat: r.category || '', ins: ins, outs: World.list(r.outputs), can: ins.every(function (g) { return g.have >= g.qty; }), secs: r.timeS || World.COOK_S || 5 };
    });
    var book = recipeBook({ key: 'cook', recs: recs, st: cookSt, cur: ck.rid, enoughLabel: 'Can cook', none: 'Nothing you know can be made here yet.', action: function (wrap, sel) {
      var most = !sel.can ? 0 : Math.min.apply(null, [99].concat(sel.ins.map(function (g) { return g.qty > 0 ? Math.floor(g.have / g.qty) : Infinity; })));
      var step = UI.stepper(Math.max(1, Math.min(most || 1, cookQty[sel.id] || 1)), most, function (v) { cookQty[sel.id] = v; }), go = qel('button', 'primary big', 'Cook');
      go.insertBefore(UI.icon('flame', UI.COLOR.ink), go.firstChild);
      go.disabled = !sel.can;
      go.title = sel.can ? 'Cook: as many as the number says (hold Shift: as many as you have the things for). What it takes goes from your backpack into the raw cells; with fuel in it, the fire is lit.' : 'You do not have what it takes';
      go.onclick = function (e) { send({ type: 'store', key: key, op: 'load', recipe: sel.id, qty: e.shiftKey ? 99 : step.get() }); };
      wrap.appendChild(step); wrap.appendChild(step.maxButton()); wrap.appendChild(go);   // - n + | Max | Craft / Cook
    } });
    var right = qel('div', 'wcol'); right.style.width = '228rem';
    right.appendChild(UI.head('Recipes')); right.appendChild(book.bar);
    book.list.classList.add('fill'); right.appendChild(book.list);
    book.paper.classList.add('fill'); right.appendChild(book.paper); right.appendChild(book.act);
    cols.appendChild(right);
    box.appendChild(cols);
    box.appendChild(UI.hints([['R', 'take all cooked'], ['Drag', 'move'], ['Shift+click', 'send across'], ['Shift', 'half'], ['Ctrl', 'one']]));
  }
  /** The window's close button (the red X) sits inside the window, at the right end of the top-right column's title plate,
   *  which shrinks to make room: the same as the title bar of every other window. (Moved there each time the window is built.) */
  var bagX = null;
  function closeInPlate(box) {
    bagX = bagX || $('bag-close');
    var cols = box.querySelector('.wcols'), last = cols && cols.lastElementChild, head = last && last.querySelector('.khead');
    if (!head) return;
    var row = document.createElement('div'); row.className = 'hrow';
    head.parentNode.insertBefore(row, head); row.appendChild(head); row.appendChild(bagX);
  }
  function bag() {
    if (invDrag || invPress) { invDirty = true; return; }    // never redraw under a drag (or a press about to become one): the thing held would vanish
    // …nor when nothing it shows has changed: answers arrive several times a second
    var sig = JSON.stringify([me.inventory, me.belt, me.held, me.equipment, me.atk, me.def, me.gold, me.abilities, me.skills, storage && [storage.key, storage.inv, storage.slots, storage.cook, storage.takeOnly], cookSt, handSt, craftQty, invSel, bagFilter,
      me.craft && [me.craft.id, me.craft.qty, me.craft.made, !!(craftFrac() || {}).on], me.level, me.hp, me.maxHp, Math.round(me.hunger == null ? 100 : me.hunger), Math.round(me.thirst == null ? 100 : me.thirst), me.hair, me.hairColor, me.beard, me.beardColor]);
    var box = $('bag-items');
    if (sig === invSig && box.firstChild) return;
    invSig = sig; box.innerHTML = '';
    var el = qel;
    $('bag-title').textContent = storage ? storage.name : 'Inventory';
    $('bag').classList.toggle('tall', !storage || !!storage.cook);   // your own window and a cooker's use the whole height (a chest's stays compact)
    if (storage && storage.cook) cookWindow(box);
    else if (storage) storeWindow(box);
    else invWindow(box);
    closeInPlate(box);
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
    if (it.hunger) bits.push((it.hunger > 0 ? '+' : '') + it.hunger + ' hunger');
    if (it.thirst) bits.push((it.thirst > 0 ? '+' : '') + it.thirst + ' thirst');
    if (!bits.length) bits.push(it.type || 'item');
    return bits.join(', ');
  }
  $('bag-close').onclick = toggleBag;
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

  /** How high the ground at (x, y) is drawn, in canvas pixels (the camera's height, and a scene's: Scene.start's `lift`). */
  function sceneLift(x, y) {
    var map = renderer && renderer.map, T = content.config.tile_size || 32;
    return map && Render.liftAt ? Render.liftAt(map, clamp(x, 0, map.width - 1), clamp(y, 0, map.height - 1), T) : 0;
  }
  // ---- your own hearing (docs/STEALTH.md, stage 4; owner, 27 Nov 2026: moving creatures, by how loud their kind is).
  // A creature out of your sight that MOVED within the last HEAR_MS is heard from Monsters `noise` tiles (none said =
  // Config monster_noise, 5; 0 = never), less what the walls between muffle (World.soundCarries, the same question the
  // monsters ask about you). What is heard is drawn as an outline where it is (Render: `sensed`), nothing more — not
  // what it is, not its health. Worked out here: the page already knows where the map's creatures are. Config
  // hearing_sense = off: none of it.
  var HEAR_MS = 1200, HEAR_EVERY = 150, heardMove = {}, heardIds = {}, heardAt = 0, heardMap = '';
  function hearing(now) {
    if (!me || !sight.vis || String(content.config.hearing_sense || 'on').toLowerCase() === 'off') return null;
    if (heardMap !== me.map) { heardMap = me.map; heardMove = {}; heardIds = {}; }
    var live = {}, any = false;
    view.monsters.forEach(function (m) {
      live[m.id] = 1;
      var rec = heardMove[m.id];
      if (!rec) heardMove[m.id] = { x: m.x, y: m.y, t: -1e9 };          // (first seen standing there: that is no movement)
      else if (rec.x !== m.x || rec.y !== m.y) { rec.x = m.x; rec.y = m.y; rec.t = now; }
    });
    if (now - heardAt > HEAR_EVERY) {                                    // who is heard: looked at a few times a second
      heardAt = now; heardIds = {};
      var stateOf = null, map = mapOf(), dflt = Number(content.config.monster_noise);
      if (!(dflt >= 0)) dflt = 5;
      view.monsters.forEach(function (m) {
        var rec = heardMove[m.id]; if (!rec || now - rec.t > HEAR_MS || sight.vis[m.x + ',' + m.y]) return;
        var d = content.monsters[m.ref], own = d ? d.noise : null, r = own == null || own < 0 ? dflt : Number(own);
        if (!(r > 0)) return;
        stateOf = stateOf || World.viewLookup(content, map, view, me).stateOf;
        if (World.soundCarries(content, map, m.x, m.y, me.x, me.y, r, stateOf)) heardIds[m.id] = 1;
      });
      Object.keys(heardMove).forEach(function (id) { if (!live[id]) delete heardMove[id]; });
    }
    var out = {};
    view.monsters.forEach(function (m) {                                 // where each is DRAWN this frame (it glides between tiles)
      if (!heardIds[m.id]) return;
      var s = shownOthers[m.id] || m;
      out[Math.round(s.x) + ',' + Math.round(s.y)] = 1; any = true;
    });
    return any ? out : null;
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (!renderer || !renderer.map || !me) return;
    var moveMs = content.config.move_ms || 140;
    var dt = Math.min(100, lastFrame ? now - lastFrame : 16); lastFrame = now;
    var moving = Math.abs(shown.x - me.x) > 0.01 || Math.abs(shown.y - me.y) > 0.01;
    if (floorWait && now - floorWait > 1500) floorWait = 0;      // the answer never came: carry on
    var inScene = Scene.playing();
    if (inScene) { Scene.update(now, shown); tap = null; held = []; }   // a scene: no walking (client/js/scene.js)
    else if (questOpen || questPop()) tap = null;               // a quest window or the quest log is up: no walking (a tap is dropped, not kept for later)
    else if (!moving && !bagOpen && !floorWait) {
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
    if (now - lastReply > pollMs && !(inScene && sceneTry)) poll();

    ease(shown, me, dt / (moveMs * (lastCost || 1)));   // (a slow step, a diagonal or wading, glides slower too)
    noiseMeter();
    if (harvesting) harvestSwing();
    if (picking) pickSwing();
    syncThrow();                                          // (the right button may have just been pressed or let go)
    var eating = eatHold && leftHeld && !eatDone && !!heldUse();   // the button held with food in hand: it rises, then is used — once
    if (!eating) eatT0 = 0; else if (!eatT0) eatT0 = now;
    eatProg = eating ? Math.min(1, (now - eatT0) / EAT_MS) : 0;
    eatUp = eating ? Math.max(eatUp, Math.min(1, eatProg / EAT_UP)) : Math.max(0, eatUp - dt / 150);
    var bitesNow = bitesAt(eatProg);
    if (bitesNow > eatBit) crumbFx(heldId(), shown.x, shown.y, aiming ? (Math.cos(aimAngle) < 0 ? 'W' : 'E') : (lastPtr && lookSide) || me.facing, now);
    eatBit = bitesNow;
    if (eating && eatProg >= 1) { eatDone = true; useHeld(); }
    handSize(now);
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
    if (lastPtr && !aiming) aimAt(lastPtr);               // you walked, the view moved: the cursor is somewhere else on the map
    var myFacing = aiming ? (Math.cos(aimAngle) < 0 ? 'W' : 'E') : (lastPtr && lookSide) || me.facing;   // (cursor off the view: the way you walk)
    var actors = [{ x: shown.x, y: shown.y, facing: myFacing, name: me.name, hp: me.hp, maxHp: me.maxHp, me: true, layers: playerLayers(me) || undefined, aim: aiming ? aimAngle : null, swing: (performance.now() - swingT0) / SWING_MS, lift: eatUp, bite: eatBit / EAT_BITES, statusColor: myst ? myst.color : '',
      idle: shown.x === me.x && shown.y === me.y && !aiming, ph: phaseOf(me.id), sneak: !!me.sneak,
      jolt: joltMs('p:' + me.id, me.hp, Math.max(swingT0, lastHoldShot || -1e9), performance.now(), myFacing), go: goOf('p:' + me.id, shown.x, shown.y), k: 'p:' + me.id }];   // idle = standing still: the figure breathes (Render, paintActor); sneak = drawn crouched
    var sceneEm = inScene ? Scene.emotes(now) : [];                    // emotes a scene put up: over you, an NPC, a tile, an actor
    var pups = inScene ? Scene.puppets(now) : {}, speaker = inScene ? Scene.speaker() : '';   // the scene's actors, and who is speaking
    function emFor(ref) {                                              // what shows over an actor: the scene's emote, else the mark of who speaks
      var base = String(ref).split('|')[0];                             // (an emote over a pack is over each of them)
      return sceneEm.filter(function (em) { return em.ref === base; })[0] || (speaker === ref ? { id: 'talk', t: 100000 + now % 100000, left: Infinity } : null);
    }
    scenePupKeys = {};
    Object.keys(pups).forEach(function (ref) { if (pups[ref].key) scenePupKeys[pups[ref].key] = 1; });
    if (pups.me) {                                                     // the scene moves your own figure (drawn only: you stand where you stood)
      var pm = pups.me, a0 = actors[0];
      a0.x = pm.x; a0.y = pm.y; a0.facing = pm.facing; a0.idle = !pm.moving; a0.alpha = pm.on ? pm.alpha : 0; a0.aim = null;
      if (!pm.on) a0.name = '';
    }
    actors[0].emote = emFor('me') || (inScene ? null : playerEmote(me.em));
    var seen = {}, marks = [], tMark = performance.now(), TM = content.config.tile_size || 32;
    reloadMark(marks, TM); craftMark(marks, TM); questMarks(marks, TM); promptMark(marks); minimap();
    // (in a scene only the map, the NPCs and you are drawn: it looks the same every time and gives nobody away)
    var inBlast = {};                                                     // monsters in a blast that is still in the air, as they stood
    landingAt(-99, -99, tMark);                                        // (drops the ones that have landed)
    landings.forEach(function (l) { if (l.map === me.map) Object.keys(l.was).forEach(function (id) { inBlast[id] = l.was[id]; }); });
    (inScene ? [] : view.monsters).forEach(function (m) {
      var d = content.monsters[m.ref] || { name: m.ref, sprite: '' }, s = shownOthers[m.id] || (shownOthers[m.id] = { x: m.x, y: m.y });
      var mStill = s.x === m.x && s.y === m.y;                           // (before easing: it was already there last frame)
      ease(s, m, dt / 250); seen[m.id] = 1;
      var stc = m.statuses && m.statuses.length && content.statuses[m.statuses[0]];
      var lay = monsterLayers(m);                                        // paper-doll zombies carry a rolled look
      // sprite '' (not undefined) keeps the monster health-bar colour + no name label even when layered
      actors.push({ x: s.x, y: s.y, facing: m.facing, name: d.name, sprite: lay ? '' : (d.sprite || ''),
        layers: lay || undefined, hp: m.hp, maxHp: m.maxHp, statusColor: stc ? stc.color : '', idle: mStill, ph: phaseOf(m.id), jolt: lay ? joltMs(m.id, m.hp, null, tMark, m.facing) : undefined, go: lay ? goOf(m.id, s.x, s.y) : undefined, k: lay ? 'm:' + m.id : undefined });
      var heldM = inBlast[m.id]; if (heldM) actors[actors.length - 1].hp = heldM.a.hp;   // (a blast still in the air has not hurt it yet)
      monSnap[m.id] = { a: actors[actors.length - 1], ref: m.ref, at: tMark };   // how it looks now, should it die (deathFx)
      // "!" when it starts after someone it sees, "?" when it loses them or hears something and goes to look — for a
      // moment, and only if you can see it
      var al = m.alert || 0, ar = alertSt[m.id] || (alertSt[m.id] = { a: al, until: 0, kind: '' });
      if (al !== ar.a) {
        if (al === 2) { ar.kind = 'alert'; ar.until = tMark + ALERT_MS; }
        else if (al === 1) { ar.kind = 'search'; ar.until = tMark + ALERT_MS; }
        else ar.until = 0;
        ar.a = al;
      }
      if (tMark < ar.until && (!sight.vis || sight.vis[m.x + ',' + m.y])) marks.push({ id: 'm:' + m.id, kind: ar.kind, x: s.x, y: s.y, up: lay ? TM * 0.5 + 4 : 4 });
    });
    if (!inScene) Object.keys(inBlast).forEach(function (id) {             // one the blast will kill: still standing until it lands
      if (seen[id]) return;
      var ga = Object.assign({}, inBlast[id].a, { idle: true });
      actors.push(ga); monSnap[id] = { a: ga, ref: inBlast[id].ref, at: tMark };
    });
    Object.keys(alertSt).forEach(function (id) { if (!seen[id]) delete alertSt[id]; });
    Object.keys(monSnap).forEach(function (id) { if (!seen[id] && tMark - monSnap[id].at > 3000) delete monSnap[id]; });
    view.players.forEach(function (q) {                       // someone watching a scene: a mark over their head (nothing can touch them)
      var s = shownOthers['p:' + q.id];
      if (q.wt && s && (!sight.vis || sight.vis[q.x + ',' + q.y])) marks.push({ id: 'w:' + q.id, kind: 'watch', x: s.x, y: s.y, up: TM * 0.5 + 4 });
    });
    setMarks(marks);
    (inScene ? [] : view.players).forEach(function (q) {
      var s = shownOthers['p:' + q.id] || (shownOthers['p:' + q.id] = { x: q.x, y: q.y });
      var qStill = s.x === q.x && s.y === q.y;
      ease(s, q, dt / (moveMs * Rules.stepCost('N', content, mapOf(), q.x, q.y, q))); seen['p:' + q.id] = 1;   // (wading or sneaking: slower)
      var act = othersAct(q, tMark), eat = othersEat(q, act, s, tMark);
      actors.push({ x: s.x, y: s.y, facing: q.facing, name: q.name, tint: '#b6553d', layers: playerLayers(q) || undefined, hp: q.hp, maxHp: q.maxHp, swing: (tMark - act.t0) / SWING_MS, lift: eat.lift, bite: eat.bite, idle: qStill, ph: phaseOf(q.id), sneak: !!q.sn, emote: playerEmote(q.em), jolt: joltMs('p:' + q.id, q.hp, act.j0, tMark, q.facing), go: goOf('p:' + q.id, s.x, s.y), k: 'p:' + q.id });
    });
    npcActors(actors, shown, sceneEm);
    if (inScene) {
      sceneActors(actors, pups, emFor);
      actors.forEach(function (a) { if (a.sprite === undefined) a.name = ''; });   // no name tags in a scene (who speaks is in the line box)
    }
    Object.keys(shownOthers).forEach(function (k) { if (!seen[k]) delete shownOthers[k]; });

    var T = content.config.tile_size || 32, map = renderer.map;
    var padB = edgePad(T);                                     // room past each edge of the map, so the HUD never covers you there
    var sv = Scene.view(shown), focus = sv || shown;           // a scene steers the camera (and comes back to you after)
    var zoom = sv && sv.zoom > 0 ? sv.zoom : 1, zs = zoom === 1 ? '' : 'scale(' + zoom.toFixed(3) + ')';
    if (canvas.style.transform !== zs) canvas.style.transform = zs;
    var cam = {
      x: clamp((focus.x + 0.5) * T - canvas.width / 2, -padB, map.width * T + padB - canvas.width),
      y: 0
    };
    // The view is centred on where you are DRAWN: on raised ground that is higher up the screen than your tile.
    // A scene's camera says its own height (sv.lift: blended from where a move starts to where it ends, so it glides in a
    // straight line whatever ground lies between); otherwise the ground under the one followed.
    var myLift = sv && sv.lift != null ? sv.lift : sceneLift(focus.x, focus.y);
    cam.y = clamp((focus.y + 0.5) * T - myLift - canvas.height / 2, -myLift - padB, map.height * T + padB - canvas.height);
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
    cam.x = Math.round(cam.x + lean.x + (sv ? sv.sx : 0)); cam.y = Math.round(cam.y + lean.y + (sv ? sv.sy : 0));   // (sx, sy: a scene's camera shake)
    if (map.width * T >= canvas.width) cam.x = clamp(cam.x, -padB, map.width * T + padB - canvas.width);      // never further past the map's edge
    if (map.height * T >= canvas.height) cam.y = clamp(cam.y, -myLift - padB, map.height * T + padB - canvas.height);
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
    if (me && !inScene && String(content.config.sight || 'on') !== 'off') {   // (a scene lifts the fog: the camera may look anywhere)
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
    sneakVeil();
    var thAim = throwing && !inScene ? throwAim() : null;      // (its reach is hatched on the ground, under what stands there)
    renderer.draw(cam, actors, { reach: thAim && thAim.cells, states: states, hidden: hiddenEntity, explored: explored, vis: vis, memory: mem, sensed: inScene ? null : hearing(now), cutAll: removing && wallsDown, watch: sightAreas(map, vis), stains: liveStains(now), floorActors: floorActors(dt), floorStates: floorStates(), floorSight: floorSight() });
    nameTags(renderer.nameTags);                              // the names over characters, as text over the view
    drawEmotes(cam, map, T, sceneEm);
    if (removing) renderer.drawRemove(cam, removeTarget(), wallsDown);
    if (moveTool && !moveTool.key) renderer.drawRemove(cam, moveTarget(), false, true);
    if (moveTool && moveTool.key) renderer.drawGhost(cam, buildTarget());
    var bpNow = building && content.blueprints && content.blueprints[building];
    if (removing || (bpNow && (bpNow.places === 'roof' || bpNow.places === 'tile'))) renderer.drawRoofs(cam, mapOf());   // where roof already is: you stand under it and cannot see it
    if (building) { var gh0 = buildTarget(); renderer.drawClaims(cam, World.claimsOn(content, mapOf()), me, gh0); renderer.drawGhost(cam, gh0); }
    else if (!moveTool && !removing && placeHeld() && $('menu').hidden && !bagOpen) { var ghP = buildTarget(); if (ghP) renderer.drawGhost(cam, ghP); }   // a bedroll in hand: where it would go
    if (armed) renderer.drawAim(cam, aimOverlay());
    else if (throwing) { if (renderer.drawThrow) renderer.drawThrow(cam, thAim || throwAim(), now); else renderer.drawAim(cam, throwOverlay()); }
    // a ready gun shows no on-canvas aim — the crosshair cursor is the aim (see updateCursor)
    renderer.drawFx(cam, fx, now);
    tickHotbar();
    $('hud-pos').textContent = '(' + me.x + ', ' + me.y + ')';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function hiddenEntity(e) {
    var o = content.objects[e.ref]; if (!o) return false;
    if (outfitOf(o)) return true;                                               // an NPC with an outfit is drawn as a figure (npcActors)
    if (scenePupKeys[e.key]) return true;                                       // a scene moves it: its actor is drawn instead (sceneActors)
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
      var look = { body: '', skin: ch.skin || 'skin_light', hair: ch.style, hairColor: ch.color, beard: '', beardColor: '' };   // (beardColor '' = the hair's)
      var beards = ch.beards || [''];
      function tinted(path, color) { return path ? Tint.layer(Assets.get(path), Assets.get(maskOf(path)), Tint.TINTS[color]) : null; }
      // one figure: the class's body with a hair shape in a colour, scaled up without smoothing
      function bodyOf(kind) { return World.bodySprite ? World.bodySprite(content, { 'class': cls.value, body: kind }) : ((content.classes[cls.value] || {}).bodySprite || ''); }
      function doll(cv, hair, color, kind, beard) {
        var g = cv.getContext('2d'), bp = bodyOf(kind === undefined ? look.body : kind), body = bp && Assets.get(bp);
        g.clearRect(0, 0, cv.width, cv.height); g.imageSmoothingEnabled = false;
        if (body) g.drawImage(Tint.skinned ? Tint.skinned(body, look.skin, false) : body, 0, 0, cv.width, cv.height);
        var bd = tinted(beard === undefined ? look.beard : beard, look.beardColor || look.hairColor); if (bd) g.drawImage(bd, 0, 0, cv.width, cv.height);
        var img = tinted(hair, color); if (img) g.drawImage(img, 0, 0, cv.width, cv.height);
      }
      function draw() {
        var hs = $('join-hair'), cs = $('join-color'), bs = $('join-body-pick'), bb = $('join-build'); hs.innerHTML = ''; cs.innerHTML = ''; bs.innerHTML = ''; bb.innerHTML = '';
        // Body: a man or a woman; a woman then picks her build (owner, 27 Nov 2026): curvy = body 'female', slim =
        // 'female_slim' (the man's cut of what she wears, no chest motion). Slim is what Female starts on (owner). The build picked is kept while Male is tried.
        var woman = look.body !== '';
        [['', 'Male'], [look.build || 'female_slim', 'Female']].forEach(function (kind) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jbody' + ((kind[0] !== '') === woman ? ' on' : ''); b.textContent = kind[1];
          b.onclick = function () { look.body = kind[0]; draw(); };
          bs.appendChild(b);
        });
        [['female_slim', 'Slim'], ['female', 'Curvy']].forEach(function (kind) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jbody' + (kind[0] === look.body ? ' on' : ''); b.textContent = kind[1];
          b.onclick = function () { look.body = look.build = kind[0]; draw(); };
          bb.appendChild(b);
        });
        bb.hidden = $('join-build-label').hidden = !woman;
        ch.styles.forEach(function (path) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jpick' + (path === look.hair ? ' on' : '');
          b.title = path ? path.replace(/^.*\/hair_?/, '').replace(/\.png$/i, '').replace(/_/g, ' ') : 'bald';
          var cv = document.createElement('canvas'); cv.width = 32; cv.height = 48; doll(cv, path, look.hairColor); b.appendChild(cv);
          b.onclick = function () { look.hair = path; draw(); };
          hs.appendChild(b);
        });
        var fs = $('join-beard'), fc = $('join-beard-color'); fs.innerHTML = ''; fc.innerHTML = '';
        beards.forEach(function (path) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jpick' + (path === look.beard ? ' on' : '');
          b.title = path ? path.replace(/^.*\/beard_?/, '').replace(/\.png$/i, '').replace(/_final$/, '').replace(/_/g, ' ') : 'none';
          var cv = document.createElement('canvas'); cv.width = 32; cv.height = 48; doll(cv, look.hair, look.hairColor, undefined, path); b.appendChild(cv);
          b.onclick = function () { look.beard = path; draw(); };
          fs.appendChild(b);
        });
        ch.colors.forEach(function (name) {
          var ramp = Tint.TINTS[name]; if (!ramp) return;
          var b = document.createElement('button'); b.type = 'button'; b.className = 'jswatch' + (name === (look.beardColor || look.hairColor) ? ' on' : '');
          b.title = name.replace(/^hair_/, ''); b.style.background = 'linear-gradient(135deg, ' + ramp[3] + ', ' + ramp[1] + ')';
          b.onclick = function () { look.beardColor = name; draw(); };
          fc.appendChild(b);
        });
        $('join-beard-color').hidden = $('join-beard-color-label').hidden = !look.beard;
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
      ['', 'female', 'female_slim'].forEach(function (kind) { var bp = bodyOf(kind); if (bp) need.push(bp); });
      ch.styles.concat(beards).forEach(function (path) { if (path) { need.push(path); need.push(maskOf(path)); } });
      Promise.all(need.map(function (path) { return Assets.load(path); })).then(function () { if (!box.hidden) draw(); });
      box.hidden = false; input.focus();
      // the big figure is alive: it breathes and turns to the cursor, as you will in the game (liveFigure)
      liveFigure($('join-preview'), function () {
        return playerLayers({ id: 'new', 'class': cls.value, body: look.body, skin: look.skin === 'skin_light' ? '' : look.skin, hair: look.hair, hairColor: look.hairColor,
          beard: look.beard, beardColor: look.beardColor, equipment: {} });
      }, { turn: { facing: 'E', at: -1e9 }, alive: function () { return !box.hidden; } });
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
    $('frame').style.setProperty('--ar', (canvas.width / canvas.height).toFixed(4));
    UI.setAspect(canvas.width / canvas.height);            // …and the UI its whole-number scale for that room (client/js/ui.js)   // the view fills the window, keeping its shape (index.html)
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
    // ?scene=<id> (the Studio's Play this scene): the test character first goes where the scene's map says the player stands
    var trySc = api.mode === 'offline' && (content.scenes || {})[new URLSearchParams(location.search).get('scene')];
    if (trySc && trySc.start && content.maps[trySc.map] && !(res.player.map === trySc.map && res.player.x === trySc.start.x && res.player.y === trySc.start.y)) return api.warp(trySc.map, trySc.start.x, trySc.start.y);
    if (want && api.mode === 'offline' && content.maps[want] && World.groundId(content, want) !== World.groundId(content, res.player.map)) return api.warp(want);
    return res;
  }).then(apply).then(function () {
    setupDebug();
    log('WASD / arrows move · hold right-click to aim (left-click fires toward the cursor; R reloads) · left-click to interact, hold it for options · F/Space to use what is towards the cursor · ' + (skillsOn() ? 'Q/E abilities · ' : '') + 'mouse wheel or 1-9, 0 choose what you hold from the belt (hold the click to use food and the like) · I or C inventory and crafting · B build.', 'info');
    if (api.staleDraft) log('Your map editor draft was made from older game data, so the game is using the latest data instead. Open the editor to update or discard the draft.', 'death');
    // ?scene=<id> (the Content Studio's "Play this scene", offline only): that scene at once, seen or not, told to nobody
    var tryScene = new URLSearchParams(location.search).get('scene');
    if (tryScene && api.mode === 'offline' && (content.scenes || {})[tryScene]) {
      sceneTry = true;                                          // (the world here waits while it plays: nothing asks the referee to move it on)
      playScene(content.scenes[tryScene], function () { sceneTry = false; log('That was the scene "' + tryScene + '" (a try: what follows it in an action list happens only in play).', 'info'); });
    }
    requestAnimationFrame(frame);
  }).catch(function (e) {
    setNet('could not start: ' + e.message, true);
    console.error(e);
  });

  addEventListener('pagehide', function () { api.leave(); });
  // read-only peek for tests and debugging in the browser console
  window.SheetsRPG = { state: function () { return { me: me, view: view, queue: queue.length }; },
                       pick: function (clientX, clientY) { return cellAt({ clientX: clientX, clientY: clientY }); },   // the tile a point of the page means (tests)
    plan: function () { return null; },    // kept for back-compat: there is no click-to-walk plan any more
    heard: function () { return hearing(performance.now()); },   // the cells where a creature out of sight is heard right now (tests)    // kept for back-compat: there is no click-to-walk plan any more
    layers: function () { return me ? playerLayers(me) : null; },
    camera: function () { return lastCam; },
    content: function () { return content; },                                  // (tests: change a map in memory, then remap())
    remap: function () { npcSig = ''; if (renderer && me) renderer.setMap(mapOf(), floorMaps()); },
    aim: function () { return { aiming: aiming, aimAngle: aimAngle, facing: me && me.facing, armed: armed, throwing: throwing, hover: hover, check: armed && hover ? aimCheck(hover) : null }; } };
})();
