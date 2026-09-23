/**
 * One-shot shell runner behind portkey's shell sheet: run a pasted line through the
 * user's login shell and hand back what it printed. Not a terminal — no tty, stdin
 * closed, one command in, exit code + output out. Interactive commands are the desk's job.
 *
 * The login shell (`-l`) matters: the bridge is a systemd user unit with a minimal
 * environment, and a command pasted from a phone expects the PATH a tmux popup has.
 */

import { homedir } from "os";

export interface ShellRun {
  command: string;
  exit: number | null; // null = killed (timeout or output cap)
  stdout: string;
  stderr: string;
  ms: number;
  truncated: boolean;
  at: number; // ms timestamp the run finished
}

export const SHELL_TIMEOUT_MS = 30_000;
export const SHELL_OUTPUT_CAP = 64 * 1024;
export const SHELL_HISTORY = 20;

/**
 * Drain a stream into a string capped at `cap` bytes. Bytes past the cap are read and
 * discarded so the child never blocks on a full pipe; the caller learns via `truncated`.
 */
async function drain(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size >= cap) {
        truncated = true;
        continue;
      }
      const take = value.length > cap - size ? value.subarray(0, cap - size) : value;
      if (take.length < value.length) truncated = true;
      chunks.push(take);
      size += take.length;
    }
  } catch {
    // A killed child closes the pipe abruptly; whatever was read is the output.
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Run `command` via `$SHELL -lc` in the home directory. `setsid` (Linux) makes the shell
 * a process-group leader so a timeout kills everything it spawned, not just the shell;
 * without it (macOS) only the shell pid is killed.
 */
export async function runShell(
  command: string,
  opts: { timeoutMs?: number; cap?: number } = {},
): Promise<ShellRun> {
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  const cap = opts.cap ?? SHELL_OUTPUT_CAP;
  const shell = process.env.SHELL || "/bin/sh";
  const setsid = Bun.which("setsid");
  const argv = setsid ? [setsid, shell, "-lc", command] : [shell, "-lc", command];
  const started = Date.now();
  let killed = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return {
      command,
      exit: null,
      stdout: "",
      stderr: `could not start ${shell}: ${(e as Error).message}`,
      ms: 0,
      truncated: false,
      at: Date.now(),
    };
  }
  const kill = () => {
    killed = true;
    try {
      if (setsid) process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  const timer = setTimeout(kill, timeoutMs);
  const [out, err] = await Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>, cap), drain(proc.stderr as ReadableStream<Uint8Array>, cap)]);
  // Output past the cap is discarded, not a reason to stop: a noisy command still finishes.
  const exit = await proc.exited;
  clearTimeout(timer);
  return {
    command,
    exit: killed ? null : exit,
    stdout: out.text,
    stderr: killed && !err.text ? `killed after ${Math.round(timeoutMs / 1000)}s` : err.text,
    ms: Date.now() - started,
    truncated: out.truncated || err.truncated,
    at: Date.now(),
  };
}
