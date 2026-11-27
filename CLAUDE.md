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
  A record is written as `<name>.json.tmp` and renamed, so a host killed mid-save leaves whole records plus at most a
  stray `.tmp`, which `load()` throws away (`tidy`).
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
- **Data-driven actions** (`on_interact`, `on_use`, `on_cast`, trigger `do`): `give:item:n; take:item:n; gold:n; heal:n; damage:n; flag:x; unflag:x; teleport:map:x:y; set_state:key:state; xp:n; message:text; scene:id` (the rest of the list waits for the scene: see Scenes); conditions (`if`): `flag:x, !flag:x, has:item:n, level:n`.
- **Building:** the `Blueprints` tab (a wall style or an object, cost, work, tool). `World.canBuild` decides a spot (ghost and referee); built things live in the map's `struct` layer with keys `<map>.b<n>`; maps carry a `nobuild` grid (map editor, No-build tab). In game: B build; C (or I) opens the inventory window, whose Crafting column is all crafting: hand recipes plus those of a station you stand next to (there is no separate crafting window; using a workbench opens the inventory too). A N-S wall may carry a draw-only offset (`style:height:l|r`, the editor's cursor-side mode): `build` takes `off`, and `{type:'shift', target, off}` moves a built one; collision stays on the grid line. Holding the button keeps a wall stroke on its line (editor and game).
- **Claims:** a built object of kind `claim` (`properties.claim_radius`) makes the land around it its builder's base; `World.mayUse` / `claimAt` (on a live map) gate building, built doors/crates/stations and damage for non-members. Members are added by name from the flag's panel. Config: `claim_max_per_player`, `claim_max_members`, `claim_open_land`, `pvp_structures` (on = raids).
- **Crafting:** the `Recipes` tab (inputs → outputs, optional `station` and `tool`); a station is a kind-`craft` object with `properties.station`; items carry `tool` tags. `World.recipesFor` decides what can be made (panel and referee). Objects with `properties.harvest` yield items when broken and grow back.
- **Items that are put down** (a bedroll, 26 Nov 2026; the owner's choices: a bedroll is an item you carry and place, the campfire stays a
  blueprint built on the spot; only who placed it — or a member of the base it stands in — picks it up; picking it up clears the
  place to come back to; it goes down at once, no frame): an item whose type has the **`place`** tick (built-in type `placeable`) and
  that names an object in Items **`places`**. `World.placeBp(c, item)` makes the blueprint it goes down with (`placed` = the item id,
  cost = the item itself) and `canBuild` is still THE check (reach, free tiles, claims, the footprint as it faces) — `bp.placed` only
  skips the build lock (`build_if`, Config `build`). Action `{type: 'place', item, x, y, facing}` → `placeItem`; the record is a built
  object like any other with `item` on it, and `dismantle` on one is PICKING IT UP (the item back whole, label "Pick up the …" in
  `actionsAt`). Page (`main.js`): `placeHeld()` = such an item in hand → `buildTarget` / `drawGhost` show the build ghost, T or
  Shift+wheel turns it, a click on ground with nothing to use sends `place`. **Once down it is only picked up** (owner, 26 Nov 2026):
  a thing put down (`rec.item`) is never turned or moved (`turnObj` / `canMove` say "Pick it up and put it down again"), and its
  pick-up action carries `pickup`, so a plain click or F does it (`tapAction`). **A bedroll is a come-back point and nothing else**:
  a kind-`rest` object put down from an item is not used at all — no rest, no healing (`comeBackOnly`) — and putting it down makes it
  its placer's place to come back to at once (`rec.rs`; picking it up clears that). A bed on the map or built from a blueprint still rests. Not built: a placed thing keeping what it holds or its
  wear when picked up, wall-mounted ones, clearing the come-back place of players who are elsewhere.
- **Picking** (a berry bush, 26 Nov 2026; the owner's choices: shared by everyone, full again all at once a while after it was
  emptied, a fixed amount per pick, holding the button keeps picking): an object with `properties.pick` (an item list) gives that
  list each time it is USED, `pick_times` times (1), then stands empty — state `empty`, its `sprite_states` `empty=` picture, no
  action on it — until `pick_s` seconds after the last pick (Config `pick_refill_s`, 300). Never damaged, never gone (that is
  `harvest`: hit it, it breaks, it grows back). For any kind with no use of its own (`isPick`; the owner's kind `harvest` is only a
  label). `World.pickAt(c, map, lk, p, x, y)` is the one "can p pick here now" question (the page's held button / held F:
  `pickSwing` in `main.js`, one `interact` per Config `pick_ms`, 600); `pickFrom` is the referee's pick; the count is `ms.picks[key]`,
  the refill one `ms.timers` entry. Studio: Objects → Durability → "picked by hand". Not built: a slow refill pick by pick, picks
  that give nothing, a per-character bush.
- **Cookers** (campfire, furnace): a kind-`craft` object with `properties.cooks` makes its station's recipes over time, with fuel
  (Items `fuel_s`). It holds three runs of cells in one list — raw, fuel, cooked — `raw_slots` / `fuel_slots` / `out_slots` each
  (20 when not said; `rec.lay` in `ms.cookers[key]`, an old three-cell record is re-laid when opened). It cooks ONLY its job, `rec.job = {id, n}`
  (batches of one recipe, set by the Cook button — never what merely lies in the raw cells); `cookPick` says whether the job can go on
  (every input in the raw cells, room for every output); an input taken back out of the raw cells makes the job fail and stop (`cookLost`, owner 26 Nov 2026; no room for the output only waits); `cookTick` counts the time. A recipe short of more than one ingredient reads "missing ingredients" (`lackText`). Actions: `inv` moves (a cell picks
  the run), `store` ops `light` / `douse` / `load` (`recipe`, `qty`: sets or adds to the job, moves what is missing from the bag into
  the raw cells, lights it if there is fuel) / `cancel`. Page: `cookWindow` in `main.js` (backpack | the fire: raw > fire > cooked, fuel, the switch | its recipes), drawn from `storage.cook`. The campfire in `data/game/` has 6 raw, 4 fuel, 6 cooked cells.
- **What is worn:** an item's `slot` = `weapon` (in hand), `helm` (head), `face` (masks, glasses; owner, 27 Nov 2026 — its worn cell is numbered AFTER the accessories, `late` in `WORN_SLOTS`, so old saves keep their cells), `armor` (chest), `pants`, `feet`, `gloves`, `back`,
  `belt` (a worn belt, not the hotbar) (`World.WORN_SLOTS`), or `accessory` — two at once (`World.ACC_SLOTS`), in `p.equipment.accessory1…2`
  (owner's layout, 27 Nov 2026: Head, Chest, Pants, Feet on the left; Face, Back, Gloves, Belt on the right; the two Acc under the figure;
  under the tray the level and XP bar, `.dlevel`; the HUD shows only an XP bar under the belt, `#xp-row`, no level or numbers). Items `hides_head` (a tick, `item.hidesHead`; owner, 26 Nov 2026: a poncho's hood): while worn, the hair and the helm's picture are not drawn (`playerLayers` in `main.js`; draw-only). While an item is dragged, the place it can be worn pulses white (`dollHint`, `.dslot.fits`). Every slot has its ghost icon (the extra kit icons helm, pants, glove, boot, belt, ring, snow, weight are drawn by `tools/gen_ui_icons.js`). Under the bars (health, then water | food as wide as it; hover = the numbers) is the **conditions row** (`conditions()` in `main.js`: statuses, toxicity, thirsty / hungry at 25% or less, and — behind `UI.FLAGS` temperature / load — freezing, too hot, encumbered), where the HP line was. `World.wornAt` / `slotFor` are the only
  two that know the accessory places; `use` takes `slot` (which place; a worn accessory dropped on another place moves).
  Page: with no container open the inventory is `invWindow` in `main.js` — who you are (the worn slots as cells beside
  your own figure, `DOLL_SLOTS`) | the backpack and the picked item's card | hand recipes (`recipeBook`: a list of rows
  and the picked one on a notebook page; shared with the cooking window).
- **Item types:** the `ItemTypes` tab (Content Studio → Item Types) gives each type ticks (`equip` + default `slot`, `shoot`,
  `consume` + `cooldown_s`, `throw`; `ammo`/`tool` only pick which item fields the form shows) and its own `properties`.
  `Content.build` turns them into `item.can`, `item.cooldownMs`, `item.props`; rules ask **`World.itemCan(it, what)`**, never
  the type's name (it falls back to the old names for content built without ticks). No tab = the built-in `Content.ITEM_TYPES`.
  Object kinds the owner adds live in Config `object_kinds` (edited from the Object Kinds card).
  **An item may add to its type** (owner, 27 Nov 2026: a small rock is a material, can be thrown, and is a slingshot's ammo):
  Items **`throwable`** (a tick) makes `item.can.throw` true whatever the type, and the Studio then shows the throw fields.
  Such an item carries `item.ownThrow` and is still treated as its TYPE everywhere else — `beltWorthy` (it does not go to the
  belt by itself: the player puts it there to throw it) and the bag's filters ask that. Ammo needs nothing: a weapon names its
  `ammo` by item id and the rules never ask the ammo's type. More per-item ticks (a bottle to drink or throw) go the same way.
  **Aiming a throw** (owner, 27 Nov 2026; page only): anything that can be thrown, a grenade and a ticked rock alike, is aimed
  only while the RIGHT button is held, like a weapon (`syncThrow` in `main.js`) — otherwise it is just carried in hand and
  clicks act as usual. The aim paints no tiles: `throwAim` → `Renderer.drawThrow` = a
  pulsing white line round the tiles the throw can land on (`throwCells`: ON the grid, within its range and not behind a wall
  — the owner asked for this edge to snap and to show only where it can be thrown; its corners are rounded, and the tiles inside
  are hatched with thin diagonal lines ON the ground, under whatever stands there: `Renderer.draw` `reach`, layer 2g), a dashed arc from the figure to the cursor itself (never snapped to the
  grid), and a ring where it lands (as wide as its blast). A cursor beyond the reach throws as far towards it as it goes (no
  more "too far"); a wall in the way ends the arc where it lands. The click throws at `throwAim().cell`.
  **A throw up a ledge reaches only its edge** (owner; a rule, `World.throwLanding`, so the referee and the aim agree): the first
  tile a level above the thrower is where it lands, never further in; ground more than a level up stops it at its foot; a ramp
  is no step; level ground and throwing down are untouched.
  **A blast shows when it lands** (owner, 27 Nov 2026; draw-only): the referee settles a throw at once, so the page holds
  back what the blast did until its flight is over — `landings` in `main.js` (added by `tossFx`): `hit` / `die` events on
  its tiles are handled then, and the monsters that stood there are drawn as they stood (health too) meanwhile. Not held:
  the loot bag, broken walls, and your own health if you stood in it.
  **In the air and landing** (owner, 27 Nov 2026): the thrown thing is a small turning copy of its picture flying the very arc
  the aim drew (`tossFx` in `main.js` → `drawFx` kind `toss`; draw-only, for other players from the `throw` event). What has a
  blast area flashes where it lands; anything else (a rock) bounces once towards the next tile the way it flew — on the spot
  when that tile is taken, walled off or across a ledge — and is gone: **a thrown thing is never left on the ground** (the
  owner decided against getting rocks back). **Landing makes a noise** (hand throws only, not shots): Items `throw_noise`
  tiles (0 = Config `throw_noise`, 6; -1 = silent) → `World.throwNoise` / `soundAt`: every monster within it (x its
  `hearing`) that is after nobody hears it like footsteps — the ?, the wait, then it goes to look where it FELL (an animal
  runs from there). The `throw` event carries `noise` (the page's ring). `soundAt` is the one way to make a noise at a spot.
  The figure in the inventory window never shows what is in hand (`drawBust`).
- **Facial hair** (27 Nov 2026; the owner's choices: picked on the character screen, not an item; a colour of its own): pictures
  `art/sprites/paperdoll/face/beard_*.png` + their `.tint.png` (the same folder will hold face gear art). `World.hairChoices`
  also gives `beards` ('' = none, first; the built-in `BEARD_STYLES`, or Config `beard_styles`); `newPlayer` takes `look.beard` /
  `look.beardColor` (a hair ramp; not stored when it is the hair's) → `p.beard`, `p.beardColor`, sent wherever `hair` is. Drawn
  by `playerLayers` under the hair and under face gear (`SLOT_Z.beard`), never hidden by a helm or hood; Items **`hides_beard`**
  (a tick, `item.hidesBeard`, draw-only, any worn slot) hides it — off by default (owner). **A layer may be nothing but its
  mask** (owner, 27 Nov 2026: stubble now, make-up later): `foo.tint.png` with no `foo.png` still draws, named by the path its
  picture would have. **`Tint.layer(picture, mask, ramp)` is the one place that decides what a paper-doll layer draws** (game,
  character screen, Studio previews) — never require the picture; both manifest builders (`tools/build_art_manifest.js`,
  `asset_server.py`) list a lone mask under that name. Not built: changing hair or beard after creation.
- **Gear cut for a man and for a woman** (27 Nov 2026; the owner's choices: two folders with the SAME file names, no data per
  item): `art/sprites/paperdoll/chest/male/chest_x.png` and `…/chest/female/chest_x.png` (masks beside each). Content always
  names the MAN's picture (Items `worn_sprite`, outfits, appearance options). `Tint.twin(path)` = where the woman's would be
  (any `…/male/<file>` → `…/female/<file>`, so another slot only needs the two folders); **`Assets.wornFor(path, female)` is the
  one place the game picks** — the twin when its file is there, else the picture named (so a garment with no woman's cut still
  draws). Asked by `playerLayers` (`p.body === 'female'`), and for looks whose body picture ends `_female.png`
  (`Tint.femaleLook`: `monsterLayers`, `Render.outfitLayers`, the Studio's `composeLook`). Draw-only. The Studio's pickers list
  both cuts (the woman's labelled "(female)"); picking a female one outright also works.
- **A woman's build: curvy or slim** (owner, 27 Nov 2026): a character's `body` is `''` (male), `'female'` (curvy) or
  **`'female_slim'`** (`World.bodySprite`: Config `body_female_slim`, or the built-in `body_survivor_female_slim.png`). A slim
  woman wears the MAN's cut of every garment and her chest never moves: the page asks `p.body === 'female'` for both, so
  slim needs nothing more than its body picture. Character screen: Body Male / Female, then a Build row Curvy / Slim shown
  for Female (`#join-build`; Slim first, and what Female starts on: the owner's choice). **Looks (NPC outfits, appearance sets) go by the body PICTURE**: `Tint.femaleLook`
  is true only for a body ending `_female.png`, so one ending `_female_slim.png` (`body_zombie_female_slim.png` too) gets
  the man's cuts and no chest motion by itself — in the Studio a slim NPC or walker is made by picking that body. A garment
  picked outright as its "(female)" cut is still drawn as picked. Not built: changing build after creation.
- **The bust mask** (owner, 27 Nov 2026; their idea, replacing the fixed box): `art/sprites/paperdoll/base/player/
  body_survivor_female.bust.png`, the size of the figure, the near breast painted in one colour (more red than blue) and the far
  one in another (more blue), nothing else. **One file for every woman's body** (the walkers' too, the owner's choice) and for
  what is worn over the chest; Config `bust_mask` names another. `bustMask` in `render.js` reads it once; `chestFrame(img, [near,
  far])` moves ONLY those pixels, column by column, each breast by its own amount (the far one `CHEST_LATE_MS` 90 / `CHEST_LATE_STEP` 0.08 behind: `chestAt(a, …, late)` — **but breathing moves both together** (owner, 27 Nov 2026): only what
  she does — a step, a blow, a shot, being hurt, turning round — moves them one after the other), lower rows more than upper, the pixel left empty filled from the one
  before it. No file = the old `CHEST` box as one piece. `.bust.png` files are left out of the art manifest (both builders).
  Not built: a mask per garment (stiff armour that should not move still does).
- **The chest also bounces on a jolt** (owner, 27 Nov 2026): when she swings a tool or weapon, shoots, throws, is hurt, or
  turns to face the other way. `joltMs(id, hp, usedAt, now, facing)` in `main.js` watches health and facing per figure and
  gives the ms since the last of those (`usedAt`: yours = `swingT0` / `lastHoldShot`; another player's = `act.j0`, set in
  `othersAct` for kinds m / r / t; a monster has none — hurt and turning only) → `jolt` on the actor; `chestAt` in `render.js`
  adds the same spring for `CHEST_JOLT_MS` (900), `CHEST_JOLT` (2.6) x `chest_bounce`, to what breathing or walking gives
  (`chestBase`). **A step setting her down is that same jolt** (owner, 27 Nov 2026: the landing bounce the same as turning,
  each breast on its own): `landings(a, now)` in `render.js` keeps, per figure key `a.k` (`p:<id>` / `m:<id>`, set in
  `main.js`), the moments its steps passed `CHEST_LAND` → `a.lands`; `chestAt` adds `jolted(now - t, late)` for each, so they
  add up while she walks (a player's step is 140 ms, far shorter than the spring: the chest hangs a little low and each
  breast shifts in its own time) and ring out after she stops (breathing waits meanwhile: `busy`). A figure with no key
  keeps the old per-step bounce (`CHEST_WALK`). Not built: NPCs (they turn to face you), a monster's own attacks.
- **How a figure stands is worked out in one place** (27 Nov 2026): `Render.pose(a, now, cfg)` (module level in `render.js`:
  `idleUp`, `chestAt`, `chestBase`) sets `a.breath` and `a.jig` on an actor; the map (`paintActor`) and **the figure in the
  inventory window** both ask it and both draw with `Render.figureOn`. **`liveFigure(cv, layersOf, o)` in `main.js` is the one way a figure is alive OFF the map** (owner): it redraws a canvas every
  frame while it is on the page — the figure breathes and a woman's chest moves as on the map; with `o.turn` it also turns to
  the side of it the cursor is on (turning is its jolt). Three use it: the inventory window's figure (`bustLive`, 32x49,
  turns), the character screen's preview (`#join-preview`, 96x147, turns; its layers = `playerLayers` of the look being
  chosen) and an NPC's portrait in its dialogue (`npcPortrait`, 64x100, class `live`; a flat-picture NPC stays still). The
  canvas is as wide as the figure is drawn and a row or two taller than 1.5 x that (the breath lifts the head). NPCs on the
  map breathe through `paintActor` like everyone (`idle: true`). Not built: the speaker's portrait in a scene, the small
  pick thumbnails of the character screen.
- **Walking, the chest also sways sideways** (owner, 27 Nov 2026): `chestSway` in `render.js` = -1 | 0 | 1, a pixel to ONE
  side on a step and to the other on the next (the owner: both ways within a step was too frenetic; by the tile left, like the walking sway), the far
  breast a little behind; `CHEST_SWAY` (1.8) x `chest_bounce`, so it shows from a strength of about 0.3 up. **The side is the one AWAY from the walking lean, on the
  screen** (`wobbleOf` leans her by the same tile rule; a figure facing left is drawn mirrored, so in its picture the sign
  flips): going by the picture alone it swayed WITH the lean facing right — invisible — and against it facing left. **This is where the owner wants walking to stay** (27 Nov 2026): tried and taken out again — an extra up-and-down while it sways (each breast on its own, both together, one way per step) and both breasts moving at the same time. Do not add either back unasked. `a.jig` is
  `[near, far, nearSideways, farSideways]`; `chestFrame` moves the masked pixels sideways first (row by row, far breast then
  near), then up or down from where they now are. Not built: sideways on a jolt or while standing.
- **A step's motion goes by the way the figure is GOING, never the way it faces** (27 Nov 2026; a bug the owner saw as "better
  facing right than left"): a player's figure looks towards the cursor, so timing a step by `a.facing` ran it backwards
  whenever she walked away from the cursor. `goOf(id, x, y)` in `main.js` keeps each figure's direction from where it was
  drawn last frame → `go: {dx, dy}` on the actor; `stepAlong(a)` in `render.js` is the one "how far along its step" question
  (the chest's bounce and sway ask it; no `a.go` = by its facing).
- **Breathing is skipped while any other animation plays** (owner, 27 Nov 2026): `busy(a)` in `render.js` — a swing, aiming,
  food lifted to the mouth, or within a jolt (`CHEST_JOLT_MS` after a blow, shot, throw, being hurt or turning round) — makes
  `idleUp` answer 0 and leaves the breath's chest bounce out; the jolt's own bounce still plays. Walking is never idle.
- **Breathing never moves the base** (owner, 27 Nov 2026): a figure made of layers (players, NPCs, paper-doll monsters and
  animals) standing still rises and sinks only from the chest up. `paintActor` sets `a.breath` (1 while `bobOf` says up) and
  `drawLayers` in `render.js` draws each layer in two pieces, cut `BREATH_ROWS` (12) from the bottom of the picture — the plain
  middle of the body, above the stand every bust is on —: the upper piece one art pixel higher, the lower one in place, the
  row at the cut in both (the body grows by that pixel). What is held goes up with the upper piece. A flat one-picture monster
  (rat, slime) still rises whole. New body art must keep its stand within the bottom 9 rows and a plain stretch at row 36.
- **A woman's chest bounces as she breathes and as she walks** (owner, 27 Nov 2026; draw-only; the owner's asks: bouncy,
  not squeezed, and MORE FRAMES than the body's two): on the layers marked `jig` (her body and what is worn on the chest:
  `playerLayers`, and `Tint.chestLayer` for looks) `drawLayers` in `render.js` draws `chestFrame(img, jig)` instead of the
  picture. `chestAt` (module level, see `Render.pose`) = how far the chest is from rest in art pixels (+ = down): a spring set off by each move
  of the idle breath (`bobOf`) that swings and dies down (`CHEST_AMP` 2.4, `CHEST_SWING` 450 ms, `CHEST_FADE` 350 ms).
  `chestFrame` moves each ROW of the `CHEST` box (x 12-28, y 24-32 of the 32x48 figure: both breasts whole, the near arm left out) by its own share — the top row
  `CHEST_TOP` (0.4), the bottom row all — so it stretches as it drops and gathers as it rises; frames are kept per picture.
  Config `chest_bounce` = a strength (1; 0 or off = none); `idle_bob` = off stops both. New female chest art must keep the
  chest inside that box. **Walking** (owner: the same on each step, a bit more pronounced): one bounce per tile, from how far
  along the step the figure is drawn (`CHEST_WALK` 3.2 x the strength, a cosine of the step, by `a.facing`). In `data/game/`
  `chest_bounce` is the owner's to tune (1 was too much). **It bounces only as the chest comes DOWN** (owner, 27 Nov 2026): standing, only after the breath sinks (never after it
  rises); walking, from where the step sets her down (`CHEST_LAND` 0.6 of the step) on into the start of the next.
  **Female walkers bounce the same, by the same Config** (owner): a
  layered monster is told by `a.layers`, never by `a.sprite` (theirs is '' even when layered). Not built: the inventory / character-screen figures.
- **What is worn is a place of its own too** (owner, 26 Nov 2026): a worn helm/armor/pants/feet/gloves/back/accessory is not in
  the backpack, only in its slot by the figure. Worn place k is cell `World.WORN_AT` (2000) + its index in `wornKeys()`
  (`World.wornCell(k)`); `p.equipment[k]` still names the item and `wornSync` keeps it in step with the cells. Wear / take off
  is the `use` action (`from: {w: 'bag', s}` = put THAT stack on; what was worn there takes its cell; off = the first free
  backpack cell, refused when the backpack is full). `inv` moves never reach a worn cell; Sort leaves them; `take` uses them last.
  Old saves move once (`p.wornV = 2`; a save at 1 had four accessory places and no belt one: its worn cells are renumbered, accessories 3-4 go back into the backpack). A slot name of the content's own (no cell) is worn from the bag, as before. The weapon is
  not this: it is the belt slot in hand.
  **Comparing gear** (owner): hovering gear in the backpack or a container for a second adds to its tooltip how it compares with
  what is worn in its place (a weapon: the one in hand) — Attack / Defence / Range / Clip / Durability, worn → this, +/− in
  green / red (`gearCompare` in `main.js`; the delay is `UI.tooltips`' `_tipMore` hook, `MORE_MS` in `ui.js`).
- **The belt is a place of its own** (owner, 26 Nov 2026): what sits on it is NOT in the backpack, never in both. Belt slot i is
  cell `World.BELT_AT + i` (1000 + i) of the same list as the bag (`p.inventory`), one stack each, so `count` / `give` / `take`
  see everything carried (take uses the bag first, the belt last) and the backpack grid is the cells below `BELT_AT`.
  `World.beltOf(p)` = the ids per slot (what `publicPlayer.belt` sends; `p.belt` is no longer stored — an old save's list is
  moved onto the belt once by `normalize`, `p.beltV = 2`). Moves are `inv` actions with `{w: 'belt', s: slot}` (and `drop`
  with `w: 'belt'`); `loadout` on the belt moves a stack too. Shift+click (owner): backpack ↔ belt (onto a slot with the same thing and room, else the first empty one; off the belt = `to: {w: 'bag'}`, wherever it fits), but with a container or cooker open it goes there instead. Anything a player RECEIVES that belongs on the belt (weapon, tool, food, throwable, placeable) — crafted, given, picked up, taken out of a container without naming a cell — goes
  onto the belt first (owner, 26 Nov 2026): stacks of it there with room, then free slots, then the backpack (`World` `carryAdd`, used by `give`, box `take`, `takeall` and box → bag moves). What the player takes off the belt is never put back behind their back. The one
  in use (`stackInUse`) is the one in the slot in hand. Bag / worn cells are 50% bigger than the kit draws them (30, 9-sliced; the belt stays 24),
  and item icons are cropped to their drawn pixels (`itemIconUrl` in `main.js`) so they fill the slot.
- **What is in hand is drawn in the hand** (27 Nov 2026; the owner's choices: the item's own icon with no hand drawn over it, everyone
  sees it, one rule for every item — nothing per item —, a small motion when it is used). A weapon or tool with a held picture
  (`worn_sprite`) is drawn as before. Anything else in hand (food, a bottle, a grenade, a bedroll, a tool with no held picture) is a
  paper-doll layer marked `icon` (`playerLayers` in `main.js`: yours from `belt[held]`, another player's from **`hand`** —
  `World.handOf`, sent wherever `wst` is, `functions/referee.js` too; '' when it is the weapon, which `equipment` already tells).
  `drawHeld` in `render.js` is the one place that draws it: the icon cut to its painted pixels, **as big as it is on the belt**
  (owner: 20 UI pixels on its longer side, whatever the view's zoom — `handSize` in `main.js` tells `Render.setHandPx`),
  centred on the `HAND` point of the 32x48 figure — at its side, under the shoulder that is turned to the camera (the back one of the bust; owner; weapons and tools with a held
  picture are not moved) — and swinging back and forth about that shoulder as the figure walks (`handSwing`, once a step,
  the other way the next; timed by where the figure is drawn, like the walking sway). Motions: `lift` on the actor (0..1) carries it to the mouth, quickly (the
  first `EAT_UP`, a fifth, of the hold); then it is eaten in `EAT_BITES` (3) bites — `bite` on the actor = the share gone, a round
  piece out of the corner by the mouth — each throwing a few crumbs of the item's own colours (`Render.crumbs`, drawn by the
  death burst's `drawFx` kind `burst`); the last bite is the moment it is used;
  a throw swings it about the shoulder (the weapons' `swing`). Others see both through `act` kinds `u` (used) and `t` (thrown)
  (`noteAct`, `othersAct`). **Food and the like in hand is used by HOLDING the left button half a second** (`EAT_MS`, `eatHold` /
  `eatProg` in `main.js`; the owner: a click somewhere must never eat by accident), **one per hold** however long it lasts; a quick
  click does nothing, and a hold on something that has actions still opens its action list instead. **The belt takes no clicks** (owner): with the
  inventory window shut, `#bcbox.through` lets every click on the bar reach the game behind it, so nothing on the map is hidden
  under it (no hover tooltips there either); with the window open the belt is part of it (drag, Shift+click), and a plain click
  on a slot still does nothing — the wheel and the number keys choose what is in hand. Not built: an offset or size per item, a hand drawn over the icon, monsters / NPCs holding things.
- **Belt and what you hold:** the hotbar is `World.BELT_SIZE` (10) belt slots (keys 1-9, 0), which take consumables,
  throwables, weapons and tools. One slot is in hand: `p.held` (-1 = nothing), set by `{type:'hold', slot}` → `World.holdSlot`,
  which is the only thing that sets `equipment.weapon` (a non-weapon in hand = no weapon). Choosing never consumes; `use`/`throw` do.
  **Skills are switched off for now** (owner, Nov 2026): Config `skills` = on brings back Q/E, the bag's abilities and the mana bar;
  the skill rules themselves are untouched. Client: wheel or number keys choose, a click on nothing uses held food; a referee that sends no `held` gets the old belt (`holdMode()`).
- **Turnable objects:** an object is authored facing south; `sprite_states` entries `north=` and `side=` (older `up`/`down`/`side`
  also read) make it turnable. A placement carries `data.facing` N|E|S|W (west = the side picture mirrored) and its `pass_*`
  sides turn with it. `Rules.facingOf / turnable / facingSprite / nextFacing / passOf` are the only readers. Editor: T or
  Shift+wheel, and a Facing setting; game: same keys on the build ghost (`build` takes `facing`), `{type:'turn', target}` after.
  **The footprint turns too:** an object's `properties.width` / `height` (tiles it blocks, from the anchor cell rightwards and upwards) describe it
  facing south; on its side picture (E/W) they swap. `Rules.footprintOf(o, placement or facing)` is the one footprint question (collision,
  building, turning — refused when the new tiles are taken —, outlines); the drawing centres a picture on that footprint (`footW` in `render.js`).
  **Putting one down, it pivots on the tile pointed at** (owner, 26 Nov 2026; game ghost and map editor brush): as authored the thing reaches up
  from that tile, and each turn swings it a quarter round — right, below, left. `Rules.pivotCell(o, facing, x, y)` gives the anchor cell that
  makes (`buildTarget` in `main.js`, `paint` and the brush ghost in `editor.js`); the rules still only know anchors.
  `Assets.loadForMap` also loads the pictures of what an item `places` (it is on no map until put down).
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
- **Foliage sway** (draw-only, 26 Nov 2026; the owner's choices: a tick per object, a constant gentle breeze — gusts crossing the map are a later step): an object with `properties.sway` (true, or a number = strength; Studio: Objects → "sways in the wind") and an item lying on the ground whose Items `sway` is ticked lean slowly from side to side, planted at the foot. `swayOf` in `render.js` gives the lean in screen pixels (each thing on its own beat, from its tile; taller = further) and `drawObject(…, lean)` draws the picture as a few bands of rows, each moved whole pixels (crisp, both parts of a tall object bend as one; `inkBox` = the rows that have anything drawn, so a small plant bends too; a picture up to 48 art pixels tall is cut twice — the foot, 4 pixels, never moves; the top goes one art pixel to the side, then the middle follows; never more than that pixel: the owner's ask for bushes and fibers —, a taller one bends along a curve that keeps the trunk still). Config `foliage_sway` scales all (1; 0 = off). Not in the editors. In `data/game/` the berry bush and plant fibers are ticked; the tree is NOT (the owner found swaying trees looked odd). Not built: gusts, leaves moving apart from the trunk (a mask), the ground variety (baked).
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
  editor (built, see Dialogue below), 3 shops (built, see Shops below), 4 moving NPCs only if wanted. **NPCs are authored apart from objects** (owner's choice): still rows of
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
- **Shops** (NPC step 3, built 26 Nov 2026; the owner's choices: each offer has its own price in gold, items or both;
  stock is per CHARACTER; a shop buys only what it lists; prices are set per offer, never worked out from an item value;
  opened from a dialogue answer; restock time per offer; offers can be locked behind a condition and are then not shown).
  The `Shops` tab (Content Studio → Story → Shops): `offers` = `[{id, gives, costs, sell, stock, restock_h, if}]`. **One
  offer = one trade**: the player hands over `costs` and gets `gives` (item lists; gold is the item id `gold`) — selling
  to the shop is the same thing the other way round, `sell` only says which list the page shows it in. `stock` = how many
  times each character may take it (0 = no limit), whole again `restock_h` hours after the first one they took (0 =
  never). An NPC names its shop in `properties.shop`. **Rules** (`shared/world.js`): `{type: 'shop', key, op: 'open' |
  'trade', offer, qty}` → `shopAct` (beside the NPC only), which always answers with a `shop` event = the offers as they
  stand for that character (`shopShow`: `left`, `back` seconds). Memory: `p.shops[shop][offer] = {n, at}` (`shopLeft`).
  A dialogue answer ticked `shop` opens it (`talkAct`) and ends the talk; an NPC with a shop and NO dialogue gets `shop: 1`
  on its `npc` event and the page shows a Trade button. **Page** (`main.js`): `openShop` / `shopView` in the NPC window —
  Buy rows, then Sell rows; a click trades once, Shift+click five times. **Studio**: `shopForm` (two lists of offer cards,
  `tradeSide` = a gold number + an item list), the NPC page's Shop picker, the answer's "Opens the shop" tick. Not built:
  stock shared by all players, prices from an item value, a shop that buys anything.
- **Scenes (cinematics)** (stage 1 built 26 Nov 2026; the owner's choices: both in-engine scenes and picture storyboards,
  only the player who triggered it sees it, they are safe and ignored by monsters and players meanwhile, always
  skippable, may change the world, once per character; and the four I recommended: leaving mid-scene = it plays again
  from the start on coming back and its world changes wait; during a scene only the map, the NPCs and you are drawn and
  the fog is lifted; a line waits for a click unless it has seconds; your own figure stays where you stand). A scene is
  DRAW-ONLY, played by the page; the referee only keeps who watches what. The `Scenes` tab (Content Studio → Story →
  Scenes, `sceneForm`): `steps` = `[{type, with, …}]`, the kinds in **`Content.SCENE_STEPS`** (the Studio builds its step
  cards from it; `with` = starts together with the step before): `bars`, `fade`, `camera` (a tile or `to: me`, seconds,
  zoom, shake), `picture` (image + text, a full-screen card) — a camera move glides in a straight line, its height blended
  from where it starts to where it ends and never taken from the ground in between (owner: independent of the terrain;
  `cam.l` in `scene.js`, `Scene.view().lift`, `lift` = `sceneLift` from `main.js`), `say` (speaker + text; no speaker = a caption), `wait`.
  **Starting one:** the action verb **`scene:<id>`** in any action list (`World.run`); **whatever follows it in that list
  is held** (`p.sceneQ = [{id, then, by, at}]`, the first is playing) and runs when it ends, watched or skipped
  (`sceneEnd`) — so the world change goes in the same list after it (`scene:gate; set_state:map_3.e9:open`). Seen =
  `p.scenes[id]`; a seen, missing or empty scene is passed over and the list goes on. Several queue, one at a time.
  `publicPlayer.scene` = the one to play now; the page answers `{type: 'scene', op: 'play' | 'end', id}` (`sceneAct`;
  play restarts its clock). **While watching** (`World.watching(c, p, now)`, at most Config `scene_max_s`, 120):
  `notices` answers nothing, chasers give up (`sceneBegin`), `monsterSwing` / `monsterShot` / timed traps do nothing,
  hunger, thirst and statuses wait, every other action of theirs is DROPPED (a step already on its way); past the cap the
  next action ends it (and runs what it held). A dialogue answer that plays a scene ends the talk. Others see them with
  `wt` (view players, `functions/referee.js` too) → a `…` mark. **Page:** `client/js/scene.js` (`Scene.start / playing /
  update / view / key / click`) draws the bars, fades, pictures and lines over the view (`#scene`, CSS in `ui.css`),
  `main.js` `sceneCheck` / `playScene` start it from `me.scene` (quest windows wait), lock the keys, hide the HUD
  (`body.scene-on`), drop monsters and other players from the drawing, lift the fog, and take the camera from
  `Scene.view` (zoom = a CSS scale on the canvas). Space / Enter / F / a click moves a line on; Esc twice or Skip
  skips. **Studio:** `▶ Play this scene` opens `client/?offline&scene=<id>` (plays it at once, seen or not, told to
  nobody; the offline world waits meanwhile); the actions editor (`rewardsField`) has a "Play a scene" row (rows below
  it and the Other actions wait for it). **Stage 2, actors** (built 27 Nov 2026; the owner's choices: NPCs on the map, NPCs
  that are not on it, the player's own figure and monsters can all act; walking finds its way, with a "straight line"
  tick per step; when the scene ends everyone is back where they really stand — real changes go in the action list after
  `scene:<id>`; a spoken line shows the speaker's figure in the line box and a mark over the speaker). An actor is named
  by a ref: **`me` | `npc:<object id>` | `mon:<monster id>`** (field type `actor`, the Studio's `actorPicker`). Steps:
  `show` (a, x, y, dir E|W, fade s), `walk` (a, x, y, `speed` × a player's pace, `straight`, `wait` = the scene waits
  for the arrival), `face` (dir E | W | player | actor + `to`), `leave` (fade s); `say` takes `a` (name = the
  actor's unless typed), `emote` takes `over: actor` + `a`. An NPC standing on the map becomes a puppet where it
  stands (the placement nearest the player) the first time a step names it, and `me` likewise; a monster or an NPC not
  on the map needs `show` first (steps naming an actor that is not there do nothing). `scene.js` holds the puppets
  (`cur.puppets`, `Scene.puppets(now)` → `{ref: {x, y, facing, alpha, on, moving, key}}`, `Scene.speaker()`); `main.js`
  is told who they are through `Scene.start`'s `actor` / `path` / `portrait` / `nameOf` / `pace` (`sceneActorAt`,
  `scenePath` = an eight-way search with `Rules.tryMove`, no way = straight; `scenePortrait`, `sceneFigure`) and draws
  them (`sceneActors`; your own is `actors[0]` moved; a taken-over NPC's real figure is hidden through `scenePupKeys` in
  `npcActors` / `hiddenEntity`). A monster's look is rolled once per scene (`sceneLooks`). The speaker's mark is the
  `talk` picture in `emotes.js` (not in `Content.EMOTES`). Actors carry `alpha` (`paintActor`); `Render.figureOn` is
  exported for the portrait. **Several of the same** (owner, 27 Nov 2026: numbered copies AND packs; for monsters,
  brought-in NPCs and NPCs placed several times on the map; each copy its own look): a ref takes `#<n>` =
  another of the same (`mon:rat#2`; the number box beside the Studio's actor list; for an NPC on the map `#2` =
  the second nearest placement), each its own actor. A **pack** = `show` with `count` over 1 (at most 12): its
  members are puppets of their own named `<ref>|2`, `<ref>|3`… (`members` in `scene.js`), and every step naming the
  actor is done by all of them, each on its own tile of `World.packSpots(c, map, at, n, opts)` (the tile, then the
  nearest that can be walked to) — the one rule the page (`sceneSpots`) and the referee (a pack that stays) both ask,
  so a pack stays where it was seen. `sceneRef` in `main.js` takes a ref apart. Figures have ONE side-on picture
  (mirrored for left), so actors face left or right only: up / down would need new art.
  **No name tags are drawn during a scene.** Until a scene's first camera step the camera stays
  on the player (wherever the scene walks them). Steps that take no time (a camera cut, an emote, a `bars` step that
  changes nothing — a scene starts with the bars on) are all done within one frame (`update` in `scene.js` loops until
  a step takes time), so a scene that opens with a cut never shows where the player stands first. **Actors that stay** (owner, 27 Nov 2026; their choices: monsters and
  the player's own figure — NPCs too, but that is light phasing, `docs/QUESTS_INSTANCES_SERVER.md` Part 3, not built;
  where the scene left it; also when skipped; a short pause, then it acts like its kind): the `stay` tick on a `show`
  or `walk` step. The referee makes it real in `sceneEnd` → `sceneLeave`, worked out from the scene's own steps
  (`sceneStays`: the last tile shown on / walked to, unless it left), never from what the page says, and BEFORE the
  held action list runs: a monster is pushed into the map's record on the nearest free tile (`sceneSpot`, within 3),
  nobody's (`m.free`: no spawner, gone for good when killed, real for everyone, counts for kills), with `m.wait` =
  2 s during which `advance` and `senseStep` leave it be; `me` = `p.x, p.y` really change. Its look is rolled when the
  scene is queued (`q.cast`, `publicPlayer.sceneCast`) so the one on screen is the one that stays. Not in the Studio's
  ▶ Play (no referee). Not built: a puppet's walking changing the real world, stage 4 sound / other maps / shared scenes; watching again.
  **Stage 3, the scene map in the Studio** (built 27 Nov 2026; the owner's choices: a Map picker on the scene, the
  real map, a pick button AND draggable markers, a "player starts here" marker that ▶ Play also uses). Scenes rows
  carry `map` and `start_xy` ("x,y") — for the Studio and its Play only; the game still plays a scene wherever it
  is started (`c.scenes[id].map / .start`). `content/js/scenemap.js` (`SceneMap.draw / fit / reload / info`,
  drawn into `#qmap` by `renderSceneMap` in `cstudio.js`): the map is drawn ONCE into a picture by the game's own
  `Render.Renderer` (so the Studio page now loads autotile, rules, world, assets, scatter, render), from a content
  built from the Studio's tables and kept until ↻ (maps are edited in the map editor); over it, worked out from the
  steps in order (`planOf`): a numbered dot per step that has a tile (camera stop, show, walk, emote on a tile), the
  camera's way, each actor's walk (the way the game would find it, `pathOf`; dashed = straight), P = the player, a
  dashed ring = it stays. Drag a dot = that step's `x, y`; click a dot = its step card (`sceneSel`); a step's
  "📍 Pick on map" (or Set player) then a click = the tile (`scenePick`). Wheel zooms, dragging the ground moves.
  ▶ Play this scene first puts the offline test character on `start` (`api.warp(map, x, y)`). A draft with no maps
  (the hosted Studio before maps are loaded) shows a note instead.
- **Emotes** (26 Nov 2026; the owner's choices: a fixed pixel-art set, not system emoji; each shows for its seconds or, at 0,
  for the whole scene; over the player, an NPC or a tile; also a standing emote on an NPC and emotes players make). The ids
  and names are **`Content.EMOTES`** (sleep, alert, question, heart, dots, angry, sweat, note); the pictures are rows of
  letters in **`client/js/emotes.js`** (`Emotes.draw / icon`; a speech bubble with the icon, zzz rising letters), drawn on
  the canvas over everything at one UI pixel (1rem) per art pixel, above the name tag. A new emote = a row in `EMOTES` + its
  picture there. **Scene step `emote`** (`emote`, `over` me|npc|tile, `npc` = object id → its placement nearest the
  player, `x, y`, `s`; `none` takes one down): it never holds the scene (add a Wait); `Scene.emotes(now)` lists them.
  **NPC standing emote:** Objects `properties.emote` (Studio NPC page; a placement's `data.emote` wins), always shown; a
  scene's emote over it takes its place meanwhile. **Players:** the **emote wheel** (owner: a radial menu round your figure, on the
  held mouse wheel button): hold the wheel button, point towards one, let go = that one, let go in the middle = none
  (`openEmotes(held)` / `wheelAim` / `closeEmotes` in `main.js`, `#emotewheel` in `ui.css`); G opens the same ring to
  click or press 1-8, G / Esc shut it; never over a quest window or in a scene → action `{type: 'emote', id}` → `p.em` / `p.emAt`; `World.emoteOf` sends `"id@when"`
  for 10 s (view players, `publicPlayer.em`, `functions/referee.js`), and the page shows it `Emotes.SHOW_MS` (3 s).
  Render's `emoteTags` = the figures drawn this frame that carry `a.emote` (`{id, t, left}`); `drawEmotes` in `main.js`.
- **Art file names** (owner, 26 Nov 2026): under `art/sprites/items/<folder>/` and `art/sprites/objects/<folder>/` a file is
  `<folder, singular>_<name-with-hyphens>.png` — only the first `_` separates; states, facings and versions are hyphens too
  (`consumables/consumable_bottle-clean.png`, `harvest/harvest_berry-bush-red-picked.png`, `door/door_wood-01-open.png`).
  Paperdoll and tilesets keep their own schemes (the code reads those by pattern, below). Bodies are in
  `paperdoll/base/player|monsters|animals/`.
- **Art by file name** (no data needed): a tileset `<key>_auto.png` (`…_auto_anim.png` = animated) finds its base tile
  `<key>.png`, its variety sheets (`scatter.json`), its cliff face `<key>_face.png` and, with a tint, its mask `….tint.png`;
  a wall top `wall_<m>_top_auto.png` finds its face `wall_<m>_face.png` (`Scatter.tileInfo`). A tintable picture `foo.png`
  has its mask `foo.tint.png` next to it. The art generators (Asset Studio, `/studio/`) are local only: they need Python and a
  Gemini key in `tools/google_api_key.txt` (never committed), and run the vendored pipelines as subprocesses of
  `tools/asset_server.py`.
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
  **`before_start`** (an action list, run by `questBegin` the moment it starts, BEFORE its "New quest" window: a scene there plays first and the window waits), its **`on_start`** (run once that window has been READ — quest op `seen` → `startHook`, pending meanwhile as `p.quests[id].os`; at once when the quest has no window, e.g. accepted from an NPC; at hand-in if it was never read; owner, 26 Nov 2026: quest window → scene → tutorial) and each objective's
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
  order is `q.order`, the order an NPC offers its quests; off while searching). **Questlines** (27 Nov 2026) are folders of that list, for tidiness only (the game never reads them): a quest row names its folder in `questline`, the folders (order, empty ones) are Config `questlines` (names joined by `|`, hidden from the Config list), which are shut is `sheetsrpg.studioQuestlinesShut`. `questFolders` / `qlCard` / `qlTarget` / `qlDrop` in `cstudio.js`: drop a quest on a heading or beside a quest of a folder to put it in; Shift+click picks a run, Ctrl+click one more (`qlSel`), and dragging one of the picked moves them all; + New questline, ✎ rename, ✕ remove (its quests are kept). The rows stay one ordered list. **Scenes and Dialogues have the same folders**, called Folders (owner, 27 Nov 2026): `FOLDERS` in `cstudio.js` is the one table of which lists have them (row field `folder`, Config `scene_folders` / `dialogue_folders`, shut ones in `sheetsrpg.studioFoldersShut.<list>`); another list = one row there. On the right, the **questline map**
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
- **Stealth** (Nov 2026, `docs/STEALTH.md`; the owner agreed the plan). Stage 1 is built: **`World.notices(c, map, m, def, p, now, range, stateFn, o)` → `seen | heard | ''` is the one question every brain asks about a player** (plain, walker, hunter, animal; a monster that was struck still knows who did it). Seen = within the brain's range (× Config `sneak_sight` 0.6 while sneaking) with line of sight; heard = within the player's noise (`World.noiseOf`: Config `noise_walk` 6 / `noise_sneak` 2 tiles, nothing standing still, `NOISE_LINGER_MS` after `p.stepAt`) × Monsters `hearing` (1; 0 = deaf), walls or not. Heard only attracts: a walker searches (`ai.w`, the ?; breaks nothing), a hunter / plain one walks to it (no shot), an animal flees only within half its `flee_range`. Sneaking: Z toggles, action `{type: 'sneak', on}` → `p.sneak`; `Rules.stepCost(…, who)` × Config `sneak_slow` (2) for `who.sneak` / `who.sn` (others are sent `sn`, also in `wire.js`); while sneaking the figure is a see-through shadow (`paintActor`, Config `sneak_alpha`), the screen edges darken (`#sneak-veil`), and each monster in view shows where it would spot you (`World.sightArea` = the seen half of `notices`, Render layer 2f, Config `stealth_areas`; `World.lookRange` is the one place each brain's range is decided); the noise meter (`noiseMeter` in `main.js`, `UI.FLAGS.noise` on) is worked out on the page from its own steps. Stage 3 too: **monsters see in a cone** (Config `sight_cone` 60° on `m.facing`, long rather than wide as the owner asked: `cone_reach` 1.5 × the range ahead, straight-line distance; behind it `back_sight` × the range, 0 = not at all — the owner chose blind behind, so a sneak attack up close is possible — `World.looksAt` is the one place, notices and sightArea ask it), idle roamers turn to look about, and a blow on a monster that has not seen you, is fighting nobody and has nobody in sight is a **sneak attack** × Config `ambush_mult` (2; `unaware` in `hitMonster`). `tools/test_world.js` sets `sight_cone` 360 and `ambush_mult` 1 for the old fights. **Sneaking ends** (owner's rules): seen by a monster, or striking one that lives → `spotted()` stands you up; while any monster here is after you (`chasedBy`: `m.engaged`, `m.chase`, a walker's `ai.spot`; `p.chased` → page `me.chased`) you cannot sneak again; opening the build tools or picking a blueprint (`standUp` in `main.js`; the referee on any build action) and talking to an NPC stand you up; the noise meter shows only while sneaking. Config `stealth` = off restores the old rules exactly. **Perception** (`senseStep`, every `advance`, owner's rules): seen → the monster reacts at once (its turn is made due); heard while after nobody → `m.hear` (the ? at once; surprised, it freezes facing as it was), Config `hear_delay_s` (2) later it turns and goes to the spot (`m.goTo`, a walker's `ai.w` search) or an animal runs from it (`m.fleeFrom`); `alertOf` reads these. Sight lines are drawn from the lesser end, so seeing is the same both ways. **Raised ground hides what is behind it** (`hillBetween` in `clearLine`, so players, monsters, shots and the fog all agree): each end's eye is Config `eye_height` (0.75 of a height step; a wall is 2) above its ground, and ground between that rises above the straight eye-to-eye line blocks; level ground never does. From high ground you see far; from below a ledge taller than you, only its edge. **Looking up a ledge** (owner, 26 Nov 2026): ground higher than your eye (your own ground + `eye_height`) is out of sight, and so is whoever stands on it — **unless they stand on its very edge** (the first cell of that higher ground along the line). `upLedge` in `clearLine` is the one place: the line runs from the one looking to what is looked at, so it holds for players, monsters, blasts; `shotReach` ends a shot in the first cell above the shooter's eyes (who is on the edge can be hit, nobody behind). Looking DOWN is untouched, so this is deliberately NOT the same both ways: the one above sees and shoots the one below. For the player's view `World.visibleCells` gives such an edge cell the value **3** = who stands there is seen, its ground is not (it keeps the fog: `seen` in `Render.makeSight`); every other cell above the eye is left out. A ramp is seen from its foot, the level above only from on the ramp. Draw-only: `behindRise` (the ledge painted again over what stands behind it) lays the fog on that piece again, so a thing behind a ledge never lights the ledge up. Not built yet: stages 2 and 4 (loud events, the player's own hearing).
- **Death effect** (draw-only, 26 Nov 2026): `hitMonster` sends a `die` event (`{map, x, y, id}`, no `to`: everyone on the map) when a monster dies. The page (`deathFx` in `main.js`) takes the figure as it was last drawn (`monSnap`) and `Render.burst` turns it into its own pixels, thrown outwards (`drawFx` kind `burst`), plus drops of blood that land as a stain drawn with the ground for 12 s (`renderer.draw` `stains`, layer 2e). Only for what you were looking at. Monsters `blood` = its colour (empty = red, `none` = no blood); Config `death_fx` = off: they just vanish. No Spine: nothing is pre-animated, the picture itself is taken apart.
- **Clicking big objects** (page only, 26 Nov 2026): a thing drawn bigger than its tile is meant by any solid pixel of its picture. `Renderer.objectAt` (the frame's `hits`) says which object is drawn under a point; `bigPick` in `main.js` (end of `cellAt`) turns the click to that object's own tile only when the tile under the cursor has nothing to do and the object has (an action, or `World.harvestWith`), and never while building, removing, moving, aiming or throwing. And ONLY its pixels (owner): the empty part of a big object's own tile is no click at all (`Renderer.bigOn`; the cell comes back `miss`, `actsOf` gives nothing), unless a creature or a small thing shares the tile. **The cursor means the tile DRAWN under it, and only that** (owner, 26 Nov 2026): a ledge hides the ground behind it, so what lies hidden there is never offered through the ledge — `cellAt` takes `Render.pickCells(…)[0]` (the old `sameLevelPick`, which reached to a same-level tile under the ledge, is gone) and `bigPick` drops an object whose picture stands behind the raised ground under the cursor. A thing next to you but up or down a cliff offers nothing at all (`actsOf` asks `Rules.cliffReach`): no prompt, no pointer, no action list. F / Space, which go by direction, still reach what is on your own level. The rules still decide what may be done. The view scrolls `edgePad` (the bottom HUD's height + half a tile) past each map edge.
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
