// Per-prompt hook for Claude Code and Codex. Node built-ins only; any error means no output, exit 0.
import { readFileSync, statSync, realpathSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MAX_PROMPT = 20000; // defence in depth against a slow pattern
const MAX_HINTS = 3;

const mtime = (p) => {
  try { return statSync(p).mtimeMs; } catch { return 0; } // missing file or folder: ignored
};

// shortcut: patterns are validated at install/regenerate time; hand-edited patterns are not re-checked here, so a
// catastrophic regex in a hand-edited table can hang the hook. Upgrade: run the validation in the hook if users edit tables by hand.
const compile = (src) => {
  try { return new RegExp(src, 'i'); } catch { return null; }
};

// A rule fits when all its patterns match; a rule with a pattern that does not compile never fits.
function fits(rules, text) {
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => {
    if (!Array.isArray(rule) || !rule.length) return false;
    for (const src of rule) {
      const re = typeof src === 'string' ? compile(src) : null;
      if (!re || !re.test(text)) return false;
    }
    return true;
  });
}

export function staleCount(table, statMtime = mtime) {
  const gen = Date.parse(table.generatedAt);
  if (Number.isNaN(gen)) return 0;
  const newer = (p) => { try { return statMtime(p) > gen; } catch { return false; } };
  let n = table.skills.filter((s) => s && typeof s.path === 'string' && (newer(s.path) || newer(dirname(s.path)))).length;
  if (Array.isArray(table.roots)) n += table.roots.filter((r) => typeof r === 'string' && newer(r)).length;
  return n;
}

function pick(prompt, table, statMtime) {
  const text = String(prompt).slice(0, MAX_PROMPT);
  const ok = (v) => typeof v === 'string' && v !== '';
  const seen = new Set();
  const hits = table.skills
    .filter((s) => s && s.enabled && ok(s.name) && ok(s.path) && fits(s.patterns, text))
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .filter((s) => !seen.has(s.name) && seen.add(s.name))
    .slice(0, MAX_HINTS);
  if (!hits.length) return null;
  let out = 'Skills that fit this work (read each SKILL.md before you start): ' + hits.map((s) => `${s.name} (${s.path})`).join('; ') + '.';
  const n = staleCount(table, statMtime);
  if (n) out += `\n${n} skills changed since the last generate. Run: npx skill-autoroute regenerate`;
  return { out, count: hits.length };
}

export const route = (prompt, table, statMtime = mtime) => pick(prompt, table, statMtime)?.out ?? null;

const load = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

// Keep only what the hook can use: skills as plain objects, roots as strings. One bad entry must not disable the hook.
function clean(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.skills)) return null;
  return {
    ...t,
    skills: t.skills.filter((s) => s && typeof s === 'object' && !Array.isArray(s)),
    roots: Array.isArray(t.roots) ? t.roots.filter((r) => typeof r === 'string') : [],
  };
}

// Project entries replace user entries of the same name. Oldest valid generatedAt wins: stale if either side is.
export function merge(user, project) {
  const u = clean(user), p = clean(project);
  if (!u || !p) return u ?? p;
  const names = new Set(p.skills.map((s) => s.name));
  const gens = [u.generatedAt, p.generatedAt].filter((g) => !Number.isNaN(Date.parse(g))).sort((x, y) => Date.parse(x) - Date.parse(y));
  return {
    ...u,
    generatedAt: gens[0] ?? '',
    roots: [...new Set([...u.roots, ...p.roots])],
    skills: [...u.skills.filter((s) => !names.has(s.name)), ...p.skills],
    ...(u.log === true || p.log === true ? { log: true } : {}),
  };
}

function main() {
  if (process.env.SKILL_AUTOROUTE_DISABLE === '1') return;
  try {
    const { prompt } = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof prompt !== 'string') return;
    const udir = join(homedir(), '.config', 'skill-autoroute');
    const table = merge(load(join(udir, 'routes.json')), load(join(process.cwd(), '.skill-autoroute', 'routes.json')));
    if (!table) return;
    const hit = pick(prompt, table, mtime);
    if (!hit) return;
    const ctx = hit.out;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }) + '\n');
    if (process.env.SKILL_AUTOROUTE_LOG === '1' || table.log === true) {
      try {
        mkdirSync(udir, { recursive: true });
        appendFileSync(join(udir, 'usage.log'), `${new Date().toISOString()}\t${hit.count}\t${ctx.length}\n`);
      } catch { /* logging must never break a prompt */ }
    }
  } catch (e) {
    if (process.env.SKILL_AUTOROUTE_DEBUG === '1') process.stderr.write(`skill-autoroute: ${e && e.stack ? e.stack : e}\n`);
  }
}

// Run only when executed directly; realpath so a symlinked data folder still matches import.meta.url.
try {
  if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
} catch { /* never break a prompt */ }
