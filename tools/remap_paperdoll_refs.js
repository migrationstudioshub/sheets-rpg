/**
 * Remap paper-doll sprite references after the art/sprites/paperdoll/ folder was reorganised into
 * type subfolders (base/ chest/ hair/ hands/ head/ …). It scans the folder on disk to learn each
 * sprite's new location, then rewrites flat references (art/sprites/paperdoll/<name>.png) to the new
 * nested path. Masks (.tint.png) follow automatically because the renderer derives the mask path from
 * the base path, and they moved alongside.
 *
 *   node tools/remap_paperdoll_refs.js                     # fix the offline seed (data/tables.json)
 *   node tools/remap_paperdoll_refs.js data/tables.json    # ...explicit file
 *   node tools/remap_paperdoll_refs.js --live <functionUrl> <editorKey>
 *                                                          # fix the LIVE content: fetch, remap, republish
 *
 * Only the flat form (name directly after paperdoll/) is rewritten; already-nested paths are left alone,
 * so the script is safe to re-run. References whose file no longer exists are reported, not changed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PD = path.join(ROOT, 'art', 'sprites', 'paperdoll');

function buildMap() {                                   // base filename (no ext) -> new repo-relative path
  const map = {};
  (function walk(dir) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.png$/i.test(n) && !/\.tint\.png$/i.test(n)) {
        map[n.replace(/\.png$/i, '')] = 'art/sprites/paperdoll/' + path.relative(PD, full).split(path.sep).join('/');
      }
    }
  })(PD);
  return map;
}

function remap(text) {
  const map = buildMap();
  const orphans = new Set();
  let count = 0;
  const out = text.replace(/art\/sprites\/paperdoll\/([a-z0-9_]+)\.png/gi, function (m, name) {
    const to = map[name];
    if (!to) { orphans.add(m); return m; }             // file not found on disk — leave it, report it
    if (to !== m) count++;
    return to;
  });
  return { out, count, orphans: Array.from(orphans), files: Object.keys(map).length };
}

async function fixLive(fun, key) {
  if (!fun || !key) { console.error('usage: --live <functionUrl> <editorKey>'); process.exit(1); }
  const rec = await fetch(fun + '?action=records').then((r) => r.json());
  if (rec.error) { console.error('records failed:', rec.error); process.exit(1); }
  const r = remap(JSON.stringify(rec.tables || {}));
  console.log('live: remapping ' + r.count + ' references…');
  if (r.orphans.length) console.log('  orphans (left as-is):\n    ' + r.orphans.join('\n    '));
  if (!r.count) { console.log('  nothing to change.'); return; }
  const res = await fetch(fun, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish', key: key, tables: JSON.parse(r.out) }) }).then((x) => x.json());
  if (res.error) { console.error('publish failed:', res.error); process.exit(1); }
  console.log('  published version ' + res.version + ' (' + res.tabs + ' tabs). Live within ~30 min, or reload to force.');
}

function fixFile(file) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const r = remap(fs.readFileSync(full, 'utf8'));
  fs.writeFileSync(full, r.out);
  console.log('remapped ' + r.count + ' references in ' + file + ' (' + r.files + ' sprites on disk)');
  if (r.orphans.length) console.log('  ORPHANS (file not found on disk, left unchanged):\n    ' + r.orphans.join('\n    '));
}

if (process.argv[2] === '--live') fixLive(process.argv[3], process.argv[4]);
else fixFile(process.argv[2] || 'data/tables.json');

module.exports = { remap, buildMap };
