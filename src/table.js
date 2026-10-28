import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function readTable(path) {
  try {
    const t = JSON.parse(readFileSync(path, 'utf8'));
    return t && Array.isArray(t.skills) ? t : null;
  } catch {
    return null;
  }
}

export function writeTable(path, table) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n');
  renameSync(tmp, path);
}

// Keep in step with merge() in hook/route.js (the hook cannot import src/).
export function mergeTables(user, project) {
  const u = user ?? { skills: [] };
  const p = project ?? { skills: [] };
  const names = new Set(p.skills.map((s) => s.name));
  const roots = [...new Set([...(u.roots ?? []), ...(p.roots ?? [])])];
  const gens = [u, p].map((t) => t.generatedAt).filter(Boolean).sort(); // oldest wins: stale if either side is
  return {
    version: 1,
    generatedAt: gens[0] ?? '',
    generator: (project ?? user)?.generator,
    ...(roots.length ? { roots } : {}),
    skills: [...u.skills.filter((s) => !names.has(s.name)), ...p.skills],
  };
}
