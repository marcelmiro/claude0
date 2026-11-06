import { expect, test } from "bun:test";
import { wakeLatch } from "./wake-latch";

const elapsed = async (p: Promise<void>) => {
  const t = performance.now();
  await p;
  return performance.now() - t;
};

test("waits out the fallback when nothing wakes it", async () => {
  expect(await elapsed(wakeLatch().wait(60))).toBeGreaterThanOrEqual(55);
});

test("a wake during the wait releases it early", async () => {
  const l = wakeLatch();
  setTimeout(() => l.wake(), 10);
  expect(await elapsed(l.wait(1000))).toBeLessThan(200);
});

test("a wake that lands mid-pass (after clear, before wait) is not lost", async () => {
  const l = wakeLatch();
  l.clear();
  l.wake(); // the change arrives while the pass is still running
  expect(await elapsed(l.wait(1000))).toBeLessThan(50);
});

test("clear() forgets wakes the coming pass will already see", async () => {
  const l = wakeLatch();
  l.wake();
  l.clear();
  expect(await elapsed(l.wait(60))).toBeGreaterThanOrEqual(55);
});
