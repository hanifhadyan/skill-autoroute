// Accuracy harness for the hook ranking. No model, no network. Usage:
//   node test/eval/run.js [--table routes.json] [--corpus corpus.json] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pick } from '../../hook/route.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE_FS = { mtime: () => 1, list: () => [], real: (p) => p };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Metrics over one group of cases. Rates are null when the group has no cases they apply to.
function score(rows) {
  const pos = rows.filter((r) => r.expect.length);
  const neg = rows.filter((r) => !r.expect.length);
  const rel = (r) => r.names.filter((n) => r.expect.includes(n)).length;
  return {
    cases: rows.length,
    p1: mean(pos.map((r) => (r.expect.includes(r.names[0]) ? 1 : 0))),
    p3: mean(pos.map((r) => (r.names.length ? rel(r) / r.names.length : 0))),
    recall3: mean(pos.map((r) => rel(r) / r.expect.length)),
    noMatchFp: neg.length ? neg.filter((r) => r.names.length).length / neg.length : null,
    meanChars: mean(rows.map((r) => r.chars)),
  };
}

export function evaluate(table, corpus, pickFn = pick) {
  const rows = corpus.map((c) => {
    const hit = pickFn(c.text, table, { tool: c.tool, fs: FAKE_FS });
    return { id: c.id, kind: c.kind, expect: c.expect, names: hit?.names ?? [], chars: hit?.out.length ?? 0 };
  });
  const kinds = [...new Set(rows.map((r) => r.kind))];
  return { all: score(rows), ...Object.fromEntries(kinds.map((k) => [k, score(rows.filter((r) => r.kind === k))])), rows };
}

const f = (v) => (v === null ? '  -  ' : v.toFixed(3));

function main() {
  const a = process.argv.slice(2);
  const opt = (name, dflt) => (a.includes(name) ? a[a.indexOf(name) + 1] : dflt);
  const table = JSON.parse(readFileSync(opt('--table', HERE + 'table.json'), 'utf8'));
  const corpus = JSON.parse(readFileSync(opt('--corpus', HERE + 'corpus.json'), 'utf8'));
  const res = evaluate(table, corpus);
  console.log('group    cases     P@1     P@3  recall@3  noMatchFP  meanChars');
  for (const [k, m] of Object.entries(res)) {
    if (k === 'rows') continue;
    console.log(`${k.padEnd(8)} ${String(m.cases).padStart(5)}  ${f(m.p1)}  ${f(m.p3)}  ${f(m.recall3)}    ${f(m.noMatchFp)}   ${m.meanChars.toFixed(1).padStart(8)}`);
  }
  const out = opt('--json');
  if (out) writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
