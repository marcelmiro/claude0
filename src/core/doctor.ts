/**
 * `claude0 doctor` — read-only, role-aware health checks. Superset of the
 * deploy/doctor.sh host checks; deliberately never prints credentials or the
 * bridge token. Every probe is wrapped: a failed probe is a failed check,
 * never a crash.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { tmuxKeys, parseTmuxKey } from "./config";
import { resolveResurrect, resurrectOptionSet, resurrectRenderDir } from "./resurrect";
import type { ResurrectResolution } from "./resurrect";
import type { Config, DeploymentRole, TmuxKeys } from "../types";

/** One doctor probe outcome. Warnings never affect the exit code. */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorResult {
  status: DoctorStatus;
  label: string;
}

/** Environment a doctor run probes against; tests inject role/platform/home. */
export interface DoctorContext {
  home: string;
  role: DeploymentRole;
  platform: NodeJS.Platform;
  /** Repo config/ dir the installed fragments are compared against */
  templateDir: string;
  configPath: string;
  /** Loaded once by the dispatcher; null when the file failed to load */
  config: Config | null;
  /** The load failure behind a null config, for the config check to report */
  configError: string | null;
  hookVersion: number;
  hookScripts: readonly string[];
}

export interface DoctorCheck {
  name: string;
  run(ctx: DoctorContext): Promise<DoctorResult[]>;
}

/** Tools claude0 functionally invokes on every role. */
const ESSENTIAL_TOOLS = ["tmux", "git", "bun", "claude", "gh", "lsof", "nc"] as const;
/** doctor.sh parity: what the host workload additionally needs (jq leaves with the launcher rewrite). */
const HOST_TOOLS = ["claude0", "zsh", "curl", "jq", "mosh-server", "bwrap", "socat"] as const;
const HOST_UNITS = [
  "tmux.service",
  "claude0-bridge.service",
  "claude0-monitor.service",
  "claude0-daemon.service",
] as const;

const ok = (label: string): DoctorResult => ({ status: "ok", label });
const warn = (label: string): DoctorResult => ({ status: "warn", label });
const fail = (label: string): DoctorResult => ({ status: "fail", label });

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

// gh/claude/tailscale can all hang on exactly the wedged machine doctor exists
// for — a probe that outlives its deadline is killed and reads as failed.
const PROBE_TIMEOUT_MS = 10_000;

/** Run a probe command; a throw (missing binary), non-start, or a hang reads as code -1/non-zero, empty output. */
export async function probe(cmd: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<{ code: number; out: string }> {
  try {
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => child.kill(), timeoutMs);
    killer.unref?.();
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    clearTimeout(killer);
    return { code: code ?? -1, out: out.trim() };
  } catch {
    return { code: -1, out: "" };
  }
}

// --- helpers shared with `claude0 setup` (single source, so the two can't diverge) ---

/**
 * Render every token in the tmux fragment template. {{BIND_*}} come from
 * resolved tmux.keys ("prefix X" ⇒ bind-key X, bare "M-x" ⇒ bind-key -n M-x);
 * {{RESURRECT_LOAD}} becomes a run-shell line loading the claude0-owned
 * tmux-resurrect clone, or nothing when `resurrectDir` is null (a user-managed
 * copy loads itself — a second line would double-load the plugin). Setup writes
 * this exact output; doctor re-renders and compares, so a custom binding or
 * either resurrect outcome never reads as a stale fragment, and new template
 * tokens are tracked automatically.
 */
export function renderTmuxFragment(template: string, keys: TmuxKeys, resurrectDir: string | null): string {
  const bindFor = (spec: string) => {
    const parsed = parseTmuxKey(spec);
    return parsed.table === "prefix" ? `bind-key ${parsed.key}` : `bind-key -n ${parsed.key}`;
  };
  return template
    .replace("{{BIND_POPUP}}", bindFor(keys.popup))
    .replace("{{BIND_NEXT}}", bindFor(keys.next))
    .replace("{{RESURRECT_LOAD}}\n", resurrectDir === null ? "" : `run-shell '${resurrectDir}/resurrect.tmux'\n`);
}

/** Pure: does the fragment's resurrect run-shell line collide with a user-managed copy? */
export function resurrectDoubleLoad(fragment: string, resolution: ResurrectResolution): boolean {
  return (
    /^run-shell '.*\/resurrect\.tmux'$/m.test(fragment) &&
    (resolution.source === "user" || resolution.source === "user-elsewhere")
  );
}

/**
 * Is the fragment sourced from the entry file, or from a dotfiles layer the
 * entry point includes (e.g. ~/.config/zsh/common.zsh)? Detect by fragment
 * path, not exact line. followSymlinks: a stow-managed aux dir holds only
 * symlinks, which the scan otherwise skips entirely.
 */
export async function importAccepted(entry: string, aux: string, fragment: string): Promise<boolean> {
  if ((await readText(entry))?.includes(fragment)) return true;
  try {
    for await (const f of new Bun.Glob("*").scan({ cwd: aux, absolute: true, followSymlinks: true })) {
      if ((await Bun.file(f).text()).includes(fragment)) return true;
    }
  } catch {}
  return false;
}

/** Read the HOOK_VERSION from an installed hook script. Returns 0 if missing or unreadable. */
export async function installedHookVersion(path: string): Promise<number> {
  const version = (await readText(path))?.match(/^# HOOK_VERSION=(\d+)/m)?.[1];
  return version ? parseInt(version, 10) : 0;
}

// --- checks ---

function toolsCheck(name: string, tools: readonly string[]): DoctorCheck {
  return {
    name,
    async run() {
      return tools.map((tool) => {
        const path = Bun.which(tool);
        return path ? ok(`${tool}: ${path}`) : fail(`${tool} is not installed or not on PATH`);
      });
    },
  };
}

function fragmentsCheck(): DoctorCheck {
  return {
    name: "fragments",
    async run(ctx) {
      const keys = tmuxKeys(ctx.config);
      // Same resolution path setup renders with; resurrectOptionSet already maps
      // the CLAUDE0_HOME seam and any tmux probe failure to false.
      const resurrectDir = resurrectRenderDir(
        await resolveResurrect(ctx.home, await resurrectOptionSet()),
        ctx.role,
        ctx.home,
      );
      const fragments = [
        {
          kind: "tmux",
          installed: `${ctx.home}/.config/claude0/tmux.conf`,
          template: `${ctx.templateDir}/tmux.conf`,
          entry: `${ctx.home}/.tmux.conf`,
          aux: `${ctx.home}/.config/tmux`,
          importPath: ".config/claude0/tmux.conf",
          render: (template: string) => renderTmuxFragment(template, keys, resurrectDir),
        },
        {
          kind: "zsh",
          installed: `${ctx.home}/.config/claude0/shell.zsh`,
          template: `${ctx.templateDir}/shell.zsh`,
          entry: `${ctx.home}/.zshrc`,
          aux: `${ctx.home}/.config/zsh`,
          importPath: ".config/claude0/shell.zsh",
          render: (template: string) => template,
        },
      ];
      const results: DoctorResult[] = [];
      for (const fragment of fragments) {
        const installed = await readText(fragment.installed);
        const template = await readText(fragment.template);
        let rendered: string | null = null;
        try {
          rendered = template === null ? null : fragment.render(template);
        } catch {}
        results.push(
          installed !== null && installed === rendered && !/^\{\{[A-Z_]+\}\}/m.test(installed)
            ? ok(`current Claude0-owned ${fragment.kind} fragment is installed`)
            : fail(`Claude0-owned ${fragment.kind} fragment is missing or stale: ${fragment.installed} — run claude0 setup`),
        );
        results.push(
          (await importAccepted(fragment.entry, fragment.aux, fragment.importPath))
            ? ok(`${fragment.entry} imports the Claude0 fragment`)
            : fail(`${fragment.entry} does not import the Claude0 fragment — run claude0 setup`),
        );
      }
      return results;
    },
  };
}

function resurrectCheck(): DoctorCheck {
  return {
    name: "resurrect",
    async run(ctx) {
      const fragment = await readText(`${ctx.home}/.config/claude0/tmux.conf`);
      if (fragment === null) return []; // no fragment installed — the fragments check reports that
      const resolution = await resolveResurrect(ctx.home, await resurrectOptionSet());
      return [
        resurrectDoubleLoad(fragment, resolution)
          ? warn("the Claude0 tmux fragment loads tmux-resurrect, but a user-managed copy now exists — the plugin loads twice; re-run claude0 setup to drop the line")
          : ok("no tmux-resurrect double-load"),
      ];
    },
  };
}

function configCheck(): DoctorCheck {
  return {
    name: "config",
    async run(ctx) {
      if (!existsSync(ctx.configPath)) return [fail(`config missing: ${ctx.configPath} — run claude0 setup`)];
      return [ctx.configError === null ? ok(`config is valid: ${ctx.configPath}`) : fail(ctx.configError)];
    },
  };
}

function authCheck(): DoctorCheck {
  return {
    name: "auth",
    async run() {
      const gh = await probe(["gh", "auth", "status"]);
      const claude = await probe(["claude", "auth", "status"]);
      let loggedIn = false;
      try {
        loggedIn = JSON.parse(claude.out)?.loggedIn === true;
      } catch {}
      return [
        gh.code === 0 ? ok("GitHub CLI is authenticated") : fail("GitHub CLI is not authenticated (gh auth login)"),
        loggedIn ? ok("Claude Code is authenticated") : fail("Claude Code is not authenticated (claude login)"),
      ];
    },
  };
}

function hooksCheck(): DoctorCheck {
  return {
    name: "hooks",
    async run(ctx) {
      const dir = `${ctx.home}/.config/claude0/hooks`;
      const installed = await Promise.all(
        ctx.hookScripts.map(async (name) => ({ name, version: await installedHookVersion(`${dir}/${name}`) })),
      );
      // A client never installs hooks fresh (sessions live on the host) — absent is
      // healthy there; hooks that ARE present must still be current on every role.
      if (ctx.role === "client" && installed.every((script) => script.version === 0)) {
        return [ok("no hooks installed (client role — sessions live on the host)")];
      }
      return installed.map((script) =>
        script.version === ctx.hookVersion
          ? ok(`hook ${script.name} is current (v${script.version})`)
          : fail(
              script.version === 0
                ? `hook ${script.name} is not installed — run claude0 setup`
                : `hook ${script.name} is v${script.version}, current is v${ctx.hookVersion} — run claude0 setup`,
            ),
      );
    },
  };
}

function unitsCheck(): DoctorCheck {
  return {
    name: "units",
    async run(ctx) {
      if (!existsSync("/run/systemd/system")) return [fail("systemd is not running")];
      const results: DoctorResult[] = [];
      for (const unit of HOST_UNITS) {
        const active = (await probe(["systemctl", "--user", "is-active", unit])).out;
        const enabled = (await probe(["systemctl", "--user", "is-enabled", unit])).out;
        results.push(active === "active" ? ok(`${unit} active`) : fail(`${unit} active = ${active || "<empty>"} (expected active)`));
        results.push(enabled === "enabled" ? ok(`${unit} enabled`) : fail(`${unit} enabled = ${enabled || "<empty>"} (expected enabled)`));
      }
      // snapshot-check is personal ops (deploy/aws/) — setup never installs it, so
      // absent is healthy; a copy someone DID install should still be running.
      if (existsSync(`${ctx.home}/.config/systemd/user/snapshot-check.timer`)) {
        const active = (await probe(["systemctl", "--user", "is-active", "snapshot-check.timer"])).out;
        results.push(
          active === "active"
            ? ok("snapshot-check.timer active")
            : warn(`snapshot-check.timer is installed but ${active || "not active"} — EBS staleness alerts are off`),
        );
      }
      const user = process.env.USER ?? userInfo().username;
      const linger = (await probe(["loginctl", "show-user", user, "-p", "Linger", "--value"])).out;
      results.push(linger === "yes" ? ok("login linger = yes") : fail(`login linger = ${linger || "<empty>"} (expected yes)`));
      return results;
    },
  };
}

/** Executable-at-this-path, `command -v` semantics (doctor.sh probed via PATH= command -v). */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function tmuxCheck(): DoctorCheck {
  return {
    name: "tmux",
    async run(ctx) {
      const session = ctx.config?.terminal.localSession ?? "main";
      if ((await probe(["tmux", "has-session", "-t", session])).code !== 0) {
        return [fail(`tmux session ${session} is not alive`)];
      }
      const results: DoctorResult[] = [ok(`tmux session ${session} is alive`)];

      const pathOut = (await probe(["tmux", "show-environment", "-g", "PATH"])).out;
      const tmuxPath = pathOut.startsWith("PATH=") ? pathOut.slice("PATH=".length) : "";
      const entries = tmuxPath.split(":");
      results.push(
        entries.includes(`${ctx.home}/.bun/bin`) && entries.includes(`${ctx.home}/.local/bin`)
          ? ok("tmux server PATH includes bun and local bins")
          : fail(`tmux server PATH is missing ${ctx.home}/.bun/bin or ${ctx.home}/.local/bin: ${tmuxPath}`),
      );
      const resolvable = entries.some((dir) => {
        if (!dir) return false;
        const expanded = dir === "~" ? ctx.home : dir.startsWith("~/") ? `${ctx.home}${dir.slice(1)}` : dir;
        return executable(`${expanded}/claude0`);
      });
      results.push(
        resolvable
          ? ok("tmux run-shell can resolve claude0")
          : fail("claude0 is not resolvable through the tmux server PATH"),
      );

      const status = (await probe(["tmux", "show-options", "-gqv", "@claude0_status"])).out;
      results.push(status.includes("claude0 status") ? ok("Claude0 status segment is active") : fail("@claude0_status is missing or inactive"));

      const spec = tmuxKeys(ctx.config).popup;
      try {
        const { table, key } = parseTmuxKey(spec);
        const bound = (await probe(["tmux", "list-keys", "-T", table, key])).out;
        results.push(
          bound.includes("display-popup") && bound.includes("claude0")
            ? ok("Claude0 popup binding is active")
            : fail(`${spec} is not bound to the Claude0 popup`),
        );
      } catch {
        results.push(fail(`tmux.keys.popup is invalid: ${spec}`));
      }
      return results;
    },
  };
}

/** KEY=value from an EnvironmentFile, hand-quoted values unwrapped. */
function envValue(env: string, key: string): string | undefined {
  const raw = env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  if (!raw) return undefined;
  return raw.replace(/^(["'])(.*)\1$/, "$2");
}

/** The bridge port: EnvironmentFile value wins, then the process env, then the 8473 default. */
async function bridgePort(home: string): Promise<string> {
  const env = await readText(`${home}/.config/claude0/bridge.env`);
  return (env !== null ? envValue(env, "CLAUDE0_BRIDGE_PORT") : undefined) ?? process.env.CLAUDE0_BRIDGE_PORT ?? "8473";
}

function bridgeCheck(): DoctorCheck {
  return {
    name: "bridge",
    async run(ctx) {
      const envPath = `${ctx.home}/.config/claude0/bridge.env`;
      const env = await readText(envPath);
      if (env === null) return [fail(`bridge EnvironmentFile is missing or unreadable: ${envPath}`)];
      const token = envValue(env, "CLAUDE0_BRIDGE_TOKEN");
      if (!token) return [fail("bridge EnvironmentFile has no CLAUDE0_BRIDGE_TOKEN")];
      const port = await bridgePort(ctx.home);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/auth`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          signal: AbortSignal.timeout(3000),
        });
        return [response.status === 200 ? ok("bridge authentication = 200") : fail(`bridge authentication = ${response.status} (expected 200)`)];
      } catch {
        return [fail(`bridge is not answering on 127.0.0.1:${port}`)];
      }
    },
  };
}

function tailscaleCheck(): DoctorCheck {
  return {
    name: "tailscale",
    async run(ctx) {
      if ((await probe(["tailscale", "status"])).code !== 0) {
        return [fail("Tailscale is not connected")];
      }
      const port = await bridgePort(ctx.home);
      const serve = (await probe(["tailscale", "serve", "status"])).out;
      return [
        ok("Tailscale is connected"),
        serve.includes(`127.0.0.1:${port}`)
          ? ok("Tailscale Serve proxies the portkey bridge")
          : fail(`Tailscale Serve is not proxying 127.0.0.1:${port}`),
      ];
    },
  };
}

/** /proc carries the value even on minimal images that ship without the sysctl binary. */
async function sysctlValue(name: string): Promise<number | null> {
  const proc = (await readText(`/proc/sys/${name.replaceAll(".", "/")}`))?.trim();
  if (proc && /^\d+$/.test(proc)) return Number(proc);
  const out = (await probe(["sysctl", "-n", name])).out;
  return /^\d+$/.test(out) ? Number(out) : null;
}

function sysctlCheck(): DoctorCheck {
  return {
    name: "sysctl",
    async run() {
      const watches = await sysctlValue("fs.inotify.max_user_watches");
      const instances = await sysctlValue("fs.inotify.max_user_instances");
      return [
        watches !== null && watches >= 1048576 ? ok(`inotify watches = ${watches}`) : fail(`inotify watches = ${watches ?? "unknown"} (expected >= 1048576)`),
        instances !== null && instances >= 16384 ? ok(`inotify instances = ${instances}`) : fail(`inotify instances = ${instances ?? "unknown"} (expected >= 16384)`),
      ];
    },
  };
}

function swapCheck(): DoctorCheck {
  return {
    name: "swap",
    async run() {
      // swapon lives in /usr/sbin (often off the user PATH) — /proc/swaps is always readable.
      const swaps = await readText("/proc/swaps");
      return [swaps !== null && /^\/swapfile /m.test(swaps) ? ok("swapfile is active") : fail("swapfile is not active")];
    },
  };
}

/**
 * Is the launchd daemon agent live? Under the CLAUDE0_HOME test seam launchctl
 * is never consulted — the plist's presence stands in (mirrors setup's gating).
 */
async function daemonLoaded(home: string): Promise<boolean> {
  if (!existsSync(`${home}/Library/LaunchAgents/com.claude0.daemon.plist`)) return false;
  if (process.env.CLAUDE0_HOME) return true;
  const uid = process.getuid?.();
  if (uid === undefined) return false; // can't address gui/<uid> — report unloaded rather than guess
  return (await probe(["launchctl", "print", `gui/${uid}/com.claude0.daemon`])).code === 0;
}

function daemonPresentCheck(): DoctorCheck {
  return {
    name: "daemon-present",
    async run(ctx) {
      return [
        (await daemonLoaded(ctx.home))
          ? ok("inbox daemon agent is loaded (com.claude0.daemon)")
          : fail("inbox daemon agent is not loaded — run claude0 setup (snoozes never wake without it)"),
      ];
    },
  };
}

function daemonAbsentCheck(): DoctorCheck {
  return {
    name: "daemon-absent",
    async run(ctx) {
      return [
        (await daemonLoaded(ctx.home))
          ? warn('a local launchd daemon (com.claude0.daemon) is live, but this machine\'s role is "client" — the daemon belongs to the host; run claude0 setup to retire it')
          : ok("no local inbox daemon (the host owns the inbox)"),
      ];
    },
  };
}

export function doctorChecks(ctx: DoctorContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    toolsCheck("essential-tools", ESSENTIAL_TOOLS),
    fragmentsCheck(),
    resurrectCheck(),
    configCheck(),
    authCheck(),
    hooksCheck(),
  ];
  if (ctx.role === "host") {
    checks.push(toolsCheck("host-tools", HOST_TOOLS), unitsCheck(), tmuxCheck(), bridgeCheck(), tailscaleCheck(), sysctlCheck(), swapCheck());
  }
  // launchd exists only on darwin — the per-role daemon checks skip cleanly elsewhere.
  if (ctx.platform === "darwin" && ctx.role === "local") checks.push(daemonPresentCheck());
  if (ctx.platform === "darwin" && ctx.role === "client") checks.push(daemonAbsentCheck());
  return checks;
}

/** Exit contract: 0 iff no failures; warnings never affect the exit code. */
export function summarize(results: DoctorResult[]): { failures: number; warnings: number; exitCode: number } {
  const failures = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return { failures, warnings, exitCode: failures === 0 ? 0 : 1 };
}

const COLORS = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" } as const;

export async function runDoctor(ctx: DoctorContext, print: (line: string) => void = console.log): Promise<number> {
  print(`Claude0 doctor — role ${ctx.role}\n`);
  const results: DoctorResult[] = [];
  for (const check of doctorChecks(ctx)) {
    let checkResults: DoctorResult[];
    try {
      checkResults = await check.run(ctx);
    } catch (error) {
      checkResults = [fail(`${check.name} check crashed: ${error instanceof Error ? error.message : String(error)}`)];
    }
    for (const result of checkResults) {
      results.push(result);
      print(`${COLORS[result.status]}[${result.status}]\x1b[0m ${result.label}`);
    }
  }
  const { failures, warnings, exitCode } = summarize(results);
  print(`\nDoctor finished: ${failures} failure(s), ${warnings} warning(s).`);
  return exitCode;
}
