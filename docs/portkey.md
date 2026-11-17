# Portkey

Mechanism notes for the phone client (`src/bridge/public/`). Driving it in a real
browser: [portkey-design-loop.md](portkey-design-loop.md). Home is the inbox:
[inbox.md](inbox.md). The offline app shell: [ADR 21](adr/0021-offline-app-shell.md).

## Thread rendering

| Behavior | Where (`app.js`) |
|---|---|
| A run of 3+ tool-only records is one burst: expanded if it's work since the last prompt (`lastPromptAt`), else a one-line tally that expands on tap | `ToolBurst`, `isToolOnlyTurn` |
| One working indicator: the live tool chip while a tool runs, else the "working…" line with elapsed time | `ToolChip`, `Working` |
| Slash-command turns are a normal user bubble with the `/name` in mono; long-press is copy-only. Queued and sending bubbles of a command render the same way. A queued command's bare-text record (written at dequeue, before its runner record) parses as a command turn too (`core/transcript.ts`) | `Turn`, `commandBody` |
| An optimistic send bubble is faded and grows a "sending…" tag after ~5s; a server-confirmed queue entry is full-strength text in a dashed peach outline with a `◷ queued` tag — they never share a look | `SendingTag`, `.bubble.queued` |

## New session picker

A plain list of names in Portkey's page chrome (the `‹` back header with swipe-back,
History's search field, `.repo` section labels): **Recent** first, because the thumb is
already at the top after tapping +, then **All** repos A–Z (`NewSession`).

- **Recent** is up to 6 base repos ranked by transcripts touched in the last 14 days,
  counting each repo's project folder in `~/.claude/projects` plus its managed worktrees'
  (`recentRepos`, `core/recent-repos.ts`). It is stat-only and runs inside the `/repos`
  cache, which sets `recent` (rank) on those base rows. History's repo chips use the same
  rank (`repoRank`). There is no config pin: Recent replaced `repositories.priority`.
- **A repo's name launches its base checkout in one tap.** In All, a trailing count is a
  separate 64px target that opens the worktrees in place. They are newest HEAD commit first
  (`discoverRepos` → `commitTimes`), each launchable. A detached worktree is named by its
  folder. A leading segment every named branch in the group shares ("marcelmiro/") shows
  once above the group (`sharedPrefix`).
- **The only warning** is a base checkout off main/master ("on <branch>" in peach): a
  session started there lands on someone's branch.
- **Search:** every word must match. A query the repo name answers alone keeps worktrees
  folded; otherwise worktrees match on repo + branch + folder + short sha, under their repo.
  Results rank name-prefix, then Recent, then A–Z. Return launches a lone target, or the top
  repo when its name starts a one-word query (`enterTarget`).
- **Launch** keeps the picker open: the tapped row shows a spinner, and every other row is
  disabled so a second tap can't launch twice. A failure shows on the row and a tap retries
  it (`launchSession`, `pickerLaunch`). If the picker was left meanwhile, the session is not
  auto-opened: Home shows "launching…", then a ready/failed card with open, retry or dismiss
  (`launchNotice`), and the + button pulses while a launch is pending.
- The sidebar's `n` mode is a separate surface: it keeps `discoverRepos` order (repos with a
  live session, then A–Z) and has no Recent section.

## iOS status bar (installed PWA, iOS 27)

The fix is the `.status-bar-background` strip (`index.html`; its comment explains the
sampling rule) with `apple-mobile-web-app-status-bar-style=default`.
`--app-top-clearance` is just the safe-area inset. On the iPhone PWA (`.iphone-pwa`, set
before first paint) the first scroll region carries the clearance and fades its top 16px
once scrolled.

Verifying: changing the status-bar meta needs the app removed and re-added from Safari;
CSS changes need only a reachable reload. Browser layout checks can't reproduce the
effect — check on-device after a cold relaunch.

What was tried and doesn't work (2026-09-19 → 29; ten strategies compared on-device,
branch `prototype/ios-top-blur`): under `black-translucent` nothing removed the blur (about
90px) — opaque strips up to the safe-area height, scroll kicks at launch, a `theme-color`
nudge. An opaque 11px strip removes it but hides the top 11px of content; a fixed panel
slid across at launch works but the slide is visible; scrolling the document or inner list
at launch changes nothing. A fixed clearance allowance below the blur (24px, then 12px,
then 16px) was tuned on-device and then removed once the strip worked.
