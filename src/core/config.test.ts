/** Versioned, materialized, single-file user configuration. */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { DEFAULT_CONFIG, PATHS, ensureUserConfig, loadConfig, parseConfigJson, validateConfig } from "./config";

beforeEach(() => {
  rmSync(PATHS.dir, { recursive: true, force: true });
  mkdirSync(PATHS.dir, { recursive: true });
});

test("ensureUserConfig materializes complete defaults and the editor schema", async () => {
  expect(await ensureUserConfig()).toBe(true);
  const config = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(config).toMatchObject({
    $schema: "./config.schema.json",
    schemaVersion: 1,
    repositories: { roots: ["~/dev"], priority: [] },
  });
  expect(readFileSync(PATHS.configSchema, "utf8")).toContain('"schemaVersion"');

  const original = readFileSync(PATHS.config, "utf8");
  expect(await ensureUserConfig()).toBe(false);
  expect(readFileSync(PATHS.config, "utf8")).toBe(original);
});

test("loadConfig rejects a schemaVersion-less file instead of guessing", async () => {
  writeFileSync(PATHS.config, "{}");
  await expect(loadConfig()).rejects.toThrow("schemaVersion must be 1");
});

test("loadConfig leaves a valid v1 file byte-identical", async () => {
  await ensureUserConfig();
  const clean = readFileSync(PATHS.config, "utf8");
  await loadConfig();
  expect(readFileSync(PATHS.config, "utf8")).toBe(clean);
});

test("invalid JSON and unknown keys are rejected instead of silently defaulted", async () => {
  expect(() => parseConfigJson("{nope")).toThrow("Invalid JSON");
  const config: Record<string, unknown> = structuredClone(DEFAULT_CONFIG);
  config.typo = true;
  expect(() => validateConfig(config)).toThrow("unknown key: typo");
});

test("ensureUserConfig materializes newly shipped keys without overwriting explicit values", async () => {
  await ensureUserConfig();
  const config = JSON.parse(readFileSync(PATHS.config, "utf8"));
  // A file written before terminalBundleId shipped, with a user-chosen sibling value.
  delete config.notifications.terminalBundleId;
  config.notifications.native = false;
  writeFileSync(PATHS.config, JSON.stringify(config, null, 2));

  expect(await ensureUserConfig()).toBe(false); // merged, not created
  const merged = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(merged.notifications.terminalBundleId).toBe(DEFAULT_CONFIG.notifications.terminalBundleId);
  expect(merged.notifications.native).toBe(false);

  // An explicit "" is a real value (no -activate) — merge must never replace it.
  merged.notifications.terminalBundleId = "";
  writeFileSync(PATHS.config, JSON.stringify(merged, null, 2));
  await ensureUserConfig();
  const kept = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(kept.notifications.terminalBundleId).toBe("");
});

test("ensureUserConfig leaves an invalid file untouched (throws before the back-fill)", async () => {
  const invalid = JSON.stringify({ statusMonitor: false });
  writeFileSync(PATHS.config, invalid);
  await expect(ensureUserConfig()).rejects.toThrow("unknown key: statusMonitor");
  expect(readFileSync(PATHS.config, "utf8")).toBe(invalid);
});

test("deployment is never back-filled by the missing-key merge — only setup writes it", async () => {
  await ensureUserConfig();
  expect(JSON.parse(readFileSync(PATHS.config, "utf8")).deployment).toBeUndefined();
  // A present role survives the merge untouched.
  const withRole = { ...JSON.parse(readFileSync(PATHS.config, "utf8")), deployment: { role: "host" } };
  writeFileSync(PATHS.config, JSON.stringify(withRole, null, 2));
  await ensureUserConfig();
  expect(JSON.parse(readFileSync(PATHS.config, "utf8")).deployment).toEqual({ role: "host" });
});
