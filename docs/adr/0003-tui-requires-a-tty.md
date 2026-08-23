# 3. The TUI refuses to run without a TTY

Date: 2026-07-20 (documenting an earlier decision)
Status: accepted

## Context

The TUI and the monitor share mutable state in `~/.config/claude0/state.json` — attention flags
that drive the ⚡ window prefix and `claude0 next`.

A TUI process can outlive the terminal that started it. `bun --watch` respawns the app on
file change, and a closed terminal leaves those respawns running headless. Such a process
keeps its in-memory view of the world from whenever it started, and keeps writing it to
`state.json`, resurrecting attention flags the user has already cleared.

## Decision

Refuse to start without a TTY: check `process.stdout.isTTY` at entry and exit.

## Consequences

- An orphaned background TUI dies at startup instead of corrupting shared state.
- The TUI cannot be driven headlessly — automated checks use the CLI subcommands
  (`claude0 list`, `claude0 status`) instead, which are read-mostly by design.
