# Background work

How Claude0 recovers a session's background scripts and async agents from its transcript,
checks them against the live runner, and shows them. The named docblocks carry the
implementation detail. Decision: [ADR 26](adr/0026-background-work-is-visibility-only.md).
Code: `core/background-tasks.ts`, `core/runner-verdicts.ts`, `core/script-wait.ts`.

| Concern | Where |
|---|---|
| What the session launched and what finished. Bash and Agent launches count only once the `tool_result` confirms a task; any Workflow result counts; a timed-out foreground command counts via the harness's "moved to the background" notice | `core/background-tasks.ts` header (the detection rules) |
| Whether a pending task's runner is alive: `lsof` on its output file, dead verdicts final, alive ones re-probed after a TTL, one file per task | `core/runner-verdicts.ts` header; lsof rules in the CLAUDE.md gotchas |
| ⏳ on the window prefix, the TUI and inbox discovery: one entry point, so they can't disagree | `detectScriptWaits` (`core/script-wait.ts`) |
| Home list's pending-script count, only for sessions with a live Claude process (with no process, no notification can ever arrive) | `pendingScriptsAt` (`core/background-tasks.ts`), called from the bridge's sessions payload |
| The navbar 🤖/⏳ pill and its sheet: the transcript payload's `pendingScripts`, filtered by the runner probe only, with no process gate | `liveScripts` via `readActiveBranchCached` (`core/session-api.ts`) |
| Sheet order (pending scripts, running agents, agents finished since your last prompt, older collapsed) and its unknown-boundary rule | `AgentList` (`bridge/public/app.js`) |
| Claude's native `shell` status maps to `ready`, with the shell shown only as ⏳ | `core/session-state.ts` header |
| Whether an agent is done: a final text turn, or a successful `SubagentHandback` call (how current Claude Code ends an agent) | `subagentStatus` / `handedBack` (`core/session-api.ts`) |

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
