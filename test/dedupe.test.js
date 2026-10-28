import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateGroups, aiDedupe, DEDUPE_SCHEMA } from '../src/dedupe.js';
import { Recorder } from '../src/usage.js';

const sk = (name, description, source = 'user', skillPath = `/x/${source}/${name}/SKILL.md`) => ({ name, description, source, skillPath });
const fake = (respond) => {
  const calls = [];
  return { calls, headless: async (args) => { calls.push(args); return respond(args); } };
};

test('candidateGroups: same name across sources, near-identical descriptions, unrelated left alone', () => {
  const a = sk('tdd', 'Guides test driven development workflow', 'user');
  const b = sk('tdd', 'Something else entirely about cooking', 'plugin');
  const c = sk('red-green', 'Drive implementation with failing tests first, refactor afterwards', 'user');
  const d = sk('tests-first', 'Drive implementation with failing tests first, refactor afterwards please', 'user');
  const e = sk('docker', 'Container image hardening checklist', 'user');
  const groups = candidateGroups([a, c, b, e, d]);
  assert.deepEqual(groups.map((g) => g.map((s) => s.skillPath)), [
    [a.skillPath, b.skillPath],
    [c.skillPath, d.skillPath],
  ]);
});

test('candidateGroups: name match is case-insensitive; each skill in one group; singletons and empty descriptions ignored', () => {
  const a = sk('TDD', 'alpha beta gamma delta', 'user');
  const b = sk('tdd', 'alpha beta gamma delta', 'plugin');
  const c = sk('tdd', 'alpha beta gamma delta', 'project');
  const empty1 = sk('p', '', 'user');
  const empty2 = sk('q', '', 'user');
  const g = candidateGroups([a, b, c, empty1, empty2]);
  assert.equal(g.length, 1);
  assert.equal(g[0].length, 3);
  assert.deepEqual(candidateGroups([]), []);
});

test('candidateGroups: stop words and short words do not create similarity', () => {
  const a = sk('one', 'Use when you want to help with the task');
  const b = sk('two', 'Use when you want to help with the work');
  assert.deepEqual(candidateGroups([a, b]), []);
});

function mkGroup() {
  const dir = mkdtempSync(join(tmpdir(), 'sa-dd-'));
  const mk = (n, body, source) => { const p = join(dir, `${n}.md`); writeFileSync(p, body); return sk(n, 'd', source, p); };
  return { group: [mk('a', 'BODY-A', 'user'), mk('b', 'B'.repeat(9000), 'plugin')], cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('aiDedupe: untrusted wrapping, 8000 char cap, valid answer', async () => {
  const { group, cleanup } = mkGroup();
  try {
    const [a, b] = group;
    const f = fake(() => ({ json: { keep: b.skillPath, reasons: [{ skillPath: a.skillPath, reason: 'x'.repeat(300) }, { skillPath: b.skillPath, reason: 'better' }, { skillPath: '/other', reason: 'ignored' }] }, usage: { input: 1, output: 1, model: 'm' } }));
    const rec = new Recorder();
    const r = await aiDedupe(f, group, { model: 'sonnet', effort: 'medium' }, rec);
    assert.equal(r.keep, b.skillPath);
    assert.equal(r.reasons[a.skillPath].length, 200);
    assert.equal(r.reasons[b.skillPath], 'better');
    assert.equal(r.reasons['/other'], undefined);
    const { prompt, schema, model } = f.calls[0];
    const nonce = prompt.match(/<untrusted-skill-([0-9a-f]{16})>/)[1];
    assert.equal(prompt.split(nonce).length - 1, 4);
    assert.equal(prompt.split('BODY-A').length - 1, 1);
    assert.equal((prompt.match(/B+/g) ?? []).sort((p, q) => q.length - p.length)[0].length, 8000);
    assert.match(prompt, /^[A-Za-z]/);
    assert.deepEqual([schema, model], [DEDUPE_SCHEMA, 'sonnet']);
    assert.equal(rec.rows()[0].step, 'dedupe');
  } finally { cleanup(); }
});

test('aiDedupe: failure, keep outside the group, or bad shape returns keep null', async () => {
  const { group, cleanup } = mkGroup();
  try {
    const none = { keep: null };
    assert.deepEqual(await aiDedupe(fake(() => { throw new Error('boom'); }), group, {}), none);
    assert.deepEqual(await aiDedupe(fake(() => ({ json: { keep: '/nope', reasons: [] } })), group, {}), none);
    assert.deepEqual(await aiDedupe(fake(() => ({ json: { keep: group[0].skillPath } })), group, {}), none);
    assert.deepEqual(await aiDedupe(fake(() => ({ json: null })), group, {}), none);
  } finally { cleanup(); }
});
