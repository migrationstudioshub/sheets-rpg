# Sheets RPG

A step-based multiplayer RPG whose content lives in Google Sheets. The game is a web page
(GitHub Pages); the server is an Apps Script web app; every tile, object, kind and map is
a row in the **Game Data** spreadsheet.

**Play:** https://migrationstudioshub.github.io/sheets-rpg/ · **Map editor:** https://migrationstudioshub.github.io/sheets-rpg/editor/ · **Set up the server:** [docs/SETUP.md](docs/SETUP.md)

## Layout

| Folder | What's in it |
| --- | --- |
| `client/` | The game page: canvas renderer, input, talking to the server |
| `editor/` | The map editor: palette, layers, tools, property forms built from the Kinds tab |
| `shared/` | Code used by both client and server: data loading, autotiling, movement, and the whole game world (`world.js`) |
| `server/` | Apps Script project (`shared_*.js` are generated copies of `shared/`) |
| `data/` | `GameData.xlsx` and `Server.xlsx` to import once; `tables.json` = the same data for offline mode; `import/` = snapshot of the old spreadsheets |
| `art/` | Tilesets and sprites served to the game |
| `tools/` | Build scripts and tests |

## How it works

- **Layers:** each map cell is drawn as base colour → terrain tile → object → characters, so nothing replaces anything.
- **Autotiling:** terrain with an `autotile` tileset (e.g. *Fields*) picks its edge and corner tiles from its 8 neighbours.
- **Same rules everywhere:** `shared/rules.js` runs in the browser (moves feel instant) and on the server (which has the final say).
- **Offline mode:** with no `API_URL` in `client/js/config.js`, the game reads `data/tables.json` and saves progress in the browser.

## Developing

```bash
python3 tools/build_gamedata.py    # rebuild data/*.xlsx and data/tables.json from data/import
tools/sync_server.sh               # copy shared/ into server/ after editing shared code
node tools/test.js                 # rules + server tests (fake Google services)
node tools/test_world.js           # game world: combat, chests, doors, traps, levels...
python3 tools/gen_sprites.py art/sprites   # redraw the placeholder monster and item sprites
python3 -m http.server 8000        # then open http://localhost:8000/client/
```

## Milestones

1. **Walkabout** ✓ maps from Game Data, layered drawing, autotiling, walking with collision, saved position
2. **Editor v2** ✓ standalone canvas map editor: palette, layers, brush/rectangle/fill/eyedropper/erase, undo, entity forms from Kinds, links between entities, object and terrain definitions, drafts and play-test
3. **RPG core** ✓ monsters (wander, chase, attack, respawn), bump-to-attack combat, loot tables, bag and equipment,
   chests (locked, per player, refilling), doors, levers, traps, teleports, resting and respawn points, XP and levels,
   classes, data-driven actions (`give:potion:2; flag:x`), tall objects drawn over characters, animated sprites
4. **Skills** ✓ Skills and Statuses tabs, six classes (Warrior, Rogue, Mage, Paladin, Priest, Barbarian) with mana and
   skills learned by level, a 5-slot bar for skills and items (keys 1–5), mouse aiming with range and line-of-sight
   preview, projectiles, area hits, dashes, damage/healing over time, slows, stuns and buffs
   Mouse controls: click to walk (paths around obstacles, opening doors), attack (keeps attacking until the monster
   dies), open, read, use; right-click for every option (e.g. picking a lock with a lockpick); hover shows what a click does
5. Multiplayer: shared world, other players, chat
6. Story and content: dialogue, shops, quests

Design doc: https://claude.ai/artifact/EsFtyJzhajG4P2ZDfbW9Hw
