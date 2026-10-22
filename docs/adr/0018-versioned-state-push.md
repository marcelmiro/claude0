# 18. The bridge pushes versioned state, not doorbells

Date: 2026-08-19
Status: accepted; amended 2026-10-03 (subscribe declares the held rev)

How the stream, subscriptions, the transcript payload and session opening work is in
[docs/sync.md](../sync.md).

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

## Decision

Keep SSE; change what rides it:

- **Every push carries data**, stamped `{seq, computedAt}`, and the client *applies*
  pushes, never merges heuristically. `sessions` events carry the full `/sessions`
  payload (on connect and on change), so a foregrounding phone paints the current world
  in one round-trip. `transcript` events serve one subscribed session per device as a
  wholesale `snapshot` or an `append` extension — which makes the rewind chimera
  structurally impossible.
- **A subscribing device declares the transcript rev it already holds**; if it is
  still current it gets only the non-turn fields, not a second copy of the thread.
  The SSE stream is never compressed, so on a long session the redundant snapshot
  (~1.4MB for 1,700 turns, against a ~400KB gzipped GET) competed with the GET for
  the link on every open and foreground.
- **Truthful snapshots, client-side optimism.** The server never stamps a state it
  hasn't observed. The phone's status overlays (send/approve/answer → `running`,
  interrupt → `ready`) retire on **confirmation or expiry, never contradiction**, so a
  snapshot computed before the action landed can't clobber the overlay backwards.
- **Staleness is surfaced, not hidden**: an old `computedAt`, or a cached thread not yet
  confirmed by a payload, shows "syncing".
- **Kept deliberately**: the GET endpoints (fallback and non-stream consumers), the iOS
  zombie-socket watchdog, the heartbeat + consumer-marker/goodbye contract (push
  suppression and the question hold depend on it), and the request-seq guards — pushes
  count as "newest", so a slow GET can never overwrite a push.

## Rejected

- **WebSockets.** Every wanted property ("no polling, real-time updates") is a
  *protocol* property, not a transport one; SSE already pushes in real time and only
  the data was missing. WS would add hand-rolled reconnect (EventSource reconnects
  itself), an unverified `tailscale serve` proxy path, a rebuilt iOS zombie-socket
  watchdog, and re-plumbing of the consumer-marker/goodbye contract, while fixing none
  of the symptoms.
- **Shipping full `tool_result` content, even capped.** Results are the bulk of a
  transcript; the phone's question is "did it work and what's the one line I need",
  which a summary answers.

## Consequences

- The doorbell is gone; every former call site triggers a recompute
  (`kickSessionsPush`), and only a changed payload reaches the wire.
- Rewind keeps its optimistic thread truncation (`rewindFloor`): Claude's rewind is
  in-memory until the next send, so no replacement push arrives at rewind time. The
  truncation is safe because every applied payload is a wholesale replacement.
- Fixtures mode pushes canned snapshots over the same stream, so the design loop and
  `bun run shoot` keep working.
