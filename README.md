# skill-autoroute

Tells Claude Code and Codex which of your installed skills fit the prompt you just typed.

Agents often have dozens of skills and use the wrong one, or none. `skill-autoroute` installs a small hook that runs on
every prompt. If the prompt matches a skill's triggers, the hook adds one line to the prompt, for example:

```
Skills that fit this work (read each SKILL.md before you start): vibe-security (/path/to/SKILL.md).
```

If the prompt matches nothing, the hook prints nothing and adds no tokens.

Before it does that, the installer:

- finds the skills installed for Claude Code and Codex,
- scans them for security problems and duplicates,
- lets you pick which skills the router may name (flagged skills start unchecked, with the reason),
- generates the triggers (regexes) with your own AI CLI, using your normal login and no API key, or from keywords if you
  have no AI CLI.

The router adds tokens. It does not save them. It pays off only when a hint makes the agent use the right skill. See
[Token usage](#token-usage).

## Requirements

- Node 20.12 or newer.
- Claude Code and/or Codex CLI.
- Linux or macOS. Windows is untested.
- For AI-generated triggers and scans: a logged-in `claude` or `codex` CLI. Without one, use `--ai none`.

## Install

There are two ways. Both run the same CLI.

### 1. Interactive

```
npx skill-autoroute install
```

You pick the tools, the AI helper, and the skills. Each AI step shows a token estimate and asks first. At the end you
can type test prompts and see which hints they would produce.

### 2. Ask your agent

Copy `skill/SKILL.md` from this package into your skills folder as `skill-autoroute-setup`, for example
`~/.claude/skills/skill-autoroute-setup/SKILL.md` for Claude Code or `~/.agents/skills/skill-autoroute-setup/SKILL.md` for
Codex. Then ask the agent to set up skill routing.

The skill makes the agent run `npx skill-autoroute install --dry-run ...`, show you the token estimate, and ask. Only
after you say yes does it run `npx skill-autoroute install --yes ...`. It shows you the printed table and token report.
It never opens or reads your skill folders itself, so a malicious skill cannot give instructions to an agent that has
tools.

`--yes` accepts every default: skills with a high security finding and non-preferred duplicates stay off. Change a row
afterwards with `set`.

### Scope

User level is the default. The hook copy is `~/.config/skill-autoroute/route.mjs` and the table is
`~/.config/skill-autoroute/routes.json`.

`--project` installs for the current repository: `.skill-autoroute/route.mjs` and `.skill-autoroute/routes.json`
(committable), and a hook entry in `.claude/settings.json`. The hook merges the user table and the project table;
project entries win for the same skill name.

Codex has no project-level hook here. The user-level Codex hook reads the project table of the folder you run Codex in.
Install at user level first so that hook exists.

The hook runs from a copy in the data folder, so it keeps working after the `npx` cache is cleared.

## Commands

```
skill-autoroute <command> [flags]
commands: install | regenerate | scan | set <skill> on|off | status | tokens | bench | uninstall
flags: --yes  --dry-run  --project  --tools claude,codex  --ai claude|codex|none  --model step=model (repeatable)  --log
```

| Command | What it does |
|---|---|
| `install` | Full flow: find tools and skills, scan, compare duplicates, pick, generate triggers, write the hook and table, self-test. |
| `regenerate` | Rescan and regenerate triggers for new or changed skills (by hash). Keeps your earlier choices. |
| `scan` | Find, scan and compare only. Changes no hook and no table. |
| `set <skill> on\|off` | Turn one row on or off in the table. |
| `status` | Tools found, hook state, skill counts, stale skills. |
| `tokens` | Estimated size of the hint for each enabled skill, plus the usage log summary. |
| `bench` | Measures the hook's real cost with CLI calls. See below. |
| `uninstall` | Removes the hook entries, the table, the install report and the hook copy. |

Flags:

- `--yes` takes every default and asks nothing. AI steps run.
- `--dry-run` prints the token estimates and writes nothing. It makes one small real AI call, the login probe.
- `--tools claude,codex` and `--ai claude|codex|none` skip those questions. `none` means keyword triggers and no AI calls.
- `--model step=model` overrides one step (see [Models](#models)).
- `--log` makes the hook count its fires (see [Token usage](#token-usage)).

Without `--yes` or `--dry-run`, `install` needs a terminal.

## What the scan checks, and what it does not

Every skill folder is scanned with fixed rules, no AI needed. A skill that fails a rule is flagged; the row shows the
reason.

| Severity | Rule |
|---|---|
| high | Remote code run (`curl ... \| sh`, `iex (irm ...)`), remote instructions, hidden text (zero-width characters, instructions in HTML comments, long base64), injection phrases ("ignore previous instructions"), secret theft (reads `~/.ssh`, `.env` and sends data out) |
| medium | Persistence (shell rc files, crontab, git hooks, agent settings), destructive commands (`rm -rf ~`, `sudo`, `chmod 777`), `allowed-tools: Bash(*)` |
| info | Binaries and large minified scripts |

A high finding unchecks the skill. A medium finding keeps it checked with a warning.

An optional AI deep scan sends the skill text to your AI CLI with no tools and a fixed answer format. It can only raise
a result, never clear a static high finding.

Read these limits:

- "no issues found" is not a safety guarantee. It means these rules found nothing. A skill can still be harmful. Read
  skills you do not trust before you install them.
- A scan can be partial. If a file cannot be read or the text is cut at about 60 KB for the AI scan, the label says
  "partial scan".
- The scan is text matching plus an AI read. It does not run anything. A determined author can word things to get past
  it.
- A skill that quotes attack phrases as examples (for instance a security skill that lists "ignore previous
  instructions") will still be flagged by the static scan. That is a false positive you can override in the checkbox
  list or with `set <skill> on`.
- Unchecking a skill removes it from the router table only. Claude Code and Codex still load that skill. It just gets
  no hints. The row says "still loaded by <tool>".
- Enabled skills get hints that tell the agent to read the skill file. Enable only skills you trust.

The AI steps send skill text to the provider behind the CLI you chose (the triggers step sends names and descriptions;
the deep scan sends the skill files, up to about 60 KB per skill; the duplicate step sends up to about 8 KB per skill).
Skill text is untrusted: it is wrapped in a delimiter with a random nonce and labelled as data in the prompt.

## Token usage

The router adds tokens. It does not reduce them. The package shows the cost and makes no claim of savings.

### Install cost

Each AI step shows an estimate first: characters sent divided by 4, plus the fixed overhead of one headless call times
the number of calls. The overhead comes from a real probe call at the start. After the step, the report shows the real
usage from the CLI next to the estimate: one row per step with model, calls, input, cache-read and output tokens. The
same data is saved in `install-report.json` next to `routes.json`. Input and cache-read are separate columns and are not
summed.

To keep calls small, each call runs in an empty temporary folder, with no tools, no session saved, and with the
context-cutting flags that still keep the login working. Measured overhead for one call that only answers
`{"ok":true}`, on 2026-10-28 with Claude Code 2.1.312 and codex-cli 0.164.0 (one setup; yours will differ):

| CLI | Input tokens per call |
|---|---|
| Claude Code, with `--setting-sources "" --strict-mcp-config --disable-slash-commands` | about 4.5k |
| Claude Code, no context flags | about 73k |
| Codex, with `--ignore-user-config` | about 21.5k |
| Codex, default config | about 23k |

A measured example, same date: installing with `--ai claude` for 7 skills used 11 calls and 58,350 input tokens (the
estimate was 58,200), 23,822 cache-read tokens and 3,372 output tokens. The output estimate was low, so treat output
estimates as rough.

### Hook cost

- A prompt that matches no rule gets no output: 0 tokens.
- A matching prompt gets one line naming at most 3 skills, about 50 to 70 tokens per skill (estimate: characters / 4).
  `skill-autoroute tokens` prints the size for each enabled skill.
- If any skill folder changed since the table was generated, the hint line is followed by one more line that says so and
  names `npx skill-autoroute regenerate`. That line appears only together with hints.
- `install --log` makes the hook append a line to `~/.config/skill-autoroute/usage.log` for each fire: time, number of
  hints, characters added. It counts only. It never writes prompt text. `tokens` then reports fires per day and the
  average added per fire and per day.

### bench

`skill-autoroute bench` runs five sample prompts through your AI CLI twice each, once with the hook and once without
(`SKILL_AUTOROUTE_DISABLE=1`), and prints the input-token difference from real usage. It loads your normal settings,
hooks and MCP servers, so each call carries your whole usual context, often tens of thousands of tokens, and your MCP
servers start for each call. Its numbers include that context. Only the difference comes from the hook, and small
differences can be cache noise. It asks before it runs.

## Models

Each AI step uses the smallest model that does the job. The top model is never the default.

| Step | Claude Code | Codex | Why |
|---|---|---|---|
| probe | `haiku`, effort low | small tier, effort low | Checks the login and measures overhead |
| triggers | `haiku`, effort low | small tier, effort low | Short structured output; validation catches bad patterns |
| dedupe | `sonnet`, effort medium | mid tier, effort medium | Needs judgment between two skills |
| scan | `sonnet`, effort medium | mid tier, effort medium | Reads adversarial content; needs judgment |

Claude uses the aliases `haiku` and `sonnet`, so no model version is pinned. Codex tiers are lists of model names kept in
`src/tools/codex-models.js`: small is `gpt-6-luna`, `gpt-5.6-luna`; mid is `gpt-6.1-sol`, `gpt-6-sol`. The adapter takes
the first name that your `~/.codex/models_cache.json` lists. If none is listed, it uses the model from your own Codex
config and says so. Codex calls always pass the step's effort level, so a high effort in your own config does not apply
to install calls.

Override one step with `--model step=model`, where step is `probe`, `triggers`, `dedupe` or `scan`. It can be repeated:

```
npx skill-autoroute install --model triggers=sonnet --model scan=haiku
```

The summary prints the model each step used.

Headless calls that read skill content run with no tools (`claude -p --tools ""`) or in the read-only sandbox
(`codex exec`).

## Triggers

A skill has a list of rules. A rule is a list of case-insensitive regexes that must all match the prompt. The skill fits
when any rule matches. The hook names up to 3 skills, in priority order.

With an AI helper, the AI writes the rules from each skill's name and description. Without one, the installer builds a
word-boundary regex from the name and the "Use when" part of the description; quality is lower and the summary says so.
Every pattern must compile and pass a timing test against long adversarial strings. Only patterns that pass are
written, so the hook never runs an untested regex.

## Codex: trust the hook once

Codex asks you to trust a new hook. After install, open Codex and run `/hooks`, then trust the skill-autoroute hook.
Until you do, Codex does not run it. The installer prints this reminder. Whether hooks fire under `codex exec` is not
confirmed.

## The hook

`hook/route.js` imports Node built-ins only. On any error it prints nothing and exits 0, so it cannot block a prompt.
Set `SKILL_AUTOROUTE_DEBUG=1` to see errors on stderr. Set `SKILL_AUTOROUTE_DISABLE=1` to switch it off for one run.

## Uninstall

```
npx skill-autoroute uninstall            # user scope
npx skill-autoroute uninstall --project  # project scope
```

This removes only the hook entries marked `skill-autoroute/route.mjs`, the table, the install report and the hook copy.
Other hooks in your settings stay as they were. The first install saved a backup of each config file as
`<file>.bak-skill-autoroute`; uninstall leaves those backups and `usage.log` in place. Install and uninstall are safe to
run twice.

## Supported tools

Version 1 supports Claude Code and Codex CLI. These are the only tools where both a prompt hook that can add context and
a headless mode that runs on the normal login without tools were confirmed. Research notes on Kiro, Cline, Antigravity
CLI, opencode, Amp, Cursor, Copilot CLI and Windsurf are in section 12 of
[the design document](docs/specs/2026-10-28-skill-autoroute-design.md). Each tool is one adapter file in `src/tools/`.

## Develop

```
npm test
```

Tests use `node:test`, fake `claude` and `codex` programs, and a fake `HOME`. They make no real AI calls.

## License

MIT
