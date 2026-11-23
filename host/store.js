/**
 * Where the host keeps the game between runs. One small interface, so the place can change without the host
 * changing: files on this computer today, the database when the game moves to a rented server.
 *
 *   store.load()              → Promise of { players: {token: player}, maps: {mapId: record}, world: {...} | null }
 *   store.put(kind, id, json) → Promise; writes ONE record. kind = 'player' | 'map' | 'world', json = its text.
 *   store.where               → a line for the host to print
 *
 * The records are the ones the Cloud Function keeps (functions/referee.js): one per character, one per map, and
 * the little that belongs to the whole world (the event count and log). The host decides WHAT changed and WHEN to
 * write; a store only reads and writes.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// A record's id as a file name every system accepts (ids hold dots; Windows refuses * and friends).
function fileName(id) { return encodeURIComponent(String(id)).replace(/[!'()*~.]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase()) + '.json'; }
function idOf(name) { return decodeURIComponent(name.slice(0, -5)); }

/**
 * Files in a folder: <dir>/players/<token>.json, <dir>/maps/<mapId>.json, <dir>/world.json.
 * legacyFile = the single file older hosts wrote ({players, world: {maps, ...}}): read when the folder has no game
 * yet, and never changed.
 */
function files(dir, legacyFile) {
  const sub = { player: path.join(dir, 'players'), map: path.join(dir, 'maps') };
  function readAll(folder, warn) {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(folder); } catch (e) { return out; }
    names.filter(n => /\.json$/.test(n)).forEach(n => {
      try { out[idOf(n)] = JSON.parse(fs.readFileSync(path.join(folder, n), 'utf8')); }
      catch (e) { warn.push(path.join(folder, n)); }
    });
    return out;
  }
  return {
    where: dir,
    async load() {
      const unread = [];
      const players = readAll(sub.player, unread), maps = readAll(sub.map, unread);
      let world = null;
      try { world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')); } catch (e) { /* none yet */ }
      if (Object.keys(players).length || Object.keys(maps).length || world) return { players, maps, world, unread };
      if (legacyFile) {
        try {
          const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8')), w = raw.world || {};
          const rest = {}; Object.keys(w).forEach(k => { if (k !== 'maps') rest[k] = w[k]; });
          return { players: raw.players || {}, maps: w.maps || {}, world: rest, unread, importedFrom: legacyFile };
        } catch (e) { /* no older save either: a new game */ }
      }
      return { players: {}, maps: {}, world: null, unread };
    },
    async put(kind, id, json) {
      const folder = sub[kind] || dir, file = path.join(folder, kind === 'world' ? 'world.json' : fileName(id)), tmp = file + '.tmp';
      await fs.promises.mkdir(folder, { recursive: true });
      await fs.promises.writeFile(tmp, json);            // write-then-rename, so a crash never leaves half a record
      await fs.promises.rename(tmp, file);
    }
  };
}

/** Keeps nothing: a throwaway session. */
function none() {
  return { where: '', async load() { return { players: {}, maps: {}, world: null, unread: [] }; }, async put() {} };
}

module.exports = { files: files, none: none, fileName: fileName };
