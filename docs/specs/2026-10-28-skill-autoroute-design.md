# skill-autoroute: design

Date: 2026-10-28
Status: draft, waiting for review

## 1. Purpose

`skill-autoroute` is a public npm package. It installs a per-prompt hook that tells a coding agent which of its installed
skills fit the current prompt. It is a standalone version of foreman's `router.py`, with three additions:

- It finds the skills that are installed, instead of using a hand-written list.
- It scans those skills for security problems and duplicates, and lets the user choose which skills the router may name.
- It generates the routing triggers with the user's own AI CLI (no API key), or from keywords when no AI CLI is present.

Success means:

- A user runs `npx skill-autoroute install`, picks tools and skills in one session, and gets working hints on the next
  prompt.
- Flagged skills start unchecked, with the reason shown.
- The hook never blocks or breaks a prompt, and it adds no tokens to prompts that match no rule.
- The user can see the token cost of both the install and the hook, measured from real usage data where possible.

## 2. Scope

v1 supports **Claude Code** and **Codex CLI**. These are the only two tools where both of these are confirmed:

- a `UserPromptSubmit` hook that can add context to the model, and
- a headless mode that runs on the normal login with no tools (`claude -p --tools ""`) or a read-only sandbox
  (`codex exec`, read-only by default).

Out of scope for v1:

- Other tools. Research notes for Kiro, Cline, Antigravity CLI, opencode, Amp, Cursor, Copilot CLI and Windsurf are in
  section 12. The tool adapter interface (section 4) must let each one be added as one file.
- A `disable` command that turns a skill off inside the tool.
- Windows. Paths are untested there.
- Skillspector integration.

## 3. Decisions

| Decision | Choice |
|---|---|
| Language | Node 20.12+, ESM. One runtime dependency: `@clack/prompts`. |
| Install paths | (1) interactive `npx` installer; (2) a setup skill that makes the agent run the same CLI with `--yes`. |
| Install scope | User-level by default; `--project` for repo-local hooks and a committed table. |
| Matching | Generated regex table (hybrid): AI-generated triggers, keyword-generated when no AI CLI is present. |
| Unchecking a skill | Removes it from the router table only. The tool still loads the skill. The row says so. |
| Duplicate choice | The AI compares each duplicate group and returns the preferred skill with a reason. The user can keep both. |
| Model choice | The smallest model that does the step well. Never the top model by default (section 9). |

## 4. Architecture

```
skill-autoroute/
  bin/cli.js          npx entry: install | regenerate | scan | set | status | tokens | bench | uninstall
  src/tools/          one adapter per tool: claude.js, codex.js
  src/discover.js     find SKILL.md folders, read frontmatter, hash content
  src/scan/static.js  rule-based checks, no AI
  src/scan/ai.js      deep scan through adapter.headless, no tools
  src/dedupe.js       candidate groups (same name or overlapping descriptions), then AI verdict
  src/triggers.js     AI or keyword trigger generation, then validation
  src/usage.js        token estimates before AI steps, real usage after, install report
  src/table.js        read and write routes.json
  hook/route.js       the per-prompt hook: Node built-ins only
  skill/SKILL.md      the prompt install path
```

Tool adapter interface:

```js
{
  name,                       // "claude" | "codex"
  detect(),                   // CLI on PATH and config folder present
  skillDirs(scope),           // folders to search for SKILL.md
  installHook(scope, cmd),    // add the marked hook entry, back up the config first
  removeHook(scope),          // remove only the marked entry
  headless({prompt, schema, model, effort}),  // -> {json, usage: {input, cacheRead, output, model}}
}
```

Boundaries:

- `hook/route.js` imports Node built-ins only and must start fast. On any error it prints nothing and exits 0.
- Only an adapter knows its tool's paths and flags.
- The prompt install path calls the same CLI. The agent never reads skill files itself, so a malicious skill cannot
  instruct an agent that has tools.

### routes.json

Location: `~/.config/skill-autoroute/routes.json`, or `.skill-autoroute/routes.json` with `--project`.

```json
{
  "version": 1,
  "generatedAt": "2026-10-28T10:00:00Z",
  "generator": {"ai": "claude", "model": "haiku"},
  "skills": [
    {
      "name": "vibe-security",
      "tool": "claude",
      "path": "/home/u/.claude/skills/vibe-security/SKILL.md",
      "hash": "sha256:...",
      "enabled": true,
      "priority": 10,
      "patterns": [["\\b(auth|oauth|jwt)\\b"]],
      "scan": {"verdict": "ok", "findings": []},
      "duplicateOf": null
    }
  ]
}
```

`patterns` is a list of rules. A rule is a list of regexes that must all match (case-insensitive). A skill fits when
any of its rules matches.

## 5. Install flow

`npx skill-autoroute install`:

1. **Find tools.** Look for `claude` and `codex` on PATH and their config folders. Multi-select, found tools checked.
2. **Scope.** User-level by default. `--project` targets the current repo.
3. **AI helper.** Choose `claude`, `codex` or `none` (keywords only). Run one probe call to confirm the login works.
   The probe also measures the fixed token overhead of one call (section 8). If the probe fails, say why and offer
   `none`.
4. **Find skills.** Read every SKILL.md in the chosen tools' user, project and plugin skill folders. Show counts per
   source.
5. **Static scan.** Always runs.
6. **AI deep scan.** Optional. Show the token estimate first (section 8) and ask to confirm.
7. **Duplicates.** Build candidate groups. Show the token estimate, ask to confirm, then get `{keep, reason}` per group.
8. **Checkbox list.** One row per skill with source, scan result or duplicate reason, and "still loaded by <tool>" for
   unchecked rows. Rows with a high finding and non-preferred duplicates start unchecked. The user can change any row.
9. **Triggers.** Show the token estimate, ask to confirm, then generate triggers for checked skills in batches of about
   20 skills per call. Validate each pattern (section 7). Report rejected patterns. Offer a preview loop: the user types
   a prompt and sees the hints it would produce.
10. **Write.** Back up each tool config before the first change (`<file>.bak-skill-autoroute`). Add the hook entry with
    a marker. Write `routes.json` and the install report.
11. **Self-test.** Feed a sample prompt to `hook/route.js` and check the output shape.
12. **Summary.** Skills routed, skills off, and the token report (section 8).

Other commands:

- `regenerate`: rescan and regenerate triggers only for new or changed skills (by hash). Keeps earlier choices.
- `scan`: steps 4 to 8 without touching hooks or triggers.
- `set <skill> on|off`: change one row.
- `status`: tools, hook state, skill counts, stale skills.
- `tokens`: the hook token report (section 8).
- `bench`: measured hook cost with real CLI calls (section 8).
- `uninstall`: remove the marked hook entries and the table. Nothing else is restored or deleted.

### Prompt install path

`skill/SKILL.md` tells the agent to run:

```
npx skill-autoroute install --yes --tools claude --ai claude
```

`--yes` accepts every default and never prompts: flagged skills and non-preferred duplicates stay off, and AI steps run
without a confirmation prompt. Before it runs, the skill tells the agent to run `npx skill-autoroute install --dry-run
--tools ... --ai ...`, which prints the token estimate, and to show that estimate to the user and ask before the real
run. After the run, the CLI prints the checkbox table and the token report as text. The agent shows them and applies
changes with `set`.

## 6. Security scan

### Static scan

Reads the whole skill folder: SKILL.md, scripts and references. Symlinks resolve to the real path; loops are skipped.

| Severity | Rule | Example match |
|---|---|---|
| high | Remote code run | `curl ... \| sh`, `wget ... \| bash`, `iex (irm ...)`, eval of fetched content |
| high | Remote instructions | Tells the agent to fetch a URL and follow its content |
| high | Hidden text | Zero-width or Unicode tag characters, instructions in HTML comments, long base64 blobs |
| high | Injection phrases | "ignore previous instructions", "do not tell the user", "without asking" |
| high | Secret theft | Reads `~/.ssh`, `~/.aws`, `.env` or keychains and sends data to a network address |
| medium | Persistence | Writes to shell rc files, crontab, systemd, git hooks, agent settings or hooks |
| medium | Destructive | `rm -rf ~` or `/`, `sudo`, `chmod 777` |
| medium | Wide permissions | `allowed-tools: Bash(*)` in frontmatter |
| info | Opaque content | Binaries, minified scripts over 50 KB |

Each finding has rule id, file, line and a short reason. The checkbox row shows the reason. A high finding unchecks
the skill; a medium finding keeps it checked with a warning. A clean result reads "no issues found", never "safe".

### AI deep scan

- Input: SKILL.md and scripts, capped at about 60 KB per skill. A cut input is reported as "partial scan".
- The content is wrapped in a delimiter with a random nonce and labelled as untrusted data.
- The call has no tools and a JSON schema: `{verdict: "ok"|"warn"|"block", findings: [{file, line, reason}]}`.
- The AI can only raise severity. It can never clear a static high finding.

## 7. Triggers

- **AI:** one call per batch of about 20 skills. Input: name and description of each skill. Output schema:
  `{skills: [{name, priority, rules: [[regex, ...], ...]}]}`. The prompt includes the lessons from `router.py`:
  word boundaries, no plain-English collisions ("go ahead" is not Go, "authority" is not auth), and two patterns
  instead of `.*` between words.
- **Keywords (no AI):** take distinctive words from the name and the "Use when" part of the description, drop a stop
  list, and build one word-boundary regex per skill. Lower quality; the summary says so.
- **Validation:** each regex must compile. Patterns with nested quantifiers are rejected. The rest run once in a worker
  thread with a 200 ms timeout against 100 KB adversarial strings. Only passing patterns reach `routes.json`, so the
  hook never runs an untested regex.

## 8. Token usage and proof

The router adds tokens; it does not save them. It is worth its cost only when a hint makes the agent use the right
skill. The package must show the cost plainly and must not claim savings.

### 8.1 Install cost (AI steps)

- **Before each AI step:** show an estimate. Input estimate = characters sent / 4 + fixed overhead per call × number
  of calls. The fixed overhead comes from the probe call's real usage (step 3), because each headless call carries the
  CLI's own system prompt. Output estimate = an upper bound from the schema size × number of items. Label it an
  estimate.
- **During:** each adapter returns real usage from the CLI's JSON output (`claude -p --output-format json` result
  usage; `codex exec --json` turn usage). Field names are verified during implementation against real output and
  recorded in a test fixture.
- **After:** write `install-report.json` next to `routes.json`, with one row per call: step, model, input tokens,
  cache-read tokens, output tokens. Print a summary per step and the total, next to the estimate.
- **Keep headless calls small:** run each call in an empty temporary folder so no project instruction files load, use
  `--setting-sources` (Claude) or `--ignore-user-config` (Codex) where that cuts loaded context, and disable session
  persistence. This also stops the user's own hooks, including this router, from firing inside install calls. Each flag
  is checked during implementation; any that turns out to break login is dropped and noted.
- `--dry-run` prints the estimates and makes no AI calls (except the probe, which is shown as one call).

### 8.2 Hook cost (per prompt)

- A prompt that matches no rule gets no output, so it costs 0 tokens.
- A matching prompt gets one line of at most 3 skills. `tokens` prints the hint each enabled skill would add, with
  its size in characters and an estimate in tokens (characters / 4, labelled estimate).
- Optional local log (`install --log`): the hook appends timestamp, number of hints and hint characters to
  `~/.config/skill-autoroute/usage.log`. It never writes prompt text. `tokens` then reports fires per day and the
  average added per prompt and per day.
- `bench`: real measurement. It runs a fixed set of sample prompts through the chosen CLI headlessly twice, once with
  the hook and once without, and reports the input-token difference per prompt from real usage data. It costs quota, so
  it shows its own estimate and asks first.

## 9. Model recommendation

Each AI step uses the smallest model that does it well. The top model is never the default. The user can override any
step with `--model <step>=<model>`.

| Step | Claude Code | Codex | Why |
|---|---|---|---|
| Probe | `haiku`, effort low | `gpt-6-luna`, effort `low` | Only checks login and measures overhead |
| Triggers | `haiku`, effort low | `gpt-6-luna`, effort `low` | Short structured output; validation catches bad patterns |
| Duplicates | `sonnet`, effort medium | `gpt-6.1-sol`, effort `medium` | Needs judgment between two skills |
| AI deep scan | `sonnet`, effort medium | `gpt-6.1-sol`, effort `medium` | Reads adversarial content; needs judgment |

- Claude uses the aliases `haiku` and `sonnet` with `--model`, so the package does not pin a model version.
  `--effort` sets the effort level.
- Codex: `-m <slug>` and `-c model_reasoning_effort=<level>`. The installer always passes the effort, because a user's
  own `config.toml` may set a high effort (for example `max`) that would otherwise apply to every install call.
- Codex model names change often. Each tier has a preference list in one file (`src/tools/codex-models.js`):
  small = `gpt-6-luna`, `gpt-5.6-luna`; mid = `gpt-6.1-sol`, `gpt-6-sol`. At run time the adapter reads
  `~/.codex/models_cache.json` and takes the first slug from the list that is present with `visibility: "list"`. If the
  cache is missing or no slug matches, it uses the user's configured `model` with the step's effort level, and the
  summary says so. The frontier model (`gpt-6-astra` today) is never chosen by default.
- The install summary prints the model each step used.

## 10. Hook runtime

`hook/route.js`:

1. Read the hook JSON from stdin; take `prompt`.
2. Load the user-level `routes.json` and the project one if present. Project entries override user entries of the same
   skill.
3. Match enabled rules. Return at most 3 skills, in priority order.
4. Print `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Skills that fit this work
   (read each SKILL.md before you start): X (path); ..."}}`.
5. Staleness: if any skill folder's modified time is newer than `generatedAt`, add one line naming the count and
   `npx skill-autoroute regenerate`.
6. On any error: print nothing, exit 0. `SKILL_AUTOROUTE_DEBUG=1` logs errors to stderr.

## 11. Testing

`node:test`, no test dependency.

- Fixtures: a fake `HOME` with skill folders; fake `claude` and `codex` executables on PATH that return canned JSON,
  including usage data. No real AI calls in CI.
- Static scan: one input that must be flagged and one that must not, per rule.
- Triggers: validation rejects catastrophic patterns; keyword generation output for a known skill.
- Ported `router.py` cases: "go ahead and fix it" picks no Go skill; "the subagent has no authority" picks no auth skill;
  a 240 KB prompt matches in under 0.5 s.
- Hook: exact output shape; no output for no match; exit 0 on a corrupt `routes.json`; cold start under 100 ms.
- Install then uninstall leaves `settings.json` and `hooks.json` equal to the original as parsed JSON.
- Usage: the install report sums per-call usage from fixtures correctly; the estimate uses the probe overhead.
- Model choice: each step calls the adapter with the model from section 9 unless overridden.
- Manual before release: install into a throwaway `HOME`, run real `claude -p` and `codex exec`, check the hint
  arrives, and compare `bench` numbers with the CLI's own usage display.

## 12. Research notes for later tools

From official docs, 2026-10-28. "Unconfirmed" means not found in the docs.

| Tool | Prompt hook that adds context | Skills | Headless without API key |
|---|---|---|---|
| Kiro | "Prompt Submit" in `.kiro/hooks/`, stdout added | `.kiro/skills` | No, needs `KIRO_API_KEY` |
| Cline | `UserPromptSubmit` in `.clinerules/hooks/`, `contextModification` (partly confirmed) | `.cline/skills` and others | Cline account; no tool deny list |
| Antigravity CLI (`agy`) | `PreInvocation`, `injectSteps`; per-prompt firing unconfirmed | `.agents/skills` | Yes; no read-only flag |
| opencode | JS plugin only; prompt event unconfirmed | `.opencode/skills`, `.agents/skills` | ChatGPT or Copilot login; not Claude Pro/Max |
| Amp | JS plugin, `agent.start` | `.agents/skills` | No, needs `AMP_API_KEY` |
| Cursor | Context only at `sessionStart` | `.cursor/skills` | Docs point to `CURSOR_API_KEY` |
| Copilot CLI | Command hook output dropped (SDK only) | `~/.copilot/skills` | `copilot login` |
| Windsurf | Block only | `.windsurf/skills` | No headless CLI found |

Roo Code shut down on 2026-05-15. Gemini CLI now needs paid API keys or enterprise licences.

Risk: the Claude Code docs say `--bare`, which needs `ANTHROPIC_API_KEY`, will become the default for `claude -p`. The
probe call (step 3) detects this and offers `none`.

## 13. Open items for implementation

- Exact usage field names in `claude -p --output-format json` and `codex exec --json` output.
- Whether `~/.codex/models_cache.json` keeps its current shape (`models[].slug`, `visibility`,
  `supported_reasoning_levels`) across Codex versions; it is a cache file, not a documented interface.
- Which context-cutting flags (`--setting-sources`, `--ignore-user-config`) keep the login working.
- Codex hook entry format for `~/.codex/hooks.json` and the one-time `/hooks` trust step; the installer must tell the
  user about it.
