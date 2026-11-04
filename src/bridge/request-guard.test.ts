import { expect, test } from "bun:test";
import { bindHostHeader, guardRequest, type GuardContext, type GuardRequest, type GuardVerdict } from "./request-guard";

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
