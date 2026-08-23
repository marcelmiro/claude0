/**
 * Integration coverage for the generated `pretooluse.sh` detached-approval branch,
 * exercising the real installed-shape script (written by `setup()`) against a
 * stubbed `tmux` on PATH. Not pure — spawns bash — but it's the only thing that
 * pins the ADR-3 fix: an away session must NOT block on calls Claude would
 * auto-approve (bypassPermissions/auto modes, read-only tools), or autonomous/
 * subagent-heavy runs stall up to 600s per call — and must not block at all when
 * no phone is watching (no fresh bridge-consumer marker: nobody could answer).
 * Tools that CAN prompt, with a phone watching, must still block-poll.
 *
 * `home` helper first — `setup()` writes the hook under the temp $HOME root.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { setup } from "./cli";

const hookPath = `${TEST_HOME}/.config/claude0/hooks/pretooluse.sh`;
const stubBin = `${TEST_HOME}/stub-bin`;
const decisionsDir = `${TEST_HOME}/.config/claude0/decisions`;
const pendingDir = `${TEST_HOME}/.config/claude0/pending`;

beforeAll(async () => {
  // TEST_HOME persists between runs and `setup()` only rewrites a script when the
  // installed HOOK_VERSION is older — so without this the suite can assert against a
  // stale script from a previous run and miss an edit to the template. The config
  // goes too: a leftover client role (written by cli.test.ts's client-setup tests)
  // would make setup() skip the fresh hook install entirely.
  rmSync(hookPath, { force: true });
  rmSync(`${TEST_HOME}/.config/claude0/config.json`, { force: true });
  await setup(); // writes the real pretooluse.sh under TEST_HOME/.config/claude0/hooks

  // Stub `tmux`. Default is a detached session: a session name exists
  // (display-message) but no client is attached (list-clients prints nothing).
  // STUB_ACTIVITY=<epoch> flips it to attached, reporting that client_activity —
  // the attached-but-idle presence path (the client_activity branch must precede
  // the bare list-clients one; both args match the wider pattern).
  rmSync(stubBin, { recursive: true, force: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    `${stubBin}/tmux`,
    `#!/bin/bash\ncase "$*" in\n  *display-message*) echo "fakesess" ;;\n  *client_activity*) [ -n "$STUB_ACTIVITY" ] && echo "$STUB_ACTIVITY" ;;\n  *list-clients*) [ -n "$STUB_ACTIVITY" ] && echo "client0: fakesess" ;;\n  *) : ;;\nesac\n`,
  );
  chmodSync(`${stubBin}/tmux`, 0o755);
});

interface HookResult {
  exitCode: number;
  stdout: string;
  pendingWritten: boolean;
}

/**
 * Run the generated hook with `payload` on stdin against the stubbed tmux.
 * A fresh bridge-consumer marker (phone watching) is the default — the hold branch
 * is unreachable without one; `phoneWatching: false` removes it. `clientActivity`
 * makes the stubbed session attached with that keystroke epoch.
 */
async function runHook(
  payload: object,
  opts: { timeoutMs?: number; phoneWatching?: boolean; clientActivity?: number } = {},
): Promise<HookResult> {
  const sessionId = (payload as any).session_id;
  rmSync(`${pendingDir}/${sessionId}.json`, { force: true });
  const consumerMarker = `${TEST_HOME}/.config/claude0/bridge-consumer`;
  if (opts.phoneWatching === false) rmSync(consumerMarker, { force: true });
  else writeFileSync(consumerMarker, "");
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: TEST_HOME,
      PATH: `${stubBin}:${process.env.PATH}`,
      TMUX_PANE: "%1",
      ...(opts.clientActivity !== undefined ? { STUB_ACTIVITY: String(opts.clientActivity) } : {}),
    },
  });

  // Block-polling tools never exit on their own here — kill after a beat and
  // treat "pending file written" as proof it entered the block branch.
  const timeoutMs = opts.timeoutMs ?? 0;
  let timer: Timer | undefined;
  if (timeoutMs > 0) timer = setTimeout(() => proc.kill(), timeoutMs);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    pendingWritten: existsSync(`${pendingDir}/${sessionId}.json`),
  };
}

const base = (overrides: object) => ({
  session_id: "itest",
  hook_event_name: "PreToolUse",
  transcript_path: "/tmp/x",
  cwd: "/tmp",
  permission_mode: "default",
  tool_use_id: "toolu_itest",
  ...overrides,
});

test("detached + read-only tool (Read) exits neutral — no block, no pending", async () => {
  // timeoutMs guards regression: if the gate is removed, Read would block here —
  // the kill makes that a clean failure (non-zero exit + pending written) not a hang.
  const r = await runHook(base({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }), { timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe(""); // neutral fall-through, no permissionDecision
  expect(r.pendingWritten).toBe(false);
});

test("detached + Task (subagent dispatch) exits neutral", async () => {
  const r = await runHook(base({ tool_name: "Task", session_id: "itest-task" }), { timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("detached + subagent tool call exits neutral", async () => {
  const r = await runHook(
    base({
      agent_id: "a11876444fb3fbef8",
      agent_type: "Explore",
      tool_name: "Bash",
      session_id: "itest-subagent",
      tool_input: { command: "git status --short" },
    }),
    { timeoutMs: 1000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("");
  expect(r.pendingWritten).toBe(false);
});

test("detached + bypassPermissions mode never blocks, even for Bash", async () => {
  const r = await runHook(
    base({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "itest-bypass", tool_input: { command: "rm -rf x" } }),
    { timeoutMs: 5000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("detached + auto mode never blocks, even for Bash", async () => {
  const r = await runHook(
    base({ tool_name: "Bash", permission_mode: "auto", session_id: "itest-auto", tool_input: { command: "cat big-file | head -450" } }),
    { timeoutMs: 5000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("no watching phone (no bridge-consumer marker) never blocks — desk prompt + push instead", async () => {
  const r = await runHook(
    base({ tool_name: "Bash", session_id: "itest-nophone", tool_input: { command: "echo hi" } }),
    { timeoutMs: 5000, phoneWatching: false },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe("");
  expect(r.pendingWritten).toBe(false);
});

test("attached-but-idle desk + watching phone blocks for the phone", async () => {
  const staleKeystroke = Math.floor(Date.now() / 1000) - 300;
  const r = await runHook(
    base({ tool_name: "Bash", session_id: "itest-idle", tool_input: { command: "echo hi" } }),
    { timeoutMs: 2000, clientActivity: staleKeystroke },
  );
  expect(r.pendingWritten).toBe(true);
});

test("a recent desk keystroke wins over a watching phone — no block", async () => {
  const freshKeystroke = Math.floor(Date.now() / 1000) - 5;
  const r = await runHook(
    base({ tool_name: "Bash", session_id: "itest-fresh", tool_input: { command: "echo hi" } }),
    { timeoutMs: 5000, clientActivity: freshKeystroke },
  );
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("the blocked hook stamps its OWN pid on the marker (readers probe it for liveness)", async () => {
  // Must be read while the hook is still blocked: once a decision lands, the hook consumes
  // it and `rm -f`s the marker before exiting, so a post-exit read finds nothing.
  const sid = "itest-pid";
  rmSync(`${decisionsDir}/${sid}.json`, { force: true });
  rmSync(`${pendingDir}/${sid}.json`, { force: true });
  writeFileSync(`${TEST_HOME}/.config/claude0/bridge-consumer`, ""); // fresh marker — the hold branch needs a watching phone
  const payload = base({ tool_name: "Bash", session_id: sid, tool_input: { command: "echo hi" } });
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: TEST_HOME, PATH: `${stubBin}:${process.env.PATH}`, TMUX_PANE: "%1" },
  });

  const marker = `${pendingDir}/${sid}.json`;
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
  const raw = JSON.parse(readFileSync(marker, "utf8"));
  proc.kill();
  await proc.exited;

  // `$$` in the template is the spawned bash's own pid — exact equality, not just a
  // typeof check, so a broken escaping (`"$"`, an empty field) can't slip through.
  expect(raw.pid).toBe(proc.pid);
});

test("detached + Bash (default mode) STILL block-polls and honors an allow decision", async () => {
  // Pre-place the decision so the first poll iteration resolves immediately —
  // reaching the allow JSON proves the call took the (correct) block branch.
  const sid = "itest-bash";
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(`${decisionsDir}/${sid}.json`, JSON.stringify({ decision: "allow" }));
  const r = await runHook(
    base({ tool_name: "Bash", session_id: sid, tool_input: { command: "echo hi" } }),
    { timeoutMs: 5000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('"permissionDecision":"allow"');
});
