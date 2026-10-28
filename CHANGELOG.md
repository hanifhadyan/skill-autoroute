# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release on GitHub uses the notes from its section below.

## [0.5.0] - 2026-10-28

### Added

- The user install now routes skills that only some projects load: a project's own `.claude/skills` folder
  and plugins enabled only in its `.claude/settings.json` or `.claude/settings.local.json`. Projects come from
  the folders Claude Code has opened (`~/.claude.json`). These entries carry `projects`, and the hook hints
  them only inside that project or a git worktree of it. Nothing is written into the project.
  A project that has a plugin installed for it (`projectPath` in `installed_plugins.json`) counts too.

### Fixed

- Plugins whose `plugin.json` lists skill folders deeper than `skills/<name>` (for example
  `skills/engineering/tdd`) were not found. The manifest list is now followed.

## [0.4.1] - 2026-10-28

### Changed

- README: the hint quality table says the measured rules apply to 0.3.0 and later.

## [0.4.0] - 2026-10-28

### Added

- `words <skill> add|remove <word...>` adds your own trigger words to a skill, and `words` lists
  them. Words are plain text matched as whole words; a match puts that skill first among the hints.
  `regenerate` and `install` keep them. Up to 20 words per skill, 60 characters each. A word that
  also fires on ordinary replies gives a warning.
- README: a "Hint quality" section with the measured results, and a section on own trigger words.

## [0.3.0] - 2026-10-28

### Changed

- Trigger rules are built from a task word plus an object word (for example "add" with "column"),
  name everyday things people point at (README, table, page) and never fire on chat words such as
  agent, spec or fix alone. Up to 6 rules per skill.
- Sonnet (Codex: a mid model) writes the trigger rules by default. On 1,616 real prompts, precision
  rose from 35.5% to 59.1% and relative recall from 50% to 59.1%, with fewer hint tokens per prompt
  (12.9 to 10.8).
- More ordinary replies ("fix it", "run it", "ask the agent") are blocked from firing a rule.

### Added

- `routes.json` records the rules version. After an update that changes how rules are written,
  `regenerate` rebuilds every skill's rules without scanning again.

### Fixed

- A failed AI call during `regenerate` keeps a skill's working rules instead of replacing them with
  keyword rules.
- `regenerate --model triggers=...` records the model that rebuilt the rules.

## [0.2.1] - 2026-10-28

### Added

- This changelog. Every merge that publishes a new version to npm also creates a GitHub release with
  that version's notes.

### Changed

- The npm badge in the README links to the npm package page.

## [0.2.0] - 2026-10-28

### Added

- AI deep scan, duplicate comparison, trigger generation and the probe show a progress bar with the
  current skill and elapsed time. Each AI step first says in one line what it does.
- The skill picker groups skills by plugin or by the tool's own skills folder.
- Trigger generation gives each skill at least one rule from the everyday words a user types for the
  task, not only the skill's own jargon.
- The preview says why a prompt got no hint.
- CI runs the tests on every pull request and publishes to npm after a merge to `main`.

### Changed

- The usage report uses thousands separators, right-aligned numbers and one column per estimate.
- README flow diagrams are PNG images, because npm does not render Mermaid.

## [0.1.0] - 2026-10-28

### Added

- First release: a per-prompt hook for Claude Code and Codex that adds a hint line naming the skills
  that fit the prompt. No AI runs at prompt time, and a prompt with no match costs 0 tokens.
- CLI with `install`, `regenerate`, `scan`, `set`, `status` and `tokens`.
- Static security scan and optional AI deep scan of each skill before it gets a route.
- AI and keyword trigger generation, with validation of each generated pattern.
- Token estimates and a usage report.

[0.5.0]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hanifhadyan/skill-autoroute/releases/tag/v0.1.0
