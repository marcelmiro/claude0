# 18. The bridge pushes versioned state, not doorbells

Date: 2026-08-19

## Status

Accepted

## Context

The SSE stream carried exactly one event — `{"type":"session-changed"}` with no
data. Every event made the phone refetch `/sessions` and (if a session was open)
`/transcript`, and those refetches raced the client's own optimistic patches.
Five persistent symptoms traced to that shape:

- **Flicker/clobber**: optimistic bubbles, approval cards and status flips were
  reconciled by heuristics (`VOLATILE_FIELDS` merge, `rewindFloor` rev checks,
  the `interruptedId` suppression hack) against refetches that could resolve out
  of order or carry pre-action state.
- **Rewind chimera**: the `?rev=` conditional fetch merged volatile fields over
  held turns; around a branch flip that merge could present a thread that never
  existed, and the post-rewind status/composer lagged.
- **Wake-up staleness**: foregrounding fired three racing refetches
  (list/transcript/subagent) with no retry — on a flaky link a silently-failed
  transcript fetch left the thread ending at the user's own message even though
  the turn-complete push notification had already arrived.
- **⚡ lag**: the bridge polled `state.json` every 3s on top of the monitor's own
  ~3s write cadence.
- **Send-echo lag**: nothing told the user the turn was starting until a full
  discovery recompute landed.

WebSockets were considered and rejected: every wanted property ("no polling,
receive updates in real time") is a *protocol* property, not a transport one.
SSE already pushes in real time; what was missing was data in the events. WS
would add hand-rolled reconnect (EventSource reconnects itself), an unverified
`tailscale serve` proxy path, a rebuilt iOS zombie-socket watchdog, and
re-plumbing of the consumer-marker/goodbye contract — while fixing none of the
symptoms above.

## Decision

Keep SSE; change what rides it (`src/bridge/stream.ts`, `src/shared/sync.js`):

- **Every push carries data**, stamped `{seq, computedAt}`. `seq` is one
  per-connection monotonic counter shared across event types (frames are
  serialized per connection; it resets on reconnect).
- **`sessions` events** carry the full `/sessions` payload, pushed on connect
  and whenever a recompute differs from the last pushed JSON (dedupe in
  `pushSessions`). Connect ⇒ snapshot: a foregrounding phone paints the current
  world in one round-trip, replacing the three racing refetches — `resync()` is
  now just "rebuild the stream".
- **`transcript` events** serve a per-device subscription (`POST /stream/open`,
  one session per device): `kind:"snapshot"` replaces wholesale (on subscribe
  and on any non-extension change — rewind, branch flip, compaction);
  `kind:"append"` extends from `fromIndex` (the previously-pushed turn list is a
  prefix, the last turn allowed to have grown — streamed assistant text). The
  non-turn fields ride every event; an omitted field means cleared, as explicit
  protocol. The client never merges heuristically — it applies
  (`applyTranscriptEvent`), which makes the rewind chimera structurally
  impossible. A per-subscription `fs.watch` on the transcript JSONL (parent dir,
  basename-filtered; ~1 watcher per device) makes mid-turn appends push live,
  debounced 500ms.
- **Truthful snapshots, client-side optimism.** The server never stamps a state
  it hasn't observed. The phone applies status overlays at payload-apply time
  (send/approve/answer → `running`, interrupt → `ready`) that retire on
  **confirmation or expiry, never contradiction** (`overlayResolved`) — a
  snapshot computed before the action landed can't clobber the overlay
  backwards. This replaced the `interruptedId` mutation hack.
- **`state.json` is watched**, not polled (bridge-side), removing up to 3s from
  the ⚡ chain; the 3s poll remains only as fallback when the watch can't be
  established.
- **Staleness is surfaced, not hidden**: a pushed payload whose `computedAt` was
  already old shows a non-blocking "syncing" band.

Kept deliberately: the GET endpoints (fallback + non-stream consumers, with the
bounded-staleness contract), the 40s iOS zombie-socket watchdog, the 15s
heartbeat + consumer-marker/goodbye contract (push suppression and the question
hold depend on it), the conditional safety polls (2.5s in-flight-send, 15s
background work), and the request-seq guards — pushes participate in them as
"newest", so a slow GET can never overwrite a push.

## Consequences

- The doorbell (`broadcast`) is gone; every former call site funnels through
  `kickSessionsPush`, which recomputes and pushes only on change.
- Fixtures mode pushes canned snapshots over the same stream (a real recompute
  is suppressed), so the design loop and `bun run shoot` keep working.
- Rewind keeps its optimistic thread truncation (`rewindFloor`): Claude's rewind
  is in-memory until the next send, so no `replace` push arrives at rewind time
  — an honest "no truncation" display would show the un-rewound thread. The
  truncation is now safe because every applied payload is a wholesale
  replacement.
- A subscription is dropped on goodbye/unsubscribe/60s-disconnected; the client
  re-declares it on every stream open, so a pruned subscription self-heals.

## Addendum: the thread payload carries time and outcomes (2026-08-25)

Three additive fields on the transcript payload, all optional, none a
migration (a client that ignores them renders exactly as before):

- **`turn.at`** — the JSONL record's `timestamp`, verbatim. The phone renders
  a centered time label before the first stamped turn and wherever the
  thread pauses for more than five minutes (24h clock, `dd/MM` beyond
  yesterday — hard-coded like `wake-abs.js`, never Intl), and an elapsed
  timer on the in-flight tool's chip measured from its own record.
- **`tool_use.result`** — `{ ok, head, lines }` summarized from the matching
  `tool_result` (paired by `tool_use_id` across turns — Claude records
  results as the *next* user turn) before that block is dropped. `head` is
  the first non-empty line capped at 120 chars; `lines` counts non-empty
  lines. Success is the norm and unmarked; a chip whose `ok` is false ends
  in a light "failed", and the head shows when tapped open. A
  tool_use with no result yet ships none — that absence, plus
  `pendingTool.toolUseId`, is what marks the live chip.
- **`tool_use.input`** now ships every present string field from a fixed
  allowlist (`command, file_path, notebook_path, pattern, description,
  subagent_type, url, query, skill, args`), each capped at 200 chars except
  paths, instead of the first present one. Agent chips finally say what the
  agent was asked (`description` is also the key that links the chip to its
  `subagents[]` entry for the drill-in tap); WebFetch/WebSearch/Skill chips
  get their url/query/skill.

Rejected: shipping the full `tool_result` behind a cap. Even capped, results
are the bulk of a transcript, and the phone's question is "did it work and
what's the one line I need", which the summary answers.

## Addendum (2026-08-31): tail-first initial paint

First open of an uncached long session waited on the full active branch (hundreds
of KB + a large DOM render) before showing anything. The client now races a
`GET /sessions/:id/transcript?tail=40` ahead of the full fetch: the server slices
the composed payload to the last 40 turns, marks it `partial: true`, and strips
`rev` — a partial copy can never satisfy the `?rev=` unchanged short-circuit or
enter the client transcript cache. The push protocol is unchanged: the
subscribe-time forced snapshot (or the fallback full GET, whichever lands first
by seq) replaces the slice wholesale and completes the conversation. While
partial, the client shows a "loading earlier messages" row, offers no rewind
(its floor is an absolute turn index, wrong once the full branch lands), and on
the partial→full swap offsets the scroll position by the height delta when the
user has scrolled off the bottom. JSON responses are also gzipped now (bridge
fetch handler) — the tail slice cuts first-paint transfer and render on top of
that.

## Addendum (2026-08-31): answered questions ride as Q&A pairs

An answered `AskUserQuestion` used to reach the phone as an opaque chip — the
thread lost both what was asked and what the user chose. The slimming now
parses the tool_result's `Your questions have been answered: "Q"="A", …` text
into `qa: [{ q, a }]` on the tool_use block (questions capped like other args),
and lifts the first question into `input.description` so even the fallback
chip says what was asked. The client renders `qa` as the exchange it was — a
muted question line plus a compact user-tinted answer bubble per pair — and
excludes qa turns from burst tallies (an answer is conversation, not
plumbing). Declined, interrupted, or unparseable results carry no `qa` and
fall back to the chip with the result summary.

## Addendum (2026-08-31): chip paths render session-relative

The transcript payload now carries `cwd` (the newest record's `cwd`,
piggybacked on the cached branch read). Chips strip that prefix for display —
an absolute worktree path (`…/.claude/worktrees/tf-192/src/x.ts`) is all
prefix noise on a phone — falling back to `~`-shortening outside the cwd.
Display-only: `input.file_path` stays absolute, since it is the tap target
the client sends back to `/diff`.
