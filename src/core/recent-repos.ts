import { homedir } from "os";
import { readdir, stat } from "fs/promises";
import { WORKTREES_DIR } from "./git";

const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 6;

/**
 * Claude Code's project-folder name for a cwd. Current versions turn every
 * non-alphanumeric into "-"; older ones turned only "/" (both still sit on disk,
 * e.g. `-home-u--dotfiles` and `-home-u-.dotfiles`), so match either.
 */
function projectDirNames(path: string): string[] {
  return [...new Set([path.replace(/[^a-zA-Z0-9]/g, "-"), path.replace(/\//g, "-")])];
}

/**
 * The base repos you've worked in lately, most-used first: counts transcripts touched
 * in the last 14 days under each repo's project folder and its managed worktrees'
 * (`<base>/.claude/worktrees/*`, deleted ones included), ties broken by the latest
 * touch. Stat-only — no transcript reads. Returns at most 6 paths from `basePaths`.
 */
export async function recentRepos(
  basePaths: string[],
  { projectsDir = `${homedir()}/.claude/projects`, now = Date.now() } = {},
): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  const keys = basePaths.map((base) => ({
    base,
    exact: projectDirNames(base),
    prefixes: projectDirNames(`${base}/${WORKTREES_DIR}/`),
  }));
  const usage = new Map<string, { count: number; latest: number }>();
  for (const dir of dirs) {
    const key = keys.find((k) => k.exact.includes(dir) || k.prefixes.some((p) => dir.startsWith(p)));
    if (!key) continue;
    let files: string[];
    try {
      files = await readdir(`${projectsDir}/${dir}`);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const mtime = (await stat(`${projectsDir}/${dir}/${f}`)).mtimeMs;
        if (now - mtime > RECENT_WINDOW_MS) continue;
        const u = usage.get(key.base) ?? { count: 0, latest: 0 };
        u.count++;
        u.latest = Math.max(u.latest, mtime);
        usage.set(key.base, u);
      } catch {
        // transcript removed mid-scan
      }
    }
  }
  return [...usage.entries()]
    .sort(([, a], [, b]) => b.count - a.count || b.latest - a.latest)
    .slice(0, RECENT_LIMIT)
    .map(([base]) => base);
}
