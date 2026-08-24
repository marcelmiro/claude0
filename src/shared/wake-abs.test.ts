import { describe, expect, test } from "bun:test";
import { formatWakeAbs } from "./wake-abs";

// Timestamps built from local components — the formatter's day math is local-calendar.
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("formatWakeAbs", () => {
  const now = at(2026, 9, 22, 14, 30); // Tue Sep 22

  test("same local day → time only, minutes dropped on the hour", () => {
    expect(formatWakeAbs(at(2026, 9, 22, 21), now)).toBe("9PM");
    expect(formatWakeAbs(at(2026, 9, 22, 22, 32), now)).toBe("10:32PM");
  });

  test("noon and midnight render as 12, not 0", () => {
    expect(formatWakeAbs(at(2026, 9, 22, 12), now)).toBe("12PM");
    expect(formatWakeAbs(at(2026, 9, 22, 0, 5), now)).toBe("12:05AM");
  });

  test("under 7 days → weekday + time", () => {
    expect(formatWakeAbs(at(2026, 9, 23, 8), now)).toBe("Wed 8AM");
    expect(formatWakeAbs(at(2026, 9, 28, 8), now)).toBe("Mon 8AM"); // 6 days out
  });

  test("7+ days → dd/MM + time", () => {
    expect(formatWakeAbs(at(2026, 9, 29, 8), now)).toBe("29/09 8AM"); // exactly 7
    expect(formatWakeAbs(at(2026, 10, 26, 9), now)).toBe("26/10 9AM");
  });

  test("midnight crossing: a short wake on the next calendar day shows the weekday", () => {
    const lateNow = at(2026, 9, 22, 23, 50);
    expect(formatWakeAbs(at(2026, 9, 23, 0, 30), lateNow)).toBe("Wed 12:30AM");
  });
});
