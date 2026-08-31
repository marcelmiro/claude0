import { extractTicketId } from "./git";
import type { Session } from "../types";

/**
 * Given a set of {id, name}, return a map id→display name where any name shared
 * by more than one item is disambiguated with a ` 2`/` 3`… suffix. Ordering within
 * a colliding group is by `id` ascending — deterministic and independent of caller
 * iteration order or session status, so the same session gets the same suffix on
 * every surface (TUI list, tmux window, phone). Empty names are never suffixed.
 */
export function disambiguateNames(items: Array<{ id: string; name: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { id, name } of items) out.set(id, name); // default: identity
  // Group ids by name, deduping repeated ids — the same session can appear on
  // multiple panes; that is NOT a name collision and must not earn a suffix.
  const byName = new Map<string, string[]>(); // name → distinct sessionIds
  const seenPerName = new Map<string, Set<string>>();
  for (const { id, name } of items) {
    if (!name) continue;
    let seen = seenPerName.get(name);
    if (!seen) { seen = new Set(); seenPerName.set(name, seen); byName.set(name, []); }
    if (seen.has(id)) continue;
    seen.add(id);
    byName.get(name)!.push(id);
  }
  // Reserve every base name FIRST so a ` N` suffix can't collide with a name that
  // already exists literally (e.g. an AI name that happens to be "Foo 2").
  const used = new Set(byName.keys());
  for (const [name, ids] of byName) {
    if (ids.length < 2) continue;
    const ordered = [...ids].sort(); // lowest id keeps the base name
    for (let i = 1; i < ordered.length; i++) {
      let n = 2;
      while (used.has(`${name} ${n}`)) n++;
      const candidate = `${name} ${n}`;
      used.add(candidate);
      out.set(ordered[i], candidate);
    }
  }
  return out;
}

/**
 * Per-repo disambiguation: group by repo, suffix collisions within each group.
 * Every surface (tmux windows, TUI list, phone) feeds the same shape through
 * this, so the same colliding pair gets the same suffixes everywhere.
 */
export function disambiguateByRepo(
  items: Array<{ id: string; name: string; repo: string }>,
): Map<string, string> {
  const byRepo = new Map<string, Array<{ id: string; name: string }>>();
  for (const { id, name, repo } of items) {
    const bucket = byRepo.get(repo);
    if (bucket) bucket.push({ id, name });
    else byRepo.set(repo, [{ id, name }]);
  }
  const out = new Map<string, string>();
  for (const bucket of byRepo.values()) {
    for (const [id, name] of disambiguateNames(bucket)) out.set(id, name);
  }
  return out;
}

/**
 * Build a display label: ticket+name > ticket+suffix > name > branch.
 * `nameOverride` (e.g. a disambiguated name) replaces `session.name` when provided;
 * callers must NOT mutate `session.name` since it feeds drift-source comparison,
 * wizard prefill, and the preview pane.
 */
export function buildSessionLabel(session: Session, nameOverride?: string): string {
  const ticket = extractTicketId(session.branch);
  const name = nameOverride ?? session.name;
  if (ticket && name) return `${ticket} · ${name}`;
  if (ticket) {
    let suffix = session.branch.includes("/") ? session.branch.split("/").pop()! : session.branch;
    suffix = suffix.replace(new RegExp(`^${ticket}-?`, "i"), "");
    return suffix ? `${ticket} · ${suffix}` : ticket;
  }
  if (name) return name;
  return session.branch;
}
