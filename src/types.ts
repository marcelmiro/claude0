export interface TmuxPane {
  paneId: string;
  windowIndex: number;
  sessionName: string;
  windowName: string;
}

export interface Session {
  id: string;
  repo: string;
  repoPath: string;
  baseRepoPath: string;
  branch: string;
  status: "running" | "waiting" | "ready" | "idle" | "archived";
  messageCount: number;
  summary: string;
  modified: Date;
  /**
   * Timestamp of the last user/assistant turn in the transcript — what both the TUI and
   * the phone display as the session's age. Absent when no transcript record carries a
   * timestamp; callers fall back to `modified` (the file mtime), which bookkeeping
   * writes and bulk resumes advance without any conversation happening.
   */
  lastTurnAt?: Date;
  firstPrompt: string;
  /** Most recent user prompt from JSONL `last-prompt` entries — reflects current convo direction after /rewind */
  lastPrompt: string;
  name: string;
  tmuxPane?: TmuxPane;
  /** Cached pane capture from status detection — reused by preview to avoid a duplicate tmux call */
  lastCapture?: string;
  /** Where `status` came from: Claude's native status file › event-sourced hook log › viewport scraper. */
  statusSource?: "event" | "scraper" | "native";
  /** Ready but still waiting on a live run_in_background script (⏳). Visibility only. */
  scriptWaiting?: boolean;
}

/**
 * Whether — and where — an archived session can be resumed from the phone.
 * "yes" = original dir intact; "relocated" = worktree gone, resumes in the base repo;
 * "no" = base repo or transcript gone (readable, not restorable). Never treat as a
 * boolean: "no" is truthy.
 */
export type RestoreState = "yes" | "relocated" | "no";

export interface RepoGroup {
  name: string;
  path: string;
  sessions: Session[];
}

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

export interface PaneInfo {
  tty: string;
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  currentPath: string;
}

export interface ClaudeProcess {
  pid: number;
  tty: string;
  command: string;
  sessionId?: string;
  /** Launched with `--fork-session`. Its `sessionId` (when set) is the fork's REAL
   *  id read from Claude's per-pid native file, NOT the parent the hook records. */
  isFork: boolean;
}

export type DisplayRow =
  | { type: "repo-header"; name: string; path: string }
  | { type: "separator" }
  | { type: "session"; session: Session }
  | { type: "session-detail"; session: Session }
  | { type: "archive-collapsed"; repoName: string; count: number; sessions: Session[] };

// --- Notification system types ---

export interface NotificationConfig {
  /** Enable tmux status bar monitor (Tier 1) */
  statusMonitor: boolean;
  /** Enable window name ⚡ prefix (Tier 2) */
  windowPrefix: boolean;
  /** Enable macOS native notifications (Tier 3) */
  nativeNotification: boolean;
  /** Notification-click `-activate` bundle id; absent ⇒ Ghostty default, "" ⇒ no -activate */
  terminalBundleId?: string;
}

export interface SessionNotificationState {
  status: string;
  needsAttention: boolean;
  /** Classification of the transition that caused attention */
  attentionType?: "blocked" | "turnComplete";
  tmuxSession?: string;
  tmuxWindow?: number;
  tmuxPane?: string;
  windowName?: string;
  lastTransition?: number;
}

export interface State {
  lastUpdatedBy: "tui" | "monitor" | "bridge";
  lastUpdatedAt: number;
  sessions: Record<string, SessionNotificationState>;
}

export interface AggregateStatus {
  needsAttention: number;
  running: number;
  waiting: number;
  ready: number;
}

export interface TransitionEvent {
  sessionKey: string;
  previousStatus: string;
  currentStatus: string;
  classification: "blocked" | "turnComplete" | "none";
  session: Session;
}

// --- Web Push (Tier 4) types ---

/** Where the most recent input on a session came from — the push-routing decision. */
export type InputSource = { source: "tui" } | { source: "portkey"; deviceId?: string };

/** A device's push subscription as persisted in push-subscriptions.json. */
export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What the service worker renders — non-sensitive label + state only. */
export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
}

/** Test seam for RFC 8291 encryption: the §5 vector fixes salt + sender keypair. */
export interface EncryptSeams {
  salt?: Uint8Array; // 16 bytes
  senderKeys?: CryptoKeyPair; // ECDH P-256 — the "ephemeral" application-server pair
}

// --- New Session Wizard types ---

export interface WizardRepo {
  name: string;           // base repo name (last path component; worktrees inherit their base's name)
  path: string;           // absolute repo/worktree path
  currentBranch: string;  // checked-out branch
  isWorktree?: boolean;   // true = a linked worktree row nested under its base repo
  isLastWorktree?: boolean; // true = last worktree child of its base (tree connector)
  hasSession?: boolean;   // true = base repo has an active/recent session (sorts to top)
  worktreeCount?: number; // linked worktrees under this base (from git worktree list); drives the collapsed-row badge
}

export interface WizardBranch {
  name: string;        // local name (remotes/origin/ stripped)
  isRemote: boolean;   // remote-only branch
  isCurrent: boolean;  // repo's current branch
  fullRef: string;     // original ref
}

export type WizardStep = "repo" | "branch" | "worktree-choice" | "worktree";

/** How a launched session sets up its working tree. */
export type WorktreeMode = "new-branch" | "reuse" | "checkout" | "current";

export interface WizardState {
  step: WizardStep;
  repos: WizardRepo[];          // all rows (bases + nested worktrees) in discovery order
  filteredRepos: WizardRepo[];  // currently-visible rows the cursor indexes into: bases-only when repoFilter is empty, scored flat matches otherwise
  repoIndex: number;            // index into filteredRepos
  repoFilter: string;           // repo-step type-to-filter query
  repoFilterCursor: number;
  expandedRepos: string[];      // base repo paths whose worktrees are expanded inline (empty-filter browse view)
  selectedRepo: WizardRepo | null;
  branches: WizardBranch[];
  filteredBranches: WizardBranch[];
  branchIndex: number;
  branchFilter: string;
  branchFilterCursor: number;
  branchFilterActive: boolean;
  selectedBranch: WizardBranch | null;
  defaultBranch: string;       // repo trunk (from origin/HEAD); drives the worktree-choice default cursor
  worktreeChoiceIndex: number; // 0 = new worktree + new branch, 1 = new worktree (reuse branch), 2 = checkout
  worktreeMode: "new-branch" | "reuse"; // what the worktree step's text field edits: a new branch name, or a dir name
  worktreeName: string;        // text input: new branch name (new-branch) or dir name (reuse)
  worktreeNameCursor: number;
  enterDebounceUntil: number;  // timestamp (ms) — ignore Enter until this time (prevents double-fire on step transition)
  fetchState: "idle" | "fetching" | "done"; // background `git fetch` status for the branch step
}

export type WizardAction =
  | { type: "noop" }
  | { type: "render" }
  | { type: "preview" }
  | { type: "cancel" }
  | { type: "loadBranches" }
  | { type: "fetch" }
  | { type: "launch"; repo: WizardRepo; branch: WizardBranch; mode: WorktreeMode; text: string; shellOnly: boolean };

// --- Global search types ---

export interface GlobalSearchState {
  query: string;
  cursor: number;
  entries: SearchEntryRef[];  // all loaded entries (cached for search session)
  results: SearchEntryRef[];  // filtered/ranked subset (max 50)
  total: number;              // full match count before the 50-row cap
  selectedIndex: number;
  loading: boolean;
}

// Forward ref — actual type lives in core/search.ts to avoid circular deps
export type SearchEntryRef = import("./core/search").SearchEntry;

/** The four configurable tmux bindings, resolved (defaults filled) by `tmuxKeys()`. */
export interface TmuxKeys {
  popup: string;
  next: string;
  sidebarFocus: string;
  sidebarToggle: string;
}

/**
 * What a machine does in a claude0 deployment: "local" holds both roles on one
 * machine (the default), "host" owns tmux/sessions/daemon/bridge/inbox, "client"
 * is the human-facing terminal attaching to a remote host.
 */
export type DeploymentRole = "local" | "host" | "client";

export interface Config {
  $schema?: string;
  schemaVersion: 1;
  /** Absent ⇒ role inferred at point of use (resolveRole); set explicitly to pin it */
  deployment?: {
    role: DeploymentRole;
  };
  repositories: {
    roots: string[];          // dirs to scan 1-level deep for canonical git repos
    priority: string[];       // repo names pinned at top of lists
  };
  terminal: {
    defaultTarget: "local" | "remote";
    remoteHost: string | null;
    localSession: string;
    remoteSession: string;
    /** Chord that pastes the Mac clipboard image into the remote Claude pane (client role); absent ⇒ "cmd+shift+v" */
    imagePasteKey?: string;
  };
  ui: {
    statusMonitor: boolean;
    windowPrefix: boolean;
    /** Repo-name → short display name on tmux windows/sidebar (e.g. {"claude0":"c0"}) */
    repoAbbreviations?: Record<string, string>;
  };
  notifications: {
    native: boolean;
    /** Bundle id the notification click raises; absent ⇒ Ghostty default, "" ⇒ no -activate */
    terminalBundleId?: string;
    /** VAPID contact sent to push services; absent ⇒ derived from `git config user.email` */
    pushContact?: string;
  };
  tmux?: {
    /** tmux key bindings in tmux notation: "prefix X" ⇒ bind-key X, bare "M-x" ⇒ bind-key -n M-x */
    keys?: Partial<TmuxKeys>;
  };
}

// --- Hook event log + transcript types (Impl #2 — Camp 1) ---

/**
 * Raw Claude Code hook payload, verbatim (snake_case). One JSON object per line
 * in `events/<session_id>.jsonl`. `event-status.test.ts` casts the committed
 * fixtures (`hooks/*.json`) `as HookEvent` and feeds them straight to
 * `deriveStatus`, so this IS the on-disk shape — no normalization layer.
 * Re-exported from `core/event-status.ts` to satisfy the test import path.
 * Unknown keys are tolerated (forward-compat across claude versions).
 */
export interface HookEvent {
  session_id: string;
  hook_event_name:
    | "SessionStart"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "Notification"
    | "Stop"
    | "SubagentStop";
  transcript_path: string; // absolute path to the JSONL transcript (free on every event)
  cwd: string;
  permission_mode?: string;
  effort?: { level: string };
  tool_name?: string; // PreToolUse / PostToolUse
  tool_input?: unknown; // PreToolUse (AskUserQuestion → { questions: [...] })
  tool_use_id?: string;
  notification_type?: "permission_prompt" | "idle_prompt";
  message?: string; // Notification
  prompt?: string; // UserPromptSubmit — the submitted prompt text
  prompt_id?: string; // UserPromptSubmit — unique per-turn identity
}

/**
 * A single block inside a transcript turn's `message.content[]`. Re-exported from
 * `core/transcript.ts` (the test imports it from "./transcript").
 */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  // Byte-free marker only: the source's base64 image data is dropped at parse time so it
  // never bloats the transcript payload — the UI just shows a "🖼 image" chip.
  | { type: "image" };

/**
 * One conversational turn. Field is `content` (NOT `blocks`) — the contract test
 * requires `t.content`. A string-valued `message.content` becomes one text block.
 */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: TranscriptBlock[];
  // Set on the post-compaction summary record (`isCompactSummary` in the JSONL). Claude
  // Code writes the summary as a `user` turn whose content is the whole summary; this flag
  // lets the UI render it as a "continued from compacted summary" divider instead of a giant
  // user bubble, making it clear the branch originated from a compact.
  compactSummary?: boolean;
  // Set on a message consumed from Claude Code's input queue MID-turn (a `queued_command`
  // attachment record — it never becomes a `user` record). It ran like any prompt, but
  // Claude's /rewind picker does not list it as a checkpoint, so rewind-count walks must
  // skip queued turns or every earlier prompt's upCount shifts by one.
  queued?: boolean;
  // Set on an executed slash command (`<command-name>` runner record): the typed command
  // ("/pr-triage args"), shown as a normal user message — the terminal echoes commands as
  // your prompt line. `content` is empty, so it is never a rewind checkpoint.
  command?: string;
  // Set on a `!` bash passthrough (`<bash-input>` record), with the adjacent output
  // record's stdout/stderr folded in by the parser. `content` is empty. Unlike slash
  // command turns, bash turns ARE rewind checkpoints — Claude's own /rewind picker
  // lists them (verified live), so prompt-counting walks must include them.
  bash?: { command: string; stdout: string; stderr: string };
  // Set on a Claude-teams mailbox delivery: the harness injects a teammate session's
  // message into this transcript as a `user` record ("Another Claude session sent a
  // message:" + one or more `<teammate-message>` blocks). Not typed by the user — the
  // UI renders teammate rows, not a user bubble. One entry per block; `summary` is the
  // tag's summary attribute, else the payload JSON's `summary` field, else "" (a bare
  // idle ping); `color` is the harness-assigned teammate color name, verbatim.
  // `content` is empty. These ARE real user-role API messages that start turns, so
  // rewind-count walks treat them like typed prompts.
  teammate?: Array<{ id: string; color?: string; summary: string; body: string }>;
}

/**
 * The on-disk `pending/<sessionId>.json` marker, as written by a blocking PreToolUse hook
 * (`pretooluse.sh` for an approval, `claude0 question-hook` for a held AskUserQuestion) and
 * parsed by every reader that has to decide which answer channel to use.
 *
 * `pid` is the holding hook's own process id — readers probe it to tell a live hold from
 * one orphaned by a killed hook. It is optional because a marker written by a hook
 * installed before the pid stamp carries no liveness info and must stay trusted.
 */
export interface PendingHold {
  sessionId?: string;
  ts?: number;
  pid?: number;
  kind?: "approval" | "question";
  tool?: string;
  tool_use_id?: string;
  input?: unknown;
}

/** A tool awaiting approval, surfaced from the blocking PreToolUse hook (Inc6). */
export interface PendingApproval {
  sessionId: string;
  ts: number;
  tool: string;
  tool_use_id: string;
  input: unknown;
  /** Absent ⇒ approval (back-compat with in-flight files). "question" records are a
   * held AskUserQuestion intercept and are filtered out of the approvals list. */
  kind?: "approval" | "question";
}
