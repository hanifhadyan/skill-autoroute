import { readdirSync, readFileSync, statSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

const SKIP = new Set(['node_modules', '.git']);
const unquote = (v) => v.replace(/^(["'])(.*)\1$/, '$2');

// shortcut: YAML subset (key: value, key: |/>); no nested maps or lists.
export function parseFrontmatter(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { body: text };
  const out = { body: text.slice(m[0].length) };
  const lines = (m[1] || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      value = block.join(value[0] === '>' ? ' ' : '\n').trim();
    } else {
      // wrapped plain scalar: indented continuation lines fold with a space
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += ' ' + lines[++i].trim();
      value = unquote(value);
    }
    const key = kv[1] === 'allowed-tools' ? 'allowedTools' : kv[1];
    if (['name', 'description', 'allowedTools'].includes(key)) out[key] = value;
  }
  return out;
}

const inside = (root, p) => p === root || p.startsWith(root + sep);

function hashFile(path) {
  const h = createHash('sha256');
  const buf = Buffer.alloc(65536);
  const fd = openSync(path, 'r');
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return h.digest('hex');
}

// Collect regular files under `root`. `seen` holds real dir paths so loops end;
// links that resolve outside `root` are recorded in `outside`, never read or walked;
// node_modules and .git are recorded in `skipped`, never read.
function walk(root, realDir, rel, seen, found, outside, skipped) {
  if (seen.has(realDir)) return;
  seen.add(realDir);
  let entries;
  try { entries = readdirSync(realDir); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name)) { skipped.push(rel + name); continue; }
    try {
      const real = realpathSync(join(realDir, name));
      if (!inside(root, real)) { outside.push(rel + name); continue; }
      const st = statSync(real);
      if (st.isDirectory()) walk(root, real, `${rel}${name}/`, seen, found, outside, skipped);
      else if (st.isFile()) found.push({ rel: rel + name, real, hash: hashFile(real) });
    } catch { /* unreadable or dangling: skip */ }
  }
}

export function discover(dirs) {
  const skills = [];
  const done = new Set();
  for (const { dir, tool, source } of dirs) {
    let names;
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const folder of names) {
      let real;
      try {
        real = realpathSync(join(dir, folder));
        if (!statSync(real).isDirectory()) continue;
      } catch { continue; }
      if (done.has(real)) continue;
      const skillPath = join(real, 'SKILL.md');
      let text;
      try {
        const sr = realpathSync(skillPath);
        if (!inside(real, sr) || !statSync(sr).isFile()) continue;
        text = readFileSync(sr, 'utf8');
      } catch { continue; }
      done.add(real);
      const found = [];
      const outside = [];
      const skipped = [];
      walk(real, real, '', new Set(), found, outside, skipped);
      found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      const h = createHash('sha256');
      for (const f of found) h.update(`${f.rel}\0${f.hash}\n`);
      const fm = parseFrontmatter(text);
      skills.push({
        name: fm.name || folder,
        description: fm.description || '',
        tool, source, dir: real, skillPath,
        hash: `sha256:${h.digest('hex')}`,
        files: found.map((f) => f.real),
        outside: outside.sort(),
        skipped: skipped.sort(),
      });
    }
  }
  return skills;
}
