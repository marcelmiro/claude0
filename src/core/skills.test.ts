/**
 * Slash-command enumeration. Exercised through the public `listSlashCommands` with a
 * throwaway project dir as the `project` source — this covers frontmatter parsing,
 * command namespacing, source precedence, and builtins without depending on whatever
 * happens to live in the real `~/.claude`.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSlashCommands } from "./skills";

let PROJ: string;
let HOME: string;

beforeAll(() => {
  PROJ = mkdtempSync(join(tmpdir(), "c0-skills-"));
  const skills = join(PROJ, ".claude", "skills");
  const cmds = join(PROJ, ".claude", "commands");
  mkdirSync(skills, { recursive: true });
  mkdirSync(join(cmds, "git"), { recursive: true });

  // (a) normal skill with frontmatter
  mkdirSync(join(skills, "my-skill"));
  writeFileSync(
    join(skills, "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: Do a specific thing\n---\n\nbody\n",
  );
  // (e) missing description → "" ; (a) name still parses
  mkdirSync(join(skills, "bare-skill"));
  writeFileSync(join(skills, "bare-skill", "SKILL.md"), "---\nname: bare-skill\n---\nbody\n");
  // multi-line description → only the first line is kept (locks line-based behavior)
  mkdirSync(join(skills, "wordy"));
  writeFileSync(
    join(skills, "wordy", "SKILL.md"),
    "---\nname: wordy\ndescription: First line here\n  continued second line\n---\nbody\n",
  );
  // lowercase filename is still recognized; bundled ref .md in a subdir is ignored
  mkdirSync(join(skills, "lower"));
  writeFileSync(join(skills, "lower", "skill.md"), "---\nname: lower\ndescription: lc\n---\n");
  mkdirSync(join(skills, "lower", "references"));
  writeFileSync(join(skills, "lower", "references", "extra.md"), "not a skill\n");
  // dot-prefixed skill folder must be enumerated (default glob skips dotfiles)
  mkdirSync(join(skills, ".dotted"));
  writeFileSync(join(skills, ".dotted", "SKILL.md"), "---\nname: .dotted\ndescription: hidden dir\n---\n");
  // (c) project skill named "compact" shadows the builtin of the same name
  mkdirSync(join(skills, "compact"));
  writeFileSync(join(skills, "compact", "SKILL.md"), "---\nname: compact\ndescription: PROJECT compact\n---\n");

  // (b) namespaced command → dir:name ; flat command
  writeFileSync(join(cmds, "sync.md"), "---\nname: sync\ndescription: sync it\n---\nprompt\n");
  writeFileSync(join(cmds, "git", "amend.md"), "---\ndescription: amend last commit\n---\nprompt\n");

  // Plugins: a throwaway claudeHome with one plugin per enablement case. `demo` has a
  // default-dir skill, a manifest-listed nested skill and a command; `off` is disabled in
  // user settings; `proj-off` is enabled for the user but disabled by the project.
  HOME = mkdtempSync(join(tmpdir(), "c0-home-"));
  const plugin = (id: string, files: Record<string, string>) => {
    const root = join(HOME, "plugins", "cache", id);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return { installPath: root };
  };
  const installed = {
    "demo@mk": [
      plugin("demo", {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "demo", skills: ["./skills/group/nested"] }),
        "skills/top/SKILL.md": "---\nname: top\ndescription: default-dir skill\n---\n",
        "skills/group/nested/SKILL.md": "---\nname: nested\ndescription: manifest-listed skill\n---\n",
        "commands/run.md": "---\ndescription: plugin command\n---\n",
      }),
    ],
    "off@mk": [plugin("off", { "skills/gone/SKILL.md": "---\nname: gone\n---\n" })],
    "proj-off@mk": [plugin("proj-off", { "skills/hidden/SKILL.md": "---\nname: hidden\n---\n" })],
  };
  writeFileSync(join(HOME, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
  writeFileSync(
    join(HOME, "settings.json"),
    JSON.stringify({ enabledPlugins: { "demo@mk": true, "off@mk": false, "proj-off@mk": true } }),
  );
  writeFileSync(join(PROJ, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "proj-off@mk": false } }));
});

afterAll(() => {
  rmSync(PROJ, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

test("parses name/description from skill frontmatter", async () => {
  const list = await listSlashCommands(PROJ);
  const s = list.find((c) => c.name === "my-skill");
  expect(s).toEqual({ name: "my-skill", description: "Do a specific thing", source: "project" });
});

test("missing description falls back to empty string without throwing", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "bare-skill")?.description).toBe("");
});

test("multi-line description keeps only the first line", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "wordy")?.description).toBe("First line here");
});

test("recognizes lowercase skill.md and ignores bundled reference .md files", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "lower")?.description).toBe("lc");
  expect(list.some((c) => c.name === "extra")).toBe(false);
});

test("command filename becomes the name; namespaced dirs join with ':'", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === "sync")?.description).toBe("sync it");
  const amend = list.find((c) => c.name === "git:amend");
  expect(amend).toEqual({ name: "git:amend", description: "amend last commit", source: "project" });
});

test("enumerates dot-prefixed skill folders (e.g. .cap)", async () => {
  const list = await listSlashCommands(PROJ);
  expect(list.find((c) => c.name === ".dotted")?.description).toBe("hidden dir");
});

test("builtins are always present", async () => {
  const list = await listSlashCommands();
  expect(list.some((c) => c.name === "help" && c.source === "builtin")).toBe(true);
  expect(list.some((c) => c.name === "clear" && c.source === "builtin")).toBe(true);
});

test("project source shadows a builtin of the same name (one row, project wins)", async () => {
  const list = await listSlashCommands(PROJ);
  const compacts = list.filter((c) => c.name === "compact");
  expect(compacts).toHaveLength(1);
  expect(compacts[0]).toEqual({ name: "compact", description: "PROJECT compact", source: "project" });
});

test("enabled plugins contribute <plugin>:<name> skills from skills/, the manifest, and commands/", async () => {
  const list = await listSlashCommands(PROJ, HOME);
  const plugins = list.filter((c) => c.source === "plugin").sort((a, b) => a.name.localeCompare(b.name));
  expect(plugins).toEqual([
    { name: "demo:nested", description: "manifest-listed skill", source: "plugin" },
    { name: "demo:run", description: "plugin command", source: "plugin" },
    { name: "demo:top", description: "default-dir skill", source: "plugin" },
  ]);
});

test("a plugin disabled in user settings, or by the project's, contributes nothing", async () => {
  const names = (await listSlashCommands(PROJ, HOME)).map((c) => c.name);
  expect(names).not.toContain("off:gone");
  expect(names).not.toContain("proj-off:hidden");
  expect(names).toContain("my-skill"); // unchanged: project skills still listed alongside plugins
});
