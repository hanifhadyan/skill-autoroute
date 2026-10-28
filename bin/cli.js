#!/usr/bin/env node
// Thin entry: parse argv, pick the ui, run a command from src/flow.js.
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import * as flow from '../src/flow.js';
import { STEP_DEFAULTS } from '../src/models.js';

const USAGE = `usage: skill-autoroute <command> [flags]
commands: install | regenerate | scan | set <skill> on|off | status | tokens | bench | uninstall
flags: --yes  --dry-run  --project  --tools claude,codex  --ai claude|codex|none  --model step=model (repeatable)  --log`;

const COMMANDS = {
  install: flow.install, regenerate: flow.regenerate, scan: flow.scan, set: flow.setSkill,
  status: flow.status, tokens: flow.tokens, bench: flow.bench, uninstall: flow.uninstall,
};

function options() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, project: { type: 'boolean' }, log: { type: 'boolean' },
      tools: { type: 'string' }, ai: { type: 'string' }, model: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' },
    },
  });
  const tools = v.tools?.split(',').map((t) => t.trim()).filter(Boolean);
  for (const t of tools ?? []) if (!flow.ADAPTERS[t]) throw new Error(`unknown tool "${t}" (claude, codex)`);
  if (v.ai && !['claude', 'codex', 'none'].includes(v.ai)) throw new Error(`unknown --ai "${v.ai}" (claude, codex, none)`);
  const models = {};
  for (const m of v.model ?? []) {
    const [step, name] = m.split('=');
    if (!STEP_DEFAULTS[step] || !name) throw new Error(`--model wants step=model with step one of ${Object.keys(STEP_DEFAULTS).join(', ')}`);
    models[step] = name;
  }
  return { cmd: positionals[0], args: positionals.slice(1), help: v.help, o: { yes: v.yes, dryRun: v['dry-run'], project: v.project, log: v.log, tools, ai: v.ai, models } };
}

const unwrap = (v) => { if (p.isCancel(v)) throw new flow.Cancel(); return v; };
const clackUi = {
  yes: false,
  log: (m) => p.log.message(m),
  confirm: async (message, initialValue = true) => unwrap(await p.confirm({ message, initialValue })),
  select: async (message, options, initialValue) => unwrap(await p.select({ message, options, initialValue })),
  multiselect: async (message, options, initialValues) => {
    if (!options.some((o) => o.group)) return unwrap(await p.multiselect({ message, options, initialValues, required: false }));
    const groups = {};
    for (const { group, ...o } of options) (groups[group] ??= []).push(o);
    return unwrap(await p.groupMultiselect({ message, options: groups, initialValues, required: false }));
  },
  progress: (max) => {
    const bar = p.progress({ max, indicator: 'timer' });
    // A label wider than the terminal wraps, and the bar then cannot redraw its own line.
    const fit = (m = '') => { const w = Math.max(20, (process.stdout.columns || 80) - 60); return m.length > w ? `${m.slice(0, w - 1)}…` : m; };
    let started = false;
    return {
      next: (msg) => { if (started) bar.advance(1, fit(msg)); else { bar.start(fit(msg)); started = true; } },
      done: (msg) => { if (!started) bar.start(); bar.advance(1); bar.stop(fit(msg)); },
    };
  },
  text: async (message) => unwrap(await p.text({ message })) ?? '',
};

const noTty = () => { throw new Error('this step asks questions and needs a terminal; pass --yes or --dry-run'); };
const noTtyUi = { ...flow.plainUi(), yes: false, confirm: noTty, select: noTty, multiselect: noTty, text: noTty };

try {
  const { cmd, args, help, o } = options();
  if (help || !COMMANDS[cmd]) {
    console.log(USAGE);
    process.exitCode = help ? 0 : 1;
  } else {
    await COMMANDS[cmd](o, o.yes || o.dryRun ? flow.plainUi() : process.stdin.isTTY ? clackUi : noTtyUi, ...args);
  }
} catch (e) {
  if (e instanceof flow.Cancel) {
    console.log('Cancelled. Nothing was written.');
    process.exitCode = 1;
  } else {
    console.error(`skill-autoroute: ${flow.show(e.message)}`);
    process.exitCode = 1;
  }
}
