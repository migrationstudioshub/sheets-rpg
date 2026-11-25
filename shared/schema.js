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

  // The tints a terrain may take (the colours themselves are the page's Tint.TINTS).
  var TERRAIN_TINTS = ['water_teal', 'water_blue', 'water_swamp', 'water_toxic', 'water_blood', 'lava', 'lava_blue', 'lava_toxic'];
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
      f('layout', 'text', 'blob47_craftpix', 'Autotile layout name'),
      f('frames', 'number', 1, 'Animated sheet (water, lava…): how many frames the image holds — whole sheets side by side, left to right. 1 = a still sheet'),
      f('frame_ms', 'number', 200, 'Animated sheet: milliseconds each frame stays'),
      f('notes', 'text', '')
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
      f('frames', 'number', 1, 'Animation: how many frames the picture holds, side by side. For an autotiled terrain this may be set here or on its tileset'), f('frame_ms', 'number', 200, 'Animation: milliseconds each frame stays'),
      f('tint', 'select', '', 'Autotiled: recolours a sheet that has a .tint.png mask next to it (the water and lava sheets). Empty = the sheet as drawn', { options: TERRAIN_TINTS }),
      f('fall', 'image', '', 'Waterfall: the moving strip drawn down a cliff where this terrain lies at the top of it (frames side by side, each four tiles wide: single, left, middle, right). Empty = water uses the standard waterfall, other terrains have none'),
      f('grows', 'items', '', 'Items that appear on this ground by themselves, to be picked up (plant fibre in the grass). Works on the base and on the overlay: it grows where this terrain is the ground you see. Needs grow_s'),
      f('grow_s', 'number', 0, 'Growing: seconds for ONE item to appear per 100 tiles of this terrain (60 = a 300-tile meadow grows three a minute). 0 = nothing grows. Only while someone is on the map; time away is caught up, within limits'),
      f('grow_max', 'number', 2, 'Growing: how thin it stays. Nothing new grows on a tile that already has this many of the item lying within 5 tiles of it (about 100 tiles), until some are picked up'),
      f('build_over', 'bool', false, 'Open ground (grass, dirt, sand…): players may lay a floor on top of it. Leave off for real floors and for anything that must not be covered (water, roads)'),
      f('pass_n', 'bool', true, 'Can leave northward'), f('pass_e', 'bool', true),
      f('pass_s', 'bool', true), f('pass_w', 'bool', true),
      f('see_through', 'bool', false, 'Ground nobody can walk on normally hides what is behind it, like a wall. Tick this for flat ground that only stops walking — a pit, a chasm: you see and shoot across it. Water sources and the tinted water / lava sheets are always seen across, ticked or not'),
      f('water', 'bool', false, 'A water source: a player next to it can drink from it (Config water_thirst) and fill empty containers (items with fills_into). A terrain with "water" in its name counts as one until this is set'),
      f('toxicity', 'number', '', 'Water source: toxicity one drink adds. Empty = Config water_toxicity (8). 0 = clean water'),
      f('notes', 'text', '')
    ] },
    wallStyles: { collection: 'wallStyles', id: 'id', label: 'Wall styles', singular: 'wall style', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('cap', 'image', '', 'Top sprite drawn along the top of the wall (1 tile wide)'),
      f('face', 'image', '', 'Front face — a 1-tile-wide strip that repeats vertically to any height (extruded look)'),
      f('color', 'color', '#8a8f98', 'Fallback colour drawn when the sprites are missing'),
      f('blocks_move', 'bool', true, 'Blocks walking across this edge'),
      f('blocks_sight', 'bool', true, 'Blocks line of sight and shots across this edge'),
      f('hp', 'number', 0, 'Health of one wall segment. 0 = cannot be damaged'),
      f('armor', 'number', 0, 'Taken off every hit'),
      f('material', 'select', 'stone', 'What it is made of: decides how hard blows, bullets, blasts and fire land', { options: ['wood', 'metal', 'stone', 'glass', 'flesh'] }),
      f('breakable', 'bool', false, 'Walls of this style painted in the map editor can be damaged (needs hp above 0)'),
      f('salvage', 'items', '', 'Items handed to whoever breaks it'),
      f('notes', 'text', '')
    ] },
    kinds: { collection: 'kinds', id: null, label: 'Object Kinds', authored: 'studio', fields: [
      f('kind', 'text', '', 'Object kind, e.g. container'),
      f('property', 'text', '', 'Property name, or "states"'),
      f('type', 'text', '', 'Field type for the editor'),
      f('default', 'text', ''), f('notes', 'text', '')
    ] },
    objects: { collection: 'objects', id: 'id', label: 'Objects', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('kind', 'select', 'deco', 'What it does', { options: ['deco', 'container', 'door', 'switch', 'trap', 'rest', 'sign', 'npc', 'spawn', 'teleport', 'trigger', 'craft', 'claim', 'stairs', 'pickup', 'coop'] }),
      f('sprite', 'image', ''),
      f('sprite_states', 'text', '', 'state=sprite pairs, e.g. open=url; empty=url. Also holds the other directions (north=, side=) and the other looks (v1=, v2=, …: the same object drawn differently, chosen in the map editor)'),
      f('frames', 'number', 1), f('frame_ms', 'number', 200),
      f('walkable', 'bool', false, 'Can you walk onto it? Off = solid (a wall, a table). Independent of sight.'),
      f('blocks_sight', 'bool', false, 'Does it block line of sight and shots? Off = you can see and shoot across it (e.g. a table you can fire over but not walk through).'),
      f('properties', 'json', '', 'JSON of kind-specific settings'),
      f('on_interact', 'text', '', 'Data-driven action list'), f('notes', 'text', '')
    ] },

    // ---- the types the owner most wants to author ----
    itemTypes: { collection: 'itemTypes', id: 'id', label: 'Item Types', singular: 'item type', authored: 'studio', fields: [
      f('id', 'text', '', 'Short name the items refer to: lower-case letters, numbers and _'), f('name', 'text', '', 'Heading shown in the Items list'),
      f('equip', 'bool', false, 'Can be equipped: worn or held in a slot. Shows slot, worn art, attack, defence'),
      f('slot', 'text', '', 'Where items of this type go when equipped: weapon, helm (head), armor (chest), pants, feet, gloves, back, or accessory (four can be worn). An item can name its own slot'),
      f('shoot', 'bool', false, 'A ranged weapon when equipped and given a range: fires on click. Shows range, ammo, magazine, aim'),
      f('consume', 'bool', false, 'Can be used: one is used up each time. Shows heal, mana, hunger, thirst, on_use'),
      f('cooldown_s', 'number', 0, 'Seconds to wait before using another of the same item (0 = none). An item can set its own'),
      f('throw', 'bool', false, 'Can be thrown from the belt. Shows the throw fields'),
      f('ammo', 'bool', false, 'Is ammunition. Only shows the ammo fields (pierce, falloff) on the item'),
      f('tool', 'bool', false, 'A tool. Shows the tool fields on the item; if the type is not equipped, its items count as tools by their own id with no tag needed'),
      f('properties', 'propdefs', '', 'Extra settings of your own for items of this type. The game stores them with the item; no rule reads them yet'),
      f('notes', 'text', '')
    ] },
    items: { collection: 'items', id: 'id', label: 'Items', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('sprite', 'image', ''),
      f('type', 'select', 'material', '', { options: ['material', 'weapon', 'armor', 'consumable', 'throwable', 'ammo', 'key'] }),
      f('slot', 'text', '', 'Equip slot: weapon, helm (head), armor (chest), pants, feet, gloves, back, or accessory (four can be worn). Empty = the slot of its type'),
      f('worn_sprite', 'image', '', 'Paper-doll layer when equipped. For a weapon that shoots: loaded and held at rest (a bow with an arrow on the string, not drawn)'),
      f('worn_empty', 'image', '', 'A weapon with a magazine (clip), held with nothing loaded: a bow with no arrow on the string. Also shown while the next one is being loaded, unless there is a reloading picture. Empty = the worn sprite'),
      f('worn_aim', 'image', '', 'The weapon loaded and being aimed (right mouse button held): a bow drawn back. Empty = the worn sprite. Draw them all on the same canvas, so the aim points fit every one'),
      f('worn_reload', 'image', '', 'Optional: the weapon while it is being reloaded (reload_ms). Empty = the worn-empty picture'),
      f('default_tint', 'tint', '', 'The colour of the worn layer (needs the sprite to have a .tint.png mask next to it). No tint = drawn as it is'),
      f('stack_max', 'number', 99), f('value', 'number', 0, 'Gold value'),
      f('atk', 'number', 0), f('def', 'number', 0), f('heal', 'number', 0), f('mp', 'number', 0),
      f('hunger', 'number', 0), f('thirst', 'number', 0),
      f('toxicity', 'number', 0, 'What using it adds to the toxicity gauge (0-100). Negative = it clears that much (a cure)'),
      f('leaves', 'ref', '', 'The item left in the bag when this one is used up: an empty bottle, an empty can', { ref: 'items' }),
      f('fills_into', 'ref', '', 'For an empty container: the item it becomes when filled at a water source (an empty bottle → a bottle of dirty water). Empty = cannot be filled', { ref: 'items' }),
      f('equip_if', 'text', '', 'Condition to equip, e.g. level:3'),
      f('range', 'number', 0, 'Ranged weapon range (0 = melee)'),
      f('ammo', 'ref', '', 'Item spent per shot', { ref: 'items' }),
      f('ammo_cost', 'number', 1), f('fire_ms', 'number', 0, 'Min time between shots'),
      f('clip', 'number', 0, 'Magazine size (R to reload)'),
      f('reload_ms', 'number', 0, 'How long a reload takes, in milliseconds (0 = the Config reload_ms, 1500 if that is unset)'),
      f('fire_mode', 'select', '', 'single = one shot per click; semi/auto = hold to keep firing', { options: ['single', 'semi', 'auto'] }),
      f('aim', 'aim', '', 'Weapon aim setup: drag the pivot (rotation axis) and the barrel tip onto the sprite so it points at the cursor'),
      f('tint', 'text', ''),
      f('penetration', 'number', 1, 'Enemies one shot pierces'),
      f('falloff', 'number', 0, 'Damage lost per extra hit (0–1)'),
      f('throw_range', 'number', 0), f('throw_area', 'number', 0), f('throw_power', 'number', 0),
      f('throw_status', 'ref', '', '', { ref: 'statuses' }), f('throw_status_ms', 'number', 0),
      f('tool', 'text', '', 'Tool tags this item counts as, e.g. hammer or axe (recipes and harvesting can require one). Empty on an item of a tool type = it counts as a tool by its own id'),
      f('structure_dmg', 'number', 0, 'Damage per hit to walls and objects (0 = half its attack)'),
      f('fuel_s', 'number', 0, 'Fuel: seconds one piece burns in a campfire or other cooker (0 = it does not burn)'),
      f('material_dmg', 'materials', '', 'What it is good against: its blows on walls and objects of a material are multiplied by this (axe: wood ×3, pickaxe: stone ×8). Under 1 = worse than bare hands on that material'),
      f('burns', 'bool', false, 'Throwables: the blast also burns wooden walls and objects'),
      f('on_use', 'textarea', '', 'Data-driven action list'),
      f('cooldown_s', 'number', '', 'Seconds to wait before using another one (empty = the cooldown of its type)'),
      f('props', 'itemprops', '', 'The extra settings its type defines')
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
      f('brain', 'select', '', 'How it thinks. Empty = plain: it goes for any player within aggro_range, even through walls, and forgets them when they step out. walker = it must SEE its target, remembers it, searches where it lost it, and breaks what is in its way. animal = it never attacks: it wanders, and runs from players and hunters that come within flee_range. hunter = it goes after prey animals and players within aggro_range (a wolf)', { options: ['walker', 'animal', 'hunter'] }),
      f('sight_range', 'number', 0, 'Walker: how many tiles away it can spot a target, with a clear line of sight (0 = aggro_range). Once it is after someone, aggro_range is how close it still hears them through walls'),
      f('aggro_s', 'number', 0, 'Walker: seconds it keeps looking after losing sight of its target (0 = 30). Time only runs while someone is on the map'),
      f('structure_dmg', 'number', 0, 'Walker: damage per blow to doors, windows, walls and objects in its way (0 = its atk)'),
      f('prey', 'bool', false, 'An animal: walkers and hunters go after it like they go after players'),
      f('flee_range', 'number', 0, 'Animal: how many tiles away a player or a hunter makes it run (0 = aggro_range). Hurt, it runs from whoever hurt it'),
      f('loot', 'items', '', 'What it gives when killed, always (the loot table above is the lucky extras). With a carcass set it is found inside the carcass, together with what the loot table rolled; with none both go straight into the bag of whoever killed it'),
      f('carcass', 'ref', '', 'The object it leaves on the ground when killed: an object of kind container. Open it like any container to take the loot. It disappears once emptied, or after Config carcass_rot_s (5 minutes). Empty = no carcass: the loot is given at once', { ref: 'objects' }),
      f('tame_with', 'ref', '', 'Animal: the item that tames it. Holding it, the animal does not run from you; use the animal to feed it one and make it yours', { ref: 'items' }),
      f('lays', 'items', '', 'What a tame one living at a coop leaves on the ground now and then, to be picked up (eggs)'),
      f('lay_s', 'number', 0, 'Seconds between two of those (only while someone is on the map)'),
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
      f('chance', 'number', 1, '0–1'), f('min', 'number', 1), f('max', 'number', 1),
      f('quest', 'ref', '', 'A quest drop: this row only rolls for a player who is on that quest and still needs the item (the quest must have a have: objective for it). Empty = for everyone', { ref: 'quests' })
    ] },
    classes: { collection: 'classes', id: 'id', label: 'Classes', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('body_sprite', 'image', '', 'Not used any more when Config body_male is set: every class shares the male / female bodies named in Config (body_male, body_female)'),
      f('hp', 'number', 100), f('atk', 'number', 5), f('def', 'number', 1),
      f('hp_per_level', 'number', 10), f('atk_per_level', 'number', 1), f('def_per_level', 'number', 1),
      f('mp', 'number', 0), f('mp_per_level', 'number', 0), f('mp_regen', 'number', 0),
      f('start_items', 'list', '', 'What a new character of this class starts with', { of: 'item:count' }),
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

    blueprints: { collection: 'blueprints', id: 'id', label: 'Blueprints', singular: 'blueprint', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('category', 'select', 'walls', 'Tab in the build menu', { options: ['walls', 'floors', 'doors', 'furniture', 'stations', 'defences', 'other'] }),
      f('places', 'select', 'wall', 'wall = a wall segment on a grid line; object = a map object (on a tile, or on a wall if the object is wall-mounted); tile = a piece of floor, laid where there is none, joined onto floor that is already there. A tile blueprint also serves as a ROOF: the build menu offers Floor and Roof for it — as a roof it is placed from below, over the storey you stand on, becomes the floor of the storey above and must rest on walls', { options: ['wall', 'object', 'tile'] }),
      f('terrain', 'ref', '', 'For tiles: the terrain it lays. For stairs: the floor laid on the landing above (empty = the floor under their foot)', { ref: 'terrain' }),
      f('wall_style', 'ref', '', 'For walls: the wall style it builds', { ref: 'wallStyles' }),
      f('object', 'ref', '', 'For objects: the object it builds', { ref: 'objects' }),
      f('cost', 'items', '', 'Materials used up to build it'),
      f('work', 'number', 4, 'How many times you must work on the frame to finish it (0 = built at once)'),
      f('tool', 'choice', '', 'Tool needed to build, repair and take it apart (empty = bare hands). Lists the tool tags your items carry', { from: 'tools' }),
      f('station', 'choice', '', 'Station that must be nearby to place it (empty = anywhere). Lists the objects of kind craft, by their station id or, with none, their own id', { from: 'stations' }),
      f('needs_wall', 'bool', true, 'Wall-mounted objects (doors, windows): the spot must already have a wall'),
      f('upgrade_of', 'ref', '', 'This is an upgrade of that blueprint: it can be applied to one already built', { ref: 'blueprints' }),
      f('unlock', 'text', '', 'Condition to know it, e.g. level:3 or flag:found_plans'),
      f('icon', 'image', '', 'Picture in the build menu (empty = the object\'s or the terrain\'s own art)'),
      f('notes', 'text', '')
    ] },
    recipes: { collection: 'recipes', id: 'id', label: 'Recipes', singular: 'recipe', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('category', 'text', '', 'Group shown in the crafting panel'),
      f('inputs', 'items', '', 'What it uses up'),
      f('outputs', 'items', '', 'What you get'),
      f('station', 'choice', '', 'Station needed nearby (empty = made by hand anywhere). Lists the objects of kind craft, by their station id or, with none, their own id', { from: 'stations' }),
      f('tool', 'choice', '', 'Tool needed in the bag, not used up (empty = none). Lists the tool tags your items carry', { from: 'tools' }),
      f('time_s', 'number', 0, 'Seconds before you can craft again (0 = instant)'),
      f('unlock', 'text', '', 'Condition to know it, e.g. level:3 or flag:found_blueprint'),
      f('notes', 'text', '')
    ] },

    // ---- story ----
    // A quest is given by an NPC (an object of kind npc), tracked in the player's quest log, and handed in to an NPC.
    // World.questState / questAct are the rules; docs/QUESTS_INSTANCES_SERVER.md is the design.
    quests: { collection: 'quests', id: 'id', label: 'Quests', singular: 'quest', authored: 'studio', fields: [
      f('id', 'text', ''), f('name', 'text', ''),
      f('giver', 'ref', '', 'The NPC who offers it: an object of kind npc. Every one of that object placed on a map offers it. Empty = it can only be started by an action (quest:<id> in an on_interact, on_use or trigger)', { ref: 'objects' }),
      f('ender', 'ref', '', 'The NPC it is handed in to. Empty = the giver', { ref: 'objects' }),
      f('text', 'textarea', '', 'What the giver says when offering it. A key written in square brackets, like [W] or [Left click], is drawn as a key'),
      f('image', 'image', '', 'A picture shown above the text (optional): a path in the repo (art/tutorial/move.gif) or a web address. An animated GIF or WebP plays by itself'),
      f('tutorial', 'bool', false, 'A tutorial step: with nobody to hand it to, it finishes by itself the moment it is done (no Claim window) and gives its rewards, so one step can start the next. The player can skip all of them with Skip tutorial'),
      f('progress_text', 'textarea', '', 'What the ender says while it is not done yet (optional)'),
      f('done_text', 'textarea', '', 'What the ender says when it is handed in (optional)'),
      f('on_start', 'rewards', '', 'What happens the moment it starts: one row each. Start a tutorial step here to show it right after this quest\'s window (each window shows after the one before is closed). A step started here is closed with this quest if the player gives it up. Stored as an action list (quest:tut_move)', { when: 'when this one starts' }),
      f('objectives', 'goals', '', 'What must be done: one row each — what kind of thing, which one, how many. All of them must be done, except those ticked optional. None = just go and talk to the ender. "When met" = a quest (a tutorial step, say) that starts the moment that objective is done'),
      f('requires', 'text', '', 'Condition to be offered it, e.g. level:3 or quest:first_steps (that quest handed in) or flag:met_mayor. Chains are made with quest:<the one before>'),
      f('rewards', 'rewards', '', 'What the player gets when it is handed in: one row each. Stored as the action list the rules run (xp:100; gold:20; give:axe:1)'),
      f('choice', 'items', '', 'Choose-one reward: the player picks ONE of these when handing in (optional)'),
      f('repeat_h', 'number', 0, 'Repeatable: hours before it is offered again after being handed in. 0 = only once. For a mission that can be taken again at once use a small number such as 0.01'),
      f('notes', 'text', '')
    ] },

    // ---- edited by the map editor, not the Content Studio forms ----
    maps: { collection: 'maps', id: 'id', label: 'Maps', authored: 'map', fields: [
      f('id', 'text', ''), f('name', 'text', ''), f('width', 'number', 0), f('height', 'number', 0),
      f('terrain', 'json', '', 'Compact-encoded terrain grid'),
      f('vWalls', 'json', '', 'Compact-encoded vertical edge-wall grid'),
      f('hWalls', 'json', '', 'Compact-encoded horizontal edge-wall grid'),
      f('floor_of', 'text', '', 'For a floor of a multi-storey map: the id of its ground map (docs/FLOORS.md)'),
      f('z', 'number', 0, 'Its level: 1, 2… above ground, -1, -2… basements'), f('notes', 'text', '')
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
    config: 'Config', tilesets: 'Tilesets', autotile: 'Autotile', terrain: 'Terrain', wallStyles: 'WallStyles', kinds: 'Kinds', itemTypes: 'ItemTypes',
    objects: 'Objects', items: 'Items', monsters: 'Monsters', loot: 'LootTables', classes: 'Classes',
    skills: 'Skills', statuses: 'Statuses', levels: 'Levels', appearances: 'Appearances', recipes: 'Recipes', blueprints: 'Blueprints', quests: 'Quests',
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
