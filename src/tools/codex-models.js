import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_TIERS = { small: ['gpt-6-luna', 'gpt-5.6-luna'], mid: ['gpt-6.1-sol', 'gpt-6-sol'] };

// The user's own `model = "..."` from config.toml, or null.
function configuredModel() {
  try {
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8'))?.[1] ?? null;
  } catch { return null; }
}

// First tier slug that Codex lists. On fallback the model is the user's configured one, or null
// (omit -m).
export function resolveCodexModel(tier) {
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
    const listed = new Set(cache.models.filter((m) => m.visibility === 'list').map((m) => m.slug));
    const model = (CODEX_TIERS[tier] ?? []).find((s) => listed.has(s));
    if (model) return { model, fallback: false };
  } catch { /* no cache: fall through */ }
  return { model: configuredModel(), fallback: true };
}
