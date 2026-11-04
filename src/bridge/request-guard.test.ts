import { expect, test } from "bun:test";
import { bindHostHeader, guardRequest, tailnetIdentity, type GuardContext, type GuardRequest, type GuardVerdict, type TailscaleStatus } from "./request-guard";

const CTX: GuardContext = { bindHost: "127.0.0.1:8473", tailnetName: "vm.example.ts.net", owner: "me@example.com" };
const TAILNET = { host: "vm.example.ts.net:8473", login: "me@example.com", proxied: true };
const req = (r: Partial<GuardRequest>): GuardRequest => ({ host: null, origin: null, secFetchSite: null, login: null, proxied: false, ...r });

test.each<[string, Partial<GuardRequest>, Partial<GuardContext>, GuardVerdict]>([
  // Host allowlist
  ["loopback tool (doctor, curl)", { host: "127.0.0.1:8473" }, {}, "ok"],
  ["tailnet, owner, same-origin fetch", { ...TAILNET, secFetchSite: "same-origin" }, {}, "ok"],
  ["tailnet name is case-insensitive", { ...TAILNET, host: "VM.Example.TS.net:8473" }, {}, "ok"],
  ["missing Host", {}, {}, "bad-host"],
  ["DNS rebinding: foreign Host on loopback", { host: "evil.example:8473", secFetchSite: "same-origin" }, {}, "bad-host"],
  ["rebinding with a forged identity header", { host: "evil.example:8473", login: "me@example.com" }, {}, "bad-host"],
  ["tailnet name with a trailing dot", { ...TAILNET, host: "vm.example.ts.net.:8473" }, {}, "bad-host"],
  ["a lookalike suffix", { ...TAILNET, host: "vm.example.ts.net.evil.example:8473" }, {}, "bad-host"],
  ["proxied request forging the loopback Host", { host: "127.0.0.1:8473", login: "someone@example.com", proxied: true }, {}, "bad-host"],
  ["proxied request forging the loopback Host, no identity", { host: "127.0.0.1:8473", proxied: true }, {}, "bad-host"],
  ["loopback on another port", { host: "127.0.0.1:8921" }, {}, "bad-host"],
  ["tailnet IP instead of the name", { ...TAILNET, host: "100.77.206.39:8473" }, {}, "bad-host"],
  ["tailnet name unknown yet: fail closed", TAILNET, { tailnetName: null }, "bad-host"],
  // Owner identity
  ["tailnet without identity (Funnel)", { host: TAILNET.host }, {}, "not-owner"],
  ["another tailnet user", { ...TAILNET, login: "someone@example.com" }, {}, "not-owner"],
  ["owner unknown yet: fail closed", TAILNET, { owner: null }, "not-owner"],
  // Cross-origin
  ["user-typed URL", { ...TAILNET, secFetchSite: "none" }, {}, "ok"],
  ["another site", { ...TAILNET, secFetchSite: "cross-site" }, {}, "cross-origin"],
  ["another port of this host (same-site)", { ...TAILNET, secFetchSite: "same-site" }, {}, "cross-origin"],
  ["Origin only, matching", { ...TAILNET, origin: "https://vm.example.ts.net:8473" }, {}, "ok"],
  ["Origin only, another port", { ...TAILNET, origin: "https://vm.example.ts.net:8931" }, {}, "cross-origin"],
  ["Origin only, another site", { ...TAILNET, origin: "https://evil.example" }, {}, "cross-origin"],
  ["opaque Origin", { ...TAILNET, origin: "null" }, {}, "cross-origin"],
  ["Sec-Fetch-Site wins over a matching Origin", { ...TAILNET, origin: "https://vm.example.ts.net:8473", secFetchSite: "cross-site" }, {}, "cross-origin"],
  ["loopback page on another port", { host: "127.0.0.1:8473", origin: "http://127.0.0.1:8921" }, {}, "cross-origin"],
  ["loopback page of the bridge itself", { host: "127.0.0.1:8473", origin: "http://127.0.0.1:8473" }, {}, "ok"],
])("%s", (_name, r, ctx, verdict) => {
  expect(guardRequest(req(r), { ...CTX, ...ctx })).toBe(verdict);
});

test("bindHostHeader brackets IPv6", () => {
  expect(bindHostHeader("127.0.0.2", 8481)).toBe("127.0.0.2:8481");
  expect(bindHostHeader("::1", 8473)).toBe("[::1]:8473");
});

const ME = 1, FRIEND = 2, TAGGED = 3;
const status = (self: { tags?: string[] }, peers: { user: number; tags?: string[] }[]): TailscaleStatus => ({
  Self: { DNSName: "vm.example.ts.net.", UserID: self.tags ? TAGGED : ME, Tags: self.tags ?? null },
  Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, { UserID: p.user, Tags: p.tags ?? null }])),
  User: { [ME]: { LoginName: "me@example.com" }, [FRIEND]: { LoginName: "friend@example.com" }, [TAGGED]: { LoginName: "vm.example.ts.net" } },
});
const TAG = ["tag:server"];

test.each<[string, TailscaleStatus, string | undefined, string | null]>([
  ["user-owned node: its user", status({}, [{ user: FRIEND }]), undefined, "me@example.com"],
  ["tagged node, one person among the peers: that person", status({ tags: TAG }, [{ user: ME }, { user: ME }]), undefined, "me@example.com"],
  ["tagged node: tagged peers don't count", status({ tags: TAG }, [{ user: ME }, { user: TAGGED, tags: TAG }]), undefined, "me@example.com"],
  ["tagged node, two people: ambiguous, fails closed", status({ tags: TAG }, [{ user: ME }, { user: FRIEND }]), undefined, null],
  ["tagged node, no people: fails closed", status({ tags: TAG }, [{ user: TAGGED, tags: TAG }]), undefined, null],
  ["override wins on a tagged node", status({ tags: TAG }, [{ user: ME }, { user: FRIEND }]), "friend@example.com", "friend@example.com"],
  ["override wins on a user-owned node", status({}, []), "friend@example.com", "friend@example.com"],
])("tailnetIdentity: %s", (_name, s, override, owner) => {
  const read = tailnetIdentity(s, override);
  expect(read.owner).toBe(owner);
  expect(read.name).toBe("vm.example.ts.net");
  expect(read.problem === null).toBe(owner !== null);
});

test("tailnetIdentity: no Self is a problem, not a guess", () => {
  expect(tailnetIdentity({}, undefined)).toEqual({ name: null, owner: null, problem: "no DNSName or owner login in tailscale status" });
});
