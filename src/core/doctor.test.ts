/**
 * `claude0 doctor` check logic. Role dispatch of the check sets, the exit-code
 * contract (0 iff no failures, warnings pass), and the individual checks that
 * read only the CLAUDE0_HOME seam. Host probes that need a live system
 * (systemctl, tailscale, a tmux server) are covered by inventory only.
 */

import "../../test/helpers/home";
import { TEST_HOME, CONFIG_DIR } from "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { doctorChecks, summarize, runDoctor, renderTmuxFragment, resurrectDoubleLoad, probe } from "./doctor";
import type { DoctorContext } from "./doctor";
import { DEFAULT_CONFIG, tmuxKeys } from "./config";
import { claude0ResurrectDir } from "./resurrect";
import type { Config } from "../types";

const templateDir = `${import.meta.dir}/../../config`;
const plistPath = `${TEST_HOME}/Library/LaunchAgents/com.claude0.daemon.plist`;
// What doctor's forward render resolves to under TEST_HOME with no user copy:
// source "none" → the claude0-owned clone dir (where setup would clone).
const cloneDir = claude0ResurrectDir(TEST_HOME);

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    home: TEST_HOME,
    role: "local",
    platform: "darwin",
    templateDir,
    configPath: `${CONFIG_DIR}/config.json`,
    config: null,
    configError: null,
    hookVersion: 5,
    hookScripts: ["session-start.sh", "event.sh"],
    ...overrides,
  };
}

function check(name: string, c: DoctorContext) {
  const found = doctorChecks(c).find((entry) => entry.name === name);
  if (!found) throw new Error(`no check named ${name} for role ${c.role}`);
  return found.run(c);
}

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.tmux.conf`, { force: true });
  rmSync(`${TEST_HOME}/.zshrc`, { force: true });
  rmSync(`${TEST_HOME}/.config/tmux`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.config/zsh`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.tmux`, { recursive: true, force: true });
  rmSync(plistPath, { force: true });
});

// --- role dispatch ---

const BASE_CHECKS = ["essential-tools", "fragments", "resurrect", "config", "auth", "hooks"];

test("check sets are role-dispatched; darwin-only checks skip cleanly off-darwin", () => {
  const names = (c: DoctorContext) => doctorChecks(c).map((entry) => entry.name);
  expect(names(ctx({ role: "host", platform: "linux" }))).toEqual([
    ...BASE_CHECKS,
    "host-tools",
    "units",
    "tmux",
    "bridge",
    "tailscale",
    "sysctl",
    "swap",
  ]);
  expect(names(ctx({ role: "local", platform: "darwin" }))).toEqual([...BASE_CHECKS, "daemon-present"]);
  expect(names(ctx({ role: "client", platform: "darwin" }))).toEqual([...BASE_CHECKS, "daemon-absent"]);
  expect(names(ctx({ role: "client", platform: "linux" }))).toEqual(BASE_CHECKS);
  expect(names(ctx({ role: "local", platform: "linux" }))).toEqual(BASE_CHECKS);
});

// --- exit-code contract ---

test("exit code is 0 iff no failures; warnings never fail the run", () => {
  const ok = { status: "ok", label: "x" } as const;
  const warn = { status: "warn", label: "x" } as const;
  const fail = { status: "fail", label: "x" } as const;
  expect(summarize([ok, ok])).toEqual({ failures: 0, warnings: 0, exitCode: 0 });
  expect(summarize([ok, warn, warn])).toEqual({ failures: 0, warnings: 2, exitCode: 0 });
  expect(summarize([ok, warn, fail])).toEqual({ failures: 1, warnings: 1, exitCode: 1 });
  expect(summarize([])).toEqual({ failures: 0, warnings: 0, exitCode: 0 });
});

test("runDoctor prints per-check lines and aggregates the exit code", async () => {
  const lines: string[] = [];
  const code = await runDoctor(ctx({ role: "local", platform: "linux" }), (line) => lines.push(line));
  expect(code).toBe(1); // config missing under a clean TEST_HOME
  expect(lines[0]).toContain("role local");
  expect(lines.some((line) => line.includes("[fail]") && line.includes("config missing"))).toBe(true);
  expect(lines.at(-1)).toMatch(/^\nDoctor finished: \d+ failure\(s\), \d+ warning\(s\)\.$/);
});

// --- host exclusivity ---

test("client role with a live local launchd daemon warns without failing", async () => {
  mkdirSync(`${TEST_HOME}/Library/LaunchAgents`, { recursive: true });
  writeFileSync(plistPath, "<plist/>");
  const results = await check("daemon-absent", ctx({ role: "client" }));
  expect(results).toHaveLength(1);
  expect(results[0].status).toBe("warn");
  expect(results[0].label).toContain("host");
  expect(summarize(results).exitCode).toBe(0);
});

test("client role with no local daemon passes; local role without one fails", async () => {
  expect((await check("daemon-absent", ctx({ role: "client" })))[0].status).toBe("ok");
  expect((await check("daemon-present", ctx()))[0].status).toBe("fail");
  mkdirSync(`${TEST_HOME}/Library/LaunchAgents`, { recursive: true });
  writeFileSync(plistPath, "<plist/>");
  expect((await check("daemon-present", ctx()))[0].status).toBe("ok");
});

// --- hooks ---

test("hooks: current versions pass, stale or missing fail, absent is fine on a client only", async () => {
  // absent: fails on local, healthy on a client (never installs fresh)
  expect((await check("hooks", ctx())).every((r) => r.status === "fail")).toBe(true);
  const clientAbsent = await check("hooks", ctx({ role: "client" }));
  expect(clientAbsent).toHaveLength(1);
  expect(clientAbsent[0].status).toBe("ok");

  const hooksDir = `${CONFIG_DIR}/hooks`;
  mkdirSync(hooksDir, { recursive: true });
  for (const name of ctx().hookScripts) writeFileSync(`${hooksDir}/${name}`, "#!/bin/bash\n# HOOK_VERSION=5\n");
  expect((await check("hooks", ctx())).every((r) => r.status === "ok")).toBe(true);

  // a present-but-stale hook fails on a client too — setup upgrades it in place
  writeFileSync(`${hooksDir}/event.sh`, "#!/bin/bash\n# HOOK_VERSION=1\n");
  const stale = await check("hooks", ctx({ role: "client" }));
  expect(stale.map((r) => r.status)).toEqual(["ok", "fail"]);
});

// --- fragments ---

/** Install fragments the way setup does: template forward-rendered with the config's keys. */
async function installFragments(keys = tmuxKeys(null), resurrectDir: string | null = cloneDir) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmux = renderTmuxFragment(await Bun.file(`${templateDir}/tmux.conf`).text(), keys, resurrectDir);
  writeFileSync(`${CONFIG_DIR}/tmux.conf`, tmux);
  cpSync(`${templateDir}/shell.zsh`, `${CONFIG_DIR}/shell.zsh`);
}

/** Fake a user-managed TPM resurrect install under TEST_HOME. */
function seedUserResurrect() {
  const dir = `${TEST_HOME}/.config/tmux/plugins/tmux-resurrect/scripts`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/save.sh`, "#!/bin/bash\n");
}

test("fragments: forward-rendered template matches; layered imports accepted on both sides", async () => {
  await installFragments();
  // both imports live in dotfiles layers, not the entry files
  writeFileSync(`${TEST_HOME}/.tmux.conf`, "# no claude0 line here\n");
  mkdirSync(`${TEST_HOME}/.config/tmux`, { recursive: true });
  writeFileSync(`${TEST_HOME}/.config/tmux/extra.conf`, "source-file ~/.config/claude0/tmux.conf\n");
  writeFileSync(`${TEST_HOME}/.zshrc`, "# no claude0 line here\n");
  mkdirSync(`${TEST_HOME}/.config/zsh`, { recursive: true });
  writeFileSync(`${TEST_HOME}/.config/zsh/common.zsh`, 'source "$HOME/.config/claude0/shell.zsh"\n');

  const results = await check("fragments", ctx());
  // [tmux fragment, tmux import, zsh fragment, zsh import]
  expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
});

test("fragments: a fragment rendered with custom keys is fresh iff config still holds those keys", async () => {
  const config: Config = { ...DEFAULT_CONFIG, tmux: { keys: { popup: "M-a" } } };
  await installFragments(tmuxKeys(config));
  expect((await check("fragments", ctx({ config })))[0].status).toBe("ok");

  // fragment still carries the default binds while config says M-a → stale
  await installFragments(tmuxKeys(null));
  expect((await check("fragments", ctx({ config })))[0].status).toBe("fail");
});

test("fragments: unrendered {{...}} tokens, a stale fragment, or a missing import fail", async () => {
  // installed file still carries raw tokens (hand-copied template, setup never rendered)
  mkdirSync(CONFIG_DIR, { recursive: true });
  cpSync(`${templateDir}/tmux.conf`, `${CONFIG_DIR}/tmux.conf`);
  writeFileSync(`${CONFIG_DIR}/shell.zsh`, "# an old fragment\n");
  const results = await check("fragments", ctx());
  // [tmux fragment, tmux import, zsh fragment, zsh import]
  expect(results.map((r) => r.status)).toEqual(["fail", "fail", "fail", "fail"]);
});

test("renderTmuxFragment renders binds per table and both resurrect outcomes", () => {
  const keys = { ...tmuxKeys(null), popup: "prefix a", next: "M-n" };
  const template = "{{BIND_POPUP}} x\n{{BIND_NEXT}} y\n{{RESURRECT_LOAD}}\n";
  expect(renderTmuxFragment(template, keys, "/h/plugins/tmux-resurrect")).toBe(
    "bind-key a x\nbind-key -n M-n y\nrun-shell '/h/plugins/tmux-resurrect/resurrect.tmux'\n",
  );
  expect(renderTmuxFragment(template, keys, null)).toBe("bind-key a x\nbind-key -n M-n y\n");
});

test("fragments: fresh in both resurrect render outcomes, stale across them", async () => {
  // user-managed copy → setup renders no run-shell line → fresh
  seedUserResurrect();
  await installFragments(tmuxKeys(null), null);
  expect((await check("fragments", ctx()))[0].status).toBe("ok");
  // fragment still carries the clone's line while a user copy exists → stale
  await installFragments(tmuxKeys(null), cloneDir);
  expect((await check("fragments", ctx()))[0].status).toBe("fail");
  // client role renders no line regardless of any local copy
  rmSync(`${TEST_HOME}/.config/tmux`, { recursive: true, force: true });
  await installFragments(tmuxKeys(null), null);
  expect((await check("fragments", ctx({ role: "client" })))[0].status).toBe("ok");
});

// --- resurrect double-load ---

test("resurrect: warns on double-load, ok otherwise, silent with no fragment", async () => {
  expect(await check("resurrect", ctx())).toEqual([]); // no fragment → skip cleanly
  await installFragments(); // claude0-owned run-shell line, no user copy
  expect((await check("resurrect", ctx()))[0].status).toBe("ok");
  // a user-managed copy appears while the line is still installed → warning, never a failure
  seedUserResurrect();
  const results = await check("resurrect", ctx());
  expect(results[0].status).toBe("warn");
  expect(results[0].label).toContain("claude0 setup");
  expect(summarize(results).exitCode).toBe(0);
});

test("resurrectDoubleLoad flags user and user-elsewhere resolutions only, and only with a line", () => {
  const fragment = "set -g x y\nrun-shell '/x/tmux-resurrect/resurrect.tmux'\n";
  expect(resurrectDoubleLoad(fragment, { source: "user", path: "/u" })).toBe(true);
  expect(resurrectDoubleLoad(fragment, { source: "user-elsewhere", path: null })).toBe(true);
  expect(resurrectDoubleLoad(fragment, { source: "claude0", path: "/x" })).toBe(false);
  expect(resurrectDoubleLoad(fragment, { source: "none", path: null })).toBe(false);
  expect(resurrectDoubleLoad("set -g x y\n", { source: "user", path: "/u" })).toBe(false);
});

// --- config ---

test("config: missing fails, a load error fails with its message, valid passes", async () => {
  expect((await check("config", ctx()))[0].status).toBe("fail");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(`${CONFIG_DIR}/config.json`, JSON.stringify({ bogus: true }));
  // the dispatcher loads once and hands the failure to the check via ctx
  const invalid = await check("config", ctx({ configError: "config contains unknown key: bogus" }));
  expect(invalid[0].status).toBe("fail");
  expect(invalid[0].label).toContain("unknown key");
  writeFileSync(`${CONFIG_DIR}/config.json`, JSON.stringify(DEFAULT_CONFIG));
  expect((await check("config", ctx({ config: DEFAULT_CONFIG })))[0].status).toBe("ok");
});

// --- probes ---

test("a hung probe is killed at its deadline instead of holding the process open", async () => {
  const start = Date.now();
  const result = await probe(["sleep", "30"], 250);
  expect(result.code).not.toBe(0);
  expect(Date.now() - start).toBeLessThan(5000);
});

test("a missing probe binary reads as a failed probe, not a crash", async () => {
  expect(await probe(["c0-definitely-not-a-binary"])).toEqual({ code: -1, out: "" });
});
