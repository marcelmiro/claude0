/**
 * `slashCommandIntent` — turns a Claude Code slash-command user message into a
 * clean naming signal. Skill-launched sessions (e.g. `/implement-plan`) store the
 * real intent only in the command block; the message that follows is generic
 * skill boilerplate ("Base directory for this skill: …"). Naming off the
 * boilerplate produced unstable, hallucinated names (a claude0 session got named
 * `papi-list-methods`); surfacing the command makes it stable.
 */

import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slashCommandIntent, resolvePaneSessionId, resolveActiveId, pickRepoPath, getLatestUserPrompt } from "./sessions";

test("extracts /implement-plan with its plan path", () => {
  const msg =
    "<command-message>implement-plan</command-message>\n" +
    "<command-name>/implement-plan</command-name>\n" +
    "<command-args>@.plans/native-status/plan.md</command-args>";
  expect(slashCommandIntent(msg)).toBe("/implement-plan @.plans/native-status/plan.md");
});

test("skips meta commands that carry no intent", () => {
  const clear =
    "<command-name>/clear</command-name>\n" +
    "<command-message>clear</command-message>\n" +
    "<command-args></command-args>";
  expect(slashCommandIntent(clear)).toBeNull();
  expect(slashCommandIntent("<command-name>/compact</command-name><command-args></command-args>")).toBeNull();
});

test("command with no args returns just the name", () => {
  expect(slashCommandIntent("<command-name>/review</command-name><command-args></command-args>")).toBe("/review");
});

test("returns null for plain text and for non-command XML (caveats)", () => {
  expect(slashCommandIntent("fix the auth bug")).toBeNull();
  expect(slashCommandIntent("<local-command-caveat>Caveat: …</local-command-caveat>")).toBeNull();
});

test("collapses whitespace in args", () => {
  const msg = "<command-name>/run</command-name><command-args>  foo   bar  </command-args>";
  expect(slashCommandIntent(msg)).toBe("/run foo bar");
});

// --- resolvePaneSessionId — the /clear pane→session precedence fix ---------------
// The SessionStart hook is authoritative; the command-line --resume id is the LAUNCH id
// and goes stale after /clear or /compact (new id, same process). Hook map must win.

const cache = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

test("resolvePaneSessionId: hook cache wins over the command-line --resume id (the /clear fix)", () => {
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "new" }), {})).toBe("new");
});

test("resolvePaneSessionId: persisted hook map (panes/ files) wins over the command-line id", () => {
  // The in-process cache missed the event; the monitor-maintained disk map still has it.
  expect(resolvePaneSessionId("%651", "old", cache(), { "%651": "new" })).toBe("new");
});

test("resolvePaneSessionId: cache preferred over persisted (both hook-derived)", () => {
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "fromCache" }), { "%651": "fromDisk" })).toBe("fromCache");
});

test("resolvePaneSessionId: unhooked pane falls back to the command-line id", () => {
  expect(resolvePaneSessionId("%9", "cmdId", cache(), {})).toBe("cmdId");
});

test("resolvePaneSessionId: fork/fresh pane (no command-line id, no hook entry) → undefined", () => {
  expect(resolvePaneSessionId("%9", undefined, cache(), {})).toBeUndefined();
});

test("resolvePaneSessionId: normal pane (hook == cmd) resolves unchanged — fix is a no-op", () => {
  expect(resolvePaneSessionId("%1", "s1", cache({ "%1": "s1" }), { "%1": "s1" })).toBe("s1");
});

// --- fork override — the fork/status-sync fix ------------------------------------
// A fork's SessionStart hook fires with the PARENT id, so the hook map (cache AND
// persisted) points the fork at its parent → it renders the parent's running status.
// For a fork, cmdSessionId is the REAL id (from Claude's per-pid native file) and
// must win over the poisoned hook map.

test("resolvePaneSessionId: fork's native id wins over the parent id in cache/persisted", () => {
  expect(
    resolvePaneSessionId("%146", "fork-real", cache({ "%146": "parent" }), { "%146": "parent" }, true),
  ).toBe("fork-real");
});

test("resolvePaneSessionId: fork with no native id yet falls back to the hook map (transient)", () => {
  // Native file not written in the split second after boot — keep the hook value
  // until nativeSessionIdByPid resolves; still better than nothing.
  expect(resolvePaneSessionId("%146", undefined, cache({ "%146": "parent" }), {}, true)).toBe("parent");
});

test("resolvePaneSessionId: isFork=false leaves the hook-wins precedence intact (/clear path)", () => {
  // The override is fork-scoped: a /clear'd pane (same process, new hook id) still
  // trusts the hook map over the stale command-line id.
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "new" }), {}, false)).toBe("new");
});

// --- pickRepoPath: restored panes that came back in $HOME ---------------------

const HOME = "/Users/dev";

test("pickRepoPath: a $HOME pane follows the transcript's cwd", () => {
  expect(pickRepoPath(HOME, `${HOME}/Documents/repo`, HOME)).toBe(`${HOME}/Documents/repo`);
});

test("pickRepoPath: a $HOME pane with no usable transcript cwd stays home", () => {
  expect(pickRepoPath(HOME, null, HOME)).toBe(HOME);
  expect(pickRepoPath(HOME, HOME, HOME)).toBe(HOME);
});

test("pickRepoPath: a normal pane keeps its own cwd even when the transcript /cd'd away", () => {
  expect(pickRepoPath(`${HOME}/Documents/repo`, `${HOME}/Documents/other`, HOME)).toBe(
    `${HOME}/Documents/repo`,
  );
});

// --- getLatestUserPrompt: backward doubling-window scan over the transcript tail ---
// The scan does its offset math on BYTES; multi-byte characters split at a window
// edge must not lose or corrupt the record the doubling pass exists to recover.

async function writeTranscript(lines: string[]): Promise<string> {
  const path = join(tmpdir(), `c0-latest-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  await Bun.write(path, lines.join("\n") + "\n");
  return path;
}

test("finds the newest last-prompt record in the tail", async () => {
  const path = await writeTranscript([
    JSON.stringify({ type: "last-prompt", lastPrompt: "older" }),
    JSON.stringify({ type: "assistant", message: { content: "hi" } }),
    JSON.stringify({ type: "last-prompt", lastPrompt: "newest prompt" }),
  ]);
  expect(await getLatestUserPrompt(path)).toBe("newest prompt");
});

test("recovers a last-prompt buried past the first 64KB window, with multi-byte content at every boundary", async () => {
  // The record sits deeper than the first window, so the scan must widen and
  // re-position using byte offsets. Multi-byte padding makes UTF-16 math lie.
  const pad = JSON.stringify({ type: "assistant", message: { content: "続き — ⚡日本語 🚀".repeat(200) } });
  const lines = [
    JSON.stringify({ type: "last-prompt", lastPrompt: "épreuve — 日本語のプロンプト 🚀" }),
    ...Array.from({ length: 40 }, () => pad), // ~40 × ~4KB of multi-byte padding after the record
  ];
  const path = await writeTranscript(lines);
  expect(await getLatestUserPrompt(path)).toBe("épreuve — 日本語のプロンプト 🚀");
});

test("empty result when the transcript has neither a prompt nor a last-prompt record", async () => {
  const path = await writeTranscript([JSON.stringify({ type: "assistant", message: { content: "hi" } })]);
  expect(await getLatestUserPrompt(path)).toBe("");
});

// --- getLatestUserPrompt: a real prompt near the tail outranks last-prompt records ---
const user = (content: unknown, extra: object = {}) => JSON.stringify({ type: "user", message: { content }, ...extra });

test("a fork's own prompt wins over the stale parent last-prompt Claude writes after it", async () => {
  const path = await writeTranscript([
    user("parent prompt"),
    JSON.stringify({ type: "last-prompt", lastPrompt: "parent prompt" }),
    user("the fork's own prompt"),
    JSON.stringify({ type: "assistant", message: { content: "ok" } }),
    JSON.stringify({ type: "last-prompt", lastPrompt: "parent prompt" }), // stale, written after the turn
  ]);
  expect(await getLatestUserPrompt(path)).toBe("the fork's own prompt");
});

test("a prompt Claude never wrote a last-prompt record for still counts", async () => {
  const path = await writeTranscript([
    JSON.stringify({ type: "last-prompt", lastPrompt: "older" }),
    user([{ type: "text", text: "newer\n  prompt" }]),
  ]);
  expect(await getLatestUserPrompt(path)).toBe("newer prompt");
});

test("tool results, bash output and meta commands are not prompts; ! commands and slash intents are", async () => {
  const skipped = [
    user([{ type: "tool_result", content: "x" }]),
    user("<bash-stdout>Ok</bash-stdout><bash-stderr></bash-stderr>"),
    user("<command-name>/clear</command-name><command-args></command-args>"),
    user("<system-reminder>x</system-reminder>"),
    user("typed but meta", { isMeta: true }),
    user("This session is being continued from a previous conversation…", { isCompactSummary: true }),
  ];
  expect(await getLatestUserPrompt(await writeTranscript([user("typed"), ...skipped]))).toBe("typed");
  expect(await getLatestUserPrompt(await writeTranscript([user("<bash-input> ls -la </bash-input>"), skipped[1]!]))).toBe("! ls -la");
  expect(
    await getLatestUserPrompt(
      await writeTranscript([user("<command-name>/implement-plan</command-name><command-args>@plan.md</command-args>")]),
    ),
  ).toBe("/implement-plan @plan.md");
});

test("a prompt beyond the 64KB tail falls back to the last-prompt record Claude rewrites through the turn", async () => {
  const pad = JSON.stringify({ type: "assistant", message: { content: "x".repeat(4000) } });
  const path = await writeTranscript([
    user("buried prompt"),
    ...Array.from({ length: 30 }, () => pad),
    JSON.stringify({ type: "last-prompt", lastPrompt: "current prompt" }),
    ...Array.from({ length: 5 }, () => pad),
  ]);
  expect(await getLatestUserPrompt(path)).toBe("current prompt");
});

// --- resolveActiveId — a known id with no transcript --------------------------------
// Claude writes a NEW session's JSONL lazily (first turn); /clear and forks write eagerly.
// With no transcript, the id the live process owns (Claude's per-pid native file, else
// --session-id argv) is the answer — whether the pane map agrees, is stale, or hasn't been
// written yet. Only with no live id does the pane blank for re-matching.

test("resolveActiveId: a transcript-backed pane keeps the hook id, else the transcript's", () => {
  expect(resolveActiveId("hook", "tx", undefined)).toBe("hook");
  expect(resolveActiveId(undefined, "tx", undefined)).toBe("tx");
});

test("resolveActiveId: no transcript + the live process owns the known id → keep it (unprompted session)", () => {
  expect(resolveActiveId("fresh", undefined, "fresh")).toBe("fresh");
});

test("resolveActiveId: reused pane — a cached id from the previous process → the live process's id", () => {
  expect(resolveActiveId("previous", undefined, "current")).toBe("current");
});

test("resolveActiveId: new pane before its SessionStart hook writes the map → the live process's id, not a guess", () => {
  expect(resolveActiveId(undefined, undefined, "booted")).toBe("booted");
});

test("resolveActiveId: no transcript and no live id → blank for re-matching", () => {
  expect(resolveActiveId("stale", undefined, undefined)).toBe("");
  expect(resolveActiveId(undefined, undefined, undefined)).toBe("");
});
