import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { merge } from '../hook/route.js';

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
  try {
    writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n');
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

export function mergeTables(user, project) {
  const m = merge(user, project) ?? { generatedAt: '', skills: [] };
  return { version: 1, generator: (project ?? user)?.generator, ...m };
}
