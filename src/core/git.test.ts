import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath, readFile } from "fs/promises";
import { tmpdir } from "os";
import { cleanBranchToDir, getDefaultBranch, branchCheckedOutPath, listBranches, ensureWorktreeIgnore, getBaseRepoPath, discoverRepos } from "./git";
import { isTrunk } from "../ui/wizard";
import type { WizardBranch } from "../types";

// --- Pure helpers (no repo needed) ---

describe("cleanBranchToDir", () => {
  test("strips the prefix before the first slash", () => {
    expect(cleanBranchToDir("cursor/ev-4-agent-ticket-workflow-031d")).toBe(
      "ev-4-agent-ticket-workflow-031d",
    );
  });
  test("keeps the trailing hash (no hash stripping)", () => {
    expect(cleanBranchToDir("feature/login-a1b2")).toBe("login-a1b2");
  });
  test("passes through a name with no slash unchanged", () => {
    expect(cleanBranchToDir("main")).toBe("main");
  });
  test("only strips the first slash segment", () => {
    expect(cleanBranchToDir("a/b/c")).toBe("b/c");
  });
});

describe("isTrunk", () => {
  const b = (name: string, isRemote = false): WizardBranch => ({
    name,
    isRemote,
    isCurrent: false,
    fullRef: name,
  });
  test("matches the repo default branch", () => {
    expect(isTrunk(b("develop"), "develop")).toBe(true);
  });
  test("always treats main/master as trunk even when default differs", () => {
    expect(isTrunk(b("main"), "develop")).toBe(true);
    expect(isTrunk(b("master"), "develop")).toBe(true);
  });
  test("a feature branch is not trunk", () => {
    expect(isTrunk(b("cursor/ev-4-x"), "main")).toBe(false);
  });
  test("falls back to main when defaultBranch is empty", () => {
    expect(isTrunk(b("main"), "")).toBe(true);
    expect(isTrunk(b("feature"), "")).toBe(false);
  });
});

// --- Repo-backed helpers ---

let dir: string;

/** Run a git command in `dir`, throwing on failure. */
async function git(...args: string[]): Promise<string> {
  return (await Bun.$`git -C ${dir} ${args}`.quiet().text()).trim();
}

beforeEach(async () => {
  // realpath so paths match what `git worktree list` reports (macOS /var → /private/var).
  dir = await realpath(await mkdtemp(`${tmpdir()}/c0-git-`));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Init a repo on `main` with one commit and identity configured. */
async function initRepo(): Promise<void> {
  await Bun.$`git -C ${dir} init -b main`.quiet();
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await Bun.write(`${dir}/README.md`, "hi\n");
  await git("add", "-A");
  await git("commit", "-m", "init");
}

describe("getDefaultBranch", () => {
  test("falls back to main when origin/HEAD is unset", async () => {
    await initRepo();
    expect(await getDefaultBranch(dir)).toBe("main");
  });

  test("falls back to master when only master exists", async () => {
    await Bun.$`git -C ${dir} init -b master`.quiet();
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await Bun.write(`${dir}/README.md`, "hi\n");
    await git("add", "-A");
    await git("commit", "-m", "init");
    expect(await getDefaultBranch(dir)).toBe("master");
  });

  test("reads origin/HEAD when set", async () => {
    // Bare remote on `trunk`, cloned, with origin/HEAD recorded.
    const remote = await mkdtemp(`${tmpdir()}/c0-git-remote-`);
    try {
      await Bun.$`git init --bare -b trunk ${remote}`.quiet();
      await initRepo();
      await git("branch", "-m", "main", "trunk");
      await git("remote", "add", "origin", remote);
      await git("push", "-u", "origin", "trunk");
      await git("remote", "set-head", "origin", "-a");
      // Fresh path to dodge the module-level cache.
      expect(await getDefaultBranch(dir)).toBe("trunk");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
});

describe("branchCheckedOutPath", () => {
  test("returns null when the branch is not checked out anywhere", async () => {
    await initRepo();
    await git("branch", "feature");
    expect(await branchCheckedOutPath(dir, "feature")).toBeNull();
  });

  test("returns the worktree path when the branch is checked out there", async () => {
    await initRepo();
    await git("branch", "feature");
    const wt = `${dir}-feature`;
    try {
      await git("worktree", "add", wt, "feature");
      expect(await branchCheckedOutPath(dir, "feature")).toBe(wt);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  test("returns the main repo path when the branch is checked out there", async () => {
    // The most common collision the reuse pre-check must catch: reuse the branch
    // you're already sitting on. The main working tree is itself a worktree entry.
    await initRepo();
    expect(await branchCheckedOutPath(dir, "main")).toBe(dir);
  });
});

describe("managed worktree layout", () => {
  test("ensureWorktreeIgnore adds one local-only exclusion idempotently", async () => {
    await initRepo();
    await ensureWorktreeIgnore(dir);
    await ensureWorktreeIgnore(dir);
    const exclude = await readFile(`${dir}/.git/info/exclude`, "utf8");
    expect(exclude.split("\n").filter((line) => line === "/.claude/worktrees/")).toHaveLength(1);
  });

  test("a deleted managed worktree resolves structurally to its base repo", async () => {
    await initRepo();
    expect(await getBaseRepoPath(`${dir}/.claude/worktrees/deleted-feature`)).toBe(dir);
  });
});

describe("discoverRepos root entries", () => {
  test("a root that is a folder of repos is scanned; a root that is itself a repo counts as one repo", async () => {
    // `dir` acts as a scan root containing one repo; `dir` itself is not a repo.
    const child = `${dir}/child-repo`;
    await Bun.$`git init -b main ${child}`.quiet();
    const repoRoot = await realpath(await mkdtemp(`${tmpdir()}/c0-git-selfrepo-`));
    try {
      await Bun.$`git -C ${repoRoot} init -b main`.quiet();
      // Nested repo inside a repo-root must NOT be discovered (vendored, not yours).
      await Bun.$`git init -b main ${repoRoot}/vendored`.quiet();
      const repos = await discoverRepos([], [dir, repoRoot], []);
      const paths = repos.map((r) => r.path);
      expect(paths).toContain(child);
      expect(paths).toContain(repoRoot);
      expect(paths).not.toContain(dir);
      expect(paths).not.toContain(`${repoRoot}/vendored`);
      expect(repos.find((r) => r.path === repoRoot)?.name).toBe(repoRoot.split("/").pop());
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("getDefaultBranch caching", () => {
  test("second call returns the cached value for the same repo path", async () => {
    await initRepo();
    const first = await getDefaultBranch(dir);
    // Rename the branch out from under it; the cache should still return the old value.
    await git("branch", "-m", "main", "renamed");
    expect(await getDefaultBranch(dir)).toBe(first);
  });
});

describe("listBranches security filter", () => {
  test("drops branches whose short name starts with '-' (git option-injection guard)", async () => {
    await initRepo();
    // A hostile remote can carry such a ref; update-ref bypasses the CLI's own guard.
    await git("update-ref", "refs/heads/--upload-pack=touch${IFS}/tmp/x", "HEAD");
    const names = (await listBranches(dir)).map((b) => b.name);
    expect(names).toContain("main");
    expect(names.some((n) => n.startsWith("-"))).toBe(false);
  });
});

describe("worktree git behavior (reuse vs new-branch)", () => {
  test("reuse: `worktree add <dir> <branch>` adds no new branch ref", async () => {
    await initRepo();
    await git("branch", "feature");
    const before = (await git("branch", "--list")).split("\n").length;
    const wt = `${dir}-feature`;
    try {
      await git("worktree", "add", wt, "feature");
      expect((await Bun.$`git -C ${wt} branch --show-current`.quiet().text()).trim()).toBe("feature");
      const after = (await git("branch", "--list")).split("\n").length;
      expect(after).toBe(before); // no fork — same branch reused
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  test("new-branch: `worktree add <dir> -b <new> <base>` creates the new ref", async () => {
    await initRepo();
    const wt = `${dir}-new`;
    try {
      await git("worktree", "add", wt, "-b", "brand-new", "main");
      expect((await Bun.$`git -C ${wt} branch --show-current`.quiet().text()).trim()).toBe("brand-new");
      const branches = await git("branch", "--list");
      expect(branches).toContain("brand-new");
      expect(branches).toContain("main");
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});
