import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addHook, removeHook as removeHookFrom } from './hookconfig.js';
import { runCli, parseJson, onPath, checkPrompt } from './run.js';

export const name = 'codex';

const NO_PROJECT = { changed: false, note: 'codex uses the user-level hook; it reads the project table' };
const hooksFile = () => join(homedir(), '.codex', 'hooks.json');

export const detect = () => ({ cli: onPath('codex'), configDir: existsSync(join(homedir(), '.codex')) });

export function skillDirs(scope) {
  if (scope === 'project') return [{ dir: join(process.cwd(), '.agents', 'skills'), tool: 'codex', source: 'project' }];
  return [
    { dir: join(homedir(), '.agents', 'skills'), tool: 'codex', source: 'user' },
    { dir: join(homedir(), '.codex', 'skills'), tool: 'codex', source: 'user' },
  ];
}

export function installHook(scope, command) {
  if (scope === 'project') return { ...NO_PROJECT };
  const r = addHook(hooksFile(), command);
  return r.changed ? { ...r, note: 'run /hooks once in Codex to trust the new hook' } : r;
}
export const removeHook = (scope) => (scope === 'project' ? { ...NO_PROJECT } : removeHookFrom(hooksFile()));

export async function headless({ prompt, schema, model, effort, timeoutMs }) {
  checkPrompt(prompt);
  const { stdout, stderr } = await runCli('codex', (dir) => {
    const schemaFile = join(dir, 'schema.json');
    writeFileSync(schemaFile, typeof schema === 'string' ? schema : JSON.stringify(schema));
    return [
      'exec', '--skip-git-repo-check', '--json', '--ignore-user-config', '-s', 'read-only',
      ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort=${effort}`,
      '--output-schema', schemaFile, prompt,
    ];
  }, timeoutMs);
  let text, usage;
  for (const line of stdout.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
    else if (ev.type === 'turn.completed') usage = ev.usage;
  }
  if (text === undefined) throw new Error(`codex output had no agent_message: ${(stderr.trim() || stdout.trim()).slice(0, 200)}`);
  return {
    json: parseJson('codex agent_message', text, stderr),
    usage: { input: usage?.input_tokens ?? 0, cacheRead: usage?.cached_input_tokens ?? 0, output: usage?.output_tokens ?? 0, model: model ?? null },
  };
}
