/**
 * Hook-owned per-pane session map. Verifies the storage model that fixed the
 * listed-but-unsendable bug: per-pane files are the source of truth, reads are
 * non-destructive (no consume-once race), and change-detection diffs only id
 * CHANGES.
 *
 * Home helper FIRST so CLAUDE0_HOME is set before config.ts freezes PATHS.dir.
 */

import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadPaneSessions, savePaneSessions, processHookEvents, reconcilePaneFiles, buildSessionStates } from "./state";
import type { Session, SessionNotificationState } from "../types";

const PANES_DIR = join(CONFIG_DIR, "panes");

beforeEach(() => {
  rmSync(PANES_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
});

test("save/load round-trips per-pane files (the % paneId is a valid filename)", async () => {
  await savePaneSessions({ "%46": "sess-a", "%7": "sess-b" });
  expect(await loadPaneSessions()).toEqual({ "%46": "sess-a", "%7": "sess-b" });
});

test("loadPaneSessions ignores in-flight .tmp files", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  writeFileSync(join(PANES_DIR, "%2.tmp"), "half-written");
  expect(await loadPaneSessions()).toEqual({ "%1": "sess-a" });
});

test("processHookEvents: a NEW pane updates the map but is NOT a change", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  const map: Record<string, string> = {};
  const { changed, changedPaneIds } = await processHookEvents(map);
  expect(changed).toBe(true);
  expect(map["%1"]).toBe("sess-a");
  expect([...changedPaneIds]).toEqual([]); // brand-new ≠ changed
});

test("processHookEvents: a CHANGED id (/clear) is flagged in changedPaneIds", async () => {
  await savePaneSessions({ "%1": "new-id" });
  const map: Record<string, string> = { "%1": "old-id" };
  const { changed, changedPaneIds } = await processHookEvents(map);
  expect(changed).toBe(true);
  expect(map["%1"]).toBe("new-id");
  expect([...changedPaneIds]).toEqual(["%1"]);
});

test("processHookEvents: reading is non-destructive (no truncate race)", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  await processHookEvents({});
  // Second reader still sees the file — the v6 consume-once bug is gone.
  expect(await loadPaneSessions()).toEqual({ "%1": "sess-a" });
});

test("reconcilePaneFiles drops only files for panes absent from tmux", async () => {
  await savePaneSessions({ "%1": "live", "%2": "dead" });
  await reconcilePaneFiles(new Set(["%1"]));
  expect(await loadPaneSessions()).toEqual({ "%1": "live" });
});

// --- phonePushed: scoped to one attention episode ----------------------------------
// It gates the per-tick tier-4 retry, so carrying it one episode too far would mute a
// real notification — the exact failure the retry exists to prevent.

const attentive = (over: Partial<Session> = {}): Session => ({
    id: "sess-1",
    repo: "claude0",
    repoPath: "/x",
    baseRepoPath: "/x",
    branch: "",
    status: "waiting",
    messageCount: 0,
    summary: "",
    modified: new Date(0),
    firstPrompt: "",
    lastPrompt: "",
    name: "claude0/x",
    tmuxPane: { sessionName: "main", windowIndex: 1, paneId: "%1", windowName: "claude0" },
    ...over,
  });

const build = (attn: boolean, prev?: Partial<SessionNotificationState>, pushedNow?: string[]) =>
  buildSessionStates(
    [attentive()],
    new Set(attn ? ["%1"] : []),
    new Map(attn ? [["%1", "turnComplete" as const]] : []),
    prev ? { "%1": prev as SessionNotificationState } : undefined,
    pushedNow ? new Set(pushedNow) : undefined,
  )["%1"]!;

test("phonePushed is set when this tick pushed, and carried while attention persists", () => {
  expect(build(true, undefined, ["%1"]).phonePushed).toBe(true);
  expect(build(true, { needsAttention: true, phonePushed: true, status: "waiting" }).phonePushed).toBe(true);
});

test("phonePushed resets when attention clears, re-arming the next episode", () => {
  // Attention gone this tick ⇒ dropped outright.
  expect(build(false, { needsAttention: true, phonePushed: true, status: "ready" }).phonePushed).toBeUndefined();
  // Cleared earlier (needsAttention false in prev), now attention again ⇒ a NEW episode,
  // so the stale flag must not carry over and mute it.
  expect(build(true, { needsAttention: false, phonePushed: true, status: "running" }).phonePushed).toBeUndefined();
});

test("phonePushed is absent rather than false when no push has gone out", () => {
  const s = build(true);
  expect(s.phonePushed).toBeUndefined();
  expect(JSON.stringify(s)).not.toContain("phonePushed");
});
