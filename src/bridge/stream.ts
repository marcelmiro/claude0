/**
 * SSE stream layer — versioned state push (the protocol that replaced the
 * `session-changed` doorbell + client refetch).
 *
 * Every event is `data: {"type", "seq", "computedAt", ...}`. `seq` is ONE
 * per-connection monotonic counter shared across event types (it resets on
 * reconnect — clients compare only within a connection), so frames are
 * serialized per connection: a shared payload JSON is spliced into each
 * connection's envelope rather than pre-encoding one frame for all.
 *
 * Event vocabulary:
 * - `sessions`   — the full `/sessions` payload, pushed on connect and whenever
 *                  the recomputed payload differs from the last pushed one.
 * - `transcript` — for a device's ONE subscribed session: `kind:"snapshot"`
 *                  (full payload; on subscribe — unless the device declared it
 *                  already holds the current rev — and on any non-extension change:
 *                  rewind, branch flip, compaction) or `kind:"append"`
 *                  (`fromIndex` + `newTurns`; the previously-pushed turn list is
 *                  a prefix, allowing the last turn to have grown mid-stream).
 *                  The non-turn fields (approval, questions, statusline, usage,
 *                  queuedPending, …) ride EVERY transcript event in `payload` —
 *                  an omitted field means cleared, as explicit protocol.
 *
 * This module owns the connection registry, per-device subscription + delta
 * state, and the append-vs-snapshot decision (`deltaTurns`, pure + tested).
 * All IO (composing payloads, fs watchers, consumer markers) stays in server.ts.
 */

type Controller = ReadableStreamDefaultController;

type Conn = { deviceId?: string; seq: number };

/**
 * Per-device transcript subscription + what was last pushed to it. `heldRev` is the
 * file revision the device declared it already holds when subscribing: the first push
 * skips the turns when it still matches, consumed by that push.
 */
type Sub = { sessionId: string; lastKeys: string[] | null; heldRev: string | null };

const conns = new Map<Controller, Conn>();
const subs = new Map<string, Sub>();
// When a device last had a live connection — subscriptions are pruned (server.ts
// heartbeat) only after a grace period, so an iOS socket drop + quick foreground
// doesn't tear down and rebuild the watcher.
const lastSeen = new Map<string, number>();

const encoder = new TextEncoder();

export function addClient(c: Controller, deviceId?: string): void {
  conns.set(c, { deviceId, seq: 0 });
  if (deviceId) lastSeen.set(deviceId, Date.now());
}

/** Remove a connection; returns the number of connections remaining. */
export function removeClient(c: Controller): number {
  const conn = conns.get(c);
  if (conn?.deviceId) lastSeen.set(conn.deviceId, Date.now());
  conns.delete(c);
  return conns.size;
}

export function clientCount(): number {
  return conns.size;
}

export function connectedDeviceIds(): Set<string> {
  const out = new Set<string>();
  for (const { deviceId } of conns.values()) if (deviceId) out.add(deviceId);
  return out;
}

/** Raw frame to every connection (the named `ping` heartbeat — carries no seq). */
export function pushRaw(frame: string): void {
  const bytes = encoder.encode(frame);
  for (const c of conns.keys()) {
    try {
      c.enqueue(bytes);
    } catch {
      conns.delete(c); // controller closed between cancel and push
    }
  }
}

/** One event to one connection, stamped with that connection's next seq. */
function sendEnvelope(c: Controller, conn: Conn, type: string, computedAt: number, bodyJson: string): void {
  const seq = ++conn.seq;
  const frame = `data: {"type":"${type}","seq":${seq},"computedAt":${computedAt},${bodyJson}}\n\n`;
  try {
    c.enqueue(encoder.encode(frame));
  } catch {
    conns.delete(c);
  }
}

// The last pushed /sessions payload JSON — pushSessions dedupes against it, so
// call sites can kick a recompute unconditionally and identical results stay quiet.
let lastSessionsJson: string | null = null;

/**
 * Push the full `/sessions` payload. Deduped against the last pushed JSON unless
 * `only` targets a specific (just-connected) controller, which always gets the
 * current snapshot regardless — that snapshot is what replaces the foreground
 * refetches.
 */
export function pushSessions(payload: unknown, computedAt: number, only?: Controller): void {
  const json = JSON.stringify(payload);
  if (only) {
    const conn = conns.get(only);
    if (conn) sendEnvelope(only, conn, "sessions", computedAt, `"payload":${json}`);
    return;
  }
  if (json === lastSessionsJson) return;
  lastSessionsJson = json;
  for (const [c, conn] of conns) sendEnvelope(c, conn, "sessions", computedAt, `"payload":${json}`);
}

/** Set (or clear, with null) a device's one transcript subscription. */
export function subscribe(deviceId: string, sessionId: string | null, heldRev: string | null = null): void {
  if (!sessionId) {
    subs.delete(deviceId);
    lastSeen.delete(deviceId); // re-stamped on the device's next connect — never grows
  } else {
    subs.set(deviceId, { sessionId, lastKeys: null, heldRev });
  }
}

export function hasSubscribers(sessionId: string): boolean {
  for (const sub of subs.values()) if (sub.sessionId === sessionId) return true;
  return false;
}

/** Devices whose subscription went unconnected past `graceMs` — for pruning. */
export function staleSubscriptions(graceMs: number): string[] {
  const connected = connectedDeviceIds();
  const now = Date.now();
  const out: string[] = [];
  for (const deviceId of subs.keys()) {
    if (connected.has(deviceId)) continue;
    if (now - (lastSeen.get(deviceId) ?? 0) > graceMs) out.push(deviceId);
  }
  return out;
}

/** Stable identity for one turn — the prefix check compares these. */
export function turnKey(turn: unknown): string {
  return String(Bun.hash(JSON.stringify(turn)));
}

/**
 * Append-vs-snapshot decision. `append` when the previously-pushed turn list is
 * a prefix of the new one, allowing the LAST pushed turn to have changed
 * (assistant text streaming into it) or been dropped (a one-turn truncation):
 * the client re-applies from `fromIndex`. Anything else — rewind, branch flip,
 * compaction — is a `snapshot`.
 */
export function deltaTurns(
  prevKeys: string[] | null,
  keys: string[],
): { kind: "snapshot" } | { kind: "append"; fromIndex: number } {
  if (!prevKeys) return { kind: "snapshot" };
  let lcp = 0;
  const max = Math.min(prevKeys.length, keys.length);
  while (lcp < max && prevKeys[lcp] === keys[lcp]) lcp++;
  if (lcp >= prevKeys.length - 1) return { kind: "append", fromIndex: lcp };
  return { kind: "snapshot" };
}

/**
 * Push a composed transcript payload to every device subscribed to `sessionId`.
 * Each device gets its own delta against what it last received; the payload's
 * non-turn fields ship whole either way (omitted = cleared). A fresh subscription
 * whose `heldRev` matches the payload's `rev` gets a zero-turn append instead of the
 * snapshot — the device already holds those turns, and on a long session the
 * uncompressed snapshot is ~1.4MB.
 */
export function pushTranscript(
  sessionId: string,
  payload: { turns?: unknown[]; rev?: unknown } & Record<string, unknown>,
): void {
  const turns = Array.isArray(payload.turns) ? payload.turns : [];
  let keys: string[] | null = null; // computed once, only if someone is subscribed
  const computedAt = Date.now();
  for (const [deviceId, sub] of subs) {
    if (sub.sessionId !== sessionId) continue;
    keys ??= turns.map(turnKey);
    const held = sub.lastKeys === null && sub.heldRev !== null && sub.heldRev === payload.rev;
    const delta = held ? { kind: "append" as const, fromIndex: keys.length } : deltaTurns(sub.lastKeys, keys);
    sub.lastKeys = keys;
    sub.heldRev = null;
    let bodyJson: string;
    if (delta.kind === "append") {
      const { turns: _t, ...rest } = payload;
      bodyJson =
        `"sessionId":${JSON.stringify(sessionId)},"kind":"append","fromIndex":${delta.fromIndex},` +
        `"newTurns":${JSON.stringify(turns.slice(delta.fromIndex))},"payload":${JSON.stringify(rest)}`;
    } else {
      bodyJson = `"sessionId":${JSON.stringify(sessionId)},"kind":"snapshot","payload":${JSON.stringify(payload)}`;
    }
    for (const [c, conn] of conns) {
      if (conn.deviceId === deviceId) sendEnvelope(c, conn, "transcript", computedAt, bodyJson);
    }
  }
}
