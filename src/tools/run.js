import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, accessSync, statSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const head = (s) => s.trim().slice(0, 200);


// Runs `cmd` with no shell, stdin ignored, in a fresh temp cwd that is removed afterwards.
// `buildArgs(dir)` may write helper files into that dir. Resolves {stdout, stderr}; rejects on
// spawn error, non-zero exit or timeout.
export function runCli(cmd, buildArgs, timeoutMs = 180000) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-autoroute-run-'));
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false, timer;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      fn(v);
    };
    let child;
    try {
      child = spawn(cmd, buildArgs(dir), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish(reject, e); }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, new Error(`could not run ${cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0
      ? finish(resolve, { stdout: out, stderr: err })
      : finish(reject, new Error(`${cmd} exited with code ${code}: ${head(err) || head(out)}`))));
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new Error(`${cmd} timed out after ${timeoutMs} ms`)); }, timeoutMs);
  });
}

export const parseJson = (cmd, text, stderr = '') => {
  try { return JSON.parse(text); } catch { throw new Error(`${cmd} output was not JSON: ${head(stderr) || head(text)}`); }
};
export const checkPrompt = (prompt) => {
  if (typeof prompt !== 'string' || prompt.startsWith('-')) throw new Error('prompt must be a string that does not start with "-"');
};

// Searches PATH itself (no `which` subprocess).
export function onPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD').split(';') : [''];
  for (const d of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const x of exts) {
      try {
        const f = join(d, name + x);
        if (statSync(f).isFile()) { accessSync(f, constants.X_OK); return true; }
      } catch { /* not here */ }
    }
  }
  return false;
}
