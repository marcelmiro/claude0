/**
 * Input decoder for the sidebar renderer. The pane stub relays raw stdin
 * bytes; this turns them into key / click / wheel / focus events. Only what
 * the sidebar actually binds is decoded — everything else is dropped.
 *
 * Mouse arrives as SGR (1006) sequences; focus in/out as DECSET 1004
 * reports (the renderer enables both by writing the modes to the pane tty).
 */

export type InputEvent =
  | { type: "key"; name: string; ch?: string; shift?: boolean; ctrl?: boolean }
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; dir: 1 | -1 }
  | { type: "focus"; in: boolean };

export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i]!;
    if (c === "\x1b") {
      if (data[i + 1] === "[") {
        // CSI — find the final byte (@ through ~)
        let j = i + 2;
        while (j < data.length && !/[@-~]/.test(data[j]!)) j++;
        const body = data.slice(i + 2, j);
        const final = data[j];
        i = j + 1;
        if (final === "I") events.push({ type: "focus", in: true });
        else if (final === "O") events.push({ type: "focus", in: false });
        // Modified arrows arrive as CSI 1;<mod>A — mod 2 is Shift (xterm encoding),
        // which the renderer maps to section jump (parity with the TUI's S-j/S-k).
        else if (final === "A") events.push({ type: "key", name: "up", ...(body === "1;2" ? { shift: true } : {}) });
        else if (final === "B") events.push({ type: "key", name: "down", ...(body === "1;2" ? { shift: true } : {}) });
        else if ((final === "M" || final === "m") && body.startsWith("<")) {
          const [b, x, y] = body.slice(1).split(";").map(Number);
          if (b !== undefined && x !== undefined && y !== undefined) {
            if (b === 64) events.push({ type: "wheel", dir: -1 });
            else if (b === 65) events.push({ type: "wheel", dir: 1 });
            // button-0 press only — release/drag/motion are noise here
            else if ((b & 0b11000011) === 0 && final === "M") events.push({ type: "click", x, y });
          }
        }
        continue;
      }
      // lone ESC (or ESC + unknown follower): the escape key
      events.push({ type: "key", name: "escape" });
      i++;
      continue;
    }
    i++;
    if (c === "\r" || c === "\n") events.push({ type: "key", name: "enter" });
    else if (c === "\x7f" || c === "\b") events.push({ type: "key", name: "backspace" });
    else if (c === "\x03") events.push({ type: "key", name: "c", ctrl: true });
    else if (c === "\t") events.push({ type: "key", name: "tab" });
    else if (c >= " " && c !== "\x7f") {
      const lower = c.toLowerCase();
      const isLetter = lower !== c.toUpperCase();
      events.push({
        type: "key",
        name: isLetter ? lower : c,
        ch: c,
        shift: isLetter && c !== lower,
      });
    }
  }
  return events;
}
