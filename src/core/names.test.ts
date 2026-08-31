import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSessionName, loadNameCache, normalizeName, slugify, looksLikeRefusal, salvageName, pruneNameCache, needsNaming, buildNamingPrompt, saveNameCache, type NameCache } from "./names";

const CACHE_FILE = join(CONFIG_DIR, "names.json");
function writeCache(obj: unknown) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(obj));
}

function cache(over: Partial<NameCache> = {}): NameCache {
  return { version: 6, names: {}, sources: {}, ...over };
}

test("getSessionName: returns the AI name", () => {
  const c = cache({ names: { s1: "Fix Auth" } });
  expect(getSessionName("s1", c)).toBe("Fix Auth");
});

test("getSessionName: empty string when unset", () => {
  expect(getSessionName("s1", cache())).toBe("");
});

test("normalizeName: keeps casing and spaces, collapses whitespace", () => {
  expect(normalizeName("  Payments   Hotfix ")).toBe("Payments Hotfix");
  expect(normalizeName("Fix Auth Flow")).toBe("Fix Auth Flow");
});

test("normalizeName: strips window separators and control chars", () => {
  expect(normalizeName("Fix·Auth⚡+")).toBe("Fix Auth");
  expect(normalizeName("   ")).toBe("");
  expect(normalizeName("")).toBe("");
});

test("normalizeName: word-joining punctuation becomes a space (slugify splits, not merges)", () => {
  expect(normalizeName("Clarification—the first")).toBe("Clarification the first");
  expect(normalizeName("Fix/Auth Bug")).toBe("Fix Auth Bug");
  expect(normalizeName("Merge_Provider:Sync")).toBe("Merge Provider Sync");
  // hyphen is kept (kebab-friendly)
  expect(normalizeName("fix-auth")).toBe("fix-auth");
});

test("normalizeName: over-30 trims at a word boundary, never mid-word", () => {
  const out = normalizeName("This doesn't appear to be a source file");
  expect(out.length).toBeLessThanOrEqual(30);
  expect(out.endsWith(" ")).toBe(false);
  expect(out).toBe("This doesn't appear to be a"); // no dangling "so"
});

test("slugify: lowercases, hyphenates, abbreviates via ABBREV", () => {
  expect(slugify("Fix Auth")).toBe("fix-auth");
  expect(slugify("Implementation Cleanup")).toBe("impl-cleanup");
  expect(slugify("Database Perf")).toBe("db-perf");
  expect(slugify("Fix Auth 2")).toBe("fix-auth-2");
  // domain-noun abbreviations that actually recur in real names
  expect(slugify("Delete Dead Organizations")).toBe("delete-dead-org");
  expect(slugify("Add Tomba Provider")).toBe("add-tomba-prov");
  expect(slugify("Disposition History Backfill")).toBe("disp-history-backfill");
  expect(slugify("Employment Verification")).toBe("employment-verif");
  expect(slugify("Session Name Generation")).toBe("session-name-gen");
});

test("slugify: em-dash-joined words split into separate slug parts (not merged)", () => {
  expect(slugify(normalizeName("Clarification—the first"))).toBe("clarification-the-first");
});

test("looksLikeRefusal: rejects refusals/meta-replies, keeps real names", () => {
  expect(looksLikeRefusal("I can't help with this. I'm here to...")).toBe(true);
  expect(looksLikeRefusal("I need permission to read that")).toBe(true);
  expect(looksLikeRefusal("This doesn't appear to be a source file")).toBe(true);
  expect(looksLikeRefusal("I need clarification—the first thing")).toBe(true);
  expect(looksLikeRefusal("Fix Auth")).toBe(false);
  expect(looksLikeRefusal("Provider Sync")).toBe(false);
});

test("looksLikeRefusal: rejects self-introductions the namer emits for non-coding tasks", () => {
  // real garbage names observed in the wild
  expect(looksLikeRefusal("I'm Claude Code, designed for")).toBe(true);
  expect(looksLikeRefusal("I'm Claude Code, a")).toBe(true);
  expect(looksLikeRefusal("I'm a set up for")).toBe(true);
  expect(looksLikeRefusal("As an AI assistant I can")).toBe(true);
});

test("looksLikeRefusal: rejects rambles (comma or >4 words), keeps terse names", () => {
  expect(looksLikeRefusal("Fix, then refactor")).toBe(true); // comma
  expect(looksLikeRefusal("Update The Index And Types")).toBe(true); // 5 words
  expect(looksLikeRefusal("Delete Dead Organizations")).toBe(false); // 3 words, real
  expect(looksLikeRefusal("Add Tomba Provider")).toBe(false);
});

test("slugify: truncates to 24 chars with no trailing dash", () => {
  const out = slugify("Optimization Something Longer Words");
  expect(out.length).toBeLessThanOrEqual(24);
  expect(out.endsWith("-")).toBe(false);
});

test("slugify: strips symbols, empty stays empty", () => {
  expect(slugify("$$$")).toBe("");
  expect(slugify("")).toBe("");
});

test("loadNameCache: any non-v6 cache starts fresh", async () => {
  writeCache({ version: 5, names: { s1: "old-name" }, sources: {}, pinned: { s2: "payments-hotfix" } });
  const c = await loadNameCache();
  expect(c.version).toBe(6);
  expect(c.names).toEqual({});
  rmSync(CACHE_FILE, { force: true });
});

test("salvageName: strips a conversational prefix and clamps to 4 words", () => {
  expect(salvageName("Sure — Dark Mode Toggle")).toBe("Dark Mode Toggle");
  expect(salvageName("Here's Provider Sync.")).toBe("Provider Sync");
  expect(salvageName("Fix Auth Token Refresh Logic Everywhere")).toBe("Fix Auth Token Refresh");
});

test("salvageName: still rejects output with no name inside", () => {
  expect(salvageName("I can't help with this")).toBe("");
  expect(salvageName("I'm Claude Code, designed for")).toBe("");
  expect(salvageName("Sorry")).toBe("");
});

test("pruneNameCache: drops entries with no live transcript, keeps live ones", () => {
  const c = cache({ names: { live: "Fix Auth", dead: "Old Thing" }, sources: { live: "x", dead: "y" } });
  const changed = pruneNameCache(c, new Set(["live"]));
  expect(changed).toBe(true);
  expect(c.names).toEqual({ live: "Fix Auth" });
  expect(c.sources).toEqual({ live: "x" });
  expect(pruneNameCache(c, new Set(["live"]))).toBe(false);
});

test("looksLikeRefusal: prefixes match on word boundaries only", () => {
  expect(looksLikeRefusal("Surefire Payments")).toBe(false); // "sure" is not a whole word here
  expect(looksLikeRefusal("Heyday Analysis")).toBe(false);
  expect(looksLikeRefusal("Sure thing")).toBe(true);
});

test("salvageName: never mangles a boundary-adjacent real name", () => {
  expect(salvageName("Surefire Payments")).toBe("Surefire Payments");
});

test("needsNaming: unnamed, drifted, and stable cases", () => {
  const c = cache({ names: { s1: "Fix Auth" }, sources: { s1: "old signal" } });
  expect(needsNaming(c, "s2", "anything")).toBe(true); // unnamed
  expect(needsNaming(c, "s1", "new signal")).toBe(true); // drifted
  expect(needsNaming(c, "s1", "old signal")).toBe(false); // stable
  expect(needsNaming(c, "s1", "")).toBe(false); // no signal, keep the name
});

test("buildNamingPrompt: assistant replies land in the prompt, deduped and truncated", () => {
  const p = buildNamingPrompt({
    firstPrompt: "grill me about this plan",
    firstAssistant: "A".repeat(400),
    lastPrompt: "ok continue",
    lastAssistant: "The inbox redesign moves rows into a store",
    branch: "tf-192-inbox-redesign",
  });
  expect(p).toContain('First assistant reply: "' + "A".repeat(300) + '"');
  expect(p).toContain('Most recent assistant reply: "The inbox redesign moves rows into a store"');
  const mid = buildNamingPrompt({ firstPrompt: "x", middlePrompts: ["backfill the residuals", "reclassify calls"] });
  expect(mid).toContain('Mid-session user message: "backfill the residuals"');
  expect(mid).toContain('Mid-session user message: "reclassify calls"');
  // Identical first/last assistant reply appears once.
  const dup = buildNamingPrompt({ firstPrompt: "x", firstAssistant: "same", lastAssistant: "same" });
  expect(dup).not.toContain("Most recent assistant reply");
});

test("saveNameCache: round-trips atomically with no temp file left behind", async () => {
  const c = cache({ names: { s1: "Fix Auth" }, sources: { s1: "sig" } });
  await saveNameCache(c);
  const loaded = await loadNameCache();
  expect(loaded.names).toEqual({ s1: "Fix Auth" });
  const { readdirSync } = await import("node:fs");
  expect(readdirSync(CONFIG_DIR).filter((f) => f.includes("names.json.tmp"))).toEqual([]);
  rmSync(CACHE_FILE, { force: true });
});
