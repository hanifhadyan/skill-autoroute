import { existsSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { onPath } from './run.js';

export const name = 'hermes';

// Hermes keeps every file under HERMES_HOME (a profile sets it); the default is ~/.hermes.
export const hermesHome = () => process.env.HERMES_HOME || join(homedir(), '.hermes');
const configFile = () => join(hermesHome(), 'config.yaml');

const MARK = 'skill-autoroute/route.mjs';
// pre_llm_call fires once per user turn and injects {"context"}; subagent_start lets the hook skip delegated children.
export const EVENTS = ['pre_llm_call', 'subagent_start'];
const TIMEOUT = 10;
const NO_PROJECT = { changed: false, note: 'hermes uses the user-level hook; it reads the project table' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ours = (h) => isObj(h) && typeof h.command === 'string' && h.command.includes(MARK);

export const detect = () => ({ cli: onPath('hermes'), configDir: existsSync(hermesHome()) });

// Settings are read and written through the Hermes CLI: no YAML parser here, and Hermes keeps its own
// file checks. The CLI runs only when a Hermes folder exists, so a machine without Hermes never spawns it.
function cli(args) {
  if (!existsSync(hermesHome()) || !onPath('hermes')) return null;
  return spawnSync('hermes', args, { encoding: 'utf8', timeout: 60000 });
}

// The JSON value of `key`; undefined when the key is unset, Hermes is missing or the output is not JSON.
export function getKey(key) {
  const r = cli(['config', 'get', '--json', key]);
  if (!r || r.status !== 0) return undefined;
  try { return JSON.parse(r.stdout); } catch { return undefined; }
}

function setKey(key, value) {
  const r = cli(['config', 'set', key, JSON.stringify(value)]);
  if (!r) throw new Error('the hermes CLI was not found on PATH; install or start Hermes first, nothing was changed');
  if (r.status !== 0) throw new Error(`hermes config set ${key} failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}

const names = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((s) => String(s).trim()).filter(Boolean);

// `~` and ${VAR} / $VAR, as Hermes expands skills.external_dirs.
const expand = (p) => String(p)
  .replace(/^~(?=$|[\\/])/, homedir())
  .replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => process.env[a ?? b] ?? m);

// Hermes nests skills in category folders (skills/<category>/<skill>/SKILL.md). discover() lists the skill
// folders inside one dir, so every folder without a SKILL.md is a container whose children are listed too.
// Skill folders are never walked: their subfolders are references and scripts.
function containers(root, depth = 0, out = []) {
  out.push(root);
  if (depth >= 3) return out;
  let entries;
  try { entries = readdirSync(root).sort(); } catch { return out; }
  for (const n of entries) {
    if (n.startsWith('.') || n === 'node_modules') continue;
    const p = join(root, n);
    try {
      if (!statSync(p).isDirectory() || existsSync(join(p, 'SKILL.md'))) continue;
    } catch { continue; }
    containers(p, depth + 1, out);
  }
  return out;
}

const PLATFORM = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform] ?? process.platform;

// The values of a top-level frontmatter list (`key: [a, b]` or an indented `- a` block); null when the key is absent.
export function frontmatterList(text, key) {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!fm) return null;
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return null;
  if (m[1].trim()) return m[1].replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
  const after = fm.slice(m.index + m[0].length).split(/\r?\n/).slice(1);
  const out = [];
  for (const l of after) {
    const item = /^\s+-\s*(.+)$/.exec(l);
    if (!item) break;
    out.push(item[1].trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

// True for a skill Hermes does not load in a normal session: turned off in skills.disabled, made for another
// platform (`platforms:`), or limited to special environments such as Kanban workers (`environments:`).
export const hiddenBy = (disabled) => (skillName, text) => {
  if (disabled.includes(skillName)) return true;
  const platforms = frontmatterList(text, 'platforms');
  if (platforms && platforms.length && !platforms.includes(PLATFORM)) return true;
  return Boolean(frontmatterList(text, 'environments')?.length);
};

// Each scope lists only its own dirs, without the skills Hermes would not load.
export function skillDirs(scope) {
  if (scope === 'project') {
    // A trusted project's own skills (`hermes skills trust`).
    return ['.hermes', '.agents'].map((d) => ({ dir: join(process.cwd(), d, 'skills'), tool: 'hermes', source: 'project', skip: hiddenBy([]) }));
  }
  const skip = hiddenBy(names(getKey('skills.disabled')));
  const roots = [join(hermesHome(), 'skills'), ...names(getKey('skills.external_dirs')).map(expand)];
  return roots.flatMap((r) => containers(r)).map((dir) => ({ dir, tool: 'hermes', source: 'user', skip }));
}

// {event: [entries]}; throws (naming the key) when a hook list has an unexpected shape.
function hookLists() {
  const hooks = getKey('hooks');
  if (hooks !== undefined && hooks !== null && !isObj(hooks)) throw new Error(`${configFile()}: hooks must be a mapping; nothing was changed`);
  const out = {};
  for (const e of EVENTS) {
    const list = hooks?.[e];
    if (list !== undefined && list !== null && !Array.isArray(list)) throw new Error(`${configFile()}: hooks.${e} must be a list; nothing was changed`);
    out[e] = list ?? [];
  }
  return out;
}

// Called before any write: Hermes must be installed and its hook settings must have the expected shape.
export function checkConfig(scope) {
  if (scope === 'project') return;
  if (!onPath('hermes')) throw new Error('the hermes CLI was not found on PATH; nothing was changed');
  hookLists();
}

export function installHook(scope, command) {
  if (scope === 'project') return { ...NO_PROJECT };
  if (!command.includes(MARK)) throw new Error(`hook command must contain "${MARK}"`);
  const lists = hookLists();
  const todo = EVENTS.filter((e) => {
    const mine = lists[e].filter(ours);
    return !(mine.length === 1 && mine[0].command === command);
  });
  if (!todo.length) return { changed: false };
  const bak = `${configFile()}.bak-skill-autoroute`;
  if (existsSync(configFile()) && !existsSync(bak)) copyFileSync(configFile(), bak);
  for (const e of todo) setKey(`hooks.${e}`, [...lists[e].filter((h) => !ours(h)), { command, timeout: TIMEOUT }]);
  return { changed: true, note: 'Hermes asks once to allow the new hook the next time it starts (or run: hermes hooks list)' };
}

export function removeHook(scope) {
  if (scope === 'project') return { ...NO_PROJECT };
  if (!detect().cli || !detect().configDir) return { changed: false };
  const lists = hookLists();
  let changed = false;
  for (const e of EVENTS) {
    if (!lists[e].some(ours)) continue;
    setKey(`hooks.${e}`, lists[e].filter((h) => !ours(h)));
    changed = true;
  }
  return { changed };
}

export function hasHook() {
  try { return hookLists().pre_llm_call.some(ours); } catch { return false; }
}
export const hookConfig = (scope) => (scope === 'project' ? null : configFile());

// What Hermes sends a pre_llm_call shell hook, and whether a reply has the shape it reads.
export const testInput = (text, cwd) => ({ hook_event_name: 'pre_llm_call', session_id: '', cwd, extra: { user_message: text } });
export const outputOk = (o) => isObj(o) && typeof o.context === 'string';
