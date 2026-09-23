# 4. The phone's model/effort switcher inherits Claude's own scoping

Date: 2026-07-20 (documenting an earlier decision)
Status: accepted

## Context

Portkey can change a session's model or reasoning effort: `/model` or `/effort` in the
composer opens a selection sheet, and tapping an option `POST`s to `/sessions/:id/config`.

Claude's own scoping for these commands is not uniform. Model and the normal effort levels
set the **global default** ("for new sessions"); `ultracode` applies to the **current session
only**. The bridge could have hidden that — by re-issuing the global default afterwards, or
by presenting everything as session-scoped.

## Decision

Don't paper over it. The bridge sends the arg-form slash command (`/model opus`,
`/effort ultracode`) through the existing send path and surfaces Claude's verbatim
confirmation toast. Scope is whatever Claude's scope is.

The route validates against `MODEL_ARGS` / `EFFORT_ARGS` (`core/session-api.ts`), so nothing
reaches the pane on a bad value.

## Consequences

- The phone never disagrees with the terminal about what a command did — the confirmation the
  user reads is Claude's own.
- The sheet has to label `ultracode` as session-only, because the user cannot infer it.
- Reading the *current* effort depends on the user's `~/.claude/statusline.sh` rendering
  `.effort.level` as *some* `•`-delimited segment (it replaced the older `• thinking`
  boolean); current *model* is already in the statusline. Position doesn't matter:
  `parseStatusline` (`core/session-api.ts`) splits on `•` and token-scans every segment for an
  `EFFORT_ARGS` member, last match winning, and for a model name — so a reordered statusline
  still resolves. Without that dotfile edit the switcher still works; the effort sheet just
  can't pre-mark the active level.
- The scrape is irreducible, not laziness: the native `~/.claude/sessions/<pid>.json` carries
  only `kind`, `sessionId`, `status`, `pid`, `updatedAt`. There is no structured per-session
  source for effort anywhere. Weighed against the alternatives in
  [ADR 6](0006-wrapping-claude-code.md).
- Mechanics are guarded by `test/smoke/model-effort.sh`, opt-in because it drives real
  sessions; it is not part of `bun test`.

## Addendum 2026-09-23: one combined picker, reachable from the session sheet

Reading the current model and effort required typing `/model` or `/effort` — enough
friction that it rarely happened. The dock statusbar was rejected as the readout: it
already spends its width on mode · branch · context percent.

- The two selection sheets merged into one `Model · Effort` sheet: model options as rows,
  effort as a chip row (same pattern as the snooze presets). One tap applies ONE change and
  closes — the config route still takes a single field per request, and Claude's verbatim
  confirmation is what the user reads next. `/model` and `/effort` both open it.
- The ⋯ session sheet gains a row whose label IS the current values (`Opus · High`) and
  which opens the picker. It renders only for the open conversation with a live pane —
  the values come from the loaded transcript's pane scrape, which the Home list never
  performs per row. An unparsed value (statusline not rendering effort) reads as `—`.
- Ultracode's session-only scope moves from an option sub-label to a hint line under the
  chip row.

## Addendum 2026-09-23: Opus version tracking

Claude Code 2.1.280 made Opus 5.5 the default Opus. The picker's "previous Opus" row is
now Opus 5 (`claude-opus-5[1m]`). `parseStatusline` no longer special-cases one old
version: the current Opus (a single constant) maps to the `opus` alias, and any other
rendered version derives its full id from the version number — so a session on an older
Opus never marks the current row, whichever version it is.
