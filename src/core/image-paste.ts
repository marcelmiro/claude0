/**
 * Image paste from a Mac client into a Claude pane on the remote host: a macOS
 * Service (Automator bundle under ~/Library/Services, hotkey registered with
 * `pbs`) runs `claude0 paste-image`, which ships the pasteboard PNG over ssh to
 * `claude0 receive-image`; the host stores it as an upload and bracketed-pastes
 * the path into the focused Claude pane — the portkey attachment convention.
 * Setup renders the bundle from config/service/ and doctor re-renders to compare,
 * so the two can't diverge. Pure decision functions live here so both commands
 * are testable without a pasteboard or a tmux server.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, pbsKeyEquivalent } from "./config";
import type { Config } from "../types";

export const SERVICE_NAME = "claude0 paste-image";
/** Pasteboard images above this are refused on the Mac before any ssh is made. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/**
 * paste-image's single-run lock: a dir (mkdir is atomic) holding the owner's
 * pid, so a lock whose owner is gone is reclaimed and a slow transfer is never
 * mistaken for a stale one.
 */
export function pasteImageLockDir(home: string): string {
  return `${home}/.config/claude0/paste-image.lock`;
}

/** The pid recorded in a lock dir, when its process is still alive. */
export function lockOwnerAlive(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(`${lockDir}/pid`, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** The ssh remote commands: a non-interactive shell may lack the bun/claude0 dirs. */
const REMOTE_PATH = 'PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"';
export const RECEIVE_COMMAND = `${REMOTE_PATH} claude0 receive-image`;
/** Doctor's reachability probe: exit 0 ⇒ ssh works and claude0 is on the host's PATH. */
export const RECEIVE_PROBE_COMMAND = `${REMOTE_PATH} claude0 --help`;
export const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

export function imagePasteKey(config: Config | null): string {
  return config?.terminal.imagePasteKey ?? DEFAULT_CONFIG.terminal.imagePasteKey;
}

/** The app the Service is scoped to — the same terminal notification clicks raise. */
export function terminalBundleId(config: Config | null): string {
  return config?.notifications.terminalBundleId ?? DEFAULT_CONFIG.notifications.terminalBundleId;
}

/** Human form of the chord for messages: "cmd+shift+v" ⇒ "Cmd+Shift+V". */
export function describeKey(spec: string): string {
  return spec
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}

/** The `pbs` NSServicesStatus key naming an Automator Service's hotkey entry, as `defaults read` prints it. */
export function pbsServiceKey(name: string): string {
  return `(null) - ${name} - runWorkflowAsService`;
}

/** The same key as a `defaults write` argument: parsed as a plist literal, so the quotes are part of the argv. */
export function pbsServiceKeyLiteral(name: string): string {
  return `"${pbsServiceKey(name)}"`;
}

/** The old-style plist value `pbs` stores per Service: enabled everywhere, with the chord. */
export function pbsServiceValue(keyEquivalent: string): string {
  return `{enabled_context_menu=1; enabled_services_menu=1; key_equivalent="${keyEquivalent}";}`;
}

export function serviceBundleDir(home: string): string {
  return `${home}/Library/Services/${SERVICE_NAME}.workflow`;
}

/**
 * Shell line the Service runs. Services get a non-login /bin/zsh, so the PATH
 * that reaches bun (the claude0 shebang) is set inline; the entry is the symlink
 * setup already installs.
 */
export function pasteImageCommand(): string {
  return 'PATH="/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" exec "$HOME/.local/bin/claude0" paste-image';
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export interface ServiceTemplates {
  infoPlist: string;
  wflow: string;
}

/** Render both bundle files from the checked-in Automator templates. */
export function renderServiceBundle(templates: ServiceTemplates, bundleId: string): ServiceTemplates {
  return {
    infoPlist: templates.infoPlist
      .replace("{{SERVICE_NAME}}", xmlEscape(SERVICE_NAME))
      .replace("{{APP_BUNDLE_ID}}", xmlEscape(bundleId)),
    wflow: templates.wflow.replace("{{COMMAND_XML_ESCAPED}}", xmlEscape(pasteImageCommand())),
  };
}

export async function readServiceTemplates(templateDir: string): Promise<ServiceTemplates> {
  return {
    infoPlist: await Bun.file(`${templateDir}/service/Info.plist`).text(),
    wflow: await Bun.file(`${templateDir}/service/document.wflow`).text(),
  };
}

/** Everything setup writes / doctor compares for one machine's config. */
export function imagePasteManifest(home: string, config: Config | null, templates: ServiceTemplates) {
  const bundleId = terminalBundleId(config);
  const key = imagePasteKey(config);
  const dir = serviceBundleDir(home);
  const rendered = renderServiceBundle(templates, bundleId);
  return {
    key,
    keyEquivalent: pbsKeyEquivalent(key),
    dir,
    files: [
      { path: `${dir}/Contents/Info.plist`, content: rendered.infoPlist },
      { path: `${dir}/Contents/document.wflow`, content: rendered.wflow },
    ],
  };
}

// --- claude0 paste-image (client) ---

export interface PasteFacts {
  remoteHost: string | null;
  /** null ⇒ nothing image-like on the pasteboard */
  imageBytes: number | null;
}

export type PasteDecision =
  | { action: "notify"; message: string }
  | { action: "push"; host: string };

export function decidePaste(facts: PasteFacts): PasteDecision {
  if (!facts.remoteHost) return { action: "notify", message: "Set terminal.remoteHost, then run claude0 setup" };
  if (facts.imageBytes === null) return { action: "notify", message: "No image on the clipboard" };
  if (facts.imageBytes > IMAGE_MAX_BYTES) {
    return { action: "notify", message: `Image is ${(facts.imageBytes / 1024 / 1024).toFixed(1)} MB — the limit is ${IMAGE_MAX_BYTES / 1024 / 1024} MB` };
  }
  return { action: "push", host: facts.remoteHost };
}

// --- claude0 receive-image (host) ---

/** The pane the attached client is looking at, as `receive-image` probes it. */
export interface FocusedPane {
  id: string;
  currentCommand: string;
  shellMode: boolean;
}

export interface ReceiveFacts {
  png: boolean;
  /** null when no client is attached */
  pane: FocusedPane | null;
}

/** Reason the paste is refused (exit 2 on the host, notification on the Mac), or null to proceed. */
export function receiveRefusal(facts: ReceiveFacts): string | null {
  if (!facts.png) return "not a PNG";
  if (!facts.pane) return "no terminal attached";
  // A `!` shell prompt would execute the pasted path as bash; a non-claude pane would type it.
  if (facts.pane.currentCommand !== "claude" || facts.pane.shellMode) return "focus a Claude prompt first";
  return null;
}
