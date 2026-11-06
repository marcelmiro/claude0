import { homedir } from "os";
import type { WizardRepo } from "../types";

/** Repo-local directory managed worktrees live in, relative to the base repo root. */
export const WORKTREES_DIR = ".claude/worktrees";

/**
 * Ticket-ID shape (Linear/Jira, e.g. ENG-2687) — the single source for every
 * ticket regex (label extraction here, branch-prefix trims in names.ts and the
 * sidebar). Compose with local anchoring; always match case-insensitively.
 */
export const TICKET_ID_SOURCE = "[a-zA-Z]{2,6}-\\d{2,}";

/** Extract a Linear/Jira-style ticket ID from a branch name (e.g. ENG-2687). */
export function extractTicketId(branch: string): string | null {
  const match = branch.match(new RegExp(`(?:^|\\/)(${TICKET_ID_SOURCE})(?=-|\\/|$)`, "i"));
  return match ? match[1].toUpperCase() : null;
}

// Persistent cache: worktree path → base repo path (survives across refresh cycles)
const baseRepoCache = new Map<string, string>();

/**
 * Resolve a worktree path to its base repo path.
 * For non-worktree repos, returns the same path. Cached across refreshes.
 */
export async function getBaseRepoPath(repoPath: string): Promise<string> {
  if (baseRepoCache.has(repoPath)) return baseRepoCache.get(repoPath)!;
  try {
    const gitCommonDir = (await Bun.$`git -C ${repoPath} rev-parse --path-format=absolute --git-common-dir`.quiet().text()).trim();
    const basePath = gitCommonDir.replace(/\/\.git\/?$/, "");
    baseRepoCache.set(repoPath, basePath);
    return basePath;
  } catch {
    // git failed — directory may be deleted (orphaned worktree). Managed worktrees
    // encode their base structurally (`<base>/.claude/worktrees/<name>`).
    const basePath = await inferManagedBaseRepo(repoPath) ?? repoPath;
    baseRepoCache.set(repoPath, basePath);
    return basePath;
  }
}

/** Infer `<base>` from a deleted `<base>/.claude/worktrees/<name>` path. */
async function inferManagedBaseRepo(repoPath: string): Promise<string | null> {
  const marker = `/${WORKTREES_DIR}/`;
  const at = repoPath.indexOf(marker);
  if (at <= 0) return null;
  const candidate = repoPath.slice(0, at);
  return await Bun.file(`${candidate}/.git/HEAD`).exists() ? candidate : null;
}

/**
 * List all worktrees for a repo via `git worktree list --porcelain`.
 * Returns `{ path, branch }` for every working tree, main first (`branch` is the
 * short name, or "detached"). Returns null when `basePath` isn't a git repo (e.g.
 * a session running in a non-repo dir like ~) so the caller can skip it.
 */
async function listWorktrees(basePath: string): Promise<Array<{ path: string; branch: string }> | null> {
  try {
    const out = await Bun.$`git -C ${basePath} worktree list --porcelain`.quiet().text();
    const entries: Array<{ path: string; branch: string }> = [];
    let cur: { path?: string; branch?: string } = {};
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) entries.push({ path: cur.path, branch: cur.branch || "detached" });
        cur = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("branch refs/heads/")) {
        cur.branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        cur.branch = "detached";
      }
    }
    if (cur.path) entries.push({ path: cur.path, branch: cur.branch || "detached" });
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Base-repo ordering: priority repos first (in configured order), then repos with an
 * active session, then alphabetical.
 */
function compareRepos(
  a: { name: string; hasSession?: boolean },
  b: { name: string; hasSession?: boolean },
  priorityRepos: string[],
): number {
  const ap = priorityRepos.indexOf(a.name.toLowerCase());
  const bp = priorityRepos.indexOf(b.name.toLowerCase());
  if (ap !== -1 && bp !== -1) return ap - bp;
  if (ap !== -1) return -1;
  if (bp !== -1) return 1;
  if (!!a.hasSession !== !!b.hasSession) return a.hasSession ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Discover git repos from session display rows + configured paths.
 * Returns a flat, display-ordered list: each base repo followed by its linked
 * worktrees (nested rows). Order: priority repos first, then repos with active
 * sessions, then alphabetical. Worktrees sort alphabetically under their base.
 */
export async function discoverRepos(
  sessionRepos: Array<{ name: string; path: string }>,
  repositoryRoots: string[],
  priorityRepos: string[],
): Promise<WizardRepo[]> {
  const bases = new Map<string, { name: string; path: string; hasSession: boolean }>();

  // Base repos from current sessions (worktrees resolved to their base).
  for (const r of sessionRepos) {
    const basePath = await getBaseRepoPath(r.path);
    const baseName = basePath.split("/").filter(Boolean).pop() ?? r.name;
    const existing = bases.get(basePath);
    if (existing) existing.hasSession = true;
    else bases.set(basePath, { name: baseName, path: basePath, hasSession: true });
  }

  // Scan configured repository roots 1-level deep (these are always base repos: a real
  // repo has a `.git/` dir, whereas a worktree's `.git` is a file — so scanning
  // never picks up worktree dirs; those come from `git worktree list` below).
  // A root that is itself a git repo (e.g. `~/.dotfiles`) counts as one repo and is
  // not scanned inside — nested repos in a checkout are vendored, not yours.
  for (let rp of repositoryRoots) {
    rp = rp.replace(/^~/, homedir()).replace(/\/+$/, "");
    try {
      if (await Bun.file(`${rp}/.git/HEAD`).exists()) {
        if (!bases.has(rp)) {
          const name = rp.split("/").filter(Boolean).pop() ?? rp;
          bases.set(rp, { name, path: rp, hasSession: false });
        }
        continue;
      }
      const glob = new Bun.Glob("*");
      for await (const entry of glob.scan({ cwd: rp, onlyFiles: false })) {
        const fullPath = `${rp}/${entry}`;
        const gitExists = await Bun.file(`${fullPath}/.git/HEAD`).exists();
        if (gitExists && !bases.has(fullPath)) {
          bases.set(fullPath, { name: entry, path: fullPath, hasSession: false });
        }
      }
    } catch {
      // path doesn't exist or not scannable
    }
  }

  // Order bases: priority first, then active-session repos, then alphabetical.
  const ordered = [...bases.values()].sort((a, b) => compareRepos(a, b, priorityRepos));

  // Flatten: each base repo followed by its worktrees (nested rows).
  const repos: WizardRepo[] = [];
  for (const base of ordered) {
    const worktrees = await listWorktrees(base.path);
    if (!worktrees) continue; // not a git repo (e.g. a session running in ~) — skip
    const main = worktrees.find((w) => w.path === base.path) ?? worktrees[0];
    const linked = worktrees
      .filter((w) => w !== main)
      .sort((a, b) => a.branch.localeCompare(b.branch));

    repos.push({ name: base.name, path: base.path, currentBranch: main?.branch || "main", hasSession: base.hasSession, worktreeCount: linked.length });
    linked.forEach((w, i) => {
      repos.push({
        name: base.name,
        path: w.path,
        currentBranch: w.branch,
        isWorktree: true,
        isLastWorktree: i === linked.length - 1,
      });
    });
  }

  return repos;
}
