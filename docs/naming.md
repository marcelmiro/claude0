# Session naming

How AI session names are generated, refreshed and resolved. Decision:
[ADR 28](adr/0028-ai-only-session-naming.md). Code: `core/names.ts`, `src/monitor.ts`, the
bridge's naming loop.

## Cache

`~/.config/claude0/names.json` v6: `names`, `sources` (the `lastPrompt || summary ||
firstPrompt` each name was generated from), optional `sizes` (transcript bytes at naming
time). Written atomically, pruned of dead-transcript entries past ~500 entries. Two forms:
the stored **title form** ("Fix Auth", `normalizeName`, ≤30 chars) and the derived **slug
form** (`fix-auth`, `slugify` + `ABBREV`, ≤24 chars, a trailing number kept through the
cut), used only on tmux windows, where `reverseNameMap` resolves panes back to session ids.

## Generation (`generateAIName`)

- `claude -p --model haiku` from a **neutral cwd** (the caller's cwd loads that repo's
  workspace context and biases names toward it).
- **Inputs**, in prompt order (`buildNamingPrompt`, `core/names.ts`): plan title, branch,
  session intent (the latest compaction summary's "Primary Request and Intent"), first user
  message, first substantive assistant reply, summary, up to three mid-session messages,
  last user message, last assistant reply, then — on monitor/bridge renames — the current
  name as an anchor and up to 8 sibling names from the same repo. Extras are read lazily at
  naming time (`readNamingExtras`), never on discovery sweeps.
- **Branch comes from the transcript** (the mode of the session's own `gitBranch` entries,
  `scanTranscriptForNaming`, ignoring main/master): `git branch` in a base checkout shared
  by several agents returns whoever checked out last. The TUI's `r` rename is the
  exception — it passes the checkout's branch, no siblings and no anchor (a user-forced
  rename must be free to change).
- **Noise filters**: mid-session samples skip relays, scaffolding, answer keys and short
  commands (`isNamingNoise`); the first prompt skips skill scaffolding
  (`getFirstUserPrompt`).
- **Prompt rules** (`buildNamingPrompt`): name the subject of the work, never the
  interaction mode; name the umbrella goal, never a sub-fix, side thread or opening
  question the session outgrew; delivery-phase activity (review, triage, merge, cleanup)
  is never the subject; prefer intent over branch where they disagree; keep the anchor
  verbatim unless the overall subject changed.
- **Best of three**: `NAME_SAMPLES` concurrent draws, consensus by `pickConsensusName`.
- **Output filters**: refusal-shaped output is salvaged (one opener stripped, clamped to 4
  words); hard refusals never are. The stdout error filter matches only the CLI's error
  phrases — single words like `credit` once discarded every draw for a session about
  credits.

## Refresh

- **Drift**: regenerate when the session's latest prompt or summary diverges from the
  stored source (`getLatestUserPrompt` reads it; its docblock covers the fork case).
- **Re-baseline**: a session whose transcript has doubled since naming
  (`shouldRebaseline`, from `sizes`) renames with the anchor withheld. An absent baseline
  keeps the anchor until the next rename records one.
- **Cooldowns** (`naming-skip/` markers, shared by monitor and bridge): renames back off 5
  minutes; never-named sessions retry after ~60s.
- **Timeouts**: haiku draws take 5–35s even for small prompts. The bridge's
  fire-and-forget loop gives 60s; the monitor keeps 15s because a hung draw stalls its
  poll. The naming lock's staleness window is 2× the budget.

## Forks

Portkey's `forkSession` and the TUI's fork key copy the parent's name onto the fork before
launching it (`inheritName`); the sidebar's `f` doesn't, so a sidebar fork starts unnamed.
Collisions resolve by naming order (`disambiguateNames`): a newcomer takes " 2", an
existing session is never renamed under you. The monitor, sidebar, TUI and bridge all run it.

## Resolution

Every consumer resolves via `getSessionName()`. Push labels use the title form
(`{repo} · {Title}`, `pushLabel`), falling back to un-slugging the window name only for
unresolved sessions; the macOS banner shows the name or, failing that, the raw window
slug. Portkey titles through one `listTitle` chain
(`name || label || summary || branch || id[:8]`). Unnamed sessions title on a first-prompt
snippet (bridge label + sidebar row); tmux stays repo-only until the name lands.

## Failure log

When every draw fails, one line goes to `~/.config/claude0/naming.log` (rotates to
`naming.log.1` past 256 KB): timestamp, pid, session id, then each draw's reason —
`timeout Nms`, `exit N <stderr, else stdout>`, `error output <stdout>`,
`refusal <stdout>`, `empty after normalize`, or `spawn <err>`. Successes and partial
failures write nothing, so it is not a failure rate. Start here when a session stays
unnamed. A usage limit surfaces as `exit 1 "You've hit your weekly limit · resets …"`; the
60s unnamed retry names the session after reset.

## Evaluating a naming change

Ad-hoc judging is noise: the same name on the same transcript drew different verdicts from
different judges. Measure a prompt or input change this way (the 2026-09-10 harness and
rubric weren't committed, so rebuild them):

1. Draw a seeded, size-stratified sample of real sessions and split it into a dev set (tune
   against it) and a holdout (judge it once, at the end).
2. Judge each name blind against its transcript with a written rubric that fixes the
   GOOD/OK/BAD boundaries and forbids downgrading for style, an omitted delivery phase, or
   a synonym.
3. Compare against the last baseline: holdout 14 GOOD / 5 OK / 1 BAD (20 sessions).

Known limits, measured — don't expect a prompt tweak to fix them:

- **Altitude on multi-session projects.** A session covering one increment of a long
  program drifts toward the program's name, and vice versa. Two prompt rewrites aimed at it
  were net-neutral.
- **Multi-topic transcripts have no stable name.** Identical inputs on a 24 MB session
  returned three different answers; the anchor is what stops the churn once a reasonable
  name lands.
