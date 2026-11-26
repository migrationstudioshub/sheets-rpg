/**
 * Tests for the host's loop and socket (host/server.js): starts a real host on the starting content, with nothing
 * saved, and talks to it the way the game page does.
 *   node tools/test_host.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Wire = require('../client/js/wire.js');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
let failed = 0, child = null;
function ok(cond, what) { if (cond) console.log('  ok   ' + what); else { failed++; console.log('  FAIL ' + what); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A page's side of the socket: call(body) → the answer; pushes pile up in .pushes, merged into .world like the page does. */
function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/');
  const c = { ws, n: 0, waiting: {}, pushes: [], raw: [], bytes: 0, world: null, player: null, events: [] };
  const held = Wire.receiver();
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    c.raw.push(msg); c.bytes += m.data.length;
    const whole = msg.now !== undefined && !msg.error ? Wire.unpack(held, msg) : null;
    if (whole) { c.world = whole.world; c.player = whole.player; whole.events.forEach(e => c.events.push(e)); }
    if (msg.push) { c.pushes.push(msg); return; }
    const wait = c.waiting[msg.re]; delete c.waiting[msg.re];
    if (wait) wait(whole ? Object.assign({ re: msg.re }, whole) : msg);
  };
  c.open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('socket would not open')); });
  c.call = body => new Promise(res => { const n = ++c.n; c.waiting[n] = res; ws.send(JSON.stringify(Object.assign({ n }, body))); });
  return c;
}
async function post(body) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

/** Start a host; resolves with what it printed once it is up. saveFile = 'off' or the path of its save. */
async function start(saveFile) {
  child = spawn(process.execPath, [path.join(ROOT, 'host', 'server.js')],
    { env: Object.assign({}, process.env, { PORT: String(PORT), CONTENT: 'local', SAVE_FILE: saveFile, SAVE_MS: '250', TICK_MS: '50', LAG_MS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const got = { text: '' };
  child.stdout.on('data', d => { got.text += d; });
  child.stderr.on('data', d => { got.text += d; });
  for (let i = 0; i < 100 && got.text.indexOf('Press Ctrl+C') < 0; i++) await sleep(100);
  return got;
}
/** Kill the host outright, as a crash or a power cut would: it gets no chance to save. */
async function crash() {
  const gone = new Promise(r => child.once('exit', r));
  child.kill('SIGKILL'); await gone; child = null;
}

/** Saving: only what changed is written, a crash loses next to nothing, and a save from an older host carries on. */
async function saving() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpg-host-')), file = path.join(tmp, 'game.json'), dir = path.join(tmp, 'game');
  let up = await start(file);
  ok(/New game/.test(up.text), 'a host with no save starts a new game');
  const j = await post({ action: 'join', name: 'Keeper', 'class': '' });
  let at = (await post({ action: 'load', token: j.token })).player;
  for (const d of ['N', 'E', 'S', 'W', 'N', 'E']) at = (await post({ action: 'act', token: j.token, 'do': { type: 'move', dirs: [d] } })).player;
  await sleep(900);
  const pf = path.join(dir, 'players'), mf = path.join(dir, 'maps');
  ok(fs.existsSync(pf) && fs.readdirSync(pf).length === 1, 'the character has a file of its own');
  ok(fs.existsSync(mf) && fs.readdirSync(mf).length >= 1 && fs.existsSync(path.join(dir, 'world.json')), 'each map has a file of its own, and the world one');
  ok(!fs.existsSync(file), 'nothing is written to the old single file');
  const s1 = await post({ action: 'stats' });
  ok(s1.saved > 0, 'the host counts what it wrote (' + s1.saved + ' records)');
  const pfile = path.join(pf, fs.readdirSync(pf)[0]), kept = fs.readFileSync(pfile, 'utf8');
  ok(JSON.parse(kept).x === at.x && JSON.parse(kept).y === at.y, 'the file holds where the character stands');

  await crash();
  ok(fs.readdirSync(pf).concat(fs.readdirSync(mf)).every(n => /\.json$/.test(n)), 'a crash leaves no half-written record behind');
  up = await start(file);
  ok(/Resumed the game/.test(up.text) && /1 character/.test(up.text), 'after a crash the host resumes the game');
  const back = await post({ action: 'load', token: j.token });
  ok(back.player && back.player.name === 'Keeper' && back.player.x === at.x && back.player.y === at.y, 'the character is where it was');
  await crash();

  // a save written by an older host: one file holding everything
  const old = path.join(tmp, 'old.json'), olddir = path.join(tmp, 'old');
  const rec = JSON.parse(kept), maps = {};
  fs.readdirSync(mf).forEach(n => { maps[decodeURIComponent(n.slice(0, -5))] = JSON.parse(fs.readFileSync(path.join(mf, n), 'utf8')); });
  const away = Object.assign({}, rec, { id: 'away1', name: 'Away', token: 'away-token', _seen: 0 });   // someone who has not played for a long time
  fs.writeFileSync(old, JSON.stringify({ players: { [j.token]: rec, 'away-token': away }, world: { seq: 7, log: [], maps: maps } }));
  const oldText = fs.readFileSync(old, 'utf8');
  up = await start(old);
  ok(/Carried on from the older save/.test(up.text), 'a save from an older host is carried on from');
  const again = await post({ action: 'load', token: j.token });
  ok(again.player && again.player.x === at.x && again.player.y === at.y, 'its character is where it was');
  await sleep(900);
  ok(fs.existsSync(path.join(olddir, 'players')) && fs.readdirSync(path.join(olddir, 'players')).length === 2, 'it is written out in the new layout');
  // while one character plays, the record of one who is away is not written again and again
  const awayFile = path.join(olddir, 'players', 'away-token.json'), wrote = fs.statSync(awayFile).mtimeMs, n1 = (await post({ action: 'stats' })).saved;
  await post({ action: 'poll', token: j.token });
  await sleep(900);
  ok((await post({ action: 'stats' })).saved > n1, 'records that change keep being written');
  ok(fs.statSync(awayFile).mtimeMs === wrote, 'a record that did not change is not written again');
  ok(fs.readFileSync(old, 'utf8') === oldText, 'the older save itself is left untouched');
  await crash();
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** The socket's messages (client/js/wire.js): whatever the host packs, the page unpacks to the same view. */
function wire() {
  const tx = Wire.sender(), rx = Wire.receiver();
  const sorted = list => (list || []).slice().sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
  const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v;   // (the order of fields does not matter)
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const mon = (id, x, hp) => ({ id: id, ref: 'rat', x: x, y: 3, hp: hp, maxHp: 9, facing: 'E', statuses: hp < 9 ? ['burn'] : [], alert: undefined, look: undefined });
  const ply = (id, x) => ({ id: id, name: 'N' + id, 'class': 'warrior', equipment: { weapon: 'axe' }, hair: 'h', hairColor: '', body: '', skin: '', x: x, y: 1, facing: 'S', hp: 10, maxHp: 12, level: 2, act: '', wst: '', sn: 0 });
  const steps = [
    { player: { id: 'me', x: 1, y: 1, hp: 10, inventory: [{ item: 'a', qty: 1 }] }, world: { map: 'm', now: 1, states: { 'm.e1': 'open' }, structRev: 2, struct: { rev: 2, ents: [] }, monsters: [mon('a#0', 1, 9), mon('b#0', 2, 9)], players: [ply('p1', 4)] }, events: [{ seq: 1, type: 'info' }] },
    { player: { id: 'me', x: 2, y: 1, hp: 10, inventory: [{ item: 'a', qty: 1 }] }, world: { map: 'm', now: 2, states: { 'm.e1': 'open' }, structRev: 2, monsters: [mon('a#0', 1, 4), mon('b#0', 2, 9)], players: [ply('p1', 5)] } },
    { player: { id: 'me', x: 2, y: 1, hp: 8 }, world: { map: 'm', now: 3, states: {}, structRev: 2, monsters: [mon('b#0', 3, 9), mon('c#0', 7, 9)], players: [],
      floors: { m_z1: { structRev: 1, struct: { rev: 1, ents: [] }, states: {}, players: [ply('p1', 5)], monsters: [mon('u#0', 1, 9)] } } } },
    { player: { id: 'me', x: 2, y: 1, hp: 8 }, world: { map: 'n', now: 4, states: {}, structRev: 0, monsters: [], players: [ply('p2', 1)] } }
  ];
  let allSame = true, sizes = [], structs = [];
  steps.forEach((st, i) => {
    const text = Wire.pack(tx, { re: i + 1, player: st.player, world: st.world, events: st.events, seq: i });
    const got = Wire.unpack(rx, JSON.parse(text));
    sizes.push(text.length); structs.push(!!got.world.struct);
    const want = JSON.parse(JSON.stringify(st.world)), have = JSON.parse(JSON.stringify(got.world));
    [want, have].concat(Object.values(want.floors || {}), Object.values(have.floors || {})).forEach(w => { w.monsters = sorted(w.monsters); w.players = sorted(w.players); });
    const keys = o => { const out = {}; Object.keys(o).sort().forEach(k => { out[k] = o[k]; }); return out; };
    if (want.floors) Object.keys(want.floors).forEach(id => { want.floors[id] = keys(want.floors[id]); have.floors[id] = keys(have.floors[id]); });
    if (!same(keys(want), keys(have)) || !same(st.player, got.player) || !same(st.events || [], got.events)) { allSame = false; console.log('     step ' + (i + 1) + ' differs: want ' + JSON.stringify(keys(want)) + ' have ' + JSON.stringify(keys(have)) + ' player ' + JSON.stringify(got.player)); }
  });
  ok(allSame, 'what the host packs, the page unpacks to the same view (monsters, players, floors, own character)');
  ok(sizes[1] < sizes[0] / 3, 'the second message is a fraction of the first (' + sizes[0] + ' → ' + sizes[1] + ' bytes)');
  ok(structs.join() === 'true,false,false,false', 'the structure layer is handed over once');
  ok(Wire.pack(tx, { push: true, player: steps[3].player, world: Object.assign({}, steps[3].world, { now: 99 }), seq: 3 }) === '', 'a push with nothing new is not sent');
}

async function main() {
  wire();
  await saving();
  const up = await start('off');
  const out = up.text;
  ok(out.indexOf('Press Ctrl+C') >= 0, 'the host starts');
  ok(/turns a second/.test(out), 'it says how fast the world runs');

  // the old way still works: a plain POST
  const viaPost = await post({ action: 'join', name: 'Poster', 'class': '' });
  ok(viaPost.token && viaPost.player, 'join by POST');
  const loaded = await post({ action: 'load', token: viaPost.token });
  ok(loaded.world && Array.isArray(loaded.world.monsters), 'load by POST answers with the world');

  // the socket
  const a = client(); await a.open;
  const ja = await a.call({ action: 'join', name: 'Ann', 'class': '' });
  ok(ja.token && ja.re === 1, 'join by the socket (the answer carries the request number)');
  const la = await a.call({ action: 'load', token: ja.token });
  ok(la.world && la.world.map && la.player && la.player.name === 'Ann', 'load by the socket answers with the world');
  ok(typeof la.world.now === 'number' && Array.isArray(la.world.monsters) && Array.isArray(la.world.players), 'the answer has the whole view');
  const bad = await a.call({ action: 'act', token: 'nobody', 'do': { type: 'move', dirs: ['N'] } });
  ok(!!bad.error, 'an unknown character is refused, with the request number: ' + bad.error);
  await a.call({ action: 'poll', token: ja.token });

  const b = client(); await b.open;
  const jb = await b.call({ action: 'join', name: 'Bea', 'class': '' });
  await b.call({ action: 'load', token: jb.token });
  ok((b.world.players || []).some(q => q.name === 'Ann'), 'the second player sees the first in her answer');

  // Ann is told about Bea without asking
  for (let i = 0; i < 40 && !(a.world.players || []).some(q => q.name === 'Bea'); i++) await sleep(50);
  ok((a.world.players || []).some(q => q.name === 'Bea'), 'the first player is PUSHED the second, unasked');
  ok(a.pushes.length > 0 && a.pushes.every(p => typeof p.now === 'number' && typeof p.seq === 'number'), 'pushes carry the clock and the event count');

  // Bea moves: Ann sees it through a push; Bea's own answer has her new place
  const before = { x: b.player.x, y: b.player.y };
  let moved = null;
  for (const d of ['N', 'E', 'S', 'W']) {
    const r = await b.call({ action: 'act', token: jb.token, 'do': { type: 'move', dirs: [d] } });
    if (r.player.x !== before.x || r.player.y !== before.y) { moved = r.player; break; }
  }
  ok(!!moved, 'a move by the socket is answered with the new place');
  if (moved) {
    const there = () => (a.world.players || []).some(q => q.name === 'Bea' && q.x === moved.x && q.y === moved.y);
    for (let i = 0; i < 40 && !there(); i++) await sleep(50);
    ok(there(), 'the other player is pushed the move');
  }

  // quiet world = quiet socket: a push only carries what changed
  ok(a.pushes.length > 0 && a.pushes.every(p => !p.world || (!p.world.states && !p.world.map && !p.world.monsters && !p.world.players)), 'pushes leave out the parts of the view that did not change');
  const first = a.raw.filter(m => m.full)[0], moveMsg = a.pushes.filter(p => p.po && !p.pf)[0];
  ok(first && first.re === 2 && a.raw.filter(m => m.full).length === 1, 'only the first answer (the load) carries everything');
  ok(a.pushes.filter(p => p.pf).length === 1, 'how another player looks is sent once');
  ok(moveMsg && JSON.stringify(moveMsg).length < 200, 'a player who moves costs the others a few bytes, not her whole description (' + (moveMsg ? JSON.stringify(moveMsg).length : '?') + ' bytes)');
  const acts = b.raw.filter(m => m.re > 2 && m.now !== undefined);
  ok(acts.length > 0 && acts.every(m => !m.full && JSON.stringify(m).length < 600), 'the answer to a move is small too (' + Math.max.apply(null, acts.map(m => JSON.stringify(m).length)) + ' bytes at most)');
  const seqs = a.events.map(e => e.seq);
  ok(seqs.every((s, i) => seqs.indexOf(s) === i), 'no event is told twice (' + seqs.length + ' told)');

  // the loop runs with nobody asking
  const s1 = await post({ action: 'stats' });
  await sleep(500);
  const s2 = await post({ action: 'stats' });
  ok(s2.ticks - s1.ticks >= 5, 'the loop turns on its own (' + (s2.ticks - s1.ticks) + ' turns in half a second, slowest ' + s2.slowest.toFixed(1) + ' ms)');
  ok(s2.sockets === 2 && s2.players >= 2, 'the host counts its sockets and players');

  a.ws.close(); b.ws.close();
  await sleep(200);
  const s3 = await post({ action: 'stats' });
  ok(s3.sockets === 0, 'closed sockets are forgotten');
}

main().catch(e => { failed++; console.log('  FAIL ' + ((e && e.stack) || e)); })
  .then(() => {
    if (child) child.kill();
    console.log(failed ? '\n' + failed + ' FAILED' : '\nall host tests passed');
    process.exit(failed ? 1 : 0);
  });
