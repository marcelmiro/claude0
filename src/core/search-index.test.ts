import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { SEARCH_DB, cutSnippet, ftsQuery, indexOnce, indexProgress, searchIndex } from "./search-index";

let projects: string;
const ID = "11111111-1111-1111-1111-111111111111";
const FORK = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  projects = mkdtempSync(`${tmpdir()}/c0-index-`);
  mkdirSync(`${projects}/-home-x-dev-repo`);
  for (const s of ["", "-wal", "-shm"]) rmSync(`${SEARCH_DB}${s}`, { force: true });
});
afterEach(() => {
  rmSync(projects, { recursive: true, force: true });
});

const file = (id = ID) => `${projects}/-home-x-dev-repo/${id}.jsonl`;
const user = (text: string, sessionId = ID) => JSON.stringify({ type: "user", sessionId, message: { role: "user", content: text } });
const reply = (text: string, sessionId = ID) =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    message: { role: "assistant", content: [{ type: "thinking", thinking: "secretthought" }, { type: "text", text }, { type: "tool_use", id: "t", name: "Bash", input: { command: "toolinputword" } }] },
  });
const toolResult = (text: string) =>
  JSON.stringify({ type: "user", sessionId: ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] } });
const index = () => indexOnce({ projectsDir: projects });
const hits = (word: string) => [...(searchIndex.hits(word) ?? [])];

test("prose is indexed; tool traffic and thinking are not", async () => {
  writeFileSync(file(), [user("please fix the zeppelin"), reply("fixed the zeppelin mooring"), toolResult("tooloutputword")].join("\n") + "\n");
  await index();
  expect(hits("zeppelin")).toEqual([ID]);
  expect(hits("moor")).toEqual([ID]); // prefix
  expect(hits("tooloutputword")).toEqual([]);
  expect(hits("toolinputword")).toEqual([]);
  expect(hits("secretthought")).toEqual([]);
  expect(searchIndex.snippet(ID, "mooring")).toContain("zeppelin mooring");
});

test("appends are read from the byte offset; an unterminated line waits for its newline", async () => {
  writeFileSync(file(), `${user("café première ünïcode 🚀 alpha")}\n${user("half-written bravo")}`);
  await index();
  expect(hits("alpha")).toEqual([ID]);
  expect(hits("bravo")).toEqual([]); // no newline yet
  appendFileSync(file(), `\n${user("charlie")}\n`);
  await index();
  expect(hits("bravo")).toEqual([ID]);
  expect(hits("charlie")).toEqual([ID]);
  // each record indexed once despite the multi-byte text before the offset
  const db = new Database(SEARCH_DB, { readonly: true });
  const text = db.query<{ t: string }, []>("SELECT group_concat(text, ' ') AS t FROM prose").get()!.t;
  db.close();
  expect(text.match(/alpha/g)).toHaveLength(1);
  expect(text.match(/bravo/g)).toHaveLength(1);
});

test("a replaced file (new inode) is re-indexed from scratch", async () => {
  writeFileSync(file(), `${user("oldword")}\n`);
  await index();
  const tmp = `${projects}/replacement`;
  writeFileSync(tmp, `${user("newword and more text so the size grows")}\n`);
  renameSync(tmp, file());
  await index();
  expect(hits("oldword")).toEqual([]);
  expect(hits("newword")).toEqual([ID]);
});

test("a shrunk file is re-indexed; a vanished file's rows are dropped", async () => {
  writeFileSync(file(), `${user("firstword")}\n${user("secondword")}\n`);
  await index();
  writeFileSync(file(), `${user("third")}\n`); // same inode, smaller
  await index();
  expect(hits("firstword")).toEqual([]);
  expect(hits("third")).toEqual([ID]);
  rmSync(file());
  expect((await index()).dropped).toBe(1);
  expect(hits("third")).toEqual([]);
});

test("a fork's copied parent records are skipped (the parent's file holds them)", async () => {
  writeFileSync(file(FORK), `${user("parentword", ID)}\n${user("forkword", FORK)}\n`);
  await index();
  expect(hits("parentword")).toEqual([]);
  expect(hits("forkword")).toEqual([FORK]);
});

test("progress reads 0 before the first pass and null once built", async () => {
  expect(indexProgress()).toBe(0);
  writeFileSync(file(), `${user("x")}\n`);
  await index();
  expect(indexProgress()).toBeNull();
});

test("a schema version change rebuilds the file", async () => {
  writeFileSync(file(), `${user("keepword")}\n`);
  await index();
  const db = new Database(SEARCH_DB);
  db.run("UPDATE meta SET value = 'old' WHERE key = 'schema_version'");
  db.run("DELETE FROM prose");
  db.close();
  await index();
  expect(hits("keepword")).toEqual([ID]);
});

test("ftsQuery: punctuation splits into a phrase; a 1-character last run makes it exact", () => {
  expect(ftsQuery("th")).toBe('"th"*');
  expect(ftsQuery("eng-2687")).toBe('"eng 2687"*');
  expect(ftsQuery("gpt-4")).toBe('"gpt 4"');
  expect(ftsQuery("don't")).toBe('"don t"');
  expect(ftsQuery("c++")).toBeNull();
  expect(ftsQuery("a")).toBeNull();
  expect(ftsQuery("--")).toBeNull();
});

test("cutSnippet: ±40 characters around the first token-prefix hit", () => {
  const text = `${"a ".repeat(40)}the ENG-2687 ticket ${"b ".repeat(40)}`;
  const s = cutSnippet(text, "eng-2687")!;
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s).toContain("ENG-2687 ticket");
  expect(cutSnippet("rethink", "th")).toBeUndefined(); // not at a token start
  expect(cutSnippet("tried gpt-45, then gpt-4 itself", "gpt-4")).toContain("then gpt-4"); // exact: not gpt-45
});

test("a short last run matches the exact phrase in the index", async () => {
  writeFileSync(file(), `${user("we tried gpt-4 here")}\n${user("and gpt-45 there", FORK)}\n`);
  writeFileSync(file(FORK), `${user("only gpt-45 here", FORK)}\n`);
  await index();
  expect(hits("gpt-4")).toEqual([ID]);
});

test("no projects dir yet is an empty corpus, and the build still completes", async () => {
  const r = await indexOnce({ projectsDir: `${projects}/missing` });
  expect(r.files).toBe(0);
  expect(indexProgress()).toBeNull();
});

test("a corrupt index file is rebuilt", async () => {
  writeFileSync(SEARCH_DB, "not a database ".repeat(100));
  writeFileSync(file(), `${user("survivor")}\n`);
  await index();
  expect(hits("survivor")).toEqual([ID]);
});
