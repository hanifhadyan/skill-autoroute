import { resolveCodexModel } from './tools/codex-models.js';

const light = { claude: ['haiku', 'low'], codex: ['small', 'low'] };
const deep = { claude: ['sonnet', 'medium'], codex: ['mid', 'medium'] };
export const STEP_DEFAULTS = { probe: light, triggers: light, dedupe: deep, scan: deep };

// overrides: {step: model} from `--model step=model`; an override is used as given.
export function pickModel(tool, step, overrides = {}) {
  const [model, effort] = STEP_DEFAULTS[step]?.[tool] ?? (() => { throw new Error(`unknown step or tool: ${step}/${tool}`); })();
  if (overrides[step]) return { model: overrides[step], effort, fallback: false };
  if (tool === 'codex') return { effort, ...resolveCodexModel(model) };
  return { model, effort, fallback: false };
}
