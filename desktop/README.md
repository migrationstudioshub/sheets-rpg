# Sheets RPG Studio (desktop app)

A one-double-click desktop wrapper around the authoring suite — **Content Studio**, **Map Editor**,
**Asset Studio** — plus **offline Play** and the **LAN host**, so you never open a terminal.

It does **not** replace the repo: it *opens your project folder* and runs everything against it.
Generated art and `data/` land in that folder exactly as before, so you still commit and push to deploy
to GitHub Pages. Publishing content/maps to Firestore still happens inside the Content Studio / map
editor over the internet, unchanged.

## How it works

- On launch it serves your project folder on a fixed local port and opens a launcher window.
  - **Primary server:** the repo's own `tools/asset_server.py`, run by a bundled Python — this gives
    the art generators (Gear / Tileset / Objects). The art logic is still the repo's scripts; only the
    Python interpreter + Pillow/numpy are frozen into the app, so art behaves the same on any machine.
  - **Fallback server:** if no usable Python is found, a built-in Node server serves everything *except*
    art generation (Map Editor, Content Studio and offline Play still work; the Asset Studio explains
    that the art engine is offline).
- The **LAN host** button runs the repo's `host/server.js` under the app's own Node (no Node install
  needed) and shows the address other devices on your WiFi can open.

The Gemini API key for art generation works exactly as before: put it in `tools/google_api_key.txt`
(git-ignored) or the `GOOGLE_API` environment variable.

## Run it in development

From this `desktop/` folder:

```bash
npm install
npm start
```

In a dev checkout the app auto-detects the repo (the parent of `desktop/`) as the project folder, so it
opens straight away. Art generation in dev uses whatever Python is on your PATH (with Pillow + numpy).

## Build the Windows installer / portable exe

```bash
npm run prepare-python
npm run dist
```

- `prepare-python` downloads the **frozen** Python runtime (embeddable Python + pinned Pillow/numpy)
  into `desktop/python/`. Run once; it needs internet. Re-run with `node prepare_python.js --force` to
  rebuild, and edit the pinned versions at the top of `prepare_python.js` when you want to bump them.
- `dist` produces the installer and a portable `.exe` under `desktop/dist/`.

The first time you run the packaged app it asks for your `sheets-rpg` project folder and remembers it
(stored in the app's user-data folder). Change it later from the **Project → Open project folder…** menu.

## Tests

```bash
npm test        # node test_server.js — exercises the fallback static server
```

## Files

| File | Role |
| --- | --- |
| `main.js` | Electron main: project folder, server (Python primary / Node fallback), menu, LAN, IPC |
| `preload.js` | Safe `window.desktop` bridge for the launcher page |
| `server.js` | Fallback Node static server (+ port helpers); also runnable standalone for testing |
| `python.js` | Finds a usable Python and launches `tools/asset_server.py` |
| `home.html` / `home.js` / `home.css` | The launcher window |
| `prepare_python.js` | Build step: fetch + freeze the bundled Python |
| `test_server.js` | Tests for `server.js` |
