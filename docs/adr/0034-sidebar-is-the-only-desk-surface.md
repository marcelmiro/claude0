# 34. The sidebar is the only desk surface; the TUI is retired

Date: 2026-11-05
Status: accepted

## Context

ADR 13 moved triage from the popup TUI to the inbox sidebar. Afterwards the TUI (`claude0 tui`
on `prefix a`; `src/index.ts` + `src/ui/`, ~5.3k lines, and the only reason `blessed` is a
dependency) was used for just two things: searching sessions and starting a new one. Every
cross-surface change (labels, status, naming) still had to be carried through it.

## Decision

Search (`/`) and new session (`n`/`N`) become **modes of the sidebar**, and the TUI is deleted
once they pass review. A read-only **preview** of a session's transcript runs as its own process
in a `tmux display-popup` beside the sidebar — not in blessed and not inside the daemon.

- **Search is a mode, not the inbox.** It shows query-ranked rows with match snippets. That
  doesn't contradict ADR 13's "labels-only rows" and "no relevance scoring" rules, which govern
  the inbox list.
- **Heavy work stays out of the daemon.** Search runs in a worker process and the preview in
  the popup's own process. Loading the search corpus plateaus around 240MB of RSS, and the
  daemon idles at ~73MB.
- **What goes with the TUI:**
  - Branch and worktree creation when starting a session. Agents create their own worktrees.
  - Answering prompts from the desk. Answer in the pane or in portkey.
  - The TUI's preview pane, copy, manual rename, and kill-without-archive.

## Rejected

- **Keep the TUI's search and wizard screens, launched from the sidebar.** That keeps blessed, a
  second renderer and a second key grammar, so the TUI's upkeep would stay.
- **Line-mode CLI commands (`claude0 new`, `claude0 search`).** That's a third interaction style
  for actions the sidebar can host directly.
- **A lean popup picker for search** (centered, wide). Kept as the fallback if the 30-column mode
  reads as cramped. It would be a third renderer.

## Consequences

- ADR 3 (the TUI refuses to run without a TTY) is superseded once the TUI is deleted.
- `prefix a` is freed and rebound to `claude0 next`. `M-s` also shows a hidden sidebar, because
  the sidebar is now the only way in.
- The sidebar's input decoder and its modes carry text editing (query, filter) that the inbox
  never needed.
