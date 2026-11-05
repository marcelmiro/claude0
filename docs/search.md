# Search

How search finds a word anywhere in a conversation. One engine, two callers: the sidebar's
`/` mode (through `claude0 search-worker`, [inbox](inbox.md)) and portkey's History
(`/history` on the bridge). Decision: [ADR 36](adr/0036-search-matches-prose-through-an-fts5-index.md).
Code: `core/search.ts` (entries, ranking), `core/search-index.ts` (the index).

## Two sources per query

- **Entries** (`loadAllSessions`): one per session, with name, summary, first prompt, branch
  and repo, plus the last turn's time and last reply from a ~40KB tail read. Callers cache
  them for 15s.
- **The index** (`~/.config/claude0/search.db`): SQLite FTS5 over conversation prose — user
  prompts, queued prompts and assistant text, by `recordProse` (`core/transcript.ts`), the
  same visibility rules as the transcript view. Tool inputs and outputs, thinking, commands,
  `!` bash, teammate deliveries, compaction summaries and interrupt markers are left out.

`searchEntries` asks the index once per query word, then scores every entry: each word must
appear in the entry's metadata or in that session's indexed prose. The name/summary/prompt/
branch/repo tiers are unchanged; a word found only in the conversation scores the content
tier (20), so metadata matches rank above conversation-only ones.

## Writing the index

The daemon spawns `claude0 daemon --index-once` every 30s (10 ticks), never two at once and
never awaited, so a long pass can't delay discovery. Each pass (`indexOnce`):

1. Globs `~/.claude/projects/*/*.jsonl` and compares each file with its `files` row (inode,
   offset, size). New bytes are read from the stored **byte** offset; a line counts only once
   its newline is on disk, and the offset moves to just past it (`readProse`).
2. A file whose inode changed (`recover.ts` renames a newer transcript over the base copy) or
   that shrank is re-indexed from 0. A file the glob no longer returns loses its rows.
3. Records stamped with another session's id are skipped: a fork starts with a byte copy of
   its parent's records ([ADR 25](adr/0025-fork-transcript-seeding.md)), and the parent's file
   already holds that prose. A session spanning several project dirs
   ([ADR 29](adr/0029-transcripts-span-project-dirs.md)) contributes each file.
4. Prose is appended to the file's last FTS row until it holds 64K characters, then a new row
   starts; `prose_rows` maps rows to file and session.
5. Commits every 100 files, so a killed pass resumes from the last commit.

Changing the schema or the extraction rules means bumping `SCHEMA_VERSION`: the writer
deletes the file and the next pass rebuilds it. A file that isn't a database is rebuilt the
same way, and a missing `~/.claude/projects` is an empty corpus, not a failed pass. The first build reports `progress` in `meta`;
the sidebar shows it as `indexing N%`.

Measured on the host (2026-11-05): 1,146 files and 3.0GB of transcripts build in 23s cold
(11s with a warm page cache) into a 70MB file of 37M characters of prose; the indexing child
peaks near 170MB RSS. Per-keystroke queries take a 4.5ms median and 29ms at p95 over 50
typed prefixes.

## Traps

- **Snippets come after the page cut.** `addContentSnippets` runs on the rows a caller is
  about to show — the worker's 50, the bridge's page — never inside ranking: the bridge ranks
  every entry. The snippet is cut in JS from the matching row's text (`cutSnippet`); FTS5's
  `snippet()` re-scans the row and cost ~1.7ms per row on 2-letter prefixes.
- **Readers open read-only and lazily**, and re-open when the file's inode changes (a rebuild
  deletes and recreates it; without the check a reader keeps serving the deleted file). A
  missing file means no conversation matches.
- **A 1-character last run is matched exactly.** unicode61 splits on punctuation, so a word
  becomes a phrase of its letter/digit runs with a prefix on the last (`eng-2687` →
  `"eng 2687"*`). A 1-character last run would prefix-match far too much, so that phrase is
  exact (`gpt-4` → `"gpt 4"`, `don't` → `"don t"`); a lone 1-character word (`c++` → `c`)
  matches metadata only (`ftsQuery`).
- **Matching is per token prefix, not substring**: `auth` finds "authentication" but not
  "oauth" in the conversation. Metadata fields still match by substring.
- **A search result can trail live prose by one pass** (≤30s). Live sessions are in the inbox
  anyway.
