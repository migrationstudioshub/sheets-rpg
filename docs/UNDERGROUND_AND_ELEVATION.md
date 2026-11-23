# Mines, digging and terrain elevation

Status: **design only — nothing here is built.** Written 18 Nov 2026 from a conversation with the owner, to be
picked up later. Read `docs/FLOORS.md` first: all three ideas sit on the floors model (a floor is a flat map of
its own; floors of a building share x/y).

It is **not** a 3D voxel world and is not meant to become one (see §7).

## 1. What was decided

| Question | Decision |
| --- | --- |
| Voxels? | **No.** Keep stacked flat maps. Digging and elevation are added as rules on top. |
| Mines in the hand-made overworld | **Shared by everyone.** More polished than a base mine, and they **replenish faster**. |
| Mines in a claimed base | **Private** to the base: its owner and members. **Raiders can enter during a raid**, and so can anyone allowed into the base. |
| Terrain elevation | **Height per tile, drawn raised, with the cut-away treatment walls get.** Not the purely visual fake. |

Still open: §6.

## 2. Mines

A mine is a place underground with a lot of ground to dig for resources. Two kinds, by where the entrance is.

### 2.1 Overworld mines (shared)
- The entrance — a **mine shaft** object — is placed by the owner in a hand-made map.
- Everyone who enters arrives in the **same** mine and sees each other there.
- It may be hand-made (a floor map of the overworld map, or a map of its own), generated, or a hand-made
  shell with generated deposits. "More polished" suggests hand-made layout with resources that come back.
- Resources **replenish quickly** (a Config value, or a property of the shaft), so it is a renewable place to go.

### 2.2 Base mines (private)
- A player builds a mine shaft inside their claim (a blueprint).
- It leads to a mine that belongs to that base. It is **generated** the first time it is entered.
- Who may enter: the same people who may use the base — `World.mayUse` on the shaft's cell: the owner and
  members. With `pvp_structures` on (raids), anyone who reaches the shaft may enter, like any other built
  thing in a base.
- Replenishes more slowly than an overworld mine, or not at all (to be set; see §6).
- When the claim dissolves, the mine stops being private. What happens to the mine itself is open (§6).

### 2.3 How it would be built
- The shaft is a teleport whose destination is a map made at play time. Today maps only come from the map
  editor (`maps/<id>` docs, served by the function); a generated mine needs the referee to **create a map**,
  store it, and serve it to the players who enter.
- A generated map is separate from the world map, so it never grows it, and it can be thrown away and
  regenerated.
- The generator: rooms and corridors or one open cavern, ore deposits by depth, monsters, the ladder back.
  A stored seed gives the same layout each time; a new seed on reset gives variety.
- Naming: a generated mine could be a basement floor of the map its shaft is on (`floor_of` + negative `z`),
  which keeps it in the building-map family and lets stage 3's sight rules treat it as underground. Or it
  could be a detached map. To be decided when built; a detached map is simpler to delete.

## 3. Digging

A basement cell is either **open** (floor you can stand on) or **solid** (earth). Today an empty cell on a floor
map already means "nothing to stand on"; digging gives solid cells a **material** and lets players remove them.

- A solid cell has a material: dirt, stone, an ore. Materials say what you get, what tool is needed and how
  long it takes — the same shape as `properties.harvest` on objects and the `tool` tags on items.
- Digging the solid cell next to you turns it into floor and gives its yield. It is a harvest whose target is
  the ground, not an object.
- A basement may start completely solid; players carve rooms and tunnels out from the foot of their stairs.
- "Terraforming" in the wider sense — filling a cell back in with material you carry — is the reverse action
  and can come with it.
- Where it is recorded: the structure layer already records what has been removed from a map and what grows
  back (`struct.gone`, timers with `regrow`). Dug cells could be recorded the same way; whether that scales
  is the question in §6.
- Drawing: a solid cell beside an open one shows a rock face, like a wall face. Solid cells nobody has dug
  next to stay dark.
- Digging **down from the ground floor** to open the cell beneath (creating the basement floor if there is
  none) is possible as a rule between two layers — a hole, like a stairwell — but is a later step.

## 4. Terrain elevation

**Height per tile, drawn raised, with cut-away.**

- Each tile of a map carries a height in whole steps (0 = the floor's own level). One step is a fraction of a
  storey; a full storey is `Rules.WALL_H` (2 tiles), so the top of a two-step hill is level with the floor
  above and could meet a balcony.
- **Movement:** a change of height between two neighbouring tiles is a **cliff**: it cannot be crossed, in
  either direction, except by a **ramp** (an object, or a tile flagged as one) — the same idea as a staircase
  inside one floor. Diagonals obey the usual both-ways-round rule.
- **Drawing:** a raised tile is drawn higher on the screen by its height; the step between two heights shows
  a cliff face. Raised ground hides what is directly behind it, so it needs the **cut-away** tall walls get:
  when the player is behind a rise, it drops to a stub or goes see-through near them.
- **Characters and objects** on a raised tile are drawn at that height (as on a staircase: `Rules.stairHeight`
  already raises whoever stands on a run).
- **Sight and combat:** to begin with, height does not change line of sight. High ground seeing over low
  walls and gaining range belongs with `docs/FLOORS.md` stage 3 (sight between floors, height bonus) and
  should be designed together with it.
- **Editor:** a height brush (raise / lower / level), and the map drawn raised as the game draws it.
- **Data:** one more grid on the map row, like `roof` and `nobuild` (compact-encoded), absent on maps that
  do not use it. Needs the function to store and serve it, as `floor_of` / `z` did.

### 4.1 What is built (elevation stage 1, 22 Nov 2026)

Decided with the owner: **one step = one tile on screen** (two = a storey); **ramps are painted on a tile**; **only the map editor** changes height; cliff faces will come **from the ground's own tileset** (`<key>_face.png` next to `<key>_auto.png`).

- **Data:** a map's `elev` grid (like `nobuild`, compact-encoded, absent when unused). A token is the height (`2`), optionally followed by the way a ramp on that tile climbs (`1N` = from 1 up to 2 going north).
- **Rules:** `Rules.heightAt / rampAt / cliffBetween / groundHeight`; `tryMove` answers `cliff` across a change of height with no ramp (players and monsters alike). Sight, shots and reach ignore height for now.
- **Map editor:** the Height tab (key 8): a level and an optional ramp direction, painted with the usual tools.
- **Drawing:** `Render.drawRelief` shows height on the FLAT map (lighter high ground, cliff lines, ramp arrows), in the game and the editor.

### 4.2 Stage 2: drawn raised (22 Nov 2026)

- **The game** bakes the ground raised (`Render.bakeGround(content, map, true)`; the canvas has a top margin, `canvas.pad`): each tile lifted by its height, a cliff face under every south drop (the ground tileset's `<key>_face.png`: 4 columns = single / left / middle / right, 5 = two middles; one tile high, repeated; a plain earth bank when there is no art), ramps stretched (north) or sheared (east / west). A ramp climbing south is edge-on: it takes no room on screen and cannot be clicked.
- **Everything on the ground** is drawn with the same lift (`Render.liftAt`, `L()` inside `draw`): objects, walls, doors, fixtures, characters, fog and roof veils, bars, marks, floating numbers. Sorting still goes by where a thing stands on the map.
- **Hiding:** `behindRise` repaints the nearer, higher ground over whatever was just drawn behind it — solid, or see-through within `wall_cut_radius` of the player.
- **Clicking:** `Render.pickCell` finds the tile drawn under the cursor (tops and cliff faces).
- **The map editor stays flat** (relief view): it is a grid to paint on.

**Not built yet:** the aim, build-ghost, claim and remove overlays are still drawn at ground level on raised tiles; doorsteps and window light of buildings on raised ground; height in sight and combat (stage 3).

## 5. Suggested order

1. **Mine shaft to a generated mine** — the least tangled with everything else, and it gives a reason to go
   underground. Shared overworld mines first (simplest), then private base mines.
2. **Digging**, inside mines first, then under bases.
3. **Elevation.** Decide it **before** floors stage 3 is built, because stage 3 is where "how high am I and
   what can I see from here" is settled.

## 6. Open questions

- **Are dug tunnels permanent?** Under a base, in a shared mine, in a generated one? Options: permanent;
  regrowing after a while; permanent inside a claim and regrowing elsewhere. Permanent digging makes each
  map's saved state grow with every tile dug.
- **Base mines:** do they replenish at all? What happens to one when its claim is destroyed — does it stay
  for whoever claims next, become open to all, or get deleted?
- **Overworld mines:** hand-made, generated, or a hand-made shell with generated deposits? How fast is
  "quicker"?
- **Size and depth** of a generated mine, and whether deeper means richer.
- **How many generated maps** may exist at once, and when unused ones are deleted (storage and cost).
- **Elevation:** how many height steps; is a ramp an object or a kind of tile; can players change height
  (that is terraforming on the surface) or only the map editor.
- **Monsters underground:** do mines have their own, and do they come up?

## 7. Why not voxels

A true 3D grid would make digging, tunnels and height one system, but it replaces the map format, the thin
edge walls and everything built on them (fixtures, cursor side, cut-away, doorsteps), movement and sight, the
renderer and the map editor, and it changes how much state the referee stores per map. Roughly half the game
would carry over untouched; the half that would not is the half that took the most work. Layers plus height
plus a dig rule give most of the play value and keep all of that. What they cannot do is free-form 3D shapes:
overhangs, bridges over bridges, caves at arbitrary depths between layers.
