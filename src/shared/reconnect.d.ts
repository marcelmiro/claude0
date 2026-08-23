export declare const BURST_WINDOW_MS: number;
export declare function burstAction(args: {
  burstStartedAt: number;
  lastOpenAt: number;
  hidden: boolean;
  now: number;
}): "retry" | "stop";
export declare function withTimeout(opts: RequestInit | undefined, ms: number): RequestInit;
