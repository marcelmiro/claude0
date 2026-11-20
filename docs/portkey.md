# Portkey

Mechanism notes for the phone client (`src/bridge/public/`). Driving it in a real
browser: [portkey-design-loop.md](portkey-design-loop.md). Home is the inbox:
[inbox.md](inbox.md). The offline app shell: [ADR 21](adr/0021-offline-app-shell.md).

## Thread rendering

| Behavior | Where (`app.js`) |
|---|---|
| A run of 3+ tool-only records is one burst: expanded if it's work since the last prompt (`lastPromptAt`), else a one-line tally that expands on tap | `ToolBurst`, `isToolOnlyTurn` |
| One working indicator: the live tool chip while a tool runs, else the "working…" line with elapsed time — "compacting…" (no elapsed) while a compaction runs, which writes nothing to the transcript until it ends: the PreCompact hook edge, AND-ed with a running native status | `ToolChip`, `Working`, `compactionInFlight` (`core/hook-events.ts`) |
| Slash-command turns are a normal user bubble with the `/name` in mono; long-press is copy-only. Queued and sending bubbles of a command render the same way. A queued command's bare-text record (written at dequeue, before its runner record) parses as a command turn too (`core/transcript.ts`) | `Turn`, `commandBody` |
| An optimistic send bubble is faded and grows a "sending…" tag after ~5s (a delivered `!cmd` or `/command` shows "running · <elapsed>" instead); a server-confirmed queue entry is full-strength text in a dashed peach outline with a `◷ queued` tag — they never share a look | `SendingTag`, `.bubble.queued` |
| A history image is a thumbnail read back from the JSONL: the transcript payload carries only a byte-free marker with a `ref` (record uuid + block index, `toBlock` in `core/transcript.ts`), and `GET /sessions/:id/image/:ref` decodes that block (`core/transcript-image.ts`). Images load last: a skeleton until the full transcript is in and no API request has been in flight for 400ms, then newest-first, two at a time; an unreadable one falls back to the "🖼 image" chip. Tapping any image (history, sending bubble, composer tray) opens it framed and inset over the blurred thread with a × (so a screenshot of portkey itself still reads as a preview), easing in and out | `TranscriptImage`, `pumpImages`, `Lightbox` |

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
  (`launchNotice`), and the + button pulses while a launch is pending. The phone mints the
  session id and sends it with `/sessions/new`, so when the response is lost (timeout or a
  dropped tunnel) it looks for that id in the list before calling the launch failed — the
  bridge may have opened the pane anyway, and a blind retry would start a second session.
- The sidebar's `n` mode is a separate surface: it keeps `discoverRepos` order (repos with a
  live session, then A–Z) and has no Recent section.

## Composer button

One button left of the textarea (`ComposerButton`) replaces the old attach `＋` and mic.

- **Tap** dictates (below). Without an OpenAI key on the host (`GET /dictation`) the face is
  `＋` and a tap opens the menu with its rows tappable instead.
- **Hold (260ms) or swipe up** opens the menu above the button. Slide onto a row and lift to
  fire it; lifting anywhere else cancels, so a hold released in place does nothing. Off the
  menu the rows fade (`muted`) to say a lift will cancel. Top to bottom: **Clear**,
  **Attach**, **All skills**, then the pinned skills with the first pin nearest the thumb.
- **Pins** are config `ui.composerSkills` (default `["/compact"]`, served by `GET /composer`).
  A skill goes to the front of the draft and replaces any leading `/command`; the rest of the
  draft becomes its arguments (`withSkill`, `shared/message-text.js`). It never sends. **All
  skills** opens the repo-scoped slash menu, and a pick there goes to the front the same way.
- **Clear** empties text, attachments and bash mode; the "Cleared" notice's Undo puts all
  three back for 5s. With nothing to clear the row stays, dimmed and inert, so the menu keeps
  its shape.
- **Bash mode.** Any action leaves it and keeps the typed command as plain text: a skill,
  dictation or attachment has no meaning in a shell command.
- **Attachments.** Images are downscaled to JPEG and pasted as image paths, as before. Any
  other file goes up as a multipart `file`, is saved as `uploads/<uuid>/<name>` (`saveUploadedFile`,
  `safeUploadName`) and rides in the message as a `[File: <path>]` ref (`withFileRefs`).
  History renders the refs as 📎 marks. A bare path would do for Claude, but a message that
  starts with one is read by Claude Code as a slash command. Files go up at full size, so a
  send with files gets a 5-minute timeout instead of 30s: the bridge types the message once
  the upload lands, and a client that gave up first would restore the draft for a duplicate
  resend. A file over 30MB is refused when attached (`MAX_FILE_BYTES`), under the bridge's
  32MB `maxRequestBodySize`, which otherwise answers a bare 413.
- **Swipe-back** ignores touches that start on the button: it sits in the left edge zone,
  and its menu drag runs up and to the right.

iOS facts this is built on, each measured on an iPhone (Safari 27) and an iPad:

- **Only a tap opens a file picker.** WebKit's file input needs a fresh user activation
  (`FileInputType::handleDOMActivateEvent`), and on iOS a swipe, a still hold or a hold-and-drag
  grants none — tested with every earlier touch more than 5s (the activation window) back.
  So lifting on Attach doesn't open the picker; it shows a large **Attach** button where the
  finger lifted, and that one tap opens it.
- **The picker always starts with iOS's menu** (Photo Library / Take Photo / Choose File) for
  any `accept` that allows images, and no attribute or API reaches the Photos picker directly
  (WebKit `WKFileUploadPanel`). With no `accept`, Choose File allows any type.
- **Haptics come only from a real switch moved by the finger.** Safari has no Vibration API,
  and a scripted click on an `<input type="checkbox" switch>` never ticks (the toggle path
  handles trusted clicks only). An invisible switch, rotated so a swipe up slides its thumb,
  sits over the button (`.cbswitch`): the swipe that opens the menu ticks. A hold-to-open and
  moving between rows can't tick.

## Dictation

Why it records in the app instead of using the iOS keyboard or Web Speech:
[ADR 37](adr/0037-dictation-records-in-the-app-and-transcribes-on-the-host.md). A tap on the
composer button dictates when the host has `~/.config/claude0/openai-key` (`GET /dictation`).

Order of one dictation:

1. **Tap.** A tap starts recording and the next tap stops it (`micTap`). It's a click
   handler, so a hardware keyboard's Space/Enter and VoiceOver work too. Pointer-down is
   cancelled so the textarea keeps focus and the keyboard stays up. One mic stream lives for the page's lifetime
   (`ensureMic`): iOS asks permission once per app launch and re-prompts sooner for a
   stopped stream. iOS can mute that kept stream, which happened after the app sat in the
   background, and leave it muted. The track still reads "live" but records silence (0-byte
   takes) with no orange mic dot, so a muted track is replaced with a fresh one before
   recording. A track that mutes or ends mid-take finishes the take. It uses the built-in mic whenever one is listed: dictating through a
   Bluetooth earbud came out badly garbled ("The urgency that is. Calculate." for "new
   incidents in better stack"), because earbud mics record narrowband call audio.
2. **Speak on red.** The button shows a grey spinner only while the mic stream is being
   (re)acquired, which took ~1.7s after the stream had died. Nothing records then. The
   button goes red the moment the recorder starts. Don't add an AnalyserNode "audio is
   flowing" gate: in the iOS PWA it read pure silence for 8s while MediaRecorder captured
   every word. In the test, counting aloud, 1–18 were all transcribed, and the gate only
   opened on its timeout at "fifteen".
   While red, the face counts seconds and a halo behind it grows with the voice level
   (`startMeter`). The meter is display only, for the same reason. Its AudioContext is
   resumed inside the tap, since iOS runs one only from a gesture, and each take logs its
   peak (`dictation-trace: meter`): 0 means the meter heard nothing.
3. **Transcribe.** `POST /sessions/:id/dictate` (multipart `audio`) sends the recording to
   OpenAI `gpt-transcribe` with a vocabulary hint, and returns the raw text in about 1s. A
   network failure or a 5xx is retried with the same recording, up to 3 attempts, so a blip
   never means saying it again. The
   recorder is timesliced (`start(1000)`), and the container is sniffed from the bytes
   (`audioExt`). An un-sliced Safari WebM recording once arrived as just its 5-byte tail,
   with an empty MIME type.
4. **Insert.** The raw text is appended to the end of the box, never at the caret: a caret
   left mid-message put dictations in the middle of the draft (`insertDictation`). A take belongs to the session it was started in. If you switched
   sessions, left the thread or backgrounded the app meanwhile, the take is finished and
   appended to that session's saved draft instead. Starting a take leaves bash mode, and a
   take can always be stopped, even with the composer disabled.
5. **Clean.** `POST /dictation/:id/clean` runs `claude -p` (haiku) with the session's terms,
   its recent prose, the personal vocabulary and the learned mis-hearings (`cleanDictation`
   in `core/dictation.ts`). It took a median 3.9s and up to 10.7s over 51 takes. The time is
   mostly the model, not CLI start-up: pre-starting the process while you talk saved only
   ~0.3s median, so it isn't done. Haiku thinks adaptively on long takes (up to ~2K thinking
   tokens), and neither `--effort low`, `MAX_THINKING_TOKENS` nor
   `CLAUDE_CODE_DISABLE_THINKING` turns that off. What `claudePrint` does cut is the tool,
   MCP and skill definitions (`--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`),
   about 22K of ~32K input tokens. On 5 long takes
   that halved the mean, ~8.0s to ~4.7s, with the same fixes.

   Haiku, not Sonnet, though Sonnet is ~1.5s faster. On a 48-clip benchmark Sonnet turned
   correct words into vocabulary terms 4–7 times per run ("CSM", "local Claude", "Camp One"
   → "claude0"). Haiku did it at most once ("twoe" → "tmux" for a spoken "TUI") and fixed
   about as many real mis-hearings. A prompt that spelled out "keep the speaker's grammar"
   stopped Sonnet's grammar edits but not its term rewrites.

   The prompt turns the dictation into the message as you'd have typed it. It removes
   fillers and false starts, turns spoken lists into numbered lists, and writes spoken
   symbols as typed (`claude -p`, UI/UX, "iff"), and writes a number that points at something
   (a list item, PR, code) in digits ("do 1 and 2"); counts in prose stay words. It fixes
   mis-heard terms and leaves every other word as said. That target came from your hand
   edits of real dictations. A looser prompt polished fluent sentences and doubled word
   error against typed prompts.

   The client swaps the cleaned text in only if the raw text is still in the box exactly as
   inserted, so an edit you make meanwhile wins. While cleanup runs, the arc on the
   button's rim spins peach. Each outcome then flashes: the swapped words ("Fixed: myatron
   → Maestro"), punctuation and layout only, "nothing to fix", kept as dictated (guard or
   failure) or not applied (edited). A cleanup that returns after the message was sent, or
   after you left the session, is dropped without a flash. Before this, 8 of 17 changed
   cleanups landed after the message was sent.
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
   - it isn't an addition, a case-only edit, a tense or plural change, or a rewrite over
     three words. The `claude -p` check below passed "works" → "worked";
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
- **Memory.** Mining reads every top-level transcript (~4.4GB), so it uses `shortJsonlLines`,
  which skips lines over 64KB without decoding them. Decoding every line, as `jsonlLines`
  does, peaks at ~500MB RSS; skipping them takes ~120MB.
- **Kept by shape.** Acronyms used mostly in caps, and identifier-shaped words. The
  identifier spelling is canonical ("CustomerOS", not the "customeros" you type).
- **Judged by Claude.** The remaining frequent words go to batched `claude -p` calls that
  keep the domain terms. Their output is matched back against the batch, so a hallucinated
  term can't enter.

## Network trace

"no response (network)" means a request got no HTTP response at all: it timed out
(`TimeoutError`, 12s; 30s for slow endpoints) or the connection failed (`TypeError`). That
is the path between the device and the VM — usually the device's Tailscale tunnel, which
iOS suspends in the background and which can take minutes to carry traffic again. A dead
bridge is different: Tailscale serve still answers, with a 502.

The patched `fetch` records every such failure, and every 5xx, with its path (no query),
duration, and whether the page was hidden, how long since it was foregrounded, and
`navigator.onLine`. The stream records a gap when it stayed down for 3s+ with the app on
screen (`visibleMs`). Entries can't be sent while the network is down, so they queue in
localStorage (`claude0-net-trace`, newest 50) and flush to `POST /net/trace` on the next
request that gets a non-5xx response (`fetchFailure`, `streamGap`, `shared/net-trace.js`).

Reading an outage: `journalctl --user -u claude0-bridge | grep net-trace`. The journal time
is when the network came back; each entry's `at` is when its request started. Then compare
with the VM's Tailscale side: `sudo journalctl -u tailscaled | grep "new contact"` shows a
check-in from an active peer about every 5s, so a gap there covering the failures means
nothing from the device reached the VM. Failures with no such gap point at the bridge.

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
