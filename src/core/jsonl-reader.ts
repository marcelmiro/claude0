/**
 * JSONL session file reader for preview rendering.
 * Reads structured messages from Claude Code session files and returns
 * them in a format suitable for markdown rendering at any width.
 */

export interface ToolInput {
  name: string;
  /** Bash: the command string */
  command?: string;
  /** Bash: intent description */
  description?: string;
  /** file path (Read/Edit/Write/etc.) */
  filePath?: string;
  /** Edit: text being replaced */
  oldString?: string;
  /** Edit: replacement text */
  newString?: string;
  /** Write: file content (truncated to 500 chars) */
  content?: string;
  /** Glob/Grep: search pattern */
  pattern?: string;
  /** AskUserQuestion: question data */
  question?: { header: string; text: string; options: Array<{ label: string; description?: string }>; multiSelect: boolean };
}

export interface PreviewMessage {
  role: "user" | "assistant" | "tool-use";
  /** Raw markdown text (assistant text blocks, user prompts) */
  text: string;
  /** Tool names used in this turn (for tool-use messages) */
  toolNames?: string[];
  /** Structured tool input details for preview rendering */
  toolInputs?: ToolInput[];
  /** Bash command output from progress entries */
  bashOutput?: string;
  /** Thinking block text (truncated) */
  thinking?: string;
  /** User turn that is a bracketed system marker (e.g. "[Request interrupted…]") */
  system?: boolean;
  /** Tool-use message whose paired tool_result was an error/denial */
  toolError?: boolean;
}

interface JsonlEntry {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    stop_reason?: string | null;
  };
  data?: {
    type?: string;
    fullOutput?: string;
  };
  parentToolUseID?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
  tool_use_id?: string;
}

/**
 * Stream a JSONL file line by line in bounded chunks, so multi-MB transcripts never
 * materialize as one contiguous string. On macOS, malloc never returns large freed
 * blocks to the OS, so every full-file `.text()` of a big transcript permanently
 * ratchets the process RSS — a long-lived process (the bridge) re-reading live
 * transcripts each refresh plateaued near 1GB from exactly that. Decoding goes
 * through a streaming TextDecoder so a multi-byte character split across chunk
 * boundaries survives intact. Early `break` by the consumer cancels the read. `start` is a
 * byte offset for incremental readers that already consumed the file up to there.
 */
export async function* jsonlLines(path: string, start = 0): AsyncGenerator<string> {
  const file = Bun.file(path);
  const reader = (start ? file.slice(start) : file).stream().getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      yield* parts;
    }
    carry += decoder.decode();
    if (carry) yield carry;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Read the last N conversation messages from a JSONL session file.
 * Reconstructs multi-entry assistant turns by grouping on message.id.
 * Returns messages in chronological order (oldest first).
 */
export async function readPreviewMessages(
  sessionPath: string,
  messageCount = 3,
): Promise<PreviewMessage[]> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return [];

    // Read more for context — need enough lines to find N conversation messages
    const TAIL_SIZE = 64 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const rawLines = chunk.trim().split("\n").filter(Boolean);

    // Skip first line if we sliced mid-file (likely truncated JSON)
    const startIdx = offset > 0 ? 1 : 0;

    // Parse all entries
    const entries: JsonlEntry[] = [];
    for (let i = startIdx; i < rawLines.length; i++) {
      try {
        entries.push(JSON.parse(rawLines[i]));
      } catch {
        continue;
      }
    }

    // Collect bash_progress fullOutput keyed by parentToolUseID
    const bashOutputs = new Map<string, string>();
    for (const entry of entries) {
      if (
        entry.type === "progress" &&
        entry.data?.type === "bash_progress" &&
        entry.data.fullOutput &&
        entry.parentToolUseID
      ) {
        bashOutputs.set(entry.parentToolUseID, entry.data.fullOutput);
      }
    }

    // Build conversation messages from entries
    // Group assistant entries by message.id to reconstruct full turns
    const conversationMessages: PreviewMessage[] = [];
    const assistantTurns = new Map<
      string,
      { text: string; toolNames: string[]; toolUseIds: string[]; toolInputs: ToolInput[]; thinking: string; index: number }
    >();

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg) continue;

      if (msg.role === "user") {
        // Flush any pending assistant turn
        flushAssistantTurns(assistantTurns, conversationMessages, bashOutputs);

        const content = msg.content;
        if (typeof content === "string" && content.trim()) {
          // Direct user prompt
          conversationMessages.push({ role: "user", text: content.trim() });
        } else if (Array.isArray(content)) {
          // User messages with tool results — only extract actual user text
          // Tool results are skipped (bash output is already on the tool-use message)
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              conversationMessages.push({ role: "user", text: block.text.trim() });
            }
          }
        }
      } else if (msg.role === "assistant") {
        const msgId = msg.id || `anon-${entries.indexOf(entry)}`;
        let turn = assistantTurns.get(msgId);
        if (!turn) {
          turn = { text: "", toolNames: [], toolUseIds: [], toolInputs: [], thinking: "", index: conversationMessages.length };
          assistantTurns.set(msgId, turn);
        }

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              turn.text += (turn.text ? "\n\n" : "") + block.text;
            } else if (block.type === "thinking" && block.thinking) {
              turn.thinking = block.thinking;
            } else if (block.type === "tool_use" && block.name) {
              turn.toolNames.push(block.name);
              if (block.id) turn.toolUseIds.push(block.id);
              // Extract tool input details for preview
              const input = block.input as Record<string, any> | undefined;
              const toolInput: ToolInput = { name: block.name };
              if (input) {
                // Generic: extract common fields for any tool
                if (typeof input.file_path === "string") toolInput.filePath = input.file_path;
                if (typeof input.command === "string") toolInput.command = input.command;
                if (typeof input.description === "string") toolInput.description = input.description;
                if (typeof input.pattern === "string") toolInput.pattern = input.pattern;

                // Tool-specific fields
                if (block.name === "Edit") {
                  if (typeof input.old_string === "string") toolInput.oldString = input.old_string;
                  if (typeof input.new_string === "string") toolInput.newString = input.new_string;
                } else if (block.name === "Write") {
                  if (typeof input.content === "string") toolInput.content = input.content.slice(0, 500);
                } else if (block.name === "AskUserQuestion" && input.questions?.[0]) {
                  const q = input.questions[0] as any;
                  toolInput.question = {
                    header: q.header || "",
                    text: q.question || "",
                    options: (q.options || []).map((o: any) => ({ label: o.label || "", description: o.description })),
                    multiSelect: q.multiSelect || false,
                  };
                }
              }
              turn.toolInputs.push(toolInput);
            }
          }
        }
      }
    }

    // Flush remaining assistant turn
    flushAssistantTurns(assistantTurns, conversationMessages, bashOutputs);

    // Return last N messages, but always include context:
    // Walk backwards to find the last N user/assistant messages (skip tool-results that are standalone)
    const result: PreviewMessage[] = [];
    let collected = 0;
    for (let i = conversationMessages.length - 1; i >= 0 && collected < messageCount; i--) {
      const m = conversationMessages[i];
      result.unshift(m);
      // Count user and assistant messages toward the limit, not tool-results
      if (m.role === "user" || m.role === "assistant" || m.role === "tool-use") {
        collected++;
      }
    }

    return result;
  } catch {
    return [];
  }
}

// --- Pending tool call detection for Space menu approve flow + preview ---

export interface PendingQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect: boolean;
  toolUseId: string;
}

/** Map one raw `AskUserQuestion` question object into a `PendingQuestion`. */
export function toPendingQuestion(raw: any, toolUseId: string): PendingQuestion {
  return {
    question: raw?.question || "",
    header: raw?.header || "",
    options: (raw?.options || []).map((o: any) => ({
      label: o.label || "",
      description: o.description,
      preview: o.preview,
    })),
    multiSelect: raw?.multiSelect || false,
    toolUseId,
  };
}

export interface PendingToolCall {
  name: string;
  toolUseId: string;
  /** Bash: the command string */
  command?: string;
  /** Bash: intent description */
  description?: string;
  /** file path (Read/Edit/Write/etc.) */
  filePath?: string;
  /** Edit: text being replaced */
  oldString?: string;
  /** Edit: replacement text */
  newString?: string;
  /** Write: file content (truncated to 500 chars) */
  content?: string;
  /** Glob/Grep: search pattern */
  pattern?: string;
  /** AskUserQuestion: the first question (display consumers — preview, status bar). */
  question?: PendingQuestion;
  /** AskUserQuestion: every question in the prompt (a prompt may carry several). */
  questions?: PendingQuestion[];
}

/**
 * Read the last unanswered tool_use from the JSONL.
 * Returns null if all tool calls have been answered or no tool call found.
 */
export async function readPendingToolCall(sessionPath: string): Promise<PendingToolCall | null> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return null;

    const TAIL_SIZE = 16 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const rawLines = chunk.trim().split("\n").filter(Boolean);
    const startIdx = offset > 0 ? 1 : 0;

    // Track the last tool_use block and its index
    let lastToolIndex = -1;
    let lastToolId = "";
    let lastToolCall: PendingToolCall | null = null;

    for (let i = startIdx; i < rawLines.length; i++) {
      try {
        const entry = JSON.parse(rawLines[i]);
        const msg = entry.message;
        if (!msg) continue;

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_use" && block.name && block.id) {
              lastToolIndex = i;
              lastToolId = block.id;
              const input = block.input as Record<string, any> | undefined;
              const call: PendingToolCall = { name: block.name, toolUseId: block.id };

              if (input) {
                // Generic: extract file_path for any tool that has it
                if (typeof input.file_path === "string") call.filePath = input.file_path;
                if (typeof input.command === "string") call.command = input.command;
                if (typeof input.description === "string") call.description = input.description;
                if (typeof input.pattern === "string") call.pattern = input.pattern;

                // Tool-specific fields
                if (block.name === "Edit") {
                  if (typeof input.old_string === "string") call.oldString = input.old_string;
                  if (typeof input.new_string === "string") call.newString = input.new_string;
                } else if (block.name === "Write") {
                  if (typeof input.content === "string") call.content = input.content.slice(0, 500);
                } else if (block.name === "AskUserQuestion" && input.questions?.[0]) {
                  const questions = input.questions.map((q: any) =>
                    toPendingQuestion(q, block.id),
                  );
                  call.questions = questions;
                  call.question = questions[0];
                }
              }

              lastToolCall = call;
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (!lastToolCall || lastToolIndex < 0) return null;

    // Check if already answered
    for (let i = lastToolIndex + 1; i < rawLines.length; i++) {
      try {
        const entry = JSON.parse(rawLines[i]);
        const msg = entry.message;
        if (!msg || msg.role !== "user") continue;

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "tool_result" && block.tool_use_id === lastToolId) {
              return null; // Already answered
            }
          }
        }
      } catch {
        continue;
      }
    }

    return lastToolCall;
  } catch {
    return null;
  }
}

/**
 * Convenience: check if the pending tool call is an AskUserQuestion.
 */
export async function readPendingQuestion(sessionPath: string): Promise<PendingQuestion | null> {
  const call = await readPendingToolCall(sessionPath);
  return call?.question ?? null;
}

function flushAssistantTurns(
  turns: Map<string, { text: string; toolNames: string[]; toolUseIds: string[]; toolInputs: ToolInput[]; thinking: string; index: number }>,
  messages: PreviewMessage[],
  bashOutputs: Map<string, string>,
): void {
  // Sort by insertion index to maintain order
  const sorted = [...turns.values()].sort((a, b) => a.index - b.index);
  for (const turn of sorted) {
    // Add thinking as part of the message if present
    const thinking = turn.thinking
      ? turn.thinking.replace(/\s+/g, " ").trim()
      : undefined;

    if (turn.text) {
      messages.push({
        role: "assistant",
        text: turn.text,
        thinking,
      });
    }

    if (turn.toolNames.length > 0) {
      // Collect bash outputs for tools in this turn
      const outputs: string[] = [];
      for (const id of turn.toolUseIds) {
        const out = bashOutputs.get(id);
        if (out) outputs.push(out);
      }

      messages.push({
        role: "tool-use",
        text: "",
        toolNames: turn.toolNames,
        toolInputs: turn.toolInputs.length > 0 ? turn.toolInputs : undefined,
        bashOutput: outputs.length > 0 ? outputs.join("\n") : undefined,
        thinking: !turn.text ? thinking : undefined, // Only attach thinking to tool-use if no text message was emitted
      });
    }
  }
  turns.clear();
}
