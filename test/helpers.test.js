import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fakeHome, fakeCli, runHook } from './helpers.js';

test('fakeCli writes an executable that runs the script', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = fakeCli(home, 'mytool', 'console.log("hi " + process.argv[2])');
    assert.equal(p, join(home, 'mytool'));
    assert.ok(statSync(p).mode & 0o111, 'executable bit set');
    const out = execFileSync(p, ['there'], { encoding: 'utf8' });
    assert.equal(out, 'hi there\n');
  } finally {
    cleanup();
  }
});

test('fakeHome dir exists until cleanup() removes it', () => {
  const { home, cleanup } = fakeHome();
  assert.ok(existsSync(home));
  cleanup();
  assert.ok(!existsSync(home));
});

test('runHook is exported', () => {
  assert.equal(typeof runHook, 'function');
});
