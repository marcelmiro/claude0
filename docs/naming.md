# Session naming

How AI session names are generated, refreshed and resolved. Decision:
[ADR 28](adr/0028-ai-only-session-naming.md). Code: `core/names.ts`, `src/monitor.ts`, the
bridge's naming loop.

## Cache

`~/.config/claude0/names.json` v6: `names`, `sources` (the `lastPrompt || summary` each
name was generated from), optional `sizes` (transcript bytes at naming time). Written
atomically, pruned of dead-transcript entries past ~500 entries. Two forms: the stored
**title form** ("Fix Auth", `normalizeName`, ≤30 chars) and the derived **slug form**
(`fix-auth`, `slugify` + `ABBREV`, ≤24 chars, a trailing number kept through the cut), used
only on tmux windows, where `reverseNameMap` resolves panes back to session ids through it.

## Generation (`generateAIName`)

- `claude -p --model haiku` from a **neutral cwd** (the caller's cwd loads that repo's
  workspace context and biases names toward it).
- **Context**, branch first: the branch (the mode of the session's own `gitBranch`
  transcript entries, `scanTranscriptForNaming`, ignoring main/master — `git branch` in a
  shared base checkout returns whoever checked out last), session intent (the latest
  compaction summary's "Primary Request and Intent", 500-char cut), plan title, first user
  message (skipping skill scaffolding), first substantive assistant reply (≥100 chars within
  the first 15), summary, up to three mid-session user messages, last user message, last
  assistant reply, up to 8 sibling names already taken by same-repo sessions, and on drift
  renames the current name as an anchor. Extras are read lazily at naming time
  (`readNamingExtras`), never on discovery sweeps.
- **Noise never reaches the prompt** (`isNamingNoise`): compaction boilerplate,
  JSON/notification and teammate-message relays, skill scaffolding, answer keys, sub-20-char
  commands.
- **Prompt rules**: name the subject of the work, never the interaction mode; name the
  umbrella goal, never a sub-fix, side thread or opening question the session outgrew;
  delivery-phase activity (review, triage, merge, cleanup) is never the subject; trust
  branch + intent over recent messages, and intent over branch where they disagree; keep
  the anchor verbatim unless the overall subject changed.
- **Best of three.** `NAME_SAMPLES` draws run concurrently; `pickConsensusName` returns the
  medoid by word overlap, so the shared subject survives and each draw's idiosyncratic word
  does not.
- **Output filters.** Refusal-shaped output is salvaged (strip one conversational opener,
  clamp to 4 words); hard refusals ("I can't…") never are. The stdout error filter matches
  only the CLI's error phrases (`API Error…`, `credit balance`) — single words like
  `credit` discarded every draw for a session about credits. `"claude code"` and names
  ending in "this" are legitimate.

## Refresh

- **Drift**: regenerate when `lastPrompt || summary` diverges from the stored source.
  `getLatestUserPrompt` prefers the newest real prompt record (typed text, slash-command
  intent, `! cmd`) in the transcript's last 64KB, falling back to Claude's `last-prompt`
  record (which a `--fork-session` fork keeps pointing at the parent's prompt).
- **Re-baseline**: a session whose transcript has doubled since naming
  (`shouldRebaseline`, from `sizes`) renames with the anchor withheld. An absent baseline
  keeps the anchor until the next rename records one.
- **Cooldowns** (`naming-skip/` markers, shared by monitor and bridge): renames back off 5
  minutes; never-named sessions retry after ~60s.
- **Timeouts**: haiku draws take 5–35s even for small prompts. The bridge's
  fire-and-forget loop gives 60s; the monitor keeps 15s because a hung draw stalls its
  poll. The naming lock's staleness window is 2× the budget.
- The TUI's `r` regenerate omits the anchor — a user-forced rename must be free to change.

## Forks

Both fork paths (portkey's `forkSession`, the TUI's fork key) copy the parent's name onto
the fork id before launching its window (`inheritName`), with a size baseline of 1 so the
first rename re-baselines. `disambiguateNames` orders a colliding group by naming order
(`nameOrder`: key order in `names.json`): a newcomer takes " 2", an existing session is
never renamed under you. The sidebar runs the same disambiguation.

## Resolution

Every consumer resolves via `getSessionName()`. Push and macOS notification labels use the
title form (`{repo} · {Title}`), falling back to un-slugging the window name only for
unresolved sessions. Portkey titles through one `listTitle` chain
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

## Evaluation

Naming changes are measured with a fixed harness, not ad-hoc judging (the same name on the
same transcript drew different verdicts from different judges): a seeded, size-stratified
sample of real sessions split into a dev set (tuned against) and a holdout judged once at
the end, with a written rubric fixing the GOOD/OK/BAD boundaries and forbidding downgrades
for style, an omitted delivery phase, or a synonym.

Scores across the 2026-09-10 rounds:

- Transcript audit before the round: 8/16 names tail-biased, generic or wrong — half
  input-side (inputs never contained the subject: skill scaffolding, bare ticket ids,
  relayed notifications, no branch), half model-side (haiku latched onto a vivid recent
  phrase).
- After the input changes: 17 sessions judged blind, 8 GOOD / 4 OK / 5 BAD. Rerunning the
  five failures without the anchor fixed four; a control session drifted across three
  unanchored runs where the anchor held the correct name — hence re-baselining rather than
  dropping the anchor.
- With the harness: dev 17/6/1 → 20 GOOD / 4 OK / 0 BAD; the holdout scored 14 GOOD / 5 OK
  / 1 BAD. Ordered by effect: branch from the transcript, best-of-three (refusals went to
  zero across two full runs, from 4–8% per single draw), sibling names, two refusal-filter
  false positives.

Residual, measured: **altitude on multi-session projects** — a session covering one
increment of a long program tends toward the program's name, and vice versa. Two prompt
rewrites aimed at it were net-neutral and were reverted. On very large multi-topic
transcripts (24 MB) identical inputs returned three different answers; the anchor keeps
such a name from churning once a reasonable one lands.
