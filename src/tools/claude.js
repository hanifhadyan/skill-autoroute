import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addHook, removeHook as removeHookFrom } from './hookconfig.js';
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
      const dir = typeof e?.installPath === 'string' && join(e.installPath, 'skills');
      if (dir && existsSync(dir)) out.push({ dir, tool: 'claude', source: `plugin:${key}` });
    }
  }
  return out;
}

// Each scope lists only its own dirs; the hook merges the user and project tables at run time.
export function skillDirs(scope) {
  const base = scope === 'project' ? join(process.cwd(), '.claude') : join(homedir(), '.claude');
  return [{ dir: join(base, 'skills'), tool: 'claude', source: scope === 'project' ? 'project' : 'user' }, ...pluginDirs(settings(scope))];
}

export const installHook = (scope, command) => addHook(settings(scope), command);
export const removeHook = (scope) => removeHookFrom(settings(scope));

export async function headless({ prompt, schema, model, effort, timeoutMs }) {
  checkPrompt(prompt);
  const { stdout, stderr } = await runCli('claude', () => [
    '-p', prompt, '--model', model, '--effort', effort, '--tools', '', '--output-format', 'json',
    '--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema), '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands',
  ], timeoutMs);
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
