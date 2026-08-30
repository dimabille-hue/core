import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededRng } from '../src/index.js';

test('same seed produces identical random sequence', () => {
  const a = createSeededRng(12345); const b = createSeededRng(12345);
  assert.deepEqual(Array.from({length:20}, () => a.nextUint32()), Array.from({length:20}, () => b.nextUint32()));
});
test('different seeds diverge', () => {
  assert.notEqual(createSeededRng(1).nextUint32(), createSeededRng(2).nextUint32());
});
