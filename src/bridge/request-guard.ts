/**
 * Who may call the bridge's data and action routes — the bridge has no token; this
 * check is its whole access control (ADR 33). Pure, so every edge case is a table test.
 *
 * - Host: the bridge's own bind address (loopback tools, the design loop) or the
 *   node's tailnet name. Anything else is a DNS-rebinding page, refused.
 * - A request Tailscale Serve proxied never counts as loopback: Serve forwards the
 *   client's Host verbatim, so `Host: 127.0.0.1:<port>` through it is a forgery.
 * - Tailnet requests must carry the node owner's `Tailscale-User-Login`. Tailscale
 *   Serve sets that header from the caller's identity and replaces a client-supplied
 *   copy; Funnel traffic and other tailnet users don't match.
 * - Browser requests must be same-origin (Sec-Fetch-Site, else Origin vs Host), so a
 *   page on another site — or another port of this host — can't drive the bridge.
 *   A request with neither header is not from a browser and passes.
 */

export interface GuardRequest {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  login: string | null;
  /** Arrived through a proxy (Serve sets X-Forwarded-Host/-For, overwriting a client's copy). */
  proxied: boolean;
}

export interface GuardContext {
  /** `host:port` exactly as a client addressing the bound socket sends it. */
  bindHost: string;
  /** The node's MagicDNS name, no trailing dot; null while unknown (fails closed). */
  tailnetName: string | null;
  /** The node owner's Tailscale login; null while unknown (fails closed). */
  owner: string | null;
}

export type GuardVerdict = "ok" | "bad-host" | "not-owner" | "cross-origin";

/** The Host header's hostname: `[::1]:8473` → `[::1]`, `vm.ts.net:8473` → `vm.ts.net`. */
function hostnameOf(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
}

export function guardRequest(req: GuardRequest, ctx: GuardContext): GuardVerdict {
  const host = (req.host ?? "").toLowerCase();
  if (!host) return "bad-host";
  if (req.proxied || host !== ctx.bindHost.toLowerCase()) {
    if (!ctx.tailnetName || hostnameOf(host) !== ctx.tailnetName.toLowerCase()) return "bad-host";
    if (!ctx.owner || req.login !== ctx.owner) return "not-owner";
  }

  if (req.secFetchSite !== null) {
    return req.secFetchSite === "same-origin" || req.secFetchSite === "none" ? "ok" : "cross-origin";
  }
  if (req.origin !== null) {
    try {
      return new URL(req.origin).host.toLowerCase() === host ? "ok" : "cross-origin";
    } catch {
      return "cross-origin"; // `null` (opaque origin) and garbage alike
    }
  }
  return "ok";
}

interface StatusNode { DNSName?: string; UserID?: number; Tags?: string[] | null }
export interface TailscaleStatus {
  Self?: StatusNode;
  Peer?: Record<string, StatusNode>;
  User?: Record<string, { LoginName?: string }>;
}

export interface TailnetIdentity { name: string | null; owner: string | null; problem: string | null }

/**
 * The node's MagicDNS name and owner login from `tailscale status --json`. `override`
 * (CLAUDE0_BRIDGE_OWNER) wins. A user-owned node's owner is its user. A tagged node has
 * no person behind it — its UserID is a stand-in whose login is the node's own name —
 * so the owner is the one person whose devices are its peers. Any device that can
 * connect is a peer (WireGuard needs its key; shared-in users' devices included), so a
 * second person makes the owner ambiguous and the node fails closed.
 */
export function tailnetIdentity(status: TailscaleStatus, override: string | undefined): TailnetIdentity {
  const name = status.Self?.DNSName?.replace(/\.$/, "") || null;
  const login = (id: number | undefined) => (id === undefined ? undefined : status.User?.[String(id)]?.LoginName);
  let owner: string | null = override || null;
  let problem: string | null = null;
  if (!owner && status.Self?.Tags?.length) {
    const people = new Set(Object.values(status.Peer ?? {}).filter((p) => !p.Tags?.length).map((p) => login(p.UserID)));
    if (people.size === 1) owner = [...people][0] ?? null;
    else problem = `tagged node with ${people.size} people among its peers: set CLAUDE0_BRIDGE_OWNER in bridge.env`;
  } else if (!owner) owner = login(status.Self?.UserID) ?? null;
  if (!problem && !(name && owner)) problem = "no DNSName or owner login in tailscale status";
  return { name, owner, problem };
}

/** `host:port` as a client sends it for a socket bound to `hostname` (IPv6 bracketed). */
export function bindHostHeader(hostname: string, port: number): string {
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}
