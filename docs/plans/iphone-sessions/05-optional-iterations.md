# Optional Iterations — after the Mobile App MVP

> **Status:** DRAFT — for agent iteration.
> **Depends on:** the Mobile App MVP ([`03-monorepo-mobile-app.md`](./03-monorepo-mobile-app.md)) shipped and used.
> **Purpose:** collect the work deliberately pushed *past* the MVP so doc 03 stays
> a clean MVP build sheet. None of these are required to validate "remote control
> of Claude Code with great UX"; each is a self-contained add-on.

These are the optional iterations resolved in
[`00-overview.md`](./00-overview.md) §Resolved decisions, **in recommended order**.
Do them one at a time, only once the MVP (and any earlier iteration they build on)
is solid.

| # | Iteration | Why this slot | Builds on |
|---|-----------|---------------|-----------|
| 1 | Push (ntfy, contentless) | Delivers the actual remote-control value ("I'm at the gym"); changes *when* you open the app, not whether the loop works | MVP web page + bridge |
| 2 | PWA install | Convenience/polish; resolves the iOS secure-context question in isolation | Iteration 1 (deep links) |
| 3 | Monorepo split | Codebase cleanliness; behavior-neutral | MVP code structure |
| 4 | EC2 | When "Mac must be awake" stops being enough | All of the above |

> Session-launch-from-phone and a read-only "big terminal" (ttyd/wetty) fallback
> remain **out of scope** until after all four of these, and only if a real need
> appears.

---

## Iteration 1 — Push notifications (ntfy, contentless)

**The "I'm at the gym" feature.** Doesn't need PWA install — the ntfy iOS app
delivers the alert and the deep link opens Safari.

- **Trigger:** the `Notification` hook + `core/notifications.ts` transition
  detection (running→waiting = "blocked", running→ready = "turn complete").
- **Transport:** hosted **ntfy.sh** — HTTP POST to a topic; the ntfy iOS app
  subscribes. No APNs, no Apple Developer account, no App Store.
- **Contentless payload (decided — doc 00):** carry only a non-sensitive label +
  a deep link (`sessionId` → app route) — e.g. *"`claude0/fix-auth` needs
  permission"* / *"`api` has a question"* / *"… turn complete"*. **Never** include
  the tool input, diff, command, or question text; the app fetches those from the
  bridge **over Tailscale** when you tap. The push traverses ntfy.sh + Apple APNs
  (third parties), so no private dev content may cross it.
- **Self-host ntfy** only if a session *label* itself ever feels too revealing.

**Acceptance:** a session blocking on permission pushes an ntfy notification that
deep-links to the approval card; the notification body contains no tool/diff/
question text. (Gate C3.)

---

## Iteration 2 — PWA install (service worker, add-to-home-screen)

Turn the MVP web page into an installable PWA.

- Add a web app manifest + a single service worker for installability.
- **iOS secure-context:** a service worker requires a secure context. Plain HTTP
  over the tailnet may not qualify in Safari → plan for **`tailscale serve`
  HTTPS**. Confirm the exact behavior here (this is the iteration that resolves the
  open secure-context question).
- Keep it offline-tolerant: show last-known state when the bridge is unreachable;
  queue nothing dangerous.

**Acceptance:** add-to-home-screen installs; relaunch works; SSE/WS still streams
from the installed PWA over Tailscale. (Gate C4 for the installed context, C5.)

---

## Iteration 3 — Monorepo split (Bun workspaces)

Behavior-neutral restructure for codebase cleanliness, once a clean package
boundary earns its keep. **No behavior change** — reviewable purely as a move.

### Layout (proposed — Bun workspaces)

```
claude0/                          # repo root
  package.json                # { "workspaces": ["packages/*", "apps/*"] }
  packages/
    core/                     # extracted from src/core/* — headless, no blessed
      package.json            # name: @claude0/core
    cli/                      # the existing TUI + subcommands
      package.json            # name: @claude0/cli, bin: claude0  → depends on @claude0/core
    bridge/                   # moved from src/bridge/
      package.json            # name: @claude0/bridge  → depends on @claude0/core
  apps/
    mobile/                   # moved from the MVP web-page assets
      package.json            # name: @claude0/mobile
```

### Migration steps (keep it non-breaking)

1. Introduce Bun workspaces at the root; create `packages/core` and move
   `src/core/*` into it as `@claude0/core`. Update imports (`../core/x` → `@claude0/core`).
2. Move the TUI (`src/index.ts`, `src/cli.ts`, `src/monitor.ts`, `src/ui/*`,
   `bin/claude0.ts`) into `packages/cli`; move `src/bridge/*` into `packages/bridge`;
   move the mobile assets into `apps/mobile`. All depend on `@claude0/core`.
3. Verify `bun run start`, `bun run status`, all subcommands, the bridge, and the
   test suite still pass unchanged — this ships with **zero behavior change**.

> Default to plain Bun workspaces (low-dep ethos); don't add Turborepo/nx unless a
> concrete need appears.

**Acceptance:** all existing Claude0 commands, the bridge, and tests pass unchanged
after the split. (Gate C1.)

---

## Iteration 4 — EC2

When "the Mac must be awake and on a network" stops being good enough, move the
substrate to an always-on Linux EC2 instance running the same stack.

- Always-on EC2 instance running tmux + zsh + `claude` + Claude0 + the bridge (under a
  process manager / systemd service / tmux window).
- Tailscale on EC2 and iPhone; bridge bound to the tailnet address (fail-closed).
- `claude0 setup` installs the hooks on this box.
- **macOS → Linux port surface:** the port stays a config change *only if* Darwin-
  only calls (`pbcopy`, `caffeinate`, Ghostty, `ps`/TTY quirks) were kept out of
  `core/`/`bridge/` from day one (doc 00). Audit for any that crept in.
- Note the model shift: EC2 sessions are a *separate pool* from the Mac's, not a
  mirror — accept the two-environments cost consciously.
- Document the bring-up runbook: instance, Tailscale join, **headless `claude`
  auth**, hook install, bridge service, ntfy topic.

**Acceptance:** the full MVP + iterations 1–2 work against real sessions running on
EC2, reached from the iPhone over Tailscale.
