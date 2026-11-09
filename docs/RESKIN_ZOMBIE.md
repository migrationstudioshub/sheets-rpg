# Reskinning to a zombie apocalypse — owner guide

The game engine doesn't care what the world is about: zombies, monsters, it's all the
same code. So turning Sheets RPG into a **zombie-survival RPG** is almost entirely
spreadsheet work *you* do in the live Game Data sheet — no code change needed for the
theme itself. Claude builds the new *survival systems* (hunger, infection, ammo, ranged
enemies, and later crafting/building); you design the content that uses them.

This guide maps today's fantasy content onto the apocalypse, tab by tab, and lists the new
columns the survival systems read.

> **Never re-import `GameData.xlsx`.** It would wipe your live edits. To add a new column,
> just type its header into the sheet by hand — the code ignores columns it doesn't know and
> fills in sensible defaults for ones you haven't added yet. After editing, open
> `<API_URL>?action=reload` to refresh the content cache.

## The theme reskin (pure content — do this whenever you like)

| Tab | Today | Becomes |
| --- | --- | --- |
| **Terrain** | Grass, stone floor, walls | Asphalt, sidewalk, overgrown grass, rubble, floorboards, concrete walls. Change `name`/`color`/`sprite`; passability (`pass_n/e/s/w`) is unchanged. |
| **Monsters** | Slime, rat, bat, skeleton | Walker (slow), runner (fast, low HP), brute (tanky), spitter (ranged). Just tune `hp`/`atk`/`move_ms`/`aggro_range` and rename. |
| **Objects** | Chests, barrels, doors, signs, spikes | Cars & lockers (`container`), barricaded/locked doors (`door`), rebar & fire (`trap`), campfire/cot (`rest`), trader (`npc`), workbench (`craft`), warning signs. Same kinds — just new names/sprites. |
| **Items** | Potions, swords, armor, keys | Bandages/medkits (`heal`), food & water (new columns below), bats/machetes/guns (`weapon`), jackets/vests (`armor`), scrap/wood/metal (`material`), ammo, tools. |
| **Classes** | Warrior, mage, rogue… | Survivor archetypes: Soldier, Medic, Scavenger, Engineer, Brawler… Set `start_items` and `skills`; keep the same stat columns. |
| **Skills** | Fireball, heal, charge… | Weapon/ability actions: gunshot (uses ammo), grenade (`target: tile`, `area`), bandage (`target: self`, `effect: heal`), adrenaline (`status`). The old fantasy rows can simply be rewritten. |
| **Statuses** | Burn, poison, chill, rage… | Bleeding (`dot`), infection (new kind — below), adrenaline (`buff`), broken leg (`slow`), stunned. |
| **LootTables** | Slime gel, bones | Scrap, food, ammo, parts, medical supplies. |
| **Maps** | Wilderness, arena | Streets, a ransacked store, a safehouse. Reuse the map editor; the geometry carries over. |

Money (`gold`) stays the engine's currency — relabel it "scrap" in your UI text. You asked
for a light trader economy with crafting as the main progression, so keep scrap cheap and
put most gear behind crafting recipes (coming in a later milestone).

## New columns the survival systems read (Milestone Z1)

These are **optional** — leave a column out and the system is simply off. Claude has already
wired the code and a working offline demo; add these to your live sheet to switch each
system on.

### Config (new keys — add a row each)
| key | example | meaning |
| --- | --- | --- |
| `hunger_decay_per_min` | `0.6` | Hunger lost per minute (0–100 scale). `0` = off. |
| `thirst_decay_per_min` | `0.9` | Thirst lost per minute. `0` = off. |
| `starve_damage` | `3` | HP lost per tick while hunger **or** thirst is at 0. `0` = off. |
| `starve_tick_s` | `6` | Seconds between starvation/dehydration ticks. |
| `infection_escalate` | `1` | Extra infection damage added each tick as it worsens. |
| `ranged_status_ms` | `3000` | How long a status a ranged enemy inflicts (e.g. poison spit) lasts. |

### Items (new columns)
- `hunger` — points of hunger this item restores when used (makes it food).
- `thirst` — points of thirst it restores (makes it a drink).
- An item with `on_use: cure` removes infection (an antidote). `on_use` also still runs any
  action script (`give/take/heal/flag/...`).

### Monsters (new columns)
- `attack_range` — `0` (or blank) = melee only; `4` = can attack from 4 tiles away with line of sight (a spitter).
- `ranged_cooldown_ms` — delay between ranged attacks (default 1500).
- `ranged_projectile` — `TRUE` draws a flying projectile.
- `ranged_status` — a status id to inflict on a ranged hit (e.g. `poison`).
- `infect_chance` — `0`–`1`; chance a hit from this zombie infects the survivor (e.g. `0.5`).

### Skills (new columns — turns a skill into a firearm/thrown item)
- `ammo` — an item id the skill spends per use (e.g. `ammo`). Blank = spends mana as before.
- `ammo_cost` — how many it spends per shot (default 1).

### Statuses (new kind)
- Give a status `kind: infection`. It never fades on its own and worsens each tick (by
  `infection_escalate`); only an antidote (`on_use: cure`) or death clears it. `amount` is
  its base per-tick damage, `tick_ms` its interval.

## Demo content already in the repo (offline mode)

So you can see each system working, the offline data (`data/tables.json`) now includes:
`ration`/`water`/`antidote`/`ammo` items, a `walker` (bites can infect) and `spitter`
(ranged) zombie, an `infection` status, and a `gunshot` skill (spends ammo, taught to the
warrior at level 5). These are examples to copy/retheme in your live sheet, not final design.
