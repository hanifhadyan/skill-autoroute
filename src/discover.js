import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const SKIP = new Set(['node_modules', '.git']);
const unquote = (v) => v.replace(/^(["'])(.*)\1$/, '$2');

// shortcut: YAML subset (key: value, key: |/>); no nested maps or lists.
export function parseFrontmatter(text) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  const out = { body: text.slice(m[0].length) };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = block.join(value[0] === '>' ? ' ' : '\n').trim();
    } else value = unquote(value);
    const key = kv[1] === 'allowed-tools' ? 'allowedTools' : kv[1];
    if (['name', 'description', 'allowedTools'].includes(key)) out[key] = value;
  }
  return out;
}

// Collect readable files under a skill folder; `seen` holds real dir paths so loops end.
function walk(realDir, rel, seen, found) {
  if (seen.has(realDir)) return;
  seen.add(realDir);
  let entries;
  try { entries = readdirSync(realDir); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(realDir, name);
    try {
      const real = realpathSync(p);
      if (statSync(real).isDirectory()) walk(real, `${rel}${name}/`, seen, found);
      else found.push({ rel: rel + name, real, data: readFileSync(real) });
    } catch { /* unreadable or dangling: skip */ }
  }
}

export function discover(dirs) {
  const skills = [];
  for (const { dir, tool, source } of dirs) {
    let names;
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const folder of names) {
      let real;
      try {
        real = realpathSync(join(dir, folder));
        if (!statSync(real).isDirectory()) continue;
      } catch { continue; }
      const skillPath = join(real, 'SKILL.md');
      let text;
      try { text = readFileSync(skillPath, 'utf8'); } catch { continue; }
      const found = [];
      walk(real, '', new Set(), found);
      found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const h = createHash('sha256');
      for (const f of found) h.update(f.rel).update('\0').update(f.data).update('\0');
      const fm = parseFrontmatter(text);
      skills.push({
        name: fm.name || folder,
        description: fm.description || '',
        tool, source, dir: real, skillPath,
        hash: `sha256:${h.digest('hex')}`,
        files: found.map((f) => f.real),
      });
    }
  }
  return skills;
}
