import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, parseTmuxKey, resolveRole, tmuxKeyProblem, tmuxKeys, validateConfig } from "./config";
import type { Config } from "../types";

function base(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

describe("ui.repoAbbreviations validation", () => {
  test("accepts a string map and passes it through", () => {
    const cfg = base();
    cfg.ui.repoAbbreviations = { claude0: "c0" };
    expect(validateConfig(cfg).ui.repoAbbreviations).toEqual({ claude0: "c0" });
  });

  test("rejects non-string and empty values", () => {
    const cfg = base() as unknown as { ui: { repoAbbreviations: unknown } };
    cfg.ui.repoAbbreviations = { claude0: 7 };
    expect(() => validateConfig(cfg)).toThrow("ui.repoAbbreviations.claude0");
    cfg.ui.repoAbbreviations = { claude0: "" };
    expect(() => validateConfig(cfg)).toThrow("ui.repoAbbreviations.claude0");
  });
});

describe("notifications.pushContact validation", () => {
  test("accepts a string and rejects non-strings", () => {
    const cfg = base();
    cfg.notifications.pushContact = "mailto:me@example.com";
    expect(validateConfig(cfg).notifications.pushContact).toBe("mailto:me@example.com");
    (cfg.notifications as { pushContact: unknown }).pushContact = 5;
    expect(() => validateConfig(cfg)).toThrow("notifications.pushContact");
  });
});

describe("tmux.keys", () => {
  test("accepts prefix and modified root-table specs", () => {
    const cfg = base();
    cfg.tmux = { keys: { popup: "prefix p", sidebarFocus: "C-M-s" } };
    expect(validateConfig(cfg).tmux?.keys).toEqual({ popup: "prefix p", sidebarFocus: "C-M-s" });
  });

  test("rejects an unmodified bare key in the root table", () => {
    const cfg = base();
    cfg.tmux = { keys: { popup: "a" } };
    expect(() => validateConfig(cfg)).toThrow("tmux.keys.popup");
  });

  test("rejects unknown key names and malformed specs", () => {
    const cfg = base() as unknown as { tmux: unknown };
    cfg.tmux = { keys: { bogus: "M-x" } };
    expect(() => validateConfig(cfg)).toThrow("tmux.keys");
    cfg.tmux = { keys: { popup: "prefix" } };
    expect(() => validateConfig(cfg)).toThrow("tmux.keys.popup");
  });

  test("tmuxKeyProblem allows F-keys and layered modifiers", () => {
    expect(tmuxKeyProblem("F5")).toBeNull();
    expect(tmuxKeyProblem("M-S")).toBeNull();
    expect(tmuxKeyProblem("C-M-x")).toBeNull();
    expect(tmuxKeyProblem("x")).not.toBeNull();
    expect(tmuxKeyProblem("prefix C-a")).toBeNull();
  });

  test("rejects key tokens that would re-tokenize the rendered bind-key line", () => {
    // Quotes, `;` and `\` land verbatim in the sourced tmux fragment — a bare `;`
    // key even runs the bound command immediately at source time.
    expect(tmuxKeyProblem("prefix ;")).not.toBeNull();
    expect(tmuxKeyProblem("prefix a'")).not.toBeNull();
    expect(tmuxKeyProblem("M-s'")).not.toBeNull();
    expect(tmuxKeyProblem('M-s"x')).not.toBeNull();
    expect(tmuxKeyProblem("M-\\")).not.toBeNull();
    // Modified keys stay valid in both tables.
    expect(tmuxKeyProblem("prefix C-a")).toBeNull();
    expect(tmuxKeyProblem("prefix Up")).toBeNull();
  });

  test("rejects two bindings colliding on the same table+key, defaults included", () => {
    const cfg = base();
    cfg.tmux = { keys: { popup: "prefix a", next: "prefix a" } };
    expect(() => validateConfig(cfg)).toThrow('popup and next both bind "prefix a"');
    // A user key colliding with another binding's DEFAULT is also a collision.
    cfg.tmux = { keys: { popup: "M-s" } };
    expect(() => validateConfig(cfg)).toThrow("sidebarFocus");
    // Same key in different tables is fine.
    cfg.tmux = { keys: { popup: "prefix s", sidebarFocus: "M-s" } };
    expect(validateConfig(cfg).tmux?.keys).toEqual({ popup: "prefix s", sidebarFocus: "M-s" });
  });

  test("parseTmuxKey splits table and key", () => {
    expect(parseTmuxKey("prefix a")).toEqual({ table: "prefix", key: "a" });
    expect(parseTmuxKey("M-s")).toEqual({ table: "root", key: "M-s" });
  });

  test("tmuxKeys fills defaults per key", () => {
    const cfg = base();
    cfg.tmux = { keys: { popup: "M-p" } };
    const keys = tmuxKeys(cfg);
    expect(keys.popup).toBe("M-p");
    expect(keys.next).toBe("prefix C-a");
    expect(keys.sidebarFocus).toBe("M-s");
    expect(tmuxKeys(null).popup).toBe("prefix a");
  });
});

describe("deployment.role", () => {
  test("round-trips through validateConfig and rejects bad values", () => {
    const cfg = base();
    cfg.deployment = { role: "host" };
    expect(validateConfig(cfg).deployment).toEqual({ role: "host" });
    (cfg.deployment as { role: unknown }).role = "server";
    expect(() => validateConfig(cfg)).toThrow("deployment.role");
    (cfg as unknown as { deployment: unknown }).deployment = { role: "host", extra: 1 };
    expect(() => validateConfig(cfg)).toThrow("deployment contains unknown");
  });

  test("resolveRole: configured value wins over inference", () => {
    const cfg = base();
    cfg.deployment = { role: "client" };
    expect(resolveRole(cfg, "linux")).toBe("client");
  });

  test("resolveRole inference: linux is the host", () => {
    expect(resolveRole(base(), "linux")).toBe("host");
  });

  test("resolveRole inference: a Mac pointed at a remote terminal is the client", () => {
    const cfg = base();
    cfg.terminal.defaultTarget = "remote";
    expect(resolveRole(cfg, "darwin")).toBe("client");
  });

  test("resolveRole inference: everything else is local", () => {
    expect(resolveRole(base(), "darwin")).toBe("local");
    expect(resolveRole(null, "darwin")).toBe("local");
  });
});
