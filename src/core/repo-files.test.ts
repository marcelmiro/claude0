import { expect, test, beforeAll, afterAll } from "bun:test";
import { realpathSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileDiff, safeRepoPath, changedFiles, baseRef, syncTiers, rangeDiff } from "./repo-files";

// --- safeRepoPath: the containment guard the /diff, /changes routes lean on ---

let guardRoot: string;
beforeAll(() => {
  guardRoot = realpathSync(mkdtempSync(`${tmpdir()}/rf-guard-`));
  mkdirSync(`${guardRoot}/src`);
  writeFileSync(`${guardRoot}/src/app.ts`, "ok");
  writeFileSync(`${guardRoot}/.env`, "SECRET=1");
  symlinkSync("/etc/passwd", `${guardRoot}/escape`); // symlink FILE out of repo
  symlinkSync("/etc", `${guardRoot}/etcdir`); // symlink DIR out of repo
});
afterAll(() => rmSync(guardRoot, { recursive: true, force: true }));

test("in-repo file is allowed", () => {
  expect(safeRepoPath(guardRoot, "src/app.ts")).toBe(`${guardRoot}/src/app.ts`);
});
test("in-repo dotfile (.env) is allowed — conscious tradeoff, own machine", () => {
  expect(safeRepoPath(guardRoot, ".env")).toBe(`${guardRoot}/.env`);
});
test("../ traversal is rejected", () => {
  expect(safeRepoPath(guardRoot, "../../../etc/passwd")).toBeNull();
});
test("absolute path outside repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "/etc/passwd")).toBeNull();
});
test("dotdot that normalizes back inside is allowed", () => {
  expect(safeRepoPath(guardRoot, "src/../src/app.ts")).toBe(`${guardRoot}/src/app.ts`);
});
test("symlink FILE escaping the repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "escape")).toBeNull();
});
test("path THROUGH a symlinked dir escaping the repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "etcdir/passwd")).toBeNull();
});
test("non-existent target INSIDE root is allowed (deleted/renamed file)", () => {
  expect(safeRepoPath(guardRoot, "src/gone.ts")).toBe(`${guardRoot}/src/gone.ts`);
});

// --- fileDiff / changedFiles / baseRef on a throwaway repo ---

async function tempRepo(): Promise<string> {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/rf-repo-`));
  await Bun.$`git -C ${root} init -q`.quiet();
  await Bun.$`git -C ${root} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${root} config user.name t`.quiet();
  return root;
}

test("modified tracked file yields adds AND dels", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "one\ntwo\nthree\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/a.txt`, "one\nCHANGED\nthree\nfour\n");
  const d = await fileDiff(root, `${root}/a.txt`, "a.txt");
  expect(d.add).toBeGreaterThan(0);
  expect(d.del).toBeGreaterThan(0);
  expect(d.patch).toContain("CHANGED");
  expect(d.status).toBe("M");
  rmSync(root, { recursive: true, force: true });
});

test("untracked file renders as all-additions", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/new.txt`, "alpha\nbeta\n");
  const d = await fileDiff(root, `${root}/new.txt`, "new.txt");
  expect(d.add).toBe(2);
  expect(d.del).toBe(0);
  expect(d.status).toBe("A");
  expect(d.empty).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("deleted tracked file reports status D", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/gone.txt`, "one\ntwo\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  rmSync(`${root}/gone.txt`);
  const d = await fileDiff(root, `${root}/gone.txt`, "gone.txt");
  expect(d.status).toBe("D");
  expect(d.del).toBeGreaterThan(0);
  rmSync(root, { recursive: true, force: true });
});

test("unchanged tracked file is empty (no whole-file re-diff)", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "stable\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  const d = await fileDiff(root, `${root}/a.txt`, "a.txt");
  expect(d.empty).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("binary file is flagged, not shipped", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/img.bin`, Buffer.from([0, 1, 2, 0, 255, 3]));
  const d = await fileDiff(root, `${root}/img.bin`, "img.bin");
  expect(d.binary).toBe(true);
  expect(d.patch).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("unborn HEAD (no commits) diffs against empty tree without throwing", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/first.txt`, "hello\n");
  await Bun.$`git -C ${root} add -A`.quiet(); // staged but never committed
  const d = await fileDiff(root, `${root}/first.txt`, "first.txt");
  expect(d.add).toBe(1);
  expect(d.patch).toContain("hello");
  rmSync(root, { recursive: true, force: true });
});

// --- baseRef + changedFiles: the "PR view" (branch vs base, committed + uncommitted) ---

test("baseRef picks the default branch; changedFiles shows committed + uncommitted + untracked", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/base.txt`, "one\n");
  writeFileSync(`${root}/keep.txt`, "keep\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet(); // deterministic default branch
  // Feature branch: a committed new file + a committed modification to a tracked file.
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "added on branch\n");
  writeFileSync(`${root}/base.txt`, "one\ntwo\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  // An uncommitted working-tree edit + an untracked new file.
  writeFileSync(`${root}/keep.txt`, "keep\nCHANGED\n");
  writeFileSync(`${root}/untracked.txt`, "u\n");

  const { ref, label } = await baseRef(root);
  expect(label).toBe("main"); // no origin → falls back to local main
  const files = await changedFiles(root, ref);
  const paths = files.map((f) => f.path).sort();
  // committed-new + committed-modify + uncommitted + untracked all appear vs the base.
  expect(paths).toEqual(["base.txt", "committed.txt", "keep.txt", "untracked.txt"]);
  // status letters vs base: new files A, modified M.
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]));
  expect(byPath["committed.txt"]).toBe("A");
  expect(byPath["untracked.txt"]).toBe("A");
  expect(byPath["base.txt"]).toBe("M");
  expect(byPath["keep.txt"]).toBe("M");
  rmSync(root, { recursive: true, force: true });
});

test("non-ASCII filename: real UTF-8 path (not git's C-quoted form), and its diff is reachable", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  // An accented committed file + an accented untracked file — both would be C-quoted by
  // default git output ("caf\303\251.txt"), which used to render as garbage and be untappable.
  writeFileSync(`${root}/café.txt`, "hello\n");
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm accented`.quiet();
  writeFileSync(`${root}/naïve.txt`, "u\n"); // untracked, also accented

  const { ref } = await baseRef(root);
  const files = await changedFiles(root, ref);
  const paths = files.map((f) => f.path).sort();
  expect(paths).toEqual(["café.txt", "naïve.txt"]); // real UTF-8, not "caf\303\251.txt"
  // The path round-trips to a reachable diff (this is what the phone's tap does).
  const abs = safeRepoPath(root, "café.txt");
  expect(abs).toBe(`${root}/café.txt`);
  const d = await fileDiff(root, abs!, "café.txt");
  expect(d.empty).toBeUndefined();
  expect(d.status).toBe("A");
  expect(d.patch).toContain("hello");
  rmSync(root, { recursive: true, force: true });
});

test("rename is one R row (new path + real churn), not a delete+add pair", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/old.txt`, "line1\nline2\nline3\nline4\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  await Bun.$`git -C ${root} mv old.txt new.txt`.quiet();
  writeFileSync(`${root}/new.txt`, "line1\nCHANGED\nline3\nline4\nline5\n"); // rename + small edit
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm "rename+edit"`.quiet();

  const { ref } = await baseRef(root);
  const files = await changedFiles(root, ref);
  expect(files.length).toBe(1); // ONE row, not old.txt(D) + new.txt(A)
  const f = files[0]!;
  expect(f.status).toBe("R");
  expect(f.path).toBe("new.txt");
  expect(f.orig).toBe("old.txt");
  expect(f.add).toBeLessThan(5); // real churn, NOT the whole 5-line file re-added
  // Tapping it renders the true rename diff (the CHANGED hunk), not a fresh add of new.txt.
  const d = await fileDiff(root, `${root}/new.txt`, "new.txt", "old.txt");
  expect(d.status).toBe("R");
  expect(d.patch).toContain("CHANGED");
  expect(d.add).toBeLessThan(5);
  rmSync(root, { recursive: true, force: true });
});

test("baseRef discovers a non-standard default branch (develop)", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/base.txt`, "one\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M develop`.quiet(); // default branch is neither main nor master
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "added\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  const { label } = await baseRef(root);
  expect(label).toBe("develop"); // committed branch work is now visible vs develop
  const paths = (await changedFiles(root, (await baseRef(root)).ref)).map((f) => f.path);
  expect(paths).toContain("committed.txt");
  rmSync(root, { recursive: true, force: true });
});

test("changedFiles: on the default branch with no divergence → only uncommitted show", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  writeFileSync(`${root}/a.txt`, "x\ny\n"); // uncommitted only
  const { ref } = await baseRef(root); // merge-base(HEAD, main) == HEAD
  const paths = (await changedFiles(root, ref)).map((f) => f.path);
  expect(paths).toEqual(["a.txt"]);
  rmSync(root, { recursive: true, force: true });
});

// --- pathspec magic: a filename can contain glob metacharacters ---

/** Repo with a bracketed path (Next.js dynamic segment) and a sibling the glob would match. */
async function bracketRepo(): Promise<string> {
  const root = await tempRepo();
  mkdirSync(`${root}/app/[slug]`, { recursive: true });
  mkdirSync(`${root}/app/s`, { recursive: true });
  writeFileSync(`${root}/app/[slug]/page.tsx`, "export const dynamic = 1\n");
  writeFileSync(`${root}/app/s/page.tsx`, "export const sibling = 1\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  return root;
}

test("bracketed path: unchanged file is empty even when the glob's sibling changed", async () => {
  const root = await bracketRepo();
  writeFileSync(`${root}/app/s/page.tsx`, "export const sibling = 2\n"); // only the SIBLING changes
  const d = await fileDiff(root, `${root}/app/[slug]/page.tsx`, "app/[slug]/page.tsx");
  // As a glob, `app/[slug]/page.tsx` matches `app/s/page.tsx` — which would render the
  // sibling's patch under the bracketed file's name.
  expect(d.empty).toBe(true);
  expect(d.patch).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("bracketed path: shows its OWN patch, not the sibling's, when both changed", async () => {
  const root = await bracketRepo();
  writeFileSync(`${root}/app/[slug]/page.tsx`, "export const dynamic = 2\n");
  writeFileSync(`${root}/app/s/page.tsx`, "export const sibling = 2\n");
  const d = await fileDiff(root, `${root}/app/[slug]/page.tsx`, "app/[slug]/page.tsx");
  expect(d.patch).toContain("dynamic = 2");
  expect(d.patch).not.toContain("sibling"); // no second file's hunks appended
  expect(d.add).toBe(1);
  expect(d.del).toBe(1);
  rmSync(root, { recursive: true, force: true });
});

test("bracketed path: untracked new file still resolves to all-additions", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  mkdirSync(`${root}/app/[id]`, { recursive: true });
  writeFileSync(`${root}/app/[id]/route.ts`, "a\nb\n");
  const d = await fileDiff(root, `${root}/app/[id]/route.ts`, "app/[id]/route.ts");
  expect(d.status).toBe("A");
  expect(d.add).toBe(2);
  rmSync(root, { recursive: true, force: true });
});

test("changedFiles path round-trips into a reachable diff for a bracketed name", async () => {
  const root = await bracketRepo();
  writeFileSync(`${root}/app/[slug]/page.tsx`, "export const dynamic = 3\n");
  const { ref } = await baseRef(root);
  const files = await changedFiles(root, ref);
  const row = files.find((f) => f.path.includes("[slug]"));
  expect(row).toBeDefined();
  const d = await fileDiff(root, `${root}/${row!.path}`, row!.path);
  expect(d.empty).toBeUndefined();
  expect(d.patch).toContain("dynamic = 3");
  rmSync(root, { recursive: true, force: true });
});

// --- baseRef: a dangling origin/HEAD must not collapse the PR view ---

test("dangling origin/HEAD symref falls through to a local default branch", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  // Left behind by a master → main rename: the symref resolves, its target does not exist.
  await Bun.$`git -C ${root} symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master`.quiet();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "added\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  const { label, ref } = await baseRef(root);
  expect(label).toBe("main"); // not "HEAD" — the branch's committed work stays visible
  const paths = (await changedFiles(root, ref)).map((f) => f.path);
  expect(paths).toContain("committed.txt");
  rmSync(root, { recursive: true, force: true });
});

// --- syncTiers: the chain base → origin/<branch> → HEAD → working tree ---

/** Repo with a real bare `origin`, `main` pushed, one committed file (`base.txt`). */
async function remoteRepo(): Promise<{ root: string; bare: string; clean: () => void }> {
  const root = await tempRepo();
  const bare = realpathSync(mkdtempSync(`${tmpdir()}/rf-bare-`));
  await Bun.$`git init -q --bare ${bare}`.quiet();
  writeFileSync(`${root}/base.txt`, "one\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  await Bun.$`git -C ${root} remote add origin ${bare}`.quiet();
  await Bun.$`git -C ${root} push -q -u origin main`.quiet();
  return {
    root,
    bare,
    clean: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

const tiersOf = async (root: string) => (await syncTiers(root, (await baseRef(root)).ref))!;
const tierByKey = (t: Awaited<ReturnType<typeof tiersOf>>, key: string) => t.tiers.find((x) => x.key === key);

test("syncTiers: one file touched in all three ranges appears in each, with THAT segment's LOC", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/base.txt`, "one\ntwo\n"); // pushed segment: +1
  await Bun.$`git -C ${root} commit -qam pushed`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  writeFileSync(`${root}/base.txt`, "one\ntwo\nthree\n"); // unpushed segment: +1
  await Bun.$`git -C ${root} commit -qam local`.quiet();
  writeFileSync(`${root}/base.txt`, "one\ntwo\nthree\nfour\n"); // uncommitted segment: +1

  const sync = await tiersOf(root);
  expect(sync.tiers.map((t) => t.key)).toEqual(["uncommitted", "unpushed", "pushed"]);
  for (const key of ["uncommitted", "unpushed", "pushed"]) {
    const t = tierByKey(sync, key)!;
    expect(t.files.map((f) => f.path)).toEqual(["base.txt"]);
    expect(t.add).toBe(1); // that range's churn, NOT the branch's cumulative +3
    expect(t.del).toBe(0);
    expect(t.add).toBe(t.files.reduce((s, f) => s + f.add, 0)); // header total == sum of its rows
  }
  expect(sync.pushed).toBe(true);
  expect(sync.unpushedCount).toBe(1); // one FILE the Mac still holds, not two tier entries
  clean();
});

test("syncTiers: never-pushed branch has no On-GitHub tier and its unpushed tier spans base..HEAD", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  const sync = await tiersOf(root);
  expect(sync.pushed).toBe(false);
  expect(tierByKey(sync, "pushed")).toBeUndefined();
  expect(tierByKey(sync, "unpushed")!.files.map((f) => f.path)).toEqual(["committed.txt"]);
  clean();
});

test("syncTiers: detached HEAD has no branch to push, so no chain", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q --detach`.quiet();
  expect(await syncTiers(root, (await baseRef(root)).ref)).toBeNull();
  clean();
});

test("syncTiers measures against origin/<branch> by NAME, ignoring a misleading @{upstream}", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/pushed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm pushed`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  // The state two live repos are actually in: a feature branch tracking origin/main.
  await Bun.$`git -C ${root} branch --set-upstream-to=origin/main feature`.quiet();
  writeFileSync(`${root}/local.txt`, "y\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm local`.quiet();

  const sync = await tiersOf(root);
  // Measured against origin/feature: only the second commit is unpushed. Against @{upstream}
  // (origin/main) BOTH files would be, reporting pushed work as still on the Mac.
  expect(tierByKey(sync, "unpushed")!.files.map((f) => f.path)).toEqual(["local.txt"]);
  expect(tierByKey(sync, "pushed")!.files.map((f) => f.path)).toEqual(["pushed.txt"]);
  clean();
});

test("remote ahead of local: no phantom deletions in the unpushed tier (three-dot, not two-dot)", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/theirs.txt`, "pushed from another worktree\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm theirs`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  await Bun.$`git -C ${root} reset -q --hard HEAD~1`.quiet(); // local behind its own remote

  const sync = await tiersOf(root);
  // `git diff origin/feature HEAD` (two-dot) invents `D theirs.txt` — a file this branch never
  // deleted, reported as un-landed local work.
  expect(tierByKey(sync, "unpushed")).toBeUndefined();
  expect(sync.unpushedCount).toBe(0);
  expect(tierByKey(sync, "pushed")!.files.map((f) => f.path)).toEqual(["theirs.txt"]);
  clean();
});

test("branch rebased after a force-push: the On-GitHub tier has no phantom deletions either", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/feat.txt`, "f\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  // main moves on and the branch is rebased onto it — `base` is no longer an ancestor of
  // origin/feature, which still points at the pre-rebase commit.
  await Bun.$`git -C ${root} checkout -q main`.quiet();
  writeFileSync(`${root}/mainonly.txt`, "m\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm mainwork`.quiet();
  await Bun.$`git -C ${root} push -q origin main`.quiet();
  await Bun.$`git -C ${root} checkout -q feature`.quiet();
  await Bun.$`git -C ${root} rebase -q main`.quiet();

  const pushedTier = tierByKey(await tiersOf(root), "pushed")!;
  expect(pushedTier.files.map((f) => f.path)).toEqual(["feat.txt"]);
  expect(pushedTier.files.some((f) => f.status === "D")).toBe(false); // not `D mainonly.txt`
  clean();
});

test("syncTiers: an untracked file is uncommitted-only, status A", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/untracked.txt`, "u\n");
  const sync = await tiersOf(root);
  expect(sync.tiers.map((t) => t.key)).toEqual(["uncommitted"]);
  expect(tierByKey(sync, "uncommitted")!.files).toEqual([
    { path: "untracked.txt", status: "A", add: 1, del: 0, binary: false },
  ]);
  clean();
});

test("rename inside an unpushed commit is one R row carrying its old path, and its patch opens", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/old.txt`, "line1\nline2\nline3\nline4\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm add`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  await Bun.$`git -C ${root} mv old.txt new.txt`.quiet();
  writeFileSync(`${root}/new.txt`, "line1\nCHANGED\nline3\nline4\n");
  await Bun.$`git -C ${root} commit -qam rename`.quiet();

  const t = tierByKey(await tiersOf(root), "unpushed")!;
  expect(t.files.length).toBe(1);
  expect(t.files[0]!.status).toBe("R");
  expect(t.files[0]!.orig).toBe("old.txt");
  // Tapping the row asks for the same range the row's LOC was measured over.
  const d = await rangeDiff(root, t.from, t.to, "new.txt", "old.txt");
  expect(d.status).toBe("R");
  expect(d.patch).toContain("CHANGED");
  expect(d.add).toBeLessThan(4); // real churn, not the whole file re-added
  clean();
});

test("rangeDiff shows only the segment's churn, not the branch's cumulative diff", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/base.txt`, "one\nPUSHED\n");
  await Bun.$`git -C ${root} commit -qam pushed`.quiet();
  await Bun.$`git -C ${root} push -q -u origin feature`.quiet();
  writeFileSync(`${root}/base.txt`, "one\nPUSHED\nLOCAL\n");
  await Bun.$`git -C ${root} commit -qam local`.quiet();

  const sync = await tiersOf(root);
  const landed = tierByKey(sync, "pushed")!;
  const d = await rangeDiff(root, landed.from, landed.to, "base.txt");
  expect(d.patch).toContain("PUSHED");
  expect(d.patch).not.toContain("LOCAL"); // the unpushed commit belongs to the next tier
  clean();
});

test("changedFiles in ref-to-ref mode skips the untracked pass (the working tree isn't an endpoint)", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "c\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  writeFileSync(`${root}/untracked.txt`, "u\n");
  const paths = (await changedFiles(root, "origin/main", "HEAD")).map((f) => f.path);
  expect(paths).toEqual(["committed.txt"]);
  clean();
});

test("unpushedCount is the distinct union: a file both committed-unpushed and dirty counts once", async () => {
  const { root, clean } = await remoteRepo();
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/base.txt`, "one\ntwo\n");
  writeFileSync(`${root}/other.txt`, "o\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm local`.quiet();
  writeFileSync(`${root}/base.txt`, "one\ntwo\nthree\n"); // same file, now also dirty

  const sync = await tiersOf(root);
  const sizes = tierByKey(sync, "uncommitted")!.files.length + tierByKey(sync, "unpushed")!.files.length;
  expect(sizes).toBe(3); // base.txt twice + other.txt
  expect(sync.unpushedCount).toBe(2); // base.txt, other.txt
  clean();
});

test("untracked numstat: last line without newline counts, empty is 0, NUL is binary, symlink is its target line", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/nonl.txt`, "a\nb");
  writeFileSync(`${root}/empty.txt`, "");
  writeFileSync(`${root}/blob.bin`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a]));
  symlinkSync("nonl.txt", `${root}/link`);
  const byPath = Object.fromEntries((await changedFiles(root, "HEAD")).map((f) => [f.path, f]));
  expect(byPath["nonl.txt"]).toMatchObject({ status: "A", add: 2, del: 0, binary: false });
  expect(byPath["empty.txt"]).toMatchObject({ status: "A", add: 0, del: 0, binary: false });
  expect(byPath["blob.bin"]).toMatchObject({ status: "A", add: 0, del: 0, binary: true });
  expect(byPath["link"]).toMatchObject({ status: "A", add: 1, del: 0, binary: false });
  rmSync(root, { recursive: true, force: true });
});

// --- untracked nested repos are not files ---

test("untracked nested git repo does not become a changed-file row", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  mkdirSync(`${root}/vendored`);
  await Bun.$`git -C ${root}/vendored init -q`.quiet();
  writeFileSync(`${root}/vendored/inner.txt`, "y\n");
  const { ref } = await baseRef(root);
  const paths = (await changedFiles(root, ref)).map((f) => f.path);
  expect(paths.some((p) => p.endsWith("/"))).toBe(false); // no nameless, un-openable row
  expect(paths).not.toContain("vendored/");
  rmSync(root, { recursive: true, force: true });
});
