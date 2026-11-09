/**
 * Where the game gets its data.
 * API_URL empty  -> offline mode: content from data/tables.json, progress saved in this browser.
 * API_URL set    -> online mode: the Apps Script web app (see docs/SETUP.md, step 5).
 */
var GAME_CONFIG = {
  API_URL: '',
  ASSET_BASE: '../',            // repository root, relative to client/
  OFFLINE_TABLES: '../data/tables.json',
  SCALE: 2                      // on-screen pixels per art pixel
};
