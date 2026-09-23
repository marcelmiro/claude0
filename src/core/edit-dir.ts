/**
 * Where a session's work actually lands: the checkout of its most recent file edit.
 *
 * A session that runs `git worktree add` and then edits by absolute path keeps its tmux
 * pane in the base checkout, so pane cwd reports the default branch and every branch-keyed
 * lookup (the PR chip) goes blind. Edits are the ownership signal — reading or listing a
 * worktree is not — so this follows the last Edit/Write/MultiEdit/NotebookEdit whose path
 * sits under the base repo. Any edit inside a worktree counts, its `.plans/` included (a
 * session that moves on to a new worktree plans there first); a `.plans/` edit in the base
 * checkout does not (planning before the worktree exists, or moving the plan back on
 * cleanup, both trail the code they belong to).
 *
 * The scan also keeps the session's own PR — the last same-repo one it created or edited
 * (Claude Code tags those Bash results with `gitOperation.pr`), or the one found for its
 * live worktree: once a worktree is removed after its PR landed there is no checkout left
 * to key on. A PR URL that is only mentioned (a skill body, a citation) is not the session's.
 *
 * Incremental: the transcript is streamed once from the cached byte offset, so a multi-MB
 * log costs one full pass ever and a tail read thereafter.
 */
import { stat } from "node:fs/promises";
import { jsonlLines } from "./jsonl-reader";
import { WORKTREES_DIR } from "./git";
import { resolveTranscriptPath } from "./last-turn";
import { branchPullRequest, pullRequestByNumber, type PullRequestInfo } from "./pull-request";

export interface EditScan {
  /** Transcript the offset belongs to — a session whose live file moves rescans from 0. */
  path: string;
  offset: number;
  /** Checkout of the last in-repo edit; absent when the scan found none yet. */
  dir?: string;
  /** Last PR of this repo the session created or edited, or its worktree's PR. */
  lastPr?: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const PR_ACTIONS = new Set(["created", "edited"]);

/** The worktree (by the `<base>/${WORKTREES_DIR}/<name>` convention) or base checkout a path falls in. */
export function editCheckout(filePath: string, base: string): string | null {
  if (!filePath.startsWith(`${base}/`)) return null;
  const rest = filePath.slice(base.length);
  const wt = `/${WORKTREES_DIR}/`;
  if (rest.startsWith(wt)) return base + wt + rest.slice(wt.length).split("/")[0];
  return rest.startsWith("/.plans/") ? null : base;
}

export async function scanEditDir(
  sessionId: string,
  repo: { base: string; slug: string },
  prev?: EditScan,
  projectsDir?: string,
): Promise<EditScan | null> {
  const { base, slug } = repo;
  const prUrl = slug ? `https://github.com/${slug}/pull/` : null;
  try {
    const path = await resolveTranscriptPath(sessionId, projectsDir);
    if (!path) return null;
    const size = Bun.file(path).size;
    const scan: EditScan = prev?.path === path && prev.offset <= size ? { ...prev } : { path, offset: 0 };
    if (scan.offset >= size) return scan;
    for await (const line of jsonlLines(path, scan.offset)) {
      const prOp = prUrl !== null && line.includes('"gitOperation"');
      if (!prOp && !line.includes('"tool_use"')) continue;
      let rec: { message?: { content?: unknown }; toolUseResult?: { gitOperation?: { pr?: { number?: unknown; url?: unknown; action?: unknown } } } };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // partial trailing line mid-write — the next pass rescans from `size`
      }
      const pr = rec.toolUseResult?.gitOperation?.pr;
      if (prOp && typeof pr?.number === "number" && pr.url === prUrl + pr.number && PR_ACTIONS.has(String(pr.action))) {
        scan.lastPr = pr.number;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as { type?: string; name?: string; input?: { file_path?: unknown; notebook_path?: unknown } }[]) {
        if (c.type !== "tool_use" || !EDIT_TOOLS.has(c.name ?? "")) continue;
        const fp = c.input?.file_path ?? c.input?.notebook_path;
        const dir = typeof fp === "string" ? editCheckout(fp, base) : null;
        if (dir) scan.dir = dir;
      }
    }
    scan.offset = size;
    return scan;
  } catch {
    return prev ?? null;
  }
}

/** `scan.dir` if that checkout still exists on disk, else `fallback`. */
export async function liveEditDir(scan: EditScan | null | undefined, fallback: string): Promise<string> {
  if (!scan?.dir || scan.dir === fallback) return fallback;
  try {
    return (await stat(scan.dir)).isDirectory() ? scan.dir : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The PR a base-checkout session is working on: its live worktree's (pinned into
 * `scan.lastPr` so it survives cleanup), else its own last PR, else the pane's branch.
 */
export async function workPullRequest(
  scan: EditScan | undefined,
  pane: string,
  lookup = { byBranch: branchPullRequest, byNumber: pullRequestByNumber },
): Promise<PullRequestInfo> {
  const dir = await liveEditDir(scan, pane);
  let pr: PullRequestInfo | undefined;
  if (dir !== pane) {
    pr = await lookup.byBranch(dir);
    if (scan && "number" in pr) scan.lastPr = pr.number;
  } else if (scan?.lastPr) pr = await lookup.byNumber(pane, scan.lastPr);
  return pr ?? lookup.byBranch(pane);
}
