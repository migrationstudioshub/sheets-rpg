# Floors: multi-storey buildings and basements

Status: **all four stages built** (18 Nov 2026; not yet run on the real server). See §9 for what each does and its limits. Decisions in §1 were made by the owner on 18 Nov 2026.

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
tiles — always 2 (`Rules.STAIR_LEN`; like a wall's height it is fixed, an older `properties.length` is ignored),
so each tile of the run climbs one tile. Its picture is ONE step tile, drawn once per tile of the run, each one
tile higher on the screen than the one before (`Render.drawStairStep`) — and has a direction — the facing from turnable objects (`data.facing`):
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
  A window works as on one floor: only for someone standing right at it, and only a narrow cone straight out
  (`seesAcross` passes the upstairs viewer as `from`). The client lights the ground cells in view
  (`floorSight` in `main.js` → `opts.floorSight`); the rest of the floors below stays dim.
- You never see **into** a roofed interior from above.
- **Height bonus**: sight radius grows by Config `sight_per_floor` (default 3) per floor above ground.
- **It is mutual**: if A can see B across floors, B can see A.
- The referee decides which creatures on other floors a player perceives and sends them with the view; the
  client also listens to those floors' pushed world.

## 7. Combat, monsters, claims

- Melee and interaction: same floor only, always.
- Shots between floors follow the same rays as §6 (stage 4). A thrown item goes DOWN the same way (`World.throwAcross`, `throw` takes `map`): onto a cell of a lower floor you can see, within its throw range, never up; it lands where aimed and its blast runs on that floor. Skills do not cross floors.
- Monsters follow a player by the stairs (stage 2): see "What stage 2 actually does". A teleport between floors
  (a ladder) is still a way to shake them off.
- A claim covers the **whole column**: the same radius on every floor of the family (stage 4).
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
| 2 | Walkable staircases with the gradual rise, for players and monsters | **built** |
| 3 | Full raised drawing (facades, cutaway), sight between floors, height bonus | **built** (clicks onto other floors moved to stage 4) |
| 4 | Shots between floors and clicking what you see on them; players build floors and stairs; claims by column | **built** |

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

### What stage 2 actually does
- Kind `stairs` (always walkable). `Rules.stairDir / stairsOn / stairAt / stairHeight`; `Rules.tryMove` answers a
  step that changes floor with `map` (the floor arrived on) and `stairs: 'up' | 'down'`. `opts.mapOf(id)` hands it
  the other floor (the referee: its live map; the client: the map as authored).
- The referee's move handler treats that as a change of map and stops the batch there. The game page does not
  predict it: it sends the step and waits for the answer (a short pause at the head of the stairs).
- Drawing: stairs lie flat under everyone; whoever is on the run is drawn part-way up (`stairHeight`). Art is
  authored climbing north (`side=` east/west mirrored, `south=`); with none it is drawn as plain steps.
- Editor: T / Shift+wheel turns the stairs, an arrow shows the climb and a dashed box the landing; the inspector has
  "climbs toward" and **Open the stairwell above**, which clears the floor above the run.
- Monsters: `tagFollowers` marks those after a player who takes the stairs (`m.follow`); `followStairs` walks them
  there; `leaveFloor` turns the step that changes floor into a **guest** in `ws.transfers`. `World.deliver` (offline)
  or the referee's `deliver` puts it in the other floor's `arrivals`, taken in on that floor's next advance. The
  floor left treats it as lost (its spawner replaces it). `player.wake` makes the leaving player's steps keep that
  floor moving for 20 s, since nobody else may be there. A guest that dies or idles 90 s is removed.
- Known limits: a follower walks straight at the stairs and can be stopped by a wall in between; only monsters
  that were after you when you took the stairs follow; arriving does not check for something a player built on the
  landing, nor for someone standing on it; there is no glide between the two floors.

### What stage 3 actually does
- `World.seesAcross(c, upper, ux, uy, lower, lx, ly, radius, stateFn)` is the one rule for sight between floors,
  asked upper-to-lower; the same answer serves both ways. `World.sightRadius(c, map)` = Config `sight_radius` +
  `sight_per_floor` (3) per floor above ground.
- What stands on the other floors reaches the client two ways: `view.floors` (`World.peek`) when the world holds
  those floors — offline play, the LAN host — and, online, by listening to each sibling floor's pushed
  `world/<floorId>` (one more listener per floor of the building you are in).
- **The whole building stays alive while someone is in it.** Offline and on the LAN host every step also runs
  `World.advanceFloors` (the other floors of the player's building; `peek` carries their players too, from the
  `everyone` argument of `World.view`). Online each floor is its own record, so `tickFloors` in `functions/referee.js`
  moves the floors with nobody on them, alongside the player's own step: at most once per Config `floor_tick_ms`
  (1000), and a floor with no monsters is left alone for 30 s. A floor with a player on it is moved by that player.
- **Doors and windows of other floors are drawn as on their own floor.** Each floor reports the states of its doors
  and wall fixtures that differ from the usual (`World.fixtureStates`): in `peek().states` offline / on the LAN, and
  as the JSON string `doors` in the pushed `world/<floorId>` online. The client hands them to the renderer
  (`opts.floorStates`); `otherFloorFixtures` + `drawOtherPrim` in render.js draw an open door as a hole, a window as
  see-through panes, and openings in N-S walls as a gap / slab / glass.
- **What players built on another floor is shown too** (its `struct` layer). Offline / LAN: `peek()` carries
  `structRev` and, when the client is behind (`floorRevs` in the request → `World.view`), `struct`. Online:
  `pushStruct` in `functions/referee.js` writes `world/s~<groundId>/<floorId>` = `{rev, json}` only when the revision
  changes, and the client listens once per building (`api.watchStructs`). The client keeps `floorStructs` and
  `floorMap(id)` (main.js) gives a floor's LIVE map: the renderer bakes other floors from it (`setMap(map, floorMaps)`),
  and sight, cover, shots and throws between floors read it. Lower floors are blurred a little (Config `floor_blur`,
  pixels, default 0.6, 0 = off) and their creatures are drawn within their own floor, under everything above.
- The client (`floorActors` in main.js) eases what it shows from tile to tile (`tx,ty` = the real tile) and keeps the creatures it has a clear view of and hands them to the renderer.
- Drawing: creatures seen on floors below are drawn bright over the dimmed lower floors. From the ground or a
  lower floor, the floors above are drawn as the upper part of the building (`Renderer.above`): roof colour over
  cells marked roofed up there, the floor itself where they are not (a terrace), and the walls — each a
  wall-height higher. Standing indoors or under an upper floor they are not drawn; outside, the part near the
  player goes faint. Whoever stands up there in plain view is drawn at that height.
- Known limits: the lower floors are shown whole (dimmed), not limited to what you can see; other floors are
  drawn as authored (not what players built or broke there, nor doors' states); upper floors need their own
  roof painted to hide their inside; offline and on a LAN only monsters (not other players) on other floors
  are shown; a floor nobody is on does not move, so what you see there is where things last stood; the
  facade is not sorted against ground-floor walls (it is simply drawn over them).
- Not done here: clicking or shooting at something on another floor — it needs the rules for shots between
  floors, so it moved to stage 4. Terrain elevation (docs/UNDERGROUND_AND_ELEVATION.md) will reuse this sight rule.

### What stage 4 actually does
- **Word between floors.** Each floor is its own record, so one floor tells another by a NOTICE in `ws.transfers`:
  `{map, monster}`, `{map, shadow}`, `{map, tiles}`. `World.applyNotice(c, mapId, ms, notice)` applies one;
  `World.deliver` uses it offline and on the LAN host, the referee's `deliver` inside a transaction on the other
  floor's record. Anything new that must cross floors should travel this way.
- **Claims by column.** A claim is copied to the other floors of its building as a *shadow* (`struct.shadow`),
  kept in step when it is built, taken apart, destroyed or its members change. `World.claimsOn` returns shadows
  too, so `claimAt / mayUse / foreignClaim / protectedOn` cover every floor without knowing about floors.
- **Laying floor.** A blueprint with `places: tile` and a `terrain` lays one piece of floor where there is none,
  joined (side to side) onto floor already there. Stored in `struct.floor`; `liveMapFromStruct` puts it in the
  live map's terrain. `{type:'dismantle', target:{t:'tile', x, y}}` takes it up (half the cost back).
- **Building stairs.** A blueprint whose object is of kind `stairs`: `build` takes `facing` (the way they climb);
  the run must be clear floor and a floor above must exist. Building them sends a `tiles` notice upstairs: the
  cells over the run become a stairwell (`struct.hole` where the map had floor) and the landing gets floor if it
  has none.
- **Shots between floors.** `{type:'shoot', map: <floorId>, x, y}`; `World.shotAcross` is the check (a ranged
  weapon, in range, and `seesAcross`). The referee runs such a shot on the TARGET floor's record (`runOnMap(…,
  'remote')`) so the hit, the kill and its rewards happen where the creature is. In the game a creature on
  another floor is clicked where it is drawn (`floorTargetAt`); the cursor names it.
- Known limits: players can only build up or down where the owner has added a floor to the map (even an empty
  one) — floors are not created at play time; laid floor needs no support beneath it, cannot be damaged and has
  no frame; taking stairs apart leaves the stairwell open; a lost claim frees the structures on its own floor
  only; a shot between floors hits one creature, pierces nothing, damages nothing built, and on the live
  referee does not see walls players built on the shooter's own floor; throwables go down only, skills do not cross
  floors; what players built on other floors is still not drawn from here.

### What stage 5 actually does: roofs (Nov 2026)

A roof over a storey and the floor of the storey above are ONE thing, kept in two records.

- **Storeys everywhere.** `Content.autoFloors(c)` gives every ground map the empty floors above it that it lacks
  (Config `auto_floors`, default 2; 0 = none; none when `build` is off). They are ordinary floors with id
  `<ground>_z<n>`, marked `auto`, and exist only in the BUILT content: the referee (`functions/index.js`), the game
  page (`main.js`) and the LAN host call it; the editors do not, so the map editor never sees them. The renderer
  does not bake one until something stands on it.
- **One blueprint, two uses.** There is no separate roof entry: a FLOOR blueprint (`places: tile`) is put up as a roof
  with `{type:'build', …, roof: true}` (`World.asRoof(bp)` is the same blueprint with `places: 'roof'`; the build
  menu shows Floor and Roof for it, V switches while placing). `places: roof` in data still works but is not offered.
- **The roof.** As a roof (`places: roof` + `terrain`) it is placed from below, on a cell of the storey you stand on.
  `build` writes `struct.roof["x,y"] = {t, by, bp}` on THIS storey and sends a `tiles` notice up, where the same
  piece becomes laid floor (`struct.floor`, carrying `s` = its step count). `liveMapFromStruct` folds
  `struct.roof` into the live map's `roof` grid, so a built roof is "indoors" exactly like one painted in the
  editor (rooms, hiding, `markExplored`).
- **Support.** `World.roofSupport(c, liveMap)` counts, for every built roof cell, how many tiles it is from a wall
  (1 = a wall on one of its four sides, or an object with `properties.support` — a pillar — standing in it),
  through roof cells side to side. `roofSteps` answers for a new cell; `riskOf` turns it into
  `safe | edge | fall` against Config `roof_support` (3; 0 = no rule). `canBuild` returns `risk` and the ghost
  is drawn green / yellow / red from it. Joining onto the map's own cover counts as one step further than a wall.
- **From above.** A floor tile laid upstairs (`places: tile`, z > 0) obeys the same limit, counted the careful way
  from the floor it joins (each laid piece remembers `s`; the walls below are another record), and sends a
  `roofs` notice down so the storey below is covered. Taking floor up upstairs un-covers it (`roofs … gone`).
- **Taking down from below.** `{type:'dismantle', target:{t:'roof', x, y}}` (`liftRoof`, checked by `canRemove`):
  the piece goes, the floor upstairs with it (a `tiles … hole` notice), half the cost comes back.
- **Cover.** `World.covered(c, liveMap, x, y)` — a built roof, a painted roof, or the authored floor above — is the
  one question for anything that comes from above (rain, fliers: not built yet).
- **Stairs** open the roof over their run; a roof cannot be put over a staircase.
- Known limits: nothing collapses yet — taking away the wall under a roof leaves it hanging (new pieces next to it
  then show red); a roof taken down from below does not check what stands on it upstairs; the landing a staircase
  makes upstairs is not counted as cover below; roofs have no health; on the live referee a floor record only
  learns of the other one through notices, so the two are in step a moment later, not in the same instant.

## 10. Rules for the code

- Never read the floor out of a map id. Use `map.z`, `map.floorOf`, `map.floors`, `World.floorId`, `World.groundId`.
  The one exception is the recovery inside `Content.linkFloors`: a map that lost its `floor_of` / `z` (saved through
  a referee older than floors, which drops fields it does not know) is recognised by its `<ground>_z<n>` id and
  taken back into its building. Without it such a floor shows up as a second map with the building's name.
- Anything that decides what is allowed across floors goes in `shared/`, as always.
- New Config keys must be optional: `sight_per_floor` (3). The storey height is not a setting: it is `Rules.WALL_H`.
- A map with no floors must behave exactly as before every stage.
