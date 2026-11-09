/**
 * Where the game gets its data.
 * API_URL empty  -> offline mode: content from data/tables.json, progress saved in this browser.
 * API_URL set    -> online mode: the Apps Script web app (see docs/SETUP.md, step 5).
 */
var GAME_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwgvNgUbURE4p27Po2XPiBjAorqIxKDv0wJxnC9sxowo9jSbO9o8SyeY0oL5OjbOoYXmA/exec',
  // Optional. The Firebase Realtime Database URL (e.g. https://<project>.firebaseio.com). When set
  // (and API_URL is set too), the game listens here for live monster/player positions, pushed in
  // ~100 ms, instead of waiting for the next poll. Empty = today's poll-only behaviour. See docs/SETUP.md.
  FIREBASE_URL: '',
  ASSET_BASE: '../',            // repository root, relative to client/
  OFFLINE_TABLES: '../data/tables.json',
  SCALE: 2                      // on-screen pixels per art pixel
};
