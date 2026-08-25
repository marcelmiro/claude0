// Claude0 (portkey) mobile bridge UI — Preact + signals + htm, no build step. Auth is the
// HttpOnly `claude0` cookie (set by POST /auth); this file never touches the token
// after the one login POST, and never puts it in a URL.
import { h, render } from "preact";
import { useRef, useEffect, useLayoutEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { Marked } from "marked";
// Same module the TUI uses (core/status.ts imports it directly), served unbuilt.
import { formatTimeAgo } from "/time-ago.js";
// Unified-patch parser, served unbuilt and covered by shared/diff-lines.test.ts.
import { parseDiffLines, narrowIndent } from "/diff-lines.js";
// Wake countdown — the same module the Mac sidebar renders from (sidebar/ansi.ts).
import { formatWakeIn } from "/wake-format.js";
import { formatWakeAbs } from "/wake-abs.js";
// Notification-tap attribution, served unbuilt and covered by shared/tap-target.test.ts.
import { tapTarget } from "/tap-target.js";
// Stream-event apply logic (versioned state push), served unbuilt and covered by
// shared/sync.test.ts.
import { applyTranscriptEvent, overlayResolved, displaySection } from "/sync.js";
// Tunnel-wake recovery decisions (burst retry + fetch timeouts), served unbuilt
// and covered by shared/reconnect.test.ts.
import { burstAction, withTimeout } from "/reconnect.js";

const html = htm.bind(h);

// --- Device identity (per-device Web Push routing) ---------------------------
// A stable per-device id: the bridge records which device drove each action and
// pushes only to that device (and only while it isn't watching live via SSE).
const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem("claude0-device");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("claude0-device", id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // private mode — a per-load id still routes correctly
  }
})();
// Every request carries the device header AND a default abort timeout — patched
// once here rather than threading a wrapper through every call site. Headers()
// normalizes whatever shape the call site passed (plain object, Headers, or
// none). The SSE URL uses a query param instead (EventSource can't set headers).
// The timeout exists because a waking Tailscale tunnel black-holes traffic: an
// untimed fetch then hangs for the platform default (60s+ on iOS), pinning stale
// UI long past the point retrying would have worked. Call sites that are
// legitimately slow (endpoints shelling out to git/gh, session launches, image
// uploads) pass their own longer signal, which wins.
const API_TIMEOUT_MS = 12_000;
const SLOW_API_TIMEOUT_MS = 30_000;
const slowTimeout = () => AbortSignal.timeout(SLOW_API_TIMEOUT_MS);
const rawFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("x-claude0-device", DEVICE_ID);
  return rawFetch(input, withTimeout({ ...init, headers }, API_TIMEOUT_MS));
};

// Render assistant markdown the way the native terminal does: real paragraphs, list
// spacing, and soft line breaks (`breaks: true` turns single newlines into <br>).
// marked has no sanitizer, so neutralize raw HTML by escaping any html token (code
// blocks are escaped correctly by marked itself), then defang javascript: links.
// Safe enough for this trusted, tailnet-only single-user bridge.
const escapeHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: { html: (token) => escapeHtml(typeof token === "string" ? token : token.text) },
});
// Cache rendered HTML by source text. Transcript turns are immutable history, so with
// the full (unsliced) conversation rendered, this keeps SSE re-renders cheap — only
// genuinely new turns run through marked.
const mdCache = new Map();
function md(text) {
  let out = mdCache.get(text);
  if (out === undefined) {
    out = marked.parse(text).replace(/href="javascript:[^"]*"/gi, 'href="#"');
    mdCache.set(text, out);
  }
  return out;
}

const authed = signal(false);
const sessions = signal([]);
const repositoryPriority = signal([]); // read-only projection of config repositories.priority
const selectedId = signal(null);
const transcript = signal(null);
const error = signal("");
const showHistory = signal(false); // History screen (the windowless archive) open
const history = signal(null); // /history payload {rows, before, repos} | null = loading
const historyQuery = signal(""); // search box text (debounced into refreshHistory)
const historyRepo = signal(""); // active repo chip ("" = all)
const historyMore = signal(false); // a page-append fetch is in flight
const historySession = signal(null); // session-shaped stand-in for a History row absent from sessions.value (>24h)
const flash = signal(""); // transient FAILURE feedback in the detail view (successes stay silent)
const flashKind = signal(""); // "" = error styling; "notice" = neutral (restore-on-interrupt)
const copied = signal(false); // transient "✓ copied" pill (clipboard success needs visible feedback)
const pendingSends = signal([]); // optimistic user bubbles awaiting transcript catch-up
const showNewSession = signal(false); // repo picker for launching a new session
const repos = signal(null); // null = loading, [] = loaded
const launching = signal(""); // repo name while waiting for a just-launched session to register
const restoring = signal(false); // true while a /restore request is in flight (blocks the button)
const menuText = signal(null); // long-pressed user message → action sheet (null = closed)
const sessionMenu = signal(null); // long-pressed session ROW → session action sheet (null = closed)
const configSheet = signal(null); // /model or /effort → model/effort selection sheet ({kind} | null)
const notice = signal(""); // transient SUCCESS notice, e.g. Claude's model/effort confirmation line
const loadingAuth = signal(true); // boot-time auth check + initial session load
const attachments = signal([]); // images staged in the composer: {blob, url} (object URLs)
const pendingImageSends = signal([]); // optimistic image bubbles awaiting transcript catch-up: {text, urls}
const connected = signal(true); // SSE stream health — false shows a "reconnecting" banner
const showAgents = signal(false); // subagent-list sheet open over the detail
const openSubagent = signal(null); // drilled-in agent {agentId, description, agentType, siblings:[]} | null
const subTranscript = signal(null); // the open subagent's conversation {turns} | null
const diffView = signal(null); // {path} → single-file diff pushed over the detail (null = closed)
const filesView = signal(false); // full changed-files list pushed over the detail
// Clock driving the relative-age labels. Ages used to recompute only when a refetch
// replaced `sessions`, so on a quiet list a row sat at "2m" for an hour. Ticking a
// signal re-renders them on their own; paused while hidden and resynced on resume.
const tick = signal(Date.now());
// The daemon's inbox snapshot is older than 10s (or absent) — sections render from the
// last known state with a banner. Server-computed.
const inboxStale = signal(false);
// Recently-done stays collapsed by default (a day of archives is screen bloat, and the
// section is an archive entry point, not a queue) — tap its header to expand. Not
// persisted: every launch starts collapsed.
const showDone = signal(false);
// A wrapped `{sessions, inboxStale}` payload has been applied this page-life — gates the
// "inbox zero" empty state, so a stale pre-inbox localStorage hydration never shows it.
const inboxAware = signal(false);

// File-editing tools, shared by the rewind-checkpoint calc (canCode) and the edit chips.
// Edit chips gate additionally on an edited path — `file_path` for most, `notebook_path`
// for NotebookEdit.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** The path a tool_use chip edited, whichever field carries it. */
const editedPath = (input) => input.file_path || input.notebook_path || "";
// A whole-line bracketed user turn (e.g. "[Request interrupted by user for tool use]") is a
// system notice Claude appends on interrupt — not a typed message. It's shown as a dim event
// line, and Claude's /rewind picker never lists it as a checkpoint. Mirrors preview-pane.ts.
const isSystemMarkerText = (t) => /^\[.*\]$/.test((t || "").trim());
const turnMarkerText = (turn) => {
  const c = turn.content || [];
  return c.length === 1 && c[0].type === "text" && isSystemMarkerText(c[0].text) ? c[0].text : null;
};

// A real typed prompt — a `user` turn carrying text or an image (excluding the system marker
// above). Claude records tool results as `user` turns too (content is a lone `tool_result`
// block), but those are NOT checkpoints in the /rewind picker and render as nothing in the
// thread. The rewind `upCount` walk must count ONLY prompt turns, or every tool result /
// interrupt marker inflates the count and the picker cursor overshoots → the server aborts
// with rewind-mismatch.
// `queued` turns (messages consumed from the input queue mid-turn) are excluded too:
// Claude's /rewind picker does not list them, so counting one would shift every earlier
// prompt's upCount by one.
// `bash` turns (`!cmd`, content empty) ARE included: Claude's picker lists them (verified
// live — `! echo … · No code changes`), the deliberate opposite of slash-command turns.
// `teammate` turns (teams mailbox deliveries, content empty) are included too: they are
// real user-role API messages that start turns — before the parser gave them their own
// kind they counted as plain text prompts, and excluding them now would shift every
// earlier prompt's upCount. (The server-side lastPromptAt boundary DOES exclude them —
// "since your last typed prompt" means the human.)
const isPromptTurn = (turn) =>
  turn.role === "user" &&
  !turn.queued &&
  !turnMarkerText(turn) &&
  (!!turn.bash ||
    !!turn.teammate ||
    (turn.content || []).some((b) => b.type === "text" || b.type === "image"));

// Ordered turn indices that are actual /rewind CHECKPOINTS. A typed prompt only becomes a
// checkpoint once it starts producing output — i.e. an assistant turn follows it before the
// next prompt. A prompt interrupted before its first token (double-tap Stop right after
// sending) creates NO checkpoint and is absent from Claude's picker, so counting it would
// shift every earlier prompt's upCount by one → the picker cursor lands wrong → the server
// aborts with rewind-mismatch. Verified against claude 2.1.x's picker. Non-prompt user turns
// (tool_result, interrupt markers) sit between and are simply skipped, not treated as prompts.
function promptCheckpointIndices(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    if (!isPromptTurn(turns[i])) continue;
    let started = false;
    for (let j = i + 1; j < turns.length; j++) {
      if (isPromptTurn(turns[j])) break; // reached the next prompt with no output in between
      if (turns[j].role === "assistant") {
        started = true;
        break;
      }
    }
    if (started) out.push(i);
  }
  return out;
}

// Map each checkpoint's turn index → its upCount (Up-presses from "(current)": the newest
// checkpoint is 1, counting back). Non-checkpoint turns are absent (→ upCount 0, no rewind).
function upCountByIndex(turns) {
  const idx = promptCheckpointIndices(turns);
  const map = new Map();
  idx.forEach((turnIndex, pos) => map.set(turnIndex, idx.length - pos));
  return map;
}
// Optimistic rewind view: {keepTurns, rev} while a rewind is committed on-pane but not yet
// written to the JSONL (Claude's /rewind is an in-memory checkpoint until the next send, so
// the transcript still returns the abandoned branch). We truncate the displayed thread to
// `keepTurns` and hold it until the file's `rev` changes (the resend's append). null = off.
const rewindFloor = signal(null);
// One-shot composer autofill: {text, sessionId}. Set on a successful rewind to drop the
// rewound message back into the box (TUI parity); the Composer consumes and clears it.
// `keepDraft: true` makes the fill yield to text already in the box instead of clobbering it.
const composerPrefill = signal(null);
// Restore-on-interrupt: interrupting right after a send makes Claude Code hand the prompt
// back to its own input box — the turn drops off the active branch, so the phone's thread
// loses the message and the composer is empty, with the text stranded in the Mac pane.
// After a Stop fires we watch the refetched transcript: if the last-sent text is no longer
// a user turn (and not queued), it returns to the composer, mirroring the TUI. If it's
// still in the thread (a mid-turn interrupt), the intent expires silently.
const lastSentText = new Map(); // sid → text; read only inside event handlers, not reactive
const interruptRestore = signal(null); // {sessionId, text, until} | null
// Interrupted prompts hidden from the thread once their text was restored to the composer:
// [{sessionId, index, text}]. Claude Code never deletes the turn from the JSONL — the
// revert only materializes as branch abandonment at the NEXT send, and sometimes not even
// then — so without this the thread keeps showing the very message the user is re-editing.
// Entries are index+text guarded at render: if the branch changed and that index no longer
// holds the exact prompt, the entry is inert (never hides an unrelated turn). This covers
// ONLY the reverted bare-leaf shape (prompt dangling at the tip, no interrupt marker) —
// indistinguishable from a just-sent message by structure alone, so it needs this
// moment-of-interrupt knowledge. It self-heals: the next send forks the branch and the
// turn drops out server-side. Marker-shaped interrupts are never hidden — the Mac TUI
// keeps those messages in the conversation, and portkey mirrors the TUI.
const hiddenInterrupts = signal([]);
// Optimistic "Chat about this": holds the sessionId whose open question we just declined,
// so the dock flips to the composer instantly (before the hook's deny resolves and the
// transcript poll drops openQuestions). Cleared on reconcile (poll shows no question), on
// failure, or by the post-settle verify timer in QuestionCard. null = off.
const clarifying = signal(null);
// Optimistic approve: the sessionId whose blocking APPROVAL card was just decided.
// Hides the card the instant the choice is tapped — before the POST round-trip and the
// transcript catch-up — mirroring `clarifying`. Cleared on reconcile (the refetched
// transcript no longer carries the card), on failure, or by a safety timeout. null = off.
const deciding = signal(null);
// Optimistic ANSWER for a question specifically: {id, toolUseId} of the question card
// that was just tapped. Separate from `deciding` (which stays sessionId-shaped for
// approvals) because a question needs identity: the card only stays hidden while the
// SAME question is open — a different toolUseId in the payload means a new question
// arrived and its card must show. Cleared on reconcile, on failure, or by the
// post-settle verify timer in QuestionCard. null = off.
const decidingQuestion = signal(null);

let es = null;

// Last-fetched payloads per session, so re-opening a session paints instantly
// (stale-while-revalidate — the mount fetch replaces them). Bounded so a long day of
// hopping between sessions doesn't grow memory unchecked.
function boundedSet(map, key, value, max = 20) {
  map.delete(key); // re-insert → newest position
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}
const transcriptCache = new Map(); // sessionId → last /transcript payload (open() paints it)
const changesDataCache = new Map(); // sessionId → last /changes payload (ChangesCard/FilesView)
const prDataCache = new Map(); // sessionId → last /pr payload (usePullRequest)
function cacheTranscript(id, data) {
  boundedSet(transcriptCache, id, data);
}

// Retirement key for a sent text: a `!cmd` send normalizes to "!" + the trimmed command,
// because the transcript's folded bash turn carries the command trimmed — a "! cmd"
// sent outside bash mode (e.g. pasted mid-draft) must still match it.
function bangKey(text) {
  const s = String(text || "").trim();
  return s.startsWith("!") ? "!" + s.slice(1).trim() : s;
}

// Text of every user turn already in the transcript — used to retire optimistic
// bubbles once the real send lands (the transcript lags the pane by a few seconds).
function userTurnTexts(t) {
  const out = new Set();
  for (const turn of (t && t.turns) || []) {
    if (turn.role !== "user") continue;
    // Executed slash commands land with their text on `command` (content is empty) — the
    // optimistic bubble for a "/cmd args" send must retire against that, not content.
    if (turn.command) out.add(turn.command.trim());
    // A `!cmd` send lands as a bash turn whose text lives on `bash.command` (the `!` is
    // stripped by Claude's record) — retire the optimistic `!cmd` bubble against it.
    if (turn.bash) out.add("!" + turn.bash.command);
    for (const b of turn.content || []) if (b.type === "text" && b.text) out.add(b.text.trim());
  }
  return out;
}

// Claude prefixes an image message's caption with literal "[Image #N] " markers; strip
// them so optimistic-image retirement matches our (prefix-free) caption, and so history
// renders the caption without the noise (the 🖼 chip already conveys the image).
const stripImagePrefix = (t) => String(t || "").replace(/^(?:\[Image #\d+\]\s*)+/, "");

// --- data ---------------------------------------------------------------

// --- optimistic status overlays (versioned state push) -----------------------
// A verb whose effect the server hasn't observed yet gets a client-side status
// overlay instead of trusting the next payload: send/approve/answer → `running`,
// interrupt → `ready`. Overlays are applied over every incoming sessions payload
// (never by mutating a payload in place), so a snapshot computed BEFORE the verb
// landed can't clobber them backwards; they retire on confirmation or expiry
// (`overlayResolved` in shared/sync.js), never on contradiction.
const statusOverlays = new Map(); // sid → {status: "running"|"ready", until}
let rawSessions = null; // the last server-truth list, before overlays

function overlaidSessions() {
  const base = rawSessions || [];
  if (statusOverlays.size === 0) return base;
  const now = Date.now();
  return base.map((s) => {
    const o = statusOverlays.get(s.id);
    if (!o) return s;
    if (overlayResolved(o, s.status, now)) {
      statusOverlays.delete(s.id);
      return s;
    }
    return { ...s, status: o.status };
  });
}

function setStatusOverlay(sid, status, ms = 10000) {
  statusOverlays.set(sid, { status, until: Date.now() + ms });
  sessions.value = overlaidSessions();
  // Re-derive at expiry so the true status resurfaces even with no new payload.
  setTimeout(() => {
    if (statusOverlays.has(sid)) sessions.value = overlaidSessions();
  }, ms + 100);
}

function clearStatusOverlay(sid) {
  if (statusOverlays.delete(sid)) sessions.value = overlaidSessions();
}

// Order list responses by request sequence, same as the transcript path: concurrent
// refreshes (SSE pushes + fallback GETs) can resolve out of order, and a slow stale
// response landing last would overwrite a fresher list until the next push.
let listReqSeq = 0;
let listAppliedSeq = 0;
// The server's `computedAt` on the last applied sessions push — when the payload
// itself was old at push time (server served a stale cache), the list shows a
// non-blocking "syncing" band instead of silently presenting old state as current.
const listStale = signal(false);

// Apply one /sessions payload (from a stream push or a fallback GET) to the app's
// state. Returns false on a malformed payload (never poison the render with it).
function applySessions(data) {
  // Payload is `{sessions, inboxStale}`; a bare array (older server) still parses.
  const list = Array.isArray(data) ? data : data && Array.isArray(data.sessions) ? data.sessions : null;
  if (!list) return false;
  rawSessions = list;
  // Prune overlays whose session left the list entirely (killed/archived mid-action) —
  // overlaidSessions only retires entries it visits, so these would otherwise linger.
  for (const id of statusOverlays.keys()) {
    if (!list.some((s) => s.id === id)) statusOverlays.delete(id);
  }
  sessions.value = overlaidSessions();
  inboxStale.value = !Array.isArray(data) && !!data.inboxStale;
  if (!Array.isArray(data)) inboxAware.value = true;
  followClearedSession(); // /clear or /compact on the open session → follow to its successor
  // Re-arm the read clear for the open session on every payload (idempotent while a
  // timer is pending): the one hook both stream pushes and GET fallbacks pass through,
  // so a session that turns unread while its detail is showing — or whose row was
  // stale at open() — still gets its ⚡ consumed.
  if (selectedId.value) markRead(selectedId.value);
  authed.value = true;
  if (error.value === "bridge unreachable") error.value = ""; // recovered — drop the banner
  // Persist for the next cold open (iOS evicts the page constantly): boot hydrates
  // from this so reopening paints the list instantly instead of a spinner.
  try {
    localStorage.setItem("claude0-sessions", JSON.stringify(list));
  } catch {
    /* private mode / quota — persistence is best-effort */
  }
  return true;
}

async function refreshSessions() {
  const seq = ++listReqSeq;
  try {
    const r = await fetch("/sessions");
    if (r.status === 401) return (authed.value = false);
    if (!r.ok) return;
    const data = await r.json();
    if (seq < listAppliedSeq) return; // a newer response already applied — never regress
    if (!applySessions(data)) return;
    listAppliedSeq = seq;
    listStale.value = false; // a direct GET is fresh-enough by construction (bounded staleness)
  } catch {
    error.value = "bridge unreachable";
  }
}

async function refreshPreferences() {
  try {
    const r = await fetch("/preferences");
    if (!r.ok) return;
    const value = await r.json();
    repositoryPriority.value = Array.isArray(value.repositoryPriority)
      ? value.repositoryPriority.map((name) => String(name).toLowerCase())
      : [];
  } catch {
    // Session refresh owns connection feedback; preferences safely fall back to alphabetical.
  }
}

// Volatile transcript fields — everything that can change while the JSONL doesn't (hook
// events, pane scrape, per-agent files). On an `unchanged` response these are replaced
// wholesale from the fresh payload; the file-derived bulk (turns, usage, pendingScripts,
// lastPromptAt, rev) is kept from the copy we already hold.
const VOLATILE_FIELDS = [
  "approval",
  "pendingTool",
  "openQuestion",
  "openQuestions",
  "subagents",
  "statusline",
  "mode",
  "model",
  "effort",
];

// Responses can arrive out of order: refreshTranscript runs concurrently (SSE bursts,
// polls, post-action refreshes) and a slow full response can land after — and would
// silently overwrite — a fresher one. That overwrite is terminal once a turn ends (no
// further hook event fires for the session, so nothing refetches), so order responses
// by request sequence and never apply one older than the last applied.
let txReqSeq = 0;
let txAppliedSeq = 0;

async function refreshTranscript() {
  const id = selectedId.value;
  if (!id) return;
  const seq = ++txReqSeq;
  // Offer the held file revision so an unchanged transcript comes back as a tiny
  // volatile-fields-only response instead of the full turn list.
  const heldRev = transcript.value && transcript.value.rev;
  const q = heldRev ? `?rev=${encodeURIComponent(heldRev)}` : "";
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/transcript${q}`);
    if (!r.ok) return;
    let data = await r.json();
    if (id !== selectedId.value) return; // session switched mid-flight — drop stale response
    if (data.unchanged) {
      const held = transcript.value;
      if (!held || held.rev !== data.rev) return; // held copy moved on — next poll refetches full
      const merged = { ...held };
      for (const k of VOLATILE_FIELDS) {
        if (k in data) merged[k] = data[k];
        else delete merged[k]; // omitted volatile field = cleared (e.g. question resolved)
      }
      data = merged;
    }
    if (seq < txAppliedSeq) return; // a newer response already applied — never regress
    txAppliedSeq = seq;
    applyTranscript(id, data);
  } catch {
    /* keep last-known */
  }
}

// Apply one complete transcript payload (from a fallback GET or a stream push) and
// reconcile every optimistic transient against it. The payload is always the full
// active conversation branch — replace, never merge (a rewind can shrink it).
function applyTranscript(id, data) {
  transcript.value = data;
  cacheTranscript(id, data);
  // Retire the optimistic approve/answer flip once the card is actually gone from the
  // refetched transcript (the decision resolved server-side).
  if (deciding.value === id && !(data.approval || data.openQuestions || data.openQuestion)) {
    deciding.value = null;
  }
  // Retire the optimistic answer once ITS question left the payload — either resolved
  // (no question) or replaced (different toolUseId, whose card must show immediately).
  const dq = decidingQuestion.value;
  if (dq && dq.id === id) {
    const openId = data.pendingTool && data.pendingTool.toolUseId;
    const sameStillOpen = (data.openQuestions || data.openQuestion) && openId === dq.toolUseId;
    if (!sameStillOpen) decidingQuestion.value = null;
  }
  // Retire the optimistic rewind view once the transcript file actually changed on disk
  // (the resend's append bumps `rev` even for a byte-identical resend) — the real active
  // branch is now the truncated one, so stop overriding it.
  if (rewindFloor.value && data.rev !== rewindFloor.value.rev) rewindFloor.value = null;
  // Retire the optimistic "Chat about this" flip once the declined question is actually
  // gone from the transcript (the deny resolved → PostToolUse cleared openQuestions).
  if (clarifying.value === id && !(data.openQuestions || data.openQuestion)) clarifying.value = null;
  // Resolve a pending restore-on-interrupt — mirroring the Mac TUI exactly (verified by
  // driving a live claude pane through timed interrupts and reading both the pane and
  // the JSONL). Claude Code REVERTS a prompt (moves the text back into its input box,
  // never draws it) only when nothing of the reply was drawn yet, and that state has one
  // JSONL signature: the prompt is the branch tip, childless — a bare leaf, NO interrupt
  // marker. Every marker means Claude Code KEPT the message in the conversation (with an
  // "Interrupted" line), so portkey keeps it too and restores nothing. The bare leaf
  // stays the served branch tip until the next send forks past it, hence the transient
  // hide; `gone` covers the post-fork state where the turn already fell off the branch.
  const ir = interruptRestore.value;
  if (ir && ir.sessionId === id) {
    const txt = ir.text.trim();
    const turns = transcript.value.turns || [];
    const last = turns[turns.length - 1];
    const reverted =
      last &&
      isPromptTurn(last) &&
      (last.content || []).some((b) => b.type === "text" && (b.text || "").trim() === txt);
    const gone =
      !userTurnTexts(transcript.value).has(txt) &&
      !(transcript.value.queuedPending || []).some((q) => q.trim() === txt);
    if (reverted || gone) {
      if (reverted) {
        hiddenInterrupts.value = [...hiddenInterrupts.value, { sessionId: id, index: turns.length - 1, text: txt }];
        // The revert parked the same text in the Mac pane's input box. Clear it (the
        // text now lives in this composer): a lingering occupied input silently flips
        // every future pre-stream interrupt from revert to keep, and feeds the next
        // send's draft guard a phantom draft. Recoverable at the Mac via C-y.
        fetch(`/sessions/${encodeURIComponent(id)}/clear-input`, { method: "POST" }).catch(() => {});
      }
      composerPrefill.value = { text: ir.text, sessionId: id, keepDraft: true };
      pendingSends.value = pendingSends.value.filter((p) => p !== ir.text);
      interruptRestore.value = null;
      // iOS won't raise the keyboard from a programmatic focus this long after the Stop
      // tap, so announce the restore where the user is looking.
      flashNotice("interrupted — message returned to the input box");
    } else if (Date.now() > ir.until) {
      interruptRestore.value = null; // Claude kept the message (marker shape) — mirror it
    }
  }
  // Drop optimistic bubbles that have now materialized as real user turns — or as
  // server-confirmed queue entries (the dim queued bubble takes over from there).
  if (pendingSends.value.length) {
    const seen = userTurnTexts(transcript.value);
    for (const q of transcript.value.queuedPending || []) seen.add(q.trim());
    const remaining = pendingSends.value.filter((p) => !seen.has(bangKey(p)));
    if (remaining.length !== pendingSends.value.length) pendingSends.value = remaining;
  }
  // Same for optimistic image bubbles, matched on the prefix-stripped caption (an
  // image-only send has caption "" and the transcript text is just "[Image #N]" → "").
  if (pendingImageSends.value.length) {
    const seen = new Set();
    for (const turn of transcript.value.turns || []) {
      if (turn.role !== "user") continue;
      for (const b of turn.content || []) if (b.type === "text") seen.add(stripImagePrefix(b.text).trim());
    }
    const keep = [];
    for (const e of pendingImageSends.value) {
      if (seen.has(stripImagePrefix(e.text).trim())) e.urls.forEach(URL.revokeObjectURL);
      else keep.push(e);
    }
    if (keep.length !== pendingImageSends.value.length) pendingImageSends.value = keep;
  }
}

// Fetch the open subagent's conversation (same {turns} shape as /transcript, rendered
// through the existing Turn). Drops a stale response if the user switched agent/session
// mid-flight; a 404 (file vanished) flashes "transcript unavailable" without crashing.
async function refreshSubagent() {
  const o = openSubagent.value;
  const id = selectedId.value;
  if (!o || !id) return;
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(o.agentId)}`);
    if (!r.ok) return flashError("✗ transcript unavailable");
    const data = await r.json();
    if (openSubagent.value?.agentId !== o.agentId || id !== selectedId.value) return;
    subTranscript.value = data;
  } catch {
    /* keep last-known */
  }
}

// Coalesce refetch bursts: an action's eager refresh and the SSE broadcast it triggers
// land within a few hundred ms, and each fired a full /sessions + /transcript pair. The
// leading call runs immediately; calls inside the window collapse into one trailing run.
// Sites that must await a guaranteed-fresh result (login, boot) call the raw functions.
function coalesce(fn, ms = 300) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, ms - (now - last));
    }
  };
}
const refreshSessionsSoon = coalesce(refreshSessions);
const refreshTranscriptSoon = coalesce(refreshTranscript);

// Last time the stream demonstrably worked (open, broadcast, or server ping). The
// watchdog below reads it; every EventSource callback stamps it.
let lastStreamActivity = Date.now();
const stampStream = () => (lastStreamActivity = Date.now());
// Last time a stream actually OPENED — the foreground burst's success signal.
// Distinct from lastStreamActivity, which the watchdog also stamps on its own
// rebuild attempts; the burst must only stand down on a real connection.
let lastOpenAt = 0;

// Tell the bridge which session this device has open (null = none). The server
// answers with a forced transcript snapshot over the stream and keeps pushing
// append/snapshot deltas (JSONL watcher + hook events) until unsubscribed.
// Serialized through a promise chain: the server keeps ONE subscription per
// device, last-request-wins, so two parallel POSTs from a rapid A→B switch
// could land out of order and leave the server pushing A while B is on screen.
let openSubChain = Promise.resolve();
function openSubscription(sessionId) {
  openSubChain = openSubChain.then(() =>
    fetch("/stream/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {
      /* the fallback GET path still keeps the thread alive */
    }),
  );
}

// After a foreground resync, the notification-tap check must run against a FRESH
// list (the pre-background copy predates the push that brought us here). Normally
// the on-connect sessions snapshot satisfies it; a fallback timer covers a
// connect that never delivers one.
let pendingTapCheck = false;

function connectStream() {
  if (es) es.close();
  es = new EventSource(`/stream?device=${encodeURIComponent(DEVICE_ID)}`);
  // On every (re)connect the SERVER pushes fresh snapshots (sessions + the
  // subscribed transcript) — that replaces the old re-fetch-everything dance.
  // The subscription itself must be re-declared: a goodbye/prune may have
  // dropped it while the socket was down.
  es.onopen = () => {
    stampStream();
    lastOpenAt = Date.now();
    connected.value = true;
    if (selectedId.value) openSubscription(selectedId.value);
    if (openSubagent.value) refreshSubagent();
  };
  // The server heartbeats a named `ping` every 15s — named events bypass onmessage,
  // so this listener exists only to stamp liveness for the watchdog.
  es.addEventListener("ping", stampStream);
  // EventSource auto-reconnects; surface the gap so a dropped tailnet/socket isn't silent.
  es.onerror = () => {
    if (!es || es.readyState !== 1) connected.value = false;
  };
  es.onmessage = (ev) => {
    stampStream();
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "sessions") {
      // A push is by definition the newest state — supersede any in-flight GET.
      listAppliedSeq = ++listReqSeq;
      if (applySessions(msg.payload)) {
        // The payload was already old when pushed (server served a stale cache) →
        // surface it honestly instead of presenting old state as current.
        listStale.value = !!msg.computedAt && Date.now() - msg.computedAt > 30_000;
        if (pendingTapCheck) {
          pendingTapCheck = false;
          followNotificationTap();
        }
      }
      return;
    }
    if (msg.type === "transcript") {
      if (msg.sessionId !== selectedId.value) return; // stale subscription push
      const r = applyTranscriptEvent(transcript.value, msg);
      if (r.needsFetch) return refreshTranscript(); // append base lost — fall back to a full GET
      txAppliedSeq = ++txReqSeq; // pushes supersede in-flight GETs
      applyTranscript(msg.sessionId, r.data);
      if (openSubagent.value) refreshSubagent();
    }
  };
}

// Zombie-stream watchdog. iOS can kill the socket with no error and no visibility
// change — the EventSource still claims OPEN, so `resync` (foreground-only) never
// runs and the app silently stops hearing broadcasts until a manual remount. The
// server pings every 15s; silence past ~2.5 periods while visible means the stream
// is dead regardless of readyState — rebuild it and refetch what the dead window
// may have dropped. Stamping before the rebuild spaces retries to one per window.
// Hidden is excluded on purpose: sendGoodbye closes the stream deliberately there,
// and resync already rebuilds it on return to foreground.
setInterval(() => {
  if (document.visibilityState !== "visible" || !authed.value) return;
  if (Date.now() - lastStreamActivity < 40_000) return;
  stampStream();
  connectStream();
  refreshSessions();
  if (selectedId.value) refreshTranscript();
}, 10_000);

// --- Web Push (installed-PWA only: iOS allows push solely for home-screen apps) ---
// The bell shows only in the true first-run case (permission not yet asked); once
// granted, a lost/pruned subscription silently self-heals on every launch.
const pushEligible = signal(false);
const IS_STANDALONE =
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
  window.navigator.standalone === true;

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush(reg) {
  const { key } = await (await fetch("/push/vapid-key")).json();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64urlToBytes(key),
  });
  const keys = sub.toJSON().keys;
  await fetch("/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: DEVICE_ID,
      subscription: { endpoint: sub.endpoint, keys },
    }),
  });
}

// Runs after auth. Registers the SW (also wiring the notification-tap deep link),
// then: permission granted → verify against SERVER truth (`/push/subscribed` — a
// pruned subscription is invisible to pushManager.getSubscription) and resubscribe
// silently; permission never asked → surface the bell; denied → nothing to offer.
async function initPush() {
  if (!IS_STANDALONE || !("Notification" in window) || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    // Force an update check every launch. register() alone can leave a months-old
    // worker active on iOS, and a stale push handler is invisible until someone
    // digs into why notifications stopped behaving.
    reg.update().catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "open-session" && msg.sessionId) open(msg.sessionId);
    });
    if (!reg.pushManager) return;
    if (Notification.permission === "granted") {
      const r = await fetch(`/push/subscribed?device=${encodeURIComponent(DEVICE_ID)}`);
      const { subscribed } = await r.json();
      const local = await reg.pushManager.getSubscription();
      if (!subscribed || !local) await subscribePush(reg);
    } else if (Notification.permission === "default") {
      pushEligible.value = true;
    }
  } catch {
    /* push is best-effort — the app works without it */
  }
}

// Bell tap — the one place that needs a user gesture (iOS requirement).
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    pushEligible.value = false;
    if (perm !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    await subscribePush(reg);
  } catch {
    flashError("✗ push setup failed");
  }
}

async function login(token) {
  error.value = "";
  loadingAuth.value = true;
  try {
    const r = await fetch("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return (error.value = "wrong token");
    await Promise.all([refreshSessions(), refreshPreferences()]);
    if (authed.value) {
      connectStream();
      initPush();
    }
  } catch {
    error.value = "bridge unreachable";
  } finally {
    loadingAuth.value = false;
  }
}

// Transient FAILURE feedback that auto-hides after 5s. Successes are silent (a "✓ sent"
// toast was just noise); only errors surface, so a silently-failed action isn't invisible.
let flashTimer = null;
function flashError(msg) {
  flashKind.value = "";
  flash.value = msg;
  clearTimeout(flashTimer);
  if (msg) flashTimer = setTimeout(() => (flash.value = ""), 5000);
}

// One exception to "successes are silent": restore-on-interrupt. The message silently
// moving from the thread to the composer is easy to miss (iOS blocks the keyboard raise),
// so it gets a neutral, non-error toast in the same slot above the input box.
function flashNotice(msg) {
  flashKind.value = "notice";
  flash.value = msg;
  clearTimeout(flashTimer);
  if (msg) flashTimer = setTimeout(() => (flash.value = ""), 5000);
}

// Copy success IS worth a toast (unlike sends): the clipboard is invisible, so silent
// success leaves you unsure it worked. A brief centered "✓ copied" pill, auto-hidden.
let copiedTimer = null;
function flashCopied() {
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1100);
}

// A longer-lived success notice (vs the 1.1s copied pill) — used to surface Claude's own
// model/effort confirmation line verbatim, including the scope it reports (global vs session).
let noticeTimer = null;
function notify(msg) {
  notice.value = msg;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => (notice.value = ""), 4500);
}

// Send an action and report ok/failure to the caller — the bridge gates
// answer/decision/message server-side and returns {ok,reason}. Failures flash; success
// is silent (the caller updates the UI optimistically).
async function action(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: slowTimeout(), // fork/send block server-side until the pane confirms
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return true;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    flashError("✗ bridge unreachable");
    return false;
  }
}

// Like action(), but returns the parsed response so callers can read extra fields (the
// /config confirmation `line`). Refreshes on success; flashes + returns null on failure.
async function actionJson(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: slowTimeout(), // /config waits for Claude's own confirmation line
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return data;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return null;
  } catch {
    flashError("✗ bridge unreachable");
    return null;
  }
}

// Multipart sibling of action() for image uploads — identical result handling, but lets
// the browser set the multipart boundary (no JSON content-type header).
async function actionForm(path, formData) {
  try {
    const r = await fetch(path, { method: "POST", body: formData, signal: slowTimeout() });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return true;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    flashError("✗ bridge unreachable");
    return false;
  }
}

// Downscale a picked image in-browser to ≤1568px long edge (Claude's max useful
// resolution) and JPEG-compress it — a 10MB phone photo becomes a few hundred KB. Falls
// back to the original File if the browser can't decode it. `imageOrientation:"from-image"`
// honours EXIF rotation so portrait photos don't arrive sideways.
async function downscale(file, maxEdge = 1568, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file;
  }
}

// Drop all staged + in-flight image object URLs (free memory) when leaving a session.
function clearAttachments() {
  for (const a of attachments.value) URL.revokeObjectURL(a.url);
  for (const e of pendingImageSends.value) e.urls.forEach(URL.revokeObjectURL);
  attachments.value = [];
  pendingImageSends.value = [];
}

function open(id) {
  // Leaving a session before its read-grace elapsed: that glance doesn't count as read.
  if (selectedId.value && selectedId.value !== id) cancelReadTimer(selectedId.value);
  selectedId.value = id;
  // Paint the last-fetched copy instantly (stale-while-revalidate) instead of blanking
  // to "loading…"; the refetch below replaces it. First-ever open still shows loading.
  transcript.value = transcriptCache.get(id) ?? null;
  flash.value = ""; // drop any stale error from the previously-open session
  pendingSends.value = [];
  rewindFloor.value = null; // never carry an optimistic rewind across sessions
  composerPrefill.value = null;
  closeAgents(); // drop any agent list/drill-in from the previously-open session
  diffView.value = null; // drop any diff / changed-files view from the previous session
  filesView.value = false;
  clearAttachments();
  openSubscription(id); // the pushed snapshot is the primary paint…
  refreshTranscript(); // …the GET is the fallback (races are settled by seq)
  markRead(id);
}

// Auto-follow /clear and /compact: both retire the open session's id and mint a NEW one on
// the SAME tmux pane, so the phone would otherwise strand on the now-archived old id (empty,
// restore-only). We track the open session's pane while it's live; when it flips to archived
// (or drops from the active list) and a DIFFERENT live session now holds that pane, that's
// the successor — open it. A real kill leaves the pane empty (no successor), so the restore
// bar still shows. Called after every sessions refresh; stateless beyond the remembered pane.
let openSessionPane = null; // { id, paneId } of the currently-open session while it was live
function followClearedSession() {
  const id = selectedId.value;
  if (!id) {
    openSessionPane = null;
    return;
  }
  const cur = sessions.value.find((s) => s.id === id);
  if (cur && cur.paneId && cur.status !== "archived") {
    openSessionPane = { id, paneId: cur.paneId }; // still live — remember its pane
    return;
  }
  // The open session is archived/gone. Follow to a live session on the same pane, if any.
  if (!openSessionPane || openSessionPane.id !== id) return;
  const succ = sessions.value.find(
    (s) => s.paneId === openSessionPane.paneId && s.id !== id && s.status !== "archived",
  );
  if (succ) open(succ.id);
}

// Drill into one subagent: stash the row (+ siblings, for the footer prev/next nav),
// close the list sheet, then fetch its conversation.
function openAgent(agent, siblings) {
  openSubagent.value = {
    agentId: agent.agentId,
    description: agent.description,
    agentType: agent.agentType,
    siblings,
  };
  showAgents.value = false;
  subTranscript.value = null;
  refreshSubagent();
}

// Clear the agent list sheet + any open drill-in (back to the session detail).
function closeAgents() {
  showAgents.value = false;
  openSubagent.value = null;
  subTranscript.value = null;
}

// Back chevron from a drill-in → return to the session detail (the list sheet is already
// dismissed once you've drilled in).
function closeSubagent() {
  openSubagent.value = null;
  subTranscript.value = null;
}

// Reading a session clears its unread glow — but only after a 3s grace period, never
// instantly. The delay closes a race: the monitor sets ⚡ once, on the running→ready
// transition, so if Claude finishes right as you open (or glance and leave), an
// immediate read would clobber that fresh ⚡ before it reaches the phone and you'd miss
// the completion. We clear only if the session is still unread with the SAME last-turn
// timestamp we saw at arm time — a turn completing within the window advances it, so
// its ⚡ survives (`activityAt`, not `modified`: the transcript mtime moves on
// bookkeeping writes with no conversation behind them, which would abort real clears).
// Arming is idempotent: a pending timer is never reset, so the steady refresh stream
// can't starve the clear. Every applied payload re-arms for the open session, which
// (1) catches a session that turns unread while its detail is already showing and
// (2) retries a clear the bridge dropped (transient pane-resolution failure). Timers
// are cancelled on selection change and on page hide — a clear fires only while that
// session's detail is open and the page visible. Clears locally + on the bridge
// (which writes needsAttention:false to state.json so the Mac's ⚡ clears too).
const readTimers = new Map();
function cancelReadTimer(id) {
  const t = readTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    readTimers.delete(id);
  }
}
function markRead(id) {
  const s = sessions.value.find((x) => x.id === id);
  if (!s || !s.unread || readTimers.has(id)) return;
  const seen = activityAt(s);
  readTimers.set(
    id,
    setTimeout(() => {
      readTimers.delete(id);
      const cur = sessions.value.find((x) => x.id === id);
      if (!cur || !cur.unread) return;
      if (activityAt(cur) !== seen) {
        // A fresh turn arrived mid-grace: keep its ⚡, but restart the grace if the
        // user is still looking at this session — the stream may stay quiet after the
        // turn's own payloads, so waiting for the next one could strand the clear.
        if (selectedId.value === id && document.visibilityState === "visible") markRead(id);
        return;
      }
      // Clear in the raw list too — overlays re-derive from it, and a re-derive from a
      // copy still flagged unread would resurrect the glow until the server's own clear.
      if (rawSessions) rawSessions = rawSessions.map((x) => (x.id === id ? { ...x, unread: false } : x));
      sessions.value = sessions.value.map((x) => (x.id === id ? { ...x, unread: false } : x));
      fetch(`/sessions/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
    }, 3000),
  );
}

function back() {
  if (selectedId.value) cancelReadTimer(selectedId.value); // backing out within the grace keeps the ⚡
  openSubscription(null); // tear down the transcript push + its server-side watcher
  selectedId.value = null;
  transcript.value = null;
  historySession.value = null; // the stand-in belongs to the closed detail only
  pendingSends.value = [];
  rewindFloor.value = null;
  composerPrefill.value = null;
  closeAgents();
  clearAttachments();
}

// --- history (the windowless archive: browse by day, search everything) ---
// Fetch-on-open by design (no SSE): an archive doesn't change while you look at it,
// and the actions that DO change it (archive/restore) already refetch.
let historySeq = 0; // supersede stale responses while typing
async function refreshHistory(opts = {}) {
  const seq = ++historySeq;
  const params = new URLSearchParams();
  const q = historyQuery.value.trim();
  if (q) params.set("q", q);
  if (historyRepo.value) params.set("repo", historyRepo.value);
  if (opts.before) params.set("before", String(opts.before));
  try {
    const r = await fetch(`/history?${params}`, { signal: slowTimeout() });
    if (!r.ok) return;
    const data = await r.json();
    if (seq !== historySeq) return; // a newer query/page fetch superseded this one
    history.value = opts.before && history.value ? { ...data, rows: [...history.value.rows, ...data.rows] } : data;
  } catch {
    /* keep whatever page we already show; the offline banner covers connectivity */
  }
}

let historyDebounce;
function setHistoryQuery(q) {
  historyQuery.value = q;
  clearTimeout(historyDebounce);
  historyDebounce = setTimeout(() => refreshHistory(), 250);
}

function setHistoryRepo(repo) {
  historyRepo.value = repo;
  refreshHistory();
}

function openHistory() {
  showHistory.value = true;
  history.value = null;
  historyQuery.value = "";
  historyRepo.value = "";
  refreshHistory();
}

// Tap a History row. Live rows just open their session. Archived rows may be older
// than discovery's 24h sweep and thus absent from sessions.value — stash a
// session-shaped stand-in so Detail can render the header + restore bar; the
// transcript itself is fetched by id and needs no discovery entry.
function openHistoryRow(row) {
  historySession.value = row.isActive
    ? null
    : {
        id: row.id,
        repo: row.repo,
        branch: row.branch,
        name: row.name,
        label: row.name || row.summary || row.branch,
        status: "archived",
        restorable: row.restorable,
        summary: row.summary,
        modified: row.modified,
        lastTurn: row.modified,
      };
  open(row.id);
}

// --- new session (repo picker → launch claude in a new tmux window) ---
async function openNewSession() {
  showNewSession.value = true;
  repos.value = null;
  try {
    const r = await fetch("/repos");
    repos.value = r.ok ? await r.json() : [];
  } catch {
    repos.value = [];
  }
}
async function launchSession(repo) {
  // The /sessions/new request blocks until claude boots and its SessionStart hook
  // registers the new session id (~1-4s), so show a "launching…" hint meanwhile, then
  // open exactly that session — server-determined id, no fragile before/after diffing.
  error.value = "";
  showNewSession.value = false;
  launching.value = repo.name;
  try {
    const r = await fetch("/sessions/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repo.path, name: repo.name }),
      signal: slowTimeout(), // blocks until the new pane's prompt is live
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok !== false) {
      await refreshSessions();
      if (data.sessionId) open(data.sessionId);
    } else {
      error.value = `launch failed: ${data.reason || r.status}`;
    }
  } catch {
    error.value = "bridge unreachable";
  } finally {
    launching.value = "";
  }
}
// Resume an archived session from the phone. The request BLOCKS until Claude's prompt is live
// (~7-12s), so show a "Restoring…" state meanwhile; on success the session is now live
// (non-archived) and refreshSessions() flips the dock to the composer. Failures stay archived
// so the button remains for retry — the reason is surfaced via `flash` in the restore row.
async function restoreSession() {
  const id = selectedId.value;
  if (!id || restoring.value) return;
  restoring.value = true;
  flash.value = "";
  try {
    // Blocks until Claude's prompt is live (~7-12s) — needs the slow tier.
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/restore`, { method: "POST", signal: slowTimeout() });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok !== false) {
      await refreshSessions();
      if (id === selectedId.value) await refreshTranscript();
    } else {
      flash.value = `restore failed: ${data.reason || r.status}`;
    }
  } catch {
    flash.value = "bridge unreachable";
  } finally {
    restoring.value = false;
  }
}

// Copy that works on iPhone across origins. On a secure origin (HTTPS) the native Clipboard
// API actually writes; over plain http navigator.clipboard is undefined, so we fall back to
// an execCommand path (see legacyCopy). iOS only honors the clipboard at all over HTTPS.
async function copyText(text) {
  if (!text) return false;
  let ok = false;
  // Prefer the native Clipboard API on a secure origin (HTTPS) — it actually writes. iOS
  // `execCommand` returns true even when it no-ops, so it can't be trusted as the primary.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = legacyCopy(text); // non-secure origins / older browsers (http desktop)
  if (ok) flashCopied();
  else flashError("✗ copy failed");
  return ok;
}

// Copy from an action sheet: copy, then dismiss the sheet.
async function copyMessage(text) {
  await copyText(text);
  menuText.value = null;
}

// execCommand("copy") via an off-screen field — the only path on a non-secure origin
// (plain http over Tailscale), where navigator.clipboard is undefined. The iOS recipe
// (per clipboard.js): a `readonly` textarea (so no keyboard pops up), positioned off-screen
// rather than hidden via opacity:0 (iOS won't copy from a zero-opacity element), selected
// with BOTH a Range over the node AND setSelectionRange. 16px font avoids an iOS zoom jump.
function legacyCopy(text) {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.cssText = `position:absolute;left:-9999px;top:${window.scrollY || 0}px;font-size:16px;`;
    document.body.appendChild(el);
    const prior = document.getSelection().rangeCount > 0 ? document.getSelection().getRangeAt(0) : null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (prior) {
      sel.removeAllRanges();
      sel.addRange(prior); // restore whatever the user had selected
    }
    return ok;
  } catch {
    return false;
  }
}

// Long-press detection for message actions. A single shared timer (only one press at a
// time); a move or release before the threshold cancels it, so it never fights swipes.
// The menu payload carries the message text + its rewind target (upCount = Up-presses from
// "(current)" in Claude's /rewind picker; 0 = not a checkpoint, so no rewind — see
// upCountByIndex). canCode gates the code-restore option.
let lpTimer = null;
const lpStart = (text, upCount, canCode) => () => {
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => (menuText.value = { text, upCount, canCode }), 450);
};
const lpCancel = () => clearTimeout(lpTimer);

// Optimistic/queued user bubbles (not yet in the transcript, so no rewind target): a
// copy-only sheet. This is the recovery path when a send silently never lands — without
// it the text exists nowhere the user can reach.
const lpStartCopyOnly = (text) => () => {
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => (menuText.value = { text, copyOnly: true }), 450);
};

// The shared touch-handler bundle for a long-pressable bubble — spread onto the element.
const lpProps = (start) => ({
  onTouchStart: start,
  onTouchMove: lpCancel,
  onTouchEnd: lpCancel,
  onContextMenu: (e) => e.preventDefault(),
});

// Assistant bubble: long-press → a Copy-only sheet (rewind is a user-turn concept). The
// `assistant` flag tells ActionSheet to drop the rewind buttons. `asstLpFired` suppresses the
// click iOS fires on release so a long-press never also tap-copies a code span underneath it.
let asstLpFired = false;
const lpStartAsst = (text) => () => {
  asstLpFired = false;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    asstLpFired = true;
    menuText.value = { text, assistant: true };
  }, 450);
};

// Tap-to-copy inside a rendered-markdown assistant bubble: a tap on a code block copies the
// whole block, a tap on an inline `code` span copies just that span. Non-code taps do nothing
// (the bubble isn't natively selectable). Delegation over the marked-generated HTML — no need
// to attach handlers to injected nodes.
function assistantTap(e) {
  if (asstLpFired) {
    asstLpFired = false;
    return; // this click is the tail of a long-press that already opened the sheet
  }
  const target = e.target.closest("pre") || e.target.closest("code");
  if (!target) return;
  e.preventDefault();
  copyText(target.textContent);
}

// Turn index of the checkpoint `upCount` Up-presses from current (the inverse of the render's
// upCountByIndex map) — i.e. where a rewind-to-before-it truncates the thread. -1 if not found
// (stale menu / count drift), signalling "don't truncate".
function keepTurnsForUpCount(turns, upCount) {
  for (const [turnIndex, up] of upCountByIndex(turns)) {
    if (up === upCount) return turnIndex;
  }
  return -1;
}

async function rewind(mode) {
  const m = menuText.value;
  menuText.value = null;
  if (!m) return;
  // Snapshot BEFORE the await: the target's truncation point + the transcript's current disk
  // revision. Rewind is offered only at the prompt (idle), so the tail is stable here.
  const sid = selectedId.value;
  const t = transcript.value;
  const keepTurns = t && t.turns ? keepTurnsForUpCount(t.turns, m.upCount) : -1;
  const rev0 = t ? t.rev : undefined;
  const ok = await action(`/sessions/${encodeURIComponent(sid)}/rewind`, {
    upCount: m.upCount,
    text: m.text,
    mode,
  });
  if (!ok || sid !== selectedId.value) return; // failed (action flashed) or switched away
  if (keepTurns >= 0) rewindFloor.value = { keepTurns, rev: rev0 };
  composerPrefill.value = { text: m.text, sessionId: sid };
}

// Long-press on a session ROW opens the session action sheet (archive). Shares the
// single lpTimer (one press at a time). lpFired suppresses the tap-to-open click that
// iOS fires on release, so a long-press never also navigates into the session.
let lpFired = false;
function rowPress(s) {
  return {
    onPointerDown: () => {
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        sessionMenu.value = s;
        if (navigator.vibrate) navigator.vibrate(8); // a tap of haptic feedback, like iOS
      }, 450);
    },
    onPointerUp: lpCancel,
    onPointerMove: lpCancel,
    onPointerCancel: lpCancel,
    onClick: (e) => {
      if (lpFired) {
        e.preventDefault();
        lpFired = false;
        return;
      }
      open(s.id);
    },
  };
}

async function archiveSession() {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  cancelReadTimer(s.id); // a disposed session never gets a deferred read-clear
  // If we're viewing the session we just archived, drop back to the list.
  if (selectedId.value === s.id) selectedId.value = null;
  await action(`/sessions/${encodeURIComponent(s.id)}/archive`, {});
}

// Inbox verbs (ADR 0013). Snooze/block are disposals: they kill the pane and park the
// row, so disposing the open session drops back to the list (same as archive). Unpark
// and un-archive only edit the row's lifecycle — no navigation.
async function snoozeSession(preset) {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  cancelReadTimer(s.id); // a disposed session never gets a deferred read-clear
  if (selectedId.value === s.id) selectedId.value = null;
  const data = await actionJson(`/sessions/${encodeURIComponent(s.id)}/snooze`, { preset });
  // Toast the resolved wake — a one-tap disposal is otherwise invisible (the sheet
  // closes and the row files under Parked), so a mis-tapped preset would go unnoticed.
  if (data && data.wakeAt) notify(`Snoozed until ${formatWakeAbs(data.wakeAt, Date.now())}`);
}

async function blockSession(note) {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  cancelReadTimer(s.id); // a disposed session never gets a deferred read-clear
  if (selectedId.value === s.id) selectedId.value = null;
  await action(`/sessions/${encodeURIComponent(s.id)}/block`, { note });
}

async function unparkSession() {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  await action(`/sessions/${encodeURIComponent(s.id)}/unpark`, {});
}

async function unarchiveSession() {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  await action(`/sessions/${encodeURIComponent(s.id)}/unarchive`, {});
}

// Fork the session: close the sheet, show the same "launching …" hint the new-session flow
// uses (the /fork request BLOCKS until the fork's prompt is live), then open straight into
// the server-determined fork id. The original session is untouched.
async function forkSession() {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  launching.value = listTitle(s);
  try {
    // actionJson flashes + returns null on failure; on success it carries the new fork id.
    const data = await actionJson(`/sessions/${encodeURIComponent(s.id)}/fork`, {});
    if (data && data.sessionId) {
      await refreshSessions();
      open(data.sessionId);
    }
  } finally {
    launching.value = "";
  }
}

// --- views --------------------------------------------------------------

const DOT_COLOR = {
  waiting: "var(--red)",
  running: "var(--mint)",
  ready: "var(--peach)",
  idle: "var(--dim)",
  archived: "var(--dim)",
};
const RANK = { waiting: 0, running: 1, ready: 2, idle: 3, archived: 4 };
const GENERIC_BRANCH = new Set(["main", "master", "develop", "dev", ""]);

// Status indicator as a uniform CSS circle (identical size for every status, unlike the
// mismatched ⏸/⦿/●/○ glyphs): filled disc for active states, hollow ring for idle/archived.
// An UNREAD session (monitor's ⚡ — a completed turn or a block you haven't seen on Mac or
// phone yet) gets a glow ring in its status color, so "glow = go read" at a glance. The
// glow clears the moment you open it (here and, via the bridge, on the Mac too).
const GLOW = {
  waiting: "rgba(255,128,128,0.65)",
  running: "rgba(153,255,228,0.6)",
  ready: "rgba(255,199,153,0.62)",
  idle: "rgba(180,180,180,0.55)",
  archived: "rgba(180,180,180,0.55)",
};
function dotStyle(s) {
  // Blocked-ON-YOU (pending question/approval) is the loudest state: a red disc with a
  // red halo, regardless of the raw status (a question session often reports `ready`).
  if (s.pending) {
    const r = GLOW.waiting;
    return `background:var(--red);box-shadow:0 0 0 4px ${r}, 0 0 9px 2px ${r}`;
  }
  const color = DOT_COLOR[s.status] ?? "var(--dim)";
  const ring = s.status === "idle" || s.status === "archived";
  const base = ring ? `border:1.5px solid ${color}` : `background:${color}`;
  const g = GLOW[s.status] ?? "rgba(255,255,255,0.55)";
  // Firmer ring + a soft blurred halo so unread reads at a glance (not just a faint tint).
  return s.unread ? `${base};box-shadow:0 0 0 4px ${g}, 0 0 9px 2px ${g}` : base;
}

function repoRank(repo) {
  const i = repositoryPriority.value.indexOf(repo.toLowerCase());
  return i === -1 ? repositoryPriority.value.length : i;
}

// A raw filesystem path or a generic branch is noise as a subtitle — drop it so the
// row falls back to nothing (cleaner) rather than echoing "/tmp/…md" or "main".
function isNoisySub(t) {
  return /^[~/]/.test(t) || /\/[^\s/]+\/[^\s/]+/.test(t) || GENERIC_BRANCH.has(t);
}
// Slug for comparing a branch against the row title — lowercased, non-alnum → hyphen.
function slug(x) {
  return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Secondary line: a meaningful summary if we have one; otherwise a real branch name.
// Never a filesystem path, a generic branch ("main"), a repeat of the title, or a branch
// that merely echoes the name ("add-tomba" / "add-tomba-as-enrichment-provider") — all
// noise, so the row falls back to just the name (cleaner than echoing junk).
function subLine(s) {
  const sum = (s.summary || "").replace(/\s+/g, " ").trim();
  if (sum && sum !== listTitle(s) && !isNoisySub(sum)) return sum;
  if (GENERIC_BRANCH.has(s.branch)) return "";
  const name = slug(listTitle(s));
  const branch = slug(s.branch);
  if (name && (branch === name || branch.startsWith(name + "-"))) return "";
  return s.branch;
}

function modifiedMs(s) {
  // Same source as the displayed age (last conversational turn), so the order matches
  // what the rows read rather than following file-mtime noise.
  const t = activityAt(s) ? new Date(activityAt(s)).getTime() : NaN;
  return Number.isFinite(t) ? t : 0; // unknown recency → oldest → bottom
}

// Order for the attention queue: priority first (blocked, then status rank), then
// most-recently-used; older sessions sink to the bottom. (The home list itself renders
// the server's pre-sectioned inbox order.)
function compareSessions(a, b) {
  return (
    (a.unread ? 0 : 1) - (b.unread ? 0 : 1) ||
    (a.pending ? 0 : 1) - (b.pending ? 0 : 1) ||
    (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
    modifiedMs(b) - modifiedMs(a)
  );
}

// Unread sessions — the "go read" queue (monitor's ⚡: completed turns + blocks).
function attentionSessions() {
  return sessions.value.filter((s) => s.unread).sort(compareSessions);
}

// Triage forward: jump to the next session needing attention (cycling past the
// current one); if none remain, fall back to the list. This — not linear up/down — is
// how you work a queue of blocked sessions from the phone.
function gotoNextAttention() {
  const queue = attentionSessions();
  const others = queue.filter((s) => s.id !== selectedId.value);
  if (others.length === 0) return back();
  const cur = queue.findIndex((s) => s.id === selectedId.value);
  const next = cur >= 0 ? queue[(cur + 1) % queue.length] : queue[0];
  open(next.id);
}

// Token-usage readout, mirroring the Mac statusline (current/size pct%), colored at
// the same 50/75% thresholds.
function usageColor(p) {
  return p > 75 ? "var(--red)" : p > 50 ? "var(--peach)" : "var(--mint)";
}

// When a session last did something. `lastTurn` is its newest conversational turn;
// `modified` (the transcript's file mtime) is the fallback — bookkeeping writes and
// bulk resumes push mtime forward with no conversation behind them, so it only stands
// in when the turn timestamp is unavailable (fixtures, or an older server).
function activityAt(s) {
  return s.lastTurn || s.modified;
}

// Concise "time since last activity" — the list column the Mac shows as token %
// (which says nothing about recency). Reading `tick` makes every age re-render on the
// clock below, not only when a refetch replaces the session list.
function formatAge(iso) {
  return formatTimeAgo(iso, { now: tick.value, verbose: true });
}

// Row title mirrors `claude0 list`: the tmux-style AI name (repo is the group header, so
// just the name). Falls back to the summary/branch label only when unnamed.
function listTitle(s) {
  return s.name || s.label || s.branch || s.id.slice(0, 8);
}

// Mirrors the static boot spinner in index.html exactly, so when Preact mounts and
// replaces #app the spinner doesn't visibly jump or restart mid-spin.
function Spinner() {
  return html`
    <div class="center">
      <div class="spinner"></div>
      <div class="loadtext">connecting</div>
    </div>
  `;
}

function Login() {
  let value = "";
  return html`
    <div class="center login">
      <h1 class="brand">portkey</h1>
      <div class="brandsub">enter your bridge token to connect</div>
      <input
        type="password"
        autocomplete="off"
        placeholder="bridge token"
        onInput=${(e) => (value = e.target.value)}
        onKeyDown=${(e) => e.key === "Enter" && login(value)}
      />
      <button class="primary" onClick=${() => login(value)}>Connect</button>
      ${error.value && html`<div class="err">${error.value}</div>`}
    </div>
  `;
}

// Last-known scroll offset of the session list, recorded as the user scrolls and
// re-applied when the list re-mounts. Not persisted: it lives for the page's life only.
let listScrollTop = 0;

function List() {
  const all = sessions.value;
  // Restore the list's scroll offset on re-mount (back from a session/history/new-session
  // — the list unmounts while a detail screen shows). Offset, not row: the list live-sorts
  // between visits, so an approximate position beats chasing a moved row. Module-level on
  // purpose — a fresh app launch starts at the top, where attention-first sorting belongs.
  const scrollRef = useRef(null);
  // Layout effect: apply before paint, so the list never flashes a top-of-list frame.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && listScrollTop > 0) el.scrollTop = listScrollTop; // browser clamps a too-large offset
  }, []);
  // Inbox (ADR 0013): rows arrive pre-ordered and pre-sectioned from the server
  // (`inbox.section` per row, payload order = the store's sort) — the client groups
  // by DISPLAYED section: the server tag rerouted between needs-you and running when
  // the row's effective status contradicts it (`displaySection` in shared/sync.js).
  // Status is the fresher fact — the optimistic overlay right after a verb, then the
  // bridge's live capture — while the section tag trails the daemon's 3s snapshot,
  // so a just-sent session files under Running immediately instead of sitting in
  // Needs You until the next snapshot push. Empty sections are omitted; rows
  // without `inbox` (idle panes, History-bound archived) don't show here.
  const SECTIONS = [
    ["needs-you", "needs you"],
    ["running", "running"],
    ["parked", "parked"],
    ["done", "recently done"],
  ];
  const inboxGroups = SECTIONS.map(([key, title]) => {
    // rows keep the server's order within their displayed section: deriveSections owns
    // the needs-you band sort (question/approval first), shared with the sidebar
    const rows = all.filter((s) => s.inbox && displaySection(s.inbox.section, s.status, s.pendingScripts) === key);
    return { key, title, rows };
  }).filter((g) => g.rows.length > 0);
  const renderInboxRow = (s) => {
    const ib = s.inbox;
    // Sub-line = repo + the parked detail (wake countdown / block note) only. The
    // summary is deliberately absent: sections mix repos so every row already pays for
    // a repo label, and truncated first-prompt fragments read as bloat at a glance.
    const parked = ib.section === "parked";
    const blocked = ib.note != null;
    const repo = s.repo === "~" ? "home" : s.repo;
    const detail = parked
      ? blocked
        ? ib.note
        : ib.wakeAt
          ? `in ${formatWakeIn(ib.wakeAt, tick.value)}`
          : ""
      : "";
    const sub = detail ? `${repo} · ${detail}` : repo;
    // Marks are inline prefixes of the name (like ⏳/☾ always were) — a reserved dot
    // column read as an empty gutter on rows with nothing to say. Pending/unread keep
    // the glowing dot, running keeps its mint, parked shows its state glyph.
    // Row marks speak the tmux window-name vocabulary (⚡ unread, ⏳ script-waiting)
    // and mark the EXCEPTION, never the section's default — a running row inside
    // RUNNING carries nothing, ⏳ earns its place by contradicting the section
    // ("looks running, the AI is actually done"). Marks stack (⚡ is the "have I
    // seen it" axis); the only dot left is the pending alarm.
    // A running session can't be waiting on an answer/approve — a lingering
    // `pending` is snapshot staleness (the verb that started the turn consumed it).
    const pending = s.status === "running" ? null : s.pending;
    const mark = parked
      ? html`<span class="markglyph">${blocked ? "✗" : "☾"}</span>`
      : pending
        ? html`<span class="markdot" style=${dotStyle(s)}></span>`
        : null;
    const zap = s.unread && html`<span class="zapmark" title="unread">⚡</span>`;
    return html`
      <button
        type="button"
        class="row inboxrow ${ib.section === "done" ? "done" : ""}"
        key=${s.id}
        ...${rowPress(s)}
        onContextMenu=${(e) => e.preventDefault()}
      >
        <span class="grow">
          <span class="name"
            >${zap}${mark}${ib.woken && html`<span class="wokemark" title="snooze came due">☾</span>`}${s.pendingScripts >
              0 &&
            html`<span class="scriptmark" title="waiting on a background script">⏳</span>`}${listTitle(s)}</span
          >
          ${sub && html`<span class="sub">${sub}</span>`}
        </span>
        ${pending &&
        html`<span class="pendingbadge ${pending === "question" ? "q" : "a"}"
          >${pending === "question" ? "answer" : "approve"}</span
        >`}
        <span class="age">${formatTimeAgo(new Date(ib.since).toISOString(), { now: tick.value })}</span>
      </button>`;
  };
  return html`
    <div class="screen">
      <div class="scroll" ref=${scrollRef} onScroll=${(e) => (listScrollTop = e.currentTarget.scrollTop)}>
        <div class="listhead">
          <h1>portkey</h1>
          ${pushEligible.value &&
          html`<button class="bellbtn" onClick=${enablePush} aria-label="Enable notifications">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
          </button>`}
          <button class="histbtn" onClick=${openHistory} aria-label="Session history">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 3" />
            </svg>
          </button>
          <button class="newbtn" onClick=${openNewSession} aria-label="New session">+</button>
        </div>
        ${error.value && error.value !== "bridge unreachable" && html`<div class="err">${error.value}</div>`}
        ${launching.value && html`<div class="sub" style="padding:4px 4px 10px">launching ${launching.value}…</div>`}
        ${inboxStale.value &&
        html`<div class="staleband">inbox snapshot is stale — showing last known state</div>`}
        ${listStale.value &&
        html`<div class="staleband">list may be out of date — syncing…</div>`}
        ${inboxAware.value &&
        inboxGroups.length === 0 &&
        html`<div class="sub" style="padding:8px">inbox zero — nothing needs you</div>`}
        ${inboxGroups.map(
          (g) => html`
            <div class="group inboxsec" key=${g.key}>
              ${g.key === "done"
                ? html`<button
                    class="repo donesec donetoggle"
                    onClick=${() => (showDone.value = !showDone.value)}
                  >
                    <span class="chev">${showDone.value ? "▾" : "▸"}</span> ${g.title} · ${g.rows.length}
                  </button>`
                : html`<div
                    class="repo ${g.key === "running"
                      ? "runsec"
                      : g.key !== "needs-you"
                        ? ""
                        : g.rows.some((r) => r.pending || r.status === "waiting")
                          ? "needsyou"
                          : "needsyou soft"}"
                  >
                    ${g.title} · ${g.rows.length}
                  </div>`}
              ${(g.key !== "done" || showDone.value) && g.rows.map(renderInboxRow)}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}


// New-session repo picker: tap a base repo to launch `claude` in a new tmux window on
// its current branch; tap a nested worktree to launch there instead. Worktrees render
// indented under their base repo (the list arrives base-then-worktrees, in order).
function NewSession() {
  const list = repos.value;
  const { rootRef } = useSwipeBack(() => (showNewSession.value = false));
  return html`
    <div class="screen" ref=${rootRef}>
      <div class="listhead">
        <button class="iconbtn" onClick=${() => (showNewSession.value = false)} aria-label="Back">‹</button>
        <h1 style="margin:0">new session</h1>
      </div>
      <div class="scroll">
        ${error.value && error.value !== "bridge unreachable" && html`<div class="err">${error.value}</div>`}
        ${list === null && html`<div class="sub" style="padding:8px">loading repos…</div>`}
        ${list && list.length === 0 && html`<div class="sub" style="padding:8px">no repos found</div>`}
        ${list &&
        list.map((r) => {
          // Worktree: just the branch name, indented under its base repo (left-rail + indent
          // signal the nesting — no marker, no path).
          if (r.isWorktree) {
            return html`
              <button type="button" class="row wt" key=${r.path} onClick=${() => launchSession(r)}>
                <span class="grow"><span class="name">${r.branch}</span></span>
              </button>
            `;
          }
          // Base repo (and the "~" home entry): a "+" marker + the name.
          return html`
            <button type="button" class="row" key=${r.path} onClick=${() => launchSession(r)}>
              <span class="addmark">+</span>
              <span class="grow"><span class="name">${r.name}</span></span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

// Day bucket label for History browse mode: today / yesterday / "fri 18 jul".
function dayLabel(iso, now) {
  const d = new Date(iso);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date(now)) - startOf(d)) / 86400000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return d
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    .toLowerCase()
    .replace(/,/g, "");
}

// Snippet text with the first query word that appears in it wrapped for highlight —
// the "why did this row match" cue. Built as elements, never raw HTML.
function highlightSnippet(snippet, query) {
  const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const lower = snippet.toLowerCase();
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i === -1) continue;
    return html`${snippet.slice(0, i)}<span class="hl">${snippet.slice(i, i + w.length)}</span>${snippet.slice(i + w.length)}`;
  }
  return snippet;
}

// History: the windowless archive. Browse = day-grouped by recency with infinite
// scroll; search = one flat relevance-ranked page with match snippets. Repo chips
// narrow either mode. Rows open the (read-only) thread; restore lives in its dock.
function History() {
  const h = history.value;
  const q = historyQuery.value.trim();
  const { rootRef } = useSwipeBack(() => (showHistory.value = false));
  const rows = h ? h.rows : [];

  // Chips: pinned repos first (same order the list uses), then by match count. The
  // server only facets repos under configured repository roots — temp/scratch clones get no chip.
  const chips = h
    ? [...h.repos].sort((a, b) => repoRank(a.repo) - repoRank(b.repo) || b.count - a.count || a.repo.localeCompare(b.repo))
    : [];

  const loadMore = async () => {
    if (!h || !h.before || historyMore.value) return;
    historyMore.value = true;
    await refreshHistory({ before: h.before });
    historyMore.value = false;
  };
  const onScroll = (e) => {
    const el = e.target;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) loadMore();
  };

  const renderRow = (row) => {
    const title = row.name || row.summary || row.branch || row.id.slice(0, 8);
    // Search shows WHY it matched; browse shows how the session ended (or its summary).
    // Never echo the title as the sub-line.
    const rawSub = q && row.matchSnippet ? row.matchSnippet : row.lastAssistant || row.summary || "";
    const sub = rawSub && rawSub !== title ? rawSub : "";
    return html`
      <button type="button" class="row" key=${row.id} onClick=${() => openHistoryRow(row)}>
        <span
          class="dot"
          style=${`background:${row.isActive ? "var(--mint)" : "transparent"};box-shadow:inset 0 0 0 1.5px ${
            row.isActive ? "var(--mint)" : "rgba(180,180,180,0.55)"
          }`}
        ></span>
        <span class="grow">
          <span class="name">${title}<span class="repotag">${row.repo === "~" ? "home" : row.repo}</span></span>
          ${sub && html`<span class="sub">${q && row.matchSnippet ? highlightSnippet(sub, q) : sub}</span>`}
        </span>
        <span class="age">${formatAge(row.modified)}</span>
      </button>`;
  };

  // Browse mode groups by day (counts are of loaded rows; they fill in as you scroll).
  // Search results stay flat: relevance order isn't chronological.
  const groups = [];
  if (!q) {
    for (const row of rows) {
      const label = dayLabel(row.modified, tick.value);
      let g = groups[groups.length - 1];
      if (!g || g.label !== label) groups.push((g = { label, rows: [] }));
      g.rows.push(row);
    }
  }

  return html`
    <div class="screen" ref=${rootRef}>
      <div class="listhead">
        <button class="iconbtn" onClick=${() => (showHistory.value = false)} aria-label="Back">‹</button>
        <h1 style="margin:0">history</h1>
      </div>
      <div class="histsearch">
        <input
          type="search"
          placeholder="search sessions…"
          value=${historyQuery.value}
          onInput=${(e) => setHistoryQuery(e.target.value)}
        />
      </div>
      ${chips.length > 1 &&
      html`<div class="chips">
        <button class=${historyRepo.value === "" ? "chip on" : "chip"} onClick=${() => setHistoryRepo("")}>all</button>
        ${chips.map(
          (c) => html`<button
            key=${c.repo}
            class=${historyRepo.value === c.repo ? "chip on" : "chip"}
            onClick=${() => setHistoryRepo(historyRepo.value === c.repo ? "" : c.repo)}
          >
            ${c.repo === "~" ? "home" : c.repo}<span class="chipcount">${c.count}</span>
          </button>`,
        )}
      </div>`}
      <div class="scroll" onScroll=${onScroll}>
        ${h === null && html`<div class="sub" style="padding:8px">loading history…</div>`}
        ${h !== null && rows.length === 0 && html`<div class="sub" style="padding:8px">${q ? "no matches in titles, prompts or transcript ends" : "no sessions"}</div>`}
        ${q
          ? rows.map(renderRow)
          : groups.map(
              (g) => html`
                <div class="group" key=${g.label}>
                  <div class="repo">${g.label}<span class="daycount">${g.rows.length}</span></div>
                  ${g.rows.map(renderRow)}
                </div>
              `,
            )}
        ${historyMore.value && html`<div class="sub" style="padding:8px">loading…</div>`}
      </div>
    </div>
  `;
}

// A folded `!` bash turn: right-aligned peach mono command bubble, then the output as a
// full-width rail — stdout mint (clamped at 8 lines behind a tap-to-expand row), stderr
// red after it. Output is literal text, never markdown. Empty output renders nothing
// (killed mid-command, or a genuinely silent command).
const BASH_CLAMP_LINES = 8;
function BashTurn({ bash, upCount, canCode }) {
  const [expanded, setExpanded] = useState(false);
  const lines = bash.stdout ? bash.stdout.split("\n") : [];
  const clamped = !expanded && lines.length > BASH_CLAMP_LINES;
  const shown = clamped ? lines.slice(0, BASH_CLAMP_LINES).join("\n") : bash.stdout;
  return html`<div class="turn">
    <div class="bang-cmd" ...${lpProps(lpStart("!" + bash.command, upCount, canCode))}>
      <span class="glyph">!</span>${bash.command}
    </div>
    ${bash.stdout && html`<div class="bang-out"><pre>${shown}</pre></div>`}
    ${clamped &&
    html`<div class="bang-more" onClick=${() => setExpanded(true)}>
      … +${lines.length - BASH_CLAMP_LINES} lines
    </div>`}
    ${bash.stderr && html`<div class="bang-out err"><pre>${bash.stderr}</pre></div>`}
    <div class="bang-gap"></div>
  </div>`;
}

// The harness assigns each teammate a color name so multi-agent chatter scans by
// sender; map the names onto the Vesper-adjacent tokens (unknown names → muted).
const TM_COLORS = {
  green: "var(--mint)",
  yellow: "var(--yellow)",
  red: "var(--red)",
  orange: "var(--peach)",
  pink: "var(--red)",
  blue: "var(--tm-blue)",
  cyan: "var(--tm-blue)",
  purple: "var(--tm-purple)",
};

// A substantive teammate message (it carries a summary): a bylined left bubble —
// colored sender id + chevron, the summary as the readable line, and the full payload
// behind the chevron. JSON bodies pretty-print; anything else renders as markdown
// (reports are agent prose, same trust level as assistant output). The toggle lives on
// the byline+summary only, so selecting text in an expanded body can't collapse it.
// Head preview for agent-message reports, which carry no summary — first non-empty
// body line, ellipsized so a long opening sentence doesn't balloon the collapsed row.
function firstLine(body) {
  const line = (body.split("\n").find((l) => l.trim()) || "").trim();
  return line.length > 120 ? line.slice(0, 120) + "…" : line;
}

function TeammateRow({ msg }) {
  const [open, setOpen] = useState(false);
  const tint = TM_COLORS[msg.color] || "var(--muted)";
  let body = msg.body;
  let isJson = false;
  try {
    body = JSON.stringify(JSON.parse(msg.body), null, 2);
    isJson = true;
  } catch {}
  return html`<div class="tm-bubble" style=${`border-left-color:${open ? tint : "var(--border)"}`}>
    <div class="tm-head" onClick=${() => setOpen(!open)}>
      <div class="tm-byline"><span style=${`color:${tint}`}>🤝 ${msg.id}</span><span class="tm-chev">${open ? "▾" : "▸"}</span></div>
      <div class="tm-sum">${msg.summary || firstLine(msg.body)}</div>
    </div>
    ${open &&
    (isJson
      ? html`<pre class="tm-body">${body}</pre>`
      : html`<div class="tm-body md" dangerouslySetInnerHTML=${{ __html: md(body) }}></div>`)}
  </div>`;
}

// A command-carrying chip (Bash) clamps its command to one ellipsized line — tapping
// toggles the full command, wrapped, so the reader can check what actually ran.
function CommandChip({ name, command }) {
  const [open, setOpen] = useState(false);
  return html`<div class=${open ? "tool open" : "tool"} onClick=${() => setOpen(!open)}>▸ ${name} <span class="arg">${command}</span></div>`;
}

// One conversational turn → a sequence of chat elements: text blocks become
// bubbles (user right / assistant left), tool calls become compact chips, image
// attachments become a 🖼 marker; thinking and tool_result blocks are omitted.
function Turn({ turn, upCount, canCode }) {
  // Post-compaction summary: render as a labeled, full-width system divider — not a giant
  // user bubble — so it reads as "this branch continued from a compact" rather than the user
  // having pasted a wall of text. Body is collapsed by default (it's long) but kept verbatim.
  if (turn.compactSummary) {
    const text = (turn.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    return html`<div class="turn">
      <details class="compact-summary">
        <summary>↻ Continued from compacted summary</summary>
        <div class="md" dangerouslySetInnerHTML=${{ __html: md(text) }}></div>
      </details>
    </div>`;
  }

  // An executed slash command — rendered as a normal user bubble showing exactly what was
  // typed, matching the terminal (which echoes the command as your prompt line). Not a
  // rewind checkpoint (content is empty, so isPromptTurn already excludes it), hence no
  // long-press rewind handlers.
  if (turn.command) {
    return html`<div class="turn"><div class="bubble user">${turn.command}</div></div>`;
  }

  // A `!` bash command (input + output records folded into one turn by the parser).
  // Unlike slash commands, a bash turn IS a rewind checkpoint (Claude's picker lists it),
  // so the command bubble gets the full user long-press: rewind targets the checkpoint
  // and the prefill restores the literal `!cmd` the user typed.
  if (turn.bash) {
    return html`<${BashTurn} bash=${turn.bash} upCount=${upCount} canCode=${canCode} />`;
  }

  // Teams mailbox delivery — a teammate session's message injected as a user record,
  // never a user bubble: the human didn't type it. Messages carrying a summary are
  // reports worth reading (bylined bubble); bare idle pings are plumbing, collapsed to
  // one near-invisible line per turn. No long-press handlers — no text to restore.
  if (turn.teammate) {
    // Idle = a bare idle_notification ping without a lifted summary. "No summary" alone
    // isn't enough: agent-message reports carry no summary attribute but are real content.
    const isIdle = (m) => !m.summary && /"type"\s*:\s*"idle_notification"/.test(m.body);
    const reports = turn.teammate.filter((m) => !isIdle(m));
    const idle = turn.teammate.filter(isIdle);
    return html`<div class="turn">
      ${reports.map((m, i) => html`<${TeammateRow} key=${i} msg=${m} />`)}
      ${idle.length > 0 &&
      html`<div class="tm-idle">
        ${idle.map(
          (m, i) =>
            html`<span style=${`color:${TM_COLORS[m.color] || "var(--dim)"}`}>${m.id}</span>${i < idle.length - 1 ? ", " : ""}`,
        )}
        ${" went idle"}
      </div>`}
    </div>`;
  }

  // Interrupt / system markers ("[Request interrupted by user…]") render as a dim event
  // line, never a user bubble — they're not typed messages and aren't rewind checkpoints.
  const marker = turnMarkerText(turn);
  if (marker) {
    return html`<div class="turn"><div class="sysline">⊘ ${marker.replace(/^\[|\]$/g, "")}</div></div>`;
  }

  const role = turn.role === "user" ? "user" : "assistant";
  const els = [];
  for (const b of turn.content || []) {
    if (b.type === "image") {
      els.push(html`<div class="imgmark">🖼 image</div>`);
      continue;
    }
    // User captions arrive prefixed with literal "[Image #N]" markers — strip for display
    // (the 🖼 chip already conveys the image; keep the raw text for long-press/rewind).
    const shown = b.type === "text" ? (role === "user" ? stripImagePrefix(b.text) : b.text) : "";
    if (b.type === "text" && shown && shown.trim()) {
      // Assistant text is markdown-rendered; user text stays literal (it's what you typed).
      els.push(
        role === "assistant"
          ? html`<div
              class="bubble assistant md"
              onClick=${assistantTap}
              ...${lpProps(lpStartAsst(b.text))}
              dangerouslySetInnerHTML=${{ __html: md(shown) }}
            ></div>`
          : html`<div
              class="bubble user"
              ...${lpProps(lpStart(b.text, upCount, canCode))}
            >${shown}</div>`,
      );
    } else if (b.type === "tool_use") {
      const input = b.input || {};
      const path = editedPath(input);
      const skill = input.skill ? `${input.skill}${input.args ? ` ${input.args}` : ""}` : "";
      const arg = input.command || path || input.pattern || skill || "";
      if ((EDIT_TOOLS.has(b.name) || b.name === "Read") && path) {
        // Edit/Read chips are informational — diffs live on the changed-files page, which
        // doesn't depend on a per-chip path resolving inside the session's repo (a
        // removed worktree or scratchpad edit never can). What the chip owes the reader
        // is the FILENAME: the dir shrinks (dimmed, ellipsized) and the basename never
        // does — the same treatment as the changed-files list.
        const p = path.replace(/^\/Users\/[^/]+\//, "~/");
        const slash = p.lastIndexOf("/");
        const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
        const base = slash >= 0 ? p.slice(slash + 1) : p;
        els.push(
          html`<div class="tool edit">
            <span class="tname">▸ ${b.name}</span
            ><span class="fl-dir">${dir}</span><span class="fl-base">${base}</span>
          </div>`,
        );
      } else if (input.command) {
        els.push(html`<${CommandChip} name=${b.name || "tool"} command=${input.command} />`);
      } else {
        els.push(html`<div class="tool">▸ ${b.name || "tool"}${arg && html` <span class="arg">${arg}</span>`}</div>`);
      }
    }
  }
  return els.length ? html`<div class="turn">${els}</div>` : null;
}

// The server's /answer takes one selection PER QUESTION (a prompt may carry several):
// each entry is a number (single-select) or number[] (multi-select), in question order.
function QuestionCard({ questions, toolUseId }) {
  // Optimistic: drop the card the instant an option is tapped — the composer takes the
  // dock immediately instead of waiting out the POST + transcript refetch. Reverts with
  // a bespoke message on failure. Raw fetch (not action(), which auto-flashes the raw
  // reason code). After a SUCCESSFUL answer there is no idle transcript poll and a
  // swallowed answer produces no SSE event, so a verify timer drives the refetch: if
  // the SAME question is still open ~8s after the server accepted, the answer didn't
  // land — re-show the card so the user can retry, instead of hiding it forever.
  // (The old blind 5s timer re-showed the card during ordinarily-slow successful
  // resolutions, inviting the double-tap this replaced.)
  const post = (selections) => {
    const id = selectedId.value;
    decidingQuestion.value = { id, toolUseId };
    // An answered question resumes the turn — optimistic running, like a send.
    setStatusOverlay(id, "running");
    const active = () => {
      const dq = decidingQuestion.value;
      return dq && dq.id === id && dq.toolUseId === toolUseId;
    };
    fetch(`/sessions/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selections, toolUseId }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (!active()) return; // reconciled or superseded while the POST was in flight
        if (d && d.ok) {
          refreshTranscriptSoon();
          refreshSessionsSoon();
          setTimeout(() => {
            if (!active()) return;
            if (selectedId.value !== id) return (decidingQuestion.value = null); // left the session
            refreshTranscript().then(() => {
              if (!active()) return; // the refetch reconciled it — answer landed
              decidingQuestion.value = null;
              flashError("✗ answer may not have landed — try again");
            });
          }, 8000);
        } else {
          decidingQuestion.value = null;
          clearStatusOverlay(id); // the answer didn't land — no turn is resuming
          const reason = (d && d.reason) || "answer failed";
          if (reason === "stale-question") {
            flashError("✗ question changed — refreshing");
            refreshTranscript();
          } else if (reason === "not-presented") {
            flashError("✗ couldn't reach the prompt — check the Mac");
          } else {
            flashError(`✗ ${reason}`);
          }
        }
      })
      .catch(() => {
        if (active()) decidingQuestion.value = null;
        clearStatusOverlay(id);
        flashError("✗ bridge unreachable");
      });
  };
  // "Chat about this": decline the whole prompt (regardless of wizard step) so the agent
  // yields and waits for a typed message. Optimistically flip to the composer + focus it;
  // a bare fetch (not action(), whose refreshTranscript would flicker the card back before
  // the deny resolves) drives the server, reverting only on failure.
  const chat = () => {
    const id = selectedId.value;
    clarifying.value = id;
    composerPrefill.value = { text: "", sessionId: id }; // focus composer → raise keyboard
    const revert = (reason) => {
      flashError(`✗ ${reason}`);
      if (clarifying.value === id) clarifying.value = null;
    };
    fetch(`/sessions/${encodeURIComponent(id)}/clarify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        // not-presented = the question isn't answerable right now (picker not on
        // screen, a permission prompt is up, or someone's typing in it at the desk) —
        // say so rather than echo the code.
        if (d && d.ok === false) {
          revert(d.reason === "not-presented" ? "question is busy on the desk — try again" : d.reason || "clarify failed");
          return;
        }
        // The deny resolving produces no reliable broadcast, so drive the reconcile
        // ourselves — same shape as the answer path's verify timer. The old blind 5s
        // timeout re-showed the card from STALE data whenever nothing had refetched in
        // between; only a question still open in a fresh transcript may re-show it.
        refreshTranscriptSoon();
        setTimeout(() => {
          if (clarifying.value !== id) return; // reconciled — the question resolved
          if (selectedId.value !== id) return (clarifying.value = null); // left the session
          refreshTranscript().then(() => {
            if (clarifying.value !== id) return; // the refetch reconciled it — deny landed
            clarifying.value = null;
            flashError("✗ chat about this may not have landed — try again");
          });
        }, 8000);
      })
      .catch(() => revert("bridge unreachable"));
  };
  return html`
    <div class="qwrap">
      ${questions.length > 1
        ? html`<${MultiQuestionCard} questions=${questions} post=${post} />`
        : html`<${SingleQuestionCard} q=${questions[0]} post=${post} />`}
      <button class="chat-about" onClick=${chat}>💬 Chat about this</button>
    </div>
  `;
}

// Single question — multiSelect: accumulate a set + explicit Submit. single-select:
// tap an option to answer immediately. Options scroll in a capped card (#2).
function SingleQuestionCard({ q, post }) {
  const multi = q.multiSelect;
  const [sel, setSel] = useState(() => new Set());
  const toggle = (i) => {
    const next = new Set(sel);
    next.has(i) ? next.delete(i) : next.add(i);
    setSel(next);
  };
  return html`
    <div class="card alert qcard">
      <div class="who">question${multi ? " · select all that apply" : ""}</div>
      <div class="qtext">${q.question}</div>
      <div class="opts">
        ${q.options.map(
          (o, i) => html`
            <button
              class="opt ${multi && sel.has(i) ? "sel" : ""}"
              key=${i}
              onClick=${() => (multi ? toggle(i) : post([i]))}
            >
              <span class="opt-head">
                ${multi && html`<span class="opt-check">${sel.has(i) ? "☑" : "☐"}</span>`}
                <span class="opt-label">${o.label}</span>
              </span>
              ${o.description && html`<span class="opt-desc">${o.description}</span>`}
              ${o.preview && html`<pre class="opt-preview">${o.preview}</pre>`}
            </button>
          `,
        )}
      </div>
      ${multi &&
      html`<button
        class="opt-submit"
        disabled=${sel.size === 0}
        onClick=${() => post([[...sel].sort((a, b) => a - b)])}
      >
        Submit${sel.size ? ` (${sel.size})` : ""}
      </button>`}
    </div>
  `;
}

// Multi-question wizard — one question per screen, Back/Next, final Submit posts a
// per-question selection array. single-select = tap-to-select; multi-select = checkboxes.
// Submit needs every single-select answered (a multi-select may be left empty).
function MultiQuestionCard({ questions, post }) {
  const [step, setStep] = useState(0);
  // picks[i]: a number (single-select, null until chosen) or a Set (multi-select).
  const [picks, setPicks] = useState(() => questions.map((q) => (q.multiSelect ? new Set() : null)));
  const q = questions[step];
  const multi = q.multiSelect;
  const pick = picks[step];
  const last = step === questions.length - 1;

  const update = (next) => {
    const copy = picks.slice();
    copy[step] = next;
    setPicks(copy);
  };
  const toggle = (i) => {
    const next = new Set(pick);
    next.has(i) ? next.delete(i) : next.add(i);
    update(next);
  };
  const ready = questions.every((qq, i) => (qq.multiSelect ? true : picks[i] != null));
  const submit = () =>
    post(questions.map((qq, i) => (qq.multiSelect ? [...picks[i]].sort((a, b) => a - b) : picks[i])));

  return html`
    <div class="card alert qcard">
      <div class="who">
        question ${step + 1} of ${questions.length}${multi ? " · select all that apply" : ""}
      </div>
      <div class="qtext">${q.question}</div>
      <div class="opts">
        ${q.options.map(
          (o, i) => html`
            <button
              class="opt ${multi ? (pick.has(i) ? "sel" : "") : pick === i ? "sel" : ""}"
              key=${i}
              onClick=${() => (multi ? toggle(i) : update(i))}
            >
              <span class="opt-head">
                ${multi
                  ? html`<span class="opt-check">${pick.has(i) ? "☑" : "☐"}</span>`
                  : html`<span class="opt-check">${pick === i ? "◉" : "◯"}</span>`}
                <span class="opt-label">${o.label}</span>
              </span>
              ${o.description && html`<span class="opt-desc">${o.description}</span>`}
              ${o.preview && html`<pre class="opt-preview">${o.preview}</pre>`}
            </button>
          `,
        )}
      </div>
      <div class="qnav">
        <button class="opt-submit" disabled=${step === 0} onClick=${() => setStep(step - 1)}>
          Back
        </button>
        ${last
          ? html`<button class="opt-submit" disabled=${!ready} onClick=${submit}>Submit</button>`
          : html`<button class="opt-submit" onClick=${() => setStep(step + 1)}>Next</button>`}
      </div>
    </div>
  `;
}

// Commands that can lose data / escalate / hit the network — surfaced loudly so a
// remote, eyes-off approval isn't a same-looking tap as a harmless one.
const DESTRUCTIVE = /\b(rm\s+-[a-z]*[rf]|rmdir|git\s+(push|reset|clean)|sudo|dd\b|mkfs|chmod\s+-R|chown\s+-R|truncate|shutdown|reboot|kill(all)?)\b|>\s*\/|:\(\)\s*\{/;

function ApprovalCard({ approval }) {
  const input = approval.input || {};
  const detail = input.command || input.file_path || "";
  const risky = typeof input.command === "string" && DESTRUCTIVE.test(input.command);
  // Optimistic: clear the card on tap (Allow flips the dock to the running tool / composer
  // instantly); revert on failure, safety-timeout if the prompt somehow stays up.
  function decide(decision) {
    const id = selectedId.value;
    deciding.value = id;
    // Allow unblocks the tool — the turn resumes running; the overlay says so now
    // rather than after the server's recompute. (Deny also resumes: Claude continues
    // the turn with the refusal.)
    setStatusOverlay(id, "running");
    action(`/sessions/${encodeURIComponent(id)}/decision`, { decision }).then((ok) => {
      if (!ok) {
        clearStatusOverlay(id);
        if (deciding.value === id) deciding.value = null;
      }
    });
    setTimeout(() => {
      if (deciding.value === id) deciding.value = null;
    }, 5000);
  }
  return html`
    <div class="card alert">
      <div class="who ${risky ? "danger" : ""}">approve · ${approval.tool}</div>
      ${input.description && html`<div class="approve-desc">${input.description}</div>`}
      ${detail && html`<pre class=${risky ? "cmd-danger" : ""}>${detail}</pre>`}
      ${risky && html`<div class="risk-tag">⚠ destructive — review carefully</div>`}
      <div class="approve-btns">
        <button class="btn-deny" onClick=${() => decide("deny")}>Deny</button>
        <button class="btn-allow" onClick=${() => decide("allow")}>Allow</button>
      </div>
    </div>
  `;
}

// In-flight tool with NO decision required (e.g. auto-approved) — read-only info,
// never Allow/Deny.
function RunningTool({ tool }) {
  const detail = tool.command || tool.filePath || tool.pattern || "";
  return html`
    <div class="card">
      <div class="who">⦿ running — ${tool.name}</div>
      ${detail && html`<pre>${detail}</pre>`}
    </div>
  `;
}

// --- Composer drafts ---------------------------------------------------------
// Per-session draft persisted to localStorage, so leaving the detail view (the
// composer unmounts), an app reload, or an iOS PWA eviction never loses typed-but-
// unsent text. Written from syncHasText — the one choke point every el.value
// mutation already calls — so sending (value → "") clears the entry for free.
// Best-effort: storage failures are swallowed. Bounded to the newest 20 sessions.
const DRAFTS_KEY = "claude0-drafts";
function readDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveDraft(sid, text) {
  if (!sid) return;
  try {
    const drafts = readDrafts();
    if (text.trim()) drafts[sid] = { text, at: Date.now() };
    else delete drafts[sid];
    const ids = Object.keys(drafts).sort((a, b) => drafts[b].at - drafts[a].at);
    for (const id of ids.slice(20)) delete drafts[id];
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {}
}

// Free-text composer — available in any state (TUI parity: the bridge sends keys to
// the pane regardless of status; Claude queues input while running, accepts it at the
// prompt). Sent text shows immediately as an optimistic bubble until the transcript
// catches up. Enter sends, Shift+Enter / the multiline keyboard inserts a newline.
function Composer({ disabled, status }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const enterArmed = useRef(false); // true after a plain Enter — a second one submits
  const enterShift = useRef(false); // e.shiftKey of the latest Enter keydown
  const shiftRun = useRef(false); // inside a Shift+Enter run — suppress submit until a keystroke
  const pasteWasEmpty = useRef(false); // pre-paste field emptiness (input's e.data is null for pastes)
  const [hasText, setHasText] = useState(false); // drives the Stop⇄Send toggle; uncontrolled textarea
  const stopArmed = useRef(false); // first Stop tap arms; a second within 3s fires (double-tap confirm)
  const disarmTimer = useRef(null);
  // Bash mode: a typed leading "!" flips the composer into command mode — the "!" lifts
  // out of the text into an in-field glyph, and the textarea remounts (keyed by mode)
  // with autocorrect/spellcheck off, since iOS only honors those attributes at focus
  // time. `bashRef` mirrors the state for the native listeners; `carryRef` hands the
  // draft text + focus across the remount (writing to the outgoing node would be lost).
  const [bashMode, setBashMode] = useState(false);
  const bashRef = useRef(false);
  const carryRef = useRef(null); // { text, focus, scrollY } | null — applied by the effect below
  const trampRef = useRef(null); // hidden focus-holder for the mode-flip remount (see flipBashMode)
  // "/" slash-command menu. Kept in a ref (not state) so the once-attached native
  // beforeinput/keydown listeners below never read stale values; `rerender` repaints.
  const slash = useRef({ open: false, filtered: [], active: 0 });
  const slashCache = useRef(new Map()); // sid → fetched command list (one fetch per session)
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => (n + 1) & 0xffff);
  const sid = selectedId.value; // read in render so the component re-subscribes on session switch
  function grow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }
  // The textarea is uncontrolled, so hasText must be resynced at EVERY site that mutates
  // el.value — onInput fires for keystrokes, but selectSlash() and the failed-send restore
  // assign el.value directly (no native input event). Call this at all of them. The same
  // every-mutation invariant makes it the one place the persisted draft stays current.
  function syncHasText() {
    const el = ref.current;
    setHasText(!!(el && el.value.trim()));
    // In bash mode the "!" lives in the glyph, not the value — persist the full send
    // string so the draft survives a reload as the literal `!cmd` text.
    if (el) saveDraft(selectedId.value, bashRef.current && el.value ? "!" + el.value : el.value);
  }
  // Flip the composer's bash mode (remounting the keyed textarea). Two iOS traps live
  // here, both around the keyboard's above-keyboard pan of the page:
  // - scrollY: with the keyboard up iOS PANS the window so the dock sits above it, and
  //   a programmatic focus never re-applies that pan (only typing's caret-reveal does) —
  //   so capture the correct offset NOW, while the outgoing field still has it, and
  //   restore it after the swap.
  // - trampoline: if focus drops to <body> for the frame the swap takes, iOS releases
  //   the pan and re-applies it late — a visible vertical flicker. A hidden input inside
  //   the dock holds focus (same location → same pan) until the new field mounts.
  function flipBashMode(bang, text, focus) {
    bashRef.current = bang;
    carryRef.current = { text, focus, scrollY: window.scrollY };
    if (focus && trampRef.current) trampRef.current.focus({ preventScroll: true });
    setBashMode(bang);
  }
  function enterBash(carryText) {
    flipBashMode(true, carryText, true);
  }
  function exitBash({ text = "", focus = true } = {}) {
    flipBashMode(false, text, focus);
  }
  // Assign the textarea wholesale and resync everything derived from it (height,
  // Stop⇄Send toggle, persisted draft, bash mode). A text starting with "!" re-enters
  // bash mode — a bash draft is saved/restored as the full `!cmd` send string, and the
  // send string is identical either way, so the mode is purely presentational to restore.
  function setComposerText(text, opts = {}) {
    const bang = text.startsWith("!");
    // The mode flip remounts the keyed textarea, so the write must ride the carry
    // effect instead of landing on the outgoing node.
    if (bang !== bashRef.current) return flipBashMode(bang, bang ? text.slice(1) : text, !!opts.focus);
    const el = ref.current;
    if (!el) return;
    el.value = bang ? text.slice(1) : text;
    grow();
    syncHasText();
  }
  function disarmStop() {
    clearTimeout(disarmTimer.current);
    if (stopArmed.current) {
      stopArmed.current = false;
      rerender();
    }
  }
  // Double-tap Stop: first tap arms (relabels), a second within 3s interrupts. Firing sets
  // an optimistic "ready" STATUS OVERLAY so the button becomes Send this frame — the
  // overlay is applied over every incoming payload, so a snapshot computed pre-interrupt
  // can't flicker Stop back; it retires when the server shows non-running, or expires.
  // A bare POST (not action(), which would immediately refetch) sends the interrupt; the
  // server's reconciler pushes the real "ready" ~1.5-3s later.
  function onStop() {
    if (!stopArmed.current) {
      stopArmed.current = true;
      rerender();
      clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(disarmStop, 3000);
      return;
    }
    clearTimeout(disarmTimer.current);
    stopArmed.current = false;
    const id = selectedId.value;
    setStatusOverlay(id, "ready");
    // Arm restore-on-interrupt: if the refetched transcript shows the last-sent message
    // fell off the active branch, it comes back into the composer (see interruptRestore).
    const lastText = lastSentText.get(id);
    if (lastText) {
      interruptRestore.value = { sessionId: id, text: lastText, until: Date.now() + 8000 };
      // Focus NOW, inside the tap gesture — iOS only raises the keyboard for a focus that
      // is gesture-driven, and the restore resolves ~2s too late to qualify. The prefill
      // then lands in an already-focused box. If the restore never fires (mid-turn stop),
      // the raised keyboard is still where an interrupting user is headed next.
      if (ref.current) ref.current.focus();
    }
    const restore = (reason) => {
      flashError(`✗ ${reason}`);
      clearStatusOverlay(id); // failed → the true "running" resurfaces (Stop returns)
      interruptRestore.value = null; // the turn keeps running — nothing was handed back
    };
    fetch(`/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d && d.ok === false) restore(d.reason || "interrupt failed");
      })
      .catch(() => restore("bridge unreachable"));
  }
  function closeSlash() {
    if (!slash.current.open) return;
    slash.current.open = false;
    rerender();
  }
  async function loadSlashItems(id) {
    const cache = slashCache.current;
    if (cache.has(id)) return cache.get(id);
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(id)}/skills`);
      const data = r.ok ? await r.json() : [];
      const list = Array.isArray(data) ? data : [];
      cache.set(id, list);
      return list;
    } catch {
      return []; // fetch failed → menu simply never opens; composer keeps working
    }
  }
  // Fires on every keystroke (post-mutation value). This is an autocomplete aid, not a
  // command gate: it opens whenever a "/" + token is being typed at the end of the field
  // and the "/" sits at the start or right after whitespace (so paths like src/foo never
  // trigger). Closes otherwise. Selecting a row only replaces that "/"-token (see selectSlash).
  async function onInput(e) {
    grow();
    syncHasText();
    disarmStop(); // typing cancels an armed Stop
    const el = ref.current;
    if (!el) return;
    // A "!" opening an empty draft enters bash mode — typed, or pasted as the whole
    // draft (`!cmd` into an empty field; pasteWasEmpty is stamped by beforeinput, since
    // this event's e.data is null for pastes). Never mid-draft: a "!" typed or pasted
    // into existing text keeps its literal meaning, matching the pane. The "!" lifts
    // out of the text into the in-field glyph; the send string is identical either way.
    if (!bashRef.current && el.value === "!" && e && e.inputType === "insertText" && e.data === "!") {
      enterBash("");
      return closeSlash();
    }
    if (!bashRef.current && e && e.inputType === "insertFromPaste" && pasteWasEmpty.current && el.value.startsWith("!")) {
      enterBash(el.value.slice(1));
      return closeSlash();
    }
    if (bashRef.current) return; // no slash menu inside a shell command ("ls /tmp")
    const m = el.value.match(/(?:^|\s)\/(\S*)$/);
    if (!m || !sid) return closeSlash();
    const items = await loadSlashItems(sid);
    const m2 = el.value.match(/(?:^|\s)\/(\S*)$/); // re-validate: value may have changed during the await
    if (!m2) return closeSlash();
    const token = m2[1].toLowerCase();
    const filtered = items.filter((c) => c.name.toLowerCase().includes(token));
    slash.current = { open: filtered.length > 0, filtered, active: 0 };
    rerender();
  }
  function selectSlash(cmd) {
    const el = ref.current;
    if (!el || !cmd) return;
    // Autocomplete replaces only the "/"-token being typed (the trailing /\S* the menu
    // matched on), leaving any text before it intact — e.g. "use /som" → "use /some-skill ".
    // /model and /effort are intercepted into a native selection sheet instead of being sent
    // as text — the sheet drives the arg-form change and reports Claude's confirmation.
    if (cmd.name === "model" || cmd.name === "effort") {
      el.value = el.value.replace(/\/\S*$/, "");
      grow();
      syncHasText();
      slash.current.open = false;
      configSheet.value = { kind: cmd.name };
      rerender();
      return;
    }
    el.value = el.value.replace(/\/\S*$/, "/" + cmd.name + " "); // trailing space closes Claude's own native / menu in-pane
    grow();
    syncHasText();
    el.focus();
    slash.current.open = false;
    rerender();
  }
  async function onPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = ""; // allow re-picking the same file
    const added = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const blob = await downscale(f);
      added.push({ blob, url: URL.createObjectURL(blob) });
    }
    if (added.length) attachments.value = [...attachments.value, ...added];
  }
  function removeAttachment(url) {
    attachments.value = attachments.value.filter((a) => a.url !== url);
    URL.revokeObjectURL(url);
  }
  async function send() {
    const el = ref.current;
    if (!el) return;
    // Bash mode sends the full `!cmd` string (the glyph's "!" re-attached, command
    // trimmed so the optimistic bubble matches the folded turn's trimmed command) — the
    // pane enters shell mode from the literal text, exactly as if typed there. A bare
    // "!" with no command is nothing to send.
    const text = bashRef.current ? "!" + el.value.trim() : el.value;
    const items = attachments.value;
    if ((bashRef.current ? !el.value.trim() : !text.trim()) && items.length === 0) return;
    const sid = selectedId.value;
    el.value = "";
    grow();
    syncHasText();
    el.blur(); // drop focus so the soft keyboard dismisses on submit
    // Exit bash mode after dispatch; no refocus — the blur above dismissed the keyboard.
    if (bashRef.current) exitBash({ focus: false });
    // Optimistic status: a delivered message means the turn is (about to be) running —
    // don't wait for the server's recompute to say so. Retires on confirmation/expiry.
    setStatusOverlay(sid, "running");
    if (items.length === 0) {
      pendingSends.value = [...pendingSends.value, text];
      lastSentText.set(sid, text); // restore-on-interrupt candidate
      const ok = await action(`/sessions/${encodeURIComponent(sid)}/message`, { text });
      if (!ok) {
        clearStatusOverlay(sid); // never reached the pane — no turn is starting
        const idx = pendingSends.value.lastIndexOf(text);
        if (idx >= 0) pendingSends.value = pendingSends.value.filter((_, i) => i !== idx);
        lastSentText.delete(sid); // never reached the pane — an interrupt can't hand it back
        // Restore so nothing is silently lost (mirrors the image path below). If the user
        // navigated away mid-await the box belongs to another session (or is unmounted) —
        // persist under the sending session instead so the draft is waiting on return.
        if (selectedId.value === sid) setComposerText(text);
        else saveDraft(sid, text);
      }
      return;
    }
    // Image send: multipart upload + an optimistic bubble (thumbnails + caption) that the
    // transcript refresh retires once the real turn lands.
    const fd = new FormData();
    fd.append("text", text);
    items.forEach((it, i) => fd.append("image", it.blob, `image${i}.jpg`));
    const entry = { text, urls: items.map((it) => it.url) };
    pendingImageSends.value = [...pendingImageSends.value, entry];
    attachments.value = [];
    const ok = await actionForm(`/sessions/${encodeURIComponent(sid)}/message`, fd);
    if (!ok) {
      clearStatusOverlay(sid); // never reached the pane — no turn is starting
      // Restore so nothing is silently lost; keep the URLs alive for the retry.
      pendingImageSends.value = pendingImageSends.value.filter((e) => e !== entry);
      attachments.value = items;
      if (selectedId.value === sid) setComposerText(text);
      else saveDraft(sid, text);
    }
  }
  // Enter handling via NATIVE listeners (not Preact props) so the binding is unambiguous on
  // iOS. We act on `beforeinput` (inputType insertLineBreak/Paragraph) — the reliable Return
  // signal across iOS soft keyboards and hardware keyboards.
  //
  // Shift is read from the Enter keydown's e.shiftKey (requires autocapitalize="none", else
  // iOS autocapitalize spuriously sets it true on the Enter right after a newline). BUT iOS
  // only honors a HELD Shift for the FIRST Enter — it drops the modifier afterward, so a
  // held Shift+Enter ×N reports shiftKey:true once then false. We can't detect those later
  // Enters as shifted. So instead: a Shift+Enter starts a "shift run" (shiftRun) that treats
  // every following Enter as a newline (never submit) until a real keystroke ends the run.
  // Consequence: to submit right after a Shift+Enter without typing, use the Send button.
  //
  // Plain Enter (no shift run) inserts a newline and arms; a second consecutive plain Enter
  // submits (stripping that newline). Never submits an empty message.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKeyDown = (e) => {
      const s = slash.current;
      if (s.open && s.filtered.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          s.active = Math.min(s.active + 1, s.filtered.length - 1);
          return rerender();
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          s.active = Math.max(s.active - 1, 0);
          return rerender();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return closeSlash();
        }
      }
      if (e.key === "Enter") enterShift.current = e.shiftKey; // fires before beforeinput
      // Backspace on an empty bash field deletes the glyph — i.e. leaves bash mode.
      if (bashRef.current && e.key === "Backspace" && el.value === "") {
        e.preventDefault();
        exitBash();
      }
    };
    const onBeforeInput = (e) => {
      // Pre-mutation snapshot for onInput's paste-into-empty bash-mode check.
      if (e.inputType === "insertFromPaste") pasteWasEmpty.current = el.value === "";
      // Slash menu open: Enter picks the highlighted row instead of newline/submit. Reset the
      // Enter state machine so no stale arm/run leaks across the menu.
      const s = slash.current;
      if (s.open && s.filtered.length && (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph")) {
        e.preventDefault();
        enterArmed.current = false;
        shiftRun.current = false;
        selectSlash(s.filtered[s.active]);
        return;
      }
      if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") {
        shiftRun.current = false; // a real keystroke (typing/delete) ends the shift run...
        enterArmed.current = false; // ...and breaks the double-Enter run
        return;
      }
      if (enterShift.current || shiftRun.current) {
        // A genuine Shift+Enter, or a held-Shift continuation iOS stripped the modifier from:
        // newline, never submit.
        shiftRun.current = true;
        enterArmed.current = false;
        return;
      }
      if (enterArmed.current && el.value.trim() !== "") {
        enterArmed.current = false;
        e.preventDefault(); // cancel the second newline
        el.value = el.value.replace(/\n$/, ""); // drop the newline the first Enter added
        send();
      } else {
        enterArmed.current = true;
      }
    };
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("beforeinput", onBeforeInput);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("beforeinput", onBeforeInput);
    };
  }, [bashMode]); // the mode flip remounts the keyed textarea — re-bind to the new node
  useEffect(() => {
    closeSlash();
    disarmStop();
  }, [sid]); // reset the menu + any armed Stop on session switch
  useEffect(() => {
    // A turn leaving "running" (the interrupt overlay, or the turn just ending):
    // disarm so Stop never carries a stale arm into the next turn.
    if (status !== "running") disarmStop();
  }, [status]);
  useEffect(() => () => clearTimeout(disarmTimer.current), []); // clear the disarm timer on unmount
  // Apply the carried draft after a bash-mode flip: the keyed textarea was just recreated
  // (iOS only honors autocorrect/spellcheck attributes at focus time, hence the remount),
  // so text, caret and focus land on the NEW node here.
  useEffect(() => {
    const c = carryRef.current;
    if (!c) return;
    carryRef.current = null;
    const el = ref.current;
    if (!el) return;
    el.value = c.text;
    grow();
    syncHasText();
    if (c.focus) {
      // Restore the keyboard pan captured at flip time (see enterBash): programmatic
      // focus doesn't trigger iOS's caret-reveal pan, so without this the page sits
      // shifted down with the composer under the keyboard until the next keystroke.
      // Repeated because iOS applies its own (wrong) adjustment after focus returns.
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
      const restore = () => window.scrollTo(0, c.scrollY || 0);
      restore();
      requestAnimationFrame(restore);
      setTimeout(restore, 120);
    }
  }, [bashMode]);
  // Load the persisted draft when the composer (re)appears for a session — mount after
  // navigating back from the list, an app reload, or a PWA eviction. On an in-place
  // switch (notification tap, fork open) the outgoing session's text is already saved
  // under its own key by syncHasText, so the box is handed to the new session wholesale:
  // leftover text is replaced rather than carried over, where the next keystroke would
  // persist it under the wrong session's draft. The prefill effect below runs after and
  // keeps precedence (a rewind's text overwrites; keepDraft yields — a draft stored for
  // this session IS the draft restore-on-interrupt must yield to).
  useEffect(() => {
    // A bash-mode draft round-trips: saved as the full `!cmd` send string, and
    // setComposerText re-enters bash mode for any `!`-leading text.
    const d = readDrafts()[sid];
    setComposerText(d ? d.text : "");
  }, [sid]);
  // One-shot autofill after a rewind: drop the rewound message back into the box (TUI parity).
  // Guarded on sessionId so a stale prefill never lands in the wrong session's composer; the
  // steady-state/mount re-fire (value null) is a no-op.
  useEffect(() => {
    const p = composerPrefill.value;
    if (!p || p.sessionId !== sid) return;
    const el = ref.current;
    // keepDraft (restore-on-interrupt): the fill yields to anything already typed — the
    // user may have started the replacement message before the restore resolved.
    if (el && !(p.keepDraft && el.value.trim())) {
      // An empty prefill ("Chat about this") exists only to focus the box and raise the
      // keyboard — writing the "" would wipe whatever is typed and delete the saved draft.
      // focus:true covers the bash-mode case, where the write rides the remount carry
      // and the el.focus() below would land on the outgoing node.
      if (p.text) setComposerText(p.text, { focus: true });
      el.focus();
    }
    composerPrefill.value = null;
  }, [composerPrefill.value]);
  return html`
    <div class="composerwrap">
      <input ref=${trampRef} class="focustramp" tabindex="-1" aria-hidden="true" autocapitalize="none" autocorrect="off" />
      ${slash.current.open &&
      html`<div class="slash-menu">
        ${slash.current.filtered.map(
          (c, i) => html`<div
            class=${"slash-item" + (i === slash.current.active ? " active" : "")}
            key=${c.source + ":" + c.name}
            onClick=${() => selectSlash(c)}
          >
            <span class="slash-name">/${c.name}</span>
            ${c.description && html`<span class="slash-desc">${c.description}</span>`}
          </div>`,
        )}
      </div>`}
      ${attachments.value.length > 0 &&
      html`<div class="thumbs">
        ${attachments.value.map(
          (a) => html`<div class="thumb" key=${a.url}>
            <img src=${a.url} alt="" />
            <button class="thumbx" onClick=${() => removeAttachment(a.url)} aria-label="Remove">×</button>
          </div>`,
        )}
      </div>`}
      <div class="composer">
        <input ref=${fileRef} type="file" accept="image/*" multiple style="display:none" onChange=${onPick} />
        <button
          class="attach"
          disabled=${disabled}
          onClick=${() => fileRef.current && fileRef.current.click()}
          aria-label="Attach image"
        >
          ＋
        </button>
        ${bashMode
          ? html`<div class="bashfield" key="bash">
              <span class="bangglyph" onClick=${() => exitBash()} aria-label="Leave bash mode">!</span>
              <textarea
                ref=${ref}
                rows="1"
                placeholder="command…"
                autocapitalize="none"
                autocorrect="off"
                spellcheck="false"
                autocomplete="off"
                disabled=${disabled}
                onInput=${onInput}
              ></textarea>
            </div>`
          : html`<textarea
              key="plain"
              ref=${ref}
              rows="1"
              placeholder="Message…"
              autocapitalize="none"
              disabled=${disabled}
              onInput=${onInput}
            ></textarea>`}
        ${!hasText && attachments.value.length === 0 && status === "running" && !disabled
          ? html`<button
              class=${"stop" + (stopArmed.current ? " armed" : "")}
              onClick=${onStop}
              aria-label=${stopArmed.current ? "Confirm stop" : "Stop Claude"}
            >
              ■
            </button>`
          : html`<button class="send" disabled=${disabled} onClick=${send} aria-label="Send">↑</button>`}
      </div>
    </div>
  `;
}

// Walk up from a touch target to the nearest ancestor that actually scrolls horizontally
// (content wider than its box + an overflow-x that scrolls). Used to let the back-swipe
// defer to code blocks / wide tables instead of stealing their horizontal pan.
function hScrollerAt(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return el;
    }
  }
  return null;
}

// Interactive swipe-right-to-go-back (iOS-style). Set the returned `rootRef` on a
// `.screen` root: the screen tracks the finger, then on release either commits `onBack`
// (past threshold, sliding the rest of the way off first so it reads as one motion) or
// springs home. Only a clearly horizontal-right drag engages, so it never steals vertical
// scroll; it defers to an inner horizontal scroller (e.g. a code block) until that's at
// its left edge. The touchmove listener is non-passive so it can preventDefault and own
// the gesture. `deps` re-binds the listeners when the root node is (re)created.
//
// Listeners live on `document`, not the root: the #app shell is a centered max-width
// column, so on a wide viewport (iPad) the side gutters are OUTSIDE it — a touch that
// starts on <body> delivers its entire event stream to <body>, which element handlers
// can never see. Screens layer (detail → files → diff), each mounting above the last,
// so a mount-ordered stack decides which instance owns the gesture: the topmost only.
const swipeScreens = [];
// The gesture only arms when the touch STARTS in an edge zone: a strip just inside
// either edge of the app column, plus the whole gutters outside it when the viewport
// is wider than the column (iPad landscape). A touch starting mid-content never
// engages — so dragging text-selection handles can't move the screen.
const SWIPE_EDGE_PX = 28;
const CONTENT_MAX_PX = 680; // #app column max-width (index.html)
function inSwipeEdgeZone(x) {
  const colLeft = Math.max(0, (innerWidth - CONTENT_MAX_PX) / 2);
  return x < colLeft + SWIPE_EDGE_PX || x > innerWidth - colLeft - SWIPE_EDGE_PX;
}
function useSwipeBack(onBack, deps = []) {
  const rootRef = useRef(null);
  const drag = useRef({ x: 0, y: 0, active: false, dx: 0, decided: true });

  useEffect(() => {
    const token = {};
    swipeScreens.push(token);

    function onStart(e) {
      if (swipeScreens[swipeScreens.length - 1] !== token) return; // not the visible screen
      const p = e.changedTouches[0];
      if (!inSwipeEdgeZone(p.clientX)) {
        drag.current = { x: p.clientX, y: p.clientY, active: false, dx: 0, decided: true };
        return;
      }
      drag.current = { x: p.clientX, y: p.clientY, active: false, dx: 0, decided: false, hScroller: hScrollerAt(e.target) };
      if (rootRef.current) rootRef.current.style.transition = "none";
    }
    function onMove(e) {
      const el = rootRef.current;
      if (!el) return;
      const p = e.changedTouches[0];
      const dx = p.clientX - drag.current.x;
      const dy = p.clientY - drag.current.y;
      if (!drag.current.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.current.decided = true;
        const horizRight = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3; // horizontal-right only
        const sc = drag.current.hScroller;
        drag.current.active = horizRight && (!sc || sc.scrollLeft <= 0);
      }
      if (!drag.current.active) return;
      e.preventDefault();
      const tx = Math.max(0, dx);
      drag.current.dx = tx;
      el.style.transform = `translateX(${tx}px)`;
      el.style.opacity = String(1 - Math.min(tx / innerWidth, 1) * 0.35);
    }
    function onEnd() {
      const el = rootRef.current;
      if (!el || !drag.current.active) return;
      drag.current.active = false;
      if (drag.current.dx > Math.min(innerWidth * 0.32, 140)) {
        el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
        el.style.transform = `translateX(${innerWidth}px)`;
        el.style.opacity = "0";
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          onBack();
        };
        el.addEventListener("transitionend", finish, { once: true });
        setTimeout(finish, 240); // fallback if transitionend is dropped
        return;
      }
      el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out"; // spring home
      el.style.transform = "";
      el.style.opacity = "";
    }

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      swipeScreens.splice(swipeScreens.indexOf(token), 1);
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, deps);

  return { rootRef };
}

function Detail() {
  const t = transcript.value;
  // A History row older than discovery's 24h sweep has no sessions.value entry — the
  // stand-in from openHistoryRow carries its header metadata + restore state instead.
  const session =
    sessions.value.find((s) => s.id === selectedId.value) ||
    (historySession.value && historySession.value.id === selectedId.value ? historySession.value : null);
  const status = session ? session.status : "";
  const turns = t ? t.turns : []; // full active branch — upCount/canCode compute over THIS
  // Optimistic rewind: show only the turns before the rewound message until the resend lands
  // (see rewindFloor). upCount/canCode still derive from the FULL branch (Claude's picker is
  // un-rewound until the resend), so a second rewind mid-window still targets correctly.
  const floor = rewindFloor.value;
  const keepTurns = floor ? floor.keepTurns : turns.length;
  const displayTurns = floor ? turns.slice(0, keepTurns) : turns;
  // Real user-turn texts in the DISPLAYED thread (image prefix stripped, matching the
  // optimistic captions). Used to suppress optimistic bubbles whose message has landed — a
  // render-time guard so a just-sent message never shows twice (the SSE only watches hook
  // events, so the pendingSends cleanup in refreshTranscript can lag the fetch). Scoped to
  // displayTurns so a rewound-then-resent message still shows as a pending bubble.
  // Messages still sitting in Claude's input queue — sent mid-turn, not yet consumed.
  // Gated on a running/waiting status: on an idle session a surviving entry is a stale
  // leftover (interrupt/popAll edge), not something about to run.
  const queued =
    t && (status === "running" || status === "waiting") ? t.queuedPending || [] : [];
  const landed = new Set();
  for (const turn of displayTurns) {
    if (turn.role !== "user") continue;
    if (turn.command) landed.add(turn.command.trim());
    if (turn.bash) landed.add("!" + turn.bash.command);
    for (const b of turn.content || []) {
      if (b.type === "text" && b.text) landed.add(stripImagePrefix(b.text).trim());
    }
  }
  // Queue entries count as landed too: the dim queued bubble renders them, so the
  // optimistic copy of the same text must stand down.
  for (const q of queued) landed.add(q.trim());
  const rawQuestions = t && (t.openQuestions || (t.openQuestion ? [t.openQuestion] : null));
  // "Chat about this" and a just-tapped answer/decision optimistically hide the blocking
  // card so the dock flips immediately, before the server resolves and the poll catches up.
  const optimisticHide =
    clarifying.value === selectedId.value ||
    deciding.value === selectedId.value ||
    (decidingQuestion.value && decidingQuestion.value.id === selectedId.value);
  const questions = optimisticHide ? null : rawQuestions;
  const approval = optimisticHide ? null : t && t.approval;
  // While blocked on a question/approval, the structured answer UI takes the dock —
  // otherwise it's the free-text composer (this is the "replace the message box with
  // the question/answers" behavior).
  const blocked = questions || approval;
  // An archived session has no live pane: sends/answers would fail with `no-pane`. When it's
  // not actually blocked (discovery can mislabel a live blocked session as archived — those
  // stay answerable), lock the composer and show a standing notice instead of a dead end.
  const archived = status === "archived" && !blocked;

  // Swipe-right-to-go-back translates the whole Detail screen (rootRef) back to the list.
  const { rootRef } = useSwipeBack(back);
  const scrollRef = useRef(null); // the thread is the ONLY scroll region (app-shell layout)
  const follow = useRef(true); // auto-scroll only while the user is near the bottom
  const [showJump, setShowJump] = useState(false); // floating "jump to latest" button
  const lastId = useRef(null);

  // Attention-jump button: count of OTHER blocked sessions (the queue minus this one).
  const otherAttention = attentionSessions().filter((s) => s.id !== selectedId.value).length;

  // Background work — agents the session fanned out to plus background scripts it is
  // waiting on (run_in_background Bash, no completion notification yet). Both are the
  // same harness machinery (tasks + task-notification) and share one surface: the
  // navbar pill (glance) → the AgentList sheet (labels). A script wait is the case
  // where status honestly reads "ready" while work is in flight — the mint pill is
  // the in-detail tell, same affordance as running agents.
  const agents = (t && t.subagents) || [];
  const runningAgents = agents.filter((a) => a.status === "running").length;
  const scripts = (t && t.pendingScripts) || [];
  const activeWork = runningAgents + scripts.length;

  // 15s safety poll while any background work is live — covers agent hard-kills (which
  // fire no SubagentStop hook) and a script wake that produces no immediate hook edge.
  // SSE stays the instant primary path; this stops the moment everything is done.
  useEffect(() => {
    if (activeWork === 0) return;
    const iv = setInterval(() => {
      refreshTranscript();
      if (openSubagent.value) refreshSubagent();
    }, 15000);
    return () => clearInterval(iv);
  }, [activeWork]);

  // Self-heal on status change. The thread's last refresh for a turn rides on the single
  // Stop-event broadcast — if that response is lost (dropped socket moment, failed fetch,
  // out-of-order overwrite) nothing refetches and the thread freezes until remount. The
  // session's list status keeps updating regardless (the id-less broadcasts refresh the
  // list unconditionally), so a status flip is the one signal that always arrives: use it
  // to refetch the open transcript.
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === status) return;
    prevStatus.current = status;
    refreshTranscriptSoon();
  }, [status]);

  // 2.5s poll while a send is in flight (optimistic bubble up) or a message sits in
  // Claude's queue. Both states advance WITHOUT any hook event — a mid-turn send fires
  // no UserPromptSubmit when enqueued, and its consumption (queue remove + attachment)
  // is a bare transcript append — so the SSE never wakes and the thread would sit on
  // the optimistic/queued bubble until the next unrelated event or a remount. Stops
  // the moment nothing is pending or queued.
  // A pending restore-on-interrupt polls too: the post-interrupt branch rewrite (the turn
  // dropping off) is a bare transcript change with no hook event, so SSE alone may never
  // deliver the refetch that resolves it.
  const sendsInFlight = pendingSends.value.length + pendingImageSends.value.length;
  const queuedCount = (t && t.queuedPending && t.queuedPending.length) || 0;
  const restorePending = !!(interruptRestore.value && interruptRestore.value.sessionId === selectedId.value);
  useEffect(() => {
    if (sendsInFlight === 0 && queuedCount === 0 && !restorePending) return;
    const iv = setInterval(refreshTranscript, 2500);
    return () => clearInterval(iv);
  }, [sendsInFlight > 0, queuedCount > 0, restorePending]);

  // Track whether we're pinned to the bottom of the thread. The 80px slack keeps auto-follow
  // alive through small jitters; the floating controls (down button + prompt-nav pill) appear
  // the moment we're off the bottom by that same slack — so "not at bottom" ⇒ buttons shown.
  function syncFloat() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = atBottom;
    setShowJump(!atBottom);
  }

  // Tap the floating button: smooth-scroll to the newest message. Don't pre-arm follow or
  // force a state change here — the post-render effect snaps `scrollTop = scrollHeight`
  // instantly whenever follow is true, which races this smooth scroll and causes the
  // flicker. syncFloat re-arms follow and fades the button out on its own as we land.
  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // Prev/next-prompt navigation: scroll to the user message just above (dir -1) or below
  // (dir +1) the current viewport top. Offsets are measured live from the DOM so they stay
  // correct as bubbles grow/shrink. At the ends it clamps — first prompt / thread bottom.
  function jumpPrompt(dir) {
    const el = scrollRef.current;
    if (!el) return;
    const cTop = el.getBoundingClientRect().top;
    const tops = [...el.querySelectorAll(".bubble.user:not(.pending)")].map(
      (b) => el.scrollTop + b.getBoundingClientRect().top - cTop,
    );
    if (!tops.length) return;
    // A jumped prompt lands `pad + GAP` below the container top (pad carries the status-bar
    // safe-area inset in standalone PWA mode, so it never butts against the top edge). The
    // prompt currently in focus therefore sits at offset `scrollTop + pad + GAP` — compare
    // next/prev against THAT line, not raw scrollTop, or the focused prompt reads as "below
    // us" and the next-search keeps re-selecting it (the stuck-button bug).
    const GAP = 12;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const ref = el.scrollTop + pad + GAP;
    let target;
    if (dir < 0) {
      const prev = tops.filter((y) => y < ref - 4);
      target = prev.length ? prev[prev.length - 1] : tops[0];
    } else {
      const next = tops.find((y) => y > ref + 4);
      target = next != null ? next : el.scrollHeight;
    }
    el.scrollTo({ top: Math.max(0, target - pad - GAP), behavior: "smooth" });
  }

  // After each render: re-pin to the newest output (forced on session switch) unless the
  // user has scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastId.current !== selectedId.value) {
      lastId.current = selectedId.value;
      follow.current = true;
    }
    if (follow.current) el.scrollTop = el.scrollHeight;
    // Recompute button visibility after the DOM settles (new content can push us off the
    // bottom without firing a scroll event), so the controls don't lag behind streaming.
    syncFloat();
  });

  const usage = t && t.usage;
  const mode = t && t.mode; // permission mode (auto/plan), scraped from the pane
  // Statusline (scraped from the pane) is `tokens • branch • model • thinking`; keep
  // just tokens + branch so it stays on one line. Auto mode is yellow (matches the TUI).
  const statusline = t && t.statusline ? t.statusline.split(" • ").slice(0, 2).filter(Boolean).join(" • ") : "";
  const modeColor = mode && /auto/i.test(mode) ? "var(--yellow)" : "var(--mint)";
  return html`
    <div
      class="screen detail"
      ref=${rootRef}
    >
      <div class="scroll thread" ref=${scrollRef} onScroll=${syncFloat}>
        ${!t && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${(() => {
          // Per user turn: upCount = Up-presses to reach it in the /rewind picker (0 = not a
          // checkpoint, so no rewind offered); canCode = whether any file-editing tool ran
          // after it (offer code-restore only when there's code to restore — Bash edits aren't
          // checkpointed, matching Claude). Both derive from the FULL branch (Claude's picker
          // is un-rewound until the resend), so a second rewind mid-window still targets right.
          const n = turns.length;
          const editAfter = new Array(n).fill(false);
          let sawEdit = false;
          for (let i = n - 1; i >= 0; i--) {
            editAfter[i] = sawEdit;
            if ((turns[i].content || []).some((b) => b.type === "tool_use" && EDIT_TOOLS.has(b.name))) {
              sawEdit = true;
            }
          }
          const upByIndex = upCountByIndex(turns);
          // Reverted prompts (bare-leaf interrupt — see the restore-on-interrupt block):
          // entries recorded at interrupt time, index+text guarded — inert once the
          // branch moves past that index. Marker-shaped interrupts are NOT hidden: the
          // Mac TUI keeps those in the conversation, so portkey mirrors it.
          const hiddenIdx = new Set();
          for (const h of hiddenInterrupts.value) {
            if (h.sessionId !== selectedId.value) continue;
            const ht = turns[h.index];
            const matches =
              ht &&
              isPromptTurn(ht) &&
              (ht.content || []).some((b) => b.type === "text" && (b.text || "").trim() === h.text);
            if (matches) hiddenIdx.add(h.index);
          }
          return turns.map((turn, i) => {
            const up = upByIndex.get(i) || 0;
            if (i >= keepTurns) return null; // truncated by an optimistic rewind
            if (hiddenIdx.has(i)) return null; // restored to the composer by an interrupt
            return html`<${Turn} key=${i} turn=${turn} upCount=${up} canCode=${editAfter[i]} />`;
          });
        })()}
        ${queued.map((text, i) =>
          text.trim().startsWith("!")
            ? html`<div
                class="bang-cmd queued"
                key=${`q${i}`}
                ...${lpProps(lpStartCopyOnly(text))}
              >
                <span class="glyph">!</span>${text.trim().slice(1)}
                <div class="queuedtag">queued</div>
              </div>`
            : html`<div
                class="bubble user queued"
                key=${`q${i}`}
                ...${lpProps(lpStartCopyOnly(text))}
              >
                ${text}
                <div class="queuedtag">queued</div>
              </div>`,
        )}
        ${pendingSends.value
          .filter((text) => !landed.has(bangKey(text)))
          .map((text, i) =>
            // A `!cmd` echo renders as the bash command bubble (no output yet) so the
            // optimistic bubble matches the folded turn it retires into.
            text.trim().startsWith("!")
              ? html`<div
                  class="bang-cmd pending"
                  key=${`p${i}`}
                  ...${lpProps(lpStartCopyOnly(text))}
                >
                  <span class="glyph">!</span>${text.trim().slice(1)}
                </div>`
              : html`<div
                  class="bubble user pending"
                  key=${`p${i}`}
                  ...${lpProps(lpStartCopyOnly(text))}
                >${text}</div>`,
          )}
        ${pendingImageSends.value
          .filter((e) => !landed.has(stripImagePrefix(e.text).trim()))
          .map(
            (entry, i) => html`<div
            class="bubble user pending imgbubble"
            key=${`pi${i}`}
            ...${lpProps(entry.text ? lpStartCopyOnly(entry.text) : undefined)}
          >
            <div class="bubthumbs">${entry.urls.map((u) => html`<img src=${u} alt="" key=${u} />`)}</div>
            ${entry.text && html`<div>${entry.text}</div>`}
          </div>`,
          )}
        ${t && t.pendingTool && !blocked && html`<${RunningTool} tool=${t.pendingTool} />`}
        ${status === "running" && !blocked && html`<div class="typing">working…</div>`}
        ${!archived && html`<${ChangesCard} />`}
      </div>
      <div class="dock">
        <div class="dockbtns">
          ${displayTurns.filter(isPromptTurn).length >= 2 &&
          html`<div class=${`promptnav${showJump ? " show" : ""}`}>
            <button onClick=${() => jumpPrompt(-1)} aria-label="Previous prompt">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
            <button onClick=${() => jumpPrompt(1)} aria-label="Next prompt">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>`}
          <button
            class=${`scrollbtn${showJump ? " show" : ""}`}
            onClick=${jumpToBottom}
            aria-label="Scroll to latest"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
        <div class="dock-inner">
          ${archived
            ? session && (session.restorable === "yes" || session.restorable === "relocated")
              ? html`<div class="flash archived restore-row">
                  <button
                    class="primary restore-btn"
                    disabled=${restoring.value}
                    onClick=${restoreSession}
                  >
                    ${restoring.value
                      ? "Restoring…"
                      : session.restorable === "relocated"
                        ? `⟲ Restore in ${session.repo}`
                        : "⟲ Restore session"}
                  </button>
                  ${session.restorable === "relocated" &&
                  !flash.value &&
                  html`<span class="restore-note">worktree gone — resumes in the base repo</span>`}
                  ${flash.value && html`<span class="restore-err">${flash.value}</span>`}
                </div>`
              : session && session.restorable === "no"
                ? html`<div class="flash archived">Repo folder is gone — readable, but nowhere to restore.</div>`
                : html`<div class="flash archived">Archived — resume from your Mac to continue this session.</div>`
            : flash.value &&
              html`<div class=${"flash" + (flashKind.value ? ` ${flashKind.value}` : "")}>${flash.value}</div>`}
          <div class="navbar">
            <button class="iconbtn" onClick=${back} aria-label="Back to sessions">‹</button>
            <div class="navtitle">
              ${session && html`<span class="dot" style=${dotStyle(session)}></span>`}
              <span class="navname">${session ? listTitle(session) : "session"}</span>
            </div>
            ${(agents.length > 0 || scripts.length > 0) &&
            html`<button
              class="agentspill${activeWork > 0 ? "" : " archive"}"
              onClick=${() => (showAgents.value = true)}
              aria-label="Background work"
            >
              ${activeWork > 0
                ? html`${runningAgents > 0 && html`🤖 <span class="run">${runningAgents}</span>`}${runningAgents >
                      0 && scripts.length > 0
                      ? " "
                      : ""}${scripts.length > 0 && html`⏳ <span class="run">${scripts.length}</span>`}`
                : html`🤖 ${agents.length}`}
            </button>`}
            ${session &&
            html`<button
              class="iconbtn morebtn"
              onClick=${() => (sessionMenu.value = session)}
              aria-label="Session actions"
            >
              ⋯
            </button>`}
            ${otherAttention > 0 &&
            html`<button class="attn" onClick=${gotoNextAttention} aria-label="Next session needing attention">
              ⚡ ${otherAttention} ›
            </button>`}
          </div>
          ${(statusline || mode || usage) &&
          html`<div class="statusbar">
            ${mode && html`<span class="modebadge" style=${`color:${modeColor}`}>${mode}</span>`}
            ${statusline
              ? html`<span class="sltext">${statusline}</span>`
              : usage &&
                html`<span class="sltext" style=${`color:${usageColor(usage.percent)}`}>${usage.percent}%</span>`}
          </div>`}
          ${questions
            ? html`<${QuestionCard} questions=${questions} toolUseId=${t.pendingTool && t.pendingTool.toolUseId} />`
            : approval
              ? html`<${ApprovalCard} approval=${approval} />`
              : html`<${Composer} disabled=${archived} status=${status} />`}
        </div>
      </div>
    </div>
  `;
}

// Long-press action sheet for a user message: copy, or rewind to before it via Claude's
// /rewind picker (driven + verified server-side). Rewind is hidden while the session is
// busy (the picker only opens at the prompt).
function ActionSheet() {
  const m = menuText.value;
  // Rewind discards the thread's tail (and, for "both", file changes) — like the session
  // sheet's Archive, it takes a second tap that swaps the sheet to an explicit confirm.
  const [confirm, setConfirm] = useState(null); // null | "conversation" | "both"
  useEffect(() => setConfirm(null), [m]);
  if (m == null) return null;
  const close = () => (menuText.value = null);
  const session = sessions.value.find((s) => s.id === selectedId.value);
  const busy = session && (session.status === "running" || session.status === "waiting");
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheetpreview">${m.text}</div>
          ${confirm
            ? html`
                <div class="sheethint">
                  ${confirm === "both"
                    ? "Removes everything after this message and resets code files to that point — changes made since are discarded. The message returns to the composer."
                    : "Removes everything after this message from the conversation. The message returns to the composer; code files stay as they are."}
                </div>
                <button class="danger-fill" onClick=${() => rewind(confirm)}>
                  ${confirm === "both" ? "Rewind code + conversation" : "Rewind conversation"}
                </button>
                <button class="sheetcancel" onClick=${() => setConfirm(null)}>Cancel</button>`
            : html`
                <button class="vrow" onClick=${() => copyMessage(m.text)}>
                  <span class="vg">${vicon(VICONS.copy)}</span>Copy
                </button>
                ${!m.assistant &&
                !busy &&
                m.upCount > 0 &&
                html`<button class="vrow danger" onClick=${() => setConfirm("conversation")}>
                  <span class="vg">${vicon(VICONS.undo)}</span>Rewind conversation to here
                </button>`}
                ${!m.assistant &&
                !busy &&
                m.upCount > 0 &&
                m.canCode &&
                html`<button class="vrow danger" onClick=${() => setConfirm("both")}>
                  <span class="vg">${vicon(VICONS.code)}</span>Rewind code + conversation
                </button>`}
                ${!m.assistant &&
                !m.copyOnly &&
                busy &&
                html`<div class="sheethint">Rewind is available at the prompt.</div>`}
                <button class="sheetcancel" onClick=${close}>Cancel</button>`}
        </div>
      </div>
    </div>
  `;
}

// Long-press action sheet for a session ROW (home list). A header identifies the session
// being acted on (status dot + name + repo · subline + age), then the actions. Archive is
// destructive (kills the live Claude process), so it takes a second tap that swaps the
// sheet to an explicit confirm — no accidental kills from a fat-fingered long-press.
// Stroke icons for the sheets' glyph columns (session, message) — same feather family
// as the bell/history buttons, tinted via currentColor (the reason these aren't emoji).
const vicon = (paths) =>
  html`<svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    dangerouslySetInnerHTML=${{ __html: paths }}
  ></svg>`;
const VICONS = {
  open: '<path d="M9 18l6-6-6-6"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  block: '<path d="M18 6L6 18M6 6l12 12"/>',
  undo: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  fork: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  done: '<path d="M20 6L9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
};

// Phone snooze presets — one-tap chips in the session sheet; the server validates the
// same list and computes the wake (hours exact, day presets at 8AM local).
const SNOOZE_PRESETS = [
  ["1h", "1h"],
  ["4h", "4h"],
  ["tomorrow", "tmrw"],
  ["3d", "3d"],
  ["7d", "7d"],
];

function SessionSheet() {
  const s = sessionMenu.value;
  const [confirm, setConfirm] = useState(null); // null | "archive" | "fork" | "snooze" | "block" — the open sub-state
  const [note, setNote] = useState(""); // block-note draft (block sub-state only)
  const [pendingPreset, setPendingPreset] = useState(null); // snooze sub-state: the preset awaiting confirm
  // The sheet returns null when closed instead of unmounting, so `confirm` would
  // otherwise persist — reset it each time the target changes (open/close/switch).
  useEffect(() => {
    setConfirm(null);
    setNote("");
    setPendingPreset(null);
  }, [s]);
  if (s == null) return null;
  const close = () => (sessionMenu.value = null);
  const sub = subLine(s);
  // Inbox verbs show on rows the inbox knows (`inbox` tag from the payload), in both
  // views. Done rows trade the disposal verbs for Un-archive; parked rows add Unpark.
  const section = s.inbox && s.inbox.section;
  const canPark = !!s.inbox && section !== "done";
  const parked = section === "parked";
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead">
            <span class="dot" style=${dotStyle(s)}></span>
            <span class="grow">
              <span class="name">${listTitle(s)}</span>
              <span class="sub">${sub ? `${s.repo} · ${sub}` : s.repo}</span>
            </span>
            <span class="age">${formatAge(activityAt(s))}</span>
          </div>
          ${confirm === "archive"
            ? html`
                <div class="sheethint">
                  ${s.paneId
                    ? "This ends the live Claude session. Your conversation is saved — resume it from your Mac anytime."
                    : "Marks the session done. Your conversation is saved — resume it anytime."}
                </div>
                <button class="danger-fill" onClick=${archiveSession}>Archive session</button>
                <button class="sheetcancel" onClick=${() => setConfirm(null)}>Keep running</button>`
            : confirm === "fork"
              ? html`
                  <div class="sheethint">
                    Forks this conversation into a new session on your Mac. The original keeps running untouched.
                  </div>
                  <button class="accent-fill" onClick=${forkSession}>Fork session</button>
                  <button class="sheetcancel" onClick=${() => setConfirm(null)}>Cancel</button>`
              : confirm === "snooze"
                ? html`
                    <div class="sheethint">
                      Claude is mid-turn — snoozing ends the run and parks the session until it
                      wakes.
                    </div>
                    <button class="accent-fill" onClick=${() => snoozeSession(pendingPreset)}>
                      Snooze
                      ${(SNOOZE_PRESETS.find(([p]) => p === pendingPreset) || [])[1] || pendingPreset}
                    </button>
                    <button class="sheetcancel" onClick=${() => (setConfirm(null), setPendingPreset(null))}>
                      Cancel
                    </button>`
                : confirm === "block"
                ? html`
                    <div class="sheethint">
                      Parks the session until you unblock it. The pane ends; the note says what it waits on.
                    </div>
                    <input
                      class="blockinput"
                      placeholder="blocked on…"
                      value=${note}
                      onInput=${(e) => setNote(e.target.value)}
                      onKeyDown=${(e) => e.key === "Enter" && blockSession(note)}
                    />
                    <button class="accent-fill" onClick=${() => blockSession(note)}>Block</button>
                    <button class="sheetcancel" onClick=${() => setConfirm(null)}>Cancel</button>`
                : html`
                    ${selectedId.value !== s.id &&
                    html`<button class="vrow" onClick=${() => (close(), open(s.id))}>
                      <span class="vg">${vicon(VICONS.open)}</span>Open
                    </button>`}
                    ${canPark &&
                    html`<div class="snoozerow">
                      <span class="vg" title="snooze until…">${vicon(VICONS.moon)}</span>
                      ${SNOOZE_PRESETS.map(
                        // A running session gets a confirm interposed — one tap would
                        // kill an in-flight turn (parity with the sidebar, which hides
                        // snooze on Running rows entirely).
                        ([preset, label]) =>
                          html`<button
                            key=${preset}
                            onClick=${() =>
                              s.status === "running"
                                ? (setPendingPreset(preset), setConfirm("snooze"))
                                : snoozeSession(preset)}
                          >
                            ${label}
                          </button>`,
                      )}
                    </div>`}
                    ${canPark &&
                    html`<button class="vrow" onClick=${() => setConfirm("block")}>
                      <span class="vg">${vicon(VICONS.block)}</span>Block…
                    </button>`}
                    ${parked &&
                    html`<button class="vrow" onClick=${unparkSession}>
                      <span class="vg">${vicon(VICONS.undo)}</span>${s.inbox.note != null ? "Unblock" : "Unsnooze"}
                    </button>`}
                    ${section === "done" &&
                    html`<button class="vrow" onClick=${unarchiveSession}>
                      <span class="vg">${vicon(VICONS.undo)}</span>Un-archive
                    </button>`}
                    <button class="vrow" onClick=${() => setConfirm("fork")}>
                      <span class="vg">${vicon(VICONS.fork)}</span>Fork session…
                    </button>
                    ${section !== "done" &&
                    html`<button class="vrow danger" onClick=${() => setConfirm("archive")}>
                      <span class="vg">${vicon(VICONS.done)}</span>Archive session…
                    </button>`}
                    <button class="sheetcancel" onClick=${close}>Cancel</button>`}
        </div>
      </div>
    </div>
  `;
}

// Background-work sheet — everything the session runs beside the main conversation, in one
// list. Pending background scripts first (they explain a session that reads "ready" while
// mid-work, and have no other surface — script rows aren't tappable, there's no conversation
// behind a shell loop), then running agents, then agents that finished SINCE YOUR LAST
// PROMPT (fresh reports — likely why the sheet was opened), then everything older collapsed
// behind one "earlier" row: fan-out-heavy sessions pile up dozens of stale rows, but
// finished reports must stay reachable — the drill-in is the only place a phone user can
// read them (tool_results are stripped from the thread).
function AgentList() {
  const [showOlder, setShowOlder] = useState(false);
  if (!showAgents.value) return null;
  const t = transcript.value;
  const list = (t && t.subagents) || [];
  const scripts = (t && t.pendingScripts) || [];
  const close = () => ((showAgents.value = false), setShowOlder(false));
  // Boundary unknown (no prompt yet / no finishedAt) → err toward fresh: hiding a report
  // is worse than one extra row.
  const lastPrompt = t && t.lastPromptAt ? new Date(t.lastPromptAt).getTime() : null;
  const isFresh = (a) =>
    !lastPrompt || !a.finishedAt || new Date(a.finishedAt).getTime() >= lastPrompt;
  const running = list.filter((a) => a.status === "running");
  const fresh = list.filter((a) => a.status !== "running" && isFresh(a));
  const older = list.filter((a) => a.status !== "running" && !isFresh(a));
  // Drill-in prev/next walks the DISPLAY order, older included, so nothing is unreachable.
  const ordered = [...running, ...fresh, ...older];
  const row = (a) => html`
    <button
      type="button"
      class="agent-row"
      key=${a.agentId}
      onClick=${() => openAgent(a, ordered)}
      style=${a.spawnDepth > 1 ? `padding-left:${12 + Math.min(a.spawnDepth - 1, 4) * 14}px` : ""}
    >
      <span class="dot" style=${`background:${a.status === "running" ? "var(--mint)" : "var(--peach)"}`}></span>
      <span class="grow">
        <span class="name">${a.description || a.agentType}</span>
        <span class="sub">
          ${a.agentType}${a.status === "running"
            ? " · running"
            : a.finishedAt
              ? ` · ${formatTimeAgo(a.finishedAt)}`
              : ""}
        </span>
      </span>
      <span class="chev">›</span>
    </button>
  `;
  // Script row — same anatomy as agent rows (dot / name / sub) so the sheet reads as one
  // list, but a div (not a button): no drill-in target exists.
  const scriptRow = (sc) => html`
    <div class="agent-row script" key=${sc.toolUseId}>
      <span class="dot" style="background:var(--mint)"></span>
      <span class="grow">
        <span class="name">${sc.label}</span>
        <span class="sub">script · ${formatTimeAgo(sc.launchedAt) || "running"}</span>
      </span>
      <span class="scripthint">⏳</span>
    </div>
  `;
  // Header = state summary, not a bare noun: "1 waiting · 2 running · 5 done".
  const doneCount = fresh.length + older.length;
  const headParts = [
    scripts.length > 0 && `${scripts.length} waiting on script${scripts.length === 1 ? "" : "s"}`,
    running.length > 0 && `${running.length} running`,
    doneCount > 0 && `${doneCount} done`,
  ].filter(Boolean);
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead">
            <span class="grow"><span class="name">${headParts.join(" · ") || "background work"}</span></span>
          </div>
          <div class="agents-sheet">
            ${scripts.map(scriptRow)} ${running.map(row)} ${fresh.map(row)}
            ${older.length > 0 &&
            html`<button type="button" class="agent-row older-toggle" onClick=${() => setShowOlder(!showOlder)}>
              <span class="grow"><span class="sub">${showOlder ? "▾" : "▸"} ${older.length} earlier agent${older.length === 1 ? "" : "s"}</span></span>
            </button>`}
            ${showOlder && older.map(row)}
          </div>
          <button class="sheetcancel" onClick=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}

// Subagent drill-in — a full-screen push over the detail rendering the agent's conversation
// through the existing Turn. The opening user turn (the task brief) is collapsed under a
// ▸ Brief toggle; the footer steps across sibling agents; the back chevron returns to the
// session. Refreshed by the same SSE wake + 15s poll as the list.
function SubagentView() {
  const o = openSubagent.value;
  const [showBrief, setShowBrief] = useState(false);
  // Swipe-right-to-go-back closes the drill-in. Re-binds when a drill-in opens (dep on
  // agentId): the root node only exists while `o` is set.
  const { rootRef } = useSwipeBack(closeSubagent, [o ? o.agentId : null]);

  if (!o) return null;
  const data = subTranscript.value;
  const turns = (data && data.turns) || [];
  // Opening user turn = the task brief; the rest is the agent's actual work.
  const opening = turns[0] && turns[0].role === "user" ? turns[0] : null;
  const body = opening ? turns.slice(1) : turns;
  const sibs = o.siblings || [];
  const idx = sibs.findIndex((s) => s.agentId === o.agentId);
  const prev = idx > 0 ? sibs[idx - 1] : null;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
  return html`
    <div class="screen subagent-view" ref=${rootRef}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${closeSubagent} aria-label="Back to session">‹</button>
        <span class="grow">
          <span class="name">${o.description || o.agentType}</span>
          <span class="sub">${o.agentType}</span>
        </span>
      </div>
      <div class="scroll">
        ${!data && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${opening &&
        html`<div class="brief">
          <button class="brief-toggle" onClick=${() => setShowBrief(!showBrief)}>
            ${showBrief ? "▾" : "▸"} Brief
          </button>
          ${showBrief && html`<${Turn} turn=${opening} upCount=${0} canCode=${false} />`}
        </div>`}
        ${body.map((turn, i) => html`<${Turn} key=${i} turn=${turn} upCount=${0} canCode=${false} />`)}
        ${data && turns.length === 0 && html`<div class="sub" style="padding:8px">no conversation</div>`}
      </div>
      ${(prev || next) &&
      html`<div class="subagent-foot">
        ${prev
          ? html`<button class="sibnav" onClick=${() => openAgent(prev, sibs)}>‹ ${prev.description || prev.agentType}</button>`
          : html`<span class="sibnav-spacer"></span>`}
        ${next
          ? html`<button class="sibnav" onClick=${() => openAgent(next, sibs)}>${next.description || next.agentType} ›</button>`
          : html`<span class="sibnav-spacer"></span>`}
      </div>`}
    </div>
  `;
}

// Git status letter → color class (A added, M modified, D deleted; else muted).
const STATUS_CLASS = { A: "st-a", M: "st-m", D: "st-d", R: "st-r" };

// "branch vs base" — the baseline every changed-files surface is measured against. The list
// is everything this BRANCH changed vs its base (committed and uncommitted, your own earlier
// edits and any parallel session's included), not an attribution of what this session did.
// Saying so is what stops "+248 −301" reading as "the agent wrote all that".
const baseline = (d) =>
  d && d.branch ? `${d.branch}${d.base && d.base !== d.branch ? ` vs ${d.base}` : ""}` : "";

// Group chrome for the sync chain (see syncTiers). The un-landed tiers are peach — peach means
// one thing here, "hasn't left this Mac" — and the landed one is muted: it's context, not news.
const TIER_META = {
  uncommitted: { label: "Uncommitted", tone: "t-live" },
  unpushed: { label: "Committed, not pushed", tone: "t-live" },
  pushed: { label: "On GitHub", tone: "t-landed" },
};

// A tier's header: what the group is, how many files, and how much code moved in THAT range —
// the "how much has changed but isn't pushed" number, per group rather than one branch total.
function tierHead(tier) {
  const m = TIER_META[tier.key];
  const n = tier.files.length;
  return html`<div class=${"tier-head " + m.tone}>
    <!-- The landed tier keeps the dot's SPACE but not its ink, so all three group labels
         start on the same column — otherwise "ON GITHUB" hangs left of the others. -->
    <span class=${"sync-dot" + (tier.key === "pushed" ? " dot-off" : "")}></span>
    <span class="tier-name">${m.label}</span>
    <span class="tier-n">${n} file${n === 1 ? "" : "s"}</span>
    <span class="tier-loc"><span class="cadd">+${tier.add}</span> <span class="cdel">−${tier.del}</span></span>
  </div>`;
}

// The card's one-line answer to "has any of this left the Mac?", from the same /changes
// payload the totals come from. Null when everything is on GitHub — then the PR's own LOC
// keeps the slot, as it always has.
const syncChip = (d) =>
  !d || !d.tiers ? null : !d.pushed ? "never pushed" : d.unpushedCount ? `${d.unpushedCount} not pushed` : null;

// One file's status badge + path (dir dimmed, filename bright) + LOC delta — shared by the
// changed-files card preview and the full list so both read identically.
function fileLine(f) {
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
  return html`
    <span class=${"fl-badge " + (STATUS_CLASS[f.status] || "st-o")}>${f.status || "M"}</span>
    <span class="fl-path"><span class="fl-dir">${dir}</span><span class="fl-base">${base}</span></span>
    <span class="fl-stat">
      ${f.binary
        ? html`<span class="cbin">bin</span>`
        : html`<span class="cadd">+${f.add}</span> <span class="cdel">−${f.del}</span>`}
    </span>`;
}

// A 5-cell diffstat bar (GitHub-style): cells filled green for the additions proportion, red
// for deletions, dim for the remainder. Guarantees ≥1 colored cell when a side is non-zero.
function diffBar(add, del) {
  const total = add + del;
  let g = total ? Math.round((add / total) * 5) : 0;
  let r = total ? 5 - g : 0;
  if (add > 0 && g === 0) (g = 1), (r = 4);
  if (del > 0 && r === 0) (r = 1), (g = Math.min(g, 4));
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push(html`<span class=${"db " + (i < g ? "db-a" : i < g + r ? "db-d" : "db-o")}></span>`);
  return html`<span class="diffbar">${cells}</span>`;
}

// The changed-files strip at the END of the scrollable thread (not the fixed dock, so it costs
// no composer viewport). Totals and the PR state only — no file preview: the list is ordered
// latest-modified, so the first three of a 144-file branch are an arbitrary sample that reads
// as a summary (three test files imply "tests only"). Tapping ANYWHERE opens the full list.
// Hidden entirely when the session changed nothing. Refetches on each new transcript revision,
// and again whenever the bridge comes back after a drop.
function ChangesCard() {
  const sid = selectedId.value;
  const rev = transcript.value && transcript.value.rev;
  const online = connected.value;
  // Paint the last-known list for this session immediately (stale-while-revalidate);
  // the fetch below replaces it.
  const [data, setData] = useState(() => (sid && changesDataCache.get(sid)) || null);
  // A session switch must not leave the previous session's files on screen — reset to
  // the NEW session's cached list (or nothing). Declared before the fetch effect so it
  // runs first when `sid` changes.
  useEffect(() => setData((sid && changesDataCache.get(sid)) || null), [sid]);
  useEffect(() => {
    if (!sid) return;
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/changes`, { signal: slowTimeout() });
        if (!r.ok) return;
        const d = await r.json();
        boundedSet(changesDataCache, sid, d);
        if (!stale) setData(d);
      } catch {
        // Unreachable bridge (the normal state on a train). Keep the last known list rather
        // than replacing it with an empty one — an empty list HIDES the card, which reads as
        // "the agent changed nothing". The global offline banner already says why it's stale.
      }
    })();
    return () => (stale = true);
  }, [sid, rev, online]);
  const pr = usePullRequest(sid);
  const files = (data && data.files) || [];
  if (files.length === 0) return null;
  const totAdd = files.reduce((s, f) => s + f.add, 0);
  const totDel = files.reduce((s, f) => s + f.del, 0);
  // The PR chip is display-only here — the strip has ONE action (open the list), and the link
  // out to GitHub lives on the list itself. A merged PR showing at glance level is the point:
  // it says this session's work already landed.
  const prState = pr && PR_TONE[pr.state] ? pr : null;
  // Un-landed work takes the PR's LOC slot: the reason the PR's numbers disagree with the
  // totals right above them beats restating the PR's own delta.
  const chip = syncChip(data);
  // A <div role=button>, NOT a <button>: WebKit (iOS Safari) refuses to render block/flex
  // children inside a <button>, collapsing it to an empty padded box. A div renders its block
  // children everywhere and still takes the click.
  return html`
    <div class="changes-card" role="button" tabindex="0" onClick=${() => (filesView.value = true)}>
      <div class="cc-main">
        <span class="cc-count">${files.length} file${files.length === 1 ? "" : "s"}</span>
        <span class="cadd">+${totAdd}</span>
        <span class="cdel">−${totDel}</span>
        ${diffBar(totAdd, totDel)}
        <span class="cc-chev">→</span>
      </div>
      <div class="cc-meta">
        ${prState &&
        html`<span class=${"pr-chip " + PR_TONE[prState.state]}>${prState.state} #${prState.number}</span>${chip
          ? ""
          : prLoc(prState)}`}
        ${chip && html`<span class="sync-chip"><span class="sync-dot"></span>${chip}</span>`}
        ${baseline(data) && html`<span class="cc-base">${baseline(data)}</span>`}
      </div>
    </div>
  `;
}

// Full-screen diff for one file — the branch-vs-base patch (committed + uncommitted), parsed
// by the shared /diff-lines.js and colored here. The header states the baseline it was
// measured against. A big diff collapses to the first 380 lines behind a "Load full diff" tap.
const DIFF_COLLAPSE = 380;
// Strips `@@ -1,4 +1,6 @@` off a hunk header, keeping only git's trailing context (the
// enclosing function). Line numbers are noise on a phone; the function name is the one bit of
// "where am I" worth the row.
const HUNK_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?/;
// A wholly-new or wholly-deleted file has no context lines and only one kind of change, so the
// gutter marks, row tints and hunk header are constants — three channels spent restating the
// `A`/`D` badge already in the header, at the cost of contrast and 14px of width. Such a file
// renders as a plain listing instead.
const isUniform = (lines) => {
  const kinds = new Set(lines.map((l) => l.t));
  return !kinds.has("ctx") && !(kinds.has("add") && kinds.has("del"));
};
function DiffView() {
  const v = diffView.value;
  const [data, setData] = useState(null);
  const [wrap, setWrap] = useState(false);
  const [full, setFull] = useState(false);
  const { rootRef } = useSwipeBack(() => (diffView.value = null), [v ? v.path : null]);
  const sid = selectedId.value;
  const path = v ? v.path : null;
  const orig = v ? v.orig : null; // old path of a rename → the route diffs both endpoints
  // A row opened from a tier carries that tier's range, so the patch shown is the one its LOC
  // was measured over. A row without a range gets the branch-vs-base diff.
  const from = v && v.from ? v.from : null;
  const to = v && v.to ? v.to : "";
  useEffect(() => {
    if (!path) return;
    setData(null);
    setFull(false);
    let stale = false;
    (async () => {
      try {
        const range = from ? `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : "";
        const q = `path=${encodeURIComponent(path)}${orig ? `&orig=${encodeURIComponent(orig)}` : ""}${range}`;
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/diff?${q}`, { signal: slowTimeout() });
        // A failed REQUEST is not a git answer: keep the two apart so an unreachable bridge
        // never renders as "this file has no changes".
        const d = r.ok ? await r.json() : { error: true };
        if (!stale) setData(d);
      } catch {
        if (!stale) setData({ offline: true });
      }
    })();
    return () => (stale = true);
  }, [path, orig, sid, from, to]);
  if (!v) return null;
  const bad = data && (data.error || data.offline);
  // Re-indent to 2 spaces per level: a 4-space file at depth 5 spends 20 of ~45 phone columns
  // before the first character. Leading whitespace only, levels preserved — see narrowIndent.
  const parsed = data && !bad && data.patch ? narrowIndent(parseDiffLines(data.patch)) : [];
  // A non-empty patch that strips to zero display lines is a metadata-only change (file
  // mode, pure rename) — render a notice, not a blank body.
  const metaOnly = data && !bad && data.patch && parsed.length === 0;
  const ok = parsed.length > 0;
  const lines = parsed;
  const plain = ok && isUniform(lines);
  // A plain listing has no hunk headers to show — a new file's single `@@` row would be a
  // lone piece of diff chrome above otherwise ordinary code.
  const body = plain ? lines.filter((l) => l.t !== "hunk") : lines;
  const shown = full ? body : body.slice(0, DIFF_COLLAPSE);
  // For a tier diff the ref pair ("origin/feat…HEAD") is noise — the group's own name is what
  // says the patch is scoped, and it's the name the reader just tapped under.
  const scope = v.tier ? TIER_META[v.tier].label : baseline(data) || "—";
  const sub = data && !bad ? `${scope} · +${data.add} −${data.del}` : path;
  // The basename alone is ambiguous in any repo with repeated leaf names (`app/[slug]/page.tsx`
  // vs `app/s/page.tsx`), so the header carries the directory too — dimmed and truncating, the
  // same treatment the file list uses.
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return html`
    <div class="screen files-view diff-view" ref=${rootRef}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${() => (diffView.value = null)} aria-label="Back to session">‹</button>
        <span class="grow"
          ><span class="fl-path dv-name"
            >${data && data.status
              ? html`<span class=${"fl-badge " + (STATUS_CLASS[data.status] || "st-o")}>${data.status}</span>`
              : ""}<span class="fl-dir">${dir}</span><span class="fl-base">${base}</span></span
          ><span class="sub">${sub}</span
          >${data && data.orig && html`<span class="sub dv-rename">renamed from ${data.orig}</span>`}</span
        >
        ${ok &&
        html`<button
          class=${"hdrtoggle" + (wrap ? " on" : "")}
          aria-pressed=${wrap ? "true" : "false"}
          onClick=${() => setWrap(!wrap)}
        >
          wrap
        </button>`}
      </div>
      <div class="scroll" style="padding:0">
        ${!data && html`<div class="sub" style="padding:12px">loading…</div>`}
        ${data && data.offline && html`<div class="guard">Couldn't reach the bridge — diff not loaded.</div>`}
        ${data && data.error && html`<div class="guard">Couldn't load this file — it may have moved.</div>`}
        ${data && data.empty && html`<div class="guard">No changes vs ${data.base || "the base branch"}.</div>`}
        ${metaOnly && html`<div class="guard">Metadata-only change (file mode or rename) — no content diff.</div>`}
        ${data && data.binary && html`<div class="guard">Binary file — not shown.</div>`}
        ${data && data.tooLarge && html`<div class="guard">Diff too large to preview.</div>`}
        ${ok &&
        html`<div class=${"diffbody" + (wrap ? " wrap" : "") + (plain ? " plain" : "")}>
          ${shown.map((l, i) =>
            plain
              ? html`<div class="dl plain" key=${i}><span class="c">${l.s}</span></div>`
              : l.t === "hunk"
                ? html`<div class="dl hunk" key=${i}><span class="c">${l.s.replace(HUNK_RANGE, "")}</span></div>`
                : html`<div class=${"dl " + l.t} key=${i}>
                    <span class="g">${l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
                    <span class="c">${l.s}</span>
                  </div>`,
          )}
          ${!full &&
          body.length > DIFF_COLLAPSE &&
          html`<button class="loadfull" onClick=${() => setFull(true)}>Load full diff (${body.length} lines)</button>`}
        </div>`}
      </div>
    </div>
  `;
}

// The session branch's GitHub PR, at the top of the changed-files list — the exit from this
// glance surface to the real review surface (docs/adr/0001). Renders nothing when there's
// nothing to link (default branch, no GitHub remote, no gh), so it never becomes a dead row on
// the repos worked directly on main.
const PR_TONE = { open: "pr-open", draft: "pr-draft", merged: "pr-merged", closed: "pr-closed" };
// The PR's own LOC delta (GitHub's merge-base diff). Distinct from the changed-files totals,
// which include uncommitted and untracked work the PR hasn't seen.
const prLoc = (d) =>
  html`<span class="pr-loc"><span class="cadd">+${d.add}</span> <span class="cdel">−${d.del}</span></span>`;
function usePullRequest(sid) {
  // Same stale-while-revalidate as ChangesCard: last-known PR paints instantly, the
  // fetch replaces it (the /pr route itself revalidates behind its 60s freshness).
  const [d, setD] = useState(() => (sid && prDataCache.get(sid)) || null);
  useEffect(() => {
    setD((sid && prDataCache.get(sid)) || null);
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/pr`, { signal: slowTimeout() });
        if (!r.ok) return;
        const fresh = await r.json();
        boundedSet(prDataCache, sid, fresh);
        if (!stale) setD(fresh);
      } catch {
        // Unreachable bridge — the surrounding surfaces already report it; stay silent here.
      }
    })();
    return () => (stale = true);
  }, [sid]);
  return d && d.state !== "none" ? d : null;
}

function PrRow({ sid }) {
  const d = usePullRequest(sid);
  if (!d) return null;
  // Not pushed: no link to give, but say so — otherwise the absence reads as "no PR exists"
  // when the truth is "this work has never left your Mac".
  if (d.state === "local-only")
    return html`<div class="pr-row pr-inert">
      <span class="pr-chip pr-closed">local</span>
      <span class="pr-text">${d.branch} isn't pushed yet</span>
    </div>`;
  if (d.state === "no-pr")
    return html`<a class="pr-row" href=${d.compareUrl} target="_blank" rel="noreferrer">
      <span class="pr-chip pr-draft">no pr</span>
      <span class="pr-text">Open a pull request for ${d.branch}</span>
      <span class="pr-out">↗</span>
    </a>`;
  // One line: the title truncates, everything else is fixed-width. `reviewDecision` is
  // deliberately not shown — it would either wrap the row or eat the title.
  return html`<a class="pr-row" href=${d.url} target="_blank" rel="noreferrer">
    <span class=${"pr-chip " + PR_TONE[d.state]}>${d.state} #${d.number}</span>
    <span class="pr-text">${d.title}</span>
    ${prLoc(d)}
    <span class="pr-out">↗</span>
  </a>`;
}

// Full changed-files list pushed over the detail (the card's "view all" target). Same
// session-scoped /changes source, latest-modified first; tapping a row opens that file's diff.
function FilesView() {
  const open = filesView.value;
  const rev = transcript.value && transcript.value.rev;
  const [data, setData] = useState(null);
  const online = connected.value;
  const { rootRef } = useSwipeBack(() => (filesView.value = false), [open]);
  const sid = selectedId.value;
  // Never carry one session's file list into another — reset to the new session's
  // cached list (shared with ChangesCard). Declared before the fetch effect so it
  // runs first when `sid` changes.
  useEffect(() => setData((sid && changesDataCache.get(sid)) || null), [sid]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/changes`, { signal: slowTimeout() });
        const d = r.ok ? await r.json() : { error: true };
        if (r.ok) boundedSet(changesDataCache, sid, d);
        if (!stale) setData(d);
      } catch {
        // Unreachable bridge: hold the last known list (see ChangesCard) and say so only
        // when there's nothing to hold.
        if (!stale) setData((prev) => (prev && prev.files ? prev : { offline: true }));
      }
    })();
    return () => (stale = true);
  }, [open, sid, rev, online]);
  if (!open) return null;
  const bad = data && (data.error || data.offline);
  const files = (data && data.files) || [];
  const tiers = (data && data.tiers) || [];
  const grouped = tiers.length > 0;
  const row = (f, tier) => html`<div
    class="changerow"
    role="button"
    tabindex="0"
    key=${(tier ? tier.key : "") + f.path}
    onClick=${() =>
      (diffView.value = { path: f.path, orig: f.orig, ...(tier ? { from: tier.from, to: tier.to, tier: tier.key } : {}) })}
  >
    ${fileLine(f)}
  </div>`;
  return html`
    <div class="screen files-view" ref=${rootRef}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${() => (filesView.value = false)} aria-label="Back to session">‹</button>
        <!-- Grouped: the baseline alone. Summing the tiers would DOUBLE-COUNT a file that was
             pushed and then edited again — it legitimately appears in two groups — and the
             group headers already carry the honest per-range counts. -->
        <span class="grow"
          ><span class="name">Changed files</span>${data &&
          !bad &&
          html`<span class="sub"
            >${grouped ? baseline(data) : `${files.length}${baseline(data) ? ` · ${baseline(data)}` : ""}`}</span
          >`}</span
        >
      </div>
      <div class="scroll">
        <${PrRow} sid=${sid} />
        ${!data && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${data && data.offline && html`<div class="guard">Couldn't reach the bridge — list not loaded.</div>`}
        ${data && data.error && html`<div class="guard">No live repo for this session.</div>`}
        ${data && !bad && files.length === 0 && !grouped && html`<div class="guard">No file changes yet.</div>`}
        ${grouped
          ? tiers.map(
              (t) => html`<div class=${"tier " + TIER_META[t.key].tone} key=${t.key}>
                ${tierHead(t)}
                <div class="tier-body">${t.files.map((f) => row(f, t))}</div>
              </div>`,
            )
          : files.map((f) => row(f, null))}
      </div>
    </div>
  `;
}

function App() {
  if (loadingAuth.value) return html`<${Spinner} />`;
  if (!authed.value) return html`<${Login} />`;
  const screen = showNewSession.value
    ? html`<${NewSession} />`
    : selectedId.value
      ? html`<${Detail} />`
      : showHistory.value
        ? html`<${History} />`
        : html`<${List} />`;
  // Bottom connectivity banner: a failed fetch ("bridge unreachable") is the persistent
  // state (stays until a refresh succeeds); a dropped SSE socket is the transient one.
  const banner = error.value === "bridge unreachable" ? "bridge unreachable" : !connected.value ? "reconnecting…" : null;
  return html`${screen}${banner && html`<div class="offline">${banner}</div>`}<${ActionSheet} /><${SessionSheet} /><${ConfigSheet} /><${AgentList} /><${SubagentView} /><${DiffView} /><${FilesView} /><${NoticeToast} /><${CopiedToast} />`;
}

// A brief centered "✓ copied" pill, shown on any successful clipboard write.
// Selection sheets for /model and /effort. Options mirror Claude's own pickers. The current
// value is read from the pane-scraped statusline (transcript.model / .effort, arg keys); note
// "Default" reads as `opus` on the statusline, so Opus is marked when Default is active.
const MODEL_OPTS = [
  { key: "default", label: "Default", sub: "recommended · Opus 5 1M" },
  { key: "opus[1m]", label: "Opus", sub: "Opus 5 · 1M context" },
  { key: "claude-opus-4-8[1m]", label: "Opus 4.8", sub: "previous Opus · 1M context" },
  { key: "fable", label: "Fable", sub: "Fable 5" },
  { key: "sonnet", label: "Sonnet", sub: "Sonnet 5" },
  { key: "haiku", label: "Haiku", sub: "Haiku 4.5" },
];
const EFFORT_OPTS = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "xhigh", label: "xHigh" },
  { key: "max", label: "Max" },
  { key: "ultracode", label: "Ultracode", sub: "this session only" },
];

function ConfigSheet() {
  const c = configSheet.value;
  if (c == null) return null;
  const close = () => (configSheet.value = null);
  const t = transcript.value;
  const current = c.kind === "model" ? t && t.model : t && t.effort;
  const opts = c.kind === "model" ? MODEL_OPTS : EFFORT_OPTS;
  const title = c.kind === "model" ? "Model" : "Reasoning effort";
  const apply = async (key) => {
    const sid = selectedId.value;
    close();
    const body = c.kind === "model" ? { model: key } : { effort: key };
    const data = await actionJson(`/sessions/${encodeURIComponent(sid)}/config`, body);
    if (data && data.line) notify(data.line); // Claude's verbatim confirmation (states the scope)
  };
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead"><span class="name">${title}</span></div>
          ${opts.map(
            (o) => html`<button
              key=${o.key}
              class=${"cfgopt" + (o.key === current ? " current" : "")}
              onClick=${() => apply(o.key)}
            >
              <span class="cfglabel">${o.label}${o.sub ? html`<span class="cfgsub">${o.sub}</span>` : ""}</span>
              ${o.key === current ? html`<span class="cfgmark">✓</span>` : ""}
            </button>`,
          )}
          <button class="sheetcancel" onClick=${close}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function NoticeToast() {
  if (!notice.value) return null;
  return html`<div class="notice-toast">${notice.value}</div>`;
}

function CopiedToast() {
  if (!copied.value) return null;
  return html`<div class="copied-toast">✓ copied</div>`;
}

// Resume sync: iOS suspends backgrounded tabs and standalone PWAs and tears down the SSE
// socket. On return to foreground, immediately re-fetch (HTTP works even if the stream is
// stale) and re-establish the stream if it isn't OPEN. Covers tab/PWA resume-from-memory;
// `pageshow` (persisted) covers iOS's bfcache-style restore. Cold relaunch is handled by boot.
// Opening/focusing the app means you're looking — dismiss any push notifications
// still sitting in the shade and clear the badge. getNotifications() lives on the SW
// registration; getRegistration() (not .ready, which hangs forever without a worker)
// so a non-PWA tab that never registered resolves undefined instead of blocking.
async function dismissNotifications() {
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (!reg) return;
    for (const n of await reg.getNotifications()) n.close();
  } catch {
    /* best-effort — the badge is already cleared above */
  }
}

// Foreground burst: for the first 30s after a resync, a stream that hasn't
// demonstrably opened is rebuilt every 4s. A waking Tailscale tunnel can
// black-hole traffic with no error delivered — the EventSource just sits
// CONNECTING — and the steady-state watchdog retries at most once per 40s,
// which reads as a frozen app. Decision logic is pure (shared/reconnect.js);
// this owns only the timer. resync() also stamps lastStreamActivity so the
// watchdog stays quiet for its full 40s window while the burst owns recovery
// — two uncoordinated timers would tear down each other's half-connected
// EventSource during exactly the window this exists to cover.
let burstTimer = null;
let burstStartedAt = 0;
function stopBurst() {
  clearInterval(burstTimer);
  burstTimer = null;
}
function startBurst() {
  stopBurst();
  burstStartedAt = Date.now();
  burstTimer = setInterval(() => {
    const act = burstAction({
      burstStartedAt,
      lastOpenAt,
      hidden: document.visibilityState !== "visible",
      now: Date.now(),
    });
    if (act === "stop") return stopBurst();
    connectStream();
  }, 4_000);
}

function resync() {
  if (!authed.value) return;
  tick.value = Date.now(); // ages froze while the tab was hidden — catch them up first
  stampStream(); // hold the 40s watchdog off — the burst owns recovery right now
  startBurst();
  // Foregrounding is ONE action now: rebuild the stream. The server's on-connect
  // snapshots (sessions + the re-subscribed transcript) replace the old three racing
  // refetches, so the first paint after a wake is already the current world.
  // ALWAYS rebuild — no readyState check: iOS can resume the page with the socket long
  // dead but no error ever delivered, so the EventSource still claims OPEN; gating on
  // readyState keeps that zombie and the app never hears another push.
  // The notification-tap check runs against the FRESH list: the on-connect snapshot
  // satisfies it (see pendingTapCheck in onmessage); if no snapshot lands within 2.5s
  // (connect failing/slow), fall back to a direct GET so a tap is never dropped.
  pendingTapCheck = true;
  setTimeout(() => {
    if (!pendingTapCheck) return;
    pendingTapCheck = false;
    refreshSessions().then(followNotificationTap);
  }, 2500);
  connectStream();
  if (openSubagent.value) refreshSubagent();
}
// Advance the age clock once a minute while the page is visible — the labels' finest
// unit is minutes, so anything faster is wasted renders. A backgrounded tab stops
// ticking; `resync` catches it up on return.
let tickTimer;
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => (tick.value = Date.now()), 60_000);
}
function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}
startTick();

// Backgrounded/evicted: close the stream FIRST so the server's heartbeat stops
// touching this device's consumer marker on the lingering socket (iOS keeps it
// alive ~30s), then tell the bridge we're gone — pushes resume immediately
// instead of after the 40s staleness window. `resync` on return reopens the
// stream (re-touching the marker).
function sendGoodbye() {
  // Drop pending read clears: a suspended timer would fire on resume against the
  // pre-background list and could consume an ⚡ set while away. Runs on both the
  // visibilitychange-hidden path and the pagehide backstop; the resume resync's
  // payload re-arms for the open session once fresh data lands.
  for (const t of readTimers.values()) clearTimeout(t);
  readTimers.clear();
  stopBurst(); // the closed stream is deliberate — don't fight it from the background
  if (es) {
    es.close();
    es = null;
  }
  try {
    navigator.sendBeacon("/push/goodbye", DEVICE_ID);
  } catch {
    /* staleness fallback covers it */
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startTick();
    resync();
  } else {
    stopTick();
    sendGoodbye();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resync();
});
// iOS sometimes evicts without a visibilitychange — pagehide is the backstop.
window.addEventListener("pagehide", sendGoodbye);

// --- boot: probe auth; the cookie (if present from a prior visit) authenticates ---
// The static boot spinner in index.html owns the screen during this probe. We delay
// Preact's first render() until the probe resolves so its first paint is already the
// list/login — never a second spinner that would replace the static one and restart
// its animation (the flicker). After boot, the in-app Spinner covers manual logins.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  loadingAuth.value = false;
  render(html`<${App} />`, document.getElementById("app"));
}

// Deep link from a push notification: ?s=<sessionId>. Once the first snapshot
// lands, open that session (if it exists) and drop the query so a refresh/back
// doesn't re-trigger it.
function applyDeepLink() {
  const id = new URLSearchParams(location.search).get("s");
  if (!id) return;
  if (sessions.value.some((s) => s.id === id)) open(id);
  history.replaceState(null, "", location.pathname);
}

// Push-tap handoff via the SW's cache (see stashTarget in sw.js). Only the COLD launch
// writes this — iOS never dispatches notificationclick to an already-running PWA — but it
// is the exact signal when it exists, so it's checked before the shade heuristic below.
// Consumed on boot AND on foreground: the SW may write the target after boot already ran
// (the launch races the notificationclick handler), so visibilitychange catches it too.
// Delete-on-read + a 2-min TTL keep a manual open from jumping to a stale tap.
async function takeStashedTap() {
  if (!("caches" in self)) return null;
  try {
    const cache = await caches.open("claude0-nav");
    const res = await cache.match("pending");
    if (!res) return null;
    await cache.delete("pending");
    const { sessionId, at } = await res.json();
    return sessionId && Date.now() - at <= 120_000 ? sessionId : null;
  } catch {
    return null; // cache unavailable — the shade diff still covers the warm case
  }
}

// Which sessions the bridge pushed to us lately (delete-on-read server-side).
// Deliberately NOT read from the service worker: iOS hands a warm-resumed page a
// stale CacheStorage snapshot, so a record the worker wrote seconds earlier reads
// back empty — measured on-device at 2.8s and again at 9s. The sender knows what
// it sent, and a network read has no cross-context storage semantics to go wrong.
async function takePushedRecord() {
  try {
    const r = await fetch(`/push/recent?device=${encodeURIComponent(DEVICE_ID)}`);
    if (!r.ok) return {};
    const { pushes } = await r.json();
    return pushes || {};
  } catch {
    return {}; // offline — nothing to attribute, so nothing moves
  }
}

// Foreground/boot: decide whether a notification tap brought us here, then open that
// session. Order is load-bearing — the tap signal IS the shade, so it must be read
// before dismissNotifications() closes everything. Both signals are consumed every
// time (even when the first one wins) so neither can go stale and fire later.
async function followNotificationTap() {
  const stashed = await takeStashedTap(); // cold launch: exact
  const pushed = await takePushedRecord();
  let tapped = null;
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) {
      const shown = await reg.getNotifications();
      tapped = tapTarget(
        pushed,
        // Tags are `${sessionId}|${ts}` (unique per push, see sw.js) — strip to
        // the session id, which is what the pushed ledger is keyed by.
        shown.map((n) => (n.tag || "").split("|")[0]),
        Date.now(),
      );
    }
  } catch {
    /* no registration (plain tab) — the stashed path may still have a target */
  }
  const id = stashed || tapped;
  // Only navigate to a session the list can actually resolve: a tap attributed to an
  // ops alert's sentinel or a since-vanished session would open a paneless, sendless
  // detail view. Unknown id ⇒ stay put (the tap still counts as "looking": dismiss).
  const known = id && sessions.value.some((s) => s.id === id);
  if (known && selectedId.value !== id) open(id);
  else if (known) markRead(id); // already open — still consume the ⚡ this tap answered
  dismissNotifications(); // you're looking now — clear the shade + badge
}

// Stale-while-revalidate boot: iOS evicts the backgrounded page constantly, so the most
// common interaction — reopen after minutes — used to boot from a blank spinner. Paint
// the last-persisted list immediately and let the auth probe below reconcile: a fresh
// snapshot replaces it in place, and a 401 flips authed → the login screen as before.
try {
  const saved = JSON.parse(localStorage.getItem("claude0-sessions") || "null");
  if (Array.isArray(saved) && saved.length) {
    rawSessions = saved; // overlays re-derive from the raw list — keep it in step
    sessions.value = saved;
    authed.value = true;
    boot();
  }
} catch {
  /* corrupt/absent snapshot — normal spinner boot */
}

let bootTimeout;
Promise.all([refreshSessions(), refreshPreferences()])
  .then(() => {
    clearTimeout(bootTimeout);
    if (authed.value) {
      applyDeepLink();
      followNotificationTap(); // also clears the shade + badge
      connectStream();
      initPush();
    }
  })
  .finally(boot);

// Timeout: if the auth probe hangs >20s, give up the spinner and show login/error.
bootTimeout = setTimeout(() => {
  if (!authed.value) error.value = "connection timeout";
  boot();
}, 20000);
