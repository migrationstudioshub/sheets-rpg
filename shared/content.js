/**
 * Turns the Game Data tabs (each a list of row objects keyed by header) into
 * the content object the game uses. Runs unchanged in the browser (offline
 * mode reads data/tables.json) and in Apps Script (reads the live sheets), so
 * both always interpret the data the same way.
 */
var Content = (function () {
  function bool(v) {
    if (typeof v === 'boolean') return v;
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  function boolDef(v, d) { return v == null || v === '' ? d : bool(v); }   // like bool, but blank keeps the default
  function num(v, d) {
    if (v === '' || v == null) return d;
    var n = Number(v);
    return isNaN(n) ? d : n;
  }
  function scalar(v) {
    if (typeof v !== 'string') return v;
    var s = v.trim();
    if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
    if (s !== '' && !isNaN(Number(s))) return Number(s);
    return s;
  }
  function json(v, d) {
    if (v && typeof v === 'object') return v;
    if (v === '' || v == null) return d;
    try { return JSON.parse(v); } catch (e) { return d; }
  }
  function str(v) { return v == null ? '' : String(v).trim(); }
  // A monster's `appearance` lists one or more Appearance sets ("set" or "set:weight", comma-separated);
  // one is picked per spawn. Accepts an already-parsed array too (drafts may store it structured).
  function parseLooks(v) {
    if (Array.isArray(v)) return v.map(function (e) { return { set: str(e.set || e), weight: num(e.weight, 1) }; }).filter(function (e) { return e.set; });
    return str(v).split(',').map(function (x) {
      var a = x.trim().split(':'), id = (a[0] || '').trim();
      return id ? { set: id, weight: num(a[1], 1) } : null;
    }).filter(Boolean);
  }
  // Terrain may be stored compact-encoded (palette + RLE); decode it to a plain grid. Look MapCode up
  // lazily so content.js keeps no load-order dependency (global in the browser, require() in Node).
  function decodeGrid(v) {
    var MC = (typeof MapCode !== 'undefined') ? MapCode : (typeof require !== 'undefined' ? require('./mapcode.js') : null);
    return MC ? MC.decode(v) : v;
  }
  function byId(rows, key) {
    var out = {};
    (rows || []).forEach(function (r) { var k = str(r[key || 'id']); if (k) out[k] = r; });
    return out;
  }
  // "open=https://...; empty=https://..." -> {open: url, empty: url}
  function pairs(v) {
    var out = {};
    str(v).split(';').forEach(function (p) {
      var i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    return out;
  }

  // The item types every game starts with. The ItemTypes tab (Content Studio → Item Types) replaces or adds to
  // them; with no such tab the game behaves exactly as it did when these names were wired into the rules.
  //   equip = can be worn/held (slot = where) · shoot = a held one with range fires · consume = used up on use
  //   throw = thrown from the belt · ammo / tool = only decide which fields the item form shows
  var ITEM_TYPES = [
    { id: 'material', name: 'Material' },
    { id: 'weapon', name: 'Weapon', equip: true, slot: 'weapon', shoot: true, tool: true },
    { id: 'armor', name: 'Armor', equip: true, slot: 'armor' },
    { id: 'consumable', name: 'Consumable', consume: true },
    { id: 'throwable', name: 'Throwable', throw: true },
    { id: 'ammo', name: 'Ammo', ammo: true },
    { id: 'key', name: 'Key' }
  ];
  function itemType(r) {
    var props = json(r.properties, []);
    return { id: str(r.id), name: str(r.name) || str(r.id), equip: bool(r.equip), slot: str(r.slot), shoot: bool(r.shoot),
      consume: bool(r.consume), cooldownS: Math.max(0, num(r.cooldown_s, 0)), throw: bool(r.throw), ammo: bool(r.ammo), tool: bool(r.tool),
      properties: (Array.isArray(props) ? props : []).filter(function (d) { return d && str(d.name); })
        .map(function (d) { return { name: str(d.name), type: str(d.type) || 'text', def: d.def == null ? '' : d.def, notes: str(d.notes) }; }) };
  }

  /**
   * The tool tags an item counts as (what "needs tool" on a blueprint, a recipe or a harvestable object asks for).
   * Its own `tool` field if it has one ("axe, blade"). With none, an item whose type is a tool type — the type's id
   * is "tool", or it has the tool tick and is not something you equip (so not every weapon) — is a tool by its own id.
   * r = the item's row, ty = its type (a row or a built type; may be missing). The Content Studio lists the same.
   */
  function toolTags(r, ty) {
    var tags = str(r && r.tool).split(/[;,]/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (tags.length || !r || !str(r.id)) return tags;
    var isTool = str(r.type) === 'tool' || !!(ty && bool(ty.tool) && !bool(ty.equip));
    return isTool ? [str(r.id)] : tags;
  }

  function build(tables) {
    var c = { config: {}, tilesets: {}, autotile: {}, terrain: {}, kinds: {}, objects: {}, maps: {} };

    (tables.Config || []).forEach(function (r) { if (str(r.key)) c.config[str(r.key)] = scalar(r.value); });

    (tables.Tilesets || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.tilesets[id] = { id: id, image: str(r.image), tileSize: num(r.tile_size, 32),
        columns: num(r.columns, 8), layout: str(r.layout),
        frames: Math.max(1, num(r.frames, 1)), frameMs: num(r.frame_ms, 200) };   // frames > 1 = an animated sheet: that many whole sheets side by side
    });

    (tables.Autotile || []).forEach(function (r) {
      var layout = str(r.layout); if (!layout) return;
      (c.autotile[layout] = c.autotile[layout] || {})[num(r.mask, 0)] =
        str(r.tiles).split(',').map(function (x) { return Number(x); }).filter(function (x) { return x > 0; });
    });

    (tables.Terrain || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.terrain[id] = { id: id, name: str(r.name) || id,
        sprite: str(r.sprite), autotile: str(r.autotile), layer: str(r.layer) === 'overlay' ? 'overlay' : (str(r.layer) === 'base' ? 'base' : ''),
        frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200), buildOver: bool(r.build_over), tint: str(r.tint), seeThrough: bool(r.see_through),
        // a water source (drink from it, fill bottles). Not said = anything called "…water…"; toxicity '' = Config water_toxicity
        water: r.water === undefined || r.water === '' || r.water === null ? /water/i.test(str(r.name) || id) : bool(r.water),
        toxicity: r.toxicity === undefined || r.toxicity === '' || r.toxicity === null ? null : num(r.toxicity, 0),
        pass: { n: bool(r.pass_n), e: bool(r.pass_e), s: bool(r.pass_s), w: bool(r.pass_w) } };
      // Water and lava lie flat: you see (and shoot) across them without anyone having to tick see_through.
      if (c.terrain[id].water || /^(water|lava)/.test(c.terrain[id].tint)) c.terrain[id].seeThrough = true;
    });

    // Wall styles: materials for edge walls (walls painted on cell boundaries, not tiles). A style is art +
    // behaviour only — NO height; height is set per painted segment. `face` is a vertically-tileable front
    // strip, `cap` the top; `color` is the artless fallback so a style works before its art exists.
    c.wallStyles = {};
    (tables.WallStyles || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.wallStyles[id] = { id: id, name: str(r.name) || id,
        cap: str(r.cap), face: str(r.face), color: str(r.color) || '#8a8f98',
        // tiles: a 16-tile connection sheet (4x4; tile index = N1·E2·S4·W8 mask). When set, the wall is drawn
        // top-down and autotiled so corners/T/cross/caps join; when absent it falls back to the extruded slab.
        tiles: str(r.tiles),
        blocksMove: boolDef(r.blocks_move, true), blocksSight: boolDef(r.blocks_sight, true),
        // Durability of ONE wall segment. hp 0 = cannot be damaged. An authored (map-editor) wall takes damage
        // only when its style is `breakable`; `material` picks how hard each kind of hit lands (World MULT).
        hp: num(r.hp, 0), armor: num(r.armor, 0), material: str(r.material) || 'stone',
        breakable: bool(r.breakable), salvage: str(r.salvage) };
    });

    (tables.Kinds || []).forEach(function (r) {
      var k = str(r.kind); if (!k) return;
      var kind = c.kinds[k] = c.kinds[k] || { kind: k, states: [], props: {} };
      var p = str(r.property);
      if (p === 'states') kind.states = str(r['default']).split('|').filter(Boolean);
      else if (p) kind.props[p] = { type: str(r.type), 'default': scalar(r['default']), notes: str(r.notes) };
    });

    // Built in: '_drop', an item lying on the ground (what a tame animal lays, what the map editor's Items tab places):
    // the entity says which (data.pickup). '_bag', the loot bag: what a player drops, and what a smashed container held.
    // The settings of a thing on the ground, for the map editor's form (unless the Kinds tab already has them).
    if (!c.kinds.pickup) c.kinds.pickup = { kind: 'pickup', states: [], props: {
      pickup: { type: 'item_list', 'default': '', notes: 'What lies here: item:how many (branch:1)' },
      respawn_s: { type: 'number', 'default': '', notes: 'Seconds until it is back after someone took it. Empty = Config pickup_respawn_s (0 = it never comes back)' } } };
    (tables.Objects || []).concat([{ id: '_drop', name: 'Item', kind: 'pickup', walkable: true, properties: '{}' },
      { id: '_bag', name: 'Loot bag', kind: 'container', walkable: true, sprite: 'art/sprites/objects/loot_bag.png', properties: '{}' }]).forEach(function (r) {
      var id = str(r.id); if (!id || c.objects[id]) return;
      var pr = json(r.properties, {});
      c.objects[id] = { id: id, name: str(r.name) || id, kind: str(r.kind) || 'deco',
        sprite: str(r.sprite), spriteStates: pairs(r.sprite_states), walkable: str(r.kind) === 'stairs' ? true : bool(r.walkable),   // stairs are always walked on
        blocksSight: bool(r.blocks_sight),
        // Collision footprint in tiles (w×h, bottom-left anchored); authored in the Content Studio as
        // properties.width / properties.height, default 1. Rules.blockersAt blocks the whole footprint.
        footprintW: Math.max(1, num(pr.width, 1)), footprintH: Math.max(1, num(pr.height, 1)),
        // Directional passability for a walkable object (like terrain): can you leave/enter its cell
        // that way? Default open, so an ordinary walkable object restricts nothing.
        pass: { n: boolDef(pr.pass_n, true), e: boolDef(pr.pass_e, true), s: boolDef(pr.pass_s, true), w: boolDef(pr.pass_w, true) },
        // Draw order relative to the player: 'auto' (base behind, tall overflow in front — the default),
        // 'over' (whole object in front of characters) or 'under' (whole object behind them).
        draw: pr.draw === 'over' || pr.draw === 'under' ? pr.draw : 'auto',
        // Vertical draw nudge in authoring pixels (negative = up, positive = down); the renderer scales it.
        offsetY: num(pr.offset_y, 0),
        frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200),
        properties: pr, onInteract: str(r.on_interact) };
    });

    (tables.Maps || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      var grid = decodeGrid(json(r.terrain, []));
      // Optional second terrain grid drawn on top of the base (overlay autotiles, transparent outside their
      // shape). Absent/empty on older maps, which then behave exactly as before (base layer only).
      var overlay = decodeGrid(json(r.overlay, []));
      // Edge walls: walls that live on cell boundaries, not tiles. Two grids of "styleId:height" tokens
      // ('' = no wall). hWalls = horizontal lines (hWalls[y][x] is the north edge of cell x,y); it has
      // height+1 rows × width cols. vWalls = vertical lines (vWalls[y][x] is the west edge of cell x,y);
      // it has height rows × width+1 cols. Absent/empty on maps without walls. See Rules wall helpers.
      var vWalls = decodeGrid(json(r.vWalls, []));
      var hWalls = decodeGrid(json(r.hWalls, []));
      // Roof cover: a W×H mask ('1' = a roofed interior tile, '' = open). Contiguous roofed tiles form a
      // "room" that is hidden (drawn as a black void) until the player steps inside. Absent/empty on maps
      // with no interiors to hide. See World.roofZoneAt (zones) and render.js (drawing the cover).
      var roof = decodeGrid(json(r.roof, []));
      // No-build mask: a W×H grid ('1' = players may not build on this tile), painted in the map editor.
      var nobuild = decodeGrid(json(r.nobuild, []));
      // Ground height: a W×H grid of tokens ('' = level; '2' = two steps up; '1N' = a ramp from 1 up to 2 going north). See Rules.heightAt.
      var elev = decodeGrid(json(r.elev, []));
      // Frozen autotile shapes from shift-click mapping: sparse { "x,y": mask } per layer, render-only.
      c.maps[id] = { id: id, name: str(r.name) || id, width: num(r.width, grid[0] ? grid[0].length : 0),
        height: num(r.height, grid.length), terrain: grid, overlay: overlay, vWalls: vWalls, hWalls: hWalls, roof: roof, nobuild: nobuild, elev: elev,
        roof_color: str(r.roof_color),
        // A floor of a multi-storey map (docs/FLOORS.md): the ground map's id and this floor's level. Linked below.
        floorOf: str(r.floor_of), z: num(r.z, 0),
        // Optional player spawn point {x, y, facing}: where new/respawning players start on this map (set in
        // the map editor). Absent on maps without one, which then fall back to Config start_x/start_y.
        spawn: json(r.spawn, null),
        shapes: json(r.shapes, {}), overlayShapes: json(r.overlayShapes, {}), entities: [] };
    });

    (tables.MapEntities || []).forEach(function (r) {
      var m = c.maps[str(r.map)]; if (!m || !str(r.ref)) return;
      m.entities.push({ key: str(r.key), x: num(r.x, 0), y: num(r.y, 0), ref: str(r.ref), data: json(r.data, {}) });
    });

    c.items = {}; c.monsters = {}; c.loot = {}; c.classes = {}; c.levels = []; c.appearances = {};
    c.itemTypes = {};
    ITEM_TYPES.concat(tables.ItemTypes || []).forEach(function (r) { var ty = itemType(r); if (ty.id) c.itemTypes[ty.id] = ty; });
    (tables.Items || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      // What the item can do comes from its type's ticks, not the type's name. A type nobody defined keeps the
      // old reading (a slot means it can be equipped), so nothing already in a game changes.
      var tyId = str(r.type) || 'material', ty = c.itemTypes[tyId];
      var slot = ty ? (ty.equip ? (str(r.slot) || ty.slot) : '') : str(r.slot);
      var props = {}, own = json(r.props, {});
      if (ty) ty.properties.forEach(function (d) { props[d.name] = d.def; });
      Object.keys(own && typeof own === 'object' ? own : {}).forEach(function (k) { props[k] = own[k]; });
      c.items[id] = { id: id, name: str(r.name) || id, sprite: str(r.sprite), type: tyId,
        can: { equip: !!slot, shoot: ty ? ty.shoot : tyId === 'weapon', consume: ty ? ty.consume : tyId === 'consumable', throw: ty ? ty.throw : tyId === 'throwable' },
        // seconds to wait before using another of the same item (the item's own value, else its type's)
        cooldownMs: Math.max(0, num(r.cooldown_s, ty ? ty.cooldownS : 0)) * 1000,
        props: props,
        slot: slot, wornSprite: str(r.worn_sprite), defaultTint: str(r.default_tint),
        wornEmpty: str(r.worn_empty), wornReload: str(r.worn_reload), wornAim: str(r.worn_aim),   // a magazine weapon held empty / being reloaded (a bow: no arrow / drawing)
        stackMax: num(r.stack_max, 99), value: num(r.value, 0),
        atk: num(r.atk, 0), def: num(r.def, 0), heal: num(r.heal, 0), mp: num(r.mp, 0),
        hunger: num(r.hunger, 0), thirst: num(r.thirst, 0),
        // toxicity: what using it adds to the toxicity gauge (negative = a cure); leaves: the item left in the bag
        // once it is used (an empty bottle); fillsInto: what this (empty) item becomes when filled at water
        toxicity: num(r.toxicity, 0), leaves: str(r.leaves), fillsInto: str(r.fills_into),
        // equip_if gates equipping a weapon/armor (e.g. a rifle at level 3)
        equipIf: str(r.equip_if),
        // a ranged weapon: range > 0, spends `ammo` per shot, fires no faster than fire_ms;
        // clip = magazine size (fire from the loaded mag; press R to refill it from the ammo stack)
        range: num(r.range, 0), ammo: str(r.ammo), ammoCost: Math.max(1, num(r.ammo_cost, 1)), fireMs: num(r.fire_ms, 0), clip: num(r.clip, 0), reloadMs: Math.max(0, num(r.reload_ms, 0)),
        // fire_mode: '' / single = one shot per click; semi / auto = hold the fire button to keep firing
        fireMode: str(r.fire_mode),
        // aim: {px,py,mx,my} normalised to the worn sprite — pivot (rotation axis) and barrel tip, set in the
        // Content Studio. The renderer rotates the gun about the pivot so pivot→tip points at the cursor.
        aim: json(r.aim, null),
        tint: str(r.tint),
        // ammo: how many enemies one shot pierces, losing `falloff` of its damage per extra hit (0..1)
        penetration: Math.max(1, num(r.penetration, 1)), falloff: Math.max(0, Math.min(1, num(r.falloff, 0))),
        // type 'throwable' (grenade/molotov): area damage + status at a thrown spot, up to throw_range away
        throwRange: num(r.throw_range, 0), throwArea: num(r.throw_area, 0), throwPower: num(r.throw_power, 0),
        throwStatus: str(r.throw_status), throwStatusMs: num(r.throw_status_ms, 0),
        // damage to walls/objects per hit (0 = derived from attack); burns = a thrown blast also sets wood alight
        structureDmg: num(r.structure_dmg, 0), burns: bool(r.burns), fuelS: num(r.fuel_s, 0),
        vsMaterial: (function () {                              // material_dmg "wood:3, stone:0.5" -> {wood: 3, stone: 0.5}
          var o = {}; str(r.material_dmg).split(/[,;]/).forEach(function (part) { var b = part.split(':'), k = String(b[0] || '').trim(), v = Number(b[1]); if (k && v >= 0) o[k] = v; });
          return o;
        })(),
        // tool tags this item counts as (hammer, axe, ...): recipes and harvestable objects can ask for one
        tools: toolTags(r, c.itemTypes[str(r.type)]),
        onUse: str(r.on_use) };
    });
    (tables.Monsters || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.monsters[id] = { id: id, name: str(r.name) || id, sprite: str(r.sprite), hp: num(r.hp, 10),
        atk: num(r.atk, 3), def: num(r.def, 0), xp: num(r.xp, 1), goldMin: num(r.gold_min, 0), goldMax: num(r.gold_max, 0),
        lootTable: str(r.loot_table), aggro: num(r.aggro_range, 4), moveMs: Math.max(150, num(r.move_ms, 800)),
        respawnS: num(r.respawn_s, 60),
        // 0 = melee only; >1 = can attack from that many tiles away (with line of sight)
        attackRange: num(r.attack_range, 0), rangedMs: Math.max(250, num(r.ranged_cooldown_ms, 1500)),
        rangedProjectile: bool(r.ranged_projectile), rangedStatus: str(r.ranged_status),
        infectChance: num(r.infect_chance, 0),
        // brain: how it thinks ('' = the plain one: go for whoever is within aggro_range; 'walker' = World.walkerStep).
        // Walker settings: sight = how far it spots a target (0 = aggro_range), aggroS = seconds it keeps looking after
        // losing sight (0 = 30), structureDmg = damage per blow to walls and objects (0 = its attack).
        // prey = walkers hunt this monster as they hunt players (animals).
        brain: str(r.brain), sight: num(r.sight_range, 0), aggroS: num(r.aggro_s, 0), structureDmg: num(r.structure_dmg, 0), prey: bool(r.prey),
        // animals: how near a threat may come before it runs, what it leaves when killed, what tames it, what a tame one lays and how often
        fleeRange: num(r.flee_range, 0), carcass: str(r.carcass), tameWith: str(r.tame_with), lays: str(r.lays), layS: num(r.lay_s, 0), loot: str(r.loot),   // lays / loot: item lists ("egg:1", "raw_meat:4, leather:2")
        // paper-doll monsters: one or more Appearance sets; the server picks one per spawn and rolls a look
        appearance: parseLooks(r.appearance) };
    });
    // Appearance sets: an ordered list of layers (bottom->top = draw order); each layer weighted-picks
    // one option per spawn (or none, by `empty` weight). An option is { sprite, tint, weight }; tint is a
    // Tint ramp name (recolours the sprite's sibling .tint.png mask). Lets many monsters share a look pool.
    (tables.Appearances || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      var layers = json(r.layers, []).map(function (L) {
        return { name: str(L.name), empty: num(L.empty, 0),
          // sprite options for this layer (one is picked per spawn)
          options: (L.options || []).map(function (o) {
            return { sprite: str(o.sprite), tint: str(o.tint), weight: num(o.weight, 1) };
          }),
          // optional colour pool: when set, the chosen sprite is recoloured with one of these ramps
          // (picked independently), so e.g. 9 hairstyles x 8 hair colours come from a short list
          tints: (L.tints || []).map(function (t) {
            return { tint: str(t.tint), weight: num(t.weight, 1) };
          }) };
      });
      c.appearances[id] = { id: id, name: str(r.name) || id, layers: layers };
    });
    (tables.LootTables || []).forEach(function (r) {
      var t = str(r.table), it = str(r.item); if (!t || !it) return;
      (c.loot[t] = c.loot[t] || []).push({ item: it, chance: num(r.chance, 1), min: num(r.min, 1), max: num(r.max, num(r.min, 1)), quest: str(r.quest) || undefined });
    });
    (tables.Classes || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.classes[id] = { id: id, name: str(r.name) || id, bodySprite: str(r.body_sprite),
        hp: num(r.hp, 100), atk: num(r.atk, 5), def: num(r.def, 1),
        hpPerLevel: num(r.hp_per_level, 10), atkPerLevel: num(r.atk_per_level, 1), defPerLevel: num(r.def_per_level, 1),
        mp: num(r.mp, 0), mpPerLevel: num(r.mp_per_level, 0), mpRegen: num(r.mp_regen, 0),
        startItems: str(r.start_items), notes: str(r.notes), lockpicking: num(r.lockpicking, 0),
        // "fireball@1, frost_nova@3" -> [{skill, level}]
        skills: str(r.skills).split(',').map(function (x) {
          var a = x.trim().split('@'); return a[0] ? { skill: a[0].trim(), level: num(a[1], 1) } : null;
        }).filter(Boolean) };
    });
    c.skills = {}; c.statuses = {};
    (tables.Skills || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.skills[id] = { id: id, name: str(r.name) || id, icon: str(r.icon), color: str(r.color) || '#cccccc',
        mp: num(r.mp, 0), cooldownMs: num(r.cooldown_ms, 1000), range: num(r.range, 1), target: str(r.target) || 'enemy',
        area: num(r.area, 0), los: bool(r.los), effect: str(r.effect) || 'damage', power: num(r.power, 0),
        stat: str(r.stat), scale: num(r.scale, 0), status: str(r.status), statusMs: num(r.status_ms, 0),
        dash: bool(r.dash), projectile: bool(r.projectile),
        // optional: this skill is a firearm/thrown item that spends an inventory item instead of (or besides) MP
        ammo: str(r.ammo), ammoCost: Math.max(1, num(r.ammo_cost, 1)),
        onCast: str(r.on_cast), description: str(r.description) };
    });
    (tables.Statuses || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.statuses[id] = { id: id, name: str(r.name) || id, kind: str(r.kind), amount: num(r.amount, 0),
        tickMs: num(r.tick_ms, 1000), atk: num(r.atk, 0), def: num(r.def, 0), slow: num(r.slow, 1), color: str(r.color) };
    });
    (tables.Levels || []).forEach(function (r) { if (r.level !== '' && r.level != null) c.levels.push({ level: num(r.level, 1), xp: num(r.xp_needed, 0) }); });
    c.levels.sort(function (a, b) { return a.level - b.level; });

    // Recipes: inputs -> outputs, optionally at a station (an object of kind craft with that station id nearby)
    // and/or with a tool. inputs/outputs stay "item:qty, item:qty" text; World parses them.
    // Blueprints: what players can build. places 'wall' = an edge wall of wall_style; 'object' = a map object
    // (on a tile, or on a wall when the object is wall-mounted). cost stays "item:qty, item:qty" text.
    c.blueprints = {};
    (tables.Blueprints || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.blueprints[id] = { id: id, name: str(r.name) || id, category: str(r.category) || 'other',
        places: str(r.places) === 'wall' ? 'wall' : str(r.places) === 'tile' ? 'tile' : str(r.places) === 'roof' ? 'roof' : 'object', terrain: str(r.terrain), wallStyle: str(r.wall_style), wallHeight: 2,   // every wall is one storey high (Rules.WALL_H); wall_height in old data is ignored
       
        object: str(r.object), cost: str(r.cost), work: Math.max(0, num(r.work, 4)), tool: str(r.tool), station: str(r.station),
        needsWall: boolDef(r.needs_wall, true), upgradeOf: str(r.upgrade_of), unlock: str(r.unlock), icon: str(r.icon) };
    });
    c.recipes = {};
    (tables.Recipes || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.recipes[id] = { id: id, name: str(r.name) || id, category: str(r.category), inputs: str(r.inputs), outputs: str(r.outputs),
        station: str(r.station), tool: str(r.tool), timeS: num(r.time_s, 0), unlock: str(r.unlock) };
    });
    // Quests: given by an NPC object, handed in to one. `objectives` (see parseGoals) becomes goals
    // [{type, ref, need, ...}] here, so the rules and the page read the same list (World.questState).
    c.quests = {};
    (tables.Quests || []).forEach(function (r, i) {
      var id = str(r.id); if (!id) return;
      var goals = parseGoals(r.objectives);
      c.quests[id] = { id: id, name: str(r.name) || id, giver: str(r.giver), ender: str(r.ender) || str(r.giver), text: str(r.text),
        progressText: str(r.progress_text), doneText: str(r.done_text), goals: goals, requires: str(r.requires), rewards: str(r.rewards),
        choice: str(r.choice), repeatS: Math.max(0, num(r.repeat_h, 0)) * 3600, order: i,
        image: str(r.image), tutorial: bool(r.tutorial) };      // image = a picture (a GIF plays) shown with its text; tutorial = a teaching step (World.questSweep, questSkip)
    });
    linkFloors(c);
    return c;
  }
  /**
   * A quest's objectives. GOAL_TYPES is every kind there is — the Content Studio builds its dropdown from it, and
   * World counts each one where it happens:
   *   ref = which table the target comes from (npcs = objects of kind npc; place = a spot on a map;
   *         none = it has no target: any water will do, any food)
   *         ui = a window of the game page, from UI_PARTS: only the page knows it was opened, and reports it)
   *   count = it can be asked for several times ("kill 5")
   *   quiet = counted without a line in the log each time (steps walked)
   * Stored as a JSON list — [{type, ref, need, label}], and for a place {type: 'goto', ref: mapId, x, y, r, label} —
   * or, written by hand, as text: "kill:rat:5; have:hide:3; talk:npc_marta; goto:map_3:10:4:2".
   * label (optional) = how the goal reads in the game, instead of the words made up from its target.
   */
  var GOAL_TYPES = [
    { id: 'kill', name: 'Kill a monster', ref: 'monsters', count: true },
    { id: 'have', name: 'Bring items (taken when handed in)', ref: 'items', count: true },
    { id: 'talk', name: 'Talk to someone', ref: 'npcs', count: false },
    { id: 'use', name: 'Use or consume an item', ref: 'items', count: true },
    { id: 'drink', name: 'Drink (any water: a stream, a bottle…)', ref: 'none', count: true },
    { id: 'eat', name: 'Eat (any food)', ref: 'none', count: true },
    { id: 'goto', name: 'Go to a place', ref: 'place', count: false },
    { id: 'interact', name: 'Use an object (a lever, a sign, a chest…)', ref: 'objects', count: true },
    { id: 'craft', name: 'Craft an item', ref: 'items', count: true },
    { id: 'build', name: 'Build something', ref: 'blueprints', count: true },
    { id: 'tame', name: 'Tame an animal', ref: 'monsters', count: true },
    // the basics, for tutorial steps
    { id: 'walk', name: 'Walk (steps taken)', ref: 'none', count: true, quiet: true },
    { id: 'hit', name: 'Land a blow (on a creature, or on something breakable)', ref: 'none', count: true },
    { id: 'shoot', name: 'Fire a shot', ref: 'none', count: true },
    { id: 'hold', name: 'Take something in hand (from the belt)', ref: 'none', count: false },
    { id: 'ui', name: 'Open a window of the game', ref: 'ui', count: false }
  ];
  /** The windows a `ui` goal can ask for. The page reports one being opened: {type: 'quest', op: 'did', what: id}. */
  var UI_PARTS = [
    { id: 'bag', name: 'The bag (I)' }, { id: 'quests', name: 'The quest log (L)' },
    { id: 'craft', name: 'The crafting window (C)' }, { id: 'build', name: 'The build bar (B)' }
  ];
  function goalType(id) { for (var i = 0; i < GOAL_TYPES.length; i++) if (GOAL_TYPES[i].id === id) return GOAL_TYPES[i]; return null; }
  function parseGoals(v) {
    var list = v;
    if (typeof v === 'string') {
      var text = v.trim();
      if (text.charAt(0) === '[') list = json(text, []);
      else list = text.split(';').map(function (part) {
        var a = part.split(':').map(function (x) { return x.trim(); });
        if (a[0] === 'goto') return { type: 'goto', ref: a[1], x: a[2], y: a[3], r: a[4] };
        if (goalType(a[0]) && goalType(a[0]).ref === 'none') return { type: a[0], need: a[1] };      // "drink" or "drink:2"
        return { type: a[0], ref: a[1], need: a[2] };
      });
    }
    return (Array.isArray(list) ? list : []).map(function (g) {
      var kind = g && goalType(str(g.type)), ref = !kind ? '' : kind.ref === 'none' ? '*' : str(g.ref);
      if (!kind || !ref) return null;
      var out = { type: kind.id, ref: ref, need: kind.count ? Math.max(1, Math.round(num(g.need, 1))) : 1 };
      if (kind.id === 'goto') { out.x = Math.round(num(g.x, 0)); out.y = Math.round(num(g.y, 0)); out.r = Math.max(0, Math.round(num(g.r, 1))); }
      if (str(g.label)) out.label = str(g.label);
      return out;
    }).filter(Boolean);
  }
  /**
   * Ties the floors of each multi-storey map together (docs/FLOORS.md). A floor is a map of its own whose row
   * names its ground map (floorOf) and its level (z: 1, 2… up; -1, -2… basements). Afterwards every map has
   * z, floorOf ('' on a ground map) and floors = { "0": groundId, "1": id, … } shared by the whole family.
   * A floor whose ground map is missing, or whose level is taken, becomes an ordinary map. Safe to run again.
   */
  /**
   * Makes every map's things the shape the rules expect, whatever road the map came by. A map saved from the map
   * editor is stored with each thing's settings (`data`) as JSON TEXT — fine for a sheet row, which build() parses,
   * but the referee also takes maps straight from their own documents, and there the text came through unparsed:
   * `e.data.side` and `e.data.target` read as nothing, so every door and window on a north-south wall was taken for
   * one on an east-west wall, and no teleport knew where it led. Also drops any derived cache (`_block`, `_edgeOv`…)
   * that travelled with the content: those belong to whoever computed them. Safe to run again.
   */
  function tidyMaps(c) {
    var maps = c.maps || {};
    Object.keys(maps).forEach(function (id) {
      var m = maps[id]; if (!m) return;
      Object.keys(m).forEach(function (k) { if (k.charAt(0) === '_') delete m[k]; });
      m.entities = (m.entities || []).filter(function (e) { return e && str(e.ref); });
      m.entities.forEach(function (e) {
        if (!e.data || typeof e.data !== 'object') e.data = json(e.data, {});
        if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) e.data = {};
        e.x = num(e.x, 0); e.y = num(e.y, 0);
      });
      if (typeof m.spawn === 'string') m.spawn = json(m.spawn, null);
    });
    return c;
  }
  function linkFloors(c) {
    tidyMaps(c);
    var maps = c.maps || {}, ids = Object.keys(maps);
    // Recovery: a floor saved through a referee from before floors existed comes back WITHOUT floor_of / z (that
    // referee stores a fixed list of fields and drops the rest), which would turn it into a second, separate map
    // with the building's name. The id the editor gave it still says what it is — "<ground>_z1", "<ground>_zm1" —
    // so, here and only here, a map with no floor fields, such an id, an existing ground map and the same size is
    // taken back into its building. (Everywhere else the id is never read: see docs/FLOORS.md.)
    ids.forEach(function (id) {
      var m = maps[id]; if (m.floorOf) return;
      var hit = /^(.+)_z(m?)(\d+)x*$/.exec(id), g = hit && maps[hit[1]];
      if (g && g !== m && !g.floorOf && Number(hit[3]) > 0 && g.width === m.width && g.height === m.height) {
        m.floorOf = hit[1]; m.z = (hit[2] ? -1 : 1) * Number(hit[3]);
      }
    });
    ids.forEach(function (id) {
      var m = maps[id], g = m.floorOf && m.floorOf !== id ? maps[m.floorOf] : null;
      m.z = g && !g.floorOf ? Math.round(Number(m.z) || 0) : 0;
      if (!m.z) m.floorOf = '';
      m.floors = null;
    });
    ids.forEach(function (id) { if (!maps[id].floorOf) { maps[id].floors = {}; maps[id].floors[0] = id; } });
    ids.forEach(function (id) {
      var m = maps[id]; if (!m.floorOf) return;
      var fam = maps[m.floorOf].floors;
      if (fam[m.z]) { m.floorOf = ''; m.z = 0; m.floors = {}; m.floors[0] = id; return; }      // level already taken
      fam[m.z] = id; m.floors = fam;
    });
    return c;
  }

  /**
   * Gives every ground map the empty storeys above it that players may build on (roofs, a second storey): Config
   * auto_floors levels (default 2; 0 = none), wherever the map has no such floor of its own. They are ordinary
   * floors (docs/FLOORS.md) with nothing on them, marked auto, and exist only in the built content — never in the
   * data, so the map editor does not see them. For the GAME only (referee, game page, LAN host): the editors do not
   * call this. Safe to run again, and on content that already carries them.
   */
  function autoFloors(c) {
    tidyMaps(c);
    var cfg = c.config || {}, n = cfg.auto_floors === undefined || cfg.auto_floors === '' ? 2 : Math.round(Number(cfg.auto_floors));
    if (!(n > 0) || String(cfg.build || 'on') === 'off') return c;
    var maps = c.maps || {}, added = false;
    Object.keys(maps).forEach(function (id) {
      var g = maps[id]; if (g.floorOf || g.auto || !(g.width > 0 && g.height > 0)) return;
      for (var z = 1; z <= n; z++) {
        var fid = id + '_z' + z;
        if ((g.floors && g.floors[z]) || maps[fid]) continue;
        var rows = [];
        for (var y = 0; y < g.height; y++) { var row = []; for (var x = 0; x < g.width; x++) row.push(''); rows.push(row); }
        maps[fid] = { id: fid, name: g.name, width: g.width, height: g.height, terrain: rows, overlay: [], vWalls: [], hWalls: [], roof: [],
          nobuild: g.nobuild || [], roof_color: g.roof_color || '', floorOf: id, z: z, spawn: null, shapes: {}, overlayShapes: {}, entities: [], auto: true };
        added = true;
      }
    });
    if (added) linkFloors(c);
    return c;
  }

  /** Rows of a sheet (first row = headers) -> list of records. */
  function recordsFromValues(values) {
    if (!values || !values.length) return [];
    var head = values[0].map(function (h) { return str(h); });
    var out = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i], rec = {}, any = false;
      for (var j = 0; j < head.length; j++) {
        if (!head[j]) continue;
        rec[head[j]] = row[j];
        if (row[j] !== '' && row[j] != null) any = true;
      }
      if (any) out.push(rec);
    }
    return out;
  }

  /** Short fingerprint of any data, to notice whether a tab or map changed since it was loaded. */
  function hash(v) {
    var s = JSON.stringify(v === undefined ? null : v), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36) + '.' + s.length;
  }
  /** Fingerprint of one map as stored: its Maps row and its MapEntities rows. */
  function mapHash(tables, id) {
    var row = (tables.Maps || []).filter(function (r) { return str(r.id) === id; })[0] || null;
    var ents = (tables.MapEntities || []).filter(function (r) { return str(r.map) === id; });
    return hash({ row: row, ents: ents });
  }

  return { build: build, recordsFromValues: recordsFromValues, bool: bool, hash: hash, mapHash: mapHash, ITEM_TYPES: ITEM_TYPES, toolTags: toolTags, linkFloors: linkFloors, GOAL_TYPES: GOAL_TYPES, UI_PARTS: UI_PARTS, parseGoals: parseGoals, autoFloors: autoFloors, tidyMaps: tidyMaps };
})();
if (typeof module !== 'undefined') module.exports = Content;
