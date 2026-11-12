/**
 * Builds art/manifest.json — the list of every image under art/, so the Content Studio can offer a
 * "Browse /art" picker for its image fields (sprites, tilesets, icons…). Run after adding art:
 *
 *   node tools/build_art_manifest.js
 *
 * A published page (GitHub Pages) can't scan the art folder at runtime, so the Studio reads this
 * manifest. Keep it in step by re-running after adding art (the Asset Studio rebuilds it on every save).
 * Lists every image under art/ recursively, except the .tint.png colour masks and the art/inbox/ scratch.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'art');
const OUT = path.join(ART, 'manifest.json');
const EXT = /\.(png|jpe?g|gif|webp)$/i;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'inbox') continue;                              // scratch drop folder, not published art
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT.test(name) && !/\.tint\.png$/i.test(name)) {    // skip paper-doll colour masks
      out.push('art/' + path.relative(ART, full).split(path.sep).join('/'));
    }
  }
}

function build() {
  if (!fs.existsSync(ART)) { console.error('no art folder:', ART); process.exit(1); }
  const images = [];
  walk(ART, images);
  images.sort();
  fs.writeFileSync(OUT, JSON.stringify({ images }, null, 2) + '\n');
  console.log('wrote ' + images.length + ' images to ' + path.relative(ROOT, OUT));
}

build();
