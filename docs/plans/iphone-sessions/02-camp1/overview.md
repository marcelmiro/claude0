# Impl #2 — Camp 1 Migration · Executable Plan

> **This is the executable plan-large suite for Implementation #2.** The narrative
> rationale lives in [`../02-camp1-hooks-jsonl.md`](../02-camp1-hooks-jsonl.md);
> this directory turns it into an ordered increment DAG with acceptance checks.
> Suite context: [`../00-overview.md`](../00-overview.md). Gate:
> [`../04-verification-gates.md`](../04-verification-gates.md) — **Gate A is 🟢**
> (A1–A10 verified & committed, including A6 approval, A7 latency, A8/A9 send-keys).

## Goal

Replace Claude0's **viewport-scraping** sensing/input layer with **hook events +
JSONL transcript**, keeping the substrate identical (real interactive `claude` in
tmux). Output is a Claude0 that (a) reports status correctly regardless of scroll
position, (b) reads conversation/pending prompts as structured data, and (c)
exposes a clean headless `core/` API that Impl #3's bridge will consume. Internal
to Claude0 — **no mobile app**. Stops at the dogfood gate (doc 00).

## Definition of done (measurable)

- The two RED contract tests flip green: `src/core/event-status.test.ts` (7
  tests) and `src/core/transcript.test.ts` (6 tests). `status.test.ts`
  (scraper-bug characterization) and the Gate-A guard stay green.
- `claude0 list` / TUI status is correct through a full tool-run **+ scroll-up** with
  no flip to `ready`.
- A tool approval can be granted from **outside** the TUI via the `approval.ts`
  IPC; the session proceeds; timeout falls through to the desk TUI; the attached
  desk path has **no added lag**.
- An `AskUserQuestion` is answered from structured options.
- `monitor.ts` status-right + ⚡/🔄 prefixes are event-sourced (correct on
  scroll-up). Sessions started before hook install still work via scraper.

## Increment DAG

```
Gate A 🟢 (A1–A10 verified & committed)
  │
  ├─ Inc1  event-status.ts (pure deriveStatus) ──┐
  ├─ Inc2  transcript.ts (parse + lastAssistant) ┼─► Inc4  wire event-status ──► Inc7  monitor + notif
  ├─ Inc3  hook event log: writer+setup+reader ──┘     into discovery (HEADLINE)     reconcile + rotation
  │        │
  │        ├─► Inc5  TUI: transcript preview + answer + send-message
  │        └─► Inc6  attach-aware blocking PreToolUse approval + approval.ts IPC
  │
  └─ DOGFOOD GATE = Inc4 + Inc5 + Inc6 + Inc7 all landed and boringly reliable
```

Edges: Inc4 needs Inc1+Inc2+Inc3. Inc5 needs Inc2+Inc3. Inc6 needs Inc3 (A6 🟢).
Inc7 needs Inc4. Inc1/Inc2/Inc3 are mutually independent (parallelizable).

## Why this order

- **Pure functions first (Inc1, Inc2).** They're tested entirely against
  committed fixtures — no live `claude` needed — and flip the contract tests that
  *define* the migration. Lowest-risk, immediately mergeable.
- **Event log (Inc3) before wiring (Inc4).** Discovery can't prefer event-status
  until real per-session logs exist. A7 proved the writer adds ~5ms — safe on the
  hook hot path.
- **Headline fix (Inc4) before everything downstream** so the scroll-up bug dies
  early and is dogfoodable. **Approval (Inc6) is standalone** because it carries
  the only remaining product risk surface even though A6 is already proven — it
  gets its own PR with a cheap pre-flight re-confirm.
- **Monitor reconcile (Inc7) last** so the *whole* attention path (status-right +
  window prefixes), not just the TUI list, is event-sourced before the dogfood gate.

## Files in this suite

- [`data-model.md`](./data-model.md) — on-disk file-state schema (event logs,
  pending/decision IPC, existing `hook-events` boundary), constraints, query
  patterns, migration, rollback.
- [`plan.md`](./plan.md) — the seven increments, one block each, with deps + done checks.
- [`contracts.md`](./contracts.md) — the headless `core/` API surface handed to Impl #3.
- [`decisions.md`](./decisions.md) — ADRs (additive event log, opt-in fallback,
  approval mechanism, deferred watch primitive) + sourced assumption log.
- [`verification.md`](./verification.md) — GIVEN/WHEN/THEN acceptance scenarios a human runs.
