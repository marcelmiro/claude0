import "../../test/helpers/home";
import { describe, expect, test } from "bun:test";
import { audioExt, buildContext, corrections, guardCleanup, mergeCorrections, rememberDictation, takeDictation } from "./dictation";
import type { TranscriptTurn } from "../types";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(12).fill(0)].slice(0, 12));

describe("audioExt", () => {
  test("recognises the containers Safari and Chrome record", () => {
    expect(audioExt(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("webm");
    expect(audioExt(new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypmp42")]))).toBe("mp4");
    expect(audioExt(bytes(0x49, 0x44, 0x33))).toBe("mp3");
  });
  test("rejects the 5-byte WebM tail Safari once sent instead of a recording", () => {
    expect(audioExt(bytes(0x1c, 0x53, 0xbb, 0x6b, 0x80))).toBeNull();
  });
});

describe("guardCleanup", () => {
  const raw = "TUI offers a global option only. Can you test out this Chat with me option to check out what JSONL stores and how it works internally to copy it for portkey?";
  test("keeps term fixes", () => {
    const fixed = raw.replace("portkey", "Portkey");
    expect(guardCleanup(raw, fixed)).toEqual({ final: fixed, guarded: false });
  });
  test("keeps the raw transcript when cleanup dropped a sentence", () => {
    const dropped = raw.replace("TUI offers a global option only. ", "");
    expect(guardCleanup(raw, dropped)).toEqual({ final: raw, guarded: true });
  });
  test("allows dropping a few fillers", () => {
    expect(guardCleanup("um so uh run the tests", "so run the tests").guarded).toBe(false);
  });
  test("allows a real dictation's fillers, false start and spoken list markers to go", () => {
    const dictated =
      "Um, questions. Number one is, are you using the correct styles the same way as the plus icon? The correct styles for the button, for the microphone button, has this plus icon to the left of the message input box. Two is, have you reviewed the UI UX on the microphone button to make it good enough? And three is, what model are you using for Claude Dash P?";
    const cleaned =
      "Questions:\n1. Are you using the correct styles the same way as the plus icon? The correct styles for the microphone button as the plus icon to the left of the message input box.\n2. Have you reviewed the UI/UX on the microphone button to make it good enough?\n3. What model are you using for claude -p?";
    expect(guardCleanup(dictated, cleaned).guarded).toBe(false);
  });
  test("term fixes, 'iff' and a spoken list in a short dictation are not a loss", () => {
    const dictated = "Um, so two things. Number one is, can you check the Betsec incidents? And two is, run the PR triage skill if and only if CI is green.";
    const cleaned = "Two things:\n1. Can you check the betterstack incidents?\n2. Run the pr-triage skill iff CI is green.";
    expect(guardCleanup(dictated, cleaned).guarded).toBe(false);
  });
  test("a cleanup that answers instead of cleaning is discarded", () => {
    expect(guardCleanup("Can you check the betterstack incidents and tell me which are open?", "Sure — I'll check them now.").guarded).toBe(true);
  });
  test("a cleanup that keeps the message but appends a reply is discarded", () => {
    const raw = "Can you check the betterstack incidents and tell me which are open?";
    expect(guardCleanup(raw, `${raw}\n\nSure, I'll look at them now and report back.`).guarded).toBe(true);
  });
  test("a multi-word term fix is not an addition", () => {
    expect(guardCleanup("Run the PR triage skill if and only if CI is green for Claude Dash P.", "Run the pr-triage skill iff CI is green for claude -p.").guarded).toBe(false);
  });
  test("a single-term fix in a short dictation is not a loss", () => {
    expect(guardCleanup("Can you check the Betsec incidents?", "Can you check the betterstack incidents?").guarded).toBe(false);
  });
  test("an empty cleanup is guarded", () => {
    expect(guardCleanup("run the tests", "  ")).toEqual({ final: "run the tests", guarded: true });
  });
});

describe("buildContext", () => {
  const turns: TranscriptTurn[] = [
    { role: "user", content: [{ type: "text", text: "add LinkedIn identifiers to the DNC table" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/core/dnc-sync.ts" } }, { type: "text", text: "Done — dnc-sync.ts now derives contacts." }] },
  ];
  const ctx = buildContext({ repo: "throxy", branch: "dnc-linkedin", skills: ["pr-triage"], turns, personal: ["Maestro", "EmailBison", "throxy"] });

  test("session terms come before personal terms, deduped", () => {
    expect(ctx.vocab).toEqual(["throxy", "dnc-linkedin", "pr-triage", "dnc-sync.ts", "Maestro", "EmailBison"]);
    expect(ctx.sttVocab).toEqual(ctx.vocab);
  });
  test("recent prose keeps turn order, newest last", () => {
    expect(ctx.recent).toBe("user: add LinkedIn identifiers to the DNC table\n\nassistant: Done — dnc-sync.ts now derives contacts.");
  });
  test("the transcription vocabulary is capped; cleanup's is not", () => {
    const personal = Array.from({ length: 300 }, (_, i) => `term${i}`);
    const big = buildContext({ skills: [], turns: [], personal });
    expect(big.sttVocab.length).toBe(120);
    expect(big.vocab.length).toBe(300);
  });
});

describe("corrections", () => {
  test("a short swap you typed over the dictation is a correction", () => {
    expect(corrections("Can you check and handle the Betsec incidents that have just appeared?", "Can you check and handle the betterstack incidents that have just appeared?")).toEqual([
      { heard: "Betsec", meant: "betterstack" },
    ]);
  });
  test("restructuring a dictated message into a list proposes no corrections", () => {
    const raw = "Um, questions. Number one is, are you using the right styles? The correct styles for the button, for the microphone button, has this plus icon. And three is, what model are you using?";
    const sent = "questions:\n1. are you using the right styles? That is the correct styles for the microphone button as the plus icon.\n3. what model are you using?";
    expect(corrections(raw, sent)).toEqual([]);
  });
  test("additions, case/punctuation-only edits and long rewrites are not corrections", () => {
    expect(corrections("run the tests", "run the tests, then open a PR")).toEqual([]);
    expect(corrections("portkey works.", "Portkey works")).toEqual([]);
    // a tense or plural fix is grammar, not a mis-heard term (a Haiku term check passed this one)
    expect(corrections("I think it works, but", "I think it worked, but")).toEqual([]);
    expect(corrections("the test passes now", "the tests passed now")).toEqual([]);
    expect(corrections("we should probably move this over to the other service", "we should merge it")).toEqual([]);
  });
  test("repeats bump the count and the newest leads", () => {
    const a = mergeCorrections([], [{ heard: "Betsec", meant: "betterstack" }], 1);
    const b = mergeCorrections(a, [{ heard: "Pettystack", meant: "betterstack" }, { heard: "betsec", meant: "BetterStack" }], 2);
    expect(b.map((c) => [c.heard, c.count])).toEqual([["betsec", 2], ["Pettystack", 1]]);
  });
  test("corrected terms lead the vocabulary and reach cleanup as mis-hearings", () => {
    const ctx = buildContext({ repo: "throxy", skills: [], turns: [], personal: ["Maestro"], learned: [{ heard: "Betsec", meant: "betterstack", count: 1, at: 1 }] });
    expect(ctx.sttVocab.slice(0, 2)).toEqual(["betterstack", "throxy"]);
    expect(ctx.mishearings).toEqual(["Betsec → betterstack"]);
  });
});

describe("pending dictations", () => {
  const ctx = { vocab: [], sttVocab: [], recent: "", mishearings: [] };
  test("a cleanup id is single-use", () => {
    const id = rememberDictation({ sessionId: "s1", raw: "hello", ctx, mic: "" });
    expect(takeDictation(id)?.raw).toBe("hello");
    expect(takeDictation(id)).toBeNull();
  });
  test("entries older than ten minutes are swept on the next insert", () => {
    const old = rememberDictation({ sessionId: "s1", raw: "old", ctx, mic: "" }, 0);
    rememberDictation({ sessionId: "s1", raw: "new", ctx, mic: "" }, 11 * 60 * 1000);
    expect(takeDictation(old)).toBeNull();
  });
});
