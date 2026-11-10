import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../hook/route.js';

const fs = { mtime: () => 1, real: (p) => p, list: () => [] };
const sk = (name, priority, patterns, words) => ({ name, enabled: true, path: `/s/${name}/SKILL.md`, priority, patterns, words });
const table = (skills) => ({ generatedAt: '2000-01-01T00:00:00Z', skills, roots: [] });
const names = (out) => [...out.matchAll(/(\w+) \(\/s\//g)].map((m) => m[1]);
const run = (skills, rank, prompt = 'fix the postgres migration please') => names(route(prompt, table(skills), { fs, rank }));

// broad wins on priority; specific needs two patterns and should win on score
const broad = sk('broad', 1, [['fix']]);
const specific = sk('specific', 9, [['postgres', 'migration']]);

test('priority rank keeps the old order', () => {
  assert.deepEqual(run([specific, broad], 'priority'), ['broad', 'specific']);
});

test('score rank prefers the more specific skill', () => {
  assert.deepEqual(run([broad, specific], 'score'), ['specific', 'broad']);
});

test('score rank keeps own words first', () => {
  const own = sk('own', 9, [], ['postgres']);
  assert.equal(run([specific, own], 'score')[0], 'own');
});

test('score ties break by priority then name, independent of input order', () => {
  const a = sk('a', 5, [['fix']]), b = sk('b', 5, [['fix']]), c = sk('c', 2, [['fix']]);
  assert.deepEqual(run([b, a, c], 'score'), ['c', 'a', 'b']);
  assert.deepEqual(run([c, a, b], 'score'), ['c', 'a', 'b']);
});

test('score rank still skips unsafe patterns and non-matches', () => {
  const evil = sk('evil', 1, [['(a+)+$']]);
  const miss = sk('miss', 1, [['nothing here']]);
  assert.deepEqual(run([evil, miss, broad], 'score', 'aaaa fix'), ['broad']);
});

test('priority is the default rank', () => {
  assert.deepEqual(names(route('fix the postgres migration please', table([broad, specific]), { fs })), ['broad', 'specific']);
});
