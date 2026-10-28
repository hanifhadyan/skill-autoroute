import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fakeHome } from './helpers.js';
import { STEP_DEFAULTS, pickModel } from '../src/models.js';
import { CODEX_TIERS, resolveCodexModel } from '../src/tools/codex-models.js';

function withHome(cache, fn) {
  const { home, cleanup } = fakeHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    if (cache) {
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify(cache));
    }
    return fn();
  } finally { process.env.HOME = saved; cleanup(); }
}
const cacheOf = (...rows) => ({ models: rows.map(([slug, visibility]) => ({ slug, visibility })) });

test('tier lists and step defaults', () => {
  assert.deepEqual(CODEX_TIERS, { small: ['gpt-6-luna', 'gpt-5.6-luna'], mid: ['gpt-6.1-sol', 'gpt-6-sol'] });
  assert.deepEqual(STEP_DEFAULTS.probe, { claude: ['haiku', 'low'], codex: ['small', 'low'] });
  assert.deepEqual(STEP_DEFAULTS.triggers, STEP_DEFAULTS.probe);
  assert.deepEqual(STEP_DEFAULTS.dedupe, { claude: ['sonnet', 'medium'], codex: ['mid', 'medium'] });
  assert.deepEqual(STEP_DEFAULTS.scan, STEP_DEFAULTS.dedupe);
});

test('claude defaults per step; override applies to that step only', () => {
  assert.deepEqual(pickModel('claude', 'probe'), { model: 'haiku', effort: 'low', fallback: false });
  assert.deepEqual(pickModel('claude', 'dedupe', {}), { model: 'sonnet', effort: 'medium', fallback: false });
  assert.deepEqual(pickModel('claude', 'scan', { scan: 'opus' }), { model: 'opus', effort: 'medium', fallback: false });
  assert.equal(pickModel('claude', 'dedupe', { scan: 'opus' }).model, 'sonnet');
  assert.throws(() => pickModel('claude', 'nope'), /unknown step/);
});

test('codex resolves tiers from the models cache', () => {
  withHome(cacheOf(['gpt-6-sol', 'list'], ['gpt-6-astra', 'list'], ['gpt-6-luna', 'list']), () => {
    assert.deepEqual(resolveCodexModel('mid'), { model: 'gpt-6-sol', fallback: false });
    assert.deepEqual(resolveCodexModel('small'), { model: 'gpt-6-luna', fallback: false });
    assert.deepEqual(pickModel('codex', 'dedupe'), { model: 'gpt-6-sol', effort: 'medium', fallback: false });
    assert.equal(pickModel('codex', 'probe', { probe: 'my-model' }).model, 'my-model');
  });
});

test('codex skips hidden models and never returns an unlisted slug', () => {
  withHome(cacheOf(['gpt-6.1-sol', 'hide'], ['gpt-6-sol', 'list'], ['gpt-6-astra', 'list']), () => {
    assert.equal(resolveCodexModel('mid').model, 'gpt-6-sol');
  });
  withHome(cacheOf(['gpt-6-astra', 'list']), () => {
    assert.deepEqual(resolveCodexModel('mid'), { model: null, fallback: true });
    assert.deepEqual(resolveCodexModel('small'), { model: null, fallback: true });
  });
});

test('missing, corrupt or unknown-tier cache falls back', () => {
  withHome(null, () => {
    assert.deepEqual(resolveCodexModel('mid'), { model: null, fallback: true });
    assert.deepEqual(pickModel('codex', 'scan'), { model: null, effort: 'medium', fallback: true });
  });
  const { home, cleanup } = fakeHome();
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'models_cache.json'), '{oops');
    assert.deepEqual(resolveCodexModel('mid'), { model: null, fallback: true });
    assert.deepEqual(resolveCodexModel('huge'), { model: null, fallback: true });
  } finally { process.env.HOME = saved; cleanup(); }
});
