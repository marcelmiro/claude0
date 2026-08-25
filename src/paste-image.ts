/**
 * `claude0 paste-image` — run by the macOS Service hotkey on a client Mac. Writes
 * the pasteboard PNG to a temp file (the AppleScript recipe Claude Code itself
 * uses for a local paste: osascript's stdout would be the textual «data PNGf…»
 * form, not bytes), ships it to `claude0 receive-image` on the host over the
 * Mac's existing ssh, and reports every refusal as a macOS notification — the
 * user pressed a key and sees nothing otherwise. One log line per run.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "os";
import { PATHS, loadConfig } from "./core/config";
import { decidePaste, lockOwnerAlive, pasteImageLockDir, RECEIVE_COMMAND, SSH_OPTIONS } from "./core/image-paste";

const LOCK_DIR = pasteImageLockDir(process.env.CLAUDE0_HOME ?? homedir());
const PNG_PATH = `${PATHS.dir}/paste-image.png`;
const LOG_PATH = `${PATHS.dir}/paste-image.log`;

function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

async function notify(message: string): Promise<void> {
  const text = message.replace(/[\\"]/g, "\\$&");
  await Bun.$`osascript -e ${`display notification "${text}" with title "claude0"`}`.quiet().nothrow();
}

/**
 * The Service fires once per key-repeat (a held chord ran ~10 times in the probe):
 * a lock dir keeps one run per press. The dir is built under a private name and
 * renamed into place, so it never exists without its pid file — a sibling that
 * looks between mkdir and write would otherwise read "no owner" and reclaim a
 * live lock. A lock whose owner pid is gone was left by a killed run — reclaim it.
 */
function acquireLock(): "acquired" | "held" {
  const staging = `${LOCK_DIR}.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  writeFileSync(`${staging}/pid`, String(process.pid));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      renameSync(staging, LOCK_DIR); // fails while LOCK_DIR exists non-empty
      return "acquired";
    } catch {
      if (lockOwnerAlive(LOCK_DIR)) break;
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  }
  rmSync(staging, { recursive: true, force: true });
  return "held";
}

/** Pasteboard → PNG file; null when the pasteboard holds nothing coercible to PNG. */
async function writePasteboardPng(): Promise<number | null> {
  writeFileSync(PNG_PATH, "", { mode: 0o600 }); // pre-created private; AppleScript fills it in place
  const script = [
    "set png_data to (the clipboard as «class PNGf»)",
    `set fp to open for access POSIX file "${PNG_PATH}" with write permission`,
    "write png_data to fp",
    "close access fp",
  ];
  const result = await Bun.$`osascript ${script.flatMap((line) => ["-e", line])}`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const size = statSync(PNG_PATH).size;
  return size > 0 ? size : null;
}

export async function pasteImage(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("claude0 paste-image runs on the Mac client (the macOS Service hotkey invokes it).");
    process.exitCode = 2;
    return;
  }
  try {
    mkdirSync(PATHS.dir, { recursive: true });
    if (acquireLock() === "held") return; // a sibling run from the same key press is already pasting
  } catch (error) {
    log(`lock failed: ${error instanceof Error ? error.message : String(error)}`);
    await notify("Image paste could not start — see paste-image.log");
    return;
  }
  try {
    const config = await loadConfig().catch(() => null);
    const remoteHost = config?.terminal.remoteHost ?? null;
    const imageBytes = remoteHost ? await writePasteboardPng() : null;
    const decision = decidePaste({ remoteHost, imageBytes });
    if (decision.action === "notify") {
      log(`refused: ${decision.message}`);
      await notify(decision.message);
      return;
    }

    const child = Bun.spawn(["ssh", ...SSH_OPTIONS, decision.host, RECEIVE_COMMAND], {
      stdin: Bun.file(PNG_PATH),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code === 0) {
      log(`pasted ${imageBytes} bytes to ${decision.host}`);
      return;
    }
    // The host prints its one-line refusal on stdout; anything else is ssh's own error.
    const reason = stdout.trim() || stderr.trim().split("\n")[0] || `ssh exited ${code}`;
    log(`failed (${code}): ${reason}`);
    await notify(reason);
  } catch (error) {
    // A missing ssh/osascript or an unreadable pasteboard file must still end in a notification.
    const reason = error instanceof Error ? error.message : String(error);
    log(`crashed: ${reason}`);
    await notify(`Image paste failed: ${reason}`);
  } finally {
    rmSync(PNG_PATH, { force: true });
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
