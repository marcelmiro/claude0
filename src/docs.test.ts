/**
 * The doc policy in CLAUDE.md, enforced: ADRs carry a numbered title plus Date/Status lines
 * and no changelog addenda (a reversal edits the Status line; mechanism lives in
 * docs/<area>.md), every relative link resolves, and CLAUDE.md links every ADR and doc so
 * an agent reading the map can reach all of them.
 */
import { test, expect } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const read = (rel: string) => Bun.file(join(ROOT, rel)).text();
const scan = (pattern: string) => Array.from(new Bun.Glob(pattern).scanSync({ cwd: ROOT })).sort();

const ADRS = scan("docs/adr/*.md");
const DOCS = scan("docs/*.md");

test("every ADR has a numbered title, Date and Status lines, and no addenda", async () => {
  expect(ADRS.length).toBeGreaterThan(0);
  const problems: string[] = [];
  for (const rel of ADRS) {
    const num = Number(rel.match(/(\d{4})-/)![1]);
    const text = await read(rel);
    const head = text.split("\n").slice(0, 5);
    if (!head[0]!.startsWith(`# ${num}. `)) problems.push(`${rel}: title must start "# ${num}. "`);
    if (!head.some((l) => l.startsWith("Date: "))) problems.push(`${rel}: no "Date: " line`);
    if (!head.some((l) => l.startsWith("Status: "))) problems.push(`${rel}: no "Status: " line`);
    for (const h of text.match(/^#{2,} .*$/gm) ?? []) {
      if (/addend|^#{2,} \d{4}-\d{2}-\d{2}/i.test(h)) problems.push(`${rel}: changelog heading "${h}"`);
    }
  }
  expect(problems).toEqual([]);
});

test("relative links in the map, glossary, docs and ADRs resolve", async () => {
  const broken: string[] = [];
  for (const rel of ["CLAUDE.md", "GLOSSARY.md", "deploy/README.md", ...DOCS, ...ADRS]) {
    for (const m of (await read(rel)).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/.test(target)) continue;
      if (!existsSync(resolve(ROOT, dirname(rel), target))) broken.push(`${rel} -> ${target}`);
    }
  }
  expect(broken).toEqual([]);
});

test("CLAUDE.md links every ADR and doc", async () => {
  const map = await read("CLAUDE.md");
  const unlinked = [...ADRS, ...DOCS].filter((rel) => !map.includes(`](${rel})`));
  expect(unlinked).toEqual([]);
});
