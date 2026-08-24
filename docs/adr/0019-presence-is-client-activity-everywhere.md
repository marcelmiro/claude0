# 19. Presence is tmux client activity on every platform

Date: 2026-08-19
Status: accepted (amends ADR 14's "macOS keeps frontmost byte-for-byte" clause)

## Context

ADR 14 unified presence off-macOS on tmux `#{client_activity}` but kept the macOS
frontmost-app probes untouched. Those probes hardcode one terminal — the string
`ghostty` / `com.mitchellh.ghostty` — in four places (monitor auto-clear, question
hold release, both generated hook gates, plus the notification click target). Any
macOS-hosted user on a different terminal gets *silently* broken presence: banners
while looking at the terminal, question intercepts firing at the desk, dead
notification clicks. On the current VM deployment the frontmost paths are dead code
anyway — the daemon, monitor and bridge all run on Linux.

## Decision

Client activity is the presence answer **everywhere**: an attached tmux client
whose last keyboard input is within `PRESENCE_WINDOW_MS` (60 s), tri-state
`present`/`absent`/`unknown` in `core/presence.ts`, each call site mapping
`unknown` per its pre-existing failure polarity (monitor: probe error ⇒ present;
hold release: error ⇒ keep holding; hook gates: error ⇒ native/desk; banner
suppression: error ⇒ full banner). The darwin frontmost branches are deleted, not
configured — a `terminal.appName` config key was rejected because it keeps a probe
that breaks silently whenever the configured name drifts from reality, and tmux
already knows the answer terminal-agnostically.

The one irreducible terminal reference — terminal-notifier's `-activate` click
target, which raises the terminal app when a notification is clicked — moves to
config: `notifications.terminalBundleId`, optional, defaulting to Ghostty's bundle
id at the point of use; empty string means "no `-activate`". Tier-3 native
notifications themselves stay darwin-only (unchanged from ADR 14).

## Consequences

- ADR 14's looking-without-typing tradeoff now applies at a local Mac desk too:
  reading an idle terminal for >60 s counts as absent — a full banner instead of
  sound-only, and (only while portkey is simultaneously foregrounded on the phone,
  i.e. a fresh `bridge-consumer` marker) an approval/question phone-hold instead of
  the instant desk prompt. The question hold self-heals on the user's next
  keystroke via the release check. Accepted deliberately over a per-terminal
  config key.
- `atMacFocus` is renamed `atDeskFocus` — the check is no longer Mac-specific.
- The generated hook gates lose their `uname` branch; `claude0 setup` must re-run
  for installed hooks to pick this up (HOOK_VERSION bump handles it).
- ADR 14's fallback remains available: a Mac-side heartbeat agent, if redundant
  desk pushes annoy in practice.

## Note (2026-08-24): banner tier on a split deployment

With the daemon on a Linux host, the tier-3 darwin banner cannot fire at all —
notifications reach the desk only via Web Push. A Mac desk client (presence
report + native banners driven from the host) is the planned replacement; until
it ships, "notifications stopped working since the migration" is this, not a bug.
