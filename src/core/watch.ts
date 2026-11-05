/**
 * Change-notify primitive over the hook events dir (Impl 2.5).
 *
 * `watchEvents(cb)` debounces `fs.watch(EVENTS_DIR)` PER sessionId and calls
 * `cb(sessionId)` so the SSE bridge pushes a TARGETED update instead of
 * re-discovering everything. Returns an unsubscribe fn.
 *
 * If `EVENTS_DIR` does not exist yet, this is a NO-OP — it returns a noop
 * unsubscribe and does NOT create the dir or throw. The dir appears once
 * `claude0 setup`'s hooks run; the bridge re-wires on its next start.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { EVENTS_DIR } from "./hook-events";

export function watchEvents(
  cb: (sessionId: string) => void,
  debounceMs = 150,
): () => void {
  if (!existsSync(EVENTS_DIR)) return () => {};

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher;
  try {
    watcher = watch(EVENTS_DIR, (_event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return; // ignore non-.jsonl and .tmp
      const sessionId = filename.slice(0, -".jsonl".length);
      if (!sessionId) return;

      const existing = timers.get(sessionId);
      if (existing) clearTimeout(existing);
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          cb(sessionId);
        }, debounceMs),
      );
    });
  } catch {
    return () => {};
  }

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}
