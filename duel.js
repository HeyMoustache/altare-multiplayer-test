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

// A brand-new duel: the standard starting army for both sides, no relics.
export function createDuel({ code, seed }) {
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
  };
}

// In a plain duel there are no relics and no Momentum: both sides are equal.
const ctxFor = (duel) => ({ pieceAt: (sq) => duel.pieces.get(sq) });

export function seatFor(duel, key) {
  if (!key) return null;
  return duel.seats.w === key ? 'w' : duel.seats.b === key ? 'b' : null;
}

// A player arrives. The first player gets a random side; the second gets the other.
// Coming back with the same key puts you back in your own seat.
export function joinDuel(duel, key, rand = Math.random) {
  const existing = seatFor(duel, key);
  if (existing) return { seat: existing, rejoined: true };
  const free = ['w', 'b'].filter((s) => !duel.seats[s]);
  if (!free.length) return { error: 'That duel already has two players.' };
  const seat = free.length === 2 ? (rand() < 0.5 ? 'w' : 'b') : free[0];
  duel.seats[seat] = key;
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
    duel.history.push({ type: 'resign', seat });
    return { ok: true };
  }
  if (duel.chess.turn() !== seat) return { error: "It isn't your turn." };

  if (msg.type === 'bless') {
    const options = blessOptions(duel, seat)[msg.from] || [];
    if (!options.includes(msg.to)) return { error: "That bishop can't bless that piece." };
    duel.pieces.get(msg.from).blessUsed = true;
    duel.pieces.get(msg.to).blessed = true;
    duel.history.push({ type: 'bless', seat, from: msg.from, to: msg.to });
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
    duel.history.push({ type: 'move', seat, from: m.from, to: m.to });
    checkForEnd(duel);
    return { ok: true, promoted: done?.promoted || null };
  }

  // A battle: the server works out the odds and rolls the dice. Nobody else can.
  const odds = forecastFor(duel, m);
  const attacker = duel.pieces.get(m.from), defender = duel.pieces.get(R.defenderSquare(m));
  const f = R.battleForecast(m, ctxFor(duel));
  const result = R.rollBattle(f, duel.rng);
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
  duel.history.push({ type: 'challenge', seat, from: m.from, to: m.to, result: battle.result });
  checkForEnd(duel);
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
  const duel = createDuel({ code: old.code, seed });
  duel.seats = { w: old.seats.b, b: old.seats.w };   // swap sides
  return duel;
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
      square, type: p.type, color: p.color, hp: p.hp, maxHp: p.maxHp,
      blessed: Boolean(p.blessed), blessUsed: Boolean(p.blessUsed),
    })),
    check: !duel.status.over && duel.chess.isCheck(),
    legal: seat === turn ? legalMoves(duel) : [],
    bless: seat === turn && !duel.status.over && bothSeated(duel) ? blessOptions(duel, seat) : {},
    players: { w: { seated: Boolean(duel.seats.w), here: Boolean(present.w) }, b: { seated: Boolean(duel.seats.b), here: Boolean(present.b) } },
    status: duel.status,
    rematch: duel.rematch,
    lastBattle: duel.lastBattle,
    moveCount: duel.history.length,
    seed: duel.status.over ? duel.seed : undefined,   // revealed at the end, so a duel can be replayed
  };
}
