import { homedir } from "os";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import type { Config, DeploymentRole, TmuxKeys } from "../types";

// CLAUDE0_HOME overrides the home root (tests point it at a temp dir; bun's
// os.homedir() ignores a runtime-set $HOME, so an env seam is the reliable hook).
const CONFIG_DIR = `${process.env.CLAUDE0_HOME ?? homedir()}/.config/claude0`;

export const PATHS = {
  dir: CONFIG_DIR,
  config: `${CONFIG_DIR}/config.json`,
  configSchema: `${CONFIG_DIR}/config.schema.json`,
  state: `${CONFIG_DIR}/state.json`,
  uploads: `${CONFIG_DIR}/uploads`, // images uploaded from the mobile bridge, pasted into a pane
} as const;

/**
 * Complete defaults — the single source for fresh-config generation, per-key
 * fallbacks at points of use, and the missing-key merge in `ensureUserConfig`.
 * Lives in code (not a shipped JSON file) so a code fallback and the written
 * template can never drift apart.
 */
export const DEFAULT_CONFIG = {
  $schema: "./config.schema.json",
  schemaVersion: 1,
  repositories: {
    roots: ["~/dev"],
    priority: [],
  },
  terminal: {
    defaultTarget: "local",
    remoteHost: null,
    localSession: "main",
    remoteSession: "main",
  },
  ui: {
    statusMonitor: true,
    windowPrefix: true,
    repoAbbreviations: {},
  },
  notifications: {
    native: true,
    terminalBundleId: "com.mitchellh.ghostty",
    // "" ⇒ derive from `git config user.email` at point of use
    pushContact: "",
  },
  tmux: {
    keys: {
      popup: "prefix a",
      next: "prefix C-a",
      sidebarFocus: "M-s",
      sidebarToggle: "M-S",
    },
  },
} satisfies Config;
/**
 * Write `text` to `path` atomically (tmp→rename) so a concurrent reader never
 * sees a half-written file. Shared by every state-file writer under PATHS.dir.
 * Throws on failure — callers decide whether that's fatal.
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function cloneDefault(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsAt(value: unknown, path: string, { nonEmpty = false } = {}): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (nonEmpty && item.length === 0))) {
    throw new Error(`${path} must be an array of${nonEmpty ? " non-empty" : ""} strings`);
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${path} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);
}

/** Validate the complete v1 file. Config mistakes are surfaced, never silently defaulted. */
export function validateConfig(value: unknown): Config {
  if (!isObject(value)) throw new Error("config must be a JSON object");
  onlyKeys(value, ["$schema", "schemaVersion", "deployment", "repositories", "terminal", "ui", "notifications", "tmux"], "config");
  if (value.schemaVersion !== 1) throw new Error(`schemaVersion must be 1 (received ${String(value.schemaVersion)})`);
  if (value.$schema !== undefined && typeof value.$schema !== "string") throw new Error("$schema must be a string");

  // Optional on purpose, and deliberately NOT in DEFAULT_CONFIG: the missing-key
  // merge would stamp role "local" onto a machine whose real role is inferred
  // differently. Absent ⇒ resolveRole infers at point of use.
  let deployment: Config["deployment"];
  if (value.deployment !== undefined) {
    if (!isObject(value.deployment)) throw new Error("deployment must be an object");
    onlyKeys(value.deployment, ["role"], "deployment");
    const role = value.deployment.role;
    if (role !== "local" && role !== "host" && role !== "client") {
      throw new Error('deployment.role must be "local", "host" or "client"');
    }
    deployment = { role };
  }

  if (!isObject(value.repositories)) throw new Error("repositories must be an object");
  onlyKeys(value.repositories, ["roots", "priority"], "repositories");
  const roots = stringsAt(value.repositories.roots, "repositories.roots", { nonEmpty: true });
  if (roots.length === 0) throw new Error("repositories.roots must contain at least one directory");
  const priority = stringsAt(value.repositories.priority, "repositories.priority", { nonEmpty: true });

  if (!isObject(value.terminal)) throw new Error("terminal must be an object");
  onlyKeys(value.terminal, ["defaultTarget", "remoteHost", "localSession", "remoteSession"], "terminal");
  if (value.terminal.defaultTarget !== "local" && value.terminal.defaultTarget !== "remote") {
    throw new Error('terminal.defaultTarget must be "local" or "remote"');
  }
  if (value.terminal.remoteHost !== null && typeof value.terminal.remoteHost !== "string") {
    throw new Error("terminal.remoteHost must be a string or null");
  }

  if (!isObject(value.ui)) throw new Error("ui must be an object");
  onlyKeys(value.ui, ["statusMonitor", "windowPrefix", "repoAbbreviations"], "ui");
  const repoAbbreviations = value.ui.repoAbbreviations;
  if (repoAbbreviations !== undefined) {
    if (!isObject(repoAbbreviations)) throw new Error("ui.repoAbbreviations must be an object");
    for (const [repo, short] of Object.entries(repoAbbreviations)) {
      if (typeof short !== "string" || short.length === 0) {
        throw new Error(`ui.repoAbbreviations.${repo} must be a non-empty string`);
      }
    }
  }
  if (!isObject(value.notifications)) throw new Error("notifications must be an object");
  onlyKeys(value.notifications, ["native", "terminalBundleId", "pushContact"], "notifications");
  // Optional on purpose ($schema precedent): absent falls back to the Ghostty default
  // at the point of use; "" is a real value meaning "no -activate on click".
  if (value.notifications.terminalBundleId !== undefined && typeof value.notifications.terminalBundleId !== "string") {
    throw new Error("notifications.terminalBundleId must be a string");
  }
  // Absent or "" ⇒ derive from `git config user.email` at point of use.
  if (value.notifications.pushContact !== undefined && typeof value.notifications.pushContact !== "string") {
    throw new Error("notifications.pushContact must be a string");
  }
  let tmux: Config["tmux"];
  if (value.tmux !== undefined) {
    if (!isObject(value.tmux)) throw new Error("tmux must be an object");
    onlyKeys(value.tmux, ["keys"], "tmux");
    if (value.tmux.keys !== undefined) {
      if (!isObject(value.tmux.keys)) throw new Error("tmux.keys must be an object");
      const names = ["popup", "next", "sidebarFocus", "sidebarToggle"];
      onlyKeys(value.tmux.keys, names, "tmux.keys");
      for (const name of names) {
        const spec = value.tmux.keys[name];
        if (spec === undefined) continue;
        if (typeof spec !== "string") throw new Error(`tmux.keys.${name} must be a string`);
        const problem = tmuxKeyProblem(spec);
        if (problem) throw new Error(`tmux.keys.${name}: ${problem}`);
      }
      tmux = { keys: value.tmux.keys as NonNullable<Config["tmux"]>["keys"] };
    } else {
      tmux = {};
    }
  }
  if (tmux?.keys) {
    // Collisions are checked on the RESOLVED set: a user key can also collide with
    // another binding's default (e.g. popup "M-s" vs sidebarFocus's default "M-s").
    // tmux keeps only the last bind for a table+key, so a collision would silently
    // disable one of the two actions.
    const resolved = tmuxKeys({ ...DEFAULT_CONFIG, tmux });
    const byBind = new Map<string, string>();
    for (const [name, spec] of Object.entries(resolved)) {
      const parsed = parseTmuxKey(spec);
      const bind = `${parsed.table} ${parsed.key}`;
      const other = byBind.get(bind);
      if (other) throw new Error(`tmux.keys: ${other} and ${name} both bind "${spec}"`);
      byBind.set(bind, name);
    }
  }

  return {
    ...(value.$schema === undefined ? {} : { $schema: value.$schema }),
    schemaVersion: 1,
    ...(deployment === undefined ? {} : { deployment }),
    repositories: { roots, priority },
    terminal: {
      defaultTarget: value.terminal.defaultTarget,
      remoteHost: value.terminal.remoteHost,
      localSession: stringAt(value.terminal.localSession, "terminal.localSession"),
      remoteSession: stringAt(value.terminal.remoteSession, "terminal.remoteSession"),
    },
    ui: {
      statusMonitor: booleanAt(value.ui.statusMonitor, "ui.statusMonitor"),
      windowPrefix: booleanAt(value.ui.windowPrefix, "ui.windowPrefix"),
      ...(repoAbbreviations === undefined ? {} : { repoAbbreviations: repoAbbreviations as Record<string, string> }),
    },
    notifications: {
      native: booleanAt(value.notifications.native, "notifications.native"),
      ...(value.notifications.terminalBundleId === undefined
        ? {}
        : { terminalBundleId: value.notifications.terminalBundleId }),
      ...(value.notifications.pushContact === undefined ? {} : { pushContact: value.notifications.pushContact }),
    },
    ...(tmux === undefined ? {} : { tmux }),
  };
}

/**
 * Validate a tmux key spec ("prefix a" ⇒ prefix table, bare "M-s" ⇒ root table).
 * Returns a problem description, or null when valid. A bare unmodified key in the
 * root table is rejected: `bind-key -n a` would swallow every literal `a` typed
 * into any pane. Key tokens are limited to letters/digits — which covers named keys
 * (Up, Space, BSpace, F5, …) — because quotes, `;` and `\` re-tokenize the rendered
 * `bind-key` line when tmux sources the fragment (a bare `;` key even turns the
 * bound command into one that runs immediately at source time).
 */
const KEY_TOKEN = /^[A-Za-z0-9]+$/;
/** Modifiers stripped, is the remaining key name letters/digits only? */
function safeKeyToken(key: string): boolean {
  return KEY_TOKEN.test(key.replace(/^(?:[MCS]-)+/, ""));
}
export function tmuxKeyProblem(spec: string): string | null {
  const parts = spec.trim().split(/\s+/);
  if (parts.length === 2 && parts[0] === "prefix") {
    if (!parts[1]) return 'missing key after "prefix"';
    return safeKeyToken(parts[1]) ? null : `key "${parts[1]}" may only use modifiers plus letters/digits (named keys like Up/BSpace/F5 included)`;
  }
  if (parts.length !== 1 || !parts[0]) return 'must be "prefix <key>" or a modified root-table key like "M-s"';
  const key = parts[0];
  if (/^F\d{1,2}$/i.test(key)) return null;
  if (/^(?:[MCS]-)+/.test(key)) {
    return safeKeyToken(key) ? null : `key "${key}" may only use modifiers plus letters/digits (named keys like Up/BSpace/F5 included)`;
  }
  return `root-table binding "${key}" needs a modifier (e.g. "M-${key}") — an unmodified key would swallow that character in every pane; use "prefix ${key}" for a prefixed binding`;
}

/** Parse a validated tmux key spec into its bind table + key. */
export function parseTmuxKey(spec: string): { table: "prefix" | "root"; key: string } {
  const problem = tmuxKeyProblem(spec);
  if (problem) throw new Error(`invalid tmux key "${spec}": ${problem}`);
  const parts = spec.trim().split(/\s+/);
  return parts.length === 2 ? { table: "prefix", key: parts[1]! } : { table: "root", key: parts[0]! };
}

/** Resolved tmux.keys with defaults filled per key. */
export function tmuxKeys(config: Config | null): TmuxKeys {
  const defaults = DEFAULT_CONFIG.tmux.keys;
  const user = config?.tmux?.keys ?? {};
  return {
    popup: user.popup ?? defaults.popup,
    next: user.next ?? defaults.next,
    sidebarFocus: user.sidebarFocus ?? defaults.sidebarFocus,
    sidebarToggle: user.sidebarToggle ?? defaults.sidebarToggle,
  };
}

/**
 * This machine's deployment role: the configured value when present, otherwise
 * inferred — linux runs the host; a Mac pointed at a remote terminal is the
 * client at the desk; anything else is the single-machine local deployment.
 * The inference is a point-of-use default (never merged into config.json);
 * writing `deployment.role` explicitly freezes it.
 */
export function resolveRole(config: Config | null, platform: NodeJS.Platform = process.platform): DeploymentRole {
  const configured = config?.deployment?.role;
  if (configured !== undefined) return configured;
  if (platform === "linux") return "host";
  if (platform === "darwin" && config?.terminal.defaultTarget === "remote") return "client";
  return "local";
}

/** Parse JSON separately so syntax diagnostics can be tested without mutating user state. */
export function parseConfigJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Last successfully loaded config. Sync hot paths that can't await (e.g.
// abbreviateRepo inside window-name building) read it via configCache();
// entry points populate it with their startup loadConfig().
let cachedConfig: Config | null = null;

/** The last loadConfig() result, falling back to defaults if none loaded yet. */
export function configCache(): Config {
  return cachedConfig ?? cloneDefault();
}

export async function loadConfig(): Promise<Config> {
  let text: string;
  try {
    text = await Bun.file(PATHS.config).text();
  } catch {
    return (cachedConfig = cloneDefault());
  }

  let raw: unknown;
  try {
    raw = parseConfigJson(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Invalid JSON:\s*/, "") : String(error);
    throw new Error(`Invalid JSON in ${PATHS.config}: ${detail}`);
  }

  try {
    return (cachedConfig = validateConfig(raw));
  } catch (error) {
    throw new Error(`Invalid Claude0 config at ${PATHS.config}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Add keys the defaults have and the user's file lacks — never overwrite a present
 * value (an explicit "" included). Keeps the materialized file complete (every knob
 * visible) as new keys ship, while `validateConfig` keeps new keys optional so a
 * not-yet-merged file still loads between an upgrade and the next `claude0 setup`.
 * Runs after validation in `ensureUserConfig`, so the input is a valid v1 shape.
 */
function mergeMissingKeys(user: Record<string, unknown>, defaults: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, def] of Object.entries(defaults)) {
    const current = user[key];
    if (current === undefined) {
      user[key] = structuredClone(def);
      changed = true;
    } else if (isObject(current) && isObject(def)) {
      changed = mergeMissingKeys(current, def) || changed;
    }
  }
  return changed;
}

/** Install discoverable defaults/schema; back-fills keys shipped since the user's
 *  file was written, never replacing a present value. */
export async function ensureUserConfig(): Promise<boolean> {
  mkdirSync(PATHS.dir, { recursive: true });
  let created = false;
  if (!(await Bun.file(PATHS.config).exists())) {
    writeAtomic(PATHS.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    created = true;
  }
  const schemaSource = `${import.meta.dir}/../../config/config.schema.json`;
  const schema = await Bun.file(schemaSource).text();
  if (!(await Bun.file(PATHS.configSchema).exists()) || (await Bun.file(PATHS.configSchema).text()) !== schema) {
    writeAtomic(PATHS.configSchema, schema);
  }
  // Validate after the schema is present so editor diagnostics work immediately.
  await loadConfig();
  // Back-fill AFTER validation: an invalid file has already thrown above, untouched.
  // Merged keys come from DEFAULT_CONFIG, so the result stays valid by construction.
  const raw = parseConfigJson(await Bun.file(PATHS.config).text());
  if (isObject(raw) && mergeMissingKeys(raw, DEFAULT_CONFIG)) {
    writeAtomic(PATHS.config, `${JSON.stringify(raw, null, 2)}\n`);
  }
  return created;
}

export async function saveConfig(config: Config): Promise<void> {
  mkdirSync(PATHS.dir, { recursive: true });
  const validated = validateConfig(config);
  writeAtomic(PATHS.config, `${JSON.stringify(validated, null, 2)}\n`);
}
