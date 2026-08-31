import { test, expect } from "bun:test";
import { disambiguateNames, disambiguateByRepo } from "./session-label";

test("disambiguateNames: unique names map to themselves", () => {
  const m = disambiguateNames([
    { id: "a", name: "Fix Auth" },
    { id: "b", name: "Db Perf" },
  ]);
  expect(m.get("a")).toBe("Fix Auth");
  expect(m.get("b")).toBe("Db Perf");
});

test("disambiguateNames: two collisions → base + ' 2' ordered by id", () => {
  const m = disambiguateNames([
    { id: "b", name: "Fix Auth" },
    { id: "a", name: "Fix Auth" },
  ]);
  expect(m.get("a")).toBe("Fix Auth"); // lowest id keeps the base
  expect(m.get("b")).toBe("Fix Auth 2");
});

test("disambiguateNames: three collisions → ' 2', ' 3'", () => {
  const m = disambiguateNames([
    { id: "a", name: "x" },
    { id: "b", name: "x" },
    { id: "c", name: "x" },
  ]);
  expect(m.get("a")).toBe("x");
  expect(m.get("b")).toBe("x 2");
  expect(m.get("c")).toBe("x 3");
});

test("disambiguateNames: suffix assignment is independent of input order", () => {
  const forward = disambiguateNames([
    { id: "a", name: "x" },
    { id: "b", name: "x" },
  ]);
  const reversed = disambiguateNames([
    { id: "b", name: "x" },
    { id: "a", name: "x" },
  ]);
  expect(forward.get("a")).toBe(reversed.get("a"));
  expect(forward.get("b")).toBe(reversed.get("b"));
});

test("disambiguateNames: suffix skips a name that already exists literally", () => {
  // Two "x" collide; a third session is literally named "x 2" already.
  const m = disambiguateNames([
    { id: "a", name: "x" },
    { id: "b", name: "x" },
    { id: "c", name: "x 2" },
  ]);
  expect(m.get("a")).toBe("x");
  expect(m.get("c")).toBe("x 2"); // pre-existing literal keeps its name
  expect(m.get("b")).toBe("x 3"); // suffix bumps past the taken "x 2"
  // all labels unique
  expect(new Set([m.get("a"), m.get("b"), m.get("c")]).size).toBe(3);
});

test("disambiguateNames: same id repeated is not a collision (no suffix)", () => {
  // The same session can surface on two panes; identical id+name must not suffix.
  const m = disambiguateNames([
    { id: "a", name: "transcript-summary" },
    { id: "a", name: "transcript-summary" },
  ]);
  expect(m.get("a")).toBe("transcript-summary");
});

test("disambiguateNames: empty names are never suffixed", () => {
  const m = disambiguateNames([
    { id: "a", name: "" },
    { id: "b", name: "" },
  ]);
  expect(m.get("a")).toBe("");
  expect(m.get("b")).toBe("");
});

test("disambiguateByRepo: collisions suffix within a repo, never across repos", () => {
  const out = disambiguateByRepo([
    { id: "a", name: "Fix Auth", repo: "r1" },
    { id: "b", name: "Fix Auth", repo: "r1" },
    { id: "c", name: "Fix Auth", repo: "r2" },
  ]);
  expect(out.get("a")).toBe("Fix Auth");
  expect(out.get("b")).toBe("Fix Auth 2");
  expect(out.get("c")).toBe("Fix Auth");
});
