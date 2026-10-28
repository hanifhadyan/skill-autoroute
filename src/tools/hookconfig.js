import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookCopyPath } from '../paths.js';

const MARK = 'skill-autoroute';
const EVENT = 'UserPromptSubmit';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ours = (h) => isObj(h) && typeof h.command === 'string' && h.command.includes(MARK);

// Returns {cfg, existed}. Throws (never overwrites) on invalid JSON or an unexpected shape.
function load(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { cfg: {}, existed: false };
    throw e;
  }
  if (!text.trim()) return { cfg: {}, existed: true };
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) {
    throw new Error(`${path} is not valid JSON (${e.message}); fix or remove it, nothing was changed`);
  }
  const groups = isObj(cfg) && (cfg.hooks === undefined || (isObj(cfg.hooks) && (cfg.hooks[EVENT] === undefined || Array.isArray(cfg.hooks[EVENT]))));
  if (!groups) throw new Error(`${path} has an unexpected shape (hooks.${EVENT} must be an array); nothing was changed`);
  return { cfg, existed: true };
}

function save(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, path);
}

const groupHooks = (g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []);

export function addHook(configPath, command) {
  const { cfg, existed } = load(configPath);
  const groups = cfg.hooks?.[EVENT] ?? [];
  if (groups.some((g) => groupHooks(g).some(ours))) return { changed: false };
  const bak = `${configPath}.bak-skill-autoroute`;
  if (existed && !existsSync(bak)) copyFileSync(configPath, bak);
  cfg.hooks ??= {};
  cfg.hooks[EVENT] = [...groups, { hooks: [{ type: 'command', command }] }];
  save(configPath, cfg);
  return { changed: true };
}

export function removeHook(configPath) {
  const { cfg, existed } = load(configPath);
  const groups = cfg.hooks?.[EVENT];
  if (!existed || !groups?.some((g) => groupHooks(g).some(ours))) return { changed: false };
  const kept = [];
  for (const g of groups) {
    const rest = groupHooks(g).filter((h) => !ours(h));
    if (rest.length === groupHooks(g).length) kept.push(g);
    else if (rest.length) kept.push({ ...g, hooks: rest });
  }
  if (kept.length) cfg.hooks[EVENT] = kept;
  else delete cfg.hooks[EVENT];
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  save(configPath, cfg);
  return { changed: true };
}

// The npx cache can vanish after install, so the hook runs from a copy in the data folder.
export function installHookCopy(scope) {
  const dest = hookCopyPath(scope);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../../hook/route.js', import.meta.url)), dest);
  return scope === 'project' ? 'node "$CLAUDE_PROJECT_DIR/.skill-autoroute/route.mjs"' : `node "${dest}"`;
}
