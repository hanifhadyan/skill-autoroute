// Per-prompt hook for Claude Code and Codex. Node built-ins only; any error means no output, exit 0.
// argv[2] names the tool (claude or codex): only that tool's skills are hinted; no argument hints all.
import { readFileSync, statSync, readdirSync, realpathSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const MAX_PROMPT = 20000; // defence in depth against a slow pattern
const MAX_HINTS = 3;
const MAX_PATTERN = 300; // same limit as src/validate.js
const MAX_NAME = 100;

// Real file system; tests pass fakes. mtime is null when the path is missing.
const FS = {
  mtime: (p) => { try { return statSync(p).mtimeMs; } catch { return null; } },
  list: (d) => { try { return readdirSync(d); } catch { return []; } },
  real: (p) => { try { return realpathSync(p); } catch { return p; } },
};

// rep: * + {n,} {n,m} with m>n (inside a group this makes it risky). multi: also any fixed {n} with n>=2
// (a group repeated like that is risky when its body has a rep). ? never counts.
function readQuantifier(src, i) {
  const c = src[i];
  if (c === '*' || c === '+') return { len: 1, rep: true, multi: true };
  if (c === '?') return { len: 1, rep: false, multi: false };
  if (c !== '{') return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 24));
  if (!m) return null; // a literal "{" without the u flag
  const rep = m[2] !== undefined && (m[3] === '' || +m[3] > Math.max(+m[1], 1));
  return { len: m[0].length, rep, multi: rep || +(m[3] || m[1]) > 1 };
}

const wild = (t) => t === null || t === '.';
const cls = (t) => t[0] === '[' || t[0] === '(' || /^\\[wWdDsS]$/.test(t);
// shortcut: branches overlap if they start with the same atom or are both classes; the timing test is the backstop.
function overlapping(firsts) {
  for (let a = 0; a < firsts.length; a++) {
    for (let b = a + 1; b < firsts.length; b++) {
      const x = firsts[a], y = firsts[b];
      if (wild(x) || wild(y) || x.toLowerCase() === y.toLowerCase() || (cls(x) && cls(y))) return true;
    }
  }
  return false;
}

// Static scan: a repeated group whose body has a repeating quantifier, or an alternation with overlapping branches.
export function hasNestedQuantifier(src) {
  const stack = [{ q: false, firsts: [null] }];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const atom = (tok) => {
    const f = top().firsts;
    if (f[f.length - 1] === null) f[f.length - 1] = tok;
  };
  const quant = () => {
    const q = readQuantifier(src, i);
    if (!q) return null;
    i += q.len;
    if (src[i] === '?') i++; // lazy suffix
    return q;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' || c === '[') {
      let end = i + 2;
      if (c === '[') {
        end = i + 1;
        while (end < src.length && src[end] !== ']') end += src[end] === '\\' ? 2 : 1;
        end++;
      }
      atom(src.slice(i, end));
      i = end;
      if (quant()?.rep) top().q = true;
    } else if (c === '(') {
      i++;
      if (src[i] === '?') {
        const m = /^\?(:|=|!|<=|<!|<[^>]*>)/.exec(src.slice(i, i + 64));
        i += m ? m[0].length : 1;
      }
      stack.push({ q: false, firsts: [null] });
    } else if (c === ')') {
      i++;
      if (stack.length === 1) continue;
      const g = stack.pop();
      const q = quant();
      if (q?.multi && (g.q || overlapping(g.firsts))) return true;
      top().q ||= g.q || q?.rep === true;
      atom('(');
    } else if (c === '|') {
      top().firsts.push(null);
      i++;
    } else if (c === '^' || c === '$') {
      i++;
    } else {
      atom(c);
      i++;
      if (quant()?.rep) top().q = true;
    }
  }
  return false;
}

// Project tables are untrusted (they arrive with a git clone), so every table is re-checked here: long or nested
// patterns are skipped. The hook cannot time a pattern; the 20000-character prompt cap is the backstop.
const compile = (src) => {
  if (typeof src !== 'string' || !src || src.length > MAX_PATTERN || hasNestedQuantifier(src)) return null;
  try { return new RegExp(src, 'i'); } catch { return null; }
};

// A rule fits when all its patterns match; a rule with a skipped pattern never fits.
function fits(rules, text) {
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => {
    if (!Array.isArray(rule) || !rule.length) return false;
    for (const src of rule) {
      const re = compile(src);
      if (!re || !re.test(text)) return false;
    }
    return true;
  });
}

// Stale: a table skill whose SKILL.md is gone or newer than the table (project entries: gone only, since a clone or
// pull resets file times past the committed generatedAt), plus a skill folder in a root that the table
// does not know (table paths are real paths; root entries are often symlinks, so they are resolved first).
export function staleCount(table, fs = FS) {
  const gen = Date.parse(table.generatedAt);
  const entries = table.skills.filter((s) => s && typeof s.path === 'string');
  const known = new Set(entries.map((s) => dirname(s.path)));
  let n = 0;
  for (const { path: p, project } of entries) {
    const m = fs.mtime(p);
    if (m === null) n++;
    else if (!project && !Number.isNaN(gen) && (m > gen || (fs.mtime(dirname(p)) ?? 0) > gen)) n++;
  }
  for (const r of Array.isArray(table.roots) ? table.roots : []) {
    if (typeof r !== 'string') continue;
    for (const name of fs.list(r)) {
      const d = join(r, name);
      if (fs.mtime(join(d, 'SKILL.md')) !== null && !known.has(fs.real(d))) n++;
    }
  }
  return n;
}

// Names come from skill files and go into model context: short, plain characters only.
const shownName = (v) => v.slice(0, MAX_NAME).replace(/[^A-Za-z0-9._:@/ -]/g, '?');

function pick(prompt, table, { tool, fs = FS } = {}) {
  const text = String(prompt).slice(0, MAX_PROMPT);
  const ok = (v) => typeof v === 'string' && v !== '';
  const seen = new Set();
  const hits = table.skills
    .filter((s) => s && s.enabled && ok(s.name) && ok(s.path) && /[\\/]SKILL\.md$/.test(s.path) && (!tool || (Array.isArray(s.tools) ? s.tools : [s.tool]).includes(tool)))
    .filter((s) => fits(s.patterns, text) && fs.mtime(s.path) !== null)
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .filter((s) => !seen.has(s.name) && seen.add(s.name))
    .slice(0, MAX_HINTS);
  if (!hits.length) return null;
  const safe = (v) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  let out = 'Skills that fit this work (read each SKILL.md before you start): ' + hits.map((s) => `${shownName(s.name)} (${safe(s.path)})`).join('; ') + '.';
  const n = staleCount(table, fs);
  if (n) out += `\n${n} skill${n === 1 ? '' : 's'} changed since the last generate. Run: npx skill-autoroute regenerate`;
  return { out, count: hits.length };
}

export const route = (prompt, table, opts) => pick(prompt, table, opts)?.out ?? null;

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

// A project table stores paths relative to the project root. Resolve them; an entry that leaves the root is dropped.
export function resolveProject(table, base) {
  const t = clean(table);
  if (!t) return null;
  const root = FS.real(base);
  const under = (p) => p.startsWith(root + sep);
  const abs = (p) => resolve(root, p);
  return {
    ...t,
    roots: t.roots.map(abs).filter(under),
    skills: t.skills.filter((s) => typeof s.path === 'string' && under(abs(s.path))).map((s) => ({ ...s, path: abs(s.path), project: true })),
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

const userClaudeHook = (udir) => {
  try {
    const copy = join(udir, 'route.mjs');
    const text = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8');
    return existsSync(copy) && (text.includes(copy) || text.includes(JSON.stringify(copy).slice(1, -1)));
  } catch { return false; }
};

function main(self) {
  if (process.env.SKILL_AUTOROUTE_DISABLE === '1') return;
  const udir = join(homedir(), '.config', 'skill-autoroute');
  // The user Claude hook already merges the project table; the project copy beside it would hint twice.
  // Only a Claude user hook counts: a Codex-only user install must not silence the Claude project hook.
  if (self.endsWith(`${sep}.skill-autoroute${sep}route.mjs`) && userClaudeHook(udir)) return;
  try {
    const { prompt } = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof prompt !== 'string') return;
    const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const table = merge(load(join(udir, 'routes.json')), resolveProject(load(join(base, '.skill-autoroute', 'routes.json')), base));
    if (!table) return;
    const hit = pick(prompt, table, { tool: process.argv[2] });
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
  const self = process.argv[1] && realpathSync(process.argv[1]);
  if (self && import.meta.url === pathToFileURL(self).href) main(self);
} catch { /* never break a prompt */ }
