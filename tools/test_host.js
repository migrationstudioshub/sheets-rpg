/**
 * Tests for the host's loop and socket (host/server.js): starts a real host on the starting content, with nothing
 * saved, and talks to it the way the game page does.
 *   node tools/test_host.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
let failed = 0, child = null;
function ok(cond, what) { if (cond) console.log('  ok   ' + what); else { failed++; console.log('  FAIL ' + what); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A page's side of the socket: call(body) → the answer; pushes pile up in .pushes, merged into .world like the page does. */
function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/');
  const c = { ws, n: 0, waiting: {}, pushes: [], world: null, player: null, events: [] };
  ws.onmessage = m => {
    const msg = JSON.parse(m.data);
    if (msg.push) {
      c.pushes.push(msg);
      const w = Object.assign({}, c.world), d = msg.world || {};
      Object.keys(d).forEach(k => { if (d[k] === null) delete w[k]; else w[k] = d[k]; });
      c.world = w;
      if (msg.player) c.player = msg.player;
      (msg.events || []).forEach(e => c.events.push(e));
      return;
    }
    const wait = c.waiting[msg.re]; delete c.waiting[msg.re];
    if (msg.world) { c.world = msg.world; c.player = msg.player; }
    (msg.events || []).forEach(e => c.events.push(e));
    if (wait) wait(msg);
  };
  c.open = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('socket would not open')); });
  c.call = body => new Promise(res => { const n = ++c.n; c.waiting[n] = res; ws.send(JSON.stringify(Object.assign({ n }, body))); });
  return c;
}
async function post(body) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

async function main() {
  child = spawn(process.execPath, [path.join(ROOT, 'host', 'server.js')],
    { env: Object.assign({}, process.env, { PORT: String(PORT), CONTENT: 'local', SAVE_FILE: 'off', TICK_MS: '50', LAG_MS: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && out.indexOf('Press Ctrl+C') < 0; i++) await sleep(100);
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
  const small = a.pushes.filter(p => p.world && !p.world.states && !p.world.map);
  ok(small.length > 0, 'pushes leave out the parts of the view that did not change');
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
