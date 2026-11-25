// Starts the real server on a spare port and plays a few moves through two live connections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3900 + Math.floor(Math.random() * 90);
const url = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(origin) {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d)));
  const next = async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await wait(20); } throw new Error('no ' + type); };
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { ws, inbox, next, opened, send: (m) => ws.send(JSON.stringify(m)) };
}

test('two players can create, join and play through the live server', async (t) => {
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const res = await fetch(`http://127.0.0.1:${PORT}/health`); assert.equal(await res.text(), 'ok');

  const a = client(), b = client();
  await a.opened; await b.opened;
  a.send({ type: 'create' });
  const { room } = await a.next('created');
  a.send({ type: 'join', room, key: 'key-alice-123' });
  const ja = await a.next('joined');
  b.send({ type: 'join', room, key: 'key-bob-45678' });
  const jb = await b.next('joined');
  assert.notEqual(ja.seat, jb.seat);
  const white = ja.seat === 'w' ? a : b, black = ja.seat === 'w' ? b : a;
  await wait(100); white.inbox.length = 0; black.inbox.length = 0;

  white.send({ type: 'move', from: 'e2', to: 'e4', id: 'm1' });
  white.send({ type: 'move', from: 'e2', to: 'e4', id: 'm1' });   // a double-tap
  const s1 = await black.next('state');
  assert.equal(s1.turn, 'b'); assert.ok(s1.pieces.some((p) => p.square === 'e4'));
  black.send({ type: 'move', from: 'd7', to: 'd5', id: 'm2' }); await black.next('state');
  white.send({ type: 'challenge', from: 'e4', to: 'd5', id: 'm3' });
  const bw = await white.next('battle'), bb = await black.next('battle');
  assert.deepEqual(bw.result, bb.result, 'both players see the same battle result');
  await wait(100);
  const last = black.inbox.filter((m) => m.type === 'state').pop();
  assert.equal(last.moveCount, 3, 'the double-tap was ignored');

  // A web page from another site is refused.
  const stranger = client('https://evil.example');
  await assert.rejects(stranger.opened);
  for (const c of [a, b]) c.ws.close();
});
