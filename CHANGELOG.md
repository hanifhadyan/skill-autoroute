# Changelog

All notable changes to this project are listed here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Each release on GitHub uses the notes from its section below.

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

[0.2.1]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hanifhadyan/skill-autoroute/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hanifhadyan/skill-autoroute/releases/tag/v0.1.0
