import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { editCheckout, liveEditDir, scanEditDir, workPullRequest, type EditScan } from "./edit-dir";

const BASE = "/home/u/dev/repo";
const WT = `${BASE}/.claude/worktrees/tf-1`;

test("editCheckout: worktree edits map to the worktree, base edits to base, others to nothing", () => {
  expect(editCheckout(`${WT}/src/a.ts`, BASE)).toBe(WT);
  expect(editCheckout(`${BASE}/src/a.ts`, BASE)).toBe(BASE);
  expect(editCheckout(`${BASE}/.claude/worktrees/tf-1`, BASE)).toBe(WT);
  expect(editCheckout(`${WT}/.plans/x/plan.md`, BASE)).toBe(WT); // planning in a worktree = working there
  expect(editCheckout(`${BASE}/.plans/x/plan.md`, BASE)).toBeNull(); // base plans trail the code (pre-worktree, or moved back on cleanup)
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
const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
const REPO = { base: BASE, slug: "acme/repo" };

test("scanEditDir: follows the last in-repo edit, ignores reads and off-repo edits, resumes from the cached offset", async () => {
  appendFileSync(transcript, edit("Edit", `${BASE}/src/a.ts`) + edit("Write", `${WT}/src/b.ts`) + read(`${BASE}/src/c.ts`));
  const first = await scanEditDir(SID, REPO, undefined, dir);
  expect(first?.dir).toBe(WT);
  expect(first?.offset).toBe(Bun.file(transcript).size);

  // only the appended bytes are read: a base edit after the cursor flips the pick back
  appendFileSync(transcript, edit("Edit", "/home/u/.claude/projects/memory/note.md") + edit("MultiEdit", `${BASE}/src/a.ts`));
  const second = await scanEditDir(SID, REPO, first!, dir);
  expect(second?.dir).toBe(BASE);
  expect(second?.offset).toBeGreaterThan(first!.offset);

  // nothing new → same cursor, same pick
  expect(await scanEditDir(SID, REPO, second!, dir)).toEqual(second!);
});

test("scanEditDir: a partial trailing line is skipped, not counted, and re-read next pass", async () => {
  const half = edit("Edit", `${WT}/src/b.ts`);
  appendFileSync(transcript, half.slice(0, 20));
  const first = await scanEditDir(SID, REPO, undefined, dir);
  expect(first?.dir).toBeUndefined();
  appendFileSync(transcript, half.slice(20));
  // the cursor sits inside the line, so the rest alone is unparseable: the pick lands on the next full edit
  appendFileSync(transcript, edit("Edit", `${WT}/src/c.ts`));
  expect((await scanEditDir(SID, REPO, first!, dir))?.dir).toBe(WT);
});

test("scanEditDir: no transcript → null; unknown session keeps the previous scan", async () => {
  expect(await scanEditDir("no-such-session", REPO, undefined, dir)).toBeNull();
});

const prOp = (action: string, url: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", content: url }] },
    toolUseResult: { stdout: url, gitOperation: { pr: { number: Number(url.split("/").pop()), url, action } } },
  }) + "\n";
const skillBody = (text: string) => JSON.stringify({ type: "user", message: { content: [{ type: "text", text }] } }) + "\n";

test("scanEditDir: keeps the last same-repo PR the session created or edited, ignoring other repos' PRs", async () => {
  appendFileSync(transcript, prOp("created", "https://github.com/acme/repo/pull/41") + prOp("created", "https://github.com/acme/other/pull/99"));
  const first = await scanEditDir(SID, REPO, undefined, dir);
  expect(first?.lastPr).toBe(41);
  appendFileSync(transcript, prOp("edited", "https://github.com/acme/repo/pull/42"));
  expect((await scanEditDir(SID, REPO, first!, dir))?.lastPr).toBe(42);
  expect((await scanEditDir(SID, { base: BASE, slug: "" }, undefined, dir))?.lastPr).toBeUndefined();
});

test("scanEditDir: a PR url that is only mentioned — skill body, prose, a comment or view — is not the session's PR", async () => {
  appendFileSync(
    transcript,
    skillBody("client onboarding ([#1105](https://github.com/acme/repo/pull/1105), merged) already sends with") +
      say("see https://github.com/acme/repo/pull/7") +
      prOp("commented", "https://github.com/acme/repo/pull/8"),
  );
  expect((await scanEditDir(SID, REPO, undefined, dir))?.lastPr).toBeUndefined();
});

test("workPullRequest: a live worktree's PR is pinned as lastPr so it outlives the worktree's cleanup", async () => {
  const scan: EditScan = { path: "p", offset: 0, dir };
  const byBranch = async (root: string) =>
    root === dir ? ({ state: "open", branch: "tf-1", number: 5, title: "", url: "", add: 0, del: 0 } as const) : ({ state: "none" } as const);
  const byNumber = async (_root: string, n: number) => ({ state: "merged", branch: "tf-1", number: n, title: "", url: "", add: 0, del: 0 }) as const;
  expect((await workPullRequest(scan, BASE, { byBranch, byNumber })).state).toBe("open");
  expect(scan.lastPr).toBe(5);

  rmSync(dir, { recursive: true, force: true }); // landed and cleaned up
  const pr = await workPullRequest(scan, BASE, { byBranch, byNumber });
  expect(pr.state === "merged" && pr.number).toBe(5);

  // no edits in a worktree and no PR of its own → the pane's own branch
  expect((await workPullRequest({ path: "p", offset: 0 }, BASE, { byBranch, byNumber })).state).toBe("none");
});

test("liveEditDir: falls back when the picked worktree is gone", async () => {
  expect(await liveEditDir({ path: "p", offset: 0, dir: `${dir}/missing` }, BASE)).toBe(BASE);
  expect(await liveEditDir({ path: "p", offset: 0, dir }, BASE)).toBe(dir);
  expect(await liveEditDir({ path: "p", offset: 0 }, BASE)).toBe(BASE);
  expect(await liveEditDir(null, BASE)).toBe(BASE);
});
