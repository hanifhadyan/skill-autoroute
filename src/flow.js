// Command logic. bin/cli.js only parses argv and supplies `ui`; tests pass a non-interactive ui.
import { statSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, sep } from 'node:path';
import * as claude from './tools/claude.js';
import * as codex from './tools/codex.js';
import { discover } from './discover.js';
import { scanStatic, label } from './scan/static.js';
import { aiScan, mergeScan } from './scan/ai.js';
import { candidateGroups, aiDedupe, MAX_GROUP } from './dedupe.js';
import { aiTriggers, keywordRules, TRIGGER_PROMPT } from './triggers.js';
import { estimate, Recorder, formatReport, writeReport, hookReport } from './usage.js';
import { readTable, writeTable, mergeTables } from './table.js';
import { pickModel } from './models.js';
import { routesPath, reportPath, hookCopyPath, logPath } from './paths.js';
import { installHookCopy, hookCommand, checkConfig } from './tools/hookconfig.js';
import { route, staleCount, resolveProject } from '../hook/route.js';

export const ADAPTERS = { claude, codex };
export class Cancel extends Error {}

const BATCH = 20;
const OUT_PER_ITEM = { triggers: 500, scan: 150, dedupe: 150 }; // Ruling R33; triggers raised after review
const CAP = { scan: 60000, dedupe: 8000 }; // same caps as src/scan/ai.js and src/dedupe.js
const PROBE_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
// Skill text is untrusted: control characters (ESC, BEL, C1) would recolour or retitle the terminal.
export const show = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const showLines = (s) => String(s).split('\n').map(show).join('\n');
const scopeOf = (o) => (o.project ? 'project' : 'user');
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
// Project tables store paths relative to the project root so the folder can move or be cloned (the hook resolves them).
const keyOf = (scope) => (p) => (scope === 'project' ? relative(process.cwd(), p).split(sep).join('/') : p);
const forHook = (scope, t) => (scope === 'project' ? resolveProject(t, process.cwd()) : t);
const AI_NOTE = 'AI flagged this (details in the install output)';

// Non-interactive ui: every prompt takes its default; AI steps run (spec: --yes never prompts).
export const plainUi = (log = console.log) => ({
  yes: true, log, confirm: async () => true, select: async (_m, _o, d) => d, multiselect: async (_m, _o, d) => d, text: async () => '',
});

export function findTools() {
  return Object.values(ADAPTERS).map((a) => ({ name: a.name, ...a.detect() }));
}

export function findSkills(tools, scope) {
  const dirs = tools.flatMap((t) => ADAPTERS[t].skillDirs(scope));
  return { skills: discover(dirs), roots: dirs.map((d) => d.dir).filter((d) => existsSync(d)) };
}

// Characters sent: exact trigger prompts; scan and dedupe approximated from file sizes, capped as the modules cap them.
export function estimates(step, items, overheadPerCall = 0, cacheReadPerCall = 0) {
  const n = items.length;
  if (step === 'triggers') {
    let chars = 0;
    for (let i = 0; i < n; i += BATCH) chars += TRIGGER_PROMPT(items.slice(i, i + BATCH)).length;
    return estimate({ chars, calls: Math.ceil(n / BATCH), overheadPerCall, cacheReadPerCall, outputPerItem: OUT_PER_ITEM.triggers, items: n });
  }
  const chars = step === 'scan'
    ? sum(items, (s) => Math.min(CAP.scan, sum(s.files, size)))
    : sum(items, (g) => sum(g.slice(0, MAX_GROUP), (s) => Math.min(CAP.dedupe, size(s.skillPath))));
  return estimate({ chars, calls: n, overheadPerCall, cacheReadPerCall, outputPerItem: OUT_PER_ITEM[step], items: n });
}

function context(aiName, o) {
  return { aiName, ai: aiName && aiName !== 'none' ? ADAPTERS[aiName] : null, overrides: o.models ?? {}, rec: new Recorder(), est: {}, used: {}, overhead: 0, cacheOverhead: 0 };
}
const model = (ctx, step) => {
  const m = pickModel(ctx.aiName, step, ctx.overrides);
  ctx.used[step] = `${m.model ?? 'codex default'}/${m.effort}`;
  if (m.fallback) ctx.fellBack = m.model ?? null; // Ruling R42: summary() says the preferred model was not listed
  return { model: m.model, effort: m.effort };
};

// One tiny call: confirms the login works and measures the fixed overhead per call (spec 8.1).
export async function probe(ctx) {
  const { usage } = await ctx.ai.headless({ prompt: 'Reply with {"ok":true}', schema: PROBE_SCHEMA, ...model(ctx, 'probe') });
  ctx.rec.add('probe', usage);
  ctx.overhead = usage.input ?? 0;
  ctx.cacheOverhead = usage.cacheRead ?? 0;
  ctx.est.probe = { input: ctx.overhead, cacheRead: ctx.cacheOverhead, output: usage.output ?? 0 };
}

async function aiStep(ctx, ui, step, items, what) {
  if (!ctx.ai || !items.length) return false;
  const e = (ctx.est[step] = estimates(step, items, ctx.overhead, ctx.cacheOverhead));
  const m = pickModel(ctx.aiName, step, ctx.overrides);
  ui.log(`${what}: ${step === 'triggers' ? Math.ceil(items.length / BATCH) : items.length} calls with ${m.model ?? 'codex default'}/${m.effort}, est input ${e.input}, est cache-read ${e.cacheRead}, est output ${e.output} tokens (estimate)`);
  return ui.confirm(`Run ${what}?`, true);
}

export async function runScans(skills, ctx, ui) {
  const scans = new Map(skills.map((s) => [s.skillPath, scanStatic(s)]));
  if (await aiStep(ctx, ui, 'scan', skills, 'AI deep scan')) {
    const m = model(ctx, 'scan');
    for (const s of skills) {
      const calls = ctx.rec.rows().length;
      const r = await aiScan(ctx.ai, s, m, ctx.rec);
      // aiScan swallows errors; no recorded call means the call failed
      if (ctx.rec.rows().length === calls) ui.log(`AI scan failed for ${show(s.name)}; static result kept`);
      else scans.set(s.skillPath, mergeScan(scans.get(s.skillPath), r));
    }
  }
  return scans;
}

// Returns Map skillPath -> {preferred: true, reason} | {of: name, from, reason} | {tooLarge: true}. Without an AI verdict nothing is marked.
export async function runDedupe(skills, ctx, ui) {
  const out = new Map();
  const groups = candidateGroups(skills);
  if (!(await aiStep(ctx, ui, 'dedupe', groups, 'duplicate comparison'))) return out;
  const m = model(ctx, 'dedupe');
  for (const all of groups) {
    const g = all.slice(0, MAX_GROUP);
    for (const s of all.slice(MAX_GROUP)) out.set(s.skillPath, { tooLarge: true });
    const v = await aiDedupe(ctx.ai, g, m, ctx.rec);
    if (!v.keep) { ui.log(`duplicate comparison failed for ${g.map((s) => show(s.name)).join(', ')}; all kept as found`); continue; }
    const keep = g.find((s) => s.skillPath === v.keep);
    for (const s of g) {
      const reason = v.reasons[s.skillPath] ?? '';
      out.set(s.skillPath, s === keep ? { preferred: true, reason } : { of: keep.name, from: `${keep.tool}, ${keep.source}`, reason });
    }
  }
  return out;
}

export function buildRows(skills, scans, dupes = new Map()) {
  return skills.map((skill) => {
    const scan = scans.get(skill.skillPath);
    const dup = dupes.get(skill.skillPath);
    const parts = [`${show(skill.name)}  ${skill.tool}`, show(label(scan))];
    const of = dup?.of && `duplicate of ${show(dup.of)}${dup.of === skill.name && dup.from ? ` (${show(dup.from)})` : ''}`;
    if (dup) parts.push(dup.preferred ? `★ preferred: ${show(dup.reason)}` : dup.tooLarge ? 'duplicate group too large to compare' : `${of}: ${show(dup.reason)}`);
    return { skill, scan, dup, enabled: scan.verdict !== 'block' && !dup?.of, text: parts.join(' · ') };
  });
}
const rowText = (r, on) => (on ? r.text : `${r.text} · still loaded by ${r.skill.tool}`);
const printRows = (rows, ui) => { for (const r of rows) ui.log(`[${r.enabled ? 'x' : ' '}] ${rowText(r, r.enabled)}`); };

async function pickRows(rows, ui) {
  if (ui.yes) { printRows(rows, ui); return rows; }
  const idx = await ui.multiselect('Skills to route (unchecked skills stay installed, they only get no hints)',
    rows.map((r, i) => ({ value: i, label: rowText(r, r.enabled) })), rows.flatMap((r, i) => (r.enabled ? [i] : [])));
  return rows.map((r, i) => ({ ...r, enabled: idx.includes(i) }));
}

// Returns {bySkill: Map name -> {priority, rules}, rejected, fellBack, mode}.
export async function generate(skills, ctx, ui) {
  if (await aiStep(ctx, ui, 'triggers', skills, 'trigger generation')) {
    return { mode: 'ai', ...(await aiTriggers(ctx.ai, skills, model(ctx, 'triggers'), ctx.rec)) };
  }
  const bySkill = new Map();
  for (const s of skills) { const k = keywordRules(s); if (k.rules.length) bySkill.set(s.name, k); }
  return { mode: 'keywords', bySkill, rejected: [], fellBack: skills.filter((s) => !bySkill.has(s.name)).map((s) => s.name) };
}

// A project table is shared in git: AI-written text (reason, file name) stays out of it.
function tableFindings(scope, skill, findings) {
  if (scope !== 'project') return findings;
  const files = new Set(skill.files.map((f) => relative(skill.dir, f).split(sep).join('/')));
  return findings.map((f) => (f.rule === 'ai' ? { ...f, file: files.has(f.file) ? f.file : 'SKILL.md', reason: AI_NOTE } : f));
}
const entry = (r, gen, scope) => {
  const g = r.enabled ? gen.bySkill.get(r.skill.name) : null;
  return {
    name: r.skill.name, tool: r.skill.tool, tools: r.skill.tools ?? [r.skill.tool], path: keyOf(scope)(r.skill.skillPath), hash: r.skill.hash, enabled: r.enabled,
    priority: g?.priority ?? 50, patterns: g?.rules ?? [],
    scan: { verdict: r.scan.verdict, partial: r.scan.partial, findings: tableFindings(scope, r.skill, r.scan.findings) }, duplicateOf: r.dup?.of ?? null,
  };
};
const tableOf = (ctx, skills, roots, log) => ({
  version: 1, generatedAt: new Date().toISOString(),
  generator: { ai: ctx.ai ? ctx.aiName : 'none', model: ctx.ai ? pickModel(ctx.aiName, 'triggers', ctx.overrides).model ?? null : null, overheadPerCall: ctx.overhead, cacheReadPerCall: ctx.cacheOverhead },
  roots, ...(log ? { log: true } : {}), skills,
});

// Every tool config must parse before anything is written (throws naming the bad file).
export function preflight(scope, tools) {
  for (const t of tools) { const p = ADAPTERS[t].hookConfig(scope); if (p) checkConfig(p); }
}

export function write(scope, table, tools, ctx) {
  preflight(scope, tools);
  const done = [];
  try {
    writeTable(routesPath(scope), table); done.push(routesPath(scope));
    writeReport(reportPath(scope), ctx.rec, ctx.est); done.push(reportPath(scope));
    installHookCopy(scope); done.push(hookCopyPath(scope));
    return tools.map((t) => {
      const r = { tool: t, ...ADAPTERS[t].installHook(scope, hookCommand(scope, t)) };
      if (r.changed) done.push(`${t} hook config`);
      return r;
    });
  } catch (e) {
    throw new Error(`${e.message}. Written before the error: ${done.join(', ') || 'nothing'}`);
  }
}

// Runs the exact hook command written to the tool config and checks the output shape (empty, or one JSON line with additionalContext).
export function selfTest(scope, tool) {
  const r = spawnSync(hookCommand(scope, tool), {
    shell: true, input: JSON.stringify({ prompt: 'skill-autoroute self-test' }), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
  });
  if (r.status !== 0) return false;
  if (!r.stdout.trim()) return true;
  try { return typeof JSON.parse(r.stdout).hookSpecificOutput.additionalContext === 'string'; } catch { return false; }
}

// Steps 1 to 5 shared by install and scan: tools, AI helper with probe, skills, static scan.
async function prelude(o, ui) {
  const found = findTools();
  const avail = found.filter((t) => t.cli || t.configDir).map((t) => t.name);
  const tools = o.tools ?? (await ui.multiselect('Tools to route', found.map((t) => ({ value: t.name, label: t.name, hint: t.cli ? 'CLI found' : t.configDir ? 'config only' : 'not found' })), avail));
  if (!tools.length) throw new Error('no tool chosen; pass --tools claude,codex');
  const clis = found.filter((t) => t.cli).map((t) => t.name);
  const aiName = o.ai ?? (await ui.select('AI helper for scan, duplicates and triggers', [...clis.map((n) => ({ value: n, label: n })), { value: 'none', label: 'none (keywords only)' }], clis.find((n) => tools.includes(n)) ?? clis[0] ?? 'none'));
  const ctx = context(aiName, o);
  if (ctx.ai) {
    try {
      await probe(ctx);
      ui.log(`probe: ${aiName} login works; fixed overhead ${ctx.overhead} input tokens per call (1 call)`);
    } catch (e) {
      ui.log(`probe failed: ${show(e.message)}`);
      if (!(await ui.confirm('Continue with keywords only (no AI)?', true))) throw new Cancel();
      Object.assign(ctx, { ai: null, aiName: 'none' });
    }
  }
  const scope = scopeOf(o);
  const { skills, roots } = findSkills(tools, scope);
  const counts = {};
  for (const s of skills) { const k = `${s.tool} ${show(s.source)}`; counts[k] = (counts[k] ?? 0) + 1; }
  ui.log(`skills found: ${skills.length}${Object.keys(counts).length ? ` (${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`);
  return { scope, tools, ctx, skills, roots };
}

function dryRun(ctx, skills, ui) {
  const statics = skills.filter((s) => scanStatic(s).verdict !== 'block');
  ui.log('Dry run: estimates only, nothing written.');
  if (!ctx.ai) { ui.log('AI helper: none. No AI calls; triggers come from keywords (lower quality).'); return; }
  for (const [step, items] of [['scan', skills], ['dedupe', candidateGroups(skills)], ['triggers', statics]]) {
    const e = estimates(step, items, ctx.overhead, ctx.cacheOverhead);
    const m = pickModel(ctx.aiName, step, ctx.overrides);
    ui.log(`${step}: ${step === 'triggers' ? Math.ceil(items.length / BATCH) : items.length} calls, ${m.model ?? 'codex default'}/${m.effort}, est input ${e.input}, est cache-read ${e.cacheRead}, est output ${e.output} tokens`);
  }
  ui.log('est = estimate (characters / 4 plus the measured input and cache-read per call); the probe above was 1 real call.');
}

function summary(ctx, gen, notes, ui) {
  if (gen.rejected.length) ui.log(`rejected patterns:\n${gen.rejected.map((r) => `  ${show(r.name)}: ${show(r.pattern)} (${show(r.error)})`).join('\n')}`);
  if (gen.fellBack.length) ui.log(`keyword fallback (lower quality) or no rules: ${gen.fellBack.map(show).join(', ')}`);
  if (gen.mode === 'keywords') ui.log('Triggers come from keywords (no AI); quality is lower.');
  for (const n of notes ?? []) if (n.note) ui.log(`${n.tool}: ${show(n.note)}`);
  if (ctx.fellBack !== undefined) ui.log(`codex: ${ctx.fellBack ? 'model from your config' : 'codex default model'} (no preferred model listed)`);
  if (Object.keys(ctx.used).length) ui.log(`models: ${Object.entries(ctx.used).map(([s, m]) => `${s}=${m}`).join(' ')}`);
  if (ctx.rec.rows().length) ui.log(showLines(formatReport(ctx.rec.totals(), ctx.est)));
}

export async function install(o, ui) {
  const { scope, tools, ctx, skills, roots } = await prelude(o, ui);
  if (o.dryRun) return dryRun(ctx, skills, ui);
  preflight(scope, tools); // fail before spending AI calls
  const scans = await runScans(skills, ctx, ui);
  const rows = await pickRows(buildRows(skills, scans, await runDedupe(skills, ctx, ui)), ui);
  const gen = await generate(rows.filter((r) => r.enabled).map((r) => r.skill), ctx, ui);
  const table = tableOf(ctx, rows.map((r) => entry(r, gen, scope)), roots.map(keyOf(scope)), o.log);
  while (!ui.yes) {
    const p = await ui.text('Preview: type a prompt to see its hints (empty to finish)');
    if (!p) break;
    ui.log(show(route(p, forHook(scope, table)) ?? '(no hints for this prompt)'));
  }
  const notes = write(scope, table, tools, ctx);
  if (tools.filter((t) => ADAPTERS[t].hookConfig(scope)).every((t) => selfTest(scope, t))) ui.log('self-test: hook ran and its output has the right shape');
  else { ui.log('self-test FAILED: the hook copy did not run cleanly'); process.exitCode = 1; }
  ui.log(`routed: ${table.skills.filter((s) => s.enabled).length} skills, off: ${table.skills.filter((s) => !s.enabled).length}. Table: ${show(routesPath(scope))}`);
  summary(ctx, gen, notes, ui);
}

export async function scan(o, ui) {
  const { ctx, skills } = await prelude(o, ui);
  printRows(buildRows(skills, await runScans(skills, ctx, ui), await runDedupe(skills, ctx, ui)), ui);
  summary(ctx, { rejected: [], fellBack: [] }, [], ui);
}

export async function regenerate(o, ui) {
  const scope = scopeOf(o);
  const old = readTable(routesPath(scope));
  if (!old) throw new Error(`no table at ${routesPath(scope)}; run install first`);
  const known = [...new Set(old.skills.map((s) => s.tool))].filter((t) => ADAPTERS[t]);
  const tools = o.tools ?? (known.length ? known : findTools().filter((t) => t.cli || t.configDir).map((t) => t.name));
  const ctx = context(o.ai ?? old.generator?.ai ?? 'none', o);
  ctx.overhead = Number(old.generator?.overheadPerCall) || 0;
  const key = keyOf(scope);
  const prev = new Map(old.skills.map((s) => [s.path, s]));
  const was = (s) => prev.get(key(s.skillPath));
  const { skills, roots } = findSkills(tools, scope);
  ctx.cacheOverhead = Number(old.generator?.cacheReadPerCall) || 0;
  const fresh = skills.filter((s) => was(s)?.hash !== s.hash);
  // unchanged and enabled but without rules (turned on with `set` after generate): they only need rules
  const bare = skills.filter((s) => !fresh.includes(s) && was(s).enabled && !was(s).patterns?.length);
  ui.log(`skills: ${skills.length}, new or changed: ${fresh.length}, enabled without rules: ${bare.length}`);
  const rows = buildRows(fresh, await runScans(fresh, ctx, ui)).map((r) => {
    const w = was(r.skill);
    if (!w) return r;
    const off = Boolean(w.enabled) && r.scan.verdict === 'block'; // Ruling R35
    const n = show(r.skill.name);
    if (off) ui.log(`${n} turned off: ${show(label(r.scan))}; run \`npx skill-autoroute set ${n} on\` to override`);
    return { ...r, enabled: Boolean(w.enabled) && !off, dup: w.duplicateOf ? { of: w.duplicateOf } : undefined };
  });
  const gen = await generate([...rows.filter((r) => r.enabled).map((r) => r.skill), ...bare], ctx, ui);
  const byPath = new Map(rows.map((r) => [r.skill.skillPath, entry(r, gen, scope)]));
  for (const s of bare) {
    const g = gen.bySkill.get(s.name);
    byPath.set(s.skillPath, { ...was(s), priority: g?.priority ?? 50, patterns: g?.rules ?? [] });
  }
  const table = tableOf(ctx, skills.map((s) => byPath.get(s.skillPath) ?? was(s)), roots.map(key), old.log);
  if (!o.ai && old.generator) table.generator = old.generator; // unchanged rules still come from the old generator
  printRows(rows, ui);
  writeTable(routesPath(scope), table);
  writeReport(reportPath(scope), ctx.rec, ctx.est);
  installHookCopy(scope); // a newer package version brings a newer hook
  summary(ctx, gen, [], ui);
}

export function setSkill(o, ui, name, state) {
  if (!name || !['on', 'off'].includes(state)) throw new Error('usage: skill-autoroute set <skill> on|off');
  const p = routesPath(scopeOf(o));
  const t = readTable(p);
  const hits = t?.skills.filter((s) => s.name === name) ?? [];
  if (!hits.length) throw new Error(`no skill named "${show(name)}" in ${show(p)}`);
  for (const s of hits) s.enabled = state === 'on';
  writeTable(p, t);
  ui.log(`${show(name)}: ${state}`);
  if (state === 'on' && hits.some((s) => !s.patterns?.length)) ui.log(`${show(name)} has no trigger rules yet, so it gets no hints. Run: npx skill-autoroute regenerate`);
}

export function status(o, ui) {
  const scope = scopeOf(o);
  for (const t of findTools()) ui.log(`${t.name}: CLI ${t.cli ? 'found' : 'not found'}, config ${t.configDir ? 'found' : 'not found'}, ${ADAPTERS[t.name].hasHook(scope) ? 'hook installed' : 'no hook'}`);
  const t = readTable(routesPath(scope));
  if (!t) return ui.log(`no table at ${routesPath(scope)}`);
  ui.log(`skills: ${t.skills.filter((s) => s.enabled).length}/${t.skills.length} enabled`);
  ui.log(`stale: ${staleCount(forHook(scope, mergeTables(t, null)))}${t.generatedAt ? ` (generated ${show(t.generatedAt)})` : ''}`);
}

export function tokens(o, ui) {
  const user = readTable(routesPath('user'));
  const table = o.project ? mergeTables(user, forHook('project', readTable(routesPath('project')))) : user;
  let log = '';
  try { log = readFileSync(logPath(), 'utf8'); } catch { /* no log yet */ }
  ui.log(showLines(hookReport(table, log)));
}

const SAMPLES = [
  'Review this pull request for security problems in the oauth login code',
  'Write a unit test for the date parser',
  'Why does the CI build fail on the lint step',
  'Refactor this React component to use hooks',
  'Explain what this SQL query does and make it faster',
];

// Ruling R31: the CLI runs with the user's settings so the hook fires; DISABLE=1 gives the baseline.
export async function bench(o, ui) {
  const aiName = o.ai ?? findTools().find((t) => t.cli)?.name;
  if (!aiName || aiName === 'none') throw new Error('bench needs an AI CLI: pass --ai claude or --ai codex');
  const ctx = context(aiName, o);
  const m = model(ctx, 'probe');
  ui.log(`bench: ${SAMPLES.length * 2} ${aiName} calls (${m.model ?? 'codex default'}/${m.effort}) with your normal settings, hooks and MCP servers loaded (your MCP servers start for each call). Each call carries your full normal context, often tens of thousands of input tokens (rough estimate; 73k was measured on one setup). It measures the user-level hook; the calls run in a temp folder.`);
  if (!(await ui.confirm('Run bench?', true))) return;
  const call = async (prompt, disable) => {
    const { usage } = await ctx.ai.headless({ prompt: `${prompt}\n\nDo not do the task. Reply with {"ok":true}.`, schema: PROBE_SCHEMA, ...m, loadUserSettings: true, env: { SKILL_AUTOROUTE_DISABLE: disable ? '1' : undefined } });
    return (usage.input ?? 0) + (usage.cacheRead ?? 0);
  };
  ui.log('prompt  without hook  with hook  difference (input + cache-read tokens, real usage)');
  for (const [i, p] of SAMPLES.entries()) {
    try {
      const off = await call(p, true);
      const on = await call(p, false);
      ui.log(`${i + 1}. ${p.slice(0, 40)}  ${off}  ${on}  ${on - off >= 0 ? '+' : ''}${on - off}`);
    } catch (e) { ui.log(`${i + 1}. failed: ${show(e.message)}`); }
  }
  ui.log('Numbers include your normal context (settings, hooks, MCP, instructions); only the difference comes from the hook. Small differences can be cache noise.');
}

export function uninstall(o, ui) {
  const scope = scopeOf(o);
  for (const a of Object.values(ADAPTERS)) {
    const r = a.removeHook(scope);
    ui.log(`${a.name}: ${r.changed ? 'hook removed' : 'no hook entry'}${r.note ? ` (${r.note})` : ''}`);
  }
  for (const f of [routesPath(scope), reportPath(scope), hookCopyPath(scope)]) rmSync(f, { force: true });
  ui.log('Removed the routes table, the install report and the hook copy. Nothing else was changed.');
}
