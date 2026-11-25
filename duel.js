// ------------------------------------------------------------
//  Fortune's Gambit: the duel referee
//  Everything about ONE duel: the board, whose turn it is, checking
//  moves, rolling battles, and deciding who has won.
//  There is no network code here (that's in server.js), so this file
//  can be tested on its own.
//
//  The game rules themselves come from rules.js, which is an exact copy
//  of rules.js from the game. If you change a rule in the game, copy the
//  new rules.js into this folder too, so the referee and the game agree.
// ------------------------------------------------------------

import * as R from './rules.js';

// Room codes avoid letters that are easy to mix up (O/0, I/1, L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeCode(rand = Math.random, length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return code;
}

const otherSide = (seat) => (seat === 'w' ? 'b' : 'w');
const SIDE_NAME = { w: 'Dawn', b: 'Dusk' };

// Turn timer choices, in seconds (0 = no timer). Run out of time and your turn is
// skipped; run out MAX_MISSED turns in a row and you lose the duel.
export const TIMER_CHOICES = [0, 30, 60, 120];
export const MAX_MISSED = 3;
export const cleanTimer = (t) => (TIMER_CHOICES.includes(Number(t)) ? Number(t) : 0);

// A brand-new duel: the standard starting army for both sides, no relics.
export const DUEL_MODES = ['draft', 'plain'];
// The game's lobby asks for 'draft' by default; anything that doesn't say (like the old 2D
// test page) gets a plain duel.
export const cleanMode = (m) => (DUEL_MODES.includes(m) ? m : 'plain');

export function createDuel({ code, seed, timer = 0, mode = 'plain' }) {
  const chess = new R.BattleChess();
  const pieces = new Map();
  for (const [square, p] of chess.board) pieces.set(square, R.makePiece(p.type, p.color, square));
  return {
    code,
    seed,                                        // the duel's dice seed: same seed = same battles
    rng: R.makeRng(R.hashSeed('duel:' + seed)),
    chess,
    pieces,
    seats: { w: null, b: null },                 // each seat holds the player's secret key
    seenIds: new Set(),                          // every move ID already handled (ignore repeats)
    status: { over: false, winner: null, reason: null },
    history: [],                                 // every action, in order, for replays and bug hunts
    lastBattle: null,
    battleCount: 0,
    rematch: { w: false, b: false },
    names: { w: '', b: '' },                     // the names players typed in
    timer: cleanTimer(timer),                    // seconds per turn (0 = off)
    deadline: null,                              // when the current turn runs out (ms clock), or null
    missed: { w: 0, b: 0 },                      // turns in a row each side has run out of time
    mode: cleanMode(mode),                       // 'draft' (pick boons first) or 'plain'
    // Draft duels: both players are offered the same boons and each picks some before play starts.
    draft: cleanMode(mode) === 'draft' ? { offer: R.dealBoons(R.makeRng(R.hashSeed('boons:' + seed))), picks: { w: null, b: null } } : null,
    momentum: { w: 0, b: 0 },                    // Battle Fervour streaks (only counted for a side that picked it)
  };
}

// Still choosing boons? Nobody can move until both players have picked.
export const inDraft = (duel) => Boolean(duel.draft && !(duel.draft.picks.w && duel.draft.picks.b));
const boonsOf = (duel, color) => new Set(!inDraft(duel) && duel.draft?.picks[color] || []);

// Start (or restart) the clock for whoever's turn it is now. The clock only runs
// once both players are in and the duel isn't over.
export function startTurnClock(duel, now = Date.now()) {
  duel.deadline = duel.timer && bothSeated(duel) && !duel.status.over && !inDraft(duel) ? now + duel.timer * 1000 : null;
}

// Called by the server when the clock may have run out. If it has, the turn passes
// to the other side (or, after MAX_MISSED in a row, that side loses). Returns true if
// something changed.
export function checkTurnClock(duel, now = Date.now()) {
  if (!duel.deadline || now < duel.deadline || duel.status.over) return false;
  const seat = duel.chess.turn();
  duel.missed[seat]++;
  if (duel.missed[seat] >= MAX_MISSED) {
    duel.status = { over: true, winner: otherSide(seat), reason: `${SIDE_NAME[seat]} ran out of time ${MAX_MISSED} turns in a row.` };
    record(duel, { type: 'timeout', seat, lost: true });
    duel.deadline = null;
    return true;
  }
  // A skipped turn isn't a real move: it mustn't count towards "the same position three times"
  // or the 50-turn rule, or two players who both walk away would end in a draw instead of a loss.
  const halfmove = duel.chess.halfmove;
  duel.chess.pass();
  duel.chess.halfmove = halfmove;
  const key = duel.chess.key(), seen = duel.chess.positions.get(key) || 0;
  if (seen > 1) duel.chess.positions.set(key, seen - 1); else duel.chess.positions.delete(key);
  record(duel, { type: 'timeout', seat, missed: duel.missed[seat] });
  checkForEnd(duel);
  startTurnClock(duel, now);
  return true;
}

// Player names: plain text, at most 20 characters, no control characters.
export function cleanName(name, fallback) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return clean || fallback;
}

// Quick comms: a fixed set of messages, so there is no free typing to moderate.
export const EMOTES = { wp: 'Well played!', ouch: 'Ouch!', gg: 'GG WP', oops: 'Oops!' };

// In a plain duel there are no relics and no Momentum: both sides are equal.
const ctxFor = (duel) => ({
  pieceAt: (sq) => duel.pieces.get(sq),
  relics: (color) => boonsOf(duel, color),
  momentum: (color) => (boonsOf(duel, color).has('fervour') ? duel.momentum[color] : 0),
});

export function seatFor(duel, key) {
  if (!key) return null;
  return duel.seats.w === key ? 'w' : duel.seats.b === key ? 'b' : null;
}

// A player arrives. The first player gets a random side; the second gets the other.
// Coming back with the same key puts you back in your own seat.
export function joinDuel(duel, key, rand = Math.random, name = '') {
  const existing = seatFor(duel, key);
  if (existing) { if (name) duel.names[existing] = cleanName(name, duel.names[existing]); return { seat: existing, rejoined: true }; }
  const free = ['w', 'b'].filter((s) => !duel.seats[s]);
  if (!free.length) return { error: 'That duel already has two players.' };
  const seat = free.length === 2 ? (rand() < 0.5 ? 'w' : 'b') : free[0];
  duel.seats[seat] = key;
  duel.names[seat] = cleanName(name, SIDE_NAME[seat] + ' player');
  return { seat, rejoined: false };
}

export const bothSeated = (duel) => Boolean(duel.seats.w && duel.seats.b);

// Percentages that always add up to 100 (same rounding as the game's odds bar).
function percents(f) {
  const [victory, repelled, slain] = R.roundPercents([f.odds.victory, f.odds.repelled, f.odds.slain]);
  return { victory, repelled, slain };
}

function forecastFor(duel, m) {
  const f = R.battleForecast(m, ctxFor(duel));
  if (!f) return null;
  return {
    ...percents(f),
    might: f.attackerStats.might,
    guard: f.defenderStats.guard,
    base: Math.round(f.base * 100),
    adjustments: f.adjustments.map((a) => ({ name: a.name, amount: Math.round(a.amount * 100) })),
    winWound: Math.round(f.winWound * 100),
    lastWound: f.attackerStats.hp <= 1,
    kingWarning: duel.chess.failureExposesKing(m),
    enPassant: m.flags.includes('e'),
    defenderSquare: R.defenderSquare(m),
  };
}

// Every legal move for the side to move, with battle odds for every attack.
// Pawns always promote to a queen (as in single player), so only those are listed.
export function legalMoves(duel) {
  if (duel.status.over || !bothSeated(duel)) return [];
  return duel.chess.moves({ verbose: true })
    .filter((m) => !m.promotion || m.promotion === 'q')
    .map((m) => {
      const capture = Boolean(m.captured || m.flags.includes('e'));
      return { from: m.from, to: m.to, piece: m.piece, flags: m.flags, capture, odds: capture ? forecastFor(duel, m) : null };
    });
}

// Which allies each of a side's bishops could bless right now.
export function blessOptions(duel, seat) {
  const out = {};
  for (const [sq, p] of duel.pieces) {
    if (p.color !== seat || p.type !== 'b' || p.blessUsed) continue;
    const targets = R.blessTargets(sq, p.color, (s) => duel.pieces.get(s));
    if (targets.length) out[sq] = targets;
  }
  return out;
}

function checkForEnd(duel) {
  const result = R.boardOutcome(duel.chess, duel.pieces);   // written from Dawn's ('w') point of view
  if (result === 'ongoing') return;
  if (result === 'draw') {
    const c = duel.chess;
    const reason = c.isStalemate() ? 'stalemate' : c.isInsufficientMaterial() ? 'too few pieces to checkmate'
      : c.halfmove >= 100 ? '50 turns without a pawn move or capture' : 'the same position three times';
    duel.status = { over: true, winner: null, reason: `Draw: ${reason}.` };
    return;
  }
  const winner = result === 'player-won' ? 'w' : 'b';
  const kingGone = ![...duel.pieces.values()].some((p) => p.type === 'k' && p.color === otherSide(winner));
  duel.status = { over: true, winner, reason: kingGone ? `${SIDE_NAME[winner]} slew the enemy king.` : `Checkmate by ${SIDE_NAME[winner]}.` };
}

// Every action is numbered, so a browser can tell exactly which ones it has already shown.
function record(duel, entry) { duel.history.push({ n: duel.history.length + 1, ...entry }); }

// Handle one action from a player. Returns {error}, {duplicate:true}, or {ok:true, battle?}.
// Every action must carry a unique `id`; an id that has been seen before is ignored,
// so a double-tap or a resend after lag can never make two moves or roll two battles.
export function handleAction(duel, seat, msg) {
  if (!seat) return { error: 'You are not seated in this duel.' };
  if (msg.type === 'rematch') return requestRematch(duel, seat);
  const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : '';
  if (!id) return { error: 'Every action needs an id.' };
  if (duel.seenIds.has(id)) return { duplicate: true };
  duel.seenIds.add(id);

  if (duel.status.over) return { error: 'This duel is over.' };
  if (!bothSeated(duel)) return { error: 'Waiting for your opponent to join.' };

  if (msg.type === 'resign') {
    duel.status = { over: true, winner: otherSide(seat), reason: `${SIDE_NAME[seat]} resigned.` };
    record(duel, { type: 'resign', seat });
    duel.deadline = null;
    return { ok: true };
  }
  if (msg.type === 'pick') {
    if (!inDraft(duel)) return { error: 'The boons have already been chosen.' };
    if (duel.draft.picks[seat]) return { error: "You've already chosen your boons." };
    const picks = Array.isArray(msg.boons) ? msg.boons.map(String) : [];
    if (!R.validBoonPick(duel.draft.offer, picks)) return { error: `Choose ${R.BOON_PICKS} different boons from the ${R.BOON_OFFER} offered.` };
    duel.draft.picks[seat] = picks;
    if (!inDraft(duel)) { record(duel, { type: 'draft', picks: duel.draft.picks }); startTurnClock(duel); }
    return { ok: true };
  }
  if (inDraft(duel)) return { error: 'Choose your boons first.' };
  if (duel.chess.turn() !== seat) return { error: "It isn't your turn." };

  if (msg.type === 'bless') {
    const options = blessOptions(duel, seat)[msg.from] || [];
    if (!options.includes(msg.to)) return { error: "That bishop can't bless that piece." };
    duel.pieces.get(msg.from).blessUsed = true;
    duel.pieces.get(msg.to).blessed = true;
    record(duel, { type: 'bless', seat, from: msg.from, to: msg.to });
    return { ok: true };            // a Blessing doesn't use up your turn
  }

  if (msg.type !== 'move' && msg.type !== 'challenge') return { error: 'Unknown action.' };
  const m = duel.chess.moves({ square: String(msg.from || ''), verbose: true })
    .find((x) => x.to === msg.to && (!x.promotion || x.promotion === 'q'));
  if (!m) return { error: "That move isn't allowed." };
  const capture = Boolean(m.captured || m.flags.includes('e'));
  if (capture !== (msg.type === 'challenge')) return { error: capture ? 'That move is an attack: confirm the battle first.' : "There's nothing to attack there." };

  if (!capture) {
    const done = R.applyMove({ chess: duel.chess, pieces: duel.pieces }, m);
    record(duel, { type: 'move', seat, from: m.from, to: m.to });
    checkForEnd(duel);
    duel.missed[seat] = 0; startTurnClock(duel);
    return { ok: true, promoted: done?.promoted || null };
  }

  // A battle: the server works out the odds and rolls the dice. Nobody else can.
  const odds = forecastFor(duel, m);
  const attacker = duel.pieces.get(m.from), defender = duel.pieces.get(R.defenderSquare(m));
  const f = R.battleForecast(m, ctxFor(duel));
  const result = R.rollBattle(f, duel.rng);
  // Battle Fervour (Momentum), worked out exactly as single player does for Dawn.
  const prev = duel.momentum[attacker.color];
  duel.momentum[attacker.color] = prev >= 3 ? 0 : R.nextMomentumStreak(prev, f.chance, result.kind);
  const applied = R.applyBattle({ chess: duel.chess, pieces: duel.pieces }, m, result);
  duel.battleCount++;
  const battle = {
    number: duel.battleCount,
    from: m.from, to: m.to, defenderSquare: R.defenderSquare(m),
    attacker: { type: attacker.type, color: attacker.color },
    defender: { type: defender.type, color: defender.color },
    odds,
    result: { kind: result.kind, wound: Boolean(result.wound) },
    promoted: applied.promoted || null,
  };
  duel.lastBattle = battle;
  record(duel, { type: 'challenge', seat, from: m.from, to: m.to, result: battle.result });
  checkForEnd(duel);
  duel.missed[seat] = 0; startTurnClock(duel);
  return { ok: true, battle };
}

// Both players must ask for a rematch. Then the same room starts again with sides swapped.
function requestRematch(duel, seat) {
  if (!duel.status.over) return { error: 'The duel is still going.' };
  duel.rematch[seat] = true;
  if (!(duel.rematch.w && duel.rematch.b)) return { ok: true, waiting: true };
  return { ok: true, restart: true };
}

export function rematchDuel(old, seed) {
  const duel = createDuel({ code: old.code, seed, timer: old.timer, mode: old.mode });
  duel.seats = { w: old.seats.b, b: old.seats.w };   // swap sides
  duel.names = { w: old.names.b, b: old.names.w };
  startTurnClock(duel);
  return duel;
}

// A short tally for the end-of-duel screen: moves made, battles fought and battles won, per side.
export function duelSummary(duel) {
  const t = { w: { moves: 0, battles: 0, won: 0 }, b: { moves: 0, battles: 0, won: 0 } };
  for (const h of duel.history) {
    if (!t[h.seat]) continue;
    if (h.type === 'move') t[h.seat].moves++;
    if (h.type === 'challenge') { t[h.seat].moves++; t[h.seat].battles++; if (h.result?.kind === 'victory') t[h.seat].won++; }
  }
  return t;
}

// What one player is told about the duel. The whole board is sent every time,
// so if a message is ever lost, the next one puts everything right.
export function stateFor(duel, seat, present = { w: false, b: false }) {
  const turn = duel.chess.turn();
  return {
    type: 'state',
    room: duel.code,
    you: seat,
    turn,
    pieces: [...duel.pieces].map(([square, p]) => ({
      square, id: p.id, home: p.home, type: p.type, color: p.color, hp: p.hp, maxHp: p.maxHp,
      mightBuff: p.mightBuff || 0, guardBuff: p.guardBuff || 0, moves: p.moves || 0,
      blessed: Boolean(p.blessed), blessUsed: Boolean(p.blessUsed),
    })),
    // The chess engine's own state, so the 3D game can rebuild the board exactly.
    engine: {
      side: duel.chess.side, ep: duel.chess.ep, halfmove: duel.chess.halfmove, fullmove: duel.chess.fullmove,
      board: [...duel.chess.board].map(([square, p]) => ({ square, type: p.type, color: p.color, moved: Boolean(p.moved) })),
    },
    names: duel.names,
    lastAction: duel.history[duel.history.length - 1] || null,
    check: !duel.status.over && duel.chess.isCheck(),
    legal: seat === turn ? legalMoves(duel) : [],
    bless: seat === turn && !duel.status.over && bothSeated(duel) ? blessOptions(duel, seat) : {},
    players: { w: { seated: Boolean(duel.seats.w), here: Boolean(present.w) }, b: { seated: Boolean(duel.seats.b), here: Boolean(present.b) } },
    status: duel.status,
    rematch: duel.rematch,
    lastBattle: duel.lastBattle,
    timer: duel.timer,                                                     // seconds per turn, 0 = off
    turnLeft: duel.deadline ? Math.max(0, duel.deadline - Date.now()) : null, // ms left this turn
    missed: duel.missed,
    mode: duel.mode,
    // Each player only sees their own picks until both have chosen; then everyone sees both.
    draft: duel.draft ? {
      offer: duel.draft.offer,
      picked: { w: Boolean(duel.draft.picks.w), b: Boolean(duel.draft.picks.b) },
      picks: inDraft(duel) ? { w: seat === 'w' ? duel.draft.picks.w : null, b: seat === 'b' ? duel.draft.picks.b : null } : duel.draft.picks,
    } : null,
    summary: duelSummary(duel),
    momentum: { w: boonsOf(duel, 'w').has('fervour') ? duel.momentum.w : 0, b: boonsOf(duel, 'b').has('fervour') ? duel.momentum.b : 0 },
    moveCount: duel.history.length,
    seed: duel.status.over ? duel.seed : undefined,   // revealed at the end, so a duel can be replayed
  };
}
