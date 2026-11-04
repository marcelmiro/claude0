# 33. Bridge access is the tailnet owner's identity, not a token

Date: 2026-11-04
Status: accepted

## Context

The bridge's command-running routes (`/message`, `/shell`, `/decision`, …) were gated by
a static token: pasted into each install, exchanged at `POST /auth` for a host-scoped
`SameSite=Strict` cookie. Its real job was never "other tailnet devices" (the tailnet has
one user) but hostile pages in that user's browsers. It also left a bearer secret that
setup printed, devices pasted, and any process reading `bridge.env` could take. And
SameSite treats every port of the host as the same site, so a page served from another
tailnet port of the VM (any dev server) could drive the bridge with the cookie attached.

Tailscale Serve, which fronts the bridge, sets `Tailscale-User-Login` from the caller's
identity, replaces a client-supplied copy, preserves `Host`, and passes `Origin` and
`Sec-Fetch-Site` through unchanged (all verified on the VM, 2026-11-04).

## Decision

**No token. `request-guard.ts` admits a request to a data or action route only when:**

1. **Host** is the bridge's own bind address (loopback tools, doctor, the design loop),
   or the node's MagicDNS name. Any other Host — a DNS-rebinding page — is refused.
   A request that came through Serve (it adds `X-Forwarded-For`) never counts as
   the bind address: Serve forwards the client's Host verbatim.
2. **Tailnet requests carry the node owner's login.** The name and owner come from
   `tailscale status --json`; until they're known, tailnet requests are refused. A
   tagged node has no owning person (its user is a stand-in carrying the node's own
   name), so its owner is the one person whose devices are its peers — every device
   that can connect is a peer. Two or more people: refused until `CLAUDE0_BRIDGE_OWNER`
   names one. That variable, when set, always wins.
3. **Browser requests are same-origin**: `Sec-Fetch-Site` must be `same-origin` or
   `none`; without it, `Origin` must match `Host` exactly (port included). A request
   with neither is not from a browser and passes.

The static app shell stays public, as before.

## Consequences

- No login screen, no `claude0 bridge token`, nothing minted by setup; `bridge.env`
  only exists to carry a non-default port.
- Stricter than the cookie on one axis: other ports of the host can't drive the bridge.
- Turning on Funnel for the bridge's port, or sharing the node, doesn't expose it:
  Funnel traffic carries no identity and other users carry a different login.
- Same-user processes on the host can call the loopback address unauthenticated — no
  change in substance, since they could read the token file before.
- A bridge served over plain HTTP gets no `Sec-Fetch-Site` from browsers, so cross-site
  GETs fall back to the Origin check (absent on GETs). Setup serves HTTPS only; the
  plain-HTTP Mac walkthrough was removed with this change.
- Assumed, not yet seen on a tagged node of ours: the stand-in user and `Self.Tags`
  shape (taken from Tailscale's source and a third-party report), and that shared-in
  devices appear in `Peer` (Tailscale's `ShareeNode` doc says they do).
- Access depends on the Tailscale CLI answering `status --json`; if it can't, only
  loopback works and the phone sees "bridge refused this page".
