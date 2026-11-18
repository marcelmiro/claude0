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

1. **Tap.** A tap starts recording and the next tap stops it (`micTap`). It's a click
   handler, so a hardware keyboard's Space/Enter and VoiceOver work too. Pointer-down is
   cancelled so the textarea keeps focus and the keyboard stays up. One mic stream lives for the page's lifetime
   (`ensureMic`): iOS asks permission once per app launch and re-prompts sooner for a
   stopped stream. It uses the built-in mic whenever one is listed: dictating through a
   Bluetooth earbud came out badly garbled ("The urgency that is. Calculate." for "new
   incidents in better stack"), because earbud mics record narrowband call audio.
2. **Speak on red.** The button shows a grey spinner only while the mic stream is being
   (re)acquired, which took ~1.7s after the stream had died. Nothing records then. The
   button goes red the moment the recorder starts. Don't add an AnalyserNode "audio is
   flowing" gate: in the iOS PWA it read pure silence for 8s while MediaRecorder captured
   every word. In the test, counting aloud, 1–18 were all transcribed, and the gate only
   opened on its timeout at "fifteen".
3. **Transcribe.** `POST /sessions/:id/dictate` (multipart `audio`) sends the recording to
   OpenAI `gpt-transcribe` with a vocabulary hint, and returns the raw text in about 1s. A
   network failure or a 5xx is retried with the same recording, up to 3 attempts, so a blip
   never means saying it again. The
   recorder is timesliced (`start(1000)`), and the container is sniffed from the bytes
   (`audioExt`). An un-sliced Safari WebM recording once arrived as just its 5-byte tail,
   with an empty MIME type.
4. **Insert.** The raw text goes in at the caret, spaced from its neighbours
   (`insertDictation`). A take belongs to the session it was started in. If you switched
   sessions, left the thread or backgrounded the app meanwhile, the take is finished and
   appended to that session's saved draft instead. The mic stays visible mid-take, even
   in bash mode, so a take can always be stopped.
5. **Clean.** `POST /dictation/:id/clean` runs `claude -p` (haiku) with the session's terms,
   its recent prose, the personal vocabulary and the learned mis-hearings (`cleanDictation`
   in `core/dictation.ts`). It takes about 3.5–4.5s, and the time is mostly the model, not
   CLI start-up: pre-starting the process while you talk saved only ~0.3s median, so it
   isn't done.

   The prompt turns the dictation into the message as you'd have typed it. It removes
   fillers and false starts, turns spoken lists into numbered lists, and writes spoken
   symbols as typed (`claude -p`, UI/UX, "iff"). It fixes mis-heard terms and leaves every
   other word as said. That target came from your hand edits of real dictations. A looser
   prompt polished fluent sentences and doubled word error against typed prompts.

   The client swaps the cleaned text in only if the raw text is still in the box exactly as
   inserted, so an edit you make meanwhile wins. The swapped words are flashed
   ("Fixed: myatron → Maestro").
6. **Guard.** Cleanup once deleted a whole sentence. So every raw sentence with 3+ real
   words must keep 40%+ of them, and so must the message overall; otherwise the raw text
   is kept (`guardCleanup`). It checks per sentence, not by word count or longest run:
   legitimate edits drop ~16% of words, and a repeated false start makes word alignment
   ambiguous.
7. **Log and learn.** `dictation-log.jsonl` gets a `take` line per cleanup: the transcript,
   the model's output (even when the guard or your edit kept it out of the box), whether
   it was guarded, its latency and the mic used. On send, `POST /dictation/outcome` adds a
   `sent` line: each dictation's take id, what it left in the box, and the message you
   sent. Only text is logged; no audio is kept.
   Short swaps you typed over the dictation ("Betsec" → "betterstack") are kept in
   `dictation-learned.json` (`corrections`, `learnFromOutcome`). The corrected terms lead the
   next transcription prompt, and cleanup gets the pairs as known mis-hearings. Rare terms
   need this: history mining keeps only words used 15+ times, and "betterstack" had 6.

   A learned pair is a rule applied to every later dictation, so a swap is kept only when:
   - it isn't an addition, a case-only edit or a rewrite over three words;
   - it looks like its replacement (character-bigram overlap); and
   - a one-word background `claude -p` check confirms it's a mangled name or term.

   Restructuring a message ("Number one is" → "1", "for" → "as") was otherwise being
   learned.

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
