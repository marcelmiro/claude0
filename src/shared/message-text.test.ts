import { expect, test } from "bun:test";
import { attachedFileNames, stripAttachmentPrefix, withFileRefs, withSkill } from "./message-text.js";

const A = "/home/u/.config/claude0/uploads/1b2c/report.pdf";
const B = "/home/u/.config/claude0/uploads/9f8e/notes.txt";

test("withFileRefs: refs lead the caption; a files-only message never starts with a bare path", () => {
  expect(withFileRefs("summarize these", [A, B])).toBe(`[File: ${A}] [File: ${B}] summarize these`);
  expect(withFileRefs("", [A])).toBe(`[File: ${A}]`);
  expect(withFileRefs("just text", [])).toBe("just text");
});

test("stripAttachmentPrefix: drops image markers and file refs, in either mix", () => {
  expect(stripAttachmentPrefix(`[Image #1] [File: ${A}] what is this`)).toBe("what is this");
  expect(stripAttachmentPrefix(`[File: ${A}]`)).toBe("");
  expect(stripAttachmentPrefix("[Image #2] caption")).toBe("caption");
  // only a LEADING run is an attachment prefix
  expect(stripAttachmentPrefix(`see [File: ${A}]`)).toBe(`see [File: ${A}]`);
});

test("attachedFileNames: the names of the leading file refs", () => {
  expect(attachedFileNames(`[Image #1] [File: ${A}] [File: ${B}] hi`)).toEqual(["report.pdf", "notes.txt"]);
  expect(attachedFileNames("no attachments")).toEqual([]);
  expect(attachedFileNames("[Image #1] caption")).toEqual([]);
});

test("withSkill: the skill goes in front, the draft becomes its arguments, a leading command is replaced", () => {
  expect(withSkill("", "/compact")).toBe("/compact ");
  expect(withSkill("keep the API notes", "/compact")).toBe("/compact keep the API notes");
  expect(withSkill("/compact keep notes", "/pr-triage")).toBe("/pr-triage keep notes");
  expect(withSkill("see src/foo", "/compact")).toBe("/compact see src/foo"); // a mid-text path is not a command
});
