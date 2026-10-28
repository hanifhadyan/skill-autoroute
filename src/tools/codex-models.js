import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_TIERS = { small: ['gpt-6-luna', 'gpt-5.6-luna'], mid: ['gpt-6.1-sol', 'gpt-6-sol'] };

// First tier slug that Codex lists; {model: null, fallback: true} means "omit -m".
export function resolveCodexModel(tier) {
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const listed = new Set(cache.models.filter((m) => m.visibility === 'list').map((m) => m.slug));
    const model = (CODEX_TIERS[tier] ?? []).find((s) => listed.has(s));
    if (model) return { model, fallback: false };
  } catch { /* no cache: fall through */ }
  return { model: null, fallback: true };
}
