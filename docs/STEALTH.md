# Stealth: sneaking, noise and what monsters notice

**Status (25 Nov 2026): the owner agreed the plan and its four choices. Stage 1 is built** (one change from the
plan: the sneak key is **Z**, not Ctrl — Ctrl+click already means something in the inventory). **Stage 3 is built
too** (facing and sneak attacks). **Stages 2 and 4 are built (27 Nov 2026)**: loud events, walls that muffle, walkers
that break through for a loud noise, and the player's own hearing — see each stage below.

## Why

The owner likes how Project Zomboid decides what is visible, and wants a hearing sense later (the `sensed`
hook). Monsters today notice players by four different rules, most of them plain distance. Stealth is one
rule for all of them, with two senses: sight and hearing.

## What exists today (`shared/world.js`)

| Brain | How it notices a player |
| --- | --- |
| plain (inside `advance`) | nearest player within `aggro_range`, through walls |
| `walker` (`walkerStep`) | must SEE: `sight_range` + line of sight (`canSee`). Once hunting, a target out of sight but within `aggro_range` is still "heard" through walls, always |
| `hunter` (`hunterStep`) | distance only, `aggro_range` (2 when fed) |
| `animal` (`animalStep`) | distance only, `flee_range` |

Already there to build on:

- The walker's states: hunt (`ai.s`, the `!` mark), search (last-known `ai.x, ai.y`, poking around `ai.w`, the `?` mark), `alertOf`.
- `m.facing` on every monster.
- `World.perceive` answers `seen | sensed | hidden`; `Render.drawSensed` draws the outline; nothing fills `sensed`.
- The noise meter on the page, hidden behind `UI.FLAGS.noise`, waiting for `me.noise` (0-1).

## The design: one question

**`World.notices(c, map, m, def, p, ctx)` → `'seen' | 'heard' | ''`** is the only place that decides whether a
monster is aware of a player. Every brain asks it; no brain measures distance to a player by itself any more.

- **Seen** = within the monster's sight range × the player's visibility, with line of sight (`canSee`, the same
  edge question as everything else). Sight range = Monsters `sight_range`, else `aggro_range` (as the walker does now).
- **Heard** = the monster is within the radius of a sound: the player's own noise, or a sound left at a place
  (stage 2). Sound ignores walls in stage 1 (see open questions).
- A monster with no senses listed behaves as now, except that it needs line of sight.

What the answer does:

| Answer | walker | hunter / plain | animal |
| --- | --- | --- | --- |
| seen | hunt, as now | attack, as now | flee, as now |
| heard | go and look where the sound was (the search state; breaks nothing on the way) | turn and walk towards it | lift its head: flee only if the sound is inside half its `flee_range` |
| nothing | roam | roam | roam |

Sight commits a monster, noise only attracts it. A monster that was struck (`m.engaged`) knows who did it, as now.

### The player's side

- **Sneaking**: `p.sneak` (true/false), set by `{type: 'sneak', on}`. A toggle key (Z), walking
  at half speed through `Rules.stepCost` (the same place wading slows you, so the referee's budget, the page's
  pace and the glide all agree).
- **Noise** (`World.noiseOf(c, p, now)` → a radius in tiles; `publicPlayer.noise` = it as 0-1 of the loudest):
  standing still 0; sneaking Config `noise_sneak` (2); walking `noise_walk` (6). It falls back to 0 a moment
  after the last step (`p.mvT` already says when that was).
- **Visibility** (a multiplier on the monster's sight range): 1 walking or standing, Config `sneak_sight` (0.6)
  sneaking. Darkness, tall grass and cover plug in here later; none exist yet.

### Config (all new, all with defaults, so content without them plays as described)

`stealth` on|off (off = today's rules exactly), `noise_walk` 6, `noise_sneak` 2, `sneak_sight` 0.6,
`sneak_slow` 2, and from later stages `noise_shot` 14, `noise_break` 10, `noise_door` 5, `sound_s` 2,
`sight_cone` 60, `cone_reach` 1.5, `back_sight` 0, `ambush_mult` 2; and for the look, `sneak_alpha` 0.55, `stealth_areas` on.

Monsters (new optional columns): `hearing` (a multiplier on every noise radius for this monster: 0 = deaf,
1 = normal, 2 = keen; empty = 1). `sight_range` already exists.

## Stages

### 1. Sneak and noise — BUILT (25 Nov 2026)
`World.notices`, `noiseOf`, the `sneak` action, `stepCost` slower when sneaking, all four brains moved onto
the one question, `publicPlayer.noise` and `sneak`, the noise meter switched on (`UI.FLAGS.noise`), a sneak
key and a visible sneaking state on the figure. The walker's fixed "within aggro_range it still hears them"
line becomes the noise check.

As built: the page works out its own meter from its own steps (`noiseMeter` in `main.js`, asking
`World.noiseRadius`), so it is live without waiting for the referee; other players are sent `sn` (view, the
Cloud Function's push, `wire.js`) and drawn crouched (`paintActor` squashes the figure onto its feet). Tests:
the "stealth:" ones in `tools/test_world.js`.
**The look of sneaking (owner, 25 Nov 2026), replacing the first crouched figure:** a sneaking figure (yours and
other players') becomes a shadow — dark, washed of colour, see-through (`paintActor`, Config `sneak_alpha` 0.55);
the edges of the screen darken softly (`#sneak-veil` in `ui.css`, toggled by `sneakVeil` in `main.js`); and every
step you take sends out a **sound ring** that grows to how far your noise carries (`soundRing` in `main.js`, an
fx of kind `sound` in `Render.drawFx`; square with round corners, because hearing counts diagonal tiles too;
Config `stealth_rings` = off hides them); and every monster you can see shows **where it would spot you** on the ground — amber, red when it is after someone
(`World.sightArea`, the same reach and line of sight as `notices`, a test keeps them equal; `sightAreas` in
`main.js`, Render layer 2f; Config `stealth_areas` = off hides them). Since stage 3 they are cones, turning with
the monster.

**When sneaking ends (owner, 25 Nov 2026):** a monster that SEES a sneaking player (or is struck by one and
lives) makes them stand up — `spotted()`, the one way, with a message "The X spotted you!". While any monster on
their map is after them (`chasedBy`: `m.engaged`, `m.chase` = a plain or hunter brain that saw them, a walker's
`ai.spot`) they cannot sneak again (`p.chased`, sent as `chased`; the sneak action refuses); when the last one
gives up, one who had been spotted is told "Nothing is after you any more". Hearing does not count. Animals that
see you flee and break your sneaking, but never chase. Opening the build bar, the remove or move tool, or
picking a blueprint stands you up (`standUp` in `main.js`; the referee also stands you up on any build action),
and so does talking to an NPC (the referee, where the `npc` event is made). Z is refused while the build tools
are out or a quest window shows. The noise meter shows only while sneaking.

**Sight is the same both ways (25 Nov 2026).** The owner saw monsters notice them past things that hid the
monster. Cause: `clearLine` drew its stepped line from the viewer, and the line from A to B is not always the one
from B to A, so round a corner one could see the other unseen (about 1 pair in 100 on map_9). The line is now
always drawn from the lesser end (a test checks every pair on map_3). Also, the plain and hunter brains now show
the same marks as the walker (`alertOf` reads `m.chase` / `m.listen`): ! after someone they saw, ? when they go to
a sound — a monster coming because it HEARD you is no longer mistaken for one that sees through walls.

**Perception (owner, 25 Nov 2026)** — `senseStep`, run by `advance` every time the world moves on, not only on
a monster's own turn:
- **Seen → at once.** A walker hunts, a plain or hunter brain chases (`m.chase`, the !), an animal runs
  (`m.fleeFrom`); a sneaking player is spotted; and if it was after nobody, its next turn is due now.
- **Heard, unseen, after nobody → `m.hear`.** The ? shows at once; surprised, it freezes where it stands,
  facing as it was (owner: no instant turn). Config `hear_delay_s` (2) later it turns to the sound (which may then
  let it see you: at once) and goes to look where the sound WAS — a
  walker searches (`ai.w`, breaks nothing), a plain or hunter brain walks there (`m.goTo`, gives up after
  15 s) — or an animal runs from that spot (`m.fleeFrom`, 4 s). A new sound while on its way only moves the spot.
  A monster already after someone keeps tracking them by sound as before. Walkers beyond Config
  `walker_wake_radius` sense nothing (they are inert). Holding an animal's feed calms it.
Cost: one pass over the map's monsters per update, a sight line only for those in range — the same work the
brains did on their turns.

Found while building: a sound behind a SHUT door a walker cannot open leaves it with no way there on foot, so
it pokes about on its own side and gives up. Whether a heard sound should make it bang on the door is a choice
for stage 2 (it is how Project Zomboid's zombies behave).

Done looks like: sneak past a walker's back room without it stirring; walk past and it comes to look; a deer
can be approached sneaking to bow range but not walking.

### 2. Loud events — BUILT (27 Nov 2026)
As built (the owner's choices: shots, blows on walls and objects, doors and melee fights all make noise, as thrown
things already did; walls muffle; a walker breaks through a shut door for LOUD noises only):
- **No list of sounds is kept.** A noise acts the moment it is made: **`World.soundAt(c, ws, mapId, x, y, radius, now,
  by, skip)`** is the one way to make one. Every monster it reaches that is after nobody hears it exactly as it hears
  footsteps (`m.hear`: the ?, the wait, then it goes to look where the noise WAS; an animal runs from there). `skip` =
  the monster that made it.
- **Who makes one:** a shot, from where it was fired (`shoot`: Items `noise`, else Config `noise_shot` 14); a blow on a
  wall or object, from the thing struck (inside `damageStructure`, so players, bullets, blasts and monsters alike:
  Config `noise_break` 10; not fire); a door opened or shut (`useDoor`, `noise_door` 5); a blow landed on a monster
  (`attack`: Items `noise`, else `noise_melee` 5); a thrown thing landing (`throw_noise`, as before). Items `noise`:
  0 = the usual, below 0 = silent (a bow can be 4).
- **Walls muffle** — `World.soundCarries(c, map, sx, sy, lx, ly, radius, stateFn)` is the ONE "does this sound reach
  there" question (footsteps in `notices`, `soundAt`, and the player's hearing on the page): within the radius LESS
  Config `sound_muffle` (2) tiles for every wall, shut door or solid cell on the straight line between
  (`wallsBetween`; 0 = walls muffle nothing, the old rule). Next to each other is always heard.
- **Loud = Config `noise_loud` (9) tiles or more** (a shot, something being broken): `m.hear.loud` → the walker's
  search carries `ai.bang`, and it BREAKS what is in its way to the spot (`walkerMove`: `ai.w && !ai.bang` is what
  forbids breaking). Once there it only pokes about. A quiet noise (footsteps, a door, a fight, a thrown rock) still
  breaks nothing. A walker breaking a wall is itself loud: others that hear it come, and break in too.
- `tools/test_world.js`: the older tests keep `sound_muffle` 0; the "stealth: sound" tests turn it on.
Not built: a ring on the page showing how far each noise carried (only footsteps and throws draw one); quieter doors
while sneaking; monsters hearing each other's footsteps.

The first plan, for the record: `ms.sounds = [{x, y, r, until}]` on the map record: a shot (`shoot`), a blow on a structure
(`damageStructure`), a door. `World.makeSound(ws, mapId, x, y, r, now)` is the one way to add one. `notices`
reads them as well as the players' own noise; a monster that hears one searches at that spot. A thrown item
makes a sound where it lands (the distraction). This is the "hearing (shots)" listed as not built.

### 3. Backs and ambushes — BUILT (25 Nov 2026)
As built: a monster sees its full range only inside a cone in front of it, Config `sight_cone` degrees wide
(centred on `m.facing`; 360 = all round). **Long rather than wide (owner):** 60 degrees, reaching Config `cone_reach`
(1.5) times the monster's range, measured as straight-line distance so the tip is round (a walker: 12 tiles ahead,
7 sneaking); a monster that sees all round keeps its brain's own measure and range. Everywhere else Config `back_sight` times as far — **0 by default,
not the 0.5 first proposed**: with half range behind, a monster saw anyone right behind it (a walker's 8 tiles,
sneaking, is still 2.4 behind it), so nobody could ever be struck unseen up close. 0.5 gives the first proposal.
`World.looksAt` is the one place (notices and sightArea both ask it), `inCone` the geometry. A roaming monster
that cannot step the way it picked still turns to look that way (`roamStep`), so the idle ones look about.
A sneak attack: a blow, shot, blast or skill on a monster that does not SEE its attacker, is fighting nobody
(`m.engaged`) and has nobody in sight (a walker's `ai.s`) does × Config `ambush_mult` (2) — `unaware` in
`hitMonster`; the message ends "A sneak attack!". Having HEARD the attacker does not spoil it (it knows
something is there, not where). Once struck it is engaged, so only the first blow counts. No separate event.
Tests set `sight_cone` 360 and `ambush_mult` 1 for the old fights (top of `tools/test_world.js`); the
"stealth:" tests turn them back on.

### 4. The player's own hearing — BUILT (27 Nov 2026)
As built (the owner's choice: creatures that are MOVING, each heard from as far as its kind is loud): **page only** —
the page already knows where the map's creatures are, so nothing new is sent. `hearing(now)` in `main.js` fills the
renderer's `sensed` set: a creature out of your sight whose tile changed within the last `HEAR_MS` (1.2 s) is heard
from Monsters `noise` tiles (empty = Config `monster_noise`, 5; 0 = never heard), less what the walls muffle
(`World.soundCarries`). It is drawn as the dashed outline (`Render.drawSensed`) where it is — not what it is, not its
health — and goes when it stops. Config `hearing_sense` = off: none of it. `SheetsRPG.heard()` is the test hook.
Not built: hearing other players, a sound for it, your own hearing being better while you stand still or sneak.

The first plan, for the record: the page fills `sensed` (already passed to `renderer.draw` as `null`): monsters out of sight that moved
within the player's hearing radius this turn, sent by the referee as positions only (no kind, no health).
Needs a per-monster "made noise" mark and care with the push format (`client/js/wire.js`, `functions/referee.js`).

## Raised ground blocks sight (26 Nov 2026)

The owner noticed elevation hid nothing. Now `clearLine` (every sight line: players' fog, monsters' notices, shots, aiming) also asks `hillBetween`: the eye of each end is Config `eye_height` (0.75 height steps) above its own ground; a cell in between whose ground (`Rules.groundHeight` at its middle) is above the straight line between the two eyes stops it. Level ground never blocks, so flat maps are unchanged. From a plateau you see over the low ground; from below you see onto a one-step ledge, but only the edge of a taller cliff. The notch filler in `visibleCells` skips cells the ground itself hides. Measured on map_9: about 13% fewer cells in view, ~2 ms per view.

## Cost

- `notices` runs only for monsters that already think (awake walkers, monsters on a map with players), against
  the players on that map: the same loops as today, one line-of-sight check where there was a distance check.
  Plain monsters gain a `canSee` per player in range; it is the bounded line walk combat uses.
- `ms.sounds` is capped (16 per map; a new one replaces the oldest) and each lasts `sound_s`. Nothing per
  step grows with the number of monsters or of characters ever made.
- Nothing new is pushed per monster in stages 1-3. Stage 4 adds positions for heard monsters only.

## Choices (agreed by the owner, 25 Nov 2026)

| Choice | Agreed |
| --- | --- |
| Sneak control | a toggle key (Z), half walking speed |
| Plain monsters (rats, slimes) need line of sight too | yes: every brain through the one question |
| Facing matters | yes, stage 3: a 120° cone; blind behind it (Config `back_sight` 0 — the owner chose this over half range, 25 Nov 2026) |
| Ambush bonus | ×2 damage on an unaware monster, in Config |

## Open questions

- **Do walls muffle sound?** Yes since stage 2 (owner, 27 Nov 2026): Config `sound_muffle`, 2 tiles a wall.
- **Tame animals and feed in hand**: unchanged (an animal does not flee a player holding its `tame_with` item).
- **Armour and load**: heavy gear making more noise needs a weight on items; on the UI backburner (`load`).

## Left out on purpose

- Players hiding from other players (PvP stealth).
- Darkness and light: there is no day and night yet. Visibility is where it will plug in.
- Monsters hearing each other, or alerting their neighbours.
