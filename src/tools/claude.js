import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { addHook, removeHook as removeHookFrom, hasHook as hasHookIn } from './hookconfig.js';
import { runCli, parseJson, onPath, checkPrompt } from './run.js';

export const name = 'claude';

const settings = (scope) => (scope === 'project' ? join(process.cwd(), '.claude', 'settings.json') : join(homedir(), '.claude', 'settings.json'));
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

export const detect = () => ({ cli: onPath('claude'), configDir: existsSync(join(homedir(), '.claude')) });

// Plugin skill dirs come from installed_plugins.json, limited to plugins enabled in `settingsFile`.
function pluginDirs(settingsFile) {
  const enabled = readJson(settingsFile)?.enabledPlugins;
  const installed = readJson(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))?.plugins;
  if (!enabled || typeof enabled !== 'object' || !installed || typeof installed !== 'object') return [];
  const out = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true || !Array.isArray(installed[key])) continue;
    for (const e of installed[key]) {
      if (typeof e?.installPath !== 'string') continue;
      const source = `plugin:${key}`;
      const listed = readJson(join(e.installPath, '.claude-plugin', 'plugin.json'))?.skills;
      if (!Array.isArray(listed)) {
        const dir = join(e.installPath, 'skills');
        if (existsSync(dir)) out.push({ dir, tool: 'claude', source });
        continue;
      }
      // A manifest names its skill folders, which may sit deeper than skills/<name>: scan each parent for those names only.
      const byParent = new Map();
      for (const rel of listed) {
        const p = typeof rel === 'string' && resolve(e.installPath, rel);
        if (!p || !p.startsWith(e.installPath + sep) || !existsSync(p)) continue;
        byParent.set(dirname(p), [...(byParent.get(dirname(p)) ?? []), basename(p)]);
      }
      for (const [dir, only] of byParent) out.push({ dir, tool: 'claude', source, only });
    }
  }
  return out;
}

// Projects Claude Code has opened (~/.claude.json) or installed a plugin for (projectPath in installed_plugins.json). Their own skills and the plugins only they enable live outside
// the user dirs; the user table lists them with `projects`, and the hook hints them only inside that project.
function projectDirs(userDirs) {
  const seen = new Set(userDirs.map((d) => d.dir));
  const out = [];
  const installed = Object.values(readJson(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {});
  const roots = new Set([
    ...Object.keys(readJson(join(homedir(), '.claude.json'))?.projects ?? {}),
    ...installed.flatMap((list) => (Array.isArray(list) ? list : [])).map((e) => e?.projectPath).filter((p) => typeof p === 'string'),
  ]);
  for (const root of roots) {
    if (root === homedir() || !existsSync(root)) continue;
    const projects = [root];
    const own = join(root, '.claude', 'skills');
    if (existsSync(own)) out.push({ dir: own, tool: 'claude', source: 'project', projects });
    for (const f of ['settings.json', 'settings.local.json']) {
      for (const d of pluginDirs(join(root, '.claude', f))) {
        if (!seen.has(d.dir) && !out.some((o) => o.dir === d.dir && o.projects === projects)) out.push({ ...d, projects });
      }
    }
  }
  return out;
}

// Each scope lists only its own dirs; the hook merges the user and project tables at run time.
export function skillDirs(scope) {
  if (scope === 'project') return [{ dir: join(process.cwd(), '.claude', 'skills'), tool: 'claude', source: 'project' }, ...pluginDirs(settings(scope))];
  const user = [{ dir: join(homedir(), '.claude', 'skills'), tool: 'claude', source: 'user' }, ...pluginDirs(settings(scope))];
  return [...user, ...projectDirs(user)];
}

export const installHook = (scope, command) => addHook(settings(scope), command);
export const removeHook = (scope) => removeHookFrom(settings(scope));
export const hasHook = (scope) => hasHookIn(settings(scope));
export const hookConfig = (scope) => settings(scope);

// loadUserSettings (bench only): keep the user's settings, hooks and MCP so the routing hook fires.
export async function headless({ prompt, schema, model, effort, timeoutMs, loadUserSettings = false, env }) {
  checkPrompt(prompt);
  const { stdout, stderr } = await runCli('claude', () => [
    '-p', prompt, '--model', model, '--effort', effort, '--tools', '', '--output-format', 'json',
    '--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema), '--no-session-persistence',
    ...(loadUserSettings ? [] : ['--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands']),
  ], timeoutMs, env);
  const r = parseJson('claude', stdout, stderr);
  if (r.is_error) throw new Error(`claude reported an error: ${String(r.result).slice(0, 200)}`);
  if (r.structured_output === undefined) throw new Error('claude result has no structured_output');
  const u = r.usage ?? {};
  return {
    json: r.structured_output,
    usage: {
      input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      model: Object.keys(r.modelUsage ?? {})[0] ?? model,
    },
  };
}
