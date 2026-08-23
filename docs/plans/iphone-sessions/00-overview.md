# iPhone Sessions — Plan Suite Overview

> **Status:** DRAFT — for agent iteration. These documents are *plans*, not
> implementation specs. Each is meant to be picked up by an agent, refined
> against the real codebase and live Claude Code behavior, and only then
> implemented. Treat every "Open question" as a gate that must be closed
> before code is written.

## The goal

Access and continue Claude Code sessions from an iPhone, so work is no longer
tied to carrying the Mac. The plan is to run the existing setup (tmux + zsh +
`claude`) on an always-on host — **the Mac, reached over Tailscale, for the MVP;
migrating to an always-on EC2 box as a later iteration** — keep Claude0 running
there, and build a small single-user companion app that lists and drives those
sessions from the phone. (See §Resolved decisions for why Mac-first and what
that defers.)

The naive alternative — SSH via Tailscale + Termius into raw tmux — is rejected:
the Claude Code TUI is keyboard-centric and miserable on a touch keyboard. The
companion app instead exposes the *operations* you actually do from a phone
(see what needs you, read the latest output/question, approve a tool, send a
short instruction) as buttons and text boxes, not as a terminal.

## The architectural decision: Camp 1 (hooks + JSONL)

Research into how mature Claude Code wrappers capture session state found two
camps (full detail and citations in [`90-references.md`](./90-references.md)):

- **Camp 1 — observe the real interactive session.** Keep `claude` running in
  tmux; derive status from **Claude Code hooks**, read conversation state from
  the **JSONL transcript**, and inject input via a blocking hook (for approvals)
  or `tmux send-keys` (for free text). Reference implementation: **ccgram**.
- **Camp 2 — own the process.** Spawn `claude -p --output-format stream-json`
  headless, parse the event stream, and drive approvals over a stdin control
  protocol. Reference implementation: **vibe-kanban**.

**We chose Camp 1.** Rationale:

1. The stated goal is to keep "my same setup of tmux, zsh, and Claude" and have
   Claude0 observe *real* sessions that are also reachable by SSH from the Mac.
   Camp 2 replaces real sessions with an app-owned process and rebuilds the
   entire UX — a different (much larger) product that discards Claude0.
2. Camp 1 is an **incremental upgrade** to Claude0: the `SessionStart` hook is
   already installed, and `core/` is already headless and reusable.
3. The only thing actually wrong with Claude0 today is the *sensing layer* (scraping
   the rendered TUI viewport). Camp 1 replaces just that layer. The substrate
   (interactive `claude` in tmux) was always correct — it is the only mode that
   preserves human-in-the-loop tool approval.

Critically, **viewport scraping is the wrong data source** and every camp agrees
on this — even Camp 1 tools read the JSONL transcript + hooks and treat
`capture-pane` as, at most, a display thumbnail.

## The two problems this fixes

1. **Status is lost on scroll.** Claude's TUI runs in the terminal alternate
   screen; `capture-pane` only sees the rendered viewport, so scrolling up makes
   a "running" session look "finished." Fix: derive status from **hook event
   edges**, which are independent of what is on screen.
2. **Answering questions / sending messages is poor UX.** Today the answer UI is
   reconstructed by regexing `☐` glyphs off the screen. Fix: `AskUserQuestion`
   options and pending tool calls are **structured data in the `PreToolUse` hook
   payload** (`tool_input` — verified 2026-06-25, see `test/fixtures/SCHEMA.md` A3)
   — render real buttons from real data. *Correction from the original plan: a
   tool/question awaiting approval is **not** in the JSONL transcript until the
   decision is made; the transcript carries only resolved history, so pending UI
   must be sourced from the hook, not the transcript.* The `AskUserQuestion` shape
   is `input.questions[]` (a plural array), not a singular `{question, options}`.

## The three implementations

The work is three large, sequential implementations. Each unblocks the next.

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Wrapper Contract Test Suite                                        │
│    Pin the behavior of the Claude-Code-wrapping layer as executable   │
│    contracts. EXPECTED TO FAIL against today's scraper — the failing  │
│    tests ARE the spec for implementation #2. Also a version-drift     │
│    canary: a future Claude release that changes payloads fails loudly.│
│    → docs: 01-wrapper-contract-tests.md                               │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ unblocks (defines the target contract)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Camp 1 Migration (hooks + JSONL)        [internal to Claude0]          │
│    Replace viewport-scraping with event-sourced status + transcript   │
│    parsing + blocking-hook approval. Many sub-phases. Makes the tests  │
│    from #1 pass and exposes a clean internal API for the bridge.      │
│    → docs: 02-camp1-hooks-jsonl.md                                    │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ unblocks (stable core API)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Mobile App MVP (bridge + web page)                                 │
│    Add a thin `src/bridge` server over the Impl #2 core API and a     │
│    manual-open mobile web page that drives the five interactions over │
│    Tailscale. No monorepo/PWA/push/EC2 — those are optional (doc 05). │
│    → docs: 03-monorepo-mobile-app.md                                  │
└─────────────────────────────────────────────────────────────────────┘
                                 │ then, optionally
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│ (optional) Iterations: push (ntfy) → PWA install → monorepo → EC2    │
│    → docs: 05-optional-iterations.md                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this order

- Tests first because they (a) define the contract the migration must satisfy,
  (b) provide a regression net so the migration is measurable ("scroll-up no
  longer flips status" becomes a passing assertion), and (c) become a permanent
  canary against Claude Code version drift.
- Migration second because the mobile app should consume a *stable, reliable*
  internal API. Building the app on top of the current scraper would bake the
  fragility into the product. **Dogfood gate: stop after #2 and validate the
  scraper→JSONL migration through real Mac coding sessions before starting #3**
  (see §Resolved decisions).
- Mobile app last because it depends on a settled `core` API surface from #2 and
  is mostly additive (transport + presentation) rather than a change to existing
  logic. The monorepo split is deferred entirely to the optional iterations
  ([`05-optional-iterations.md`](./05-optional-iterations.md)).

## Document index

| Doc | Implementation | Scope |
|-----|----------------|-------|
| [`01-wrapper-contract-tests.md`](./01-wrapper-contract-tests.md) | #1 | Contract tests + fixtures + version-drift canary |
| [`02-camp1-hooks-jsonl.md`](./02-camp1-hooks-jsonl.md) | #2 | Hooks, event-status, transcript reader, approval IPC |
| [`03-monorepo-mobile-app.md`](./03-monorepo-mobile-app.md) | #3 | Mobile App MVP: `src/bridge` server + mobile web page + 5 interactions |
| [`05-optional-iterations.md`](./05-optional-iterations.md) | post-MVP | Optional iterations: push (ntfy), PWA install, monorepo split, EC2 |
| [`04-verification-gates.md`](./04-verification-gates.md) | all | Pre-implementation gates that must be 🟢 before any code |
| [`90-references.md`](./90-references.md) | all | Verified Claude Code facts + competitor research + URLs |

## Enforcement protocol (read before implementing anything)

Each implementation has a **Verification Gate** in
[`04-verification-gates.md`](./04-verification-gates.md): a checklist of
falsifiable assumptions (especially about how Claude Code wraps — hook payloads,
transcript shapes, blocking-hook approval) that must be empirically confirmed
*before* implementation begins. The gate exists so an implementation agent never
has to deviate from a plan mid-build because reality differed from an assumption.

**Three rules, enforced:**

1. **Gate-first.** Do not write implementation code for an implementation until
   its gate is 🟢 (Verified & plan reconciled) **and committed**. An agent
   assigned an implementation must first check the gate; if it is not 🟢, the
   agent's task becomes *running the verification spike*, not implementing.
2. **Contradiction rule.** Any verification result that conflicts with a plan
   (⚠️/❌) means: **stop, amend the plan doc to match reality, note the change,
   then re-evaluate the gate.** Plans bend to findings; code does not start until
   they agree.
3. **Auditable artifact.** A verification spike is its own commit and produces
   committed evidence: filled Result slots in `04-verification-gates.md` plus the
   pinned `test/fixtures/SCHEMA.md`. "We verified" must be provable.

Enforcement is documentation-driven (agents follow the plan), so the gate is
loud and linked from every plan. On top of that, **hard enforcement is enabled**
(decided): a guard test keeps `bun test` red until each enforced gate is 🟢, so
skipping the gate requires deleting a test — loud in a reviewed diff. The guard
is built as part of Impl #1 (it needs the test harness to exist first); see the
Hard-enforcement spec in [`04-verification-gates.md`](./04-verification-gates.md).

## Resolved decisions (MVP scope) — read before iterating

These were settled in a design review and **supersede the corresponding "Open
question" / default lines in the per-impl docs.** Where a doc still phrases one
of these as open, treat it as closed per this list and reconcile on next edit.

**Substrate & roadmap**
- **Mac-first substrate.** Run the sessions on the Mac (kept awake), reached over
  Tailscale. EC2 is a *later* iteration, not the MVP. EC2 is Linux → keep all
  Darwin-only calls (`pbcopy`, `caffeinate`, Ghostty, `ps`/TTY quirks) out of
  `core/` and `src/bridge/` so the eventual EC2 move is a config change, not a
  port. The "detached pane" verification (Gate A9) must be exercised **in the Mac
  phase** (test with no tmux client attached), not deferred to EC2.
- **Dogfood checkpoint — STOP after Implementation 2.** Land the Camp 1 migration
  *internal to Claude0* and use it through real Mac coding sessions until it is
  boringly reliable (status never flips on scroll-up; transcript-driven
  preview/answers correct; desk approval via the IPC works) **before** building
  any bridge/app. The migration is validated as a Claude0-internal change, while it's
  still cheap to iterate, before product depends on it.
- **MVP slice = mobile web page, not a PWA.** First shippable product is a
  mobile-Safari web page (Preact) hitting `src/bridge/` over Tailscale,
  manual-open, delivering the five interactions (see status / read output or
  question / approve a tool / answer a question / send a message). PWA install
  and push are *optional next iterations*, not MVP.
- **Optional iterations, in order:** (1) **push** via ntfy (contentless — see
  below); (2) **PWA install** (service worker / add-to-home-screen — resolves the
  iOS secure-context / `tailscale serve` HTTPS question in isolation);
  (3) **monorepo split** (codebase cleanliness, behavior-neutral); (4) **EC2**.
  Session-launch-from-phone stays out of scope until after all of these.

**Architecture & mechanism**
- **Approval = attach-aware blocking `PreToolUse` hook.** The hook queries tmux
  attach state (`tmux list-clients -t <target>`): **client attached → exit
  neutral immediately** (instant desk TUI prompt, no dead air); **detached →
  block-and-poll** a decision file with a long timeout (real remote-approval
  window). This also arbitrates the double-approval race — desk and phone are
  never both live approval surfaces for the same prompt. (Adds a sub-assumption to
  Gate A6.)
- **"running" staleness uses the transcript as cross-check.** Trust the last hook
  event edge; gate "running" on pane/proc liveness each refresh (already free);
  for a dropped terminal edge, demote running→ready only when a secondary signal
  confirms (a `tool_result` appeared in the transcript after the `PreToolUse`, or
  transcript mtime went quiet). No CPU sampling. `event-status` therefore reads
  the transcript too for the missed-edge backstop.
- **Answer / message = index-based `send-keys`, status-gated, stream-confirmed.**
  `AskUserQuestion` answers via `send-keys` arrow-to-index + Enter using the
  option index from Contract B (a hook-based answer is an *optimization* to
  confirm in A8, not the baseline; the bridge `/answer` takes an option index
  regardless). Free-text `/message` is enabled only when event-status is `ready` /
  waiting-for-input. Every send is confirmed via the event stream, never
  optimistically.

**Bridge / app / ops**
- **No monorepo for MVP.** Build the bridge as `src/bridge/server.ts` importing
  `src/core/*` directly (same shape as `monitor.ts`). Guard the core boundary with
  a lint rule / tiny test banning `blessed`/`ui` imports under `core/`. The
  `packages/*` workspace split is optional iteration #3.
- **Transport = SSE**, driven by a debounced watch of the events dir (no polling).
  WS only if a genuinely bidirectional feature (e.g. a terminal fallback) appears.
- **App stack = Preact + `@preact/signals` + `htm`, no build step**, served as
  ES modules.
- **Push = hosted ntfy, contentless.** The push carries only a non-sensitive label
  + a deep link (`sessionId` → app route); **never** the tool input, diff,
  command, or question text — the app fetches those from the bridge over
  Tailscale. Self-hosted ntfy only if a session label itself ever feels too
  revealing.
- **Auth = bind-to-tailnet (the real wall) + fail-closed + static bearer token.**
  The bridge refuses to start bound to a non-loopback/non-tailnet address; the
  token is constant-time compared, env-supplied, never logged. Assume
  `tailscale serve` HTTPS for the iOS secure-context requirement (confirm during
  the PWA-install iteration); plain HTTP over the tailnet is a nice-if-true
  simplification.

**Test scope (MVP)**
- **Keep Contracts A + B** (event-status truth table + scroll-up regression;
  transcript parsing) as the executable definition-of-done. **Cut Contract C**
  (characterizing the soon-to-be-demoted scraper — it never signals "done").
  **Defer Contract D** (live drift canary — a future regression alarm, not a
  completion gate).
- **Gate guard scoped to Gate A only** for MVP. Keep the `verification.json`
  structure intact so `enforce: true` can be flipped on B/C later without
  rebuilding anything.

## Conventions for agents iterating on these docs

- **Close open questions empirically.** Where a doc says a field name or hook
  behavior is "assumed/inferred," verify it against a live session on the Mac
  (or any machine with `claude`) before relying on it. The single most important
  shared task is *Schema Pinning* (see doc 01 §Fixtures and doc 02 §1b.0).
- **Keep `capture-pane` as fallback only.** No new feature should depend on
  parsing the rendered viewport as its source of truth.
- **Single user.** This is a personal tool. No multi-tenancy, no auth beyond a
  bearer token, no App Store. Prefer a web page / PWA over native unless a hard
  requirement forces otherwise.
- **No new runtime deps without justification.** Claude0's convention is "no
  external deps beyond blessed" and Bun built-ins. The bridge/app may add deps,
  but keep them minimal and document why.

## Glossary

- **Hook** — a Claude Code lifecycle callback (`SessionStart`, `PreToolUse`,
  `Notification`, `Stop`, …) that runs a script with a JSON payload on stdin.
- **Transcript** — the append-only JSONL conversation log at
  `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
- **Event-sourced status** — session status derived from the last hook event
  edge, not from the rendered screen.
- **Bridge** — the Bun HTTP/SSE server (on the Mac for the MVP, EC2 later) that
  the phone talks to.
- **Camp 1 / Camp 2** — the two wrapper architectures (see above).
