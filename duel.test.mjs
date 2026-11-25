// Tests for the duel referee. Run them with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, joinDuel, handleAction, stateFor, legalMoves, rematchDuel, blessOptions } from '../duel.js';

let n = 0; const id = () => 'id-' + (++n);
function seated(seed = 'test') {
  const duel = createDuel({ code: 'ABCDE', seed });
  const a = joinDuel(duel, 'key-alice-1', () => 0.1), b = joinDuel(duel, 'key-bob-22');
  const seat = { alice: a.seat, bob: b.seat };
  const white = seat.alice === 'w' ? 'alice' : 'bob';
  return { duel, seat, w: seat[white], b: seat[white === 'alice' ? 'bob' : 'alice'] };
}
const play = (duel, seat, from, to, type = 'move') => handleAction(duel, seat, { type, from, to, id: id() });
const sync = (duel) => {
  const a = [...duel.chess.board].map(([s, p]) => s + p.color + p.type).sort().join();
  const b = [...duel.pieces].map(([s, p]) => s + p.color + p.type).sort().join();
  return a === b;
};

test('two players get opposite sides; a third is turned away; the same key rejoins its seat', () => {
  const duel = createDuel({ code: 'ABCDE', seed: 's' });
  const a = joinDuel(duel, 'key-alice-1'), b = joinDuel(duel, 'key-bob-22');
  assert.notEqual(a.seat, b.seat);
  assert.ok(joinDuel(duel, 'key-carol-3').error);
  assert.deepEqual(joinDuel(duel, 'key-alice-1'), { seat: a.seat, rejoined: true });
});

test('nobody can move until both players are here', () => {
  const duel = createDuel({ code: 'ABCDE', seed: 's' });
  const a = joinDuel(duel, 'key-alice-1');
  assert.deepEqual(legalMoves(duel), []);
  assert.ok(play(duel, a.seat, 'e2', 'e4').error);
});

test('the server enforces turns and legal moves', () => {
  const { duel, w, b } = seated();
  assert.ok(play(duel, b, 'e7', 'e5').error, "Dusk can't move first");
  assert.ok(play(duel, w, 'e2', 'e5').error, 'a pawn cannot jump three squares');
  assert.ok(play(duel, w, 'e2', 'e4').ok);
  assert.equal(duel.chess.turn(), 'b');
  assert.ok(play(duel, w, 'd2', 'd4').error, "Dawn can't move twice");
});

test('a repeated action ID is ignored, so a double-tap only moves once', () => {
  const { duel, w } = seated();
  const msg = { type: 'move', from: 'e2', to: 'e4', id: 'same-id' };
  assert.ok(handleAction(duel, w, msg).ok);
  assert.deepEqual(handleAction(duel, w, msg), { duplicate: true });
  assert.equal(duel.history.length, 1);
});

test('attacks must be confirmed as a challenge, and the server rolls the battle', () => {
  const { duel, w, b } = seated();
  play(duel, w, 'e2', 'e4'); play(duel, b, 'd7', 'd5');
  assert.ok(play(duel, w, 'e4', 'd5', 'move').error, 'an attack sent as a plain move is refused');
  const r = play(duel, w, 'e4', 'd5', 'challenge');
  assert.ok(r.ok && r.battle);
  assert.ok(['victory', 'repelled', 'slain'].includes(r.battle.result.kind));
  assert.equal(r.battle.odds.victory + r.battle.odds.repelled + r.battle.odds.slain, 100);
  assert.ok(sync(duel), 'the chess board and the pieces stay in step');
  assert.equal(duel.chess.turn(), 'b', 'a battle uses the turn, win or lose');
});

test('the same duel seed always gives the same battle results', () => {
  const results = [];
  for (const run of [1, 2]) {
    const { duel, w, b } = seated('same-seed');
    play(duel, w, 'e2', 'e4'); play(duel, b, 'd7', 'd5');
    results.push(play(duel, w, 'e4', 'd5', 'challenge').battle.result);
  }
  assert.deepEqual(results[0], results[1]);
});

test('a bishop can bless an ally without using the turn', () => {
  const { duel, w } = seated();
  play(duel, w, 'd2', 'd3');                       // nothing yet: c1's diagonals are b2 and d2
  const { duel: d2, w: w2 } = seated();
  assert.deepEqual(blessOptions(d2, w2).c1.sort(), ['b2', 'd2']);
  assert.ok(handleAction(d2, w2, { type: 'bless', from: 'c1', to: 'd2', id: id() }).ok);
  assert.equal(d2.pieces.get('d2').blessed, true);
  assert.equal(d2.chess.turn(), 'w', 'still Dawn to move');
  assert.ok(handleAction(d2, w2, { type: 'bless', from: 'c1', to: 'b2', id: id() }).error, 'once per bishop');
});

test('slaying the king wins the duel; resigning loses it', () => {
  const { duel, w } = seated();
  duel.chess.clear(); duel.pieces.clear();
  const put = (t, c, s) => { duel.chess.put({ type: t, color: c, moved: true }, s); duel.pieces.set(s, { type: t, color: c, hp: 3, maxHp: 3, mightBuff: 0, guardBuff: 0, moves: 1 }); };
  put('k', 'w', 'a1'); put('q', 'w', 'h1'); put('k', 'b', 'h8');
  duel.rng = () => 0;                               // force a win for this test
  const r = play(duel, w, 'h1', 'h8', 'challenge');
  assert.equal(r.battle.result.kind, 'victory');
  assert.deepEqual([duel.status.over, duel.status.winner], [true, 'w']);
  const other = seated();
  handleAction(other.duel, other.b, { type: 'resign', id: id() });
  assert.equal(other.duel.status.winner, 'w');
});

test('a rematch needs both players, and swaps sides', () => {
  const { duel, w, b } = seated();
  handleAction(duel, w, { type: 'resign', id: id() });
  assert.ok(handleAction(duel, w, { type: 'rematch' }).waiting);
  assert.ok(handleAction(duel, b, { type: 'rematch' }).restart);
  const next = rematchDuel(duel, 'new-seed');
  assert.equal(next.seats.w, duel.seats.b);
  assert.equal(next.seats.b, duel.seats.w);
});

test('each player only gets legal moves on their own turn, and the seed stays secret until the end', () => {
  const { duel, w, b } = seated();
  assert.ok(stateFor(duel, w).legal.length === 20);
  assert.equal(stateFor(duel, b).legal.length, 0);
  assert.equal(stateFor(duel, w).seed, undefined);
});
