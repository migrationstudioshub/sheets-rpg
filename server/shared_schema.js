// GENERATED from shared/schema.js by tools/sync_server.sh. Edit the original, not this copy.
/**
 * Content schema: one definition per content type, describing its fields.
 *
 * This is the backbone of the content database migration. It is the single source of truth for:
 *   - the Content Studio, which generates create/edit forms from these field lists;
 *   - publish validation (the Cloud Function checks records against the schema);
 *   - what each Firestore collection holds.
 *
 * It mirrors exactly the columns `shared/content.js` already reads, so `Content.build` keeps working
 * unchanged — the records in Firestore are the same rows the Game Data sheet holds today.
 *
 * Classic script (runs in the browser, in Node tooling, and in the Cloud Function), like the other
 * shared files. Look other shared globals up lazily; this one has no dependencies.
 *
 * Field: { key, type, def, label?, help?, options?, ref?, of? }
 *   type: 'text' | 'textarea' | 'number' | 'bool' | 'color' | 'image' | 'select' | 'ref' | 'list' | 'json'
 *   options: for 'select', the allowed values (the form still allows a custom value)
 *   ref:     for 'ref', the content type whose ids this points at (e.g. 'items', 'loot')
 *   of:      for 'list', a short note on each element's shape (e.g. 'skill@level')
 * A type entry: { collection, id, label, singular?, authored, fields:[...] }
 *   collection: Firestore collection name            id: the field that is the doc id
 *   authored:   'studio' (hand-edited in the Content Studio) | 'map' (the map editor) | 'generated'
 */
var Schema = (function () {
  function f(key, type, def, help, extra) {
    var o = { key: key, type: type, def: def === undefined ? '' : def };
    if (help) o.help = help;
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }

  var TYPES = {
    // ---- simple settings ----
    config: { collection: 'config', id: 'key', label: 'Config', singular: 'setting', authored: 'studio', fields: [
      f('key', 'text', '', 'Setting name, e.g. tile_size'),
      f('value', 'text', '', 'Number, true/false, or text')
    ] },

    // ---- world building blocks ----
    tilesets: { collection: 'tilesets', id: 'id', label: 'Tilesets', authored: 'studio', fields: [
      f('id', 'text', ''), f('image', 'image', '', 'Path or URL of the tile sheet'),
      f('tile_size', 'number', 32), f('columns', 'number', 8),
      f('layout', 'text', 'blob47_craftpix', 'Autotile layout name'), f('notes', 'text', '')
    ] },
    autotile: { collection: 'autotile', id: null, label: 'Autotile', authored: 'generated', fields: [
      f('layout', 'text', ''), f('mask', 'number', 0, '0–255 neighbour mask'),
      f('tiles', 'text', '', 'Comma list of 1-based tile indices')
    ] },
    terrain: { collection: 'terrain', id: 'id', label: 'Terrain', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('sprite', 'image', '', 'Non-autotiled sprite (optional)'),
      f('autotile', 'ref', '', 'Autotiled: which tileset', { ref: 'tilesets' }),
      f('layer', 'select', 'base', 'Layer this paints on by default: base (opaque ground) or overlay (transparent, sits on top of the ground)', { options: ['base', 'overlay'] }),
      f('frames', 'number', 1), f('frame_ms', 'number', 200),
      f('pass_n', 'bool', true, 'Can leave northward'), f('pass_e', 'bool', true),
      f('pass_s', 'bool', true), f('pass_w', 'bool', true), f('notes', 'text', '')
    ] },
    kinds: { collection: 'kinds', id: null, label: 'Kinds', authored: 'studio', fields: [
      f('kind', 'text', '', 'Object kind, e.g. container'),
      f('property', 'text', '', 'Property name, or "states"'),
      f('type', 'text', '', 'Field type for the editor'),
      f('default', 'text', ''), f('notes', 'text', '')
    ] },
    objects: { collection: 'objects', id: 'id', label: 'Objects', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('kind', 'select', 'deco', 'What it does', { options: ['deco', 'container', 'door', 'switch', 'trap', 'rest', 'sign', 'npc', 'spawn', 'teleport', 'trigger', 'craft'] }),
      f('sprite', 'image', ''), f('sprite_top', 'image', '', 'Upper tile for tall objects'),
      f('sprite_states', 'text', '', 'state=sprite pairs, e.g. open=url; empty=url'),
      f('frames', 'number', 1), f('frame_ms', 'number', 200),
      f('walkable', 'bool', false, 'Can you walk onto it? Off = solid (a wall, a table). Independent of sight.'),
      f('blocks_sight', 'bool', false, 'Does it block line of sight and shots? Off = you can see and shoot across it (e.g. a table you can fire over but not walk through).'),
      f('properties', 'json', '', 'JSON of kind-specific settings'),
      f('on_interact', 'text', '', 'Data-driven action list'), f('notes', 'text', '')
    ] },

    // ---- the types the owner most wants to author ----
    items: { collection: 'items', id: 'id', label: 'Items', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('sprite', 'image', ''),
      f('type', 'select', 'material', '', { options: ['material', 'weapon', 'armor', 'consumable', 'throwable', 'ammo', 'key'] }),
      f('slot', 'text', '', 'Equip slot (weapon, armor, helm…)'),
      f('worn_sprite', 'image', '', 'Paper-doll layer when equipped'),
      f('default_tint', 'text', '', 'Tint preset for the worn layer'),
      f('stack_max', 'number', 99), f('value', 'number', 0, 'Gold value'),
      f('atk', 'number', 0), f('def', 'number', 0), f('heal', 'number', 0), f('mp', 'number', 0),
      f('hunger', 'number', 0), f('thirst', 'number', 0),
      f('equip_if', 'text', '', 'Condition to equip, e.g. level:3'),
      f('range', 'number', 0, 'Ranged weapon range (0 = melee)'),
      f('ammo', 'ref', '', 'Item spent per shot', { ref: 'items' }),
      f('ammo_cost', 'number', 1), f('fire_ms', 'number', 0, 'Min time between shots'),
      f('clip', 'number', 0, 'Magazine size (R to reload)'),
      f('fire_mode', 'select', '', 'single = one shot per click; semi/auto = hold to keep firing', { options: ['single', 'semi', 'auto'] }),
      f('aim', 'aim', '', 'Weapon aim setup: drag the pivot (rotation axis) and the barrel tip onto the sprite so it points at the cursor'),
      f('tint', 'text', ''),
      f('penetration', 'number', 1, 'Enemies one shot pierces'),
      f('falloff', 'number', 0, 'Damage lost per extra hit (0–1)'),
      f('throw_range', 'number', 0), f('throw_area', 'number', 0), f('throw_power', 'number', 0),
      f('throw_status', 'ref', '', '', { ref: 'statuses' }), f('throw_status_ms', 'number', 0),
      f('on_use', 'textarea', '', 'Data-driven action list')
    ] },
    monsters: { collection: 'monsters', id: 'id', label: 'Monsters', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('sprite', 'image', ''),
      f('hp', 'number', 10), f('atk', 'number', 3), f('def', 'number', 0), f('xp', 'number', 1),
      f('gold_min', 'number', 0), f('gold_max', 'number', 0),
      f('loot_table', 'ref', '', '', { ref: 'loot' }),
      f('aggro_range', 'number', 4), f('move_ms', 'number', 800), f('respawn_s', 'number', 60),
      f('attack_range', 'number', 0, '0 = melee; >1 = ranged'), f('ranged_cooldown_ms', 'number', 1500),
      f('ranged_projectile', 'bool', false), f('ranged_status', 'ref', '', '', { ref: 'statuses' }),
      f('infect_chance', 'number', 0, 'Chance a hit infects (0–1)'),
      f('appearance', 'looks', '', 'Paper-doll sets rolled per spawn — add more than one (e.g. male/female) and one is picked by weight (blank = use the flat sprite)', { ref: 'appearances' })
    ] },
    appearances: { collection: 'appearances', id: 'id', label: 'Appearances', singular: 'appearance set', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      // layers are edited by the Content Studio's dedicated appearance editor, not a raw field
      f('layers', 'json', '', 'Ordered paper-doll layers, each a weighted pool of sprites')
    ] },
    loot: { collection: 'loot', id: null, label: 'Loot tables', singular: 'drop', authored: 'studio', fields: [
      f('table', 'text', '', 'Table name a monster/chest references'),
      f('item', 'ref', '', '', { ref: 'items' }),
      f('chance', 'number', 1, '0–1'), f('min', 'number', 1), f('max', 'number', 1)
    ] },
    classes: { collection: 'classes', id: 'id', label: 'Classes', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('body_sprite', 'image', '', 'Paper-doll base body'),
      f('hp', 'number', 100), f('atk', 'number', 5), f('def', 'number', 1),
      f('hp_per_level', 'number', 10), f('atk_per_level', 'number', 1), f('def_per_level', 'number', 1),
      f('mp', 'number', 0), f('mp_per_level', 'number', 0), f('mp_regen', 'number', 0),
      f('start_items', 'list', '', 'item:count list', { of: 'item:count' }),
      f('lockpicking', 'number', 0),
      f('skills', 'list', '', 'skill@level list', { of: 'skill@level' }), f('notes', 'text', '')
    ] },
    skills: { collection: 'skills', id: 'id', label: 'Skills', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('icon', 'image', ''), f('color', 'color', '#cccccc'),
      f('mp', 'number', 0), f('cooldown_ms', 'number', 1000), f('range', 'number', 1),
      f('target', 'select', 'enemy', '', { options: ['enemy', 'ally', 'self', 'tile', 'around'] }),
      f('area', 'number', 0), f('los', 'bool', false, 'Needs line of sight'),
      f('effect', 'select', 'damage', '', { options: ['damage', 'heal', 'none'] }),
      f('power', 'number', 0), f('stat', 'select', '', 'Stat the power scales with', { options: ['atk', 'level'] }),
      f('scale', 'number', 0), f('status', 'ref', '', '', { ref: 'statuses' }), f('status_ms', 'number', 0),
      f('dash', 'bool', false), f('projectile', 'bool', false),
      f('ammo', 'ref', '', 'Item spent to cast', { ref: 'items' }), f('ammo_cost', 'number', 1),
      f('on_cast', 'textarea', ''), f('description', 'textarea', '')
    ] },
    statuses: { collection: 'statuses', id: 'id', label: 'Statuses', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('kind', 'text', '', 'e.g. burn, chill, stun, bleed'),
      f('amount', 'number', 0, 'Per-tick effect'), f('tick_ms', 'number', 1000),
      f('atk', 'number', 0, 'Attack modifier'), f('def', 'number', 0, 'Defence modifier'),
      f('slow', 'number', 1, 'Move-speed multiplier'), f('color', 'color', '')
    ] },
    levels: { collection: 'levels', id: null, label: 'Levels', singular: 'level', authored: 'studio', fields: [
      f('level', 'number', 1), f('xp_needed', 'number', 0, 'Total XP to reach this level')
    ] },

    // ---- edited by the map editor, not the Content Studio forms ----
    maps: { collection: 'maps', id: 'id', label: 'Maps', authored: 'map', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('width', 'number', 0), f('height', 'number', 0),
      f('terrain', 'json', '', 'Compact-encoded terrain grid'), f('notes', 'text', '')
    ] },
    mapEntities: { collection: 'mapEntities', id: 'key', label: 'Map entities', authored: 'map', fields: [
      f('map', 'ref', '', '', { ref: 'maps' }), f('key', 'text', ''),
      f('x', 'number', 0), f('y', 'number', 0), f('ref', 'ref', '', '', { ref: 'objects' }),
      f('data', 'json', '', 'Per-placement property overrides')
    ] }
  };

  // The Game Data tab name each content type maps to (so `Content.build(tables)` keeps working:
  // records come from Firestore collections but are assembled into the same `tables` shape).
  var TAB = {
    config: 'Config', tilesets: 'Tilesets', autotile: 'Autotile', terrain: 'Terrain', kinds: 'Kinds',
    objects: 'Objects', items: 'Items', monsters: 'Monsters', loot: 'LootTables', classes: 'Classes',
    skills: 'Skills', statuses: 'Statuses', levels: 'Levels', appearances: 'Appearances',
    maps: 'Maps', mapEntities: 'MapEntities'
  };

  function get(type) { return TYPES[type]; }
  function list() { return Object.keys(TYPES); }
  function authored(kind) { return list().filter(function (t) { return TYPES[t].authored === kind; }); }
  function defaults(type) {
    var t = TYPES[type], o = {};
    if (t) t.fields.forEach(function (fl) { o[fl.key] = fl.def; });
    return o;
  }
  function tabOf(type) { return TAB[type]; }

  return { TYPES: TYPES, TAB: TAB, get: get, list: list, authored: authored, defaults: defaults, tabOf: tabOf };
})();
if (typeof module !== 'undefined') module.exports = Schema;
