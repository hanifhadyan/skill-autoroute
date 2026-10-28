import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, discover } from '../src/discover.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');

function tmpCopy() {
  const d = mkdtempSync(join(tmpdir(), 'skill-autoroute-disc-'));
  cpSync(fixtures, d, { recursive: true });
  return { d, cleanup: () => { chmodAll(d); rmSync(d, { recursive: true, force: true }); } };
}
function chmodAll(d) { try { chmodSync(join(d, 'alpha', 'locked.txt'), 0o644); } catch {} }
const roots = (d) => [{ dir: d, tool: 'claude', source: 'user' }];

test('parseFrontmatter folds description: > and keeps body', () => {
  const r = parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\nallowed-tools: Read\n---\nBody\n');
  assert.equal(r.name, 'x');
  assert.equal(r.description, 'one two');
  assert.equal(r.allowedTools, 'Read');
  assert.equal(r.body, 'Body\n');
});

test('parseFrontmatter keeps newlines for | and strips quotes', () => {
  const r = parseFrontmatter('---\nname: "q"\ndescription: |\n  a\n  b\n---\nB');
  assert.equal(r.name, 'q');
  assert.equal(r.description, 'a\nb');
});

test('parseFrontmatter without frontmatter returns body only', () => {
  assert.deepEqual(parseFrontmatter('# Title\ntext'), { body: '# Title\ntext' });
});

test('discover finds the 3 fixture skills and ignores folders without SKILL.md', () => {
  const skills = discover([{ dir: fixtures, tool: 'claude', source: 'user' }]);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['alpha', 'beta', 'gamma']);
  const alpha = skills.find((s) => s.name === 'alpha');
  assert.equal(alpha.description, 'Reviews pull requests and writes comments.');
  assert.equal(alpha.tool, 'claude');
  assert.equal(alpha.source, 'user');
  assert.equal(alpha.dir, realpathSync(join(fixtures, 'alpha')));
  assert.equal(alpha.skillPath, join(alpha.dir, 'SKILL.md'));
  assert.match(alpha.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(alpha.files.length, 2);
  // name falls back to folder name
  assert.equal(skills.find((s) => s.dir.endsWith('gamma')).name, 'gamma');
});

test('discover returns [] for a missing dir', () => {
  assert.deepEqual(discover([{ dir: '/nonexistent/skill-autoroute', tool: 'codex', source: 'x' }]), []);
});

test('symlink loop inside a skill does not hang; skill still returned', () => {
  const { d, cleanup } = tmpCopy();
  try {
    symlinkSync(join(d, 'alpha'), join(d, 'alpha', 'loop'));
    const alpha = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.ok(alpha);
    assert.equal(alpha.files.length, 2);
  } finally { cleanup(); }
});

test('unreadable file is skipped', { skip: process.getuid?.() === 0 }, () => {
  const { d, cleanup } = tmpCopy();
  try {
    writeFileSync(join(d, 'alpha', 'locked.txt'), 'secret');
    chmodSync(join(d, 'alpha', 'locked.txt'), 0o000);
    const alpha = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.equal(alpha.files.length, 2);
    assert.ok(!alpha.files.some((f) => f.endsWith('locked.txt')));
  } finally { cleanup(); }
});

test('node_modules and .git are skipped', () => {
  const { d, cleanup } = tmpCopy();
  try {
    for (const n of ['node_modules', '.git']) {
      mkdirSync(join(d, 'alpha', n));
      writeFileSync(join(d, 'alpha', n, 'x.js'), 'x');
    }
    mkdirSync(join(d, 'alpha', 'scripts', 'node_modules'));
    const alpha = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.equal(alpha.files.length, 2);
    assert.deepEqual(alpha.skipped, ['.git', 'node_modules', 'scripts/node_modules']);
    assert.deepEqual(discover(roots(d)).find((s) => s.name === 'beta').skipped, []);
  } finally { cleanup(); }
});

test('hash changes when one file changes and is stable otherwise', () => {
  const { d, cleanup } = tmpCopy();
  try {
    const h1 = discover(roots(d)).find((s) => s.name === 'alpha').hash;
    assert.equal(discover(roots(d)).find((s) => s.name === 'alpha').hash, h1);
    writeFileSync(join(d, 'alpha', 'scripts', 'check.js'), 'changed');
    assert.notEqual(discover(roots(d)).find((s) => s.name === 'alpha').hash, h1);
  } finally { cleanup(); }
});

test('symlinked skill folder is followed and reported by real path', () => {
  const { d, cleanup } = tmpCopy();
  const other = mkdtempSync(join(tmpdir(), 'skill-autoroute-disc-'));
  try {
    symlinkSync(join(d, 'beta'), join(other, 'linked'));
    const [s] = discover([{ dir: other, tool: 'codex', source: 'p' }]);
    assert.equal(s.dir, realpathSync(join(d, 'beta')));
    assert.equal(s.tool, 'codex');
  } finally { cleanup(); rmSync(other, { recursive: true, force: true }); }
});

test('links escaping the skill folder are not read, hashed or walked; they are reported in outside', () => {
  const { d, cleanup } = tmpCopy();
  const out = mkdtempSync(join(tmpdir(), 'skill-autoroute-out-'));
  try {
    writeFileSync(join(out, 'secret.txt'), 's');
    mkdirSync(join(out, 'dir'));
    writeFileSync(join(out, 'dir', 'inner.txt'), 'i');
    const base = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.deepEqual(base.outside, []);
    symlinkSync(join(out, 'secret.txt'), join(d, 'alpha', 'notes'));
    symlinkSync(join(out, 'dir'), join(d, 'alpha', 'scripts', 'x'));
    const a = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.deepEqual(a.files, base.files);
    assert.equal(a.hash, base.hash);
    assert.deepEqual(a.outside, ['notes', 'scripts/x']);
  } finally { cleanup(); rmSync(out, { recursive: true, force: true }); }
});

test('SKILL.md symlinked outside the skill folder is rejected', () => {
  const { d, cleanup } = tmpCopy();
  const out = mkdtempSync(join(tmpdir(), 'skill-autoroute-out-'));
  try {
    writeFileSync(join(out, 'SKILL.md'), '---\nname: evil\n---\n');
    mkdirSync(join(d, 'evil'));
    symlinkSync(join(out, 'SKILL.md'), join(d, 'evil', 'SKILL.md'));
    assert.ok(!discover(roots(d)).some((s) => s.name === 'evil'));
  } finally { cleanup(); rmSync(out, { recursive: true, force: true }); }
});

test('a FIFO in a skill does not hang and is not listed', () => {
  const { d, cleanup } = tmpCopy();
  try {
    const r = spawnSync('mkfifo', [join(d, 'alpha', 'pipe')]);
    if (r.status !== 0) return; // no mkfifo on this platform
    const alpha = discover(roots(d)).find((s) => s.name === 'alpha');
    assert.equal(alpha.files.length, 2);
    assert.ok(!alpha.files.some((f) => f.endsWith('pipe')));
  } finally { cleanup(); }
});

test('same real skill via two roots or a link is returned once, first entry wins', () => {
  const { d, cleanup } = tmpCopy();
  const other = mkdtempSync(join(tmpdir(), 'skill-autoroute-disc-'));
  try {
    symlinkSync(join(d, 'beta'), join(other, 'beta-link'));
    const skills = discover([
      { dir: d, tool: 'claude', source: 'first' },
      { dir: other, tool: 'codex', source: 'second' },
      { dir: d, tool: 'claude', source: 'third' },
    ]);
    assert.equal(skills.filter((s) => s.name === 'beta').length, 1);
    assert.equal(skills.find((s) => s.name === 'beta').source, 'first');
    assert.deepEqual(skills.find((s) => s.name === 'beta').tools, ['claude', 'codex'], 'a shared folder lists both tools');
    assert.deepEqual(skills.find((s) => s.name !== 'beta').tools, ['claude']);
    assert.equal(skills.length, 3);
  } finally { cleanup(); rmSync(other, { recursive: true, force: true }); }
});

test('parseFrontmatter: wrapped plain scalar, BOM, empty block', () => {
  const w = parseFrontmatter('---\nname: w\ndescription: first part\n  second part\n  third\nallowed-tools: Read\n---\nB');
  assert.equal(w.description, 'first part second part third');
  assert.equal(w.allowedTools, 'Read');
  assert.equal(parseFrontmatter('\uFEFF---\nname: bom\n---\nB').name, 'bom');
  assert.deepEqual(parseFrontmatter('---\n---\nB'), { body: 'B' });
});
