/**
 * Finds a Python interpreter that can run the repo's art pipeline, and launches the art server.
 *
 * Consistency goal (see desktop/README.md): a PACKAGED build ships a frozen embeddable Python with
 * pinned Pillow + numpy under resources/python, so the art tool behaves the same on every machine.
 * In DEV (npm start) we prefer that same desktop/python/ if present, else fall back to a system Python.
 * Either way we run the REPO's own `tools/asset_server.py` + `tools/*pipe` scripts unchanged, so the
 * art logic always tracks the owner's checkout.
 *
 * Plain Node (runs under Electron's own Node), no dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const EMBED_EXE = WIN ? 'python.exe' : path.join('bin', 'python3');

/** Ordered list of interpreters to try: bundled (prod), bundled (dev), then system. */
function candidates({ resourcesPath, isPackaged }) {
  const out = [];
  if (isPackaged && resourcesPath) out.push(path.join(resourcesPath, 'python', EMBED_EXE));
  out.push(path.join(__dirname, 'python', EMBED_EXE));   // dev: desktop/python/ if prepared
  out.push.apply(out, WIN ? ['py', 'python', 'python3'] : ['python3', 'python']);
  return out;
}

/** True if `exe` runs and can import the pipeline's deps (Pillow + numpy). */
function canRunArt(exe) {
  // A bundled path that doesn't exist on disk is skipped before we spawn it.
  if ((exe.includes(path.sep) || exe.includes('/')) && !fs.existsSync(exe)) return false;
  try {
    const r = spawnSync(exe, ['-c', 'import PIL, numpy'], { timeout: 15000, windowsHide: true });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

/** First interpreter that can run the art pipeline, or null if none can. */
function resolvePython(opts) {
  for (const exe of candidates(opts || {})) {
    if (canRunArt(exe)) return exe;
  }
  return null;
}

/**
 * Launch the repo's art + static server (tools/asset_server.py) on `port`.
 * Returns the child process. The caller waits for the port to accept connections.
 */
function startAssetServer({ exe, projectRoot, port, env }) {
  const script = path.join(projectRoot, 'tools', 'asset_server.py');
  const child = spawn(exe, [script, String(port)], {
    cwd: projectRoot,
    env: Object.assign({}, process.env, env || {}),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

module.exports = { candidates, canRunArt, resolvePython, startAssetServer, EMBED_EXE };
