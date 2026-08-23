/**
 * Directory decisions behind `claude0 save-sessions` / `claude0 restore-sessions`.
 *
 * tmux-resurrect brings panes back in whatever directory the shell starts in, which for a
 * restored pane is often `$HOME`. Resuming a session there roots Claude at `$HOME`, and since
 * a session's repo is derived from its pane cwd it then files under `~` instead of its real
 * repo — and the next save snapshots `$HOME` as its cwd, making the damage permanent. These
 * two helpers keep that from happening and are kept free of tmux so they can be unit-tested.
 */

import { homedir } from "os";
import type { DeploymentRole } from "../types";
import { getBaseRepoPath } from "./git";
import { recoverWorktreeTranscript, isDirectory } from "./recover";
import { resolveTranscriptPath, latestTranscriptCwd } from "./last-turn";

/**
 * The cwd `save-sessions` should record for a session, given the pane's current cwd and
 * whatever cwd the previous map already held for that same session.
 *
 * The rule is one-way: a real repo cwd already on record is never replaced by `$HOME`. A pane
 * sitting in `$HOME` is nearly always a restored pane that never got its directory back, and
 * overwriting a good path with it is what makes the misgrouping self-perpetuating. The cost is
 * that a session deliberately moved to `$HOME` keeps its old entry until it's deleted by hand
 * — the far cheaper of the two failure modes.
 */
export function pickSavedCwd(
  paneCwd: string,
  previousCwd: string | undefined,
  home: string = homedir(),
): string {
  if (paneCwd === home && previousCwd && previousCwd !== home) return previousCwd;
  return paneCwd;
}

/**
 * The directory to `cd` into before resuming a saved session, or null for "resume where the
 * pane already is" (the pre-existing behaviour, so an unresolvable entry never regresses).
 *
 * Branch order matters, and the `$HOME` case has to come first: `$HOME` is always a live
 * directory, so a generic exists-check would shadow it and strand exactly the poisoned entries
 * this exists to repair. Keeping it first also means `$HOME` never reaches `getBaseRepoPath`,
 * whose deleted-worktree fallback would otherwise scan `/Users` for a sibling whose name is a
 * hyphen-prefix of the home dir's basename.
 */
export async function resolveRestoreTarget(
  sessionId: string,
  savedCwd: string,
  home: string = homedir(),
  projectsDir?: string,
): Promise<string | null> {
  // 1. Poisoned entry — recover the real directory from what Claude itself last recorded.
  if (savedCwd === home) {
    const cwd = await transcriptCwd(sessionId, projectsDir);
    return cwd && cwd !== home && (await isDirectory(cwd)) ? cwd : null;
  }

  // 2. The common case: the saved directory is still there.
  if (await isDirectory(savedCwd)) return savedCwd;

  // 3. Gone — usually a deleted worktree. Resume in its base repo, consolidating the transcript
  //    into the base project folder first so the resumed session isn't tailing a frozen copy.
  const baseRepoPath = await getBaseRepoPath(savedCwd);
  if (baseRepoPath === savedCwd || !(await isDirectory(baseRepoPath))) return null;
  return recoverWorktreeTranscript(sessionId, savedCwd, baseRepoPath, projectsDir);
}

/** Claude's own last-recorded cwd for a session (tracks `/cd`), or null. */
async function transcriptCwd(sessionId: string, projectsDir?: string): Promise<string | null> {
  const transcript = await resolveTranscriptPath(sessionId, projectsDir);
  return transcript ? latestTranscriptCwd(transcript) : null;
}

// ---------------------------------------------------------------------------
// tmux-resurrect plugin resolution (`claude0 resurrect save|restore`, setup, doctor)
// ---------------------------------------------------------------------------

/**
 * Where the tmux-resurrect plugin lives, and who manages it. A user-managed
 * (TPM) copy always wins so its behavior stays byte-identical; the claude0-owned
 * clone under ~/.config/claude0/plugins is the fallback that makes resurrection
 * work with zero dotfiles. "user-elsewhere" = no copy at a conventional path but
 * a live `@resurrect-save-dir` tmux option — only a user's resurrect config sets
 * that, so a clone (and a fragment run-shell line) would double-load the plugin.
 */
export type ResurrectResolution =
  | { source: "user" | "claude0"; path: string }
  | { source: "user-elsewhere" | "none"; path: null };

/** Conventional TPM install locations, in probe order. */
export function userResurrectDirs(home: string = homedir()): [string, string] {
  return [
    `${home}/.config/tmux/plugins/tmux-resurrect`,
    `${home}/.tmux/plugins/tmux-resurrect`,
  ];
}

/** Where `claude0 setup` clones its own copy when no user-managed one exists. */
export function claude0ResurrectDir(home: string = homedir()): string {
  return `${home}/.config/claude0/plugins/tmux-resurrect`;
}

/** A directory counts as an install only if it holds the script we exec. */
async function hasResurrectScripts(dir: string): Promise<boolean> {
  return Bun.file(`${dir}/scripts/save.sh`).exists();
}

/**
 * `@resurrect-save-dir` presence on the live tmux server — the double-load
 * signal for an unconventionally-located user copy. False when no server is
 * reachable, the option is unset, tmux is absent, or the CLAUDE0_HOME test
 * seam is active (tests never touch the real server).
 */
export async function resurrectOptionSet(): Promise<boolean> {
  if (process.env.CLAUDE0_HOME || !Bun.which("tmux")) return false;
  try {
    const out = await Bun.$`tmux show-option -gqv @resurrect-save-dir`.quiet().text();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Resolve the tmux-resurrect install this machine should use (see ResurrectResolution). */
export async function resolveResurrect(
  home: string = homedir(),
  optionSet = false,
): Promise<ResurrectResolution> {
  for (const dir of userResurrectDirs(home)) {
    if (await hasResurrectScripts(dir)) return { source: "user", path: dir };
  }
  if (optionSet) return { source: "user-elsewhere", path: null };
  const owned = claude0ResurrectDir(home);
  if (await hasResurrectScripts(owned)) return { source: "claude0", path: owned };
  return { source: "none", path: null };
}

/**
 * The plugin dir the tmux fragment's {{RESURRECT_LOAD}} token should render to,
 * or null for no run-shell line: a user-managed copy loads itself (a second
 * line would double-load the plugin) and a client owns no tmux server. "none"
 * still renders the claude0-owned dir — setup clones there. Shared by setup's
 * renderer and doctor's freshness check so the two can't disagree.
 */
export function resurrectRenderDir(
  resolution: ResurrectResolution,
  role: DeploymentRole,
  home: string = homedir(),
): string | null {
  if (role === "client") return null;
  if (resolution.source === "user" || resolution.source === "user-elsewhere") return null;
  return claude0ResurrectDir(home);
}

/**
 * argv for a resolved plugin's save/restore script. Save passes `quiet` — it runs
 * from hook/unit context where resurrect's status-line display has no client.
 * Explicit `bash`: same reason the hook registrations name it (exec bits and
 * /bin/sh-is-dash can't be assumed).
 */
export function resurrectCommand(pluginDir: string, action: "save" | "restore"): string[] {
  const script = `${pluginDir}/scripts/${action}.sh`;
  return action === "save" ? ["bash", script, "quiet"] : ["bash", script];
}

/** Cadence of the daemon's periodic layout save (continuum's conventional default). */
export const RESURRECT_SAVE_INTERVAL_MS = 15 * 60_000;

/**
 * argv for the daemon's periodic best-effort save, or null when this process
 * must not save: on linux the monitor unit already owns the save loop, and a
 * user-elsewhere/none resolution leaves nothing invocable.
 */
export function daemonSaveCommand(
  resolution: ResurrectResolution,
  platform: NodeJS.Platform,
): string[] | null {
  if (platform !== "darwin") return null;
  return resolution.path ? resurrectCommand(resolution.path, "save") : null;
}

const RESURRECT_REPO = "https://github.com/tmux-plugins/tmux-resurrect";

// Known-good tmux-resurrect commit for the claude0-owned clone (master tip,
// verified 2026-08-23). Pinned, never tracking master — the pin also holds the
// @resurrect-processes invariant stated in config/tmux.conf.
export const RESURRECT_COMMIT = "cff343cf9e81983d3da0c8562b01616f12e8d548";

/** argvs, run in order, that install the claude0-owned clone at `dir`. */
export function cloneResurrectCommands(dir: string): string[][] {
  return [
    ["mkdir", "-p", dir.slice(0, dir.lastIndexOf("/"))],
    ["git", "clone", "--quiet", RESURRECT_REPO, dir],
    ["git", "-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", RESURRECT_COMMIT],
  ];
}
