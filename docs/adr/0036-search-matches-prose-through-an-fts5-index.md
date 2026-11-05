# 36. Search matches conversation prose through an FTS5 index

Date: 2026-11-05
Status: accepted

## Context

Search reads only a 32KB head and a ~40KB tail of each transcript. On the host on 2026-11-05,
1,045 of 1,141 transcripts were larger than 64KB, so the middle of almost every session could not
be searched. Transcripts totalled 2.8GB. Conversation prose (user prompts and assistant text) is
about 3.3% of those bytes, roughly 90MB; the rest is tool output. Grepping the raw files took
2–3s warm and 13s cold per word, and matched tool output.

## Decision

- **An SQLite FTS5 index via `bun:sqlite`**, covering prose only: user prompts and assistant text.
  Tool inputs, tool outputs and thinking are excluded. Tool inputs (commands, paths, URLs) can be
  added if searches visibly miss them.
- **Storage:** its own file, `search.db`, separate from `inbox.db`. It's a derived index, deletable
  and rebuildable; a schema change rebuilds it. It doesn't travel with host state and doesn't wake
  the inbox pollers.
- **Updates:** a short-lived child of the daemon writes it incrementally by byte offset.
  Transcripts are append-only; a file that shrinks or is replaced (a new inode at the same path)
  is re-indexed from 0, and a vanished file's rows are dropped.
- **Indexing granularity:** per file. A session spanning several project dirs (ADR 29) contributes
  each file. A fork's byte-copied parent records (ADR 25) are skipped, so parent prose isn't
  counted twice.
- **Ranking:** the name, branch and repo tiers are unchanged. The index adds conversation matches,
  with snippets, below them.

## Rejected

- **Larger head/tail windows** — fewer misses, a slower cold load, and still no middle.
- **Grep over raw transcripts per query** — seconds per keystroke, and it matches tool output.
- **A plain-text extract searched with `rg`** — the same extraction work, with matching, ranking
  and snippets written by hand.

## Consequences

- The host's SQLite must support FTS5, and `claude0 doctor` must check it. On macOS, Bun uses the system
  SQLite; this was not verified when the decision was made.
- Search results lag a live session's newest prose by up to one indexing pass. Live sessions are
  in the inbox anyway.
