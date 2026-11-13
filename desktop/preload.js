/**
 * Preload bridge. Exposes a small, safe `window.desktop` API to the launcher page (home.html) and the
 * served tool pages. contextIsolation is on and nodeIntegration is off, so pages can't touch Node —
 * they go through these IPC calls only.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getStatus: () => ipcRenderer.invoke('status'),
  startLan: () => ipcRenderer.invoke('lan:start'),
  stopLan: () => ipcRenderer.invoke('lan:stop'),
  navigate: (tool) => ipcRenderer.invoke('navigate', tool),
  // Tell the shell how tall its top nav is, so the tool view is placed right below it.
  setNavHeight: (px) => ipcRenderer.send('nav:height', px),
  // Fired when the active tool changes (incl. 'home'), so the nav can highlight the right tab.
  onNavActive: (cb) => {
    const handler = (_e, tool) => cb(tool);
    ipcRenderer.on('nav:active', handler);
    return () => ipcRenderer.removeListener('nav:active', handler);
  },
  chooseProject: () => ipcRenderer.invoke('project:choose'),
  revealProject: () => ipcRenderer.invoke('project:reveal'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Live LAN stdout lines. Returns an unsubscribe function.
  onLanLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on('lan:log', handler);
    return () => ipcRenderer.removeListener('lan:log', handler);
  },
  // Fired when LAN start/stop changes state, so the page can refresh without polling.
  onLanState: (cb) => {
    const handler = (_e, lan) => cb(lan);
    ipcRenderer.on('lan:state', handler);
    return () => ipcRenderer.removeListener('lan:state', handler);
  },
});
