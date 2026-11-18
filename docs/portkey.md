# Portkey

Mechanism notes for the phone client (`src/bridge/public/`). Driving it in a real
browser: [portkey-design-loop.md](portkey-design-loop.md). Home is the inbox:
[inbox.md](inbox.md). The offline app shell: [ADR 21](adr/0021-offline-app-shell.md).

## Thread rendering

| Behavior | Where (`app.js`) |
|---|---|
| A run of 3+ tool-only records is one burst: expanded if it's work since the last prompt (`lastPromptAt`), else a one-line tally that expands on tap | `ToolBurst`, `isToolOnlyTurn` |
| One working indicator: the live tool chip while a tool runs, else the "working…" line with elapsed time | `ToolChip`, `Working` |
| Slash-command turns are a normal user bubble with the `/name` in mono; long-press is copy-only. Queued and sending bubbles of a command render the same way. A queued command's bare-text record (written at dequeue, before its runner record) parses as a command turn too (`core/transcript.ts`) | `Turn`, `commandBody` |
| An optimistic send bubble is faded and grows a "sending…" tag after ~5s; a server-confirmed queue entry is full-strength text in a dashed peach outline with a `◷ queued` tag — they never share a look | `SendingTag`, `.bubble.queued` |

## New session picker

A plain list of names in Portkey's page chrome (the `‹` back header with swipe-back,
History's search field, `.repo` section labels): **Recent** first, because the thumb is
already at the top after tapping +, then **All** repos A–Z (`NewSession`).

- **Recent** is up to 6 base repos ranked by transcripts touched in the last 14 days,
  counting each repo's project folder in `~/.claude/projects` plus its managed worktrees'
  (`recentRepos`, `core/recent-repos.ts`). It is stat-only and runs inside the `/repos`
  cache, which sets `recent` (rank) on those base rows. History's repo chips use the same
  rank (`repoRank`). There is no config pin: Recent replaced `repositories.priority`.
- **A repo's name launches its base checkout in one tap.** In All, a trailing count is a
  separate 64px target that opens the worktrees in place. They are newest HEAD commit first
  (`discoverRepos` → `commitTimes`), each launchable. A detached worktree is named by its
  folder. A leading segment every named branch in the group shares ("marcelmiro/") shows
  once above the group (`sharedPrefix`).
- **The only warning** is a base checkout off main/master ("on <branch>" in peach): a
  session started there lands on someone's branch.
- **Search:** every word must match. A query the repo name answers alone keeps worktrees
  folded; otherwise worktrees match on repo + branch + folder + short sha, under their repo.
  Results rank name-prefix, then Recent, then A–Z. Return launches a lone target, or the top
  repo when its name starts a one-word query (`enterTarget`).
- **Launch** keeps the picker open: the tapped row shows a spinner, and every other row is
  disabled so a second tap can't launch twice. A failure shows on the row and a tap retries
  it (`launchSession`, `pickerLaunch`). If the picker was left meanwhile, the session is not
  auto-opened: Home shows "launching…", then a ready/failed card with open, retry or dismiss
  (`launchNotice`), and the + button pulses while a launch is pending.
- The sidebar's `n` mode is a separate surface: it keeps `discoverRepos` order (repos with a
  live session, then A–Z) and has no Recent section.

## Dictation

Why it records in the app instead of using the iOS keyboard or Web Speech:
[ADR 37](adr/0037-dictation-records-in-the-app-and-transcribes-on-the-host.md). The composer
shows a mic only when the host has `~/.config/claude0/openai-key` (`GET /dictation`).

Order of one dictation:

1. **Press.** A tap toggles recording until the next tap; a hold records until release
   (`micDown`/`micUp`, 350ms threshold). One mic stream lives for the page's lifetime
   (`ensureMic`): iOS asks permission once per app launch and re-prompts sooner for a
   stopped stream.
2. **Wait, then speak.** The button is peach ("wait") until real samples arrive, then red.
   A long-idle iOS track stays `live` but delivers exact zeros for seconds after recording
   starts; that silently cut the first ~3.5s off a prompt. A mic's noise floor is never
   exactly zero, so the first non-zero sample means audio is flowing (`whenAudioFlows`).
3. **Transcribe.** `POST /sessions/:id/dictate` (multipart `audio`) sends the recording to
   OpenAI `gpt-transcribe` with a vocabulary hint, and returns the raw text in about 1s. The
   recorder is timesliced (`start(1000)`), and the container is sniffed from the bytes
   (`audioExt`). An un-sliced Safari WebM recording once arrived as just its 5-byte tail,
   with an empty MIME type.
4. **Insert.** The raw text goes in at the caret, spaced from its neighbours
   (`insertDictation`). If you switched sessions meanwhile, it is appended to the dictating
   session's saved draft instead.
5. **Clean.** `POST /dictation/:id/clean` runs `claude -p` (haiku) with the session's terms,
   its recent prose, and the personal vocabulary (`cleanDictation` in `core/dictation.ts`).
   This takes about 5s. The prompt fixes only mis-heard terms and punctuation. A result that
   lost more than about 10% of the words (minimum 4) is discarded (`guardCleanup`), because
   the cleanup once dropped a whole sentence. The client swaps the cleaned text in only if
   the raw text is still in the box exactly as inserted, so an edit you make meanwhile wins.
   The swapped words are flashed ("Fixed: myatron → Maestro").
6. **Log and learn.** On send, `POST /dictation/outcome` appends what dictation inserted and
   what you finally sent to `dictation-log.jsonl`. Only text is logged; no audio is kept.
   Short word swaps you typed over the dictation ("Betsec" → "betterstack") are kept in
   `dictation-learned.json` (`corrections`, `learnFromOutcome`). Additions, case-only edits
   and rewrites longer than three words aren't counted. The corrected terms lead the next
   transcription prompt, and cleanup gets the pairs as known mis-hearings. Rare terms need
   this: history mining keeps only words used 15+ times, and "betterstack" had 6.

**Vocabulary.** The transcription prompt is length-limited. It gets the session's repo,
branch, non-builtin skills and recently touched files, then the top 120 personal terms
(`buildContext`). Cleanup gets everything.

The personal terms come from every prompt you've sent Claude Code. Session context alone
missed "DNC", "Maestro" and "EmailBison" whenever you dictated about another topic.

- **Where it runs.** `claude0 dictation-vocab` mines them. The bridge launches it in the
  background when `dictation-vocab.json` is missing or more than a day old
  (`refreshVocabIfStale`).
- **Memory.** The history is ~13GB, so mining reads it with `shortJsonlLines`, which skips
  lines over 64KB without decoding them. Decoding every line, as `jsonlLines` does, peaked
  at 1.6GB RSS; skipping them takes ~150MB.
- **Kept by shape.** Acronyms used mostly in caps, and identifier-shaped words. The
  identifier spelling is canonical ("CustomerOS", not the "customeros" you type).
- **Judged by Claude.** The remaining frequent words go to batched `claude -p` calls that
  keep the domain terms. Their output is matched back against the batch, so a hallucinated
  term can't enter.

## iOS status bar (installed PWA, iOS 27)

The fix is the `.status-bar-background` strip (`index.html`; its comment explains the
sampling rule) with `apple-mobile-web-app-status-bar-style=default`.
`--app-top-clearance` is just the safe-area inset. On the iPhone PWA (`.iphone-pwa`, set
before first paint) the first scroll region carries the clearance and fades its top 16px
once scrolled.

Verifying: changing the status-bar meta needs the app removed and re-added from Safari;
CSS changes need only a reachable reload. Browser layout checks can't reproduce the
effect — check on-device after a cold relaunch.

What was tried and doesn't work (2026-09-19 → 29; ten strategies compared on-device,
branch `prototype/ios-top-blur`): under `black-translucent` nothing removed the blur (about
90px) — opaque strips up to the safe-area height, scroll kicks at launch, a `theme-color`
nudge. An opaque 11px strip removes it but hides the top 11px of content; a fixed panel
slid across at launch works but the slide is visible; scrolling the document or inner list
at launch changes nothing. A fixed clearance allowance below the blur (24px, then 12px,
then 16px) was tuned on-device and then removed once the strip worked.
