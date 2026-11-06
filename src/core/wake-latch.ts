/**
 * Lets a polling loop sleep until its next fallback tick OR an external change,
 * whichever comes first — and never lose a change that lands while the loop is
 * busy. `clear()` marks "from here on, changes need another pass" (call it right
 * before the work starts); `wait(ms)` returns at once if a `wake()` has come in
 * since, else after `ms` or the next `wake()`.
 */
export interface WakeLatch {
  wake(): void;
  clear(): void;
  wait(ms: number): Promise<void>;
}

export function wakeLatch(): WakeLatch {
  let pending = false;
  let release: (() => void) | null = null;
  return {
    wake() {
      pending = true;
      release?.();
    },
    clear() {
      pending = false;
    },
    wait(ms) {
      if (pending) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          release = null;
          resolve();
        };
        const timer = setTimeout(done, ms);
        release = done;
      });
    },
  };
}
