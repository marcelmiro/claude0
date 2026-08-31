import { homedir } from "os";
import type {
  Session,
  RepoGroup,
  SessionIndex,
  PaneInfo,
} from "../types";
import { listPanes, capturePane } from "./tmux";
import { dictatedSessionId, findClaudeProcesses } from "./process";
import { detectStatus, type StatusResult } from "./status";
import { getBaseRepoPath } from "./git";
import { stripAllPrefixes, extractAIName } from "./notifications";
import { slugify } from "./names";
import { processHookEvents, savePaneSessions, reconcilePaneFiles } from "./state";
import { eventSourcedStatus } from "./hook-events";
import { nativeStatus, resolveStatus } from "./session-state";
import { readLastTurnAt, resolveTranscriptPath, latestTranscriptCwd } from "./last-turn";
import { jsonlLines } from "./jsonl-reader";

const home = homedir();

/** Derive a display-friendly repo name from a path. Returns "~" for home dir. */
export function repoNameFromPath(p: string): string {
  if (p === home) return "~";
  return p.split("/").filter(Boolean).pop() ?? "unknown";
}

// Persistent cache: paneId → sessionId, survives across refresh cycles.
// Populated by hook events, --resume flag, or JSONL mtime heuristic (best-guess).
// Once set, prevents re-running the expensive heuristic every 3s.
const paneSessionCache = new Map<string, string>();

/** Seed the in-memory pane→sessionId cache from persisted data (avoids lsof cold start). */
export function seedPaneSessionCache(entries: Record<string, string>): void {
  for (const [k, v] of Object.entries(entries)) {
    paneSessionCache.set(k, v);
  }
}

/** Export current cache contents for persistence. */
export function exportPaneSessionCache(): Record<string, string> {
  return Object.fromEntries(paneSessionCache);
}

/**
 * Resolve a pane's CURRENT session id. The SessionStart hook is authoritative — it fires
 * on launch, resume, /clear AND /compact — so the hook-derived maps win. The command-line
 * `--resume` id is only a FALLBACK for panes the hook never recorded (hook not installed,
 * or a brand-new pane before its first event lands): it is the LAUNCH id, so after /clear
 * or /compact (which mint a new id WITHOUT restarting the process) it goes stale and must
 * not win, or the pane stays pinned to the dead old session while the new one is orphaned.
 * `cache` is this process's hook accumulation; `persisted` is the hook-owned per-pane
 * file map (`panes/`) — both are pure hook data, so the order between them is moot.
 */
export function resolvePaneSessionId(
  paneId: string,
  cmdSessionId: string | undefined,
  cache: Map<string, string>,
  persisted: Record<string, string>,
  isFork = false,
): string | undefined {
  // A fork is the ONE case where the hook map is wrong: its SessionStart fires
  // with the PARENT (resume-source) id, so cache/persisted alias the fork onto
  // its parent (rendering the parent's running status/name). `cmdSessionId` for
  // a fork is its REAL id, read from Claude's per-pid native file in
  // findClaudeProcesses — trust it over the stale hook map.
  if (isFork && cmdSessionId) return cmdSessionId;
  return cache.get(paneId) ?? persisted[paneId] ?? cmdSessionId;
}

/**
 * Discover all Claude Code sessions using a two-phase approach:
 * Phase A: Active sessions from tmux panes (source of truth)
 * Phase B: Idle sessions from index files (secondary, filtered)
 */
/**
 * Phase B (archived sweep) result cache, opt-in via `archivedTtlMs`. The sweep globs
 * every project dir and re-reads index files, dominating a discovery cycle, yet archived
 * sessions change on human timescales. Reused only while BOTH hold: the entry is younger
 * than the caller's TTL, and the ACTIVE session-id set is unchanged — a just-killed pane
 * must re-enter the archived list immediately (not vanish from both lists until the TTL
 * expires), and a just-restored session must not appear twice.
 */
let archivedCache: { ts: number; activeKey: string; sessions: Session[] } | null = null;

export async function discoverSessions(opts?: { skipArchivedSummaries?: boolean; nameMap?: Record<string, string>; archivedTtlMs?: number }): Promise<{ sessions: Session[]; changedPaneIds: Set<string> }> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  // Process hook events before discovery to pick up fresh pane→sessionId mappings
  const paneSessionMap = Object.fromEntries(paneSessionCache);
  const {
    changed: hookChanged,
    changedPaneIds: hookChangedPanes,
    // The persisted map (the same source `claude0 list` trusts) is a fallback for panes the
    // in-memory cache has pruned: a freshly-launched session's hook event can be read on
    // a cycle before its pane has a running claude process, and without this fallback
    // that session would never resolve an id. processHookEvents just loaded it — reuse
    // it instead of re-reading the per-pane files.
    paneMap: persistedPaneMap,
  } = await processHookEvents(paneSessionMap);
  if (hookChanged) {
    for (const [k, v] of Object.entries(paneSessionMap)) {
      paneSessionCache.set(k, v);
    }
  }

  // Phase A: Gather tmux panes and Claude processes in parallel.
  const [panes, claudeProcesses] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
  ]);

  // Build a TTY→process map. ps reports "ttys001", tmux reports "/dev/ttys001".
  // When multiple processes share a TTY (parent/child), prefer one with a sessionId.
  const claudeTtyMap = new Map<string, typeof claudeProcesses[0]>();
  for (const proc of claudeProcesses) {
    const existing = claudeTtyMap.get(proc.tty);
    if (!existing || proc.sessionId) {
      claudeTtyMap.set(proc.tty, proc);
    }
  }

  // Filter panes to those with a Claude process on their TTY
  const claudePanesWithProc: Array<{ pane: PaneInfo; sessionId?: string; isFork: boolean; dictatedId?: string }> = [];
  for (const pane of panes) {
    const normalizedPaneTty = pane.tty.replace(/^\/dev\//, "");
    const proc = claudeTtyMap.get(normalizedPaneTty);
    if (proc) {
      claudePanesWithProc.push({
        pane,
        sessionId: proc.sessionId,
        isFork: proc.isFork,
        dictatedId: dictatedSessionId(proc.command),
      });
    }
  }

  // Phase A: Build active sessions from Claude panes. Hook map (cache/persisted) wins over
  // the command-line --resume id so a /clear'd or /compact'd pane resolves to its CURRENT
  // session, not the stale launch id (see resolvePaneSessionId). A fork is the exception —
  // its hook map is the parent id, so its native-resolved id wins; cache it so the wrong
  // hook-written pane file gets overwritten on savePaneSessions and every reader self-heals.
  const activeSessionPromises = claudePanesWithProc.map(({ pane, sessionId, isFork, dictatedId }) => {
    const resolved = resolvePaneSessionId(pane.paneId, sessionId, paneSessionCache, persistedPaneMap, isFork);
    if (isFork && resolved) paneSessionCache.set(pane.paneId, resolved);
    return buildActiveSession(pane, projectsDir, resolved, dictatedId);
  });
  const activeSessions = await Promise.all(activeSessionPromises);

  // Session-ID changes (/clear, /compact) come from the SessionStart hook — the
  // authoritative signal. We deliberately do NOT derive changes from, or cache, the
  // command-line --resume id: it's the launch id and never changes, so it would miss
  // nothing the hook didn't already report yet fire spuriously every cycle — and caching
  // it would clobber the post-/clear mapping back onto the stale id. Keeping the cache
  // hook-only is what makes the precedence above hold across discovery cycles.
  const changedPaneIds = new Set<string>(hookChangedPanes);

  // Enrich active sessions that still couldn't resolve a session ID
  await enrichUnmatchedSessions(activeSessions, projectsDir, persistedPaneMap, opts?.nameMap);

  // Clean stale cache entries for panes that no longer exist
  const activePaneIds = new Set(claudePanesWithProc.map(({ pane }) => pane.paneId));
  for (const paneId of paneSessionCache.keys()) {
    if (!activePaneIds.has(paneId)) paneSessionCache.delete(paneId);
  }

  // Persist the resolved map to the hook-owned per-pane files so every discoverer (incl. the
  // always-on bridge) keeps `resolveSessionPane` current — capturing window-name/mtime fallback
  // resolutions the hook never wrote. Prune files for panes that have left tmux entirely (the
  // full pane set, not just claude panes, so a transient miss can't drop a live mapping).
  await savePaneSessions(exportPaneSessionCache());
  await reconcilePaneFiles(new Set(panes.map((p) => p.paneId)));

  // Phase B: Discover archived sessions from index files. With `archivedTtlMs` (bridge
  // opt-in — never for skipArchivedSummaries results, whose entries lack summaries),
  // reuse the cached sweep while it's fresh AND the active id set is unchanged.
  const cacheable = opts?.archivedTtlMs !== undefined && !opts?.skipArchivedSummaries;
  const activeKey = activeSessions
    .map((s) => s.id)
    .filter(Boolean)
    .sort()
    .join(",");
  let archivedSessions: Session[];
  if (
    cacheable &&
    archivedCache &&
    Date.now() - archivedCache.ts < opts!.archivedTtlMs! &&
    archivedCache.activeKey === activeKey
  ) {
    archivedSessions = archivedCache.sessions;
  } else {
    archivedSessions = await discoverArchivedSessions(projectsDir, activeSessions, opts?.skipArchivedSummaries);
    if (cacheable) archivedCache = { ts: Date.now(), activeKey, sessions: archivedSessions };
  }

  const sessions = [...activeSessions, ...archivedSessions];
  await attachLastTurn(sessions);
  return { sessions, changedPaneIds };
}

/**
 * Fill in `lastTurnAt` for every identified session — the age both the TUI and the
 * phone display. `modified` is the transcript's file mtime, which bookkeeping writes
 * and bulk resumes push forward without any conversation happening; the last
 * conversational record's timestamp is the real thing. Reads are memoized on mtime
 * (see `last-turn.ts`), so a settled list re-reads nothing.
 */
async function attachLastTurn(sessions: Session[]): Promise<void> {
  await Promise.all(
    sessions.map(async (session) => {
      if (!session.id) return;
      const path = await resolveTranscriptPath(session.id);
      if (!path) return;
      const at = await readLastTurnAt(path);
      if (at !== null) session.lastTurnAt = new Date(at);
    }),
  );
}

/**
 * For active sessions that couldn't resolve a session ID via lsof or
 * command-line flags, try to match them using two strategies:
 *
 * 1. Window name reverse lookup (reliable): If the tmux window was previously
 *    named by Claude0, look up the name in the name cache to find the session ID.
 *    Only matches unique names (skips collisions within same repo).
 *
 * 2. JSONL mtime heuristic (1:1 only): When exactly one unmatched session
 *    exists per repo, assign the most recently modified JSONL. With multiple
 *    sessions, this is unreliable (tmux pane order doesn't correlate with
 *    JSONL mtime order) so we skip it to avoid swapping metadata.
 */
async function enrichUnmatchedSessions(
  sessions: Session[],
  projectsDir: string,
  persistedPaneMap: Record<string, string>,
  nameMap?: Record<string, string>,
): Promise<void> {
  const unmatched = sessions.filter((s) => !s.id);
  if (unmatched.length === 0) return;

  // Collect session IDs already claimed by matched sessions
  const claimedIds = new Set(sessions.filter((s) => s.id).map((s) => s.id));

  // Detect panes that share a tmux window (window name is unreliable for these)
  const panesPerWindow = new Map<string, number>();
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
    panesPerWindow.set(wKey, (panesPerWindow.get(wKey) ?? 0) + 1);
  }

  // Build reverse name lookup: windowSlug → sessionId. Window names carry the
  // slug (what `extractAIName` pulls out), while the cache stores the normalized
  // name — so key on `slugify(name)` for the round-trip to resolve.
  const reverseNameMap = new Map<string, string>();
  if (nameMap) {
    for (const [sessionId, name] of Object.entries(nameMap)) {
      const slug = slugify(name);
      if (!slug) continue;
      // If two sessions share a slug, mark it as ambiguous (skip during matching)
      if (reverseNameMap.has(slug)) {
        reverseNameMap.set(slug, ""); // empty = ambiguous
      } else {
        reverseNameMap.set(slug, sessionId);
      }
    }
  }

  // Group unmatched sessions by repoPath
  const byRepo = new Map<string, Session[]>();
  for (const session of unmatched) {
    const existing = byRepo.get(session.repoPath);
    if (existing) {
      existing.push(session);
    } else {
      byRepo.set(session.repoPath, [session]);
    }
  }

  for (const [repoPath, repoSessions] of byRepo) {
    try {
      const encodedPath = repoPath.replace(/\//g, "-");
      const projectDir = `${projectsDir}/${encodedPath}`;
      const repoName = repoNameFromPath(repoPath);

      // Read the index once for summary lookup
      let index: SessionIndex | null = null;
      try {
        const raw = await Bun.file(`${projectDir}/sessions-index.json`).text();
        index = JSON.parse(raw);
      } catch {
        // No index — will fall back to JSONL first prompt
      }

      // Scan JSONL files and rank by actual file mtime (most recently written = active)
      const jsonlGlob = new Bun.Glob("*.jsonl");
      const candidates: Array<{ sessionId: string; mtime: number }> = [];

      for await (const path of jsonlGlob.scan({ cwd: projectDir, absolute: true })) {
        const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");
        if (claimedIds.has(sessionId)) continue;

        try {
          const stat = await Bun.file(path).stat();
          if (stat) candidates.push({ sessionId, mtime: stat.mtimeMs });
        } catch {
          continue;
        }
      }

      candidates.sort((a, b) => b.mtime - a.mtime);
      const candidateSet = new Set(candidates.map((c) => c.sessionId));

      // Strategy 1: Window name reverse lookup
      // Match tmux window names against the name cache to find session IDs.
      // Skip default names ("claude", repo name) and names that appear on
      // multiple unmatched panes in this repo (ambiguous).
      if (reverseNameMap.size > 0) {
        // Count window name occurrences among unmatched panes in this repo
        // to detect collisions (e.g., two panes both named "you-recently-implemented")
        const nameCount = new Map<string, number>();
        for (const session of repoSessions) {
          const wn = normalizeWindowName(session.tmuxPane?.windowName, repoName);
          if (wn) nameCount.set(wn, (nameCount.get(wn) ?? 0) + 1);
        }

        for (const session of repoSessions) {
          if (session.id) continue; // already matched

          // Skip panes in shared windows — window name is ambiguous (set to "claude/{repo}")
          if (session.tmuxPane) {
            const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
            if ((panesPerWindow.get(wKey) ?? 0) > 1) continue;
          }

          const windowName = normalizeWindowName(session.tmuxPane?.windowName, repoName);
          if (!windowName) continue;

          // Skip if multiple unmatched panes share this window name (ambiguous)
          if ((nameCount.get(windowName) ?? 0) > 1) continue;

          const sessionId = reverseNameMap.get(windowName);
          if (!sessionId || claimedIds.has(sessionId)) continue;

          // Verify this session ID has a JSONL candidate in this project
          if (!candidateSet.has(sessionId)) continue;

          const candidate = candidates.find((c) => c.sessionId === sessionId);
          await enrichSession(session, sessionId, candidate?.mtime, index, projectDir);
          claimedIds.add(sessionId);

          // Cache window-name matches — these are reliable (Claude0 set the name)
          if (session.tmuxPane) {
            paneSessionCache.set(session.tmuxPane.paneId, sessionId);
          }
        }
      }

      // Strategy 2: Content matching (pane capture vs JSONL user messages)
      // Match visible pane content against recent user messages from JSONL
      // candidates. User prompts are plain text displayed verbatim in the
      // terminal, so they match reliably after whitespace normalization.
      const unmatchedForContent = repoSessions.filter((s) => !s.id && s.lastCapture);
      const unclaimedForContent = candidates.filter((c) => !claimedIds.has(c.sessionId));

      if (unmatchedForContent.length > 0 && unclaimedForContent.length > 0) {
        const candidateMessages = await Promise.all(
          unclaimedForContent.map(async (c) => ({
            ...c,
            snippets: await extractRecentUserMessages(`${projectDir}/${c.sessionId}.jsonl`),
          })),
        );

        // Normalize pane text: strip ANSI and collapse whitespace
        const paneTexts = new Map<Session, string>();
        for (const session of unmatchedForContent) {
          const plain = stripAnsi(session.lastCapture!).replace(/\s+/g, " ");
          paneTexts.set(session, plain);
        }

        // Score each (session, candidate) pair by counting matching snippets
        const scores: Array<{ session: Session; candidateIdx: number; score: number }> = [];
        for (const [session, paneText] of paneTexts) {
          for (let ci = 0; ci < candidateMessages.length; ci++) {
            let score = 0;
            for (const snippet of candidateMessages[ci].snippets) {
              if (paneText.includes(snippet)) score++;
            }
            if (score > 0) {
              scores.push({ session, candidateIdx: ci, score });
            }
          }
        }

        // Greedy assignment: highest score first
        scores.sort((a, b) => b.score - a.score);
        const assignedSessions = new Set<Session>();
        const assignedCandidates = new Set<number>();

        for (const { session, candidateIdx } of scores) {
          if (assignedSessions.has(session) || assignedCandidates.has(candidateIdx)) continue;
          const { sessionId, mtime } = candidateMessages[candidateIdx];
          await enrichSession(session, sessionId, mtime, index, projectDir);
          claimedIds.add(sessionId);
          assignedSessions.add(session);
          assignedCandidates.add(candidateIdx);

          // Cache content-matched assignments — conversation content is unique
          if (session.tmuxPane) {
            paneSessionCache.set(session.tmuxPane.paneId, sessionId);
          }
        }
      }

      // Strategy 3: JSONL mtime heuristic (only for 1:1 case)
      // After content matching, if exactly one unmatched session remains,
      // assign the most recently modified JSONL as a last resort.
      const stillUnmatched = repoSessions.filter((s) => !s.id);
      const unclaimed = candidates.filter((c) => !claimedIds.has(c.sessionId));

      // Skip the mtime guess for a pane the hook ALREADY claimed: its persisted id was
      // cleared by buildActiveSession only because that session's JSONL is gone (stale
      // hook id, e.g. a fresh attached session before its first JSONL write). Overriding
      // the hook with an unrelated most-recent JSONL mislabels a live, unresolvable pane
      // with a DEAD session's identity — which then can't be archived from the phone and
      // reappears every cycle. Leave it untracked (hidden) until its real id resolves.
      const soleUnmatchedPane = stillUnmatched.length === 1 ? stillUnmatched[0].tmuxPane?.paneId : undefined;
      const hookClaimedPane = !!(soleUnmatchedPane && persistedPaneMap[soleUnmatchedPane]);

      if (stillUnmatched.length === 1 && unclaimed.length >= 1 && !hookClaimedPane) {
        const { sessionId, mtime } = unclaimed[0];
        const session = stillUnmatched[0];

        await enrichSession(session, sessionId, mtime, index, projectDir);
        claimedIds.add(sessionId);

        // NOTE: We intentionally do NOT cache mtime-heuristic assignments in
        // paneSessionCache. Only lsof-confirmed and window-name-confirmed
        // mappings should be cached, to prevent wrong mappings from persisting.
      }
    } catch {
      // Skip this repo
    }
  }
}

/** Normalize a tmux window name for matching: strip prefix, extract AI name for cache lookup */
function normalizeWindowName(windowName: string | undefined, repoName: string): string | null {
  if (!windowName) return null;
  const stripped = stripAllPrefixes(windowName);
  // "{repo}/{ai-name}" → extract AI name
  const aiName = extractAIName(windowName);
  if (aiName) return aiName;
  // Fallback: bare name after stripping prefixes ("claude" = tmux's automatic
  // rename after the running command — not a name worth caching)
  if (stripped === "claude" || stripped === repoName || stripped === "zsh" || stripped === "bash") return null;
  return stripped;
}

/** Populate a session object with metadata from index/JSONL */
async function enrichSession(
  session: Session,
  sessionId: string,
  mtime: number | undefined,
  index: SessionIndex | null,
  projectDir: string,
): Promise<void> {
  session.id = sessionId;
  if (mtime) session.modified = new Date(mtime);

  const entry = index?.entries.find((e) => e.sessionId === sessionId);
  if (entry) {
    session.messageCount = entry.messageCount;
    session.summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
    session.firstPrompt = entry.firstPrompt || "";
  } else {
    const prompt = await getFirstUserPrompt(`${projectDir}/${sessionId}.jsonl`);
    session.summary = prompt;
    session.firstPrompt = prompt;
  }
}

/**
 * The directory a session's repo info should be derived from: the pane's cwd, unless that is
 * the home dir and Claude's transcript records somewhere better. Home is the only case worth
 * overriding — it's what a tmux-resurrect-restored pane reports before it gets its directory
 * back, and it groups the session under "~" instead of its repo.
 */
export function pickRepoPath(
  paneCwd: string,
  transcriptCwd: string | null,
  homeDir: string = home,
): string {
  if (paneCwd !== homeDir) return paneCwd;
  return transcriptCwd && transcriptCwd !== homeDir ? transcriptCwd : paneCwd;
}

/**
 * Build a Session from an active tmux pane running Claude.
 * Derives repo info from tmux + git, with best-effort enrichment from JSONL/index.
 */
/**
 * The id a live pane resolves to. A known id with no JSONL behind it is normally a stale
 * pane→session mapping and resets to "" so the pane falls through to
 * enrichUnmatchedSessions() — UNLESS the pane's Claude process was launched with
 * `--session-id <that id>`: Claude writes a NEW session's transcript lazily (nothing on
 * disk until the first turn; /clear and forks write eagerly), and a stale file can't
 * coincide with the live process's own argv, so the id is certain. Without this a
 * phone-created session left unprompted surfaced as an id-less row nobody could open or
 * archive.
 */
export function resolveActiveId(
  knownSessionId: string | undefined,
  transcriptSessionId: string | undefined,
  dictatedId: string | undefined,
): string {
  if (transcriptSessionId) return knownSessionId ?? transcriptSessionId;
  if (knownSessionId && knownSessionId === dictatedId) return knownSessionId;
  return "";
}

async function buildActiveSession(
  pane: PaneInfo,
  projectsDir: string,
  knownSessionId?: string,
  dictatedId?: string,
): Promise<Session> {
  // A pane sitting in $HOME is almost always one tmux-resurrect brought back without its
  // directory: the shell starts in $HOME, `claude --resume` roots there, and the session then
  // files under the "~" group instead of its repo. Claude's own last-recorded cwd is the
  // authority, so fall back to it — but only for $HOME, so the transcript read stays off the
  // 3s refresh for every normal pane. Must settle before the Promise.all below: the branch,
  // index lookup and base-repo resolution all key off repoPath.
  let repoPath = pane.currentPath;
  if (repoPath === home && knownSessionId) {
    const transcript = await resolveTranscriptPath(knownSessionId);
    repoPath = pickRepoPath(repoPath, transcript ? await latestTranscriptCwd(transcript) : null);
  }

  // Run all enrichments in parallel — capture pane with escapes for reuse in preview
  let lastCapture = "";
  const [statusResult, branch, activeInfo, baseRepoPath] = await Promise.all([
    capturePane(pane.paneId, { escapes: true }).then(
      (captured) => {
        lastCapture = captured;
        // Strip ANSI for status detection (detectStatus expects plain text)
        const plain = captured.replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
        return detectStatus(plain, true);
      },
      (): StatusResult => ({ status: "ready" }),
    ),
    getGitBranch(repoPath),
    findActiveSessionInfo(projectsDir, repoPath, knownSessionId),
    getBaseRepoPath(repoPath),
  ]);

  const repo = repoNameFromPath(baseRepoPath);

  const resolvedId = resolveActiveId(knownSessionId, activeInfo?.sessionId, dictatedId);
  if (knownSessionId && !resolvedId) {
    paneSessionCache.delete(pane.paneId); // stale mapping — see resolveActiveId
  }

  // Status resolution order: Claude's native status file › event-sourced hook log
  // › viewport scraper. Native is authoritative for live sessions and de-latches
  // the stuck-running case (revert/interrupt emit no hook). Events are correct
  // regardless of pane scroll; the scraper is the last resort — and the tiebreak
  // when a frozen native file claims "ready" over a live spinner (resolveStatus).
  const native = resolvedId ? await nativeStatus(resolvedId) : null;
  const eventStatus = resolvedId ? await eventSourcedStatus(resolvedId) : null;
  const resolved = resolveStatus(native, eventStatus, statusResult.status);

  return {
    id: resolvedId,
    repo,
    repoPath,
    baseRepoPath,
    branch,
    status: resolved.status,
    statusSource: resolved.source,
    messageCount: activeInfo?.messageCount ?? 0,
    summary: activeInfo?.summary ?? "",
    modified: activeInfo?.modified ? new Date(activeInfo.modified) : new Date(),
    firstPrompt: activeInfo?.firstPrompt ?? "",
    lastPrompt: activeInfo?.lastPrompt ?? "",
    name: "",
    tmuxPane: {
      paneId: pane.paneId,
      windowIndex: pane.windowIndex,
      sessionName: pane.sessionName,
      windowName: pane.windowName,
    },
    lastCapture,
  };
}

/**
 * Find session info from the index. If knownSessionId is provided (from lsof),
 * look it up directly. Otherwise fall back to the most recently modified JSONL.
 */
export async function findActiveSessionInfo(
  projectsDir: string,
  repoPath: string,
  knownSessionId?: string,
): Promise<{ sessionId: string; messageCount: number; summary: string; modified?: string; firstPrompt: string; lastPrompt: string } | null> {
  // Without a known session ID we can't reliably match — enrichment
  // for unmatched sessions happens in enrichUnmatchedSessions() instead
  if (!knownSessionId) return null;

  // Try the expected project dir first, then fall back to searching all dirs.
  // The pane CWD can diverge from the project dir Claude was launched in
  // (e.g. user cd'd after starting Claude), so the JSONL may live elsewhere.
  const encodedPath = repoPath.replace(/\//g, "-");
  const projectDir = await resolveProjectDir(projectsDir, encodedPath, knownSessionId);
  if (!projectDir) return null;

  return readSessionInfo(projectDir, knownSessionId);
}

/**
 * Assistant-reply snippets for AI naming, read lazily at naming time only (never on
 * discovery sweeps — two extra transcript scans are fine per `claude -p` call, not per
 * tick). The first assistant reply matters most: for meta-prompts ("grill me on this
 * plan") it's the only place the actual subject of the work appears.
 */
export async function readNamingExtras(
  repoPath: string,
  sessionId: string,
  projectsDir = `${homedir()}/.claude/projects`,
): Promise<{ firstAssistant: string; lastAssistant: string }> {
  const none = { firstAssistant: "", lastAssistant: "" };
  try {
    const encodedPath = repoPath.replace(/\//g, "-");
    const projectDir = await resolveProjectDir(projectsDir, encodedPath, sessionId);
    if (!projectDir) return none;
    const jsonlPath = `${projectDir}/${sessionId}.jsonl`;
    return {
      firstAssistant: await getFirstAssistantReply(jsonlPath),
      lastAssistant: await getLatestAssistantReply(jsonlPath),
    };
  } catch {
    return none;
  }
}

/** First text block from an assistant reply, or "". */
function assistantText(parsed: { type?: string; message?: { content?: unknown } }): string {
  if (parsed.type !== "assistant") return "";
  const content = parsed.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b: { type: string; text?: string }) => b.type === "text");
    return block?.text ?? "";
  }
  return "";
}

/** Stream from the top and return the first assistant text reply (sits near the head). */
async function getFirstAssistantReply(jsonlPath: string): Promise<string> {
  try {
    for await (const line of jsonlLines(jsonlPath)) {
      if (!line.includes('"type":"assistant"')) continue;
      try {
        const text = assistantText(JSON.parse(line));
        if (!text) continue;
        const clean = text.replace(/\s+/g, " ").trim();
        return clean.length > 300 ? clean.slice(0, 300) + "..." : clean;
      } catch {
        continue;
      }
    }
    return "";
  } catch {
    return "";
  }
}

/** Latest assistant text reply via the shared backward tail scan. */
async function getLatestAssistantReply(jsonlPath: string): Promise<string> {
  return scanTailForLine(jsonlPath, (line) => {
    if (!line.includes('"type":"assistant"')) return undefined;
    try {
      const text = assistantText(JSON.parse(line));
      if (!text) return undefined;
      const clean = text.replace(/\s+/g, " ").trim();
      return clean.length > 300 ? clean.slice(0, 300) + "..." : clean;
    } catch {
      return undefined;
    }
  });
}

/**
 * Backward doubling-window byte scan over a JSONL file, newest-line-first.
 * `matcher` runs on each candidate line; return a non-empty string to stop the
 * scan and return it. Offset math is on BYTES, never decoded text — a multi-byte
 * character split at the window edge makes UTF-16 lengths lie about file
 * positions. A mid-file slice starts inside some record — its remainder ends at
 * the first newline: skipped for parsing, its BYTE length positions the next
 * window's end. No newline at all means the window sits inside one huge line:
 * widen and retry with `scannedTo` unchanged so the line is captured whole.
 */
async function scanTailForLine(path: string, matcher: (line: string) => string | undefined): Promise<string> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return "";
    let scannedTo = stat.size; // bytes at/after this offset were covered by a previous window
    for (let window = 64 * 1024; ; window *= 2) {
      const start = Math.max(0, stat.size - window);
      const bytes = new Uint8Array(await file.slice(start, scannedTo).arrayBuffer());
      const firstNl = start > 0 ? bytes.indexOf(0x0a) : -1;
      if (start > 0 && firstNl === -1) continue;
      const chunk = new TextDecoder().decode(start > 0 ? bytes.subarray(firstNl + 1) : bytes);
      const lines = chunk.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        const hit = matcher(lines[i]);
        if (hit) return hit;
      }
      if (start === 0) return "";
      // Re-scan overlap is bounded: the next pass reads [newStart, start+partial).
      scannedTo = start + firstNl + 1;
    }
  } catch {
    return "";
  }
}

/** Find the project dir containing a session's JSONL. Tries expected dir first, then scans. */
async function resolveProjectDir(projectsDir: string, encodedPath: string, sessionId: string): Promise<string | null> {
  const expectedDir = `${projectsDir}/${encodedPath}`;
  try {
    const stat = await Bun.file(`${expectedDir}/${sessionId}.jsonl`).stat();
    if (stat) return expectedDir;
  } catch {}

  // Fallback: scan all project dirs for this session's JSONL
  try {
    const glob = new Bun.Glob(`*/${sessionId}.jsonl`);
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      return path.replace(`/${sessionId}.jsonl`, "");
    }
  } catch {}

  return null;
}

/** Read session metadata from a resolved project directory. */
async function readSessionInfo(
  projectDir: string,
  sessionId: string,
): Promise<{ sessionId: string; messageCount: number; summary: string; modified?: string; firstPrompt: string; lastPrompt: string }> {
  let messageCount = 0;
  let summary = "";
  let modified: string | undefined;
  let firstPrompt = "";

  try {
    const indexPath = `${projectDir}/sessions-index.json`;
    const raw = await Bun.file(indexPath).text();
    const index: SessionIndex = JSON.parse(raw);
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry) {
      messageCount = entry.messageCount;
      summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
      modified = entry.modified;
      firstPrompt = entry.firstPrompt || "";
    }
  } catch {
    // No index file or malformed — that's fine
  }

  // Use JSONL file mtime as authoritative last-activity time
  const jsonlPath = `${projectDir}/${sessionId}.jsonl`;
  try {
    const stat = await Bun.file(jsonlPath).stat();
    if (stat) {
      modified = new Date(stat.mtimeMs).toISOString();
    }
  } catch {}

  // If no summary from index, read first user prompt from the JSONL
  if (!summary) {
    summary = await getFirstUserPrompt(jsonlPath);
    if (!firstPrompt) firstPrompt = summary;
  }

  const lastPrompt = await getLatestUserPrompt(jsonlPath);

  return { sessionId, messageCount, summary, modified, firstPrompt, lastPrompt };
}

/**
 * Phase B: Discover archived sessions from session index files.
 * Skips entries that match an active session (same project + session ID),
 * and entries older than 24 hours.
 */
async function discoverArchivedSessions(
  projectsDir: string,
  activeSessions: Session[],
  skipSummaries = false,
): Promise<Session[]> {
  // Build set of active session IDs to avoid duplicating active sessions as archived
  const activeSessionIds = new Set<string>(
    activeSessions.filter((s) => s.id).map((s) => s.id),
  );

  const glob = new Bun.Glob("*/sessions-index.json");
  const indexFiles: string[] = [];

  try {
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      indexFiles.push(path);
    }
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  const archiveWindow = 24 * 60 * 60 * 1000;
  const indexSessionIds = new Set<string>();

  for (const indexFile of indexFiles) {
    try {
      const raw = await Bun.file(indexFile).text();
      const index: SessionIndex = JSON.parse(raw);

      for (const entry of index.entries) {
        indexSessionIds.add(entry.sessionId);

        if (entry.isSidechain) continue;

        // Skip AI naming sessions created by `claude -p` in names.ts
        if (entry.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;

        // Skip if this session is already active
        if (activeSessionIds.has(entry.sessionId)) continue;

        // Skip entries older than 24h
        const modifiedMs = new Date(entry.modified).getTime();
        const ageMs = Date.now() - modifiedMs;
        if (ageMs > archiveWindow) continue;

        let baseRepoPath = entry.projectPath;
        try { baseRepoPath = await getBaseRepoPath(entry.projectPath); } catch {}
        const repo = repoNameFromPath(baseRepoPath);

        // For archived sessions, use index summary or fetch last assistant message
        let summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
        let branch = entry.gitBranch || "";
        if (!skipSummaries && entry.fullPath) {
          try {
            const tail = await readSessionTail(entry.fullPath);
            if (tail.lastMessage) {
              summary = tail.lastMessage;
            }
            // Resolve "HEAD" (detached) to actual branch from JSONL
            if (tail.gitBranch && (!branch || branch === "HEAD")) {
              branch = tail.gitBranch;
            }
          } catch {
            // keep existing summary/branch
          }
        }

        sessions.push({
          id: entry.sessionId,
          repo,
          repoPath: entry.projectPath,
          baseRepoPath,
          branch,
          status: "archived",
          messageCount: entry.messageCount,
          summary,
          modified: new Date(entry.modified),
          firstPrompt: entry.firstPrompt || "",
          lastPrompt: "",
          name: "",
          tmuxPane: undefined,
        });
      }
    } catch {
      continue;
    }
  }

  // Fallback: scan for JSONL files not covered by any index
  // When skipSummaries is set, skip the expensive JSONL parse entirely — only stat for recency
  if (!skipSummaries) {
    try {
      const jsonlGlob = new Bun.Glob("*/*.jsonl");
      for await (const path of jsonlGlob.scan({ cwd: projectsDir, absolute: true })) {
        try {
          const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");

          // Skip if already known from active sessions or index files
          if (activeSessionIds.has(sessionId) || indexSessionIds.has(sessionId)) continue;

          // Check mtime — skip files older than 24h (cheap stat, no file read)
          const file = Bun.file(path);
          const stat = await file.stat();
          if (!stat) continue;
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > archiveWindow) continue;

          // Parse the JSONL for metadata
          const metadata = await parseJsonlMetadata(path);
          if (!metadata) continue;

          // Skip AI naming sessions created by `claude -p` in names.ts
          if (metadata.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;

          let baseRepoPath = metadata.projectPath;
          try { baseRepoPath = await getBaseRepoPath(metadata.projectPath); } catch {}
          const repo = repoNameFromPath(baseRepoPath);
          const summary = metadata.lastAssistantMessage || metadata.firstPrompt || "";

          sessions.push({
            id: sessionId,
            repo,
            repoPath: metadata.projectPath,
            baseRepoPath,
            branch: metadata.gitBranch,
            status: "archived",
            messageCount: metadata.messageCount,
            summary,
            modified: new Date(stat.mtimeMs),
            firstPrompt: metadata.firstPrompt || "",
            lastPrompt: "",
            name: "",
            tmuxPane: undefined,
          });
        } catch {
          continue;
        }
      }
    } catch {
      // Glob scan failed — not fatal
    }
  }

  return sessions;
}

/**
 * Get the current git branch for a project path.
 * Returns empty string if not a git repo or command fails.
 * Cached briefly per path — one subprocess per repo per discovery cycle, not per
 * caller; a checkout on the Mac shows up within the TTL.
 */
const GIT_BRANCH_TTL = 5000;
const gitBranchCache = new Map<string, { ts: number; branch: string }>();

async function getGitBranch(projectPath: string): Promise<string> {
  const hit = gitBranchCache.get(projectPath);
  if (hit && Date.now() - hit.ts < GIT_BRANCH_TTL) return hit.branch;
  let branch = "";
  try {
    branch = (await Bun.$`git -C ${projectPath} branch --show-current`.quiet().text()).trim();
  } catch {
    // not a git repo / git failed — cache the miss too (same TTL) so a non-repo
    // pane doesn't re-spawn git every cycle
  }
  gitBranchCache.set(projectPath, { ts: Date.now(), branch });
  return branch;
}

/**
 * Group sessions by repo name, priority repos first then alphabetical.
 * Sessions within each group mirror portkey's list order (`compareSessions` in
 * bridge/public/app.js): attention (⚡) first, then status priority, then
 * last-activity recency desc.
 */
export function groupSessions(
  sessions: Session[],
  priorityRepos: string[],
  attentionKeys: Set<string> = new Set(),
): RepoGroup[] {
  const statusPriority: Record<Session["status"], number> = {
    waiting: 0,
    running: 1,
    ready: 2,
    idle: 3,
    archived: 4,
  };

  // Group by repo name
  const groupMap = new Map<string, Session[]>();

  for (const session of sessions) {
    const existing = groupMap.get(session.repo);
    if (existing) {
      existing.push(session);
    } else {
      groupMap.set(session.repo, [session]);
    }
  }

  // Build RepoGroup array
  const groups: RepoGroup[] = [];

  // Recency uses lastTurnAt — a stable transcript timestamp — never a live session's
  // `modified` fallback, which is stamped new Date() each refresh and would shuffle
  // same-status sessions between cycles. Archived mtimes are stable, so they stand in.
  const activityMs = (s: Session): number =>
    s.lastTurnAt?.getTime() ?? (s.status === "archived" ? s.modified.getTime() : 0);

  for (const [name, groupSessions] of groupMap) {
    // Portkey's compareSessions: attention first, then status rank, then recency desc.
    // Stable pane-id/id tiebreak so exact ties keep a fixed order across refreshes.
    groupSessions.sort((a, b) => {
      const attnDiff =
        (attentionKeys.has(a.tmuxPane?.paneId ?? "") ? 0 : 1) -
        (attentionKeys.has(b.tmuxPane?.paneId ?? "") ? 0 : 1);
      if (attnDiff !== 0) return attnDiff;
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      const recency = activityMs(b) - activityMs(a);
      if (recency !== 0) return recency;
      const aKey = a.tmuxPane?.paneId ?? a.id;
      const bKey = b.tmuxPane?.paneId ?? b.id;
      return aKey.localeCompare(bKey);
    });

    // Use the baseRepoPath from the first session as the group path
    const path = groupSessions[0].baseRepoPath;

    groups.push({ name, path, sessions: groupSessions });
  }

  // Sort groups: priority repos first (in array order), then alphabetical
  groups.sort((a, b) => {
    const aPriority = priorityRepos.indexOf(a.name.toLowerCase());
    const bPriority = priorityRepos.indexOf(b.name.toLowerCase());
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    if (aPriority !== -1) return -1;
    if (bPriority !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  return groups;
}

interface JsonlMetadata {
  projectPath: string;
  gitBranch: string;
  messageCount: number;
  firstPrompt: string;
  lastAssistantMessage: string;
}

// The archived-sessions fallback scan re-runs on every uncached discovery, and a full
// metadata parse walks the whole file — cache per path keyed by (size, mtime), like
// background-tasks' pathCache, so unchanged files cost one stat.
const jsonlMetadataCache = new Map<string, { size: number; mtimeMs: number; meta: JsonlMetadata | null }>();

/**
 * Parse a JSONL session file and extract metadata for archived session discovery.
 * Returns null if the session is a sidechain or the file is invalid.
 * Streams the file line-by-line (never one contiguous string) — see jsonlLines.
 */
async function parseJsonlMetadata(filePath: string): Promise<JsonlMetadata | null> {
  try {
    const stat = await Bun.file(filePath).stat();
    if (!stat) return null;
    const hit = jsonlMetadataCache.get(filePath);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.meta;
    const meta = await parseJsonlMetadataUncached(filePath);
    jsonlMetadataCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, meta });
    return meta;
  } catch {
    return null;
  }
}

async function parseJsonlMetadataUncached(filePath: string): Promise<JsonlMetadata | null> {
  try {
    let projectPath = "";
    let gitBranch = "";
    let messageCount = 0;
    let firstPrompt = "";
    let lastAssistantMessage = "";

    for await (const line of jsonlLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        // Extract project metadata from the first line that has cwd
        // (metadata fields like cwd, gitBranch, isSidechain appear on user/assistant/system lines)
        if (!projectPath && parsed.cwd) {
          if (parsed.isSidechain) return null;
          projectPath = parsed.cwd || "";
          gitBranch = parsed.gitBranch || "";
        }

        if (parsed.type === "user") {
          messageCount++;

          // Extract first user prompt (reuse same filtering logic as getFirstUserPrompt)
          if (!firstPrompt) {
            let text = "";
            const content = parsed.message?.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textBlock = content.find(
                (block: { type: string }) => block.type === "text",
              );
              if (textBlock?.text) {
                text = textBlock.text;
              }
            }
            if (text && !text.startsWith("[Request interrupted") && !text.trimStart().startsWith("<")) {
              const clean = text.replace(/\s+/g, " ").trim();
              firstPrompt = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
            }
          }
        }

        if (parsed.type === "assistant") {
          messageCount++;

          // Track last assistant message
          let text = "";
          if (typeof parsed.message?.content === "string") {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message?.content)) {
            const textBlock = parsed.message.content.find(
              (block: { type: string }) => block.type === "text",
            );
            if (textBlock?.text) {
              text = textBlock.text;
            }
          }
          if (text) {
            const clean = text.replace(/\s+/g, " ").trim();
            lastAssistantMessage = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
          }
        }
      } catch {
        continue;
      }
    }

    // If we couldn't determine a project path, the file is not useful
    if (!projectPath) return null;

    return { projectPath, gitBranch, messageCount, firstPrompt, lastAssistantMessage };
  } catch {
    return null;
  }
}

/** Slash commands that carry no naming intent — they reset/inspect, not work. */
const META_COMMANDS = new Set([
  "clear", "compact", "rewind", "resume", "init", "cost", "help", "model", "config",
]);

/**
 * Parse a Claude Code slash-command user message into a clean intent string.
 *
 * Slash commands are stored as
 *   <command-name>/implement-plan</command-name>
 *   <command-args>@.plans/native-status/plan.md</command-args>
 * blocks. The plain-text extractor skips them (they start with `<`) and returns
 * the message that follows — which, for skill-launched sessions, is generic skill
 * boilerplate ("Base directory for this skill: …"), not the user's intent. For
 * those sessions the command + args is the ONLY place the real goal lives.
 *
 * Returns the cleaned `/<name> <args>` string, or null for non-command text and
 * for meta commands (clear/compact/…) that carry no intent.
 */
export function slashCommandIntent(text: string): string | null {
  const nameMatch = text.match(/<command-name>\s*\/?([\w-]+)\s*<\/command-name>/);
  if (!nameMatch) return null;
  const name = nameMatch[1].toLowerCase();
  if (META_COMMANDS.has(name)) return null;
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const args = (argsMatch?.[1] ?? "").replace(/\s+/g, " ").trim();
  return args ? `/${name} ${args}` : `/${name}`;
}

/**
 * Read a JSONL session file and extract the first user prompt.
 * Returns a truncated string (first 200 chars) or empty string on failure.
 */
async function getFirstUserPrompt(sessionPath: string): Promise<string> {
  try {
    // Stream and break at the first real prompt — it sits near the top, so this
    // reads a few chunks of a multi-MB file instead of all of it.
    for await (const line of jsonlLines(sessionPath)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "user") continue;

        let text = "";
        const content = parsed.message?.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (block: { type: string }) => block.type === "text",
          );
          if (textBlock?.text) {
            text = textBlock.text;
          }
        }

        // Slash commands arrive as <command-name>…<command-args>… blocks (they
        // start with `<`, so the XML-tag skip below would drop them). For
        // skill-launched sessions the command + args is the real intent — the
        // following message is generic skill boilerplate. Surface it instead.
        const intent = slashCommandIntent(text);
        if (intent) {
          return intent.length > 200 ? intent.slice(0, 200) + "..." : intent;
        }

        // Skip system/meta messages and anything starting with XML tags
        if (!text || text.startsWith("[Request interrupted") || text.trimStart().startsWith("<")) {
          continue;
        }

        // Collapse whitespace and truncate
        const clean = text.replace(/\s+/g, " ").trim();
        return clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
      } catch {
        continue;
      }
    }

    return "";
  } catch {
    return "";
  }
}

/**
 * Scan a JSONL session file for the most recent `"type":"last-prompt"` entry.
 * Claude Code writes one of these on each user turn, so this reflects the
 * current conversation direction (unlike firstPrompt, which is frozen).
 * Returns a truncated string (first 200 chars) or empty string on failure.
 */
export async function getLatestUserPrompt(sessionPath: string): Promise<string> {
  // Tail scan (the readLastPromptAt pattern): the newest last-prompt record sits
  // near the end, so this reads KBs of a multi-MB file — and it runs for EVERY
  // active session on EVERY discovery sweep.
  return scanTailForLine(sessionPath, (line) => {
    if (!line.includes('"type":"last-prompt"')) return undefined;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "last-prompt") return undefined;
      const text: string = parsed.lastPrompt || "";
      if (!text) return undefined;
      const clean = text.replace(/\s+/g, " ").trim();
      return clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
    } catch {
      return undefined;
    }
  });
}

export interface SessionTailInfo {
  lastMessage: string;
  gitBranch: string;
}

/**
 * Read the tail of a JSONL session file and extract the last assistant message
 * and most recent git branch. Only reads the last 32KB to avoid loading multi-MB files.
 * @param maxMessageLength - truncate the last message to this length (default 200)
 */
export async function readSessionTail(sessionPath: string, maxMessageLength = 200): Promise<SessionTailInfo> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return { lastMessage: "", gitBranch: "" };

    const TAIL_SIZE = 32 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const lines = chunk.trim().split("\n").filter(Boolean);

    // If we sliced mid-file, the first line is likely truncated — skip it
    const startIdx = offset > 0 ? 1 : 0;

    let lastMessage = "";
    let gitBranch = "";

    // Walk backwards to find last assistant message and most recent non-HEAD branch
    for (let i = lines.length - 1; i >= startIdx; i--) {
      try {
        const parsed = JSON.parse(lines[i]);

        // Capture most recent non-HEAD gitBranch (HEAD = detached, not useful)
        if (!gitBranch && parsed.gitBranch && parsed.gitBranch !== "HEAD") {
          gitBranch = parsed.gitBranch;
        }

        if (!lastMessage && parsed.type === "assistant") {
          let text = "";
          if (typeof parsed.message?.content === "string") {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message?.content)) {
            const textBlock = parsed.message.content.find(
              (block: { type: string }) => block.type === "text",
            );
            if (textBlock?.text) {
              text = textBlock.text;
            }
          }

          if (text) {
            const clean = text.replace(/\s+/g, " ").trim();
            lastMessage = clean.length > maxMessageLength ? clean.slice(0, maxMessageLength) + "..." : clean;
          }
        }

        if (lastMessage && gitBranch) break;
      } catch {
        continue;
      }
    }

    return { lastMessage, gitBranch };
  } catch {
    return { lastMessage: "", gitBranch: "" };
  }
}

/** Convenience wrapper — returns just the last assistant message (200 char limit). */
export async function getLastAssistantMessage(sessionPath: string): Promise<string> {
  const { lastMessage } = await readSessionTail(sessionPath);
  return lastMessage;
}

/** Strip ANSI escape sequences and control characters from terminal output. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Extract recent user messages from a JSONL session file for content matching.
 * Reads the last 32KB and walks backwards to find the last N user prompts.
 * Returns whitespace-normalized snippets (first 100 chars each, min 20 chars).
 */
async function extractRecentUserMessages(sessionPath: string, count = 3): Promise<string[]> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return [];

    const TAIL_SIZE = 32 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const lines = chunk.trim().split("\n").filter(Boolean);
    const startIdx = offset > 0 ? 1 : 0;

    const snippets: string[] = [];

    for (let i = lines.length - 1; i >= startIdx && snippets.length < count; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type !== "user") continue;

        let text = "";
        const content = parsed.message?.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (block: { type: string }) => block.type === "text",
          );
          if (textBlock?.text) text = textBlock.text;
        }

        // Skip system/meta messages, XML-prefixed content, and very short messages
        if (!text || text.startsWith("[Request interrupted") || text.trimStart().startsWith("<")) continue;

        const clean = text.replace(/\s+/g, " ").trim();
        if (clean.length < 20) continue;

        snippets.push(clean.length > 100 ? clean.slice(0, 100) : clean);
      } catch {
        continue;
      }
    }

    return snippets;
  } catch {
    return [];
  }
}
