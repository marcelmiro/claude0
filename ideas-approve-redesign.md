# Redesign: Top-level contextual approve with decision-first preview

## Why it's a 6/10 today

I traced the full user journey for approving a single waiting session:

```
1. Open Claude0                               (popup appears)
2. j/k to find waiting session            (navigate list)
3. Eyes scan preview...                    (conversation history fills the pane)
4. Scroll preview to find attention block  (it's at the BOTTOM, past all history)
5. Read what the session wants             (finally see "⏸ Waiting: Bash")
6. Press Space                             (generic menu appears with 6 options)
7. Press y                                 (async detection, then sub-menu appears)
8. Press y again                           (finally sends approval)
9. Menu closes, flash "Sent"              (weak feedback)
10. j to next waiting session              (manual navigation)
11. Repeat 3-10                            (for each waiting session)
```

**5 keystrokes per approval** (j, Space, y, y, j). Plus cognitive overhead of reading menus and scanning for the attention block.

### Every friction point:

1. **Preview buries the decision.** Conversation history fills the pane. The attention block ("what are you waiting for?") is appended at the BOTTOM. You have to scroll past irrelevant text and tool output to find the one thing that matters. This is like burying "Approve?" under 3 pages of email thread.

2. **Space menu adds 2 unnecessary layers.** Space opens a generic 6-option menu. Then "approve" opens a 3-option sub-menu. Two layers of indirection for the #1 most common action. This is like opening File → Export → PDF when you just want Cmd+P.

3. **No auto-advance.** After approving, cursor stays on the same session (now "running"). You manually j/k to the next waiting one. Superhuman auto-advances after archive. Vim auto-advances after deleting a line. We should too.

4. **No contextual keys.** `y` does nothing at the top level. But "y" literally means "yes." When a session shows "Do you want to proceed?", pressing `y` should approve. The mapping is so natural it shouldn't need a menu.

5. **Weak feedback.** A 2-second green flash "Sent" is easy to miss. The session should visibly change status from ⏸ to ⦿ immediately, before the 3s refresh confirms it.

6. **No context in the session list.** The row says "waiting" but not WHAT it's waiting for. You must look at the preview to know. If the row said "⏸ Bash" or "⏸ Question", you could triage at a glance.

7. **Status bar doesn't adapt.** The bottom bar always shows the same keys regardless of whether you're looking at a waiting session or an idle one. In context, the most important keys (y to approve) aren't shown.

8. **Critical: Edit diffs are invisible.** The most common approval type is Edit. In the terminal, Claude shows old_string → new_string. In Claude0's preview, only the filename is shown. That's like asking "approve this PR?" while only showing the branch name. The actual change — what you're agreeing to — is hidden. Same for Write (no content shown) and Bash (no description shown).

## What a 10/10 looks like

The flow for approving 3 waiting sessions:

```
1. Open Claude0                    (first waiting session auto-selected)
2. Preview shows: "⏸ Bash: $ npm install"
   Status bar shows: "y approve · Y always"
3. Press y                     (approved! cursor auto-advances to next waiting)
4. Preview shows: "⏸ Edit: src/auth.ts"
5. Press y                     (approved! auto-advances)
6. Preview shows: "⏸ Question: Which approach?"
   with "1. Option A  2. Option B"
7. Press 1                     (answered! no more waiting sessions)
```

**1 keystroke per approval. Zero menus. Zero scrolling. Zero manual navigation.**

## Implementation

### 1. Top-level contextual keys

When the selected session has `status === "waiting"`:

| Key | Action | Sends to pane |
|-----|--------|---------------|
| `y` | Approve | `Enter` |
| `Y` | Approve, don't ask again | `Down` + `Enter` |
| `1-9` | Answer question option | number + `Enter` |
| `t` | Type custom answer | Opens inline text input |

When the session is NOT waiting, these keys are inert (no-op). No risk of accidental actions.

**No `a` key overloading.** `a` always means toggle-archived. `Y` (Shift) for "always approve" is more deliberate and harder to hit accidentally — appropriate for a permanent permission change.

**No top-level deny key.** Deny is rare and usually needs feedback ("no, do X instead"). Press Enter to switch to the pane and interact directly.

### 2. Decision-first preview for waiting sessions

When `session.status === "waiting"`, flip the preview: **decision at top, history below**.

**Tool approval (Bash):**
```
  claude0/main

  ⏸ Approve Bash
  ──────────────────────
  Install TypeScript as a dev dependency

  $ npm install --save-dev typescript

  y approve · Y always
  ──────────────────────
  [last 1-2 messages dimmed for context]
```

Shows: description (why) + command (what). Both fields exist in the JSONL.

**Tool approval (Edit) — with inline diff:**
```
  claude0/main

  ⏸ Approve Edit
  ──────────────────────
  src/index.ts

  - const x = 1;
  - const y = 2;
  + const x = getConfig("x");
  + const y = getConfig("y");
  + const z = getConfig("z");

  y approve · Y always
```

Shows: file path + old_string/new_string as a diff. Red (C.red) for removed lines, mint (C.mint) for added lines. Truncated with "… N more lines" for large diffs. The JSONL has both `old_string` and `new_string` fields.

**Tool approval (Write) — with content preview:**
```
  claude0/main

  ⏸ Approve Write (new file)
  ──────────────────────
  src/utils/helpers.ts

  import { homedir } from "os";
  export function getConfigPath() {
    return `${homedir()}/.config/claude0`;
  }
  … 120 more lines

  y approve · Y always
```

Shows: file path + first ~8 lines of content. The JSONL has the full `content` field.

**AskUserQuestion:**
```
  claude0/main

  ⏸ Question: Which file?
  ──────────────────────
  Is the 30s mostly from git worktree add?

  1. git worktree add alone
  2. Fetch + worktree
  3. Not sure exactly

  1-3 answer · t custom
```

Already good — question + options from JSONL.

**Generic waiting (no JSONL match):**
```
  claude0/main

  ⏸ Waiting for input

  y approve
```

Conversation history rendered BELOW the decision block, dimmed, for additional context (what was the session doing when it hit this point).

### 3. Contextual status bar

When a waiting session is selected, the status bar adapts to show the most relevant actions:

**Tool approval:**
```
y approve · Y always │ j/k move  ⏎ switch  Space more  q quit
```

**AskUserQuestion:**
```
1-N answer · t custom │ j/k move  ⏎ switch  Space more  q quit
```

**Non-waiting (unchanged):**
```
j/k move  ⏎ switch  / search  Space actions  x kill  f fork  ...
```

### 4. Auto-advance after approve

After any approve/answer action:
1. Immediately update the session's visual status from ⏸ to ⦿ in the list (optimistic, before 3s refresh confirms)
2. Find the next waiting session in display rows and auto-select it
3. Update preview for the newly selected session
4. If no more waiting sessions, stay on current

### 5. Inline text input for `t` (custom answer)

Reuse the search bar pattern: `t` replaces the status bar with a text input line. No overlay, no Space menu.

```
❯ [typed text█]                     Enter send · Esc cancel
```

Enter sends the text + Enter to the pane, then auto-advances. Escape restores the status bar.

### 6. Simplify Space menu

Remove approve (`y`) and its sub-menus from the Space menu entirely. The Space menu becomes a utility menu for non-contextual actions:

```
  m  send message
  c  copy
  r  rename
  x  kill
  f  fork
```

### 7. Richer tool data extraction

The `readPendingToolCall` function currently extracts: name, command (Bash), filePath (Edit/Write), question (AskUserQuestion).

Needs to ALSO extract:
- **Bash**: `description` field (explains intent, e.g. "Install TypeScript as a dev dependency")
- **Edit**: `old_string` and `new_string` fields (the actual diff being proposed)
- **Write**: `content` field (first ~500 chars for preview)

Data verified present in real JSONL:
- Bash: `{ command: string, description: string }`
- Edit: `{ file_path: string, old_string: string, new_string: string }`
- Write: `{ file_path: string, content: string }`

### 8. Cache pending tool call per session

To power the contextual status bar and preview without re-reading JSONL on every keypress, cache the pending tool call result per session during the preview update.

### Files to modify

| File | Changes |
|------|---------|
| `src/index.ts` | Contextual key handlers (y, Y, 1-9, t), auto-advance, inline text input, cache pending call, remove approve from Space dispatch |
| `src/ui/preview-pane.ts` | Decision-first rendering for waiting sessions with full tool details |
| `src/ui/status-bar.ts` | Contextual approve hints |
| `src/ui/space-menu.ts` | Remove approve levels, simplify root menu |
| `src/core/jsonl-reader.ts` | Extract description (Bash), old_string/new_string (Edit), content (Write) in PendingToolCall |
| `src/core/tmux.ts` | No changes (sendKeys, sendTextAndEnter exist) |

### Verification

1. Open Claude0 with 2+ waiting sessions
2. First waiting session auto-selected → preview shows decision block prominently
3. Status bar shows "y approve · Y always"
4. Press `y` → session status flips to ⦿, cursor auto-advances to next waiting session
5. Preview updates to show new waiting session's decision
6. Press `y` again → approved, no more waiting → cursor stays
7. Test with AskUserQuestion → preview shows numbered options, `1` selects, auto-advances
8. Press `t` → inline text input appears in status bar, type + Enter sends
9. Non-waiting session selected → `y`, `1-9`, `t` do nothing; status bar shows normal hints
10. Space menu → no approve option, just m/c/r/x/f
