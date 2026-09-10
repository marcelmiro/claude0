# 28. Session names are AI-only, resolved from one cache on every surface

Date: 2026-08-31

## Status

Accepted

## Context

Sessions carry a generated name in two forms: the stored **title form** ("Fix Auth", `normalizeName`, ≤30 chars) and the derived **slug form** (`fix-auth`, `slugify` + `ABBREV`, ≤24 chars) used only on tmux windows — where it is load-bearing: `reverseNameMap` resolves panes back to session ids through it.

Two classes of problems had accumulated:

1. **Names described the interaction, not the work.** The namer saw only user messages (first/last prompt + summary + branch), so a session opened with "grill me on this plan" was named "Grill Plan" — the subject of the plan appears only in the assistant's reply, which the namer never received. Refusal-shaped output was discarded outright, leaving sessions unnamed for the 5-minute cooldown.
2. **Surfaces disagreed.** Push labels were reverse-engineered from the window slug (title → abbreviate → 24-char cut → un-kebab → title-case: "Notifications Config" arrived as "Notif Cfg"); the user-pinned name was honored on only half the surfaces; the bridge never wrote `sources`, so the monitor re-named every bridge-named session; the bridge also never drift-refreshed, and the monitor only ticks while a tmux client is attached — phone-only days froze names; portkey had four diverging title-fallback chains.

## Decision

**AI naming is the only name source.** Pinning (user-typed override, TUI-only entry point) is removed with its cache field; the cache is `names.json` v6 (`names` + `sources`), written atomically, pruned of dead-transcript entries once it exceeds ~500 entries.

**Generation names the subject.** Context sent to `claude -p --model haiku`: plan title, first user message, **first assistant reply**, summary, **up to three mid-session user messages**, last user message, **last assistant reply**, branch (extras read lazily at naming time via `readNamingExtras` — never on discovery sweeps). Mid-session messages matter because long sessions often open and close with meta text ("read the ticket and begin", "run triage") while the actual subject appears only in the middle. The subprocess runs from a **neutral cwd** — inheriting the caller's cwd loaded that repo's workspace context and biased names toward the caller's own project. The prompt demands the subject of the work, never the interaction mode alone. Refusal-shaped output is salvaged (strip one conversational opener, clamp to 4 words) before rejection; hard refusals ("I can't…") are never salvaged.

**Monitor and bridge are symmetric namers.** Both apply the same drift rule (regenerate when `lastPrompt || summary` diverges from the stored source), share the on-disk `naming-skip/` cooldown markers (renames back off 5 minutes — the drift-thrash guard; never-named sessions retry after ~60s, since their failures are usually a fresh post-compact transcript that isn't ready yet), and write `sources` on success. The monitor stays the sole *window-writing* authority (ADR 14 addendum) and runs the same per-repo disambiguation on its immediate post-naming rename as on the tick sync.

**One resolver, per-surface rules.** Every consumer resolves via `getSessionName()`. Push and macOS notification labels resolve the title form from the cache (`{repo} · {Title}`), falling back to un-slugging the window name only for unresolved sessions. Portkey titles through a single `listTitle` chain (`name || label || summary || branch || id[:8]`). Unnamed sessions title on a **first-prompt snippet** (bridge label + sidebar row), never a bare branch or raw session id; tmux stays repo-only until the name lands.

## Consequences

- A wrong name has no manual override; the recourse is the TUI `r` regenerate (which now also feeds assistant snippets) or waiting out drift refresh. Accepted deliberately: bet on generation quality, not escape hatches.
- The v6 bump discards all v5 names (including old pins) — they regenerate on the next monitor/bridge cycle, per the no-migration policy.
- Naming costs two extra transcript scans per `claude -p` call (head stream + tail byte-window), both bounded; discovery hot paths are untouched.
- The salvage clamp means over-long model output degrades to its first 4 words instead of leaving the window unnamed.

## Addendum (2026-09-10): global-subject inputs and the current-name anchor

A 16-session transcript audit (names vs. what each session actually did) scored 8/16 names as tail-biased, generic, or wrong. Two failure modes, roughly half each:

1. **Input-side**: ticket-driven sessions open with skill scaffolding ("Base directory for this skill… ARGUMENTS: TF-283") or a bare ticket ID, mid-samples landed on relayed subagent/teammate notifications and answer-key replies ("11. a / 12. yes"), and base-checkout sessions have no branch slug — so the namer's inputs literally never contained the subject, and it faithfully named the delivery tail ("PR Review Triage" for a form-completed-pipeline session).
2. **Model-side**: the subject WAS present (usually the branch slug, listed last as a bare label) but haiku latched onto a vivid recent phrase — once naming another agent's follow-up work mentioned only in the closing exchange.

Changes, in response:

- **Compaction summaries are mined for intent.** The latest continuation message's "Primary Request and Intent" section (backward tail scan, 500-char cut) enters the prompt as `Session intent` — for long ticket sessions it is often the only input that states the global subject.
- **Noise never reaches the prompt.** Mid-samples drop compaction boilerplate, JSON/notification relays, teammate-message relays, skill scaffolding, answer-keys, and sub-20-char commands (`isNamingNoise`). `getFirstUserPrompt` skips "Base directory for this skill" scaffolding to the first substantive message. The first assistant reply prefers the first *substantive* one (≥100 chars within the first 15) over "I'll load both skills first" acknowledgments.
- **Branch is promoted.** It moves to the top of the context (it names the deliverable verbatim more reliably than any message) and `main`/`master` are omitted entirely; the prompt says to trust branch + session intent over recent messages, and that delivery-phase activity (review, triage, merge, cleanup) is never the subject.
- **Drift renames carry a stability anchor.** Monitor and bridge pass the current cached name; the prompt keeps it verbatim unless the session's overall subject changed, so a well-named session no longer gets renamed after its PR-review tail. The TUI's manual `r` regenerate deliberately omits it — a user-forced rename must be free to change.
- The monitor now actually passes `middlePrompts` (it silently dropped them since their introduction — only bridge/TUI spread the extras).

Re-running the six worst sessions through the new inputs produced deliverable-level names matching an independent per-transcript analysis (e.g. "PR Review Triage" → "Form Completed Receiver", "Ticket Triage" → "Throxy Clients Route", "Stale Block Monitor" → "DNC Actions").

## Addendum (2026-09-10, later): re-baseline, or a stale name is permanent

Backtesting the changes above on 17 sessions (renamed and unchanged, judged blind against their transcripts) scored 8 GOOD / 4 OK / 5 BAD. Rerunning the five failures with the anchor withheld corrected four of them — so the failures were not the inputs but the **stability anchor itself**: it is strong enough that a wrong name never self-corrects. Withholding the anchor entirely is worse, though; a control session drew "Portkey Session UI"/"Portkey Sessions UI"/"Portkey Session Bubbles" across three unanchored runs where the anchor had been holding the (correct) "Portkey Bubbles".

So the anchor stays, with an escape hatch: **`sizes` records the transcript bytes at naming time, and a session whose transcript has since doubled (`shouldRebaseline`) is renamed with the anchor withheld.** Doubling is the observable form of "the session outgrew its name" — the failure mode where an opening bug question ("does the assigned-to-me tab load?") becomes a page redesign and the name still describes the question. `sizes` is an optional field on the v6 cache rather than a version bump: bumping would discard every name, and an absent baseline simply means "keep the anchor until the next rename records one".

The prompt also gained an umbrella rule in the same round, after failures that named a Resend paging fix inside a form-receiver session and a PII-redaction sub-fix inside a migration wave: name the umbrella goal that explains most of the session, never a sub-fix, side thread, or detour however recent, and never the opening question if the session outgrew it. Where the branch and the session intent disagree, prefer the intent — one failure inherited a worktree branch belonging to a *different* session's work.

Residual limit, measured not assumed: on very large multi-topic transcripts (a 24 MB session spanning several migration waves) three runs on identical inputs returned "Postgres Migration", a refusal, and "Dual Write PII Log". Snippet-based naming has no stable answer when a session genuinely contains several subjects; the anchor is what keeps such a session's name from churning once a reasonable one lands.

## Addendum (2026-09-10, evaluation): a dev/holdout harness, consensus draws, sibling context

Ad-hoc judging of cached names proved unreliable — the same name on the same transcript
drew different verdicts from different judges, so round-over-round totals were measuring
rater noise, not naming quality. Naming changes are now measured with a fixed harness:
a seeded, size-stratified sample of real sessions split into a dev set (tuned against)
and a holdout judged once at the end, with a written rubric that fixes the GOOD/OK/BAD
boundaries and forbids downgrading for style, for omitting a delivery phase, or for a
synonym choice. Dev went 17/6/1 → 20 GOOD / 4 OK / 0 BAD; the fresh holdout, which
influenced nothing, scored 14 GOOD / 5 OK / 1 BAD.

What moved the numbers, in order of effect:

- **Branch comes from the transcript, not the checkout.** `git branch --show-current` in
  a base checkout shared by several agents returns whoever checked out last, which named
  one session after a different session's work. The branch is now the mode of the
  session's own `gitBranch` entries (`scanTranscriptForNaming`), ignoring main/master.
- **Best-of-three consensus.** Identical context re-run gave materially different names on
  long multi-topic sessions, and single draws refused 4–8% of the time. `generateAIName`
  now draws `NAME_SAMPLES` candidates concurrently (wall time stays one call) and returns
  the medoid by word overlap (`pickConsensusName`): the shared subject survives across
  draws, each draw's idiosyncratic word does not. Refusals went to zero across two full
  sample runs, since one bad draw no longer decides.
- **Sibling names in the prompt.** A name is a list label, so it must be distinguishable
  from its neighbours; without this, every session covering one PR of a long migration
  landed on the migration's own name. Both namers now pass up to 8 names already taken by
  same-repo sessions.
- **Two refusal-filter false positives**, both caught by the holdout: `"claude code"` was
  a blanket reject even though claude0 manages Claude Code and sessions are legitimately
  named after it, and the dangling-word guard rejected any name ending in "this"
  ("Chat About This"). Self-introductions are still caught by the first-person prefixes.

Not fixed, and the dominant residual in both sets: **altitude on multi-session projects**.
A session covering one increment of a long program tends toward the program's name, and a
session covering the whole program sometimes takes one increment's name. Two prompt
rewrites aimed at this were net-neutral — each fixed some sessions and broke others —
so the wording was reverted to the version that scored best and the failure is recorded
rather than papered over.
