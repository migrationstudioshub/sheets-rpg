/**
 * Build step: fetch a FROZEN Python runtime for the packaged app.
 *
 *   node prepare_python.js            # downloads + prepares desktop/python/ (skips if already there)
 *   node prepare_python.js --force    # rebuild from scratch
 *
 * It downloads the Windows *embeddable* Python, enables site-packages, bootstraps pip, and installs
 * PINNED Pillow + numpy into it. electron-builder then bundles desktop/python/ as resources/python.
 * The result: the art tool uses this exact interpreter + library versions on every machine, while
 * still running the REPO's own tools/asset_server.py + tools/*pipe scripts (so art logic tracks the
 * owner's checkout). Needs internet; run once before `npm run dist`. Windows only (uses Expand-Archive).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// --- pinned versions (bump deliberately; this is the whole point of freezing) ---
const PY = '3.11.9';
const PILLOW = '10.4.0';
const NUMPY = '1.26.4';

const EMBED_URL = 'https://www.python.org/ftp/python/' + PY + '/python-' + PY + '-embed-amd64.zip';
const GETPIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const DIR = path.join(__dirname, 'python');
const EXE = path.join(DIR, 'python.exe');
const FORCE = process.argv.includes('--force');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); get(res.headers.location); return;        // follow redirect
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' for ' + u)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', reject);
    get(url);
  });
}

function ps(cmd) { execFileSync('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'inherit' }); }

/** Embeddable Python ships with `import site` commented out; turn it on so site-packages works. */
function enableSitePackages() {
  const pth = fs.readdirSync(DIR).find((f) => /^python\d+\._pth$/.test(f));
  if (!pth) throw new Error('no python._pth in ' + DIR);
  const p = path.join(DIR, pth);
  let txt = fs.readFileSync(p, 'utf8').replace(/^#\s*import site/m, 'import site');
  if (!/^Lib\\site-packages/m.test(txt)) txt += '\nLib\\site-packages\n';
  fs.writeFileSync(p, txt);
}

async function main() {
  if (process.platform !== 'win32') {
    console.error('prepare_python.js is Windows-only (packaged target is Windows). Skipping.');
    process.exit(0);
  }
  if (fs.existsSync(EXE) && !FORCE) {
    console.log('desktop/python already prepared (use --force to rebuild). Done.');
    return;
  }
  if (FORCE && fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const zip = path.join(__dirname, '_python-embed.zip');
  const getpip = path.join(DIR, 'get-pip.py');

  console.log('Downloading embeddable Python ' + PY + '…');
  await download(EMBED_URL, zip);
  console.log('Extracting…');
  ps("Expand-Archive -Force -LiteralPath '" + zip + "' -DestinationPath '" + DIR + "'");
  fs.rmSync(zip, { force: true });

  enableSitePackages();

  console.log('Bootstrapping pip…');
  await download(GETPIP_URL, getpip);
  execFileSync(EXE, [getpip, '--no-warn-script-location'], { stdio: 'inherit' });

  console.log('Installing pinned Pillow ' + PILLOW + ' + numpy ' + NUMPY + '…');
  execFileSync(EXE, ['-m', 'pip', 'install', '--no-warn-script-location',
    'Pillow==' + PILLOW, 'numpy==' + NUMPY], { stdio: 'inherit' });

  fs.rmSync(getpip, { force: true });

  console.log('Verifying…');
  execFileSync(EXE, ['-c', 'import PIL, numpy; print("Pillow", PIL.__version__, "numpy", numpy.__version__)'],
    { stdio: 'inherit' });
  console.log('\ndesktop/python is ready. Now run: npm run dist');
}

main().catch((e) => { console.error('prepare_python failed:', e.message); process.exit(1); });
