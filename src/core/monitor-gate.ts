/**
 * Rate gate for `claude0 status`. tmux runs the status-right `#()` job once per attached
 * client, and again on any status redraw in a new second (a window switch, a rename —
 * the monitor's own renames included), so full ticks arrived ~1/s instead of once per
 * status-interval, at ~150ms CPU each. A run within MIN_TICK_GAP_MS of the last full
 * tick reprints that tick's output instead — unless something a tick must react to at
 * once changed since it started: the focused window, a Claude status file (every
 * running/ready/waiting flip, so ⚡ and pushes stay as fast as before), or a ⚡ on the
 * window the present user is looking at (its auto-clear is pending).
 */
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { PATHS } from "./config";
import { ATTENTION_PREFIX } from "./notifications";
import { classifyActivity } from "./presence";
import { NATIVE_STATUS_DIR } from "./session-state";

export const MIN_TICK_GAP_MS = 2_500;
const LAST_TICK = `${PATHS.dir}/last-tick.json`;

interface LastTick {
  ts: number;
  window: string;
  text: string;
}

/** The most recently active tmux client: the one the monitor reads presence and the viewed window from. */
export interface Focus {
  activity: number; // epoch seconds of the client's last keystroke
  window: string; // session:window_index
  windowName: string;
}

/** Record a full tick's output, the focused window it saw, and when it STARTED (atomic: gate runs read it concurrently). */
export function recordTick(window: string, text: string, startedAt: number): void {
  try {
    const tmp = `${LAST_TICK}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ts: startedAt, window, text } satisfies LastTick));
    renameSync(tmp, LAST_TICK);
  } catch {}
}

/** The last full tick's output when nothing it must react to changed since, else null (run a full tick). */
export function recentTickOutput(
  focus: Focus | null,
  now: number = Date.now(),
  nativeDir: string = NATIVE_STATUS_DIR,
): string | null {
  try {
    const t = JSON.parse(readFileSync(LAST_TICK, "utf8")) as LastTick;
    if (typeof t.text !== "string" || !(now - t.ts >= 0 && now - t.ts < MIN_TICK_GAP_MS)) return null;
    if (t.window !== (focus?.window ?? "")) return null;
    if (focus?.windowName.startsWith(ATTENTION_PREFIX) && classifyActivity([focus.activity], now) !== "absent") return null;
    for (const f of readdirSync(nativeDir)) {
      if (f.endsWith(".json") && statSync(`${nativeDir}/${f}`).mtimeMs >= t.ts) return null;
    }
    return t.text;
  } catch {
    return null;
  }
}

export function focusedClient(): Focus | null {
  try {
    const out = Bun.spawnSync(
      ["tmux", "list-clients", "-F", "#{client_activity} #{session_name}:#{window_index} #{window_name}"],
      { stdin: "ignore", stderr: "ignore" },
    ).stdout.toString();
    return parseFocus(out);
  } catch {
    return null;
  }
}

/** `list-clients` lines → the most recently active client. window_name is the free-text tail. */
export function parseFocus(out: string): Focus | null {
  const top = out
    .split("\n")
    .filter(Boolean)
    .sort((a, b) => Number(b.split(" ")[0]) - Number(a.split(" ")[0]))[0];
  if (!top) return null;
  const s1 = top.indexOf(" ");
  const s2 = top.indexOf(" ", s1 + 1);
  if (s1 < 0 || s2 < 0) return null;
  return { activity: Number(top.slice(0, s1)), window: top.slice(s1 + 1, s2), windowName: top.slice(s2 + 1) };
}
