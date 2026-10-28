import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fakeHome } from './helpers.js';
import { estimate, Recorder, formatReport, writeReport, hookReport } from '../src/usage.js';
import { route } from '../hook/route.js';

// Probe overhead from docs/notes/cli-output.md, Claude run C: 2 + 3,454 + 1,071 input tokens per probe call.
const PROBE_OVERHEAD = 4527;

const skill = (name, extra = {}) => ({ name, tool: 'claude', path: `/s/${name}/SKILL.md`, enabled: true, priority: 10, patterns: [['x']], ...extra });
const table = (skills) => ({ version: 1, generatedAt: '2026-10-28T10:00:00Z', skills });

test('estimate: chars/4 rounded up plus overhead per call; output is items * outputPerItem', () => {
  assert.deepEqual(
    estimate({ chars: 10001, calls: 3, overheadPerCall: PROBE_OVERHEAD, outputPerItem: 200, items: 7 }),
    { input: 2501 + 3 * PROBE_OVERHEAD, output: 1400 },
  );
  assert.deepEqual(estimate({ chars: 0, calls: 0, overheadPerCall: 0, outputPerItem: 0, items: 0 }), { input: 0, output: 0 });
});

test('Recorder: rows keep each call, totals sum two rows of the same step', () => {
  const r = new Recorder();
  r.add('triggers', { input: 100, cacheRead: 10, output: 20, model: 'claude-haiku-5-5' });
  r.add('triggers', { input: 50, cacheRead: 5, output: 7, model: 'claude-haiku-5-5' });
  r.add('probe', { input: 4527, cacheRead: 0, output: 12, model: null });
  assert.equal(r.rows().length, 3);
  assert.deepEqual(r.rows()[0], { step: 'triggers', model: 'claude-haiku-5-5', input: 100, cacheRead: 10, output: 20 });
  const t = r.totals();
  assert.deepEqual(t.triggers, { calls: 2, input: 150, cacheRead: 15, output: 27, model: 'claude-haiku-5-5' });
  assert.deepEqual(t.probe, { calls: 1, input: 4527, cacheRead: 0, output: 12, model: null });
});

test('Recorder tolerates missing usage fields', () => {
  const r = new Recorder();
  r.add('x', {});
  assert.deepEqual(r.totals().x, { calls: 1, input: 0, cacheRead: 0, output: 0, model: null });
});

test('formatReport: estimates are marked est, input and cache-read stay separate columns', () => {
  const r = new Recorder();
  r.add('triggers', { input: 100, cacheRead: 10, output: 20, model: 'haiku' });
  r.add('duplicates', { input: 300, cacheRead: 0, output: 40, model: 'sonnet' });
  const text = formatReport(r.totals(), { triggers: { input: 120, output: 30 } });
  const lines = text.split('\n');
  assert.match(lines.find((l) => l.startsWith('triggers')), /haiku +1 +100 \(est 120\) +10 +20 \(est 30\)/);
  assert.match(lines.find((l) => l.startsWith('duplicates')), /est n\/a/);
  const total = lines.find((l) => l.startsWith('total'));
  assert.match(total, /400 \(est n\/a\)/); // an incomplete estimate is not presented as a total
  const full = formatReport(r.totals(), { triggers: { input: 120, output: 30 }, duplicates: { input: 350, output: 50 } });
  assert.match(full.split('\n').find((l) => l.startsWith('total')), /400 \(est 470\) +10 +60 \(est 80\)/);
  assert.match(text, /est = estimate/);
  assert.doesNotMatch(text, /sav(e|ed|es|ing)/i);
  assert.match(text, /adds tokens/);
  assert.match(text, /not summed/);
});

test('formatReport with no rows still prints a total line', () => {
  assert.match(formatReport({}, {}), /^total/m);
});

test('writeReport: JSON with generatedAt, rows, totals, estimates; atomic', () => {
  const { home, cleanup } = fakeHome();
  try {
    const r = new Recorder();
    r.add('probe', { input: 5, cacheRead: 1, output: 2, model: 'm' });
    const p = join(home, 'sub', 'install-report.json');
    writeReport(p, r, { probe: { input: 9, output: 3 } });
    const raw = readFileSync(p, 'utf8');
    assert.ok(raw.includes('\n  "rows"'));
    const j = JSON.parse(raw);
    assert.ok(!Number.isNaN(Date.parse(j.generatedAt)));
    assert.deepEqual(j.rows, r.rows());
    assert.deepEqual(j.totals, r.totals());
    assert.deepEqual(j.estimates, { probe: { input: 9, output: 3 } });
    assert.deepEqual(readdirSync(join(home, 'sub')), ['install-report.json']);
  } finally { cleanup(); }
});

test('hookReport: per enabled skill hint size matches what the hook really prints', () => {
  const s = skill('alpha', { patterns: [['hello']] });
  const real = route('hello world', table([s]), () => 0);
  const text = hookReport(table([s, skill('off', { enabled: false })]), []);
  assert.match(text, new RegExp(`alpha +${real.length} chars +~${Math.ceil(real.length / 4)} tokens \\(estimate\\)`));
  assert.doesNotMatch(text, /off/);
});

test('hookReport: 3 log lines on 2 days report 2 days, fires and averages', () => {
  const log = [
    '2026-10-27T09:00:00.000Z\t1\t100',
    '2026-10-28T09:00:00.000Z\t2\t200',
    '2026-10-28T10:00:00.000Z\t3\t300',
  ];
  const text = hookReport(table([skill('a')]), log);
  assert.match(text, /3 fires over 2 days/);
  assert.match(text, /1\.5 fires per day/);
  assert.match(text, /200 chars per fire \(~50 tokens, estimate\)/);
  assert.match(text, /300 chars per day \(~75 tokens, estimate\)/);
});

test('hookReport: malformed log lines are skipped, never crash', () => {
  const log = ['', 'garbage', 'nope\t1\t2', '2026-10-28T09:00:00.000Z\tx\t5', '2026-10-28T09:00:00.000Z\t1', '2026-10-28T09:00:00.000Z\t1\t40'];
  const text = hookReport(table([skill('a')]), log);
  assert.match(text, /1 fires over 1 days/);
  assert.match(text, /40 chars per fire/);
  assert.doesNotThrow(() => hookReport(table([]), undefined));
  assert.doesNotThrow(() => hookReport(null, null));
});

test('hookReport: no log lines says so and invents no numbers', () => {
  const text = hookReport(table([skill('a')]), []);
  assert.match(text, /no usage log entries/i);
  assert.doesNotMatch(text, /per fire/);
});
