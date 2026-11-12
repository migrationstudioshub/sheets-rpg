/**
 * Where the game gets its data.
 * FUNCTIONS_URL set -> online: the Cloud Function is the referee AND serves content from Firestore.
 * FUNCTIONS_URL empty -> offline: content from data/tables.json (or a content draft), progress in this browser.
 */
var GAME_CONFIG = {
  // Retired: the old Apps Script web app. Unused now (the function serves content); kept for reference only.
  API_URL: 'https://script.google.com/macros/s/AKfycbwgvNgUbURE4p27Po2XPiBjAorqIxKDv0wJxnC9sxowo9jSbO9o8SyeY0oL5OjbOoYXmA/exec',
  // The Firebase Realtime Database URL. The game listens here for live monster/player positions (pushed
  // in ~100 ms by the referee) instead of waiting for the next poll. See docs/SETUP.md.
  FIREBASE_URL: 'https://sheets-rpg-73de1-default-rtdb.firebaseio.com/',
  // The Cloud Function URL: the live referee (join/load/poll/act, ~300 ms) AND the content server
  // (?action=content/records/maps from Firestore; key-gated publish). This is the online backend.
  FUNCTIONS_URL: 'https://us-central1-sheets-rpg-73de1.cloudfunctions.net/game',
  ASSET_BASE: '../',            // repository root, relative to client/
  OFFLINE_TABLES: '../data/tables.json',
  SCALE: 1.35                   // on-screen pixels per art pixel (lower = smaller tiles, wider view fits)
};
