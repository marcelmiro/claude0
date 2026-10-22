# Portkey

Mechanism notes for the phone client (`src/bridge/public/`). Driving it in a real
browser: [portkey-design-loop.md](portkey-design-loop.md). Home is the inbox:
[inbox.md](inbox.md). The offline app shell: [ADR 21](adr/0021-offline-app-shell.md).

## Thread rendering

- **Bursts.** A run of three or more consecutive tool-only assistant records is one burst:
  expanded (every chip) when it is work since the user's last prompt (`lastPromptAt`),
  collapsed to a one-line tally ("▸ 33 tool calls · 1 failed · Bash ×20, Edit ×9, …") when
  it predates it. Tapping the tally expands it in place.
- **One working indicator.** The in-flight tool is its own chip rendered live (pulsing dot,
  elapsed since its record landed), so it becomes the finished chip without moving. While a
  tool runs, that chip *is* the working indicator; the "working…" line covers only the
  thinking/writing stretches between calls, with elapsed time from `lastPromptAt`.
- **Slash-command turns** render as a normal user bubble with the `/name` as inline mono
  text, with or without args. Long-press is copy-only.
- An optimistic send bubble that lingers past ~5s grows a "sending…" tag; on the happy path
  it retires into the real turn before the tag appears.

## iOS status bar (installed PWA, iOS 27)

iOS 27 blurs the top edge of an installed web app unless WebKit can sample a background
colour from a fixed, full-width element touching the top edge, and it ignores elements 4px
tall or shorter.

- `apple-mobile-web-app-status-bar-style=default`, and a real, fixed, non-interactive
  `.status-bar-background` strip outside Preact's root (so it survives mounting): 11px
  tall, `--bg` with `background-clip: text` and no text, so it paints nothing and content
  stays sharp up to the edge.
- `--app-top-clearance` is just the safe-area inset. The shell is `100dvh`. On the iPhone
  PWA (`.iphone-pwa`, set before first paint) the shell has no top padding; the first
  scroll region's initial padding carries the clearance and scrolls away with the content.
  Fixed top toolbars and overlays keep the clearance.
- With `default`, iOS paints the status-bar area down to the web view's top edge, so rows
  scrolling up are cut in a hard line: scroll regions fade their top 16px once scrolled (a
  mask toggled by a `scrolled` class); content at rest is not faded.
- Changing the status-bar meta needs the app removed and re-added from Safari; CSS changes
  only need a reachable reload. Browser layout checks can't reproduce the effect — verify
  on-device after a cold relaunch.

What was tried and doesn't work (2026-09-19 → 29; ten strategies compared on-device,
branch `prototype/ios-top-blur`): under `black-translucent` nothing removed the blur (about
90px) — opaque strips up to the safe-area height, scroll kicks at launch, a `theme-color`
nudge. An opaque 11px strip removes it but hides the top 11px of content; a fixed panel
slid across at launch works but the slide is visible; scrolling the document or inner list
at launch changes nothing. A fixed clearance allowance below the blur (24px, then 12px,
then 16px) was tuned on-device and then removed once the strip worked.
