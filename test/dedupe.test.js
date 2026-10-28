import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateGroups, aiDedupe, DEDUPE_SCHEMA, MAX_GROUP } from '../src/dedupe.js';
import { Recorder } from '../src/usage.js';

const sk = (name, description, source = 'user', skillPath = `/x/${source}/${name}/SKILL.md`) => ({ name, description, source, skillPath });
const jac = (x, y) => { const p = new Set(x.description.split(' ')), q = new Set(y.description.split(' ')); return [...p].filter((w) => q.has(w)).length / new Set([...p, ...q]).size; };
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

test('candidateGroups: a candidate joins through any member, not only the first', () => {
  const a = sk('a', 'alpha beta gamma delta epsilon zeta');
  const b = sk('b', 'alpha beta gamma delta eta theta');
  const c = sk('c', 'eta theta iota kappa gamma delta');
  assert.ok(jac(a, c) < 0.5 && jac(b, c) >= 0.5);
  assert.deepEqual(candidateGroups([a, b, c]).map((g) => g.map((s) => s.name)), [['a', 'b', 'c']]);
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

test('aiDedupe: numbered members, everything inside the untrusted block, 8000 char cap, valid answer', async () => {
  const { group, cleanup } = mkGroup();
  try {
    const [a, b] = group;
    a.name = 'NAME-A'; a.source = 'SRC-A';
    const f = fake(() => ({ json: { keep: 2, reasons: [{ skill: 1, reason: 'x'.repeat(300) }, { skill: 2, reason: 'better' }, { skill: 9, reason: 'ignored' }] }, usage: { input: 1, output: 1, model: 'm' } }));
    const rec = new Recorder();
    const r = await aiDedupe(f, group, { model: 'sonnet', effort: 'medium' }, rec);
    assert.equal(r.keep, b.skillPath);
    assert.equal(r.reasons[a.skillPath].length, 200);
    assert.equal(r.reasons[b.skillPath], 'better');
    assert.deepEqual(Object.keys(r.reasons).sort(), [a.skillPath, b.skillPath].sort());
    const { prompt, schema, model } = f.calls[0];
    const nonce = prompt.match(/<untrusted-skill-([0-9a-f]{16})>/)[1];
    assert.equal(prompt.split(nonce).length - 1, 4);
    assert.equal(prompt.split('BODY-A').length - 1, 1);
    assert.equal((prompt.match(/B+/g) ?? []).sort((p, q) => q.length - p.length)[0].length, 8000);
    assert.match(prompt, /^[A-Za-z]/);
    assert.ok(!prompt.includes(a.skillPath) && !prompt.includes(b.skillPath));
    const inside = prompt.match(new RegExp(`<untrusted-skill-${nonce}>([\\s\\S]*?)</untrusted-skill-${nonce}>`))[1];
    assert.ok(inside.includes('NAME-A') && inside.includes('SRC-A'));
    assert.equal(prompt.split('NAME-A').length - 1, 1);
    assert.deepEqual([schema, model], [DEDUPE_SCHEMA, 'sonnet']);
    assert.equal(rec.rows()[0].step, 'dedupe');
  } finally { cleanup(); }
});

test('aiDedupe: name is capped at 200 chars', async () => {
  const { group, cleanup } = mkGroup();
  try {
    group[0].name = 'N'.repeat(500);
    const f = fake(() => ({ json: { keep: 1, reasons: [] } }));
    await aiDedupe(f, group, {});
    assert.equal(f.calls[0].prompt.match(/N+/g).sort((p, q) => q.length - p.length)[0].length, 200);
  } finally { cleanup(); }
});

test('aiDedupe: failure, out-of-range or non-integer keep, or bad shape returns keep null', async () => {
  const { group, cleanup } = mkGroup();
  try {
    const none = { keep: null };
    assert.deepEqual(await aiDedupe(fake(() => { throw new Error('boom'); }), group, {}), none);
    for (const keep of [0, 3, -1, 1.5, '1', null, group[0].skillPath]) {
      assert.deepEqual(await aiDedupe(fake(() => ({ json: { keep, reasons: [] } })), group, {}), none, String(keep));
    }
    assert.deepEqual(await aiDedupe(fake(() => ({ json: { keep: 1 } })), group, {}), none);
    assert.deepEqual(await aiDedupe(fake(() => ({ json: null })), group, {}), none);
  } finally { cleanup(); }
});

test('aiDedupe: reads only the start of a huge SKILL.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-dd-'));
  try {
    const p = join(dir, 'big.md'); writeFileSync(p, 'Z'.repeat(5_000_000));
    const f = fake(() => ({ json: { keep: 1, reasons: [] } }));
    await aiDedupe(f, [sk('big', 'd', 'user', p), sk('big', 'd', 'user', p)], {});
    assert.equal(f.calls[0].prompt.match(/Z+/g)[0].length, 8000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('candidateGroups groups only within one tool', () => {
  const a = { ...sk('tdd', 'Guides test driven development workflow'), tool: 'claude' };
  const b = { ...sk('tdd', 'Guides test driven development workflow', 'other'), tool: 'codex' };
  assert.deepEqual(candidateGroups([a, b]), []);
  assert.equal(candidateGroups([a, { ...b, tool: 'claude' }]).length, 1);
});

test('aiDedupe: "Skill N" in a reason becomes that member\'s name', async () => {
  const { group, cleanup } = mkGroup();
  try {
    const f = fake(() => ({ json: { keep: 1, reasons: [{ skill: 2, reason: 'Skill 1 covers more; Skill 2 is older. Skill 9 stays.' }] } }));
    const r = await aiDedupe(f, group, {});
    assert.equal(r.reasons[group[1].skillPath], 'a covers more; b is older. Skill 9 stays.');
  } finally { cleanup(); }
});

test('aiDedupe: a group is capped at MAX_GROUP members and each body at 12000 bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-dd-'));
  try {
    const members = Array.from({ length: 10 }, (_, i) => { const p = join(dir, `${i}.md`); writeFileSync(p, '€'.repeat(8000)); return sk(`m${i}`, 'd', 'user', p); });
    const f = fake(() => ({ json: { keep: 1, reasons: [] } }));
    await aiDedupe(f, members, {});
    const { prompt } = f.calls[0];
    assert.equal(MAX_GROUP, 8);
    assert.match(prompt, /Compare these 8 agent skills/);
    assert.ok(!prompt.includes('Skill 9:'));
    assert.ok(Buffer.byteLength(prompt) < 128 * 1024, `${Buffer.byteLength(prompt)} bytes`);
    assert.equal(Buffer.byteLength(prompt.match(/€+/)[0]), 12000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
