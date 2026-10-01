/**
 * Integration coverage for the generated `session-start.sh` pane→session mapper,
 * run as installed (written by `setup()`) against a stubbed `ps` on PATH. Pins that a
 * nested `claude -p` (spawned from a session's Bash tool: inherits the parent's
 * TMUX_PANE, has no controlling tty) never overwrites the parent's `panes/` file —
 * that clobber left the parent session listed but unclickable in the inbox.
 *
 * `home` helper first — `setup()` writes the hook under the temp $HOME root.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { setup } from "./cli";

const hookPath = `${TEST_HOME}/.config/claude0/hooks/session-start.sh`;
const stubBin = `${TEST_HOME}/stub-bin-ps`;
const paneFile = `${TEST_HOME}/.config/claude0/panes/%1`;

beforeAll(async () => {
  // Same staleness trap as cli.pretooluse.test.ts: setup() only rewrites a script whose
  // installed HOOK_VERSION is older, and a leftover client role skips the install.
  rmSync(hookPath, { force: true });
  rmSync(`${TEST_HOME}/.config/claude0/config.json`, { force: true });
  await setup();

  // Stub `ps`: prints STUB_TTY as the tty of whatever pid is asked about.
  rmSync(stubBin, { recursive: true, force: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(`${stubBin}/ps`, `#!/bin/bash\necho "$STUB_TTY"\n`);
  chmodSync(`${stubBin}/ps`, 0o755);
});

beforeEach(() => rmSync(paneFile, { force: true }));

async function runHook(env: Record<string, string>): Promise<void> {
  const { CLAUDE_PID: _, ...base } = process.env;
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: Buffer.from(JSON.stringify({ session_id: "sess-a", hook_event_name: "SessionStart" })),
    env: { ...base, HOME: TEST_HOME, PATH: `${stubBin}:${process.env.PATH}`, TMUX_PANE: "%1", ...env },
  });
  expect(await proc.exited).toBe(0);
}

test("the pane's own claude (has a tty) records its session for the pane", async () => {
  await runHook({ CLAUDE_PID: "123", STUB_TTY: "pts/26" });
  expect(readFileSync(paneFile, "utf8")).toBe("sess-a");
});

test("a nested tty-less claude does not overwrite the pane's mapping (procps and BSD forms)", async () => {
  for (const tty of ["?", "??"]) {
    writeFileSync(paneFile, "parent-sess");
    await runHook({ CLAUDE_PID: "123", STUB_TTY: `  ${tty}  ` });
    expect(readFileSync(paneFile, "utf8")).toBe("parent-sess");
  }
});

test("without CLAUDE_PID the hook still records the pane (no tty check possible)", async () => {
  await runHook({ STUB_TTY: "?" });
  expect(existsSync(paneFile)).toBe(true);
});
