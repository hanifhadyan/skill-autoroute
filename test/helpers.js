import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'skill-autoroute-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// Tests prepend `dir` to PATH to stand in for a real CLI.
export function fakeCli(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

export function runHook(stdinJson, env = {}, cwd = process.cwd()) {
  const t0 = Date.now();
  const r = spawnSync('node', [join(root, 'hook', 'route.js')], {
    input: typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    cwd,
    timeout: 5000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}
