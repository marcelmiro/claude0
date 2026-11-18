import { homedir } from "node:os";
import { resolveClaudePath } from "./names";

const CLAUDE_PATH = resolveClaudePath();

/**
 * One `claude -p` call with a system prompt: the text it printed, or why there isn't any.
 * Runs from a neutral cwd so no workspace CLAUDE.md leaks in, with the cli entrypoint so it
 * bills like the naming calls (`generateOneName` in names.ts).
 */
export async function claudePrint(opts: { system: string; input: string; model?: string; timeoutMs?: number }): Promise<{ text: string } | { error: string }> {
  const { system, input, model = "haiku", timeoutMs = 30_000 } = opts;
  try {
    const proc = Bun.spawn([CLAUDE_PATH, "-p", "--model", model, "--no-session-persistence", "--system-prompt", system], {
      stdin: new Response(input),
      stdout: "pipe",
      stderr: "pipe",
      cwd: homedir(),
      env: { ...process.env, TMUX: "", TMUX_PANE: "", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    let timedOut = false;
    const killTimer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(killTimer);
    await proc.exited;
    if (timedOut) return { error: `timeout ${timeoutMs}ms` };
    if (proc.exitCode !== 0) return { error: `exit ${proc.exitCode}: ${(err || out).trim().slice(0, 200)}` };
    return { text: out.trim() };
  } catch (e) {
    return { error: `spawn: ${String(e).slice(0, 200)}` };
  }
}
