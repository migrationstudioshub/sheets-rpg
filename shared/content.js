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

  function build(tables) {
    var c = { config: {}, tilesets: {}, autotile: {}, terrain: {}, kinds: {}, objects: {}, maps: {} };

    (tables.Config || []).forEach(function (r) { if (str(r.key)) c.config[str(r.key)] = scalar(r.value); });

    (tables.Tilesets || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.tilesets[id] = { id: id, image: str(r.image), tileSize: num(r.tile_size, 32),
        columns: num(r.columns, 8), layout: str(r.layout) };
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
        frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200),
        pass: { n: bool(r.pass_n), e: bool(r.pass_e), s: bool(r.pass_s), w: bool(r.pass_w) } };
    });

    (tables.Kinds || []).forEach(function (r) {
      var k = str(r.kind); if (!k) return;
      var kind = c.kinds[k] = c.kinds[k] || { kind: k, states: [], props: {} };
      var p = str(r.property);
      if (p === 'states') kind.states = str(r['default']).split('|').filter(Boolean);
      else if (p) kind.props[p] = { type: str(r.type), 'default': scalar(r['default']), notes: str(r.notes) };
    });

    (tables.Objects || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      var pr = json(r.properties, {});
      c.objects[id] = { id: id, name: str(r.name) || id, kind: str(r.kind) || 'deco',
        sprite: str(r.sprite), spriteTop: str(r.sprite_top), spriteStates: pairs(r.sprite_states), walkable: bool(r.walkable),
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
        frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200),
        properties: pr, onInteract: str(r.on_interact) };
    });

    (tables.Maps || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      var grid = decodeGrid(json(r.terrain, []));
      // Optional second terrain grid drawn on top of the base (overlay autotiles, transparent outside their
      // shape). Absent/empty on older maps, which then behave exactly as before (base layer only).
      var overlay = decodeGrid(json(r.overlay, []));
      // Frozen autotile shapes from shift-click mapping: sparse { "x,y": mask } per layer, render-only.
      c.maps[id] = { id: id, name: str(r.name) || id, width: num(r.width, grid[0] ? grid[0].length : 0),
        height: num(r.height, grid.length), terrain: grid, overlay: overlay,
        shapes: json(r.shapes, {}), overlayShapes: json(r.overlayShapes, {}), entities: [] };
    });

    (tables.MapEntities || []).forEach(function (r) {
      var m = c.maps[str(r.map)]; if (!m || !str(r.ref)) return;
      m.entities.push({ key: str(r.key), x: num(r.x, 0), y: num(r.y, 0), ref: str(r.ref), data: json(r.data, {}) });
    });

    c.items = {}; c.monsters = {}; c.loot = {}; c.classes = {}; c.levels = []; c.appearances = {};
    (tables.Items || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.items[id] = { id: id, name: str(r.name) || id, sprite: str(r.sprite), type: str(r.type) || 'material',
        slot: str(r.slot), wornSprite: str(r.worn_sprite), defaultTint: str(r.default_tint),
        stackMax: num(r.stack_max, 99), value: num(r.value, 0),
        atk: num(r.atk, 0), def: num(r.def, 0), heal: num(r.heal, 0), mp: num(r.mp, 0),
        hunger: num(r.hunger, 0), thirst: num(r.thirst, 0),
        // equip_if gates equipping a weapon/armor (e.g. a rifle at level 3)
        equipIf: str(r.equip_if),
        // a ranged weapon: range > 0, spends `ammo` per shot, fires no faster than fire_ms;
        // clip = magazine size (fire from the loaded mag; press R to refill it from the ammo stack)
        range: num(r.range, 0), ammo: str(r.ammo), ammoCost: Math.max(1, num(r.ammo_cost, 1)), fireMs: num(r.fire_ms, 0), clip: num(r.clip, 0),
        tint: str(r.tint),
        // ammo: how many enemies one shot pierces, losing `falloff` of its damage per extra hit (0..1)
        penetration: Math.max(1, num(r.penetration, 1)), falloff: Math.max(0, Math.min(1, num(r.falloff, 0))),
        // type 'throwable' (grenade/molotov): area damage + status at a thrown spot, up to throw_range away
        throwRange: num(r.throw_range, 0), throwArea: num(r.throw_area, 0), throwPower: num(r.throw_power, 0),
        throwStatus: str(r.throw_status), throwStatusMs: num(r.throw_status_ms, 0),
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
      (c.loot[t] = c.loot[t] || []).push({ item: it, chance: num(r.chance, 1), min: num(r.min, 1), max: num(r.max, num(r.min, 1)) });
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

  return { build: build, recordsFromValues: recordsFromValues, bool: bool, hash: hash, mapHash: mapHash };
})();
if (typeof module !== 'undefined') module.exports = Content;
