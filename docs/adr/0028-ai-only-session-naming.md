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

**Monitor and bridge are symmetric namers.** Both apply the same drift rule (regenerate when `lastPrompt || summary` diverges from the stored source), share the on-disk `naming-skip.json` cooldown, and write `sources` on success. The monitor stays the sole *window-writing* authority (ADR 14 addendum) and runs the same per-repo disambiguation on its immediate post-naming rename as on the tick sync.

**One resolver, per-surface rules.** Every consumer resolves via `getSessionName()`. Push and macOS notification labels resolve the title form from the cache (`{repo} · {Title}`), falling back to un-slugging the window name only for unresolved sessions. Portkey titles through a single `listTitle` chain (`name || label || summary || branch || id[:8]`). Unnamed sessions title on a **first-prompt snippet** (bridge label + sidebar row), never a bare branch or raw session id; tmux stays repo-only until the name lands.

## Consequences

- A wrong name has no manual override; the recourse is the TUI `r` regenerate (which now also feeds assistant snippets) or waiting out drift refresh. Accepted deliberately: bet on generation quality, not escape hatches.
- The v6 bump discards all v5 names (including old pins) — they regenerate on the next monitor/bridge cycle, per the no-migration policy.
- Naming costs two extra transcript scans per `claude -p` call (head stream + tail byte-window), both bounded; discovery hot paths are untouched.
- The salvage clamp means over-long model output degrades to its first 4 words instead of leaving the window unnamed.
