/**
 * Builds art/sprites/paperdoll/manifest.json — the list of paper-doll sprites the Content Studio's
 * appearance editor offers in its sprite picker. Run this after generating new paper-doll art:
 *
 *   node tools/build_paperdoll_manifest.js
 *
 * A published page (GitHub Pages) can't scan the art folder at runtime, so the Studio reads this
 * manifest instead; keep it in step by re-running after adding art (the art pipeline can call this too).
 * Lists every *.png in art/sprites/paperdoll except the .tint.png colour masks.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'art', 'sprites', 'paperdoll');
const OUT = path.join(DIR, 'manifest.json');

function build() {
  if (!fs.existsSync(DIR)) { console.error('no paper-doll art folder:', DIR); process.exit(1); }
  const sprites = fs.readdirSync(DIR)
    .filter(f => /\.png$/i.test(f) && !/\.tint\.png$/i.test(f))
    .sort()
    .map(f => 'art/sprites/paperdoll/' + f);
  fs.writeFileSync(OUT, JSON.stringify({ sprites }, null, 2) + '\n');
  console.log('wrote ' + sprites.length + ' sprites to ' + path.relative(path.join(__dirname, '..'), OUT));
}

build();
