# Sheets RPG — notes for Claude

A step-based multiplayer RPG for the browser. **All game content is data in a Google Sheets
spreadsheet ("Game Data")**; the game page and the map editor are static pages on GitHub Pages.
The **live referee is a Firebase Cloud Function** (`functions/`, runs `shared/world.js`, ~220 ms/action);
Apps Script still serves the content and the map-editor saves. The owner (the studio; writes in English)
designs the game; Claude writes the code.

- Play: https://migrationstudioshub.github.io/sheets-rpg/ (redirects to `client/`)
- Map editor: https://migrationstudioshub.github.io/sheets-rpg/editor/
- Live referee (Firebase Cloud Function): `FUNCTIONS_URL` in `client/js/config.js` (empty → fall back to the Apps Script referee)
- Content + editor server (Apps Script web app): `API_URL` in `client/js/config.js`
- Realtime Database (live world + game state): `FIREBASE_URL` in `client/js/config.js`
- Design doc (architecture, data model, roadmap): https://claude.ai/artifact/EsFtyJzhajG4P2ZDfbW9Hw
- Setup guide for the owner: `docs/SETUP.md` (Firebase steps included); moving to the studio accounts: `docs/MIGRATION.md`

## How it fits together

```
browser (client/ or editor/)  --POST (join|load|poll|act)-->  Firebase Cloud Function (functions/index.js)
  draws with canvas, predicts moves                            runs shared/world.js, has the final say (~220 ms)
  runs the same shared/*.js                                    reads/writes game state in the Realtime Database
  listens to FIREBASE_URL for the live world (pushed) <----------  writes world/<mapId> (the live view)

  --GET ?action=content--> Apps Script (server/Code.js): serves content from the Game Data sheet, and map-editor saves
```
Set `FUNCTIONS_URL` empty and the client falls back to the **Apps Script referee** (`server/Code.js` runs the same
`shared/world.js`, ~1.5 s/action, live world in CacheService) — the original path, kept as a fallback.

| Folder | Contents |
| --- | --- |
| `shared/` | Code that runs **unchanged** in the browser and in Apps Script: `content.js` (sheet rows → content object), `autotile.js` (47-tile blob autotiling), `rules.js` (movement, collision), `world.js` (everything else: monsters, combat, skills, statuses, line of sight, chests, doors, levers, traps, lockpicking, inventory, levels, events, action list for mouse clicks) |
| `client/` | Game page: `main.js` (loop, input, mouse actions, path walking, hotbar, aiming, HUD, bag), `render.js` (layered drawing, tall objects, animation, aim overlay, effects), `api.js` (**Offline, Online (Apps Script) and Functions (Cloud Function) backends** with the same methods), `assets.js`, `config.js` |
| `editor/` | Map editor: `editor.js` (canvas, tools, undo, maps), `panels.js` (palette with Terrain/Objects/Monsters tabs, inspector forms built from the Kinds tab, definition forms), `store.js` (drafts, export, saving to the server) |
| `functions/` | **The live referee**: Firebase Cloud Function (`index.js`) running the same rules as the referee; `shared/` = **generated copies** of `/shared` (run `tools/sync_server.sh`; never edit the copies). Deployed with `firebase deploy --only functions`. `package-lock.json`/`node_modules` are npm's. |
| `server/` | Apps Script project (now **content + map-editor saves only**, plus the fallback referee): `Code.js`, `appsscript.json`, and `shared_*.js` = **generated copies** of `shared/` (run `tools/sync_server.sh`; never edit the copies) |
| `data/` | `GameData.xlsx` + `Server.xlsx` (were imported once into Google Sheets), `tables.json` (same data, read by offline mode), `import/` (snapshot of the owner's original spreadsheets) |
| `art/` | `tilesets/fields_placeholder.png` (drawn by `tools/gen_placeholder_fields.py`, CraftPix layout), `sprites/` (placeholder monster/item sprites from `tools/gen_sprites.py`). Terrain/object sprites are imgur links in the data. |
| `tools/` | `build_gamedata.py` (builds data/ from data/import + the demo content), `sync_server.sh` (**syncs `shared/` into both `server/shared_*.js` and `functions/shared/`**), `test.js` (server with fake Google services), `test_world.js` (game rules), generators |
| root | `firebase.json`, `database.rules.json` (RTDB rules: `world` public-read, everything else locked), `.firebaserc` (project `sheets-rpg-73de1`) |

### Backends (all in `client/js/api.js`, same methods, same `{player, world, events, seq}` answers)
`create()` picks one: `FUNCTIONS_URL` set → **Functions**; else `API_URL` set → **Online**; else **Offline**.
A game action is sent as `do` (not `action`!): `{type: 'move', dirs} | {type: 'interact', x, y, verb} |
{type: 'attack', x, y} | {type: 'cast', skill, x, y} | {type: 'use', item} | {type: 'loadout', slot, entry}`.
`POST {action: join|load|poll|act|save, ...}`.
- **Functions** (`FUNCTIONS_URL` set — the live default): play goes to the Cloud Function (~220 ms); content still
  loads from `API_URL`; the live world is **pushed** over Firebase (`FIREBASE_URL`), so polling is a slow heartbeat.
  State lives in the Realtime Database: `players/<token>` and `state/world` are **JSON strings** (their keys hold
  `.`, which RTDB forbids in keys); `world/<mapId>` is a plain object clients read.
- **Online** (`API_URL` set, `FUNCTIONS_URL` empty): the Apps Script referee checks everything (~1.5 s). Same action
  protocol; also `GET ?action=content|tables|reload`. With `FIREBASE_URL` set it also writes the pushed live world.
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
  They contain `.`, which the Realtime Database forbids in **keys** — so the Cloud Function stores `players`/`state/world`
  as JSON strings, not trees (see `functions/index.js`).
- After editing `shared/`, run `tools/sync_server.sh` (it regenerates **both** `server/shared_*.js` and
  `functions/shared/`); `tools/test.js` fails if the `server/` copies are stale. Changing `shared/` means
  redeploying the Cloud Function too (`firebase deploy --only functions`), not just merging.
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
- **The Cloud Function deploys separately** (not via the GitHub Action): the owner runs `firebase deploy --only functions`
  (and `,database` to update rules) from the repo on the studio account (Blaze plan). It needs the `script.external_request`
  OAuth scope authorized once (any `UrlFetchApp`/external call) — unrelated to `clasp`. `docs/SETUP.md` has the steps.
  The function caches content from `API_URL` for 30 min, so `<API_URL>?action=reload` won't reach it instantly.
- After a content change in the sheet, `<API_URL>?action=reload` clears the Apps Script content cache.
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
Open follow-ups from the referee work: world-level writes are still **last-write-wins** under truly simultaneous
actions (player-position clobber is fixed); no **Sheet→RTDB character migration**; a smoother idle-monster tick
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
