/**
 * Where a session's work actually lands: the checkout of its most recent file edit.
 *
 * A session that runs `git worktree add` and then edits by absolute path keeps its tmux
 * pane in the base checkout, so pane cwd reports the default branch and every branch-keyed
 * lookup (the PR chip) goes blind. Edits are the ownership signal — reading or listing a
 * worktree is not — so this follows the last Edit/Write/MultiEdit/NotebookEdit whose path
 * sits under the base repo, ignoring `.plans/` (scratch that trails the code it planned).
 *
 * Incremental: the transcript is streamed once from the cached byte offset, so a multi-MB
 * log costs one full pass ever and a tail read thereafter. A worktree removed after its
 * PR landed resolves to the base checkout again.
 */
import { stat } from "node:fs/promises";
import { jsonlLines } from "./jsonl-reader";
import { resolveTranscriptPath } from "./last-turn";

export interface EditScan {
  /** Transcript the offset belongs to — a session whose live file moves rescans from 0. */
  path: string;
  offset: number;
  /** Checkout of the last in-repo edit; absent when the scan found none yet. */
  dir?: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The worktree (by the `.claude/worktrees/<name>` convention) or base checkout a path falls in. */
export function editCheckout(filePath: string, base: string): string | null {
  if (!filePath.startsWith(`${base}/`) || filePath.includes("/.plans/")) return null;
  const m = filePath.slice(base.length).match(/^\/\.claude\/worktrees\/[^/]+/);
  return m ? base + m[0] : base;
}

export async function scanEditDir(
  sessionId: string,
  base: string,
  prev?: EditScan,
  projectsDir?: string,
): Promise<EditScan | null> {
  try {
    const path = await resolveTranscriptPath(sessionId, projectsDir);
    if (!path) return null;
    const size = Bun.file(path).size;
    const scan: EditScan = prev?.path === path && prev.offset <= size ? { ...prev } : { path, offset: 0 };
    if (scan.offset >= size) return scan;
    for await (const line of jsonlLines(path, scan.offset)) {
      if (!line.includes('"tool_use"')) continue;
      let rec: { message?: { content?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // partial trailing line mid-write — the next pass rescans from `size`
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
