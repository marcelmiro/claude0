import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { pickSavedCwd, resolveRestoreTarget, resolveResurrect, resurrectCommand, userResurrectDirs, claude0ResurrectDir, cloneResurrectCommands, RESURRECT_COMMIT, daemonSaveCommand } from "./resurrect";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function enc(p: string): string {
  return p.replace(/\//g, "-");
}

let root: string; // stands in for the home dir in these tests
let projectsDir: string;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/c0-resurrect-`);
  projectsDir = `${root}/projects`;
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a transcript for SID whose last record carries `cwd`. */
async function seedTranscript(cwd: string): Promise<void> {
  const dir = `${projectsDir}/${enc(cwd)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${SID}.jsonl`, `{"type":"user","cwd":${JSON.stringify(cwd)}}\n`);
}

// --- pickSavedCwd -----------------------------------------------------------

test("pickSavedCwd keeps a recorded repo cwd when the pane reports home", () => {
  expect(pickSavedCwd("/home/dev", "/home/dev/repo", "/home/dev")).toBe("/home/dev/repo");
});

test("pickSavedCwd takes the pane cwd when it is a real directory", () => {
  expect(pickSavedCwd("/home/dev/repo", "/home/dev/other", "/home/dev")).toBe("/home/dev/repo");
});

test("pickSavedCwd records home when nothing better is on record", () => {
  expect(pickSavedCwd("/home/dev", undefined, "/home/dev")).toBe("/home/dev");
  expect(pickSavedCwd("/home/dev", "/home/dev", "/home/dev")).toBe("/home/dev");
});

// --- resolveRestoreTarget ---------------------------------------------------

test("returns the saved dir when it still exists", async () => {
  const repo = `${root}/repo`;
  await mkdir(repo);
  expect(await resolveRestoreTarget(SID, repo, root, projectsDir)).toBe(repo);
});

test("a home saved cwd resolves to the transcript's cwd, never to home", async () => {
  const repo = `${root}/repo`;
  await mkdir(repo);
  await seedTranscript(repo);
  // `root` exists as a directory, so an exists-first branch order would wrongly return it.
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBe(repo);
});

test("a home saved cwd with no usable transcript resolves to null (bare resume)", async () => {
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBeNull();
  await seedTranscript(`${root}/gone`); // recorded cwd no longer on disk
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBeNull();
});

test("a deleted managed worktree resolves to its base repo", async () => {
  const base = `${root}/repo`;
  await mkdir(`${base}/.git`, { recursive: true });
  await writeFile(`${base}/.git/HEAD`, "ref: refs/heads/main\n");
  const worktree = `${base}/.claude/worktrees/feature`; // never created — stands for a deleted worktree
  expect(await resolveRestoreTarget(SID, worktree, root, projectsDir)).toBe(base);
});

test("an unresolvable saved cwd returns null", async () => {
  expect(await resolveRestoreTarget(SID, `${root}/nope`, root, projectsDir)).toBeNull();
});

// --- resolveResurrect -------------------------------------------------------

/** Fake a plugin install by creating the script the resolver (and exec) require. */
async function seedPlugin(dir: string): Promise<void> {
  await mkdir(`${dir}/scripts`, { recursive: true });
  await writeFile(`${dir}/scripts/save.sh`, "#!/bin/bash\n");
}

test("a user TPM copy under .config/tmux wins over everything", async () => {
  const [a, b] = userResurrectDirs(root);
  await seedPlugin(a);
  await seedPlugin(b);
  await seedPlugin(claude0ResurrectDir(root));
  expect(await resolveResurrect(root, true)).toEqual({ source: "user", path: a });
});

test("the legacy .tmux/plugins path is probed second", async () => {
  const [, b] = userResurrectDirs(root);
  await seedPlugin(b);
  await seedPlugin(claude0ResurrectDir(root));
  expect(await resolveResurrect(root)).toEqual({ source: "user", path: b });
});

test("a live @resurrect-save-dir suppresses the claude0-owned copy", async () => {
  // The option can only come from a user's resurrect config — an unconventionally
  // located copy the path probe misses. Loading claude0's clone beside it would
  // double-load the plugin.
  await seedPlugin(claude0ResurrectDir(root));
  expect(await resolveResurrect(root, true)).toEqual({ source: "user-elsewhere", path: null });
});

test("the claude0-owned clone is the fallback; nothing at all resolves to none", async () => {
  expect(await resolveResurrect(root)).toEqual({ source: "none", path: null });
  await seedPlugin(claude0ResurrectDir(root));
  expect(await resolveResurrect(root)).toEqual({
    source: "claude0",
    path: claude0ResurrectDir(root),
  });
});

test("a plugin dir without scripts/save.sh does not count as an install", async () => {
  const [a] = userResurrectDirs(root);
  await mkdir(a, { recursive: true });
  expect(await resolveResurrect(root)).toEqual({ source: "none", path: null });
});

// --- resurrectCommand -------------------------------------------------------

test("save runs quiet, restore doesn't, both through explicit bash", () => {
  expect(resurrectCommand("/x/tmux-resurrect", "save")).toEqual(["bash", "/x/tmux-resurrect/scripts/save.sh", "quiet"]);
  expect(resurrectCommand("/x/tmux-resurrect", "restore")).toEqual(["bash", "/x/tmux-resurrect/scripts/restore.sh"]);
});

test("the daemon's periodic save runs only on darwin with an invocable plugin", () => {
  // Linux hosts already run the monitor unit's save loop — a second saver there
  // would be redundant; user-elsewhere/none leave nothing to exec.
  const user = { source: "user", path: "/x/tmux-resurrect" } as const;
  expect(daemonSaveCommand(user, "darwin")).toEqual(["bash", "/x/tmux-resurrect/scripts/save.sh", "quiet"]);
  expect(daemonSaveCommand(user, "linux")).toBeNull();
  expect(daemonSaveCommand({ source: "user-elsewhere", path: null }, "darwin")).toBeNull();
  expect(daemonSaveCommand({ source: "none", path: null }, "darwin")).toBeNull();
});

test("the clone creates the parent dir and checks out the pinned commit, never master", () => {
  const dir = "/h/.config/claude0/plugins/tmux-resurrect";
  expect(RESURRECT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  expect(cloneResurrectCommands(dir)).toEqual([
    ["mkdir", "-p", "/h/.config/claude0/plugins"],
    ["git", "clone", "--quiet", "https://github.com/tmux-plugins/tmux-resurrect", dir],
    ["git", "-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", RESURRECT_COMMIT],
  ]);
});
