# Sync (bridge ⇄ portkey)

How portkey stays current and where each part lives: the SSE protocol, per-device
transcript subscriptions, opening a session, and the fallbacks. The behavior below is the
spec; the named docblocks carry the implementation detail. Decision:
[ADR 18](adr/0018-versioned-state-push.md). Code: `bridge/stream.ts` (protocol,
subscriptions), `bridge/server.ts` (payload composition, watchers, consumer markers),
`shared/sync.js`, `bridge/public/app.js`.

## Push paths

- **Sessions.** Every `/sessions` recompute ends in `startSessionsRefresh` →
  `stream.pushSessions`, which dedupes against the last pushed JSON. State changes trigger
  recomputes via `kickSessionsPush`. The on-connect snapshot goes, undeduped, to the new
  connection only.
- **Transcript.** No transcript is pushed on connect: the client re-declares its
  subscription on every stream open, carrying the rev it holds, and that request decides
  between a snapshot and a zero-turn append. Mid-turn appends come from the JSONL watcher
  via `scheduleTranscriptPush`.

| Concern | Where |
|---|---|
| Event vocabulary, `seq`/`computedAt` envelope, snapshot vs append | `bridge/stream.ts` header, `deltaTurns` |
| Held rev → zero-turn append instead of a snapshot | `Sub` type and `pushTranscript` (`bridge/stream.ts`) |
| Live appends (watch the JSONL's parent dir, debounced 500ms) | `watchSubscription`, `scheduleTranscriptPush` (`bridge/server.ts`) |
| ⚡ changes (watch the config dir for `state.json`, 3s poll fallback) | the unread sync block in `bridge/server.ts` |
| Subscription pruned after 60s disconnected; client re-declares on every open | `staleSubscriptions` (`bridge/stream.ts`) |
| JSON gzip (needs `accept-encoding: gzip`, body ≥ `GZIP_MIN_BYTES`; SSE never compressed) | `gzipJson` (`bridge/server.ts`) |

## Client

| Concern | Where |
|---|---|
| Optimistic status overlays retire on confirmation or expiry, never contradiction | `overlayResolved` (`shared/sync.js`) |
| Tail-first paint (`?tail=40`, `partial`, no `rev`) | `applyTail` (`bridge/server.ts`), `fetchTailPaint` (`app.js`) |
| Stream liveness (`streamLive`: OPEN + heard within 20s) and the zombie-socket watchdog | `app.js`, comments above `streamLive` and the watchdog interval |

Order when opening a session: the tail GET races ahead for an uncached session; the full
GET brings the thread current (`?rev=` short-circuits to `unchanged`); then the client
subscribes declaring the rev it now holds. Opens and every stream (re)open go through
one serialized subscription chain, and a step superseded by a later open or back is
skipped.

What the user sees:

- **"syncing"**: a pushed payload whose `computedAt` was already old shows a band; the
  thread header shows "syncing…" from open (or foreground) until a payload for that
  session applies. A tail slice counts as current.
- **While partial**: a "loading earlier messages" row, no rewind (its floor is an
  absolute turn index), and on the partial→full swap the scroll position keeps its place
  when the user has scrolled off the bottom.
- **Rewind** truncates optimistically (`rewindFloor`) until an applied payload's `rev`
  differs from the one it was set against; it is cleared on opening another session.
- **Sends**: while the stream is live, a send skips its post-POST transcript GET, and the
  2.5s send/queue poll runs only if no transcript push arrived for 10s.

## Transcript payload

What a turn keeps is `slimTurns` / `slimToolUse` (`core/session-api.ts`). Fields read
across server and client:

| Field | Meaning | Where |
|---|---|---|
| `turn.at` | JSONL record timestamp, verbatim: time-gap labels (first stamped turn, then any pause > 5 min) and the live chip's elapsed timer | `app.js` thread render (`GAP_MS`) |
| `tool_use.result` | `{ ok, head, lines }` summary of the matching `tool_result`; absent on the live chip | `slimTurns` docblock |
| `tool_use.input` | `TOOL_ARG_FIELDS`, capped at `TOOL_ARG_CAP` except `UNCAPPED_FIELDS` (`file_path`, `notebook_path`), which the chip shows as display paths | `core/session-api.ts` |
| `tool_use.qa` | answered `AskUserQuestion` as `[{ q, a }]`; rendered as an exchange, excluded from burst tallies | `parseQuestionAnswers` |
| `cwd` | newest record's cwd; chips show paths relative to it, else `/Users/<name>/` → `~/` | `relPath` (`app.js`) |
