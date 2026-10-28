import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Codex reads CODEX_HOME when it is set, so every Codex file lives there.
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), '.codex');

export const CODEX_TIERS = { small: ['gpt-6-luna', 'gpt-5.6-luna'], mid: ['gpt-6.1-sol', 'gpt-6-sol'] };

// The user's own top-level `model = "..."` from config.toml (keys before the first [section]), or null.
function configuredModel() {
  try {
    const top = readFileSync(join(codexHome(), 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
  } catch { return null; }
}

// First tier slug that Codex lists. On fallback the model is the user's configured one, or null
// (omit -m).
export function resolveCodexModel(tier) {
  try {
    const cache = JSON.parse(readFileSync(join(codexHome(), 'models_cache.json'), 'utf8'));
    const listed = new Set(cache.models.filter((m) => m.visibility === 'list').map((m) => m.slug));
    const model = (CODEX_TIERS[tier] ?? []).find((s) => listed.has(s));
    if (model) return { model, fallback: false };
  } catch { /* no cache: fall through */ }
  return { model: configuredModel(), fallback: true };
}
