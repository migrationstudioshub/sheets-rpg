"""Build the Game Data and Server workbooks from the old Server spreadsheet export.

Reads  data/import/old_*.csv|json  (snapshot of the original Server sheet)
Writes data/tables.json            (every tab as a list of row records)
       data/GameData.xlsx          (import into Google Sheets once)
       data/Server.xlsx            (import into Google Sheets once)

The client's offline snapshot (client/data/content.json) is then built from
data/tables.json by tools/build_content.js, using the same shared code the
server uses, so both always agree.
"""
import csv
import json
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMP = os.path.join(ROOT, 'data', 'import')

BLOB47 = {
    0: [47], 1: [44], 2: [41], 3: [22], 4: [43], 5: [32, 40, 48], 6: [6], 7: [50],
    8: [42], 9: [24], 10: [30, 31, 39], 11: [52], 12: [8], 13: [49], 14: [51], 15: [15],
    19: [26], 23: [62], 27: [63], 31: [58], 38: [10], 39: [54], 46: [55], 47: [59],
    55: [13, 21, 29], 63: [14], 76: [12], 77: [53], 78: [56], 79: [60], 95: [46],
    110: [34, 35, 36], 111: [7], 127: [37], 137: [28], 139: [64], 141: [61], 143: [57],
    155: [2, 3, 4], 159: [23], 175: [45], 191: [5], 205: [9, 17, 25], 207: [16],
    223: [1], 239: [33], 255: [11, 18, 20, 27],
}

# old object kind -> new kind
KIND_MAP = {'storage': 'container', 'blocker': 'door', 'transfer': 'teleport', 'trap': 'trap',
            'save': 'rest', 'spawner': 'spawn', 'trigger': 'switch', 'craft': 'craft', 'deco': 'deco'}
# objects whose old kind undersold them
KIND_FIX = {'Sign': 'sign', 'Letter': 'sign', 'Bed': 'rest', 'Bedroll': 'rest'}

TERRAIN_NAMES = {'til_0': 'Void', 'til_1': 'Stone floor', 'til_2': 'Stone wall', 'til_3': 'Grass',
                 'til_4': 'Parquet floor', 'til_5': 'Wooden wall', 'til_6': 'Sand', 'til_7': 'Wooden stairs',
                 'til_8': 'Stone stairs', 'til_9': 'Trapdoor', 'til_10': 'Plank floor',
                 'til_11': 'Cobblestone wall', 'til_12': 'Light grass'}
# fixes to the old passability data (N, E, S, W)
PASS_FIX = {'til_11': (0, 0, 0, 0)}  # wall facade was marked walkable


# Demo content added on top of the imported maps, so milestone 3 has something to play.
# (x, y, object, settings)
# imported entities to drop: (map, x, y)
DROP = {('map_3', 3, 9), ('map_3', 3, 10)}   # the tree built from two stacked pieces; replaced by one Tree below
DEMO = {
    'map_3': [  # Wilderness_0
        (10, 4, 'obj_37', {}),                                                   # record table: rest + save point
        (10, 7, 'obj_0', {'contents': 'potion:2, wooden_sword:1', 'per_player': True}),
        (4, 13, 'obj_8', {'monster': 'slime', 'count': 3, 'radius': 3}),
        (13, 13, 'obj_8', {'monster': 'rat', 'count': 2, 'radius': 2}),
        (14, 10, 'obj_9', {'target': 'map_1:7:14'}),                             # cave door to the Arena
        (8, 11, 'obj_15', {'text': 'East: the old arena. Bring a sword.'}),
        (3, 10, 'obj_tree', {}),
        (0, 11, 'obj_tree', {}), (1, 12, 'obj_tree', {}), (0, 13, 'obj_tree', {}), (0, 14, 'obj_tree', {}),
        (15, 14, 'obj_tree', {}), (14, 15, 'obj_tree', {}), (15, 12, 'obj_tree', {}),
    ],
    'map_1': [  # Arena
        (7, 7, 'obj_8', {'monster': 'skeleton', 'count': 2, 'radius': 3}),
        (3, 3, 'obj_8', {'monster': 'bat', 'count': 2, 'radius': 3}),
        (11, 2, 'obj_39', {'locked_by': 'iron_key', 'contents': 'iron_armor:1, gold:50', 'per_player': True}),
    ],
}
# settings for entities that already exist on the imported maps: (map, x, y) -> settings
EXISTING = {
    ('map_2', 14, 6): {'locked': True, 'lock_difficulty': 0.1},   # Test map: a locked storeroom door to practise lockpicking
    ('map_1', 7, 15): {'target': 'map_3:14:11'},   # arena gates lead back to the wilderness
    ('map_1', 8, 15): {'target': 'map_3:14:11'},
}


def read_csv(name):
    with open(os.path.join(IMP, name), newline='') as f:
        return list(csv.DictReader(f))


def imgur(i):
    return f'https://i.imgur.com/{i}.png' if i else ''


def build():
    t = {}
    t['Config'] = [
        {'key': 'tile_size', 'value': 32, 'notes': 'Pixels per tile in the art'},
        {'key': 'view_w', 'value': 15, 'notes': 'Tiles visible across'},
        {'key': 'view_h', 'value': 11, 'notes': 'Tiles visible down'},
        {'key': 'start_map', 'value': 'map_3', 'notes': 'Where new characters appear'},
        {'key': 'start_x', 'value': 9, 'notes': ''},
        {'key': 'start_y', 'value': 15, 'notes': ''},
        {'key': 'move_ms', 'value': 140, 'notes': 'Time for one step, in milliseconds'},
        {'key': 'autotile_edge_same', 'value': True,
         'notes': 'TRUE: terrain running off the map edge gets no border there'},
        {'key': 'save_every_s', 'value': 30, 'notes': 'How often the server writes players to the sheet (min 10). Level-ups, deaths and map changes are written at once.'},
        {'key': 'poll_ms', 'value': 1000, 'notes': 'How often an idle game asks the server what changed'},
        {'key': 'start_class', 'value': 'warrior', 'notes': 'Class used when none is chosen'},
        {'key': 'death_gold_loss', 'value': 0.1, 'notes': 'Share of gold lost on death (0.1 = 10%)'},
        {'key': 'attack_ms', 'value': 500, 'notes': 'Minimum time between basic attacks'},
        {'key': 'lockpick_chance', 'value': 0.5, 'notes': 'Base chance to pick a lock (plus the class bonus, minus the lock difficulty)'},
        {'key': 'lockpick_break', 'value': 0.3, 'notes': 'Chance a lockpick breaks on a failed attempt'},
        # --- survival (M-Zombie Z1): all default to off-ish; set to 0 to disable a system ---
        {'key': 'hunger_decay_per_min', 'value': 0.6, 'notes': 'Hunger points lost per minute (0-100 scale; 0 = off)'},
        {'key': 'thirst_decay_per_min', 'value': 0.9, 'notes': 'Thirst points lost per minute (0 = off)'},
        {'key': 'starve_damage', 'value': 3, 'notes': 'HP lost per tick while hunger or thirst is at 0 (0 = off)'},
        {'key': 'starve_tick_s', 'value': 6, 'notes': 'Seconds between starvation/dehydration ticks'},
        {'key': 'infection_escalate', 'value': 1, 'notes': 'Extra infection damage added each tick as it worsens'},
        {'key': 'ranged_status_ms', 'value': 3000, 'notes': "How long a ranged enemy's applied status lasts (e.g. poison spit)"},
    ]
    t['Tilesets'] = [
        {'id': 'fields', 'image': 'art/tilesets/fields_placeholder.png', 'tile_size': 32, 'columns': 8,
         'layout': 'blob47_craftpix',
         'notes': 'Placeholder art; swap image for the CraftPix FieldsTileset.png (same layout)'},
    ]
    t['Autotile'] = [{'layout': 'blob47_craftpix', 'mask': m, 'tiles': ','.join(map(str, ts))}
                     for m, ts in sorted(BLOB47.items())]

    terrain = []
    for r in read_csv('old_tiles.csv'):
        terrain.append({
            'id': r['id'], 'name': TERRAIN_NAMES.get(r['id'], ''), 'color': r['color'],
            'sprite': imgur(r['imgur']), 'autotile': '',
            'pass_n': int(r['pass_up']), 'pass_e': int(r['pass_right']),
            'pass_s': int(r['pass_down']), 'pass_w': int(r['pass_left']),
            'frames': '', 'frame_ms': '',
            'notes': 'imported' + (' (passability fixed: was walkable)' if r['id'] in PASS_FIX else ''),
        })
    for row in terrain:
        if row['id'] in PASS_FIX:
            row['pass_n'], row['pass_e'], row['pass_s'], row['pass_w'] = PASS_FIX[row['id']]
    terrain.append({'id': 'fields', 'name': 'Fields', 'color': '#c99660', 'sprite': '',
                    'autotile': 'fields', 'pass_n': 1, 'pass_e': 1, 'pass_s': 1, 'pass_w': 1, 'frames': '', 'frame_ms': '',
                    'notes': 'Autotiled: edges and corners are picked automatically'})
    t['Terrain'] = terrain

    t['Kinds'] = [
        {'kind': k, 'property': p, 'type': ty, 'default': d, 'notes': n} for k, p, ty, d, n in [
            ('deco', 'states', 'states', '', 'Scenery; nothing happens on interact'),
            ('container', 'states', 'states', 'closed|open|empty|locked', ''),
            ('container', 'capacity', 'number', 8, ''),
            ('container', 'contents', 'item_list', '', 'Fixed contents, e.g. potion:2, gold:30'),
            ('container', 'loot_table', 'loot_table', '', 'Rolled when opened, if no contents'),
            ('container', 'locked_by', 'item', '', 'Key item needed to open'),
            ('container', 'lock_difficulty', 'number', 0.2, '0 = easy to pick, 0.5 = hard; makes it locked even without a key item'),
            ('container', 'refill_after_s', 'number', 0, '0 = never refills'),
            ('container', 'per_player', 'bool', False, 'TRUE: each player gets their own copy'),
            ('container', 'locked', 'bool', False, 'Locked even without a key item (can only be picked)'),
            ('door', 'states', 'states', 'closed|open|locked', ''),
            ('door', 'locked_by', 'item', '', ''),
            ('door', 'lock_difficulty', 'number', 0.2, '0 = easy to pick, 0.5 = hard'),
            ('door', 'locked', 'bool', False, 'Locked even without a key item (can only be picked or opened by a lever)'),
            ('door', 'target', 'map_pos', '', 'Leave empty for a door that just opens'),
            ('switch', 'states', 'states', 'off|on', 'Levers, buttons, pressure plates'),
            ('switch', 'targets', 'entity_list', '', 'Entity keys to change'),
            ('switch', 'mode', 'select:toggle|once', 'toggle', ''),
            ('trap', 'states', 'states', 'up|down', 'up = dangerous'),
            ('trap', 'damage', 'number', 10, ''),
            ('trap', 'trigger', 'select:step|timed', 'step', 'step: springs when stepped on; timed: goes up and down by itself'),
            ('trap', 'up_ms', 'number', 1000, 'timed: how long it stays up'),
            ('trap', 'down_ms', 'number', 1000, 'timed: how long it stays down'),
            ('trap', 'offset_ms', 'number', 0, 'timed: shift its cycle so neighbouring traps take turns'),
            ('trap', 'hidden', 'bool', False, 'step: invisible until sprung'),
            ('trap', 'rearm_after_s', 'number', 5, 'step: seconds until it is dangerous again'),
            ('rest', 'states', 'states', '', 'Beds and record tables'),
            ('rest', 'heals', 'bool', True, ''),
            ('rest', 'sets_respawn', 'bool', True, ''),
            ('rest', 'cost', 'number', 0, 'Gold'),
            ('sign', 'states', 'states', '', ''),
            ('sign', 'text', 'text', '', ''),
            ('npc', 'states', 'states', 'idle|talking', ''),
            ('npc', 'dialogue', 'dialogue', '', ''),
            ('npc', 'shop', 'shop', '', ''),
            ('npc', 'wander_radius', 'number', 0, ''),
            ('spawn', 'states', 'states', 'active|cleared', 'Place with the Monsters tab of the editor palette'),
            ('spawn', 'monster', 'monster', '', ''),
            ('spawn', 'count', 'number', 1, ''),
            ('spawn', 'radius', 'number', 3, ''),
            ('spawn', 'respawn_after_s', 'number', 60, ''),
            ('teleport', 'states', 'states', 'active|inactive', 'Stairs, cave mouths, map exits'),
            ('teleport', 'target', 'map_pos', '', 'map:x:y'),
            ('teleport', 'requires', 'item', '', ''),
            ('trigger', 'states', 'states', 'ready|fired', 'Invisible zones'),
            ('trigger', 'once', 'bool', True, ''),
            ('trigger', 'if', 'text', '', 'Condition, e.g. flag:met_mayor'),
            ('trigger', 'do', 'text', '', 'Actions, e.g. give:potion:1; flag:seen_cave'),
            ('craft', 'states', 'states', 'lit|unlit', 'Campfires and workbenches'),
        ]]

    # default settings for imported objects (each placed copy can override them in the editor)
    OBJ_PROPS = {
        'obj_0': {'loot_table': 'chest_common'}, 'obj_39': {'loot_table': 'chest_common'},
        'obj_1': {'loot_table': 'barrel', 'refill_after_s': 300}, 'obj_30': {'loot_table': 'barrel', 'refill_after_s': 300},
        'obj_11': {'loot_table': 'barrel', 'refill_after_s': 300}, 'obj_33': {'loot_table': 'barrel'},
        'obj_15': {'text': 'A weathered sign.'}, 'obj_16': {'text': 'A weathered sign.'},
        'obj_40': {'text': 'A weathered sign.'}, 'obj_43': {'text': 'A weathered sign.'},
        'obj_38': {'text': 'A letter. The handwriting is hard to read.'},
    }
    UP, DOWN = imgur('llBBp9J'), imgur('ukg7ivm')   # obj_6 shows the spikes up, obj_5 down
    OBJ_FIX = {
        'obj_8': {'name': 'Monster spawn'},
        'obj_6': {'name': 'Spike trap', 'sprite': UP, 'sprite_states': 'down=' + DOWN,
                  'properties': json.dumps({'trigger': 'timed', 'up_ms': 1000, 'down_ms': 1000})},
        'obj_5': {'name': 'Spike trap (opposite)', 'sprite': UP, 'sprite_states': 'down=' + DOWN,
                  'properties': json.dumps({'trigger': 'timed', 'up_ms': 1000, 'down_ms': 1000, 'offset_ms': 1000})},
    }
    objects, row_to_id = [], {}
    for r in read_csv('old_objects.csv'):
        row_to_id[int(r['row'])] = r['id']
        kind = KIND_FIX.get(r['name'], KIND_MAP[r['kind']])
        objects.append({
            'id': r['id'], 'name': r['name'] or r['id'], 'kind': kind, 'sprite': imgur(r['imgur']),
            'sprite_top': '', 'sprite_states': '', 'frames': '', 'frame_ms': '', 'walkable': r['pass'] == '1',
            'blocks_sight': r['name'] in ('Tree', 'Wooden Door', 'Cave Door'),
            'properties': json.dumps(OBJ_PROPS[r['id']]) if r['id'] in OBJ_PROPS else '',
            'on_interact': '', 'notes': f"imported (old kind: {r['kind']})",
        })
    for o in objects:
        o.update(OBJ_FIX.get(o['id'], {}))
    # one Tree made of the two imported halves: only the trunk blocks, the crown is drawn over characters
    objects.append({'id': 'obj_tree', 'name': 'Tree', 'kind': 'deco', 'sprite': imgur('rhqzQpI'),
                    'sprite_top': imgur('vIDIahx'), 'sprite_states': '', 'frames': '', 'frame_ms': '',
                    'walkable': False, 'blocks_sight': True, 'properties': '', 'on_interact': '',
                    'notes': 'Two tiles tall: trunk (blocks) + crown (drawn above characters)'})
    t['Objects'] = objects

    maps, ents = [], []
    with open(os.path.join(IMP, 'old_maps.json')) as f:
        old_maps = json.load(f)
    for m in old_maps:
        grid, n = [], 0
        for y, row in enumerate(m['layout']):
            out = []
            for x, cell in enumerate(row):
                if isinstance(cell, list) and (m['id'], x, y) in DROP:
                    tile = cell[1]
                    n += 1   # keep the numbering of the other entities' keys unchanged
                elif isinstance(cell, list):
                    obj, tile = cell
                    n += 1
                    extra = EXISTING.get((m['id'], x, y))
                    ents.append({'map': m['id'], 'key': f"{m['id']}.e{n}", 'x': x, 'y': y,
                                 'ref': row_to_id[obj], 'data': json.dumps(extra) if extra else ''})
                else:
                    tile = cell
                tid = f'til_{tile}'
                if m['id'] == 'map_3' and tid == 'til_6':
                    tid = 'fields'  # Wilderness path becomes the autotiled Fields terrain
                out.append(tid)
            grid.append(out)
        for (x, y, ref, data) in DEMO.get(m['id'], []):
            n += 1
            ents.append({'map': m['id'], 'key': f"{m['id']}.e{n}", 'x': x, 'y': y, 'ref': ref,
                         'data': json.dumps(data) if data else ''})
        maps.append({'id': m['id'], 'name': m['name'], 'width': len(grid[0]), 'height': len(grid),
                     'terrain': json.dumps(grid, separators=(',', ':')), 'notes': 'imported'})
    t['Maps'] = maps
    t['MapEntities'] = ents

    sp = lambda n: f'art/sprites/{n}.png'
    ITEM_COLS = ['id', 'name', 'type', 'slot', 'stack_max', 'value', 'atk', 'def', 'heal', 'mp', 'hunger', 'thirst', 'on_use']
    t['Items'] = [dict(zip(ITEM_COLS, r), sprite=sp(r[0]), notes='') for r in [
        # id, name, type, slot, stack_max, value, atk, def, heal, mp, hunger, thirst, on_use
        ('potion', 'Potion', 'consumable', '', 20, 10, 0, 0, 40, 0, 0, 0, ''),
        ('mana_potion', 'Mana potion', 'consumable', '', 20, 12, 0, 0, 0, 40, 0, 0, ''),
        ('big_potion', 'Big potion', 'consumable', '', 10, 30, 0, 0, 100, 0, 0, 0, ''),
        ('wooden_sword', 'Wooden sword', 'weapon', 'weapon', 1, 15, 3, 0, 0, 0, 0, 0, ''),
        ('iron_sword', 'Iron sword', 'weapon', 'weapon', 1, 60, 7, 0, 0, 0, 0, 0, ''),
        ('leather_armor', 'Leather armor', 'armor', 'armor', 1, 20, 0, 2, 0, 0, 0, 0, ''),
        ('iron_armor', 'Iron armor', 'armor', 'armor', 1, 80, 0, 5, 0, 0, 0, 0, ''),
        ('iron_key', 'Iron key', 'key', '', 10, 0, 0, 0, 0, 0, 0, 0, ''),
        ('lockpick', 'Lockpick', 'tool', '', 20, 5, 0, 0, 0, 0, 0, 0, ''),
        ('bone', 'Bone', 'material', '', 99, 2, 0, 0, 0, 0, 0, 0, ''),
        ('slime_gel', 'Slime gel', 'material', '', 99, 1, 0, 0, 0, 0, 0, 0, ''),
        # --- survival demo items (Z1): food/water restore hunger/thirst; antidote cures infection; ammo feeds firearms ---
        ('ration', 'Ration', 'consumable', '', 20, 8, 0, 0, 0, 0, 60, 0, ''),
        ('water', 'Water bottle', 'consumable', '', 20, 6, 0, 0, 0, 0, 0, 60, ''),
        ('antidote', 'Antidote', 'consumable', '', 10, 25, 0, 0, 0, 0, 0, 0, 'cure'),
        ('ammo', 'Ammo', 'material', '', 99, 3, 0, 0, 0, 0, 0, 0, ''),
    ]]
    MON_COLS = ['id', 'name', 'hp', 'atk', 'def', 'xp', 'gold_min', 'gold_max', 'loot_table', 'aggro_range',
                'move_ms', 'respawn_s', 'attack_range', 'ranged_cooldown_ms', 'ranged_projectile', 'ranged_status', 'infect_chance']
    t['Monsters'] = [dict(zip(MON_COLS, r), sprite=sp(r[0]), notes='') for r in [
        # id, name, hp, atk, def, xp, gold_min, gold_max, loot, aggro, move_ms, respawn_s, attack_range, ranged_cd_ms, ranged_proj, ranged_status, infect_chance
        ('slime', 'Slime', 14, 5, 0, 6, 1, 3, 'slime', 3, 1000, 30, 0, 1500, False, '', 0),
        ('rat', 'Rat', 9, 4, 0, 4, 0, 2, 'rat', 5, 600, 30, 0, 1500, False, '', 0),
        ('bat', 'Bat', 12, 6, 1, 10, 1, 4, 'bat', 6, 450, 40, 0, 1500, False, '', 0),
        ('skeleton', 'Skeleton', 32, 11, 3, 25, 4, 12, 'skeleton', 6, 800, 60, 0, 1500, False, '', 0),
        # --- survival demo zombies (Z1) ---
        ('walker', 'Walker', 24, 6, 0, 8, 0, 3, 'walker', 5, 1100, 45, 0, 1500, False, '', 0.5),   # slow; its bite can infect
        ('spitter', 'Spitter', 18, 7, 0, 14, 1, 5, 'spitter', 7, 900, 50, 4, 1500, True, '', 0),    # attacks from 4 tiles with line of sight
    ]]
    t['LootTables'] = [
        {'table': tb, 'item': it, 'chance': ch, 'min': a, 'max': b}
        for tb, it, ch, a, b in [
            ('slime', 'slime_gel', 0.6, 1, 2), ('slime', 'potion', 0.1, 1, 1),
            ('rat', 'potion', 0.08, 1, 1),
            ('bat', 'big_potion', 0.05, 1, 1), ('bat', 'mana_potion', 0.2, 1, 1), ('skeleton', 'mana_potion', 0.25, 1, 1),
            ('chest_common', 'mana_potion', 0.4, 1, 2), ('chest_common', 'lockpick', 0.3, 1, 2), ('barrel', 'lockpick', 0.1, 1, 1),
            ('skeleton', 'bone', 0.7, 1, 3), ('skeleton', 'potion', 0.3, 1, 1),
            ('skeleton', 'iron_key', 0.3, 1, 1), ('skeleton', 'iron_sword', 0.08, 1, 1),
            ('chest_common', 'gold', 1, 5, 20), ('chest_common', 'potion', 0.9, 1, 2),
            ('chest_common', 'wooden_sword', 0.3, 1, 1), ('chest_common', 'leather_armor', 0.25, 1, 1),
            ('barrel', 'gold', 0.6, 1, 6), ('barrel', 'potion', 0.15, 1, 1),
            # survival demo drops
            ('walker', 'ration', 0.3, 1, 1), ('walker', 'ammo', 0.2, 1, 2), ('walker', 'bone', 0.5, 1, 2),
            ('spitter', 'ammo', 0.5, 1, 3), ('spitter', 'antidote', 0.15, 1, 1), ('spitter', 'water', 0.3, 1, 1),
        ]]
    CLASS_COLS = ['id', 'name', 'hp', 'atk', 'def', 'mp', 'hp_per_level', 'atk_per_level', 'def_per_level',
                  'mp_per_level', 'mp_regen', 'start_items', 'skills', 'notes', 'lockpicking']
    t['Classes'] = [dict(zip(CLASS_COLS, r)) for r in [
        ('warrior', 'Warrior', 120, 6, 2, 30, 12, 2, 1, 3, 1.0, 'potion:2', 'charge@1, cleave@1, second_wind@3, gunshot@5', 'Front line', 0),
        ('rogue', 'Rogue', 90, 7, 1, 40, 9, 2, 1, 4, 1.5, 'potion:3, gold:20, lockpick:3', 'throw_dagger@1, poison_strike@1, shadow_step@3', 'Fast, ranged poke', 0.3),
        ('mage', 'Mage', 70, 3, 1, 70, 7, 1, 1, 7, 3.0, 'potion:1, mana_potion:2', 'fireball@1, frost_bolt@1, frost_nova@3', 'Ranged magic, fragile', 0),
        ('paladin', 'Paladin', 110, 5, 3, 45, 11, 2, 1, 4, 1.5, 'potion:2', 'holy_strike@1, blessing@1, lay_on_hands@3', 'Support: protects allies', 0),
        ('priest', 'Priest', 80, 3, 1, 80, 8, 1, 1, 8, 3.0, 'potion:1, mana_potion:2', 'heal@1, smite@1, renew@3', 'Healer', 0),
        ('barbarian', 'Barbarian', 140, 7, 1, 30, 14, 2, 1, 2, 1.0, 'potion:2', 'whirlwind@1, rage@1, leap@3', 'Brute force', 0),
    ]]
    STATUS_COLS = ['id', 'name', 'kind', 'amount', 'tick_ms', 'atk', 'def', 'slow', 'color', 'notes']
    t['Statuses'] = [dict(zip(STATUS_COLS, r)) for r in [
        ('infection', 'Infected', 'infection', 2, 3000, 0, 0, 1, '#9acd32', 'From a zombie bite: worsens each tick and never fades on its own. Cure with an antidote (on_use: cure) or turn.'),
        ('burn', 'Burning', 'dot', 3, 1000, 0, 0, 1, '#ff7a2a', 'Damage every tick'),
        ('poison', 'Poisoned', 'dot', 3, 1000, 0, 0, 1, '#7ad04a', 'Damage every tick'),
        ('chill', 'Chilled', 'slow', 0, 0, 0, 0, 2, '#7ad0ff', 'slow = how much longer each step takes'),
        ('stun', 'Stunned', 'stun', 0, 0, 0, 0, 1, '#ffe680', 'Cannot act'),
        ('blessed', 'Blessed', 'buff', 0, 0, 0, 4, 1, '#ffe680', ''),
        ('rage', 'Raging', 'buff', 0, 0, 6, -2, 1, '#e05050', ''),
        ('renew', 'Renewing', 'hot', 5, 1000, 0, 0, 1, '#8aff9a', 'Healing every tick'),
    ]]
    SKILL_COLS = ['id', 'name', 'icon', 'color', 'mp', 'cooldown_ms', 'range', 'target', 'area', 'los', 'effect',
                  'power', 'stat', 'scale', 'status', 'status_ms', 'dash', 'projectile', 'on_cast', 'description']
    t['Skills'] = [dict(zip(SKILL_COLS, r)) for r in [
        # id, name, icon, color, mp, cd, range, target, area, los, effect, power, stat, scale, status, status_ms, dash, projectile, on_cast, description
        ('charge', 'Charge', '', '#d9a441', 5, 6000, 4, 'enemy', 0, True, 'damage', 3, 'atk', 1.0, 'stun', 1200, True, False, '', 'Rush to an enemy, hit and stun it'),
        ('cleave', 'Cleave', '', '#d9a441', 4, 3000, 0, 'around', 1, False, 'damage', 0, 'atk', 1.0, '', 0, False, False, '', 'Hit every enemy next to you'),
        ('second_wind', 'Second wind', '', '#8aff9a', 8, 20000, 0, 'self', 0, False, 'heal', 25, 'level', 5, '', 0, False, False, '', 'Heal yourself'),
        ('throw_dagger', 'Throw dagger', '', '#c0c8d0', 2, 1200, 6, 'enemy', 0, True, 'damage', 2, 'atk', 0.8, '', 0, False, True, '', 'Cheap ranged attack'),
        ('poison_strike', 'Poison strike', '', '#7ad04a', 4, 4000, 1, 'enemy', 0, False, 'damage', 0, 'atk', 1.0, 'poison', 5000, False, False, '', 'Hit and poison'),
        ('shadow_step', 'Shadow step', '', '#7a5aa0', 5, 8000, 4, 'tile', 0, True, 'none', 0, '', 0, '', 0, True, False, '', 'Vanish and reappear nearby'),
        ('fireball', 'Fireball', '', '#ff7a2a', 10, 2500, 7, 'enemy', 1, True, 'damage', 10, 'level', 3, 'burn', 3000, False, True, '', 'Explodes on impact and sets enemies on fire'),
        ('frost_bolt', 'Frost bolt', '', '#7ad0ff', 6, 1500, 7, 'enemy', 0, True, 'damage', 6, 'level', 2, 'chill', 4000, False, True, '', 'Damages and slows'),
        ('frost_nova', 'Frost nova', '', '#7ad0ff', 14, 8000, 0, 'around', 2, False, 'damage', 6, 'level', 2, 'chill', 3000, False, False, '', 'Chill everything around you'),
        ('holy_strike', 'Holy strike', '', '#ffe680', 4, 2000, 1, 'enemy', 0, False, 'damage', 4, 'atk', 1.2, '', 0, False, False, '', 'A blessed blow'),
        ('blessing', 'Blessing', '', '#ffe680', 10, 12000, 5, 'ally', 0, True, 'none', 0, '', 0, 'blessed', 12000, False, False, '', 'An ally takes less damage'),
        ('lay_on_hands', 'Lay on hands', '', '#8aff9a', 15, 15000, 1, 'ally', 0, False, 'heal', 40, 'level', 6, '', 0, False, False, '', 'Big heal on an ally next to you'),
        ('heal', 'Heal', '', '#8aff9a', 10, 2500, 6, 'ally', 0, True, 'heal', 30, 'level', 6, '', 0, False, False, '', 'Heal an ally (or yourself)'),
        ('smite', 'Smite', '', '#ffe680', 6, 2000, 6, 'enemy', 0, True, 'damage', 8, 'level', 2, '', 0, False, True, '', 'Holy light at range'),
        ('renew', 'Renew', '', '#8aff9a', 8, 6000, 6, 'ally', 0, True, 'none', 0, '', 0, 'renew', 8000, False, False, '', 'Heals over time'),
        ('whirlwind', 'Whirlwind', '', '#e05050', 8, 4000, 0, 'around', 1, False, 'damage', 2, 'atk', 1.0, '', 0, False, False, '', 'Spin and hit everything next to you'),
        ('rage', 'Rage', '', '#e05050', 10, 15000, 0, 'self', 0, False, 'none', 0, '', 0, 'rage', 8000, False, False, '', 'Hit harder, guard less'),
        ('leap', 'Leap', '', '#e05050', 10, 10000, 4, 'tile', 1, True, 'damage', 4, 'atk', 0.8, 'stun', 1000, True, False, '', 'Jump to a spot, stunning enemies where you land'),
    ]]
    # survival demo (Z1): a firearm skill that spends one 'ammo' item per shot instead of mana
    t['Skills'].append(dict(zip(SKILL_COLS,
        ('gunshot', 'Gunshot', '', '#d0d0d0', 0, 900, 6, 'enemy', 0, True, 'damage', 8, 'atk', 0.6, '', 0, False, True, '', 'Fire your gun at an enemy; spends one ammo')),
        ammo='ammo', ammo_cost=1))
    for _s in t['Skills']:
        _s.setdefault('ammo', '')
        _s.setdefault('ammo_cost', '')
    t['Levels'] = [{'level': lv, 'xp_needed': xp} for lv, xp in
                   [(1, 0), (2, 20), (3, 50), (4, 100), (5, 170), (6, 260), (7, 380), (8, 530), (9, 720), (10, 950)]]

    server = {
        'Players': [],
        'WorldState': [],
        'Log': [],
    }
    return t, server


SERVER_HEADERS = {
    'Players': ['id', 'token', 'name', 'class', 'map', 'x', 'y', 'facing', 'hp', 'mp', 'level', 'xp', 'gold',
                'inventory', 'equipment', 'loadout', 'cooldowns', 'statuses', 'flags', 'respawn', 'created', 'last_seen'],
    'WorldState': ['map', 'key', 'state', 'updated'],
    'Log': ['time', 'player', 'event', 'detail'],
}

README = [
    ('Game Data', 'Everything a designer edits. One row per thing; the first row names the fields.'),
    ('', 'Do not rename tabs or header cells: the game finds columns by these names.'),
    ('', 'You may reorder columns and add your own columns (the game ignores unknown ones).'),
    ('Config', 'Global settings: one key per row.'),
    ('Tilesets', 'Images cut into tiles. image = path in the GitHub repository (or a full URL).'),
    ('Autotile', 'Which tile of an autotile sheet to draw for each neighbour combination. Rarely edited.'),
    ('Terrain', 'Ground types. color is always drawn first; sprite (or autotile) is drawn over it.'),
    ('', 'pass_n/e/s/w: 1 = can cross that side of the tile, 0 = blocked.'),
    ('Kinds', 'What each kind of interactable can be configured with. The map editor builds its forms from this.'),
    ('Objects', 'Placeable things. kind is one of the kinds in Kinds. walkable TRUE = players can stand on it. blocks_sight TRUE = skills cannot pass it.'),
    ('', 'Tall objects: sprite_top is drawn one tile up, over characters (only the bottom tile blocks). An image taller than wide works too.'),
    ('', 'Animation (Objects and Terrain): the sprite is a horizontal strip; frames = how many, frame_ms = time per frame.'),
    ('Maps', 'terrain = JSON grid of Terrain ids, row by row. Edited with the map editor, not by hand.'),
    ('MapEntities', 'Objects placed on maps. key is unique; data = JSON of property overrides.'),
    ('Items', 'Everything that goes in a bag. type: consumable, weapon, armor, key, material. heal = HP restored.'),
    ('Monsters', 'Enemy types. Placed through spawn objects on maps. move_ms = time per step; aggro_range = tiles.'),
    ('LootTables', 'Drops: each row rolls on its own. chance 0-1; item "gold" means money.'),
    ('Classes', 'lockpicking = bonus chance to pick locks (0.3 = +30%). Starting stats and growth per level. start_items like potion:2, gold:20. skills like fireball@1, frost_nova@3 (skill@level learned).'),
    ('Skills', 'target: enemy, ally, self, tile (a spot) or around (centred on the caster). range and area in tiles. los TRUE = walls and blocking objects stop it.'),
    ('', 'effect: damage, heal or none. Amount = power + scale x stat (stat: atk or level); damage then minus the target\'s defence. status + status_ms add a status. dash TRUE = the caster moves there.'),
    ('Statuses', 'kind: dot (damage per tick), hot (healing per tick), buff (atk/def change), slow (steps take slow x longer), stun (cannot act).'),
    ('Levels', 'Total XP needed to reach each level.'),
]


def style_header(ws):
    for c in ws[1]:
        c.font = Font(name='Arial', bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='3D5A80')
    ws.freeze_panes = 'A2'


def write_book(path, tables, headers=None, readme=None):
    wb = Workbook()
    wb.remove(wb.active)
    if readme:
        ws = wb.create_sheet('README')
        ws.append(['Tab', 'What it holds'])
        for row in readme:
            ws.append(list(row))
        style_header(ws)
        ws.column_dimensions['A'].width = 16
        ws.column_dimensions['B'].width = 110
    for name, rows in tables.items():
        ws = wb.create_sheet(name)
        cols = headers[name] if headers else list(rows[0].keys())
        ws.append(cols)
        for r in rows:
            ws.append([r.get(c, '') for c in cols])
        style_header(ws)
        for i, c in enumerate(cols, 1):
            longest = max([len(str(c))] + [min(len(str(r.get(c, ''))), 60) for r in rows])
            ws.column_dimensions[ws.cell(1, i).column_letter].width = max(8, longest + 2)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if c.row > 1:
                    c.font = Font(name='Arial')
                    c.alignment = Alignment(vertical='top')
    wb.save(path)
    print('wrote', path)


def main():
    t, server = build()
    import hashlib
    stamp = hashlib.sha1(json.dumps(t, sort_keys=True).encode()).hexdigest()[:12]
    with open(os.path.join(ROOT, 'data', 'tables.json'), 'w') as f:
        json.dump(dict(t, _version=stamp), f, indent=1)
    write_book(os.path.join(ROOT, 'data', 'GameData.xlsx'), t, readme=README)
    write_book(os.path.join(ROOT, 'data', 'Server.xlsx'), server, headers=SERVER_HEADERS)
    print({k: len(v) for k, v in t.items()})


if __name__ == '__main__':
    main()
