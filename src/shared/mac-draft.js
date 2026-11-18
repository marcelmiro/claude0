/**
 * Whether sending `message` replaces the draft in the Mac's input box instead of stashing
 * it: the message is the draft, or the draft followed by more once the draft is long
 * enough not to match by accident. Whitespace is ignored — the pane capture flattens the
 * draft's line breaks. Shared by the send pre-flight (`prepareInput` in core/session-api.ts)
 * and portkey's composer note (served unbuilt as /mac-draft.js), so the note never
 * promises something the send won't do.
 */
export function replacesDraft(draft, message) {
  const d = draft.replace(/\s+/g, "");
  const m = message.replace(/\s+/g, "");
  return d.length > 0 && (d === m || (d.length >= 15 && m.startsWith(d)));
}
