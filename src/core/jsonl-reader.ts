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
 * byte offset for incremental readers that already consumed the file up to there; `end`
 * stops the read at a byte offset (the file as it stood at an earlier stat).
 */
export async function* jsonlLines(path: string, start = 0, end?: number): AsyncGenerator<string> {
  const file = Bun.file(path);
  const reader = (start || end !== undefined ? file.slice(start, end) : file).stream().getReader();
  const decoder = new TextDecoder();
  // The unfinished line's pieces, joined once at its newline: appending each chunk to one
  // carry string and re-splitting it re-copies the whole line per chunk, and a pasted image
  // makes a line tens of MB (a 127MB transcript peaked at ~880MB RSS that way).
  let pieces: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      let from = 0;
      for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", from)) {
        pieces.push(text.slice(from, nl));
        yield pieces.join("");
        pieces = [];
        from = nl + 1;
      }
      if (from < text.length) pieces.push(text.slice(from));
    }
    pieces.push(decoder.decode());
    const last = pieces.join("");
    if (last) yield last;
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
