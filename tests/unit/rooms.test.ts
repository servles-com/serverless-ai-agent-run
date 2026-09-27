import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsRoom } from '../../src/rooms.ts';

test('instance owns only its own rooms', () => {
  assert.equal(ownsRoom('main', 'main'), true);
  assert.equal(ownsRoom('ci-abc', 'main'), false);
  assert.equal(ownsRoom('main', 'ci-abc'), false);
  assert.equal(ownsRoom('ci-abc', 'ci-abc'), true);
});

test('unlabelled rooms (before sar.instance existed) belong to main only', () => {
  assert.equal(ownsRoom('', 'main'), true);
  assert.equal(ownsRoom('', 'ci-abc'), false);
});
