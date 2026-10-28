import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePattern, validateRules } from '../src/validate.js';

const err = async (p) => (await validatePattern(p)).error;

test('accepts a plain alternation', async () => {
  assert.deepEqual(await validatePattern('\\b(auth|oauth|jwt)\\b'), { ok: true });
});

test('rejects nested quantifiers', async () => {
  for (const p of ['(a+)+$', '(\\w*)*', '(a|aa)+', '((a)+)+', '(?:x+y)*', '(a{2,})+', '(.|a)*']) {
    assert.match(await err(p), /nested quantifier/, p);
  }
});

test('escaped parens and character classes are not groups or quantifiers', async () => {
  for (const p of ['\\(a+\\)+', '([+*])+x', '[(]a+[)]+', '(\\+\\*)+', '(foo|bar)+', '(\\d{3}-)+', '(a?)b']) {
    assert.deepEqual(await validatePattern(p), { ok: true }, p);
  }
});

test('rejects a pattern that does not compile', async () => {
  assert.equal(await err('['), 'does not compile');
  assert.equal(await err('(a'), 'does not compile');
});

test('length limit is 300', async () => {
  assert.deepEqual(await validatePattern('a'.repeat(300)), { ok: true });
  assert.equal(await err('a'.repeat(301)), 'too long');
});

test('rejects empty and non-string input', async () => {
  assert.equal(await err(''), 'empty');
  assert.equal(await err(42), 'not a string');
});

test('compiles with flag i only', async () => {
  assert.equal(await err('(?<n>a)\\k<n>'), undefined);
  assert.equal(await err('\\p{L}'), undefined); // without u this is a literal p{L}
});

test('kills a runaway regex that the static scan misses', async () => {
  const t = Date.now();
  assert.equal(await err('^(?:a?){40}a{40}$'), 'too slow');
  assert.ok(Date.now() - t < 3000);
});

test('validateRules drops a rule when any pattern fails and reports it', async () => {
  const out = await validateRules([
    ['\\bjwt\\b', 'oauth'],
    ['fine', '(a+)+$'],
    ['^(?:a?){40}a{40}$'],
    ['[', 'x'],
    ['deploy'],
  ]);
  assert.deepEqual(out.rules, [['\\bjwt\\b', 'oauth'], ['deploy']]);
  assert.deepEqual(out.rejected, [
    { pattern: '(a+)+$', error: 'nested quantifier' },
    { pattern: '^(?:a?){40}a{40}$', error: 'too slow' },
    { pattern: '[', error: 'does not compile' },
  ]);
});

test('validateRules keeps validating after a worker timeout', async () => {
  const out = await validateRules([['^(?:a?){40}a{40}$'], ['one'], ['two']]);
  assert.deepEqual(out.rules, [['one'], ['two']]);
});

test('validateRules on no rules', async () => {
  assert.deepEqual(await validateRules([]), { rules: [], rejected: [] });
});
