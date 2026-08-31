import blessed from "blessed";
import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, moveToGroup, getSelectableIndices } from "./ui/session-list";
import { handleTextInputKey, renderTextWithCursor } from "./ui/text-input";
import { updatePreview, getPreviewPlainText, renderMessage } from "./ui/preview-pane";
import { discoverSessions, groupSessions, seedPaneSessionCache, readNamingExtras } from "./core/sessions";
import { readPreviewMessages, type PendingToolCall, type PendingQuestion } from "./core/jsonl-reader";
import { switchToPane, getMainSession, killPane, sendKeys, sendKeysSequential, sendTextAndEnter, answerQuestion } from "./core/tmux";
import { loadNameCache, getSessionName, generateAIName, saveNameCache, slugify, type NameCache } from "./core/names";
import { loadConfig, configCache, DEFAULT_CONFIG } from "./core/config";
import { loadState, saveState, loadPaneSessions } from "./core/state";
import { listPendingApprovals, decideApproval, decideQuestion, buildAnswersMap } from "./core/approval";
import { syncWindowPrefix, buildBaseName, abbreviateRepo } from "./core/notifications";
import { discoverRepos, listBranches, fetchRepo, getDefaultBranch, branchCheckedOutPath, ensureWorktreeIgnore, WORKTREES_DIR } from "./core/git";
import { buildLaunchCommand, USER_SHELL } from "./core/launch-command";
import { copyToClipboard } from "./core/clipboard";
import { initWizard, renderWizard, renderWizardPreview, renderWizardStatusBar, handleWizardKey, setWizardBranches } from "./ui/wizard";
import { loadAllSessions, searchEntries, type SearchEntry } from "./core/search";
import { recoverWorktreeTranscript } from "./core/recover";
import { detectScriptWaits } from "./core/script-wait";
import { parkedJobSessions } from "./core/session-state";
import { renderSearchResults } from "./ui/search-list";
import { createSpaceMenuState, renderSpaceMenu, handleSpaceMenuKey, getMenuDimensions, type SpaceMenuState } from "./ui/space-menu";
import { createQuestionPicker, renderQuestionPicker, handleQuestionPickerKey, getPickerDimensions, type QuestionPickerState } from "./ui/question-picker";
import { C } from "./ui/colors";
import type { DisplayRow, Session, Config, WizardState, WizardRepo, GlobalSearchState, WorktreeMode } from "./types";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

// Guard: refuse to run without a proper terminal.
// Prevents orphaned background processes (e.g. from bun --watch after terminal closes)
// from continuously overwriting state.json with stale attention flags.
if (!process.stdout.isTTY) {
  process.exit(0);
}

const focusPaneId = process.env.CLAUDE0_FOCUS_PANE?.match(/^%\d+$/)
  ? process.env.CLAUDE0_FOCUS_PANE
  : null;

const { screen, listBox, previewBox, statusBar } = createLayout();

let rows: DisplayRow[] = [];
let allSessions: Session[] = [];
let selectedIndex = -1;
let cachedSession: Session | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let isRefreshing = false;
let previewGeneration = 0;
let showArchived = false;
let nameCache: NameCache = { version: 6, names: {}, sources: {} };
// Placeholder until loadConfig() resolves at startup; derived from the shipped
// defaults so this can't drift into a fourth hand-written copy of the shape.
let notifConfig: Config = structuredClone(DEFAULT_CONFIG);

// Wizard state (null = not in wizard mode)
let wizardState: WizardState | null = null;
let wizardLaunching = false;
// Flag: true while keypress handler is processing a wizard key this tick.
// Prevents screen.key() handlers (which fire after keypress) from acting
// on a key the wizard already consumed (e.g. Escape = cancel, not quit).
let wizardHandledKey = false;

// Global search state (null = not in search mode)
let globalSearch: GlobalSearchState | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let preSearchIndex = -1; // selection before search started

// Attention type tracking: what kind of transition triggered attention
const attentionTypes = new Map<string, "blocked" | "turnComplete">();

// Kill confirmation state
let pendingKillPaneId: string | null = null;
let killConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// Space menu state (null = not in menu mode)
let spaceMenu: SpaceMenuState | null = null;
let menuBox: blessed.Widgets.BoxElement | null = null;
// Flag: true while keypress handler is processing a space menu key this tick.
// Prevents screen.key() handlers from acting on a key the menu already consumed.
let spaceMenuHandledKey = false;

// Cached pending tool call from last preview update
let cachedPendingToolCall: PendingToolCall | null = null;

// Inline text input state for custom answers (t key)
let customInputState: { text: string; cursor: number } | null = null;

// Multi-question AskUserQuestion picker overlay (opens when a prompt has >1 question).
let multiQuestionPicker: QuestionPickerState | null = null;
// Suppress the picker's own keypress handler from re-processing the digit that opened it.
let pickerJustOpened = false;

// Guard against async double-fire (e.g. Enter pressed twice before first completes)
let isExiting = false;

// Attention state — populated from monitor's state.json each refresh
const needsAttention = new Set<string>();
// Persists across refreshes. Entries cleaned up when monitor clears the attention.
const localDismissals = new Set<string>();

/** Get attention + running flags for OTHER panes in the same window */
function getWindowFlags(session: Session, sessions: Session[]): { hasAttention: boolean; hasRunning: boolean } {
  if (!session.tmuxPane) return { hasAttention: false, hasRunning: false };
  const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
  let hasAttention = false;
  let hasRunning = false;
  for (const s of sessions) {
    if (!s.tmuxPane) continue;
    if (`${s.tmuxPane.sessionName}:${s.tmuxPane.windowIndex}` !== wKey) continue;
    if (s.tmuxPane.paneId === session.tmuxPane.paneId) continue;
    if (needsAttention.has(s.tmuxPane.paneId)) hasAttention = true;
    if (s.status === "running") hasRunning = true;
  }
  return { hasAttention, hasRunning };
}

function updateStatusBar() {
  if (wizardState) return; // Don't overwrite wizard status bar
  if (globalSearch) return; // Don't overwrite search bar
  if (spaceMenu) return; // Don't overwrite while menu is open
  if (flashTimer) return; // Don't overwrite active flash messages
  if (customInputState || multiQuestionPicker) return; // Don't overwrite inline text input
  const session = getSelectedSession();
  renderStatusBar(statusBar, session?.status, showArchived,
    session?.status === "waiting" ? cachedPendingToolCall : null);
}

// --- Space menu helpers ---

function getOrCreateMenuBox() {
  if (!menuBox) {
    menuBox = blessed.box({
      parent: screen,
      bottom: 2,
      left: 2,
      width: 24,
      height: 8,
      border: { type: "line" },
      tags: true,
      hidden: true,
      style: {
        bg: C.surface,
        fg: C.muted,
        border: { fg: C.dim, bg: C.surface },
      },
      padding: { left: 1, right: 1 },
    });
  }
  return menuBox!;
}

function updateMenuBox() {
  if (!spaceMenu) return;
  const box = getOrCreateMenuBox();
  const dims = getMenuDimensions(spaceMenu);
  box.width = dims.width;
  box.height = dims.height;
  box.setContent(renderSpaceMenu(spaceMenu));
}

function openSpaceMenu() {
  // Free-text send is only offered at a prompt (Inc5): ready or waiting-input.
  const status = getSelectedSession()?.status;
  const canSend = status === "ready" || status === "waiting";
  spaceMenu = createSpaceMenuState(canSend);
  const box = getOrCreateMenuBox();
  updateMenuBox();
  box.show();
  screen.render();
}

function closeSpaceMenu() {
  spaceMenu = null;
  const box = getOrCreateMenuBox();
  box.hide();
  updateStatusBar();
  screen.render();
}

// --- Multi-question picker (reuses the menu overlay box; never open alongside the space menu) ---

function updateQuestionBox() {
  if (!multiQuestionPicker) return;
  const box = getOrCreateMenuBox();
  const dims = getPickerDimensions(multiQuestionPicker);
  box.width = dims.width;
  box.height = dims.height;
  box.setContent(renderQuestionPicker(multiQuestionPicker));
}

function openQuestionPicker(questions: PendingQuestion[]) {
  multiQuestionPicker = createQuestionPicker(questions);
  const box = getOrCreateMenuBox();
  updateQuestionBox();
  box.show();
  screen.render();
}

function closeQuestionPicker() {
  multiQuestionPicker = null;
  const box = getOrCreateMenuBox();
  box.hide();
  updateStatusBar();
  screen.render();
}

async function handleCopy() {
  const text = getPreviewPlainText();
  if (!text) {
    flashStatusMessage(`{${C.dim}-fg}Nothing to copy{/${C.dim}-fg}`);
    return;
  }
  const ok = await copyToClipboard(text);
  if (ok) {
    flashStatusMessage(`{${C.mint}-fg}Copied to clipboard{/${C.mint}-fg}`);
  } else {
    flashStatusMessage(`{${C.red}-fg}Copy failed{/${C.red}-fg}`);
  }
}

function handleRename() {
  const session = getSelectedSession();
  if (!session || !session.firstPrompt) {
    flashStatusMessage(`{${C.dim}-fg}No prompt to generate name from{/${C.dim}-fg}`);
    return;
  }
  if (session.status === "archived") {
    flashStatusMessage(`{${C.dim}-fg}AI naming disabled for archived sessions{/${C.dim}-fg}`);
    return;
  }
  flashStatusMessage(`{${C.muted}-fg}Generating name\u2026{/${C.muted}-fg}`);
  const sessionId = session.id;
  const sessionSummary = session.summary;
  const sessionFirstPrompt = session.firstPrompt;
  const sessionLastPrompt = session.lastPrompt;
  // Fire-and-forget: the TUI stays responsive while `claude -p` runs. 30s budget
  // (vs the monitor's 15s) so a cold start resolves in one attempt instead of
  // being killed mid-rename and leaving the window blank.
  void (async () => {
    const extras = await readNamingExtras(session.repoPath, sessionId);
    const name = await generateAIName({
      firstPrompt: sessionFirstPrompt,
      summary: sessionSummary,
      branch: session.branch,
      lastPrompt: sessionLastPrompt,
      ...extras,
      timeoutMs: 30_000,
    });
    // Reload-and-merge: capture any name the monitor wrote while `claude -p` ran.
    const fresh = await loadNameCache();
    if (name) {
      fresh.names[sessionId] = name;
      fresh.sources[sessionId] = sessionLastPrompt || sessionSummary || sessionFirstPrompt;
    }
    // On failure, keep whatever name was already there — a stale name beats a blank
    // window, and the monitor retries naming in the background.
    nameCache = fresh;
    await saveNameCache(fresh);
    await refresh();
    if (!name) flashStatusMessage(`{${C.dim}-fg}Name generation failed{/${C.dim}-fg}`);
  })().catch(() => {});
}

function renderSearchBar() {
  if (!globalSearch) return;
  const text = renderTextWithCursor(globalSearch.query, globalSearch.cursor);
  const shown = globalSearch.results.length;
  const countStr = globalSearch.loading
    ? "loading…"
    : globalSearch.total > shown
      ? `${shown} of ${globalSearch.total}`
      : `${shown} result${shown === 1 ? "" : "s"}`;
  const enterHint = getSelectedSearchEntry()?.isActive ? "switch" : "resume";
  const escHint = globalSearch.query ? "clear" : "close";
  statusBar.setContent(
    `{${C.peach}-fg}/{/${C.peach}-fg} ${text}` +
    `  {${C.dim}-fg}${countStr}  ↑/↓ move  ⏎ ${enterHint}  ^U/^D scroll  repo: filter  Esc ${escHint}{/${C.dim}-fg}`,
  );
}

function applySearchFilter() {
  if (!globalSearch) return;
  const { results, total } = searchEntries(globalSearch.entries, globalSearch.query);
  globalSearch.results = results;
  globalSearch.total = total;
  if (globalSearch.results.length > 0) {
    globalSearch.selectedIndex = Math.min(globalSearch.selectedIndex, globalSearch.results.length - 1);
  } else {
    globalSearch.selectedIndex = 0;
  }
}

async function exitSearch() {
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  globalSearch = null;
  selectedIndex = preSearchIndex;
  // Clamp to valid range
  const selectable = getSelectableIndices(rows);
  if (selectable.length > 0 && !selectable.includes(selectedIndex)) {
    selectedIndex = selectable[0];
  }
  saveSelection();
  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  // Restore preview for the selected session
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  screen.render();
}

/** Get the currently selected search entry (if in search mode) */
function getSelectedSearchEntry(): SearchEntry | null {
  if (!globalSearch || globalSearch.results.length === 0) return null;
  return globalSearch.results[globalSearch.selectedIndex] ?? null;
}

/** Update preview pane for a search result, with staleness guard */
async function updateSearchPreview(entry: SearchEntry | null): Promise<void> {
  if (!entry) {
    previewBox.setContent("");
    return;
  }

  // For active sessions, reuse the existing preview pipeline
  if (entry.isActive) {
    const activeSession = allSessions.find((s) => s.id === entry.sessionId);
    if (activeSession) {
      await safeUpdatePreview(activeSession, { scrollToBottom: true });
      return;
    }
  }

  // Staleness guard — if selection changed while reading JSONL, discard
  const gen = ++previewGeneration;

  // Header: repo/branch · summary
  const boxWidth = typeof previewBox.width === "number" ? previewBox.width : 40;
  const contentWidth = Math.max(10, boxWidth - 4);
  const repoHeader = `${entry.repo}/${entry.branch}`;
  let header = `{${C.muted}-fg}  ${repoHeader}{/${C.muted}-fg}`;
  if (entry.summary) {
    const escaped = entry.summary.replace(/\{/g, "{open}").replace(/\}/g, "{close}").replace(/\n/g, " ");
    const maxLen = Math.max(10, boxWidth - repoHeader.length - 5);
    const trunc = escaped.length > maxLen ? escaped.slice(0, maxLen - 1) + "\u2026" : escaped;
    header += ` {${C.dim}-fg}\u00b7{/${C.dim}-fg} {${C.muted}-fg}${trunc}{/${C.muted}-fg}`;
  }

  // Read messages from JSONL, reusing shared rendering from preview-pane
  let body = "";
  if (entry.fullPath) {
    try {
      const messages = await readPreviewMessages(entry.fullPath, 3);
      if (gen !== previewGeneration) return; // stale
      if (messages.length > 0) {
        body = messages.map((msg) => renderMessage(msg, contentWidth)).join("\n\n");
      }
    } catch {}
  }

  if (!body && entry.firstPrompt) {
    const escaped = entry.firstPrompt.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
    body = `{${C.muted}-fg}${escaped}{/${C.muted}-fg}`;
  }

  if (!body) {
    body = `{${C.dim}-fg}No recent output{/${C.dim}-fg}`;
  }

  if (gen !== previewGeneration) return; // stale
  previewBox.setContent(`${header}\n\n${body}`);
  previewBox.setScrollPerc(100);
}

function flashStatusMessage(msg: string, duration = 2000) {
  if (flashTimer) clearTimeout(flashTimer);
  statusBar.setContent(`  ${msg}`);
  screen.render();
  flashTimer = setTimeout(() => {
    flashTimer = null;
    // updateStatusBar no-ops while search is active, which would leave the flash
    // text stuck in the bar — restore the search bar explicitly.
    if (globalSearch) renderSearchBar();
    else updateStatusBar();
    screen.render();
  }, duration);
}

function getSelectedRow(): DisplayRow | null {
  if (selectedIndex < 0 || selectedIndex >= rows.length) return null;
  return rows[selectedIndex];
}

function getSelectedSession() {
  const row = getSelectedRow();
  if (!row) return null;
  return row.type === "session" ? row.session : null;
}

function saveSelection() {
  cachedSession = getSelectedSession();
}

/** Update preview with staleness guard. Returns true if the result is still current. */
async function safeUpdatePreview(
  session: ReturnType<typeof getSelectedSession>,
  opts?: { scrollToBottom?: boolean; archivedSessions?: Session[] },
): Promise<boolean> {
  const gen = ++previewGeneration;
  const pending = await updatePreview(previewBox, session, opts);
  if (gen === previewGeneration) {
    cachedPendingToolCall = pending ?? null;
    // Keep an open multi-question picker in sync with the live prompt: if the pending
    // question cleared, close it; if a DIFFERENT question opened (Q1 resolved, Q2 up —
    // new tool_use_id), re-open on the new set rather than answering the stale one.
    if (multiQuestionPicker) {
      const openId = multiQuestionPicker.questions[0]?.toolUseId;
      const liveQs = cachedPendingToolCall?.questions;
      const liveId = liveQs?.[0]?.toolUseId;
      if (!liveQs || liveQs.length <= 1) closeQuestionPicker();
      else if (liveId !== openId) openQuestionPicker(liveQs);
    }
    return true;
  }
  return false;
}

async function refresh(opts?: { skipArchivedSummaries?: boolean }) {
  if (isRefreshing) return;
  if (wizardState) return; // Don't overwrite wizard UI with session list
  if (globalSearch) return; // Don't overwrite search UI
  isRefreshing = true;
  try {
    const { sessions, changedPaneIds } = await discoverSessions({
      ...opts,
      nameMap: nameCache.names,
    });
    allSessions = sessions;

    // Reset stale state for panes where session ID changed (e.g. after /clear)
    if (changedPaneIds.size > 0) {
      for (const session of sessions) {
        if (session.tmuxPane && changedPaneIds.has(session.tmuxPane.paneId)) {
          needsAttention.delete(session.tmuxPane.paneId);
          attentionTypes.delete(session.tmuxPane.paneId);
        }
      }
    }

    // Reload name cache from disk (monitor may have generated new names)
    nameCache = await loadNameCache();

    // Assign names from cache (AI-generated only, no heuristic fallback)
    for (const session of sessions) {
      session.name = getSessionName(session.id, nameCache);
    }

    // ⏳ script-wait: a ready session may still be driving a run_in_background
    // script. Same entry point the monitor uses, so the transcript parse and the
    // runner-liveness verdicts come from their shared on-disk caches — launched via
    // `tmux display-popup` this is a fresh process on every open, and nothing held
    // in memory survives to the next one. Visibility only: never affects status,
    // sort, or attention.
    const readyIds = sessions.filter((s) => s.status === "ready" && s.id).map((s) => s.id);
    const scriptWaitIds = readyIds.length > 0 ? await detectScriptWaits(readyIds) : new Set<string>();
    for (const session of sessions) {
      if (scriptWaitIds.has(session.id)) session.scriptWaiting = true;
    }

    // Read attention from monitor's state.json (before grouping — ⚡ sessions sort first)
    const monitorState = await loadState();
    needsAttention.clear();
    attentionTypes.clear();
    for (const [key, s] of Object.entries(monitorState.sessions)) {
      if (s.needsAttention && !localDismissals.has(key)) {
        needsAttention.add(key);
        if (s.attentionType) attentionTypes.set(key, s.attentionType);
      }
    }
    // Clean up dismissed entries the monitor already cleared
    for (const key of localDismissals) {
      if (!monitorState.sessions[key]?.needsAttention) {
        localDismissals.delete(key);
      }
    }

    const groups = groupSessions(sessions, notifConfig.repositories.priority, needsAttention);

    if (groups.length === 0) {
      listBox.setContent(
        `\n\n\n{center}{${C.muted}-fg}No active sessions{/${C.muted}-fg}{/center}\n\n{center}{${C.dim}-fg}Start one with: claude{/${C.dim}-fg}{/center}`,
      );
      previewBox.setContent("");
      rows = [];
      selectedIndex = -1;
      screen.render();
      return;
    }

    rows = buildDisplayRows(groups, showArchived);

    const selectable = getSelectableIndices(rows);

    if (selectable.length === 0) {
      selectedIndex = -1;
      cachedSession = null;
    } else if (selectedIndex < 0) {
      // First load — pre-select focused pane if provided, else first session
      if (focusPaneId) {
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.tmuxPane?.paneId === focusPaneId;
        });
        selectedIndex = found ?? selectable[0];
      } else {
        selectedIndex = selectable[0];
      }
      saveSelection();
    } else {
      // Try to keep cursor on the same session across refreshes
      const paneId = cachedSession?.tmuxPane?.paneId;
      const sessionId = cachedSession?.id;

      if (paneId) {
        // Active session: match by paneId (most reliable)
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.tmuxPane?.paneId === paneId;
        });
        if (found !== undefined) {
          selectedIndex = found;
        }
        // If pane not found in rows, keep selectedIndex as-is — pane still exists in tmux
      } else if (sessionId) {
        // Archived session: match by session ID (stable across reorders)
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.id === sessionId;
        });
        if (found !== undefined) {
          selectedIndex = found;
        } else if (!selectable.includes(selectedIndex)) {
          selectedIndex = selectable.reduce((best, idx) =>
            Math.abs(idx - selectedIndex) < Math.abs(best - selectedIndex) ? idx : best,
          );
        }
      } else if (!selectable.includes(selectedIndex)) {
        // No identifier to match — clamp to nearest selectable
        selectedIndex = selectable.reduce((best, idx) =>
          Math.abs(idx - selectedIndex) < Math.abs(best - selectedIndex) ? idx : best,
        );
      }

      // Keep cachedSession in sync with the actual selected row
      saveSelection();
    }

    const isInitial = !refreshTimer;
    renderSessionList(listBox, rows, selectedIndex, needsAttention);
    updateStatusBar();
    const selectedRow = getSelectedRow();
    const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
    const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: isInitial, archivedSessions });
    if (isCurrent) screen.render();
  } finally {
    isRefreshing = false;
  }
}

async function handleSelect(direction: 1 | -1) {
  if (rows.length === 0) return;
  selectedIndex = moveSelection(rows, selectedIndex, direction);
  saveSelection();

  // Dismiss attention for newly selected session (visual only, monitor clears within 5s)
  const session = getSelectedSession();
  if (session) {
    const key = session.tmuxPane?.paneId ?? session.id;
    if (needsAttention.has(key)) {
      localDismissals.add(key);
      needsAttention.delete(key);
      attentionTypes.delete(key);
    }
  }

  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  if (isCurrent) screen.render();
}

async function handleGroupSelect(direction: 1 | -1) {
  if (rows.length === 0) return;
  selectedIndex = moveToGroup(rows, selectedIndex, direction);
  saveSelection();

  const session = getSelectedSession();
  if (session) {
    const key = session.tmuxPane?.paneId ?? session.id;
    if (needsAttention.has(key)) {
      localDismissals.add(key);
      needsAttention.delete(key);
      attentionTypes.delete(key);
    }
  }

  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  if (isCurrent) screen.render();
}

async function handleEnter() {
  const session = getSelectedSession();
  if (!session?.tmuxPane) return;
  if (isExiting) return;
  isExiting = true;

  const { paneId, sessionName, windowIndex } = session.tmuxPane;
  const key = paneId;
  needsAttention.delete(key);
  attentionTypes.delete(key);

  // Immediate ⚡ clear — don't wait 5s for monitor
  const flags = getWindowFlags(session, allSessions);
  await syncWindowPrefix(sessionName, windowIndex,
    flags.hasAttention, session.status === "running" || flags.hasRunning);

  // Clear attention in state.json (fresh read to avoid overwriting monitor data)
  const freshState = await loadState();
  if (freshState.sessions[key]) {
    freshState.sessions[key].needsAttention = false;
    freshState.sessions[key].attentionType = undefined;
    freshState.lastUpdatedAt = Date.now();
    await saveState(freshState);
  }

  cleanup();
  await switchToPane(paneId, sessionName, windowIndex);
  process.exit(0);
}

async function handleResume() {
  const session = getSelectedSession();
  if (!session) return;
  if (!session.id) return;
  if (isExiting) return;
  isExiting = true;

  const targetSession = await getMainSession();
  if (!targetSession) {
    isExiting = false;
    flashStatusMessage(`{${C.dim}-fg}No tmux session found{/${C.dim}-fg}`);
    return;
  }

  // Relocate to the base repo if the session's worktree was deleted, so the resume lands.
  const effectivePath = await recoverWorktreeTranscript(session.id, session.repoPath, session.baseRepoPath);
  const repoName = effectivePath.split("/").filter(Boolean).pop() ?? "claude";
  cleanup();
  try {
    const cmd = `claude --resume=${session.id}; exec ${USER_SHELL} -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${repoName} -c ${effectivePath} ${USER_SHELL} -c ${cmd}`.quiet();
  } catch (e) {
    console.error(`claude0: failed to resume session: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  process.exit(0);
}

/** Contextual Enter: switch to active sessions, resume archived sessions, expand collapsed archives */
async function handleEnterContextual() {
  const row = getSelectedRow();
  if (!row) return;

  if (row.type === "archive-collapsed") {
    showArchived = true;
    await refresh();
    return;
  }

  const session = getSelectedSession();
  if (!session) return;

  if (session.status === "archived") {
    await handleResume();
  } else {
    await handleEnter();
  }
}

/** Kill handler with double-press confirmation */
async function handleKill() {
  const session = getSelectedSession();
  if (!session) return;

  if (!session.tmuxPane) {
    flashStatusMessage(`{${C.dim}-fg}Can only kill active sessions{/${C.dim}-fg}`);
    return;
  }

  const paneId = session.tmuxPane.paneId;

  if (pendingKillPaneId === paneId) {
    // Second press — confirmed
    if (killConfirmTimer) clearTimeout(killConfirmTimer);
    pendingKillPaneId = null;
    await killPane(paneId);
    flashStatusMessage(`{${C.mint}-fg}Session killed{/${C.mint}-fg}`);
    await refresh();
    return;
  }

  // First press — ask for confirmation
  pendingKillPaneId = paneId;
  flashStatusMessage(`{${C.red}-fg}Kill session? Press x again to confirm{/${C.red}-fg}`);
  if (killConfirmTimer) clearTimeout(killConfirmTimer);
  killConfirmTimer = setTimeout(() => {
    pendingKillPaneId = null;
    updateStatusBar();
    screen.render();
  }, 3000);
}

/** Fork handler: resume --fork in a new tmux window */
async function handleFork() {
  const session = getSelectedSession();
  if (!session) return;
  if (isExiting) return;

  if (!session.id) {
    flashStatusMessage(`{${C.dim}-fg}No session ID to fork{/${C.dim}-fg}`);
    return;
  }
  isExiting = true;

  const targetSession = await getMainSession();
  if (!targetSession) {
    isExiting = false;
    flashStatusMessage(`{${C.dim}-fg}No tmux session found{/${C.dim}-fg}`);
    return;
  }

  // While a live parked job (kind:"bg") owns this session's pane, the on-screen
  // conversation — the one being forked — is the JOB's; fork from its session id.
  const sourceId = (await parkedJobSessions()).get(session.id) ?? session.id;
  // Relocate to the base repo if the session's worktree was deleted, so the fork resume lands.
  const effectivePath = await recoverWorktreeTranscript(sourceId, session.repoPath, session.baseRepoPath);
  const repoName = effectivePath.split("/").filter(Boolean).pop() ?? "claude";
  const forkName = buildBaseName(repoName, session.name ? slugify(session.name) || undefined : undefined, true);

  cleanup();
  try {
    const forkId = crypto.randomUUID();
    const cmd = `claude --session-id ${forkId} --resume=${sourceId} --fork-session; exec ${USER_SHELL} -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${forkName} -c ${effectivePath} ${USER_SHELL} -c ${cmd}`.quiet();
  } catch (e) {
    console.error(`claude0: failed to fork session: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  process.exit(0);
}

function cleanup() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (killConfirmTimer) clearTimeout(killConfirmTimer);
  screen.destroy();
}

// --- Auto-advance and optimistic approve ---

/** Find and select the next waiting session, wrapping around. Returns true if found. */
async function advanceToNextWaiting(): Promise<boolean> {
  const selectable = getSelectableIndices(rows);
  if (selectable.length === 0) return false;

  const startPos = selectable.indexOf(selectedIndex);
  if (startPos < 0) return false;

  for (let offset = 1; offset < selectable.length; offset++) {
    const idx = selectable[(startPos + offset) % selectable.length];
    const row = rows[idx];
    if (row.type === "session" && row.session.status === "waiting") {
      selectedIndex = idx;
      saveSelection();
      renderSessionList(listBox, rows, selectedIndex, needsAttention);
      updateStatusBar();
      const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: true });
      if (isCurrent) screen.render();
      return true;
    }
  }
  return false;
}

/** Optimistically flip session to running and clear cached pending call */
function optimisticApprove(session: Session) {
  session.status = "running";
  cachedPendingToolCall = null;
  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
}

/** Render inline text input bar for custom answers */
function renderCustomInputBar() {
  if (!customInputState || multiQuestionPicker) return;
  const text = renderTextWithCursor(customInputState.text, customInputState.cursor);
  statusBar.setContent(
    `  {${C.peach}-fg}❯{/${C.peach}-fg} ${text}` +
    `  {${C.dim}-fg}Enter send · Esc cancel{/${C.dim}-fg}`,
  );
}

// --- Contextual key handler (y/Y/1-9/t for waiting sessions) ---

screen.on("keypress", async (_ch: string, key: any) => {
  if (!key || wizardState || globalSearch || spaceMenu || multiQuestionPicker) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  // --- Inline text input mode ---
  if (customInputState) {
    // Mark key as consumed
    spaceMenuHandledKey = true;
    queueMicrotask(() => { spaceMenuHandledKey = false; });

    if (keyName === "escape") {
      customInputState = null;
      updateStatusBar();
      screen.render();
      return;
    }

    if (keyName === "enter" || keyName === "return") {
      const text = customInputState.text;
      customInputState = null;
      const session = getSelectedSession();
      if (session?.tmuxPane && text.trim()) {
        await sendTextAndEnter(session.tmuxPane.paneId, text);
        optimisticApprove(session);
        await advanceToNextWaiting();
        screen.render();
      } else {
        updateStatusBar();
        screen.render();
      }
      return;
    }

    // Delegate to text input handler
    const result = handleTextInputKey(customInputState.text, customInputState.cursor, keyName, ch);
    if (result.handled) {
      customInputState.text = result.text;
      customInputState.cursor = result.cursor;
      renderCustomInputBar();
      screen.render();
    }
    return;
  }

  // --- Top-level contextual keys (only for waiting sessions) ---
  const session = getSelectedSession();
  if (!session || session.status !== "waiting" || !session.tmuxPane) return;

  const paneId = session.tmuxPane.paneId;

  // y = approve. If this session is blocked on a detached IPC approval (the
  // blocking PreToolUse hook is polling for a decision), resolve it via the
  // decision file; otherwise drive the on-screen prompt with Enter (attached).
  if (ch === "y" && !key.shift && !key.ctrl && !key.meta) {
    spaceMenuHandledKey = true;
    queueMicrotask(() => { spaceMenuHandledKey = false; });
    const blocked = session.id
      ? listPendingApprovals().find((p) => p.sessionId === session.id)
      : undefined;
    if (blocked) {
      decideApproval(session.id, "allow", { toolUseId: blocked.tool_use_id });
    } else {
      await sendKeys(paneId, ["Enter"]);
    }
    optimisticApprove(session);
    await advanceToNextWaiting();
    screen.render();
    return;
  }

  // Y = approve, don't ask again (option 2 = Down + Enter, sent sequentially so the
  // Down isn't dropped — a batched Down+Enter selected plain "Yes" instead).
  if (ch === "Y" || (key.shift && ch === "y")) {
    spaceMenuHandledKey = true;
    queueMicrotask(() => { spaceMenuHandledKey = false; });
    await sendKeysSequential(paneId, ["Down", "Enter"]);
    optimisticApprove(session);
    await advanceToNextWaiting();
    screen.render();
    return;
  }

  // 1-9 = answer question option via A8 index-nav (structured options, not glyphs)
  const num = parseInt(ch, 10);
  if (num >= 1 && num <= 9) {
    // Multi-question prompt: a digit can't answer in place (it would land on whatever
    // question tab is focused) — open the picker overlay instead. The digit that opened
    // it is swallowed by `pickerJustOpened` so it doesn't also pre-select inside.
    if (cachedPendingToolCall?.questions && cachedPendingToolCall.questions.length > 1) {
      spaceMenuHandledKey = true;
      queueMicrotask(() => { spaceMenuHandledKey = false; });
      pickerJustOpened = true;
      queueMicrotask(() => { pickerJustOpened = false; });
      openQuestionPicker(cachedPendingToolCall.questions);
      return;
    }
    if (cachedPendingToolCall?.question) {
      const q = cachedPendingToolCall.question;
      if (num <= q.options.length) {
        spaceMenuHandledKey = true;
        queueMicrotask(() => { spaceMenuHandledKey = false; });
        const idx = num - 1;
        const selections = [q.multiSelect ? [idx] : idx];
        // Intercepted (you answered from the phone / walked away, hook holding) → resolve
        // via the decision file; else drive the live native widget with keys (at the desk).
        // multiSelect submits via the Submit tab; single-select Enters on the option.
        if (!decideQuestion(session.id, cachedPendingToolCall.toolUseId, buildAnswersMap([q], selections))) {
          await answerQuestion(paneId, selections);
        }
        optimisticApprove(session);
        await advanceToNextWaiting();
        screen.render();
        return;
      }
    }
  }

  // t = type custom answer (single-question only; per-question free text on a
  // multi-question prompt would send blind to the focused tab — disabled there).
  if (ch === "t" && !key.ctrl && !key.meta) {
    if (cachedPendingToolCall?.questions && cachedPendingToolCall.questions.length > 1) {
      flashStatusMessage(`{${C.dim}-fg}Use 1-9 to open the multi-question picker{/${C.dim}-fg}`);
      return;
    }
    spaceMenuHandledKey = true;
    queueMicrotask(() => { spaceMenuHandledKey = false; });
    customInputState = { text: "", cursor: 0 };
    renderCustomInputBar();
    screen.render();
    return;
  }
});

// Multi-question picker keypress handler (intercepts all keys while the picker is open).
screen.on("keypress", async (_ch: string, key: any) => {
  if (!multiQuestionPicker || !key) return;
  // Swallow the digit that opened the picker (same keypress event fires this handler too).
  if (pickerJustOpened) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  // Block the screen.key() handlers from also acting on this key.
  spaceMenuHandledKey = true;
  queueMicrotask(() => { spaceMenuHandledKey = false; });

  const action = handleQuestionPickerKey(multiQuestionPicker, keyName, ch);
  switch (action.type) {
    case "render":
      updateQuestionBox();
      screen.render();
      break;
    case "cancel":
      closeQuestionPicker();
      break;
    case "submit": {
      const session = getSelectedSession();
      const paneId = session?.tmuxPane?.paneId;
      // Capture the picker's questions before closing — they're the exact set
      // `action.selections` was scored against, and share one tool_use_id.
      const qs = multiQuestionPicker.questions;
      const toolUseId = qs[0]?.toolUseId ?? "";
      closeQuestionPicker();
      // Intercepted → resolve via the decision file (no live pane needed); else send keys.
      const resolved = session
        ? decideQuestion(session.id, toolUseId, buildAnswersMap(qs, action.selections))
        : false;
      if (!resolved) {
        if (!paneId) {
          flashStatusMessage(`{${C.dim}-fg}No active pane{/${C.dim}-fg}`);
          break;
        }
        await answerQuestion(paneId, action.selections);
      }
      if (session) optimisticApprove(session);
      await advanceToNextWaiting();
      screen.render();
      break;
    }
  }
});

// Key bindings (guarded: no-op when wizard, search, or space menu is active)
screen.key(["j", "down"], () => { if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return; handleSelect(1); });
screen.key(["k", "up"], () => { if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return; handleSelect(-1); });
screen.key(["S-j", "S-down"], () => { if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return; handleGroupSelect(1); });
screen.key(["S-k", "S-up"], () => { if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return; handleGroupSelect(-1); });
screen.key(["enter"], () => { if (wizardState || wizardHandledKey || globalSearch || spaceMenu || spaceMenuHandledKey || customInputState || multiQuestionPicker) return; handleEnterContextual(); });
screen.key(["x"], () => { if (wizardState || globalSearch || spaceMenu || spaceMenuHandledKey || customInputState || multiQuestionPicker) return; handleKill(); });
screen.key(["f"], () => { if (wizardState || globalSearch || spaceMenu || spaceMenuHandledKey || customInputState || multiQuestionPicker) return; handleFork(); });
screen.key(["a"], () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;
  showArchived = !showArchived;
  refresh();
});
screen.key(["u"], () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;
  previewBox.scroll(-6);
  screen.render();
});
screen.key(["d"], () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;
  previewBox.scroll(6);
  screen.render();
});
screen.key(["q"], () => {
  if (wizardState || wizardHandledKey || globalSearch || spaceMenu || spaceMenuHandledKey || customInputState || multiQuestionPicker) return;
  cleanup();
  process.exit(0);
});
screen.key(["escape"], () => {
  if (wizardState || wizardHandledKey || globalSearch || spaceMenu || spaceMenuHandledKey || customInputState || multiQuestionPicker) return;
  cleanup();
  process.exit(0);
});

// Quick new session in selected repo (`N` / Shift+N)
screen.key(["S-n"], async () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;

  const session = getSelectedSession();
  if (!session?.repoPath) {
    flashStatusMessage(`{${C.dim}-fg}No repo selected{/${C.dim}-fg}`);
    return;
  }

  const repoPath = session.repoPath;
  const repoName = repoPath.split("/").pop() || "repo";

  // Get current branch
  let currentBranch = "main";
  try {
    currentBranch = (await Bun.$`git -C ${repoPath} branch --show-current`.quiet().text()).trim() || "main";
  } catch {}

  const repo: WizardRepo = { name: repoName, path: repoPath, currentBranch };
  const branch = { name: currentBranch, isRemote: false, isCurrent: true };

  flashStatusMessage(`{${C.muted}-fg}Launching in ${repoName}…{/${C.muted}-fg}`);
  const error = await handleWizardLaunch(repo, branch, "current", "", false);
  if (error) {
    flashStatusMessage(`{${C.red}-fg}${error}{/${C.red}-fg}`, 4000);
  }
});

// New Session wizard (`n` key)
screen.key(["n"], async () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;

  // Pause refresh loop
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  // Collect repos from display rows
  const sessionRepos = getUniqueRepos(rows);

  // Discover repos (merge session repos + config paths)
  const repos = await discoverRepos(
    sessionRepos,
    notifConfig.repositories.roots,
    notifConfig.repositories.priority,
  );

  if (repos.length === 0) {
    flashStatusMessage(`{${C.dim}-fg}No repos found{/${C.dim}-fg}`);
    refreshTimer = setInterval(refresh, 3000);
    return;
  }

  // Preselect repo from current selection
  const selectedRow = getSelectedRow();
  let preselectedRepoPath: string | undefined;
  if (selectedRow?.type === "repo-header") {
    preselectedRepoPath = selectedRow.path;
  } else if (selectedRow?.type === "session") {
    preselectedRepoPath = selectedRow.session.baseRepoPath;
  }

  wizardState = initWizard(repos, preselectedRepoPath);

  if (!wizardState) {
    flashStatusMessage(`{${C.dim}-fg}No repos found{/${C.dim}-fg}`);
    refreshTimer = setInterval(refresh, 3000);
    return;
  }

  // If auto-skipped to branch step, load branches + resolve the trunk (drives the
  // worktree-choice default cursor). Single-repo users skip the `loadBranches`
  // action, so this must set defaultBranch too.
  if (wizardState.step === "branch" && wizardState.selectedRepo) {
    const branches = await listBranches(wizardState.selectedRepo.path);
    wizardState.branches = branches;
    wizardState.filteredBranches = branches;
    wizardState.defaultBranch = await getDefaultBranch(wizardState.selectedRepo.path);
  }

  renderWizard(listBox, wizardState);
  renderWizardStatusBar(statusBar, wizardState);
  await renderWizardPreview(previewBox, wizardState);
  screen.render();

  // Auto-skipped straight to the branch step → kick off the background fetch too.
  if (wizardState.step === "branch" && wizardState.selectedRepo) {
    void runWizardFetch(wizardState.selectedRepo.path);
  }
});

// Flag: true during the tick when `/` activates search, prevents the search
// keypress handler from also processing `/` as text input in the same event.
let searchJustActivated = false;

// Space key opens action menu
screen.key(["space"], () => {
  if (wizardState || globalSearch || spaceMenu || customInputState || multiQuestionPicker) return;
  openSpaceMenu();
});

// `/` key activates global search mode
screen.on("keypress", (_ch: string, key: any) => {
  if (!key || wizardState || globalSearch || spaceMenu) return;
  if (_ch === "/" && !key.ctrl && !key.meta) {
    preSearchIndex = selectedIndex;
    globalSearch = {
      query: "",
      cursor: 0,
      entries: [],
      results: [],
      total: 0,
      selectedIndex: 0,
      loading: true,
    };
    searchJustActivated = true;
    queueMicrotask(() => { searchJustActivated = false; });

    // Show loading state
    listBox.setContent(
      `\n\n\n{center}{${C.muted}-fg}Loading sessions…{/${C.muted}-fg}{/center}`,
    );
    renderSearchBar();
    screen.render();

    // Load all sessions asynchronously
    loadAllSessions(nameCache, allSessions).then((entries) => {
      if (!globalSearch) return; // exited search while loading
      globalSearch.entries = entries;
      globalSearch.loading = false;
      applySearchFilter();
      renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
      renderSearchBar();
      // Update preview for first result
      updateSearchPreview(getSelectedSearchEntry());
      screen.render();
    });
  }
});

/** Handle search result selection: switch to active or resume archived */
async function handleSearchEnter() {
  const entry = getSelectedSearchEntry();
  if (!entry) return;
  if (isExiting) return;
  isExiting = true;

  if (entry.isActive && entry.activePaneId && entry.activeSessionName != null && entry.activeWindowIndex != null) {
    const paneId = entry.activePaneId;
    const sessionName = entry.activeSessionName;
    const windowIndex = entry.activeWindowIndex;

    // Clear attention for this pane
    needsAttention.delete(paneId);
    attentionTypes.delete(paneId);

    // Find matching session to sync window prefix
    const session = allSessions.find((s) => s.id === entry.sessionId);
    if (session) {
      const flags = getWindowFlags(session, allSessions);
      await syncWindowPrefix(sessionName, windowIndex,
        flags.hasAttention, session.status === "running" || flags.hasRunning);
    }

    // Clear attention in state.json
    const freshState = await loadState();
    if (freshState.sessions[paneId]) {
      freshState.sessions[paneId].needsAttention = false;
      freshState.sessions[paneId].attentionType = undefined;
      freshState.lastUpdatedAt = Date.now();
      await saveState(freshState);
    }

    globalSearch = null;
    cleanup();
    await switchToPane(paneId, sessionName, windowIndex);
    process.exit(0);
  }

  // Archived session: resume in new tmux window
  const targetSession = await getMainSession();
  if (!targetSession) {
    isExiting = false; // keep Enter usable — a stuck flag dead-locks every exit path
    flashStatusMessage(`{${C.dim}-fg}No tmux session found{/${C.dim}-fg}`);
    return;
  }

  // Use base repo if the worktree is deleted, relocating the transcript there so the resume lands.
  const effectivePath = await recoverWorktreeTranscript(entry.sessionId, entry.projectPath, entry.baseRepoPath);
  const repoName = entry.repo;

  globalSearch = null;
  cleanup();
  try {
    const cmd = `claude --resume=${entry.sessionId}; exec ${USER_SHELL} -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${repoName} -c ${effectivePath} ${USER_SHELL} -c ${cmd}`.quiet();
  } catch (e) {
    console.error(`claude0: failed to resume session: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  process.exit(0);
}

// Space menu keypress handler (intercepts all keys when menu is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!spaceMenu || !key) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  const action = handleSpaceMenuKey(spaceMenu, keyName, ch);

  // Mark key as consumed so screen.key() handlers don't also fire
  spaceMenuHandledKey = true;
  queueMicrotask(() => { spaceMenuHandledKey = false; });

  switch (action.type) {
    case "noop":
      break;
    case "render":
      updateMenuBox();
      screen.render();
      break;
    case "close":
      closeSpaceMenu();
      break;
    case "back":
      if (spaceMenu.level === "root") {
        closeSpaceMenu();
      } else {
        // Restore to root
        spaceMenu.level = "root";
        spaceMenu.previousLevel = undefined;
        spaceMenu.messageText = "";
        spaceMenu.messageCursor = 0;
        updateMenuBox();
        screen.render();
      }
      break;
    case "exec":
      closeSpaceMenu();
      switch (action.command) {
        case "copy":
          handleCopy();
          break;
        case "rename":
          handleRename();
          break;
        case "kill":
          handleKill();
          break;
        case "fork":
          handleFork();
          break;
      }
      break;
    case "send-keys": {
      const session = getSelectedSession();
      const keys = action.keys;
      closeSpaceMenu(); // Close before await to prevent double-fire
      if (!session?.tmuxPane) {
        flashStatusMessage(`{${C.dim}-fg}No active pane{/${C.dim}-fg}`);
        break;
      }
      await sendKeys(session.tmuxPane.paneId, keys);
      flashStatusMessage(`{${C.mint}-fg}Sent{/${C.mint}-fg}`);
      break;
    }
    case "start-input":
      spaceMenu.level = "send-message";
      spaceMenu.previousLevel = "root";
      spaceMenu.messageText = "";
      spaceMenu.messageCursor = 0;
      updateMenuBox();
      screen.render();
      break;
    case "send-text": {
      const session = getSelectedSession();
      const text = action.text;
      closeSpaceMenu(); // Close before await to prevent double-fire
      if (!session?.tmuxPane) {
        flashStatusMessage(`{${C.dim}-fg}No active pane{/${C.dim}-fg}`);
        break;
      }
      await sendTextAndEnter(session.tmuxPane.paneId, text);
      flashStatusMessage(`{${C.mint}-fg}Sent{/${C.mint}-fg}`);
      break;
    }
  }
});

/** Move the search selection and refresh list/bar/preview together. */
async function moveSearchSelection(delta: number) {
  if (!globalSearch || globalSearch.results.length === 0) return;
  globalSearch.selectedIndex = Math.max(
    0,
    Math.min(globalSearch.results.length - 1, globalSearch.selectedIndex + delta),
  );
  renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
  renderSearchBar(); // the ⏎ switch/resume hint tracks the selected entry
  await updateSearchPreview(getSelectedSearchEntry());
  screen.render();
}

// Search keypress handler (intercepts all keys when search is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!globalSearch || !key || searchJustActivated) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  if (keyName === "escape") {
    // Two-stage, matching the wizard filters: first Esc clears the query, second exits.
    if (globalSearch.query) {
      if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
      globalSearch.query = "";
      globalSearch.cursor = 0;
      applySearchFilter();
      renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
      renderSearchBar();
      await updateSearchPreview(getSelectedSearchEntry());
      screen.render();
    } else {
      exitSearch();
    }
    return;
  }

  if (keyName === "enter" || keyName === "return") {
    await handleSearchEnter();
    return;
  }

  // ^J arrives as blessed keyName "linefeed", not "C-j" (same quirk as the wizard).
  if (keyName === "up" || keyName === "C-k") {
    await moveSearchSelection(-1);
    return;
  }
  if (keyName === "down" || keyName === "linefeed" || keyName === "C-j") {
    await moveSearchSelection(1);
    return;
  }

  // Preview scroll, mirroring the home list's u/d (which are text here). ^U shadows
  // text-input's clear-line in search only — Esc already clears the query.
  if (keyName === "C-u" || keyName === "C-d") {
    previewBox.scroll(keyName === "C-u" ? -6 : 6);
    screen.render();
    return;
  }

  // All other keys go to text input
  const result = handleTextInputKey(globalSearch.query, globalSearch.cursor, keyName, ch);
  if (result.handled) {
    const changed = result.text !== globalSearch.query;
    globalSearch.query = result.text;
    globalSearch.cursor = result.cursor;
    if (changed) {
      // Debounce filter/rank
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        if (!globalSearch) return;
        applySearchFilter();
        renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
        renderSearchBar(); // count + switch/resume hint follow the fresh results
        updateSearchPreview(getSelectedSearchEntry());
        screen.render();
      }, 100);
    }
    renderSearchBar();
    screen.render();
  }
});

// Wizard keypress handler (intercepts all keys when wizard is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!wizardState || !key) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  const action = handleWizardKey(wizardState, keyName, ch);
  if (action.type !== "noop") {
    wizardHandledKey = true;
    queueMicrotask(() => { wizardHandledKey = false; });
  }

  switch (action.type) {
    case "noop":
      break;
    case "render":
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      break;
    case "preview":
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      break;
    case "cancel":
      wizardState = null;
      refreshTimer = setInterval(refresh, 3000);
      await refresh();
      break;
    case "loadBranches": {
      const branches = await listBranches(wizardState.selectedRepo!.path);
      wizardState.branches = branches;
      wizardState.filteredBranches = branches;
      wizardState.defaultBranch = await getDefaultBranch(wizardState.selectedRepo!.path);
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      // Non-blocking fetch so branches pushed by others appear without quitting.
      void runWizardFetch(wizardState.selectedRepo!.path);
      break;
    }
    case "fetch":
      // Manual ^R refresh in the branch step.
      void runWizardFetch(wizardState.selectedRepo!.path);
      break;
    case "launch": {
      if (wizardLaunching) break;
      wizardLaunching = true;
      statusBar.setContent(`  {${C.muted}-fg}Launching…{/${C.muted}-fg}`);
      screen.render();
      const error = await handleWizardLaunch(action.repo, action.branch, action.mode, action.text, action.shellOnly);
      wizardLaunching = false;
      if (error) {
        // Reachable when tmux session lookup fails, or when a "reuse branch"
        // worktree is refused because the branch is already checked out elsewhere.
        renderWizard(listBox, wizardState!);
        screen.render();
        flashStatusMessage(`{${C.red}-fg}${error}{/${C.red}-fg}`, 4000);
      }
      break;
    }
  }
});

/** Background `git fetch` for the wizard branch step. Shows a spinner in the
 *  filter bar, then re-lists branches so remote-only branches pushed by others
 *  become selectable. Bails silently if the wizard moved on (different repo,
 *  left the branch step, or cancelled) while the fetch was in flight. */
async function runWizardFetch(repoPath: string): Promise<void> {
  if (!wizardState) return;
  wizardState.fetchState = "fetching";
  renderWizard(listBox, wizardState);
  screen.render();

  const result = await fetchRepo(repoPath);

  // Wizard may have advanced/cancelled during the fetch — only apply if still
  // on the branch step for the same repo.
  if (!wizardState || wizardState.step !== "branch" || wizardState.selectedRepo?.path !== repoPath) return;

  if (result.ok) {
    setWizardBranches(wizardState, await listBranches(repoPath));
  }
  wizardState.fetchState = "done";
  renderWizard(listBox, wizardState);
  renderWizardStatusBar(statusBar, wizardState);
  await renderWizardPreview(previewBox, wizardState);
  screen.render();

  if (!result.ok) flashStatusMessage(`{${C.dim}-fg}fetch failed — showing local branches{/${C.dim}-fg}`, 3000);
}

/** Extract unique repos from display rows */
function getUniqueRepos(displayRows: DisplayRow[]): Array<{ name: string; path: string }> {
  const seen = new Map<string, { name: string; path: string }>();
  for (const row of displayRows) {
    if (row.type === "repo-header" && !seen.has(row.path)) {
      seen.set(row.path, { name: row.name, path: row.path });
    }
  }
  return [...seen.values()];
}

/** Handle wizard launch: create tmux window immediately, run git + claude inside it
 *  (or git setup + a plain shell when shellOnly — worktree without a Claude session).
 *  Returns null on success (exits process), or error string on failure. */
async function handleWizardLaunch(
  repo: WizardRepo,
  branch: { name: string; isRemote: boolean; isCurrent: boolean },
  mode: WorktreeMode,
  text: string,
  shellOnly: boolean,
): Promise<string | null> {
  if (isExiting) return null;

  // Collision pre-check for "reuse": git refuses `worktree add` on a branch that
  // is already checked out elsewhere. Run it BEFORE committing to exit so the
  // wizard can stay open and flash the conflict. NOTE: this only catches branch
  // collisions — other `worktree add` failures (e.g. the target dir already
  // exists) surface inside the spawned window, not here.
  if (mode === "reuse") {
    const existing = await branchCheckedOutPath(repo.path, branch.name);
    if (existing) {
      return `${branch.name} is already checked out at ${existing}`;
    }
  }

  if (mode === "reuse" || mode === "new-branch") {
    try {
      await ensureWorktreeIgnore(repo.path);
    } catch (error) {
      return `Could not prepare ${WORKTREES_DIR}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  isExiting = true;
  const targetSession = await getMainSession();
  if (!targetSession) {
    isExiting = false; // keep the wizard usable for a retry
    return "No tmux session found";
  }

  wizardState = null;
  cleanup();
  try {
    // Compound command: git setup (if any) then claude, run inside the new window.
    const cmd = buildLaunchCommand(mode, repo, branch, text, !shellOnly);
    const windowName = abbreviateRepo(repo.name);

    if (cmd === "") {
      // Shell-only with no git setup: plain window on the default shell.
      await Bun.$`tmux new-window -a -t ${targetSession} -n ${windowName} -c ${repo.path}`.quiet();
    } else if (cmd === "claude") {
      // Simple case: launch claude directly as the window command (no shell race)
      await Bun.$`tmux new-window -a -t ${targetSession} -n ${windowName} -c ${repo.path} claude`.quiet();
    } else {
      // Compound command: run via the user's shell (`-c`) to avoid send-keys race with shell
      // init (prompt frameworks can swallow keystrokes). The trailing exec keeps the shell
      // open after claude exits.
      const wrapped = `${cmd}; exec ${USER_SHELL} -l`;
      await Bun.$`tmux new-window -a -t ${targetSession} -n ${windowName} -c ${repo.path} ${USER_SHELL} -c ${wrapped}`.quiet();
    }
  } catch {
    // ignore — window may already exist
  }
  process.exit(0);
}

// Render loading state immediately so the TUI appears instantly
listBox.setContent(
  `\n\n\n{center}{${C.muted}-fg}Loading sessions…{/${C.muted}-fg}{/center}`,
);
updateStatusBar();
screen.render();

// Load name cache + notification config + pane sessions, then start refresh loop.
// An invalid config degrades to defaults instead of crashing the TUI (an unhandled
// rejection here would kill the process before the first paint).
let configError: string | null = null;
const loadConfigOrDefaults = loadConfig().catch((error: unknown) => {
  configError = error instanceof Error ? error.message : String(error);
  return configCache();
});
Promise.all([loadNameCache(), loadConfigOrDefaults, loadPaneSessions()]).then(([cache, config, paneSessions]) => {
  nameCache = cache;
  notifConfig = config;
  if (configError) flashStatusMessage(`{${C.red}-fg}Config invalid — using defaults{/${C.red}-fg}`, 5000);
  // Seed pane→sessionId cache from disk (persisted by monitor)
  seedPaneSessionCache(paneSessions);
  // Nudge: flash a message if the SessionStart hook is missing or outdated
  const hookPath = `${homedir()}/.config/claude0/hooks/session-start.sh`;
  let needsSetup = !existsSync(hookPath);
  if (!needsSetup) {
    try {
      const content = readFileSync(hookPath, "utf-8");
      needsSetup = !content.includes("HOOK_VERSION=");
    } catch { needsSetup = true; }
  }
  if (needsSetup) {
    setTimeout(() => flashStatusMessage(`{${C.muted}-fg}Run {${C.peach}-fg}claude0 setup{/${C.peach}-fg} for auto session naming{/${C.muted}-fg}`, 5000), 500);
  }
  // Initial load: skip archived summaries for instant render.
  // The 3s auto-refresh will fill in summaries and context %.
  refresh({ skipArchivedSummaries: true });
  refreshTimer = setInterval(refresh, 3000);
});
