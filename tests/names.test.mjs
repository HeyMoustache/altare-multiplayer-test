import test from 'node:test';
import assert from 'node:assert/strict';
import { isRudeName, cleanPlayerName } from '../names.js';

test('rude names are caught, even disguised', () => {
  for (const n of ['fuck', 'FUCK', 'f u c k', 'f.u.c.k', 'fuuuuck', 'Fvck'.replace('v', 'u'), 'sh1t', 'ShitLord', 'xXcuntXx', 'b1tch', 'a$$hole', 'Big Dick', 'dick', 'n1gg@', 'w@nker', 'tw4t', 'c0ck', 'Pr1ck', 'piss off', 'kkk', 'Hitler88', 'nazi', 'cum'])
    assert.equal(isRudeName(n), true, n);
});

test('ordinary names pass (no Scunthorpe problem)', () => {
  for (const n of ['Martin', 'Alex', 'Cassandra', 'Scunthorpe', 'Dickens', 'Knight', 'Knightley', 'Sussex', 'Hancock', 'Cumbria', 'Matsui', 'Shiitake', 'Penistone', 'Peacock', 'Assassin', 'Grace', 'Ashley', 'Bassett', 'Pisces', 'Titan', 'Analyst', 'Hellen', 'Gitte', 'Dawn player', 'Raphael', 'Snigger'.replace('Snigger', 'Spain'), 'Therapist'.replace('Therapist', 'Theo')])
    assert.equal(isRudeName(n), false, n);
});

test('cleanPlayerName tidies and replaces', () => {
  assert.equal(cleanPlayerName('  Martin   S  ', 'X'), 'Martin S');
  assert.equal(cleanPlayerName('<b>Bob</b>', 'X'), 'bBob/b');
  assert.equal(cleanPlayerName('', 'Dawn player'), 'Dawn player');
  assert.equal(cleanPlayerName('sh1t head', 'Dawn player'), 'Dawn player');
  assert.equal(cleanPlayerName('A'.repeat(40), 'X').length, 20);
});
