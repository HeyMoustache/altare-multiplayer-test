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

test('a third person watches: sees the board and battles, can react, but cannot play', async (t) => {
  const port = PORT + 19, u = `ws://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const at = () => { const ws = new WebSocket(u); const inbox = []; ws.on('message', (d) => inbox.push(JSON.parse(d)));
    const next = async (type) => { for (let i = 0; i < 100; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await wait(20); } throw new Error('no ' + type); };
    return { ws, inbox, next, opened: new Promise((r) => ws.on('open', r)), send: (m) => ws.send(JSON.stringify(m)) }; };
  const a = at(), b = at(), v = at(); await a.opened; await b.opened; await v.opened;
  a.send({ type: 'create' }); const { room } = await a.next('created');
  a.send({ type: 'join', room, key: 'alice-key-1', name: 'Alice' }); const ja = await a.next('joined');
  b.send({ type: 'join', room, key: 'bob-key-123', name: 'Bob' }); await b.next('joined');
  v.send({ type: 'join', room, key: 'viv-key-123', name: 'Viv' });
  const jv = await v.next('joined');
  assert.equal(jv.watching, true); assert.equal(jv.seat, null); assert.equal(jv.key, undefined);
  const sv = await v.next('state');
  assert.equal(sv.you, null); assert.deepEqual(sv.legal, []); assert.equal(sv.watchers, 1);
  assert.equal(sv.names.w === 'Alice' || sv.names.b === 'Alice', true);
  await wait(100); for (const c of [a, b, v]) c.inbox.length = 0;

  // The watcher can't move, even on the right turn.
  v.send({ type: 'move', from: 'e2', to: 'e4', id: 'v1' }); v.send({ type: 'resign', id: 'v2' });
  await wait(200); assert.equal(v.inbox.filter((m) => m.type === 'state').length, 0, 'nothing happened');

  const white = ja.seat === 'w' ? a : b, black = white === a ? b : a;
  white.send({ type: 'move', from: 'e2', to: 'e4', id: 'm1' }); await v.next('state');
  black.send({ type: 'move', from: 'd7', to: 'd5', id: 'm2' }); await v.next('state');
  white.send({ type: 'challenge', from: 'e4', to: 'd5', id: 'm3' });
  const bw = await white.next('battle'), bv = await v.next('battle');
  assert.deepEqual(bw.result, bv.result, 'the watcher sees the same battle');

  // A reaction from the watcher reaches everyone, with their name.
  v.send({ type: 'emote', code: 'gg' });
  const e = await a.next('emote'); assert.equal(e.from, 'watch'); assert.equal(e.name, 'Viv');

  // When the watcher leaves, the players see the count drop.
  await wait(100); a.inbox.length = 0;
  v.ws.close();
  const after = await a.next('state'); assert.equal(after.watchers, 0);
  for (const c of [a, b]) c.ws.close();
});

test('turn timer through the live server: the creator picks it and the turn passes on', async (t) => {
  const port = PORT + 23, u = `ws://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const at = () => { const ws = new WebSocket(u); const inbox = []; ws.on('message', (d) => inbox.push(JSON.parse(d)));
    const next = async (type, tries = 100) => { for (let i = 0; i < tries; i++) { const k = inbox.findIndex((m) => m.type === type); if (k >= 0) return inbox.splice(k, 1)[0]; await wait(20); } throw new Error('no ' + type); };
    return { ws, inbox, next, opened: new Promise((r) => ws.on('open', r)), send: (m) => ws.send(JSON.stringify(m)) }; };
  const a = at(), b = at(); await a.opened; await b.opened;
  a.send({ type: 'create', timer: 999 });               // not an allowed length -> off
  assert.equal((await a.next('created')).timer, 0);
  a.send({ type: 'create', timer: 30 });
  const { room, timer } = await a.next('created'); assert.equal(timer, 30);
  a.send({ type: 'join', room, key: 'alice-key-1' }); await a.next('joined');
  b.send({ type: 'join', room, key: 'bob-key-123' }); await b.next('joined');
  await wait(100);
  const s = a.inbox.filter((m) => m.type === 'state').pop();
  assert.equal(s.timer, 30); assert.ok(s.turnLeft > 29_000 && s.turnLeft <= 30_000, 'the clock started when the second player sat down');
  for (const c of [a, b]) c.ws.close();
});

test('the server page forwards visitors (and old invite links) to the game', async (t) => {
  const port = PORT + 29;
  const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, cwd: new URL('..', import.meta.url) });
  t.after(() => srv.kill());
  await wait(600);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /https:\/\/martinsnelling\.com\/gambit\//);
  assert.match(html, /q\.get\('duel'\) \|\| q\.get\('room'\)/);
  assert.ok(!html.includes('WebSocket'), 'the old 2D test client is gone');
});
