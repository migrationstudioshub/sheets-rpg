# Floors: multi-storey buildings and basements

Status: **stage 1 built** (branch `floors`, 18 Nov 2026; not yet run on the real server). Stages 2–4 not started (see §9). Decisions in §1 were made by the owner on 18 Nov 2026.

This is the plan for real multi-storey construction inside one map: upper floors, basements, staircases you
walk and teleports between floors, drawn raised, with sight between floors. Read it before touching anything
that mentions a floor.

## 1. What was decided

| Question | Decision |
| --- | --- |
| How is an upper floor drawn? | **Raised**: shifted up the screen by the storey height. Basements shifted down. |
| How many floors? | **Any number**, above and below ground. |
| Who makes them? | The map editor first; **players build floors and stairs later** (stage 4). |
| What do you see from upstairs? | Your own floor, plus the ground outside **where there is a clear view**: a window, or the edge of a balcony or terrace. Being higher also **widens your view**. |
| How do you change floor? | **Both**: a teleport (instant: ladder, trapdoor, lift) and a **walkable staircase**. |

## 2. Words

- **Floor**: one level of a map. Ground is 0; 1, 2… go up; -1, -2… are basements. The number is `z`.
- **Building-map** (or just "the map"): the ground floor together with all its floors. To the owner it is one
  map, with one name, opened and saved as one thing.
- **Storey height**: how many tiles up the screen one floor is drawn. It is the height of a wall, and **every
  wall is 2 tiles high** (`Rules.WALL_H`; owner's decision, 18 Nov 2026). A wall token's height number is
  ignored. Anything lower — a fence, a gate — is an object, not a wall.

## 3. The model: a floor is a map in a family

Every rule in `shared/` already works on "a map": movement, collision, sight, combat, monsters, the structure
layer, claims. Rather than thread a floor number through all of it, **each floor is a map of its own**, and
the floors of one building are tied together as a family.

- A floor's map row carries `floor_of` (the ground map's id) and `z`. The ground map has neither.
- Floor ids are generated: `<ground>_z1`, `<ground>_z2`, `<ground>_zm1` (m = minus). **Never parse the id**:
  the link is `floor_of` + `z`. The id only has to be unique and match `^[a-z0-9_]+$`.
- A floor has the **same width and height** as its ground map and shares its x/y. The editor keeps them in
  step (resize, rename, delete and duplicate act on the whole family).
- Terrain on a floor is **sparse**: a cell with no terrain is open air (above ground) or solid earth (below).
  Nothing can stand there. An upper floor is just the cells that have a floor.
- `Content.linkFloors(c)` (run by `Content.build`, and by the function after it merges map docs) gives every
  map `z`, `floorOf` and `floors` — `{ "0": groundId, "1": id, "-1": id }`, the same object for the whole
  family. `World.floorId(c, mapId, z)` and `World.groundId(c, mapId)` are the only readers.
- A player's `map` is the id of the floor they are on. So is a monster's. Entity keys (`map_5_z1.e3`) stay
  stable ids, as today.

What this buys: live state, transactions, the pushed world view and the structure layer stay **per floor**,
exactly the size they are now. Changing floor is the same event as changing map, which the referee and the
client already handle. What it costs: anything that looks **across** floors (sight, shots, claims, drawing)
has to ask for the other floor explicitly. Those are listed in §6–§8 and are where the later stages go.

Storage: each floor is its own `maps/<id>` Firestore doc with `floor_of` and `z` added, so `publishMap`,
`deleteMap` and the editor's save path are reused. The function must pass the two fields through
(`publishMap`, `mergeMaps`), so **floors need a function redeploy** before they exist on the live game.

## 4. Changing floor

### 4.1 Teleport (stage 1)
The existing `teleport` kind (and a door's `target`) already names a map and a cell. A floor is a map, so a
teleport between floors needs no new rule — only the editor's "pick a destination" has to let you switch
floor. Use it for ladders, trapdoors, lifts.

### 4.2 Walkable staircase (stage 2)
A new object kind `stairs`. It lies on the **lower** of the two floors it joins, occupies a straight run of
tiles (`properties.length`, default 2) and has a direction — the facing from turnable objects (`data.facing`):
the way you walk to go **up**.

- You step onto the bottom tile like any walkable object, and keep walking in the stair's direction.
- Stepping **off the top tile in that direction** puts you on the floor above, on the next tile (the landing).
  Stepping from the landing back toward the run puts you on the top tile of the floor below.
- It is `Rules.tryMove` that answers this: a successful step may carry `map` (the floor arrived on). The
  referee treats it as a change of map; the client predicts it with the same call.
- The run can only be entered at its bottom and left at its top (its other sides are shut, like `pass_*`).
- On the floor above, the cells over the run have no terrain: that is the stairwell opening.
- While on the run a character is drawn rising: tile `i` of `n` is drawn `i/n` of a storey up.
- Monsters walk it by the same rule. Chasing a target on another floor means heading for the nearest stairs
  (stage 2 gives them that much; smarter routing can wait).
- Stairs down into a basement are the same object placed on the basement floor.

## 5. Drawing (raised)

Floor `z` is drawn shifted **up** by `z × 2` tiles (one wall-height per floor) relative to the ground.

Stage 1 (simple):
- On floor 0: as today. Upper floors are not drawn.
- On an upper floor: the floors below are drawn first, each at its own height, dimmed, without creatures;
  then your floor, in full.
- In a basement: only your floor.

Stage 3 (full):
- From outside or below, an upper floor shows as the building's upper **facade** (its walls, windows, and the
  roof over it); its inside stays under the roof, as interiors do today.
- A tall building between the camera and the player is **cut down** to stubs, extending today's `cutH`.
- Clicks resolve on **your** floor, except onto something you can see on another floor (a monster below).
- The stairwell opening shows the run below it.

## 6. Sight between floors (stage 3)

- Your own floor: today's rules, unchanged.
- **Looking down and out**: a ray from you, traced on your floor, that reaches open air (a cell with no
  terrain on your floor) without meeting a sight-blocking wall — so through a window, or over the unwalled
  edge of a balcony — carries on over the floors below. There it is stopped only by things as tall as you are:
  cells that have a floor at your height, i.e. other buildings. Single-storey walls do not stop it.
- You never see **into** a roofed interior from above.
- **Height bonus**: sight radius grows by Config `sight_per_floor` (default 3) per floor above ground.
- **It is mutual**: if A can see B across floors, B can see A.
- The referee decides which creatures on other floors a player perceives and sends them with the view; the
  client also listens to those floors' pushed world.

## 7. Combat, monsters, claims

- Melee and interaction: same floor only, always.
- Shots and thrown items between floors: stage 4, along the same rays as §6.
- Monsters stay on their floor until stage 2 gives them stairs. **Until then an upper floor is a safe spot** —
  a known gap, closed in stage 2.
- A claim covers the **whole column**: the same radius on every floor of the family (stage 4, with building).
- No-build masks and roofs are per floor. The roof of the top floor is the building's roof.

## 8. Building floors (stage 4)

- A **floor** blueprint places a floor tile on the level above; it needs support: a wall or another floor
  tile beneath or beside it (exact rule to be set then).
- A **stairs** blueprint places a staircase and opens the stairwell above it.
- Destroying the support brings down what rested on it (to be designed).

## 9. Stages

| # | What | State |
| --- | --- | --- |
| 1 | Floors in data and rules (`floor_of`, `z`, `linkFloors`), saving/serving them, the editor's floor switch and family operations, teleports between floors, simple raised drawing | **built** |
| 2 | Walkable staircases with the gradual rise, for players and monsters | not started |
| 3 | Full raised drawing (facades, cutaway, clicks), sight between floors, height bonus | not started |
| 4 | Shots between floors; players build floors and stairs; claims by column | not started |

### What stage 1 actually does
- `Content.linkFloors`, `World.groundId / floorId / floorsOf`; map rows carry `floor_of` + `z`; the function's
  `publishMap` / `mergeMaps` and the editor's store pass them through.
- Map editor: the map list shows buildings; a **Floor** row (G, 1, 2…, B1…) switches floor, **+ Above / + Below** add
  an empty one, **Delete floor** removes the open one. Rename, resize, duplicate and delete act on the whole
  building. The open floor is drawn raised, as in the game: the next floor toward the ground shows faintly at its own height (lower under an upper floor, higher above a basement), and switching floor keeps the ground where it was on screen.
- Game: on an upper floor the floors beneath are drawn first — as authored, without creatures or anything
  players built there — each `Rules.WALL_H` tiles lower on the screen, under a dim veil; cells of your floor
  with no terrain are see-through. On the ground and in basements nothing of other floors is drawn.
- Known gaps until later stages: monsters do not change floor; nothing on another floor can be seen live,
  targeted or shot; a claim only covers its own floor; from the ground an upper floor is invisible.

## 10. Rules for the code

- Never read the floor out of a map id. Use `map.z`, `map.floorOf`, `map.floors`, `World.floorId`, `World.groundId`.
  The one exception is the recovery inside `Content.linkFloors`: a map that lost its `floor_of` / `z` (saved through
  a referee older than floors, which drops fields it does not know) is recognised by its `<ground>_z<n>` id and
  taken back into its building. Without it such a floor shows up as a second map with the building's name.
- Anything that decides what is allowed across floors goes in `shared/`, as always.
- New Config keys must be optional: `sight_per_floor` (3). The storey height is not a setting: it is `Rules.WALL_H`.
- A map with no floors must behave exactly as before every stage.
