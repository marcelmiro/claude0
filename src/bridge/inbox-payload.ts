/**
 * Inbox section composition for the /sessions payload (ADR 0013). Pure — the
 * store side (composeSessions → deriveSections) is the ONLY section brain; the
 * bridge never re-derives lifecycle from its own discovery. Row detail stays
 * bridge-side: this module just orders session ids and attaches the per-row
 * inbox meta the phone renders, so the sidebar and the phone can't disagree
 * about what section a session is in.
 */
import {
  deriveSections,
  effectiveSince,
  isWoken,
  type InboxSession,
  type Section,
} from "../core/inbox-model";

export interface InboxRowMeta {
  section: Section;
  /**
   * The age the row displays: effectiveSince, archivedAt for done rows, and
   * the script handover for script-waiting running rows — the same anchor the
   * sidebar ages those rows from, so the two surfaces show the same number.
   */
  since: number;
  /** Wake timestamp — snoozed-and-not-yet-due rows only. */
  wakeAt?: number;
  /** Block note — blocked rows only (may be empty). */
  note?: string;
  /** A due snooze not yet auto-resumed — renders in Needs You with the ☾ mark. */
  woken?: boolean;
}

import type { Session } from "../types";

/** What the bridge's own discovery knows about a session id this pass. */
export interface DiscoverySeen {
  status: Session["status"];
  live: boolean;
  /** Pending approval/question or unread ⚡ — files a newborn under Needs You. */
  needsYou: boolean;
  /**
   * Stable age anchor for a newborn row (the session's last turn). Must not
   * change across recomputes: a fresh `now` re-stamp makes the payload differ
   * every pass, and the change-broadcast → refetch cycle then self-sustains
   * for as long as a newborn exists (permanently, when the daemon is down).
   */
  since?: number;
}

function metaOf(s: InboxSession, section: Section, now: number): InboxRowMeta {
  const m: InboxRowMeta = {
    section,
    since:
      section === "done"
        ? (s.archivedAt ?? s.since)
        : section === "running" && s.scriptSince
          ? s.scriptSince
          : effectiveSince(s, now),
  };
  if (s.disposition?.kind === "snoozed" && s.disposition.until > now) m.wakeAt = s.disposition.until;
  if (s.disposition?.kind === "blocked") m.note = s.disposition.note;
  if (isWoken(s, now)) m.woken = true;
  return m;
}

export interface InboxRow {
  id: string;
  meta: InboxRowMeta;
  /** The store's snapshot row — absent for discovery-only newborns. */
  snapshot?: InboxSession;
}

/**
 * Order the inbox rows for the payload: sections in Needs You → Running →
 * Parked → Recently done order (deriveSections owns the within-section sort),
 * then discovery-only newborns (born since the daemon's last snapshot tick)
 * appended after the sectioned rows WITHIN their section — mapped directly
 * from their status (running → Running, live prompt-sitters → Needs You),
 * never through a faked InboxSession. A discovery row that is neither live nor
 * flagged pending/unread (a plain 24h-window archived row) is History's
 * business, not the inbox's.
 */
export function orderInboxRows(
  composed: InboxSession[],
  discovery: Map<string, DiscoverySeen>,
  now: number,
): InboxRow[] {
  const sections = deriveSections(composed, now);
  const inInbox = new Set(composed.map((s) => s.id));
  type Newborn = { id: string; since: number };
  const newborn: { "needs-you": Newborn[]; running: Newborn[] } = { "needs-you": [], running: [] };
  for (const [id, d] of discovery) {
    if (inInbox.has(id)) continue;
    const born = { id, since: d.since ?? now };
    if (d.live && d.status === "running") newborn.running.push(born);
    else if ((d.live && (d.status === "waiting" || d.status === "ready")) || d.needsYou) {
      newborn["needs-you"].push(born);
    }
  }
  const out: InboxRow[] = [];
  const pushSection = (list: InboxSession[], section: Section, extras: Newborn[] = []) => {
    for (const s of list) out.push({ id: s.id, meta: metaOf(s, section, now), snapshot: s });
    for (const b of extras) out.push({ id: b.id, meta: { section, since: b.since } });
  };
  pushSection(sections.needsYou, "needs-you", newborn["needs-you"]);
  pushSection(sections.running, "running", newborn.running);
  pushSection(sections.parked, "parked");
  pushSection(sections.done, "done");
  return out;
}
