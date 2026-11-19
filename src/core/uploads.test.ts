import "../../test/helpers/home";
import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { PATHS } from "./config";
import { safeUploadName, saveUploadedFile } from "./uploads";

test("safeUploadName keeps a readable name but nothing that can escape or break a [File: …] ref", () => {
  expect(safeUploadName("report.pdf")).toBe("report.pdf");
  expect(safeUploadName("Q3 plan [final].docx")).toBe("Q3-plan-final-.docx");
  expect(safeUploadName("../../etc/passwd")).toBe("passwd");
  expect(safeUploadName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
  expect(safeUploadName(".env")).toBe("env");
  expect(safeUploadName("--help")).toBe("help");
  expect(safeUploadName("")).toBe("file");
  expect(safeUploadName(`${"a".repeat(300)}.json`)).toHaveLength(100);
  expect(safeUploadName(`${"a".repeat(300)}.json`).endsWith(".json")).toBe(true);
});

test("saveUploadedFile writes <uploads>/<uuid>/<safe name>, private to this account", async () => {
  const path = await saveUploadedFile(new TextEncoder().encode("hello"), "my notes.txt");
  expect(path).toMatch(new RegExp(`^${PATHS.uploads}/[0-9a-f-]{36}/my-notes\\.txt$`));
  expect(readFileSync(path, "utf8")).toBe("hello");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(path.slice(0, path.lastIndexOf("/"))).mode & 0o777).toBe(0o700);
});
