# Model/effort switcher

How portkey's `Model · Effort` picker reads and changes a session's model and reasoning
effort. Decision: [ADR 4](adr/0004-model-effort-switcher-scope.md). Code:
`core/session-api.ts` (`MODEL_ARGS`, `EFFORT_ARGS`, `parseStatusline`,
`setSessionModelEffort`, `configLabel`). Mechanics are guarded by
`test/smoke/model-effort.sh`, opt-in because it drives real sessions (not part of
`bun test`).

## The sheet

- One `Model · Effort` sheet: model options as rows (aliases only: `default`, `opus[1m]`,
  `fable`, `sonnet`, `haiku`), effort as a chip row. `/model` and `/effort` in the composer
  both open it. One tap applies one change and closes — the config route
  (`POST /sessions/:id/config`) takes a single field per request.
- The ⋯ session sheet has a row whose label is the current values (`Opus · High`) and opens
  the picker. It renders only for the open conversation with a live pane, because the values
  come from the loaded transcript's pane scrape. An unparsed value reads as `—`.
- Ultracode's session-only scope is a hint line under the chip row. The sheet also states a
  model switch's cost: it re-reads the whole conversation on Claude's next step.

## Reading the current values (`parseStatusline`)

- Current *effort* depends on the user's `~/.claude/statusline.sh` rendering
  `.effort.level` as the final word of some `•`-delimited segment, bare or parenthesized
  (`• Opus 5.5 (high)`). Position doesn't matter: every segment is token-scanned for a
  trailing `EFFORT_ARGS` member, last match winning, and for a model name. Without that
  statusline edit the switcher still works; the sheet just can't pre-mark the active level.
- The native `~/.claude/sessions/<pid>.json` carries only `kind`, `sessionId`, `status`,
  `pid`, `updatedAt` — no structured per-session source for effort exists.
- **Opus versions.** The current Opus (one constant) maps to `opus[1m]` with or without the
  `(1M context)` suffix: on 2.1.288 bare `opus` also resolves to a 1M-window Opus 5.5 but
  renders without the suffix, so both must mark the Opus row. Any other rendered version
  derives its full id from the version number (`[1m]` only when suffixed), so a session on
  an older Opus marks no row, and `configLabel` derives its readout from that id
  (`claude-opus-5[1m]` → "Opus 5").
- Family aliases are version-free, so a family's version bump is a sub-label edit.

## Applying a change (`setSessionModelEffort`)

- Sends the arg-form command (`/model opus[1m]`, `/effort high`) through the guarded send
  path ([docs/pane-input.md](pane-input.md)); a draft is stashed with Ctrl+S and Claude puts
  it back once the switch (and any confirm) is accepted.
- **Scope, as Claude implements it** (lab, 2.1.284–2.1.286): `/model <arg>` saves the arg
  **verbatim** as the new-session default (`/model default` removes the key); `/effort`
  saves per model under `modelSettings.<model id>.effortLevel` in `~/.claude/settings.json`,
  and a model switch inside a running session keeps the session's effort. The `/model`
  picker's `s` (this session only) has no arg form.
- **Switch confirm.** On a warm cache (always, mid-turn) `/model x` opens "Switch model? …
  the full history gets re-read". When its cursor sits on "Yes, switch to …" the switcher
  presses Enter, as Claude's own Alt+P picker switches without asking. Any other dialog
  returns `{ok, dialog: true}` and the phone shows it as a dialog card
  ([ADR 31](adr/0031-dialogs-covering-the-input-box.md)).
- **Mid-turn**, `/model` and `/effort` run at once (unlike `/rewind`, which queues) and
  apply from Claude's next API call in the same turn (2.1.284, checked against the model
  and effort recorded on each assistant message).

## Reading the confirmation

- At the prompt: the `Set model to …` / effort line counts only if it sits under the
  command's own echo and that echo is the newest — an earlier switch's line on screen used
  to be reported as this one's success.
- Mid-turn the confirmation isn't echoed; it's a toast in the slot above the input box that
  lingers ~7s, and it counts only if it wasn't already up when the command was typed.
  Re-applying the value just applied, mid-turn within ~7s, reports `no-confirm` (identical
  toast text) though Claude applied it.
- A wrapped confirmation's continuation rows sit 5 columns in, under the `⎿`'s text; the
  right-aligned effort indicator (`◐ medium · /effort`) below the line is not part of it.
