import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { recentRepos } from "./recent-repos";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const DAY = 86_400_000;
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function transcripts(project: string, ages: number[]) {
  mkdirSync(`${dir}/${project}`, { recursive: true });
  ages.forEach((days, i) => {
    const f = `${dir}/${project}/s${i}.jsonl`;
    writeFileSync(f, "{}\n");
    const t = (NOW - days * DAY) / 1000;
    utimesSync(f, t, t);
  });
}

test("recentRepos: ranks by sessions in the last 14 days, folding managed worktrees into their base", async () => {
  dir = mkdtempSync(`${tmpdir()}/c0-recent-`);
  transcripts("-dev-a", [1]);
  transcripts("-dev-b", [1, 2]);
  transcripts("-dev-a--claude-worktrees-tf-1", [3, 4]); // a: 3 total
  transcripts("-dev-c", [20, 30]); // outside the window
  transcripts("-dev-b-other", [1, 1, 1, 1]); // a different repo sharing b's prefix
  transcripts("-tmp-scratch", [0, 0, 0]); // not a listed repo
  const got = await recentRepos(["/dev/a", "/dev/b", "/dev/c"], { projectsDir: dir, now: NOW });
  expect(got).toEqual(["/dev/a", "/dev/b"]);
});

test("recentRepos: ties go to the latest touch; dot-preserving folder names still match", async () => {
  dir = mkdtempSync(`${tmpdir()}/c0-recent-`);
  transcripts("-home--dotfiles", [5]);
  transcripts("-home-.dotfiles", [1]); // older Claude encoding of the same path
  transcripts("-dev-x", [0, 6]);
  const got = await recentRepos(["/home/.dotfiles", "/dev/x"], { projectsDir: dir, now: NOW });
  expect(got).toEqual(["/dev/x", "/home/.dotfiles"]);
});

test("recentRepos: a missing projects dir yields nothing", async () => {
  expect(await recentRepos(["/dev/a"], { projectsDir: "/nonexistent/c0", now: NOW })).toEqual([]);
});
