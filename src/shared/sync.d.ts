export function applyTranscriptEvent(
  held: { turns?: unknown[] } | null,
  ev: { kind: string; payload: Record<string, unknown>; fromIndex?: number; newTurns?: unknown[] },
): { data: Record<string, unknown> } | { needsFetch: true };

export function overlayResolved(
  overlay: { status: "running" | "ready"; until: number },
  serverStatus: string,
  now: number,
): boolean;

export function displaySection(section: string, status: string, pendingScripts: number | undefined): string;
