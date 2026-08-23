# 17. User-centric development layout and one Claude0 config

Date: 2026-08-16
Status: accepted

## Context

Repositories accumulated directly in `~/Documents`, while linked worktrees sat
beside them with names that looked like unrelated repositories. Claude0 settings were
split between a JSON file, terminal sidecar files, shell defaults, and a hardcoded
phone ordering. Absolute paths also appear in Git worktree metadata, Claude project
directories/transcripts, tmux state, launch agents, and symlinks, so a filesystem or
account rename cannot be treated as a plain `mv`.

## Decision

- Canonical repositories are flat at `~/dev/<repo>`. There are no organization or
  personal grouping directories; repository identity already supplies that context.
- Linked worktrees are implementation detail of their base repository and live at
  `<repo>/.claude/worktrees/<friendly-name>`. Claude0 adds
  `/.claude/worktrees/` to the repository-local `.git/info/exclude`, avoiding a
  tracked ignore-file change in every repository. Claude Code's native worktree
  lifecycle owns creation/removal.
- All durable user choices live in the schema-backed
  `~/.config/claude0/config.json`. `claude0 config` creates the default when needed and
  prints its absolute path; CLI invocations may override behavior for one run but do
  not mutate settings. New installs discover `~/dev` and use no priority pins.
- The human account is `marcel` with home `/Users/marcel` on both Mac and VM.
  Matching absolute homes preserves portability between the two hosts. The name is a
  user/system concern, not a Claude0 constant; provisioning remains `$USER`/`$HOME`
  driven.
- Existing machines migrate from a generated preflight manifest. The apply phase
  refuses collisions and dirty submodules, repairs Git worktree links before and
  after moves, reinitializes clean submodules, renames Claude project directories,
  rewrites known durable path state, and keeps hard-linked (or copied) backups.
  Account renames themselves remain a human cutover because macOS requires logging
  into another administrator account and Linux requires terminating the old user's
  processes.

## Consequences

- A repository path is short and predictable: `~/dev/customeros`; source code inside
  it may naturally remain `~/dev/customeros/src` without the redundant `~/src/.../src`
  reading.
- `git worktree list` remains the authority. Moving a base repository or a worktree
  manually requires `git worktree repair`; worktrees containing submodules cannot use
  `git worktree move`, which is why the migration deinitializes only verified-clean
  submodules before a filesystem rename and restores them afterward.
- Editor settings can validate the user file through its adjacent schema. Invalid or
  unknown settings fail with the config path instead of silently falling back.
- Old pre-v1 config is migrated once. Its implicit `~/Documents` discovery root is
  retained until the explicit filesystem migration rewrites it, so upgrading Claude0 by
  itself never makes existing repositories disappear.

## Rejected

- `~/src`: conventional, but produces visually redundant paths for repositories that
  contain their own `src/` directory.
- Grouping under organization/personal/local directories: more hierarchy without a
  corresponding navigation or ownership benefit for this single-user setup.
- A global `~/worktrees`: separates related working trees and complicates cleanup,
  discovery, and repository moves.
- Separate `config.json` and `config.local.json`, or mutating config subcommands: both
  create multiple sources of truth. The one file is user-owned and directly editable.
- A compatibility symlink from the old home or repository root: tools disagree about
  lexical versus real paths, which would recreate split Claude transcript identities.
