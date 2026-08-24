/**
 * Host-provisioning planner: pure verdicts + exact commands from a probed
 * system state (no root/systemd needed), the thin executor's set -e semantics,
 * the bridge-token action, and the guided-stop checklist. probeSystemState is
 * deliberately untested — it is read-only glue over probe()/existsSync.
 */

import "../../test/helpers/home";
import { TEST_HOME } from "../../test/helpers/home";
import { test, expect } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import {
  HOST_PACKAGES,
  PRODUCT_UNITS,
  SYSCTL_FILE,
  planProvision,
  executeProvision,
  guidedStops,
  generateBridgeToken,
  ensureBridgeEnv,
  renderDryRun,
} from "./provision";
import type { Command, ProvisionContext, ProvisionStep, SystemState } from "./provision";

const ctx: ProvisionContext = {
  home: TEST_HOME,
  unitsDir: `${import.meta.dir}/../../config/units`,
  user: "marcel",
  tz: "Europe/London",
  swapGb: 16,
  bridgePort: "8473",
};

/** A fully provisioned, fully authed host — every step reads done. */
function satisfied(overrides: Partial<SystemState> = {}): SystemState {
  return {
    systemd: true,
    missingPackages: [],
    zshPath: "/usr/bin/zsh",
    loginShell: "/usr/bin/zsh",
    sysctlFilePresent: true,
    swapActive: true,
    fstabHasSwap: true,
    timezone: "Europe/London",
    journaldCapPresent: true,
    needrestartDirPresent: true,
    needrestartConfPresent: true,
    apparmorDirPresent: true,
    apparmorProfilePresent: true,
    apparmorParserPresent: true,
    lingerEnabled: true,
    staleUnits: [],
    bridgeEnvPresent: true,
    bridgeEnvHasPort: false,
    bunPresent: true,
    claudePresent: true,
    tailscalePresent: true,
    tailscaleUp: true,
    tailscaleServing: true,
    claudeAuthed: true,
    ghAuthed: true,
    ...overrides,
  };
}

function step(steps: ProvisionStep[], id: string): ProvisionStep {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

// --- execution order & batching ---

test("steps are batched sudo-first in the notes' execution order", () => {
  const steps = planProvision(satisfied(), ctx);
  expect(steps.map((s) => s.id)).toEqual([
    "packages",
    "login-shell",
    "sysctl",
    "swap",
    "timezone",
    "journald",
    "needrestart",
    "apparmor",
    "linger",
    "tailscale-install",
    "tailscale-serve",
    "bun",
    "claude",
    "units",
    "units-enable",
    "bridge-token",
  ]);
  const firstUser = steps.findIndex((s) => s.scope === "user");
  expect(steps.slice(0, firstUser).every((s) => s.scope === "sudo")).toBe(true);
  expect(steps.slice(firstUser).every((s) => s.scope === "user")).toBe(true);
});

test("a satisfied host plans no runnable step (units-enable stays idempotent)", () => {
  const steps = planProvision(satisfied(), ctx);
  const runnable = steps.filter((s) => s.verdict === "run").map((s) => s.id);
  expect(runnable).toEqual(["units-enable"]); // enable is idempotent and always re-asserted
});

// --- per-step verdicts & commands ---

test("packages: jq is dropped, netcat-openbsd is in, missing installs via one apt pass", () => {
  expect(HOST_PACKAGES).not.toContain("jq");
  expect(HOST_PACKAGES).toContain("netcat-openbsd");
  const steps = planProvision(satisfied({ missingPackages: ["netcat-openbsd", "earlyoom"] }), ctx);
  const packages = step(steps, "packages");
  expect(packages.verdict).toBe("run");
  expect(packages.commands[0].argv).toEqual(["sudo", "apt-get", "update", "-qq"]);
  expect(packages.commands[1].argv).toEqual([
    "sudo",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    "install",
    "-y",
    "-qq",
    "netcat-openbsd",
    "earlyoom",
  ]);
});

test("login shell: chsh only when the passwd entry differs; targets /usr/bin/zsh before zsh exists", () => {
  expect(step(planProvision(satisfied(), ctx), "login-shell").verdict).toBe("done");
  const pending = step(planProvision(satisfied({ loginShell: "/bin/bash", zshPath: null }), ctx), "login-shell");
  expect(pending.verdict).toBe("run");
  expect(pending.commands).toEqual([{ argv: ["sudo", "chsh", "-s", "/usr/bin/zsh", "marcel"] }]);
});

test("sysctl: writes the claude0-named file and reloads", () => {
  const fresh = step(planProvision(satisfied({ sysctlFilePresent: false }), ctx), "sysctl");
  expect(fresh.verdict).toBe("run");
  expect(fresh.commands.map((c) => c.argv)).toEqual([
    ["sudo", "tee", SYSCTL_FILE],
    ["sudo", "sysctl", "--system"],
  ]);
  expect(fresh.commands[0].stdin).toContain("fs.inotify.max_user_watches = 1048576");

  expect(step(planProvision(satisfied(), ctx), "sysctl").verdict).toBe("done");
});

test("swap: honours --swap-gb, skips the fstab append when already recorded, blocked without systemd", () => {
  const swap = step(planProvision(satisfied({ swapActive: false, fstabHasSwap: false }), { ...ctx, swapGb: 8 }), "swap");
  expect(swap.message).toContain("8G");
  expect(swap.commands.map((c) => c.argv)).toEqual([
    ["sudo", "fallocate", "-l", "8G", "/swapfile"],
    ["sudo", "chmod", "600", "/swapfile"],
    ["sudo", "mkswap", "/swapfile"],
    ["sudo", "swapon", "/swapfile"],
    ["sudo", "tee", "-a", "/etc/fstab"],
  ]);
  const recorded = step(planProvision(satisfied({ swapActive: false }), ctx), "swap");
  expect(recorded.commands.map((c) => c.argv)).not.toContainEqual(["sudo", "tee", "-a", "/etc/fstab"]);
  expect(step(planProvision(satisfied({ swapActive: false, systemd: false }), ctx), "swap").verdict).toBe("blocked");
  expect(step(planProvision(satisfied(), ctx), "swap").verdict).toBe("done");
});

test("timezone: defaults to the wanted zone, runs only on mismatch, blocked without timedatectl", () => {
  expect(step(planProvision(satisfied(), ctx), "timezone").verdict).toBe("done");
  const change = step(planProvision(satisfied({ timezone: "Etc/UTC" }), ctx), "timezone");
  expect(change.commands).toEqual([{ argv: ["sudo", "timedatectl", "set-timezone", "Europe/London"] }]);
  expect(step(planProvision(satisfied({ timezone: null }), ctx), "timezone").verdict).toBe("blocked");
});

test("needrestart and apparmor keep their compound guards", () => {
  // needrestart: dir present ∧ conf absent is the only run case
  expect(step(planProvision(satisfied({ needrestartConfPresent: false }), ctx), "needrestart").verdict).toBe("run");
  expect(step(planProvision(satisfied({ needrestartDirPresent: false, needrestartConfPresent: false }), ctx), "needrestart").verdict).toBe("done");
  // apparmor: parser missing drops the reload but still writes the profile
  const noParser = step(
    planProvision(satisfied({ apparmorProfilePresent: false, apparmorParserPresent: false }), ctx),
    "apparmor",
  );
  expect(noParser.commands.map((c) => c.argv)).toEqual([["sudo", "tee", "/etc/apparmor.d/bwrap"]]);
  expect(step(planProvision(satisfied({ apparmorDirPresent: false, apparmorProfilePresent: false }), ctx), "apparmor").verdict).toBe("done");
});

test("tailscale: installer only when missing; serve is guided-stop when not up, runs when up and unserved", () => {
  expect(step(planProvision(satisfied(), ctx), "tailscale-install").verdict).toBe("done");
  const install = step(planProvision(satisfied({ tailscalePresent: false, tailscaleUp: false, tailscaleServing: false }), ctx), "tailscale-install");
  expect(install.commands[0].argv[2]).toContain("https://tailscale.com/install.sh");
  expect(install.commands[0].argv[2]).toStartWith("set -o pipefail; ");
  expect(step(planProvision(satisfied({ tailscaleUp: false, tailscaleServing: false }), ctx), "tailscale-serve").verdict).toBe("blocked");
  const serve = step(planProvision(satisfied({ tailscaleServing: false }), { ...ctx, bridgePort: "9000" }), "tailscale-serve");
  expect(serve.commands).toEqual([{ argv: ["sudo", "tailscale", "serve", "--bg", "9000"] }]);
});

test("bun/claude install via the official installer scripts only when missing", () => {
  expect(step(planProvision(satisfied(), ctx), "bun").verdict).toBe("done");
  expect(step(planProvision(satisfied(), ctx), "claude").verdict).toBe("done");
  const steps = planProvision(satisfied({ bunPresent: false, claudePresent: false, claudeAuthed: false }), ctx);
  // pipefail: a failed curl must fail the step, not feed the shell empty stdin
  expect(step(steps, "bun").commands[0].argv[2]).toStartWith("set -o pipefail; ");
  expect(step(steps, "bun").commands[0].argv[2]).toContain("https://bun.sh/install");
  expect(step(steps, "claude").commands[0].argv[2]).toStartWith("set -o pipefail; ");
  expect(step(steps, "claude").commands[0].argv[2]).toContain("https://claude.ai/install.sh");
});

test("units: stale product units are copied from config/units and all four enabled independently", () => {
  const steps = planProvision(satisfied({ staleUnits: ["tmux.service", "claude0-daemon.service"] }), ctx);
  const units = step(steps, "units");
  expect(units.commands.map((c) => c.argv)).toEqual([
    ["mkdir", "-p", `${TEST_HOME}/.config/systemd/user`],
    ["cp", `${ctx.unitsDir}/tmux.service`, `${TEST_HOME}/.config/systemd/user/tmux.service`],
    ["cp", `${ctx.unitsDir}/claude0-daemon.service`, `${TEST_HOME}/.config/systemd/user/claude0-daemon.service`],
  ]);
  const enable = step(steps, "units-enable");
  expect(enable.commands[0].argv).toEqual(["systemctl", "--user", "daemon-reload"]);
  const enables = enable.commands.slice(1);
  expect(enables.map((c) => c.argv[3])).toEqual([...PRODUCT_UNITS]);
  expect(enables.every((c) => c.allowFailure === true)).toBe(true); // one broken unit must not stop the rest
  // snapshot-check is never touched
  expect(steps.flatMap((s) => s.commands).some((c) => c.argv.join(" ").includes("snapshot-check"))).toBe(false);
  // without systemd both unit steps are blocked
  const blocked = planProvision(satisfied({ systemd: false, staleUnits: ["tmux.service"] }), ctx);
  expect(step(blocked, "units").verdict).toBe("blocked");
  expect(step(blocked, "units-enable").verdict).toBe("blocked");
});

test("bridge token: minted when absent, port recorded when non-default, done otherwise", () => {
  expect(step(planProvision(satisfied(), ctx), "bridge-token").verdict).toBe("done");
  expect(step(planProvision(satisfied({ bridgeEnvPresent: false }), ctx), "bridge-token").verdict).toBe("run");
  // non-default port not yet recorded → run; recorded → done
  expect(step(planProvision(satisfied(), { ...ctx, bridgePort: "9000" }), "bridge-token").verdict).toBe("run");
  expect(step(planProvision(satisfied({ bridgeEnvHasPort: true }), { ...ctx, bridgePort: "9000" }), "bridge-token").verdict).toBe("done");
  expect(step(planProvision(satisfied({ bridgeEnvPresent: false, systemd: false }), ctx), "bridge-token").verdict).toBe("blocked");
});

// --- bridge env action ---

test("ensureBridgeEnv mints a 43-char alnum token at 0600 and appends only a missing non-default port", () => {
  const path = `${TEST_HOME}/.config/claude0/bridge.env`;
  rmSync(path, { force: true });
  ensureBridgeEnv(ctx);
  const env = readFileSync(path, "utf8");
  const token = env.match(/^CLAUDE0_BRIDGE_TOKEN=([a-zA-Z0-9]{43})\n/)?.[1];
  expect(token).toBeDefined();
  expect(statSync(path).mode & 0o777).toBe(0o600);
  // re-run with a non-default port: token untouched, port appended once
  ensureBridgeEnv({ ...ctx, bridgePort: "9000" });
  ensureBridgeEnv({ ...ctx, bridgePort: "9000" });
  const after = readFileSync(path, "utf8");
  expect(after).toContain(`CLAUDE0_BRIDGE_TOKEN=${token}`);
  expect(after.match(/^CLAUDE0_BRIDGE_PORT=9000$/gm)).toHaveLength(1);
  rmSync(path, { force: true });
});

test("generateBridgeToken is 43 alphanumeric chars", () => {
  for (let i = 0; i < 5; i++) expect(generateBridgeToken()).toMatch(/^[a-zA-Z0-9]{43}$/);
});

// --- executor ---

function fakeExec(codes: Record<string, number> = {}) {
  const ran: string[] = [];
  return {
    ran,
    exec: async (command: Command) => {
      const key = command.argv.join(" ");
      ran.push(key);
      return codes[key] ?? 0;
    },
  };
}

test("executeProvision runs only runnable steps' commands, prints [setup]/[skip] styles", async () => {
  const steps = planProvision(satisfied({ swapActive: false, systemd: true, fstabHasSwap: true }), ctx);
  const lines: string[] = [];
  const { ran, exec } = fakeExec();
  await executeProvision(steps, ctx, (line) => lines.push(line), exec);
  expect(ran.some((c) => c.startsWith("sudo fallocate"))).toBe(true);
  expect(ran.some((c) => c.startsWith("sudo apt-get"))).toBe(false); // packages step was done
  expect(lines.some((l) => l.includes("[setup]") && l.includes("swapfile"))).toBe(true);
  expect(lines.some((l) => l.includes("[setup]") && l.includes("packages already present"))).toBe(true);
});

test("a failed required command aborts naming the step; allowFailure continues with its note", async () => {
  const steps = planProvision(satisfied({ swapActive: false }), ctx);
  const { exec } = fakeExec({ "sudo fallocate -l 16G /swapfile": 1 });
  await expect(executeProvision(steps, ctx, () => {}, exec)).rejects.toThrow("provisioning failed at swap");

  // sysctl --system is allowFailure: the run survives and later steps still execute
  const reload = planProvision(satisfied({ sysctlFilePresent: false }), ctx);
  const failing = fakeExec({ "sudo sysctl --system": 1 });
  await expect(executeProvision(reload, ctx, () => {}, failing.exec)).resolves.toBeUndefined();
  expect(failing.ran.some((c) => c.startsWith("systemctl --user daemon-reload"))).toBe(true);
});

test("executeProvision fires the bridge-token action", async () => {
  const path = `${TEST_HOME}/.config/claude0/bridge.env`;
  rmSync(path, { force: true });
  const steps = planProvision(satisfied({ bridgeEnvPresent: false }), ctx);
  await executeProvision(steps, ctx, () => {}, fakeExec().exec);
  expect(readFileSync(path, "utf8")).toMatch(/^CLAUDE0_BRIDGE_TOKEN=/);
  rmSync(path, { force: true });
});

// --- guided stops & dry run ---

test("guided stops list exactly the unauthenticated tools with exact commands; pairing line always prints", () => {
  const all = guidedStops(satisfied({ claudeAuthed: false, ghAuthed: false, tailscaleUp: false }), ctx);
  expect(all.join("\n")).toContain("gh auth login");
  expect(all.join("\n")).toContain("tailscale up --ssh");
  expect(all.filter((l) => l.includes("[todo]"))).toHaveLength(3);
  const none = guidedStops(satisfied(), ctx);
  expect(none.some((l) => l.includes("[todo]"))).toBe(false);
  expect(none.join("\n")).toContain("bridge token");
});

test("renderDryRun prints every step with a verdict and never a secret", () => {
  const state = satisfied({ bridgeEnvPresent: false, missingPackages: ["netcat-openbsd"], claudeAuthed: false });
  const lines = renderDryRun(planProvision(state, ctx), state, ctx);
  expect(lines[0]).toContain("--dry-run");
  for (const id of ["packages", "sysctl", "bridge-token", "units-enable"]) {
    expect(lines.some((l) => l.includes(id))).toBe(true);
  }
  expect(lines.some((l) => l.includes("[run ]") && l.includes("packages"))).toBe(true);
  expect(lines.some((l) => l.includes("[skip]") && l.includes("timezone already"))).toBe(true);
  expect(lines.join("\n")).not.toMatch(/CLAUDE0_BRIDGE_TOKEN=[a-zA-Z0-9]/);
  expect(lines.join("\n")).toContain("$ sudo apt-get update -qq");
});
