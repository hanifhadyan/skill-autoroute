import { writeTable } from './table.js';

const tokens = (chars) => Math.ceil(chars / 4);
const HINT_PREFIX = 'Skills that fit this work (read each SKILL.md before you start): '; // same text as hook/route.js

// overheadPerCall and cacheReadPerCall come from the probe's real usage (input and cache-read, kept apart like the report).
export function estimate({ chars = 0, calls = 0, overheadPerCall = 0, cacheReadPerCall = 0, outputPerItem = 0, items = 0 } = {}) {
  return { input: tokens(chars) + calls * overheadPerCall, cacheRead: calls * cacheReadPerCall, output: items * outputPerItem };
}

export class Recorder {
  #rows = [];
  add(step, usage = {}) {
    const { input = 0, cacheRead = 0, output = 0, model = null } = usage ?? {};
    this.#rows.push({ step, model, input, cacheRead, output });
  }
  rows() { return this.#rows.map((r) => ({ ...r })); }
  totals() {
    const t = {};
    for (const r of this.#rows) {
      const x = (t[r.step] ??= { calls: 0, input: 0, cacheRead: 0, output: 0, model: null });
      x.calls++; x.input += r.input; x.cacheRead += r.cacheRead; x.output += r.output;
      if (r.model && !x.model) x.model = r.model;
    }
    return t;
  }
}

const pad = (v, n) => String(v).padEnd(n);
// 515450 -> "515,450": long token counts are read at a glance.
export const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

// Input and cache-read are separate columns on purpose: Codex may or may not count cached tokens inside input.
// Each real number has its estimate in the column beside it; numbers are right-aligned so digits line up.
export function formatReport(totals = {}, estimates = {}) {
  const steps = Object.keys(totals);
  const est = (s, k) => (estimates[s]?.[k] == null ? 'n/a' : num(estimates[s][k]));
  const sum = (f) => num(steps.reduce((a, s) => a + f(totals[s]), 0));
  const estSum = (k) => (steps.every((s) => estimates[s]?.[k] != null) ? num(steps.reduce((a, s) => a + estimates[s][k], 0)) : 'n/a');
  const rows = steps.map((s) => {
    const t = totals[s];
    return [s, t.model ?? '-', num(t.calls), num(t.input), est(s, 'input'), num(t.cacheRead), est(s, 'cacheRead'), num(t.output), est(s, 'output')];
  });
  const total = ['total', '', sum((t) => t.calls), sum((t) => t.input), estSum('input'), sum((t) => t.cacheRead), estSum('cacheRead'), sum((t) => t.output), estSum('output')];
  const head = ['step', 'model', 'calls', 'input', 'est input', 'cache-read', 'est cache-read', 'output', 'est output'];
  const w = head.map((h, i) => Math.max(...[head, ...rows, total].map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (i < 2 ? pad(c, w[i]) : String(c).padStart(w[i]))).join('  ').trimEnd();
  const rule = w.map((n) => '─'.repeat(n)).join('  ');
  return [
    line(head), rule, ...rows.map(line), rule, line(total), '',
    'est = estimate (characters / 4 plus overhead per call). Real numbers come from the CLI usage output.',
    'Input and cache-read are separate columns and are not summed. The router adds tokens; it does not reduce them.',
  ].join('\n');
}

export function writeReport(path, recorder, estimates = {}) {
  writeTable(path, { generatedAt: new Date().toISOString(), rows: recorder.rows(), totals: recorder.totals(), estimates });
}

function parseLog(lines) {
  const list = typeof lines === 'string' ? lines.split('\n') : Array.isArray(lines) ? lines : [];
  const fires = [];
  for (const l of list) {
    const [time, count, chars, ...rest] = String(l).split('\t');
    const day = /^\d{4}-\d{2}-\d{2}T/.test(time ?? '') && !Number.isNaN(Date.parse(time)) ? time.slice(0, 10) : null;
    if (!day || rest.length || !/^\d+$/.test(count ?? '') || !/^\d+$/.test(chars ?? '')) continue;
    fires.push({ day, chars: Number(chars) });
  }
  return fires;
}

export function hookReport(table, logLines) {
  const out = ['Hint added to a matching prompt, one skill (estimate = characters / 4):'];
  const skills = (table?.skills ?? []).filter((s) => s?.enabled && s.name && s.path);
  const size = (s) => HINT_PREFIX + `${s.name} (${s.path})` + '.';
  const w = Math.max(0, ...skills.map((s) => s.name.length));
  for (const s of skills) {
    const c = size(s).length;
    out.push(`  ${pad(s.name, w)}  ${num(c)} chars  ~${num(tokens(c))} tokens (estimate)`);
  }
  if (!skills.length) out.push('  no enabled skills in the table');
  const fires = parseLog(logLines);
  if (!fires.length) {
    out.push('Usage log: no usage log entries.');
    return out.join('\n');
  }
  const days = new Set(fires.map((f) => f.day)).size;
  const total = fires.reduce((a, f) => a + f.chars, 0);
  const round1 = (n) => Math.round(n * 10) / 10;
  out.push(
    `Usage log: ${num(fires.length)} fires over ${num(days)} active days, ${round1(fires.length / days)} fires per active day`,
    `  average added: ${num(Math.round(total / fires.length))} chars per fire (~${num(tokens(total / fires.length))} tokens, estimate)`,
    `  average added: ${num(Math.round(total / days))} chars per active day (~${num(tokens(total / days))} tokens, estimate)`,
  );
  return out.join('\n');
}
