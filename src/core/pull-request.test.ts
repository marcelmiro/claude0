import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { githubSlug, compareUrl, branchPullRequest } from "./pull-request";

// --- githubSlug ---

test("githubSlug parses ssh, https and .git-less remotes", () => {
  expect(githubSlug("git@github.com:marcelmiro/claude0.git")).toBe("marcelmiro/claude0");
  expect(githubSlug("https://github.com/throxy-ai/throxy.git")).toBe("throxy-ai/throxy");
  expect(githubSlug("https://github.com/throxy-ai/throxy")).toBe("throxy-ai/throxy");
  expect(githubSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
});

test("githubSlug rejects non-GitHub remotes rather than guessing", () => {
  expect(githubSlug("git@gitlab.com:owner/repo.git")).toBe("");
  expect(githubSlug("/srv/git/bare.git")).toBe("");
  expect(githubSlug("")).toBe("");
});

// --- compareUrl ---

test("compareUrl keeps slashes in a branch name but escapes the segments", () => {
  // `marcelmiro/eng-80-…` is a real branch shape here — a percent-encoded slash 404s.
  expect(compareUrl("https://github.com/o/r", "marcelmiro/eng-80 x")).toBe(
    "https://github.com/o/r/compare/marcelmiro/eng-80%20x?expand=1",
  );
});

// --- branchPullRequest ---

test("a repo with no remote yields no PR surface (never shells out to gh)", async () => {
  const dir = mkdtempSync(`${tmpdir()}/c0-pr-`);
  try {
    await Bun.$`git init -q ${dir}`.nothrow().quiet();
    await Bun.write(`${dir}/a.txt`, "a");
    await Bun.$`git -C ${dir} add -A`.nothrow().quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    expect(await branchPullRequest(dir)).toEqual({ state: "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default branch yields no PR surface — compare/main would target itself", async () => {
  const dir = mkdtempSync(`${tmpdir()}/c0-pr-`);
  try {
    await Bun.$`git init -q -b main ${dir}`.nothrow().quiet();
    await Bun.write(`${dir}/a.txt`, "a");
    await Bun.$`git -C ${dir} add -A`.nothrow().quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    await Bun.$`git -C ${dir} remote add origin git@github.com:owner/repo.git`.nothrow().quiet();
    expect(await branchPullRequest(dir)).toEqual({ state: "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fake `gh` first on PATH: `answer` is what it prints to stderr before exiting 1.
async function withFakeGh(answer: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(`${tmpdir()}/c0-pr-`);
  const bin = `${dir}/bin`;
  const path = process.env.PATH;
  try {
    await Bun.write(`${bin}/gh`, `#!/bin/sh\necho '${answer}' >&2\nexit 1\n`);
    await Bun.$`chmod +x ${bin}/gh`.quiet();
    process.env.PATH = `${bin}:${path}`;
    const repo = `${dir}/repo`;
    await Bun.$`git init -q -b main ${repo}`.nothrow().quiet();
    await Bun.write(`${repo}/a.txt`, "a");
    await Bun.$`git -C ${repo} add -A`.nothrow().quiet();
    await Bun.$`git -C ${repo} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    await Bun.$`git -C ${repo} remote add origin git@github.com:owner/repo.git`.nothrow().quiet();
    await Bun.$`git -C ${repo} checkout -q -b feature/x`.nothrow().quiet();
    await run(repo);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unpushed feature branch with no PR reports local-only, not a bogus compare link", async () => {
  await withFakeGh('no pull requests found for branch "feature/x"', async (repo) => {
    expect(await branchPullRequest(repo)).toEqual({ state: "local-only", branch: "feature/x" });
  });
});

test("a failed gh lookup renders nothing rather than a guessed 'no PR' (missing, never wrong)", async () => {
  await withFakeGh("error connecting to api.github.com", async (repo) => {
    expect(await branchPullRequest(repo)).toEqual({ state: "none" });
  });
});
