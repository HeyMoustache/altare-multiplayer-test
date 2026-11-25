// ------------------------------------------------------------
//  Fortune's Gambit duel server (runs on Altare)
//  - Serves a bare 2D test page (index.html) so you can try duels
//    in two browser tabs
//  - Runs the WebSocket (live connection) server
//  - Acts as the referee: checks every move and rolls every battle
//    (the duel rules are in duel.js, the game rules in rules.js)
// ------------------------------------------------------------

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createDuel, joinDuel, seatFor, cleanName, handleAction, stateFor, rematchDuel, bothSeated, makeCode, EMOTES } from './duel.js';

// Altare tells us which port to use through the PORT variable.
// On your own computer it falls back to 3000.
const PORT = process.env.PORT || 3000;

// How long a player can be gone before their opponent wins (milliseconds).
const RECONNECT_GRACE = 60_000;
// Empty duels are tidied away after this long.
const EMPTY_ROOM_LIFETIME = 15 * 60_000;
// Safety limit so the free server can't be flooded with rooms.
const MAX_ROOMS = 500;
// Nudges and quick comms can't be spammed: one nudge every 20 seconds, one quick message every 3.
const NUDGE_GAP = 20_000, EMOTE_GAP = 3_000;
const MAX_WATCHERS = 20; // people watching one duel (on top of its two players)

// Which web pages may connect. The game's own site, this server's own test
// page, and your computer while testing. Add more, comma-separated, in an
// ALLOWED_ORIGINS setting on Altare if you ever need to.
const ALLOWED = [
  'https://martinsnelling.com',
  'https://www.martinsnelling.com',
  'https://gambit.martinsnelling.com',
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
];
function originAllowed(origin, host) {
  if (!origin) return true; // not a browser (e.g. a test script)
  if (ALLOWED.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    if (u.host === host) return true; // this server's own test page
  } catch { /* not a valid origin */ }
  return false;
}

// ---------- 1. A normal web server for the test page ----------
const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (path === '/' || path === '/index.html') {
    const html = await readFile(new URL('./index.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(html);
  }
  res.writeHead(404);
  res.end('Not found');
});

// ---------- 2. The WebSocket (live connection) server ----------
const wss = new WebSocketServer({
  server,
  maxPayload: 4096, // duel messages are tiny; refuse anything big
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
});

// Every duel lives here, looked up by its room code.
// room = { duel, sockets: {w, b}, watchers: Set of connections, leaveTimers: {w, b}, emptySince }
const rooms = new Map();

const isOpen = (ws) => Boolean(ws && ws.readyState === ws.OPEN);
function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function present(room) {
  return { w: Boolean(room.sockets.w), b: Boolean(room.sockets.b) };
}
// Everyone in the room: the two players and any watchers.
function everyone(room) { return [room.sockets.w, room.sockets.b, ...room.watchers].filter(Boolean); }
function stateMsg(room, seat) { return { ...stateFor(room.duel, seat, present(room)), watchers: room.watchers.size }; }
// Send each player the whole board, from their own point of view; watchers get the neutral view.
function broadcast(room) {
  for (const seat of ['w', 'b']) send(room.sockets[seat], stateMsg(room, seat));
  if (room.watchers.size) { const view = stateMsg(room, null); for (const w of room.watchers) send(w, view); }
}
function newSeed() { return randomBytes(6).toString('hex'); }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    // Delay meter: send the time straight back.
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t });

    // Make a new duel room and hand back its code.
    if (msg.type === 'create') {
      if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: 'The server is busy. Please try again later.' });
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      rooms.set(code, { duel: createDuel({ code, seed: newSeed() }), sockets: { w: null, b: null }, watchers: new Set(), leaveTimers: {}, emptySince: Date.now() });
      return send(ws, { type: 'created', room: code });
    }

    // Join (or rejoin) a duel. The key is the browser's secret ticket for its seat.
    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase().slice(0, 12);
      const key = typeof msg.key === 'string' && msg.key.length >= 8 ? msg.key.slice(0, 64) : null;
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'There is no duel with that code. Check the link, or create a new duel.' });
      if (!key) return send(ws, { type: 'error', message: 'Missing player key.' });
      // A new tab on a device that played this duel offers the seat keys it remembers.
      // Hand back whichever of those seats isn't in use right now (the tab was closed or dropped).
      const offered = Array.isArray(msg.resume) ? msg.resume.filter((k) => typeof k === 'string' && k.length >= 8).slice(0, 2) : [];
      let useKey = key;
      if (offered.length && !seatFor(room.duel, key)) {
        const free = offered.find((k) => { const s = seatFor(room.duel, k); return s && !isOpen(room.sockets[s]); });
        if (free) useKey = free;
        else if (offered.some((k) => seatFor(room.duel, k))) return send(ws, { type: 'resume-failed', room: code });
      }
      const name = typeof msg.name === 'string' ? msg.name : '';
      // Coming back to your own seat (keepName) keeps the name you already have in this duel.
      const joined = joinDuel(room.duel, useKey, Math.random, msg.keepName && seatFor(room.duel, useKey) ? '' : name);
      if (joined.error) {
        // Both seats are taken, so this person watches instead.
        if (!bothSeated(room.duel)) return send(ws, { type: 'error', message: joined.error });
        if (room.watchers.size >= MAX_WATCHERS && !room.watchers.has(ws)) return send(ws, { type: 'error', message: 'This duel already has the most watchers it can take.' });
        room.watchers.add(ws);
        ws.roomCode = code; ws.seat = null; ws.watchName = cleanName(name, 'A watcher');
        room.emptySince = null;
        send(ws, { type: 'joined', room: code, seat: null, watching: true });
        return broadcast(room);
      }
      const seat = joined.seat;
      room.watchers.delete(ws);
      // If this seat was already connected in another tab or an old connection, replace it.
      if (room.sockets[seat] && room.sockets[seat] !== ws) room.sockets[seat].close(4000, 'Replaced by a newer connection');
      room.sockets[seat] = ws;
      clearTimeout(room.leaveTimers[seat]);
      room.emptySince = null;
      ws.roomCode = code;
      ws.seat = seat;
      send(ws, { type: 'joined', room: code, seat, rejoined: joined.rejoined, key: useKey });
      return broadcast(room);
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const watching = room.watchers.has(ws);
    if (!watching && room.sockets[ws.seat] !== ws) return;
    // Watchers can send quick messages, but nothing else: no moves, nudges or resigning.
    if (watching && msg.type !== 'emote') return;

    // A nudge goes to the opponent only; a quick message pops up on both screens.
    if (msg.type === 'nudge' || msg.type === 'emote') {
      const now = Date.now(), gap = msg.type === 'nudge' ? NUDGE_GAP : EMOTE_GAP;
      ws.lastSent = ws.lastSent || {};
      if (now - (ws.lastSent[msg.type] || 0) < gap) return send(ws, { type: 'error', message: msg.type === 'nudge' ? 'You can nudge once every 20 seconds.' : 'Slow down a little!' });
      if (msg.type === 'emote' && !EMOTES[msg.code]) return;
      ws.lastSent[msg.type] = now;
      const other = ws.seat === 'w' ? 'b' : 'w';
      const out = { type: msg.type, from: watching ? 'watch' : ws.seat, name: watching ? ws.watchName : room.duel.names[ws.seat], code: msg.code, text: EMOTES[msg.code] };
      if (msg.type === 'nudge') send(room.sockets[other], out);
      else for (const c of everyone(room)) send(c, out);
      return;
    }

    // Moves, attacks, blessings, resigning and rematches all go to the referee.
    if (['move', 'challenge', 'bless', 'resign', 'rematch'].includes(msg.type)) {
      const outcome = handleAction(room.duel, ws.seat, msg);
      if (outcome.duplicate) return; // already handled this exact action
      if (outcome.error) {
        send(ws, { type: 'error', message: outcome.error });
        return send(ws, stateFor(room.duel, ws.seat, present(room))); // put their board right
      }
      if (outcome.restart) {
        room.duel = rematchDuel(room.duel, newSeed());
        // Sides are swapped, so swap the connections too.
        room.sockets = { w: room.sockets.b, b: room.sockets.w };
        for (const s of ['w', 'b']) if (room.sockets[s]) { room.sockets[s].seat = s; send(room.sockets[s], { type: 'joined', room: room.duel.code, seat: s, rematch: true }); }
        for (const w of room.watchers) send(w, { type: 'joined', room: room.duel.code, seat: null, watching: true, rematch: true });
      }
      // Both players see the battle result first, then the new board.
      if (outcome.battle) for (const c of everyone(room)) send(c, { type: 'battle', ...outcome.battle });
      return broadcast(room);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (room.watchers.delete(ws)) { if (!room.sockets.w && !room.sockets.b && !room.watchers.size) room.emptySince = Date.now(); return broadcast(room); }
    if (room.sockets[ws.seat] !== ws) return;
    const seat = ws.seat;
    room.sockets[seat] = null;
    if (!room.sockets.w && !room.sockets.b && !room.watchers.size) room.emptySince = Date.now();
    broadcast(room);
    // Give them a minute to come back. If they don't, the player still here wins.
    const duel = room.duel;
    if (bothSeated(duel) && !duel.status.over) {
      clearTimeout(room.leaveTimers[seat]);
      room.leaveTimers[seat] = setTimeout(() => {
        if (room.sockets[seat] || room.duel !== duel || duel.status.over) return;
        const other = seat === 'w' ? 'b' : 'w';
        duel.status = { over: true, winner: other, reason: `${seat === 'w' ? 'Dawn' : 'Dusk'} left the duel.` };
        broadcast(room);
      }, RECONNECT_GRACE);
    }
  });
});

// Every 30 seconds, check connections are still alive and drop any that
// have gone quiet (e.g. a phone lost signal), and tidy up empty duels.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_LIFETIME) rooms.delete(code);
  }
}, 30_000);

// Listen on 0.0.0.0 so Altare can reach the app.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Fortune's Gambit duel server running on port ${PORT}`);
});
