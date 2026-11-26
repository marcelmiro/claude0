# Background work

How Claude0 recovers a session's background scripts, workflows and async agents from its transcript
and its agents' transcripts, checks them against the live runner, and shows them. The named docblocks carry the
implementation detail. Decision: [ADR 26](adr/0026-background-work-is-visibility-only.md).
Code: `core/background-tasks.ts`, `core/runner-verdicts.ts`, `core/script-wait.ts`.

| Concern | Where |
|---|---|
| What the session launched and what finished. Bash, Agent and Workflow launches count only once the `tool_result` confirms a task; a timed-out foreground command counts via the harness's "moved to the background" notice. A `Monitor` counts once "Monitor started" confirms it, and ends only on a notice with a `<status>`, an `[Monitor expired` event or a `TaskStop` of it, never on its per-event notifications | `core/background-tasks.ts` header (the detection rules) |
| Scripts the session's agents launched (forks, teammates, subagents): the launch is recorded only in the agent's own file under `<proj>/<sessionId>/subagents/` (the project dir of the session's cwd at launch, which is not always the transcript's), so every surface below adds those files' pending scripts to the session's. Changed files are re-parsed, the rest cost one stat each | `scanAgentScripts` (`core/background-tasks.ts`) |
| Whether a pending task's runner is alive: does any process hold its output file open (`/proc/*/fd` on Linux, `lsof` on macOS), dead verdicts final, alive ones re-probed after a TTL, one file per task. A Monitor is never probed: its output file only appears with its first event and nothing holds it open, so it is live until launch + `timeoutMs` (≤30m) | `core/runner-verdicts.ts` header; the Monitor deadline in `taskLive` (`core/background-tasks.ts`), the one rule `liveScripts` and `liveTasks` share; fd-probe rules in the CLAUDE.md gotchas |
| ⏳ on the window prefix and inbox discovery: one entry point, so they can't disagree. A running workflow is a wait (Claude resumes when it ends), counted without a runner probe because only `ready` sessions are checked and their own process runs it | `detectScriptWaits` (`core/script-wait.ts`) |
| Home list's pending-script count and lead task, only for sessions with a live Claude process (with no process, no notification can ever arrive). The row's ⏳ hides while the session runs, like the window prefix | `pendingScriptsAt` (`core/background-tasks.ts`), called from the bridge's sessions payload; `renderInboxRow` (`bridge/public/app.js`) |
| The navbar pill: each slot counts live items of one kind (🧩 workflows, 🤖 running agents, ⏳ waits, ◉ services: a service hands the turn back, so it is no ⏳), with nothing live a bare entry point to the finished list. It and its sheet read the transcript payload's `pendingScripts`, filtered by the runner probe; the server applies no process gate, so the phone does: for a session with no live Claude process (anything but running/ready/waiting) a "running" agent or pending workflow shows as stopped and scripts are dropped | `liveScripts` via `readActiveBranchCached` (`core/session-api.ts`); `bgParts` (`bridge/public/app.js`) |
| Sheet layout: Home-style RUNNING (workflows with stalled ones first, scripts and monitors, running agents) and FINISHED (ended workflows and agents interleaved newest first; since your last prompt open, older collapsed, or the newest 3 open when nothing is running or new) sections; every row is name (up to two lines), one sub-line, a time on the right (elapsed under Running, since under Finished). A monitor's sub-line is its latest event. Peach only warns: new finished rows get a white dot. Its unknown-boundary rule | `AgentList` (`bridge/public/app.js`) |
| Claude's native `shell` status maps to `ready`, with the shell shown only as ⏳ | `core/session-state.ts` header |
| Wait vs service: a script whose label opens with "Boot" or names a server or tunnel, or whose command binds a port (a bare `PORT=`, not a client's `*_PORT=` setting), opens a tunnel or runs a dev server, is a service unless its label opens with a wait verb or routes the run "through the … server". A server the command backgrounds itself (`server &`) doesn't count: the script goes on to finish; only inbox placement reads the difference | `isServiceScript` (`core/background-tasks.ts`), `waitKind` (`core/script-wait.ts`) |
| A workflow is one row, never its agents: they live under its run dir (`subagents/workflows/<runId>/`), which the subagent listing doesn't descend into. It is pending until its notice or a `TaskStop`, with no runner probe (nothing holds its output file open), and only the session's own launches count, not its agents'. Its progress comes from the run dir: one `agent-*.meta.json` per agent (the newest one's `workflowPhase` is the phase), each done by the subagent rule, a done transcript's mtime being when it finished. The harness's `journal.jsonl` is not read: on a real run it stopped 20 minutes before the run did. An agent that ended on an API error or was interrupted (the harness's stall retry) is not done. No agent finishing for 15 minutes (counted from the launch until the first) reads as stalled, on the row and the Home line: across 51 real runs the longest healthy gap was 9.5m, and runs whose agents all failed finished none. No file carries the total while a run lives: Claude Code holds it in memory (every `agent()` call so far, queued included) and shows it only on its footer row, "◯ <name>  <bar>  91/165 · …", which drops N/M on narrow panes and hides under menus and dialogs. The bridge reads it off the pane capture it already takes, best effort and never cached (same-named runs share a total only when their rows agree): the row shows "91/165" when the read succeeds and "91 done" when it doesn't, plus the phase. An ended workflow stays in the sheet like a finished agent, showing only its outcome: completed, stopped, or failed, with failed agents from the notice's `<usage>` block | `workflowProgress` / `withWorkflowProgress` / `screenTotal` / `endedWorkflows` (`core/background-tasks.ts`); `AgentList` (`bridge/public/app.js`) |
| Home row's sub-line: the session's lead background task (a workflow with its progress, a stalled one first, else a wait's label, else its running background agents by count and the newest one's description, else a service as "serving"), whatever the status. Agents count from their own files, the sheet's source (an agent resumed with `SendMessage` has no launch in the parent transcript), so a session that ended its turn with agents out doesn't read as idle. A service never gets the ⏳ mark: it hands the turn back | `backgroundLead` (`core/background-tasks.ts`), the sessions payload (`bridge/server.ts`), `renderInboxRow` (`bridge/public/app.js`) |
| Whether an agent is done: a final text turn, a successful `SubagentHandback` or `StructuredOutput` result (read across the trailing run of records, since a call made in parallel with another tool writes two assistant records then two results), and `stopped` (no report) for a user interrupt or an API-error ending. An agent killed with its session's process writes nothing terminal: the phone reads that from the session's status | `subagentStatus` (`core/agent-status.ts`) |

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
- An agent launching a script, a runner dying and a workflow's progress change nothing in
  the session's own files, so the `?rev=` fast path ships `pendingScripts` fresh on every
  call (`pendingScriptsFor`) and the phone treats it as a volatile field.

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
