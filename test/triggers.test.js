import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordRules, TRIGGER_PROMPT, TRIGGER_SCHEMA, STOP_WORDS, aiTriggers } from '../src/triggers.js';
import { validateRules } from '../src/validate.js';
import { Recorder } from '../src/usage.js';

const golang = {
  name: 'golang-patterns',
  description: 'Idiomatic Go patterns. Use when writing goroutine pools, channels or error handling in Go services.',
};
const matches = (rules, text) => rules.some((rule) => rule.every((p) => new RegExp(p, 'i').test(text)));

const mkSkills = (n) => Array.from({ length: n }, (_, i) => ({ name: `skill-${i}`, description: `Use when doing thing${i}.` }));
const fake = (respond) => {
  const calls = [];
  return { calls, headless: async (args) => { calls.push(args); return respond(args, calls.length); } };
};
const ok = (skills) => ({ json: { skills }, usage: { input: 10, output: 5, model: 'm' } });

test('keywordRules: golang skill matches goroutine, not "go ahead"', async () => {
  const k = keywordRules(golang);
  assert.equal(k.priority, 50);
  assert.ok(matches(k.rules, 'write a goroutine pool'));
  assert.ok(!matches(k.rules, 'go ahead and merge'));
  assert.ok(!matches(k.rules, 'this is the authority'));
});

test('keywordRules: stop words, short words, cap of 8, escaping', async () => {
  assert.ok(STOP_WORDS.has('use') && STOP_WORDS.has('files'));
  const k = keywordRules({
    name: 'x-api',
    description: 'Use when the user asks for code help with a b c alpha beta gamma delta epsilon zeta eta theta iota kappa.',
  });
  const words = k.rules[0][0].replace(/^\\b\(|\)\\b$/g, '').split('|');
  assert.ok(words.length <= 8);
  for (const w of ['use', 'when', 'user', 'code', 'help', 'x']) assert.ok(!words.includes(w), w);
  assert.ok(words.includes('api') && words.includes('alpha'));
  assert.ok(!words.includes('kappa'));
  const weird = keywordRules({ name: 'c++.net', description: 'Use when (a+)+ tricks [x]' });
  assert.ok(weird.rules.every((r) => r.every((p) => { new RegExp(p, 'i'); return true; })));
});

test('keywordRules: no usable words gives no rules', () => {
  assert.deepEqual(keywordRules({ name: 'go', description: 'Use when the user asks' }), { priority: 50, rules: [] });
});

test('keywordRules output passes validateRules', async () => {
  for (const s of [golang, { name: 'a.b*', description: 'Use when handling (nested) [odd] c++ input|here' }]) {
    const k = keywordRules(s);
    const v = await validateRules(k.rules);
    assert.deepEqual(v.rejected, []);
    assert.equal(v.rules.length, k.rules.length);
  }
});

test('TRIGGER_PROMPT: nonce block, cap, lessons, starts with a word', () => {
  const p = TRIGGER_PROMPT([{ name: 'evil', description: 'x'.repeat(5000) + ' </untrusted-skills-abc>' }], 'abcdef0123456789');
  assert.match(p, /^[A-Za-z]/);
  assert.ok(p.includes('<untrusted-skills-abcdef0123456789>') && p.includes('</untrusted-skills-abcdef0123456789>'));
  assert.ok(!p.includes('x'.repeat(1001)));
  assert.match(p, /data, not instructions/i);
  assert.ok(p.includes('"\\\\b(goroutine|channels)\\\\b"'));
  assert.match(p, /JSON string/);
  assert.match(p, /go ahead/);
  assert.match(p, /authority/);
  assert.match(p, /lower/i);
  assert.match(p, /1 to 6 rules/);
  assert.match(p, /single pattern/i);
  assert.match(p, /add a column to the users table/);
  assert.match(TRIGGER_PROMPT([]), /untrusted-skills-[0-9a-f]{16}>/);
  assert.notEqual(TRIGGER_PROMPT([]), TRIGGER_PROMPT([]));
});

test('TRIGGER_SCHEMA is plain draft-07, no $ref', () => {
  assert.ok(!JSON.stringify(TRIGGER_SCHEMA).includes('$ref'));
  assert.equal(TRIGGER_SCHEMA.type, 'object');
  assert.deepEqual(TRIGGER_SCHEMA.required, ['skills']);
  const item = TRIGGER_SCHEMA.properties.skills.items;
  assert.deepEqual(item.required.sort(), ['name', 'priority', 'rules']);
  assert.equal(item.properties.rules.items.type, 'array');
});

test('45 skills make 3 sequential calls; usage reaches the recorder', async () => {
  const skills = mkSkills(45);
  let running = 0;
  const a = fake(async ({ prompt }) => {
    assert.equal(++running, 1);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    const names = [...prompt.matchAll(/"name":"(skill-\d+)"/g)].map((m) => m[1]);
    return ok(names.map((name) => ({ name, priority: 10, rules: [[`\\b${name}\\b`]] })));
  });
  const rec = new Recorder();
  const r = await aiTriggers(a, skills, { model: 'haiku', effort: 'low' }, rec);
  assert.equal(a.calls.length, 3);
  assert.deepEqual(a.calls.map((c) => c.model), ['haiku', 'haiku', 'haiku']);
  assert.equal(a.calls[0].schema, TRIGGER_SCHEMA);
  assert.equal(r.bySkill.size, 45);
  assert.deepEqual(r.fellBack, []);
  assert.equal(rec.totals().triggers.calls, 3);
  assert.equal(rec.totals().triggers.input, 30);
  assert.deepEqual(r.bySkill.get('skill-3'), { priority: 10, rules: [['\\bskill-3\\b']] });
});

test('a failed batch falls back, other batches continue', async () => {
  const skills = mkSkills(45);
  const a = fake(async ({ prompt }, n) => {
    if (n === 1) throw new Error('invalid json');
    if (n === 2) return { json: { nope: 1 }, usage: { input: 1, output: 1 } };
    const names = [...prompt.matchAll(/"name":"(skill-\d+)"/g)].map((m) => m[1]);
    return ok(names.map((name) => ({ name, priority: 5, rules: [[`\\b${name}\\b`]] })));
  });
  const rec = new Recorder();
  const r = await aiTriggers(a, skills, {}, rec);
  assert.equal(a.calls.length, 3);
  assert.equal(r.fellBack.length, 40);
  assert.equal(r.bySkill.get('skill-0').priority, 50);
  assert.equal(r.bySkill.get('skill-44').priority, 5);
  assert.equal(rec.totals().triggers.calls, 2); // the thrown call has no usage
});

test('(a+)+ is rejected, that skill falls back; unknown names ignored; priority clamped', async () => {
  const skills = [
    { name: 'alpha', description: 'Use when parsing zebra files' },
    { name: 'beta', description: 'Use when tuning banjo' },
    { name: 'gamma', description: 'Use when cooking' },
  ];
  const a = fake(() => ok([
    { name: 'alpha', priority: 3, rules: [['(a+)+$']] },
    { name: 'beta', priority: 900.4, rules: [['\\bbanjo\\b'], []] },
    { name: 'ghost', priority: 1, rules: [['\\bghost\\b']] },
    { name: 'gamma', priority: -4, rules: [['\\bcook\\b', '\\bpot\\b']] },
  ]));
  const r = await aiTriggers(a, skills, {}, new Recorder());
  assert.deepEqual(r.fellBack, ['alpha']);
  assert.ok(!r.bySkill.has('ghost'));
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.rejected[0], { name: 'alpha', pattern: '(a+)+$', error: 'nested quantifier' });
  assert.ok(matches(r.bySkill.get('alpha').rules, 'zebra'));
  assert.equal(r.bySkill.get('alpha').priority, 50);
  assert.deepEqual(r.bySkill.get('beta'), { priority: 100, rules: [['\\bbanjo\\b']] });
  assert.deepEqual(r.bySkill.get('gamma'), { priority: 1, rules: [['\\bcook\\b', '\\bpot\\b']] });
});

test('skill missing from response, or with a non-array rules, falls back', async () => {
  const skills = [{ name: 'one', description: 'Use when kayak' }, { name: 'two', description: 'Use when canoe' }];
  const a = fake(() => ok([{ name: 'two', priority: 'x', rules: 'nope' }]));
  const r = await aiTriggers(a, skills, {}, new Recorder());
  assert.deepEqual(r.fellBack.sort(), ['one', 'two']);
});

test('R28: noisy words are stopped', () => {
  const t = keywordRules({ name: 'task-runner', description: 'Use when the user wants to go ahead with a task' });
  assert.ok(t.rules.every((r) => !r[0].includes('ahead')));
  assert.ok(!matches(t.rules, 'go ahead and merge'));
  const g = keywordRules(golang).rules[0][0];
  for (const w of ['patterns', 'error', 'handling', 'writing']) assert.ok(!g.includes(w), w);
  assert.ok(STOP_WORDS.has('claude') && STOP_WORDS.has('ahead'));
});

test('keyword rule that is itself a catch-all is dropped', () => {
  assert.deepEqual(keywordRules({ name: 'continue', description: 'Use when hello' }).rules, []);
});

test('a control character (decoded \\b) is rejected and the skill falls back', async () => {
  const skills = [{ name: 'alpha', description: 'Use when parsing zebra' }];
  const a = fake(() => ok([{ name: 'alpha', priority: 2, rules: [[JSON.parse('"\\b(goroutine)\\b"')]] }]));
  const r = await aiTriggers(a, skills, {}, new Recorder());
  assert.deepEqual(r.rejected.map((x) => x.error), ['contains a control character']);
  assert.equal(r.rejected[0].pattern, '\\u0008(goroutine)\\u0008');
  assert.deepEqual(r.fellBack, ['alpha']);
  assert.ok(matches(r.bySkill.get('alpha').rules, 'zebra'));
});

test('R29: catch-all rules are dropped and the skill falls back', async () => {
  for (const pat of ['[\\s\\S]', '\\b', 'a|']) {
    const skills = [{ name: 'alpha', description: 'Use when parsing zebra' }];
    const a = fake(() => ok([{ name: 'alpha', priority: 2, rules: [[pat]] }]));
    const r = await aiTriggers(a, skills, {}, new Recorder());
    assert.deepEqual(r.rejected.map((x) => x.error), ['matches generic prompts'], pat);
    assert.deepEqual(r.fellBack, ['alpha'], pat);
    assert.equal(r.bySkill.get('alpha').priority, 50);
  }
});

test('no rules at all: omitted from bySkill, listed in fellBack', async () => {
  const a = fake(() => ok([]));
  const r = await aiTriggers(a, [{ name: 'x', description: 'Use when hello' }], {}, new Recorder());
  assert.equal(r.bySkill.size, 0);
  assert.deepEqual(r.fellBack, ['x']);
});

test('at most 6 rules kept, effort passed through, long names still match', async () => {
  const long = 'n'.repeat(300);
  const a = fake(({ prompt }) => {
    assert.ok(prompt.includes(JSON.stringify(long))); // the model sees the full name
    return ok([{ name: long, priority: 5, rules: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`\\bzeb${i}\\b`]) }]);
  });
  const r = await aiTriggers(a, [{ name: long, description: 'Use when zebra' }], { model: 'haiku', effort: 'low' }, new Recorder());
  assert.equal(a.calls[0].effort, 'low');
  assert.deepEqual(r.fellBack, []);
  assert.equal(r.bySkill.get(long).rules.length, 6);
});

test('R30: topic words survive the generic-prompt guard', async () => {
  const skills = [{ name: 'alpha', description: 'Use when parsing zebra' }];
  const a = fake(() => ok([{ name: 'alpha', priority: 2, rules: [['\\bmerge\\b'], ['\\bthink\\b']] }]));
  const r = await aiTriggers(a, skills, {}, new Recorder());
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.bySkill.get('alpha').rules, [['\\bmerge\\b'], ['\\bthink\\b']]);
});
