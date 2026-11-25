# UI kit: piece reference

What every piece in `pieces/` is for, where it goes, and how to slice and scale it.
The same data in machine-readable form is in `pieces.json`.

## 1. Scale
- All pieces are drawn in **art pixels** at 1x. The reference screen is **720 x 360 art px**.
- Pick one whole-number scale for the whole UI and never use fractions:
  `UI_SCALE = max(1, floor(min(screen_w / 720, screen_h / 360)))`
  (1440x720 or 1920x1080 gives 2, 2560x1440 gives 3).
- Draw every piece scaled by `UI_SCALE` with **nearest-neighbour** filtering, at positions that
  are multiples of `UI_SCALE`, so pixels stay square and sharp.
- **Item icons** (the 32x32 world sprites) go into slots at `max(1, floor(UI_SCALE / 2))`, centred.
  At UI_SCALE 2 a 20px slot is 40 screen px and holds the 32px sprite with 4px to spare.
- Fonts scale with the UI too (see 3).

## 2. 9-slice and how to resize a piece
Most frames can be any size. Cut them into 9 parts with the border widths given per piece
(left, top, right, bottom). The 4 corners are drawn as-is, the edges repeat along their length,
and the middle fills the rest.
- **stretch**: the middle and edges are flat colour, so stretching them is fine.
- **tile**: the middle has texture (scratches, ruled lines, segments). Repeat it instead of
  stretching, or the texture smears.
- **fixed size**: draw at its own size and never resize (slots, icons, checkboxes, toggles).
- Pieces with a fixed height (header, tabs, buttons) are 3-slice in practice: only the width changes.
- Godot: `NinePatchRect` with the margins below, axis mode Tile or Stretch. Unity: sprite borders
  in the Sprite Editor plus Image Type Sliced or Tiled. Phaser: `NineSlice`. HTML: `border-image`.

## 3. Text
| font | file | size (art px) | used for | colour |
|---|---|---|---|---|
| Silkscreen Bold | `fonts/Silkscreen-Bold.ttf` | 8 | headers, tabs, keycaps, item names, numbers that matter | bone `#e7ddc2` |
| Silkscreen | `fonts/Silkscreen-Regular.ttf` | 8 | labels, counts, stats, small hints | bone, or grey `#837d7f` for secondary |
| Jersey 10 | `fonts/Jersey10-Regular.ttf` | 10 | mixed-case body: descriptions, quest lines, tips | bone or `#ada59f` |

- Render at `size x UI_SCALE` with **anti-aliasing off**. Silkscreen is all caps and its capitals are 5 art px tall.
- On the game world, give text a 1 art px near-black `#0e0d11` shadow at (+1,+1).
- On paper, text is near-black. Have/need counts are rot green `#3c4633` (enough) or blood red `#8e1c22` (missing).
- Both fonts are SIL Open Font License: free to ship in a commercial game.

## 4. Colour roles
| colour | hex | means |
|---|---|---|
| hazard yellow | `#c49b2a` | selected, the main action, quest titles |
| blood red | `#c1352d` | health, danger, missing, critical |
| rot green | `#a2a683` | have enough, done, infection |
| cold blue | `#86a3b8` | water, cold, night |
| bone | `#e7ddc2` | text on dark |
| near-black | `#0e0d11` | outlines, text on paper and keycaps |

## 5. Where things go
Coordinates are art px on the 720x360 reference. Anchor HUD pieces to the **screen edge they sit
against** (keep the 6px margin), not to fixed coordinates, so they hold on any aspect ratio.

**HUD** (`mock_hud.png`)
| element | anchor | position / size | built from |
|---|---|---|---|
| nightfall warning | top-left | (6,4), 132x15, only shown in the last ~3 game hours of daylight | panel_plate, icon_moon, Silkscreen |
| noise meter | top-centre | 76x15, 4px from the top | panel_plate, icon_eye, bar_frame + bar_fill_stamina (14px ticks) |
| clock | top-right | 110x20, 6px from right, 4px from top | clock + text + icon |
| minimap | top-right | 110x62, 3px under the clock | minimap_frame |
| quest card | top-right | 110 wide, 3px under the minimap, grows with objectives | panel_plate + 2px yellow stripe on the left, checkbox, bar |
| pickup toasts | left | x=6, newest at y=236, older ones stack upward every 22px, fade after ~3s | panel_plate 20 tall, item sprite, Silkscreen |
| interaction prompt | world | right of the target object | keycap + panel_plate label |
| vitals | bottom-left | 150x52, 6px from left and bottom | panel_plate, 4 chips + status chip, HP bar (11 tall), stamina bar (7 tall) |
| XP | bottom-centre | 3px above the belt backing, belt width | small panel_plate 'LV 2' tag + bar_frame/bar_fill_xp 6 tall + label |
| belt | bottom-centre | 10 slot_hotbar at 25px pitch on a panel_plate backing (3px padding), 6px from bottom | slot_hotbar, slot_hotbar_selected |
| weapon card | bottom-right | 118x36, 6px from right and bottom | panel_plate, slot_hotbar, icon_ammo, bar (condition) |

**Windows** (`mock_inventory_crafting.png`, `mock_campfire.png`)
- Window: panel_metal 672 wide, centred, top at y=19; tabs above it at y=6. Height fits the content
  (293 for inventory, 263 for campfire). [ESC] CLOSE top-right above the window.
- The world behind is darkened to about 30% brightness and half saturation. The belt stays visible
  so items can be dragged onto it.
- Columns sit 8px inside the window with 8px gutters. Every column starts with a header_plate.
  - Inventory: survivor 160, backpack 172, crafting 308 (recipe list 150 + paper page 152).
  - Campfire: backpack 172, station 240, recipes 228.
- Bottom row: a divider (1px near-black over 1px `#2c2a31`), then keycap + Silkscreen hints, 10px apart.
- Grids: slots at 21px pitch inside a panel_inset with 2px padding (backpack: 8 x 4 plus a locked row).
- Recipe rows: 24px tall, slot + name (Silkscreen) + status (Jersey 10, green 'ready' or red 'missing 3 fiber').
  The selected row gets a `#2c2a31` background and a 2px yellow bar on its left.

### Panels

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `panel_metal` | 48x48 | 6,6,6,6 / tile | Main window body: inventory, campfire, any full-screen menu. Holds headers, slots and lists. | Screens. In the mocks: 672x300 at (24,19), centred under the tab row. | Corner rivets live in the 6px corners. Lay content 8px in from the outer edge. |
| `panel_plate` | 24x24 | 2,2,2,2 / stretch | Small raised plate: HUD blocks, stat boxes, item detail card, belt backing, toasts, clock, quest card. | HUD and inside windows. | Pad content 4-5px from the edge. Belt backing: 3px around the 10 hotbar slots. |
| `panel_inset` | 24x24 | 1,1,1,1 / stretch | Recessed tray that holds a grid or list: backpack grid, recipe list, campfire station, quantity box. | Inside windows, under groups of slots. | Dark top/left edge, light bottom/right, so it reads as sunk in. |
| `panel_paper` | 64x48 | 3,12,3,3 / tile | Notebook page for the selected recipe: icon, name, stats, needed ingredients, flavour text. | Crafting and campfire, right column. | Ruled lines every 8px from y=12, so tile the middle vertically in steps of 8. Put `tape` on top at x=6 and x=w-22, y=-2. Text on paper is near-black #0e0d11. |
| `panel_tooltip` | 24x24 | 2,2,2,2 / stretch | Hover tooltip for items, recipes and stats. | Follows the cursor, 8px right and below it, kept on screen. | Silkscreen title in bone, Jersey 10 body, stat changes in rot green (+) or blood red (-). |
| `tape` | 16x6 | fixed size | Duct tape strip that holds paper panels. | Two per paper panel, overlapping its top edge by 2px. | Draw after the paper. |
| `header_plate` | 64x14 | 11,2,2,2 / tile | Section title bar: SURVIVOR, BACKPACK, CRAFTING, CAMPFIRE, RECIPES. | Top of each column inside a window, full column width. | Height stays 14. Left 11px is the hazard stripe block, never stretch it. Title: Silkscreen Bold, bone, at (14,4) with a 1px olive shadow. Optional right-aligned counter (5/32) in Silkscreen at w-5. |
| `tab_active`<br>`tab_idle` | 40x15 | 2,4,2,2 / stretch | Window tabs: INVENTORY / JOURNAL / MAP / SKILLS. | Row above the window, starting 8px in from its left edge, 1px apart. | Width = label width + 12. Label: Silkscreen Bold at (6,5), bone when active, grey #837d7f when idle. Tabs overlap the window top by 2px: under the active tab, paint over the window's top border with olive #3e4331 so it opens into the panel. |

### Slots

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `slot_empty`<br>`slot_hover`<br>`slot_selected`<br>`slot_locked`<br>`slot_warn` | 20x20 | fixed size | Inventory, equipment, recipe and station cells. Swap the whole sprite per state: hover = cursor over it, selected = picked or being dragged, locked = not unlocked yet (bag upgrades), warn = something wrong (broken item, missing fuel). | Grids at 21px pitch (20 + 1px gap). | Item icons (32x32 world sprites) are drawn at 1 screen px per sprite px, centred, so they fit the 40-screen-px slot with 4px to spare. Stack count: Silkscreen, bone with a near-black shadow, bottom-right at (n-2, n-8), right-aligned. Empty equipment slots can show a 9x9 icon in #423f46 as a ghost hint. |
| `slot_hotbar`<br>`slot_hotbar_selected` | 24x24 | fixed size | Belt (hotbar) slots 1-0. | Bottom centre of the HUD, 25px pitch, on a panel_plate backing. | Key number in Silkscreen, grey #5e5a60, at (3,3). Selected = the one in hand. |

### Buttons

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `button_normal_idle`<br>`button_normal_hover`<br>`button_normal_pressed`<br>`button_normal_disabled` | 32x14 | 2,2,2,3 / stretch | Any ordinary action: Sort, Split, filters, +/- steppers, close. | Windows and dialogs. | Height 14 (13 for filter chips, 16 for the Craft/Cook bar). Label: Silkscreen, centred, 1px lower when pressed. Text bone on normal/danger, near-black on primary, #5e5a60 when disabled. An optional 9x9 icon sits 3px from the left. A pressed state also serves as 'toggled on' for filter chips. |
| `button_primary_idle`<br>`button_primary_hover`<br>`button_primary_pressed` | 32x14 | 2,2,2,3 / stretch | The one main action on a screen: Craft, Cook. Only one per screen. | Windows and dialogs. | Height 14 (13 for filter chips, 16 for the Craft/Cook bar). Label: Silkscreen, centred, 1px lower when pressed. Text bone on normal/danger, near-black on primary, #5e5a60 when disabled. An optional 9x9 icon sits 3px from the left. A pressed state also serves as 'toggled on' for filter chips. |
| `button_danger_idle`<br>`button_danger_hover`<br>`button_danger_pressed` | 32x14 | 2,2,2,3 / stretch | Destructive actions: Drop, Destroy, Abandon quest. | Windows and dialogs. | Height 14 (13 for filter chips, 16 for the Craft/Cook bar). Label: Silkscreen, centred, 1px lower when pressed. Text bone on normal/danger, near-black on primary, #5e5a60 when disabled. An optional 9x9 icon sits 3px from the left. A pressed state also serves as 'toggled on' for filter chips. |

### Bars

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `bar_frame` | 48x8 | 1,2,1,1 / stretch | Empty trough for every bar: HP, stamina, XP, quest progress, craft progress, fuel, load, condition. | HUD and windows. | Any width; height 5-11 (HP 11, stamina 7, XP 6, small progress 5). |
| `bar_fill_hp`<br>`bar_fill_stamina`<br>`bar_fill_hunger`<br>`bar_fill_thirst`<br>`bar_fill_infection`<br>`bar_fill_xp`<br>`bar_fill_temp`<br>`bar_fill_fuel` | 20x6 | 0,1,0,1 / tile | Fill for the matching bar. hp red, stamina hazard yellow, hunger rust, thirst/temp cold blue, infection rot green, xp bone, fuel orange. | Inside bar_frame, inset 1px. | Tile horizontally (10px period, dark tick every 10px) and clip to value x inner width. For thin bars (5-6px) you can turn ticks off. HP damage tail: after a hit, draw the lost part in #ada59f for ~0.5s, then shrink it. |

### HUD

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `chip_frame`<br>`chip_frame_warn` | 16x16 | fixed size | Square vital gauge: thirst, hunger, temperature, infection (and fuel). Warn version has a red rim for critical values. | HUD vitals block, 19px pitch. | Build at runtime: frame, then a fill from the bottom of the 14x14 inside (height = 14 x value) in the kind's dark colour with a 1px mid-colour top line, then the 9x9 icon at (3,3) in bone with a 1px near-black shadow at (+1,+1). Switch to chip_frame_warn below 20% (or above 80% for infection). |
| `chip_hp`<br>`chip_stamina`<br>`chip_hunger`<br>`chip_thirst`<br>`chip_infection`<br>`chip_xp`<br>`chip_temp`<br>`chip_fuel` | 16x16 | fixed size | Previews of each chip at 65%. Reference only: build chips at runtime as above. | - |  |
| `clock` | 110x20 | 3,2,3,2 / stretch | Day counter, time and day/night track. | HUD top-right, 6px from the edges (in the mock: 110 wide at x=604). | Draw on top: sun or moon icon at (4,3) (sun yellow, moon #86a3b8), 'DAY 3' in Silkscreen Bold at (16,5), time right-aligned at w-5. Track at y=14-16: blue night, yellow day, blue night (0-20%, 20-75%, 75-100% of the day). Now-marker: 1x5 bone line at x = 4 + (w-8) x day_fraction, y=13. Stretching breaks the track proportions, so redraw the track if you change width. |
| `minimap_frame` | 110x62 | 4,4,4,4 / stretch | Minimap frame. | HUD top-right, right under the clock (3px gap). | Map image in the 102x54 inside at (4,4). Player: bone arrow in the centre with a near-black outline. Zombies: 2x2 red #c1352d dots. Quest target: yellow diamond. North: 9x8 near-black notch at top centre with 'N'. Area name bottom-right in Silkscreen. |

### Controls

| piece | size | 9-slice (L,T,R,B) / middle | what it is for | where | how to use it |
|---|---|---|---|---|---|
| `keycap` | 12x11 | 2,2,2,3 / stretch | Key hints: interaction prompts ([E] Pick up), control hints along the window bottom, [ESC] Close. | Prompts float next to the target object; hints sit along the window bottom. | Width = label width + 6. Label: Silkscreen Bold, near-black, at (3,2). Pair it with a panel_plate label to its right, 2px gap. |
| `checkbox_off`<br>`checkbox_on` | 9x9 | fixed size | Filters (Can craft) and quest objectives. | Windows and the quest tracker. | checkbox_on is 10 tall because the tick pokes 1px above the box: draw it 1px higher. Label 12px to the right. |
| `toggle_off`<br>`toggle_on` | 24x11 | fixed size | On/off switches: campfire lit, settings. | Campfire fuel section. | Label under or beside it; yellow 'LIT' when on. |
| `scrollbar_track` | 6x40 | 1,1,1,1 / stretch | Scrollbar track for lists (recipes). | Right edge inside the list's inset. |  |
| `scrollbar_thumb` | 4x12 | 0,1,0,1 / stretch | Scrollbar thumb. | Inside the track, inset 1px. | Height = track height x visible fraction. |
| `flow_arrow_empty`<br>`flow_arrow_full` | 20x11 | fixed size | Process arrow (raw > fire > cooked). | Campfire station, either side of the fire. | Progress: draw empty, then draw full clipped to progress x 20px from the left. |

### Icons (all 9x9, fixed size, one colour)

Drawn in bone `#e7ddc2`. Recolour by replacing that one colour (yellow for a selected or primary context, red for danger, grey `#423f46` for empty-slot ghosts). Add a 1px near-black shadow at (+1,+1) when an icon sits on the game world.

| icon | used for |
|---|---|
| `icon_heart` | HP |
| `icon_drop` | thirst, water, bleeding |
| `icon_meat` | hunger, food filter |
| `icon_bolt` | stamina |
| `icon_skull` | infection, danger |
| `icon_temp` | temperature, warmth stat |
| `icon_sun` | day |
| `icon_moon` | night, nightfall warning |
| `icon_flame` | fuel, campfire, Cook button |
| `icon_hammer` | crafting, Craft button, tools filter |
| `icon_pack` | backpack, all-items filter, back slot ghost |
| `icon_lock` | locked slot |
| `icon_shield` | defence, chest slot ghost |
| `icon_sword` | attack, weapons filter |
| `icon_ammo` | ammo count |
| `icon_check` | have enough, done |
| `icon_x` | missing, close |
| `icon_left` | page/arrow |
| `icon_right` | page/arrow |
| `icon_up` | sort/arrow |
| `icon_down` | sort/arrow |
| `icon_marker` | quest target |
| `icon_arrow` | player on minimap |
| `icon_coin` | gold |
| `icon_plus` | stepper +, XP |
| `icon_minus` | stepper - |
| `icon_eye` | noise / visibility meter |
## 6. Nano Banana versions (`nano_banana/pieces/`)
Same names and sizes as `pieces/` and the same 9-slice borders, with these differences:
- Their middles are textured, so use **tile**, not stretch, for every frame and button.
- `panel_paper` there is the older 64x50 version with the tape baked in: slice 3,14,3,3 and don't add `tape`.
- `minimap_frame` there is the older 84x62 version with a 1px empty top row: slice 4,5,4,4.
- Pieces with no Nano Banana version (bar fills, chips, icons, the new split pieces) use the plain one.
  Bar fills and icons should stay flat anyway, so they read at a glance.
