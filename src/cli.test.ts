/**
 * `setup()` idempotency (Inc setup). Two runs under a temp $HOME must leave exactly
 * one Claude0 registration per event, preserve pre-existing user hooks + other settings
 * keys, and write the hook scripts stamped with the current HOOK_VERSION.
 *
 * `home` helper first — cli → hook-events → config freezes paths from $HOME; setup
 * itself re-reads homedir() at call time, so it targets the same temp HOME.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readlinkSync, existsSync, symlinkSync, statSync } from "node:fs";
import { setup, HOOK_VERSION } from "./cli";
import { HOLD_WINDOW_MS } from "./core/approval";

const claudeDir = `${TEST_HOME}/.claude`;
const settingsPath = `${claudeDir}/settings.json`;
const configDir = `${TEST_HOME}/.config/claude0`;
const hooksDir = `${configDir}/hooks`;
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreToolUse",
];

beforeEach(() => {
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.local/bin/claude0`, { force: true });
  rmSync(`${TEST_HOME}/.local/bin/c0`, { force: true });
  rmSync(`${TEST_HOME}/.zshrc`, { force: true });
  rmSync(`${TEST_HOME}/.tmux.conf`, { force: true });
  rmSync(`${TEST_HOME}/.config/tmux`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.config/zsh`, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.tmux`, { recursive: true, force: true });
  mkdirSync(claudeDir, { recursive: true });
  // Pre-existing user content that setup() must NOT clobber.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook" }] }],
      },
    }),
  );
});

test("setup installs Claude0-owned terminal fragments and imports them idempotently", async () => {
  writeFileSync(`${TEST_HOME}/.zshrc`, "# user zsh config\n");
  writeFileSync(`${TEST_HOME}/.tmux.conf`, "# user tmux config\n");
  mkdirSync(`${TEST_HOME}/.local/bin`, { recursive: true });

  await setup();
  await setup();

  const shellFragment = readFileSync(`${configDir}/shell.zsh`, "utf8");
  const tmuxFragment = readFileSync(`${configDir}/tmux.conf`, "utf8");
  expect(shellFragment).not.toContain("PROMPT=");
  expect(tmuxFragment).toContain("display-popup -E -w 90% -h 85% claude0 tui");
  expect(tmuxFragment).toContain("@claude0_status");
  expect(tmuxFragment).not.toContain("@plugin");
  expect(tmuxFragment).not.toContain("catppuccin");
  expect(readlinkSync(`${TEST_HOME}/.local/bin/claude0`)).toBe(`${import.meta.dir}/../bin/claude0.ts`);
  expect(readlinkSync(`${TEST_HOME}/.local/bin/c0`)).toBe(`${import.meta.dir}/../bin/claude0.ts`);
  expect(readFileSync(`${configDir}/terminal-launcher`, "utf8")).toContain(
    "MOSH_SERVER_NETWORK_TMOUT=2592000",
  );
  const zshrc = readFileSync(`${TEST_HOME}/.zshrc`, "utf8");
  const tmux = readFileSync(`${TEST_HOME}/.tmux.conf`, "utf8");
  expect(zshrc).toContain("# user zsh config");
  expect(tmux).toContain("# user tmux config");
  expect(zshrc.match(/\.config\/claude0\/shell\.zsh/g)).toHaveLength(2); // test + source in one import line
  expect(tmux.match(/\.config\/claude0\/tmux\.conf/g)).toHaveLength(2); // test + source in one import line
});

test("setup bakes terminal.* into the launcher and re-renders when config changes", async () => {
  const { DEFAULT_CONFIG } = await import("./core/config");
  const config = {
    ...DEFAULT_CONFIG,
    deployment: { role: "local" },
    terminal: { defaultTarget: "remote", remoteHost: "vm.tailnet.ts.net", localSession: "desk", remoteSession: "vm" },
  };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(`${configDir}/config.json`, JSON.stringify(config));

  await setup();
  const launcher = readFileSync(`${configDir}/terminal-launcher`, "utf8");
  expect(launcher).toContain("'vm.tailnet.ts.net'");
  expect(launcher).toContain("'desk'");
  expect(launcher).toContain("'vm'");
  expect(launcher).toContain("'remote'");
  expect(launcher).not.toContain("{{");
  expect(launcher).not.toContain("jq");

  writeFileSync(
    `${configDir}/config.json`,
    JSON.stringify({ ...config, terminal: { ...config.terminal, remoteHost: "vm2.tailnet.ts.net" } }),
  );
  await setup();
  expect(readFileSync(`${configDir}/terminal-launcher`, "utf8")).toContain("'vm2.tailnet.ts.net'");
});

/** Count Claude0 registrations (command points into the Claude0 hooks dir) for an event. */
function hookEntries(settings: any, event: string): any[] {
  const entries = settings.hooks?.[event] ?? [];
  return entries.filter(
    (e: any) =>
      Array.isArray(e.hooks) &&
      e.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(hooksDir)),
  );
}

/** The Claude0 registration for an event whose command runs the given script. */
function hookEntry(settings: any, event: string, script: string): any {
  return hookEntries(settings, event).find((e: any) =>
    e.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(script)),
  );
}

test("a $HOME-portable registration is recognized, kept verbatim, and not duplicated", async () => {
  // A dotfiles-managed settings.json registers hooks as $HOME/... so the same
  // file works on machines with different homes. Setup must treat that as the
  // registration — not append this machine's absolute form beside it.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: 'bash "$HOME/.config/claude0/hooks/session-start.sh"' }] },
        ],
      },
    }),
  );

  await setup();

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const commands = settings.hooks.SessionStart.flatMap((e: any) => e.hooks.map((h: any) => h.command));
  expect(commands.filter((c: string) => c.includes("session-start.sh"))).toEqual([
    'bash "$HOME/.config/claude0/hooks/session-start.sh"',
  ]);
});

test("zsh import is skipped when a dotfiles layer already sources the fragment", async () => {
  writeFileSync(`${TEST_HOME}/.zshrc`, "# user zsh config\n");
  mkdirSync(`${TEST_HOME}/.config/zsh`, { recursive: true });
  writeFileSync(
    `${TEST_HOME}/.config/zsh/common.zsh`,
    '[[ -r "$HOME/.config/claude0/shell.zsh" ]] && source "$HOME/.config/claude0/shell.zsh"\n',
  );

  await setup();

  const zshrc = readFileSync(`${TEST_HOME}/.zshrc`, "utf8");
  expect(zshrc).not.toContain("shell.zsh"); // sourced via common.zsh already
  // the tmux side has no aux import, so it still gets the entry-point line
  expect(readFileSync(`${TEST_HOME}/.tmux.conf`, "utf8")).toContain(".config/claude0/tmux.conf");
});

test("zsh import dedup sees a stow-symlinked aux file", async () => {
  writeFileSync(`${TEST_HOME}/.zshrc`, "# user zsh config\n");
  mkdirSync(`${TEST_HOME}/dotfiles`, { recursive: true });
  writeFileSync(
    `${TEST_HOME}/dotfiles/common.zsh`,
    '[[ -r "$HOME/.config/claude0/shell.zsh" ]] && source "$HOME/.config/claude0/shell.zsh"\n',
  );
  mkdirSync(`${TEST_HOME}/.config/zsh`, { recursive: true });
  symlinkSync(`${TEST_HOME}/dotfiles/common.zsh`, `${TEST_HOME}/.config/zsh/common.zsh`);

  await setup();

  const zshrc = readFileSync(`${TEST_HOME}/.zshrc`, "utf8");
  expect(zshrc).not.toContain("shell.zsh"); // sourced via the symlinked common.zsh
});

test("running setup() twice leaves exactly one Claude0 entry per event and preserves user content", async () => {
  await setup();
  await setup();

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  // Other top-level keys preserved.
  expect(settings.model).toBe("opus");

  // Idempotent per script after two runs. PreToolUse deliberately carries two
  // registrations (approval + question).
  for (const event of EVENTS) {
    const wanted = event === "PreToolUse" ? 2 : 1;
    expect(hookEntries(settings, event)).toHaveLength(wanted);
  }

  // The pre-existing user hook on SessionStart survives alongside the Claude0 one.
  const userHook = settings.hooks.SessionStart.some(
    (e: any) => e.hooks.some((h: any) => h.command === "/usr/local/bin/my-own-hook"),
  );
  expect(userHook).toBe(true);
  expect(settings.hooks.SessionStart.length).toBe(2); // user + Claude0

  // The approval hook keeps the short kill deadline (600s window + grace) — a hung
  // ordinary tool call must stay killable; only the question entry may hold for hours.
  const pre = hookEntry(settings, "PreToolUse", "/pretooluse.sh");
  expect(pre.hooks[0].timeout).toBe(615);
  expect(pre.matcher).toBeUndefined(); // all tools
  const q = hookEntry(settings, "PreToolUse", "/question-pretooluse.sh");
  expect(q.matcher).toBe("AskUserQuestion");
  expect(q.hooks[0].timeout).toBe(14415); // 4h question window + kill grace
});

test("the registered kill timeout outlasts the window the hook poll loops run to", async () => {
  // Claude counts its timeout from hook spawn; the loops can only start once the process
  // is up. If the kill isn't strictly later, it lands first and the hook dies before the
  // cleanup that un-registers its marker — the orphan the pid gate then has to catch.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const registered = hookEntries(settings, "PreToolUse")[0].hooks[0].timeout * 1000;
  expect(registered).toBeGreaterThan(HOLD_WINDOW_MS);
});

test("setup() repairs a stale timeout on an already-registered hook", async () => {
  // The registration is matched on command path, so without an explicit reconcile an
  // install from an older version would keep its old kill deadline forever.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  hookEntries(settings, "PreToolUse")[0].hooks[0].timeout = 600; // as an older version left it
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  await setup();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(hookEntry(after, "PreToolUse", "/pretooluse.sh").hooks[0].timeout).toBe(615);
  expect(hookEntries(after, "PreToolUse")).toHaveLength(2); // repaired, not duplicated
});

test("setup() writes every hook script stamped with the current HOOK_VERSION", async () => {
  await setup();
  for (const name of [
    "session-start",
    "event",
    "pretooluse",
    "question-pretooluse",
  ]) {
    const path = `${hooksDir}/${name}.sh`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(`# HOOK_VERSION=${HOOK_VERSION}`);
  }
});

test("hook gates read client_activity on every platform — no uname branch, no frontmost probe", async () => {
  // Presence is keystroke recency everywhere: an attached client alone is not
  // presence (a remote host's persistent SSH attach is the steady state), and
  // frontmost-app probes would hardcode a terminal app name.
  await setup();
  const pre = readFileSync(`${hooksDir}/pretooluse.sh`, "utf8");
  expect(pre).toContain("#{client_activity}");
  expect(pre).not.toContain("uname");
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  expect(q).toContain("#{client_activity}");
  expect(q).not.toContain("uname");
  expect(q).not.toContain("lsappinfo");
  // The window constant is interpolated from core/presence.ts, not hand-copied.
  expect(q).toMatch(/-le 60\b/);
  expect(pre).toMatch(/-le 60\b/);
});

test("setup() registers hook commands as explicit quoted bash invocations", async () => {
  // Claude runs hook commands via /bin/sh -c — dash on Debian-family hosts — so the
  // registration must name bash itself, and quote the path against spaces.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const event of EVENTS) {
    for (const entry of hookEntries(settings, event)) {
      for (const h of entry.hooks) {
        expect(h.command).toMatch(/^bash "[^"]+\.sh"$/);
      }
    }
  }
});

test("setup() upgrades a bare-path command from an older install to the bash form", async () => {
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const entry = hookEntry(settings, "SessionStart", "/session-start.sh");
  entry.hooks[0].command = `${hooksDir}/session-start.sh`; // as an older version registered it
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  await setup();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const upgraded = hookEntry(after, "SessionStart", "/session-start.sh");
  expect(upgraded.hooks[0].command).toBe(`bash "${hooksDir}/session-start.sh"`);
  expect(hookEntries(after, "SessionStart")).toHaveLength(1); // upgraded, not duplicated
});

test("question hook reads marker mtime via the GNU→BSD stat fallback chain", async () => {
  // `stat -f %m` is BSD-only; on GNU hosts it fails to `echo 0`, which reads as a
  // dead bridge consumer and silently disables the question intercept entirely.
  await setup();
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  expect(q).toContain('stat -c %Y "$M" 2>/dev/null || stat -f %m "$M" 2>/dev/null || echo 0');
});

test("AskUserQuestion is delegated: pretooluse.sh exits for it, question-pretooluse.sh intercepts", async () => {
  await setup();
  const pre = readFileSync(`${hooksDir}/pretooluse.sh`, "utf8");
  // The approval script logs the event, then bails — its short kill timeout must never
  // apply to a question hold, and the matched entry would otherwise double-intercept.
  expect(pre).toContain('[ "$TOOL" = "AskUserQuestion" ] && exit 0');
  expect(pre).not.toContain("claude0 question-hook");
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  // The intercept gates: tracked pane + live marker + focus, then claude0 question-hook.
  expect(q).toContain("claude0 question-hook");
  expect(q).toContain("bridge-consumer");
  expect(q).toContain("panes/$TMUX_PANE");
  expect(q).toContain("#{client_activity}");
  // No claude-version gate (dropped 2026-07-18) — updatedInput is assumed forward-compatible.
  expect(q).not.toContain("claude --version");
});

test("setup() manages the daemon with launchd only on macOS", async () => {
  const plistPath = `${TEST_HOME}/Library/LaunchAgents/com.claude0.daemon.plist`;
  rmSync(plistPath, { force: true });

  await setup();
  if (process.platform !== "darwin") {
    expect(existsSync(plistPath)).toBe(false);
    return;
  }

  const plist = readFileSync(plistPath, "utf8");
  expect(plist).toContain("<string>com.claude0.daemon</string>");
  expect(plist).toContain("<string>daemon</string>");
  expect(plist).toContain(`<string>${Bun.which("bun") ?? process.execPath}</string>`);
  expect(plist).toContain("<key>KeepAlive</key><true/>");

  // Second run leaves it byte-identical (the change check gates launchctl reloads).
  await setup();
  expect(readFileSync(plistPath, "utf8")).toBe(plist);
});

test("setup() creates the sidebar autostart marker on a fresh machine", async () => {
  const { PATHS } = await import("./core/config");
  const marker = `${PATHS.dir}/inbox-sidebar-autostart-default`;
  rmSync(marker, { force: true });
  await setup();
  expect(await Bun.file(marker).exists()).toBe(true);
});

test("setup without a user-managed resurrect renders the claude0-owned run-shell line", async () => {
  await setup();
  const fragment = readFileSync(`${configDir}/tmux.conf`, "utf8");
  expect(fragment).toContain(
    `run-shell '${TEST_HOME}/.config/claude0/plugins/tmux-resurrect/resurrect.tmux'`,
  );
  expect(fragment).not.toContain("{{RESURRECT_LOAD}}");
  // The clone itself never runs under the test seam — rendering only, no network.
  expect(existsSync(`${configDir}/plugins`)).toBe(false);
});

test("a user-managed TPM resurrect suppresses the run-shell line and the clone", async () => {
  const userCopy = `${TEST_HOME}/.config/tmux/plugins/tmux-resurrect`;
  mkdirSync(`${userCopy}/scripts`, { recursive: true });
  writeFileSync(`${userCopy}/scripts/save.sh`, "#!/bin/bash\n");

  await setup();
  const fragment = readFileSync(`${configDir}/tmux.conf`, "utf8");
  expect(fragment).not.toContain("resurrect.tmux"); // the TPM copy loads itself
  expect(fragment).toContain("@resurrect-hook-post-save-all 'claude0 save-sessions'");
  expect(existsSync(`${configDir}/plugins`)).toBe(false);
});

test("client setup renders no resurrect run-shell line — a client owns no tmux server", async () => {
  await setup("client");
  expect(readFileSync(`${configDir}/tmux.conf`, "utf8")).not.toContain("resurrect.tmux");
});

test("setup rejects an unknown --role value", async () => {
  await expect(setup("server")).rejects.toThrow("--role must be local, host or client");
});

test("setup pins explicit and non-local roles, never an inferred local", async () => {
  await setup();
  const config = JSON.parse(readFileSync(`${TEST_HOME}/.config/claude0/config.json`, "utf8"));
  // linux infers host and pins it; darwin infers local, which stays unpinned so a
  // later remote-target config re-infers client instead of trusting a frozen default.
  expect(config.deployment).toEqual(process.platform === "darwin" ? undefined : { role: "host" });
});

test("role host refuses on darwin regardless of the machine running the tests", async () => {
  const { resolveSetupRole } = await import("./cli");
  await expect(resolveSetupRole("host", "darwin")).rejects.toThrow("requires a linux/systemd machine");
  await expect(resolveSetupRole(undefined, "darwin")).resolves.toBe("local");
});

test("setup --dry-run refuses off a linux host and persists nothing", async () => {
  await expect(setup("client", { dryRun: true })).rejects.toThrow("previews host provisioning");
  // dry-run pins no role and creates no config
  expect(existsSync(`${TEST_HOME}/.config/claude0/config.json`)).toBe(false);
});

test("client setup installs no hooks, no daemon, no sidebar marker — but keeps the terminal layer", async () => {
  await setup("client");
  const { PATHS } = await import("./core/config");

  // Terminal layer present.
  expect(existsSync(`${TEST_HOME}/.local/bin/claude0`)).toBe(true);
  expect(existsSync(`${TEST_HOME}/.config/claude0/terminal-launcher`)).toBe(true);

  // No fresh hooks: scripts absent, settings carry only the user's own hook.
  expect(existsSync(`${TEST_HOME}/.config/claude0/hooks/session-start.sh`)).toBe(false);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const commands = Object.values(settings.hooks ?? {})
    .flat()
    .flatMap((entry: any) => entry.hooks ?? [])
    .map((h: any) => h.command);
  expect(commands).toEqual(["/usr/local/bin/my-own-hook"]);

  // No daemon plist, no sidebar autostart marker.
  expect(existsSync(`${TEST_HOME}/Library/LaunchAgents/com.claude0.daemon.plist`)).toBe(false);
  expect(existsSync(`${PATHS.dir}/inbox-sidebar-autostart-default`)).toBe(false);

  const config = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(config.deployment).toEqual({ role: "client" });
});

test("client setup upgrades hooks already present instead of leaving them stale", async () => {
  await setup(); // full install (local/host) puts the hooks in place
  const hookPath = `${TEST_HOME}/.config/claude0/hooks/session-start.sh`;
  const current = readFileSync(hookPath, "utf8");
  writeFileSync(hookPath, current.replace(/^# HOOK_VERSION=\d+/m, "# HOOK_VERSION=1"));

  await setup("client");
  expect(readFileSync(hookPath, "utf8")).toBe(current);
});

test("client setup retires a previously installed daemon plist", async () => {
  if (process.platform !== "darwin") return; // retire lives behind the launchd (darwin) gate
  const plistPath = `${TEST_HOME}/Library/LaunchAgents/com.claude0.daemon.plist`;
  mkdirSync(`${TEST_HOME}/Library/LaunchAgents`, { recursive: true });
  writeFileSync(plistPath, "<plist/>");
  await setup("client");
  expect(existsSync(plistPath)).toBe(false);
});

test("client setup restores a registered hook script that vanished", async () => {
  // A registration exists (portable $HOME form) but the script file is gone —
  // the client's never-install-fresh rule must not leave it exiting 127 forever.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: 'bash "$HOME/.config/claude0/hooks/session-start.sh"' }] },
        ],
      },
    }),
  );
  await setup("client");
  const script = readFileSync(`${TEST_HOME}/.config/claude0/hooks/session-start.sh`, "utf8");
  expect(script).toContain(`# HOOK_VERSION=`);
});

// --- image paste Service (client Mac) ---

const serviceDir = `${TEST_HOME}/Library/Services/claude0 paste-image.workflow`;

async function configureRemoteHost(host: string | null): Promise<void> {
  const { PATHS, ensureUserConfig } = await import("./core/config");
  await ensureUserConfig();
  const config = JSON.parse(readFileSync(PATHS.config, "utf8"));
  config.terminal.remoteHost = host;
  config.terminal.defaultTarget = host ? "remote" : "local";
  writeFileSync(PATHS.config, JSON.stringify(config));
}

test("client setup renders the image paste Service from the templates, idempotently, and retires it when the role changes", async () => {
  if (process.platform !== "darwin") return; // Services (and the pbs hotkey) exist only on macOS
  rmSync(serviceDir, { recursive: true, force: true });
  await configureRemoteHost("vm.ts.net");
  await setup("client");
  const info = readFileSync(`${serviceDir}/Contents/Info.plist`, "utf8");
  const wflow = readFileSync(`${serviceDir}/Contents/document.wflow`, "utf8");
  expect(info).toContain("<string>claude0 paste-image</string>");
  expect(info).toContain("<string>com.mitchellh.ghostty</string>");
  expect(wflow).toContain("exec &quot;$HOME/.local/bin/claude0&quot; paste-image");
  expect(info + wflow).not.toContain("{{");

  const before = statSync(`${serviceDir}/Contents/document.wflow`).mtimeMs;
  await setup("client");
  expect(statSync(`${serviceDir}/Contents/document.wflow`).mtimeMs).toBe(before);

  await setup("local");
  expect(existsSync(serviceDir)).toBe(false);
});

test("client setup without a remote host installs no Service", async () => {
  if (process.platform !== "darwin") return;
  rmSync(serviceDir, { recursive: true, force: true });
  await configureRemoteHost(null);
  await setup("client");
  expect(existsSync(serviceDir)).toBe(false);
});

test("setup never writes a macOS Service bundle off darwin", async () => {
  if (process.platform === "darwin") return;
  await configureRemoteHost("vm.ts.net");
  await setup("client");
  expect(existsSync(`${TEST_HOME}/Library/Services`)).toBe(false);
});
