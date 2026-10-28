import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { fakeHome } from './helpers.js';
import { addHook, removeHook } from '../src/tools/hookconfig.js';

const CMD = 'node "/x/.config/skill-autoroute/route.mjs"';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const other = {
  model: 'opus',
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
  },
};

test('missing file is created with one entry, and add then remove leaves {}', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'sub', 'settings.json');
    assert.deepEqual(addHook(p, CMD), { changed: true });
    assert.deepEqual(read(p), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CMD }] }] } });
    assert.ok(readFileSync(p, 'utf8').includes('\n  "hooks"'), '2-space indent');
    assert.equal(existsSync(p + '.bak-skill-autoroute'), false, 'nothing to back up');
    assert.deepEqual(removeHook(p), { changed: true });
    assert.deepEqual(read(p), {});
  } finally { cleanup(); }
});

test('other keys and hooks survive add and remove; add-then-remove equals original', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    writeFileSync(p, JSON.stringify(other, null, 2));
    addHook(p, CMD);
    const added = read(p);
    assert.equal(added.model, 'opus');
    assert.deepEqual(added.hooks.Stop, other.hooks.Stop);
    assert.equal(added.hooks.UserPromptSubmit.length, 2);
    assert.deepEqual(removeHook(p), { changed: true });
    assert.deepEqual(read(p), other);
    assert.deepEqual(removeHook(p), { changed: false });
  } finally { cleanup(); }
});

test('only our entry is removed from a group shared with another hook', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    const shared = { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: CMD }] }] } };
    writeFileSync(p, JSON.stringify(shared));
    assert.deepEqual(addHook(p, CMD), { changed: false });
    assert.deepEqual(removeHook(p), { changed: true });
    assert.deepEqual(read(p), { hooks: { UserPromptSubmit: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo mine' }] }] } });
  } finally { cleanup(); }
});

test('addHook twice keeps one entry and the first backup', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    const original = JSON.stringify(other, null, 2);
    writeFileSync(p, original);
    assert.equal(addHook(p, CMD).changed, true);
    assert.equal(readFileSync(p + '.bak-skill-autoroute', 'utf8'), original);
    assert.deepEqual(addHook(p, CMD), { changed: false });
    assert.equal(read(p).hooks.UserPromptSubmit.filter((g) => JSON.stringify(g).includes('skill-autoroute')).length, 1);
    // a later change must not overwrite the first backup
    removeHook(p);
    addHook(p, CMD);
    assert.equal(readFileSync(p + '.bak-skill-autoroute', 'utf8'), original);
    assert.deepEqual(readdirSync(home).sort(), ['settings.json', 'settings.json.bak-skill-autoroute']);
  } finally { cleanup(); }
});

test('empty or whitespace file is treated as {}', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    writeFileSync(p, '  \n');
    assert.equal(addHook(p, CMD).changed, true);
    assert.equal(read(p).hooks.UserPromptSubmit.length, 1);
  } finally { cleanup(); }
});

test('invalid JSON throws a clear error and the file is untouched', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    const bad = '{ "model": "opus", // comment\n';
    writeFileSync(p, bad);
    assert.throws(() => addHook(p, CMD), /settings\.json.*not valid JSON/s);
    assert.throws(() => removeHook(p), /not valid JSON/);
    assert.equal(readFileSync(p, 'utf8'), bad);
    assert.equal(existsSync(p + '.bak-skill-autoroute'), false);
    assert.deepEqual(readdirSync(home), ['settings.json']);
  } finally { cleanup(); }
});

test('unexpected shapes throw instead of being overwritten', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    for (const text of ['[]', '{"hooks":[]}', '{"hooks":{"UserPromptSubmit":"x"}}']) {
      writeFileSync(p, text);
      assert.throws(() => addHook(p, CMD), /unexpected/);
      assert.equal(readFileSync(p, 'utf8'), text);
    }
  } finally { cleanup(); }
});

test('removeHook on a missing file does nothing', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'nope.json');
    assert.deepEqual(removeHook(p), { changed: false });
    assert.equal(existsSync(p), false);
  } finally { cleanup(); }
});

test('the marker is skill-autoroute/route.mjs: unrelated hooks are left alone', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    const mine = { hooks: [{ type: 'command', command: 'node /home/u/dev/skill-autoroute/scripts/my-own-hook.js' }] };
    writeFileSync(p, JSON.stringify({ hooks: { UserPromptSubmit: [mine] } }));
    assert.deepEqual(removeHook(p), { changed: false });
    assert.equal(addHook(p, CMD).changed, true, 'not mistaken for installed');
    assert.equal(read(p).hooks.UserPromptSubmit.length, 2);
    assert.deepEqual(removeHook(p), { changed: true });
    assert.deepEqual(read(p), { hooks: { UserPromptSubmit: [mine] } });
  } finally { cleanup(); }
});

test('addHook rejects a command without the marker', () => {
  const { home, cleanup } = fakeHome();
  try {
    const p = join(home, 'settings.json');
    assert.throws(() => addHook(p, 'node /x/other.js'), /skill-autoroute\/route\.mjs/);
    assert.equal(existsSync(p), false);
  } finally { cleanup(); }
});
