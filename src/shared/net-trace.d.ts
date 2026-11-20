export declare const NET_TRACE_CAP: number;
export declare function fetchFailure(args: {
  url: string;
  method: string;
  startedAt: number;
  now: number;
  error?: { name: string };
  signal?: { reason?: { name?: string } } | null;
  status?: number;
  hidden: boolean;
  foregroundAt: number;
  online: boolean;
}): Record<string, unknown> | null;
export declare function streamGap(args: { downAt: number; now: number; foregroundAt: number }): Record<string, unknown> | null;
export declare function appendCapped<T>(queue: T[], entry: T, cap?: number): T[];
