/**
 * Who may call the bridge's data and action routes — the bridge has no token; this
 * check is its whole access control (ADR 33). Pure, so every edge case is a table test.
 *
 * - Host: the bridge's own bind address (loopback tools, the design loop) or the
 *   node's tailnet name. Anything else is a DNS-rebinding page, refused.
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
  if (host !== ctx.bindHost.toLowerCase()) {
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

/** `host:port` as a client sends it for a socket bound to `hostname` (IPv6 bracketed). */
export function bindHostHeader(hostname: string, port: number): string {
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}
