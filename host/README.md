# Host (one player's computer is the referee)

Play together on the same WiFi, or with friends elsewhere over a private network such as Tailscale. One person runs this little server; it is
the referee **and** it serves the game page, so everyone else just opens a link in their browser.

It reuses the exact same rules as the cloud game (`shared/world.js`) and the normal game page
(`client/`). The only difference is where the browser sends moves: a LAN game talks to this host
instead of the Cloud Function / Apps Script / Firebase.

## Run it

You need [Node.js](https://nodejs.org) installed (no `npm install` step — it uses only built-in modules).

From the repo root:

```bash
node host/server.js
```

Pick a different port with `PORT=4000 node host/server.js`.

It prints something like:

```
  On THIS computer:      http://localhost:3000
  Others on your WiFi:   http://192.168.1.42:3000
```

- The host plays at `http://localhost:3000`.
- A friend somewhere else, with **Tailscale** running on both computers, opens the line marked
  "Friends on Tailscale" (an address starting with `100.`). `tailscale ping <their device>` tells you whether the
  connection is direct (fast) or relayed (slower).
- Everyone else on the same WiFi opens the `192.168.x.x` address (whatever it printed).
- Create a character and play — moves should feel near-instant (a LAN round trip is a few ms vs ~220 ms
  to the cloud).

## Good to know

- **The world runs on its own.** The host turns the world ten times a second for as long as somebody is playing
  (monsters move without anyone asking), and keeps a socket open to every page: your actions go up it and each
  turn's changes come down it, only the parts that changed. `TICK_MS=50 node host/server.js` runs it faster.
  A page that cannot open the socket falls back to asking four times a second, as before.
- **Try a bad connection.** `LAG_MS=150 node host/server.js` delays every socket message 150 ms each way, so you can
  feel how the game plays for a friend far away while testing alone.
- **Small messages.** A message only carries what changed since the last one on that socket, and only the monsters
  and players within 20 tiles of you (Config `interest_radius`; 0 = the whole map). A player standing in a crowd of
  30 is sent about 5 kB a second.
- **Check it.** `node tools/test_host.js` starts a throwaway host and tests the loop, the socket and saving.
- **Try a crowd.** `node tools/bots.js` puts 30 scripted players on a throwaway host for 20 seconds and prints how
  fast answers came, how much was sent and how hard the loop worked (`--n 60`, `--secs 30`, `--live` for your live
  content, `--lag 100`). It never touches your saved game unless you point it at a running host with `--url`.

- **It plays your live content.** At start-up the host reads the live game's content from the Cloud Function (the
  same read the game page does; nothing is ever written there), so you host your real maps, monsters and blueprints.
  It is read ONCE: publish something in the Content Studio and you restart the host to get it. With no internet it
  uses the copy kept from the last good read (`host/content.cache.json`), and failing that the starting content in
  `data/tables.json`. `CONTENT=local node host/server.js` always plays the starting content. A project with `data/game/` (local mode:
what the Content Studio and the map editor save) plays that by default; `CONTENT=live` reads the live game instead.
- **Saved between sessions.** The game is kept in the folder `host/save.live/` (`host/save/` when playing the starting
  content): one small file per character, one per map, and `world.json`. Every 3 seconds the host writes only the
  records that changed, and once more on Ctrl+C, so if the computer dies mid-game at most 3 seconds are lost
  (`SAVE_MS=10000` to write less often). A game from an older host (the single file `host/save.live.json`) is read
  the first time and carried on from; that file is left as it was. Restart the host later and everyone's characters and the world come back. A returning
  player resumes automatically as long as they use the same browser (their character token is kept in
  that browser, separate from their cloud token). Delete that folder (and the older single file, if you have one) to start a clean world, or
  run `SAVE_FILE=off node host/server.js` for a throwaway session that saves nothing. The save is
  gitignored, so it never ends up in the repo.
- **Tied to this host + this machine.** The save lives on the host's computer. If someone else hosts
  (a different machine), that's a different, separate world. For one always-on world that doesn't
  depend on who hosts, that's what the cloud game already is.
- **The host must stay running** during a session. If the host closes mid-game, everyone disconnects
  (but the saved state is kept for next time).
- **Firewall.** The first time, Windows/macOS may ask whether to allow Node to accept connections on
  your private network — say yes, or others can't reach you.
- **Nothing in the repo changes.** The page the host serves sets `window.GAME_LAN`, which tells
  `client/js/api.js` to use the LAN backend. The normal site (GitHub Pages) never sets that flag, so
  the live cloud game is unaffected. LAN characters use a separate saved token, so playing a LAN game
  does not log you out of your cloud character.

## Prototype limits (not done yet)

- No discovery: players type the host's address (could add a short "LAN code" / mDNS later).
- No packaging: you run `node host/server.js`. For non-technical hosts this would become a
  double-click app (`.exe` via `pkg`, or a small Electron wrapper).
- Like the cloud, world writes are simple last-write-wins under truly simultaneous actions.
