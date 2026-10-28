import { writeTable } from './table.js';

const tokens = (chars) => Math.ceil(chars / 4);
const HINT_PREFIX = 'Skills that fit this work (read each SKILL.md before you start): '; // same text as hook/route.js

export function estimate({ chars = 0, calls = 0, overheadPerCall = 0, outputPerItem = 0, items = 0 } = {}) {
  return { input: tokens(chars) + calls * overheadPerCall, output: items * outputPerItem };
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

// Input and cache-read are separate columns on purpose: Codex may or may not count cached tokens inside input.
export function formatReport(totals = {}, estimates = {}) {
  const est = (n) => (n == null ? 'est n/a' : `est ${n}`);
  const rows = Object.entries(totals).map(([step, t]) => [
    step, t.model ?? '-', t.calls, `${t.input} (${est(estimates[step]?.input)})`, t.cacheRead, `${t.output} (${est(estimates[step]?.output)})`,
  ]);
  const sum = (f) => Object.values(totals).reduce((a, t) => a + f(t), 0);
  const estSum = (k) => (Object.keys(totals).every((s) => estimates[s]?.[k] != null) ? Object.keys(totals).reduce((a, s) => a + estimates[s][k], 0) : null);
  rows.push(['total', '', sum((t) => t.calls), `${sum((t) => t.input)} (${est(estSum('input'))})`, sum((t) => t.cacheRead), `${sum((t) => t.output)} (${est(estSum('output'))})`]);
  const head = ['step', 'model', 'calls', 'input', 'cache-read', 'output'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => pad(c, w[i])).join('  ').trimEnd();
  return [
    line(head), ...rows.map(line),
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
    out.push(`  ${pad(s.name, w)}  ${c} chars  ~${tokens(c)} tokens (estimate)`);
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
    `Usage log: ${fires.length} fires over ${days} days, ${round1(fires.length / days)} fires per day`,
    `  average added: ${Math.round(total / fires.length)} chars per fire (~${tokens(total / fires.length)} tokens, estimate)`,
    `  average added: ${Math.round(total / days)} chars per day (~${tokens(total / days)} tokens, estimate)`,
  );
  return out.join('\n');
}
