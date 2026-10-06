import { homedir } from "os";
import { existsSync } from "fs";
import { basename, join } from "path";

/**
 * A slash-command the bridge composer can suggest. `name` is stored WITHOUT the
 * leading `/` (the UI prepends it). Sending `/${name} ` to a pane runs it — see the
 * live-verified note in the plan; the trailing space the UI adds closes Claude's own
 * native `/` autocomplete so the submit lands on the literal buffer.
 */
export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "plugin" | "user" | "project";
}

/**
 * Built-in Claude Code commands. These are NOT file-backed (they live in the binary),
 * so the common set is curated here. Descriptions are short — the disk skills carry the
 * long trigger-phrase descriptions.
 */
const BUILTIN_COMMANDS: Omit<SlashCommand, "source">[] = [
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "help", description: "Show help and available commands" },
  { name: "model", description: "Switch the active model" },
  { name: "effort", description: "Set reasoning effort" },
  { name: "cost", description: "Show token usage and cost for this session" },
  { name: "context", description: "Show the context-window breakdown" },
  { name: "resume", description: "Resume a previous conversation" },
  { name: "review", description: "Review a pull request" },
  { name: "config", description: "Open settings" },
  { name: "agents", description: "Manage subagents" },
  { name: "memory", description: "Edit Claude memory files" },
  { name: "export", description: "Export the conversation" },
  { name: "status", description: "Show session and account status" },
  { name: "init", description: "Initialize a CLAUDE.md for the codebase" },
];

/**
 * Parse the leading `---` YAML frontmatter block for `name`/`description`. Line-based
 * (first matching line wins) — multi-line/folded values keep only their first line,
 * which is fine for the one-line descriptions skills use. Returns {} when there's no
 * frontmatter.
 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^(name|description):\s*(.*)$/);
    if (m && out[m[1] as "name" | "description"] === undefined) {
      out[m[1] as "name" | "description"] = m[2].trim();
    }
  }
  return out;
}

/**
 * Enumerate skills + commands under a `.claude` dir or a plugin root (skips silently if
 * absent). Skills are `skills/<name>/SKILL.md` (case-insensitive filename) named by
 * their folder; commands are `commands/**\/*.md` named by their path (namespaced dirs
 * joined with `:`). Per-file failures are skipped; the whole thing never throws.
 */
async function readClaudeDir(
  claudeDir: string,
  source: "plugin" | "user" | "project",
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];

  const skillsDir = `${claudeDir}/skills`;
  if (existsSync(skillsDir)) {
    try {
      const glob = new Bun.Glob("*/*.md");
      // dot:true — user skill folders are commonly dot-prefixed (.cap, .fix-bug), which the
      // default glob would skip entirely.
      for await (const rel of glob.scan({ cwd: skillsDir, followSymlinks: true, dot: true })) {
        const [folder, file] = rel.split("/");
        if (!folder || file?.toLowerCase() !== "skill.md") continue; // ignore bundled refs
        try {
          const fm = parseFrontmatter(await Bun.file(`${skillsDir}/${rel}`).text());
          out.push({ name: folder, description: fm.description ?? "", source });
        } catch {}
      }
    } catch {}
  }

  const cmdDir = `${claudeDir}/commands`;
  if (existsSync(cmdDir)) {
    try {
      const glob = new Bun.Glob("**/*.md");
      for await (const rel of glob.scan({ cwd: cmdDir, followSymlinks: true, dot: true })) {
        const name = rel.replace(/\.md$/, "").split("/").join(":");
        try {
          const fm = parseFrontmatter(await Bun.file(`${cmdDir}/${rel}`).text());
          out.push({ name, description: fm.description ?? "", source });
        } catch {}
      }
    } catch {}
  }

  return out;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return (await Bun.file(path).json()) as T;
  } catch {
    return undefined;
  }
}

interface PluginManifest {
  name?: string;
  skills?: string | string[];
}

/**
 * Skills + commands of the plugins enabled in settings, named `<plugin>:<name>` as
 * Claude Code registers them. Enablement merges user → project → project-local
 * settings, so a later `false` disables; install paths come from
 * `plugins/installed_plugins.json`. Skill dirs listed in the manifest's `skills` add to
 * the default `skills/` scan — mattpocock-skills nests every skill a level deeper, so
 * the manifest is the only place its skills are found.
 */
async function readPlugins(claudeHome: string, projectDir?: string): Promise<SlashCommand[]> {
  const settingsFiles = [join(claudeHome, "settings.json")];
  if (projectDir) {
    settingsFiles.push(join(projectDir, ".claude", "settings.json"), join(projectDir, ".claude", "settings.local.json"));
  }
  const enabled: Record<string, boolean> = {};
  for (const file of settingsFiles) {
    Object.assign(enabled, (await readJson<{ enabledPlugins?: Record<string, boolean> }>(file))?.enabledPlugins);
  }
  const installed =
    (await readJson<{ plugins?: Record<string, { installPath: string }[]> }>(
      join(claudeHome, "plugins", "installed_plugins.json"),
    ))?.plugins ?? {};

  const out: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    const root = on ? installed[id]?.find((e) => existsSync(e.installPath))?.installPath : undefined;
    if (!root) continue;
    const manifest = await readJson<PluginManifest>(join(root, ".claude-plugin", "plugin.json"));
    const found = await readClaudeDir(root, "plugin");
    for (const rel of [manifest?.skills ?? []].flat()) {
      const dir = join(root, rel);
      try {
        const fm = parseFrontmatter(await Bun.file(join(dir, "SKILL.md")).text());
        found.push({ name: basename(dir), description: fm.description ?? "", source: "plugin" });
      } catch {}
    }
    const plugin = manifest?.name ?? id.split("@")[0];
    for (const c of found) out.push({ ...c, name: `${plugin}:${c.name}` });
  }
  return out;
}

/**
 * The slash-commands available to a session: built-in defaults + enabled plugins'
 * skills/commands + the user's global skills/commands (`~/.claude`) + (when
 * `projectDir` is given) that repo's project skills/commands. Merged with precedence
 * project > user > plugin > builtin — a later source shadows an earlier one of the same
 * name, keeping one row.
 */
export async function listSlashCommands(
  projectDir?: string,
  claudeHome = join(homedir(), ".claude"),
): Promise<SlashCommand[]> {
  const builtin: SlashCommand[] = BUILTIN_COMMANDS.map((c) => ({ ...c, source: "builtin" }));
  const plugin = await readPlugins(claudeHome, projectDir);
  const user = await readClaudeDir(claudeHome, "user");
  const project = projectDir ? await readClaudeDir(`${projectDir}/.claude`, "project") : [];

  const byName = new Map<string, SlashCommand>();
  for (const c of [...builtin, ...plugin, ...user, ...project]) byName.set(c.name, c);
  return [...byName.values()];
}
