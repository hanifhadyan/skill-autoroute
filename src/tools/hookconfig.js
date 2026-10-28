import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, existsSync, realpathSync, statSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookCopyPath } from '../paths.js';

const MARK = 'skill-autoroute/route.mjs';
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

// Writes next to the real target (a symlinked config stays a symlink) and keeps the file mode.
function save(path, cfg) {
  mkdirSync(dirname(path), { recursive: true });
  const target = existsSync(path) ? realpathSync(path) : path;
  const tmp = `${target}.tmp-${process.pid}`;
  const mode = existsSync(target) ? statSync(target).mode & 0o7777 : null;
  try {
    // created with the target's mode, so a private config is never world-readable, not even briefly
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', mode === null ? undefined : { mode });
    if (mode !== null) chmodSync(tmp, mode); // the umask may have narrowed it
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

const groupHooks = (g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []);

export function addHook(configPath, command) {
  if (!command.includes(MARK)) throw new Error(`hook command must contain "${MARK}"`);
  const { cfg, existed } = load(configPath);
  const groups = cfg.hooks?.[EVENT] ?? [];
  const mine = groups.flatMap(groupHooks).filter(ours);
  if (mine.length && mine.every((h) => h.command === command)) return { changed: false };
  const bak = `${configPath}.bak-skill-autoroute`;
  if (existed && !existsSync(bak)) copyFileSync(configPath, bak);
  if (mine.length) for (const h of mine) h.command = command; // an older install (other node, no tool argument): update in place
  else {
    cfg.hooks ??= {};
    cfg.hooks[EVENT] = [...groups, { hooks: [{ type: 'command', command }] }];
  }
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

// Throws (naming the file) when addHook would refuse it; used to check every config before any write.
export const checkConfig = (configPath) => { load(configPath); };

// False when the file is missing or unreadable.
export function hasHook(configPath) {
  try { return (load(configPath).cfg.hooks?.[EVENT] ?? []).some((g) => groupHooks(g).some(ours)); } catch { return false; }
}

// The npx cache can vanish after install, so the hook runs from a copy in the data folder. Returns the copy's path.
export function installHookCopy(scope) {
  const dest = hookCopyPath(scope);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    copyFileSync(fileURLToPath(new URL('../../hook/route.js', import.meta.url)), tmp);
    renameSync(tmp, dest);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  return dest;
}

// The hook command for one tool; the tool argument makes the hook hint only that tool's skills.
// User scope runs the installing node by absolute path; project settings are shared in git, so they name `node`.
export const hookCommand = (scope, tool) => (scope === 'project'
  ? `node "$CLAUDE_PROJECT_DIR/.skill-autoroute/route.mjs" ${tool}`
  : `"${process.execPath}" "${hookCopyPath(scope)}" ${tool}`);
