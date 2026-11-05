/**
 * Streaming JSONL reads for Claude Code transcripts, plus the pending tool-call and
 * AskUserQuestion shapes the hook log and the bridge share.
 */

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
