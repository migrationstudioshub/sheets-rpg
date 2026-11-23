# Sheets RPG — notes for Claude

A step-based multiplayer RPG for the browser. **All game content lives in Firebase Firestore**, authored
in the **Content Studio** (`content/`, definitions) and the **map editor** (`editor/`, maps); the game,
editors and studios are static pages on GitHub Pages. The **live referee is a Firebase Cloud Function**
(`functions/`, runs `shared/world.js`, ~220 ms/action) — it also **serves content from Firestore** and
takes key-gated content/map writes. **Apps Script is retired** (code dormant in `server/`, no longer
deployed). The owner (the studio; writes in English) designs the game via the studios; Claude writes the code.

- Play: https://migrationstudioshub.github.io/sheets-rpg/ (redirects to `client/`)
- Map editor: https://migrationstudioshub.github.io/sheets-rpg/editor/ · Content Studio: `/content/` · Asset Studio (local art gen): `/studio/`
- Live referee + content server (Firebase Cloud Function): `FUNCTIONS_URL` in `client/js/config.js`
- Firestore content: `published/current` (definitions) + `maps/<id>` (maps; terrain compact-encoded via `shared/mapcode.js`). Reads are served by the function; writes are key-gated (`EDITOR_KEY` secret).
- Realtime Database (live world + game state): `FIREBASE_URL` in `client/js/config.js`
- `API_URL` (Apps Script) in config is **unused/retired**; `server/` is kept as dormant history.
- Design doc (architecture, data model, roadmap): https://claude.ai/artifact/EsFtyJzhajG4P2ZDfbW9Hw
- Setup guide for the owner: `docs/SETUP.md` (Firebase steps included); moving to the studio accounts: `docs/MIGRATION.md`

## How it fits together

```
browser (client/ editor/ content/)  --POST (join|load|poll|act)-->  Firebase Cloud Function (functions/index.js)
  draws with canvas, predicts moves                                 runs shared/world.js, has the final say (~220 ms)
  runs the same shared/*.js                                         game state in the Realtime Database
  listens to FIREBASE_URL for the live world (pushed) <---------------  writes world/<mapId> (the live view)

  --GET ?action=content|records|maps--> same function: builds content from Firestore (published/current + maps/<id>)
  --POST publish | publishMap | deleteMap (editor key)--> same function: writes Firestore (Content Studio / map editor)
```
`server/` (Apps Script) is **retired** — no longer deployed, kept only as dormant history/reference.

| Folder | Contents |
| --- | --- |
| `shared/` | Code that runs **unchanged** in the browser and in the Cloud Function: `content.js` (records → content object), `mapcode.js` (compact terrain encode/decode), `schema.js` (content-type field definitions; the Content Studio + publish validation use it), `autotile.js` (47-tile blob autotiling), `rules.js` (movement, collision), `world.js` (everything else: monsters, combat, skills, statuses, LoS, chests, doors, levers, traps, lockpicking, inventory, levels, events, mouse-click actions) |
| `client/` | Game page: `main.js` (loop, input, mouse actions, path walking, hotbar, aiming, HUD, bag), `render.js` (layered drawing, tall objects, animation, aim overlay, effects), `scatter.js` (ground variety layer), `api.js` (**Offline, Functions (Cloud Function) and Lan backends**; `Online` is a dormant Apps Script base class), `content_store.js` (content draft + publish), `assets.js`, `config.js` |
| `editor/` | Map editor: `editor.js` (canvas, tools, undo, maps, facing), `panels.js` (palette, inspector forms, Play-test), `store.js` (loads content + maps from the function, saves maps via `publishMap` encoded; offline draft) |
| `content/` | **Content Studio**: a hosted, schema-driven editor for all definition content (items, classes, skills, monsters, statuses, loot, config, terrain, objects, tilesets, levels). Edits a local draft → Play-test offline → Publish to Firestore. `js/cstudio.js`, driven by `shared/schema.js` |
| `studio/` | **Asset Studio** (local only): art generators (Gear / Tileset / Objects) driven by `tools/asset_server.py` + the vendored pipelines |
| `functions/` | **The live referee**: Firebase Cloud Function (`index.js`) running the same rules as the referee; `shared/` = **generated copies** of `/shared` (run `tools/sync_server.sh`; never edit the copies). Deployed with `firebase deploy --only functions`. `package-lock.json`/`node_modules` are npm's. |
| `server/` | **Retired** Apps Script project (`Code.js`, `shared_*.js` copies) — kept as dormant history; no longer deployed and not on any critical path. `sync_server.sh` still regenerates its copies for reference. |
| `data/` | `tables.json` — the seed/offline content (and what `tools/seed_firestore.js` published to Firestore). `GameData.xlsx`/`import/` are legacy snapshots from the Sheets era. |
| `art/` | `tilesets/fields_placeholder.png` (drawn by `tools/gen_placeholder_fields.py`, CraftPix layout), `sprites/` (placeholder monster/item sprites from `tools/gen_sprites.py`). Terrain/object sprites are imgur links in the data. |
| `tools/` | `build_gamedata.py` (builds data/ from data/import + the demo content), `sync_server.sh` (**syncs `shared/` into both `server/shared_*.js` and `functions/shared/`**), `test.js` (server with fake Google services), `test_world.js` (game rules), generators |
| `desktop/` | **Electron desktop app** ("Sheets RPG Studio"): wraps the authoring suite + offline Play + LAN host into one window. It *opens the repo folder* and serves it — primary server = the repo's Python `tools/asset_server.py` run by a **bundled frozen Python** (embeddable + pinned Pillow/numpy), Node static fallback with art off. Dev: `cd desktop && npm install && npm start`. Build the exe: `npm run prepare-python` then `npm run dist`. Does not change the web apps; art/data still commit → Pages as usual. See `desktop/README.md`. |
| root | `firebase.json`, `database.rules.json` (RTDB rules: `world` public-read, everything else locked), `.firebaserc` (project `sheets-rpg-73de1`) |

### Backends (all in `client/js/api.js`, same methods, same `{player, world, events, seq}` answers)
`create()` picks one: `FUNCTIONS_URL` set → **Functions**; else `API_URL` set → **Online**; else **Offline**.
A game action is sent as `do` (not `action`!): `{type: 'move', dirs} | {type: 'interact', x, y, verb} |
{type: 'attack', x, y} | {type: 'cast', skill, x, y} | {type: 'use', item} | {type: 'loadout', slot, entry} | {type: 'quest', op, id}`.
`POST {action: join|load|poll|act|save, ...}`.
- **Functions** (`FUNCTIONS_URL` set — the live default): play goes to the Cloud Function (~220 ms); content still
  loads from `API_URL`; the live world is **pushed** over Firebase (`FIREBASE_URL`), so polling is a slow heartbeat.
  State lives in the Realtime Database: `players/<token>` and `state/maps/<mapId>` (one record per map, written in a transaction) are **JSON strings** (their keys hold
  `.`, which RTDB forbids in keys); `world/<mapId>` is a plain object clients read.
  **What a step costs (Nov 2026, `functions/referee.js`):** the pushed `world/<mapId>` is written piece by piece — `m/<key>` a short
  string per monster (only the ones that changed), `d/<key>` its fixed part (kind, looks) once, players/doors when they change;
  `pushView` keeps what this instance last wrote and rewrites the whole record only when it cannot trust that (first push, another
  instance ran the map's last step — the record's `pi`/`pv` —, a failure, or a minute passed). `Api.watchMap` rebuilds the list from
  those pieces. The page sends `live` (the map whose push it is receiving → answers leave the monsters out) and `at` (its map → the
  step reads its own record and `here/<groundId>`, the who-is-in-this-building index, side by side, then only those characters —
  never the whole `players` tree). Saves and pushes run side by side. Keep it that way: nothing per step may grow with the number
  of monsters on the map or of characters ever made.
- **Online** (`API_URL` set, `FUNCTIONS_URL` empty): the Apps Script referee checks everything (~1.5 s). Same action
  protocol; also `GET ?action=content|tables|reload`. With `FIREBASE_URL` set it also writes the pushed live world.
- **Host** (`host/server.js`, the page it serves sets `window.GAME_LAN` → `Lan` backend): one player's computer is the referee, in memory, saved to
  `host/save.live/` (a folder; see below). It reads the LIVE content once at start-up (`GET FUNCTIONS_URL?action=content`, read-only; cache file, then
  `data/tables.json` as fallbacks; `CONTENT=local` forces the latter). **It runs a loop** (Nov 2026, stage 1 of the game server in
  `docs/QUESTS_INSTANCES_SERVER.md`): `tick()` advances every map with players `TICK_MS` (100) apart, and a hand-written WebSocket
  carries requests up (same bodies as POST plus `n`; answer `{re: n, …}`) and each turn's changes down (`{push: 1, …}`, only the
  parts of the view that differ from what that socket was last sent — `conn.wire`; the host counts events per socket). Page side:
  `Lan.connect` + `api.onPush` → `takePush` in `main.js`; `api.pushed` slows asking to a 5 s "still here". No socket = POST and
  the 250 ms poll, as before. `LAG_MS` fakes lag. Tests: `node tools/test_host.js`. **Saving (stage 2)** goes through
  `host/store.js` (`load()` / `put(kind, id, json)`; files today, the database later): `host/save.live/` holds one file per
  character, per map, and `world.json`; `save()` writes only records whose JSON changed, every `SAVE_MS` (3 s) and on Ctrl+C.
  All map state stays in memory (no load/unload). **Messages (stage 3)**: `client/js/wire.js` holds both ends
  (`Wire.pack` host, `Wire.unpack` page; the format is in its header) — answers and pushes alike carry only what changed on
  that socket, monsters/players one by one, and only those within Config `interest_radius` (20) of the player. Change the
  format there, never in `server.js`/`api.js`. `node tools/bots.js` = a crowd of scripted players (the load test).
  Friends elsewhere reach it over Tailscale.
- **Offline** (`API_URL` empty): `client/js/api.js` runs `shared/world.js` in the browser against `data/tables.json`
  (or a newer map-editor draft in localStorage), saving in localStorage. Useful for testing without the server.

**Editor saves** (to Apps Script): need the `EDITOR_KEY` script property, and send `base` (`Content.hash` /
`Content.mapHash` of what was loaded); the server answers `{error, conflict: true}` if the sheet changed since,
and the editor asks before resending with `force`.

## The data (Game Data spreadsheet = the database)
Tabs (one row per thing, first row = column names, the code finds columns by name and ignores unknown ones):
Config, Tilesets, Autotile, Terrain, Kinds, Objects, Maps, MapEntities, Items, Monsters, LootTables, Classes,
Skills, Statuses, Levels. Server spreadsheet: Players, WorldState (the server adds missing tabs/columns itself).

- **Kinds** describe each interactable kind's properties (type, default); the editor builds its forms from them.
  Settings resolve as kind default → object `properties` (JSON) → placement `data` (JSON in MapEntities).
- Object `kind`s: deco, container, door, switch, trap (step|timed), rest, sign, npc, spawn (places monsters), teleport, trigger, craft.
- **Data-driven actions** (`on_interact`, `on_use`, `on_cast`, trigger `do`): `give:item:n; take:item:n; gold:n; heal:n; damage:n; flag:x; unflag:x; teleport:map:x:y; set_state:key:state; xp:n; message:text`; conditions (`if`): `flag:x, !flag:x, has:item:n, level:n`.
- **Building:** the `Blueprints` tab (a wall style or an object, cost, work, tool). `World.canBuild` decides a spot (ghost and referee); built things live in the map's `struct` layer with keys `<map>.b<n>`; maps carry a `nobuild` grid (map editor, No-build tab). In game: B build, C craft. A N-S wall may carry a draw-only offset (`style:height:l|r`, the editor's cursor-side mode): `build` takes `off`, and `{type:'shift', target, off}` moves a built one; collision stays on the grid line. Holding the button keeps a wall stroke on its line (editor and game).
- **Claims:** a built object of kind `claim` (`properties.claim_radius`) makes the land around it its builder's base; `World.mayUse` / `claimAt` (on a live map) gate building, built doors/crates/stations and damage for non-members. Members are added by name from the flag's panel. Config: `claim_max_per_player`, `claim_max_members`, `claim_open_land`, `pvp_structures` (on = raids).
- **Crafting:** the `Recipes` tab (inputs → outputs, optional `station` and `tool`); a station is a kind-`craft` object with `properties.station`; items carry `tool` tags. `World.recipesFor` decides what can be made (panel and referee). Objects with `properties.harvest` yield items when broken and grow back.
- **Item types:** the `ItemTypes` tab (Content Studio → Item Types) gives each type ticks (`equip` + default `slot`, `shoot`,
  `consume` + `cooldown_s`, `throw`; `ammo`/`tool` only pick which item fields the form shows) and its own `properties`.
  `Content.build` turns them into `item.can`, `item.cooldownMs`, `item.props`; rules ask **`World.itemCan(it, what)`**, never
  the type's name (it falls back to the old names for content built without ticks). No tab = the built-in `Content.ITEM_TYPES`.
  Object kinds the owner adds live in Config `object_kinds` (edited from the Object Kinds card).
- **Belt and what you hold:** the hotbar is `World.BELT_SIZE` (10) belt slots (keys 1-9, 0), which take consumables,
  throwables, weapons and tools. One slot is in hand: `p.held` (-1 = nothing), set by `{type:'hold', slot}` → `World.holdSlot`,
  which is the only thing that sets `equipment.weapon` (a non-weapon in hand = no weapon). Choosing never consumes; `use`/`throw` do.
  **Skills are switched off for now** (owner, Nov 2026): Config `skills` = on brings back Q/E, the bag's abilities and the mana bar;
  the skill rules themselves are untouched. Client: wheel or number keys choose, a click on nothing uses held food; a referee that sends no `held` gets the old belt (`holdMode()`).
- **Turnable objects:** an object is authored facing south; `sprite_states` entries `north=` and `side=` (older `up`/`down`/`side`
  also read) make it turnable. A placement carries `data.facing` N|E|S|W (west = the side picture mirrored) and its `pass_*`
  sides turn with it. `Rules.facingOf / turnable / facingSprite / nextFacing / passOf` are the only readers. Editor: T or
  Shift+wheel, and a Facing setting; game: same keys on the build ghost (`build` takes `facing`), `{type:'turn', target}` after.
- **Monster brains** (Nov 2026): Monsters `brain` picks how one thinks; empty = the plain one inside `World.advance` (nearest player
  within `aggro_range`, straight line, through walls). **`walker`** = `World.walkerStep`: inert with no player within Config
  `walker_wake_radius` (24); it must SEE a target (`sight_range`, same LoS as players) to start; state is `m.ai` in the map record
  (`k` p|m|s = player, prey monster, built structure; `a` aggro left; last-known `x,y`; a kept path `p`), so a hunt survives everyone
  leaving. Aggro runs down by the walker's own turns, never by the clock. `findPath` counts blows as steps (bounded: `WALKER_NODES`,
  `WALKER_PLANS` per map per turn) and the walker breaks what is in the way with `damageStructure` (kind `monster`). Monsters `prey` =
  walkers hunt it. Config `walkers_attack_buildings` (on). A door or window that is destroyed now takes its stretch of wall along
  (a hole, for everyone). Hearing (shots) is not built.
- **Animals** (Nov 2026): two more brains. **`animal`** = `World.animalStep`: never attacks, wanders, runs from players and from
  hunters/walkers within `flee_range`. **`hunter`** = `hunterStep` (a wolf): goes for prey animals and players within `aggro_range`,
  rests after a kill (`m.fedUntil`). Monsters `carcass` = the object left where it dies (`leaveCarcass`: a struct entity marked
  `wild`: a take-only container holding the monster's `loot`, gone once emptied or after Config `carcass_rot_s`). `tame_with` = the item that tames it: in hand the animal does
  not flee, using the animal feeds it (`tame`: `m.tame/owner/free/home`; it leaves its spawner, which grows a new one). A tame one
  lives within 3 tiles of its home — the nearest object of kind **`coop`** within Config `coop_range` — and leaves its `lays` items (an item list) on the ground there every `lay_s` seconds, up to Config `egg_cap`: an entity of the built-in
  object `_drop` (kind **`pickup`**) whose `data.pickup` says what lies there. Monsters `loot` (an item list) = what it always gives: the
  contents of its carcass, or, with no carcass, straight to the killer. `wild` struct entities are
  nobody's: not repaired, not taken apart.
- **Walking:** `Rules.DIRS` stays four-way (facing, walls, "next to"); `Rules.DIAG` (NE/SE/SW/NW) are move-only steps, allowed
  by `tryMove` only when BOTH straight ways round the corner are open, costing `Rules.stepCost` = 1.4. Facing stays four-way
  (`Rules.faceFor`). The referee enforces walking speed: a per-player budget (`p.mvB`/`p.mvT`) refills one step per `move_ms`
  up to Config `move_burst` (6); unpaid steps are dropped. Tests that replay moves at one instant set `move_burst` huge.
  Reach is eight-way too: `near` = the eight tiles around you, and `Rules.reachBlocked` (any of the four edges at the shared corner) stops using or hitting round a wall end, for players and monsters. F/Space still acts on the tile you face.
- **Floors (multi-storey maps): read `docs/FLOORS.md` first.** A floor is a map of its own (`floor_of` + `z` on its row) tied to its
  ground map by `Content.linkFloors`; never parse a floor out of a map id — use `map.z / floorOf / floors`, `World.groundId /
  floorId / floorsOf`. Stages 1–3 are built (stage 3: `World.seesAcross` + `sightRadius`, `view.floors` / per-floor pushes, upper floors drawn as a facade): data, editor floor switch, teleports between floors, simple raised drawing, and walkable
  stairs (kind `stairs`; `tryMove` may answer with `map`; monsters follow as guests via `ws.transfers` → `arrivals`).
  Stage 4 too: floors talk through notices (`ws.transfers` → `World.applyNotice`), claims are shadowed onto every floor,
  `places: tile` blueprints lay floor, stairs can be built (they open the floor above), and `shoot` takes `map` for another floor.
- **Roofs (floors stage 5, see `docs/FLOORS.md`):** a roof over a storey IS the floor of the storey above. No separate roof blueprint: a FLOOR blueprint (`places: tile`)
  is put up as a roof with `build … roof: true` (`World.asRoof`; menu buttons Floor / Roof, V switches), placed from below → `struct.roof` on that storey + a notice laying `struct.floor` upstairs; `Content.autoFloors` supplies the
  empty storeys (Config `auto_floors`, game only — never the editors). Support = tiles from a wall (`World.roofSupport/roofSteps`,
  Config `roof_support`), returned by `canBuild` as `risk` safe|edge|fall (the green/yellow/red ghost). `World.covered` is the one
  "is this cell under cover" question (rain/fliers later). Nothing collapses yet.
- **Planned, not built:** mines (shared in the overworld, private in bases), digging, and terrain elevation (height per tile,
  drawn raised with cut-away) are designed in `docs/UNDERGROUND_AND_ELEVATION.md`. No voxels. Decide elevation before floors stage 3.
- **Quests** (Nov 2026; design and what is still planned in `docs/QUESTS_INSTANCES_SERVER.md`): the `Quests` tab (Content
  Studio → Story → Quests): `giver` / `ender` = NPC **object ids** (kind `npc`; every placement of that object offers it),
  `objectives` = a list of goals, one kind each from **`Content.GOAL_TYPES`** (kill, have, talk, use, drink, eat, goto, interact, craft,
  build, tame; drink / eat have no target: `ref` is `*`) — stored as JSON `[{type, ref, need, label}]` (goto: `ref` = map, `x, y, r`) by the Studio's objectives editor
  (`goalsField`), or hand-written text `kill:rat:5; goto:map_3:10:4:2`; `Content.parseGoals` reads both. A new kind = a row in
  `GOAL_TYPES` + one `questCount(c, p, type, ref, now, ev)` call where it happens (`questPlaces` does goto, after every action).
  `requires` (an `if` list — chains use `quest:<id>`), `rewards` (an action list; the Studio's `rewardsField` edits it as rows —
  XP, gold, any item, or start another quest — and keeps other verbs in an "Other actions" box),
  `rewards` (an action list), `choice` (choose-one items), `repeat_h`. `Content.build` parses objectives into `q.goals`.
  The log is `p.quests[id] = {n: [count per goal], at}` and `p.questsDone[id] = when`; **`World.questState` is the one question**
  (closed | open | active | ready | done | wait). `have` goals are never counted: they are what is in the bag, taken at hand-in.
  The page never works a state out: `publicPlayer` carries `quests` (`[{id, s, n}]`) and `questsOpen` (ids). Action
  `{type: 'quest', op: 'accept' | 'turnin' | 'abandon', id, choice?}`; conditions `quest:x` (handed in), `quest_active:x`; action
  verb `quest:<id>` starts one with no giver. Talking to an NPC sends the page an `npc` event (`key, ref, name, text` — the
  object's `text` property). LootTables `quest` = a row that only rolls for a player on that quest who still needs the item.
  Client: `openNpc` / `npcPanel` / `questPanel` (L) / `tracker` / `questMarks` in `main.js`.
  **Starting quests:** Config `start_quests` (ids) go into every NEW character's log (`World.newPlayer`); `p.intro` lists them
  until the page has shown its "New quest" window (`publicPlayer.questIntro` → `introPanel`, then quest op `seen`); a quest started
  by the action verb `quest:<id>` (e.g. in another quest's `rewards`) is announced the same way. Config `start_thirst` /
  `start_hunger` (0-100) = how a new character begins. **A quest with no giver and no ender is claimed where the player stands:**
  when it turns ready the page opens a "Quest complete" window (`claimPanel`: `done_text`, rewards, a Claim button → the
  same `turnin`, which needs no NPC without an ender); closed unclaimed, it waits in the quest log. Nothing finishes by itself.
  `questSweep` (after every action and on the map's turn) checks places reached; `questFinish` is the one way a quest is completed.
  **Tutorial steps** (Nov 2026) are quests with the `tutorial` tick: with no ender (and no choice) they are the ONE kind that
  finishes by itself (`questSweep`), so each step's `rewards` (`quest:<next>`) open the next "New quest" window at once; quest op
  `skip` (`questSkip`) closes the whole chain unrewarded and starts the first non-tutorial quest it leads to. Goal kinds for the
  basics: `walk` (steps, quiet), `hit`, `shoot`, `hold` (no target) and `ui` (`ref` from `Content.UI_PARTS`: bag, quests, craft,
  build — only the page knows, it sends quest op `did` + `what`; `didUi` in `main.js`). Quests `image` = a picture above the text
  (`questPic`; a GIF plays); `[W]` in quest text or a goal label is drawn as a key (`qtext`).
- **Who took part in a kill** (Nov 2026): a monster keeps `m.hits = {playerId: when}`; on death everyone who hit it within
  Config `kill_credit_s` (30) gets `World` `killShare`: the kill for their quests, **full XP**, their own gold and their own roll
  of the loot table. The last hitter gets it at once; the others' shares wait in the map record (`ms.credits`) and are given by
  `advance` (with a `kill` event addressed to them, which is also what makes the function save their record). What a monster
  always gives (`loot`) is not multiplied: it lies in the carcass, shared. A player's own roll lies in the same carcass as
  stacks marked `own: <playerId>`; **`boxInv(c, e, p)`** is what that player finds there, and the body stays until all is taken.
- **Planned, not built — dialogue, light phasing, instances, parties, bosses, raids:** `docs/QUESTS_INSTANCES_SERVER.md`.
- Item id `gold` means money. Tall objects: one image taller than a tile (the part above the footprint draws over characters). Animation: `frames` + `frame_ms` (horizontal strip).
- Skills: target `enemy|ally|self|tile|around`, `range`, `area`, `los`, `effect damage|heal|none`, amount = `power + scale × stat(atk|level)`, `status`, `dash`, `projectile`.

- **Walls, fixtures, sight** (one model, Nov 2026): walls are edge tokens `style:height` in `hWalls`/`vWalls`. **Every wall is 2 tiles high** (`Rules.WALL_H`, also the height of a storey): the token number is ignored, and anything lower (fence, gate) is an object. Anything on a
  wall is a **fixture** = an object with `properties.layer: 'wall'`, anchored by cell + `data.side`; it may be an
  **opening** (kind `door`, or `properties.opening: window|arch`). `World.syncEdges` folds openings into `map._edgeOv`
  and **`Rules.edgeBlocked(…, 'move'|'sight')` is the only edge question** (movement, LoS, shots, visibility).
  **Structures (Nov 2026, see `docs/BASE_BUILDING.md`):** each map's live state has a `struct` layer (damage to
  walls/objects, things destroyed; later, things built). **Rules must read `World.liveMap(c, ws, mapId)`** — the
  authored map with that layer applied — never `c.maps[id]` directly; the client builds the same map with
  `World.liveMapFromStruct` from `view.struct`. Health comes from data: wall styles `hp/armor/material/breakable`,
  object properties `hp/armor/material/indestructible/salvage`. `World.damageStructure` is the one way to hurt them.
  `World.visibleCells` = what a player sees (same LoS as combat); `World.perceive` → `seen|sensed|hidden` (`sensed` is the
  unused hook for a hearing sense). The client decides all occlusion in `Render.makeSight`: roof grid = "indoors",
  unknown indoor cells get the roof, out-of-sight cells a fog veil, and `cutH` drops E-W walls to stubs. Config:
  `sight` on|off, `sight_radius`, `fog_alpha`, `wall_cut_radius`, `wall_cut_alpha`, `roof_color`.

**Important:** the owner now edits the live Game Data spreadsheet. `tools/build_gamedata.py` and `data/*.xlsx`
only describe the *starting* data. **Never tell the owner to re-import GameData.xlsx** once they have made edits — it would
wipe them. For a new tab or column: make the code tolerate its absence (sensible defaults), and give the owner the
rows/columns to add by hand (or add a small server function that adds them). Keep `data/tables.json` in step
for offline mode by updating `build_gamedata.py` too.

## Rules of the code
- Shared code is **classic scripts**, not modules: `var X = (function () { ... })(); if (typeof module !== 'undefined') module.exports = X;`
  Apps Script has no `import`, and may load files in any order — so look other shared globals up **lazily**
  (see `Rl()` in `world.js`), never at load time.
- Anything that decides what is allowed goes in `shared/` so client prediction and the server agree
  (e.g. `World.checkTarget`, `World.actionsAt`, `World.viewLookup` vs `serverLookup`).
- Entity keys (`map_3.e9`) are stable ids that links refer to (lever targets, WorldState rows); never renumber them.
  They contain `.`, which the Realtime Database forbids in **keys** — so the Cloud Function stores `players`/`state/maps/<mapId>`
  as JSON strings, not trees (see `functions/index.js`).
- After editing `shared/`, run `tools/sync_server.sh` (it regenerates **both** `server/shared_*.js` and
  `functions/shared/`); `tools/test.js` fails if the `server/` copies are stale. Changing `shared/` means
  redeploying the Cloud Function too (`firebase deploy --only functions`), not just merging.
- Client pages load scripts with a cache-busting query string (`index.html` loader) — keep that when adding files,
  and add new shared files to both `client/index.html` and `editor/index.html` lists.

## Workflow with the owner
- Work on a **branch**, push, and give the owner the pull-request link
  (`https://github.com/migrationstudioshub/sheets-rpg/pull/new/<branch>`); they merge it on GitHub. `gh` is not authenticated here.
- **No more Apps Script deploy.** The old `deploy-server.yml` GitHub Action is removed; `server/` is dormant history.
  After editing anything in `shared/`, still run `tools/sync_server.sh` (it keeps `functions/shared/` current) and
  redeploy the function — the tests (`tools/test.js`) check the copies are in sync.
- **The Cloud Function deploys manually** (the owner): `firebase deploy --only functions` from the repo on the studio
  account (Blaze plan); add `,firestore` when `firestore.rules` changes, `,database` for RTDB rules. The editor key is a
  function secret: `firebase functions:secrets:set EDITOR_KEY`.
- **Content changes go live through the Content Studio / map editor** (Publish → Firestore via the function). The function
  caches content ~30 min; a cold start or re-publish refreshes it.
- **Seeding/one-offs:** `tools/seed_firestore.js <functionUrl> <key>` publishes `data/tables.json`;
  `tools/migrate_maps.js <functionUrl> <key>` moves maps from the content blob into their own docs.
- **To see the live data:** `GET <FUNCTIONS_URL>?action=content` (built content) or `?action=records` / `?action=maps`
  (raw). The cloud sandbox can't reach Google hosts; fetch from the owner's built-in browser pane instead.
- Explain things in plain terms; the owner reads summaries, not diffs. Test in a real browser before handing over.

## Testing (in Claude's cloud workspace)
- `node tools/test.js` (server, fake SpreadsheetApp/CacheService), `node tools/test_world.js` (game rules) and
  `node tools/test_functions.js` (the Cloud Function's step, `functions/referee.js`, on a fake database) must pass.
- Browser: Playwright with `/usr/bin/google-chrome` against `python3 -m http.server 8765` started from the repo root
  **in the same shell command** (background servers get killed between commands). imgur is blocked in the sandbox, so
  art shows as lettered placeholders and pages wait ~8 s for image timeouts; wait for `#log` text before acting.
  `window.SheetsRPG` exposes `state()`, `camera()`, `aim()`, `plan()` for tests.
- The owner's built-in browser can reach the live site and the Apps Script URL (good for checking the real server).

## Status (9 Nov 2026)
Moved to the studio accounts (`docs/MIGRATION.md`): repo `migrationstudioshub/sheets-rpg` (one fresh commit, author
"Migration Studios" with the GitHub noreply email — keep personal names/emails out of commits and files), Pages on,
`production` environment with both secrets, automatic deploy green, `API_URL` = the studio's web app.
**Latency fix shipped (9 Nov 2026): the live referee is now a Firebase Cloud Function (~220 ms/action), not Apps
Script (~1.5 s).** Path: quick wins (attack prediction + faster polling) → Firebase live world (positions pushed) →
Cloud Function referee (Option 2, below). Live for everyone via `FUNCTIONS_URL` in `config.js`. The cutover gave
players **fresh characters** (the function keeps its own `players` store; the old Sheet characters are not migrated).

Done: M1 walkabout · M2 map editor · M3 RPG core · M4 skills (6 classes) · mouse controls + lockpicking · online server ·
deploy secrets locked to `main` · editor refuses to overwrite sheet edits made after it loaded (asks first) ·
**attack/own-cast prediction · Firebase live-world push · fast Cloud Function referee (live)**.

Next: **M5 multiplayer** — the fast referee + push already make other players move in real time; still want chat,
party/ally targeting UX, and drawing other players nicely (the `paper-doll-sprites` branch is layered player sprites,
unmerged) · **M6 story**: NPC dialogue (Dialogue tab), shops, quests.
Open follow-ups from the referee work: world writes are now **per map, in a transaction** (`functions/referee.js`), so simultaneous actions on a map
no longer overwrite each other; player records are still last-write-wins per player; no **Sheet→RTDB character migration**; a smoother idle-monster tick
(Cloud Scheduler's 1-min minimum rules out a true server tick; idle monsters rely on the client heartbeat).
Also: an art pipeline script for `art/inbox/`; real skill icons; editor screens for Items/Skills/Classes (today via the sheet).

## Firebase (built — this is how the speed came from)
On the **Blaze** plan (studio account, project `sheets-rpg-73de1`); at ~10 players it sits in the free tier (~$0).
Watch the no-cost thresholds in the Firebase console: Realtime Database **downloads 360 MB/day**, storage 1 GB,
**function invocations 2M/month**. The heartbeat poll + write-on-change keep these low; the pre-cutover full-poll
design was the usage risk.
- **Option 1 (live world over Firebase), built first and still available**: the referee (Apps Script OR the function)
  writes `world/<mapId>` after each step; clients listen (`FIREBASE_URL`, EventSource) instead of only polling, so the
  world looks live. On its own (Apps Script referee) it's capped at ~1.5 s because the referee is still slow.
- **Option 2 (fast referee), now live**: `functions/index.js` runs `shared/world.js` as the referee in ~220 ms, state in
  the Realtime Database. This is what the live game uses (`FUNCTIONS_URL`).
- Why it was easy to swap: the client talks through `client/js/api.js` (one backend object, same methods for all three),
  and the live world is a self-contained view written per map.

Licences: the repo is public — don't commit art that may not be redistributed (e.g. CraftPix packs).
