import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readdirSync } from 'node:fs';
import { fakeHome } from './helpers.js';
import { readTable, writeTable, mergeTables } from '../src/table.js';
import { dataDir, routesPath, reportPath, logPath, hookCopyPath } from '../src/paths.js';

const skill = (name, extra = {}) => ({ name, tool: 'claude', path: `/s/${name}/SKILL.md`, enabled: true, priority: 10, patterns: [['x']], ...extra });
const table = (skills, extra = {}) => ({ version: 1, generatedAt: '2026-10-28T10:00:00Z', skills, ...extra });

test('writeTable then readTable round-trips and leaves no temp file', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'nested', 'routes.json');
    const t = table([skill('a')]);
    writeTable(p, t);
    assert.deepEqual(readTable(p), t);
    assert.deepEqual(readdirSync(join(home, 'nested')), ['routes.json']);
  } finally { cleanup(); }
});

test('readTable returns null for a missing, corrupt or wrongly shaped file', () => {
  const { home, cleanup } = fakeHome();
  try {
    assert.equal(readTable(join(home, 'nope.json')), null);
    const bad = join(home, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(readTable(bad), null);
    writeFileSync(bad, '{"version":1}');
    assert.equal(readTable(bad), null);
  } finally { cleanup(); }
});

test('mergeTables: a project entry replaces the user entry with the same name', () => {
  const user = table([skill('a', { priority: 1 }), skill('b')]);
  const project = table([skill('a', { priority: 5, path: '/p/a/SKILL.md' }), skill('c')]);
  const m = mergeTables(user, project);
  assert.deepEqual(m.skills.map((s) => s.name).sort(), ['a', 'b', 'c']);
  assert.equal(m.skills.find((s) => s.name === 'a').path, '/p/a/SKILL.md');
});

test('mergeTables tolerates a missing side', () => {
  const t = table([skill('a')]);
  assert.deepEqual(mergeTables(t, null).skills, t.skills);
  assert.deepEqual(mergeTables(null, t).skills, t.skills);
  assert.deepEqual(mergeTables(null, null).skills, []);
});

test('paths derive from HOME and cwd', () => {
  const { home, cleanup } = fakeHome();
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(dataDir('user'), join(home, '.config', 'skill-autoroute'));
    assert.equal(dataDir('project'), join(process.cwd(), '.skill-autoroute'));
    assert.equal(routesPath('user'), join(home, '.config', 'skill-autoroute', 'routes.json'));
    assert.equal(reportPath('project'), join(process.cwd(), '.skill-autoroute', 'install-report.json'));
    assert.equal(logPath(), join(home, '.config', 'skill-autoroute', 'usage.log'));
    assert.equal(hookCopyPath('user'), join(home, '.config', 'skill-autoroute', 'route.js'));
  } finally { process.env.HOME = old; cleanup(); }
});
