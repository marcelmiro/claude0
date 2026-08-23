# Implementation 3 — Mobile App MVP (bridge + web page)

> **Status:** DRAFT — for agent iteration.
> **Depends on:** Implementation 2 complete **and the dogfood checkpoint passed**
> (see [`00-overview.md`](./00-overview.md) §Resolved decisions).
> **Unblocks:** the actual goal — using sessions from the iPhone.
>
> **⛔ Gate:** Do not write code until **Gate C** in
> [`04-verification-gates.md`](./04-verification-gates.md) is 🟢. For the MVP only
> the C items **C2** (phone reaches the bridge over Tailscale) and **C4** (SSE from
> iOS Safari) are load-bearing.
>
> **Optional work past the MVP** (push, PWA install, monorepo split, EC2) lives in
> [`05-optional-iterations.md`](./05-optional-iterations.md) — keep it out of this
> doc.

## Goal

Expose Implementation 2's headless `core/` over a thin HTTP/SSE **bridge** and
drive it from a **mobile web page** on the iPhone over Tailscale. Deliver the five
interactions against real sessions running on the Mac:

1. see live session status,
2. read the latest output / pending question,
3. approve a tool prompt,
4. answer an `AskUserQuestion`,
5. send a free-text message.

This is **mostly additive**: the hard problems (status, transcript, approval) were
solved in Implementation 2; here we add transport + presentation, **no new
Claude-wrapping logic**.

## Scope (decided — doc 00)

- **MVP = a manual-open mobile-Safari web page + `src/bridge` over Tailscale.** No
  PWA install, no push, no monorepo, no EC2 — all of those are
  [`05-optional-iterations.md`](./05-optional-iterations.md).
- **No monorepo.** The bridge is `src/bridge/server.ts` importing `src/core/*`
  directly — the same shape as `monitor.ts`, which already consumes `core/` with no
  blessed dependency. Guard the core boundary with a lint rule / tiny test banning
  `blessed`/`ui` imports under `core/` so the eventual split stays trivial.
- **Mac-first substrate.** Sessions and the bridge run on the Mac (kept awake),
  reached over Tailscale. Keep Darwin-only calls out of `core/`/`bridge/` so the
  later EC2 move is a config change.

## Bridge server (`src/bridge/`)

Thin Bun (`Bun.serve`) server importing `src/core/*`. Adds **no** Claude-wrapping
logic. Runs on the Mac alongside the sessions.

**Endpoints:**

| Method | Path | Backed by `core/` | MVP? |
|--------|------|-------------------|------|
| `GET` | `/sessions` | `discoverSessions()` (event-sourced status) | ✅ |
| `GET` | `/sessions/:id/transcript` | `getTranscript(id)` | ✅ |
| `GET` | `/pending` | `listPendingApprovals()` | ✅ |
| `POST` | `/sessions/:id/decision` | `decideApproval(id, allow\|deny)` | ✅ |
| `POST` | `/sessions/:id/message` | `sendMessage(id, text)` | ✅ |
| `POST` | `/sessions/:id/answer` | answer an `AskUserQuestion` by option index | ✅ |
| `GET` | `/stream` (SSE) | watch events dir → push updates | ✅ |
| `GET` | `/sessions/:id/thumbnail` | `capturePane(paneId)` (fallback display) | optional |
| `POST` | `/sessions/:id/kill`, `/rename` | reuse `tmux.ts` | optional |

**Cross-cutting (decided — doc 00):**

- **Transport: SSE** (not WS), driven by a **debounced watch of the events dir**
  (no polling). The live channel is strictly server→client; all actions are plain
  `POST`. SSE's built-in auto-reconnect matters for a phone that sleeps/wakes/roams
  on Tailscale. (`Bun.serve` does SSE with a `ReadableStream`; no dep.) Add a WS
  endpoint only if a genuinely bidirectional feature appears later.
- **Input contract (from Impl #2):** `/answer` takes an **option index** (resolved
  to `send-keys` arrow-to-index + Enter under the hood); `/message` is accepted
  only when event-status is `ready` / waiting-for-input; every send is confirmed
  via the `/stream` event, never optimistically.
- **Auth:** bind-to-tailnet is the real wall; a static bearer token (env var) is
  defense-in-depth — **constant-time** compared, never logged. The bridge
  **fails closed**: it refuses to start if asked to bind to a non-loopback /
  non-tailnet address, so a future copy-paste can't expose RCE publicly.
- **Security:** `/decision`, `/message`, `/answer` are remote-code-execution by
  design. Bind to the Tailscale interface only; never expose publicly.
- **iOS secure-context:** plain HTTP over the tailnet is fine for a non-installed
  web page (this MVP). The secure-context / `tailscale serve` HTTPS question only
  bites once a service worker is added — resolved in
  [`05-optional-iterations.md`](./05-optional-iterations.md) iteration 2.

## Mobile app (web page)

**MVP = a plain mobile-Safari web page**, manual-open over Tailscale (no service
worker). The *interactions* are identical installed or not, so opening in Safari
fully validates "remote control with great UX" without the ntfy/APNs/SW surface.
Native iOS is out of scope unless a hard requirement (e.g. a true interactive
terminal fallback) forces it.

**Stack (decided — doc 00): Preact + `@preact/signals` + `htm`, no build step**,
served as ES modules. Signals map 1:1 onto SSE pushes (an SSE message updates a
signal → the list/detail re-render), which is the whole interaction model; `htm`
avoids a JSX compiler so there's no toolchain. ~5KB, consistent with Claude0's
low-dependency ethos. Inline assets; mobile-first CSS.

**Screens:**

1. **Session list** — status dots (event-sourced), repo grouping (reuse grouping
   logic from `core/`), ⚡ attention first. Live via `/stream`.
2. **Session detail** — structured transcript (last N turns), live updates.
3. **Approval card** — for a pending tool: show `tool` + `input` (the diff /
   command), Allow / Deny → `POST /decision`.
4. **Question card** — `AskUserQuestion` options as buttons → `POST /answer`.
5. **Message box** — free text → `POST /message`, enabled only when at the prompt.

**Offline/connectivity:** assume Tailscale is up; degrade gracefully when the
bridge is unreachable (show last-known state, queue nothing dangerous).

## Deployment (Mac)

- The Mac, kept awake (`caffeinate` / never-sleep), running tmux + zsh + `claude`
  + Claude0 + the `src/bridge` server (e.g. a tmux window or a `launchd` agent).
- Tailscale on Mac and iPhone; bridge bound to the tailnet address (fail-closed).
- `claude0 setup` (extended in Impl #2) installs the hooks.

## Acceptance criteria (MVP)

- From the iPhone web page over Tailscale: see the live session list + statuses,
  read a session's conversation, approve a tool prompt, answer a question, and send
  a message — all against a real session running on the Mac.
- Status shown on the phone matches reality through a full tool-run + scroll-up
  cycle (inherited from Impl #2; no flicker to "ready").
- The bridge refuses to start bound to a non-tailnet address (fail-closed verified).

## Open questions

- [ ] Do we want a read-only "big terminal" fallback (ttyd) for the rare case the
      button UI can't express something? Defer unless needed.

## What's next

Optional iterations — push, PWA install, monorepo split, EC2 — are specified in
[`05-optional-iterations.md`](./05-optional-iterations.md), in recommended order.
