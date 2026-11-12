#!/usr/bin/env node
/**
 * One-off: move every map out of the content blob into its own Firestore doc, then strip maps from
 * the blob so it holds definitions only. After this, maps live solely in maps/<id> docs — deleting a
 * map works cleanly and there's no blob/doc duality. Run it once (after any maps you already created
 * in the editor, which are already docs, are safe — this only migrates the ones still in the blob).
 *
 *   node tools/migrate_maps.js <functionUrl> <editorKey>
 *
 * It reads the current content through the function, so it always migrates the live state (your
 * published definitions are preserved untouched). Safe to re-run.
 */
const path = require('path');
const MapCode = require(path.join(__dirname, '..', 'shared', 'mapcode.js'));

const [, , url, key] = process.argv;
if (!url || !key) {
  console.error('Usage: node tools/migrate_maps.js <functionUrl> <editorKey>');
  process.exit(1);
}

async function post(body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  const rec = await fetch(url + '?action=records').then(r => r.json());
  if (rec.error) throw new Error(rec.error);
  const t = rec.tables || {};
  const maps = t.Maps || [], ents = t.MapEntities || [];
  if (!maps.length) { console.log('No maps in the content blob — nothing to migrate.'); }

  for (const m of maps) {
    let grid = JSON.parse(m.terrain);
    grid = MapCode.isEncoded(grid) ? MapCode.decode(grid) : grid;      // normalise to a plain grid
    const myEnts = ents.filter(e => String(e.map) === String(m.id)).map(e => ({
      key: e.key, x: Number(e.x), y: Number(e.y), ref: e.ref, data: e.data
    }));
    const res = await post({ action: 'publishMap', key, map: {
      id: m.id, name: m.name, width: Number(m.width), height: Number(m.height),
      terrain: MapCode.encode(grid), entities: myEnts } });
    if (res.error) { console.error('  ' + m.id + ' FAILED: ' + res.error); process.exit(1); }
    console.log('  moved ' + m.id + ' → maps/' + m.id + ' (' + myEnts.length + ' entities)');
  }

  // strip Maps + MapEntities from the blob; keep every definition tab as-is
  const defs = {};
  Object.keys(t).forEach(k => { if (k !== 'Maps' && k !== 'MapEntities') defs[k] = t[k]; });
  const pub = await post({ action: 'publish', key, tables: defs });
  if (pub.error) { console.error('publish definitions FAILED: ' + pub.error); process.exit(1); }
  console.log('Done. Blob now holds definitions only (' + pub.tabs + ' tabs); maps live in their own docs.');
})().catch(e => { console.error(e); process.exit(1); });
