# Verification — Impl #2 acceptance scenarios

Run these by hand on the Mac (the MVP substrate) after the named increment. The
scroll-up regression (V1) is the scenario that defines the project.

## V1 — Status survives scroll-up (HEADLINE) · after Inc4
```
GIVEN a live claude session running a long Bash tool inside tmux
WHEN  I scroll the pane up (so the spinner leaves the viewport and
      "Jump to bottom (ctrl+End) ↓" is shown)
THEN  `claude0 list` and the TUI still report the session as `running`
AND   it NEVER flips to `ready` until a real Stop/idle edge arrives
```
Automated mirror: `bun test src/core/event-status.test.ts` (scroll-up regression
block) green; `status.test.ts` still pins the scraper bug as the documented contrast.

## V2 — Status truth table through a real turn · after Inc4
```
GIVEN hooks installed (`claude0 setup`) and an event log for the session
WHEN  I submit a prompt, let a tool run, approve it, and let the turn finish
THEN  status transitions running → (waiting at the permission prompt) → running →
      ready, matching Contract A, with no flicker, regardless of scroll position
AND   the event-vs-scraper debug diff is clean for that session
```

## V3 — Remote approval via IPC + timeout fallthrough + no desk lag · after Inc6
```
GIVEN a session with no tmux client attached and a tool awaiting permission
WHEN  I call `decideApproval(id, "allow")` from outside the TUI
THEN  the blocking PreToolUse hook returns allow and the tool runs

GIVEN the same, but I make no decision
WHEN  600s elapse
THEN  the hook exits neutral and the normal desk TUI prompt appears (nothing stranded)

GIVEN a session WITH a tmux client attached
WHEN  a tool requests permission
THEN  the desk TUI prompt appears instantly with no added lag (hook exits `ask`)
```

## V4 — Answer an AskUserQuestion from structured options · after Inc5
```
GIVEN a session showing an AskUserQuestion (single- and, separately, multi-select)
WHEN  I pick option(s) from the TUI Space-menu (rendered from structured data, not
      regexed glyphs) and submit
THEN  the answer lands, confirmed on the event stream
      (PostToolUse.tool_response.answers maps question_text → chosen label[s])
```

## V5 — Free-text message, status-gated · after Inc5
```
GIVEN a session at the prompt (status `ready`/waiting-input)
WHEN  I send a free-text message via the TUI
THEN  it lands via send-keys + Enter

GIVEN a session with status `running` (mid tool-run, not at the prompt)
WHEN  I open the Space-menu
THEN  the send-message action is not selectable (hidden/disabled)
AND   no keystrokes are sent to the pane
```

## V6 — Pre-hook sessions fall back to scraper · after Inc4
```
GIVEN a session started BEFORE the event hooks were installed (no event log)
WHEN  Claude0 discovers it
THEN  it still appears with a status derived from `status.ts` scraping
AND   nothing errors; `statusSource` reports `scraper`
```

## V7 — Monitor / status-right is event-sourced · after Inc7
```
GIVEN a running session whose pane is scrolled up
WHEN  the monitor refreshes
THEN  tmux status-right (⚡/🔄 counts) and the window-name prefixes reflect the
      event-sourced status, NOT the scraped viewport
AND   a killed session's events/, pending/, and decisions/ files are reaped next
      refresh (no zombie approval lingers in listPendingApprovals())
```

## V8 — Test + boundary gates green · CI, every increment
```
GIVEN any increment merged
WHEN  `bun test` runs
THEN  event-status.test.ts (7) + transcript.test.ts (6) + status.test.ts + the
      Gate-A guard are all green
AND   the core/ import-boundary guard (Inc7) bans blessed/ui imports under core/
```

## Dogfood gate (doc 00) — human judgment, before any Impl #3
```
GIVEN Inc4+Inc5+Inc6+Inc7 landed
WHEN  I use Claude0 through real Mac coding sessions for several days
THEN  status never flips on scroll-up, transcript-driven preview/answers are
      correct, and desk approval via the IPC works in daily use
ONLY THEN is Implementation #3 (bridge + app) unblocked.
```
