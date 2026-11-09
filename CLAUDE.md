# Sheets RPG — notes for Claude

A step-based multiplayer RPG for the browser. **All game content is data in a Google Sheets
spreadsheet ("Game Data")**; the game page and the map editor are static pages on GitHub Pages;
the server is a Google Apps Script web app. The owner (the studio; writes in English) designs
the game; Claude writes the code.

- Play: https://migrationstudioshub.github.io/sheets-rpg/ (redirects to `client/`)
- Map editor: https://migrationstudioshub.github.io/sheets-rpg/editor/
- Server (Apps Script web app): the `API_URL` in `client/js/config.js`
- Design doc (architecture, data model, roadmap): https://claude.ai/artifact/EsFtyJzhajG4P2ZDfbW9Hw
- Setup guide for the owner: `docs/SETUP.md`; moving to the studio accounts: `docs/MIGRATION.md`

## How it fits together

```
browser (client/ or editor/)  --fetch text/plain POST-->  Apps Script (server/Code.js)
  draws with canvas, predicts moves                        runs shared/world.js, has the final say
  runs the same shared/*.js                                 live world in CacheService
                                                            Game Data sheet (content), Server sheet (Players, WorldState)
```

| Folder | Contents |
| --- | --- |
| `shared/` | Code that runs **unchanged** in the browser and in Apps Script: `content.js` (sheet rows → content object), `autotile.js` (47-tile blob autotiling), `rules.js` (movement, collision), `world.js` (everything else: monsters, combat, skills, statuses, line of sight, chests, doors, levers, traps, lockpicking, inventory, levels, events, action list for mouse clicks) |
| `client/` | Game page: `main.js` (loop, input, mouse actions, path walking, hotbar, aiming, HUD, bag), `render.js` (layered drawing, tall objects, animation, aim overlay, effects), `api.js` (Offline and Online backends with the same methods), `assets.js`, `config.js` |
| `editor/` | Map editor: `editor.js` (canvas, tools, undo, maps), `panels.js` (palette with Terrain/Objects/Monsters tabs, inspector forms built from the Kinds tab, definition forms), `store.js` (drafts, export, saving to the server) |
| `server/` | Apps Script project: `Code.js`, `appsscript.json`, and `shared_*.js` = **generated copies** of `shared/` (run `tools/sync_server.sh`; never edit the copies) |
| `data/` | `GameData.xlsx` + `Server.xlsx` (were imported once into Google Sheets), `tables.json` (same data, read by offline mode), `import/` (snapshot of the owner's original spreadsheets) |
| `art/` | `tilesets/fields_placeholder.png` (drawn by `tools/gen_placeholder_fields.py`, CraftPix layout), `sprites/` (placeholder monster/item sprites from `tools/gen_sprites.py`). Terrain/object sprites are imgur links in the data. |
| `tools/` | `build_gamedata.py` (builds data/ from data/import + the demo content), `sync_server.sh`, `test.js` (server with fake Google services), `test_world.js` (game rules), generators |

### Two modes
- **Online** (`API_URL` set): the server checks everything. API: `GET ?action=content|tables|reload`;
  `POST {action: join|load|poll|act|save|saveMap|deleteMap|saveTab, ...}`. A game action is sent as `do`
  (not `action`!): `{type: 'move', dirs} | {type: 'interact', x, y, verb} | {type: 'attack', x, y} | {type: 'cast', skill, x, y} | {type: 'use', item} | {type: 'loadout', slot, entry}`.
  Every answer is `{player, world, events, seq}`. Editor saves need the `EDITOR_KEY` script property,
  and send `base` (`Content.hash` / `Content.mapHash` of what was loaded); the server answers `{error, conflict: true}`
  if the sheet changed since, and the editor asks before resending with `force`.
- **Offline** (`API_URL` empty): `client/js/api.js` runs `shared/world.js` in the browser against `data/tables.json`
  (or a newer map-editor draft in localStorage), saving in localStorage. Useful for testing without the server.

## The data (Game Data spreadsheet = the database)
Tabs (one row per thing, first row = column names, the code finds columns by name and ignores unknown ones):
Config, Tilesets, Autotile, Terrain, Kinds, Objects, Maps, MapEntities, Items, Monsters, LootTables, Classes,
Skills, Statuses, Levels. Server spreadsheet: Players, WorldState (the server adds missing tabs/columns itself).

- **Kinds** describe each interactable kind's properties (type, default); the editor builds its forms from them.
  Settings resolve as kind default → object `properties` (JSON) → placement `data` (JSON in MapEntities).
- Object `kind`s: deco, container, door, switch, trap (step|timed), rest, sign, npc, spawn (places monsters), teleport, trigger, craft.
- **Data-driven actions** (`on_interact`, `on_use`, `on_cast`, trigger `do`): `give:item:n; take:item:n; gold:n; heal:n; damage:n; flag:x; unflag:x; teleport:map:x:y; set_state:key:state; xp:n; message:text`; conditions (`if`): `flag:x, !flag:x, has:item:n, level:n`.
- Item id `gold` means money. Tall objects: `sprite_top`. Animation: `frames` + `frame_ms` (horizontal strip).
- Skills: target `enemy|ally|self|tile|around`, `range`, `area`, `los`, `effect damage|heal|none`, amount = `power + scale × stat(atk|level)`, `status`, `dash`, `projectile`.

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
- After editing `shared/`, run `tools/sync_server.sh`; `tools/test.js` fails if the copies are stale.
- Client pages load scripts with a cache-busting query string (`index.html` loader) — keep that when adding files,
  and add new shared files to both `client/index.html` and `editor/index.html` lists.

## Workflow with the owner
- Work on a **branch**, push, and give the owner the pull-request link
  (`https://github.com/migrationstudioshub/sheets-rpg/pull/new/<branch>`); they merge it on GitHub. `gh` is not authenticated here.
- **Server deploys are automatic** once the owner has added the `CLASPRC_JSON` and `SCRIPT_ID` secrets to the
  `production` environment (restricted to `main`, so branch workflows can't read them — never move them to repository secrets)
  (`docs/SETUP.md`, "Automatic server updates"): `.github/workflows/deploy-server.yml` runs on every push to `main` that
  touches `server/`, `shared/` or `client/js/config.js` — syncs shared code, runs both test files, `clasp push`, redeploys
  the web app's existing deployment (id taken from `API_URL`, so the URL never changes) and clears the content cache.
  So: keep the tests green, and tell the owner a merge will update the server. If the secrets aren't set yet (the run
  fails with a clear error), the owner deploys by hand: paste every changed `server/*` file, then Deploy → Manage
  deployments → edit → New version. New server files only need to live in `server/` (`.claspignore` lists what is uploaded).
- After a content change in the sheet, `<API_URL>?action=reload` clears the server's content cache.
- **To see the live data** (the repo's `data/` is only the starting point): `GET <API_URL>?action=tables` returns every
  Game Data tab as rows. The cloud sandbox can't reach script.google.com; fetch it from the owner's built-in browser
  pane (e.g. from a tab on migrationstudioshub.github.io) instead.
- Explain things in plain terms; the owner reads summaries, not diffs. Test in a real browser before handing over.

## Testing (in Claude's cloud workspace)
- `node tools/test.js` (server, fake SpreadsheetApp/CacheService) and `node tools/test_world.js` (game rules) must pass.
- Browser: Playwright with `/usr/bin/google-chrome` against `python3 -m http.server 8765` started from the repo root
  **in the same shell command** (background servers get killed between commands). imgur is blocked in the sandbox, so
  art shows as lettered placeholders and pages wait ~8 s for image timeouts; wait for `#log` text before acting.
  `window.SheetsRPG` exposes `state()`, `camera()`, `aim()`, `plan()` for tests.
- The owner's built-in browser can reach the live site and the Apps Script URL (good for checking the real server).

## Status (9 Nov 2026)
Moved to the studio accounts (`docs/MIGRATION.md`): repo `migrationstudioshub/sheets-rpg` (one fresh commit, author
"Migration Studios" with the GitHub noreply email — keep personal names/emails out of commits and files), Pages on,
`production` environment with both secrets, automatic deploy green, `API_URL` = the studio's web app.
Checked live on 9 Nov: join, move (server-checked), save, load all work. Measured with the current code
(`faster-online` included): ~1.3–2.9 s per game request, ~8.7 s for the first join (cold start + content load).
Left for the owner: delete the test character "Tester" in Players; retire the old personal setup (MIGRATION step 7).

Done: M1 walkabout · M2 map editor · M3 RPG core · M4 skills (6 classes) · mouse controls + lockpicking · online server ·
deploy secrets locked to `main` · editor refuses to overwrite sheet edits made after it loaded (asks first).

Next: **M5 multiplayer** (presence and `view.players` already exist; needs other players drawn/animated smoothly,
chat, party/ally targeting UX, faster polling for nearby action) · **M6 story**: NPC dialogue (Dialogue tab), shops, quests.
Ideas on the table: Firebase (see below); an art pipeline script for `art/inbox/` (planned in the design doc, not built); real skill icons;
editor screens for Items/Skills/Classes (today only via the sheet).

## Later, not now: Firebase for speed
Apps Script costs ~1.2 s per request, so online, monsters move in small jumps and combat results arrive ~1 s late
(walking and your own spell effects are already predicted/instant). Agreed plan if this bothers us after multiplayer (M5):
- **Firebase Realtime Database, free Spark plan**: 100 simultaneous connections (hard limit, cannot be raised), 1 GB
  stored, 10 GB downloaded per month; no billing unless the owner upgrades. Plenty for ~10 players.
- **Option 1, preferred, stays free**: Apps Script remains the referee (actions still go through it and `shared/world.js`),
  and after each step it also writes the live view (positions, monsters, object states, recent events) to Firebase;
  clients listen to Firebase instead of polling, so the world looks live. Game Data sheets and rules code don't change.
- **Option 2**: move the referee to Firebase Cloud Functions running `shared/world.js` (fast everywhere), but that needs the
  pay-as-you-go Blaze plan with a card on file (it has a free allowance, so likely ~$0, but billing is on).
- The design already allows it: the client talks through `client/js/api.js` (one backend object with the same methods),
  and the live world is one JSON blob (`getWorld`/`saveWorld` in `server/Code.js`).

Licences: the repo is public — don't commit art that may not be redistributed (e.g. CraftPix packs).
