/**
 * Host provisioning (role=host on linux) — the native port of deploy/provision.sh,
 * run by `claude0 setup`. Split as pure planning over a probed system state
 * (`planProvision`, unit-testable without root) and a thin executor; the only
 * privileged interaction is one upfront `sudo -v`, after which the sudo-scoped
 * steps run first so a credential timeout can't half-apply a step.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, appendFileSync, readFileSync } from "node:fs";
import { probe } from "./doctor";

/** apt packages the host workload needs. lsof: background-script liveness probes.
 * bubblewrap+socat: Claude Code's Linux sandbox — WITHOUT them it silently runs
 * unsandboxed while autoAllowBashIfSandboxed defaults true. earlyoom: kills the
 * largest process instead of a whole cgroup. netcat-openbsd: the sidebar stub's
 * `nc -U` relay. */
export const HOST_PACKAGES = [
  "tmux",
  "mosh",
  "zsh",
  "lsof",
  "git",
  "gh",
  "curl",
  "bubblewrap",
  "socat",
  "earlyoom",
  "unzip",
  "netcat-openbsd",
] as const;

/** The product units setup installs and enables (snapshot-check is personal ops, deploy/aws/). */
export const PRODUCT_UNITS = [
  "tmux.service",
  "claude0-bridge.service",
  "claude0-monitor.service",
  "claude0-daemon.service",
] as const;

export const SYSCTL_FILE = "/etc/sysctl.d/99-claude0-inotify.conf";
export const OLD_SYSCTL_FILE = "/etc/sysctl.d/99-csm-inotify.conf";
// Per-UID and shared by every Claude session; exhaustion is a hard ENOSPC crash
// with no graceful degradation. max_user_instances (default 128) breaks first.
const SYSCTL_CONTENT = `fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 16384
fs.inotify.max_queued_events = 32768
`;

const JOURNALD_FILE = "/etc/systemd/journald.conf.d/claude0.conf";
const JOURNALD_CONTENT = "[Journal]\nSystemMaxUse=500M\n";

const NEEDRESTART_FILE = "/etc/needrestart/conf.d/50-claude0.conf";
// 'l' = list only ('i' can still prompt and hang a job).
const NEEDRESTART_CONTENT = "$nrconf{restart} = 'l';\n";

const APPARMOR_FILE = "/etc/apparmor.d/bwrap";
// Ubuntu 24.04 blocks unprivileged user namespaces by default; without this
// profile the Claude Code sandbox cannot start (and its absence is silent).
const APPARMOR_CONTENT = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

export interface ProvisionContext {
  home: string;
  /** Repo config/units dir the product units are sourced from */
  unitsDir: string;
  user: string;
  tz: string;
  swapGb: number;
  bridgePort: string;
}

export interface Command {
  argv: string[];
  /** Piped to the process (sudo tee file writes) */
  stdin?: string;
  /** Suppress stdout (tee echoes its input) */
  quiet?: boolean;
  /** Non-zero exit prints failNote and continues instead of aborting the run */
  allowFailure?: boolean;
  failNote?: string;
}

export interface ProvisionStep {
  id: string;
  scope: "sudo" | "user";
  /** run = commands/action will execute; done = guard already satisfied; blocked = subsystem absent */
  verdict: "run" | "done" | "blocked";
  message: string;
  commands: Command[];
  /** TS-native effect (bridge token mint) — secrets never appear in the printable plan */
  action?: (ctx: ProvisionContext) => void;
}

/** Everything the planner needs, probed read-only (no sudo, no side effects). */
export interface SystemState {
  systemd: boolean;
  missingPackages: string[];
  zshPath: string | null;
  loginShell: string | null;
  sysctlFilePresent: boolean;
  oldSysctlFilePresent: boolean;
  swapActive: boolean;
  fstabHasSwap: boolean;
  /** null = timedatectl unavailable */
  timezone: string | null;
  journaldCapPresent: boolean;
  needrestartDirPresent: boolean;
  needrestartConfPresent: boolean;
  apparmorDirPresent: boolean;
  apparmorProfilePresent: boolean;
  apparmorParserPresent: boolean;
  lingerEnabled: boolean;
  /** Product units whose installed copy differs from the repo's */
  staleUnits: string[];
  bridgeEnvPresent: boolean;
  bridgeEnvHasPort: boolean;
  bunPresent: boolean;
  claudePresent: boolean;
  tailscalePresent: boolean;
  tailscaleUp: boolean;
  tailscaleServing: boolean;
  claudeAuthed: boolean;
  ghAuthed: boolean;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

export async function probeSystemState(ctx: ProvisionContext): Promise<SystemState> {
  const systemd = existsSync("/run/systemd/system");

  // One dpkg call for the whole list: a stanza with an installed Status marks the
  // package present (dpkg -s exits non-zero when ANY name is unknown, so the exit
  // code can't answer per-package).
  const dpkg = await probe(["dpkg", "-s", ...HOST_PACKAGES]);
  const installedPackages = new Set<string>();
  let stanzaPackage: string | null = null;
  for (const line of dpkg.out.split("\n")) {
    const pkg = line.match(/^Package: (\S+)/)?.[1];
    if (pkg) stanzaPackage = pkg;
    if (stanzaPackage && /^Status: .*\binstalled\b/.test(line)) installedPackages.add(stanzaPackage);
  }
  const missingPackages = HOST_PACKAGES.filter((pkg) => !installedPackages.has(pkg));

  const passwd = await probe(["getent", "passwd", ctx.user]);
  const loginShell = passwd.code === 0 ? (passwd.out.split(":")[6] ?? null) : null;

  const swaps = await readText("/proc/swaps");
  const fstab = await readText("/etc/fstab");

  let timezone: string | null = null;
  if (systemd && Bun.which("timedatectl")) {
    const tz = await probe(["timedatectl", "show", "-p", "Timezone", "--value"]);
    if (tz.code === 0) timezone = tz.out;
  }

  const staleUnits: string[] = [];
  for (const unit of PRODUCT_UNITS) {
    const wanted = await readText(`${ctx.unitsDir}/${unit}`);
    // an unreadable repo unit must fail loudly, never read as "already current" —
    // units-enable would then enable a unit that was never installed
    if (wanted === null) throw new Error(`missing unit file: ${ctx.unitsDir}/${unit}`);
    const installed = await readText(`${ctx.home}/.config/systemd/user/${unit}`);
    if (wanted !== installed) staleUnits.push(unit);
  }

  const bridgeEnv = await readText(`${ctx.home}/.config/claude0/bridge.env`);

  const tailscalePresent = Bun.which("tailscale") !== null;
  const tailscaleUp = tailscalePresent && (await probe(["tailscale", "status"])).code === 0;
  const tailscaleServing =
    tailscaleUp && (await probe(["tailscale", "serve", "status"])).out.includes(ctx.bridgePort);

  const claudePresent = Bun.which("claude") !== null;
  let claudeAuthed = false;
  if (claudePresent) {
    try {
      claudeAuthed = JSON.parse((await probe(["claude", "auth", "status"])).out)?.loggedIn === true;
    } catch {}
  }
  const ghAuthed = Bun.which("gh") !== null && (await probe(["gh", "auth", "status"])).code === 0;

  return {
    systemd,
    missingPackages,
    zshPath: Bun.which("zsh"),
    loginShell,
    sysctlFilePresent: existsSync(SYSCTL_FILE),
    oldSysctlFilePresent: existsSync(OLD_SYSCTL_FILE),
    swapActive: swaps !== null && /^\/swapfile /m.test(swaps),
    fstabHasSwap: fstab !== null && /^\/swapfile/m.test(fstab),
    timezone,
    journaldCapPresent: existsSync(JOURNALD_FILE),
    needrestartDirPresent: existsSync("/etc/needrestart"),
    needrestartConfPresent: existsSync(NEEDRESTART_FILE),
    apparmorDirPresent: existsSync("/etc/apparmor.d"),
    apparmorProfilePresent: existsSync(APPARMOR_FILE),
    apparmorParserPresent: Bun.which("apparmor_parser") !== null,
    lingerEnabled: existsSync(`/var/lib/systemd/linger/${ctx.user}`),
    staleUnits,
    bridgeEnvPresent: bridgeEnv !== null,
    bridgeEnvHasPort: bridgeEnv !== null && /^CLAUDE0_BRIDGE_PORT=/m.test(bridgeEnv),
    bunPresent: Bun.which("bun") !== null,
    claudePresent,
    tailscalePresent,
    tailscaleUp,
    tailscaleServing,
    claudeAuthed,
    ghAuthed,
  };
}

const done = (id: string, scope: ProvisionStep["scope"], message: string): ProvisionStep => ({
  id,
  scope,
  verdict: "done",
  message,
  commands: [],
});
const blocked = (id: string, scope: ProvisionStep["scope"], message: string): ProvisionStep => ({
  id,
  scope,
  verdict: "blocked",
  message,
  commands: [],
});
const run = (
  id: string,
  scope: ProvisionStep["scope"],
  message: string,
  commands: Command[],
  action?: ProvisionStep["action"],
): ProvisionStep => ({ id, scope, verdict: "run", message, commands, action });

const sudoTee = (path: string, content: string): Command => ({
  argv: ["sudo", "tee", path],
  stdin: content,
  quiet: true,
});

/**
 * The ordered step list with run/skip verdicts and exact commands. Enumeration
 * follows provision.sh's numbering; execution order batches by privilege (sudo
 * block first) so a sudo credential timeout can't half-apply a step.
 */
export function planProvision(state: SystemState, ctx: ProvisionContext): ProvisionStep[] {
  const steps: ProvisionStep[] = [];

  // 1. packages
  steps.push(
    state.missingPackages.length === 0
      ? done("packages", "sudo", "packages already present")
      : run("packages", "sudo", `installing: ${state.missingPackages.join(" ")}`, [
          { argv: ["sudo", "apt-get", "update", "-qq"] },
          { argv: ["sudo", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", ...state.missingPackages] },
        ]),
  );

  // 1c. login shell — zsh lands at /usr/bin/zsh when the packages step above installs it.
  const zshBin = state.zshPath ?? "/usr/bin/zsh";
  steps.push(
    state.loginShell === zshBin
      ? done("login-shell", "sudo", `login shell already ${zshBin}`)
      : run("login-shell", "sudo", `setting login shell to ${zshBin}`, [
          { argv: ["sudo", "chsh", "-s", zshBin, ctx.user] },
        ]),
  );

  // 2. inotify sysctl (renamed from the legacy csm file, which is removed when found)
  if (state.sysctlFilePresent && !state.oldSysctlFilePresent) {
    steps.push(done("sysctl", "sudo", "inotify sysctl already present"));
  } else {
    const commands: Command[] = [];
    if (!state.sysctlFilePresent) commands.push(sudoTee(SYSCTL_FILE, SYSCTL_CONTENT));
    if (state.oldSysctlFilePresent) commands.push({ argv: ["sudo", "rm", "-f", OLD_SYSCTL_FILE] });
    commands.push({ argv: ["sudo", "sysctl", "--system"], quiet: true, allowFailure: true });
    const message = state.sysctlFilePresent
      ? `removing legacy ${OLD_SYSCTL_FILE}`
      : `writing ${SYSCTL_FILE}${state.oldSysctlFilePresent ? ` (replacing legacy ${OLD_SYSCTL_FILE})` : ""}`;
    steps.push(run("sysctl", "sudo", message, commands));
  }

  // 3. swap — a swapless box livelocks under memory pressure instead of degrading.
  if (state.swapActive) {
    steps.push(done("swap", "sudo", "swapfile already active"));
  } else if (!state.systemd) {
    steps.push(blocked("swap", "sudo", "no systemd (container?) — skipping swapfile"));
  } else {
    const commands: Command[] = [
      { argv: ["sudo", "fallocate", "-l", `${ctx.swapGb}G`, "/swapfile"] },
      { argv: ["sudo", "chmod", "600", "/swapfile"] },
      { argv: ["sudo", "mkswap", "/swapfile"], quiet: true },
      { argv: ["sudo", "swapon", "/swapfile"] },
    ];
    if (!state.fstabHasSwap) commands.push({ argv: ["sudo", "tee", "-a", "/etc/fstab"], stdin: "/swapfile none swap sw 0 0\n", quiet: true });
    steps.push(run("swap", "sudo", `creating ${ctx.swapGb}G swapfile`, commands));
  }

  // 4. timezone — the 24h archive window and staleness heuristics are wall-clock sensitive.
  if (!state.systemd || state.timezone === null) {
    steps.push(blocked("timezone", "sudo", "no timedatectl/systemd — skipping timezone"));
  } else if (state.timezone === ctx.tz) {
    steps.push(done("timezone", "sudo", `timezone already ${ctx.tz}`));
  } else {
    steps.push(
      run("timezone", "sudo", `timezone ${state.timezone} → ${ctx.tz}`, [
        { argv: ["sudo", "timedatectl", "set-timezone", ctx.tz] },
      ]),
    );
  }

  // 5. journald cap
  if (state.journaldCapPresent) {
    steps.push(done("journald", "sudo", "journald cap already present"));
  } else {
    const commands: Command[] = [
      { argv: ["sudo", "mkdir", "-p", "/etc/systemd/journald.conf.d"] },
      sudoTee(JOURNALD_FILE, JOURNALD_CONTENT),
    ];
    if (state.systemd) commands.push({ argv: ["sudo", "systemctl", "restart", "systemd-journald"], allowFailure: true });
    steps.push(run("journald", "sudo", "capping journald at 500M", commands));
  }

  // 6. needrestart list-only — since 24.04 it auto-restarts services after
  // unattended-upgrades and can reach into user managers.
  steps.push(
    state.needrestartDirPresent && !state.needrestartConfPresent
      ? run("needrestart", "sudo", "setting needrestart to list-only", [sudoTee(NEEDRESTART_FILE, NEEDRESTART_CONTENT)])
      : done("needrestart", "sudo", "needrestart config present or needrestart not installed"),
  );

  // 7. AppArmor profile for bubblewrap
  if (state.apparmorDirPresent && !state.apparmorProfilePresent) {
    const commands: Command[] = [sudoTee(APPARMOR_FILE, APPARMOR_CONTENT)];
    if (state.apparmorParserPresent) commands.push({ argv: ["sudo", "apparmor_parser", "-r", APPARMOR_FILE], allowFailure: true });
    steps.push(run("apparmor", "sudo", "installing bwrap AppArmor profile", commands));
  } else {
    steps.push(done("apparmor", "sudo", "bwrap AppArmor profile present or apparmor absent"));
  }

  // 8. linger — without it logind kills the whole tmux server when the last SSH
  // session closes: the single config that silently destroys the setup.
  if (!state.systemd) {
    steps.push(blocked("linger", "sudo", "no systemd — skipping linger"));
  } else if (state.lingerEnabled) {
    steps.push(done("linger", "sudo", "linger already enabled"));
  } else {
    steps.push(run("linger", "sudo", `enabling linger for ${ctx.user}`, [{ argv: ["sudo", "loginctl", "enable-linger", ctx.user] }]));
  }

  // 10. tailscale — install when missing; join is a guided stop, serve when logged in.
  steps.push(
    state.tailscalePresent
      ? done("tailscale-install", "sudo", "tailscale already installed")
      : run("tailscale-install", "sudo", "installing tailscale", [
          { argv: ["bash", "-c", "set -o pipefail; curl -fsSL https://tailscale.com/install.sh | sh"] },
        ]),
  );
  if (!state.systemd || !state.tailscalePresent) {
    steps.push(blocked("tailscale-serve", "sudo", "no systemd/tailscale daemon — skipping tailscale serve"));
  } else if (!state.tailscaleUp) {
    steps.push(blocked("tailscale-serve", "sudo", "tailscale not up — join command in the checklist below"));
  } else if (state.tailscaleServing) {
    steps.push(done("tailscale-serve", "sudo", `tailscale serve already proxying ${ctx.bridgePort}`));
  } else {
    steps.push(
      run("tailscale-serve", "sudo", "enabling tailscale serve for the bridge", [
        { argv: ["sudo", "tailscale", "serve", "--bg", ctx.bridgePort] },
      ]),
    );
  }

  // --- user scope ---

  // 1a/1b. bun + claude via the official installers. Auth is a guided stop, never
  // attempted non-interactively.
  steps.push(
    state.bunPresent
      ? done("bun", "user", "bun already installed")
      : run("bun", "user", "installing bun", [
          { argv: ["bash", "-c", "set -o pipefail; curl -fsSL https://bun.sh/install | bash"] },
        ]),
  );
  steps.push(
    state.claudePresent
      ? done("claude", "user", "claude already installed")
      : run("claude", "user", "installing claude", [
          { argv: ["bash", "-c", "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"] },
        ]),
  );

  // 8a. product units — installed from the repo, enabled independently: one
  // missing/broken unit must not silently leave tmux disabled while the rest
  // succeed (this happened on the first VM cutover).
  if (!state.systemd) {
    steps.push(blocked("units", "user", "no systemd — skipping user units"));
    steps.push(blocked("units-enable", "user", "no systemd — skipping unit enablement"));
  } else {
    steps.push(
      state.staleUnits.length === 0
        ? done("units", "user", "user units already current")
        : run("units", "user", `installing user units: ${state.staleUnits.join(" ")}`, [
            { argv: ["mkdir", "-p", `${ctx.home}/.config/systemd/user`] },
            ...state.staleUnits.map((unit) => ({
              argv: ["cp", `${ctx.unitsDir}/${unit}`, `${ctx.home}/.config/systemd/user/${unit}`],
            })),
          ]),
    );
    steps.push(
      run("units-enable", "user", `enabling user units: ${PRODUCT_UNITS.join(" ")}`, [
        { argv: ["systemctl", "--user", "daemon-reload"] },
        ...PRODUCT_UNITS.map((unit) => ({
          argv: ["systemctl", "--user", "enable", unit],
          quiet: true,
          allowFailure: true,
          failNote: `could not enable user unit ${unit}`,
        })),
      ]),
    );
  }

  // 8b. bridge token — minted once, consumed by claude0-bridge.service via
  // EnvironmentFile. TS-native action so the token never appears in the plan.
  if (!state.systemd) {
    steps.push(blocked("bridge-token", "user", "no systemd — skipping bridge token"));
  } else if (state.bridgeEnvPresent && (ctx.bridgePort === "8473" || state.bridgeEnvHasPort)) {
    steps.push(done("bridge-token", "user", "bridge token already minted"));
  } else {
    const message = state.bridgeEnvPresent
      ? `recording bridge port ${ctx.bridgePort} → bridge.env`
      : `minting bridge token → ${ctx.home}/.config/claude0/bridge.env`;
    steps.push(run("bridge-token", "user", message, [], (c) => ensureBridgeEnv(c)));
  }

  return steps;
}

/** 43 alphanumeric chars, same shape provision.sh minted from /dev/urandom. */
export function generateBridgeToken(): string {
  let token = "";
  while (token.length < 43) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    token += Buffer.from(bytes).toString("base64").replace(/[^a-zA-Z0-9]/g, "");
  }
  return token.slice(0, 43);
}

/** Mint the bridge token (0600) and/or record a non-default port. */
export function ensureBridgeEnv(ctx: ProvisionContext): void {
  const dir = `${ctx.home}/.config/claude0`;
  const path = `${dir}/bridge.env`;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, `CLAUDE0_BRIDGE_TOKEN=${generateBridgeToken()}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  // A non-default port must reach the bridge itself, not just tailscale serve: the
  // server binds CLAUDE0_BRIDGE_PORT from this EnvironmentFile (default 8473).
  if (ctx.bridgePort !== "8473" && !/^CLAUDE0_BRIDGE_PORT=/m.test(readFileSync(path, "utf8"))) {
    appendFileSync(path, `CLAUDE0_BRIDGE_PORT=${ctx.bridgePort}\n`);
  }
}

/**
 * The auth checklist printed after all steps — mirrors what `claude0 doctor`
 * checks, so setup's final output is doctor's TODO list. Guided stops are never
 * failures.
 */
export function guidedStops(state: SystemState, ctx: ProvisionContext): string[] {
  const todos: string[] = [];
  if (!state.claudeAuthed) todos.push("Claude Code login:  claude   (complete the interactive sign-in)");
  if (!state.ghAuthed) todos.push("GitHub CLI login:   gh auth login");
  if (!state.tailscaleUp) {
    todos.push(
      "Tailscale join:     sudo tailscale up --ssh --hostname=<name> --authkey=<pre-tagged key>   (tag at JOIN time or key expiry stays on)",
    );
  }
  const lines: string[] = [];
  if (todos.length > 0) {
    lines.push("", "Remaining manual steps (auth is interactive by design):");
    for (const todo of todos) lines.push(`  [todo] ${todo}`);
  }
  lines.push(
    "",
    `Client pairing: the bridge token lives in ${ctx.home}/.config/claude0/bridge.env — paste it into portkey on first connect.`,
    "Reboot once to prove unit autostart.",
  );
  return lines;
}

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** `--dry-run`: the plan in execution order, no side effects, no sudo prompt. */
export function renderDryRun(steps: ProvisionStep[], state: SystemState, ctx: ProvisionContext): string[] {
  const lines = ["claude0 setup --role host --dry-run (nothing executed):", ""];
  for (const step of steps) {
    const verdict = step.verdict === "run" ? "run " : "skip";
    lines.push(`  [${verdict}] ${step.id.padEnd(16)} ${step.message}`);
    for (const command of step.commands) lines.push(`           $ ${command.argv.join(" ")}`);
  }
  lines.push(...guidedStops(state, ctx));
  return lines;
}

/** Default executor: inherit stdio so apt/installer output streams to the user. */
async function runCommand(command: Command): Promise<number> {
  const child = Bun.spawn(command.argv, {
    stdin: command.stdin !== undefined ? Buffer.from(command.stdin) : "inherit",
    stdout: command.quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

/**
 * Run the planned steps in order, provision.sh's set -e semantics: a failed
 * required command aborts with the command named; allowFailure commands print
 * their failNote and continue.
 */
export async function executeProvision(
  steps: ProvisionStep[],
  ctx: ProvisionContext,
  print: (line: string) => void = console.log,
  exec: (command: Command) => Promise<number> = runCommand,
): Promise<void> {
  for (const step of steps) {
    if (step.verdict === "blocked") {
      print(`${YELLOW}[skip]${RESET} ${step.message}`);
      continue;
    }
    print(`${CYAN}[setup]${RESET} ${step.message}`);
    if (step.verdict === "done") continue;
    for (const command of step.commands) {
      const code = await exec(command);
      if (code !== 0) {
        if (command.allowFailure) {
          if (command.failNote) print(`${YELLOW}[skip]${RESET} ${command.failNote}`);
          continue;
        }
        throw new Error(`provisioning failed at ${step.id}: \`${command.argv.join(" ")}\` exited ${code}`);
      }
    }
    step.action?.(ctx);
  }
}

/** Probe → plan → one sudo authorization → execute → guided checklist. */
export async function runHostProvisioning(ctx: ProvisionContext, print: (line: string) => void = console.log): Promise<void> {
  const state = await probeSystemState(ctx);
  const steps = planProvision(state, ctx);
  if (steps.some((step) => step.verdict === "run" && step.scope === "sudo")) {
    // One upfront authorization; the batched sudo commands reuse the cached credential.
    const sudo = Bun.spawn(["sudo", "-v"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if ((await sudo.exited) !== 0) throw new Error("sudo authorization failed — host provisioning needs one sudo pass");
  }
  await executeProvision(steps, ctx, print);
  for (const line of guidedStops(state, ctx)) print(line);
}
