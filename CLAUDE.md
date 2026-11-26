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
| `data/` | **`game/`** — the owner's game in local mode (below): `tables.json` (definitions) + `maps/<id>.json` + `maps/index.json`. `tables.json` — the sample world the tests use (and the offline fallback when there is no `game/`; also what `tools/seed_firestore.js` published to Firestore). `GameData.xlsx`/`import/` are legacy snapshots from the Sheets era. |
| `art/` | `tilesets/fields_placeholder.png` (drawn by `tools/gen_placeholder_fields.py`, CraftPix layout), `sprites/` (placeholder monster/item sprites from `tools/gen_sprites.py`). Terrain/object sprites are imgur links in the data. |
| `tools/` | `build_gamedata.py` (builds data/ from data/import + the demo content), `sync_server.sh` (**syncs `shared/` into both `server/shared_*.js` and `functions/shared/`**), `test.js` (server with fake Google services), `test_world.js` (game rules), generators |
| `desktop/` | **Electron desktop app** ("Sheets RPG Studio"): wraps the authoring suite + offline Play + LAN host into one window. It *opens the repo folder* and serves it — primary server = the repo's Python `tools/asset_server.py` run by a **bundled frozen Python** (embeddable + pinned Pillow/numpy), Node static fallback with art off. Dev: `cd desktop && npm install && npm start`. Build the exe: `npm run prepare-python` then `npm run dist`. Does not change the web apps; art/data still commit → Pages as usual. See `desktop/README.md`. |
| root | `firebase.json`, `database.rules.json` (RTDB rules: `world` public-read, everything else locked), `.firebaserc` (project `sheets-rpg-73de1`) |

### Local mode — how the owner works now (25 Nov 2026)
**The owner does not care about the live game yet**: they are building the Studio, and work locally only — nothing is
published to Firestore/Firebase. Their game is **project files that travel with Git**: `data/game/tables.json` (every
definition tab, one row per line; no maps) + `data/game/maps/<id>.json` (one map each: the "map document", terrain packed by
`shared/mapcode.js`, one entity per line) + `data/game/maps/index.json` (the ids, in order). `client/js/localdata.js` is the
one place that knows this layout (`assemble` files → tables, `docOf`/`split` back, `tablesText`/`mapText` the file format);
`tools/pull_live.js` made the first copy from the live data (read-only). **Local mode switches on by itself** when the page's
own server answers `GET /data/ping` — `tools/asset_server.py` (what the desktop app runs) and the desktop app's Node fallback
`desktop/server.js`, which both take `POST /data/save-tabs` (`{tabs}` merged tab by tab, `all` = replace) / `save-map` /
`delete-map`, write only inside `data/game/`, and write byte-identical files. Then: the **Content Studio** saves each change
into the files a moment after it is made (only the tabs that changed; no draft, no Publish; an old browser draft is offered
once), the **map editor**'s Save writes the maps that changed (unsaved edits still autosave as the WIP), **Play / Play-test**
(`Offline.loadContent`) read the files and ignore drafts, and the **LAN host** reads `data/game/` by default (`CONTENT=live` /
`CONTENT=local` = the sample). GitHub Pages and a plain static server are unchanged (online, as before). Default to local
solutions; keep the live path working but do not steer the owner to Publish, deploys or live data unless they ask.

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

- **Kinds** describe each interactable kind's properties (type, default); the editor builds its forms from them
  (`field` in `editor/js/panels.js`; type `item_list` = rows of item × amount, `itemListField`, stored as `potion:2, gold:30`).
  Settings resolve as kind default → object `properties` (JSON) → placement `data` (JSON in MapEntities).
- Object `kind`s: deco, container, door, switch, trap (step|timed), rest, sign, npc, spawn (places monsters), teleport, trigger, craft.
- **Data-driven actions** (`on_interact`, `on_use`, `on_cast`, trigger `do`): `give:item:n; take:item:n; gold:n; heal:n; damage:n; flag:x; unflag:x; teleport:map:x:y; set_state:key:state; xp:n; message:text`; conditions (`if`): `flag:x, !flag:x, has:item:n, level:n`.
- **Building:** the `Blueprints` tab (a wall style or an object, cost, work, tool). `World.canBuild` decides a spot (ghost and referee); built things live in the map's `struct` layer with keys `<map>.b<n>`; maps carry a `nobuild` grid (map editor, No-build tab). In game: B build; C (or I) opens the inventory window, whose Crafting column is all crafting: hand recipes plus those of a station you stand next to (there is no separate crafting window; using a workbench opens the inventory too). A N-S wall may carry a draw-only offset (`style:height:l|r`, the editor's cursor-side mode): `build` takes `off`, and `{type:'shift', target, off}` moves a built one; collision stays on the grid line. Holding the button keeps a wall stroke on its line (editor and game).
- **Claims:** a built object of kind `claim` (`properties.claim_radius`) makes the land around it its builder's base; `World.mayUse` / `claimAt` (on a live map) gate building, built doors/crates/stations and damage for non-members. Members are added by name from the flag's panel. Config: `claim_max_per_player`, `claim_max_members`, `claim_open_land`, `pvp_structures` (on = raids).
- **Crafting:** the `Recipes` tab (inputs → outputs, optional `station` and `tool`); a station is a kind-`craft` object with `properties.station`; items carry `tool` tags. `World.recipesFor` decides what can be made (panel and referee). Objects with `properties.harvest` yield items when broken and grow back.
- **Cookers** (campfire, furnace): a kind-`craft` object with `properties.cooks` makes its station's recipes over time, with fuel
  (Items `fuel_s`). It holds three runs of cells in one list — raw, fuel, cooked — `raw_slots` / `fuel_slots` / `out_slots` each
  (20 when not said; `rec.lay` in `ms.cookers[key]`, an old three-cell record is re-laid when opened). It cooks ONLY its job, `rec.job = {id, n}`
  (batches of one recipe, set by the Cook button — never what merely lies in the raw cells); `cookPick` says whether the job can go on
  (every input in the raw cells, room for every output); `cookTick` counts the time. Actions: `inv` moves (a cell picks
  the run), `store` ops `light` / `douse` / `load` (`recipe`, `qty`: sets or adds to the job, moves what is missing from the bag into
  the raw cells, lights it if there is fuel) / `cancel`. Page: `cookWindow` in `main.js` (backpack | the fire: raw > fire > cooked, fuel, the switch | its recipes), drawn from `storage.cook`. The campfire in `data/game/` has 6 raw, 4 fuel, 6 cooked cells.
- **What is worn:** an item's `slot` = `weapon` (in hand), `helm` (head), `armor` (chest), `pants`, `feet`, `gloves`, `back`
  (`World.WORN_SLOTS`), or `accessory` — four at once, in `p.equipment.accessory1…4`. `World.wornAt` / `slotFor` are the only
  two that know the accessory places; `use` takes `slot` (which place; a worn accessory dropped on another place moves).
  Page: with no container open the inventory is `invWindow` in `main.js` — who you are (the worn slots as cells beside
  your own figure, `DOLL_SLOTS`) | the backpack and the picked item's card | hand recipes (`recipeBook`: a list of rows
  and the picked one on a notebook page; shared with the cooking window).
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
  rests after a kill (`m.fedUntil`). Monsters `carcass` = only what the loot bag it leaves LOOKS like (see "Where loot lies": there are no carcasses apart from loot bags). `tame_with` = the item that tames it: in hand the animal does
  not flee, using the animal feeds it (`tame`: `m.tame/owner/free/home`; it leaves its spawner, which grows a new one). A tame one
  lives within 3 tiles of its home — the nearest object of kind **`coop`** within Config `coop_range` — and leaves its `lays` items (an item list) on the ground there every `lay_s` seconds, up to Config `egg_cap`: an entity of the built-in
  object `_drop` (kind **`pickup`**) whose `data.pickup` says what lies there. Monsters `loot` (an item list) = what it always gives: it lies in its loot bag. `wild` struct entities are
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
- **Waterfalls** (draw-only, `client/js/render.js`): water on raised ground falls down the cliff to its south. `Render.fallAt` is the one question (a terrain that is `water` or has a `fall` picture, unless Config `waterfalls` = off; the map's `falls` grid, painted on the editor's Height tab, forces `1` / a tint name or forbids `0`); `fallCells` + `drawFalls` draw the moving strip (default `art/tilesets/waterfall_anim.png`, 4 tiles per frame: single, left, middle, right) over the baked face. A new map grid must be added in `shared/content.js`, `editor/js/editor.js` (mapRows, snapshot, resize), `editor/js/store.js` and `functions/index.js` (both ways), and `client/js/localdata.js` (`GRIDS`). The map editor draws ground raised like the game (`E.show.raised`, H; `mapPt` turns the pointer into the tile drawn under it).
- **Shallow water** (Nov 2026): the map's `shallow` grid (`'1'` = shallow) marks water you can wade through. Not a terrain of its own (that would draw a shoreline between deep and shallow): the same water, a depth per tile. Painted in the map editor with the water itself — Terrain tab, pick a water terrain, **Depth: Deep / Shallow** (`E.brush.shallow`; painting water sets the tile's depth, painting anything else on the overlay or erasing clears it; the eyedropper picks the depth up). Rules: `Rules.terrainAt` answers a shallow water tile with the same terrain made walkable on every side (`.shallow`, still a water source); `Rules.isWater` / `shallowAt`. Nothing else asks. Drawing (`Render.shallowCells`): only overlay water is see-through (the base painted under it shows); Config `shallow_alpha` (0.45) = how much water shows, `shallow_blend` (2) = tiles the fade between shallow and deep takes, centred on the walkable edge, wobbled by fixed noise. See-through cells are drawn live with the moving ground (`animatedCells` → `drawShallow`), never baked (`bakeGround(…, live)`), so the water is never laid twice. **Wading is slower:** `Rules.stepCost(dir, content, map, x, y)` (x, y = where the step lands) is ×Config `shallow_slow` (2) into shallow water — the referee's walking budget, the page's pace and glide (`lastCost`), and the monsters' turns all ask it. **Wading looks submerged:** `paintActor` in `render.js` draws a character in shallow water through `drawWading` (scratch canvas): below a waterline (Config `wade_depth` 0.22 of the figure, from its feet: the bust's pedestal, up to where the chest begins; `wadeAt` blends it in as it glides onto the tile) the figure is faded and tinted the water's colour, with a ripple ring at the line. `SheetsRPG.content()` / `remap()` are test hooks (change a map in memory, redraw).
- **Walking sway** (draw-only, owner asked for it subtle): a figure between two tiles leans Config `walk_wobble` degrees (2.5; 0 = off) about its feet and lifts one art pixel, most at mid-step, alternating side each step, aiming or not (`wobbleOf` in `render.js`; timed by where it is drawn, so it follows the walking pace). Standing still it breathes instead (`bobOf`).
- **Things on cliff faces** (draw-only): an object with `properties.layer: 'cliff'` is placed on the south face of a raised tile (entity `x, y` = that tile; `data.up` tiles above the foot, `data.dx` sideways from the middle, `data.flip`); any number per face. `Render.cliffRect` is the one place that works out where it is drawn (game, editor ghost, editor picking). To the rules it is a walkable object on the tile above. Cliff face pictures: `<tileset>_face.png` = single, left, middle, right (+ an optional 5th = a second middle).
- **Things that appear on the ground** (`World` `growStep`, called from `advance`): an object with `properties.drops` (+ `drop_s`, `drop_radius` 2, `drop_max` 3) and a terrain with `grows` (+ `grow_s` = seconds per item per 100 tiles, `grow_max` 2; base or overlay, wherever it is the ground you see) leave `_drop` pickups in the struct layer. `ms.growAt` is the map's clock; time away is caught up (Config `growth_catchup_s`). A round (Config `growth_round_s`) tries `GROW_TRIES` random sources of each kind, never all, and Config `ground_item_cap` bounds a map. `growSources` caches the sources on the authored map (`_grow`).
- **Appearance sets** (paper-doll monsters): the `Appearances` tab (Content Studio → Appearances, `appearanceForm`) = an ordered
  list of layers, bottom to top; each layer picks one sprite per spawn by weight (or none, its `empty` weight) and may have its
  own pool of `tints`. Monsters `appearance` = one or more sets, `set` or `set:weight, set2:weight2`; `World.rollLook` picks a set
  and rolls it once per spawn, the look is kept on the monster and sent as `look: [{path, tint}]`; the page draws it with the
  player paper-doll code (`monsterLayers` in `main.js`, `client/js/tint.js`). Empty = the flat `sprite`. The Studio's sprite
  pickers read `art/manifest.json` (a published page cannot list a folder): after adding art run
  `node tools/build_art_manifest.js` and commit both. `tools/build_gamedata.py` (Sheets era) does not know this tab: the
  offline seed `data/tables.json` is kept by hand.
- **NPCs** (plan agreed 25 Nov 2026; the owner wants to be **asked the design questions of each step before it is started**):
  an NPC stays an anchored object of kind `npc` (never hurt, no brain); order: 1 looks (built), 2 dialogue + its Studio
  editor (built, see Dialogue below), 3 shops, 4 moving NPCs only if wanted. **NPCs are authored apart from objects** (owner's choice): still rows of
  the Objects table, but the Content Studio has an **NPCs** panel (Story → NPCs: type `'npcs'` = the Objects rows of kind
  npc — `tab`/`idField`/`isNpc`, `npcList`, `npcForm`: id, name, what it says (`properties.text`), outfit, the quests it
  gives / takes back, picture and notes under More) and the map editor an **NPCs** palette tab (`paletteTab 'npcs'`, + New
  NPC); NPCs are left out of the Objects panel and tab. Objects and NPCs share `E.brush.object`, each tab remembering its
  own pick (`E.tabBrush`, in `E.setPaletteTab`). **Step 1, draw-only:** object `properties.outfit` = `[{path, tint, type}]`,
  bottom to top, the exact pictures it wears (`npcOutfit` in `cstudio.js`; no random rolls; hair with no colour = `hair_brown`,
  as hair draws only through its mask). `Render.outfitOf / outfitLayers / drawOutfit` are the one place that reads it: the
  game (`npcActors` in `main.js`; `hiddenEntity` drops its object picture), the map editor's map and its palette thumbnail
  all draw the figure. In the game it **always faces YOU**, worked out on each page so every player
  sees it turned towards themself; its name shows within `NPC_NAME_R` (3) tiles or under the mouse; it is shown wherever
  the place is known, like objects (`a.fixed`), not only in line of sight. **Idle breathing** is for every figure standing
  still — players, monsters, NPCs: actors carry `idle` + `ph`, `bobOf` in `render.js` lifts the figure one art pixel on a
  slow beat (health bar and name stay put); Config `idle_bob` = off stops it.
- **Dialogue** (NPC step 2, built 26 Nov 2026; the owner's choices: a branching tree, conditions + actions, quests inside
  the conversation, a node map + side form in the Studio, dialogues in a tab of their own, a window with the NPC's figure,
  memory through conditions, the NPC's one line kept as the fallback). The `Dialogues` tab (Content Studio → Story →
  Dialogues): `nodes` = `[{id, text, start, if, x, y, answers: [{id, text, if, do, to, once}]}]` — a node is a LINE the NPC
  says, an answer is what the player may say back (`to` = the next line, empty = the talk ends; `do` = an action list, the
  same as quest rewards; `once` = gone for that character after it is picked; `x, y` = where the box sits on the map,
  ignored by the game). `Content.build` → `c.dialogues[id] = {nodes: {id: {text, start, cond, answers: [{id, text, cond,
  run, to, once}]}}, order}`. An NPC names one in `properties.dialogue` (several may share one); none, or one with no line
  to open on, = its `text` line and the quest list, as before. **Rules** (`shared/world.js`): `talkTo` opens on the FIRST
  `start` line (row order) whose condition holds (`dlgStart`), `dlgSay` sends the page an `npc` event with `dlg = {id,
  node, hub, answers: [{a, text}]}` (only the answers this character may give), and `{type: 'talk', key, a}` →
  `talkAct` takes the answer picked, runs its actions and says the next line or ends (`npc` event with `end`). Where a
  talk stands is `p.talkAt = {k, d, n}`: only an answer of the line last said is taken, and only beside the NPC. Memory:
  `p.talk[dialogue] = {n: [lines said], a: [once-answers used]}`; `World.check(c, p, cond, dlg)` knows `talked` and
  `said:<line>` inside a dialogue (`talked:<dialogue>`, `said:<dialogue>/<line>` anywhere else). A line has no actions:
  only answers do things. **Page** (`main.js`): `dlgView` in the NPC window (`#npcp`) = the figure (`npcPortrait`) beside
  the line, then the numbered answers (`dlgRows`; keys 1-9 → `dlgKey`); on a `hub` line (one that can open the talk) the
  NPC's quests are added to the answers by themselves, and picking one shows the quest view as before. **Studio**
  (`cstudio.js` `dialogueForm`, `content/js/dialogmap.js` drawn into `#qmap`): the form edits ONE line at a time (the
  one picked on the map or in the strip of lines) and its answers; the answers' actions use the rewards editor; the NPC
  page has a Dialogue picker (+ New dialogue makes one from its line). Not built: text that names the player, answers that
  open a shop (step 3), a visual condition editor (conditions are typed).
- **Art by file name** (no data needed): a tileset `<key>_auto.png` (`…_auto_anim.png` = animated) finds its base tile
  `<key>.png`, its variety sheets (`scatter.json`), its cliff face `<key>_face.png` and, with a tint, its mask `….tint.png`;
  a wall top `wall_<m>_top_auto.png` finds its face `wall_<m>_face.png` (`Scatter.tileInfo`). A tintable picture `foo.png`
  has its mask `foo.tint.png` next to it. The art generators (Asset Studio, `/studio/`) are local only: they need Python and a
  Gemini key in `tools/google_api_key.txt` (never committed), and run the vendored pipelines as subprocesses of
  `tools/asset_server.py`. Not built: blocking a multi-tile object's whole footprint (the author paints the terrain impassable).
- **Planned, not built:** mines (shared in the overworld, private in bases), digging, and terrain elevation (height per tile,
  drawn raised with cut-away) are designed in `docs/UNDERGROUND_AND_ELEVATION.md`. No voxels. Decide elevation before floors stage 3.
- **Quests** (Nov 2026; design and what is still planned in `docs/QUESTS_INSTANCES_SERVER.md`): the `Quests` tab (Content
  Studio → Story → Quests): `giver` / `ender` = NPC **object ids** (kind `npc`; every placement of that object offers it),
  `objectives` = a list of goals, one kind each from **`Content.GOAL_TYPES`** (kill, have, own, talk, use, drink, eat, goto, interact, craft,
  build, tame, walk, hit, shoot, hold, ui; see "More goal rules" below) — stored as JSON `[{type, ref, need, label}]` (goto: `ref` = map, `x, y, r`) by the Studio's objectives editor
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
  same `turnin`, which needs no NPC without an ender); closed unclaimed, it waits in the quest log. Nothing finishes by itself (tutorial steps apart, below).
  `questSweep` (after every action and on the map's turn) checks places reached; `questFinish` is the one way a quest is completed.
  **Tutorial steps** (Nov 2026) are quests with the `tutorial` tick: with no ender (and no choice) they are the ONE kind that
  finishes by itself (`questSweep`), so each step's `rewards` (`quest:<next>`) open the next "New quest" window at once; quest op
  `skip` (`questSkip`) closes the whole chain unrewarded and starts the first non-tutorial quest it leads to. Goal kinds for the
  basics: `walk` (steps, quiet), `hit`, `shoot`, `hold` (no target) and `ui` (`ref` from `Content.UI_PARTS`: bag, quests, craft,
  build — only the page knows, it sends quest op `did` + `what`; `didUi` in `main.js`). Quests `image` = a picture above the text
  (`questPic`; a GIF plays); `[W]` in quest text or a goal label is drawn as a key (`qtext`).
  **Quest hooks** (Nov 2026; how tutorials are shown — the owner chose this over listing them in Config): a quest's
  **`on_start`** (an action list, run by `questBegin` when it starts, start_quests included) and each objective's
  **`on_done`** (JSON goals only; run once by `questSweep` → `goalHook` the first time the goal is met, marked in
  `p.quests[id].f`) are the same action lists as `rewards`; `quest:<tutorial step>` there = show that step now. A quest
  started by a hook remembers its starter (`p.quests[id].by`); abandoning the starter closes it (`questDrop`, not done).
  `questStart(c, ws, p, id, now, ev, {announce, by})` is the one way to start one. "New quest" windows show **one at a
  time**, in the order things started (`p.intro`; quest op `seen` takes the `id` read). **Skip tutorial** sets `p.tutOff`:
  the chain is closed, and every tutorial step a hook starts later is skipped the same way (`skipSteps`). Studio: the
  `on_start` field (rewards editor) and a "When met, start" picker under each objective (`goalsField`).
  **What the player sees of quests** (owner, 26 Nov 2026): Quests `no_abandon` (Studio tick "Cannot be given up", `q.noAbandon`)
  = no Give up button, and quest op `abandon` is refused (main quests). **Tutorial steps are never tracked where the player sees
  them**: not in the quest log, not in the tracker, no lines in the log (`New quest` / counts / reached / done / complete are
  silent for `q.tutorial`), and their window shows the words and picture but no objectives; the referee still counts them.
  The **quest log (L)** is a list on the left (`qlog` / `qli` in `main.js`) and the picked quest on the right; each row has a
  **Follow** box (quest op `follow` + `on`; unfollowed = `p.quests[id].hide`, sent as `hide` in the log entry). The tracker
  (right of the game view) shows only followed quests; a quest is followed when it starts.
  **Studio, Quests view** (Nov 2026): the cards can be dragged into order (`dragSort` / `moveRow` in `cstudio.js`; the row
  order is `q.order`, the order an NPC offers its quests; off while searching). On the right, the **questline map**
  (`content/js/questmap.js`, draw-only, reads the draft rows): every `quest:` link in `on_start`, an objective's `on_done`,
  `rewards`, and `quest:` / `quest_active:` in `requires` is an arrow (colour = kind); quests joined by links form one
  questline, laid out top to bottom, links going back up drawn round the side; a link to a missing id shows dashed red.
  One canvas: click a box to open that quest, **drag it to place it** (kept on the row as `map_xy` "x,y" — published
  with the quests, ignored by the game; a box without one is placed by the automatic layout; Reset layout clears them),
  hold the mouse wheel or drag empty space to pan, wheel to zoom, Fit; the view outlives redraws. Wide / Hide are kept in
  `sheetsrpg.studioQuestMap`. A new kind of link = one line in `graph`.
  More goal rules: **`have`** (bring) is what is in the bag right now, and the full amount must be there at hand-in, when it is
  taken. **`own`** (have in the bag, kept) is the most that was in the bag at once while on the quest — `questSweep` keeps the
  mark, so once met it stays ticked when the item is then eaten or used (the owner's "kill, pick up the meat, eat it" quest).
  A goal with `opt: true` (text: a leading `?`) is optional: counted and shown, never holds the quest back, gives no bonus, and
  an optional `have` is taken only if brought in full. `drink` / `eat` / `hold` take ref `*` (anything; a stream counts only
  for `*`) or one item id. What a cooker makes counts for `craft` when a player takes it out of a cooked cell into the bag
  (`invAct`): the fire cooks with nobody there, so the taker is the maker.
  Page rules: a quest window (`#npcp`: new quest / tutorial, quest complete, an NPC) first shuts every other view
  (`closeViews`), and while it shows the bag, craft, build and quest-log keys open nothing (`questPop`).
  Not built, and not decided: a bonus reward for optional goals; the boss lockout (fight again at once, or once a day / week).
- **Durability, and what never stacks** (Nov 2026): Items `durability` (uses; 0 = never wears out) on weapons and tools. Each
  stack carries what it has left as `dur` (missing = whole); `World.wear` takes one per blow at a monster (`attack`), per blow that
  does damage to a wall or object (`strike`, harvesting included) and per shot (`shoot`); at 0 it breaks and is gone. How much a
  hit costs depends on the material hit: Items `material_wear` (`stone:2, metal:3` → `item.wearVs`; not listed = 1, 0 = free;
  a monster is `flesh`; a shot always 1).
  **Broken** (dur 0) is not destroyed: it stays, but counts as nothing in hand (`usable`; `holdSlot`, `heldItem`, `hasTool` skip it).
  **Repair** (inv op `repair`, `World.repairInfo`): back to full for Items `repair_cost` (empty = half its recipe, rounded up; no recipe
  and no repair_cost = cannot), at Items `repair_station` (empty = its recipe's station, or anywhere). **Salvage** (op `salvage`,
  `World.salvageInfo`): the item is gone, Items `salvage` comes back (empty = half its recipe, rounded down). Page: the bag's item
  card shows Repair / Salvage / Drop for held things (never Equip/Unequip: the belt says what is in hand); worn gear keeps Wear / Take off. The one in
  use is `World.stackInUse` (the first of that item in the bag); `World.durOf` = {left, max}. **Never stack** (`stackMaxOf` = 1,
  whatever stack_max says): weapons, worn gear, anything with a durability; a tool with none (a lockpick) still stacks. A stack
  that is moved keeps its `dur` (`addStacks` takes it along as `keep`; sort, drop, take all, loot bags). Page: `durMark` = the 2 px
  line along the bottom of a bag cell / belt slot and the "Durability x/max" hover line.
- **Ammo that can be had back** (Nov 2026): Items `recover` (0-100 %, an ammo field in the Studio) = the chance, rolled per round
  spent, that a shot gives it back. `World` `shoot`: a shot that ends in a monster leaves it stuck there (`stickIn`, `m.stuck`), and
  `hitMonster` puts what is stuck into the loot bag it leaves; a shot that hits
  nothing leaves it lying where it stopped (`layOnGround`: a `_drop` pickup on the last cell of the shot it can lie on, joined to
  the same item already there). Not for shots onto another floor (`shootAcross`) or thrown items yet.
- **Who took part in a kill** (Nov 2026): a monster keeps `m.hits = {playerId: when}`; on death everyone who hit it within
  Config `kill_credit_s` (30) gets `World` `killShare`: the kill for their quests, **full XP**, their own gold and their own roll
  of the loot table. The last hitter gets it at once; the others' shares wait in the map record (`ms.credits`) and are given by
  `advance` (with a `kill` event addressed to them, which is also what makes the function save their record). What a monster
  always gives (`loot`) is not multiplied: it lies in the loot bag, shared. A player's own roll lies in the same bag as
  stacks marked `own: <playerId>`; **`boxInv(c, e, p)`** is what that player finds there, and the body stays until all is taken.
- **Where loot lies** (owner's rule, 26 Nov 2026): **loot never goes straight into a player's bag** (a full bag would lose it,
  and the player could not choose): every kill that has anything to give leaves a **loot bag** (a struct entity marked `wild`: a take-only container)
  for what it always gives, arrows stuck in it, and each player's own roll (`killShare` makes the bag when there is none
  or it was already emptied). **Carcasses and loot bags are one thing** (owner: there is no carcass farming): Monsters
  `carcass` is only the bag's look (`lootBagOf`; empty = the standard `_bag`), every bag rots after Config
  `loot_bag_rot_s` (900) or goes when emptied, and `carcass_rot_s` is no longer read. Gold is still handed over. `World` `lootSpot` / `lootBox` are the one place that decides where.
  **The owner's rules, in order.** The tile it fell on: (1) nothing on it → a new bag there; (2) a loot bag on it → the loot
  joins it and its rot timer starts again; (3) only **dispensable** items on it (Items `dispensable` tick, `item.dispensable`:
  branches, rocks, fiber; only `_drop` pickups that grew or were left, never map-editor ones) → a new bag there with those
  items put INSIDE it. Anything else on it (an item not ticked, an object) → the tiles around, nearest first, that can be
  WALKED to from there (walls, shut doors, cliffs count), same ground height, within `DROP_REACH` (3) steps: (4) the
  nearest free one; (5) none → the nearest holding only dispensable items, as in 3; (6) none → it joins the nearest loot
  bag there (my addition, the owner did not say); (7) not even one → a new bag on the tile it fell on, sharing it. An
  item that is not dispensable is never moved or bagged. Spawn points and triggers do not count as something on a tile.
  In `data/game/` rock, plant fiber and branch are ticked.
- **Planned, not built — dialogue, light phasing, instances, parties, bosses, raids:** `docs/QUESTS_INSTANCES_SERVER.md`.
- **Stealth** (Nov 2026, `docs/STEALTH.md`; the owner agreed the plan). Stage 1 is built: **`World.notices(c, map, m, def, p, now, range, stateFn, o)` → `seen | heard | ''` is the one question every brain asks about a player** (plain, walker, hunter, animal; a monster that was struck still knows who did it). Seen = within the brain's range (× Config `sneak_sight` 0.6 while sneaking) with line of sight; heard = within the player's noise (`World.noiseOf`: Config `noise_walk` 6 / `noise_sneak` 2 tiles, nothing standing still, `NOISE_LINGER_MS` after `p.stepAt`) × Monsters `hearing` (1; 0 = deaf), walls or not. Heard only attracts: a walker searches (`ai.w`, the ?; breaks nothing), a hunter / plain one walks to it (no shot), an animal flees only within half its `flee_range`. Sneaking: Z toggles, action `{type: 'sneak', on}` → `p.sneak`; `Rules.stepCost(…, who)` × Config `sneak_slow` (2) for `who.sneak` / `who.sn` (others are sent `sn`, also in `wire.js`); while sneaking the figure is a see-through shadow (`paintActor`, Config `sneak_alpha`), the screen edges darken (`#sneak-veil`), and each monster in view shows where it would spot you (`World.sightArea` = the seen half of `notices`, Render layer 2f, Config `stealth_areas`; `World.lookRange` is the one place each brain's range is decided); the noise meter (`noiseMeter` in `main.js`, `UI.FLAGS.noise` on) is worked out on the page from its own steps. Stage 3 too: **monsters see in a cone** (Config `sight_cone` 60° on `m.facing`, long rather than wide as the owner asked: `cone_reach` 1.5 × the range ahead, straight-line distance; behind it `back_sight` × the range, 0 = not at all — the owner chose blind behind, so a sneak attack up close is possible — `World.looksAt` is the one place, notices and sightArea ask it), idle roamers turn to look about, and a blow on a monster that has not seen you, is fighting nobody and has nobody in sight is a **sneak attack** × Config `ambush_mult` (2; `unaware` in `hitMonster`). `tools/test_world.js` sets `sight_cone` 360 and `ambush_mult` 1 for the old fights. **Sneaking ends** (owner's rules): seen by a monster, or striking one that lives → `spotted()` stands you up; while any monster here is after you (`chasedBy`: `m.engaged`, `m.chase`, a walker's `ai.spot`; `p.chased` → page `me.chased`) you cannot sneak again; opening the build tools or picking a blueprint (`standUp` in `main.js`; the referee on any build action) and talking to an NPC stand you up; the noise meter shows only while sneaking. Config `stealth` = off restores the old rules exactly. **Perception** (`senseStep`, every `advance`, owner's rules): seen → the monster reacts at once (its turn is made due); heard while after nobody → `m.hear` (the ? at once; surprised, it freezes facing as it was), Config `hear_delay_s` (2) later it turns and goes to the spot (`m.goTo`, a walker's `ai.w` search) or an animal runs from it (`m.fleeFrom`); `alertOf` reads these. Sight lines are drawn from the lesser end, so seeing is the same both ways. **Raised ground hides what is behind it** (`hillBetween` in `clearLine`, so players, monsters, shots and the fog all agree): each end's eye is Config `eye_height` (0.75 of a height step; a wall is 2) above its ground, and ground between that rises above the straight eye-to-eye line blocks; level ground never does. From high ground you see far; from below a ledge taller than you, only its edge. Not built yet: stages 2 and 4 (loud events, the player's own hearing).
- **Clicking big objects** (page only, 26 Nov 2026): a thing drawn bigger than its tile is meant by any solid pixel of its picture. `Renderer.objectAt` (the frame's `hits`) says which object is drawn under a point; `bigPick` in `main.js` (end of `cellAt`) turns the click to that object's own tile only when the tile under the cursor has nothing to do and the object has (an action, or `World.harvestWith`), and never while building, removing, moving, aiming or throwing. And ONLY its pixels (owner): the empty part of a big object's own tile is no click at all (`Renderer.bigOn`; the cell comes back `miss`, `actsOf` gives nothing), unless a creature or a small thing shares the tile. F / Space on the faced tile are unchanged. The rules still decide what may be done. The view scrolls `edgePad` (the bottom HUD's height + half a tile) past each map edge.
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
  **What the owner chose (17 Nov 2026, after asking to rethink walls from scratch; they like how Project Zomboid decides what
  is visible):** walls in the player's way drop to low stubs, never see-through walls; on a stub, doors, windows and usable
  things stay visible (faint) so they can be found, pure decoration drops; rooms already seen stay revealed but dimmed;
  creatures show only in line of sight, outdoors too; walls keep an illusion of depth even if faked (the flat top-down style
  was dropped). A hearing sense that outlines unseen creatures is wanted later (`sensed` is its hook). The owner values **one
  consistent rule over many configurable special cases**: extend the single edge question and the single sight decision, do
  not add a parallel mechanism. Out of sight, what stands on a known cell (objects, items on the ground, NPCs, doors,
  waterfalls and cliff things — `drawFalls` / `drawCliffThings` take a `shade` function) is
  drawn darker by the fog's own `fog_alpha`, like the ground (`shadeAt` in `render.js`, owner 26 Nov 2026). Put off, not
  rejected: cutting thin N-S walls, fixtures on a wall's north face, remembering seen cells across a reload.

**Important:** the owner now edits the live Game Data spreadsheet. `tools/build_gamedata.py` and `data/*.xlsx`
only describe the *starting* data. **Never tell the owner to re-import GameData.xlsx** once they have made edits — it would
wipe them. For a new tab or column: make the code tolerate its absence (sensible defaults), and give the owner the
rows/columns to add by hand (or add a small server function that adds them). Keep `data/tables.json` in step
for offline mode by updating `build_gamedata.py` too.

## The game page's look: the UI kit (25 Nov 2026) — read `docs/UI_KIT.md` before touching the HUD or a window
The owner drew a UI kit (`art/ui/kit/`: `plain/` and `nb/` = Nano Banana, same piece names; `PIECES.md` says what each piece is
for and how it is cut) and the page is built from it. `client/js/ui.js` (`UI`) knows which set each piece comes from (`SET`: one
line moves a piece), the scale, and the parts (bars, chips, icons, key caps, toasts, the tooltip); `client/css/ui.css` holds every
size. **1rem = 1 art pixel** (`--u` = a whole number of screen pixels, set from the view's room): never write `px` there, never
name a picture file there (`var(--k-<piece>)`). Fonts: Silkscreen (labels, caps) and Jersey 10 (body), in `art/ui/fonts/`.
What the owner chose: the mix (Nano Banana for `panel_metal`, `header_plate`, `panel_paper`, all `button_*`, tiled; everything
else plain); **only what the game has data for is shown** — the rest is built and hidden behind `UI.FLAGS` (minimap, clock,
nightfall, noise, stamina, temperature, condition, load, lockedRow, queue; `?ui=all` shows them), never a placeholder value;
drag / Shift / Ctrl / double-click in the inventory stay exactly as they were; windows with no mock (quests, NPC, build bar,
storage, claim, new character, help) use the same pieces with their old layouts. The data the mocks still wait for is the
**backburner** list in `docs/UI_KIT.md`: add to it, do not add the data unasked.

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
- **Desktop installer releases** (Nov 2026): `.github/workflows/desktop-installer.yml` builds the Windows installer + portable .exe on
  GitHub's runners. A tag `studio-v<version>` (e.g. studio-v0.2.0) publishes both on a GitHub Release; Run workflow (Actions tab, needs
  the file on main) leaves them on the run's page. The version comes from the tag, not desktop/package.json. Only desktop/ changes need
  a new installer. Icon: `desktop/build/icon.ico`. First release: studio-v0.2.0 (passed).
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
- **Commit and push only when the owner says so** (a commit request is not a push request). The owner is hands-on — runs git,
  the Firebase CLI and deploys themselves — and **works in the repo in parallel**: files you did not touch may be changed or
  uncommitted, so look at the working tree before any git step, never discard what you do not recognise, and say what in a
  commit was not yours. `.claude/` (local settings, with machine paths) stays out of commits.
- **Never write to the live game.** Reading live data (`GET ?action=content|records|maps`) is fine; publishing, deleting or
  saving anything needs the owner and their editor key — do not handle the key, do not press Publish / Save in the Content
  Studio or map editor, and do not create a character or act in the live (online) game. Browser checks use `?offline` or a
  locally run host, with the page's storage writes blocked or every test draft removed afterwards (`sheetsrpg.*` keys).
- The owner is **cost-conscious** (they watch the Firebase free-tier limits): answer cost questions with numbers and the metric
  that matters, and keep anything per step from growing with the map. They like to **see how a big change feels** before
  committing to it: a prototype or a measurement first, the live site kept safe meanwhile.
- A new session knows only this file and the docs: when a design choice is agreed, write it here.

## Testing (in Claude's cloud workspace)
- `node tools/test.js` (server, fake SpreadsheetApp/CacheService), `node tools/test_world.js` (game rules) and
  `node tools/test_functions.js` (the Cloud Function's step, `functions/referee.js`, on a fake database) must pass.
- Browser: Playwright with `/usr/bin/google-chrome` against `python3 -m http.server 8765` started from the repo root
  **in the same shell command** (background servers get killed between commands). imgur is blocked in the sandbox, so
  art shows as lettered placeholders and pages wait ~8 s for image timeouts; wait for `#log` text before acting.
  `window.SheetsRPG` exposes `state()`, `camera()`, `aim()`, `plan()` for tests.
- The owner's built-in browser can reach the live site and the Apps Script URL (good for checking the real server).
- **On the owner's Windows machine** (the desktop app's sessions): Git Bash and PowerShell, files mostly CRLF. A server the
  owner runs usually serves the repo at `http://localhost:8765` (the desktop app uses its own port and its own storage);
  the game offline is `/client/index.html?offline` (seed `data/tables.json`), the Studio's Play-test runs the draft.
  Things that cost time before: clicking Play in the create-character form before the page is ready submits the form and
  lands on `index.html?` = the ONLINE game — check `location.search === '?offline'` before every scripted step. Scripted
  keys: blur the focused input first; a short tap only turns the character, hold a key ~600 ms to step. The seed map's
  rats and slimes box a new character in at the start within seconds. A test character is removed with the page's
  New character button (pressed twice); a map-editor test edit leaves `sheetsrpg.editorWip` behind — remove it.
  `tools/test_host.js` (the LAN host) is the fourth suite to run. Patches with quotes in them: write a script file and
  run it, a shell heredoc breaks on apostrophes.

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
