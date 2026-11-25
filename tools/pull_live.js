/**
 * One-off: copy the live content (Firestore, read through the Cloud Function) into the project files of local
 * mode, data/game/ (see client/js/localdata.js). Read-only for the live game: nothing is written there.
 *
 *   node tools/pull_live.js                          # reads FUNCTIONS_URL ?action=records and ?action=maps
 *   node tools/pull_live.js records.json maps.json   # or two answers already downloaded (no internet needed)
 *
 * The map documents (Firestore maps/<id>) win over the copies inside the content blob, as they do in the game;
 * a map that only the blob has is kept too. data/game/ is replaced as a whole.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LocalData = require('../client/js/localdata.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'game');

async function read() {
  if (process.argv[3]) return [process.argv[2], process.argv[3]].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const m = /FUNCTIONS_URL:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'client', 'js', 'config.js'), 'utf8'));
  if (!m) throw new Error('no FUNCTIONS_URL in client/js/config.js');
  return Promise.all(['records', 'maps'].map((a) => fetch(m[1] + '?action=' + a).then((r) => r.json())));
}

read().then(([rec, mp]) => {
  if (rec.error || !rec.tables) throw new Error(rec.error || 'no tables in the records answer');
  const tables = rec.tables, docs = (mp && mp.maps) || [];
  const have = {}; docs.forEach((d) => { have[d.id] = 1; });
  const blob = LocalData.split(tables).docs.filter((d) => !have[d.id]);   // maps only the content blob holds
  const all = docs.map((d) => { const r = LocalData.rowsOf(d); return LocalData.docOf(r.row, r.entities); }).concat(blob);
  const defs = LocalData.split(tables).defs;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'tables.json'), LocalData.tablesText(defs));
  all.forEach((d) => fs.writeFileSync(path.join(OUT, 'maps', d.id + '.json'), LocalData.mapText(d)));
  fs.writeFileSync(path.join(OUT, 'maps', 'index.json'), JSON.stringify({ maps: all.map((d) => d.id) }, null, 1) + '\n');
  console.log('data/game: ' + Object.keys(defs).length + ' tabs, ' + all.length + ' maps (' + all.map((d) => d.id).join(', ') + ')' +
    (blob.length ? '; from the content blob only: ' + blob.map((d) => d.id).join(', ') : ''));
}).catch((e) => { console.error('pull_live: ' + ((e && e.message) || e)); process.exit(1); });
