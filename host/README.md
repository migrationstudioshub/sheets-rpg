# LAN host (prototype)

Play together on the same WiFi, with no internet needed. One person runs this little server; it is
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
- Everyone else on the same WiFi opens the `192.168.x.x` address (whatever it printed).
- Create a character and play — moves should feel near-instant (a LAN round trip is a few ms vs ~220 ms
  to the cloud).

## Good to know

- **Fully offline.** Content comes from `data/tables.json` (the starting-content snapshot), so this
  does not need the internet or the Game Data sheet. It will not reflect later edits the owner makes
  in the live sheet.
- **Saved between sessions.** The game is written to `host/save.json` (debounced, once a second, and
  on Ctrl+C). Restart the host later and everyone's characters and the world come back. A returning
  player resumes automatically as long as they use the same browser (their character token is kept in
  that browser, separate from their cloud token). Delete `host/save.json` to start a clean world, or
  run `SAVE_FILE=off node host/server.js` for a throwaway session that saves nothing. The save file is
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
