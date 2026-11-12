# Background work

How Claude0 recovers a session's background scripts and async agents from its transcript
and its agents' transcripts, checks them against the live runner, and shows them. The named docblocks carry the
implementation detail. Decision: [ADR 26](adr/0026-background-work-is-visibility-only.md).
Code: `core/background-tasks.ts`, `core/runner-verdicts.ts`, `core/script-wait.ts`.

| Concern | Where |
|---|---|
| What the session launched and what finished. Bash and Agent launches count only once the `tool_result` confirms a task; any Workflow result counts; a timed-out foreground command counts via the harness's "moved to the background" notice. A `Monitor` counts once "Monitor started" confirms it, and ends only on a notice with a `<status>`, an `[Monitor expired` event or a `TaskStop` of it, never on its per-event notifications | `core/background-tasks.ts` header (the detection rules) |
| Scripts the session's agents launched (forks, teammates, subagents): the launch is recorded only in the agent's own file under `<proj>/<sessionId>/subagents/` (the project dir of the session's cwd at launch, which is not always the transcript's), so every surface below adds those files' pending scripts to the session's. Changed files are re-parsed, the rest cost one stat each | `scanAgentScripts` (`core/background-tasks.ts`) |
| Whether a pending task's runner is alive: `lsof` on its output file, dead verdicts final, alive ones re-probed after a TTL, one file per task. A Monitor is never probed: its output file only appears with its first event and nothing holds it open, so it is live until launch + `timeoutMs` (≤30m) | `core/runner-verdicts.ts` header; the Monitor deadline in `taskLive` (`core/background-tasks.ts`), the one rule `liveScripts` and `liveTasks` share; lsof rules in the CLAUDE.md gotchas |
| ⏳ on the window prefix and inbox discovery: one entry point, so they can't disagree | `detectScriptWaits` (`core/script-wait.ts`) |
| Home list's pending-script count, only for sessions with a live Claude process (with no process, no notification can ever arrive). The row's ⏳ hides while the session runs, like the window prefix | `pendingScriptsAt` (`core/background-tasks.ts`), called from the bridge's sessions payload; `renderInboxRow` (`bridge/public/app.js`) |
| The navbar 🤖/⏳ pill and its sheet: the transcript payload's `pendingScripts`, filtered by the runner probe only, with no process gate | `liveScripts` via `readActiveBranchCached` (`core/session-api.ts`) |
| Sheet order (pending scripts, running agents, agents finished since your last prompt, older collapsed) and its unknown-boundary rule | `AgentList` (`bridge/public/app.js`) |
| Claude's native `shell` status maps to `ready`, with the shell shown only as ⏳ | `core/session-state.ts` header |
| Wait vs service: a script whose label names a server or tunnel, or whose command binds a port (a bare `PORT=`, not a client's `*_PORT=` setting), opens a tunnel or runs a dev server, is a service unless its label opens with a wait verb; only inbox placement reads the difference | `isServiceScript` (`core/background-tasks.ts`), `waitKind` (`core/script-wait.ts`) |
| Whether an agent is done: a final text turn, or a successful `SubagentHandback` call (how current Claude Code ends an agent) | `subagentStatus` / `handedBack` (`core/session-api.ts`) |

Where the harness writes a script's records, which no single file shows:

- A script's launch goes to the transcript of whoever launched it. Its completion notice
  lands either there or in the PARENT's transcript, where it matches no launch and is
  ignored. So an agent's file can say "pending" forever, and only the runner probe ends
  an agent-launched script. A Monitor whose end notice went to the parent shows until
  its deadline.
- A fork that stops with a script still running is reported to the parent as
  `<status>completed</status>` with the summary "is waiting on its own background work";
  a teammate that does the same sends the parent no task notification at all. Neither
  transcript-side signal is used: the agents' files are scanned instead.
- An agent launching a script doesn't change the session's own files, so the open
  conversation's pill picks it up on its next full transcript fetch, not on the
  `?rev=` fast path.

Three parts of what the phone shows aren't stated in any one file:

- The Home count and the pill can disagree for a session with no live Claude process: Home
  shows nothing, while the open conversation's pill still lists a pending script whose
  runner probes alive.
- A finished agent's report shows in two places. Its drill-in ends on it: the
  `SubagentHandback` call's `message` becomes the agent's closing bubble (`slimTurns`).
  The parent thread gets it as an `<agent-message>` delivery: the harness's trust frame is
  stripped (`handbackReport`, `core/transcript.ts`) and the byline maps the hex agentId to
  the agent's description (`TeammateRow`). Agents that ended in plain text before
  handback existed are readable only in the drill-in, because tool_results are stripped
  from the thread.
- While anything is live, the conversation re-fetches every 15s. A done agent misread as
  running keeps that poll going forever, so the status rule matters beyond the pill.
