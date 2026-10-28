import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiScan, mergeScan, AI_SCAN_SCHEMA } from '../src/scan/ai.js';
import { Recorder } from '../src/usage.js';

const fake = (respond) => {
  const calls = [];
  return { calls, headless: async (args) => { calls.push(args); return respond(args); } };
};
const reply = (json) => ({ json, usage: { input: 10, output: 5, model: 'm' } });

function mkSkill(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sa-ai-')));
  const abs = [];
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    abs.push(p);
  }
  const skillPath = join(dir, 'SKILL.md');
  return { skill: { name: 's', description: 'd', tool: 'claude', source: 'user', dir, skillPath, hash: 'h', files: abs, outside: [] }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('mergeScan: static block + AI ok stays block', () => {
  const s = { verdict: 'block', partial: false, findings: [{ rule: 'x', severity: 'high', file: 'SKILL.md', line: 1, reason: 'r' }] };
  const m = mergeScan(s, { verdict: 'ok', partial: false, findings: [] });
  assert.equal(m.verdict, 'block');
  assert.equal(m.findings.length, 1);
});

test('mergeScan: static ok + AI warn becomes warn; partial if either; findings unioned', () => {
  const ai = { verdict: 'warn', partial: true, findings: [{ rule: 'ai', severity: 'medium', file: 'a', line: 2, reason: 'q' }] };
  const m = mergeScan({ verdict: 'ok', partial: false, findings: [] }, ai);
  assert.deepEqual([m.verdict, m.partial, m.findings.length], ['warn', true, 1]);
  assert.equal(mergeScan({ verdict: 'warn', partial: false, findings: [] }, { verdict: 'block', partial: false, findings: [] }).verdict, 'block');
});

test('aiScan: prompt has nonce twice and skill text once; fresh nonce per call; schema and model passed', async () => {
  const { skill, cleanup } = mkSkill({ 'SKILL.md': 'UNIQUE-BODY-123', 'scripts/run.sh': 'echo hi' });
  try {
    const a = fake(() => reply({ verdict: 'ok', findings: [] }));
    const rec = new Recorder();
    const r = await aiScan(a, skill, { model: 'sonnet', effort: 'medium' }, rec);
    const { prompt, schema, model, effort } = a.calls[0];
    const nonce = prompt.match(/<untrusted-skill-([0-9a-f]{16})>/)[1];
    assert.equal(prompt.split(nonce).length - 1, 2);
    assert.equal(prompt.split('UNIQUE-BODY-123').length - 1, 1);
    assert.match(prompt, /^[A-Za-z]/);
    assert.ok(prompt.indexOf('SKILL.md') < prompt.indexOf('scripts/run.sh'));
    assert.deepEqual([schema, model, effort], [AI_SCAN_SCHEMA, 'sonnet', 'medium']);
    assert.deepEqual([r.verdict, r.partial, r.findings], ['ok', false, []]);
    assert.equal(rec.rows()[0].step, 'scan');
    await aiScan(a, skill, {}, rec);
    assert.notEqual(a.calls[1].prompt.match(/untrusted-skill-([0-9a-f]{16})/)[1], nonce);
  } finally { cleanup(); }
});

test('aiScan: 70 KB skill is cut to 60000 chars and partial', async () => {
  const { skill, cleanup } = mkSkill({ 'SKILL.md': 'x'.repeat(70000) });
  try {
    const a = fake(() => reply({ verdict: 'ok', findings: [] }));
    const r = await aiScan(a, skill, {});
    assert.equal(r.partial, true);
    const body = a.calls[0].prompt.match(/x+/g).sort((p, q) => q.length - p.length)[0];
    assert.ok(body.length <= 60000 && body.length > 59000);
  } finally { cleanup(); }
});

test('aiScan: binary and unreadable files are skipped and make it partial', async () => {
  const { skill, cleanup } = mkSkill({ 'SKILL.md': 'text', 'bin/blob': 'ab\0cd' });
  try {
    skill.files.push(join(skill.dir, 'missing.txt'));
    const a = fake(() => reply({ verdict: 'ok', findings: [] }));
    const r = await aiScan(a, skill, {});
    assert.equal(r.partial, true);
    assert.ok(!a.calls[0].prompt.includes('bin/blob'));
  } finally { cleanup(); }
});

test('aiScan: findings become rule ai; severity by verdict; ok drops findings; clamps and caps', async () => {
  const { skill, cleanup } = mkSkill({ 'SKILL.md': 'text' });
  try {
    const f = (i) => ({ file: 'SKILL.md', line: i === 0 ? -5 : 1.9, reason: 'r'.repeat(500) });
    const blockRes = await aiScan(fake(() => reply({ verdict: 'block', findings: Array.from({ length: 15 }, (_, i) => f(i)) })), skill, {});
    assert.equal(blockRes.verdict, 'block');
    assert.equal(blockRes.findings.length, 10);
    assert.ok(blockRes.findings.every((x) => x.rule === 'ai' && x.severity === 'high' && x.reason.length === 200));
    assert.deepEqual([blockRes.findings[0].line, blockRes.findings[1].line], [0, 1]);
    const warnRes = await aiScan(fake(() => reply({ verdict: 'warn', findings: [f(1)] })), skill, {});
    assert.equal(warnRes.findings[0].severity, 'medium');
    const okRes = await aiScan(fake(() => reply({ verdict: 'ok', findings: [f(1)] })), skill, {});
    assert.deepEqual(okRes.findings, []);
    const bare = await aiScan(fake(() => reply({ verdict: 'warn', findings: [] })), skill, {});
    assert.equal(bare.findings.length, 1);
  } finally { cleanup(); }
});

test('aiScan: failure or bad shape returns no-change partial result, never throws', async () => {
  const { skill, cleanup } = mkSkill({ 'SKILL.md': 'text' });
  try {
    const none = { verdict: 'ok', partial: true, findings: [] };
    assert.deepEqual(await aiScan(fake(() => { throw new Error('boom'); }), skill, {}), none);
    assert.deepEqual(await aiScan(fake(() => reply({ verdict: 'safe', findings: [] })), skill, {}), none);
    assert.deepEqual(await aiScan(fake(() => reply(null)), skill, {}), none);
    assert.deepEqual(await aiScan(fake(() => reply({ verdict: 'ok' })), skill, {}), none);
  } finally { cleanup(); }
});
