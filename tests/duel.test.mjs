// Tests for the duel referee. Run them with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, joinDuel, handleAction, stateFor, legalMoves, rematchDuel, blessOptions, startTurnClock, checkTurnClock, cleanTimer, inDraft } from '../duel.js';
import { DUEL_BOONS, battleForecast, pieceStats } from '../rules.js';

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

test('names are cleaned, kept per seat, and swap with the sides on a rematch', async () => {
  const { cleanName } = await import('../duel.js');
  assert.equal(cleanName('  <b>Martin</b>\n ', 'x'), 'bMartin/b');
  assert.equal(cleanName('', 'Dawn player'), 'Dawn player');
  assert.equal(cleanName('A'.repeat(40), 'x').length, 20);
  const duel = createDuel({ code: 'ABCDE', seed: 's' });
  const a = joinDuel(duel, 'key-alice-1', () => 0.1, 'Alice'), b = joinDuel(duel, 'key-bob-22', Math.random, 'Bob');
  assert.equal(duel.names[a.seat], 'Alice'); assert.equal(duel.names[b.seat], 'Bob');
  const next = rematchDuel(duel, 'n');
  assert.equal(next.names[b.seat === 'w' ? 'b' : 'w'], 'Bob');
});

test('state carries the engine snapshot and numbered actions for the 3D game', () => {
  const { duel, w } = seated();
  play(duel, w, 'e2', 'e4');
  const s = stateFor(duel, w);
  assert.equal(s.engine.side, 'b'); assert.equal(s.engine.ep, 'e3');
  assert.ok(s.engine.board.find((p) => p.square === 'e4').moved);
  assert.deepEqual([s.lastAction.n, s.lastAction.type, s.lastAction.from, s.lastAction.to], [1, 'move', 'e2', 'e4']);
  assert.ok(s.pieces.every((p) => p.id && p.home));
});

test('turn timer: off by default, only the allowed lengths', () => {
  assert.equal(createDuel({ code: 'X', seed: 's' }).timer, 0);
  assert.equal(cleanTimer(60), 60); assert.equal(cleanTimer('120'), 120); assert.equal(cleanTimer(5), 0); assert.equal(cleanTimer('lots'), 0);
  const d = createDuel({ code: 'X', seed: 's' }); joinDuel(d, 'key-one-111'); joinDuel(d, 'key-two-222'); startTurnClock(d, 1000);
  assert.equal(d.deadline, null, 'no timer, no clock');
  assert.equal(checkTurnClock(d, 1e12), false);
});

test('turn timer: running out skips your turn; a move resets the count; three in a row loses', () => {
  const duel = createDuel({ code: 'T', seed: 'clock', timer: 30 });
  joinDuel(duel, 'key-alice-1', () => 0.1); joinDuel(duel, 'key-bob-22');
  startTurnClock(duel, 0);
  assert.equal(duel.deadline, 30_000);
  assert.equal(checkTurnClock(duel, 29_999), false, 'not yet');
  assert.equal(checkTurnClock(duel, 30_000), true);
  assert.equal(duel.chess.turn(), 'b', "Dawn's turn was skipped");
  assert.equal(duel.missed.w, 1);
  assert.equal(duel.history.at(-1).type, 'timeout');
  assert.equal(duel.deadline, 60_000, "Dusk's clock starts straight away");

  // Dusk moves (the real clock is used here), which resets Dusk's count and restarts the clock for Dawn.
  duel.missed.b = 2;
  assert.ok(handleAction(duel, 'b', { type: 'move', from: 'e7', to: 'e5', id: id() }).ok);
  assert.equal(duel.missed.b, 0); assert.ok(duel.deadline > Date.now());

  // Dawn runs out twice more: three in a row, so Dawn loses.
  let t = duel.deadline;
  checkTurnClock(duel, t);                     // Dawn misses (2)
  t = duel.deadline; checkTurnClock(duel, t);  // Dusk misses (1)
  t = duel.deadline; checkTurnClock(duel, t);  // Dawn misses (3) -> loses
  assert.equal(duel.status.over, true); assert.equal(duel.status.winner, 'b');
  assert.match(duel.status.reason, /ran out of time 3 turns in a row/);
  assert.equal(duel.deadline, null);
  const s = stateFor(duel, 'w'); assert.equal(s.timer, 30); assert.equal(s.turnLeft, null);

  // A rematch keeps the same timer.
  duel.rematch = { w: true, b: true };
  assert.equal(rematchDuel(duel, 'next').timer, 30);
});

function draftDuel(seed = 'draft-test', timer = 0) {
  const duel = createDuel({ code: 'D', seed, timer, mode: 'draft' });
  joinDuel(duel, 'key-alice-1', () => 0.1); joinDuel(duel, 'key-bob-22');
  return duel;
}

test('draft: the same three boons for both, from the pool, the same for the same seed', () => {
  const a = draftDuel('s1'), b = draftDuel('s1');
  assert.equal(a.draft.offer.length, 3);
  assert.deepEqual(a.draft.offer, b.draft.offer, 'same seed, same deal');
  assert.ok(a.draft.offer.every((k) => DUEL_BOONS[k]));
  assert.equal(new Set(a.draft.offer).size, 3);
  assert.ok(!Object.keys(DUEL_BOONS).includes('bulwark'), 'Iron Bulwark is not in duels');
  // Over many seeds, every boon gets dealt sometimes.
  const seen = new Set(); for (let i = 0; i < 200; i++) for (const k of draftDuel('x' + i).draft.offer) seen.add(k);
  assert.equal(seen.size, Object.keys(DUEL_BOONS).length);
  assert.equal(createDuel({ code: 'P', seed: 's', mode: 'plain' }).draft, null);
  assert.equal(createDuel({ code: 'P', seed: 's' }).mode, 'plain', 'plain unless asked for a draft');
});

test('draft: nobody moves until both have picked; picks stay secret until then', () => {
  const duel = draftDuel('secret', 60);
  startTurnClock(duel);
  assert.equal(duel.deadline, null, 'no clock during the draft');
  assert.match(handleAction(duel, 'w', { type: 'move', from: 'e2', to: 'e4', id: id() }).error, /boons first/);
  const [x, y, z] = duel.draft.offer;
  assert.match(handleAction(duel, 'w', { type: 'pick', boons: [x], id: id() }).error, /Choose 2/);
  assert.match(handleAction(duel, 'w', { type: 'pick', boons: [x, x], id: id() }).error, /Choose 2/);
  assert.match(handleAction(duel, 'w', { type: 'pick', boons: [x, 'bulwark'], id: id() }).error, /Choose 2/);
  assert.ok(handleAction(duel, 'w', { type: 'pick', boons: [x, y], id: id() }).ok);
  assert.match(handleAction(duel, 'w', { type: 'pick', boons: [y, z], id: id() }).error, /already chosen/);
  const forB = stateFor(duel, 'b');
  assert.equal(forB.draft.picks.w, null, "Dusk can't see Dawn's picks yet");
  assert.equal(forB.draft.picked.w, true);
  assert.deepEqual(stateFor(duel, 'w').draft.picks.w, [x, y], 'you see your own');
  assert.ok(inDraft(duel));
  assert.ok(handleAction(duel, 'b', { type: 'pick', boons: [y, z], id: id() }).ok);
  assert.ok(!inDraft(duel));
  assert.equal(duel.history.at(-1).type, 'draft');
  assert.ok(duel.deadline > Date.now(), 'the clock starts once both have picked');
  const watcher = stateFor(duel, null);
  assert.deepEqual(watcher.draft.picks, { w: [x, y], b: [y, z] }, 'revealed to everyone');
  assert.ok(handleAction(duel, 'w', { type: 'move', from: 'e2', to: 'e4', id: id() }).ok);
});

test('draft: boons change the odds the server uses', () => {
  const duel = draftDuel('odds');
  duel.draft.offer = ['pikewall', 'royalguard', 'siege'];
  handleAction(duel, 'w', { type: 'pick', boons: ['pikewall', 'royalguard'], id: id() });
  handleAction(duel, 'b', { type: 'pick', boons: ['royalguard', 'siege'], id: id() });
  const ctx = { pieceAt: (sq) => duel.pieces.get(sq) };
  const withBoons = (c) => ({ ...ctx, relics: (col) => new Set(duel.draft.picks[col]) });
  assert.equal(pieceStats('e2', withBoons()).guard, pieceStats('e2', ctx).guard + 1, 'Pike Wall: Dawn pawns +1 Guard');
  assert.equal(pieceStats('e7', withBoons()).guard, pieceStats('e7', ctx).guard, 'not Dusk pawns');
  assert.equal(pieceStats('e1', withBoons()).guard, pieceStats('e1', ctx).guard + 2, 'Royal Guard: king +2 Guard');
  // A rematch deals fresh boons and stays a draft.
  duel.status = { over: true }; duel.rematch = { w: true, b: true };
  const next = rematchDuel(duel, 'another');
  assert.equal(next.mode, 'draft'); assert.deepEqual(next.draft.picks, { w: null, b: null });
});

test('boons: Siege Oil, Pilgrim\'s Blade and Queen\'s Favour add 10% to their piece\'s attacks', () => {
  for (const [boon, type] of [['siege', 'r'], ['pilgrim', 'b'], ['favour', 'q'], ['whetstone', 'n']]) {
    const pieces = new Map([['d4', { type, color: 'w', hp: 2, maxHp: 2, mightBuff: 0, guardBuff: 0, moves: 1 }], ['d5', { type: 'p', color: 'b', hp: 1, maxHp: 1, mightBuff: 0, guardBuff: 0, moves: 1 }]]);
    const m = { from: 'd4', to: 'd5', flags: 'c' };
    const plain = battleForecast(m, { pieceAt: (s) => pieces.get(s) });
    const boosted = battleForecast(m, { pieceAt: (s) => pieces.get(s), relics: (c) => new Set(c === 'w' ? [boon] : []) });
    assert.ok(Math.abs(boosted.chance - Math.min(.95, plain.chance + .10)) < 1e-9, boon);
    assert.ok(boosted.adjustments.some((a) => a.name === DUEL_BOONS[boon].name), boon + ' is listed in the forecast');
  }
});

test('turn timer: skipped turns never count as a repeated position, so walking away loses rather than draws', () => {
  for (const opening of [[], [['w', 'g1', 'f3']], [['w', 'e2', 'e4'], ['b', 'e7', 'e5']]]) {
    const duel = createDuel({ code: 'R', seed: 'rep', timer: 30 });
    joinDuel(duel, 'key-aaaa-1'); joinDuel(duel, 'key-bbbb-2'); startTurnClock(duel, 0);
    for (const [seat, from, to] of opening) assert.ok(handleAction(duel, seat, { type: 'move', from, to, id: id() }).ok);
    for (let i = 0; i < 10 && !duel.status.over; i++) checkTurnClock(duel, duel.deadline);
    assert.equal(duel.status.over, true);
    assert.match(duel.status.reason, /ran out of time 3 turns in a row/, `opening of ${opening.length} moves`);
    assert.ok(duel.status.winner);
  }
});
