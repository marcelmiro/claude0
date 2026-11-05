/**
 * `claude0 preview <windowId>` — the read-only transcript viewer the sidebar
 * opens in a tmux popup (docs/preview.md). It reads the result list the daemon
 * wrote, renders one transcript at a time, and talks back over the sidebar
 * socket: `preview-cursor` moves the sidebar's highlight as J/K flip results,
 * `preview-open` hands the open to the daemon (search's Enter path) and exits.
 */
import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { PATHS } from "../core/config";
import { forgetTranscripts, getTranscript } from "../core/session-api";
import { resolveTranscriptPaths } from "../core/last-turn";
import type { TranscriptTurn } from "../types";
import { parseInput } from "../sidebar/input";
import { C, fg } from "../sidebar/ansi";
import { paintLine, plain, renderTranscript, type Doc, type Highlight } from "./render";

/** What the daemon hands the viewer: the rows J/K flip through and where to start. */
export interface PreviewFile {
  /** session ids, in the order the sidebar lists them */
  ids: string[];
  index: number;
  /** seeds find — the search query, or "" from the inbox */
  query: string;
}

export const previewPath = (windowId: string) => `${PATHS.dir}/preview/${windowId}.json`;
const LOG = `${PATHS.dir}/preview.log`;
const SOCK = `${PATHS.dir}/sidebar.sock`;
/** Wrap width: past ~100 columns prose stops reading as lines. */
const MAX_TEXT = 100;
/** Popup width that fits MAX_TEXT: border 2 + left margin 2 + gap 1 + scrollbar 1. */
const POPUP_WIDTH = MAX_TEXT + 6;

/**
 * `tmux display-popup` position and size: wide enough for the text and no wider,
 * 85% of the height, centred over the work area right of the sidebar. A work area
 * under 60 columns gets a centred 90% popup instead.
 */
export function popupGeometry(o: { sidebar: number; width: number; height: number; statusLines: number; statusTop: boolean }): string[] {
  const left = o.sidebar + 1; // first column past the sidebar's pane border
  const areaW = o.width - left;
  const areaH = o.height - o.statusLines;
  if (areaW < 60) return ["-x", "C", "-y", "C", "-w", "90%", "-h", "90%"];
  const w = Math.min(areaW - 4, POPUP_WIDTH);
  const h = Math.max(10, Math.round(areaH * 0.85));
  const x = left + Math.floor((areaW - w) / 2);
  const top = (o.statusTop ? o.statusLines : 0) + Math.floor((areaH - h) / 2);
  // -y names the popup's BOTTOM row: tmux subtracts the height from it
  return ["-x", String(x), "-y", String(top + h), "-w", String(w), "-h", String(h)];
}
/** Neighbours bigger than this load on demand — a 100MB transcript costs ~570MB RSS to parse. */
const PREFETCH_MAX_BYTES = 30 * 1024 * 1024;

interface Loaded {
  turns: TranscriptTurn[];
  cwd?: string;
  lastPromptAt?: number;
  doc?: { width: number; doc: Doc };
}

export interface Match {
  line: number;
  from: number;
  to: number;
  word: string;
}

function log(msg: string): void {
  try {
    if (statSync(LOG).size > 1024 * 1024) truncateSync(LOG, 0);
  } catch {}
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

/** One command per connection — the renderer reads only a connection's first line. */
function send(line: string): Promise<void> {
  return new Promise<void>((resolve) => {
    Bun.connect({
      unix: SOCK,
      socket: {
        open(s) {
          s.write(`${line}\n`);
          s.flush();
          setTimeout(() => {
            s.end();
            resolve();
          }, 30);
        },
        data() {},
        error: () => resolve(),
        close: () => resolve(),
      },
    }).catch(() => resolve());
  });
}

async function transcriptBytes(id: string): Promise<number> {
  let total = 0;
  for (const p of await resolveTranscriptPaths(id)) {
    try {
      total += statSync(p).size;
    } catch {}
  }
  return total;
}

/** Find words: every whitespace-separated term; 1-char terms only when alone. */
export function findWords(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.filter((w) => w.length > 1) : words;
}

export function findMatches(doc: Doc, words: string[]): Match[] {
  const out: Match[] = [];
  if (!words.length) return out;
  doc.lines.forEach((l, line) => {
    const p = plain(l).toLowerCase();
    for (const w of words) {
      for (let i = p.indexOf(w); i !== -1; i = p.indexOf(w, i + w.length)) out.push({ line, from: i, to: i + w.length, word: w });
    }
  });
  return out.sort((a, b) => a.line - b.line || a.from - b.from);
}

/** Where to open: the first match on the earliest line holding the most distinct query words. */
export function bestMatch(matches: Match[]): number {
  const words = new Map<number, Set<string>>();
  for (const m of matches) words.set(m.line, (words.get(m.line) ?? new Set()).add(m.word));
  let best = -1;
  let most = 0;
  matches.forEach((m, i) => {
    const n = words.get(m.line)!.size;
    if (n > most) [best, most] = [i, n];
  });
  return best;
}

export async function runPreview(windowId: string | undefined): Promise<void> {
  if (!windowId) return;
  let file: PreviewFile;
  try {
    file = JSON.parse(readFileSync(previewPath(windowId), "utf8")) as PreviewFile;
  } catch (e) {
    log(`open window=${windowId} unreadable preview file: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const ids = file.ids;
  // a daemon still running older code writes another shape — say so instead of a silent flash
  if (!Array.isArray(ids) || !ids.length) {
    log(`open window=${windowId} no session ids in the preview file (daemon needs a restart?)`);
    return;
  }
  let idx = Math.max(0, Math.min(file.index, ids.length - 1));
  let query = file.query.trim();
  let editing: string | null = null; // the find line being typed
  let top = 0;
  let matches: Match[] = [];
  let cur = -1;
  let status = ""; // "loading…" / "no transcript"

  const cache = new Map<string, Loaded>();
  const pending = new Map<string, Promise<Loaded>>();
  const out = process.stdout;
  const dims = () => ({ w: out.columns || 80, h: out.rows || 24 });
  const textWidth = () => Math.max(20, Math.min(MAX_TEXT, dims().w - 4));
  const viewHeight = () => Math.max(1, dims().h - 1);

  function load(id: string): Promise<Loaded> {
    const hit = cache.get(id);
    if (hit) return Promise.resolve(hit);
    const inflight = pending.get(id);
    if (inflight) return inflight;
    const p = (async () => {
      const t0 = performance.now();
      const tr = await getTranscript(id).catch(() => null);
      forgetTranscripts();
      const loaded: Loaded = {
        turns: tr?.turns ?? [],
        ...(tr?.cwd ? { cwd: tr.cwd } : {}),
        ...(tr?.lastPromptAt ? { lastPromptAt: Date.parse(tr.lastPromptAt) } : {}),
      };
      cache.set(id, loaded);
      pending.delete(id);
      log(`load id=${id.slice(0, 8)} turns=${loaded.turns.length} ms=${Math.round(performance.now() - t0)}`);
      return loaded;
    })();
    pending.set(id, p);
    return p;
  }

  function docOf(l: Loaded): Doc {
    const width = textWidth();
    if (l.doc?.width !== width) {
      l.doc = { width, doc: renderTranscript(l.turns, { width, cwd: l.cwd, lastPromptAt: l.lastPromptAt, now: Date.now() }) };
    }
    return l.doc.doc;
  }

  const current = (): Loaded | undefined => cache.get(ids[idx]!);
  const maxTop = (doc: Doc) => Math.max(0, doc.lines.length - viewHeight());
  const clampTop = (doc: Doc) => {
    top = Math.max(0, Math.min(top, maxTop(doc)));
  };
  const reveal = (doc: Doc, line: number) => {
    const h = viewHeight();
    if (line < top || line >= top + h) top = line - Math.floor(h / 3);
    clampTop(doc);
  };

  /** Recompute matches for the current doc; `seed` places the view at the best one (else the end). */
  function refind(seed: boolean): void {
    const l = current();
    if (!l) return;
    const doc = docOf(l);
    const words = findWords(query);
    matches = findMatches(doc, words);
    if (seed) {
      cur = bestMatch(matches);
      if (cur >= 0) {
        top = matches[cur]!.line - Math.floor(viewHeight() / 3);
        clampTop(doc);
      } else top = maxTop(doc);
    } else {
      cur = matches.findIndex((m) => m.line >= top);
      if (cur === -1 && matches.length) cur = 0;
      if (cur >= 0) reveal(doc, matches[cur]!.line);
    }
  }

  function footer(w: number): string {
    if (editing !== null) {
      const right = "↵ find  ⎋ cancel";
      return ` ${fg(C.peach, "/")} ${fg(C.fg, editing)}${fg(C.peach, "▏")}${" ".repeat(Math.max(1, w - 5 - Bun.stringWidth(editing) - right.length))}${fg(C.dim, right)}`;
    }
    // [key, label]; while find is active its result rides on the n/N hint, which stays
    // at any width — "no matches" is the only sign a find came up empty
    const find: [string, string][] = !query ? [] : matches.length ? [["n/N", `match ${cur + 1} of ${matches.length}`]] : [["", "no matches"]];
    const always: [string, string][] = [["⎋", query ? "clear" : "close"], ["↵", "open"], ["J/K", "result"], ...find];
    const optional: [string, string][] = [["j/k", "^d/^u"], ["{/}", "prompt"], ["/", "find"]];
    let hints = [...always, ...optional];
    const text = () => hints.map(([k, l]) => (k ? `${k} ${l}` : l)).join("  ");
    while (Bun.stringWidth(text()) > w - 2 && hints.length > always.length) hints = hints.slice(0, -1);
    return ` ${hints.map(([k, l]) => (k ? `${fg(C.muted, k)} ${fg(C.dim, l)}` : fg(C.dim, l))).join("  ")}`;
  }

  function paint(): void {
    const { w, h } = dims();
    const view = viewHeight();
    const tw = textWidth();
    const l = current();
    const doc = l ? docOf(l) : null;
    let frame = "\x1b[?2026h\x1b[?25l";
    const lines = doc?.lines ?? [];
    const scroll = doc && lines.length > view;
    const thumbH = scroll ? Math.max(1, Math.round((view * view) / lines.length)) : 0;
    const thumbTop = scroll ? Math.round(((view - thumbH) * top) / Math.max(1, lines.length - view)) : 0;
    for (let r = 0; r < view; r++) {
      const i = top + r;
      let row: string;
      if (!doc) row = r === 0 ? `  ${fg(C.dim, status || "loading…")}` : "";
      else if (!lines.length) row = r === 0 ? `  ${fg(C.dim, "no transcript")}` : "";
      else if (i < lines.length) {
        const hl: Highlight[] = [];
        matches.forEach((m, k) => {
          if (m.line === i) hl.push({ from: m.from, to: m.to, current: k === cur });
        });
        row = `  ${paintLine(lines[i]!, tw, hl)}`;
      } else row = "";
      const bar = scroll ? (r >= thumbTop && r < thumbTop + thumbH ? fg(C.muted, "┃") : fg("#303030", "│")) : " ";
      frame += `\x1b[${r + 1};1H\x1b[0m\x1b[2K${row}\x1b[0m\x1b[${r + 1};${w}H${bar}`;
    }
    frame += `\x1b[${h};1H\x1b[0m\x1b[2K${footer(w)}\x1b[0m\x1b[?2026l`;
    out.write(frame);
  }

  function evict(): void {
    const keep = new Set([idx - 1, idx, idx + 1].filter((i) => i >= 0 && i < ids.length).map((i) => ids[i]!));
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
  }

  async function prefetch(): Promise<void> {
    for (const i of [idx + 1, idx - 1]) {
      const id = ids[i];
      if (!id || cache.has(id) || pending.has(id)) continue;
      if ((await transcriptBytes(id)) > PREFETCH_MAX_BYTES) continue;
      await load(id);
    }
  }

  async function show(seed: boolean): Promise<void> {
    const id = ids[idx]!;
    const t0 = performance.now();
    const warm = cache.has(id);
    if (!warm) {
      status = "loading…";
      paint();
    }
    await load(id);
    if (ids[idx] !== id) return; // flipped again while loading
    status = "";
    refind(seed);
    paint();
    log(`show id=${id.slice(0, 8)} ${warm ? "warm" : "cold"} ms=${Math.round(performance.now() - t0)}`);
    evict();
    setTimeout(() => void prefetch(), 0);
  }

  function scrollBy(n: number): void {
    const l = current();
    if (!l) return;
    top += n;
    clampTop(docOf(l));
    paint();
  }

  function jumpPrompt(dir: 1 | -1): void {
    const l = current();
    if (!l) return;
    const doc = docOf(l);
    const stops = dir === 1 ? doc.prompts.filter((p) => p > top) : doc.prompts.filter((p) => p < top).reverse();
    if (stops.length) {
      top = stops[0]!;
      clampTop(doc);
      paint();
    }
  }

  async function flip(dir: 1 | -1): Promise<void> {
    const next = idx + dir;
    if (next < 0 || next >= ids.length) return;
    idx = next;
    void send(`preview-cursor ${windowId} ${ids[idx]!}`);
    await show(true);
  }

  let closing = false;
  function close(code = 0): void {
    if (closing) return;
    closing = true;
    out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
    process.exit(code);
  }

  async function onKey(ev: { name: string; ch?: string; shift?: boolean; ctrl?: boolean }): Promise<void> {
    if (editing !== null) {
      if (ev.name === "escape" || (ev.ctrl && ev.name === "c")) editing = null;
      else if (ev.name === "enter") {
        query = editing.trim();
        editing = null;
        refind(false);
      } else if (ev.name === "backspace") editing = editing.slice(0, -1);
      else if (ev.ctrl && ev.name === "u") editing = "";
      else if (ev.ctrl && ev.name === "w") editing = editing.replace(/\S+\s*$/, "");
      else if (ev.ch && !ev.ctrl && ev.ch.length === 1 && ev.ch >= " ") editing += ev.ch;
      paint();
      return;
    }
    const half = Math.max(1, Math.floor(viewHeight() / 2));
    if (ev.ctrl && ev.name === "c") close();
    else if (ev.name === "escape") {
      if (query) {
        query = "";
        matches = [];
        cur = -1;
        paint();
      } else close();
    } else if (ev.name === "q") close();
    else if (ev.name === "enter") {
      await send(`preview-open ${windowId} ${ids[idx]!}`);
      close();
    } else if (ev.name === "j" && ev.shift) await flip(1);
    else if (ev.name === "k" && ev.shift) await flip(-1);
    else if (ev.name === "j" || ev.name === "down") scrollBy(1);
    else if (ev.name === "k" || ev.name === "up") scrollBy(-1);
    else if (ev.ctrl && ev.name === "d") scrollBy(half);
    else if (ev.ctrl && ev.name === "u") scrollBy(-half);
    else if (ev.name === "pagedown") scrollBy(viewHeight() - 1);
    else if (ev.name === "pageup") scrollBy(-(viewHeight() - 1));
    else if (ev.ch === "}") jumpPrompt(1);
    else if (ev.ch === "{") jumpPrompt(-1);
    else if (ev.ch === "/") {
      editing = "";
      paint();
    } else if (ev.name === "n" && query && matches.length) {
      cur = (cur + (ev.shift ? matches.length - 1 : 1)) % matches.length;
      const l = current();
      if (l) reveal(docOf(l), matches[cur]!.line);
      paint();
    }
  }

  process.stdin.setRawMode?.(true);
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  out.on("resize", () => {
    const l = current();
    if (!l) return paint();
    // keep the same content line near the top across a re-wrap
    const before = docOf(l).lines.length;
    const ratio = before ? top / before : 0;
    l.doc = undefined;
    const doc = docOf(l);
    top = Math.round(ratio * doc.lines.length);
    clampTop(doc);
    matches = findMatches(doc, findWords(query));
    cur = Math.min(cur, matches.length - 1);
    paint();
  });
  process.stdin.on("data", (chunk: Buffer) => {
    for (const ev of parseInput(chunk.toString())) {
      if (ev.type === "key") void onKey(ev);
      else if (ev.type === "wheel") scrollBy(ev.dir * 3);
    }
  });
  process.on("SIGHUP", () => close());
  process.on("SIGTERM", () => close());
  await show(true);
}

