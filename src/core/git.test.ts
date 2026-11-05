import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, realpath } from "fs/promises";
import { tmpdir } from "os";
import { getBaseRepoPath, discoverRepos } from "./git";

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

describe("managed worktree layout", () => {
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
