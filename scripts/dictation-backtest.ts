#!/usr/bin/env bun
/**
 * Replays logged dictations through cleanup prompts and scores them against the messages
 * actually sent (docs/portkey.md § Dictation). Runs the production call (`cleanDictation`:
 * same flags, guard and context builder) with each variant's prompt.
 *
 *   bun scripts/dictation-backtest.ts head=HEAD work=working [--runs 3] [--only id8,id8] [--since ISO]
 *
 * A variant is name=<git ref> (the prompt in that commit's core/dictation.ts), name=working
 * (the file on disk), or name=/abs/path to a copy of dictation.ts holding a trial prompt. Results are cached per variant/take/run in
 * /tmp/dictation-backtest/<name>.jsonl, so re-running resumes; delete a file to redo it.
 *
 * Context is rebuilt the way the bridge builds it — the session's transcript up to the
 * take's time, the personal vocabulary and today's learned mis-hearings — minus the repo,
 * branch and skills, which the log doesn't record.
 */
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { buildContext, cleanDictation, DICTATION_LOG_PATH, readLearned, type DictationContext } from "../src/core/dictation";
import { readPersonalVocab } from "../src/core/dictation-vocab";
import { getTranscript } from "../src/core/session-api";

type Take = { id: string; at: string; sessionId: string; raw: string; cleaned?: string };
type Sent = { at: string; dictations: { id: string | null; raw: string; final: string }[]; sent: string };
type Result = { id: string; run: number; ms: number; final: string; guarded: boolean; error?: string };

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const RUNS = Number(flag("runs") ?? 1);
const ONLY = flag("only")?.split(",");
const SINCE = flag("since") ?? "";
const variants = args.map((a) => a.split("=") as [string, string]);
if (!variants.length || variants.some((v) => !v[1])) {
  console.error("usage: bun scripts/dictation-backtest.ts name=<git ref|working> … [--runs N] [--only id8,…] [--since ISO]");
  process.exit(1);
}
const OUT = "/tmp/dictation-backtest";
mkdirSync(OUT, { recursive: true });

const promptOf = async (ref: string) => {
  const src = ref === "working" ? readFileSync(`${import.meta.dir}/../src/core/dictation.ts`, "utf8") : ref.startsWith("/") ? readFileSync(ref, "utf8") : await $`git -C ${import.meta.dir}/.. show ${ref}:src/core/dictation.ts`.text();
  const m = src.match(/CLEANUP_SYSTEM = `([\s\S]*?)`;/);
  if (!m) throw new Error(`no CLEANUP_SYSTEM in ${ref}`);
  return m[1]!;
};

const log = readFileSync(DICTATION_LOG_PATH, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const kind = (r: Record<string, unknown>) => r.kind ?? ("raw" in r ? "take" : "sent");
const takes: Take[] = log.filter((r) => kind(r) === "take" && r.raw && r.at >= SINCE && (!ONLY || ONLY.some((p) => r.id.startsWith(p))));
const sents: Sent[] = log.filter((r) => kind(r) === "sent");

// --- context, as the bridge builds it at the take's time ---
const learned = readLearned();
const personal = readPersonalVocab()?.terms ?? [];
const txCache = new Map<string, Awaited<ReturnType<typeof getTranscript>> | null>();
async function contextFor(t: Take): Promise<DictationContext> {
  if (!txCache.has(t.sessionId)) txCache.set(t.sessionId, await getTranscript(t.sessionId).catch(() => null));
  const turns = (txCache.get(t.sessionId)?.turns ?? []).filter((x) => !x.at || x.at < t.at);
  return buildContext({ skills: [], turns, personal, learned });
}

// --- run ---
for (const [name, ref] of variants) {
  const system = await promptOf(ref);
  const file = `${OUT}/${name}.jsonl`;
  const done = new Set(existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l) as Result; return `${r.id}:${r.run}`; }) : []);
  const jobs = takes.flatMap((t) => Array.from({ length: RUNS }, (_, run) => ({ t, run }))).filter(({ t, run }) => !done.has(`${t.id}:${run}`));
  let n = 0;
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const { t, run } = queue.shift()!;
      const t0 = performance.now();
      const r = await cleanDictation(t.raw, await contextFor(t), system);
      const res: Result = { id: t.id, run, ms: Math.round(performance.now() - t0), ...("error" in r ? { final: t.raw, guarded: false, error: r.error } : { final: r.final, guarded: r.guarded }) };
      appendFileSync(file, JSON.stringify(res) + "\n");
      if (++n % 25 === 0 || n === jobs.length) console.error(`${name}: ${n}/${jobs.length} (${Math.round((100 * n) / jobs.length)}%)`);
    }
  }));
}

// --- score ---
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? [];
function edits(a: string[], b: string[]): { del: string; ins: string }[] {
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { del: string; ins: string }[] = [];
  let i = 0, j = 0, del: string[] = [], ins: string[] = [];
  const flush = () => { if (del.length || ins.length) out.push({ del: del.join(" "), ins: ins.join(" ") }); del = []; ins = []; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || L[i]![j + 1]! >= L[i + 1]![j]!)) ins.push(b[j++]!);
    else del.push(a[i++]!);
  }
  flush();
  return out;
}
const distance = (a: string, b: string) => edits(words(a), words(b)).reduce((n, e) => n + Math.max(e.del.split(" ").filter(Boolean).length, e.ins.split(" ").filter(Boolean).length), 0) / Math.max(1, words(b).length);

// Ground truth: a send carrying one dictation that is mostly that dictation (not mostly typed).
const truth = new Map<string, { sent: string; applied: boolean; handEdits: { del: string; ins: string }[] }>();
for (const s of sents) {
  if (s.dictations.length !== 1 || !s.dictations[0]!.id) continue;
  const d = s.dictations[0]!;
  const sent = s.sent.replace(/\s+[0-9a-f]{8}-[0-9a-f-]{27}\s*$/, "").trim(); // a pasted session id
  if (distance(d.final, sent) > 0.3) continue;
  truth.set(d.id!, { sent, applied: d.final !== d.raw, handEdits: edits(words(d.final), words(sent)).filter((e) => e.del && e.ins && e.del.split(" ").length <= 4) });
}

// Edits the prompt forbids. Heuristic, so each hit is printed for a human to judge.
const CONTRACTIONS: [string, string][] = [["does not", "doesn't"], ["cannot", "can't"], ["do not", "don't"], ["is not", "isn't"], ["that is", "that's"], ["it is", "it's"], ["i am", "i'm"], ["will not", "won't"], ["are not", "aren't"]];
const QUALIFIERS = ["only", "even", "honestly", "completely", "just", "exactly", "always", "never"];
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
function violations(raw: string, out: string): string[] {
  const R = raw.toLowerCase(), O = out.toLowerCase(), v: string[] = [];
  for (const [a, b] of CONTRACTIONS) if (count(R, new RegExp(`\\b${a}\\b`, "g")) > count(O, new RegExp(`\\b${a}\\b`, "g")) && count(O, new RegExp(`\\b${b}`, "g")) > count(R, new RegExp(`\\b${b}`, "g"))) v.push(`contraction ${b}`);
  if (count(O, /\bwhether\b/g) > count(R, /\bwhether\b/g)) v.push("if → whether");
  for (const q of QUALIFIERS) if (count(R, new RegExp(`\\b${q}\\b`, "g")) > count(O, new RegExp(`\\b${q}\\b`, "g"))) v.push(`dropped "${q}"`);
  // A list numbered by position over points the speaker named by number: "2. Agree on doing 2 and 3."
  for (const line of out.split("\n")) { const m = line.match(/^(\d+)\.\s(.*)$/); if (m && new RegExp(`\\b${m[1]}\\b`).test(m[2]!)) v.push(`list item ${m[1]} names ${m[1]} again`); }
  return v;
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const results = new Map(variants.map(([name]) => [name, readFileSync(`${OUT}/${name}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Result).filter((r) => takes.some((t) => t.id === r.id))]));
const raw = new Map(takes.map((t) => [t.id, t.raw]));
const scored = takes.filter((t) => truth.has(t.id));
const unapplied = scored.filter((t) => !truth.get(t.id)!.applied);

console.log(`\n${takes.length} takes × ${RUNS} run(s); ${scored.length} with a sent message to compare against (${unapplied.length} whose cleanup wasn't in the box when sent — the fairest test)\n`);
console.log("variant      median ms  p90 ms  errors  guarded  changed  violations  distance→sent  (unapplied)  hand edits recovered");
const rawDist = mean(scored.map((t) => distance(t.raw, truth.get(t.id)!.sent)));
const rawUn = mean(unapplied.map((t) => distance(t.raw, truth.get(t.id)!.sent)));
console.log(`${"(raw text)".padEnd(12)} ${"".padStart(9)} ${"".padStart(7)} ${"".padStart(7)} ${"".padStart(8)} ${"".padStart(8)} ${"".padStart(11)} ${rawDist.toFixed(3).padStart(14)} ${rawUn.toFixed(3).padStart(12)}`);
const allViolations = new Map<string, { id: string; v: string }[]>();
for (const [name] of variants) {
  const rs = results.get(name)!;
  const ms = rs.filter((r) => !r.error).map((r) => r.ms);
  const vs = rs.flatMap((r) => violations(raw.get(r.id)!, r.final).map((v) => ({ id: r.id, v })));
  allViolations.set(name, vs);
  const dist = (set: Take[]) => mean(rs.filter((r) => set.some((t) => t.id === r.id)).map((r) => distance(r.final, truth.get(r.id)!.sent)));
  const hand = scored.flatMap((t) => truth.get(t.id)!.handEdits.map((e) => ({ t, e })));
  const recovered = hand.filter(({ t, e }) => rs.filter((r) => r.id === t.id).some((r) => words(r.final).join(" ").includes(e.ins)));
  console.log(`${name.padEnd(12)} ${String(pct(ms, 0.5)).padStart(9)} ${String(pct(ms, 0.9)).padStart(7)} ${String(rs.filter((r) => r.error).length).padStart(7)} ${String(rs.filter((r) => r.guarded).length).padStart(8)} ${String(rs.filter((r) => r.final !== raw.get(r.id)).length).padStart(8)} ${String(vs.length).padStart(11)} ${dist(scored).toFixed(3).padStart(14)} ${dist(unapplied).toFixed(3).padStart(12)}  ${recovered.length}/${hand.length}`);
}
for (const [name, vs] of allViolations) if (vs.length) console.log(`\n${name} violations:\n` + vs.map(({ id, v }) => `  ${id.slice(0, 8)}  ${v}`).join("\n"));

// Learned mis-hearings: does the output carry the meant term wherever the heard form occurs?
console.log("\nlearned mis-hearings (takes with the heard form whose output has the meant term):");
for (const c of learned) {
  const ts = takes.filter((t) => t.raw.toLowerCase().includes(c.heard.toLowerCase()));
  if (ts.length) console.log(`  ${c.heard} → ${c.meant}: ` + variants.map(([name]) => `${name} ${results.get(name)!.filter((r) => ts.some((t) => t.id === r.id) && r.final.toLowerCase().includes(c.meant.toLowerCase())).length}/${ts.length * RUNS}`).join("  "));
}
// Where the first two variants disagree, for reading side by side.
if (variants.length >= 2) {
  const [a, b] = [variants[0]![0], variants[1]![0]];
  const diff = takes.filter((t) => { const x = results.get(a)!.find((r) => r.id === t.id && r.run === 0); const y = results.get(b)!.find((r) => r.id === t.id && r.run === 0); return x && y && x.final !== y.final; });
  console.log(`\n${diff.length} takes where ${a} and ${b} differ (run 0): written to ${OUT}/diff-${a}-${b}.txt`);
  await Bun.write(`${OUT}/diff-${a}-${b}.txt`, diff.map((t) => {
    const x = results.get(a)!.find((r) => r.id === t.id && r.run === 0)!, y = results.get(b)!.find((r) => r.id === t.id && r.run === 0)!;
    return `${t.id.slice(0, 8)}\nRAW  ${t.raw}\n${a.toUpperCase().padEnd(4)} ${x.final}\n${b.toUpperCase().padEnd(4)} ${y.final}\nSENT ${truth.get(t.id)?.sent ?? "(no comparable send)"}\n`;
  }).join("\n"));
}
process.exit(0);
