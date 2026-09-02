/**
 * Deterministic fixture data for the bridge UI — enabled by CLAUDE0_BRIDGE_FIXTURES.
 *
 * When set, server.ts serves these canned payloads instead of querying `core/`, so the
 * web app renders stable, representative content (every status, a markdown turn, a tool
 * chip, an open question) without any live tmux sessions. Used by `scripts/shoot.ts` to
 * screenshot the UI and by anyone testing layout/CSS headlessly. Auth + static serving
 * stay real; ONLY the data is faked.
 */

// Relative timestamps so the list shows natural ages (2m, 40s, 3h…) whenever it runs.
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const agoMs = (ms: number) => Date.now() - ms;

// Projected session shape — mirrors projectSession() in server.ts, plus the `inbox`
// meta computeSessionsPayload attaches (rows arrive pre-ordered by section: needs-you →
// running → parked → done, untagged rows last). Covers every status tier and every
// inbox section, incl. a woken snooze and a blocked-with-note row.
export const FIXTURE_SESSIONS = [
  {
    id: "fix-auth",
    repo: "claude0",
    branch: "eng-2687-cookie-auth",
    status: "waiting",
    name: "Cookie Auth",
    label: "ENG-2687 · Cookie Auth",
    pending: "question",
    unread: true,
    messageCount: 14,
    summary: "Switch the bridge token to an HttpOnly cookie",
    statusSource: "fixture",
    modified: ago(2 * 60_000),
    inbox: { section: "needs-you", since: agoMs(2 * 60_000) },
  },
  {
    id: "push-retry",
    repo: "claude0",
    branch: "push-retry-backoff",
    status: "ready",
    name: "Push Retry",
    label: "Push Retry",
    pending: null,
    unread: true,
    messageCount: 6,
    summary: "Retry Web Push sends with backoff",
    statusSource: "fixture",
    modified: ago(9 * 60_000),
    // A snooze that came due: files under needs-you with the ☾ woken mark.
    inbox: { section: "needs-you", since: agoMs(9 * 60_000), woken: true },
  },
  {
    id: "api-refactor",
    repo: "claude0",
    branch: "refactor-session-api",
    status: "running",
    name: "Session API",
    label: "Session API",
    pending: null,
    unread: false,
    messageCount: 9,
    summary: "Extract session-api helpers from sessions.ts",
    statusSource: "fixture",
    modified: ago(40_000),
    inbox: { section: "running", since: agoMs(40_000) },
  },
  {
    id: "docs-pass",
    repo: "claude0",
    branch: "main",
    status: "ready",
    name: "Docs Pass",
    label: "Docs Pass",
    pending: null,
    unread: false,
    messageCount: 4,
    summary: "Tighten the README wording",
    statusSource: "fixture",
    modified: ago(11 * 60_000),
    // Reads ready but waits on a background script → inline ⏳ after the name,
    // counted into the header's 🔄 chip; the inbox files script-waits under running.
    pendingScripts: 1,
    inbox: { section: "running", since: agoMs(11 * 60_000) },
  },
  {
    id: "stripe-keys",
    repo: "throxy",
    branch: "billing-stripe",
    status: "archived",
    name: "Stripe Billing",
    label: "Stripe Billing",
    pending: null,
    unread: false,
    messageCount: 22,
    summary: "Stripe billing integration",
    statusSource: "fixture",
    modified: ago(4 * 3_600_000),
    restorable: "yes",
    inbox: { section: "parked", since: agoMs(4 * 3_600_000), wakeAt: agoMs(-4 * 3_600_000) },
  },
  {
    id: "blocked-deploy",
    repo: "throxy",
    branch: "deploy-pipeline",
    status: "archived",
    name: "Deploy Pipeline",
    label: "Deploy Pipeline",
    pending: null,
    unread: false,
    messageCount: 17,
    summary: "Deploy pipeline hardening",
    statusSource: "fixture",
    modified: ago(26 * 3_600_000),
    restorable: "yes",
    inbox: { section: "parked", since: agoMs(26 * 3_600_000), note: "waiting on infra access" },
  },
  {
    id: "done-usage",
    repo: "claude0",
    branch: "usage-readout",
    status: "archived",
    name: "Usage Readout",
    label: "Usage Readout",
    pending: null,
    unread: false,
    messageCount: 11,
    summary: "Token-usage readout thresholds",
    statusSource: "fixture",
    modified: ago(2 * 3_600_000),
    restorable: "yes",
    inbox: { section: "done", since: agoMs(2 * 3_600_000) },
  },
  {
    id: "ingest",
    repo: "throxy",
    branch: "main",
    status: "idle",
    name: "Ingest",
    label: "Ingest",
    pending: null,
    unread: false,
    messageCount: 2,
    summary: "Batch ingest pipeline",
    statusSource: "fixture",
    modified: ago(3 * 3_600_000),
  },
  {
    id: "old-thing",
    repo: "throxy",
    branch: "spike-old",
    status: "archived",
    name: "Spike",
    label: "Spike",
    pending: null,
    unread: false,
    messageCount: 1,
    summary: "Old spike, parked",
    statusSource: "fixture",
    modified: ago(5 * 86_400_000),
  },
];

// Transcript shape — mirrors getTranscript() plus the approval/statusline spread the
// /transcript route adds. One of every thread block: compact divider, user + markdown
// assistant bubbles, every chip variant (edit / command / Agent / WebFetch, one of them
// failed), a tool-only burst older than lastPromptAt (collapsed tally), slash command,
// `!` bash turn, ⊘ interrupt line, teammate report + idle ping, image marker, a queued
// turn, and an open AskUserQuestion (question card + tags). Timestamps step back from
// now so the 5-minute time-gap labels render.
const m = 60_000;
export const FIXTURE_TRANSCRIPT = {
  turns: [
    // Filler history padding the thread past the `?tail=` cutoff (40), so the design
    // loop exercises the partial first paint (loader row, then the full fill-in). The
    // crafted showcase turns below stay inside the tail slice.
    ...Array.from({ length: 30 }, (_, i) => [
      { role: "user", content: [{ type: "text", text: `earlier question #${i + 1} about the auth flow` }] },
      {
        role: "assistant",
        content: [{ type: "text", text: `Earlier answer #${i + 1} — superseded by the work below.` }],
      },
    ]).flat(),
    {
      role: "user",
      at: ago(95 * m),
      compactSummary: true,
      content: [
        {
          type: "text",
          text: "## Summary\n\nThe session moved bridge auth from a bearer header to a cookie. Remaining: gate the SSE route, update the README.",
        },
      ],
    },
    {
      role: "user",
      at: ago(94 * m),
      content: [{ type: "text", text: "Can you switch the bridge token to an HttpOnly cookie?" }],
    },
    {
      role: "assistant",
      at: ago(93 * m),
      content: [
        {
          type: "text",
          text: [
            "Here's the plan:",
            "",
            "1. Exchange the token **once** via `POST /auth`",
            "2. Set an `HttpOnly` cookie so JS never touches it",
            "3. Gate every other route on the cookie",
            "",
            "```ts",
            'res.headers.set("set-cookie", `claude0=${tok}; HttpOnly; SameSite=Strict`);',
            "```",
            "",
            "Wiring it up now.",
          ].join("\n"),
        },
        {
          type: "tool_use",
          id: "t1",
          name: "Edit",
          input: { file_path: "/Users/throxy/dev/claude0/.claude/worktrees/eng-2687/src/bridge/server.ts" },
          result: { ok: true, head: "The file src/bridge/server.ts has been updated.", lines: 1 },
        },
      ],
    },
    // A burst of tool-only records (≥3 in a row) older than lastPromptAt → one collapsed
    // tally line; tapping expands the chips, one of which failed.
    {
      role: "assistant",
      at: ago(92 * m),
      content: [
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: { command: "bun test src/bridge 2>&1 | tail -4", description: "Run the bridge tests" },
          result: { ok: true, head: "12 pass", lines: 4 },
        },
      ],
    },
    {
      role: "assistant",
      at: ago(91 * m),
      content: [
        {
          type: "tool_use",
          id: "t3",
          name: "Grep",
          input: { pattern: "cookieToken" },
          result: { ok: true, head: "src/bridge/server.ts:212:function cookieToken(req: Request)", lines: 3 },
        },
      ],
    },
    {
      role: "assistant",
      at: ago(90 * m),
      content: [
        {
          type: "tool_use",
          id: "t4",
          name: "Bash",
          input: { command: "bun run typecheck", description: "Type-check the bridge" },
          result: { ok: false, head: "src/bridge/server.ts(214,9): error TS2339: Property 'cookie' does not exist", lines: 2 },
        },
      ],
    },
    {
      role: "assistant",
      at: ago(89 * m),
      content: [
        {
          type: "tool_use",
          id: "t5",
          name: "Edit",
          input: { file_path: "/Users/throxy/dev/claude0/.claude/worktrees/eng-2687/src/bridge/server.ts" },
          result: { ok: true, head: "The file src/bridge/server.ts has been updated.", lines: 1 },
        },
      ],
    },
    {
      role: "assistant",
      at: ago(88 * m),
      content: [
        {
          type: "tool_use",
          id: "t6",
          name: "Agent",
          // Same description as subagent afix1 below → the chip taps into that agent.
          input: { description: "Trace the cookie exchange path", subagent_type: "Explore" },
        },
        {
          type: "tool_use",
          id: "t7",
          name: "WebFetch",
          input: { url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie" },
          result: { ok: true, head: "Set-Cookie: <cookie-name>=<cookie-value>; HttpOnly; SameSite=Strict", lines: 40 },
        },
      ],
    },
    // 27 minutes of silence → a time-gap label before this prompt.
    { role: "user", at: ago(60 * m), content: [{ type: "text", text: "looks good — ship it" }] },
    // Executed slash commands, with and without args: both a normal user bubble with
    // the /name as inline mono text.
    { role: "user", at: ago(59 * m), content: [], command: "/pr-triage" },
    {
      role: "user",
      at: ago(59 * m),
      content: [],
      command: "/loop keep polishing the session thread until every block type reads well on a phone",
    },
    {
      role: "assistant",
      at: ago(58 * m),
      content: [{ type: "text", text: "Shipping — wiring the cookie into the auth route now." }],
    },
    // A `!` bash passthrough (input + output records folded into one turn by the parser) →
    // peach command bubble + rail output; long stdout exercises the "+N lines" expander,
    // stderr renders as a red rail block after it. A rewind checkpoint (the assistant
    // reply below follows it), unlike the slash-command turn above.
    {
      role: "user",
      at: ago(45 * m),
      content: [],
      bash: {
        command: "git status -sb && bun test 2>&1 | tail -8",
        stdout: [
          "## eng-2687-cookie-auth...origin/eng-2687-cookie-auth",
          " M src/bridge/server.ts",
          " M src/bridge/public/app.js",
          "?? src/core/cookie-auth.ts",
          "",
          "bun test v1.3.14",
          " 12 pass",
          " 0 fail",
          " 31 expect() calls",
          "Ran 12 tests across 3 files. [412ms]",
        ].join("\n"),
        stderr: "warn: cookie secret unset — using dev fallback",
      },
    },
    {
      role: "assistant",
      at: ago(44 * m),
      content: [{ type: "text", text: "Clean tree and green tests — the deploy can go out." }],
    },
    // An answered AskUserQuestion → the qa pairs render as a question line + answer
    // bubble exchange (never an opaque chip, never swallowed into a burst).
    {
      role: "assistant",
      at: ago(42 * m),
      content: [
        {
          type: "tool_use",
          id: "t-ask1",
          name: "AskUserQuestion",
          input: { description: "Which storage should the session token use?" },
          result: { ok: true, head: "Your questions have been answered: …", lines: 1 },
          qa: [
            { q: "Which storage should the session token use?", a: "HttpOnly cookie" },
            { q: "Keep the legacy token endpoint during rollout?", a: "No — remove it now" },
          ],
        },
      ],
    },
    // Interrupt marker → dim ⊘ system line, not a bubble.
    {
      role: "user",
      at: ago(40 * m),
      content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    },
    // Teams mailbox delivery: a report (bylined, expandable) + a bare idle ping.
    {
      role: "user",
      at: ago(35 * m),
      content: [],
      teammate: [
        {
          id: "reviewer",
          color: "green",
          summary: "Auth diff reviewed — 1 finding",
          body: "## Finding\n\n`cookieToken()` trusts the first `claude0=` pair; a second cookie of the same name would win on some proxies.",
        },
        { id: "docs", color: "blue", summary: "", body: '{"type":"idle_notification","from":"docs"}' },
      ],
    },
    // Image attachment + caption → 🖼 marker and the caption bubble.
    {
      role: "user",
      at: ago(31 * m),
      content: [{ type: "image" }, { type: "text", text: "[Image #1] this is what the login page looks like now" }],
    },
    {
      role: "assistant",
      at: ago(30 * m),
      content: [{ type: "text", text: "Looks right — the token field is gone and the cookie is set on connect." }],
    },
    // A message consumed from the input queue MID-turn (queued_command attachment, never a
    // `user` record) — renders as a normal user bubble, excluded from rewind checkpoints.
    {
      role: "user",
      at: ago(20 * m),
      queued: true,
      content: [{ type: "text", text: "also double-check the cookie's SameSite setting" }],
    },
  ],
  // Still sitting in the input queue (sent mid-turn, unconsumed) → dim "queued" bubble.
  queuedPending: ["and update the README auth section once that lands"],
  usage: { tokens: 124_000, size: 200_000, percent: 62 },
  mode: "auto",
  statusline: "124k/200k • eng-2687-cookie-auth",
  // Background work: one script wait + agents on both sides of lastPromptAt, so the
  // pill (🤖 1 ⏳ 1) and the sheet's waiting/running/fresh/earlier grouping all render.
  pendingScripts: [
    {
      toolUseId: "toolu_fixture1",
      kind: "script",
      label: "Background wait for Codex review to post",
      status: "pending",
      taskId: "bfixture1",
      launchedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
  ],
  // Worktree cwd: chips strip this prefix so paths render repo-relative.
  cwd: "/Users/throxy/dev/claude0/.claude/worktrees/eng-2687",
  lastPromptAt: ago(31 * m), // the image prompt above — everything after it is "since your prompt"
  subagents: [
    {
      agentId: "afix1",
      agentType: "Explore",
      description: "Trace the cookie exchange path",
      status: "running",
    },
    {
      agentId: "afix2",
      agentType: "code-reviewer",
      description: "Review the auth diff",
      status: "done",
      finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    {
      agentId: "afix3",
      agentType: "general-purpose",
      description: "Survey token storage options",
      status: "done",
      finishedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    },
    {
      agentId: "afix4",
      agentType: "Explore",
      description: "Map current auth routes",
      status: "done",
      finishedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
    },
  ],
  openQuestion: {
    question: "Which storage should the token use?",
    options: [
      { label: "HttpOnly cookie", description: "Server-set; JavaScript can't read it — safest for a bearer token." },
      { label: "localStorage", description: "Trivial to use but readable by any XSS on the page." },
      {
        label: "In-memory only",
        description: "Cleared on every reload; forces re-auth each visit.",
        preview: "store.set(token)\n// gone on refresh ↻",
      },
    ],
  },
  approval: null,
  pendingTool: null,
};

export const FIXTURE_REPOS = [
  { name: "throxy", path: "/Users/throxy/dev/throxy", branch: "main", isWorktree: false },
  { name: "throxy", path: "/Users/throxy/dev/throxy/.claude/worktrees/add-tomba-as-enrichment-provider", branch: "add-tomba-as-enrichment-provider", isWorktree: true },
  { name: "throxy", path: "/Users/throxy/dev/throxy/.claude/worktrees/workspace-cleanup", branch: "feature/workspace-context-cleanup", isWorktree: true },
  { name: "claude0", path: "/Users/throxy/dev/claude0", branch: "main", isWorktree: false },
  { name: "customeros", path: "/Users/throxy/dev/customeros", branch: "main", isWorktree: false },
  { name: "customeros", path: "/Users/throxy/dev/customeros/.claude/worktrees/ticket-output-piping", branch: "ticket-output-piping", isWorktree: true },
  { name: "wiki", path: "/Users/throxy/dev/wiki", branch: "main", isWorktree: false },
];

// Branch-vs-base changed files for the changed-files card/list demo (latest-modified first).
const FIXTURE_CHANGES = {
  root: "/Users/throxy/dev/claude0",
  branch: "eng-2687-cookie-auth",
  base: "main",
  files: [
    { path: "src/bridge/server.ts", status: "M", add: 34, del: 6, binary: false },
    { path: "src/bridge/diff-view.ts", status: "R", orig: "src/bridge/file-view.ts", add: 12, del: 3, binary: false },
    { path: "src/bridge/public/app.js", status: "M", add: 88, del: 2, binary: false },
    { path: "src/core/session-api.ts", status: "M", add: 41, del: 0, binary: false },
    { path: "src/bridge/public/index.html", status: "M", add: 22, del: 4, binary: false },
    { path: "src/core/repo-files.ts", status: "A", add: 190, del: 0, binary: false },
    { path: "public/icons/badge.png", status: "A", add: 0, del: 0, binary: true },
  ],
};

// Single-file diff for the diff-view demo — mirrors FileDiff (status letter + a small
// unified patch the client colors). Served for any /diff path so tapping any changed-files
// row renders a representative diff (with the A/M/D status badge in the header).
const FIXTURE_DIFF = {
  branch: "eng-2687-cookie-auth",
  base: "main",
  status: "M",
  add: 34,
  del: 6,
  patch: [
    "diff --git a/src/bridge/server.ts b/src/bridge/server.ts",
    "index 1111111..2222222 100644",
    "--- a/src/bridge/server.ts",
    "+++ b/src/bridge/server.ts",
    "@@ -40,7 +40,9 @@ export function serve() {",
    '   const token = req.headers.get("authorization");',
    "-  if (!token) return unauthorized();",
    '+  const cookie = parseCookie(req.headers.get("cookie"));',
    "+  if (!cookie?.claude0) return unauthorized();",
    "+  // token now lives in an HttpOnly cookie, never in JS",
    "   return handler(req);",
    "@@ -80,3 +82,4 @@ function routes() {",
    '   res.set("cache-control", "no-cache");',
    "+  res.set(\"set-cookie\", `claude0=${tok}; HttpOnly; SameSite=Strict`);",
    " }",
  ].join("\n"),
};

// History browse page: several days, several repos, one still-live row, and all three
// restore states (yes / relocated / no) so the row + drill-in treatments are exercised.
const FIXTURE_HISTORY = {
  rows: [
    {
      id: "api-refactor",
      repo: "claude0",
      branch: "refactor-session-api",
      name: "Session API",
      summary: "Extract session-api helpers from sessions.ts",
      firstPrompt: "extract the pane helpers out of sessions.ts",
      lastAssistant: "Moved the pane helpers into session-api.ts and updated the imports.",
      modified: ago(40_000),
      isActive: true,
    },
    {
      id: "hist-restore-fix",
      repo: "claude0",
      branch: "restore-sessions",
      name: "resurrect-fix",
      summary: "Never overwrite a real cwd with $HOME in pickSavedCwd",
      firstPrompt: "restore-sessions resumes in the home dir after a crash",
      lastAssistant: "pickSavedCwd now keeps the recorded repo path when a restored pane still reports $HOME.",
      modified: ago(3 * 3_600_000),
      isActive: false,
      restorable: "yes",
    },
    {
      id: "hist-diff-view",
      repo: "claude0",
      branch: "portkey-diff-view",
      name: "diff-view",
      summary: "Changed-files strip styling for the thread",
      firstPrompt: "make the changed-files glance readable on a phone",
      lastAssistant: "The strip is full-bleed with hairline rules now — no more assistant-bubble look.",
      modified: ago(7 * 3_600_000),
      isActive: false,
      restorable: "yes",
    },
    {
      id: "hist-tomba",
      repo: "throxy",
      branch: "cursor/add-tomba-provider",
      name: "tomba-provider",
      summary: "Add Tomba as an enrichment provider",
      firstPrompt: "add tomba as an enrichment provider behind the existing interface",
      lastAssistant: "Tomba is wired behind the provider interface with retries matching the others.",
      modified: ago(26 * 3_600_000),
      isActive: false,
      restorable: "relocated", // worktree deleted → resumes in the base repo
    },
    {
      id: "hist-icp",
      repo: "cortex",
      branch: "main",
      name: "icp-notes",
      summary: "Summarize ICP interview notes",
      firstPrompt: "summarize the ICP interview notes into a one-pager",
      lastAssistant: "One-pager written to notes/icp-summary.md.",
      modified: ago(30 * 3_600_000),
      isActive: false,
      restorable: "no", // repo folder gone — readable only
    },
    {
      id: "hist-usage",
      repo: "claude0",
      branch: "main",
      name: "Usage Readout",
      summary: "Token-usage readout thresholds",
      firstPrompt: "mirror the statusline usage colors on the phone",
      lastAssistant: "Usage now colors at the same 50/75% thresholds as the Mac statusline.",
      modified: ago(3 * 86_400_000),
      isActive: false,
      restorable: "yes",
    },
  ],
  before: null,
  // cortex lives outside configured repository roots in this fixture → no chip (rows still list).
  repos: [
    { repo: "claude0", count: 4 },
    { repo: "throxy", count: 1 },
  ],
};

// Search page for the same surface: flat, relevance-ranked, with match provenance —
// the snippet carries the query word so the .hl highlight renders.
const FIXTURE_HISTORY_SEARCH = {
  rows: [
    {
      ...FIXTURE_HISTORY.rows[1]!,
      matchField: "summary",
      matchSnippet: "…the resurrect map kept $HOME after a crash-restore…",
    },
    {
      ...FIXTURE_HISTORY.rows[5]!,
      matchField: "content",
      matchSnippet: "…tested resurrect end-to-end after the threshold change…",
    },
  ],
  before: null,
  repos: [{ repo: "claude0", count: 2 }],
};

/**
 * Canned payload for a request, or `undefined` if this isn't a fixture route (so the
 * caller falls through to the real handler — e.g. `/stream` keeps its live SSE).
 */
export function fixtureData(method: string, path: string, params?: URLSearchParams): unknown | undefined {
  if (method === "GET" && path === "/sessions") return { sessions: FIXTURE_SESSIONS, inboxStale: false };
  if (method === "GET" && path === "/repos") return FIXTURE_REPOS;
  if (method === "GET" && path === "/history") {
    return params?.get("q") ? FIXTURE_HISTORY_SEARCH : FIXTURE_HISTORY;
  }
  if (method === "GET" && path === "/pending") return [];
  // The open question blocks only the session whose list row says "question" — on the
  // others the composer (and, on a running session, the working indicator) stays visible.
  const tm = path.match(/^\/sessions\/([^/]+)\/transcript$/);
  if (method === "GET" && tm) {
    return tm[1] === "fix-auth" ? FIXTURE_TRANSCRIPT : { ...FIXTURE_TRANSCRIPT, openQuestion: null };
  }
  if (method === "GET" && /^\/sessions\/[^/]+\/changes$/.test(path)) return FIXTURE_CHANGES;
  if (method === "GET" && /^\/sessions\/[^/]+\/diff$/.test(path)) return FIXTURE_DIFF;
  // Stub the mutating actions so the UI's optimistic flows resolve cleanly in a demo.
  if (method === "POST" && path === "/sessions/new") return { ok: true, sessionId: FIXTURE_SESSIONS[0]!.id };
  if (
    method === "POST" &&
    // `archive` included: its real handler now writes the inbox store even for pane-less
    // ids (fixtures mode never populates discovery), which would pollute the real inbox.db.
    /^\/sessions\/[^/]+\/(decision|message|answer|read|rewind|snooze|block|unpark|unarchive|archive)$/.test(path)
  ) {
    return { ok: true };
  }
  return undefined;
}
