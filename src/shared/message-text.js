// The text of a message as it reaches Claude's pane, shared by the bridge (which builds it)
// and portkey (which reads it back out of the transcript).

// A non-image attachment rides in the message as a `[File: <path>]` token, mirroring the
// `[Image #N]` marker Claude writes for a pasted image. A bare path would do for Claude, but
// a message that starts with one ("/home/…") is read by Claude Code as a slash command.
const fileRef = (path) => `[File: ${path}]`;

/** The message text with each attached file's reference in front of it. */
export function withFileRefs(text, paths) {
  return [...paths.map(fileRef), text].filter((s) => s.trim()).join(" ");
}

// Leading `[Image #N]` / `[File: …]` markers: stripped so an optimistic send matches its
// landed turn (the bubble carries only the caption), and so history shows the caption.
const ATTACHMENT_PREFIX = /^(?:\[(?:Image #\d+|File: [^\]\n]+)\]\s*)+/;
export const stripAttachmentPrefix = (t) => String(t || "").replace(ATTACHMENT_PREFIX, "");

/** File names (the upload path's last segment) of the `[File: …]` refs leading a message. */
export function attachedFileNames(t) {
  const prefix = String(t || "").match(ATTACHMENT_PREFIX);
  if (!prefix) return [];
  return [...prefix[0].matchAll(/\[File: ([^\]\n]+)\]/g)].map((m) => m[1].split("/").pop());
}

/**
 * The draft with `skill` (e.g. "/compact") put in front: a slash command only runs from the
 * start of a message, so whatever is drafted becomes its arguments. A leading command already
 * there is replaced, so picking twice never stacks two.
 */
export function withSkill(text, skill) {
  return `${skill} ${String(text || "").replace(/^\/\S+\s*/, "")}`;
}
