import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { editCheckout, liveEditDir, scanEditDir } from "./edit-dir";

const BASE = "/home/u/dev/repo";
const WT = `${BASE}/.claude/worktrees/tf-1`;

test("editCheckout: worktree edits map to the worktree, base edits to base, others to nothing", () => {
  expect(editCheckout(`${WT}/src/a.ts`, BASE)).toBe(WT);
  expect(editCheckout(`${BASE}/src/a.ts`, BASE)).toBe(BASE);
  expect(editCheckout(`${BASE}/.claude/worktrees/tf-1`, BASE)).toBe(WT);
  expect(editCheckout(`${WT}/.plans/x/plan.md`, BASE)).toBeNull(); // scratch trails the code
  expect(editCheckout(`/home/u/.claude/projects/memory/x.md`, BASE)).toBeNull();
  expect(editCheckout(`${BASE}-other/src/a.ts`, BASE)).toBeNull(); // prefix, not a child
});

let dir: string;
let transcript: string;
const SID = "11111111-2222-3333-4444-555555555555";
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/c0-edit-dir-`);
  mkdirSync(`${dir}/-home-u-dev-repo`);
  transcript = `${dir}/-home-u-dev-repo/${SID}.jsonl`;
  writeFileSync(transcript, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const edit = (tool: string, file_path: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: tool, input: { file_path } }] } }) + "\n";
const read = (file_path: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path } }] } }) + "\n";

test("scanEditDir: follows the last in-repo edit, ignores reads and off-repo edits, resumes from the cached offset", async () => {
  appendFileSync(transcript, edit("Edit", `${BASE}/src/a.ts`) + edit("Write", `${WT}/src/b.ts`) + read(`${BASE}/src/c.ts`));
  const first = await scanEditDir(SID, BASE, undefined, dir);
  expect(first?.dir).toBe(WT);
  expect(first?.offset).toBe(Bun.file(transcript).size);

  // only the appended bytes are read: a base edit after the cursor flips the pick back
  appendFileSync(transcript, edit("Edit", "/home/u/.claude/projects/memory/note.md") + edit("MultiEdit", `${BASE}/src/a.ts`));
  const second = await scanEditDir(SID, BASE, first!, dir);
  expect(second?.dir).toBe(BASE);
  expect(second?.offset).toBeGreaterThan(first!.offset);

  // nothing new → same cursor, same pick
  expect(await scanEditDir(SID, BASE, second!, dir)).toEqual(second!);
});

test("scanEditDir: a partial trailing line is skipped, not counted, and re-read next pass", async () => {
  const half = edit("Edit", `${WT}/src/b.ts`);
  appendFileSync(transcript, half.slice(0, 20));
  const first = await scanEditDir(SID, BASE, undefined, dir);
  expect(first?.dir).toBeUndefined();
  appendFileSync(transcript, half.slice(20));
  // the cursor sits inside the line, so the rest alone is unparseable: the pick lands on the next full edit
  appendFileSync(transcript, edit("Edit", `${WT}/src/c.ts`));
  expect((await scanEditDir(SID, BASE, first!, dir))?.dir).toBe(WT);
});

test("scanEditDir: no transcript → null; unknown session keeps the previous scan", async () => {
  expect(await scanEditDir("no-such-session", BASE, undefined, dir)).toBeNull();
});

test("liveEditDir: falls back when the picked worktree is gone", async () => {
  expect(await liveEditDir({ path: "p", offset: 0, dir: `${dir}/missing` }, BASE)).toBe(BASE);
  expect(await liveEditDir({ path: "p", offset: 0, dir }, BASE)).toBe(dir);
  expect(await liveEditDir({ path: "p", offset: 0 }, BASE)).toBe(BASE);
  expect(await liveEditDir(null, BASE)).toBe(BASE);
});
