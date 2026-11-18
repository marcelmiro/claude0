/**
 * Personal dictation vocabulary — the domain terms you actually use ("DNC", "Maestro",
 * "EmailBison", …), mined from every prompt you've sent Claude Code, so dictation recognises
 * them even when the session you're dictating into never mentioned them.
 *
 * Mining streams every transcript (GBs), so it runs as its own process (`claude0
 * dictation-vocab`), never inside the bridge; the bridge only reads the result.
 * docs/portkey.md § Dictation.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { PATHS, writeAtomic } from "./config";
import { claudePrint } from "./claude-print";

export const VOCAB_PATH = `${PATHS.dir}/dictation-vocab.json`;
export const VOCAB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_USES = 15;
const MAX_CANDIDATES = 3000;
const BATCH = 300;

export interface PersonalVocab { generatedAt: number; terms: string[] }
export type TermStats = Map<string, { total: number; forms: Map<string, number> }>;

const INJECTED = /<teammate-message|<command-|<system-reminder|<task-notification|Base directory for this skill|\[Request interrupted|This session is being continued/;

/** The prompt text of a transcript line when it's something a human typed or dictated, else null. */
export function humanPromptText(line: string): string | null {
  if (!line.includes('"type":"user"')) return null;
  let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; userType?: string; message?: { content?: unknown } };
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== "user" || o.isMeta || o.isSidechain || (o.userType && o.userType !== "external")) return null;
  const c = o.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b?.type === "tool_result")) return null;
    text = c.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" ");
  }
  text = text.trim();
  // Injected turns (skill bodies, teammate messages, hook notices) ride the user role too.
  if (!text || /^[<\[]/.test(text) || text.length > 2500 || INJECTED.test(text)) return null;
  return text;
}

export function countTerms(text: string, stats: TermStats): void {
  for (const w of text.match(/[A-Za-z][\w.\-]*[A-Za-z0-9]/g) ?? []) {
    if (w.length > 30) continue;
    const k = w.toLowerCase();
    const s = stats.get(k) ?? { total: 0, forms: new Map<string, number>() };
    s.total++;
    s.forms.set(w, (s.forms.get(w) ?? 0) + 1);
    stats.set(k, s);
  }
}

const ACRONYM = /^[A-Z]{2,6}s?$/;
const IDENT = /[a-z][A-Z]|[a-z0-9][._-][a-z0-9]|[a-z]\d/;

/**
 * Split counted words into terms whose shape alone marks them (acronyms used mostly in
 * caps, identifier-shaped words) and frequent plain words that need judging.
 */
export function classifyByShape(stats: TermStats): { kept: { term: string; n: number }[]; candidates: { key: string; form: string; n: number }[] } {
  const kept: { term: string; n: number }[] = [];
  const candidates: { key: string; form: string; n: number }[] = [];
  for (const [k, s] of stats) {
    if (s.total < MIN_USES || /^(e\.g|i\.e)$/.test(k)) continue;
    const forms = [...s.forms].sort((a, b) => b[1] - a[1]);
    const caps = forms.filter(([f]) => ACRONYM.test(f));
    const capsN = caps.reduce((n, [, c]) => n + c, 0);
    // The spelling with the identifier shape is the canonical one — you may type
    // "customeros" far more often, but "CustomerOS" is how the name is written.
    const ident = /^\d/.test(k) ? undefined : forms.find(([f, c]) => c >= 5 && IDENT.test(f));
    if (capsN >= 10 && capsN / s.total >= 0.4) kept.push({ term: caps[0]![0], n: s.total });
    else if (ident) kept.push({ term: ident[0], n: s.total });
    else if (k.length >= 3) candidates.push({ key: k, form: forms.slice(0, 3).map(([f]) => f).join("/"), n: s.total });
  }
  candidates.sort((a, b) => b.n - a.n);
  return { kept, candidates: candidates.slice(0, MAX_CANDIDATES) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Lines Claude kept, mapped back to candidate keys — anything not in the batch is dropped. */
export function parseKept(output: string, batch: { key: string }[]): Map<string, string> {
  const byNorm = new Map(batch.map((c) => [norm(c.key), c.key]));
  const out = new Map<string, string>();
  for (const line of output.split("\n")) {
    const term = line.replace(/^[\s\-*•\d.)]+/, "").trim();
    const key = byNorm.get(norm(term));
    if (term && key && !out.has(key)) out.set(key, term);
  }
  return out;
}

const JUDGE_SYSTEM = `You get words a software developer used in chat messages to an AI coding agent, one per line: the spellings they used (most common first, separated by "/") and a usage count. Return only the domain-specific ones a speech recognizer may not know: product, company, tool, library, service, person and project names, and technical jargon. Leave out ordinary English words, including everyday technical words (session, deploy, table, merge, branch, server). Output one term per line, spelled the way the name is properly written, not necessarily the most common spelling given (customeros/CustomerOS → CustomerOS, emailbison → EmailBison, github → GitHub). No other text.`;

async function judge(candidates: { key: string; form: string; n: number }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batches: (typeof candidates)[] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const r = await claudePrint({ system: JUDGE_SYSTEM, input: batch.map((c) => `${c.form} ${c.n}`).join("\n"), timeoutMs: 90_000 });
      if ("error" in r) { console.error(`[dictation-vocab] batch failed: ${r.error}`); continue; }
      for (const [k, v] of parseKept(r.text, batch)) out.set(k, v);
    }
  }));
  return out;
}

/**
 * Lines of a JSONL file shorter than `maxBytes`; longer ones are skipped without being
 * decoded. A prompt's record is a few KB, while tool results and images run to MBs — turning
 * those into strings (as `jsonlLines` must) took mining past 1.5 GB RSS over a 13 GB history.
 */
export async function* shortJsonlLines(path: string, maxBytes = 64 * 1024): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let len = 0;
  let skipping = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      while (start < value.length) {
        const nl = value.indexOf(10, start);
        const end = nl === -1 ? value.length : nl;
        if (!skipping && len + (end - start) > maxBytes) { skipping = true; parts = []; len = 0; }
        if (!skipping && end > start) { parts.push(value.slice(start, end)); len += end - start; }
        if (nl === -1) break;
        if (!skipping && len) yield decoder.decode(Buffer.concat(parts));
        parts = []; len = 0; skipping = false;
        start = nl + 1;
      }
    }
    if (!skipping && len) yield decoder.decode(Buffer.concat(parts));
  } finally {
    reader.releaseLock();
  }
}

/** Every top-level transcript under ~/.claude/projects (subagent transcripts live in subdirs). */
function transcriptFiles(root: string): string[] {
  const files: string[] = [];
  try {
    for (const dir of readdirSync(root)) {
      const d = join(root, dir);
      try {
        if (!statSync(d).isDirectory()) continue;
        for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) files.push(join(d, f));
      } catch { /* unreadable dir */ }
    }
  } catch { /* no projects dir */ }
  return files;
}

export async function mineVocab(root = join(homedir(), ".claude/projects")): Promise<PersonalVocab> {
  const stats: TermStats = new Map();
  let prompts = 0;
  for (const f of transcriptFiles(root)) {
    try {
      for await (const line of shortJsonlLines(f)) {
        const text = humanPromptText(line);
        if (text) { prompts++; countTerms(text, stats); }
      }
    } catch { /* unreadable transcript */ }
  }
  const { kept, candidates } = classifyByShape(stats);
  const judged = await judge(candidates);
  const all = [...kept, ...candidates.filter((c) => judged.has(c.key)).map((c) => ({ term: judged.get(c.key)!, n: c.n }))];
  all.sort((a, b) => b.n - a.n);
  const seen = new Set<string>();
  const terms = all.filter((t) => !seen.has(norm(t.term)) && seen.add(norm(t.term))).map((t) => t.term);
  console.error(`[dictation-vocab] ${prompts} prompts → ${kept.length} by shape + ${judged.size}/${candidates.length} judged = ${terms.length} terms`);
  return { generatedAt: Date.now(), terms };
}

/** `claude0 dictation-vocab` — mine and write the vocabulary file. */
export async function runDictationVocab(): Promise<void> {
  const vocab = await mineVocab();
  mkdirSync(PATHS.dir, { recursive: true });
  writeAtomic(VOCAB_PATH, JSON.stringify(vocab));
}

export function readPersonalVocab(): PersonalVocab | null {
  try {
    const v = JSON.parse(readFileSync(VOCAB_PATH, "utf8")) as PersonalVocab;
    return Array.isArray(v.terms) ? v : null;
  } catch {
    return null;
  }
}

let mining: Promise<void> | null = null;

/**
 * Re-mine in a child process when the file is missing or a day old. Fire-and-forget and
 * single-flight: a dictation never waits on it — it uses whatever vocabulary exists.
 */
export function refreshVocabIfStale(now = Date.now()): void {
  if (mining) return;
  const v = readPersonalVocab();
  if (v && now - v.generatedAt < VOCAB_MAX_AGE_MS) return;
  mining = (async () => {
    try {
      const proc = Bun.spawn([process.execPath, process.argv[1]!, "dictation-vocab"], { stdout: "ignore", stderr: "inherit" });
      await proc.exited;
    } catch (e) {
      console.error(`[dictation-vocab] spawn failed: ${String(e)}`);
    } finally {
      mining = null;
    }
  })();
}
