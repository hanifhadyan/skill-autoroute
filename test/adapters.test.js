import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, statSync, lstatSync, chmodSync, readdirSync } from 'node:fs';
import { fakeHome, fakeCli } from './helpers.js';
import * as claude from '../src/tools/claude.js';
import * as codex from '../src/tools/codex.js';
import { installHookCopy as copyHook, hookCommand } from '../src/tools/hookconfig.js';

const installHookCopy = (scope, tool = 'claude') => { copyHook(scope); return hookCommand(scope, tool); };
import { hookCopyPath } from '../src/paths.js';

// Runs fn with HOME, cwd and PATH pointing at a throwaway tree.
async function env(fn) {
  const { home, cleanup } = fakeHome();
  const bin = join(home, 'bin');
  const proj = join(home, 'proj');
  mkdirSync(bin);
  mkdirSync(proj);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, cwd: process.cwd() };
  process.env.HOME = home;
  process.env.PATH = bin + ':' + saved.PATH;
  process.chdir(proj);
  try { return await fn({ home: realpathSync(home), bin, proj: realpathSync(proj) }); } finally {
    process.chdir(saved.cwd);
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    cleanup();
  }
}
const fixtureClaude = readFileSync(new URL('./fixtures/claude-headless.json', import.meta.url), 'utf8');
const fixtureCodex = readFileSync(new URL('./fixtures/codex-headless.jsonl', import.meta.url), 'utf8');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

const claudeScript = `
const fs = require('fs');
const out = JSON.parse(${JSON.stringify(fixtureClaude)});
out.structured_output = { argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, 'utf8') };
console.log(JSON.stringify(out));`;
const codexScript = `
const fs = require('fs');
const a = process.argv.slice(2);
const sf = a[a.indexOf('--output-schema') + 1];
const lines = ${JSON.stringify(fixtureCodex)}.trim().split('\\n').map((l) => JSON.parse(l));
const msg = lines.find((l) => l.type === 'item.completed');
msg.item.text = JSON.stringify({ argv: a, cwd: process.cwd(), schemaFile: sf, schema: fs.readFileSync(sf, 'utf8'), stdin: fs.readFileSync(0, 'utf8') });
console.log(lines.map((l) => JSON.stringify(l)).join('\\n'));`;

test('claude.headless: argv, usage, cwd and stdin', () => env(async ({ bin, proj }) => {
  fakeCli(bin, 'claude', claudeScript);
  const r = await claude.headless({ prompt: 'hello', schema: SCHEMA, model: 'haiku', effort: 'low' });
  const { argv, cwd, stdin } = r.json;
  assert.deepEqual(argv, [
    '-p', 'hello', '--model', 'haiku', '--effort', 'low', '--tools', '', '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA), '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
  ]);
  assert.ok(!argv.includes('--bare'));
  assert.equal(stdin, '', 'stdin is /dev/null');
  assert.ok(cwd.includes('skill-autoroute-run-') && cwd !== proj, 'fresh temp cwd');
  assert.equal(existsSync(cwd), false, 'temp cwd removed');
  assert.deepEqual(r.usage, { input: 2 + 3454, cacheRead: 1071, output: 52, model: 'claude-haiku-5-5' });
}));

test('claude.headless: failures reject with stderr, is_error and bad JSON included', () => env(async ({ bin }) => {
  const args = { prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low' };
  fakeCli(bin, 'claude', `console.error('x'.repeat(300)); process.exit(1);`);
  await assert.rejects(claude.headless(args), (e) => e.message.includes('x'.repeat(200)) && !e.message.includes('x'.repeat(201)));
  fakeCli(bin, 'claude', `console.log('not json');`);
  await assert.rejects(claude.headless(args), /not JSON/);
  fakeCli(bin, 'claude', `console.log(JSON.stringify({is_error:true,result:'Not logged in'}));process.exit(1);`);
  await assert.rejects(claude.headless(args), /Not logged in/);
  fakeCli(bin, 'claude', `console.log(JSON.stringify({is_error:false,result:'hi',usage:{}}));`);
  await assert.rejects(claude.headless(args), /structured_output/);
}));

test('headless rejects on timeout', () => env(async ({ bin }) => {
  fakeCli(bin, 'claude', `setTimeout(() => {}, 20000);`);
  const t0 = Date.now();
  await assert.rejects(claude.headless({ prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low', timeoutMs: 300 }), /timed out/);
  assert.ok(Date.now() - t0 < 5000);
}));

test('headless rejects when the CLI is missing', () => env(async () => {
  process.env.PATH = '/nonexistent';
  await assert.rejects(codex.headless({ prompt: 'p', schema: SCHEMA, model: null, effort: 'low' }), /codex/);
}));

test('codex.headless: argv, schema file, usage, cwd', () => env(async ({ bin, proj }) => {
  fakeCli(bin, 'codex', codexScript);
  const r = await codex.headless({ prompt: 'hello', schema: SCHEMA, model: 'gpt-6-luna', effort: 'low' });
  const { argv, cwd, stdin, schema, schemaFile } = r.json;
  assert.deepEqual(argv.slice(0, 5), ['exec', '--skip-git-repo-check', '--json', '--ignore-user-config', '-s']);
  assert.equal(argv[5], 'read-only');
  assert.ok(argv.join(' ').includes('read-only --disable shell_tool --disable unified_exec'), 'shell features off; sandbox stays as backstop');
  assert.ok(argv.join(' ').includes('-m gpt-6-luna -c model_reasoning_effort=low --output-schema'));
  assert.equal(argv.at(-1), 'hello');
  for (const bad of ['--full-auto', '--dangerously-bypass-approvals-and-sandbox']) assert.ok(!argv.includes(bad));
  assert.deepEqual(JSON.parse(schema), SCHEMA);
  assert.equal(existsSync(schemaFile), false, 'schema file removed with the temp dir');
  assert.equal(stdin, '');
  assert.ok(cwd.includes('skill-autoroute-run-') && cwd !== proj, 'fresh temp cwd');
  assert.deepEqual(r.usage, { input: 22978, cacheRead: 0, output: 15, model: 'gpt-6-luna' });
}));

test('codex.headless: null model omits -m; failures reject', () => env(async ({ bin }) => {
  fakeCli(bin, 'codex', codexScript);
  const r = await codex.headless({ prompt: 'p', schema: SCHEMA, model: null, effort: 'medium' });
  assert.ok(!r.json.argv.includes('-m'));
  assert.ok(r.json.argv.includes('model_reasoning_effort=medium'));
  assert.equal(r.usage.model, null);
  const args = { prompt: 'p', schema: SCHEMA, model: null, effort: 'low' };
  fakeCli(bin, 'codex', `console.error('boom'); process.exit(2);`);
  await assert.rejects(codex.headless(args), /boom/);
  fakeCli(bin, 'codex', `console.log('{"type":"turn.completed","usage":{}}');`);
  await assert.rejects(codex.headless(args), /agent_message/);
  fakeCli(bin, 'codex', `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'nope'}}));`);
  await assert.rejects(codex.headless(args), /not JSON/);
}));

test('installHookCopy copies the hook; hookCommand runs the copy with this node and passes the tool', () => env(async ({ home, proj }) => {
  assert.equal(copyHook('user'), hookCopyPath('user'));
  const copy = hookCopyPath('user');
  assert.equal(hookCommand('user', 'claude'), `"${process.execPath}" "${copy}" claude`);
  assert.equal(hookCommand('user', 'codex'), `"${process.execPath}" "${copy}" codex`);
  assert.ok(copy.startsWith(home));
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(new URL('../hook/route.js', import.meta.url), 'utf8'));
  copyHook('project');
  // project settings are shared in git, so the command names `node` on PATH, not this machine's node
  assert.equal(hookCommand('project', 'claude'), 'node "$CLAUDE_PROJECT_DIR/.skill-autoroute/route.mjs" claude');
  assert.ok(existsSync(join(proj, '.skill-autoroute', 'route.mjs')));
  for (const sc of ['user', 'project']) assert.ok(hookCommand(sc, 'claude').includes('skill-autoroute/route.mjs'));
}));

test('claude.installHook / removeHook edit the right config per scope', () => env(async ({ home, proj }) => {
  const cmd = installHookCopy('user');
  assert.deepEqual(claude.installHook('user', cmd), { changed: true });
  const u = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(u.hooks.UserPromptSubmit[0].hooks[0].command, cmd);
  claude.installHook('project', installHookCopy('project'));
  assert.ok(existsSync(join(proj, '.claude', 'settings.json')));
  assert.deepEqual(claude.removeHook('user'), { changed: true });
  assert.deepEqual(claude.removeHook('project'), { changed: true });
}));

test('codex.installHook: user edits hooks.json; project is a no-op', () => env(async ({ home, proj }) => {
  const r = codex.installHook('user', installHookCopy('user', 'codex'));
  assert.equal(r.changed, true);
  assert.match(r.note, /\/hooks/);
  assert.deepEqual(codex.installHook('user', installHookCopy('user', 'codex')), { changed: false }, 'no trust note when nothing changed');
  assert.ok(existsSync(join(home, '.codex', 'hooks.json')));
  const note = 'codex uses the user-level hook; it reads the project table';
  assert.deepEqual(codex.installHook('project', 'x'), { changed: false, note });
  assert.deepEqual(codex.removeHook('project'), { changed: false, note });
  assert.equal(existsSync(join(proj, '.codex')), false);
  assert.equal(codex.removeHook('user').changed, true);
}));

test('detect checks PATH and the config folder', () => env(async ({ home, bin }) => {
  process.env.PATH = bin; // hide any real claude/codex
  assert.deepEqual(claude.detect(), { cli: false, configDir: false });
  fakeCli(bin, 'claude', '');
  mkdirSync(join(home, '.claude'));
  assert.deepEqual(claude.detect(), { cli: true, configDir: true });
  assert.deepEqual(codex.detect(), { cli: false, configDir: false });
  writeFileSync(join(bin, 'codex'), 'x'); // not executable
  assert.equal(codex.detect().cli, false);
}));

test('claude.skillDirs: user, project and enabled plugins only', () => env(async ({ home, proj }) => {
  const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };
  const on = mk(join(home, '.claude/plugins/cache/m/on/1.0.0'));
  mk(join(on, 'skills'));
  const noSkills = mk(join(home, '.claude/plugins/cache/m/noskills/1.0.0'));
  const off = mk(join(home, '.claude/plugins/cache/m/off/1.0.0'));
  mk(join(off, 'skills'));
  const projPlug = mk(join(home, '.claude/plugins/cache/m/pp/1.0.0'));
  mk(join(projPlug, 'skills'));
  const entry = (installPath) => [{ scope: 'user', installPath, version: '1' }];
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'on@m': entry(on), 'noskills@m': entry(noSkills), 'off@m': entry(off), 'pp@m': entry(projPlug),
  } }));
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'on@m': true, 'noskills@m': true, 'off@m': false } }));
  mk(join(proj, '.claude'));
  writeFileSync(join(proj, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'pp@m': true } }));

  const user = claude.skillDirs('user');
  assert.deepEqual(user, [
    { dir: join(home, '.claude/skills'), tool: 'claude', source: 'user' },
    { dir: join(on, 'skills'), tool: 'claude', source: 'plugin:on@m' },
  ]);
  const project = claude.skillDirs('project');
  assert.deepEqual(project, [
    { dir: join(proj, '.claude/skills'), tool: 'claude', source: 'project' },
    { dir: join(projPlug, 'skills'), tool: 'claude', source: 'plugin:pp@m' },
  ]);
}));

test('claude.skillDirs: missing or corrupt plugin files do not throw', () => env(async ({ home }) => {
  assert.equal(claude.skillDirs('user').length, 1);
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{bad');
  writeFileSync(join(home, '.claude/settings.json'), '{"enabledPlugins":{"a@m":true}}');
  assert.equal(claude.skillDirs('user').length, 1);
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), '{"plugins":{"a@m":"x"}}');
  assert.equal(claude.skillDirs('user').length, 1);
}));

test('codex.skillDirs', () => env(async ({ home, proj }) => {
  assert.deepEqual(codex.skillDirs('user'), [
    { dir: join(home, '.agents/skills'), tool: 'codex', source: 'user' },
    { dir: join(home, '.codex/skills'), tool: 'codex', source: 'user' },
  ]);
  assert.deepEqual(codex.skillDirs('project'), [{ dir: join(proj, '.agents/skills'), tool: 'codex', source: 'project' }]);
}));

test('headless rejects a non-string prompt or one starting with "-"', () => env(async ({ bin }) => {
  fakeCli(bin, 'claude', claudeScript);
  fakeCli(bin, 'codex', codexScript);
  for (const h of [claude.headless, codex.headless]) {
    for (const prompt of ['--help', '-x', undefined, 5]) {
      await assert.rejects(h({ prompt, schema: SCHEMA, model: null, effort: 'low' }), /prompt must be a string/);
    }
  }
}));

test('multi-byte characters split across stdout chunks survive', () => env(async ({ bin }) => {
  const s = JSON.stringify({ is_error: false, structured_output: { t: 'a€\u{1F600}b' }, usage: {} });
  fakeCli(bin, 'claude', `
const b = Buffer.from(${JSON.stringify(s)});
const i = b.indexOf(0xe2) + 1; // inside the 3-byte euro sign
process.stdout.write(b.subarray(0, i));
setTimeout(() => process.stdout.write(b.subarray(i)), 100);`);
  const r = await claude.headless({ prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low' });
  assert.equal(r.json.t, 'a€\u{1F600}b');
}));

test('non-JSON on exit 0 reports the stderr head when there is one', () => env(async ({ bin }) => {
  fakeCli(bin, 'claude', `console.error('warn: login expired'); console.log('garbage');`);
  await assert.rejects(claude.headless({ prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low' }), /not JSON: warn: login expired/);
}));

test('codex.headless uses the configured model when the tier cache falls back', () => env(async ({ home, bin }) => {
  fakeCli(bin, 'codex', codexScript);
  const { pickModel } = await import('../src/models.js');
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'config.toml'), '# c\nmodel_provider = "x"\nmodel = "my-gw-model"\n');
  const pick = pickModel('codex', 'probe');
  assert.deepEqual(pick, { model: 'my-gw-model', effort: 'low', fallback: true });
  const r = await codex.headless({ prompt: 'p', schema: SCHEMA, ...pick });
  assert.ok(r.json.argv.join(' ').includes('-m my-gw-model '));
  writeFileSync(join(home, '.codex', 'config.toml'), 'model_provider = "x"\n');
  const none = pickModel('codex', 'probe');
  assert.equal(none.model, null);
  assert.ok(!(await codex.headless({ prompt: 'p', schema: SCHEMA, ...none })).json.argv.includes('-m'));
}));

test('config edits keep a symlink and the file mode', () => env(async ({ home }) => {
  const real = join(home, 'dotfiles', 'settings.json');
  mkdirSync(join(home, 'dotfiles'));
  writeFileSync(real, '{"env":{"K":"secret"}}');
  chmodSync(real, 0o600);
  mkdirSync(join(home, '.claude'));
  const link = join(home, '.claude', 'settings.json');
  symlinkSync(real, link);
  assert.equal(claude.installHook('user', installHookCopy('user')).changed, true);
  assert.ok(lstatSync(link).isSymbolicLink(), 'still a symlink');
  assert.ok(JSON.parse(readFileSync(real, 'utf8')).hooks.UserPromptSubmit);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(home, 'dotfiles')).sort(), ['settings.json']);
  assert.equal(claude.removeHook('user').changed, true);
  assert.deepEqual(JSON.parse(readFileSync(real, 'utf8')), { env: { K: 'secret' } });
  assert.equal(statSync(real).mode & 0o777, 0o600);
}));

test('headless loadUserSettings drops the context-cutting flags and passes env (claude and codex)', () => env(async ({ bin }) => {
  const envEcho = `out.structured_output.flag = process.env.SA_TEST_FLAG ?? null; out.structured_output.dis = process.env.SKILL_AUTOROUTE_DISABLE ?? null;`;
  fakeCli(bin, 'claude', claudeScript.replace('console.log', `${envEcho}\nconsole.log`));
  process.env.SKILL_AUTOROUTE_DISABLE = '1';
  try {
    const r = await claude.headless({ prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low', loadUserSettings: true, env: { SA_TEST_FLAG: 'x', SKILL_AUTOROUTE_DISABLE: undefined } });
    for (const f of ['--setting-sources', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(!r.json.argv.includes(f), f);
    assert.ok(r.json.argv.includes('--no-session-persistence'));
    assert.equal(r.json.flag, 'x');
    assert.equal(r.json.dis, null, 'undefined removes an inherited var');
    const d = await claude.headless({ prompt: 'p', schema: SCHEMA, model: 'haiku', effort: 'low' });
    assert.ok(d.json.argv.includes('--setting-sources'), 'default path unchanged');
    assert.equal(d.json.flag, null);
  } finally { delete process.env.SKILL_AUTOROUTE_DISABLE; }
  fakeCli(bin, 'codex', codexScript);
  const c = await codex.headless({ prompt: 'p', schema: SCHEMA, model: 'm', effort: 'low', loadUserSettings: true, env: { A: 'b' } });
  assert.ok(!c.json.argv.includes('--ignore-user-config'));
  assert.ok(c.json.argv.includes('read-only'));
  assert.ok(c.json.argv.join(' ').includes('--disable shell_tool --disable unified_exec'));
}));

test('CODEX_HOME moves hooks.json, the config dir check and the codex skills dir; ~/.agents/skills stays under HOME', () => env(async ({ home }) => {
  const ch = join(home, 'alt-codex');
  process.env.CODEX_HOME = ch;
  try {
    assert.equal(codex.detect().configDir, false);
    mkdirSync(ch);
    assert.equal(codex.detect().configDir, true);
    assert.equal(codex.hookConfig('user'), join(ch, 'hooks.json'));
    assert.deepEqual(codex.skillDirs('user').map((d) => d.dir), [join(home, '.agents/skills'), join(ch, 'skills')]);
    assert.equal(codex.installHook('user', installHookCopy('user', 'codex')).changed, true);
    assert.ok(existsSync(join(ch, 'hooks.json')) && !existsSync(join(home, '.codex')));
    assert.equal(codex.hasHook('user'), true);
  } finally { delete process.env.CODEX_HOME; }
}));

test('claude.skillDirs user: known projects add their skills and project-only plugins, scoped to the project', () => env(async ({ home, proj }) => {
  const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };
  const both = mk(join(home, '.claude/plugins/cache/m/both/1.0.0/skills'));
  const local = mk(join(home, '.claude/plugins/cache/m/local/1.0.0/skills'));
  const entry = (p) => [{ scope: 'user', installPath: join(p, '..'), version: '1' }];
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'both@m': entry(both), 'local@m': entry(local) } }));
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'both@m': true } }));
  mk(join(proj, '.claude/skills'));
  writeFileSync(join(proj, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'both@m': true, 'local@m': true } }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: { [proj]: {}, [home]: {}, [join(home, 'gone')]: {} } }));

  assert.deepEqual(claude.skillDirs('user'), [
    { dir: join(home, '.claude/skills'), tool: 'claude', source: 'user' },
    { dir: both, tool: 'claude', source: 'plugin:both@m' },
    { dir: join(proj, '.claude/skills'), tool: 'claude', source: 'project', projects: [proj] },
    { dir: local, tool: 'claude', source: 'plugin:local@m', projects: [proj] },
  ]);
  assert.equal(claude.skillDirs('project').some((d) => d.projects), false, 'a project table never carries projects');
}));

test('claude.skillDirs: a plugin manifest skill list is followed; projectPath in installed_plugins.json names a project', () => env(async ({ home, proj }) => {
  const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };
  const plug = mk(join(home, '.claude/plugins/cache/m/nested/1.0.0'));
  mk(join(plug, 'skills/eng/tdd')); mk(join(plug, 'skills/eng/old')); mk(join(plug, 'skills/misc/pr'));
  mk(join(plug, '.claude-plugin'));
  writeFileSync(join(plug, '.claude-plugin/plugin.json'), JSON.stringify({ skills: ['./skills/eng/tdd', './skills/misc/pr', '../../escape'] }));
  writeFileSync(join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'nested@m': [{ scope: 'local', projectPath: proj, installPath: plug, version: '1' }],
  } }));
  mk(join(proj, '.claude'));
  writeFileSync(join(proj, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { 'nested@m': true } }));
  assert.deepEqual(claude.skillDirs('user').slice(1), [
    { dir: join(plug, 'skills/eng'), tool: 'claude', source: 'plugin:nested@m', only: ['tdd'], projects: [proj] },
    { dir: join(plug, 'skills/misc'), tool: 'claude', source: 'plugin:nested@m', only: ['pr'], projects: [proj] },
  ]);
}));
