// ------------------------------------------------------------
//  Altare multiplayer test server
//  - Serves the game page (index.html)
//  - Runs a WebSocket server so two players can play noughts
//    and crosses together in real time
//  - Answers "ping" messages so the page can show the delay
// ------------------------------------------------------------

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';

// Altare tells us which port to use through the PORT variable.
// On your own computer it falls back to 3000.
const PORT = process.env.PORT || 3000;

// ---------- 1. A normal web server for the page ----------
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    const html = await readFile(new URL('./index.html', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404);
  res.end('Not found');
});

// ---------- 2. The WebSocket (live connection) server ----------
const wss = new WebSocketServer({ server });

// Every game "room" lives here, looked up by its room code.
const rooms = new Map();

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function newRoom() {
  return {
    players: { X: null, O: null },
    board: Array(9).fill(null),
    turn: 'X',
    winner: null,
    seenMoveIds: new Set(), // so a repeated/duplicate move is ignored
  };
}

function checkWinner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Tell both players what the board looks like now.
function broadcast(room) {
  for (const mark of ['X', 'O']) {
    send(room.players[mark], {
      type: 'state',
      you: mark,
      board: room.board,
      turn: room.turn,
      winner: room.winner,
      opponentHere: Boolean(room.players[mark === 'X' ? 'O' : 'X']),
    });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Latency check: send the time straight back.
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t });

    // A player joins a room.
    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase().slice(0, 12);
      if (!code) return;
      const room = rooms.get(code) || newRoom();
      rooms.set(code, room);

      const mark = !room.players.X ? 'X' : !room.players.O ? 'O' : null;
      if (!mark) return send(ws, { type: 'error', message: 'That room is full.' });

      room.players[mark] = ws;
      ws.roomCode = code;
      ws.mark = mark;
      return broadcast(room);
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    // A player makes a move.
    if (msg.type === 'move') {
      // Each move carries its own ID. If we've already handled
      // that ID (e.g. a double-click or a resend), do nothing.
      if (!msg.id || room.seenMoveIds.has(msg.id)) return;
      room.seenMoveIds.add(msg.id);

      const cell = Number(msg.cell);
      const ok =
        !room.winner &&
        room.turn === ws.mark &&
        Number.isInteger(cell) && cell >= 0 && cell < 9 &&
        !room.board[cell];
      if (!ok) return;

      room.board[cell] = ws.mark;
      room.winner = checkWinner(room.board);
      room.turn = ws.mark === 'X' ? 'O' : 'X';
      return broadcast(room);
    }

    // Start a new game in the same room.
    if (msg.type === 'reset') {
      room.board = Array(9).fill(null);
      room.turn = 'X';
      room.winner = null;
      room.seenMoveIds.clear();
      return broadcast(room);
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (room.players[ws.mark] === ws) room.players[ws.mark] = null;
    if (!room.players.X && !room.players.O) rooms.delete(ws.roomCode);
    else broadcast(room);
  });
});

// Every 30 seconds, check connections are still alive and
// drop any that have gone quiet (e.g. a phone lost signal).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

// Listen on 0.0.0.0 so Altare can reach the app.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Multiplayer test server running on port ${PORT}`);
});
