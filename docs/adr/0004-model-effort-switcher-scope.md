# 4. The phone's model/effort switcher inherits Claude's own scoping

Date: 2026-07-20 (documenting an earlier decision)
Status: accepted; amended 2026-09-29 (switch confirm accepted for the user), 2026-10-01 (aliases only)

How the picker reads and applies values — statusline parsing, Opus version tracking, the
switch confirm, mid-turn toasts — is in [docs/model-effort-switcher.md](../model-effort-switcher.md).

## Context

Portkey can change a session's model or reasoning effort: `/model` or `/effort` in the
composer opens a selection sheet, and tapping an option `POST`s to `/sessions/:id/config`.

Claude's own scoping for these commands is not uniform. Model and the normal effort levels
set the **global default** ("for new sessions"); `ultracode` applies to the **current session
only**. The bridge could have hidden that — by re-issuing the global default afterwards, or
by presenting everything as session-scoped.

## Decision

Don't paper over it. The bridge sends the arg-form slash command (`/model opus[1m]`,
`/effort ultracode`) through the existing send path and surfaces Claude's verbatim
confirmation. Scope is whatever Claude's scope is.

The route validates against `MODEL_ARGS` / `EFFORT_ARGS` (`core/session-api.ts`), so nothing
reaches the pane on a bad value.

- **Aliases only.** Claude saves a `/model <arg>` verbatim as the new-session default, so a
  row offering a full id (`claude-opus-5[1m]`) pinned every future session to a frozen
  version from one tap — new sessions were observed starting on Opus 5 while Opus 5.5 was
  current. An alias tracks the current version of its family, so a saved default can never
  be stale. Reaching an older version stays Claude's own picker, at the desk.
- **The model-switch confirm is accepted for the user** when its cursor is on "Yes, switch
  to …" — Claude's own picker switches without asking, and mid-turn the confirm always
  appears. The sheet states the cost (the whole conversation is re-read) instead.

## Consequences

- The phone never disagrees with the terminal about what a command did — the confirmation the
  user reads is Claude's own.
- The sheet has to label `ultracode` as session-only, because the user cannot infer it.
- Reading the *current* effort scrapes the statusline, which depends on the user's
  `~/.claude/statusline.sh` rendering it. The scrape is irreducible, not laziness: there is no
  structured per-session source for effort anywhere. Weighed against the alternatives in
  [ADR 6](0006-wrapping-claude-code.md).
- Mechanics are guarded by `test/smoke/model-effort.sh`, opt-in because it drives real
  sessions; it is not part of `bun test`.
