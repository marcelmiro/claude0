import { homedir } from "os";
import { TICKET_ID_SOURCE } from "./git";

// Config root honors the CLAUDE0_HOME test seam (matches config.ts); unset in prod → real home.
const CLAUDE0_ROOT = process.env.CLAUDE0_HOME ?? homedir();

const NAMING_LOCK = `${CLAUDE0_ROOT}/.config/claude0/naming.lock`;

/** Resolve the full path to `claude` CLI, searching common install locations beyond PATH. */
function resolveClaudePath(): string {
  const found = Bun.which("claude");
  if (found) return found;
  // tmux #() inherits a limited PATH — check common install locations
  const home = homedir();
  const candidates = [
    `${home}/.local/bin`,
    `${home}/.claude/bin`,
    "/usr/local/bin",
  ];
  for (const dir of candidates) {
    const path = Bun.which("claude", { PATH: dir });
    if (path) return path;
  }
  return "claude"; // fallback — will fail at spawn
}

const CLAUDE_PATH = resolveClaudePath();

export async function acquireNamingLock(): Promise<boolean> {
  try {
    const file = Bun.file(NAMING_LOCK);
    if (await file.exists()) {
      const { pid, ts } = JSON.parse(await file.text());
      if (Date.now() - ts < 60_000) {
        try { process.kill(pid, 0); return false; } catch {} // dead → stale
      }
    }
    await Bun.write(NAMING_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch { return false; }
}

export async function releaseNamingLock(): Promise<void> {
  try { const { unlink } = await import("fs/promises"); await unlink(NAMING_LOCK); } catch {}
}

// ---------------------------------------------------------------------------
// Naming skip/cooldown — shared by the monitor and the bridge so a failed or
// fresh generation backs off across processes. One marker file per sessionId
// (mtime = when the cooldown started), per the concurrent-writers convention —
// a shared JSON map would let one process's stale copy clobber the other's
// just-set cooldown and defeat the drift-thrash guard.
// ---------------------------------------------------------------------------

const NAMING_SKIP_DIR = `${CLAUDE0_ROOT}/.config/claude0/naming-skip`;
const NAMING_SKIP_TTL = 5 * 60_000; // renames: the drift-thrash guard
// A failed attempt on a NEVER-named session is usually "transcript not ready yet"
// (fresh /compact or /clear) — there's no name to churn, so back off briefly
// instead of leaving the session unnamed for the full rename cooldown.
const NAMING_RETRY_UNNAMED = 60_000;

/** Cooldown start age (ms) per sessionId; expired marker files are unlinked as seen. */
export async function loadNamingSkips(): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  try {
    const { readdir, stat, unlink } = await import("fs/promises");
    const now = Date.now();
    for (const id of await readdir(NAMING_SKIP_DIR)) {
      try {
        const elapsed = now - (await stat(`${NAMING_SKIP_DIR}/${id}`)).mtimeMs;
        if (elapsed > NAMING_SKIP_TTL) {
          await unlink(`${NAMING_SKIP_DIR}/${id}`);
        } else {
          live.set(id, elapsed);
        }
      } catch {}
    }
  } catch {}
  return live;
}

/** True while a session's cooldown blocks another attempt: named sessions back off
 *  the full rename TTL; never-named ones retry after NAMING_RETRY_UNNAMED. */
export function inNamingCooldown(skips: Map<string, number>, sessionId: string, cache: NameCache): boolean {
  const elapsed = skips.get(sessionId);
  if (elapsed === undefined) return false;
  return elapsed < (cache.names[sessionId] ? NAMING_SKIP_TTL : NAMING_RETRY_UNNAMED);
}

/** Start (or restart) a session's naming cooldown. */
export async function setNamingSkip(sessionId: string): Promise<void> {
  try {
    await Bun.write(`${NAMING_SKIP_DIR}/${sessionId}`, ""); // creates the dir
  } catch {}
}

/**
 * True when a session needs a fresh AI name: unnamed, or the freshest convo
 * signal (lastPrompt > summary) diverges from the source the current name was
 * generated off of. lastPrompt matters because Claude doesn't always update
 * its summary after /rewind or topic shifts.
 */
export function needsNaming(cache: NameCache, sessionId: string, currentSignal: string): boolean {
  if (!cache.names[sessionId]) return true;
  return !!currentSignal && currentSignal !== (cache.sources[sessionId] || "");
}

export interface NameCache {
  version: 6;
  names: Record<string, string>;     // sessionId → AI-generated name (human-readable, e.g. "Fix Auth")
  sources: Record<string, string>;   // sessionId → summary/prompt used for naming
}

/**
 * Deterministic abbreviation map applied ONLY by `slugify` (tmux width). Keys are
 * lowercase whole words; both long and short forms map to the compact form so an AI
 * name and a hand-typed one collapse the same way. Best-effort — words outside the
 * map pass through full, and `slugify`'s 24-char cap is the hard width backstop.
 */
export const ABBREV: Record<string, string> = {
  implement: "impl", implementation: "impl", impl: "impl",
  configuration: "cfg", config: "cfg", cfg: "cfg",
  authentication: "auth", auth: "auth",
  performance: "perf", perf: "perf",
  refactoring: "refactor", refactor: "refactor",
  database: "db", db: "db",
  // Domain nouns that actually recur in real session names and dominate tab width.
  organization: "org", organizations: "org",
  integration: "integ", integrations: "integ",
  visibility: "vis",
  notification: "notif", notifications: "notif",
  dashboard: "dash",
  migration: "migr", migrations: "migr",
  optimization: "opt", optimize: "opt",
  component: "cmp", components: "cmp",
  validation: "val", validate: "val",
  provider: "prov", providers: "prov",
  pipeline: "pipe", pipelines: "pipe",
  enrichment: "enrich",
  repository: "repo", repositories: "repo",
  permission: "perm", permissions: "perm",
  disposition: "disp", dispositions: "disp",
  verification: "verif",
  classification: "classif", classify: "classif",
  deployment: "deploy", deploy: "deploy",
  development: "dev", dev: "dev",
  environment: "env", env: "env",
  infrastructure: "infra", infra: "infra",
  documentation: "docs", docs: "docs",
  generation: "gen", gen: "gen",
};

/**
 * Conversational refusals/meta-replies the namer echoes when the source prompt is a
 * refusal or a vague follow-up ("I can't help…", "This doesn't appear…"). As a name
 * they read as broken UI, so we reject them and leave the window unnamed until a real
 * signal lands. Matched as case-insensitive prefixes of the raw model output.
 */
const HARD_REFUSAL_PREFIXES = [
  "i can't", "i cannot", "i can not", "i'm sorry", "i am sorry", "sorry",
  "i need permission", "i don't have", "i do not have", "i'm unable", "i am unable",
  "unable to", "this doesn't appear", "this does not appear", "i'd be happy",
  "i would be happy", "i need clarification", "i need more", "i'll need", "i cannot help",
  // First-person openers — a real name is a terse noun/verb phrase ("Fix Auth"),
  // never a sentence. Catches self-introductions the namer emits when the source is
  // a non-coding task ("I'm Claude Code, designed for…").
  "i'm", "i am", "i'll", "i'd", "i've", "as an", "as a", "let me", "hello", "hey",
];

// Conversational openers that often PRECEDE a real name ("Sure — Dark Mode") —
// refusal-shaped, but worth stripping and salvaging what follows.
const OPENER_PREFIXES = [
  "here's", "here is", "sure", "certainly", "of course", "well,", "actually",
];

// Substrings that only appear when the model answered conversationally, not as a name.
const NOT_A_NAME_SUBSTRINGS = [
  "claude code", "as an ai", "language model", "ai assistant", "i'm claude", "i am claude",
];

/** Prefix match on a word boundary: "sure thing" matches "sure", "Surefire" doesn't. */
function matchesPrefix(lower: string, p: string): boolean {
  if (!lower.startsWith(p)) return false;
  const next = lower[p.length];
  return next === undefined || /[\s,.:;!?'—–-]/.test(next);
}

/** True if the model output reads as a refusal/meta-reply rather than a session name. */
export function looksLikeRefusal(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (HARD_REFUSAL_PREFIXES.some((p) => matchesPrefix(lower, p))) return true;
  if (OPENER_PREFIXES.some((p) => matchesPrefix(lower, p))) return true;
  if (NOT_A_NAME_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  // A name is 1-4 words with no sentence punctuation; a comma or >4 words is a ramble.
  if (lower.includes(",") || lower.split(/\s+/).filter(Boolean).length > 4) return true;
  return false;
}

/**
 * Try to recover a usable name from refusal-shaped output instead of discarding it
 * ("Sure — Dark Mode Toggle" → "Dark Mode Toggle"): strip one conversational OPENER
 * (never a hard refusal — those contain no name), clamp to the first 4 words, drop
 * trailing sentence punctuation. Returns "" when the remainder still reads as a
 * refusal — a rejected name costs "unnamed for 5 minutes", so salvage tries first.
 */
export function salvageName(text: string): string {
  let t = text.trim();
  const lower = t.toLowerCase();
  if (HARD_REFUSAL_PREFIXES.some((p) => matchesPrefix(lower, p))) return "";
  const opener = OPENER_PREFIXES.find((p) => matchesPrefix(lower, p));
  if (opener) t = t.slice(opener.length).replace(/^[\s,.:;!—–-]+/, "");
  t = t.split(/\s+/).filter(Boolean).slice(0, 4).join(" ").replace(/[.,;:!?]+$/, "");
  return t && !looksLikeRefusal(t) ? t : "";
}

/**
 * Normalize a name to the human-readable shape stored in the cache and shown on the
 * phone/TUI verbatim: trim, collapse internal whitespace to single spaces, strip
 * control chars and the window separators (`/`/`⚡`/`🔄`/`+`) that would corrupt the
 * tmux format even after slugify, but KEEP spaces and casing. Capped at 30 chars.
 */
export function normalizeName(input: string): string {
  const cleaned = input
    // Control chars, window separators (`/·⚡🔄+` — `·` is the retired separator,
    // still stripped), and word-joining punctuation (`\ : _ — –`) → space, so
    // slugify splits on them instead of gluing words
    // ("clarification—the" → "clarification the", not "clarificationthe"). Hyphen
    // is intentionally kept (kebab-friendly).
    .replace(/[\x00-\x1f·⚡🔄+/\\:_—–]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 30) return cleaned;
  // Trim at a word boundary so the stored name never ends mid-word ("…to be a so").
  const cut = cleaned.slice(0, 30);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= 15 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Slugify a human-readable name to the kebab slug shown on tmux windows: lowercase,
 * abbreviate each word via `ABBREV`, join with `-`, strip remaining non-`[a-z0-9-]`,
 * collapse/trim dashes, and truncate to 24 chars (no trailing dash). Applied at every
 * window-name write; `reverseNameMap` keys on this so the round-trip resolves.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => ABBREV[w] ?? w)
    .join("-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}

const CACHE_PATH = `${CLAUDE0_ROOT}/.config/claude0/names.json`;

/**
 * Extract a meaningful title from structured prompts like:
 * "Implement the following plan: # Plan: Claude0 UI Improvements ## Context..."
 * → "Claude0 UI Improvements"
 */
export function extractPlanTitle(prompt: string): string {
  if (!prompt) return "";

  // Find first # heading (not ## or deeper)
  const match = prompt.match(/(?:^|\n)# +(.+)/);
  if (!match) return "";

  let title = match[1].trim();

  // Skip meta headings
  const metaHeadings = ["phase executor prompt", "implementation plan generator"];
  if (metaHeadings.some((m) => title.toLowerCase().includes(m))) return "";

  // Strip category prefixes: "Plan: Title" → "Title"
  title = title.replace(/^(?:Plan|Fix|Feature|Refactor):\s*/i, "");

  // Strip trailing noise: "(4 Changes)", trailing "Plan"
  title = title.replace(/\s*\(\d+\s+\w+\)\s*$/, "");
  title = title.replace(/\s+Plan\s*$/i, "");

  return title.trim();
}

/** Conversation signals fed to the namer. Assistant replies are optional but matter:
 *  for meta-prompts ("grill me on this plan") the assistant's reply is the only place
 *  the actual subject of the work appears. */
export interface NamingContext {
  firstPrompt: string;
  summary?: string;
  branch?: string;
  lastPrompt?: string;
  firstAssistant?: string;
  lastAssistant?: string;
  /** User messages sampled from the middle of the transcript — often the only
   *  place the actual subject appears when first/last are meta ("begin the task"). */
  middlePrompts?: string[];
  /** Bounds the subprocess — keep it low (15s default) for the background monitor so a
   *  hung `claude -p` can't stall its poll loop; the interactive TUI rename passes a
   *  longer budget so a cold haiku start resolves in one attempt. */
  timeoutMs?: number;
}

/** Assemble the `claude -p` naming prompt from the conversation signals. */
export function buildNamingPrompt(ctx: NamingContext): string {
  const { firstPrompt, summary, branch, lastPrompt, firstAssistant, lastAssistant } = ctx;
  const contextParts: string[] = [];
  // Always anchor on firstPrompt — it's the most reliable signal of intent.
  // Dropping it when summary/lastPrompt exist caused hallucinated names from
  // vague follow-ups like "IDK, go check that".
  const planTitle = extractPlanTitle(firstPrompt || "");
  if (planTitle) contextParts.push(`Plan title: "${planTitle}"`);
  if (firstPrompt) contextParts.push(`First user message: "${firstPrompt.slice(0, 300)}"`);
  if (firstAssistant) contextParts.push(`First assistant reply: "${firstAssistant.slice(0, 300)}"`);
  const usefulSummary = summary && summary !== firstPrompt ? summary : "";
  if (usefulSummary) contextParts.push(`Summary: "${usefulSummary}"`);
  for (const m of ctx.middlePrompts ?? []) {
    contextParts.push(`Mid-session user message: "${m}"`);
  }
  if (lastPrompt && lastPrompt !== firstPrompt) {
    contextParts.push(`Most recent user message: "${lastPrompt.slice(0, 300)}"`);
  }
  if (lastAssistant && lastAssistant !== firstAssistant) {
    contextParts.push(`Most recent assistant reply: "${lastAssistant.slice(0, 300)}"`);
  }
  if (branch) {
    // Strip ticket prefix (e.g. "ENG-2687-") for naming context
    const branchContext = branch.replace(new RegExp(`^${TICKET_ID_SOURCE}-?`, "i"), "");
    if (branchContext) contextParts.push(`Branch: "${branchContext}"`);
  }

  return `Name this session in Title Case, plain English words. It may be any kind of task (coding or not) — always produce a name from the content; never introduce yourself or explain. Prefer 2-3 words; up to 4 when the subject needs them (it labels a narrow tmux tab). Drop filler words (the, a, for, with, to).

Name the session's OVERALL subject — the specific feature, system, or deliverable being worked on. The most recent messages show the current step; use them to identify the subject, never as the name itself. Never name the interaction style alone: for "review/plan/grill/debug X", name X. Never use a ticket ID (TF-123, ENG-45) as the name — name what the ticket is about. Avoid words generic enough to fit any session (Analytics, Cleanup, Config, Optimization, Task) unless paired with the specific subject. Ignore meta text about continuing or compacting a previous conversation. Focus on the GOAL, not file paths or locations. Do NOT use kebab-case, do NOT abbreviate.

Good: Fix Auth, Dark Mode Toggle, Provider Sync, iCloud Photos, Employment Verification
Bad: fix-auth, TF-245 Cleanup, Analytics, Grill Plan, Plan Review, "I'm Claude Code..."

Reply with ONLY the name, nothing else.

${contextParts.join("\n")}`;
}

/**
 * AI-powered name generation using `claude -p`. Returns a normalized Title-Case name
 * or empty string on failure/refusal.
 */
export async function generateAIName(ctx: NamingContext): Promise<string> {
  const { firstPrompt, summary, lastPrompt, timeoutMs = 15_000 } = ctx;
  if (!firstPrompt && !summary && !lastPrompt) return "";

  try {
    const namePrompt = buildNamingPrompt(ctx);
    const proc = Bun.spawn([CLAUDE_PATH, "-p", "--model", "haiku", "--no-session-persistence"], {
      stdin: new Response(namePrompt),
      stdout: "pipe",
      stderr: "ignore",
      // Neutral cwd: `claude -p` loads workspace context from its working directory,
      // and inheriting the caller's cwd biased names toward the CALLER'S repo — four
      // unrelated sessions once named after the directory the generator ran from.
      cwd: homedir(),
      // CLAUDECODE=1 ensures cc_entrypoint=cli billing (Max subscription).
      env: { ...process.env, TMUX: "", TMUX_PANE: "", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    // Kill the subprocess after `timeoutMs` so a hung `claude -p` can't stall the
    // caller (the monitor's tmux #() runs one instance — a hang blocks all polls).
    const killTimer = setTimeout(() => proc.kill(), timeoutMs);
    const result = await new Response(proc.stdout).text();
    clearTimeout(killTimer);
    await proc.exited;
    if (proc.exitCode !== 0) return "";
    // Reject error/rate-limit messages that survive sanitization
    const lower = result.trim().toLowerCase();
    if (lower.includes("error") || lower.includes("credit") || lower.includes("balance") || lower.includes("rate limit") || lower.includes("unauthorized") || lower.includes("overloaded")) return "";
    // Refusal-shaped output: try to salvage a name from it before giving up —
    // rejection leaves the session unnamed for the whole skip cooldown.
    const usable = looksLikeRefusal(result) ? salvageName(result) : result.trim();
    if (!usable) return "";
    const name = normalizeName(usable);
    return name.length > 0 ? name : "";
  } catch {
    return "";
  }
}

export async function loadNameCache(): Promise<NameCache> {
  try {
    const raw = await Bun.file(CACHE_PATH).text();
    const parsed = JSON.parse(raw);
    if (parsed.version === 6 && parsed.names) return parsed;
    // Any other version: start fresh (names regenerate on the next monitor/bridge cycle).
  } catch {
    // No cache or malformed
  }
  return { version: 6, names: {}, sources: {} };
}

export async function saveNameCache(cache: NameCache): Promise<void> {
  try {
    const dir = CACHE_PATH.replace(/\/[^/]+$/, "");
    await Bun.$`mkdir -p ${dir}`.quiet();
    // Atomic temp+rename: monitor, bridge, and TUI all write this file concurrently.
    const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
    await Bun.write(tmp, JSON.stringify(cache, null, 2));
    const { rename } = await import("fs/promises");
    await rename(tmp, CACHE_PATH);
  } catch {
    // Non-fatal
  }
}

/**
 * Drop cache entries whose session no longer exists on disk (transcripts age out on
 * Claude's retention). Returns true when anything was removed. Callers gate on cache
 * size so the transcript scan doesn't run on every tick.
 */
export function pruneNameCache(cache: NameCache, liveSessionIds: Set<string>): boolean {
  let pruned = false;
  for (const id of Object.keys(cache.names)) {
    if (liveSessionIds.has(id)) continue;
    delete cache.names[id];
    delete cache.sources[id];
    pruned = true;
  }
  return pruned;
}

/**
 * Prune once the cache is large — drop entries whose transcript no longer exists
 * (transcripts age out on Claude's retention). Gated on size so the projects scan
 * doesn't run on every naming write; callers invoke this right before saving.
 */
export async function pruneNameCacheIfLarge(cache: NameCache, projectsDir: string): Promise<void> {
  if (Object.keys(cache.names).length <= 500) return;
  try {
    const liveIds = new Set<string>();
    for await (const p of new Bun.Glob("*/*.jsonl").scan({ cwd: projectsDir })) {
      liveIds.add(p.slice(p.lastIndexOf("/") + 1, -".jsonl".length));
    }
    pruneNameCache(cache, liveIds);
  } catch {}
}

/**
 * Get the AI-generated session name from the cache.
 * Returns empty string if unset (window stays "{repo}" until naming completes).
 */
export function getSessionName(sessionId: string, cache: NameCache): string {
  return cache.names[sessionId] || "";
}

