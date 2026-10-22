# Portkey

Mechanism notes for the phone client (`src/bridge/public/`). Driving it in a real
browser: [portkey-design-loop.md](portkey-design-loop.md). Home is the inbox:
[inbox.md](inbox.md). The offline app shell: [ADR 21](adr/0021-offline-app-shell.md).

## Thread rendering

| Behavior | Where (`app.js`) |
|---|---|
| A run of 3+ tool-only records is one burst: expanded if it's work since the last prompt (`lastPromptAt`), else a one-line tally that expands on tap | `ToolBurst`, `isToolOnlyTurn` |
| One working indicator: the live tool chip while a tool runs, else the "working…" line with elapsed time | `ToolChip`, `Working` |
| Slash-command turns are a normal user bubble with the `/name` in mono; long-press is copy-only | `Turn` |
| An optimistic send bubble grows a "sending…" tag after ~5s | `SendingTag` |

## iOS status bar (installed PWA, iOS 27)

The fix is the `.status-bar-background` strip (`index.html`; its comment explains the
sampling rule) with `apple-mobile-web-app-status-bar-style=default`.
`--app-top-clearance` is just the safe-area inset. On the iPhone PWA (`.iphone-pwa`, set
before first paint) the first scroll region carries the clearance and fades its top 16px
once scrolled.

Verifying: changing the status-bar meta needs the app removed and re-added from Safari;
CSS changes need only a reachable reload. Browser layout checks can't reproduce the
effect — check on-device after a cold relaunch.

What was tried and doesn't work (2026-09-19 → 29; ten strategies compared on-device,
branch `prototype/ios-top-blur`): under `black-translucent` nothing removed the blur (about
90px) — opaque strips up to the safe-area height, scroll kicks at launch, a `theme-color`
nudge. An opaque 11px strip removes it but hides the top 11px of content; a fixed panel
slid across at launch works but the slide is visible; scrolling the document or inner list
at launch changes nothing. A fixed clearance allowance below the blur (24px, then 12px,
then 16px) was tuned on-device and then removed once the strip worked.
