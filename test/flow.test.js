import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimates, buildRows, runDedupe, runScans, plainUi, groupOf } from '../src/flow.js';
import { Recorder } from '../src/usage.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ok = { verdict: 'ok', partial: false, findings: [] };
const sk = (name, tool = 'claude', source = 'user', i = name) => ({ name, tool, source, description: 'Reviews pull requests carefully for bugs', skillPath: `/nope/${i}/SKILL.md`, files: [] });

test('trigger output estimate is 500 tokens per skill', () => {
  assert.equal(estimates('triggers', [sk('a'), sk('b')]).output, 1000);
});

test('duplicate text names tool and source when the names are equal', () => {
  const a = sk('skill-d', 'claude', 'plugin:x', 1), b = sk('skill-d', 'claude', 'user', 2), c = sk('other', 'claude', 'user', 3);
  const scans = new Map([a, b, c].map((s) => [s.skillPath, ok]));
  const rows = buildRows([a, b, c], scans, new Map([
    [a.skillPath, { of: 'skill-d', from: 'claude, user', reason: 'older' }],
    [c.skillPath, { of: 'skill-d', from: 'claude, user', reason: 'narrower' }],
  ]));
  assert.match(rows[0].text, /duplicate of skill-d \(claude, user\): older/);
  assert.match(rows[2].text, /duplicate of skill-d: narrower/);
  assert.equal(rows[0].enabled, false);
});

test('runDedupe: a group over 8 compares the first 8; the rest stay checked and say so', async () => {
  const group = Array.from({ length: 10 }, (_, i) => sk(`dup${i}`, 'claude', 'user', i)).map((s) => ({ ...s, name: 'same' }));
  const calls = [];
  const ai = { headless: async (a) => { calls.push(a); return { json: { keep: 1, reasons: [{ skill: 2, reason: 'Skill 1 is newer' }] }, usage: {} }; } };
  const ctx = { aiName: 'claude', ai, overrides: {}, rec: new Recorder(), est: {}, used: {}, overhead: 0, cacheOverhead: 0 };
  const out = await runDedupe(group, ctx, plainUi(() => {}));
  assert.match(calls[0].prompt, /Compare these 8 agent skills/);
  assert.deepEqual(out.get(group[0].skillPath), { preferred: true, reason: '' });
  assert.deepEqual(out.get(group[1].skillPath), { of: 'same', from: 'claude, user', reason: 'same is newer' });
  assert.deepEqual(out.get(group[9].skillPath), { tooLarge: true });
  const rows = buildRows(group, new Map(group.map((s) => [s.skillPath, ok])), out);
  assert.equal(rows[9].enabled, true);
  assert.match(rows[9].text, /duplicate group too large to compare/);
});

test('groupOf: plugin skills group by plugin, others by tool and folder kind', () => {
  assert.equal(groupOf(sk('a', 'claude', 'plugin:caveman@caveman')), 'plugin caveman@caveman');
  assert.equal(groupOf(sk('b', 'codex', 'user')), 'codex user skills');
});

test('runScans: the progress bar names each skill in order and closes with a count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sa-flow-'));
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: one\n---\nbody\n');
  const real = { skillPath: join(dir, 'SKILL.md'), dir, files: [join(dir, 'SKILL.md')], outside: [], skipped: [] };
  const skills = [{ ...sk('one', 'claude', 'user', 1), ...real }, { ...sk('two', 'codex', 'user', 2), outside: [], skipped: [] }];
  const ai = { headless: async () => ({ json: { verdict: 'ok', findings: [] }, usage: {} }) };
  const ctx = { aiName: 'claude', ai, overrides: {}, rec: new Recorder(), est: {}, used: {}, overhead: 0, cacheOverhead: 0 };
  const seen = [];
  const ui = { ...plainUi(() => {}), progress: (max) => { seen.push(`max ${max}`); return { next: (m) => seen.push(m), done: (m) => seen.push(m) }; } };
  await runScans(skills, ctx, ui);
  rmSync(dir, { recursive: true });
  // "two" has no files on disk, so its call fails before it is sent
  assert.deepEqual(seen, ['max 2', 'AI deep scan 1/2: one', 'AI deep scan 2/2: two', 'AI deep scan done: 1 of 2 skills scanned']);
});
