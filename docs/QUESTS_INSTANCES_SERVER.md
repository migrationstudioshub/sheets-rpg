# NPCs, quests, instances and the game server — plan

Status: **built: server stages 1–3 on the LAN host, and the quest core (Part 1: quests, shared kill credit, per-player loot). Planned: dialogue, phasing, instances, parties, bosses, raids.** Agreed with the owner 22–23 Nov 2026. Modelled on how MMORPGs such as World of
Warcraft handle quests, adapted to this game's shared, buildable world.

Where things stand in the code today (checked when this was written):
- An NPC is an object of kind `npc`. Using it answers "has nothing to say yet" (`shared/world.js`, the `npc` case).
- Players carry `p.flags`; the action language (`give`, `take`, `gold`, `xp`, `flag`, `teleport`, …) and its `if`
  conditions (`flag:x`, `has:item:n`, `level:n`) already exist.
- A monster remembers only `m.engaged` (who it is after). On death, `hitMonster` gives all XP and gold to the last
  hitter; loot goes into one shared carcass, or to the killer when there is no carcass.
- Map-editor containers can be `per_player` (each player's stacks kept in `p.boxes`).
- `host/server.js` (the LAN host) already holds players and the whole world in memory and runs the shared rules, but
  has no loop: the world moves only when a request arrives.

## Decisions (owner)

| Topic | Decision |
| --- | --- |
| NPCs | Objects for the first version. Cannot be hurt, ever ("protected by plot"). The owner writes the narrative. |
| Quest style | Hand-written chains, plus repeatable missions for farming resources. |
| Dialogue | Shallow branching. |
| Kill credit | Everyone who took an active part in the fight (landed at least one blow) and has the quest. |
| XP | Full XP to each participant, not split. |
| Loot | Loot-table rolls and quest items are per player; a carcass's fixed yield (meat, hide) stays shared. |
| Changing the world | Quests never change the shared map permanently. Light phasing for objects; a private copy of a map for anything bigger. |
| Instances | Wanted: boss fights alone or in small groups; raids of 8–10 with a queue. |
| Server | Plan for a server that holds the map in memory and runs a loop. To be adjusted later. |

## Part 1 — Quests

**Built 23 Nov 2026** (rules in `shared/world.js`, the "quests" and "WHO TOOK PART" sections; tests in
`tools/test_world.js`; a sample NPC and two chained quests in `data/tables.json`). How it came out, where it differs
from the plan below:
- **Objectives built:** kill, have (bring), talk, use (consume an item), drink and eat (from any source), goto
  (reach a place), interact (use an object), craft, build, tame — the list is `Content.GOAL_TYPES`. In the Content Studio they are rows of dropdowns
  (kind, target, how many, optional wording). Not yet: harvest, escort, survive-for-a-time.
- **Giver and ender are NPC object ids**, not placements: every one of that object placed on a map offers the quest.
  A quest with no giver is started by the action verb `quest:<id>` (from an object, an item, a trigger); one with no
  ender is finished from the quest log.
- **The page is told, it does not work things out:** every answer carries the player's log (`quests`) and the ids of
  what could be accepted now (`questsOpen`); the markers, the NPC window, the log and the tracker are drawn from those.
- **Per-player loot is not a separate compartment:** a player's own roll lies in the carcass as stacks marked with
  their id, and each player is shown the unmarked (shared) stacks plus their own. With no carcass it goes straight
  into the bag. The shared part still goes to whoever takes it first.
- **Shares for those who did not strike the last blow** wait in the map's record and are given on the map's next
  turn; one nobody came for within a minute is dropped (they left the map).
- **Quests with nobody to hand them to** (no giver, no ender): when the last goal is met the page opens a "Quest
  complete" window with the quest's done text, its rewards and a Claim button. Closed without claiming, it stays
  ready in the quest log. Its `rewards` may start the next (`quest:<id>`), which the page announces in a "New quest"
  window — a story can run with no NPC in it. Config `start_thirst` / `start_hunger` set how a new
  character begins (thirsty, for a first quest that sends them to water).
- **Starting quests:** Config `start_quests` names quests every new character begins with; the page shows them once
  in a welcome window the first time the character enters the game (it comes back after a reload until it is read).
- **Not done here:** the "which authored map is this a copy of" lookup — it belongs with instances (Part 4).
- **To go live:** quests are rules in `shared/`, so the Cloud Function must be redeployed; until then the live game
  and a host playing live content (it gets its content already built by the function) have no quests. A host started
  with `CONTENT=local` plays the sample quests today.

### Data
- **Quests** card in the Content Studio (a `shared/schema.js` entry): id, name, text, `giver` and `ender` (NPC object
  ids; may differ), `requires` (an `if` condition list), objectives, `rewards` (an action list, e.g.
  `xp:100; gold:20; give:axe:1`), optional choose-one reward items, `next` (chain), `repeat` (never, or again after N
  hours).
- **Objectives** are counters fed by game events: kill N of a monster, have N of an item, talk to an NPC, use an
  object, reach a place (a trigger). Later, the survival ones: craft, build, tame, harvest.
- **Collect objectives count the bag live** and take the items at hand-in.
- **Quest drops:** a loot-table row gets an optional `quest` column; the row rolls only for players who have that
  quest active and still need the item.

### Player state
`p.quests`, next to `p.flags`: active quests with their counters, and finished ones (with the time, for repeatables).
A quest is unavailable, available, in progress, ready to hand in, or done.

### Rules (all in `shared/`)
- New conditions `quest:x` (done) and `quest_active:x`, usable anywhere `if` is: doors, levers, triggers, teleports.
- New action `{type: 'quest', op: 'accept' | 'turnin' | 'abandon', id, npc, choice}`; the referee checks the player is
  next to the NPC and that the state allows it.
- One shared question for "what does this NPC offer this player" and "what state is this quest in", so the page and
  the referee agree.
- **Markers** (`!` available, grey `?` in progress, `?` ready) are worked out on the page from the player's own quest
  log and the content. Nothing is added to the referee's per-step work.

### The hit list (kill credit, XP, loot)
A monster keeps a short list of who has hit it: cleared when it dies or resets, a player dropping off after about 30
seconds without landing a blow, capped in size. On death, everyone on the list:
- gets the kill counted for their quests,
- gets full XP and gold,
- gets their own loot-table roll.

The carcass gets a compartment per player for those rolls (you see only your share; a bystander sees nothing), next
to its shared fixed yield. It rots as now.

### Client
A quest log panel, an on-screen tracker, markers over NPCs, the dialogue window.

## Part 2 — Dialogue (shallow branching)

**Dialogues** card: each entry is one thing the NPC says, plus up to about four replies. A reply may carry an `if`
condition (shown only when met), an action list (the existing language, plus start-quest and hand-in-quest), and where
it leads: another entry, or the end. An NPC names its opening entry; the first whose condition matches wins, so an NPC
can greet differently by quest state.

Accepting and handing in are replies, so quests and conversation are one system. "Shallow" is a writing guideline;
the engine is the same at any depth. Shops (buy and sell) come as another reply type.

## Part 3 — Phasing

**Light phasing — to build.** A placed object gets a show-if / hide-if condition. One shared question, "does this object
exist for this player", asked by the page when drawing and by the referee on walking and interacting.
- Covers objects placed in the map editor only: not walls, not player-built structures, not monsters.
- Monsters treat a phased object as always there.

**True phasing — not built on shared maps.** Different monsters, terrain or buildings per player on one map would
mean friends on the same spot not seeing each other, bases belonging to a phase, and walkers unable to hunt across
phases. Anything that big uses an instance (below) or a second map reached by a quest-gated teleport.

## Part 4 — Instances

An instance is a **private copy of a map**: its own monsters, chests and doors, for one player or one group.

- **Entering:** a teleport with an `instance` setting (solo, group, raid) creates a fresh copy, or joins the group's.
- **Running:** one more live map record. Costs nothing while empty.
- **Ending:** deleted some minutes after it empties; a disconnected player rejoins the same copy while it exists.
- **Inside:** no building, no claims; death returns the player to the entrance.
- **Quests:** unchanged. "Defeat the boss" is a kill objective; a quest condition can gate the door.

| Size | Needs on top |
| --- | --- |
| Solo | Only the instance mechanism. |
| Small group | A **party system** (invite by name, as claim members are added today). Does not exist yet. |
| Raid (8–10) | Party at raid size; a queue with a ready check. |

**Do early:** today the code assumes a map's id is also its content id. A copy has its own id and the original's
layout. Add the one lookup ("which authored map is this a copy of") during the quest work, as floors did with
`World.groundId`; never parse it out of the id.

**Bosses** need a new `boss` brain: telegraphed area attacks, stages by health, summoned helpers. The largest single
piece of work in this plan.

**Raids** start with a leader forming the group by hand and bosses that scale to the number present (say 3 to 10);
automatic queueing waits for a population that can fill it.

## Part 5 — The game server

### Why
The Cloud Function wakes per action, reads the map's record, changes it and writes it back in a transaction. Two
actions on one map at the same moment take turns and the loser retries; ten players on one boss would mostly collide.
There is also no real tick: idle monsters depend on a player's heartbeat. Large MMOs avoid both by keeping each zone
in the memory of a long-running process with a loop, and using the database only for saving.

### Shape
`host/server.js` grows into the game server; one codebase runs on a friend's computer (LAN) or in the cloud.

| | LAN host today | Game server |
| --- | --- | --- |
| World | In memory | Same |
| When the world moves | When a request arrives (the page polls every 250 ms) | A loop, about 10 times a second |
| Connection | One request per action | A WebSocket: actions up, changes down each tick |
| Saving | One local file | The Realtime Database, in the function's record formats |
| Maps | All loaded | Loaded when someone enters, saved and dropped when empty |

Each tick: apply the actions that arrived, in order; advance every map that has players; send each player what
changed near them. Empty maps are not ticked and catch up on arrival, as now. One process applying everything in
order means no transactions and no collisions.

### What stays
- `shared/world.js` and the rest of `shared/`: untouched; quests, dialogue and instances work on every backend.
- The Cloud Function: still serves content and takes Content Studio / map editor publishes, and remains a working
  referee to fall back to. Never let both referee the same map at once.
- Save formats: the same, so no migration and switching back is a config change.
- The page: a fourth backend in `client/js/api.js`, answering in the same `{player, world, events, seq}` shape first.
- The Firebase live-world push is not needed once the socket carries the world.

### Saving
Players on logout, at key moments and every 30–60 s; a map every 30–60 s when changed and when unloaded; everything
flushed on shutdown. A crash loses up to about a minute.

### Risks
- One process is a single point of failure: it must restart itself and reload; the page needs reconnect logic.
- Deploys disconnect players for a few seconds.
- Rules that assume a step is rare (for example the walker's planning budget per map per turn) need a pass through
  `World.advance` before going live. Not audited yet.
- It has to be hosted and kept running, beyond `firebase deploy`.

### Where it runs first (owner, 23 Nov 2026)
**On the owner's own computer, for friends, for a long time — no paid server yet.** It is the same program a rented
machine would run, reached over Tailscale as the LAN host is today. Because the host serves the page itself, no domain
name or secure-address setup is needed. So the save layer must be swappable: the local save file now, the database
when it moves. What a home computer does not show: staying up when the computer is off, and a home connection's
upload limit with many players. A switch that adds artificial delay covers testing with lag.

### Stages
1. **Built (23 Nov 2026).** Loop and socket on the LAN host; the page's `Lan` backend uses the socket. Deviations:
   actions are applied the moment they arrive, not held for the turn (one thread, so order is kept and nothing
   collides; it saves up to a turn of delay); the socket is hand-written (no dependency, no compression); pushes
   already leave out the parts of the view that did not change; the lag switch is `LAG_MS`. Saving is still the one
   local file, written at most once a second. Tests: `tools/test_host.js`.
2. **Built (23 Nov 2026).** Saving behind one small interface (`host/store.js`: `load()`, `put(kind, id, json)`):
   a folder with one file per character, one per map and one for the world — the Cloud Function's records. Every
   `SAVE_MS` (3 s) the host writes only the records whose text changed, and everything on Ctrl+C; a killed host
   loses at most that. The older single-file save is imported once. **Deviation: maps are not loaded and unloaded.**
   Every map's state stays in memory (it is small, and an empty map is neither advanced nor written), which keeps
   the rules free of "is this map loaded yet". All characters are read at start-up; a database store will want to
   read a character when it logs in instead. The database version of the interface comes with stage 4.
3. **Built (23 Nov 2026).** The socket's messages live in `client/js/wire.js`, both ends (`Wire.pack` on the host,
   `Wire.unpack` on the page): every message — answers too, not only pushes — carries what changed since the last
   one on that socket. Monsters and players go one by one (what stays, once; where they are, when it changes; who
   is gone), the other floors of a building the same way, and a player's own record field by field. **Interest:**
   monsters and players further than Config `interest_radius` (20 tiles) are left out. `tools/bots.js` is the load
   test. Measured on this computer, live content, everyone on one map:

   | Bots | Sent to each, per second | Host upload | Answers (95%) | A turn of the loop |
   | --- | --- | --- | --- | --- |
   | 30, before | 116 kB | 28 Mbit/s | 5 ms | 4 ms |
   | 30 | 6 kB | 1.5 Mbit/s | 8 ms | 6 ms |
   | 60 | 10 kB | 5 Mbit/s | 21 ms | 18 ms |
   | 100 | 14 kB | 12 Mbit/s | 48 ms | 42 ms |

   The turn grows with the square of the crowd (each player's view is built and compared every turn); at 100 it
   uses under half of the 100 ms it has. Past that, the next step is to build what a map's players share once per
   turn instead of once per player. Not sliced by area: `states` (doors, levers) and the structure layer still
   cover the whole map, sent only when they change.
4. **Deferred until a server is rented:** database saves, a secure address, a deploy script, the switch in `config.js`.

## Order

1. Server stages 1–3
2. Quest core: log, objectives, NPC accept and hand-in, markers, the hit list with shared credit and per-player loot
3. Dialogue, light phasing, repeatables
4. Solo instances
5. Party system, then group instances
6. Boss brain
7. Raids: hand-formed groups first, the queue later

Server stage 4 (renting a machine) is outside this order; it happens when the owner decides to.

## Open

- **Server first or quests first** (order above is Claude's suggestion; quests do not depend on the server, everything
  after them does).
- **Hosting (deferred, see "Where it runs first"):** when the time comes, a small virtual machine in the same Google
  project (cheapest; needs a domain name for the secure connection) or Cloud Run (simpler, dearer when always on).
- **Boss lockout:** fight again at once, or once per day / week per character.
