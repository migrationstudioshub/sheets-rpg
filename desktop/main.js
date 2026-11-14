/**
 * Sheets RPG Studio — Electron desktop shell (migration Phase 5).
 *
 * Wraps the repo's authoring suite in a one-double-click app so the owner never opens a terminal:
 *   - Opens the owner's project folder (the git repo) and serves it on a fixed localhost port.
 *     PRIMARY server = the repo's Python tools/asset_server.py (static files + art-generation APIs),
 *     run by a bundled/found Python. FALLBACK = a Node static server (desktop/server.js) with art off.
 *   - A native menu + a launcher page (home.html) open the Content Studio, Map Editor, Asset Studio
 *     and offline Play; a LAN panel starts/stops the repo's host/server.js for same-WiFi multiplayer.
 *
 * Generated art and data land in the project folder exactly as before, so the owner's normal
 * git commit -> GitHub Pages deploy loop is unchanged. Firestore publish still goes over the internet.
 */
'use strict';
const { app, BrowserWindow, WebContentsView, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { fork } = require('child_process');

const server = require('./server');
const py = require('./python');

const PREF_PORT = 8766;                 // stable origin keeps Content Studio's localStorage draft durable
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');

let win = null;
let httpServer = null;                  // fallback Node server (only in fallback mode)
let assetChild = null;                  // Python asset_server.py (only in python mode)
let lanChild = null;                    // host/server.js

// The window itself shows the shell (home.html): the top nav + the Home panel (LAN, status). Each tool
// loads into this WebContentsView, laid out BELOW the nav, so the shared web pages stay untouched and the
// live site is unaffected. 'home' means the view is detached, revealing the shell's Home panel underneath.
let toolView = null;
let activeTool = 'home';
let navHeight = 150;                    // px reserved for the shell's top nav; the shell reports the real value

const state = {
  projectRoot: null,
  port: PREF_PORT,
  mode: 'starting',                     // 'python' | 'fallback'
  artOk: false,
  lan: { running: false, port: 3000, addresses: [] },
};

// ---------------------------------------------------------------- settings + project folder
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2));
  } catch (e) { /* non-fatal: we just lose the remembered folder/port */ }
}

/** A folder is a valid project if it has the files the suite needs. */
function isProject(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'client', 'index.html'))
    && fs.existsSync(path.join(dir, 'shared', 'world.js'))
    && fs.existsSync(path.join(dir, 'data', 'tables.json'));
}

/** The repo this app was shipped from — valid only in a dev checkout (desktop/ inside the repo). */
function devRepoRoot() {
  const guess = path.resolve(__dirname, '..');
  return isProject(guess) ? guess : null;
}

async function pickProjectDialog() {
  const r = await dialog.showOpenDialog({
    title: 'Choose your sheets-rpg project folder',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  if (!isProject(dir)) {
    await dialog.showMessageBox({
      type: 'error', message: "That folder isn't a sheets-rpg project",
      detail: 'Expected to find client/, shared/ and data/tables.json inside it. Pick the repo root.',
    });
    return pickProjectDialog();
  }
  return dir;
}

/** Decide the project folder: remembered → dev checkout → ask. Returns false if the user cancels. */
async function ensureProject() {
  const s = loadSettings();
  if (typeof s.port === 'number') state.port = s.port;
  if (isProject(s.projectRoot)) { state.projectRoot = s.projectRoot; return true; }

  const dev = !app.isPackaged && devRepoRoot();
  if (dev) { state.projectRoot = dev; return true; }

  const picked = await pickProjectDialog();
  if (!picked) return false;
  state.projectRoot = picked;
  saveSettings(Object.assign(loadSettings(), { projectRoot: picked }));
  return true;
}

// ---------------------------------------------------------------- serving the project
/** Resolve true once something accepts a TCP connection on `port` (server is up). */
function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

async function startServing() {
  state.port = await server.findPort(state.port);     // prefer the remembered port; drift only if taken
  saveSettings(Object.assign(loadSettings(), { projectRoot: state.projectRoot, port: state.port }));

  const exe = py.resolvePython({ resourcesPath: process.resourcesPath, isPackaged: app.isPackaged });
  if (exe) {
    assetChild = py.startAssetServer({ exe, projectRoot: state.projectRoot, port: state.port });
    assetChild.on('exit', () => { assetChild = null; });
    if (await waitForPort(state.port)) {
      state.mode = 'python'; state.artOk = true;
      return;
    }
    try { assetChild && assetChild.kill(); } catch (e) { /* ignore */ }
    assetChild = null;
  }

  // Fallback: Node static server, art disabled.
  httpServer = server.createServer(state.projectRoot);
  await new Promise((res) => httpServer.listen(state.port, '127.0.0.1', res));
  state.mode = 'fallback'; state.artOk = false;
}

function base() { return 'http://127.0.0.1:' + state.port; }
function urlFor(tool) {
  switch (tool) {
    case 'content': return base() + '/content/';
    case 'editor':  return base() + '/editor/';
    case 'studio':  return base() + '/studio/';
    case 'play':    return base() + '/client/?offline';
    default:        return base() + '/desktop/home.html';
  }
}

// ---------------------------------------------------------------- tool view (below the nav)
function ensureToolView() {
  if (toolView) return toolView;
  toolView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  toolView.setBackgroundColor('#14161b');
  toolView.webContents.setWindowOpenHandler(({ url }) => {
    // A Play-test (map editor / Content Studio) opens the offline game with window.open. It has already
    // written the offline draft first, so instead of spawning a separate window, load it straight into
    // the Play tab in this same window (carrying any ?map=...), and don't pop a new window.
    if (url.indexOf(base() + '/client/') === 0) { showTool('play', url); return { action: 'deny' }; }
    // Anything else (external links) opens in the default browser-like window.
    if (win && !win.isDestroyed()) win.webContents.send('nav:active', activeTool);
    return { action: 'allow' };
  });
  return toolView;
}
function layoutToolView() {
  if (!win || win.isDestroyed() || !toolView || activeTool === 'home') return;
  const b = win.getContentBounds();
  const y = Math.min(navHeight, b.height);
  toolView.setBounds({ x: 0, y: y, width: b.width, height: Math.max(0, b.height - y) });
}
function showTool(tool, overrideUrl) {
  if (!win || win.isDestroyed()) return;
  ensureToolView();
  const url = overrideUrl || urlFor(tool);
  // Reload when the tool changes, or always when given an explicit URL (a Play-test carries fresh content
  // and a specific map, so re-load even if the Play tab already shows the game).
  if (overrideUrl || toolView.webContents.getURL() !== url) toolView.webContents.loadURL(url);
  if (activeTool === 'home') win.contentView.addChildView(toolView);   // attach only when leaving Home
  activeTool = tool;
  layoutToolView();
  win.webContents.send('nav:active', activeTool);
}
function showHome() {
  if (!win || win.isDestroyed()) return;
  if (toolView && activeTool !== 'home') win.contentView.removeChildView(toolView);  // reveal the shell's Home panel
  activeTool = 'home';
  win.webContents.send('nav:active', activeTool);
}
function navTo(tool) { if (!tool || tool === 'home') showHome(); else showTool(tool); }

// ---------------------------------------------------------------- LAN host
function lanState() { return Object.assign({}, state.lan); }
function pushLanState() { if (win && !win.isDestroyed()) win.webContents.send('lan:state', lanState()); }

async function startLan() {
  if (lanChild) return lanState();
  const port = await server.findPort(3000);
  const hostScript = path.join(state.projectRoot, 'host', 'server.js');
  lanChild = fork(hostScript, [], {
    cwd: state.projectRoot,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  state.lan = { running: true, port, addresses: [] };

  const onLine = (buf) => {
    String(buf).split('\n').forEach((line) => {
      if (!line.trim()) return;
      if (win && !win.isDestroyed()) win.webContents.send('lan:log', line);
      const m = line.match(/https?:\/\/[^\s]+/);
      if (m && !state.lan.addresses.includes(m[0])) { state.lan.addresses.push(m[0]); pushLanState(); }
    });
  };
  lanChild.stdout && lanChild.stdout.on('data', onLine);
  lanChild.stderr && lanChild.stderr.on('data', onLine);
  lanChild.on('exit', () => { lanChild = null; state.lan = { running: false, port, addresses: [] }; pushLanState(); });

  pushLanState();
  return lanState();
}

function stopLan() {
  if (lanChild) { try { lanChild.kill(); } catch (e) { /* ignore */ } }  // SIGTERM → host saves + exits
  return lanState();
}

// ---------------------------------------------------------------- window + menu
function buildMenu() {
  const nav = (tool) => () => navTo(tool);
  const template = [
    {
      label: 'Studio',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+H', click: nav('home') },
        { type: 'separator' },
        { label: 'Content Studio', click: nav('content') },
        { label: 'Map Editor', click: nav('editor') },
        { label: 'Asset Studio', click: nav('studio') },
        { label: 'Play (offline)', click: nav('play') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Project',
      submenu: [
        { label: 'Open project folder…', click: async () => { await changeProject(); } },
        { label: 'Reveal in file manager', click: () => shell.openPath(state.projectRoot) },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'LAN',
      submenu: [
        { label: 'Start LAN host', click: () => startLan() },
        { label: 'Stop LAN host', click: () => stopLan() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function changeProject() {
  const picked = await pickProjectDialog();
  if (!picked) return;
  saveSettings(Object.assign(loadSettings(), { projectRoot: picked }));
  // Simplest correct way to re-serve a different folder: relaunch.
  app.relaunch();
  app.exit(0);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, backgroundColor: '#14161b',
    title: 'Sheets RPG Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(urlFor('home'));
  // Re-tell the shell which tab is active whenever it (re)loads, so a manual Reload keeps the highlight right.
  win.webContents.on('did-finish-load', () => { if (win && !win.isDestroyed()) win.webContents.send('nav:active', activeTool); });
  win.on('closed', () => { win = null; toolView = null; activeTool = 'home'; });
  win.on('resize', layoutToolView);
  win.on('maximize', layoutToolView);
  win.on('unmaximize', layoutToolView);
  win.on('enter-full-screen', layoutToolView);
  win.on('leave-full-screen', layoutToolView);
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('status', () => ({
  projectRoot: state.projectRoot, port: state.port, mode: state.mode,
  artOk: state.artOk, lan: lanState(),
}));
ipcMain.handle('lan:start', () => startLan());
ipcMain.handle('lan:stop', () => stopLan());
ipcMain.handle('navigate', (_e, tool) => { navTo(tool); return true; });
// The shell reports how tall its top nav is, so the tool view sits exactly beneath it.
ipcMain.on('nav:height', (_e, px) => { navHeight = Math.max(0, Math.round(Number(px) || 0)) || navHeight; layoutToolView(); });
ipcMain.handle('project:choose', () => changeProject());
ipcMain.handle('project:reveal', () => shell.openPath(state.projectRoot));
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

// ---------------------------------------------------------------- lifecycle
function cleanup() {
  if (lanChild) { try { lanChild.kill(); } catch (e) { /* ignore */ } lanChild = null; }
  if (assetChild) { try { assetChild.kill(); } catch (e) { /* ignore */ } assetChild = null; }
  if (httpServer) { try { httpServer.close(); } catch (e) { /* ignore */ } httpServer = null; }
}

app.whenReady().then(async () => {
  if (!(await ensureProject())) { app.quit(); return; }
  await startServing();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', cleanup);
