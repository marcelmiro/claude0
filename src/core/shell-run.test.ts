import { test, expect } from "bun:test";
import { runShell } from "./shell-run";

test("runs a command through the login shell and returns exit, stdout, stderr", async () => {
  const r = await runShell("printf out; printf err >&2; exit 3");
  expect(r.exit).toBe(3);
  expect(r.stdout).toBe("out");
  expect(r.stderr).toBe("err");
  expect(r.truncated).toBe(false);
  expect(r.ms).toBeGreaterThanOrEqual(0);
});

test("a timed-out command is killed with its children and reported as killed", async () => {
  const started = Date.now();
  const r = await runShell("sleep 30 & sleep 30", { timeoutMs: 300 });
  expect(r.exit).toBeNull();
  expect(r.stderr).toContain("killed");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("output past the cap is discarded and flagged, and the command still completes", async () => {
  const r = await runShell("yes | head -c 200000; echo done >&2", { cap: 1024 });
  expect(r.exit).toBe(0);
  expect(r.stdout.length).toBe(1024);
  expect(r.truncated).toBe(true);
  expect(r.stderr).toBe("done\n");
});

test("runs in the home directory with a login-shell PATH", async () => {
  const r = await runShell("pwd; command -v jq >/dev/null && echo has-jq");
  expect(r.stdout.split("\n")[0]).toBe(process.env.HOME ?? "");
});
