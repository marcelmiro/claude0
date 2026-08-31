/**
 * Transcript parsing (Contract B) — resolved conversational history only.
 *
 * Reads a Claude Code JSONL transcript into ordered `TranscriptTurn`s. Generalizes
 * the tail-read in `jsonl-reader.ts`. Per A5, conversational records have a
 * top-level `type` of `user` | `assistant`; everything else (mode, permission-mode,
 * last-prompt, ai-title, system, file-history-snapshot, …) is meta and dropped —
 * EXCEPT a `queued_command` prompt attachment, which is a real human message consumed
 * mid-turn (see `isQueuedPromptAttachment`) and maps to a `queued` user turn.
 * A record nests an Anthropic `message` whose `content` is either a string
 * (→ one text block) or an array of blocks.
 *
 * SCOPE (A3): pending interactions are NOT here — a tool awaiting approval has no
 * record until resolved. Pending data comes from the PreToolUse hook (Contract A).
 *
 * Tolerant by contract: unknown keys ignored, a truncated/half-written final line
 * is dropped (per-line try/parse). Forward-compat with claude minor versions.
 */

// Re-export so the contract test can import these from "./transcript".
export type { TranscriptBlock, TranscriptTurn } from "../types";
import type { TranscriptBlock, TranscriptTurn } from "../types";

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Slash-command runner records (`/compact`, `/clear`, …). Claude Code emits these
 * as `user` turns wrapped in reserved tags and renders them as a command pill, not
 * raw text. We drop them so the transcript shows conversation, not the plumbing.
 */
const LOCAL_COMMAND_META =
  /^\s*<(?:local-command-caveat|local-command-stdout|command-name|command-message|command-args|command-contents)>/;

/**
 * Async-subagent completion reports. When a background `Agent`/Task finishes, Claude
 * Code injects a `<task-notification>…</task-notification>` block as a `user` record and
 * renders it as a system notification, NOT a user message. We drop it so a session that
 * fans out to background agents doesn't read as the user posting walls of subagent output.
 */
const TASK_NOTIFICATION = /^\s*<task-notification>/;

/**
 * `!cmd` bash passthrough. Claude Code writes two ADJACENT `user` records: the command
 * (`<bash-input>cmd</bash-input>`) and its output (`<bash-stdout>…</bash-stdout>
 * <bash-stderr>…</bash-stderr>` — both tags observed on every record, stderr empty
 * included, but the parser must not depend on that shape). `recordToTurn` maps the
 * input to a `bash` turn and the output to a fold marker; `foldBashTurns` merges the
 * marker into the preceding command turn so the pair renders as one turn.
 */
const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/;
const BASH_OUTPUT_OPEN = /^\s*<bash-(?:stdout|stderr)>/;

/**
 * Claude-teams mailbox delivery: a teammate session's message injected into this
 * transcript as a `user` record — "Another Claude session sent a message:" followed by
 * one or more tagged blocks and a trailing trust-boundary boilerplate. Two wrappers
 * exist: `<teammate-message teammate_id= color= [summary=]>` (mailbox deliveries) and
 * `<agent-message from=>` (direct agent reports — no color or summary attributes).
 * Gate on the injected PREFIX, not the tag alone: a user pasting a quoted teammate
 * block mid-message must keep rendering as their own text. The summary lives either as
 * a `summary` attribute on the tag or as a `summary` field in a JSON payload
 * (idle_notification records use the latter).
 */
export const TEAMMATE_PREFIX = /^\s*Another Claude session sent a message:/;
const TEAMMATE_MESSAGE = /<(teammate-message|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/g;

/** Parse a teams delivery's tagged blocks; null when the prefix or every tag is absent. */
function parseTeammateDelivery(text: string): TranscriptTurn["teammate"] | null {
  if (!TEAMMATE_PREFIX.test(text)) return null;
  const msgs: NonNullable<TranscriptTurn["teammate"]> = [];
  for (const m of text.matchAll(TEAMMATE_MESSAGE)) {
    const attrs = m[2];
    const body = m[3].trim();
    let summary = attrs.match(/summary="([^"]*)"/)?.[1] ?? "";
    if (!summary) {
      try {
        const payload = JSON.parse(body);
        if (typeof payload?.summary === "string") summary = payload.summary;
      } catch {} // non-JSON payload — no summary to lift
    }
    msgs.push({
      id: attrs.match(/(?:teammate_id|from)="([^"]*)"/)?.[1] ?? "teammate",
      color: attrs.match(/color="([^"]*)"/)?.[1],
      summary,
      body,
    });
  }
  return msgs.length ? msgs : null;
}

/** Internal pre-fold turn: `bashOutput` marks an output record and never leaves this module. */
interface FoldableTurn extends TranscriptTurn {
  bashOutput?: { stdout: string; stderr: string };
}

/** A parsed conversational record: the turn plus the tree links used to rebuild a branch. */
interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: unknown };
  attachment?: { type?: string; prompt?: unknown; commandMode?: string };
}

/**
 * A message sent while the session is mid-turn sits in Claude Code's input queue. When
  timestamp?: string;
 * it is consumed MID-turn (inside a tool loop — the common case) it never becomes a
 * `user` record: the queue logs a `remove` op and the message lands on the active branch
 * as a `queued_command` attachment (the next assistant record parents onto its uuid).
 * Gate on `commandMode === "prompt"` — that is the human-typed kind; `task-notification`
 * attachments are background-task plumbing and must stay dropped. (`origin.kind` is NOT
 * the gate: some prompt-mode records in real history lack `origin` entirely.)
 *
 * Exported as THE gate for this record kind — `last-turn.ts`'s prompt-boundary scan
 * reuses it so the thread and the "since your last prompt" boundary can't drift apart.
 */
export function isQueuedPromptAttachment(record: {
  type?: string;
  attachment?: { type?: string; commandMode?: string };
}): boolean {
  return (
    record.type === "attachment" &&
    record.attachment?.type === "queued_command" &&
    record.attachment.commandMode === "prompt"
  );
}

/**
 * Convert a conversational record (`type` of `user`/`assistant`) to a `TranscriptTurn`,
 * or null when it carries no visible content (pure local-command plumbing). A genuinely
 * empty turn (no blocks to begin with) is preserved as `{ content: [] }`.
 *
 * `isMeta` records (e.g. the `Base directory for this skill: …` injection a skill launch
 * adds as a `user` turn) are hidden by the terminal; we drop them too so they don't show
 * as user bubbles.
 */
function recordToTurn(record: RawRecord): FoldableTurn | null {
  if (isQueuedPromptAttachment(record)) {
    const text = typeof record.attachment?.prompt === "string" ? record.attachment.prompt : "";
    if (!text || LOCAL_COMMAND_META.test(text) || TASK_NOTIFICATION.test(text)) return null;
    // A teams delivery consumed mid-turn from the input queue is still a teammate
    // message, not something the user queued — render it as a teammate turn.
    const attachedTeammate = parseTeammateDelivery(text);
  const turn = recordToTurnBody(record);
  if (turn && typeof record.timestamp === "string" && record.timestamp) turn.at = record.timestamp;
  return turn;
}

function recordToTurnBody(record: RawRecord): FoldableTurn | null {
    if (attachedTeammate) return { role: "user", content: [], teammate: attachedTeammate };
    return { role: "user", content: [{ type: "text", text }], queued: true };
  }
  if (record.type !== "user" && record.type !== "assistant") return null;
  const content = record.message?.content;
  if (record.isMeta) {
    // The one meta shape we surface: a queue-consumed teams delivery lands as an
    // isMeta user record (turn-end deliveries arrive non-meta). Everything else
    // meta stays hidden.
    if (record.type === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as RawBlock[])
                .filter((b): b is { type: "text"; text: string } => b?.type === "text")
                .map((b) => b.text)
                .join("\n")
            : "";
      const metaTeammate = parseTeammateDelivery(text);
      if (metaTeammate) return { role: "user", content: [], teammate: metaTeammate };
    }
    return null;
  }

  const blocks: TranscriptBlock[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? (content as RawBlock[]).map(toBlock).filter((b): b is TranscriptBlock => b !== null)
        : [];

  // An executed slash command's runner record (`<command-name>…`): map to a command turn
  // instead of dropping it — the terminal echoes the command as your prompt line; dropping
  // it made a command sent from the phone look lost. Output/caveat records (`<local-command-*>`)
  // carry no <command-name> and stay dropped below.
  const joined = blocks
    .filter((b): b is Extract<TranscriptBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const name = joined.match(/<command-name>([^<]+)<\/command-name>/)?.[1]?.trim();
  if (name) {
    const args = joined.match(/<command-args>([^<]+)<\/command-args>/)?.[1]?.trim();
    return { role: record.type, content: [], command: args ? `${name} ${args}` : name };
  }

  // `!cmd` bash passthrough records (see BASH_INPUT above). Only `user` records carry them.
  if (record.type === "user") {
    const input = joined.match(BASH_INPUT);
    if (input) {
      return { role: "user", content: [], bash: { command: input[1].trim(), stdout: "", stderr: "" } };
    }
    if (BASH_OUTPUT_OPEN.test(joined)) {
      // Extract each tag independently — don't assume both are present.
      const stdout = joined.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/)?.[1] ?? "";
      const stderr = joined.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/)?.[1] ?? "";
      return { role: "user", content: [], bashOutput: { stdout, stderr } };
    }

    // Teams mailbox delivery (see TEAMMATE_PREFIX above) → a teammate turn, one entry
    // per tagged block. The surrounding boilerplate is plumbing and dropped.
    const teammate = parseTeammateDelivery(joined);
    if (teammate) return { role: "user", content: [], teammate };
  }

  const visible = blocks.filter(
    (b) =>
      !(b.type === "text" && (LOCAL_COMMAND_META.test(b.text) || TASK_NOTIFICATION.test(b.text))),
  );
  if (visible.length === 0 && blocks.length > 0) return null;

  // "No response requested." is a sentinel the terminal suppresses, in both its forms:
  // the harness writes it as a synthetic assistant record (model "<synthetic>") to close
  // a dangling user leaf on resume, and the model itself replies with it when a turn
  // needs no answer (e.g. after a `!` command's output). Drop it so neither renders as
  // a real assistant bubble.
  const only = visible[0];
  if (
    record.type === "assistant" &&
    visible.length === 1 &&
    only?.type === "text" &&
    only.text.trim() === "No response requested."
  ) {
    return null;
  }

  // The post-compaction summary is a `user` record carrying the entire summary as its text.
  // Flag it so the UI labels it a "continued from compacted summary" divider rather than a
  // giant user bubble — the branch literally originated from a compact here.
  if (record.isCompactSummary) return { role: record.type, content: visible, compactSummary: true };

  return { role: record.type, content: visible };
}

/**
 * Merge each bash output marker into its immediately-preceding bash command turn.
 * An orphan output (no preceding command — e.g. a branch walk clipped the input) is
 * dropped; a command with no following output keeps empty stdout/stderr (killed
 * mid-command). Markers never survive this pass.
 */
function foldBashTurns(turns: FoldableTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const turn of turns) {
    if (turn.bashOutput) {
      const prev = out[out.length - 1];
      // Guard on still-empty output so a stray second output record can't clobber a
      // previously-folded pair.
      if (prev?.bash && !prev.bash.stdout && !prev.bash.stderr) {
        prev.bash.stdout = turn.bashOutput.stdout;
        prev.bash.stderr = turn.bashOutput.stderr;
      }
      continue;
    }
    out.push(turn);
  }
  return out;
}

/** Parse a raw JSONL transcript into ordered turns (oldest first), in file order. */
export function parseTranscript(raw: string | string[]): TranscriptTurn[] {
  const turns: FoldableTurn[] = [];
  for (const line of typeof raw === "string" ? raw.split("\n") : raw) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated/half-written line — drop it
    }
    const turn = recordToTurn(record);
    if (turn) turns.push(turn);
  }
  return foldBashTurns(turns);
}

/**
 * Parse a raw JSONL transcript into the turns of its ACTIVE conversation branch only.
 *
 * Claude Code's JSONL is a tree, not a linear log: a rewind or edit-and-resend appends a
 * NEW branch (its first record's `parentUuid` points back at an earlier message) while the
 * abandoned branch's records stay in the file. The terminal renders only the active branch
 * — the path from the latest leaf back to the root — so a linear read (`parseTranscript`)
 * shows abandoned-branch and subagent (`isSidechain`) turns the user never committed.
 *
 * Reconstruct that path: index records by `uuid`, take the LAST non-sidechain
 * conversational record as the active leaf (Claude writes the live tip last), then walk
 * `parentUuid` to the root and reverse to oldest-first. Sidechain turns fall out naturally
 * (they branch off the main line and are never ancestors of the main leaf); we also skip
 * any sidechain record defensively. A broken parent link (missing uuid) just stops the
 * walk, yielding the deepest intact suffix rather than crashing.
 */
export function parseActiveBranch(raw: string | string[]): TranscriptTurn[] {
  const byId = new Map<string, RawRecord>();
  let leaf: string | null = null;
  let sawConversational = false;
  for (const line of typeof raw === "string" ? raw.split("\n") : raw) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated/half-written line — drop it
    }
    if (typeof record.uuid === "string") byId.set(record.uuid, record);
    const conversational = record.type === "user" || record.type === "assistant";
    if (conversational) sawConversational = true;
    // A queued-prompt attachment is leaf-eligible too: between its `remove` op and the
    // next assistant append it IS the deepest node of the active branch — without this
    // the just-consumed message would vanish from the transcript for one poll cycle.
    if (
      (conversational || isQueuedPromptAttachment(record)) &&
      !record.isSidechain &&
      typeof record.uuid === "string"
    ) {
      leaf = record.uuid; // newest wins — the active tip is written last
    }
  }

  // Pre-tree logs (no `uuid` on any conversational record) carry no branch to rebuild —
  // fall back to the linear read so they still render rather than coming back empty.
  if (!leaf && sawConversational) return parseTranscript(raw);

  const chain: RawRecord[] = [];
  const seen = new Set<string>();
  for (let id: string | null = leaf; id && byId.has(id) && !seen.has(id); ) {
    seen.add(id);
    const record = byId.get(id)!;
    if (!record.isSidechain) chain.push(record);
    id = typeof record.parentUuid === "string" ? record.parentUuid : null;
  }
  chain.reverse(); // walked leaf→root; emit oldest-first

  const turns: FoldableTurn[] = [];
  for (const record of chain) {
    const turn = recordToTurn(record);
    if (turn) turns.push(turn);
  }
  return foldBashTurns(turns);
}

/** The text of the last assistant turn that has any text content, else undefined. */
export function lastAssistantMessage(turns: TranscriptTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const text = turn.content
      .filter((b): b is Extract<TranscriptBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    if (text) return text;
  }
  return undefined;
}

/** Map one raw content block to a typed `TranscriptBlock`, or null if unknown. */
function toBlock(block: RawBlock): TranscriptBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "thinking":
      return { type: "thinking", text: block.thinking ?? "" };
    case "tool_use":
      return { type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.tool_use_id ?? "", content: block.content, is_error: block.is_error };
    case "image":
      return { type: "image" }; // drop the (large base64) source — keep only a marker
    default:
      return null; // unknown block type — drop
  }
}
