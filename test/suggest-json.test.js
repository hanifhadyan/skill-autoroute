import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fakeHome } from './helpers.js';

const ROUTE = join(dirname(new URL(import.meta.url).pathname), '..', 'hook', 'route.js');
const OLD = new Date('2020-01-01T00:00:00Z');
const sk = (name, patterns, extra = {}) => ({ name, tool: 'claude', path: `/s/${name}/SKILL.md`, enabled: true, priority: 10, patterns, ...extra });

// Skill paths under /s/ become real files in the fake HOME; `projects` entries of '@cwd' become the project folder.
function setup(skills) {
  const { home, cleanup } = fakeHome();
  const udir = join(home, '.config', 'skill-autoroute');
  mkdirSync(udir, { recursive: true });
  const cwd = join(home, 'proj');
  mkdirSync(cwd);
  for (const s of skills) {
    s.path = join(home, s.path);
    mkdirSync(dirname(s.path), { recursive: true });
    writeFileSync(s.path, '# skill\n');
    for (const p of [s.path, dirname(s.path)]) utimesSync(p, OLD, OLD);
    if (s.projects) s.projects = s.projects.map((p) => (p === '@cwd' ? cwd : join(home, p)));
  }
  writeFileSync(join(udir, 'routes.json'), JSON.stringify({ version: 1, generatedAt: '2026-10-28T10:00:00Z', skills }));
  return { home, cwd, udir, cleanup };
}
const run = (s, args, input) => spawnSync('node', [ROUTE, ...args], { env: { ...process.env, HOME: s.home, CLAUDE_PROJECT_DIR: '' }, cwd: s.cwd, input, encoding: 'utf8', timeout: 5000 });
// Context goes in on stdin, so no shell or file name ever carries the text.
const ask = (s, ctx) => {
  const r = run(s, ['claude', 'suggest', '--json', '--context-file', '-'], typeof ctx === 'string' ? ctx : JSON.stringify(ctx));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, r.stdout);
  return JSON.parse(r.stdout);
};
const ctx = (title, extra = {}) => ({ schema_version: 1, task: { title }, ...extra });

test('ok: names the skill with scope and reason code, plus routing_version and duration', () => {
  const s = setup([sk('a-skill', [['alpha']]), sk('own-skill', [], { words: ['gamma'] })]);
  try {
    const r = ask(s, ctx('do alpha and gamma', { stage: 'build', role: 'dev' }));
    assert.equal(r.schema_version, 1);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.selected.map((x) => [x.id, x.scope, x.reason_code]), [['own-skill', 'global', 'own_words'], ['a-skill', 'global', 'pattern']]);
    assert.match(r.selected[0].path, /SKILL\.md$/);
    assert.match(r.routing_version, /^[0-9a-f]{12}$/);
    assert.equal(typeof r.duration_ms, 'number');
    assert.deepEqual(r.suppressed, []);
    assert.equal(ask(s, ctx('alpha gamma', { policy: { max_skills: 1 } })).selected.length, 1);
  } finally { s.cleanup(); }
});

test('the match text is stage, role, title, summary and tags', () => {
  const s = setup([sk('a-skill', [['alpha']]), sk('b-skill', [['beta']]), sk('c-skill', [['gamma']])]);
  try {
    const r = ask(s, { schema_version: 1, stage: 'alpha', task: { summary: 'beta', tags: ['x', 'gamma'] } });
    assert.deepEqual(r.selected.map((x) => x.id).sort(), ['a-skill', 'b-skill', 'c-skill']);
  } finally { s.cleanup(); }
});

test('no_match: empty selected, nothing remembered', () => {
  const s = setup([sk('a-skill', [['alpha']])]);
  try {
    const r = ask(s, ctx('zzz', { session_id: 's1' }));
    assert.equal(r.status, 'no_match');
    assert.deepEqual(r.selected, []);
    assert.ok(!existsSync(join(s.udir, 'sessions')));
  } finally { s.cleanup(); }
});

test('error: bad schema version, non-object, oversize, bad json, missing flag; always exit 0', () => {
  const s = setup([sk('a-skill', [['alpha']])]);
  try {
    const err = (r) => { assert.equal(r.status, 'error'); assert.equal(r.schema_version, 1); return r.error; };
    assert.equal(err(ask(s, { schema_version: 2, task: {} })), 'bad_schema_version');
    assert.equal(err(ask(s, '[1]')), 'not_object');
    assert.equal(err(ask(s, '"x"')), 'not_object');
    assert.equal(err(ask(s, '{nope')), 'bad_json');
    assert.equal(err(ask(s, ctx('x'.repeat(20001)))), 'too_large');
    const r = run(s, ['claude', 'suggest', '--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).error, 'bad_args');
  } finally { s.cleanup(); }
});

test('policy.skip is honoured and reported as skip_list', () => {
  const s = setup([sk('a-skill', [['alpha']]), sk('b-skill', [['alpha']])]);
  try {
    const r = ask(s, ctx('alpha', { policy: { skip: ['a-skill'] } }));
    assert.deepEqual(r.selected.map((x) => x.id), ['b-skill']);
    assert.deepEqual(r.suppressed, [{ id: 'a-skill', reason_code: 'skip_list' }]);
  } finally { s.cleanup(); }
});

test('session memory: selected skills are remembered and then suppressed; other sessions start fresh', () => {
  const s = setup([sk('a-skill', [['alpha']])]);
  try {
    assert.equal(ask(s, ctx('alpha', { session_id: 's1' })).status, 'ok');
    const again = ask(s, ctx('alpha', { session_id: 's1' }));
    assert.equal(again.status, 'no_match');
    assert.deepEqual(again.suppressed, [{ id: 'a-skill', reason_code: 'seen_in_session' }]);
    assert.equal(ask(s, ctx('alpha', { session_id: 's2' })).status, 'ok');
    assert.equal(ask(s, ctx('alpha', { session_id: '../x' })).status, 'ok');
    assert.equal(ask(s, ctx('alpha', { session_id: '../x' })).status, 'ok', 'a bad session id is never a file name');
  } finally { s.cleanup(); }
});

test('duplicate names are suppressed as duplicate_name', () => {
  const s = setup([sk('a-skill', [['alpha']]), sk('a-skill', [['alpha']], { path: '/s/other/SKILL.md' })]);
  try {
    const r = ask(s, ctx('alpha'));
    assert.deepEqual(r.selected.map((x) => x.id), ['a-skill']);
    assert.deepEqual(r.suppressed, [{ id: 'a-skill', reason_code: 'duplicate_name' }]);
  } finally { s.cleanup(); }
});

test('project scoping: a scoped skill is scope project inside its folder and absent outside', () => {
  const inside = setup([sk('proj-skill', [['alpha']], { projects: ['@cwd'] }), sk('glob', [['alpha']])]);
  const outside = setup([sk('proj-skill', [['alpha']], { projects: ['elsewhere'] }), sk('glob', [['alpha']])]);
  try {
    assert.deepEqual(ask(inside, ctx('alpha')).selected.map((x) => [x.id, x.scope]).sort(), [['glob', 'global'], ['proj-skill', 'project']]);
    assert.deepEqual(ask(outside, ctx('alpha')).selected.map((x) => x.id), ['glob']);
  } finally { inside.cleanup(); outside.cleanup(); }
});

test('injection-looking text stays inert data', () => {
  const s = setup([sk('a-skill', [['alpha']])]);
  try {
    const marker = join(s.home, 'pwned');
    const evil = `alpha $(touch ${marker})\n\`touch ${marker}\`; touch ${marker}\n"; rm -rf / #`;
    const r = ask(s, { schema_version: 1, session_id: 's1', task: { title: evil, summary: evil, tags: [evil] }, policy: { skip: [evil] } });
    assert.equal(r.status, 'ok');
    assert.ok(!existsSync(marker));
    assert.ok(!JSON.stringify(r).includes('touch'));
  } finally { s.cleanup(); }
});

test('text mode is unchanged', () => {
  const s = setup([sk('a-skill', [['alpha']])]);
  try {
    const r = run(s, ['claude', 'suggest', 's1', 'alpha']);
    assert.match(r.stdout, /^Skills that fit this work \(read each SKILL\.md before you start\): a-skill \(.*SKILL\.md\)\.\n$/);
    assert.equal(run(s, ['claude', 'suggest', 's1', 'zzz']).stdout, 'No skill fits.\n');
  } finally { s.cleanup(); }
});
