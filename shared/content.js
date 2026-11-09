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
      c.terrain[id] = { id: id, name: str(r.name) || id, color: str(r.color) || '#000000',
        sprite: str(r.sprite), autotile: str(r.autotile), frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200),
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
      c.objects[id] = { id: id, name: str(r.name) || id, kind: str(r.kind) || 'deco',
        sprite: str(r.sprite), spriteTop: str(r.sprite_top), spriteStates: pairs(r.sprite_states), walkable: bool(r.walkable),
        blocksSight: bool(r.blocks_sight),
        frames: num(r.frames, 1), frameMs: num(r.frame_ms, 200),
        properties: json(r.properties, {}), onInteract: str(r.on_interact) };
    });

    (tables.Maps || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      var grid = json(r.terrain, []);
      c.maps[id] = { id: id, name: str(r.name) || id, width: num(r.width, grid[0] ? grid[0].length : 0),
        height: num(r.height, grid.length), terrain: grid, entities: [] };
    });

    (tables.MapEntities || []).forEach(function (r) {
      var m = c.maps[str(r.map)]; if (!m || !str(r.ref)) return;
      m.entities.push({ key: str(r.key), x: num(r.x, 0), y: num(r.y, 0), ref: str(r.ref), data: json(r.data, {}) });
    });

    c.items = {}; c.monsters = {}; c.loot = {}; c.classes = {}; c.levels = [];
    (tables.Items || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.items[id] = { id: id, name: str(r.name) || id, sprite: str(r.sprite), type: str(r.type) || 'material',
        slot: str(r.slot), wornSprite: str(r.worn_sprite), defaultTint: str(r.default_tint),
        stackMax: num(r.stack_max, 99), value: num(r.value, 0),
        atk: num(r.atk, 0), def: num(r.def, 0), heal: num(r.heal, 0), mp: num(r.mp, 0), onUse: str(r.on_use) };
    });
    (tables.Monsters || []).forEach(function (r) {
      var id = str(r.id); if (!id) return;
      c.monsters[id] = { id: id, name: str(r.name) || id, sprite: str(r.sprite), hp: num(r.hp, 10),
        atk: num(r.atk, 3), def: num(r.def, 0), xp: num(r.xp, 1), goldMin: num(r.gold_min, 0), goldMax: num(r.gold_max, 0),
        lootTable: str(r.loot_table), aggro: num(r.aggro_range, 4), moveMs: Math.max(150, num(r.move_ms, 800)),
        respawnS: num(r.respawn_s, 60) };
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
        dash: bool(r.dash), projectile: bool(r.projectile), onCast: str(r.on_cast), description: str(r.description) };
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
