import "../../test/helpers/home";
import { CONFIG_DIR } from "../../test/helpers/home";
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSessionName, loadNameCache, normalizeName, slugify, looksLikeRefusal, salvageName, pruneNameCache, needsNaming, inNamingCooldown, shouldRebaseline, pickConsensusName, buildNamingPrompt, saveNameCache, type NameCache } from "./names";

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

test("looksLikeRefusal: clipped sentences and I-don't replies are rejected", () => {
  // real garbage that reached names.json in the wild
  expect(looksLikeRefusal("I don't see an")).toBe(true);
  expect(looksLikeRefusal("Need PR details to")).toBe(true);
  expect(salvageName("I don't see an")).toBe("");
  expect(salvageName("Need PR details to")).toBe("");
  // trailing-word guard doesn't hit real names
  expect(looksLikeRefusal("Add Direction Column")).toBe(false);
  expect(looksLikeRefusal("Dial Targets Scoring")).toBe(false);
});

test("looksLikeRefusal: keeps real names that mention Claude Code or end in 'this'", () => {
  // claude0 manages Claude Code, so these are legitimate subjects, not self-introductions
  expect(looksLikeRefusal("Claude Code Health Check")).toBe(false);
  expect(looksLikeRefusal("Chat About This")).toBe(false);
  // self-introductions still rejected
  expect(looksLikeRefusal("I'm Claude Code, designed for")).toBe(true);
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

test("buildNamingPrompt: branch leads the context, main/master are omitted", () => {
  const p = buildNamingPrompt({ firstPrompt: "read tf-283 and begin", branch: "tf-283-client-provisioning-v2" });
  expect(p.indexOf('Branch: "client-provisioning-v2"')).toBeLessThan(p.indexOf("First user message"));
  expect(buildNamingPrompt({ firstPrompt: "x", branch: "main" })).not.toContain("Branch:");
  expect(buildNamingPrompt({ firstPrompt: "x", branch: "master" })).not.toContain("Branch:");
});

test("buildNamingPrompt: compact intent and current name land in the prompt", () => {
  const p = buildNamingPrompt({
    firstPrompt: "/grill-with-docs TF-285",
    compactIntent: "Build Onboard Client v2: provision through Throxy and spawn the ticket chain",
    currentName: "Onboard Client V2",
  });
  expect(p).toContain('Session intent (from an in-session summary): "Build Onboard Client v2');
  expect(p).toContain('Current name: "Onboard Client V2"');
  expect(p).toContain("reply with it UNCHANGED");
  const bare = buildNamingPrompt({ firstPrompt: "x" });
  expect(bare).not.toContain("Session intent");
  expect(bare).not.toContain("Current name:");
});

test("buildNamingPrompt: sibling names are listed, capped, and never echo the current name", () => {
  const p = buildNamingPrompt({
    firstPrompt: "x",
    currentName: "Postgres Migration",
    siblingNames: ["Postgres Migration", "Dial Targets Scoring", ""],
  });
  expect(p).toContain('Other sessions in this repo are already named: "Dial Targets Scoring"');
  expect(p).not.toContain('already named: "Postgres Migration"'); // own name filtered out
  const many = buildNamingPrompt({ firstPrompt: "x", siblingNames: Array.from({ length: 12 }, (_, i) => `Name ${i}`) });
  expect(many).toContain("Name 7");
  expect(many).not.toContain("Name 8"); // capped at 8
  expect(buildNamingPrompt({ firstPrompt: "x" })).not.toContain("Other sessions in this repo");
});

test("pickConsensusName: returns the draw the others agree with most", () => {
  // two draws share the subject, the third is an outlier — consensus wins
  expect(pickConsensusName(["Contact Self-Heal Flow", "Contact Self-Heal", "SNS Restructure"]))
    .toBe("Contact Self-Heal Flow");
  expect(pickConsensusName(["", "Web Push Notifications", ""])).toBe("Web Push Notifications");
  expect(pickConsensusName(["", "", ""])).toBe("");
  // no overlap at all: first draw, deterministically
  expect(pickConsensusName(["Alpha One", "Beta Two", "Gamma Three"])).toBe("Alpha One");
});

test("shouldRebaseline: drops the anchor only once a session outgrows its name", () => {
  const c = cache({ names: { s1: "Ticket Queue Load" }, sizes: { s1: 1000 } });
  expect(shouldRebaseline(c, "s1", 1500)).toBe(false); // normal growth — keep the anchor
  expect(shouldRebaseline(c, "s1", 2000)).toBe(true); // doubled — re-derive
  expect(shouldRebaseline(c, "s1", 9000)).toBe(true);
  expect(shouldRebaseline(c, "unknown", 9000)).toBe(false); // no baseline recorded
  expect(shouldRebaseline(c, "s1", 0)).toBe(false); // unreadable transcript
});

test("pruneNameCache: drops the size baseline alongside the name", () => {
  const c = cache({ names: { dead: "Old" }, sources: { dead: "x" }, sizes: { dead: 10 } });
  pruneNameCache(c, new Set<string>());
  expect(c.sizes).toEqual({});
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

test("inNamingCooldown: unnamed sessions retry early, named ones hold the full TTL", () => {
  const named = cache({ names: { s1: "Fix Auth" } });
  const skips = new Map([["s1", 90_000], ["s2", 90_000], ["s3", 30_000]]);
  expect(inNamingCooldown(skips, "s1", named)).toBe(true); // named: 90s < 5min
  expect(inNamingCooldown(skips, "s2", named)).toBe(false); // unnamed: 90s > 60s retry
  expect(inNamingCooldown(skips, "s3", named)).toBe(true); // unnamed: 30s < 60s
  expect(inNamingCooldown(skips, "s4", named)).toBe(false); // no cooldown at all
});
