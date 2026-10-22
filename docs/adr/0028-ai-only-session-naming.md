# 28. Session names are AI-only, resolved from one cache on every surface

Date: 2026-08-31
Status: accepted; amended 2026-09-10 (drift renames keep the current name as an anchor, re-baselined when the transcript doubles; best-of-three draws) and 2026-10-09 (forks inherit the parent's name)

How names are generated, refreshed and resolved — the prompt inputs, filters, cooldowns,
failure log, and the evaluation harness and its scores — is in [docs/naming.md](../naming.md).

## Context

Sessions carry a generated name in two forms: the stored **title form** ("Fix Auth") and the derived **slug form** (`fix-auth`) used only on tmux windows — where it is load-bearing: `reverseNameMap` resolves panes back to session ids through it.

Two classes of problems had accumulated:

1. **Names described the interaction, not the work.** The namer saw only user messages (first/last prompt + summary + branch), so a session opened with "grill me on this plan" was named "Grill Plan" — the subject of the plan appears only in the assistant's reply, which the namer never received. Refusal-shaped output was discarded outright, leaving sessions unnamed for the 5-minute cooldown.
2. **Surfaces disagreed.** Push labels were reverse-engineered from the window slug (title → abbreviate → 24-char cut → un-kebab → title-case: "Notifications Config" arrived as "Notif Cfg"); the user-pinned name was honored on only half the surfaces; the bridge never wrote `sources`, so the monitor re-named every bridge-named session; the bridge also never drift-refreshed, and the monitor only ticks while a tmux client is attached — phone-only days froze names; portkey had four diverging title-fallback chains.

## Decision

**AI naming is the only name source.** Pinning (user-typed override, TUI-only entry point) is removed with its cache field; the cache is `names.json` v6.

**Generation names the subject.** The namer sees assistant replies, mid-session messages and the session's own branch, not just the first and last prompt — long sessions often open and close with meta text while the subject appears only in the middle. Refusal-shaped output is salvaged before rejection.

**Monitor and bridge are symmetric namers.** Both apply the same drift rule, share the cooldown markers, and write `sources` on success. The monitor stays the sole *window-writing* authority (ADR 14 addendum).

**Drift renames keep the current name unless the session outgrew it.** The current name is passed as an anchor, so a well-named session isn't renamed after its PR-review tail; a session whose transcript has doubled since naming is renamed without it, because an anchor strong enough to stop churn also stops a wrong name from ever self-correcting.

**A fork starts with its parent's name** ("Name 2") and earns its own on its first prompt. Within a colliding group the earliest-named session keeps the base name; an existing session is never renamed under you.

**One resolver, per-surface rules.** Every consumer resolves via `getSessionName()`. Unnamed sessions title on a first-prompt snippet, never a bare branch or raw session id.

## Consequences

- A wrong name has no manual override; the recourse is the TUI `r` regenerate or waiting out drift refresh. Accepted deliberately: bet on generation quality, not escape hatches.
- The v6 bump discarded all v5 names (including old pins), per the no-migration policy.
- Naming costs two extra transcript scans per `claude -p` call (head stream + tail byte-window), both bounded; discovery hot paths are untouched.
- Snippet-based naming has no stable answer for a session that genuinely contains several subjects; the anchor is what keeps such a name from churning.
