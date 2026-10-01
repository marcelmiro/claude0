/**
 * Copy text to the USER's clipboard from wherever Claude0 runs. On macOS that's pbcopy.
 * On a remote host there is no useful local clipboard — instead emit OSC 52, which
 * the attaching terminal (Ghostty over Mosh/SSH) translates into a clipboard write on
 * the user's machine. Requires tmux `set-clipboard on` + `allow-passthrough on` and
 * the terminal allowing clipboard-write; all three are silent no-ops when missing,
 * which is why the sequences are built by a pure, exactly-tested function.
 */
import { openSync, writeSync, closeSync } from "node:fs";

/**
 * mosh-server keeps at most 16 KiB of an OSC string ("52;c;" included) and silently
 * drops the rest, so over mosh it — not tmux's ~100 KB buffer — is the binding hop.
 */
export const MOSH_OSC_STRING_MAX = 16 * 1024;

/** The largest plaintext whose base64 payload fits mosh's OSC string limit. */
export const OSC52_MAX_TEXT_BYTES = Math.floor((MOSH_OSC_STRING_MAX - "52;c;".length) / 4) * 3;

/**
 * The OSC 52 write for `text`, or null when it exceeds the mosh ceiling (a silent
 * partial write would corrupt what lands in the clipboard — refuse instead).
 *
 * Inside tmux the sequence must ride a DCS passthrough envelope: every ESC of the
 * inner sequence is doubled, and the envelope always closes with `ESC \` regardless
 * of the inner terminator.
 */
export function osc52Sequence(text: string, insideTmux: boolean): string | null {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > OSC52_MAX_TEXT_BYTES) return null;
  const inner = `\x1b]52;c;${bytes.toString("base64")}\x07`;
  if (!insideTmux) return inner;
  return `\x1bPtmux;${inner.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

/**
 * Copy via the platform-appropriate route. Resolves true on success, false when the
 * text is too large for OSC 52 or the write failed. Writes to /dev/tty directly —
 * the TUI's render stream (blessed) would buffer/interleave the escape.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }
  const seq = osc52Sequence(text, Boolean(process.env.TMUX));
  if (seq === null) return false;
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, seq);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
