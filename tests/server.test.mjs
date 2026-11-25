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

test('nudges reach the opponent only; quick messages reach both; both are rate-limited', async (t) => {
  const port = PORT + 7, u = `ws://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const mk = () => { const ws = new WebSocket(u); const inbox = []; ws.on('message', (d) => inbox.push(JSON.parse(d))); return { ws, inbox, opened: new Promise((r) => ws.on('open', r)), send: (m) => ws.send(JSON.stringify(m)) }; };
  const a = mk(), b = mk(); await a.opened; await b.opened;
  a.send({ type: 'create' }); await wait(150);
  const room = a.inbox.find((m) => m.type === 'created').room;
  a.send({ type: 'join', room, key: 'key-alice-123', name: 'Alice' }); b.send({ type: 'join', room, key: 'key-bob-45678', name: 'Bob' }); await wait(200);
  assert.deepEqual(Object.values(b.inbox.filter((m) => m.type === 'state').pop().names).sort(), ['Alice', 'Bob']);
  a.inbox.length = 0; b.inbox.length = 0;
  a.send({ type: 'nudge' }); a.send({ type: 'nudge' }); a.send({ type: 'emote', code: 'gg' }); a.send({ type: 'emote', code: 'swear' });
  await wait(200);
  assert.equal(b.inbox.filter((m) => m.type === 'nudge').length, 1, 'one nudge arrives; the second is too soon');
  assert.equal(a.inbox.filter((m) => m.type === 'nudge').length, 0, 'you do not nudge yourself');
  assert.equal(a.inbox.filter((m) => m.type === 'emote' && m.text === 'GG WP').length, 1);
  assert.equal(b.inbox.filter((m) => m.type === 'emote').length, 1, 'unknown quick messages are dropped');
  a.ws.close(); b.ws.close();
});

test('a closed tab can get its seat back; a seat still in use cannot be taken', async (t) => {
  const port = PORT + 13, u = `ws://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const at = (o) => { const ws = new WebSocket(u, o); const inbox = []; ws.on('message', (d) => inbox.push(JSON.parse(d)));
    const next = async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await wait(20); } throw new Error('no ' + type); };
    return { ws, next, opened: new Promise((r) => ws.on('open', r)), send: (m) => ws.send(JSON.stringify(m)) }; };
  const a = at(), b = at(); await a.opened; await b.opened;
  a.send({ type: 'create' }); const { room } = await a.next('created');
  a.send({ type: 'join', room, key: 'alice-tab-one', name: 'Alice' }); const ja = await a.next('joined');
  assert.equal(ja.key, 'alice-tab-one');
  b.send({ type: 'join', room, key: 'bob-tab-1234', name: 'Bob' }); await b.next('joined');

  // Alice opens her own link again while her first tab is still open: refused, so she isn't kicked out.
  const a2 = at(); await a2.opened;
  a2.send({ type: 'join', room, key: 'brand-new-tab', resume: ['alice-tab-one'] });
  assert.equal((await a2.next('resume-failed')).room, room);
  a2.ws.close();

  // Alice closes her tab, then opens the link in a new one: she gets her own seat back.
  a.ws.close(); await wait(200);
  const a3 = at(); await a3.opened;
  a3.send({ type: 'join', room, key: 'another-new-tab', resume: ['alice-tab-one'] });
  const back = await a3.next('joined');
  assert.equal(back.seat, ja.seat); assert.equal(back.key, 'alice-tab-one'); assert.equal(back.rejoined, true);
  for (const c of [a3, b]) c.ws.close();
});
