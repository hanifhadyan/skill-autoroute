# Real Claude and Codex CLI behaviour (spike, resolves spec section 13)

Recorded 2026-10-28 with Claude Code 2.1.312 and codex-cli 0.164.0, on the user's own logins, in throwaway dirs under the session scratchpad (never inside this repo). 8 real calls in total, all small model at low effort (one `gpt-6.1-sol` availability check). Probe prompt: `Reply with {"ok":true}`. Schema file for Codex (`schema.json`): `{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}`.

Fixtures (all redacted; no prompt text other than "hello"):
- `test/fixtures/claude-headless.json` (run C below)
- `test/fixtures/codex-headless.jsonl` (run A below)
- `test/fixtures/claude-hook-input.json` (captured)
- `test/fixtures/codex-hook-input.json` (NOT captured, documented shape only, see Codex hook section)

`CL` = `claude -p 'Reply with {"ok":true}' --model haiku --effort low --tools "" --output-format json --json-schema '<schema>' --no-session-persistence`
`CX` = `codex exec --skip-git-repo-check --json -s read-only -m gpt-6-luna -c model_reasoning_effort=low --output-schema schema.json 'Reply with {"ok":true}'` (I added `-s read-only` to every Codex call to match the global sandbox constraint; it worked.)

## Claude headless

| Question | Answer | Command |
|---|---|---|
| Does it succeed on the login? | Yes. `is_error:false`, exit 0, `apiKeySource:"none"` (OAuth login, no API key). | `CL` (run A) |
| Does `--setting-sources ""` keep login working? | Yes. Succeeds, same result. | `CL --setting-sources ""` (run B) |
| Does `--setting-sources ""` plus `--strict-mcp-config --disable-slash-commands` keep login working? | Yes. Succeeds, same result. | `CL --setting-sources "" --strict-mcp-config --disable-slash-commands` (run C) |
| Does `--bare` keep login working? | No: `is_error:true`, `result:"Not logged in · Please run /login"`, exit 1, zero tokens (no API call made). **Not used**: `--bare` skips OAuth/keychain, so it only works with an API key. | `CL --bare` |
| Path of the parsed result | `structured_output` (top level object, already parsed: `{"ok":true}`). `result` is the same JSON as a string. Success flags: `is_error === false`, `subtype === "success"`, `terminal_reason === "completed"`. On failure `is_error:true` and `result` holds the message. | `CL` |
| JSON path of input tokens | `usage.input_tokens` (uncached part only, 2 to 6 here) | `CL` |
| JSON path of cache read | `usage.cache_read_input_tokens` | `CL` |
| JSON path of cache write | `usage.cache_creation_input_tokens` | `CL` |
| JSON path of output tokens | `usage.output_tokens` (includes thinking; `usage.output_tokens_details.thinking_tokens` is the part) | `CL` |
| Other useful fields | `total_cost_usd`, `num_turns`, `modelUsage["claude-haiku-5-5"]` (camelCase: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`), `session_id`, `uuid`. `--model haiku` resolved to `claude-haiku-5-5`. | `CL` |
| Is `usage` cumulative? | Top-level `usage` sums every API call of the run. `usage.iterations[]` holds only the last call. Run B: `num_turns:3`, top-level 6 + 54722 + 51788, last iteration 4 + 1491 + 51788, so two ~53.2k calls. Count total input as `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` from the top level. | run B |
| Input-token count, no context flag (run A) | 73,304 total (2 + 73,302 cache write + 0 read), 1 call | `CL` |
| Input-token count with `--setting-sources ""` (run B) | 106,516 total over 2 calls = about 53.3k per call (6 + 54,722 write + 51,788 read) | `CL --setting-sources ""` |
| Input-token count with `--setting-sources "" --strict-mcp-config --disable-slash-commands` (run C) | 4,527 total (2 + 3,454 write + 1,071 read), 1 call. About 16x smaller than A. | run C command |
| Which of the three flags cut the last 49k? | Not attributed: I did not spend extra calls on one flag each. `--setting-sources ""` alone gives about 53k per call, so the MCP and/or skills flags remove most of the rest. A later task can test `--strict-mcp-config` alone if it matters. | n/a |
| Do the user's global hooks fire in headless `-p`? | Yes by default: settings sources load them (the user has hooks on 16 events, 3 on UserPromptSubmit, 20 enabled plugins). Not run directly (a stream-json run would cost another call), but run A is 20k tokens larger than B. With `--setting-sources project` the init event listed no user plugins and only one SessionStart hook ran (see next row), so user hooks are suppressed. `--setting-sources ""` loads nothing from settings, so it suppresses them too (inferred from B/C token drop and the init plugin list, not observed directly). | `claude ... --setting-sources project --output-format stream-json --verbose` |
| Hook output with `--setting-sources`? | One `SessionStart:startup` hook still ran: it came from an inline plugin injected by the Orca harness through env `CLAUDE_CODE_PLUGIN_DIRS`, not from user settings. This env var is set only because the spike ran inside an Orca-managed Claude session; a plain terminal would not have it. | same |
| Slowness | Without a TTY on stdin, `claude -p` waits 3 s and warns `no stdin data received in 3s, proceeding without it`. Spawn with stdin ignored (`stdio: ['ignore', ...]`) or `< /dev/null`. Runs took about 9 s with the wait. | `CL` |

## Claude hook input (UserPromptSubmit)

Throwaway project with `.claude/settings.json` holding one `UserPromptSubmit` command hook that wrote its stdin and environment info to files, run with `claude -p hello --model haiku --effort low --tools "" --no-session-persistence --setting-sources project --strict-mcp-config --disable-slash-commands --output-format stream-json --verbose`. Both temp hook files were deleted afterwards.

| Question | Answer |
|---|---|
| Does a project hook fire in `-p` mode? | Yes. Login still worked with `--setting-sources project` (so project settings load while user settings do not). |
| Prompt field name | `prompt` |
| Other stdin fields | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode` (`"default"`), `hook_event_name` (`"UserPromptSubmit"`) |
| Hook command working directory | The project directory (equal to the `cwd` field). |
| Is `$CLAUDE_PROJECT_DIR` set in the hook env? | Yes, `CLAUDE_PROJECT_DIR`, equal to the project directory (value redacted). |
| Env name notes | Other `CLAUDE_*` names seen (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_EFFORT`, ...) were also inherited from the harness; only `CLAUDE_PROJECT_DIR` is needed. |
| Were UserPromptSubmit hook lifecycle events visible in stream-json? | No, only `SessionStart` events appear without `--include-hook-events`. The file written by the hook is the proof it fired. |

## Codex headless

| Question | Answer | Command |
|---|---|---|
| Does it succeed on the login (user config uses `model_provider = "caveman"` gateway)? | Yes, exit 0, final message `{"ok":true}`. Stderr shows `ERROR codex_models_manager::manager: failed to refresh available models: request timed out` (gateway model-list refresh) but the call still completes. | `CX` (run A) |
| Does `--ignore-user-config` keep login working? | Yes, exit 0, same result, no gateway error on stderr. It skips `~/.codex/config.toml` (so no `caveman` provider) but still uses `auth.json`. | `CX --ignore-user-config` (run B) |
| Does `gpt-6.1-sol` work? | Yes, accepted and returned `{"ok":true}` (default user config, low effort). The JSONL does not name the served model, so "works" means the request was accepted and answered. | `CX` with `-m gpt-6.1-sol` (run C) |
| JSONL events | `thread.started` (`thread_id`), `turn.started`, `item.completed`, `turn.completed`. One JSON object per line. | `CX` |
| Where is the final message? | `item.completed` event with `item.type === "agent_message"`, text at `item.text` (a JSON string: parse it again, giving `{"ok":true}`). Take the last such event. | `CX` |
| Which event carries usage? | `turn.completed`, at `usage` | `CX` |
| Usage field names | `usage.input_tokens`, `usage.cached_input_tokens`, `usage.cache_write_input_tokens`, `usage.output_tokens`, `usage.reasoning_output_tokens` | `CX` |
| Input tokens per call | Default config: 22,978. With `--ignore-user-config`: 21,517 (about 1.5k less). `gpt-6.1-sol`, default config: 24,382. `cached_input_tokens` was 0 in every run, so whether `input_tokens` includes cached tokens is unconfirmed. | runs A, B, C |
| Exit code and stderr | Exit 0 on success. First stderr line is always `Reading additional input from stdin...`; spawn with stdin ignored or `< /dev/null`. | `CX` |

## Codex hook input

| Question | Answer |
|---|---|
| Did the project hook fire under `codex exec`? | No. A throwaway project with `.codex/hooks.json` (`UserPromptSubmit` command hook) ran `codex exec --json -s read-only -m gpt-6-luna -c model_reasoning_effort=low 'hello'`. The hook file was never written. |
| Message seen | None. Stdout was the normal JSONL, stderr only `Reading additional input from stdin...`. No trust prompt or warning in headless mode. |
| Result | **needs trust; not captured.** Per docs (https://learn.chatgpt.com/docs/hooks, fetched 2026-10-28) project hooks load only when the project `.codex/` layer is trusted, and every non-managed hook must be reviewed and trusted in the `/hooks` UI (trust is stored by hook hash under `[hooks.state]` in `~/.codex/config.toml`). Both steps are interactive or need a global config write, so I did not work around them. `--dangerously-bypass-hook-trust` exists but I did not use it. |
| Do hooks fire under `codex exec` at all? | Unknown. Codex docs do not say. Not observed. Needs a real run by the user with the hook trusted via `/hooks`. |
| Prompt field name | `prompt` (from docs, not observed). |
| Documented stdin fields | `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name` (`"UserPromptSubmit"`), `model`, `permission_mode`, `turn_id`, `prompt`. |
| Hook working directory / project-dir env var | Not captured. |
| Fixture | `test/fixtures/codex-hook-input.json` is built from the documented fields with a `_note` key. It is not a real capture. Replace it once a trusted hook has run. |

## What this means for later tasks

- Claude probes: use `--setting-sources "" --strict-mcp-config --disable-slash-commands` (cuts a call from ~73k to ~4.5k input tokens, login intact). Never `--bare`. Read `structured_output`; guard on `is_error`.
- Codex probes: use `--ignore-user-config -s read-only` (login intact; avoids the gateway stderr error). Read the last `agent_message` `item.text`, then `turn.completed.usage`.
- Always spawn both CLIs with stdin ignored.
- Codex hook install cannot be verified headless; the installer must tell the user to trust the hook via `/hooks`.
