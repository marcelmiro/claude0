# Changed files

How portkey's changed-files surfaces and the sidebar's PR chip behave and where each part
lives; the named docblocks carry the implementation detail. Decisions:
[ADR 1](adr/0001-changed-files-is-a-glance-surface.md) (glance, not review),
[ADR 2](adr/0002-changed-files-baseline.md) (merge-base baseline),
[ADR 11](adr/0011-pushed-vs-unpushed-is-a-tier-chain.md) (pushed/unpushed tier chain),
[ADR 5](adr/0005-link-out-to-the-pull-request.md) (PR link). Code: `core/repo-files.ts`,
`core/pull-request.ts`, `core/edit-dir.ts`, `shared/diff-lines.js`, the `/changes`, `/diff`
and `/sessions/:id/pr` routes in `bridge/server.ts`. Git pathspec and revspec rules:
CLAUDE.md gotchas.

## Flow

`/changes` computes the baseline (`baseRef`), the flat list (`changedFiles`) and the tier
chain (`syncTiers`) once per second behind one cache; the thread card, the file list and
`/diff` all read that same cached answer, so they can't disagree about what changed or how
far it has travelled. `/diff` then serves one file's patch for a row the list rendered.

| Concern | Where |
|---|---|
| Baseline and its fallbacks (dangling `origin/HEAD`, unborn or detached HEAD, never pushed) | `baseRef`, `syncTiers` (`core/repo-files.ts`) |
| 1s shared cache, why it exists | `CHANGES_TTL` comment (`bridge/server.ts`) |
| `/diff` honours only a `from`/`to` pair the cached chain published | comment above the tier lookup in the `/diff` route (`bridge/server.ts`) |
| Rename old path: the caller's `orig` wins, the cached list is the fallback, scoped to the tier | same route; the file list passes `orig` (`FilesView`, `app.js`) |
| Ref-to-ref tiers → `rangeDiff`; the uncommitted tier → `fileDiff` with a start-ref override (it still needs the untracked fallback and the NFD/NFC retry) | `/diff` route, `core/repo-files.ts` |
| `● N not pushed` is the distinct union of the two un-landed tiers | `syncTiers` (`unpushedCount`), `syncChip` (`app.js`) |
| PR states | `PullRequestInfo`, `branchPullRequest` (`core/pull-request.ts`); 60s `PR_TTL` (`bridge/server.ts`) |

**Untracked files are counted in-process** (`untrackedNumstat`), one streamed read at a time.
A `git diff --no-index` per file once turned a 9,222-file generated-output worktree into
9,222 concurrent shells, and on Bun 1.4.0 each `Bun.$` retained ~160 KB of native memory for
the life of the process — that grew the bridge to 24 GB. Keep it subprocess-free.
Consequence: a `.gitattributes` `-diff` rule is not honored for untracked files.

**What renders nothing.** `none` means detached HEAD, no or non-GitHub `origin`, or the
default branch. A missing `gh` or a network failure is not `none`: `gh pr view` yields
nothing and the answer falls through to `no-pr` (pushed) or `local-only` (never pushed).

## Rendering

| Concern | Where |
|---|---|
| Thread strip: totals and PR state only, no file preview | comment above the strip component (`app.js`) |
| Strip styled as an unfilled, full-width bordered box, so it can't read as an assistant bubble | `.changes-card` (`index.html`) |
| File-list header states the baseline and no total (summing tiers double-counts) | comment in the list header (`FilesView`, `app.js`) |
| PR row on top of the list; nothing for `none` | `PrRow` (`app.js`) |
| Per-file diff re-indented for phone width (display only) | `narrowIndent` (`shared/diff-lines.js`) |
| Edit/Write/Read chips: filename bright, directory dim; they open no diff | tool-chip rendering (`isEdit`, `app.js`); ADR 1 |
| Sidebar PR chip: which checkout and which PR, refresh budget (≤5 rows/tick, 60s) | comment above the PR refresh in `core/inbox-discovery.ts`, `core/edit-dir.ts` header |
| Sidebar chip colors (`#N`; open white, draft dim, merged purple, closed red) | `PR_CHIP_COLOR` and the comment above it (`sidebar/rows.ts`) |
