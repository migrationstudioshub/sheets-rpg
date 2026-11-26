# The game's UI kit

The look of the game page (HUD, inventory + crafting, campfire, and every other window) since 25 Nov 2026.
The pieces themselves, what each is for and how it is sliced: `art/ui/kit/PIECES.md` (and `pieces.json`).

## Where things are
| what | where |
| --- | --- |
| The pieces, plain set (83) | `art/ui/kit/plain/` |
| The pieces, Nano Banana set (38, same names and sizes) | `art/ui/kit/nb/` |
| Fonts: Silkscreen (labels), Jersey 10 (body). SIL Open Font License | `art/ui/fonts/` |
| Which set each piece comes from, the scale, the flags, bars / chips / icons / toasts / tooltip | `client/js/ui.js` |
| Every size, position and colour | `client/css/ui.css` |
| The HUD and the windows (what goes in them) | `client/js/main.js`: `hud`, `weaponCard`, `tracker`, `promptMark`, `bag` → `invWindow` / `storeWindow` / `cookWindow`, `recipeBook`, `bagColumn`, `itemCard` |

## The rules
- **1rem = 1 art pixel.** `ui.js` sets `--u` so an art pixel is a whole number of the screen's REAL pixels (counted with
  `devicePixelRatio`, so Windows display scaling and browser zoom do not shrink it), from the room the view has
  (`floor(min(width / 720, height / 360))`, 1 at least). The stylesheet never uses `px`. The player can override it with
  the UI size menu in the top strip (Auto / 1x-6x, kept in this browser as `sheetsrpg.uiScale`).
- **No picture is named in the stylesheet.** A piece is `var(--k-<piece>)`.
- **Switching a piece between the two sets is one line**: the `SET` table at the top of `ui.js` (`piece: 'nb'`; a piece
  not listed is the plain one). Today from Nano Banana: `panel_metal`, `header_plate`, `panel_paper`, every `button_*`.
  Their middles are tiled, not stretched.
- The Nano Banana notebook page has its tape drawn in (64 x 50, cut 3,14,3,3): `ui.js` makes a tape-free top edge from it
  once, so a wide page does not repeat the tape, and the two taped ends are laid over the corners.
- Colour means something: yellow = picked / the one main action / quests, red = health, danger, missing, green = enough,
  blue = water. Only one `.primary` button per window.

## Built, and switched off (`UI.FLAGS` in `client/js/ui.js`)
Each of these is made and styled, and shows nothing until its flag is on **and** the game sends its number. Nothing draws
a made-up value. To look at one: `…/client/index.html?offline&ui=minimap` (`ui=all` = every flag).

| flag | what | what it reads |
| --- | --- | --- |
| `minimap` | the land around you, top right | works today (the map on screen, Terrain `color`); off until wanted |
| `clock` | day, hour, day-night track | `me.clock = {day, frac, text}` |
| `nightfall` | "Nightfall in 2h 10m", top left | `me.clock.nightIn` (game minutes) |
| `noise` | noise / visibility meter, top centre | `me.noise` 0-1 |
| `stamina` | the bar under health | `me.stamina`, `me.maxStamina` |
| `temperature` | a vital chip | `me.temp` 0-100 |
| `condition` | the weapon card's condition bar | `me.cond[itemId]` 0-1 |
| `load` | the weight bar under the backpack | `me.load`, `me.maxLoad` |
| `lockedRow` | a locked row under the backpack | bag upgrades |
| `queue` | craft / cook queue cells | a queue in the rules |

## Backburner: data and rules the mocks ask for, not in the game yet
Nothing below was added. Each needs a decision first; the UI part is already there unless said.

1. **Stamina** (a number that sprinting / swinging spends). Not in `shared/world.js` at all. UI: ready (`stamina`).
2. **Day and night** (a world clock, day length, when night falls). UI: ready (`clock`, `nightfall`).
3. **Temperature / warmth** (per player, and a Warmth stat on clothes; "+warmth nearby" on a lit fire). UI: chip ready;
   the Warmth row of the stats box and the campfire note are not drawn.
4. **Noise / stealth**. DONE (25 Nov 2026, `docs/STEALTH.md` stage 1): the `noise` meter is on, filled by `noiseMeter` in `main.js`.
5. **Weight**: Items `weight`, a carry limit. UI: ready (`load`).
6. **Condition / durability**: per item instance, which stacks do not have today. UI: ready (`condition`).
7. **Bag upgrades** (a back-slot item that adds rows). UI: ready (`lockedRow`).
8. **A craft / cook queue** (today: one hand job, one cooker job with batches). UI: cells ready (`queue`).
9. ~~Item descriptions~~: done (Items `description`, shown on the item card and on the page of a recipe that makes it).
10. **Recipe categories**: Recipes `category` exists but is empty in `data/game/`; with two or more filled in, the filter
    buttons (All / Tools / Weapons / …) appear by themselves.
11. **Split a stack with a button** (the mock's SPLIT): there is no `split` action; Shift / Ctrl while dropping do it today.
12. **Fuel burn-time bar**: the fire sends the time left, not the total, so there is the time in words and no bar.
13. **Bleeding and other status icons**: statuses show (colour, name, time); a per-status icon would need a Statuses `icon`.
14. **Area names** for the minimap corner (today: the map's name).
15. **Journal / Map / Skills tabs** on the inventory window: there is one tab (the window's name). The quest log stays on L.
16. **Art**: item pictures for things that still show two letters (pistol, bandage, arrows…).

## Names over characters
Not painted into the game picture (which is stretched to the window and would blur them): `render.js` lists where each name goes
(`renderer.nameTags`) and `main.js` (`nameTags`) lays them over the view as text, Jersey 10 (the body font: the case people type is kept), bone (players' own colour for
others), with a 1 px dark outline (`.ntag` in `ui.css`).

## Window height
The inventory window and a cooker's window (`#bag.tall`) take the whole height of the view, less the belt: the parts marked
`.fill` (recipe list, notebook page, item card) share what is left, never below their min-height. A chest's window stays compact.

## Changed in the game data
`data/game/tables.json`: the campfire now has `raw_slots: 6`, `fuel_slots: 4`, `out_slots: 6` (it had none, so 20 each).
A cooker with other counts just gets more rows.
The backpack is Config `bag_slots` = 56 (7 rows of 8; it was the default 32).
