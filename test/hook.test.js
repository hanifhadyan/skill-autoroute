import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { fakeHome, runHook } from './helpers.js';
import { spawnSync } from 'node:child_process';
import { route, merge } from '../hook/route.js';

const GEN = '2026-10-28T10:00:00Z';
const genMs = Date.parse(GEN);
const sk = (name, patterns, priority = 10, extra = {}) => ({ name, tool: 'claude', path: `/s/${name}/SKILL.md`, enabled: true, priority, patterns, ...extra });
const fixture = () => ({
  version: 1,
  generatedAt: GEN,
  skills: [
    sk('golang-patterns', [['\\bgo(lang)?\\b', '\\b(code|func|package|module|goroutine)s?\\b']]),
    sk('vibe-security', [['\\b(auth|oauth|jwt)\\b']]),
    sk('no-ai-slop', [['\\brewrite\\b', '\\b(readme|docs?|blog|post|copy)\\b']]),
  ],
});

test('no match gives null', () => {
  const t = fixture();
  assert.equal(route('go ahead and fix it', t), null);
  assert.equal(route('the subagent has no authority', t), null);
  assert.equal(route('rewrite the parser', t), null); // two-pattern rule: one half is not enough
});

test('matches name the skill and its path in the exact hint format', () => {
  const t = fixture();
  assert.equal(route('fix the oauth login', t), 'Skills that fit this work (read each SKILL.md before you start): vibe-security (/s/vibe-security/SKILL.md).');
  assert.match(route('rewrite the readme', t), /no-ai-slop/);
  assert.match(route('write go code for the module', t), /golang-patterns/);
});

test('five matches return only the 3 lowest priority values, in order', () => {
  const t = { version: 1, generatedAt: GEN, skills: [5, 1, 4, 2, 3].map((p) => sk(`s${p}`, [['draft']], p)) };
  const out = route('draft it', t);
  assert.ok(out.includes('s1 (/s/s1/SKILL.md); s2 (/s/s2/SKILL.md); s3 (/s/s3/SKILL.md).'));
  assert.ok(!out.includes('s4') && !out.includes('s5'));
});

test('disabled skills never appear', () => {
  const t = { version: 1, generatedAt: GEN, skills: [sk('off', [['draft']], 1, { enabled: false }), sk('on', [['draft']], 2)] };
  const out = route('draft it', t);
  assert.ok(out.includes('on (') && !out.includes('off ('));
  t.skills[1].enabled = false;
  assert.equal(route('draft it', t), null);
});

test('a bad pattern is skipped and never throws; matching is case-insensitive', () => {
  const t = { version: 1, generatedAt: GEN, skills: [sk('bad', [['(unclosed'], ['draft', '(also bad']]), sk('good', [['DRAFT']], 2)] };
  const out = route('Draft it', t);
  assert.ok(out.includes('good (') && !out.includes('bad ('));
});

test('only the first 20000 characters are matched', () => {
  const t = { version: 1, generatedAt: GEN, skills: [sk('a', [['needle']])] };
  assert.ok(route('x'.repeat(19990) + 'needle', t));
  assert.equal(route('x'.repeat(20000) + 'needle', t), null);
});

test('a 240 KB prompt finishes under 500 ms', () => {
  const t = fixture();
  const t0 = Date.now();
  route('draft '.repeat(40000), t);
  assert.ok(Date.now() - t0 < 500);
});

test('stale line counts changed skills (file or folder mtime) and new skill roots', () => {
  const t = { ...fixture(), roots: ['/roots/r1', '/roots/r2'] };
  const newer = genMs + 1000;
  const stat = (p) => (p === '/s/golang-patterns/SKILL.md' || p === '/s/vibe-security' ? newer : genMs - 1000);
  const out = route('fix the oauth login', t, stat);
  assert.ok(out.endsWith('\n2 skills changed since the last generate. Run: npx skill-autoroute regenerate'));
  const withRoot = route('fix the oauth login', t, (p) => (p === '/roots/r1' || stat(p) === newer ? newer : 0));
  assert.ok(withRoot.endsWith('\n3 skills changed since the last generate. Run: npx skill-autoroute regenerate'));
});

test('no stale line when nothing changed; missing files and a throwing stat are ignored', () => {
  const t = { ...fixture(), roots: ['/nope'] };
  assert.ok(!route('fix the oauth login', t, () => genMs - 1).includes('\n'));
  assert.ok(!route('fix the oauth login', t, () => { throw new Error('ENOENT'); }).includes('\n'));
  assert.ok(!route('fix the oauth login', t).includes('\n')); // real fs: /s/... and /nope do not exist
});

// ---- process-level tests ----
function setup(userTable, projectTable) {
  const { home, cleanup } = fakeHome();
  const udir = join(home, '.config', 'skill-autoroute');
  mkdirSync(udir, { recursive: true });
  if (userTable !== undefined) writeFileSync(join(udir, 'routes.json'), typeof userTable === 'string' ? userTable : JSON.stringify(userTable));
  const cwd = join(home, 'proj');
  mkdirSync(cwd);
  if (projectTable) {
    mkdirSync(join(cwd, '.skill-autoroute'));
    writeFileSync(join(cwd, '.skill-autoroute', 'routes.json'), JSON.stringify(projectTable));
  }
  return { home, cwd, udir, cleanup };
}
const input = (prompt) => ({ session_id: 'x', cwd: 'x', hook_event_name: 'UserPromptSubmit', prompt });
const claudeInput = JSON.parse(readFileSync(new URL('./fixtures/claude-hook-input.json', import.meta.url), 'utf8'));
const codexInput = JSON.parse(readFileSync(new URL('./fixtures/codex-hook-input.json', import.meta.url), 'utf8'));

test('hook prints the one-line JSON for a match (Claude and Codex fixtures)', () => {
  const t = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('hello-skill', [['hello']])] };
  const s = setup(t);
  try {
    for (const fx of [claudeInput, codexInput]) {
      const r = runHook(fx, { HOME: s.home }, s.cwd);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.ok(r.stdout.endsWith('\n') && r.stdout.trim().split('\n').length === 1);
      assert.deepEqual(JSON.parse(r.stdout), {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'Skills that fit this work (read each SKILL.md before you start): hello-skill (/s/hello-skill/SKILL.md).',
        },
      });
    }
  } finally { s.cleanup(); }
});

test('hook prints nothing on no match, corrupt table, missing table, bad stdin', () => {
  const t = { version: 1, generatedAt: GEN, skills: [sk('x', [['zzzz']])] };
  const s = setup(t);
  const c = setup('{corrupt');
  const m = setup();
  try {
    const cases = [
      runHook(claudeInput, { HOME: s.home }, s.cwd),
      runHook(claudeInput, { HOME: c.home }, c.cwd),
      runHook(claudeInput, { HOME: m.home }, m.cwd),
      runHook('not json', { HOME: s.home }, s.cwd),
      runHook({ nope: 1 }, { HOME: s.home }, s.cwd),
    ];
    for (const r of cases) { assert.equal(r.code, 0); assert.equal(r.stdout, ''); }
    assert.equal(cases[3].stderr, '');
    const d = runHook('not json', { HOME: s.home, SKILL_AUTOROUTE_DEBUG: '1' }, s.cwd);
    assert.equal(d.code, 0);
    assert.notEqual(d.stderr, '');
  } finally { s.cleanup(); c.cleanup(); m.cleanup(); }
});

test('project table overrides the user table by skill name', () => {
  const user = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('a', [['hello']], 1, { path: '/user/a' })] };
  const proj = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('a', [['hello']], 1, { path: '/proj/a' })] };
  const s = setup(user, proj);
  try {
    const out = JSON.parse(runHook(claudeInput, { HOME: s.home }, s.cwd).stdout).hookSpecificOutput.additionalContext;
    assert.ok(out.includes('/proj/a') && !out.includes('/user/a'));
  } finally { s.cleanup(); }
});

test('SKILL_AUTOROUTE_DISABLE=1 prints nothing and exits 0', () => {
  const t = { version: 1, generatedAt: GEN, skills: [sk('hello-skill', [['hello']])] };
  const s = setup(t);
  try {
    const r = runHook(claudeInput, { HOME: s.home, SKILL_AUTOROUTE_DISABLE: '1' }, s.cwd);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  } finally { s.cleanup(); }
});

test('cold start median of 5 runs is under 100 ms', () => {
  const t = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('hello-skill', [['hello']])] };
  const s = setup(t);
  try {
    const ms = Array.from({ length: 5 }, () => runHook(claudeInput, { HOME: s.home }, s.cwd).ms).sort((a, b) => a - b);
    console.log(`cold-start ms: ${ms.join(',')} median ${ms[2]}`);
    assert.ok(ms[2] < 100, `median ${ms[2]} ms`);
  } finally { s.cleanup(); }
});

test('SKILL_AUTOROUTE_LOG=1 appends a 3-field line without the prompt; no log by default', () => {
  const t = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('hello-skill', [['secretword']])] };
  const s = setup(t);
  try {
    runHook(input('please secretword now'), { HOME: s.home }, s.cwd);
    assert.ok(!existsSync(join(s.udir, 'usage.log')));
    const r = runHook(input('please secretword now'), { HOME: s.home, SKILL_AUTOROUTE_LOG: '1' }, s.cwd);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const log = readFileSync(join(s.udir, 'usage.log'), 'utf8');
    assert.match(log, /^\d{4}-\d\d-\d\dT[^\t]+\t1\t\d+\n$/);
    assert.equal(log.trimEnd().split('\t')[2], String(ctx.length));
    assert.ok(!log.includes('secretword'));
    // prompt text is written nowhere under HOME
    for (const f of readdirSync(s.home, { recursive: true })) {
      const p = join(s.home, f);
      try { assert.ok(!readFileSync(p, 'utf8').includes('please secretword now')); } catch (e) { if (e.code !== 'EISDIR') throw e; }
    }
  } finally { s.cleanup(); }
});

test('malformed entries in either table never disable the hook', () => {
  const user = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('good', [['hello']])] };
  const proj = { generatedAt: 'nonsense', roots: 5, skills: [null, 7, 'x', [], {}, { name: 'noPath', enabled: true, patterns: [['hello']] }, { name: 'bad', path: '/b', enabled: true, patterns: 'hello' }] };
  const s = setup(user, proj);
  try {
    const r = runHook(claudeInput, { HOME: s.home }, s.cwd);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, 'Skills that fit this work (read each SKILL.md before you start): good (/s/good/SKILL.md).');
  } finally { s.cleanup(); }
  const t = { generatedAt: GEN, roots: ['/r', 3, null], skills: [null, sk('ok', [['draft']])] };
  assert.ok(route('draft', merge(t, null)).includes('ok ('));
});

test('merge dedupes roots so a root in both tables counts once', () => {
  const a = { generatedAt: GEN, roots: ['/r'], skills: [] };
  const b = { generatedAt: GEN, roots: ['/r'], skills: [sk('x', [['draft']])] };
  const out = route('draft', merge(a, b), (p) => (p === '/r' ? genMs + 1 : 0));
  assert.ok(out.endsWith('\n1 skills changed since the last generate. Run: npx skill-autoroute regenerate'));
});

test('duplicate names use one hint slot, first by priority', () => {
  const t = { generatedAt: GEN, skills: [sk('d', [['draft']], 2, { path: '/second' }), sk('d', [['draft']], 1, { path: '/first' }), sk('e', [['draft']], 3), sk('f', [['draft']], 4), sk('g', [['draft']], 5)] };
  const out = route('draft', t);
  assert.equal(out.split('; ').length, 3);
  assert.ok(out.includes('d (/first)') && !out.includes('/second') && out.includes('e (') && out.includes('f ('));
});

test('the hook copy works as route.mjs beside a commonjs package.json', () => {
  const t = { version: 1, generatedAt: new Date().toISOString(), skills: [sk('hello-skill', [['hello']])] };
  const s = setup(t);
  try {
    const dir = join(s.home, 'copy');
    mkdirSync(dir);
    copyFileSync(new URL('../hook/route.js', import.meta.url), join(dir, 'route.mjs'));
    writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
    const r = spawnSync('node', [join(dir, 'route.mjs')], { input: JSON.stringify(claudeInput), env: { ...process.env, HOME: s.home }, cwd: s.cwd, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /hello-skill/);
  } finally { s.cleanup(); }
});
