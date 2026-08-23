#!/usr/bin/env -S bun --env-file=/dev/null
export {};

function help() {
  console.log(`
  \x1b[1mclaude0\x1b[0m — Claude0

  \x1b[1mUsage:\x1b[0m  claude0 [command]

  \x1b[1mCommands:\x1b[0m
    \x1b[36m(none)\x1b[0m              Open the full TUI
    \x1b[36mnext\x1b[0m                Switch to next attention session (oldest first)
    \x1b[36mreset\x1b[0m               Reset all window names and clear attention state
    \x1b[36mstatus\x1b[0m              Tmux status-right monitor (⚡3 🔄2)
    \x1b[36mlist\x1b[0m                Print sessions with status, repo, and context %
    \x1b[36mswitch <name>\x1b[0m       Fuzzy-match a session by name and switch to it
    \x1b[36mnotify <message>\x1b[0m    Web-push a message to every subscribed device
    \x1b[36msetup\x1b[0m               Install Claude0 for this machine's role (--role local|host|client)
    \x1b[36mconfig\x1b[0m              Print the absolute user config path
    \x1b[36mterminal [command]\x1b[0m  Manage local/remote terminal attachment
    \x1b[36msave-sessions\x1b[0m       Snapshot pane→session map for tmux-resurrect
    \x1b[36mrestore-sessions\x1b[0m    Restore Claude sessions after tmux-resurrect restore
    \x1b[36mbridge\x1b[0m              Serve the HTTP/SSE bridge for the mobile web app
    \x1b[36mdaemon\x1b[0m              Inbox daemon: snooze wake pass (launchd runs this)

  \x1b[1mOptions:\x1b[0m
    \x1b[36m-h, --help\x1b[0m          Show this help message

  Run \x1b[36mclaude0 terminal --help\x1b[0m for terminal commands.
`.trimEnd());
}

function terminalHelp() {
  console.log(`
  \x1b[1mclaude0 terminal\x1b[0m — Manage terminal attachment

  \x1b[1mUsage:\x1b[0m
    \x1b[36mclaude0 terminal\x1b[0m                   Attach using config.json's defaultTarget
    \x1b[36mclaude0 terminal local\x1b[0m             Attach to local tmux for this invocation
    \x1b[36mclaude0 terminal remote\x1b[0m            Attach to the configured remote host
    \x1b[36mclaude0 terminal status\x1b[0m            Show the effective terminal configuration

  \x1b[1mOptions:\x1b[0m
    \x1b[36m-h, --help\x1b[0m                     Show this help message
`.trimEnd());
}

const cmd = process.argv[2];

async function runTerminal(args: string[]): Promise<never> {
  const home = process.env.HOME;
  const installed = home ? `${home}/.config/claude0/terminal-launcher` : "";
  const bundled = `${import.meta.dir}/../config/terminal-launcher`;
  const command = installed && (await Bun.file(installed).exists())
    ? [installed, ...args]
    : ["/bin/sh", bundled, ...args];
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}

switch (cmd) {
  case undefined:
    await import("../src/index");
    break;
  case "-h":
  case "--help":
    help();
    break;
  case "help":
    if (process.argv[3] === "terminal") terminalHelp();
    else help();
    break;
  case "next":
    await import("../src/cli").then((m) => m.next());
    break;
  case "reset":
    await import("../src/cli").then((m) => m.reset());
    break;
  case "status":
    await import("../src/monitor");
    break;
  case "list":
    await import("../src/cli").then((m) => m.list());
    break;
  case "switch":
    await import("../src/cli").then((m) => m.switchTo(process.argv[3]));
    break;
  case "setup": {
    // "--role client" and "--role=client"; a missing value becomes "" so the
    // validator errors instead of silently falling back to inference.
    let role: string | undefined;
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i]!;
      if (arg === "--role") role = process.argv[i + 1] ?? "";
      else if (arg.startsWith("--role=")) role = arg.slice("--role=".length);
    }
    await import("../src/cli").then((m) => m.setup(role));
    break;
  }
  case "config": {
    const { PATHS, ensureUserConfig } = await import("../src/core/config");
    await ensureUserConfig();
    console.log(PATHS.config);
    break;
  }
  case "terminal": {
    const args = process.argv.slice(3);
    const subcommand = args[0];
    if (args.some((arg) => arg === "-h" || arg === "--help" || arg === "help")) {
      terminalHelp();
      break;
    }
    await runTerminal(args);
    break;
  }
  case "save-sessions":
    await import("../src/cli").then((m) => m.saveSessions());
    break;
  case "restore-sessions":
    await import("../src/cli").then((m) => m.restoreSessions());
    break;
  case "question-hook":
    // Internal — invoked by pretooluse.sh to hold+answer an intercepted AskUserQuestion.
    await import("../src/cli").then((m) => m.questionHook());
    break;
  case "daemon":
    await import("../src/cli").then((m) => m.daemon());
    break;
  case "sidebar-ctl":
    // Internal — M-s/M-S bindings send focus/toggle to the renderer.
    await import("../src/cli").then((m) => m.sidebarCtl(process.argv[3], process.argv[4]));
    break;
  case "bridge":
    try {
      await import("../src/bridge/server").then((m) => m.startBridge());
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  case "notify":
    await import("../src/cli").then((m) => m.notify(process.argv.slice(3).join(" ")));
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
