import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from './eval/run.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./eval/${f}`, import.meta.url), 'utf8'));

test('evaluate scores the fixture table', () => {
  const r = evaluate(load('table.json'), load('corpus.json'));
  for (const g of ['all', 'prompt', 'worker']) {
    for (const k of ['p1', 'p3', 'recall3', 'noMatchFp']) assert.ok(r[g][k] >= 0 && r[g][k] <= 1, `${g}.${k}=${r[g][k]}`);
    assert.ok(r[g].meanChars >= 0);
  }
  // Baseline of the current ranking on the fixture: no-match false-positive rate 0.364 (4 of 11), P@1 0.689.
  // Lower the ceiling when ranking improves; a rise above it is a regression.
  assert.ok(r.all.noMatchFp <= 0.4, `no-match false-positive rate ${r.all.noMatchFp}`);
});
