// Client-side apply logic for the bridge's versioned state push (see
// src/bridge/stream.ts for the wire protocol). Served unbuilt as /sync.js and
// covered by shared/sync.test.ts — keep it dependency-free and side-effect-free.

/**
 * Apply one `transcript` stream event over the transcript object the client
 * holds. Returns `{ data }` with the complete new transcript, or
 * `{ needsFetch: true }` when an append can't be applied (nothing held, or the
 * held turn list is shorter than the append's base) — the caller falls back to
 * a full GET. A snapshot always replaces wholesale; an append rebuilds
 * `turns` as `held[0..fromIndex) + newTurns` and takes every OTHER field from
 * the event's payload (the server ships the full non-turn state on every push —
 * an omitted field means cleared).
 */
export function applyTranscriptEvent(held, ev) {
  if (ev.kind === "snapshot") return { data: ev.payload };
  if (ev.kind !== "append" || typeof ev.fromIndex !== "number") return { needsFetch: true };
  const base = held && Array.isArray(held.turns) ? held.turns : [];
  // fromIndex 0 rebuilds from nothing — valid even with no held copy.
  if (ev.fromIndex > base.length) return { needsFetch: true };
  return {
    data: { ...ev.payload, turns: base.slice(0, ev.fromIndex).concat(ev.newTurns || []) },
  };
}

/**
 * Whether a client-side status overlay (optimistic `running` after a send /
 * approve, optimistic `ready` after an interrupt) is resolved and should be
 * dropped, given the server's current status for that session. Overlays retire
 * on CONFIRMATION or EXPIRY, never on contradiction — a snapshot computed just
 * before the action landed would otherwise clobber the overlay backwards
 * (ready→running→ready flicker).
 */
export function overlayResolved(overlay, serverStatus, now) {
  if (now > overlay.until) return true;
  if (overlay.status === "running") return serverStatus === "running" || serverStatus === "waiting";
  if (overlay.status === "ready") return serverStatus !== "running";
  return true;
}

/**
 * Which inbox section a row RENDERS in, given the server's section and the
 * row's effective status (status overlays already applied). The two server
 * facts can disagree: `status` is the bridge's live pane capture, `section`
 * derives from the daemon's snapshot (a 3s tick behind, plus push latency) —
 * so between a send and the snapshot catching up, a genuinely-running session
 * still carries section "needs-you". The fresher fact wins for display only;
 * the store stays the section brain for everything authored (parked/done are
 * never rerouted). Script-waiters (turn over, background script live) keep
 * their Running placement — that contradiction is deliberate (the ⏳ mark).
 */
export function displaySection(section, status, pendingScripts) {
  if (section === "needs-you" && status === "running") return "running";
  if (section === "running" && (status === "ready" || status === "waiting") && !pendingScripts) return "needs-you";
  return section;
}
