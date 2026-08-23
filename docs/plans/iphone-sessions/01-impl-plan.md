# Implementation 1 — Wrapper Contract Test Suite (executable plan)

> **Status: IMPLEMENTED (2026-06-25).** All deliverables landed: `package.json`
> `test` script; `test/helpers/fixture.ts`; `verification-gate.test.ts`;
> `src/core/status.test.ts` (scroll-up characterization, GREEN);
> `src/core/event-status.test.ts` + `src/core/transcript.test.ts` (Contract A/B,
> RED-by-design until Impl #2). Gate command verified: green-set exits 0,
> contract-set exits non-zero, guard fails-naming-Gate-A when flipped to
> `unverified`. Fixtures + `SCHEMA.md` + `verification.json` (Gate A `verified`)
> were already present. `event-status.ts` / `transcript.ts` intentionally NOT
> created — that is Impl #2.

> Distilled, execution-ready plan for [`01-wrapper-contract-tests.md`](./01-wrapper-contract-tests.md),
> MVP-scoped per [`00-overview.md`](./00-overview.md) §Resolved decisions.
> **Right-size note:** trips one `plan-large` trigger — a sequenced dependency
> (the Gate A live-capture spike must produce `SCHEMA.md` + fixtures before any
> assertion can be written). Kept as one PR per explicit `plan-small` request.

## Summary

Claude0 has zero tests and its status/transcript sensing is unpinned. Build a
hermetic `bun:test` suite that (a) captures Claude Code's **real** hook,
transcript, and viewport shapes as fixtures + `SCHEMA.md`, closing Gate A;
(b) encodes the event-sourced status truth table (Contract A) and transcript
parsing (Contract B) as tests that import the not-yet-built
`src/core/event-status.ts` / `src/core/transcript.ts` and are therefore **RED
until Implementation 2** — the failing tests are Impl #2's spec; (c) keeps one
characterization test pinning the scroll-up bug; and (d) ships the
verification-gate guard test that keeps `bun test` red until Gate A is
`verified`. No production behavior changes — this PR is tests, fixtures, and the
gate guard only.

## Out of scope — DO NOT (read before implementing)

- **DO NOT create `src/core/event-status.ts` or `src/core/transcript.ts`** in this
  PR. Their absence is a *deliverable*: it is what makes the Contract A/B tests
  RED, and those failing tests are the executable spec Impl #2 must satisfy. If you
  feel the urge to "make `bun test` pass" by creating them, **stop — that is Impl
  #2's job and would be the wrong outcome here.**
- **DO NOT fix the scroll-up bug** (don't touch `src/core/status.ts`). This PR only
  *pins* the bug as a characterization test.
- A full-suite `bun test` exiting **non-zero is the intended state** of this PR
  (the two contract files fail on purpose). Verify success with the explicit
  commands in §Verification → Done when — never with a bare `bun test` exit code.

## Files to touch

### package.json

Add `"test": "bun test"` to `scripts`. No new deps (`bun:test` is built in).

### test/helpers/fixture.ts

New tiny loader. **Synchronous** (`readFileSync` from `node:fs`) so call sites
stay sync — `detectStatus` is synchronous and must not be handed a `Promise`.
`fixture(rel): string` → file text under `test/fixtures/`;
`fixtureJson(rel): unknown` → `JSON.parse` of same. No tmux/claude dependency.

### test/fixtures/SCHEMA.md + hooks/ + transcripts/ + viewport/

The Gate A artifact — **captured live (claude v2.1.191, 2026-06-25); already
present in the repo.** `hooks/` has 9 real payloads (sessionstart,
userpromptsubmit, pretooluse, posttooluse, stop, notification-permission,
notification-idle, plus `pretooluse-askuserquestion{,-multiselect}` — the
pending-question source); `transcripts/` has `approved-tool.jsonl` (resolved
tool_use→tool_result) and `askuserquestion.jsonl` (real `questions[]` structure);
`viewport/` has `running.{txt,plain.txt}` (running) and
`running-scrolled-up.{txt,plain.txt}` (the B3 bug — scrolled mid-run).
`detectStatus` consumes the `.plain.txt` (ANSI-stripped) form; the strip lives in
`sessions.ts:389-392`, extract it in Impl #2. `SCHEMA.md` records every Gate A/B
item with a real example. Work-codebase paths were scrubbed to `/private/tmp`.

### docs/plans/iphone-sessions/verification.json

**Canonical** machine source of truth: gates A/B/C with `status` + `enforce`.
Gate A `enforce: true`; B/C `enforce: false` (kept for later flip). The 🔴/🟢
statuses in `04-verification-gates.md` are a human-readable mirror, manually kept
in sync (the gates doc already states this @ 04-verification-gates.md:38-39); the
guard test reads only the JSON. See §Hard-enforcement spec there.

### docs/plans/iphone-sessions/verification-gate.test.ts

Guard. Reads `verification.json`; fails for any gate with `enforce: true` and
`status !== "verified"`, naming the gate and pointing at the gates doc. Built
after the harness exists (Gate B is trivially met by then).

### src/core/status.test.ts

Characterization test (Contract C is cut except this one). `fixture()` returns
**raw** file text and `detectStatus` needs ANSI-stripped input, so use the
`.plain.txt` variants. Two assertions for a meaningful contrast:
`detectStatus(fixture("viewport/running-scrolled-up.plain.txt"), true).status === "ready"`
(the bug) and `detectStatus(fixture("viewport/running.plain.txt"), true).status === "running"`
(control). This pins the migration target. **Temporary:** it asserts
buggy behavior and will flip the moment the scroll-up bug is fixed. It is not
fixed in this PR (only the scraper's successor is). Impl #2 owns deleting or
inverting it when `event-status` becomes the primary status source; leave a code
comment saying so.

### src/core/event-status.test.ts

Contract A. Imports `./event-status` (created in Impl #2 → RED now). **This file
pins event-status.ts's contract, so the interface is specified here, not left to
Impl #2:** a pure function `deriveStatus(events: HookEvent[], opts?: { transcript?: TranscriptEntry[] }): SessionStatus`,
where `events` is the ordered hook-event history (each loaded from a
`hooks/*.json` fixture) and the optional `transcript` is the missed-edge backstop
(doc 00 §Architecture). Each truth-table row builds the event array then asserts
the return. Truth table: SessionStart→`idle`; UserPromptSubmit→`running`;
PreToolUse with no following PostToolUse→`running`; Notification permission→`waiting`;
Notification idle→`ready` (idle_prompt fires ~60s post-turn — session is sitting
at an empty prompt, not blocked; mapping it to `waiting` would make the
ready→idle_prompt sequence a false "blocked" attention ping); Stop→`ready`. Headline regression: feed the running
event history (the scroll-up viewport is irrelevant to this function) → `running`.

### src/core/transcript.test.ts

Contract B. Imports `./transcript` (created in Impl #2 → RED now). Sourced from
real fixtures (SCHEMA.md). Asserts: ordered turns from `type:"user"`/`"assistant"`
records with nested `message.content[]` blocks (`text`/`thinking`/`tool_use`/
`tool_result`), ignoring meta record types; a **resolved** tool surfaces as a
`tool_use`/`tool_result` pair matched by `tool_use_id`; an AskUserQuestion
`tool_use.input` surfaces as **`{ questions: [{ question, header, multiSelect,
options:[{label,description}] }] }`** (plural `questions` array — corrected from
the original singular guess, A4); tolerates a truncated last line and unknown
keys; returns the last assistant message.

> **Pending interactions are NOT in the transcript (A3).** A tool awaiting
> approval, or an unanswered AskUserQuestion, has **no** record in the transcript
> until the decision is made. So Contract B covers *resolved history only*; the
> *pending* `{pending, tool, input}` / pending-question data is sourced from the
> **`PreToolUse` hook payload** (`tool_name`/`tool_input`) and is a `event-status`
> / hook concern (Contract A + Impl #2's hook reader), not a transcript-parse
> concern. Fixtures: `transcripts/approved-tool.jsonl`, `transcripts/askuserquestion.jsonl`.

## Edge cases

- No tmux / no `claude` at test time: suite is hermetic; only the Contract A/B
  files are red (module-not-found), never the harness tests.
- `event-status.ts` / `transcript.ts` absent: import error = intended RED, not a
  harness bug. **Verified:** bun:test isolates per file — the failing import is
  reported as "Unhandled error between tests" for that file only; other test files
  still run and pass.
- Gate A unverified: guard test is red until `SCHEMA.md` captured and
  `verification.json` Gate A flipped to `verified`.
- A scenario that can't be triggered solo (e.g. an interactive permission prompt
  headlessly): leave its fixture absent + Gate A item ⬜ — never fabricate it.

## Verification

- Run: `bun test`
- Capture procedure (closes Gate A): install a throwaway `~/.config/claude0/hooks/dump.sh`
  (`printf '%s\n' "$(cat)" >> /tmp/claude0-hook-dump.jsonl`) registered for all seven
  hook events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  Notification, Stop, SubagentStop) — note this is 7 *hooks*, distinct from the 5
  fixture *scenarios* below, several of which span multiple events → drive a live
  session through each scenario (idle, running, waiting-permission,
  waiting-question, turn-complete) → `tail -f` the transcript →
  `capture-pane -e` (incl. scrolled-up) → distill into fixtures + `SCHEMA.md` →
  fill the Result slots + Gate A statuses in `04-verification-gates.md` → flip
  `verification.json` Gate A to `verified`.
- Tests to add: the five files above (signatures inline).
- **Deterministic done command** (the gate — use THIS, not bare `bun test`):

  ```sh
  # GREEN set must pass (exit 0):
  bun test src/core/status.test.ts docs/plans/iphone-sessions/verification-gate.test.ts
  # CONTRACT set must fail (these import the not-yet-built modules):
  bun test src/core/event-status.test.ts src/core/transcript.test.ts   # expect non-zero
  ```

  One-liner that exits 0 **only** in the correct end state (green passes AND
  contracts fail):

  ```sh
  bun test src/core/status.test.ts docs/plans/iphone-sessions/verification-gate.test.ts \
    && ! bun test src/core/event-status.test.ts src/core/transcript.test.ts \
    && echo "INCREMENT OK"
  ```

  (Verified facts this relies on: a missing-module import fails only its own file,
  other files still run; the green-set command exits 0; the full `bun test` exits
  1 by design.)

- Done when (each maps to a command above):
  - GIVEN no tmux/claude present, the **green-set** command exits 0 (`status.test.ts`
    + `verification-gate.test.ts` pass; suite is hermetic) AND the **contract-set**
    command exits non-zero (`event-status`/`transcript` red = spec pinned).
  - GIVEN `verification.json` Gate A `status: "verified"`, `verification-gate.test.ts`
    passes; flipping it back to `"unverified"` makes it fail naming Gate A (sanity).
  - WHEN `detectStatus` is fed `viewport/running-scrolled-up.plain.txt` with
    `hasProcess=true` it returns `ready` (bug), AND `viewport/running.plain.txt`
    returns `running` (control) — the contrast that defines the migration target.

## Verification spike — results (run 2026-06-25, claude v2.1.191)

Gate A **fully closed** (A1–A10) against live sessions; evidence in
`test/fixtures/SCHEMA.md` + filled Result slots in
[`04-verification-gates.md`](./04-verification-gates.md); machine state in
`verification.json` (Gate A = `verified`, `enforce: true` → the guard test passes
on Gate A; `bun test` stays red only via the Impl #2 Contract A/B modules).

- **A1 ✅** envelope `{session_id, cwd, transcript_path, hook_event_name}` on every event.
- **A2 ✅** `notification_type` ∈ {`permission_prompt`, `idle_prompt`}.
- **A3 ❌→reconciled** pending tool_use is **not** in the transcript pre-approval; pending data comes from the `PreToolUse` hook. Plan + doc 00 amended.
- **A4 ⚠️→reconciled** AskUserQuestion is `input.questions[]` (plural), not `{question, options}`. Plan + doc 01 amended.
- **A5 ✅** `type:user|assistant` + nested `message.content[]` blocks; meta types ignored.
- **A6 ✅** attach-aware blocking `PreToolUse` hook (contained project-scoped spike): `allow`/`deny` suppress the prompt, `ask`/exit-0 falls through, a ~5s block + remote decision ran cleanly, and `tmux list-clients` drives detached→block-and-poll vs attached→instant-`ask`. Schema `{hookSpecificOutput:{permissionDecision}}`, default timeout 600s.
- **A7 ✅** hook exec median 5.0ms — negligible.
- **A8 ✅** AskUserQuestion answer round-trip via `send-keys` index nav (single: `↓`×idx+`Enter`; multiSelect: `Space` toggles, `→`+`Enter` submits), confirmed on the event stream (`PostToolUse.tool_response.answers`). Pending question source = `PreToolUse.tool_input.questions[]` (fixtures saved).
- **A9 ✅** send-keys to detached pane. **A10 ✅** cwd→transcript path.
- **B1/B2/B3 ✅** — Gate B verified. B3 captured live: `viewport/running-scrolled-up.plain.txt` (scrolled mid-run via `PageUp`) → `detectStatus` = `ready` (bug); non-scrolled control → `running`. Mechanism: scroll keeps the `❯` prompt but swaps the spinner for `Jump to bottom (ctrl+End) ↓`.

## Decisions and assumptions

- Decision: Plan lives at `docs/plans/iphone-sessions/01-impl-plan.md`. Source: user-confirmed.
- Decision: Include RED Contract A+B files importing the future modules now. Source: user-confirmed + doc @ 01-wrapper-contract-tests.md:210.
- Decision: Agent drives the live capture solo. Source: user-confirmed. Risk: interactive scenarios may be hard to trigger headlessly; uncapturable fixtures stay absent and their Gate A item stays ⬜ rather than faked.
- Decision: Cut Contract C (keep only the scroll-up characterization), defer Contract D. Source: doc @ 00-overview.md:235-243.
- Decision: Only Gate A is `enforce: true` for MVP. Source: doc @ 04-verification-gates.md:51-53.
- Decision: Framework = `bun:test`, no new deps. Source: code @ package.json (no test script) + CLAUDE.md.
- Assumption: transcript path = `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Source: code @ src/core/sessions.ts:507.
- Assumption: fixtures committed, scrubbed of sensitive prompt text. Source: doc @ 01-wrapper-contract-tests.md:230.

## Standards / common-mistakes referenced

- None — repo has no `.agents/standards/` or `.agents/common-mistakes/`.

## Estimated scope

L (borderline — the live-capture spike dominates; harness + tests are small).

## Open questions (CONSIDER from review)

- `verification-gate.test.ts` lives in `docs/plans/iphone-sessions/` (beside the
  `verification.json` it guards), not `test/`. `bun test` finds it via glob, but
  it couples the guard to a docs dir — if that dir is later moved/pruned the guard
  silently vanishes. Justified for now because doc 04's Hard-enforcement spec
  names that exact path and the JSON is docs-resident; reconsider moving both to
  `test/guards/` if the gate outlives the plan suite.
