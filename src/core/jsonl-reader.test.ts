import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlLines } from "./jsonl-reader";

async function collect(path: string): Promise<string[]> {
  const out: string[] = [];
  for await (const line of jsonlLines(path)) out.push(line);
  return out;
}

describe("jsonlLines", () => {
  test("round-trips lines exactly, including multi-byte characters split across chunk boundaries", async () => {
    // Big enough to guarantee multiple stream chunks, with multi-byte characters
    // densely packed so some inevitably straddle a chunk boundary.
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      lines.push(JSON.stringify({ i, text: `héllo — ⚡日本語テキスト ${i} 🚀` }));
    }
    const path = join(tmpdir(), `jsonl-lines-${Date.now()}.jsonl`);
    await Bun.write(path, lines.join("\n") + "\n");
    const got = await collect(path);
    // A trailing newline yields no final empty line (the empty carry is dropped).
    expect(got.length).toBe(lines.length);
    expect(got[0]).toBe(lines[0]);
    expect(got[12345]).toBe(lines[12345]);
    expect(got[lines.length - 1]).toBe(lines[lines.length - 1]);
  });

  test("a line spanning many chunks comes back whole, with its neighbours and blank lines intact", async () => {
    // A pasted image makes one transcript line tens of MB: it arrives in hundreds of chunks.
    const big = JSON.stringify({ image: "⚡a".repeat(400_000) });
    const path = join(tmpdir(), `jsonl-big-${Date.now()}.jsonl`);
    await Bun.write(path, `{"a":1}\n${big}\n\n{"b":2}\n`);
    const got = await collect(path);
    expect(got.length).toBe(4);
    expect(got[0]).toBe('{"a":1}');
    expect(got[1] === big).toBe(true);
    expect(got.slice(2)).toEqual(["", '{"b":2}']);
  });

  test("yields a final line with no trailing newline", async () => {
    const path = join(tmpdir(), `jsonl-tail-${Date.now()}.jsonl`);
    await Bun.write(path, '{"a":1}\n{"b":2}');
    expect(await collect(path)).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("early break stops the read without hanging", async () => {
    const path = join(tmpdir(), `jsonl-break-${Date.now()}.jsonl`);
    await Bun.write(path, Array.from({ length: 50_000 }, (_, i) => `{"i":${i}}`).join("\n"));
    let first = "";
    for await (const line of jsonlLines(path)) {
      first = line;
      break;
    }
    expect(first).toBe('{"i":0}');
  });

  test("missing file throws (callers catch and fall back)", async () => {
    expect(collect(join(tmpdir(), "jsonl-nope-does-not-exist.jsonl"))).rejects.toThrow();
  });
});
