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
import { slashCommandIntent, resolvePaneSessionId, resolveActiveId, pickRepoPath, groupSessions, getLatestUserPrompt } from "./sessions";
import type { Session } from "../types";

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

// --- groupSessions: within-group order mirrors portkey's compareSessions --------
// attention (⚡) first → status rank → last-turn recency desc → stable key.

function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    repo: "claude0",
    repoPath: "/repo",
    baseRepoPath: "/repo",
    branch: "main",
    status: "ready",
    messageCount: 0,
    summary: "",
    modified: new Date("2026-01-01T00:00:00Z"),
    firstPrompt: "",
    lastPrompt: "",
    name: "",
    tmuxPane: { paneId: `%${over.id}`, windowIndex: 0, sessionName: "main", windowName: "claude0" },
    ...over,
  };
}

test("groupSessions: attention sorts first, even ahead of a waiting session", () => {
  const waiting = makeSession({ id: "a", status: "waiting" });
  const readyAttn = makeSession({ id: "b", status: "ready" });
  const [g] = groupSessions([waiting, readyAttn], [], new Set(["%b"]));
  expect(g.sessions.map((s) => s.id)).toEqual(["b", "a"]);
});

test("groupSessions: same status orders by lastTurnAt desc, unknown recency sinks", () => {
  const old = makeSession({ id: "a", lastTurnAt: new Date("2026-01-01T00:00:00Z") });
  const fresh = makeSession({ id: "b", lastTurnAt: new Date("2026-01-02T00:00:00Z") });
  const unknown = makeSession({ id: "c" });
  const [g] = groupSessions([old, unknown, fresh], []);
  expect(g.sessions.map((s) => s.id)).toEqual(["b", "a", "c"]);
});

test("groupSessions: status rank still separates non-attention sessions", () => {
  const ready = makeSession({ id: "a", status: "ready" });
  const running = makeSession({ id: "b", status: "running" });
  const waiting = makeSession({ id: "c", status: "waiting" });
  const [g] = groupSessions([ready, running, waiting], []);
  expect(g.sessions.map((s) => s.id)).toEqual(["c", "b", "a"]);
});

test("groupSessions: archived without lastTurnAt falls back to its stable mtime", () => {
  const older = makeSession({ id: "a", status: "archived", modified: new Date("2026-01-01T00:00:00Z"), tmuxPane: undefined });
  const newer = makeSession({ id: "b", status: "archived", modified: new Date("2026-01-02T00:00:00Z"), tmuxPane: undefined });
  const [g] = groupSessions([older, newer], []);
  expect(g.sessions.map((s) => s.id)).toEqual(["b", "a"]);
});

test("groupSessions: priority repos pin group order ahead of alphabetical", () => {
  const groups = groupSessions(
    [
      makeSession({ id: "a", repo: "alpha", repoPath: "/alpha", baseRepoPath: "/alpha" }),
      makeSession({ id: "b", repo: "claude0" }),
      makeSession({ id: "c", repo: "throxy", repoPath: "/throxy", baseRepoPath: "/throxy" }),
    ],
    ["throxy", "customeros", "~", "claude0"],
  );
  expect(groups.map((g) => g.name)).toEqual(["throxy", "claude0", "alpha"]);
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
    JSON.stringify({ type: "user", message: { content: "hi" } }),
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

test("empty result when no last-prompt record exists", async () => {
  const path = await writeTranscript([JSON.stringify({ type: "user", message: { content: "hi" } })]);
  expect(await getLatestUserPrompt(path)).toBe("");
});

// --- resolveActiveId — a known id with no transcript --------------------------------
// Claude writes a NEW session's JSONL lazily (first turn); /clear and forks write eagerly.
// A phone-created session left unprompted must keep its minted id through that window;
// any other transcript-less known id is a stale pane→session mapping.

test("resolveActiveId: a transcript-backed pane keeps the hook id, else the transcript's", () => {
  expect(resolveActiveId("hook", "tx", undefined)).toBe("hook");
  expect(resolveActiveId(undefined, "tx", undefined)).toBe("tx");
});

test("resolveActiveId: no transcript + id dictated by --session-id on the live process → keep it", () => {
  expect(resolveActiveId("minted", undefined, "minted")).toBe("minted");
});

test("resolveActiveId: no transcript + id NOT on the process argv → stale mapping, blank for re-matching", () => {
  expect(resolveActiveId("stale", undefined, undefined)).toBe("");
  expect(resolveActiveId("other", undefined, "launch-id")).toBe("");
  expect(resolveActiveId(undefined, undefined, "minted")).toBe("");
});
