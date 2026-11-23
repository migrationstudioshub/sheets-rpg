/**
 * A crowd of scripted players for the host (host/server.js): how does it hold up with many on one map?
 *
 *   node tools/bots.js                 # 30 bots for 20 s on a throwaway host with the starting content
 *   node tools/bots.js --n 60 --secs 30
 *   node tools/bots.js --live          # the throwaway host plays the live content instead (read-only, as always)
 *   node tools/bots.js --lag 100       # with 100 ms of pretend lag each way
 *   node tools/bots.js --url ws://localhost:3000   # a host that is already running — its game gets the bots' characters!
 *
 * Each bot plays the way the page does: one socket, one request on its way at a time; it walks about, changing
 * direction now and then, and hits a monster that is next to it. Nothing is saved by the throwaway host.
 *
 * It prints how long answers took, how much each bot was sent, and how hard the host's loop worked. With
 * --json it prints only those numbers, as JSON (tools/test_host.js reads that).
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const Wire = require('../client/js/wire.js');

const args = process.argv.slice(2);
function opt(name, dflt) { const i = args.indexOf('--' + name); return i < 0 ? dflt : (args[i + 1] === undefined || /^--/.test(args[i + 1]) ? true : args[i + 1]); }
const N = Number(opt('n', 30)), SECS = Number(opt('secs', 20)), URL_ = opt('url', ''), LIVE = !!opt('live', false), LAG = Number(opt('lag', 0)) || 0, JSON_OUT = !!opt('json', false);
const ROOT = path.join(__dirname, '..');
const PORT = 3800 + Math.floor(Math.random() * 90);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = s => { if (!JSON_OUT) console.log(s); };

let child = null;
async function startHost() {
  const env = Object.assign({}, process.env, { PORT: String(PORT), SAVE_FILE: 'off', LAG_MS: LAG ? String(LAG) : '' });
  if (!LIVE) env.CONTENT = 'local';
  child = spawn(process.execPath, [path.join(ROOT, 'host', 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', d => { text += d; });
  child.stderr.on('data', d => { text += d; });
  for (let i = 0; i < 300 && text.indexOf('Press Ctrl+C') < 0; i++) await sleep(100);
  if (text.indexOf('Press Ctrl+C') < 0) throw new Error('the host did not start:\n' + text);
  return 'ws://127.0.0.1:' + PORT;
}

const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
function bot(url, i, until, tally) {
  return new Promise(resolve => {
    const ws = new WebSocket(url + '/');
    const b = { n: 0, waiting: {}, held: Wire.receiver(), player: null, mon: [], token: '', dir: 'NESW'[i % 4] };
    const call = body => new Promise(res => { const n = ++b.n; b.waiting[n] = { res: res, t: performance.now() }; ws.send(JSON.stringify(Object.assign({ n: n }, body))); });
    ws.onerror = () => { tally.errors++; resolve(); };
    ws.onclose = () => resolve();
    ws.onmessage = m => {
      tally.bytes += m.data.length;
      const msg = JSON.parse(m.data);
      // keep what the page keeps: the messages only carry what changed (client/js/wire.js)
      if (msg.now !== undefined && !msg.error) { const whole = Wire.unpack(b.held, msg); b.player = whole.player; b.mon = whole.world.monsters; }
      if (msg.push) { tally.pushes++; return; }
      const wait = b.waiting[msg.re]; delete b.waiting[msg.re];
      if (wait) { tally.ms.push(performance.now() - wait.t); wait.res(msg); }
    };
    ws.onopen = async () => {
      try {
        const j = await call({ action: 'join', name: 'Bot' + (i + 1), 'class': '' });
        b.token = j.token;
        await call({ action: 'load', token: b.token });
        await sleep(Math.random() * 300);
        while (Date.now() < until) {
          const me = b.player, near = b.mon.filter(q => Math.abs(q.x - me.x) + Math.abs(q.y - me.y) === 1)[0];
          let act;
          if (near && Math.random() < 0.7) act = { type: 'attack', x: near.x, y: near.y };
          else { if (Math.random() < 0.2) b.dir = 'NESW'[Math.floor(Math.random() * 4)]; act = { type: 'move', dirs: [b.dir] }; }
          const before = me.x + ',' + me.y;
          const r = await call({ action: 'act', token: b.token, 'do': act });
          tally.acts++;
          if (r.error) tally.refused++;
          else if (act.type === 'move' && b.player.x + ',' + b.player.y === before) b.dir = 'NESW'[Math.floor(Math.random() * 4)];   // a wall: turn
          await sleep(140 + Math.random() * 120);
        }
      } catch (e) { tally.errors++; }
      ws.close();
    };
  });
}

async function stats(url) {
  const r = await fetch(url.replace(/^ws/, 'http') + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stats' }) });
  return r.json();
}
function pct(list, p) { if (!list.length) return 0; const s = list.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

async function main() {
  const url = URL_ || await startHost();
  say('\n  ' + N + ' bots for ' + SECS + ' s on ' + (URL_ ? url : 'a throwaway host (' + (LIVE ? 'live' : 'starting') + ' content' + (LAG ? ', ' + LAG + ' ms lag each way' : '') + ')') + ' ...');
  const tally = { ms: [], bytes: 0, pushes: 0, acts: 0, refused: 0, errors: 0 };
  const s0 = await stats(url), t0 = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => bot(url, i, t0 + SECS * 1000, tally)));
  const secs = (Date.now() - t0) / 1000, s1 = await stats(url);
  const ticks = s1.ticks - s0.ticks;
  const out = {
    bots: N, seconds: Math.round(secs), actions: tally.acts, refused: tally.refused, errors: tally.errors,
    answerMs: { half: Math.round(pct(tally.ms, 0.5)), most: Math.round(pct(tally.ms, 0.95)), worst: Math.round(pct(tally.ms, 1)) },
    kbPerBotPerSec: +(tally.bytes / 1024 / N / secs).toFixed(2), kbPerSecAll: +(tally.bytes / 1024 / secs).toFixed(1),
    pushesPerBotPerSec: +(tally.pushes / N / secs).toFixed(1),
    turnsPerSec: +(ticks / secs).toFixed(1), turnMs: { usual: +(((s1.busy || 0) - (s0.busy || 0)) / Math.max(1, ticks)).toFixed(2), worst: +(s1.slowest || 0).toFixed(1) }
  };
  if (JSON_OUT) console.log(JSON.stringify(out));
  else {
    say('  Actions sent:        ' + out.actions + (out.refused ? ' (' + out.refused + ' refused)' : '') + (out.errors ? '  ERRORS: ' + out.errors : ''));
    say('  Answer time:         half within ' + out.answerMs.half + ' ms, 95% within ' + out.answerMs.most + ' ms, worst ' + out.answerMs.worst + ' ms');
    say('  Sent to each bot:    ' + out.kbPerBotPerSec + ' kB a second (' + out.pushesPerBotPerSec + ' pushes a second)');
    say('  Sent by the host:    ' + out.kbPerSecAll + ' kB a second in all (' + (out.kbPerSecAll * 8 / 1000).toFixed(2) + ' Mbit/s of upload)');
    say('  The loop:            ' + out.turnsPerSec + ' turns a second; a turn took ' + out.turnMs.usual + ' ms as a rule, ' + out.turnMs.worst + ' ms at worst\n');
  }
}
main().catch(e => { console.error((e && e.stack) || e); process.exitCode = 1; }).then(() => { if (child) child.kill(); process.exit(process.exitCode || 0); });
