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

## Addendum 2026-09-29: the switch-model confirm, and effort is per model

- Claude Code 2.1.284 confirms a model switch on a conversation with a warm cache
  ("Switch model? … the full history gets re-read"). The arg form no longer always prints
  "Set model to …" at once. `setSessionModelEffort` returns `{ok, dialog: true}` when the
  confirm appears, and the phone shows it as a dialog card with Claude's own options
  ([ADR 31](0031-dialogs-covering-the-input-box.md)). A confirmation line counts only when
  it sits under the command's own echo; an earlier switch's line on screen used to be
  reported as this one's success.
- `/effort` now saves per model, under `modelSettings.<model id>.effortLevel` in
  `~/.claude/settings.json` (lab: `/effort low` on Haiku wrote `claude-haiku-4-5`). A
  switch inside a running session keeps the session's effort: a Fable session at xhigh,
  switched to Opus 5.5, still read `Opus 5.5 • xhigh`.
- The `/model` picker also offers `s` to use a model for this session only. Portkey's
  arg-form switch still saves the global default.

## Addendum 2026-09-29: mid-turn switches

- Lab-verified on 2.1.284 against the model and effort recorded on each assistant
  message: `/model` and `/effort` typed mid-turn run at once (unlike `/rewind`, which
  queues) and apply from Claude's next API call in the same turn, as a pick in the Alt+P
  picker does.
- Typing `/model x` on a warm cache, which mid-turn it always is, opens "Switch model?";
  the picker switches without asking. `setSessionModelEffort` presses Enter on the confirm
  when its cursor sits on "Yes, switch to …", so a phone tap switches the way the picker
  does. The sheet always states the cost instead: a switch re-reads the whole conversation
  on Claude's next step. Any other dialog still returns `{ok, dialog: true}`.
- Mid-turn the confirmation isn't echoed; it's a toast in the slot above the input box that
  lingers ~7s. It counts only if it wasn't already up when the command was typed. At the
  prompt, the line under the command's echo counts only if that echo is the newest.
  Re-applying the value just applied, mid-turn within ~7s, reports `no-confirm` (the toast
  text is identical) though Claude applied it.
- A wrapped confirmation's continuation rows sit 5 columns in, under the `⎿`'s text; the
  right-aligned effort indicator (`◐ medium · /effort`) below the line is no longer joined
  onto it.
- A draft stashed for the switch is yanked back only once the switch settles. Yanked
  right after the command's Enter, as `sendMessage` does, the C-y landed in the confirm
  and left the draft cut (lab-verified). Under a dialog left for the card, the draft stays
  in the kill ring for C-y at the Mac.

## Addendum 2026-09-30: the draft rides Claude's stash

The switcher no longer times the draft's restore around the switch confirm: the draft is
stashed with Claude's Ctrl+S, and Claude puts it back once the confirm is accepted
([ADR 9](0009-interrupt-revert-mirroring.md) addendum 2026-09-30).

## Addendum 2026-10-01: the picker offers aliases only

The picker's rows had included the previous Opus by its full id (`claude-opus-5[1m]`), one row
under the current one. Claude saves a `/model <arg>` **verbatim** as the new-session default
(lab, 2.1.286, isolated HOME: `/model opus[1m]` → `"model": "opus[1m]"`, confirmed as "Set
model to Opus 5.5 (1M context) and saved as your default for new sessions"; `/model
claude-opus-5[1m]` → `"model": "claude-opus-5[1m]"`, "Set model to Opus 5 (1M context) …";
`/model default` removes the key, "Set model to Opus 5.5 (default) …"). So that one row pinned
*every future session* to a frozen version from a single tap, while the sheet's model hint —
unlike the effort hint — never mentioned the scope. New sessions were observed starting on
Opus 5 (1M) from their first message while Opus 5.5 was current, which only that saved id
produces.

- `MODEL_ARGS` and the sheet's rows now carry **aliases only** (`default`, `opus[1m]`,
  `fable`, `sonnet`, `haiku`). An alias tracks the current version of its family, so a saved
  default can never be stale. Reaching an older version stays Claude's own picker, at the desk.
- `parseStatusline` still resolves an older Opus to its full id, so such a session marks no
  row (it is no longer selectable) — and `configLabel` now derives the readout from that id
  (`claude-opus-5[1m]` → "Opus 5") instead of reading "—".
- Family aliases are version-free, so a family's version bump is a sub-label edit: Sonnet's
  alias now resolves to Sonnet 5.5 (verified: `claude --model sonnet -p` → `claude-sonnet-5-5`).

## Addendum 2026-10-03: plain `opus` marks the Opus row

On Claude Code 2.1.288 bare `opus` is no longer a non-1M base. `claude -p --model opus`
reports `claude-opus-5-5` with a 1,000,000 context window, and `--model opus[1m]` reports
`claude-opus-5-5[1m]`, also at 1,000,000. Only the latter renders "(1M context)" on the
statusline. With `"model": "opus"` as the saved default, every new session rendered
`Opus 5.5`, parsed to `opus`, and the picker marked no row.

- `parseStatusline` maps the current Opus to `opus[1m]` with or without the suffix, so the
  Opus row is marked for both. An older Opus still keeps its full id, with `[1m]` only when
  suffixed, so it marks no row.
- The picker's row stays `opus[1m]`, because a tap saves its arg verbatim as the default and
  the two aliases resolve to different model ids.
