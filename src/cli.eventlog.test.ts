/**
 * Integration coverage for the generated event logger (`event.sh`, the same snippet
 * `pretooluse.sh` logs with), run under real concurrency. Claude fires hooks in
 * parallel (parallel tool calls, a PreToolUse and its PostToolUse racing a sibling's),
 * and a line lost in the trim drops a PostToolUse (a phantom pending tool) or an
 * AskUserQuestion PreToolUse (an unflagged question).
 *
 * `home` helper first — the hook writes under the temp $HOME root.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { HOOK_SCRIPTS } from "./cli";
import { EVENTS_DIR, eventLogPath, readEvents } from "./core/hook-events";

const hookPath = `${TEST_HOME}/event-hook.sh`;

/** A payload sized like a real PostToolUse (they carry the tool_response). */
function event(id: string): string {
  return JSON.stringify({ session_id: "sess-a", hook_event_name: "PostToolUse", tool_use_id: id, pad: "x".repeat(2000) });
}

test("concurrent hooks crossing the rotation point lose no events", async () => {
  writeFileSync(hookPath, HOOK_SCRIPTS.find((s) => s.name === "event.sh")!.content);
  for (let round = 0; round < 5; round++) {
    rmSync(EVENTS_DIR, { recursive: true, force: true });
    mkdirSync(EVENTS_DIR, { recursive: true });
    // Just under the rotation point, so the burst below crosses it mid-flight.
    writeFileSync(eventLogPath("sess-a"), Array.from({ length: 195 }, (_, i) => event(`seed-${i}`) + "\n").join(""));
    const ids = Array.from({ length: 40 }, (_, i) => `r${round}-${i}`);
    await Promise.all(
      ids.map(async (id) => {
        const proc = Bun.spawn(["bash", hookPath], {
          stdin: Buffer.from(event(id)),
          env: { ...process.env, HOME: TEST_HOME },
          stderr: "pipe",
        });
        expect(await proc.exited).toBe(0);
        expect(await new Response(proc.stderr).text()).toBe("");
      }),
    );
    const logged = new Set(readEvents("sess-a").map((e) => e.tool_use_id));
    expect(ids.filter((id) => !logged.has(id))).toEqual([]);
    expect(logged.has("seed-0")).toBe(true); // one rotation keeps the whole history
    expect(readdirSync(EVENTS_DIR).sort()).toEqual(["sess-a.jsonl", "sess-a.jsonl.old"]); // no stray lock/temp
  }
});
