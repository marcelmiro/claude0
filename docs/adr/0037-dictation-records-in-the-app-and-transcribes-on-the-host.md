# 37. Dictation records in the app and transcribes on the host

Date: 2026-11-18
Status: accepted

## Context

Dictating into Portkey used a third-party iOS keyboard (Raycast). iOS keyboard extensions can't
use the microphone, so every dictation jumped to the Raycast app. Since iOS 26.4, no third-party
keyboard can return to the host app on its own. A home-screen web app has no URL scheme to
return to either, so each dictation ended with a manual swipe back.

Three alternatives were checked:

- **Apple's keyboard dictation.** It stays in the app, but a web page can neither start it nor
  tell when it ends, so it can't be one gesture. It also mis-hears domain terms.
- **Web Speech (`webkitSpeechRecognition`).** WebKit resolved bug 225298 as "later": not
  available in home-screen web apps. Open bug 321436 reports it working only for the first
  session after launch, and conflicting with `getUserMedia`.
- **`getUserMedia` + `MediaRecorder`.** This works in an installed web app. The permission
  prompt returns on every app launch (WebKit bug 327237).

Transcription was benchmarked on 24 real claude0 prompts read by two synthetic voices, scored
against the original text, then checked against the owner's flagged real recordings:

- `gpt-4o-mini-transcribe` with a vocabulary prompt sometimes answered the dictated question
  instead of transcribing it (2 of 48 clips).
- On real recordings, `gpt-transcribe` with a personal vocabulary got right every term the
  owner had flagged (DNC, contacts table, Maestro, EmailBison). `gpt-4o-transcribe` gave
  different words for the same audio on repeat runs.
- A `claude -p` cleanup pass raised jargon accuracy from 77–90% to 93–97%. It costs about 5s,
  and loose prompts reworded text or dropped sentences.

## Decision

- The composer records audio itself and the bridge transcribes it with OpenAI `gpt-transcribe`.
  The vocabulary hint is the session's own terms, then terms mined from every prompt the owner
  has sent.
- The raw transcript is inserted immediately. A strict `claude -p` cleanup then swaps in
  term and punctuation fixes, and is discarded if it dropped words or the user has edited
  the text.
- Dictation is optional. With no OpenAI key on the host, there is no mic button.

## Consequences

- Dictation is one gesture and never leaves Portkey. There is one mic permission prompt per
  app launch.
- Audio and a list of vocabulary terms go to OpenAI. Session prose goes only to Claude, which
  already has it. No audio is stored.
- A dictation costs about $0.005 per minute of audio; the owner's ChatGPT plan includes API
  credits.
- Raw text lands in about 1s; cleaned text arrives about 5s later.
- The personal vocabulary is re-mined daily in a child process, which reads the whole
  transcript history.
- Revisit if Web Speech becomes reliable in home-screen web apps, or if a faster cleanup model
  matches the benchmark.
