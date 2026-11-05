/**
 * Transcript → terminal lines for the preview popup (docs/preview.md). Pure:
 * `getTranscript`'s slimmed turns in, styled lines out, in Claude Code's own
 * grammar (`❯` prompts on a band, `●` replies and tool calls) and portkey's
 * block taxonomy (tool bursts fold, time gaps label, thinking stays hidden).
 */
import { lexer, type Token } from "../bridge/public/vendor/marked.mjs";
import type { TranscriptBlock, TranscriptTurn } from "../types";
import { C } from "../sidebar/ansi";

export interface Span {
  t: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  under?: boolean;
  strike?: boolean;
}

export interface Line {
  spans: Span[];
  /** Full-width background (the prompt band, a code block). */
  band?: string;
  /** Right-aligned label (a time gap). Not searchable. */
  right?: Span;
}

export interface Doc {
  lines: Line[];
  /** First line of every prompt, command and `!` command — the `{`/`}` stops. */
  prompts: number[];
}

export interface RenderOpts {
  width: number;
  cwd?: string;
  /** epoch ms of the session's newest prompt — tool bursts before it fold */
  lastPromptAt?: number;
  now: number;
}

type Style = Omit<Span, "t">;
type Tool = Extract<TranscriptBlock, { type: "tool_use" }>;

const GAP_MS = 5 * 60_000;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const width = (s: string) => Bun.stringWidth(s);

export const plain = (l: Line): string => l.spans.map((s) => s.t).join("");

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.under === !!b.under && !!a.strike === !!b.strike;
}

/**
 * Greedy word wrap of styled text at `max` cells. `\n` is a hard break and
 * keeps the next line's indentation; a soft break drops the spaces it lands
 * on. A word wider than the line splits by grapheme.
 */
export function wrap(spans: Span[], max: number): Span[][] {
  const out: Span[][] = [];
  let line: Span[] = [];
  let used = 0;
  let soft = false;
  const push = (t: string, st: Style) => {
    const last = line[line.length - 1];
    if (last && sameStyle(last, st)) last.t += t;
    else line.push({ ...st, t });
    used += width(t);
  };
  const breakLine = (isSoft: boolean) => {
    const last = line[line.length - 1];
    if (last) last.t = last.t.replace(/\s+$/, "");
    out.push(line.filter((s) => s.t));
    line = [];
    used = 0;
    soft = isSoft;
  };
  for (const sp of spans) {
    const { t, ...st } = sp;
    t.replace(/\t/g, "  ")
      .split("\n")
      .forEach((para, i) => {
        if (i > 0) breakLine(false);
        for (const piece of para.split(/(\s+)/)) {
          if (!piece) continue;
          const pw = width(piece);
          if (/^\s+$/.test(piece)) {
            if (soft) continue;
            if (used + pw > max) breakLine(true);
            else push(piece, st);
            continue;
          }
          if (used + pw <= max) push(piece, st);
          else if (pw <= max) {
            breakLine(true);
            push(piece, st);
          } else {
            for (const { segment } of GRAPHEMES.segment(piece)) {
              if (used + width(segment) > max && used > 0) breakLine(true);
              push(segment, st);
            }
          }
          soft = false;
        }
      });
  }
  breakLine(false);
  return out;
}

/** Truncate styled spans to `max` cells, ending in `…` when cut. */
function clip(spans: Span[], max: number): Span[] {
  const out: Span[] = [];
  let used = 0;
  for (const sp of spans) {
    const w = width(sp.t);
    if (used + w <= max) {
      out.push(sp);
      used += w;
      continue;
    }
    let t = "";
    for (const { segment } of GRAPHEMES.segment(sp.t)) {
      if (used + width(t + segment) > max - 1) break;
      t += segment;
    }
    out.push({ ...sp, t: `${t}…` });
    break;
  }
  return out;
}

/** First-line prefix, the rest indented to match — `● reply`, `❯ prompt`, list bullets. */
function prefixed(prefix: Span[], body: Span[][], band?: string): Line[] {
  const indent = " ".repeat(width(prefix.map((s) => s.t).join("")));
  return body.map((spans, i) => ({ spans: [...(i === 0 ? prefix : [{ t: indent }]), ...spans], ...(band ? { band } : {}) }));
}

function indentLines(lines: Line[], by: Span[], rest = by): Line[] {
  return lines.map((l, i) => ({ ...l, spans: [...(i === 0 ? by : rest), ...l.spans] }));
}

// ── markdown ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]!);

function inline(tokens: Token[] | undefined, st: Style): Span[] {
  const out: Span[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inline(t.tokens, { ...st, bold: true }));
        break;
      case "em":
        out.push(...inline(t.tokens, { ...st, italic: true }));
        break;
      case "del":
        out.push(...inline(t.tokens, { ...st, strike: true }));
        break;
      case "codespan":
        out.push({ ...st, t: unescape(t.text ?? ""), fg: C.mint });
        break;
      case "link":
        out.push(...inline(t.tokens, { ...st, fg: C.peach, under: true }));
        break;
      case "br":
        out.push({ ...st, t: "\n" });
        break;
      case "html":
        out.push({ ...st, t: t.text ?? "", fg: C.muted });
        break;
      default:
        if (t.tokens?.length) out.push(...inline(t.tokens, st));
        else out.push({ ...st, t: unescape(t.text ?? t.raw ?? "") });
    }
  }
  return out;
}

const body = (spans: Span[][]): Line[] => spans.map((s) => ({ spans: s }));

function table(t: Token, max: number): Line[] {
  const head = (t.header ?? []).map((c) => inline(c.tokens, { bold: true }));
  const rows = (t.rows ?? []).map((r) => r.map((c) => inline(c.tokens, {})));
  const all = [head, ...rows];
  const cols = head.length;
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...all.map((r) => width((r[i] ?? []).map((s) => s.t).join("")))));
  const gap = 2;
  if (widths.reduce((a, b) => a + b, 0) + gap * (cols - 1) > max) {
    // too wide to align: one wrapped line per row, cells joined by a dim dot
    return all.flatMap((r) => body(wrap(r.flatMap((c, i) => (i ? [{ t: " · ", fg: C.dim }, ...c] : c)), max)));
  }
  const line = (r: Span[][]): Line => ({
    spans: r.flatMap((c, i) => {
      if (i === cols - 1) return c;
      return [...c, { t: " ".repeat(widths[i]! - width(c.map((s) => s.t).join("")) + gap) }];
    }),
  });
  const rule = { spans: [{ t: widths.map((w) => "─".repeat(w)).join(" ".repeat(gap)), fg: C.dim }] };
  return [line(head), rule, ...rows.map(line)];
}

function blocks(tokens: Token[], max: number): Line[] {
  const out: Line[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1]!.spans.length) out.push({ spans: [] });
  };
  for (const t of tokens) {
    switch (t.type) {
      case "space":
        blank();
        break;
      case "paragraph":
      case "text":
        out.push(...body(wrap(t.tokens?.length ? inline(t.tokens, {}) : [{ t: unescape(t.text ?? "") }], max)));
        break;
      case "heading":
        out.push(...body(wrap(inline(t.tokens, { bold: true }), max)));
        break;
      case "code":
        blank();
        out.push(...body(wrap([{ t: (t.text ?? "").replace(/\n+$/, ""), fg: C.mint }], max - 2)).map((l) => ({ spans: [{ t: " " }, ...l.spans], band: C.surface })));
        blank();
        break;
      case "list": {
        let n = typeof t.start === "number" ? t.start : 1;
        for (const item of t.items ?? []) {
          const marker = t.ordered ? `${n++}. ` : "• ";
          const inner = blocks(item.tokens ?? [], max - width(marker));
          while (inner.length && !inner[inner.length - 1]!.spans.length) inner.pop();
          out.push(...indentLines(inner, [{ t: marker, fg: C.muted }], [{ t: " ".repeat(width(marker)) }]));
        }
        break;
      }
      case "blockquote":
        out.push(...indentLines(blocks(t.tokens ?? [], max - 2), [{ t: "│ ", fg: C.dim }]).map((l) => ({ ...l, spans: l.spans.map((s, i) => (i === 0 ? s : { ...s, fg: s.fg ?? C.muted, italic: true })) })));
        break;
      case "hr":
        out.push({ spans: [{ t: "─".repeat(Math.min(max, 40)), fg: C.dim }] });
        break;
      case "table":
        out.push(...table(t, max));
        break;
      default:
        if (t.text) out.push(...body(wrap([{ t: t.text, fg: C.muted }], max)));
    }
  }
  while (out.length && !out[0]!.spans.length) out.shift();
  while (out.length && !out[out.length - 1]!.spans.length) out.pop();
  return out;
}

export function markdown(text: string, max: number): Line[] {
  try {
    return blocks(lexer(text), max);
  } catch {
    return body(wrap([{ t: text }], max));
  }
}

// ── tools ───────────────────────────────────────────────────────────────

function relPath(p: string, cwd: string | undefined): string {
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  const home = process.env.HOME;
  return home && p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

/** The one argument a tool line shows — portkey's chip label order. */
export function toolArg(b: Tool, cwd?: string): string {
  const input = (b.input ?? {}) as Record<string, string | undefined>;
  const skill = input.skill ? `${input.skill}${input.args ? ` ${input.args}` : ""}` : "";
  const arg =
    input.command ||
    relPath(input.file_path || input.notebook_path || "", cwd) ||
    input.pattern ||
    skill ||
    input.description ||
    input.url ||
    input.query ||
    input.summary ||
    "";
  const first = arg.split("\n")[0]!;
  return first.length < arg.length ? `${first} …` : first;
}

function toolLines(b: Tool, o: RenderOpts): Line[] {
  if (b.qa?.length) {
    return b.qa.flatMap((p) => [
      ...prefixed([{ t: "● ", fg: C.muted }], wrap([{ t: `Asked: ${p.q}`, fg: C.muted }], o.width - 2)),
      ...prefixed([{ t: "  ⎿ ", fg: C.dim }], wrap([{ t: p.a }], o.width - 4)),
    ]);
  }
  const input = (b.input ?? {}) as Record<string, string | undefined>;
  const dot = b.result ? (b.result.ok ? C.mint : C.red) : C.dim;
  const who = [input.subagent_type, input.to && `→ ${input.to}`].filter(Boolean).join(" ");
  const arg = toolArg(b, o.cwd);
  const spans: Span[] = [
    { t: "● ", fg: dot },
    { t: b.name, bold: true },
    ...(who ? [{ t: ` ${who}`, fg: C.muted }] : []),
    ...(arg ? [{ t: ` ${arg}`, fg: C.muted }] : []),
  ];
  const lines: Line[] = [{ spans: clip(spans, o.width) }];
  if (b.result && !b.result.ok && b.result.head) {
    lines.push({ spans: clip([{ t: "  ⎿ ", fg: C.dim }, { t: b.result.head, fg: C.red }], o.width) });
  }
  return lines;
}

/** One line for a run of tool-only turns: portkey's burst tally. */
function burstLine(turns: TranscriptTurn[], max: number): Line {
  const counts = new Map<string, number>();
  const files = new Set<string>();
  let failed = 0;
  for (const t of turns) {
    for (const b of t.content) {
      if (b.type !== "tool_use") continue;
      counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
      if (b.result && !b.result.ok) failed++;
      const input = (b.input ?? {}) as Record<string, string | undefined>;
      const p = input.file_path || input.notebook_path;
      if (p) files.add(p.slice(p.lastIndexOf("/") + 1));
    }
  }
  const total = [...counts.values()].reduce((a, c) => a + c, 0);
  const names = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
  const fl = [...files];
  const fileNote = fl.length ? ` · ${fl.slice(0, 2).join(", ")}${fl.length > 2 ? ` +${fl.length - 2}` : ""}` : "";
  return {
    spans: clip(
      [
        { t: "● ", fg: C.dim },
        { t: `${total} tool calls`, fg: C.muted },
        ...(failed ? [{ t: ` · ${failed} failed`, fg: C.red }] : []),
        { t: ` · ${names}${fileNote}`, fg: C.dim },
      ],
      max,
    ),
  };
}

/** A turn that is nothing but tool calls (an answered question is conversation). */
export function isToolOnly(t: TranscriptTurn): boolean {
  return (
    t.role === "assistant" &&
    !t.compactSummary &&
    !t.command &&
    !t.bash &&
    !t.teammate &&
    t.content.length > 0 &&
    t.content.every((b) => b.type === "tool_use" && !b.qa?.length)
  );
}

// ── turns ───────────────────────────────────────────────────────────────

/** The clock alone today, "Yesterday 13:06", else "24/08 13:06" — portkey's fmtGap. */
export function fmtGap(ms: number, now: number): string {
  const d = new Date(ms);
  const n = new Date(now);
  const two = (x: number) => String(x).padStart(2, "0");
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return time;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${time}`;
}

const MARKER = /^\[.*\]$/s;

function promptLines(text: string, o: RenderOpts, lead: Span = { t: "❯ ", fg: C.muted }): Line[] {
  return prefixed([lead], wrap([{ t: text }], o.width - 2), C.surface);
}

function bashLines(bash: NonNullable<TranscriptTurn["bash"]>, o: RenderOpts): Line[] {
  const lines = promptLines(bash.command, o, { t: "! ", fg: C.peach });
  const output = `${bash.stdout}\n${bash.stderr}`.split("\n").filter((l) => l.trim());
  output.slice(0, 3).forEach((l, i) => lines.push({ spans: clip([{ t: i === 0 ? "  ⎿ " : "    ", fg: C.dim }, { t: l, fg: C.muted }], o.width) }));
  if (output.length > 3) lines.push({ spans: [{ t: `    … +${output.length - 3} lines`, fg: C.dim }] });
  return lines;
}

/** One turn → its items (each item is separated from the next by a blank line). */
function turnItems(t: TranscriptTurn, o: RenderOpts): { lines: Line[]; prompt?: boolean }[] {
  if (t.compactSummary) {
    const label = " compacted ";
    const side = Math.max(2, Math.floor((Math.min(o.width, 60) - label.length) / 2));
    return [{ lines: [{ spans: [{ t: `${"─".repeat(side)}${label}${"─".repeat(side)}`, fg: C.dim }] }] }];
  }
  if (t.command) return [{ lines: promptLines(t.command, o), prompt: true }];
  if (t.bash) return [{ lines: bashLines(t.bash, o), prompt: true }];
  if (t.teammate) {
    return [{ lines: t.teammate.map((m) => ({ spans: clip([{ t: `↳ ${m.id}: ${m.summary || "idle"}`, fg: C.dim }], o.width) })) }];
  }
  if (t.role === "user") {
    const texts = t.content.flatMap((b) => (b.type === "text" ? [b.text] : b.type === "image" ? ["[image]"] : []));
    const text = texts.join("\n\n").trim();
    if (!text) return [];
    if (MARKER.test(text)) return [{ lines: [{ spans: clip([{ t: `⊘ ${text.slice(1, -1)}`, fg: C.dim }], o.width) }] }];
    return [{ lines: promptLines(text, o), prompt: true }];
  }
  const items: { lines: Line[] }[] = [];
  for (const b of t.content) {
    if (b.type === "text" && b.text.trim()) {
      items.push({ lines: prefixed([{ t: "● " }], markdown(b.text, o.width - 2).map((l) => l.spans)) });
    } else if (b.type === "tool_use") items.push({ lines: toolLines(b, o) });
    else if (b.type === "image") items.push({ lines: [{ spans: [{ t: "● [image]", fg: C.dim }] }] });
  }
  return items;
}

export function renderTranscript(turns: TranscriptTurn[], o: RenderOpts): Doc {
  const lines: Line[] = [];
  const prompts: number[] = [];
  const add = (item: Line[], prompt = false) => {
    if (!item.length) return;
    if (lines.length && lines[lines.length - 1]!.right === undefined) lines.push({ spans: [] });
    if (prompt) prompts.push(lines.length);
    lines.push(...item);
  };
  let prevAt: number | null = null;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const at = turn.at ? Date.parse(turn.at) : NaN;
    if (!Number.isNaN(at) && (prevAt === null || at - prevAt > GAP_MS)) {
      if (lines.length) lines.push({ spans: [] });
      lines.push({ spans: [], right: { t: fmtGap(at, o.now), fg: C.dim } });
    }
    if (isToolOnly(turn)) {
      let j = i;
      while (j + 1 < turns.length && isToolOnly(turns[j + 1]!)) j++;
      if (j - i >= 2) {
        // a burst before the newest prompt is history already reported on — it
        // folds; the work since that prompt stays expanded (portkey's rule)
        const lastAt = turns[j]!.at ? Date.parse(turns[j]!.at!) : NaN;
        const stale = o.lastPromptAt !== undefined && !Number.isNaN(lastAt) && lastAt < o.lastPromptAt;
        if (stale) add([burstLine(turns.slice(i, j + 1), o.width)]);
        else for (const t of turns.slice(i, j + 1)) for (const it of turnItems(t, o)) add(it.lines);
        if (!Number.isNaN(lastAt)) prevAt = lastAt;
        i = j;
        continue;
      }
    }
    if (!Number.isNaN(at)) prevAt = at;
    for (const it of turnItems(turn, o)) add(it.lines, it.prompt);
  }
  return { lines, prompts };
}

// ── paint ───────────────────────────────────────────────────────────────

export interface Highlight {
  /** string offsets into `plain(line)` */
  from: number;
  to: number;
  current: boolean;
}

function hex(c: string): string {
  return `${parseInt(c.slice(1, 3), 16)};${parseInt(c.slice(3, 5), 16)};${parseInt(c.slice(5, 7), 16)}`;
}

function sgr(st: Style): string {
  const codes = ["0"];
  if (st.bold) codes.push("1");
  if (st.italic) codes.push("3");
  if (st.under) codes.push("4");
  if (st.strike) codes.push("9");
  if (st.fg) codes.push(`38;2;${hex(st.fg)}`);
  if (st.bg) codes.push(`48;2;${hex(st.bg)}`);
  return `\x1b[${codes.join(";")}m`;
}

const HL_CURRENT: Style = { fg: "#101010", bg: C.peach, bold: true };
const HL_OTHER: Style = { fg: C.peach, bg: C.sel };

/** A line as SGR text exactly `w` cells wide: band filled, highlights over spans, right label flush. */
export function paintLine(line: Line, w: number, hl: Highlight[] = []): string {
  let out = "";
  let used = 0;
  let off = 0;
  for (const sp of line.spans) {
    // split the span at highlight edges
    let i = 0;
    while (i < sp.t.length) {
      const at = off + i;
      const h = hl.find((x) => at >= x.from && at < x.to);
      const next = h ? Math.min(sp.t.length, h.to - off) : Math.min(sp.t.length, ...hl.filter((x) => x.from > at).map((x) => x.from - off));
      const piece = sp.t.slice(i, next);
      const st: Style = h ? { ...sp, ...(h.current ? HL_CURRENT : HL_OTHER) } : { ...sp, bg: sp.bg ?? line.band };
      out += sgr(st) + piece;
      used += width(piece);
      i = next;
    }
    off += sp.t.length;
  }
  const right = line.right ? width(line.right.t) : 0;
  const pad = Math.max(0, w - used - right);
  out += sgr({ bg: line.band }) + " ".repeat(pad);
  if (line.right) out += sgr(line.right) + line.right.t;
  return `${out}\x1b[0m`;
}
