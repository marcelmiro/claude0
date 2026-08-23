# Implementation 1 — Wrapper Contract Test Suite

> **Status:** DRAFT — for agent iteration.
> **Depends on:** nothing (this is the foundation).
> **Unblocks:** Implementation 2 (the failing tests define its target contract).
>
> **⛔ Gate:** Do not write code until **Gate A (items A1–A5)** and **Gate B** in
> [`04-verification-gates.md`](./04-verification-gates.md) are 🟢. See the
> Enforcement protocol in [`00-overview.md`](./00-overview.md).

## Goal

Build a test suite that pins the behavior of the parts of Claude0 that **wrap Claude
Code** — status detection and session-content parsing — as executable contracts.

Two outcomes:

1. **Define the target.** Many of these tests are written against the *intended*
   event-sourced / transcript-based behavior. They are **expected to fail
   against the current viewport-scraping implementation.** That is deliberate:
   the failing tests are the specification for Implementation 2.
2. **Detect Claude Code drift.** A new `claude` release that changes hook
   payloads, transcript shapes, or TUI rendering should make a test fail loudly
   instead of silently breaking Claude0 in production.

## Why first

- A migration without a regression net is a rewrite by vibes. These tests make
  "scroll-up no longer flips status" a concrete assertion rather than a hope.
- The fixtures captured here (real hook payloads + real transcripts) are the
  same artifacts Implementation 2 needs. Capturing them once, as test data,
  pays for both efforts.

## Current state (verified)

- `package.json` has **no `test` script** and there are **no `*.test.ts` files**.
  `CLAUDE.md` references `bun test` and `bun:test` aspirationally.
- Test framework: **`bun:test`** (built in, zero new deps). Add
  `"test": "bun test"` to `package.json` scripts.
- The code under test today: `src/core/status.ts` (`detectStatus`,
  `getAbovePrompt`, `parseContextPercent`) and the archived-session transcript
  reader in `src/ui/preview-pane.ts` / `src/core/sessions.ts`.

## Test layout (proposed)

```
src/
  core/
    status.ts
    status.test.ts            # characterization tests for the CURRENT scraper
    event-status.ts           # (created in impl #2) — target behavior
    event-status.test.ts      # contract tests, FAIL until impl #2 lands
    transcript.ts             # (created in impl #2) — live transcript reader
    transcript.test.ts        # contract tests
test/
  fixtures/
    hooks/                    # captured hook stdin payloads, one file per scenario
      idle.json
      running-pretooluse.json
      waiting-permission.json
      waiting-question.json   # AskUserQuestion PreToolUse / Notification
      turn-complete-stop.json
      ...
    transcripts/              # captured *.jsonl slices, one per scenario
      running.jsonl
      pending-tool.jsonl
      askuserquestion.jsonl
      ...
    viewport/                 # captured `capture-pane` output (incl. ANSI)
      running.txt
      running-scrolled-up.txt # the regression case
      waiting.txt
      ...
    SCHEMA.md                 # the verified shapes (see §Schema Pinning)
```

Keep fixtures as **real captured data**, not hand-authored guesses. Hand-authored
fixtures encode our assumptions and defeat the drift-detection purpose.

## Schema Pinning (the prerequisite task — shared with impl #2 §1b.0)

Before writing assertions, capture ground truth from a live session on the Mac
(or any machine with `claude`):

1. Install a throwaway hook for every event of interest that appends its stdin
   to a dump file:
   ```sh
   # ~/.config/claude0/hooks/dump.sh
   printf '%s\n' "$(cat)" >> /tmp/claude0-hook-dump.jsonl
   ```
   Register it for `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `Notification`, `Stop`, `SubagentStop`.
2. Drive a real session through each scenario (run a tool, trigger a permission
   prompt, trigger an `AskUserQuestion`, let it finish, leave it idle).
3. `tail -f` the live `*.jsonl` transcript through the same scenarios.
4. Record `capture-pane -e` output for each scenario, **including a scrolled-up
   variant** of a running session.
5. Distill the observed shapes into `test/fixtures/SCHEMA.md`.

**Resolve these specific unknowns and record the answer in SCHEMA.md** (the prior
research cited capabilities from docs but some field names were inferred).
**RESOLVED 2026-06-25 (claude v2.1.191) — see `test/fixtures/SCHEMA.md`:**

- [x] `Notification`: discriminator is `notification_type` ∈ {`permission_prompt`,
      `idle_prompt`} (messages "Claude needs your permission" / "…waiting for your input").
- [x] Pending `tool_use` does **NOT** appear in the transcript before approval —
      it is written only post-decision. Pending data lives in the `PreToolUse` hook.
- [x] `AskUserQuestion` is `tool_input.questions[]` (plural array), each
      `{question, header, multiSelect, options:[{label, description}]}` — **not**
      a singular `{question, options}`.
- [x] Transcript discriminators: `type:"user"`/`"assistant"` with nested
      `message.content[]` blocks (`text`/`thinking`/`tool_use`/`tool_result`);
      meta types (`mode`, `permission-mode`, `attachment`, `last-prompt`,
      `file-history-snapshot`, `system`, `ai-title`) ignored. The inferred
      `user_message` name is dead.
- [x] `PreToolUse` provides `tool_name`, `tool_input`, `tool_use_id`, `cwd`,
      `session_id`, `transcript_path`, `permission_mode` — the full approval-card data.

## The contracts

### Contract A — Event-sourced status (the headline)

Tests for `event-status.ts` (created in impl #2). Given a sequence of hook events
(from fixtures), assert the derived status:

| Scenario fixture | Expected status |
|------------------|-----------------|
| `SessionStart` only | `idle`/`ready` (define which) |
| `UserPromptSubmit` then nothing | `running` |
| `PreToolUse` with no matching `PostToolUse`/`Stop` | `running` |
| `Notification:permission_prompt` | `waiting` (approval) |
| `Notification:idle_prompt` | `ready` (idle ~60s post-turn, not blocked — mapping to `waiting` would fire a false attention ping on the ready→idle_prompt transition) |
| `Stop` | `ready` / turn-complete |
| `PreToolUse` → `PostToolUse` → (no Stop) | `running` |

**The regression test that defines the project:** feed the *same* logical
"running" state but with the **scrolled-up viewport** fixture, and assert status
is still `running`. This test should:
- **PASS** against `event-status.ts` (which ignores the viewport), and
- be paired with a characterization test showing the current `detectStatus`
  **returns `ready`** for the scrolled-up viewport (documenting the bug).

### Contract B — Transcript parsing

Tests for `transcript.ts` (created in impl #2). Given a `*.jsonl` fixture, assert
the structured output:

- Parses into ordered turns (user / assistant text / tool_use / tool_result).
- A pending tool call surfaces as `{ pending: true, tool, input }` — **sourced
  from the `PreToolUse` hook, NOT the transcript** (verified A3: a pending tool is
  absent from the transcript until approved; see SCHEMA.md). This bullet therefore
  belongs to the hook reader / Contract A, not transcript parsing.
- A resolved `AskUserQuestion` `tool_use.input` surfaces as
  `{ questions: [{ question, header, multiSelect, options:[{label, description}] }] }`
  — **plural `questions` array** (verified A4; corrected from the original
  singular guess) — the data the mobile app renders as buttons.
- Robust to partial/truncated last line (transcript is appended live).
- Returns the last assistant message for the preview/notification text.

### Contract C — Current scraper characterization (CUT for MVP)

> **Decision (Resolved decisions, doc 00): CUT.** Characterizing the scraper we're
> about to demote never signals "the new implementation is done" — the single
> scroll-up regression in Contract A already measures the migration. Skipped for
> MVP. The one exception worth keeping is the paired scroll-up characterization
> noted in Contract A (current `detectStatus` returns `ready` for the scrolled-up
> fixture), since it documents the exact bug the project fixes. Everything below is
> retained only as a record of the original intent.

Tests for the existing `status.ts` that **lock in current behavior**, including
its failures, so the migration can be measured and so we notice if the scraper
changes unexpectedly. Mark the known-bad ones clearly:

```ts
// CHARACTERIZATION: documents current (buggy) behavior. Impl #2 replaces the
// status source; this test is expected to be deleted/inverted when event-status
// becomes primary.
test("scraper misreports scrolled-up running session as ready", () => {
  expect(detectStatus(fixture("viewport/running-scrolled-up.txt"), true).status)
    .toBe("ready"); // the bug, pinned
});
```

### Contract D — Version-drift canary (DEFERRED past MVP)

> **Decision (Resolved decisions, doc 00): DEFER.** This is a future "new Claude
> version broke us" alarm, not a completion gate — a different axis from the
> definition-of-done. Build it once the tool is a daily dependency. Spec retained
> below for when that time comes.

A test, gated behind an env flag (e.g. `CLAUDE0_LIVE_CLAUDE=1`) so it does not run in
normal CI without a `claude` binary, that:

- Spawns a minimal real session, captures a fresh hook payload + transcript line,
  and asserts it still matches the shapes in `SCHEMA.md`.
- On mismatch, fails with a diff pointing at which field drifted.

This is the "new Claude version broke us" alarm. Keep it separate from the pure
unit tests so the default `bun test` stays hermetic and fast.

## Test infrastructure tasks

- [ ] Add `"test": "bun test"` to `package.json` scripts.
- [ ] Add a tiny fixture loader helper (`test/helpers/fixture.ts`) — reads a file
      under `test/fixtures/` and returns string/parsed JSON.
- [ ] Decide fixture-vs-snapshot strategy: prefer explicit assertions over
      `bun:test` snapshots for the contract tests (snapshots hide intent); use
      fixtures as *inputs*, not as golden outputs.
- [ ] Ensure tests run with no tmux / no `claude` present (hermetic). (The only
      non-hermetic test is the deferred Contract D canary, if/when it is built.)
- [ ] **Build the verification-gate guard test** (decided enforcement, **scoped to
      Gate A only for MVP**). Create `docs/plans/iphone-sessions/verification.json`
      and `verification-gate.test.ts` per the spec in
      [`04-verification-gates.md`](./04-verification-gates.md) §Hard-enforcement
      spec: `bun test` fails for any gate with `enforce: true` and
      `status !== "verified"`. For MVP only **Gate A** is `enforce: true`; keep the
      B/C entries in `verification.json` (`enforce: false`) so they can be flipped
      on later without rebuilding. This is itself gated behind Gate B passing first.

## Acceptance criteria

- `bun test` runs green for Contracts A + B *after Implementation 2*, and the
  event-sourced status tests are RED before it (proving they specify the target).
- Every "Open question" in Schema Pinning is closed and recorded in
  `SCHEMA.md` with a real captured example.
- The scroll-up regression is expressed as a single, named, passing test against
  `event-status.ts`.
- *(Deferred — Contract D)* when the drift canary is later built, it fails loudly
  with a diff against a deliberately edited fixture, proving it works.

## Open questions

- [x] **RESOLVED (A8, 2026-06-25):** `AskUserQuestion` is answered reliably via
      `send-keys` index nav — single-select `↓`×idx + `Enter`; multiSelect `Space`
      to toggle each + `→` to Submit + `Enter`. Confirmed on the event stream
      (`PostToolUse.tool_response.answers`). A hook-supplied answer is unnecessary.
      The pending question (options to render) comes from `PreToolUse.tool_input`,
      not the transcript — so the round-trip belongs to impl #2's hook/bridge path,
      not Contract B (transcript = resolved history only).
- [ ] How stable are transcript line shapes across `claude` minor versions?
      Decide whether the parser should be tolerant (ignore unknown keys) — it
      should — and test that tolerance explicitly.
- [ ] Should fixtures be committed to the repo (they may contain prompt text)?
      Default: yes, but scrub any sensitive content; this is a personal tool.
