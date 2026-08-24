# 20. Config defaults live in code; setup materializes and back-fills the user's file

Date: 2026-08-19
Status: accepted

## Context

Defaults existed in two places: `config/default.json` (bundled, written verbatim as a
fresh `config.json`) and per-key constants at points of use (e.g. the notification
click target). Two copies of the same value drift. At the same time, the materialized
full config file is the discoverability surface — open it and every knob is visible —
which a sparse-overrides model would lose.

A survey of eight comparable tools (lazygit, gh, starship, alacritty, helix, bat,
zellij, k9s) found the dominant pattern is code defaults + optional sparse config;
none hard-error on a missing file. The two that write a full file (zellij, k9s) keep
full per-key code fallbacks underneath, so a stale or deleted file never breaks
anything. Alacritty retired full-template generation as "bad for migration".

## Decision

`DEFAULT_CONFIG` is a typed literal in `core/config.ts` — the single source for
fresh-config generation, per-key fallbacks, and back-fill. `config/default.json` is
deleted. `ensureUserConfig` (run by `claude0 setup`) writes the full defaults when no
config exists and otherwise **adds missing keys only** — a present value, explicit
`""` included, is never overwritten. `validateConfig` keeps new keys optional with a
point-of-use fallback into the same object, so a not-yet-merged file still loads
between an upgrade and the next `claude0 setup` (no crash window for the headless
daemon/bridge/monitor units).

## Consequences

- A changed default for an *existing* key does not propagate to already-written
  files — the explicit value pins it. Inherent to any materialized-file model.
- `config/config.schema.json` remains the one hand-maintained duplicate (key names +
  descriptions for editor hints via `$schema`).
- A deliberately deleted optional key (e.g. `$schema`) is re-added on the next setup.

## Rejected

- **Sparse config over code defaults** (the majority pattern): loses the
  open-the-file discoverability of a complete config; claude0's file is small enough
  that the stale-template downside barely applies.
- **Full file as the single source, required keys, error when absent**: every new key
  would hard-fail every process between deploy and setup — crash-looping systemd
  units on the VM host.
- **Generating the JSON schema from the TS type**: over-engineering at ~10 keys.

## Addendum (2026-08-24): what qualifies for config.json

User-taste knobs only — abbreviations, keys, repository roots, notification
preferences, snooze presets. Internal timings, TTLs, and detection heuristics
stay hardcoded: being tunable is not qualification. A full ranking of ~50
hardcoded values against this bar yielded no internal value worth exposing.
