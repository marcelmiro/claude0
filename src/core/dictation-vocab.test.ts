import "../../test/helpers/home";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyByShape, countTerms, humanPromptText, parseKept, shortJsonlLines, type TermStats } from "./dictation-vocab";

const userLine = (content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", userType: "external", message: { role: "user", content }, ...extra });

describe("humanPromptText", () => {
  test("returns a typed prompt, string or text blocks", () => {
    expect(humanPromptText(userLine("check the DNC sync"))).toBe("check the DNC sync");
    expect(humanPromptText(userLine([{ type: "text", text: "check Maestro" }]))).toBe("check Maestro");
  });
  test("skips tool results, meta and sidechain records, and assistant lines", () => {
    expect(humanPromptText(userLine([{ type: "tool_result", content: "ok" }]))).toBeNull();
    expect(humanPromptText(userLine("x", { isMeta: true }))).toBeNull();
    expect(humanPromptText(userLine("x", { isSidechain: true }))).toBeNull();
    expect(humanPromptText(JSON.stringify({ type: "assistant", message: { content: "hi" } }))).toBeNull();
  });
  test("skips injected text riding the user role", () => {
    expect(humanPromptText(userLine("<command-name>/clear</command-name>"))).toBeNull();
    expect(humanPromptText(userLine("Another Claude session sent a message: <teammate-message>hi</teammate-message>"))).toBeNull();
    expect(humanPromptText(userLine("Base directory for this skill: /x"))).toBeNull();
    expect(humanPromptText(userLine("a".repeat(3000)))).toBeNull();
  });
});

describe("classifyByShape", () => {
  const stats: TermStats = new Map();
  const say = (text: string, times: number) => { for (let i = 0; i < times; i++) countTerms(text, stats); };
  say("block the DNC row", 20); // acronym used in caps
  say("THE plan is NOW", 1); say("the plan is now", 30); // shouting, not acronyms
  say("run pr-triage then claude0", 20); // identifier-shaped
  say("sync maestro", 20); // plain word → needs judging
  say("rare zorblax", 3); // under the use threshold
  const { kept, candidates } = classifyByShape(stats);
  const keptTerms = kept.map((k) => k.term);

  test("keeps acronyms and identifiers by shape", () => {
    expect(keptTerms).toEqual(expect.arrayContaining(["DNC", "pr-triage", "claude0"]));
  });
  test("an identifier takes its capitalised spelling when that's used at least a fifth of the time", () => {
    const s: TermStats = new Map();
    for (let i = 0; i < 15; i++) countTerms("ping customeros", s);
    for (let i = 0; i < 5; i++) countTerms("ping CustomerOS", s);
    expect(classifyByShape(s).kept.map((k) => k.term)).toContain("CustomerOS");
  });
  test("emphasis caps on common words are not acronyms", () => {
    expect(keptTerms).not.toContain("THE");
    expect(keptTerms).not.toContain("NOW");
  });
  test("plain frequent words go to judging; rare words are dropped", () => {
    expect(candidates.map((c) => c.key)).toContain("maestro");
    expect(candidates.map((c) => c.key)).not.toContain("zorblax");
  });
});

describe("shortJsonlLines", () => {
  test("yields short lines in order and skips over-long ones without decoding them", async () => {
    const path = join(tmpdir(), `short-lines-${process.pid}.jsonl`);
    const long = "x".repeat(200_000); // spans several stream chunks
    await Bun.write(path, `{"a":1}\n${long}\n{"b":"é"}\n\n{"c":3}`);
    const lines: string[] = [];
    for await (const l of shortJsonlLines(path, 1024)) lines.push(l);
    expect(lines).toEqual(['{"a":1}', '{"b":"é"}', '{"c":3}']);
  });
});

describe("parseKept", () => {
  const batch = [{ key: "maestro" }, { key: "emailbison" }, { key: "session" }];
  test("maps canonical spellings back to candidates, ignoring list markers", () => {
    expect([...parseKept("- Maestro\n2. EmailBison\n", batch)]).toEqual([["maestro", "Maestro"], ["emailbison", "EmailBison"]]);
  });
  test("drops anything that wasn't in the batch", () => {
    expect([...parseKept("Maestro\nKubernetes\nHere are the terms:", batch)]).toEqual([["maestro", "Maestro"]]);
  });
});
