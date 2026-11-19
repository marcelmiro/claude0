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

export function stripImagePrefix(text: string): string;

export function newestTurnAt(turns: { at?: string }[] | undefined): number;

export function landedSends(
  turns:
    | {
        role: string;
        at?: string;
        command?: string;
        bash?: { command: string };
        content?: { type: string; text?: string }[];
      }[]
    | undefined,
): Map<string, number>;
