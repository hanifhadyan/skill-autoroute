import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, utimesSync } from 'node:fs';
import { fakeHome, fakeCli, runHook } from './helpers.js';
import { discover } from '../src/discover.js';
import * as hermes from '../src/tools/hermes.js';
import { messageText, readInput, hookOutput } from '../hook/route.js';
import { selfTest } from '../src/flow.js';
import { installHookCopy, hookCommand } from '../src/tools/hookconfig.js';

// A stand-in `hermes` CLI: `config get --json <key>` and `config set <key> <json>` on $HERMES_HOME/config.json.
// config.yaml mirrors it so the adapter's one-time backup has a file to copy. Every call is logged.
const HERMES = `
const fs = require('fs'), path = require('path');
const home = process.env.HERMES_HOME || path.join(process.env.HOME, '.hermes');
const file = path.join(home, 'config.json');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.log'), a.join(' ') + '\\n');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (a[0] === 'config' && a[1] === 'get') {
  let v = cfg;
  for (const k of a[3].split('.')) v = v && typeof v === 'object' ? v[k] : undefined;
  if (v === undefined) { console.log('Config key not set: ' + a[3]); process.exit(1); }
  console.log(JSON.stringify(v));
} else if (a[0] === 'config' && a[1] === 'set') {
  const keys = a[2].split('.');
  let o = cfg;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = JSON.parse(a[3]);
  fs.writeFileSync(file, JSON.stringify(cfg));
  fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(cfg));
} else process.exit(2);`;

// HOME, cwd and PATH point at a throwaway tree; `cfg` (when given) seeds the fake Hermes config.
async function env(fn, { cfg, cli = true } = {}) {
  const { home, cleanup } = fakeHome();
  const bin = join(home, 'bin');
  const proj = join(home, 'proj');
  const hh = join(home, '.hermes');
  mkdirSync(bin);
  mkdirSync(proj);
  if (cfg) {
    mkdirSync(hh);
    writeFileSync(join(hh, 'config.json'), JSON.stringify(cfg));
    writeFileSync(join(hh, 'config.yaml'), 'original: true\n');
  }
  if (cli) fakeCli(bin, 'hermes', HERMES);
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, cwd: process.cwd() };
  process.env.HOME = home;
  // Without the fake CLI, PATH is only `bin` so a real Hermes install is not found either.
  process.env.PATH = cli ? bin + ':' + saved.PATH : bin;
  process.chdir(proj);
  const config = () => JSON.parse(readFileSync(join(hh, 'config.json'), 'utf8'));
  const calls = () => { try { return readFileSync(join(hh, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  try { return await fn({ home: realpathSync(home), bin, proj: realpathSync(proj), hh, config, calls }); } finally {
    process.chdir(saved.cwd);
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    cleanup();
  }
}

const skill = (dir, name = dir.split('/').at(-1)) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`);
};

test('hermes.skillDirs: category folders, top-level skills, external dirs and skills.disabled', () => env(({ home, hh }) => {
  skill(join(hh, 'skills', 'top-skill'));
  skill(join(hh, 'skills', 'software-development', 'tdd'));
  skill(join(hh, 'skills', 'software-development', 'tdd', 'references', 'not-a-skill')); // inside a skill: never listed
  skill(join(hh, 'skills', 'creative', 'humanizer'));
  skill(join(hh, 'skills', 'deep', 'sub', 'nested'));
  skill(join(home, 'linked', 'foreman-run'));
  const dirs = hermes.skillDirs('user');
  assert.ok(dirs.every((d) => d.tool === 'hermes' && d.source === 'user'));
  const found = discover(dirs).map((s) => s.name).sort();
  assert.deepEqual(found, ['foreman-run', 'nested', 'tdd', 'top-skill']);
}, { cfg: { skills: { external_dirs: ['~/linked'], disabled: ['humanizer'] } } }));

test('hermes.skillDirs: ${VAR} in external_dirs; a scalar disabled value counts as one name', () => env(({ home, hh }) => {
  process.env.SAR_TEST_DIR = join(home, 'ext');
  try {
    skill(join(home, 'ext', 'a'));
    skill(join(hh, 'skills', 'b'));
    assert.deepEqual(discover(hermes.skillDirs('user')).map((s) => s.name), ['b']);
  } finally { delete process.env.SAR_TEST_DIR; }
}, { cfg: { skills: { external_dirs: ['${SAR_TEST_DIR}'], disabled: 'a' } } }));

test('hermes.skillDirs project: the trusted project folders', () => env(({ proj }) => {
  assert.deepEqual(hermes.skillDirs('project').map((d) => d.dir), [join(proj, '.hermes', 'skills'), join(proj, '.agents', 'skills')]);
}, { cfg: {} }));

test('HERMES_HOME moves the skills and the config', () => env(({ home, calls }) => {
  const other = join(home, 'profile');
  process.env.HERMES_HOME = other;
  try {
    mkdirSync(other);
    writeFileSync(join(other, 'config.json'), '{}');
    skill(join(other, 'skills', 'cat', 'p-skill'));
    assert.deepEqual(discover(hermes.skillDirs('user')).map((s) => s.name), ['p-skill']);
    assert.equal(hermes.hookConfig('user'), join(other, 'config.yaml'));
    assert.equal(hermes.detect().configDir, true);
    assert.equal(calls().length, 0, 'the default home was not touched');
  } finally { delete process.env.HERMES_HOME; }
}));

test('without a Hermes folder the CLI is never run', () => env(({ bin }) => {
  fakeCli(bin, 'hermes', `require('fs').writeFileSync(${JSON.stringify(join(bin, 'ran'))}, '1')`);
  assert.deepEqual(hermes.detect(), { cli: true, configDir: false });
  assert.equal(discover(hermes.skillDirs('user')).length, 0);
  assert.deepEqual(hermes.removeHook('user'), { changed: false });
  assert.equal(hermes.hasHook(), false);
  assert.equal(existsSync(join(bin, 'ran')), false);
}));

test('discover: skip leaves a turned-off skill out for that tool only', () => env(({ home }) => {
  skill(join(home, 'shared', 'x'));
  const both = discover([
    { dir: join(home, 'shared'), tool: 'hermes', source: 'user', skip: (n) => n === 'x' },
    { dir: join(home, 'shared'), tool: 'claude', source: 'user' },
  ]);
  assert.equal(both.length, 1);
  assert.deepEqual(both[0].tools, ['claude']);
}));

test('hiddenBy: disabled names, other platforms and environment-only skills; frontmatterList reads both list forms', () => {
  const fm = (body) => `---\nname: s\n${body}\n---\nbody\n`;
  const here = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
  const other = here === 'macos' ? 'windows' : 'macos';
  const hide = hermes.hiddenBy(['off']);
  assert.equal(hide('off', fm('')), true);
  assert.equal(hide('s', fm('')), false);
  assert.equal(hide('s', fm(`platforms: [${other}]`)), true);
  assert.equal(hide('s', fm(`platforms: [${other}, ${here}]`)), false);
  assert.equal(hide('s', fm(`platforms:\n  - ${other}`)), true);
  assert.equal(hide('s', fm('environments:\n  - kanban')), true);
  assert.equal(hide('s', fm('metadata:\n  hermes:\n    platforms: [nowhere]')), false, 'only top-level keys count');
  assert.deepEqual(hermes.frontmatterList(fm('platforms: ["linux", \'macos\']'), 'platforms'), ['linux', 'macos']);
  assert.equal(hermes.frontmatterList('no frontmatter', 'platforms'), null);
});

test('hermes.skillDirs leaves out skills for another platform and Kanban-only skills', () => env(({ hh }) => {
  const other = process.platform === 'darwin' ? 'windows' : 'macos';
  mkdirSync(join(hh, 'skills', 'apple', 'notes'), { recursive: true });
  writeFileSync(join(hh, 'skills', 'apple', 'notes', 'SKILL.md'), `---\nname: notes\nplatforms: [${other}]\n---\n`);
  mkdirSync(join(hh, 'skills', 'devops', 'review'), { recursive: true });
  writeFileSync(join(hh, 'skills', 'devops', 'review', 'SKILL.md'), '---\nname: review\nenvironments:\n  - kanban\n---\n');
  skill(join(hh, 'skills', 'devops', 'kept'));
  assert.deepEqual(discover(hermes.skillDirs('user')).map((s) => s.name), ['kept']);
}, { cfg: {} }));

const CMD = '"/usr/bin/node" "/h/.config/skill-autoroute/route.mjs" hermes';

test('hermes.installHook adds both events, keeps other hooks, backs up config.yaml once, and is idempotent', () => env(({ hh, config, calls }) => {
  const r = hermes.installHook('user', CMD);
  assert.equal(r.changed, true);
  assert.match(r.note, /allow the new hook/);
  const hooks = config().hooks;
  assert.deepEqual(hooks.pre_llm_call, [{ command: 'other.sh' }, { command: CMD, timeout: 10 }]);
  assert.deepEqual(hooks.subagent_start, [{ command: CMD, timeout: 10 }]);
  assert.deepEqual(hooks.pre_tool_call, [{ command: 'guard.sh' }], 'other events untouched');
  assert.equal(readFileSync(join(hh, 'config.yaml.bak-skill-autoroute'), 'utf8'), 'original: true\n');
  assert.equal(hermes.hasHook(), true);
  const n = calls().filter((c) => c.startsWith('config set')).length;
  assert.deepEqual(hermes.installHook('user', CMD), { changed: false });
  assert.equal(calls().filter((c) => c.startsWith('config set')).length, n, 'no write when nothing changed');
  // An older command (another node path) is replaced in place, not added twice; the backup is not overwritten.
  const newer = CMD.replace('/usr/bin/node', '/opt/node');
  assert.equal(hermes.installHook('user', newer).changed, true);
  assert.deepEqual(config().hooks.pre_llm_call, [{ command: 'other.sh' }, { command: newer, timeout: 10 }]);
  assert.equal(readFileSync(join(hh, 'config.yaml.bak-skill-autoroute'), 'utf8'), 'original: true\n');
}, { cfg: { hooks: { pre_llm_call: [{ command: 'other.sh' }], pre_tool_call: [{ command: 'guard.sh' }] } } }));

test('hermes.removeHook removes only its own entries; project scope is a no-op', () => env(({ config }) => {
  hermes.installHook('user', CMD);
  assert.deepEqual(hermes.installHook('project', CMD), { changed: false, note: 'hermes uses the user-level hook; it reads the project table' });
  assert.equal(hermes.hookConfig('project'), null);
  assert.deepEqual(hermes.removeHook('user'), { changed: true });
  assert.deepEqual(config().hooks.pre_llm_call, [{ command: 'other.sh' }]);
  assert.deepEqual(config().hooks.subagent_start, []);
  assert.equal(hermes.hasHook(), false);
  assert.deepEqual(hermes.removeHook('user'), { changed: false });
}, { cfg: { hooks: { pre_llm_call: [{ command: 'other.sh' }] } } }));

test('hermes.checkConfig refuses a bad hook shape or a missing CLI; installHook writes nothing then', async () => {
  await env(({ config }) => {
    assert.throws(() => hermes.checkConfig('user'), /hooks\.pre_llm_call must be a list/);
    assert.throws(() => hermes.installHook('user', CMD), /must be a list/);
    assert.equal(config().hooks.pre_llm_call, 'oops');
  }, { cfg: { hooks: { pre_llm_call: 'oops' } } });
  await env(() => {
    assert.throws(() => hermes.checkConfig('user'), /hermes CLI was not found/);
    assert.doesNotThrow(() => hermes.checkConfig('project'));
  }, { cfg: {}, cli: false });
  await env(() => assert.throws(() => hermes.installHook('user', 'echo hi'), /must contain/), { cfg: {} });
});

// ---- the hook with Hermes input ----
test('messageText: a string, the text parts of a multimodal list, or null', () => {
  assert.equal(messageText('hi'), 'hi');
  assert.equal(messageText([{ type: 'text', text: 'review' }, { type: 'image_url', image_url: { url: 'x' } }, 'the login']), 'review\nthe login');
  assert.equal(messageText([{ type: 'image_url' }]), null);
  assert.equal(messageText(undefined), null);
});

test('readInput: Hermes and Claude shapes; other Hermes events give nothing', () => {
  assert.deepEqual(readInput({ hook_event_name: 'pre_llm_call', session_id: 's', cwd: '/p', extra: { user_message: 'go' } }, 'hermes', '/nowhere'), { prompt: 'go', sid: 's', base: '/p' });
  assert.equal(readInput({ hook_event_name: 'post_llm_call', extra: { user_message: 'go' } }, 'hermes', '/nowhere'), null);
  assert.equal(readInput({ prompt: 'go' }, 'hermes', '/nowhere'), null, 'a Claude payload is not read as Hermes');
  assert.equal(readInput({ prompt: 'go', session_id: 's' }, 'claude', '/nowhere').prompt, 'go');
  assert.deepEqual(hookOutput('hermes', 'x'), { context: 'x' });
  assert.deepEqual(hookOutput('codex', 'x'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'x' } });
});

const OLD = new Date('2020-01-01T00:00:00Z');
function hookSetup(names) {
  const { home, cleanup } = fakeHome();
  const udir = join(home, '.config', 'skill-autoroute');
  mkdirSync(udir, { recursive: true });
  const cwd = join(home, 'proj');
  mkdirSync(cwd);
  const skills = names.map(([name, word, tool = 'hermes'], i) => {
    const path = join(home, 's', name, 'SKILL.md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# skill\n');
    for (const p of [path, dirname(path)]) utimesSync(p, OLD, OLD);
    return { name, tool, tools: [tool], path, enabled: true, priority: i + 1, patterns: [[`\\b${word}\\b`]] };
  });
  writeFileSync(join(udir, 'routes.json'), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), skills }));
  return { home, cwd, udir, cleanup };
}
const turn = (prompt, sid = '', extra = {}) => ({ hook_event_name: 'pre_llm_call', tool_name: null, tool_input: null, session_id: sid, cwd: '', profile: 'default', extra: { user_message: prompt, is_first_turn: true, conversation_history: [], ...extra } });
const contextOf = (r) => JSON.parse(r.stdout).context;

test('hook as hermes: a match prints {"context"} on one line; no match prints nothing; only Hermes skills', () => {
  const s = hookSetup([['h-skill', 'hello'], ['c-skill', 'hello', 'claude']]);
  try {
    const r = runHook(turn('hello there'), { HOME: s.home }, s.cwd, ['hermes']);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.deepEqual(JSON.parse(r.stdout), { context: `Skills that fit this work (read each SKILL.md before you start): h-skill (${join(s.home, 's/h-skill/SKILL.md')}).` });
    assert.equal(runHook(turn('nothing fits'), { HOME: s.home }, s.cwd, ['hermes']).stdout, '');
    assert.equal(runHook('not json', { HOME: s.home }, s.cwd, ['hermes']).stdout, '');
  } finally { s.cleanup(); }
});

test('hook as hermes: a multimodal turn routes on its text parts', () => {
  const s = hookSetup([['h-skill', 'hello']]);
  try {
    const r = runHook(turn([{ type: 'image_url', image_url: { url: 'data:x' } }, { type: 'text', text: 'hello' }]), { HOME: s.home }, s.cwd, ['hermes']);
    assert.match(contextOf(r), /h-skill/);
  } finally { s.cleanup(); }
});

test('hook as hermes: session memory and the suggest line, per Hermes session', () => {
  const s = hookSetup([['a-skill', 'alpha']]);
  try {
    const first = contextOf(runHook(turn('alpha', '20261117_120000_ab12cd'), { HOME: s.home }, s.cwd, ['hermes']));
    assert.match(first, /a-skill/);
    assert.match(first, / hermes suggest 20261117_120000_ab12cd "/);
    assert.equal(runHook(turn('alpha again', '20261117_120000_ab12cd'), { HOME: s.home }, s.cwd, ['hermes']).stdout, '');
  } finally { s.cleanup(); }
});

test('hook as hermes: a delegated child (named by subagent_start) gets no hints; its parent still does', () => {
  const s = hookSetup([['a-skill', 'alpha']]);
  try {
    const start = { hook_event_name: 'subagent_start', session_id: 'parent1', cwd: '', extra: { child_session_id: 'child1', child_goal: 'alpha work' } };
    const r = runHook(start, { HOME: s.home }, s.cwd, ['hermes']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(runHook(turn('alpha', 'child1'), { HOME: s.home }, s.cwd, ['hermes']).stdout, '');
    assert.match(contextOf(runHook(turn('alpha', 'parent1'), { HOME: s.home }, s.cwd, ['hermes'])), /a-skill/);
    // A child id with path characters is never used as a file name.
    runHook({ ...start, extra: { child_session_id: '../../evil' } }, { HOME: s.home }, s.cwd, ['hermes']);
    assert.equal(existsSync(join(s.udir, 'evil')), false);
  } finally { s.cleanup(); }
});

test('selfTest sends Hermes input and accepts {"context"} output', () => env(() => {
  installHookCopy('user');
  assert.ok(hookCommand('user', 'hermes').endsWith('route.mjs" hermes'));
  assert.equal(selfTest('user', 'hermes'), true);
}));
