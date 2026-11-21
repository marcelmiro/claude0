/**
 * Claude Code (seen in 2.1.330) records a long paste in a user prompt wrapped as
 * `\n\n<pasted_content id="07a9">\n…\n</pasted_content id="07a9">\n`. Portkey's sends go
 * through tmux paste, so a long phone message lands wrapped. Every reader that shows or
 * matches prompt text unwraps it, or the phone's optimistic bubble never matches the
 * landed turn and stays pending forever.
 */
const PASTED = /\n*<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">\n*/g;

export function unwrapPastedContent(text: string): string {
  if (!text.includes("<pasted_content")) return text;
  return text.replace(PASTED, "\n\n$2\n\n").trim();
}
