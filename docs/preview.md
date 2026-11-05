# Preview

The read-only transcript viewer the sidebar opens in a tmux popup: Enter on a search result,
or Enter / double-click on a pane-less Parked or Recent row. No `claude` process, no inbox
state change. Decisions: [ADR 34](adr/0034-sidebar-is-the-only-desk-surface.md) (preview as
part of the sidebar), [ADR 35](adr/0035-enter-never-refiles-a-parked-or-recent-row.md)
(looking is preview, re-entering is a verb). Code: `src/preview/`, the launcher in
`src/sidebar/renderer.ts` (`openPreview`).

## Flow

1. The renderer writes `~/.config/claude0/preview/<windowId>.json` — the rows `J`/`K` flip
   through (search hits, or the visible Parked + Recent rows), the starting index, and the
   search query (empty from the inbox) — then spawns
   `tmux display-popup -E "claude0 preview <windowId>"` on the most recently active client
   showing that window.
2. `claude0 preview` (`viewer.ts`) loads the transcript with `getTranscript` — stitched across
   project dirs (ADR 29), tool results already slimmed — and renders it with `render.ts`.
3. It talks back over `sidebar.sock`, **one command per connection** (the renderer reads only
   a connection's first line): `preview-cursor <window> <session>` moves the sidebar's
   highlight as `J`/`K` flip; `preview-open <window> <session>` runs search's open path
   (`openSession`: live → its pane, parked → unparked, archived → unarchived, each clear after
   the window spawns) and the viewer exits, closing the popup.

## Traps

- **`display-popup` blocks until the popup closes.** The renderer spawns it with `Bun.spawn`
  and never awaits it. Not `Bun.$`: an unawaited `Bun.$` never starts, and an awaited one
  would hold the renderer's handler for as long as the popup is open.
- **`-y` names the popup's bottom row** — tmux subtracts the height, so `-y` = top + height.
  The popup is as wide as the text needs (106 columns) and 85% of the height, centred over
  the work area right of the sidebar (`popupGeometry`). A work area under 60 columns gets a
  centred 90% popup instead.
- **Popups send no focus events** to the pane under them, and don't change `pane_active`, so
  the sidebar keeps its focus — and search keeps its query and results — while the popup is up.
- **Memory.** Parsing a transcript costs about 5–6× its size in RSS (a 104MB transcript:
  ~420ms, ~600MB). The viewer keeps only the current row and its neighbours, drops
  `getTranscript`'s parse cache after every load (`forgetTranscripts`), and prefetches a
  neighbour only when it is under 30MB. The process exits with the popup.
- **Logs** go to `~/.config/claude0/preview.log` (load and show timings, warm or cold) — the
  popup owns stderr. The file resets past 1MB.

## Rendering (`render.ts`)

Claude Code's grammar in the Vesper palette, portkey's block taxonomy:

| Turn / block | Lines |
|---|---|
| prompt, `/command`, `! bash` | `❯` / `!` on a full-width surface band; `{`/`}` stops |
| assistant text | `● ` + markdown (marked's lexer → styled spans: bold, italic, inline code mint, fenced code on a band, lists, tables aligned or one line per row when too wide) |
| tool call | `● Name arg` — portkey's argument order, paths relative to the session's cwd; dot mint ok, red failed; `⎿ head` only on failure |
| 3+ consecutive tool-only turns | one tally line when the run predates the newest prompt (portkey's fold rule); expanded otherwise |
| answered question | `● Asked: q` / `⎿ a` |
| bash output | first 3 lines, `… +N lines` |
| compaction, interrupt marker, teammate, image | one dim line each |
| gap > 5 min | right-aligned time label |
| thinking, raw tool output | hidden |

Text wraps at 100 columns. Find highlights every occurrence of each query word; the current
match is strongest. Opening with a query lands on the earliest line holding the most distinct
query words, a third of the way down; no match opens at the end.
