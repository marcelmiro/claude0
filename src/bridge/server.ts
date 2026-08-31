/**
 * Claude0 Bridge (Impl #3) — a thin HTTP/SSE transport over the headless `core/` API
 * so an iPhone (over Tailscale) can see sessions, read transcripts, approve tools,
 * answer questions, and send messages. Adds NO Claude-wrapping logic: every route
 * delegates to an existing `core/` function. Headless like `monitor.ts` — imports
 * `core/*` only, never `ui/`/`blessed`.
 *
 * Security posture: bind fail-closed (loopback / tailnet only); a static bearer
 * token, exchanged once via `POST /auth` for an HttpOnly cookie so the token never
 * rides in a URL. `/decision`, `/message`, `/answer`, `/config` are remote-code-execution
 * by design (`/config` is allowlist-clamped) — the tailnet bind is the wall, the token is
 * defense-in-depth.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { relative } from "node:path";
import { discoverSessions, readNamingExtras } from "../core/sessions";
import {
  getTranscript,
  getSubagentTranscript,
  listSubagents,
  pendingToolFields,
  transcriptRevAt,
  sendMessage,
  answerSessionQuestion,
  clarifySessionQuestion,
  createSession,
  restoreState,
  restoreSession,
  forkSession,
  rewindSession,
  archiveSession,
  interruptSession,
  clearPaneInput,
  resolveSessionPane,
  readPaneStatusline,
  decideAttachedApproval,
  setSessionModelEffort,
  isModelArg,
  isEffortArg,
  type SendResult,
} from "../core/session-api";
import { nativeStatus, parkedJobSessions } from "../core/session-state";
import { pendingScriptsAt } from "../core/background-tasks";
import { resolveTranscriptPath } from "../core/last-turn";
import { homedir } from "os";
import { discoverRepos, getBaseRepoPath } from "../core/git";
import { listSlashCommands } from "../core/skills";
import { repoRootForSession, safeRepoPath, fileDiff, rangeDiff, branchChanges } from "../core/repo-files";
import { branchPullRequest, type PullRequestInfo } from "../core/pull-request";
import { recoverWorktreeTranscript } from "../core/recover";
import { loadConfig, PATHS } from "../core/config";
import { saveUploadedBytes } from "../core/uploads";
import { listPendingApprovals, decideApproval } from "../core/approval";
import { markPortkeySource } from "../core/input-source";
import {
  CONSUMERS_DIR,
  isValidDeviceId,
  getVapidPublicKey,
  saveSubscription,
  getSubscription,
  takeRecentPushes,
} from "../core/web-push";
import { watchEvents } from "../core/watch";
import { EVENTS_DIR, pendingToolCall } from "../core/hook-events";
import { capturePane, listPanes } from "../core/tmux";
import { isPermissionPrompt, sessionActivityAt } from "../core/status";
import {
  loadNameCache,
  saveNameCache,
  generateAIName,
  getSessionName,
  acquireNamingLock,
  releaseNamingLock,
  loadNamingSkips,
  setNamingSkip,
  inNamingCooldown,
  needsNaming,
  pruneNameCacheIfLarge,
  type NameCache,
} from "../core/names";
import { buildSessionLabel, disambiguateByRepo, snippet } from "../core/session-label";
import { loadState, saveState } from "../core/state";
import { InboxStore } from "../core/inbox-store";
import { composeSessions, isWakePreset, presetWakeAt, type InboxSession } from "../core/inbox-model";
import { orderInboxRows, type DiscoverySeen } from "./inbox-payload";
import { withDeadline } from "../core/deadline";
import * as stream from "./stream";
import { loadAllSessions, filterAndRankEntries, type SearchEntry } from "../core/search";
import { fixtureData } from "./fixtures";
import type { RestoreState, Session } from "../types";

const PUBLIC_DIR = `${import.meta.dir}/public`;

// Demo/test mode: serve canned data (fixtures.ts) instead of querying core/, so the UI
// renders deterministically with no live sessions. Auth + static serving stay real.
const FIXTURES = !!process.env.CLAUDE0_BRIDGE_FIXTURES;

// Explicit allow-map: request path → file under public/. Never join a raw
// url.pathname onto PUBLIC_DIR (path traversal). Unlisted paths → 404.
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/sw.js": "sw.js",
  // Shared with the TUI (core/status.ts imports the same file) — served unbuilt.
  "/time-ago.js": "../../shared/time-ago.js",
  // Unified-patch parser, shared with its test suite — served unbuilt.
  "/diff-lines.js": "../../shared/diff-lines.js",
  // Notification-tap attribution, shared with its test suite — served unbuilt.
  "/tap-target.js": "../../shared/tap-target.js",
  // Wake countdown, shared with the sidebar (sidebar/ansi.ts) — served unbuilt.
  "/wake-format.js": "../../shared/wake-format.js",
  // Absolute wake moment (snooze toast), shared with the sidebar — served unbuilt.
  "/wake-abs.js": "../../shared/wake-abs.js",
  // Stream-event apply logic (versioned state push), shared with its test suite.
  "/sync.js": "../../shared/sync.js",
  // Tunnel-wake recovery decisions (burst retry + fetch timeouts), shared with
  // its test suite — served unbuilt.
  "/reconnect.js": "../../shared/reconnect.js",
  "/manifest.json": "manifest.json",
  "/icon-512.png": "icon-512.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/vendor/preact.mjs": "vendor/preact.mjs",
  "/vendor/hooks.mjs": "vendor/hooks.mjs",
  "/vendor/signals-core.mjs": "vendor/signals-core.mjs",
  "/vendor/signals.mjs": "vendor/signals.mjs",
  "/vendor/htm.mjs": "vendor/htm.mjs",
  "/vendor/marked.mjs": "vendor/marked.mjs",
};

// ---------------------------------------------------------------------------
// Auth — sha256 + timingSafeEqual (equal-length digests → never throws, no leak)
// ---------------------------------------------------------------------------

let rawToken = "";
let tokenDigest: Buffer;

function tokenMatches(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const digest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(tokenDigest, digest);
}

function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "claude0") return part.slice(eq + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// Gzip JSON bodies for clients that accept it — a long session's transcript payload
// reaches ~250KB raw (~3x smaller gzipped) and portkey often rides a slow mobile
// link. JSON only: SSE must stream unbuffered, and the static shell is cached by
// the service worker. Below the threshold the gzip header outweighs the savings.
// Constraint (BREACH): no JSON body may ever echo attacker-influenced input next to
// a secret — compressed length would then leak the secret to a tailnet observer.
const GZIP_MIN_BYTES = 1024;
export async function gzipJson(req: Request, res: Response): Promise<Response> {
  if (!res.headers.get("content-type")?.startsWith("application/json")) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  if (body.byteLength < GZIP_MIN_BYTES) return new Response(body, { status: res.status, headers });
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  return new Response(Bun.gzipSync(new Uint8Array(body)), { status: res.status, headers });
}

function staticResponse(rel: string): Response {
  const type = rel.endsWith(".html")
    ? "text/html;charset=utf-8"
    : rel.endsWith(".mjs") || rel.endsWith(".js")
      ? "text/javascript;charset=utf-8"
      : rel.endsWith(".json")
        ? "application/manifest+json;charset=utf-8"
        : rel.endsWith(".png")
          ? "image/png"
          : "application/octet-stream";
  // Vendored libs are immutable; the app's own HTML/JS changes as we iterate, so
  // forbid stale caching of it (mobile Safari otherwise serves an old bundle).
  const cache = rel.startsWith("vendor/") ? "public, max-age=86400" : "no-cache";
  return new Response(Bun.file(`${PUBLIC_DIR}/${rel}`), {
    headers: { "content-type": type, "cache-control": cache },
  });
}

function sendResult(r: SendResult): Response {
  return json(r, r.ok ? 200 : 409);
}

// ---------------------------------------------------------------------------
// Image uploads — written to PATHS.uploads, then pasted into the pane by sendMessage.
// ---------------------------------------------------------------------------

const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Persist uploaded image files; returns absolute paths, or a `bad-image` error. */
async function saveUploadedImages(files: File[]): Promise<{ paths: string[] } | { error: "bad-image" }> {
  const paths: string[] = [];
  for (const f of files) {
    const dest = await saveUploadedBytes(await f.arrayBuffer(), f.type);
    if (!dest) return { error: "bad-image" };
    paths.push(dest);
  }
  return { paths };
}

/** Best-effort prune of upload files older than 24h (the bytes live in the JSONL after submit). */
function pruneOldUploads(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(PATHS.uploads)) {
      const p = `${PATHS.uploads}/${name}`;
      try {
        if (now - statSync(p).mtimeMs > UPLOAD_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        // file vanished mid-scan — ignore
      }
    }
  } catch {
    // uploads dir not created yet — nothing to prune
  }
}

// ---------------------------------------------------------------------------
// /sessions — projection (drop the large lastCapture blob), served
// stale-while-revalidate (see sessionsPayload) so a request never blocks on the
// ps/tmux/git discovery sweep and SSE reconnect storms can't fan out into
// concurrent subprocess swarms.
// ---------------------------------------------------------------------------


/**
 * Primary display label: AI name / ticket / branch (via buildSessionLabel), but
 * when that degrades to a bare branch — i.e. the session has no name yet — prefer
 * a first-prompt/summary snippet as the temporary title: what the user asked for
 * identifies the session better than any branch name.
 */
function sessionLabel(s: Session): string {
  const base = buildSessionLabel(s);
  if (base === s.branch) {
    const snip = snippet(s.firstPrompt) || snippet(s.summary);
    if (snip) return snip;
  }
  return base;
}

function projectSession(
  s: Session,
  pending: ReturnType<typeof pendingToolCall>,
  approvalIds: Set<string>,
  unread: boolean,
  restorable?: RestoreState,
  pendingScriptCount?: number,
) {
  // Pending = blocked-on-USER, sourced from the hook log (not status): discovery can
  // mislabel a live blocked session as `archived`, but it must stay reachable from the
  // phone. ONLY a real question or a real awaiting-decision approval counts — an
  // in-flight auto-approved tool is NOT pending (that was the false bash-approval bug).
  const pendingKind =
    pending?.name === "AskUserQuestion" && pending.question
      ? "question"
      : approvalIds.has(s.id)
        ? "approval"
        : null;
  return {
    id: s.id,
    repo: s.repo,
    branch: s.branch,
    status: s.status,
    name: s.name,
    label: sessionLabel(s),
    pending: pendingKind,
    // Unread = the monitor's ⚡ (needsAttention from state.json): a turn that completed
    // or a block that you haven't seen on Mac OR phone yet. Drives the glow + header.
    unread,
    messageCount: s.messageCount,
    summary: s.summary,
    statusSource: s.statusSource,
    modified: s.modified.toISOString(),
    // The age the phone renders: last conversational turn, falling back to the mtime in
    // `modified` when the transcript holds no timestamped turn.
    lastTurn: sessionActivityAt(s).toISOString(),
    // The tmux pane this session lives on (active sessions only). The phone uses it to
    // auto-follow /clear and /compact: both mint a NEW id on the SAME pane, so when the
    // open session goes archived and a live session now holds its pane, that's the successor.
    ...(s.tmuxPane ? { paneId: s.tmuxPane.paneId } : {}),
    // Present only for archived sessions: whether/where the phone can resume it
    // ("yes" | "relocated" | "no") — drives the restore bar's button and label.
    ...(restorable !== undefined ? { restorable } : {}),
    // ≥1 background script still awaited (live sessions only) — the list's ⏳ badge, so
    // a `ready` session mid-wait doesn't read as done from the list.
    ...(pendingScriptCount ? { pendingScripts: pendingScriptCount } : {}),
  };
}

/** PaneIds the monitor currently flags as needing attention (state.json ⚡). */
async function unreadPanes(): Promise<Set<string>> {
  const state = await loadState();
  const out = new Set<string>();
  for (const [paneId, st] of Object.entries(state.sessions)) {
    if (st.needsAttention) out.add(paneId);
  }
  return out;
}

/**
 * Clear a session's unread flag (read-on-open from the phone) by writing
 * needsAttention:false for its live pane into the shared state.json. The monitor
 * re-reads disk each cycle and preserves prior flags, so this stays cleared until the
 * next real transition — clearing the ⚡ on the Mac window name too. Surgical: flips one
 * pane's flag, never rewrites the attention set (safe from a background process).
 */
async function markSessionRead(sessionId: string): Promise<void> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return;
  const state = await loadState();
  const entry = state.sessions[paneId];
  if (!entry?.needsAttention) return;
  entry.needsAttention = false;
  delete entry.attentionType;
  state.lastUpdatedBy = "bridge";
  state.lastUpdatedAt = Date.now();
  await saveState(state);
  kickSessionsPush(sessionId);
}

// Repos available for a new session: active-session repos (worktrees deduped to base)
// plus the configured repository roots, exactly as the TUI wizard sources them. Sources the
// session set from the discovery snapshot computeSessionsPayload already produced
// (repo membership changes on human timescales — no need for a dedicated sweep), and
// falls back to a real discovery only before the first projection exists.
async function reposPayload(): Promise<Array<{ name: string; path: string; branch: string; isWorktree: boolean }>> {
  const cfg = await loadConfig();
  const sessions = lastDiscovered ?? (await discoverSessions({})).sessions;
  const sessionRepos = sessions
    .filter((s) => s.repoPath)
    .map((s) => ({ name: s.repo, path: s.repoPath }));
  const repos = await discoverRepos(sessionRepos, cfg.repositories.roots, cfg.repositories.priority);
  return repos.map((r) => ({
    name: r.name,
    path: r.path,
    branch: r.currentBranch,
    isWorktree: !!r.isWorktree,
  }));
}

let sessionsCache: { ts: number; value: unknown } | null = null;
// Stable age anchor for sessions whose transcript holds no timestamped turn yet
// (lastTurnAt absent): first time this bridge saw the id. A fresh `now` per
// recompute would make the payload differ every pass and self-sustain the
// change-broadcast → refetch cycle (see DiscoverySeen.since). Pruned to the
// tracked set each pass, so it can't grow unbounded.
const firstSeenAt = new Map<string, number>();
// The full session set from the last completed discovery — reused by /repos so opening
// the wizard doesn't re-run the ps/tmux/git sweep the projection just paid for.
let lastDiscovered: Session[] | null = null;

// ---------------------------------------------------------------------------
// Inbox (ADR 0013) — the store is the section brain; the bridge only joins.
// ---------------------------------------------------------------------------

// Lazy singleton: the daemon writes the snapshot; the bridge is a WAL reader
// (plus verb writer). A failed open (unwritable dir, corrupt db) degrades to
// "no inbox" — the payload then carries only untagged rows, flagged stale.
let inboxStore: InboxStore | null = null;
function getInboxStore(): InboxStore | null {
  if (!inboxStore) {
    try {
      inboxStore = new InboxStore();
    } catch {
      return null;
    }
  }
  return inboxStore;
}

/**
 * A verb (snooze/block/archive) on a session the daemon has never snapshotted —
 * born since its last 3s tick, or the daemon down since before the session
 * existed — writes a fact composeSessions can't surface: the overlay only lands
 * on snapshot rows, so the session would vanish from the inbox and the fact
 * would sit stranded. Seed a minimal snapshot row from the bridge's own
 * discovery; the daemon's preserve rule then carries it like any parked/done
 * row. Best-effort — with no discovery row to describe the session, the verb
 * still applies and the id degrades to History-only, as before.
 */
function seedInboxRow(store: InboxStore, id: string, now: number): void {
  try {
    const s = (lastDiscovered ?? []).find((x) => x.id === id);
    if (!s) return;
    const row: InboxSession = {
      id,
      repo: s.repo,
      name: s.name,
      reason: "turn-done",
      since: s.lastTurnAt?.getTime() ?? now,
      repoPath: s.repoPath,
      branch: s.branch,
    };
    store.seedSnapshotRow(id, JSON.stringify(row));
  } catch {
    // seed is visibility-only; the verb's own write already succeeded
  }
}

/** The /sessions row schema — projectSession is its single source of truth. */
type ProjectedRow = ReturnType<typeof projectSession>;

/**
 * Minimal projected row for a store-known session outside discovery's window
 * (pane-less parked, or done approaching the 24h edge): enough for the row +
 * thread-open + restore bar. Everything richer needs a live discovery hit.
 * Typed against ProjectedRow so a renamed/retyped field in projectSession is a
 * compile error here instead of a silently diverging phone row.
 */
async function projectSnapshotOnly(
  s: InboxSession,
  since: number,
): Promise<Omit<ProjectedRow, "statusSource"> & { statusSource: "inbox-snapshot" }> {
  const at = new Date(since).toISOString();
  return {
    id: s.id,
    repo: s.repo,
    branch: s.branch ?? "",
    status: "archived",
    name: s.name,
    label: s.name || s.branch || s.id.slice(0, 8),
    pending: null,
    unread: false,
    messageCount: 0,
    summary: "",
    statusSource: "inbox-snapshot",
    modified: at,
    lastTurn: at,
    restorable: await restoreState(s.id, s.repoPath ?? "", ""),
  };
}

// The wizard is the only consumer and a repo appearing/disappearing is a human-timescale
// event; 15s keeps a reopened wizard instant while an expired hit revalidates behind it.
const REPOS_TTL = 15_000;
const cachedRepos = swrCache(REPOS_TTL, () => reposPayload());

/**
 * Generic stale-while-revalidate cell (the /changes, /pr and /repos caches): a fresh
 * hit serves the value; an EXPIRED hit serves the stale value immediately and kicks one
 * deduplicated background recompute (a failed recompute keeps the stale value); only a
 * cold miss (nothing cached for the key) blocks the request, deduped across concurrent
 * callers. The phone therefore never waits on git/gh past a key's very first request.
 */
function swrCache<V>(ttl: number, compute: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const cache = new Map<string, { ts: number; value: V }>();
  const inflight = new Map<string, Promise<V>>();
  const start = (key: string): Promise<V> => {
    let p = inflight.get(key);
    if (!p) {
      p = compute(key)
        .then((value) => {
          cache.set(key, { ts: Date.now(), value });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
  return async (key: string): Promise<V> => {
    const hit = cache.get(key);
    if (!hit) return start(key); // cold miss — block, deduped
    if (Date.now() - hit.ts >= ttl) start(key).catch(() => {}); // expired — revalidate behind the response
    return hit.value;
  };
}

// The changed-files card and the full list are separate components rendering the same URL,
// and the list is an overlay — opening it doesn't unmount the card, so every transcript
// revision ran the whole git sweep twice. 1s freshness, matching /sessions: short enough
// that opening the list still reflects an out-of-band edit (you editing on the Mac, a
// formatter running), long enough to collapse the duplicate. `/diff` shares it to resolve
// renames (a slightly stale `orig` self-corrects on the next fetch).
const CHANGES_TTL = 1000;
const cachedBranchChanges = swrCache(CHANGES_TTL, (sessionId) => branchChanges(sessionId));

// The PR lookup shells out to `gh`, which hits the network — so unlike /changes (git only,
// 1s freshness) it gets a minute. A PR's state changes on human timescales; re-querying
// GitHub every time the changed-files list is opened would put a visible stall on a
// glance surface.
const PR_TTL = 60_000;
// Keyed by SESSION, with the root resolution inside the compute: repoRootForSession is
// itself a transcript+git walk, so keying by root would leave it on every warm request.
// `{ state: "none" }` (no live repo) caches like any other answer and revalidates the
// same way, so an idle session that comes back live self-corrects within the TTL.
const cachedSessionPr: (sessionId: string) => Promise<PullRequestInfo | { state: "none" }> = swrCache(
  PR_TTL,
  async (sessionId) => {
    const root = await repoRootForSession(sessionId);
    return root ? branchPullRequest(root) : { state: "none" };
  },
);

// GET /sessions/:id/skills — slash-commands scoped to the session's repo. Cached per
// resolved repo dir (30s TTL); the "" key holds the builtin+user fallback used when a
// session's pane/repo can't be resolved (archived / no live pane).
const skillsCache = new Map<string, { list: unknown; ts: number }>();

async function sessionSkills(sessionId: string): Promise<unknown> {
  let repoDir = "";
  try {
    const paneId = await resolveSessionPane(sessionId);
    if (paneId) {
      const pane = (await listPanes()).find((p) => p.paneId === paneId);
      if (pane?.currentPath) repoDir = await getBaseRepoPath(pane.currentPath);
    }
  } catch {}
  const hit = skillsCache.get(repoDir);
  if (hit && Date.now() - hit.ts < 30_000) return hit.list;
  const list = await listSlashCommands(repoDir || undefined);
  skillsCache.set(repoDir, { list, ts: Date.now() });
  return list;
}

/**
 * Serve /sessions stale-while-revalidate with BOUNDED staleness: a projection younger
 * than SESSIONS_FRESH_MS serves as-is; older kicks one deduped background recompute and
 * serves the stale copy — but only up to SESSIONS_MAX_STALE_MS. Past that (the phone
 * returning from a long background, where the "fresher data exists" broadcast may have
 * been missed on a dead socket), the request WAITS for the recompute: a resume must
 * paint the current world, not however-old the last connected moment was. Nothing
 * cached at all (first request / explicit `sessionsCache = null` invalidation) also
 * waits. A changed recompute pushes the fresh payload to every stream client
 * (`stream.pushSessions`), so live clients converge without a refetch.
 */
const SESSIONS_FRESH_MS = 1000;
const SESSIONS_MAX_STALE_MS = 10_000;
let sessionsRefreshing: Promise<unknown> | null = null;

/** One deduped recompute; rejections propagate to awaiting callers (never resolves null). */
function startSessionsRefresh(): Promise<unknown> {
  if (!sessionsRefreshing) {
    // Watchdog: every request funnels into this one promise, so if the compute never
    // settles (a subprocess await lost by the runtime — see core/deadline.ts) it must
    // reject rather than pin the bridge forever. The finally then clears the slot, so
    // the next request starts a fresh compute instead of joining a dead one.
    sessionsRefreshing = withDeadline(computeSessionsPayload(), 30_000, "sessions compute")
      .then((value) => {
        // Push unconditionally — pushSessions dedupes against the last pushed JSON,
        // so an unchanged recompute stays quiet on the wire.
        stream.pushSessions(value, sessionsCache?.ts ?? Date.now());
        return value;
      })
      .finally(() => {
        sessionsRefreshing = null;
      });
  }
  return sessionsRefreshing;
}

async function sessionsPayload(): Promise<unknown> {
  if (!sessionsCache) return startSessionsRefresh();
  const age = Date.now() - sessionsCache.ts;
  if (age >= SESSIONS_MAX_STALE_MS) return startSessionsRefresh();
  if (age >= SESSIONS_FRESH_MS) startSessionsRefresh().catch(() => {}); // revalidate behind the response
  return sessionsCache.value;
}

// --- History: the windowless archive (browse + search) ------------------------
// Backed by the TUI's global-search engine (core/search.ts): every transcript Claude
// still retains, no 24h window. Browse (empty q) pages by recency via a `before`
// timestamp cursor; a query returns one relevance-ranked page (rank order isn't
// chronological, so no cursor). Entries are cached briefly — the corpus scan reads
// head+tail of every transcript (~1s cold) and a debounced search keystroke shouldn't
// re-pay it; archive/restore bust the cache so a just-archived session appears at once.
const HISTORY_PAGE = 50;
const HISTORY_TTL_MS = 15_000;
let historyCache: { ts: number; entries: SearchEntry[] } | null = null;

async function historyEntries(): Promise<SearchEntry[]> {
  if (historyCache && Date.now() - historyCache.ts < HISTORY_TTL_MS) return historyCache.entries;
  const nameCache = await loadNameCache();
  // isActive should mean "has a live pane to switch to" — discovery's archived entries
  // carry ids too and must not count.
  const live = (lastDiscovered ?? []).filter((s) => s.tmuxPane);
  const entries = await loadAllSessions(nameCache, live);
  historyCache = { ts: Date.now(), entries };
  return entries;
}

async function historyPayload(params: URLSearchParams): Promise<unknown> {
  const q = (params.get("q") || "").trim();
  const repo = (params.get("repo") || "").trim();
  const before = Number(params.get("before") || NaN);
  const entries = await historyEntries();

  // Rank/filter before the repo facet is applied, so the chips row can show which
  // repos the current query still matches (and their counts).
  const matched = q ? filterAndRankEntries(entries, q, Number.MAX_SAFE_INTEGER) : entries;
  const repoCounts = new Map<string, number>();
  for (const e of matched) repoCounts.set(e.repo, (repoCounts.get(e.repo) ?? 0) + 1);

  // Chips are for YOUR repos: base repo a direct child of a configured repository root,
  // a root that is itself a repo (e.g. `~/.dotfiles`), or $HOME itself (where general
  // sessions live). Months of history accumulate
  // temp/scratch clones Claude spawned — those get no chip (their rows still list
  // under "all" and in search).
  const home = homedir();
  const roots = (await loadConfig()).repositories.roots.map((p) => p.replace(/^~/, home).replace(/\/+$/, ""));
  const primary = new Set<string>();
  for (const e of matched) {
    const base = (e.baseRepoPath || "").replace(/\/+$/, "");
    if (base === home || roots.some((r) => base === r || (base.startsWith(`${r}/`) && !base.slice(r.length + 1).includes("/")))) {
      primary.add(e.repo);
    }
  }

  let rows = repo ? matched.filter((e) => e.repo === repo) : matched;
  if (!q && Number.isFinite(before)) rows = rows.filter((e) => e.modified.getTime() < before);
  rows = rows.slice(0, HISTORY_PAGE);

  const payload = await Promise.all(
    rows.map(async (e) => ({
      id: e.sessionId,
      repo: e.repo,
      branch: e.branch,
      name: e.name,
      summary: e.summary,
      firstPrompt: e.firstPrompt,
      lastAssistant: e.lastAssistant,
      modified: e.modified.toISOString(),
      isActive: e.isActive,
      ...(e.matchField && q ? { matchField: e.matchField } : {}),
      ...(e.matchSnippet && q ? { matchSnippet: e.matchSnippet } : {}),
      // Disk checks for the returned page only; live rows just open their session.
      ...(e.isActive ? {} : { restorable: await restoreState(e.sessionId, e.projectPath, e.baseRepoPath) }),
    })),
  );

  return {
    rows: payload,
    // Cursor only while browsing, and only when the page filled (more may exist).
    before: !q && rows.length === HISTORY_PAGE ? rows[rows.length - 1]!.modified.getTime() : null,
    repos: [...repoCounts.entries()]
      .filter(([r]) => primary.has(r))
      .map(([r, count]) => ({ repo: r, count })),
  };
}

async function computeSessionsPayload(): Promise<unknown> {
  const now = Date.now();
  const nameCache = await loadNameCache();
  const { sessions } = await discoverSessions({ nameMap: nameCache.names, archivedTtlMs: 15_000 });
  lastDiscovered = sessions; // snapshot for /repos (see reposPayload)
  const approvalIds = new Set(listPendingApprovals().map((a) => a.sessionId));
  const unread = await unreadPanes();
  const tracked = sessions.filter((s) => s.id); // untracked panes (no id) are unaddressable
  // Parent sessionId → live parked-job sessionId, used twice below: a parked job's hook
  // state (pending tool/question) and its scripts are both recorded under the JOB's id
  // while the phone lists the parent.
  const parkedJobs = await parkedJobSessions();
  // One event-log read per session per build: the waiting-session check below and
  // projectSession both need the pending tool call.
  const pendingById = new Map(
    tracked.map((s): [string, ReturnType<typeof pendingToolCall>] => {
      const job = parkedJobs.get(s.id);
      return [s.id, pendingToolCall(s.id) ?? (job ? pendingToolCall(job) : null)];
    }),
  );
  // Attached sessions never get a pending-file (the PreToolUse hook exits neutral so the
  // instant desk prompt shows) — so a phone-approvable permission prompt must be sourced
  // from the live pane. For each WAITING session with no file-pending and no open question,
  // confirm a permission prompt is actually on-screen before flagging it `approval`.
  // Captures are independent per pane — run them concurrently.
  await Promise.all(
    tracked.map(async (s) => {
      if (s.status !== "waiting" || approvalIds.has(s.id) || !s.tmuxPane) return;
      const pt = pendingById.get(s.id);
      if (pt?.name === "AskUserQuestion" && pt.question) return;
      if (isPermissionPrompt(await capturePane(s.tmuxPane.paneId))) approvalIds.add(s.id);
    }),
  );
  // Apply the cached AI name, mirroring the TUI/tmux.
  for (const s of tracked) s.name = getSessionName(s.id, nameCache) || s.name;
  // Disambiguate same-repo name collisions with a " 2"/" 3" suffix, matching the TUI/tmux.
  const dnMap = disambiguateByRepo(tracked.map((s) => ({ id: s.id, name: s.name, repo: s.repo })));
  // Apply the suffixed name onto the projection so the phone's name-first row title
  // (listTitle = s.name || s.label) shows ` 2`/` 3`, matching the TUI/tmux.
  for (const s of tracked) s.name = dnMap.get(s.id) ?? s.name;
  // Restore state for archived sessions only (disk checks) — computed in an async pass
  // before the sync `.map()`, mirroring the approvalIds loop above.
  const restorableMap = new Map<string, RestoreState>();
  await Promise.all(
    tracked
      .filter((s) => s.status === "archived")
      .map(async (s) => {
        restorableMap.set(s.id, await restoreState(s.id, s.repoPath, s.baseRepoPath));
      }),
  );
  // Pending-script counts for sessions with a live Claude process only: without one the
  // task runner is gone, no notification can ever arrive, and a stale "pending" would
  // badge a dead session forever. Cached by (size, mtime) in pendingScriptsAt, so an
  // unchanged transcript costs one stat here.
  // A parked job's scripts run in the session's pane but are recorded in the JOB's
  // transcript, so both are counted against the session the phone lists.
  const scriptCounts = new Map<string, number>();
  await Promise.all(
    tracked
      .filter((s) => s.status === "running" || s.status === "ready" || s.status === "waiting")
      .map(async (s) => {
        const ids = [s.id, parkedJobs.get(s.id)].filter((id): id is string => !!id);
        const counts = await Promise.all(ids.map(async (id) => {
          const path = await resolveTranscriptPath(id);
          return path ? (await pendingScriptsAt(path)).length : 0;
        }));
        const n = counts.reduce((a, b) => a + b, 0);
        if (n > 0) scriptCounts.set(s.id, n);
      }),
  );
  const value = tracked.map((s) =>
    projectSession(
      s,
      pendingById.get(s.id) ?? null,
      approvalIds,
      !!(s.tmuxPane && unread.has(s.tmuxPane.paneId)),
      restorableMap.get(s.id),
      scriptCounts.get(s.id),
    ),
  );
  // Inbox (ADR 0013): the store decides every row's section (composeSessions →
  // orderInboxRows); the bridge contributes only row detail, joined by id. Inbox rows
  // come first in section order and carry `inbox` meta; rows without a store row (idle
  // panes, 24h-window archived) follow untagged — they never render in the home list,
  // but still back the client's by-id lookups (open session, attention queue).
  let rows: unknown[] = value;
  let inboxStale = true;
  const store = getInboxStore();
  if (store) {
    try {
      const composed = composeSessions(store);
      const snapAt = store.loadSnapshot().map((r) => r.updatedAt);
      inboxStale = snapAt.length === 0 || Math.max(...snapAt) < now - 10_000;
      const trackedIds = new Set(tracked.map((s) => s.id));
      for (const id of firstSeenAt.keys()) if (!trackedIds.has(id)) firstSeenAt.delete(id);
      const firstSeen = (id: string): number => {
        const v = firstSeenAt.get(id);
        if (v !== undefined) return v;
        firstSeenAt.set(id, now);
        return now;
      };
      const discovery = new Map<string, DiscoverySeen>(
        tracked.map((s) => {
          const pt = pendingById.get(s.id);
          return [
            s.id,
            {
              status: s.status,
              live: !!s.tmuxPane,
              needsYou:
                !!(s.tmuxPane && unread.has(s.tmuxPane.paneId)) ||
                approvalIds.has(s.id) ||
                (pt?.name === "AskUserQuestion" && !!pt.question),
              since: s.lastTurnAt?.getTime() ?? firstSeen(s.id),
            },
          ];
        }),
      );
      const projected = new Map(value.map((r) => [r.id, r]));
      const ordered: unknown[] = [];
      const seen = new Set<string>();
      for (const row of orderInboxRows(composed, discovery, now)) {
        seen.add(row.id);
        const detail =
          projected.get(row.id) ??
          (row.snapshot ? await projectSnapshotOnly(row.snapshot, row.meta.since) : null);
        if (detail) ordered.push({ ...detail, inbox: row.meta });
      }
      for (const r of value) if (!seen.has(r.id)) ordered.push(r);
      rows = ordered;
    } catch {
      // store unreadable this pass — serve the untagged discovery rows, flagged stale
    }
  }
  const payload = { sessions: rows, inboxStale };
  sessionsCache = { ts: now, value: payload };
  maybeGenerateNames(tracked, nameCache); // fire-and-forget; refreshes via SSE
  return payload;
}

// --- Background AI naming -------------------------------------------------
// Generate tmux-style names for unnamed AND drifted sessions, reusing the monitor's
// generateAIName + the shared name cache and skip file. Drift refresh matters here:
// the monitor only ticks while a tmux client is attached, so on a phone-only day the
// bridge is the sole naming authority. Lock-coordinated so the bridge and monitor
// never double-name; every attempt (success or failure) starts a cooldown — long
// for renames (drift-thrash guard), short for still-unnamed sessions.

let namingActive = false;
const NAMING_BATCH = 3; // keep concurrent `claude -p` low so cold starts don't starve past the timeout
const PROJECTS_DIR = `${homedir()}/.claude/projects`;

function maybeGenerateNames(sessions: Session[], cache: NameCache): void {
  if (namingActive) return;
  namingActive = true;
  let locked = false;
  void (async () => {
    try {
      const skips = await loadNamingSkips();
      const todo = sessions
        .filter(
          (s) =>
            s.id &&
            !inNamingCooldown(skips, s.id, cache) &&
            (s.firstPrompt || s.summary || s.lastPrompt) &&
            needsNaming(cache, s.id, s.lastPrompt || s.summary || ""),
        )
        .slice(0, NAMING_BATCH);
      if (todo.length === 0) return;
      locked = await acquireNamingLock();
      if (!locked) return; // monitor is naming — skip this cycle
      const named: Array<[id: string, name: string, source: string]> = [];
      await Promise.all(
        todo.map(async (s) => {
          const extras = await readNamingExtras(s.repoPath, s.id);
          const name = await generateAIName({
            firstPrompt: s.firstPrompt,
            summary: s.summary,
            branch: s.branch,
            lastPrompt: s.lastPrompt,
            ...extras,
          });
          // Cooldown on success too — the post-rename guard against drift-thrash.
          await setNamingSkip(s.id);
          if (name) named.push([s.id, name, s.lastPrompt || s.summary || s.firstPrompt]);
        }),
      );
      if (named.length > 0) {
        // Reload under the lock so we merge onto any names the monitor wrote meanwhile.
        const fresh = await loadNameCache();
        for (const [id, name, source] of named) {
          fresh.names[id] = name;
          // Written so the monitor's drift check agrees on what this name was
          // based on — without it, the monitor re-names every bridge-named session.
          fresh.sources[id] = source;
        }
        await pruneNameCacheIfLarge(fresh, PROJECTS_DIR);
        await saveNameCache(fresh);
        kickSessionsPush(); // re-project + push with the new names
      }
    } catch {
      // naming is best-effort — never let it crash the server
    } finally {
      if (locked) await releaseNamingLock();
      namingActive = false;
    }
  })();
}

// ---------------------------------------------------------------------------
// SSE — versioned state push (src/bridge/stream.ts owns the registry/protocol).
// Connect delivers a `sessions` snapshot (+ the device's subscribed transcript),
// so a foregrounding phone paints correct state in one round-trip. Heartbeat
// every 15s (iOS drops idle background sockets ~30s).
// ---------------------------------------------------------------------------

// Liveness marker for the focus-aware question-intercept hook: its mtime is the only
// on-disk signal that a phone is actually connected (the `clients` set is in-memory).
// The hook holds an AskUserQuestion for 600s ONLY when this marker is fresh (≤40s old),
// so nobody's-phone-connected never causes a 600s stall. Never crash the bridge.
const BRIDGE_CONSUMER = `${PATHS.dir}/bridge-consumer`;
function touchMarker(path: string): void {
  try {
    closeSync(openSync(path, "w")); // create/truncate → bumps mtime to now
  } catch {
    /* marker is best-effort */
  }
}
function clearMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

// Per-device liveness markers (consumers/<deviceId>) — the push-suppression signal.
// Additive to the aggregate BRIDGE_CONSUMER above, which the question-intercept
// hook reads and which must keep its exact semantics.
function touchDeviceConsumer(deviceId: string): void {
  try {
    mkdirSync(CONSUMERS_DIR, { recursive: true });
  } catch {
    /* marker is best-effort */
  }
  touchMarker(`${CONSUMERS_DIR}/${deviceId}`);
}
function clearDeviceConsumer(deviceId: string): void {
  clearMarker(`${CONSUMERS_DIR}/${deviceId}`);
}

/** The validated device identity a portkey client sends on every request. */
function deviceOf(req: Request): string | undefined {
  const d = req.headers.get("x-claude0-device");
  return isValidDeviceId(d) ? d : undefined;
}

/**
 * Invalidate the /sessions projection and kick one recompute; the recompute
 * pushes the fresh payload to every stream client when it differs from the last
 * pushed one (dedupe lives in stream.pushSessions). This replaces the old
 * `session-changed` doorbell: the push carries the data, so clients apply
 * instead of refetching. A sessionId additionally schedules a transcript push
 * for that session's subscribers.
 */
function kickSessionsPush(sessionId?: string): void {
  // Fixtures mode: the canned payload IS the state — never let a real recompute
  // (whose discovery output would differ) get pushed over it.
  if (FIXTURES) {
    if (sessionId) scheduleTranscriptPush(sessionId);
    return;
  }
  sessionsCache = null;
  if (sessionsRefreshing) {
    // A compute is mid-flight and won't see this change (turn-end bursts: the Stop
    // event lands while the last PostToolUse's compute runs) — run one more after
    // it. Concurrent chains dedupe: the first re-kick claims the slot, the rest join.
    sessionsRefreshing.catch(() => {}).then(() => void startSessionsRefresh().catch(() => {}));
  } else {
    void startSessionsRefresh().catch(() => {});
  }
  if (sessionId) scheduleTranscriptPush(sessionId);
}

// Debounced per-session transcript pushes: hook events (150ms upstream debounce)
// and the per-subscription JSONL watcher (500ms) both funnel here; one compose
// serves every subscribed device with its own append/snapshot delta.
const txPushTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleTranscriptPush(sessionId: string, delayMs = 150): void {
  if (!stream.hasSubscribers(sessionId)) return;
  const existing = txPushTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  txPushTimers.set(
    sessionId,
    setTimeout(() => {
      txPushTimers.delete(sessionId);
      void pushTranscriptNow(sessionId);
    }, delayMs),
  );
}

async function pushTranscriptNow(sessionId: string): Promise<void> {
  if (!stream.hasSubscribers(sessionId)) return;
  try {
    const payload = FIXTURES
      ? (fixtureData("GET", `/sessions/${sessionId}/transcript`) as Record<string, unknown>)
      : await composeTranscriptPayload(sessionId);
    if (payload) stream.pushTranscript(sessionId, payload as { turns?: unknown[] } & Record<string, unknown>);
  } catch {
    // compose failed this pass — the next change (or the client's fallback GET) covers it
  }
}

// One JSONL watcher per subscribed device: the transcript grows mid-turn with no
// hook event (streamed assistant text, queue consumption), and this is what makes
// those pushes live. Watches the PARENT dir filtered to the file's basename —
// fs.watch on the file itself breaks on atomic rename-replace, and the file may
// not exist yet at all (a fork before its first turn).
const subWatchers = new Map<string, FSWatcher>();
// Per-device call generation: an older watchSubscription call whose async path
// resolution finishes AFTER a newer call must never install its watcher — a
// subscription-equality check alone can't tell A→B→A apart from plain A.
const subWatcherGen = new Map<string, number>();
async function watchSubscription(deviceId: string, sessionId: string | null): Promise<void> {
  const gen = (subWatcherGen.get(deviceId) ?? 0) + 1;
  subWatcherGen.set(deviceId, gen);
  const old = subWatchers.get(deviceId);
  if (old) {
    subWatchers.delete(deviceId);
    try {
      old.close();
    } catch {}
  }
  if (!sessionId || FIXTURES) return;
  try {
    const txId = (await parkedJobSessions()).get(sessionId) ?? sessionId;
    const path = await resolveTranscriptPath(txId);
    if (!path) return; // no file yet — hook-event pushes still cover it
    const cut = path.lastIndexOf("/");
    const dir = path.slice(0, cut);
    const base = path.slice(cut + 1);
    const w = watch(dir, (_event, filename) => {
      if (filename === base) scheduleTranscriptPush(sessionId, 500);
    });
    // A newer call superseded this one while the path resolved — never leak a watcher.
    if (subWatcherGen.get(deviceId) === gen) subWatchers.set(deviceId, w);
    else w.close();
  } catch {
    // watcher is an enhancement — hook events + safety polls still drive pushes
  }
}

/**
 * After an interrupt, wait for Claude's native status to leave "running" (busy→idle
 * ~1.5s later) and push so clients see the now-"ready" status. `nativeStatus`
 * has a ~1s cache TTL, so ~500ms polling is the practical resolution floor; ~3.5s of
 * budget covers the flip. Always pushes on exit (even at timeout) so a missed
 * native write doesn't strand the client on the stale "running". Fire-and-forget.
 */
function reconcileAfterInterrupt(id: string): void {
  void (async () => {
    for (let i = 0; i < 7; i++) {
      await Bun.sleep(500);
      const status = await nativeStatus(id);
      if (status && status !== "running") break;
    }
    kickSessionsPush(id);
  })();
}

function streamResponse(deviceId?: string): Response {
  let self: ReadableStreamDefaultController;
  const body = new ReadableStream({
    start(controller) {
      self = controller;
      stream.addClient(controller, deviceId);
      touchMarker(BRIDGE_CONSUMER); // a phone is now connected — mark it fresh
      if (deviceId) touchDeviceConsumer(deviceId); // this device is watching live
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      // Snapshot-on-connect, to THIS controller only: the current sessions payload
      // (plus a fresh recompute behind it) and, if this device has a transcript
      // subscription, a forced-snapshot transcript push. This replaces the client's
      // three racing foreground refetches.
      const cached = FIXTURES ? fixtureData("GET", "/sessions") : sessionsCache?.value;
      if (cached) stream.pushSessions(cached, sessionsCache?.ts ?? Date.now(), controller);
      if (!FIXTURES) void startSessionsRefresh().catch(() => {});
      if (deviceId) {
        const sub = stream.subscriptionFor(deviceId);
        if (sub) {
          stream.forceSnapshot(deviceId);
          scheduleTranscriptPush(sub, 0);
        }
      }
    },
    cancel() {
      if (stream.removeClient(self) === 0) clearMarker(BRIDGE_CONSUMER); // last phone gone — go stale now
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Transcript composition — shared by the GET route and the stream pusher, so
// both surfaces always agree on the payload shape.
// ---------------------------------------------------------------------------

// Real awaiting-decision approval (blocking hook), NOT the in-flight pendingTool —
// so Allow/Deny only appears when a decision is genuinely required. Detached sessions
// surface it via the pending-file; an ATTACHED session has no file, so confirm a
// permission prompt is live on the pane and synthesize the same card shape from the
// pending tool call (identical Allow/Deny UI; /decision drives the keys instead).
function resolveApproval(
  txId: string,
  id: string,
  pt: ReturnType<typeof pendingToolCall>,
  pane: string | null,
  capture: string,
) {
  const blocked = listPendingApprovals().find((a) => a.sessionId === txId) ?? null;
  if (blocked || !pane || !pt) return blocked;
  if (pt.name === "AskUserQuestion" && pt.question) return null;
  if (!isPermissionPrompt(capture)) return null;
  return {
    sessionId: id,
    ts: 0,
    tool: pt.name,
    tool_use_id: pt.toolUseId,
    input: { command: pt.command, file_path: pt.filePath, description: pt.description },
  };
}

/**
 * The full transcript payload for a session — the whole active branch
 * (reconstructed leaf→root; a rewind can shrink the conversation) plus the
 * volatile pane/hook state (approval, statusline, permission mode). While a live
 * parked job (kind:"bg") owns this session's pane, the conversation on screen
 * belongs to the JOB session — answer with its transcript + hook state.
 * Pane-scoped fields (capture, statusline) stay on the listed id, whose pane it is.
 */
async function composeTranscriptPayload(id: string): Promise<Record<string, unknown>> {
  const txId = (await parkedJobSessions()).get(id) ?? id;
  // Transcript read and pane resolution share no state — overlap them.
  const [tx, pane] = await Promise.all([getTranscript(txId), resolveSessionPane(id)]);
  // One capture serves both the permission-prompt check and the statusline scrape.
  const capture = pane ? await capturePane(pane) : "";
  const approval = resolveApproval(txId, id, pendingToolCall(txId), pane, capture);
  // The live statusline + permission mode, scraped from the pane (the only faithful
  // source for the user's custom statusline and the auto/plan mode).
  const statusline = pane ? await readPaneStatusline(pane, capture) : {};
  return { ...tx, approval, ...statusline };
}

/**
 * Tail-first initial paint: `?tail=<n>` trims the payload to the last n turns,
 * marked `partial: true` and stripped of `rev` — a partial copy must never
 * satisfy the `?rev=` short-circuit or be held by the client as a full
 * revision. A payload already at or under n turns passes through untouched
 * (full, `rev` kept, no `partial`), as does any out-of-bounds or garbage `n`.
 */
export function applyTail(payload: Record<string, unknown>, tailParam: string | null): Record<string, unknown> {
  const n = Number(tailParam);
  if (!tailParam || !Number.isInteger(n) || n < 1 || n > 500) return payload;
  const turns = payload.turns;
  if (!Array.isArray(turns) || turns.length <= n) return payload;
  const { rev: _rev, ...rest } = payload;
  return { ...rest, turns: turns.slice(-n), partial: true };
}

// One source of truth for the transcript route: the FIXTURES early-return must keep
// matching exactly what the real handler below matches, or `?tail` silently diverges
// between demo and production.
const TRANSCRIPT_PATH = /^\/sessions\/([^/]+)\/transcript$/;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // --- Public: static shell (carries no secret/data) ---
  if (method === "GET" && path in STATIC) return staticResponse(STATIC[path]!);

  // --- Public: token → cookie exchange (the only place the token is accepted) ---
  if (method === "POST" && path === "/auth") {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string" || !tokenMatches(body.token)) return json({ ok: false }, 401);
    return json({ ok: true }, 200, {
      "set-cookie": `claude0=${rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    });
  }

  // --- Everything below is protected: valid claude0 cookie required ---
  if (!tokenMatches(cookieToken(req))) return json({ ok: false }, 401);

  // --- Demo/test mode: canned data for the GET/action routes (`/stream` falls through) ---
  if (FIXTURES) {
    const fixture = fixtureData(method, path, url.searchParams);
    if (fixture !== undefined) {
      // The canned transcript honors `?tail` too — this branch returns before the
      // real transcript handler below, and the design loop needs the partial paint.
      if (method === "GET" && TRANSCRIPT_PATH.test(path)) {
        return json(applyTail(fixture as Record<string, unknown>, url.searchParams.get("tail")));
      }
      return json(fixture);
    }
  }

  if (method === "GET" && path === "/sessions") return json(await sessionsPayload());
  if (method === "GET" && path === "/preferences") {
    const cfg = await loadConfig();
    return json({ repositoryPriority: cfg.repositories.priority });
  }
  if (method === "GET" && path === "/pending") return json(listPendingApprovals());
  // EventSource can't set headers, so the deviceId rides a query param here.
  if (method === "GET" && path === "/stream") {
    const d = url.searchParams.get("device");
    return streamResponse(isValidDeviceId(d) ? d : undefined);
  }

  // --- Web Push: per-device subscriptions (see core/web-push.ts) ---
  if (method === "GET" && path === "/push/vapid-key") {
    try {
      return json({ key: await getVapidPublicKey() });
    } catch {
      // Keypair generation/persist failed — refuse rather than hand out a key
      // that won't survive the process (the client retries on next launch).
      return json({ ok: false, reason: "vapid-unavailable" }, 500);
    }
  }
  if (method === "POST" && path === "/push/subscribe") {
    const body = (await req.json().catch(() => ({}))) as {
      deviceId?: unknown;
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    };
    const sub = body.subscription;
    if (
      !isValidDeviceId(body.deviceId) ||
      typeof sub?.endpoint !== "string" ||
      !sub.endpoint.startsWith("https://") ||
      typeof sub.keys?.p256dh !== "string" ||
      typeof sub.keys?.auth !== "string"
    ) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    saveSubscription(body.deviceId, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return json({ ok: true });
  }
  // Server-truth for the client's launch check — pushManager.getSubscription()
  // can't see a server-side prune (404/410/VAPID-mismatch), so the client asks.
  if (method === "GET" && path === "/push/subscribed") {
    const d = url.searchParams.get("device");
    return json({ subscribed: isValidDeviceId(d) && getSubscription(d) !== null });
  }
  // Which sessions we pushed to this device lately, so the page can tell a
  // notification tap from a manual app open (it diffs this against the shade —
  // see shared/tap-target.js). Delete-on-read: one push, one attribution.
  if (method === "GET" && path === "/push/recent") {
    const d = url.searchParams.get("device");
    return json({ pushes: isValidDeviceId(d) ? takeRecentPushes(d) : {} });
  }
  // sendBeacon target fired on visibilitychange→hidden: the client closes its
  // EventSource FIRST (so no heartbeat re-touches the marker on a lingering
  // socket), then beacons. Body is text/plain (sendBeacon can't set headers).
  if (method === "POST" && path === "/push/goodbye") {
    const d = (await req.text().catch(() => "")).trim();
    if (isValidDeviceId(d)) {
      clearDeviceConsumer(d);
      // Backgrounded = not watching: drop the transcript subscription (and its JSONL
      // watcher). The client re-subscribes on foreground via /stream/open.
      stream.subscribe(d, null);
      void watchSubscription(d, null);
    }
    return json({ ok: true });
  }
  if (method === "GET" && path === "/repos") return json(await cachedRepos(""));
  if (method === "GET" && path === "/history") return json(await historyPayload(url.searchParams));

  // New session: launch `claude` in a new tmux window for the chosen repo (TUI `n`).
  if (method === "POST" && path === "/sessions/new") {
    const body = (await req.json().catch(() => ({}))) as { path?: unknown; name?: unknown };
    if (typeof body.path !== "string" || typeof body.name !== "string") {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    return sendResult(await createSession(body.path, body.name));
  }

  const transcript = path.match(TRANSCRIPT_PATH);
  if (method === "GET" && transcript) {
    const id = decodeURIComponent(transcript[1]!);
    // Fast path: the client holds this exact file revision (`?rev=`), so skip rebuilding
    // and re-shipping the turns — the payload that scales with thread length. Everything
    // that can change WITHOUT the file changing still ships fresh: the pending
    // tool/question (hook events log), approval + statusline (pane scrape), and the
    // subagent list (separate per-agent files — an agent finishing doesn't bump the
    // session file). The client merges these over its held turns.
    const wantRev = url.searchParams.get("rev");
    if (wantRev) {
      const txId = (await parkedJobSessions()).get(id) ?? id;
      const at = await transcriptRevAt(txId);
      if (at && at.rev === wantRev) {
        const [pane, subagents] = await Promise.all([resolveSessionPane(id), listSubagents(at.path)]);
        const capture = pane ? await capturePane(pane) : "";
        const pt = pendingToolCall(txId);
        const statusline = pane ? await readPaneStatusline(pane, capture) : {};
        return json({
          unchanged: true,
          rev: at.rev,
          ...pendingToolFields(pt),
          subagents, // always present here ([] clears) — the client overwrites its copy
          approval: resolveApproval(txId, id, pt, pane, capture),
          ...statusline,
        });
      }
    }
    return json(applyTail(await composeTranscriptPayload(id), url.searchParams.get("tail")));
  }

  // Transcript subscription (versioned state push): the device tells the bridge which
  // ONE session it has open; the bridge pushes that session's transcript over the
  // stream — a forced snapshot now, then append/snapshot deltas as it changes (JSONL
  // watcher + hook events). `sessionId: null` unsubscribes.
  if (method === "POST" && path === "/stream/open") {
    const body = (await req.json().catch(() => ({}))) as { sessionId?: unknown };
    const sid = body.sessionId;
    // Shape-check the id like deviceId below: it reaches resolveTranscriptPath's Glob,
    // where metacharacters ("*", "../") would widen the scan past the named session.
    if (sid !== null && (typeof sid !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(sid))) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    // Device identity rides the x-claude0-device header here (the app patches fetch);
    // only /stream itself uses ?device=, since EventSource can't set headers.
    const deviceId = deviceOf(req);
    if (!deviceId) return json({ ok: false, reason: "no-device" }, 400);
    stream.subscribe(deviceId, sid);
    void watchSubscription(deviceId, sid);
    if (sid) {
      stream.forceSnapshot(deviceId);
      void pushTranscriptNow(sid);
    }
    return json({ ok: true });
  }

  // Drill into ONE subagent's full conversation. Anchored like `…/transcript$` so it isn't
  // shadowed; getSubagentTranscript validates the agentId (traversal guard) and 404s on a
  // bad id / missing file.
  const subagent = path.match(/^\/sessions\/([^/]+)\/subagents\/([^/]+)$/);
  if (method === "GET" && subagent) {
    const id = decodeURIComponent(subagent[1]!);
    const agentId = decodeURIComponent(subagent[2]!);
    const tx = await getSubagentTranscript(id, agentId);
    if (!tx) return json({ ok: false, reason: "not-found" }, 404);
    return json(tx);
  }

  const skills = path.match(/^\/sessions\/([^/]+)\/skills$/);
  if (method === "GET" && skills) {
    return json(await sessionSkills(decodeURIComponent(skills[1]!)));
  }

  // --- Repo-scoped read-only diff access (Portkey Layer 1) — containment-guarded to the
  // session's live repo root. 404 on no-live-repo (idle/archived) or an escaping path.
  // `relTo` re-derives the repo-relative path from the guard's validated abs (which may have
  // normalized `..`), so git only ever sees a path known to be inside the repo. ---
  const relTo = (root: string, abs: string) => relative(root, abs);

  // Files this branch changed vs its base branch (committed + uncommitted) — the changed-files
  // card + full list. Only changed files, never the whole repo. Carries `tiers`, the same work
  // split by how far it has travelled (pushed / committed-not-pushed / uncommitted), on the
  // same payload so the card and the list can never disagree about it.
  const changes = path.match(/^\/sessions\/([^/]+)\/changes$/);
  if (method === "GET" && changes) {
    const data = await cachedBranchChanges(decodeURIComponent(changes[1]!));
    if (!data) return json({ ok: false, reason: "no-repo" }, 404);
    return json(data);
  }

  // Single-file diff, branch vs its base (committed + uncommitted, + untracked). `path` =
  // repo-relative, sent by a changed-files row; git calls use
  // `-- <rel>` so a leading-dash path can't be read as a flag. `from`/`to` scope the patch to
  // one tier of the sync chain — the row's LOC and its patch then measure the same range.
  const diff = path.match(/^\/sessions\/([^/]+)\/diff$/);
  if (method === "GET" && diff) {
    const rel = url.searchParams.get("path");
    if (!rel) return json({ ok: false, reason: "no-path" }, 400);
    const id = decodeURIComponent(diff[1]!);
    const root = await repoRootForSession(id);
    if (!root) return json({ ok: false, reason: "no-repo" }, 404);
    const abs = safeRepoPath(root, decodeURIComponent(rel));
    if (!abs) return json({ ok: false, reason: "not-found" }, 404);
    const relPath = relTo(root, abs);
    const changed = await cachedBranchChanges(id);
    // Only a range this session's own chain published is honoured: the endpoints reach git as
    // a revspec, and a caller-supplied one could otherwise pose as an option (`--output=…`).
    // A pair that no longer matches (the chain moved since the list was fetched) degrades to
    // the branch-vs-base diff rather than erroring.
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to") || "";
    const tier = from ? changed?.tiers?.find((t) => t.from === from && t.to === to) : undefined;
    // `orig` (the old path of a rename) makes the diff show the true rename rather than a
    // whole-file add. Resolve it from the change list rather than trusting the caller to
    // supply it, so a caller that only knows the current path still gets the true rename.
    // The list is cached, so this costs nothing on the common path. An explicit `orig`
    // param still wins. Within a tier the lookup is scoped to THAT tier — a rename
    // committed but not pushed is a rename in one range and an ordinary file in the next.
    const origParam = url.searchParams.get("orig");
    const origAbs = origParam ? safeRepoPath(root, decodeURIComponent(origParam)) : null;
    let orig = origAbs ? relTo(root, origAbs) : undefined;
    if (!orig) orig = (tier?.files ?? changed?.files ?? []).find((f) => f.path === relPath)?.orig;
    if (tier?.to) return json(await rangeDiff(root, tier.from, tier.to, relPath, orig));
    // A tier ending at the working tree (`uncommitted`) still needs `fileDiff`'s untracked
    // fallback and pathspec normalization — only its start ref moves.
    if (tier) return json(await fileDiff(root, abs, relPath, orig, { ref: tier.from, label: tier.from }));
    return json(await fileDiff(root, abs, relPath, orig));
  }

  // The GitHub PR for this session's branch — the changed-files list's exit to the real review
  // surface. `{ state: "none" }` whenever there's nothing to link (default branch, no GitHub
  // remote, no gh), and the UI renders nothing for it.
  const pr = path.match(/^\/sessions\/([^/]+)\/pr$/);
  if (method === "GET" && pr) {
    return json(await cachedSessionPr(decodeURIComponent(pr[1]!)));
  }

  const decision = path.match(/^\/sessions\/([^/]+)\/decision$/);
  if (method === "POST" && decision) {
    const body = (await req.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown };
    if (body.decision !== "allow" && body.decision !== "deny") {
      return json({ ok: false, reason: "bad-decision" }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const id = decodeURIComponent(decision[1]!);
    // Detached (blocking-hook) approvals resolve via the decision file; an attached
    // session has no such file, so drive its on-screen prompt with pane keystrokes.
    // A parked job's hook holds under the JOB's id (the transcript endpoint surfaced
    // it from there), so the hold — and the decision file it polls — is keyed by
    // whichever id the approval was recorded under.
    const txId = (await parkedJobSessions()).get(id) ?? id;
    const blocked = listPendingApprovals().find((a) => a.sessionId === id || a.sessionId === txId);
    if (blocked) {
      decideApproval(blocked.sessionId, body.decision, { reason, toolUseId: blocked.tool_use_id });
      markPortkeySource(id, { deviceId: deviceOf(req) });
      return json({ ok: true });
    }
    const r = await decideAttachedApproval(id, body.decision);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) });
    return sendResult(r);
  }

  const rewind = path.match(/^\/sessions\/([^/]+)\/rewind$/);
  if (method === "POST" && rewind) {
    const body = (await req.json().catch(() => ({}))) as {
      upCount?: unknown;
      text?: unknown;
      mode?: unknown;
    };
    if (
      typeof body.upCount !== "number" ||
      typeof body.text !== "string" ||
      (body.mode !== "conversation" && body.mode !== "both")
    ) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    const id = decodeURIComponent(rewind[1]!);
    const r = await rewindSession(id, body.upCount, body.text, body.mode);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: body.text }); // rewind re-sends text → attributes by text-match
    return sendResult(r);
  }

  const message = path.match(/^\/sessions\/([^/]+)\/message$/);
  if (method === "POST" && message) {
    const id = decodeURIComponent(message[1]!);
    // Multipart = a message with image attachments; JSON = the original text-only path.
    if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      if (!form) return json({ ok: false, reason: "bad-form" }, 400);
      const text = typeof form.get("text") === "string" ? (form.get("text") as string) : "";
      const files = form.getAll("image").filter((v): v is File => v instanceof File);
      if (!text.trim() && files.length === 0) return json({ ok: false, reason: "empty" }, 400);
      const saved = await saveUploadedImages(files);
      if ("error" in saved) return json({ ok: false, reason: saved.error }, 400);
      pruneOldUploads();
      const r = await sendMessage(id, text, saved.paths);
      // Image-only (empty text) can't text-match; fall back to the turn's prompt_id anchor.
      if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: text.trim() ? text : undefined });
      return sendResult(r);
    }
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return json({ ok: false, reason: "bad-text" }, 400);
    const r = await sendMessage(id, body.text);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: body.text });
    return sendResult(r);
  }

  const answer = path.match(/^\/sessions\/([^/]+)\/answer$/);
  if (method === "POST" && answer) {
    const body = (await req.json().catch(() => ({}))) as { selections?: unknown; toolUseId?: unknown };
    const sels = body.selections;
    // Optional pin to the question the client rendered — a stale card must not answer
    // the question that replaced it. Older cached clients omit it; the gate is skipped.
    const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId : undefined;
    // One entry per question: each is a number (single-select) or number[] (multi-select).
    const valid =
      Array.isArray(sels) &&
      sels.length > 0 &&
      sels.every(
        (s) => typeof s === "number" || (Array.isArray(s) && s.every((n) => typeof n === "number")),
      );
    if (!valid) return json({ ok: false, reason: "bad-selection" }, 400);
    const id = decodeURIComponent(answer[1]!);
    // A parked job's open question lives in the JOB session's hook state; its pane
    // resolves back through the parent (resolveSessionPane's parked-job join).
    const txId = (await parkedJobSessions()).get(id) ?? id;
    const r = await answerSessionQuestion(txId, sels as (number | number[])[], toolUseId);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) }); // no text ⇒ anchors the current turn's prompt_id
    return sendResult(r);
  }

  // "Chat about this": decline the open question so the agent yields and waits for the
  // user's next message (the composer takes over on the phone). Works held (decision
  // file) and un-held (drives the native picker's own chat row).
  const clarify = path.match(/^\/sessions\/([^/]+)\/clarify$/);
  if (method === "POST" && clarify) {
    const id = decodeURIComponent(clarify[1]!);
    // Same parked-job routing as /answer: the held question is keyed by the job's id.
    const r = await clarifySessionQuestion((await parkedJobSessions()).get(id) ?? id);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) }); // no text ⇒ anchors the current turn's prompt_id
    return sendResult(r);
  }

  // Mark read (cleared the unread glow on open) — clears the monitor's ⚡ on both devices.
  const read = path.match(/^\/sessions\/([^/]+)\/read$/);
  if (method === "POST" && read) {
    await markSessionRead(decodeURIComponent(read[1]!));
    return json({ ok: true });
  }

  // Archive (kill the tmux pane, ending the Claude process; conversation stays resumable).
  // Also writes the inbox's Done fact — but only when the kill succeeded OR the row is
  // already pane-less per our own discovery. Never blanket-treat no-pane as success on a
  // live row: archiveSession's failure exists because a swallowed pane-resolution race
  // once marked live sessions archived while their process kept running (see
  // core/session-api.ts) — a store-archive on that race would orphan a live pane invisibly.
  const archive = path.match(/^\/sessions\/([^/]+)\/archive$/);
  if (method === "POST" && archive) {
    const id = decodeURIComponent(archive[1]!);
    const result = await archiveSession(id);
    // Discovery-never-ran is UNKNOWN, not pane-less: a null lastDiscovered would
    // otherwise classify every id as pane-less and let the store write through a
    // failed kill — exactly the race the gate exists to block.
    const paneless =
      lastDiscovered !== null && !lastDiscovered.find((s) => s.id === id)?.tmuxPane;
    let stored = false;
    const store = getInboxStore();
    if (store && (result.ok || paneless)) {
      try {
        const now = Date.now();
        seedInboxRow(store, id, now);
        stored = store.archive(id, now);
      } catch {
        // store write failed — the pane-kill result still answers the client
      }
    }
    historyCache = null; // the just-archived session should surface in History at once
    kickSessionsPush(id); // the killed pane drops from the next pushed list
    // A pane-less inbox row (parked/woken) archives successfully via the store alone.
    return result.ok || stored ? json({ ok: true }) : sendResult(result);
  }

  // Inbox verbs (ADR 0013): park / unpark / un-archive from the phone. The store is the
  // authored layer (the section brain reads it); the pane-kill mirrors the sidebar's
  // dispositions — parking kills the pane, and only the wake or re-engagement resurrects
  // it. Kills are best-effort: a pane-less row (re-snoozing a parked session) still parks.
  const snooze = path.match(/^\/sessions\/([^/]+)\/snooze$/);
  if (method === "POST" && snooze) {
    const id = decodeURIComponent(snooze[1]!);
    const body = (await req.json().catch(() => ({}))) as { preset?: unknown };
    if (typeof body.preset !== "string" || !isWakePreset(body.preset)) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    const store = getInboxStore();
    if (!store) return json({ ok: false, reason: "no-store" }, 500);
    const now = Date.now();
    const wakeAt = presetWakeAt(now, body.preset);
    if (!store.snooze(id, wakeAt, now, deviceOf(req) ?? null)) {
      return json({ ok: false, reason: "archived" }, 409);
    }
    seedInboxRow(store, id, now);
    await archiveSession(id).catch(() => {}); // kill the pane; no-pane is fine
    kickSessionsPush(id);
    // wakeAt lets the client toast the resolved moment without re-deriving it
    return json({ ok: true, wakeAt });
  }

  const block = path.match(/^\/sessions\/([^/]+)\/block$/);
  if (method === "POST" && block) {
    const id = decodeURIComponent(block[1]!);
    const body = (await req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const store = getInboxStore();
    if (!store) return json({ ok: false, reason: "no-store" }, 500);
    if (!store.block(id, note, Date.now())) return json({ ok: false, reason: "archived" }, 409);
    seedInboxRow(store, id, Date.now());
    await archiveSession(id).catch(() => {});
    kickSessionsPush(id);
    return json({ ok: true });
  }

  // Explicit unpark (unblock / unsnooze): the row returns to Needs You pane-less; no pane
  // is spawned — only re-engagement resumes (ADR 0013: undo does not resurrect the pane).
  // Reason "manual" is what discovery's preserve rule keys on to keep the pane-less row.
  const unpark = path.match(/^\/sessions\/([^/]+)\/unpark$/);
  if (method === "POST" && unpark) {
    const id = decodeURIComponent(unpark[1]!);
    const store = getInboxStore();
    if (!store) return json({ ok: false, reason: "no-store" }, 500);
    if (store.clearDisposition(id, Date.now(), "manual") === null) {
      return json({ ok: false, reason: "not-parked" }, 409);
    }
    kickSessionsPush(id);
    return json({ ok: true });
  }

  const unarchive = path.match(/^\/sessions\/([^/]+)\/unarchive$/);
  if (method === "POST" && unarchive) {
    const id = decodeURIComponent(unarchive[1]!);
    const store = getInboxStore();
    if (!store) return json({ ok: false, reason: "no-store" }, 500);
    if (!store.unarchive(id, Date.now())) return json({ ok: false, reason: "not-archived" }, 409);
    historyCache = null;
    kickSessionsPush(id);
    return json({ ok: true });
  }

  // Restore (resume an archived session in a new tmux window; blocks until its prompt is
  // live so a send right after opening lands). repoPath comes from discovery, not the client.
  const restore = path.match(/^\/sessions\/([^/]+)\/restore$/);
  if (method === "POST" && restore) {
    const id = decodeURIComponent(restore[1]!);
    // Full discovery (NOT skipArchivedSummaries — that flag also skips the fallback JSONL
    // scan, dropping index-less sessions the phone DID list → spurious not-found).
    const { sessions } = await discoverSessions({});
    const s = sessions.find((x) => x.id === id);
    // Already live (the Mac resumed it between list-render and tap) — the client just opens it.
    if (s && s.status !== "archived") return json({ ok: true, sessionId: id });
    let repoPath = s?.repoPath;
    let basePath = s?.baseRepoPath;
    if (!s) {
      // Older than discovery's 24h archived sweep — a History row. Resolve its repo
      // paths from the same engine that listed it.
      const entry = (await historyEntries()).find((e) => e.sessionId === id);
      if (!entry) return json({ ok: false, reason: "not-found" }, 404);
      repoPath = entry.projectPath;
      basePath = entry.baseRepoPath;
    }
    // Relocate to the base repo if the session's worktree was deleted, so the resume lands
    // (and doesn't fail `restoreSession`'s isDirectory guard). Mirrors the TUI resume path.
    const effectivePath = await recoverWorktreeTranscript(id, repoPath!, basePath!);
    const result = await restoreSession(id, effectivePath);
    historyCache = null; // the row's isActive/restorable just changed
    kickSessionsPush(id); // re-derive + push the now-live status
    return sendResult(result);
  }

  // Fork (mint a new session that resumes this one's history in a new tmux window; blocks
  // until the fork's prompt is live so the phone can open straight into it). The parent is
  // untouched. repoPath/name come from discovery, not the client, mirroring restore.
  const fork = path.match(/^\/sessions\/([^/]+)\/fork$/);
  if (method === "POST" && fork) {
    const id = decodeURIComponent(fork[1]!);
    const { sessions } = await discoverSessions({});
    const s = sessions.find((x) => x.id === id);
    let repoPath = s?.repoPath;
    let basePath = s?.baseRepoPath;
    if (!s) {
      const entry = (await historyEntries()).find((e) => e.sessionId === id);
      if (!entry) return json({ ok: false, reason: "not-found" }, 404);
      repoPath = entry.projectPath;
      basePath = entry.baseRepoPath;
    }
    const result = await forkSession(id, repoPath!, basePath!, s?.name);
    historyCache = null;
    // The fork is a new session — surface it on the next pushed list.
    kickSessionsPush(result.ok ? result.sessionId : undefined);
    return sendResult(result);
  }

  // Interrupt (send Escape to stop a running turn). Interrupt fires no Stop hook, so the
  // event-sourced status stays "running"; nativeStatus de-latches it to "ready" ~1.5s
  // later but emits no SSE. So on success we poll nativeStatus and broadcast once it
  // leaves "running", pushing the flip to the list + other clients. The poll runs
  // un-awaited (fire-and-forget) so the response returns immediately.
  const interrupt = path.match(/^\/sessions\/([^/]+)\/interrupt$/);
  if (method === "POST" && interrupt) {
    const id = decodeURIComponent(interrupt[1]!);
    const result = await interruptSession(id);
    if (result.ok) reconcileAfterInterrupt(id);
    return sendResult(result);
  }

  // Clear the pane's input box. Called by the phone after a confirmed interrupt-revert:
  // Claude Code parked the interrupted prompt back in the pane's input, the composer has
  // restored it phone-side, and the pane copy would otherwise flip future interrupts from
  // revert to keep and pollute the draft guard (ADR 9). Recoverable at the Mac via C-y.
  const clearInput = path.match(/^\/sessions\/([^/]+)\/clear-input$/);
  if (method === "POST" && clearInput) {
    const id = decodeURIComponent(clearInput[1]!);
    return sendResult(await clearPaneInput(id));
  }

  // Switch model or reasoning effort. Body carries EXACTLY ONE of `model`/`effort`, each
  // validated against the allowlist before anything reaches the pane. Response includes
  // Claude's verbatim confirmation `line` (states the applied value + scope).
  const config = path.match(/^\/sessions\/([^/]+)\/config$/);
  if (method === "POST" && config) {
    const id = decodeURIComponent(config[1]!);
    const body = (await req.json().catch(() => ({}))) as { model?: unknown; effort?: unknown };
    const hasModel = typeof body.model === "string";
    const hasEffort = typeof body.effort === "string";
    if (hasModel === hasEffort) return json({ ok: false, reason: "bad-args" }, 400); // need exactly one
    if (hasModel) {
      if (!isModelArg(body.model as string)) return json({ ok: false, reason: "bad-args" }, 400);
      return sendResult(await setSessionModelEffort(id, "model", body.model as string));
    }
    if (!isEffortArg(body.effort as string)) return json({ ok: false, reason: "bad-args" }, 400);
    return sendResult(await setSessionModelEffort(id, "effort", body.effort as string));
  }

  return json({ ok: false, reason: "not-found" }, 404);
}

// ---------------------------------------------------------------------------
// Bind — fail-closed to loopback / tailnet (Tailscale CGNAT 100.64.0.0/10)
// ---------------------------------------------------------------------------

function isAllowedHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // tailnet CGNAT
  return false;
}

/** Returns the server so tests can bind port 0 and stop it; `claude0 bridge` ignores it. */
export function startBridge(): ReturnType<typeof Bun.serve> {
  const host = process.env.CLAUDE0_BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.CLAUDE0_BRIDGE_PORT ?? "8473");
  rawToken = process.env.CLAUDE0_BRIDGE_TOKEN ?? "";

  if (!rawToken) {
    throw new Error("CLAUDE0_BRIDGE_TOKEN is required — refusing to start without a token (fail-closed)");
  }
  if (!isAllowedHost(host)) {
    throw new Error(
      `CLAUDE0_BRIDGE_HOST=${host} is not loopback or tailnet (100.64.0.0/10) — refusing to bind (fail-closed)`,
    );
  }
  tokenDigest = createHash("sha256").update(rawToken).digest();

  // Warm the config cache so sync paths (abbreviateRepo in fork window naming)
  // see user config before the first route-level loadConfig() refreshes it.
  void loadConfig().catch(() => {});

  if (!existsSync(EVENTS_DIR)) {
    console.error("EVENTS_DIR not found: live push disabled; restart bridge after claude0 setup");
  }
  // Hook events (the fastest change signal) drive both surfaces: the sessions
  // recompute+push and, for subscribers of the changed session, a transcript push.
  watchEvents((id) => kickSessionsPush(id));
  setInterval(() => {
    if (stream.clientCount() > 0) touchMarker(BRIDGE_CONSUMER); // keep the marker fresh while a phone is live
    for (const deviceId of stream.connectedDeviceIds()) touchDeviceConsumer(deviceId);
    // Named `ping` (not a comment): EventSource surfaces it to a listener, so the
    // client can measure stream silence and rebuild a zombie socket that still
    // claims OPEN. A `:` comment keeps the socket alive but is invisible to JS.
    stream.pushRaw("event: ping\ndata: {}\n\n");
    // Drop subscriptions (and their JSONL watchers) whose device has been gone for a
    // while — the goodbye beacon is the normal teardown; this catches a missed one.
    for (const deviceId of stream.staleSubscriptions(60_000)) {
      stream.subscribe(deviceId, null);
      void watchSubscription(deviceId, null);
    }
  }, 15_000);

  // Sync the unread/⚡ set from the monitor (which rewrites state.json ~every 3s). Only
  // push when the set of needs-attention panes actually changes, so a Mac-side
  // focus-clear or a fresh attention reaches the phone without refresh spam. Watching
  // the config dir (state.json is replaced in place; watching the file itself can lose
  // the inode) removes the old 3s bridge-side poll from the ⚡ latency chain; if the
  // watch can't be established, fall back to that poll.
  let lastUnreadKey: string | null = null;
  const checkUnread = async () => {
    try {
      const state = await loadState();
      const key = Object.entries(state.sessions)
        .filter(([, st]) => st.needsAttention)
        .map(([pane]) => pane)
        .sort()
        .join(",");
      if (lastUnreadKey === null) {
        lastUnreadKey = key; // first sight: establish baseline, don't push
        return;
      }
      if (key !== lastUnreadKey) {
        lastUnreadKey = key;
        kickSessionsPush(); // re-project + push with the new unread flags
      }
    } catch {
      // state.json missing/locked mid-write — the next change/tick retries
    }
  };
  void checkUnread(); // establish the baseline
  try {
    let unreadTimer: ReturnType<typeof setTimeout> | null = null;
    watch(PATHS.dir, (_event, filename) => {
      if (filename !== "state.json") return;
      if (unreadTimer) clearTimeout(unreadTimer);
      unreadTimer = setTimeout(() => void checkUnread(), 300);
    });
  } catch {
    setInterval(() => void checkUnread(), 3000);
  }

  // Follow the inbox store: the daemon commits a fresh snapshot every 3s, and a
  // section flip (a just-sent session turning Running, a Mac-side verb) otherwise
  // sits unpushed until an unrelated trigger — the next hook event could be a whole
  // turn away. PRAGMA data_version is a free read that bumps on another
  // connection's commit, so poll it and re-project on change. Gated on connected
  // clients (phones close their stream on background), with the baseline reset
  // while idle so a reconnect doesn't kick for changes it already received via the
  // on-connect snapshot. pushSessions dedupes, so unchanged recomputes stay off
  // the wire.
  let lastInboxVersion: number | null = null;
  setInterval(() => {
    if (stream.clientCount() === 0) {
      lastInboxVersion = null;
      return;
    }
    try {
      const store = getInboxStore();
      if (!store) return;
      const v = store.dataVersion();
      if (lastInboxVersion !== null && v !== lastInboxVersion) kickSessionsPush();
      lastInboxVersion = v;
    } catch {
      // db mid-replace or briefly locked — the next tick retries
    }
  }, 1000);

  const server = Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: 32 * 1024 * 1024, // backstop for image uploads (client downscales first)
    idleTimeout: 255, // long-lived SSE; heartbeat (15s) keeps it active well within
    async fetch(req) {
      try {
        return await gzipJson(req, await route(req));
      } catch (e) {
        const url = new URL(req.url);
        console.error(`unhandled error on ${req.method} ${url.pathname}:`, e);
        return json({ ok: false, reason: "internal-error" }, 500);
      }
    },
  });
  console.error(`claude0 bridge listening on http://${host}:${server.port}${FIXTURES ? " (fixtures mode — canned data)" : ""}`);

  // Pre-warm the /sessions projection so the phone's first request after a bridge
  // (re)start hits the served-from-cache path instead of paying the discovery sweep.
  if (!FIXTURES) void computeSessionsPayload().catch(() => {});
  return server;
}
