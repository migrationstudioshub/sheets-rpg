# Base building, damage and crafting — implementation spec

Status: **Phases 0, 1, 2 and 3 built.** Phase 0: per-map state + transactions (`functions/referee.js`, tests in
`tools/test_functions.js`). Phase 1: the structure layer, `World.liveMap`, health/damage/breach/destruction
for authored walls and objects, wired into melee (the `attack` action falls through to a structure),
bullets and blasts; crack overlay + health bars; durability fields in the Content Studio; `resetStructures`
(key-gated function action). Phase 2: the Recipes table, item tool tags, crafting stations (`properties.station`
on a kind-craft object), the `craft` action, `World.recipesFor`, the crafting panel (key C, or use a station), and
harvestable objects (`properties.harvest` / `harvest_tool` / `respawn_s`) that grow back. Phase 3: the Blueprints table,
`World.canBuild` / `blueprintsFor`, the `build` / `work` / `dismantle` / `upgrade` / `store` actions, frames, repair,
storage containers and rubble, build mode in the client (key B, ghost preview, F works on a frame), the storage panel,
and the No-build tab in the map editor (`map.nobuild`). Phase 4: claims (object kind `claim`, `World.claimsOn` /
`claimAt` / `mayUse` / `isMember` / `mayDismantle`, the `claim` action, the members panel, claim outlines in build mode).
Phase 5 planned.
Written 18 Nov 2026.

**Deviations in Phase 4:** the claim helpers take a **live map** (`claimAt(c, map, x, y)`, `mayUse(c, map, p, x, y)`),
not `ws, mapId`, so the client's ghost and menus ask the same question. A claim record carries `owner` (name) and
`members: [{id, name}]`. **Members are added by name among the players on the same map** (the `players` list `act`
already gets) — no referee change; offline there is nobody to add. The player record keeps `claims: [{map, key}]`;
entries are checked against what stands on the map when the player is on it (`heldClaims`), so a claim destroyed while
its owner is on another map frees the slot only once they return there. **Who may damage what (owner said "start",
did not object):** inside a claim, non-members cannot damage anything except harvestables, unless `pvp_structures` is
on; outside claims anyone can damage anything built; taking apart: your own, unowned things, or anything inside a base
you belong to (the flag itself: owner only). Extra placement rules for a claim: not within its radius of the map's own
doors / containers / teleports (switch: Config `claim_open_land` = off lets players claim existing buildings), the
map's arrival point, another player's structures, or another claim's land. Also fixed here: `yes()` did not accept
`on`, so `pvp_structures: on` never took effect in Phase 3; and using (F / click) an unfinished frame of a usable
object (door, crate, station, flag) now works on it instead of opening it.

**Deviations in Phase 3:** `work`, `dismantle` and `upgrade` take `target` (`{t:'wall', orient, x, y}` or `{t:'ent', key}`);
pressing use (F) with nothing usable in front works on the frame / damaged thing you face. No hold-to-work and no
rotation key yet. Building is not predicted (the client waits for the reply). **Who may damage what:** until claims
exist (Phase 4) `World.protectedFrom` returns false, so any player can damage any built structure; taking apart is
limited to the builder unless `pvp_structures` is on. Phase 4 must make `protectedFrom` true inside a claim the player
is not a member of (done — see Phase 4).
**Gotcha fixed here:** the live map is `Object.create(authoredMap)`, so every cache hung on a map (`_at`, `_block`,
`_edgeOv`) must be reset as an OWN property in `liveMapFromStruct`, or it silently reads the authored map's.

**Deviations in Phase 2:** item lists (`inputs`, `outputs`, `cost`, `salvage`, `harvest`) are written
`item:qty, item:qty` — `World.list` accepts a comma or a semicolon. There is no `stack_max` check (the bag has no
stack limits today). A harvested object is marked `gone[key] = 2` with a `{at, regrow: true}` timer. Key **B** already
opens the bag (with I), so build mode in Phase 3 needs another key.

**Deviations from this spec in what was built (Phase 1):**
- There is no separate `strike` action: `{type:'attack', x, y}` at a neighbouring cell hits the creature
  there, or — when there is none, or a wall is between — the breakable fixture/wall on the shared edge, else a
  breakable solid object in that cell (`World.strikeTarget`). The action menu lists "Attack the …".
- The public push node `struct/<mapId>` (7.3, 9.4) is **not built yet**: clients get the layer through
  `view.struct` on their own poll/act replies (they send `structRev`), so another player's damage shows up
  within one heartbeat (~3 s). `database.rules.json` is unchanged. Add the push when it matters.
- `World.entity()` (spawn / lever-target lookup) still reads the authored map; fine until things are built.
- Objects show damage as a health bar only (no crack overlay on sprites); walls get cracks and a bar.
implements it — a person or an agent. It is self-contained: read `CLAUDE.md` first (project rules), then
this. Line numbers are from the day of writing and will drift; function names are the stable reference.

Contents: 1 Decisions · 2 What exists today · 3 Design in one page · 4 Content (authored data) ·
5 Live data (the structure layer) · 6 The effective map · 7 Actions and protocol · 8 Rules in detail ·
9 Persistence and concurrency · 10 Client · 11 Editors · 12 Phases with acceptance tests ·
13 Default numbers · 14 Risks and open points · 15 Working conventions

---

## 1. Decisions the owner has made

Agreed on 18 Nov 2026. Do not re-open these without asking the owner.

| # | Question | Decision |
| - | -------- | -------- |
| 1 | Where can players build? | Anywhere, **except tiles marked no-build** in the map editor. |
| 2 | Who owns a base? | A **claim object**: building, dismantling and using doors/containers inside its radius is limited to its owner and the members they add. Outside any claim, anything goes. |
| 3 | Can players damage each other's structures? | **No — monsters only** at first. A Config switch (`pvp_structures`) exists for later and defaults to off. |
| 4 | Are authored (map-editor) buildings destructible? | Doors, windows and furniture **yes**. Structural walls **only when their wall style is marked breakable**. Anything can be marked indestructible. |
| 5 | Do bases decay or reset? | **No decay** for now. Leave a hook (`built` timestamp on every structure) and nothing else. |

Standing preferences of the owner that shape this work (see also the memory notes and `CLAUDE.md`):

- One consistent rule beats many special cases. Extend the single edge question
  (`Rules.edgeBlocked`) and the single sight decision (`Render.makeSight`) instead of adding parallel systems.
- The owner designs through the Content Studio and map editor; **all tuning must be data**, not code.
- Cost-conscious: stay inside the Firebase free tier (§9.6).
- The owner reads summaries, not diffs, and tests before anything is committed.

---

## 2. What exists today (verified in code)

### 2.1 Runtime shape

- **Referee:** `functions/index.js`, one HTTPS function `game`. `step(token, action, since)` does:
  read all `players/*`, read `state/world`, `World.advance` (catch the map up), `World.act` (the player's
  action), `World.record` (event log), then one multi-path `update` of `state/world` + the actor's player
  record (+ players touched by events), then writes the public view `world/<mapId>` if it changed.
- **State storage (Realtime Database):** `players/<token>` and `state/world` are **JSON strings**
  (entity keys contain `.`, which RTDB forbids in keys). `world/<mapId>` is a plain object:
  `{map, now, seq, monsters[], players[]}`. Rules: `world` public-read, everything else locked
  (`database.rules.json`).
- **Known weakness:** `state/world` is **last-write-wins** for the whole world. Two actions in the same
  ~200 ms overwrite each other's world changes. This must be fixed before bases exist (§9).
- **World state object** (`ws`): `{seq, log[], maps: {<mapId>: {states: {<entityKey>: state}, timers: {<entityKey>: {at, state}}, monsters: [...]}}}`.
  See `World.mapState`.
- **Other backends that run the same rules** and must keep working: `Offline` in `client/js/api.js`
  (rules in the browser, `ws` in localStorage — used by `?offline`, Play-test and the desktop app) and the
  LAN host `host/server.js`. All three call `World.advance / act / view / record / eventsFor`.
- **Content:** Firestore `published/current` (all tables) + `maps/<id>` (one doc per map; grids encoded
  with `shared/mapcode.js`). `Content.build(tables)` turns rows into the `content` object; the function
  caches it for 30 minutes. The map objects inside it are **shared and cached** — the code hangs
  derived caches on them (`map._edgeOv`, `map._block`, `map._roofZones`).

### 2.2 Maps, walls, objects

- **Edge walls:** `map.hWalls[y][x]` = north edge of cell (x,y); `map.vWalls[y][x]` = west edge of cell
  (x,y). Token `style:height[:side]` (`side` = `l`/`r` for a N-S wall drawn off its line; parsed by
  `Render.parseWallTok`, ignored by `Rules.parseWall`).
- **The one edge question:** `Rules.edgeBlocked(content, map, orient, x, y, 'move'|'sight', from?)`.
  It consults `map._edgeOv[Rules.edgeKey(orient,x,y)]` first (`{move, sight, peek, key}`; true = blocked),
  then the wall token. `World.syncEdges(c, ws, mapId)` rebuilds `_edgeOv` from openings (doors, windows,
  arches) and their states; the client does the same with `World.syncEdgesView`.
- **Objects:** `map.entities = [{key, x, y, ref, data}]`, `ref` → `content.objects[id]`
  (`kind`, `sprite`, `spriteStates`, `walkable`, `blocksSight`, `footprintW/H`, `properties`).
  Keys look like `map_3.e9` and are **stable ids** — never renumber.
- **Wall fixtures:** objects with `properties.layer === 'wall'`, anchored by cell + `data.side`
  (`N` = the cell's north edge, `W` = its west edge; `S`/`E` exist in the rules but the editor places N and W).
  Openings: kind `door`, or `properties.opening: 'window' | 'arch'`.
- **Object kinds:** deco, container, door, switch, trap, rest, sign, npc, spawn, teleport, trigger, craft.
  **`craft` is a stub** (`interact` prints "Crafting comes later.").
- **Kinds table** gives each kind its `states` list and default properties; placement properties resolve
  kind default → object `properties` → entity `data` (`World.props`).

### 2.3 Combat and AI

- Only **players and monsters have hp**. `World.hurt` damages a player; `hitMonster` a monster;
  `damage(atk, def, rng) = max(1, atk − def + rint(−1, 2))`.
- Attack paths: `attack` (melee, via `act` type `attack`; walking into a creature no longer attacks), `shoot` (ranged weapon),
  `cast` (skills), `throwItem` (grenades: `throwLanding` + `blastCells`, both stopped by walls that
  block **movement**).
- **Monster AI** lives inside `World.advance`: pick a target (the engaged player, else nearest within
  `aggro`), then ranged attack / melee swing / a greedy step toward the target (tries the dominant axis,
  then the other; no pathfinding). **Monsters never target anything but players.**
- Containers hand loot straight into the opener's inventory (`openContainer`); there are **no items lying
  on the ground** and **no player storage**.

### 2.4 Client and editors

- `client/js/main.js`: input, prediction, the frame loop; `mapOf()` returns `content.maps[me.map]`.
  `client/js/render.js`: `Renderer.setMap(map)` caches `this.wall25 = wall25(content, map)`; `draw`
  is the layered painter pass. Sight is computed in `main.js` (`World.visibleCells`) and decided in
  `Render.makeSight`.
- Live push: `Online.watchMap` listens with `EventSource` to `<FIREBASE_URL>/world/<mapId>.json`.
- `editor/js/editor.js` already has the snapping this feature needs: `E.edgeAt(ev)` (nearest edge) and
  `E.mountCellAt(ev)` (nearest edge for a fixture, preferring the line that has a wall), plus ghost
  drawing through `Render.wallMountPlace` / `Render.drawObject` / `Render.drawPrim25`.
- `content/js/cstudio.js` builds forms from `shared/schema.js`; adding a content type there gives it a
  list + form for free. Objects have a hand-written form (`objForm`).

---

## 3. The design in one page

1. **One structure layer per map**, kept in the live world state next to `states` and `monsters`.
   It holds: walls players built, objects players built, damage taken by anything (built or authored),
   and authored things that have been destroyed.
2. **The effective map** = authored map + structure layer. Every rule (walking, sight, shots, blasts,
   monster movement, interaction) reads the effective map, so a built wall blocks and a broken wall stops
   blocking everywhere at once. Produced by one function, `World.liveMap` (§6).
3. **Everything that can be hit has hp**, defined by data: wall styles, objects, blueprints.
4. **Building** = spend materials to place a *frame* (low hp, already solid), then *work* on it until it is
   finished. Repair, upgrade and dismantle are variations of the same work action.
5. **Crafting** = recipes (inputs → outputs, maybe at a station, maybe needing a tool). Stations are
   objects of kind `craft`, authored or built.
6. **Monsters attack structures** only when a structure is what stands between them and a player.
7. **Claims** give ownership; **no-build tiles** protect authored places.
8. **Prerequisite:** per-map world state with safe concurrent writes (§9).

---

## 4. Content (authored data)

All new columns must be **optional** with safe defaults: the published game data will not have them
until the owner adds them. Never ask the owner to re-import data. For each new table add: a
`shared/schema.js` type, a `Schema.TAB` entry, a `Content.build` section, seed rows in
`data/tables.json`, and (so offline seeds can be rebuilt) the same rows in `tools/build_gamedata.py`.

### 4.1 Wall styles — new columns (`WallStyles`)

| Column | Type | Default | Meaning |
| ------ | ---- | ------- | ------- |
| `hp` | number | 0 | Health of one wall segment (one edge). `0` = indestructible. |
| `armor` | number | 0 | Flat reduction applied to every hit. |
| `material` | select `wood|metal|stone|glass|flesh` | `stone` | Picks the damage multipliers (§8.5) and what burns. |
| `breakable` | bool | false | Decision 4: authored walls of this style can be damaged only when true. Built walls ignore this (they are always damageable). |
| `salvage` | text | '' | `item:qty; item:qty` handed back on dismantle (see §8.4). Empty = half the blueprint cost. |

`Content.build` → `c.wallStyles[id].{hp, armor, material, breakable, salvage}`.

### 4.2 Objects — new `properties` keys (edited in the object form)

| Key | Default | Meaning |
| --- | ------- | ------- |
| `hp` | 0 | Health. `0` = indestructible. Decision 4 defaults: seed `door`, `container` and furniture objects with hp; leave deco at 0 unless set. |
| `armor` | 0 | As walls. |
| `material` | `wood` | As walls. |
| `indestructible` | false | Hard override (quest doors, teleports). `spawn`, `trigger`, `teleport`, `npc`, `sign` are always indestructible regardless. |
| `salvage` | '' | As walls. |
| `station` | '' | For kind `craft`: the station id recipes refer to (e.g. `workbench`, `stove`). |
| `storage` | 0 | For kind `container` **when player-built**: number of item stacks it can hold. `0` = an ordinary loot container (today's behaviour). |
| `claim_radius` | 0 | For kind `claim`: radius in tiles (Chebyshev). |

Add a new object kind **`claim`** to the kind `select` in `shared/schema.js` and to the seed `Kinds`
rows (states: none). Add it to `INTERACTIVE` in `world.js`.

Add a "Durability" section to `objForm` in `content/js/cstudio.js` (hp, armor, material,
indestructible, salvage), a "Station id" field when kind is `craft`, "Storage slots" when kind is
`container`, "Claim radius" when kind is `claim`.

### 4.3 Items — new columns (`Items`)

| Column | Type | Default | Meaning |
| ------ | ---- | ------- | ------- |
| `tool` | text | '' | Tool tags, `;`-separated (e.g. `hammer`, `axe`, `saw`, `wrench`). Blueprints and recipes can require a tag. |
| `structure_dmg` | number | 0 | Damage one swing/shot does to structures. `0` = use `atk` × `structure_dmg_scale` (Config). |
| `burns` | bool | false | Throwables only: the blast applies fire damage to wood (§8.5). |

`type` keeps its current options; materials are ordinary `material` items (wood, scrap, nails, …).

### 4.4 Monsters — new columns (`Monsters`)

> **Built differently (Nov 2026):** monsters that attack structures are the ones with `brain` = `walker`
> (`World.walkerStep`, see CLAUDE.md "Monster brains"). The column is `structure_dmg` (0 = the monster's atk), a blow
> takes one of its steps (no `structure_ms`), and a walker also goes for player-built things it sees. The table below is the
> original plan.

| Column | Type | Default | Meaning |
| ------ | ---- | ------- | ------- |
| `structure_atk` | number | 0 | Damage per swing against structures. `0` = this monster never attacks structures. |
| `structure_ms` | number | 1500 | Minimum time between swings at a structure. |

### 4.5 Blueprints — new table (`Blueprints`, schema type `blueprints`, authored `studio`)

One row per thing a player can build.

| Column | Type | Meaning |
| ------ | ---- | ------- |
| `id` | text | Stable id. |
| `name` | text | Shown in the build menu. |
| `category` | select `walls|doors|furniture|stations|defences|other` | Build-menu tab. |
| `places` | select `wall|object` | `wall` = an edge wall segment; `object` = a map object (on a tile or on a wall, decided by the object's `layer`). |
| `wall_style` | ref `wallStyles` | For `places = wall`. |
| `wall_height` | number (default 2) | For `places = wall`. |
| `object` | ref `objects` | For `places = object`. |
| `cost` | text | `item:qty; item:qty`. |
| `work` | number (default 4) | Work points to finish the frame (§8.3). |
| `tool` | text | Required tool tag, or empty. |
| `station` | text | Must be within `station_range` of a station with this id, or empty. |
| `needs_wall` | bool | For wall-layer objects (doors, windows): the target edge must already hold a wall. Default true for wall-layer objects. |
| `replaces_wall` | bool | The object *is* the opening: placing it removes nothing (fixtures override their edge already). Informational; default true for doors/windows. |
| `upgrade_of` | ref `blueprints` | This blueprint is an upgrade of that one: it can be applied in place (§8.4). |
| `unlock` | text | Condition string as used by `World.check` (`level:3`, `flag:x`, `has:item:n`). Empty = always known. |
| `icon` | image | Menu icon; falls back to the object sprite / wall face. |

`Content.build` → `c.blueprints[id]` with `cost` parsed by the existing `list()`-style parser
(`World.list` parses `item:qty` pairs — reuse it or move it into `content.js`).

### 4.6 Recipes — new table (`Recipes`, schema type `recipes`, authored `studio`)

| Column | Type | Meaning |
| ------ | ---- | ------- |
| `id`, `name` | text | |
| `category` | text | Free text for grouping in the panel. |
| `inputs` | text | `item:qty; item:qty`. |
| `outputs` | text | `item:qty; item:qty` (usually one). |
| `station` | text | Station id required nearby, or empty = craft by hand anywhere. |
| `tool` | text | Required tool tag (not consumed), or empty. |
| `time_s` | number (default 0) | `0` = instant. `>0` = queued at the station (§8.7); hand recipes must be 0 in the first version. |
| `unlock` | text | `World.check` condition. |

### 4.7 Config keys (all optional)

`build` on|off (default on) · `build_reach` 2 (tiles from the player to the placed thing) ·
`station_range` 2 · `frame_hp_pct` 0.2 · `work_ms` 600 (min time between work points) ·
`repair_cost_pct` 0.5 · `dismantle_refund_pct` 0.5 · `structure_dmg_scale` 0.5 ·
`structure_cap_per_map` 600 · `structure_cap_per_player` 150 · `pvp_structures` off ·
`breach_at_pct` 0.33 (below this a wall becomes see-through, §8.6) ·
`claim_max_per_player` 1 · `harvest_respawn_s` 600.

---

## 5. Live data — the structure layer

Per map, inside the map's live state (`World.mapState(ws, mapId)`), add `struct`:

```js
ms.struct = {
  rev: 0,            // bumped on EVERY change to struct; drives caches and client updates
  n: 0,              // counter for built entity keys; only ever increases
  walls: {           // walls players built, and overrides of authored walls
    "h12,7": { tok: "wall_wood:2", hp: 40, max: 40, bp: "bp_wood_wall", by: "<playerId>", built: 1731900000000, prog: 4, need: 4 }
  },
  ents: [            // objects players built (same shape as map.entities, plus live fields)
    { key: "map_3.b17", x: 9, y: 4, ref: "obj_crate", data: { side: "N" },
      hp: 30, max: 30, bp: "bp_crate", by: "<playerId>", built: 1731900000000, prog: 3, need: 3,
      inv: { wood: 12 } }                      // only for storage containers
  ],
  dmg: {             // damage taken by AUTHORED things (absent = full health)
    "map_3.e9": 12,  // an authored entity, hp lost
    "h4,3": 30       // an authored wall edge, hp lost
  },
  gone: { "map_3.e9": 1, "h4,3": 1 }           // authored things that were destroyed
};
```

Rules of the layer:

- **Keys.** Wall edges use `Rules.edgeKey(orient, x, y)` (`"h12,7"`). Built entities get
  `mapId + '.b' + (++struct.n)` — the `.b` prefix can never collide with authored `.e` keys, and is never
  reused. Everything that already keys by entity key (`states`, `timers`, lever targets) works unchanged.
- **`prog` / `need`.** A frame has `prog < need`. Finished: `prog === need`. Frames are solid (they block)
  from the moment they are placed, with `max` already the final hp and `hp = max × frame_hp_pct`.
- **`by`** is the builder's public player id (`p.id`), never the token.
- **Authored damage** lives in `dmg` (hp lost, so content hp changes stay sane) and `gone`. An authored
  thing in `gone` is removed from the effective map. Authored things are **never** copied into `walls` /
  `ents`.
- **Size budget.** Keep entries terse (short field names as above). At 600 structures × ~120 bytes the
  layer is ~70 KB per map — fine for RTDB, but see §9.6 for why it is pushed separately from monsters.
- **Add helpers to `world.js`:** `structOf(ws, mapId)` (creates the empty shape), `touchStruct(st)`
  (`st.rev++`), `hpOf(c, ws, mapId, target)`, `maxHpOf(c, target)`.

A **target** (used by every damage/work function) is one of:
`{t:'wall', orient, x, y}` or `{t:'ent', key}`; resolve it with one function
`resolveTarget(c, ws, mapId, target)` → `{built: bool, rec, style|obj, max, hp, armor, material, breakable}`.

---

## 6. The effective map

### 6.1 `World.liveMap(c, ws, mapId)` (server and offline)

Returns the map every rule should use. Implementation:

```js
function liveMap(c, ws, mapId) {
  var base = c.maps[mapId]; if (!base) return null;
  var st = structOf(ws, mapId);
  if (!st.rev) return base;                              // nothing built or broken: zero cost
  var cache = base._live;                                // one cached effective map per base map
  if (cache && cache.rev === st.rev && cache.of === st) return cache.map;
  var m = Object.create(base);                           // inherits width/height/terrain/roof/...
  m.hWalls = overlayGrid(base.hWalls, st, 'h');          // copy only the rows that change
  m.vWalls = overlayGrid(base.vWalls, st, 'v');
  m.entities = base.entities.filter(function (e) { return !st.gone[e.key]; }).concat(st.ents);
  m._block = null; m._edgeOv = null; m._roofZones = base._roofZones;   // own derived caches
  m._struct = st;                                        // so rules can read hp/progress
  base._live = { rev: st.rev, of: st, map: m };
  return m;
}
```

- `overlayGrid`: for each `st.walls` entry of that orientation set the token; for each `st.gone` edge key
  set `''`. Copy a row before changing it; never mutate `base`.
- **`cache.of === st` matters:** on the server `ws` is re-read every request, so identity differs each
  step and the map is rebuilt once per step. That is acceptable (O(entities + changed rows)). In the
  browser (`Offline`) `ws` lives across steps, so the cache holds until `rev` changes.
- **Replace every rule-side `c.maps[...]` lookup in `shared/world.js`** (22 uses today) with `liveMap`
  where the code needs walls or entities: `entity`, `syncEdges`, `free`, `ensureMonsters`, `advance`,
  `cast`, `shoot`, `throwItem`, `onStep`, `interact`, `act`, `view`, `markExplored`. Leave the ones that
  only need static facts (`startMap`, `normalize`, `respawnPoint`, `teleport` target lookup). Add an
  internal `M(c, ws, mapId)` shorthand.
- `syncEdges` must write `_edgeOv` on the **live** map object (and `buildEdgeOv` then sees built doors and
  windows for free, because they are in `m.entities`).
- **Breached walls** (§8.6) are added to `_edgeOv` in `buildEdgeOv`: for every damaged wall edge below
  `breach_at_pct`, `{move: true, sight: false}`.
- `Rules.blockersAt` caches on `map._block`; because the live map is a fresh object per `rev`, the cache
  is correct without extra invalidation.

### 6.2 The client's effective map

The client has no `ws`. It receives the structure layer (§7.3) and builds the same thing with a shared
function so prediction and the server agree:

- Add `World.liveMapFromStruct(c, baseMap, struct)` — the body of `liveMap` taking the layer directly;
  `liveMap` calls it. The client calls it from `main.js` and stores the result; `mapOf()` returns it.
- On every new `rev`: call `renderer.setMap(liveMap)` (rebuilds `wall25`, the baked ground stays valid
  because terrain does not change — check `setMap` and skip the ground rebake when only walls/entities
  changed; add a `renderer.setStructure(map)` if needed), reset the `sight` cache key in `main.js`.

---

## 7. Actions and protocol

Game actions are sent as `do` (see `CLAUDE.md`). New action types handled in `World.act`:

| `type` | Fields | Does |
| ------ | ------ | ---- |
| `build` | `bp`, `x`, `y`, `side` (`N`/`W` for walls and wall fixtures; omitted for floor objects), `facing?` | Validates (§8.1), takes the cost, places a frame. |
| `work` | target (`x,y,side` for a wall, or `key`) | One work point on a frame (construct) or a damaged structure (repair). |
| `dismantle` | target | Removes a built structure the player may dismantle; refunds. |
| `upgrade` | target, `bp` | Applies an upgrade blueprint in place. |
| `strike` | target | A melee swing at a structure. |
| `craft` | `recipe`, `qty` (default 1), `station?` (entity key) | Crafts (§8.7). |
| `store` | `key` (container), `op` `put`/`take`, `item`, `qty` | Storage containers. |
| `claim` | `key` (claim object), `op` `add`/`remove`, `name` | Manage claim members (owner only). |

Existing actions gain structure effects: `shoot` and `throw` damage structures in their path/blast
(§8.5); `interact` on a `craft` object opens the crafting panel (client-side; the server just allows it);
`interact` on a storage container returns its contents.

### 7.1 Shared decision functions (must live in `shared/world.js`)

So the ghost preview, the menus and the referee agree:

- `World.canBuild(c, map, lk, p, bp, x, y, side)` → `{ok, reason}`. Pure; uses the effective map and a
  lookup (`serverLookup` / `viewLookup`).
- `World.canWork / canDismantle / canStrike(c, map, lk, p, target)` → `{ok, reason}`.
- `World.recipesFor(c, map, p, lk)` → the recipes this player can see here, each with `{can, missing[]}`.
- `World.actionsAt` (the left-click/hold menu) gains the entries: `Build here…`, `Work on`, `Repair`,
  `Dismantle`, `Attack` (for a structure), `Craft`, `Open storage`.

### 7.2 Events (pushed into `ev`, same shape as today)

- `{type:'struct', map, op:'place'|'work'|'done'|'hit'|'break'|'remove', target, hp, max, by}` — clients
  use it for sounds/particles/floating numbers. State itself comes from the layer, not from events.
- `info` messages to the actor for refusals (`reason` text from the `can*` functions).

### 7.3 Getting the layer to clients

- `World.view(...)` adds `struct: {rev, walls, ents, dmg, gone}` **only when the client is behind**:
  the client sends `structRev` with every `poll`/`act`/`load` (add it next to `since` in
  `client/js/api.js` and in `functions/index.js` → `step`), and `view` includes `struct` when
  `structRev !== st.rev`, otherwise just `structRev: st.rev`. `ents[].inv` is **never** sent (contents are
  private until opened).
- **Live push:** a second public node `struct/<mapId>`, a **JSON string** `{rev, walls, ents, dmg, gone}`
  written by the function only when `rev` changed in that step. Clients listen with a second
  `EventSource` (extend `Online.watchMap` or add `watchStruct`). JSON string because keys contain `.`.
  Add to `database.rules.json`: `"struct": {".read": true, ".write": false}` (deploy with `,database`).
- Offline and LAN backends get it through `view` alone (they poll fast).

---

## 8. Rules in detail

### 8.1 Placement (`canBuild`) — refuse with the first failing reason

1. `build` Config is on; blueprint exists and its `unlock` condition holds (`World.check`).
2. The player has the `tool` tag (any inventory item whose `tool` list contains it) and is within
   `station_range` of a finished station with the blueprint's `station` id, if required.
3. The player has the full `cost`.
4. **Reach:** the target edge/cell is within `build_reach` (Chebyshev) of the player, and there is line of
   sight to it (`canSee` to the cell on the player's side of the edge).
5. **No-build:** none of the cells the structure touches is no-build (§11.2). An edge touches the two
   cells it separates; an object touches its footprint.
6. **Claims:** if any touched cell lies inside a claim's radius, the player must be its owner or a member
   (§8.8).
7. **Caps:** the map has fewer than `structure_cap_per_map` built structures and the player fewer than
   `structure_cap_per_player` (count `walls` + `ents` with `by === p.id`).
8. **Shape rules**
   - `places = wall`: the edge is inside the map and holds no wall (neither authored-and-present nor built).
   - `places = object`, floor object: every footprint cell is standable terrain
     (`Rules.terrainAt` passable) and free of blockers, monsters and players (`lk.free` for each cell);
     the anchor cell holds no other built object.
   - `places = object`, wall fixture: the edge holds a wall if `needs_wall`; no other fixture already
     occupies any of the edges it spans (`World.fixtureEdges`).
9. A structure may never be placed so that it seals a player inside a 1-cell pocket with no way out
   **only if** that is cheap to check: skip this in v1 (dismantling your own wall is always possible).

On success (`build` action): `take` the cost, create the record with `prog: 0`, `need: bp.work`,
`max` = the style/object hp, `hp = max(1, round(max × frame_hp_pct))`, `touchStruct`, emit
`struct place`. If `bp.work <= 0` the structure is finished immediately.

### 8.2 Finding what a click means

- The client sends an explicit target; the server never guesses from facing for build actions.
- For `work` / `strike` / `dismantle` without a target (keyboard F on a frame in front of you), resolve
  like `interact` already does for fixtures: the edge shared by the player's cell and the faced cell
  first, then the faced cell's built object.

### 8.3 Construction and repair (`work`)

- Requires: adjacent to the target (same test as `near`, or for an edge: standing in one of its two
  cells), the blueprint's tool, `now >= p.cooldowns._work`. Sets `_work = now + work_ms`.
- **Frame:** `prog += 1`; `hp = min(max, hp + (max − frameHp) / need)`. When `prog === need`: `hp = max`,
  emit `struct done`.
- **Repair** (finished structure with `hp < max`, built or authored): each work point restores
  `max / need` hp (authored things: use `need = 4`) and takes `ceil(cost × repair_cost_pct / need)` of
  each cost item — for authored things with no blueprint, the cost is the style/object `salvage` list, or
  free if empty. Refuse when materials are missing.
- Work on an authored thing in `gone` is not possible (it is gone; rebuild with a blueprint on the now
  empty edge/cell).

### 8.4 Dismantle and upgrade

- **Dismantle:** only built structures; allowed for `by === p.id`, the claim owner/members when inside a
  claim, or anyone when outside every claim and `pvp_structures` is on. Requires the tool. Refunds
  `floor(cost × dismantle_refund_pct × hp/max)` of each item (or the `salvage` list if set). A storage
  container must be empty first.
- **Upgrade:** target must be a finished built structure whose blueprint is `bp.upgrade_of`. Takes the
  new blueprint's cost, swaps `tok`/`ref` and `max`, keeps the hp **ratio**, sets `bp`. No frame stage.

### 8.5 Damage

One function does all structure damage:

```js
damageStructure(c, ws, mapId, target, amount, source, ev)
// source = { kind: 'melee'|'bullet'|'blast'|'fire'|'monster', by: playerId|monsterId|null }
```

1. Resolve the target. Refuse silently when indestructible: hp 0 in content; `indestructible`;
   always-indestructible kinds; an **authored wall whose style is not `breakable`** (decision 4);
   `source.by` is a player and the structure belongs to someone else and `pvp_structures` is off
   (decision 3) — a player may always damage their own or unowned-and-outside-claims structures.
2. `dealt = max(0, round(amount × MULT[source.kind][material]) − armor)`.
3. Subtract: built → `rec.hp`; authored → `dmg[key] += dealt`. `touchStruct`. Emit `struct hit`.
4. At 0 hp → `destroyStructure` (§8.6).

Multipliers `MULT` (a constant table in `world.js`; overridable later by Config if the owner asks):

| | wood | metal | stone | glass |
| - | - | - | - | - |
| melee | 1 | 0.25 | 0.25 | 2 |
| bullet | 0.5 | 0.1 | 0.1 | 3 |
| blast | 2 | 1 | 1 | 4 |
| fire | 1 | 0 | 0 | 0 |
| monster | 1 | 0.5 | 0.5 | 2 |

Where each source is wired in:

- **Melee (`strike`):** amount = weapon `structure_dmg`, else `stats(c,p).atk × structure_dmg_scale`.
  Same reach test as the melee `attack` action, but for an edge the player must stand in one of its two
  cells. Uses the same cooldown as attacks.
- **Bullets (`shoot`):** today `shotReach` walks the line and stops at the first sight-blocking edge or
  cell. When the shot is stopped by a structure (not by a monster hit), damage that structure once with
  the weapon's `structure_dmg` (default `atk × structure_dmg_scale`). A shot that hits its monster does
  nothing to structures.
- **Blasts (`throwItem`):** after monsters, for every edge and built/authored object within `throwArea`
  of the landing cell **that the blast reaches** (reuse `blastCells`: an edge is reached when one of its
  two cells is in the blast set; an object when its cell is), apply `throwPower` as `blast`; if the item
  `burns`, also `fire` with half that amount. Walls still stop the blast for whatever lies behind them in
  the same detonation (compute the reached set before applying damage).
- **Monsters:** §8.9.
- **Fire over time** is out of scope for v1 (no burning state); `fire` is a one-off hit.

### 8.6 Damage stages, breach, destruction

- **Stage** (derived, not stored): `intact` (hp > 66%), `cracked` (33–66%), `breached` (< `breach_at_pct`).
  Used by the renderer for a crack overlay.
- **Breached walls** stop blocking **sight** (and shots) but still block movement — add them to the edge
  overlay in `buildEdgeOv`. This applies to wall edges only, and only to styles that block sight when
  intact. It is deliberately the same behaviour as an arch-less window.
- **Destroy** (`destroyStructure`):
  - built wall → delete `walls[key]`; authored wall → `gone[key] = 1`, delete `dmg[key]`.
  - built object → remove from `ents`; authored object → `gone[key] = 1`; also delete its entry in
    `states` and `timers`.
  - wall fixtures standing on a destroyed wall edge are destroyed with it (iterate fixtures whose
    `fixtureEdges` include the edge).
  - **Drops:** there are no ground items. If `source.by` is a player, `give` them the salvage
    (`dismantle_refund_pct` × cost, or the `salvage` list). Otherwise nothing drops. A destroyed storage
    container leaves a **rubble pile**: a built `container` entity (`ref` from Config `rubble_object`,
    default `obj_rubble` — add this seed object, walkable, storage) on the same cell holding the lost
    inventory, with no owner, so contents are never silently deleted.
  - emit `struct break`. `touchStruct`.
- A destroyed authored thing stays gone until the owner republishes the map **and** clears state, or a
  player rebuilds there. (No decay/reset: decision 5.) Add a key-gated function action
  `resetStructures {map}` for the owner (wipes that map's `struct`).

### 8.7 Crafting

- `craft` action: recipe exists and is unlocked; player has the tool tag; if `station` is set, a
  **finished** object of kind `craft` with that `properties.station` lies within `station_range` of the
  player with line of sight (and, inside a claim, the player is owner/member); the player has
  `inputs × qty`; the outputs fit (respect `stack_max`; refuse the whole craft if they would not).
  Then `take` inputs, `give` outputs. `qty` is clamped to 1–20.
- **Timed recipes** (`time_s > 0`): v1 implements them as a cooldown on the player
  (`p.cooldowns._craft = now + time_s×1000×qty`, outputs given immediately) so there is no queue state.
  A real station queue (start, walk away, collect) is a later phase; note it in the code.
- **Harvestables** (gathering): an authored object with `properties.hp > 0` and
  `properties.harvest = "item:qty; …"` yields that list to the player who destroys it and, instead of
  `gone` forever, gets `timers[key] = {at: now + harvest_respawn_s×1000, state: null}` plus a
  `regrow` marker in `gone` (`gone[key] = 2`); when the timer fires in `advance`, delete `gone[key]`.
  Extend the timer loop in `advance` to handle this.

### 8.8 Claims and ownership

- A **claim** is a built object of kind `claim` (blueprint category `other`). Its struct record carries
  `members: [playerId…]`. Radius from `properties.claim_radius` (Chebyshev, centred on its cell).
- Placement extra rules: the player owns fewer than `claim_max_per_player` claims on **all** maps (keep a
  counter on the player record: `p.claims = [{map, key}]`); its radius must not overlap another claim's.
- `World.claimAt(c, ws, mapId, x, y)` → the claim record covering a cell, or null.
  `World.mayUse(c, ws, mapId, p, x, y)` → true when there is no claim there, or `p.id` is owner/member.
- Inside a claim, `mayUse` gates: `build`, `work`, `dismantle`, `upgrade`, opening **built** doors,
  `store` on built containers, `craft` at built stations. Authored doors/containers inside a claim are
  **not** gated (a claim must not lock other players out of map content) — and to stop abuse, a claim may
  not be placed where its radius contains any authored door, container or teleport (add this to
  `canBuild` for claim blueprints).
- Destroying the claim object (monsters can) dissolves the claim; structures stay and become unowned.
- Members are added by **name**: the `claim add` action looks the name up among known players on the
  server (`functions/index.js` has all players loaded in `step`; pass a `findPlayer(name)` helper into
  `World.act` via the `players` argument or resolve the id in `index.js` before calling `act`). Offline:
  a no-op.

### 8.9 Monsters and structures

Change the "move toward target" part of the monster loop in `World.advance`:

- When a monster has a target and **every** step it tries fails, look at why: `Rules.tryMove` returns
  `reason` `wall` / `door` (an edge) or `object` (a cell; the result carries `entity`, the blocking
  entity's key). `occupied`, `blocked` and `edge` are not structures — ignore them. For the **first**
  direction tried, identify the blocking structure: the edge in that direction, or that entity.
- If `def.structure_atk > 0`, that structure is damageable (§8.5 rule 1 with `source.kind = 'monster'`),
  and `now >= (m.nextBash || 0)`: face it, `damageStructure(... def.structure_atk, {kind:'monster', by:m.id})`,
  `m.nextBash = now + def.structure_ms`, and `break` out of the step loop.
- A **closed built door** counts as a structure here (monsters bash doors); an open one is just a gap.
- Monsters never attack structures without a target, never choose a structure over a reachable player,
  and never path-find around a base (the greedy movement stays). This is intentionally simple; note in
  the code that proper pathfinding would change base design a lot and is a separate decision.
- Wandering monsters must not walk onto built floor objects that are not walkable — already true through
  `moveOpts`/`blockersAt` once they read the live map.
- Monster **spawns** (`ensureMonsters`, `place`): a spawn cell blocked by a built object must fall back
  to a nearby free cell (it already searches a radius; verify with a test).

---

## 9. Persistence and concurrency (Phase 0 — do this first)

### 9.1 Split the world per map

Replace the single `state/world` string with:

- `state/maps/<mapId>` — JSON string of that map's state **plus its own event log and counter**:
  `{states, timers, monsters, struct, log: [...], seq: n}`.
- Delete `state/world` after migration (9.5).

`ws` as the rules see it stays the same shape (`{seq, log, maps: {…}}`), so `shared/world.js` barely
changes: `functions/index.js` assembles a `ws` containing just the maps it loaded, with `ws.seq`/`ws.log`
pointing at the **actor's current map**.

Event sequence numbers become **per map**. Consequences to handle in `index.js` and the clients:

- `World.record(ws, ev)` writes to the current map's log. Events addressed `to` a player are stored in
  the map log too (as today).
- When the player changes map inside a step (door/teleport), the reply's `seq` is the **new** map's
  `seq`, and the reply's `events` are the events produced in this step (return them directly, do not
  re-read from the log). The client must reset `since` to the returned `seq` whenever `player.map`
  changed — check `apply()` in `client/js/main.js`.
- `eventsFor(ws, since, p)` keeps working against the current map's log.

### 9.2 Safe concurrent writes

Run each step inside an RTDB **transaction on `state/maps/<mapId>`**:

```js
await db.ref('state/maps/' + mapId).transaction(function (cur) {
  var ms = parse(cur);                      // may be called more than once — must be pure
  var p2 = clone(p), others = clonePlayers; // never mutate objects captured from outside
  ... World.advance / World.act on a ws built from ms ...
  result = { p: p2, touched, ev, view... }; // overwrite on every attempt; use the last one
  return JSON.stringify(ms);
});
```

- The transaction function **must be re-runnable**: clone the player(s) at the top of each attempt and
  only keep the result of the attempt that commits. `Math.random` inside is fine.
- After it commits: write the actor's player record and touched players (as today), then the public
  nodes (`world/<mapId>` when its signature changed, `struct/<mapId>` when `rev` changed).
- A step that crosses maps (teleport) runs a second transaction on the destination map for the
  arrival `advance`. Order: commit the source map first.
- Player records stay last-write-wins per player. That is acceptable: only the owner's own requests and
  rare cross-player combat write them. Note it; do not try to solve it here.
- Reads: `step` currently reads **all** players every request (`readPlayers`). Keep it for now, but note
  the cost grows with the player count; a follow-up can index players by map.

### 9.3 Offline and LAN

- `Offline` (browser): one `ws` in localStorage, single-threaded — no transaction needed. It must still
  honour per-map `seq`/`log` **only if** `World.record` changes; simplest is to leave `World.record` and
  `eventsFor` exactly as they are (global `ws.seq`/`ws.log`) and do the per-map split purely in
  `functions/index.js` by building a small `ws` per request. **Prefer this**: zero changes to shared code
  for Phase 0.
- LAN host (`host/server.js`): single process, keeps `ws` in memory; no change for Phase 0. It saves the
  whole world object to `host/save.json`, so `struct` is persisted without changes.

### 9.4 Public nodes

| Path | Content | Written when |
| ---- | ------- | ------------ |
| `world/<mapId>` | monsters + players (unchanged) | signature changed |
| `struct/<mapId>` | JSON string of the layer (no `inv`) | `struct.rev` changed |

Update `database.rules.json` (`struct` public-read) and tell the owner the deploy needs
`firebase deploy --only functions,database`.

### 9.5 Migration of live state

On the first request after deploy, if `state/maps` does not exist and `state/world` does: split it
(`maps.<id>` → `state/maps/<id>` with `log: []`, `seq: old.seq`), then delete `state/world`. Do it in a
one-off guarded block in `readMapState`. Players keep their characters (player records are untouched).

### 9.6 Cost guardrails (owner is cost-conscious)

- RTDB free tier: 360 MB/day downloads, 1 GB storage; function invocations 2M/month.
- The structure layer is pushed **only on change** and separately from the fast-changing monsters node,
  so walking around never re-downloads bases.
- Enforce `structure_cap_per_map`. With 600 structures the `struct/<mapId>` payload is ~70 KB; a build
  session that changes it 200 times with 5 listeners costs ~70 MB — under the daily limit but not by a
  wide margin. **If this becomes a problem**, switch `struct/<mapId>` from one string to a small object
  of chunks keyed by a `.`-free id (e.g. per 16×16 tile region) so a change re-sends one chunk. Design
  the client's `watchStruct` handler so that swap is local.
- Work/strike actions are rate-limited by cooldowns (`work_ms`), so a held key cannot flood the function.

---

## 10. Client

### 10.1 Build mode (`client/js/main.js`)

- Key **B** toggles build mode; **Esc** leaves. A build bar lists unlocked blueprints by category with
  cost; missing materials are shown in red. Pick one → the cursor carries a **ghost**.
- Ghost snapping: port the math of `E.mountCellAt` / `E.edgeAt` from `editor/js/editor.js` into a small
  shared helper used by both (put it in `client/js/render.js` exports or a new `shared/snap.js`; if a new
  shared file is added, list it in `client/index.html`, `editor/index.html` and `content/index.html`
  loaders; `tools/sync_server.sh` copies every `shared/*.js` on its own).
  - wall blueprints: nearest edge of the hovered cell;
  - wall fixtures: nearest edge, preferring an edge that holds a wall;
  - floor objects: the hovered cell (rotate facing with **R** while in build mode — `reload` uses R, so
    build mode must swallow it).
- Ghost colour: `World.canBuild(...)` every time the hover target changes — green when ok, red otherwise,
  with the `reason` as a tooltip.
- Left-click sends `{type:'build', …}`. **No prediction**: wait for the reply (~220 ms) — a wrongly
  predicted wall would block the player's own prediction. Show a brief "placing…" ghost meanwhile.
- Holding the use key (F / Space) facing a frame or damaged structure sends `work` on the `work_ms`
  cadence (reuse the hold-to-fire timer pattern near the `aiming && leftHeld` code).
- The hold-click action menu (`World.actionsAt`) shows Work on / Repair / Dismantle / Upgrade / Attack.

### 10.2 Rendering (`client/js/render.js`)

- Built walls and objects need no new drawing: they are in the effective map.
- **Frames:** draw at 55% opacity with a dashed outline; show a small progress bar (`prog/need`).
- **Damage stages:** a procedural crack overlay on the wall face (`drawPrim25` gets an optional `stage`)
  and on objects (a dark jagged overlay clipped to the sprite silhouette — reuse `silhouette()`).
  Breached walls draw a hole (reuse the `drawFaceWithHoles` punch with a jagged mask).
- **Health bars:** a thin bar above a structure for 2 s after it is hit (from `struct hit` events), like
  monster bars.
- **Claims:** while in build mode, tint the claim radius (own = green outline, other = red wash).
  No-build tiles get a red hatch while in build mode.
- The renderer reads hp from `map._struct` (the layer hangs on the effective map).
- Sight: nothing to do — `visibleCells` reads the same edge question. Roof zones are authored only;
  **player-built rooms are not "indoors"** in v1 (no roof, no darkness). Note this limitation to the owner.

### 10.3 Crafting and storage panels

- **Crafting panel** (opened by interacting with a station, or key **C** for hand recipes): list from
  `World.recipesFor`, grouped by `category`; each row shows inputs (owned/needed), output, a Craft button
  and a ×5 button. Sends `craft`.
- **Storage panel**: two columns (bag / container), click to move one stack, shift-click to move all.
  Sends `store`. Contents arrive in the reply to `interact` as an event
  `{type:'storage', to, key, inv, slots}`.
- Reuse the bag panel's markup and CSS (`#bag` in `client/index.html`).

### 10.4 State plumbing

- `apply(res)` in `main.js`: when `res.world.struct` is present, replace the local layer and rebuild the
  effective map (§6.2); always remember `res.world.structRev` and send it with the next request.
- The live push handler does the same for `struct/<mapId>`.
- `window.SheetsRPG` (test hook) gains `struct()` and `build()` (current blueprint / ghost target).

---

## 11. Editors

### 11.1 Content Studio

- New types `blueprints` and `recipes` appear automatically once they are in `shared/schema.js`
  (check `renderNav` and add labels). Fields of type `ref` give id pickers.
- Durability fields on Wall styles come from the schema. Objects: extend `objForm` (§4.2).
- Publish validation: the function accepts any tables object; nothing to change server-side.

### 11.2 Map editor — no-build tiles

- A new per-map grid `nobuild` (W×H, `'1'` = no building), stored exactly like `roof`:
  - `shared/content.js` → `decodeGrid(json(r.nobuild, []))` into `c.maps[id].nobuild`;
  - `functions/index.js` → `mergeMaps` (decode) and `publishMap` (store), both next to `roof`;
  - `editor/js/store.js` → encode/decode next to `roof` (it uses `encodeGrid` on save and `JSON.stringify` on load);
  - `editor/js/editor.js` / `panels.js` → a **No-build** palette tab cloned from the Roof tab
    (brush / erase / fill), drawn as a red hatch when its "show" toggle is on.
- Default for an unset grid: building allowed everywhere. Suggest to the owner: paint no-build over
  quest areas, spawn points and narrow passages.
- `Rules`/`World`: `World.noBuild(map, x, y)`.

---

## 12. Phases, in order, each shippable on its own

Each phase = one branch + one pull request, tests added to `tools/test_world.js` (rules) or
`tools/test.js` (server), a browser check, and a plain-language summary for the owner. Phases 0–2 need
`firebase deploy --only functions` (Phase 0 also `,database`).

### Phase 0 — per-map state and safe writes (§9)

Files: `functions/index.js`, `database.rules.json`, `client/js/main.js` (`since` reset on map change),
`tools/test.js`.
Acceptance:
- Two simulated steps on the same map run "at once" both keep their effects (test with a fake `db` whose
  `transaction` re-invokes the callback once with a changed value).
- Legacy `state/world` is migrated once and removed.
- Changing map returns the new map's `seq`; the client does not replay or miss events.
- No behaviour change in play; idle heartbeat still writes nothing public.

### Phase 1 — structure layer + damage to authored things (§5, §6, §8.5, §8.6)

Files: `shared/world.js`, `shared/rules.js` (only if `tryMove` needs to report the blocking entity),
`shared/content.js`, `shared/schema.js`, `data/tables.json`, `functions/index.js` (struct node,
`structRev`, `resetStructures`), `client/js/api.js`, `client/js/main.js`, `client/js/render.js`,
`content/js/cstudio.js` (durability fields).
Acceptance tests (rules):
- a breakable authored wall loses hp to a blast, becomes see-through below the breach threshold
  (`canSee` flips, `tryMove` still refuses), then is destroyed (`tryMove` succeeds);
- a non-breakable authored wall takes nothing;
- an authored door with hp can be struck down; its state entry is cleared; monsters then walk through;
- a shot stopped by a wooden wall damages it; a shot that hits a monster does not;
- blast damage does not reach an object behind an intact wall;
- `liveMap` returns the base map untouched when nothing has changed, and never mutates the base grids;
- `view` sends `struct` only when `structRev` differs.
Browser check: break a window and a door on a test map offline; cracks show; the gap is walkable.

### Phase 2 — recipes, stations, crafting panel (§4.6, §8.7, §10.3)

Acceptance: craft by hand; craft refused without station/tool/materials with the right message; outputs
respect `stack_max`; harvestable object yields and regrows; panel greys out what you cannot make.

### Phase 3 — blueprints and build mode (§4.5, §8.1–8.4, §10.1, §10.2, §11.2)

Acceptance: place a wall frame, it blocks at once; work finishes it; repair costs materials; dismantle
refunds by hp; upgrade keeps the hp ratio; no-build tiles refuse; caps refuse; a built door opens,
closes, blocks sight when shut; a built window peeks (the existing window rule); storage put/take;
a destroyed storage container leaves rubble with its contents; ghost colour matches the server's answer
for the same spot (same `canBuild`).

### Phase 4 — claims (§8.8)

Acceptance: non-member cannot build/dismantle/open a built door or container inside a claim; can still
use authored doors; claim cannot be placed over authored doors/containers; members by name; claim
destroyed → structures unowned.

### Phase 5 — monsters attack structures; polish (§8.9)

Acceptance: a monster with `structure_atk` blocked by a built wall between it and a player bashes it on
its cadence and walks through once it breaks; a monster with 0 does not; no target → no bashing.
Then: structure health bars, sounds/particles from `struct` events, balance pass with the owner.

### Later (not designed here)

Station queues, fire that spreads, power/electricity, traps as blueprints (the `trap` kind already
exists — a blueprint that places one mostly works after Phase 3), decay, player-built roofs/indoors,
real monster pathfinding, PvP raiding rules (`pvp_structures`).

---

## 13. Default numbers (seed data — the owner will tune them)

| Thing | hp | armor | material | Cost | Work |
| ----- | -- | ----- | -------- | ---- | ---- |
| Wood wall | 40 | 0 | wood | wood:4; nails:2 | 4 |
| Metal wall (upgrade of wood) | 120 | 3 | metal | scrap:6; nails:2 | 6 |
| Brick wall style (authored, breakable off) | 200 | 4 | stone | — | — |
| Wooden door | 30 | 0 | wood | wood:3; nails:2; scrap:1 | 4 |
| Window | 10 | 0 | glass | wood:2; glass:1 | 3 |
| Barricade (floor object, not walkable) | 25 | 0 | wood | wood:3 | 2 |
| Storage crate (12 stacks) | 30 | 0 | wood | wood:4; nails:1 | 3 |
| Workbench (`station: workbench`) | 40 | 0 | wood | wood:6; nails:4 | 6 |
| Claim flag (radius 8) | 60 | 0 | wood | wood:4; cloth:2 | 4 |
| Rubble pile | 0 (indestructible) | | | — | — |

Zombie: `structure_atk` 3, `structure_ms` 1500 → a wood wall lasts ~20 s against one zombie.
Starter materials (items of type `material`): `wood`, `nails`, `scrap`, `glass`, `cloth`.
Starter tools: `hammer` (tag `hammer`, required by all blueprints above), `axe` (tag `axe`, harvest trees).
Starter recipes: `nails` ← scrap:1 (workbench); `hammer` ← wood:1; scrap:2 (by hand); `planks`-style
intermediates are deliberately omitted to keep the first version small.

---

## 14. Risks and open points

- **Effective-map rebuild cost** on the server is per request. Fine at this scale; if maps reach
  thousands of entities, cache `liveMap` in the function instance keyed by `(mapId, rev)`.
- **Roof / indoors** are authored. Destroying an authored wall does not un-roof a room, and built rooms
  are not dark. Acceptable for v1; say so to the owner.
- **Greedy monster movement** means a one-tile gap far along a wall is not found; monsters bash the wall
  in front of them instead. This favours simple bases. It is a feature for now.
- **Grief vectors without PvP damage:** walling in a spawn or a doorway. Mitigations in this spec:
  no-build tiles, claims not allowed over authored doors, anyone may dismantle unowned structures outside
  claims **only when `pvp_structures` is on** — so with it off, a griefer's wall outside a claim can only
  be removed by its builder. **Add:** any player may `strike` (damage) a structure that is not inside a
  claim, regardless of `pvp_structures`; the switch then only protects structures **inside** claims.
  Confirm this reading of decision 3 with the owner before Phase 3.
- **Storage duplication:** `store` must run inside the map transaction and move items between the player
  record and the map record in one step; the player record is written after the map commits. A crash
  between the two could duplicate or lose a stack. Accept, but order the writes so the failure mode is
  *loss on take, duplication never*: on `take`, remove from the container in the transaction and give to
  the player after; on `put`, remove from the player **before** the transaction result is used — i.e.
  compute both inside the attempt and write the player record immediately after commit.
- **Content cache:** blueprints/recipes are content; the function caches content for 30 minutes after a
  publish from another instance. Same as today for all content.
- **Old clients** talking to a new function: unknown fields are ignored; a client that never sends
  `structRev` should always receive `struct` (treat missing as "behind").

---

## 15. Working conventions (from `CLAUDE.md` — follow them)

- Shared code is **classic scripts** (`var X = (function(){…})(); if (typeof module !== 'undefined') module.exports = X;`),
  no `import`, look other shared globals up lazily (`Rl()` in `world.js`).
- Anything that decides what is allowed goes in `shared/` so prediction and the referee agree.
- After editing `shared/`: run `tools/sync_server.sh` (regenerates `functions/shared/` and
  `server/shared_*.js`; never edit the copies). `node tools/test.js` and `node tools/test_world.js` must pass.
- New client script files: add to the cache-busting loaders in `client/index.html`, `editor/index.html`
  (and `content/index.html` when the studio needs them).
- Work on a branch, push, give the owner
  `https://github.com/migrationstudioshub/sheets-rpg/pull/new/<branch>`. `gh` is not authenticated.
  Commit only when the owner says so. Commit author is "Migration Studios"; keep personal names and
  emails out of commits and files.
- The owner deploys: `firebase deploy --only functions` (add `,database` when `database.rules.json`
  changes, `,firestore` for Firestore rules).
- Explain results in plain terms; the owner reads summaries, not diffs. Test in a real browser before
  handing over.
- **Local browser test recipe:** `node tools/serve.js` serves the repo on port 8765. Open
  `client/index.html?offline`. To test on a custom map without touching real data, put a full tables
  object (start from `data/tables.json`, add a map and objects, point Config `start_map`/`start_x`/
  `start_y` at it) into `localStorage['sheetsrpg.contentDraft']` and reload. Clear localStorage afterwards.
  `window.SheetsRPG.state()` / `.camera()` expose the game for checks.
- **Live data check:** `GET <FUNCTIONS_URL>?action=records` (raw tables) or `?action=content`.
  Re-read it before telling the owner something is or is not set — it changes while you work.
