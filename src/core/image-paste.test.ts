/**
 * Image paste (Mac client → host Claude pane): the pbs hotkey mapping, the
 * Service bundle render, and the two pure decisions behind `claude0 paste-image`
 * and `claude0 receive-image` — exercised without a pasteboard or a tmux server.
 */

import "../../test/helpers/home";
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { pbsKeyEquivalent, validateConfig, DEFAULT_CONFIG, PATHS } from "./config";
import {
  decidePaste,
  receiveRefusal,
  renderServiceBundle,
  readServiceTemplates,
  imagePasteManifest,
  pasteImageCommand,
  describeKey,
  IMAGE_MAX_BYTES,
} from "./image-paste";
import { isPng, saveUploadedBytes } from "./uploads";

const templateDir = `${import.meta.dir}/../../config`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("pbsKeyEquivalent renders chords in pbs glyph order, rejects unknown modifiers and multi-char keys", () => {
  expect(pbsKeyEquivalent("cmd+shift+v")).toBe("@$v");
  expect(pbsKeyEquivalent("Shift+Cmd+V")).toBe("@$v"); // order and case normalized
  expect(pbsKeyEquivalent("ctrl+alt+cmd+shift+4")).toBe("@^~$4");
  expect(pbsKeyEquivalent("alt+i")).toBe("~i");
  expect(() => pbsKeyEquivalent("hyper+v")).toThrow('unknown modifier "hyper"');
  expect(() => pbsKeyEquivalent("cmd+enter")).toThrow("single letter or digit");
  expect(() => pbsKeyEquivalent("v")).toThrow("needs at least one modifier");
});

test("terminal.imagePasteKey is validated through the pbs mapping and stays optional", () => {
  const withKey = { ...DEFAULT_CONFIG, terminal: { ...DEFAULT_CONFIG.terminal, imagePasteKey: "cmd+alt+i" } };
  expect(validateConfig(withKey).terminal.imagePasteKey).toBe("cmd+alt+i");
  const { imagePasteKey: _absent, ...terminal } = DEFAULT_CONFIG.terminal;
  expect(validateConfig({ ...DEFAULT_CONFIG, terminal }).terminal.imagePasteKey).toBeUndefined();
  expect(() => validateConfig({ ...DEFAULT_CONFIG, terminal: { ...terminal, imagePasteKey: "meta+v" } })).toThrow("terminal.imagePasteKey: unknown modifier");
  expect(() => validateConfig({ ...DEFAULT_CONFIG, terminal: { ...terminal, imagePasteKey: "" } })).toThrow("non-empty string");
});

test("describeKey title-cases the chord for messages", () => {
  expect(describeKey("cmd+shift+v")).toBe("Cmd+Shift+V");
});

test("the Service bundle renders every token, XML-escaped, and scopes to the terminal app", async () => {
  const templates = await readServiceTemplates(templateDir);
  const rendered = renderServiceBundle(templates, "com.example.term<>&");
  expect(rendered.infoPlist).toContain("<string>claude0 paste-image</string>");
  expect(rendered.infoPlist).toContain("<string>com.example.term&lt;&gt;&amp;</string>");
  expect(rendered.wflow).toContain(`<string>${pasteImageCommand().replace(/"/g, "&quot;")}</string>`);
  expect(rendered.infoPlist + rendered.wflow).not.toContain("{{");
  // Automator only accepts its own structure: the shell action must stay intact.
  expect(rendered.wflow).toContain("<string>/bin/zsh</string>");
  expect(rendered.wflow).toContain("com.apple.Automator.servicesMenu");
});

test("imagePasteManifest resolves paths, chord and terminal app from config with defaults", async () => {
  const templates = await readServiceTemplates(templateDir);
  const install = imagePasteManifest("/Users/x", null, templates);
  expect(install.dir).toBe("/Users/x/Library/Services/claude0 paste-image.workflow");
  expect(install.files.map((f) => f.path)).toEqual([
    "/Users/x/Library/Services/claude0 paste-image.workflow/Contents/Info.plist",
    "/Users/x/Library/Services/claude0 paste-image.workflow/Contents/document.wflow",
  ]);
  expect(install.keyEquivalent).toBe("@$v");
  expect(install.files[0]!.content).toContain("com.mitchellh.ghostty");
  const custom = imagePasteManifest("/Users/x", {
    ...DEFAULT_CONFIG,
    terminal: { ...DEFAULT_CONFIG.terminal, imagePasteKey: "ctrl+alt+p" },
    notifications: { ...DEFAULT_CONFIG.notifications, terminalBundleId: "net.kovidgoyal.kitty" },
  }, templates);
  expect(custom.keyEquivalent).toBe("^~p");
  expect(custom.files[0]!.content).toContain("net.kovidgoyal.kitty");
});

test("decidePaste: host, image, and size gate before a push", () => {
  expect(decidePaste({ remoteHost: null, imageBytes: 10 })).toMatchObject({ action: "notify", message: expect.stringContaining("terminal.remoteHost") });
  expect(decidePaste({ remoteHost: "vm", imageBytes: null })).toEqual({ action: "notify", message: "No image on the clipboard" });
  expect(decidePaste({ remoteHost: "vm", imageBytes: IMAGE_MAX_BYTES + 1 })).toMatchObject({ action: "notify", message: expect.stringContaining("20 MB") });
  expect(decidePaste({ remoteHost: "vm", imageBytes: IMAGE_MAX_BYTES })).toEqual({ action: "push", host: "vm" });
});

test("receiveRefusal: PNG magic, an attached client, a claude pane outside shell mode", () => {
  const pane = { id: "%1", currentCommand: "claude", shellMode: false };
  expect(receiveRefusal({ png: false, pane })).toBe("not a PNG");
  expect(receiveRefusal({ png: true, pane: null })).toBe("no terminal attached");
  expect(receiveRefusal({ png: true, pane: { ...pane, currentCommand: "zsh" } })).toBe("focus a Claude prompt first");
  expect(receiveRefusal({ png: true, pane: { ...pane, shellMode: true } })).toBe("focus a Claude prompt first");
  expect(receiveRefusal({ png: true, pane })).toBeNull();
});

test("uploads: PNG magic check and allow-listed writes under PATHS.uploads", async () => {
  expect(isPng(PNG)).toBe(true);
  expect(isPng(new TextEncoder().encode("GIF89a"))).toBe(false);
  expect(await saveUploadedBytes(PNG, "text/plain")).toBeNull();
  const path = await saveUploadedBytes(PNG, "image/png");
  expect(path).toMatch(new RegExp(`^${PATHS.uploads}/[0-9a-f-]{36}\\.png$`));
  expect(new Uint8Array(readFileSync(path!))).toEqual(PNG);
});
