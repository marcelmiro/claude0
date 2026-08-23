# 14. Off-macOS presence is tmux client activity; the desk notification tier stays darwin-only

Date: 2026-08-09
Status: accepted; the "macOS keeps frontmost byte-for-byte" clause is superseded by ADR 19

## Context

Five sites answer "is the user at the terminal?" and act on it: the monitor's
active-pane attention/push suppression and takeover (`monitor.ts`), the question
hold's release check (`atMacFocus` in `core/tmux.ts`), the question intercept's
focus gate and the approval hook's desk-prompt gate (both generated bash in
`cli.ts`). On macOS they ask the OS — osascript/lsappinfo "is Ghostty frontmost" —
or use "a tmux client is attached" as a proxy. Each has a deliberate,
site-specific failure polarity (monitor: probe error ⇒ present; hold release:
error ⇒ absent; hook gates: error ⇒ present).

On a Linux host (Claude0 moved to an always-on VM, Mac and phone as thin clients)
both mechanisms break *silently*:

- There is no frontmost app. The osascript path's catch makes the monitor
  permanently believe the user is watching (kills ⚡ and phone pushes on the
  active pane); the hook's empty-`lsappinfo` case permanently disables the
  question intercept; `atMacFocus` never releases a hold early.
- "Client attached" inverts its meaning: a persistent Mosh/SSH attach is the VM's
  steady state even when the user is out with their phone, so the approval hook
  would *always* route to the (unwatched) desk prompt.

## Decision

Presence off-macOS = **an attached tmux client whose last keyboard input is
within 60 s** (`#{client_activity}`), lab-verified on tmux 3.4: pane output and
server-side `send-keys` do NOT refresh it; a real client keystroke does. The
tri-state core (`present`/`absent`/`unknown`) lives in `core/presence.ts`; each
call site maps `unknown` per its pre-existing polarity, and the bash gates inline
the same read (`uname`-branched) with the window interpolated from the same
constant. macOS keeps its frontmost probes byte-for-byte — behavior at the desk
is unchanged.

The macOS-native notification tier (terminal-notifier/osascript, tier 3) is
**not ported**: on the VM you are either tmux-attached (⚡ prefixes, status-right,
`claude0 next` cover the desk) or away (tier-4 web push covers the phone). The tier
is gated behind `process.platform === "darwin"` instead.

## Consequences

- Reading-without-typing counts as absent after 60 s: an occasional redundant
  phone push while sitting at an idle terminal. Accepted for v1.
- Attached-but-idle now routes approvals/questions to the phone hold on Linux —
  that is the feature, not a regression: the attach is permanent there.

## Rejected

- **Mac-side heartbeat agent** (launchd job posting "Ghostty frontmost" to a
  bridge endpoint): accurate looking-not-typing presence, but a new always-on
  Mac component. Becomes the fallback if client-activity semantics ever change,
  or a follow-up if redundant desk pushes annoy in practice.
- **Presence marker file**: nothing to go stale if presence is computed live
  from tmux on every read.
- **Porting tier 3 to a Linux notifier** (notify-send/ntfy): notifies the VM,
  not the human; the desk surfaces that matter are tmux-side already.
