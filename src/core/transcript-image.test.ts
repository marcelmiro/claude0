import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { readTranscriptImage } from "./transcript-image";

const id = "11111111-2222-3333-4444-555555555555";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/c0-tx-image-`);
  mkdirSync(`${dir}/-proj`);
  const lines = [
    { type: "user", uuid: "u-1", message: { content: [{ type: "text", text: "[Image #1] look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] } },
    { type: "assistant", uuid: "a-1", parentUuid: "u-1", message: { content: [{ type: "text", text: "nice" }] } },
    { type: "user", uuid: "u-2", message: { content: [{ type: "image", source: { type: "base64", media_type: "text/html", data: "PGI+" } }] } },
  ];
  writeFileSync(`${dir}/-proj/${id}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("reads the image bytes and media type at a ref", async () => {
  const img = await readTranscriptImage(id, "u-1/1", dir);
  expect(img?.mediaType).toBe("image/png");
  expect(Buffer.from(img!.bytes)).toEqual(png);
});

test("null for a non-image block, a missing record, a non-image media type, or a malformed ref", async () => {
  expect(await readTranscriptImage(id, "u-1/0", dir)).toBeNull(); // the text block
  expect(await readTranscriptImage(id, "u-9/1", dir)).toBeNull();
  expect(await readTranscriptImage(id, "u-2/0", dir)).toBeNull();
  expect(await readTranscriptImage(id, "../u-1/1", dir)).toBeNull();
  expect(await readTranscriptImage("66666666-7777-8888-9999-000000000000", "u-1/1", dir)).toBeNull();
});
