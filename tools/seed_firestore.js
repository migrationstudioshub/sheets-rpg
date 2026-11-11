#!/usr/bin/env node
/**
 * One-off: seed Firestore with the current content by publishing data/tables.json through the
 * Cloud Function's key-gated /publish endpoint. No admin credentials needed — it just POSTs, the
 * function (Admin SDK) does the write. Run it once after deploying the function and setting the
 * EDITOR_KEY secret.
 *
 *   node tools/seed_firestore.js <functionUrl> <editorKey>
 *
 * <functionUrl> is the deployed function URL (same as FUNCTIONS_URL in client/js/config.js).
 * <editorKey>   is the value you set with:  firebase functions:secrets:set EDITOR_KEY
 */
const fs = require('fs');
const path = require('path');

const [, , url, key] = process.argv;
if (!url || !key) {
  console.error('Usage: node tools/seed_firestore.js <functionUrl> <editorKey>');
  process.exit(1);
}
const tables = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tables.json'), 'utf8'));
const tabs = Object.keys(tables).filter(function (k) { return Array.isArray(tables[k]); });
console.log('Publishing ' + tabs.length + ' tabs (' + tabs.join(', ') + ') to ' + url);

fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'publish', key: key, tables: tables })
})
  .then(function (r) { return r.json(); })
  .then(function (j) {
    if (j.error) { console.error('FAILED: ' + j.error); process.exit(1); }
    console.log('Published:', JSON.stringify(j));
  })
  .catch(function (e) { console.error('Request failed:', e.message); process.exit(1); });
