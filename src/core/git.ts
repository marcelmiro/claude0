import { homedir } from "os";
import { dirname } from "node:path";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import type { WizardRepo, WizardBranch } from "../types";

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
 * Keep Claude's managed worktree directory out of the canonical checkout
 * without dirtying a tracked .gitignore. Safe and idempotent per repository.
 */
export async function ensureWorktreeIgnore(repoPath: string): Promise<void> {
  const common = (await Bun.$`git -C ${repoPath} rev-parse --path-format=absolute --git-common-dir`.quiet().text()).trim();
  const exclude = `${common}/info/exclude`;
  await mkdir(dirname(exclude), { recursive: true });
  let content = "";
  try { content = await readFile(exclude, "utf8"); } catch {}
  const pattern = `/${WORKTREES_DIR}/`;
  if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await appendFile(exclude, `${prefix}${pattern}\n`, "utf8");
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

// Persistent cache: repo path → default branch short name (survives refreshes)
const defaultBranchCache = new Map<string, string>();

/**
 * Resolve a repo's default branch (the trunk). Reads `origin/HEAD`, falling back
 * to whichever of `main`/`master` exists locally, else `"main"`. Repos cloned
 * without `git remote set-head origin -a` have no `origin/HEAD`, so the fallback
 * is the common case, not just a theoretical edge. Cached across refreshes.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
  if (defaultBranchCache.has(repoPath)) return defaultBranchCache.get(repoPath)!;
  let result = "main";
  try {
    // `--short` yields e.g. `origin/main`; strip the remote prefix for a bare branch name.
    const ref = (await Bun.$`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`.quiet().text()).trim();
    if (ref) {
      result = ref.replace(/^origin\//, "");
    } else {
      result = await fallbackDefaultBranch(repoPath);
    }
  } catch {
    result = await fallbackDefaultBranch(repoPath);
  }
  defaultBranchCache.set(repoPath, result);
  return result;
}

/** When `origin/HEAD` is unset, pick whichever of main/master has a local ref, else "main". */
async function fallbackDefaultBranch(repoPath: string): Promise<string> {
  for (const name of ["main", "master"]) {
    const exists = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/${name}`.quiet().then(() => true, () => false);
    if (exists) return name;
  }
  return "main";
}

/**
 * Return the working-tree path where `branch` is currently checked out (main repo
 * or a linked worktree), or `null` if it isn't checked out anywhere. Used to
 * pre-check the "reuse branch" worktree flow, which git refuses when the branch is
 * already checked out elsewhere.
 */
export async function branchCheckedOutPath(repoPath: string, branch: string): Promise<string | null> {
  const worktrees = await listWorktrees(repoPath);
  if (!worktrees) return null;
  const match = worktrees.find((w) => w.branch === branch);
  return match ? match.path : null;
}

/**
 * Derive a default worktree directory name from a branch: strip everything up to
 * and including the first `/` (`cursor/ev-4-…-031d` → `ev-4-…-031d`). Branches
 * without a slash pass through unchanged.
 */
export function cleanBranchToDir(branch: string): string {
  const slash = branch.indexOf("/");
  return slash >= 0 ? branch.slice(slash + 1) : branch;
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
    const basePath = baseRepoCache.get(r.path) ?? r.path;
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

/**
 * List branches for a repo. Dedup local/remote, sort: current first, local alpha, remote-only alpha.
 */
export async function listBranches(repoPath: string): Promise<WizardBranch[]> {
  try {
    const output = await Bun.$`git -C ${repoPath} branch --all`.quiet().text();
    const lines = output.trim().split("\n").filter(Boolean);

    const localBranches = new Map<string, WizardBranch>();
    const remoteBranches = new Map<string, WizardBranch>();
    let currentBranch = "";

    for (let line of lines) {
      const isCurrent = line.startsWith("* ");
      line = line.replace(/^\*?\s+/, "");

      // Skip HEAD pointer
      if (line.includes("HEAD")) continue;

      // Drop branches whose short name starts with "-": a hostile remote can name
      // a branch `--upload-pack=…`, which git would parse as an option (not a ref)
      // when interpolated into `git fetch`/`checkout`/`worktree add`. Such names
      // aren't safely usable anyway, so never surface them in the wizard.
      const shortName = line.replace(/^remotes\/origin\//, "");
      if (shortName.startsWith("-")) continue;

      if (line.startsWith("remotes/origin/")) {
        const name = line.replace("remotes/origin/", "");
        if (!remoteBranches.has(name)) {
          remoteBranches.set(name, {
            name,
            isRemote: true,
            isCurrent: false,
            fullRef: line,
          });
        }
      } else {
        if (isCurrent) currentBranch = line;
        localBranches.set(line, {
          name: line,
          isRemote: false,
          isCurrent,
          fullRef: line,
        });
      }
    }

    // No dedup: show both local and remote so user can search "remotes/origin/main"
    const branches: WizardBranch[] = [];

    // Current branch first
    if (currentBranch && localBranches.has(currentBranch)) {
      branches.push(localBranches.get(currentBranch)!);
    }

    // Local branches (alpha, skip current)
    const localSorted = [...localBranches.values()]
      .filter((b) => !b.isCurrent)
      .sort((a, b) => a.name.localeCompare(b.name));
    branches.push(...localSorted);

    // All remote branches (alpha)
    const remoteSorted = [...remoteBranches.values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    branches.push(...remoteSorted);

    return branches;
  } catch {
    return [];
  }
}

/**
 * Fetch remote refs so branches pushed by others become visible, and prune
 * refs deleted on the remote. Returns ok:false with the git error on failure
 * (offline, no remote, etc.) — callers fall back to the local ref list.
 */
export async function fetchRepo(repoPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await Bun.$`git -C ${repoPath} fetch --prune`.quiet();
    return { ok: true };
  } catch (e: any) {
    const error = (e?.stderr?.toString() || e?.message || "fetch failed").trim();
    return { ok: false, error };
  }
}

/**
 * Get git log for a branch (colored, graph format).
 */
export async function getBranchLog(repoPath: string, branch: string): Promise<string> {
  try {
    const output = await Bun.$`git -C ${repoPath} log --oneline --decorate --graph --color=always -20 ${branch}`.quiet().text();
    return output;
  } catch {
    return "";
  }
}

/**
 * Checkout an existing local branch.
 */
export async function checkoutBranch(repoPath: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await Bun.$`git -C ${repoPath} checkout ${branch}`.quiet();
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "checkout failed";
    return { ok: false, error: msg.trim() };
  }
}

/**
 * Create a local tracking branch and check it out.
 */
export async function trackAndCheckout(repoPath: string, localName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Check if a local branch with this name already exists
    const localExists = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/${localName}`.quiet().then(() => true, () => false);
    if (localExists) {
      await Bun.$`git -C ${repoPath} checkout ${localName}`.quiet();
    } else {
      await Bun.$`git -C ${repoPath} checkout -b ${localName} --track origin/${localName}`.quiet();
    }
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "track+checkout failed";
    return { ok: false, error: msg.trim() };
  }
}

/**
 * Create a git worktree with a new branch.
 * Runs: git worktree add <wtPath> -b <newBranch> <baseRef>
 * baseRef = origin/<baseBranch> if remote, else <baseBranch>
 */
export async function createWorktree(
  repoPath: string,
  wtPath: string,
  newBranch: string,
  baseBranch: string,
  isRemote: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const baseRef = isRemote ? `origin/${baseBranch}` : baseBranch;
    // If branch already exists locally, use it directly instead of -b (which fails on existing branches)
    const branchExists = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/${newBranch}`.quiet().then(() => true, () => false);
    if (branchExists) {
      await Bun.$`git -C ${repoPath} worktree add ${wtPath} ${newBranch}`.quiet();
    } else {
      await Bun.$`git -C ${repoPath} worktree add ${wtPath} -b ${newBranch} ${baseRef}`.quiet();
    }
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "worktree creation failed";
    // Strip git's "Preparing worktree..." progress line to surface the actual error
    const error = msg.trim().split("\n").filter((l: string) => !l.startsWith("Preparing worktree")).join(" ").trim()
      || msg.trim();
    return { ok: false, error };
  }
}
