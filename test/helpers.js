import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

export function runHook(stdinJson, env = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('node', [join(root, 'hook', 'route.js')], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // a missing hook file can exit before stdin is written
    child.stdin.on('error', () => {});
    child.stdin.end(typeof stdinJson === 'string' ? stdinJson : JSON.stringify(stdinJson));
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}
