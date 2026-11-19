/**
 * Uploads — written to PATHS.uploads by the bridge (portkey attachments) and by
 * `claude0 receive-image` (Mac clipboard images). An image is bracketed-pasted into a
 * pane as its path; any other file rides in the message text as a `[File: <path>]` ref
 * (shared/message-text.js). The bridge prunes the dir after 24h.
 */

import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { PATHS } from "./config";

// Allow-list of accepted image types → file extension. The filename is always our own
// randomUUID (never the client's) so there's no path-traversal surface.
export const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** Persist one image; returns its absolute path, or null for a type outside the allow-list. Throws on a failed write. */
export async function saveUploadedBytes(bytes: ArrayBuffer | Uint8Array, mime: string): Promise<string | null> {
  const ext = IMAGE_EXT[mime];
  if (!ext) return null;
  const dest = `${PATHS.uploads}/${randomUUID()}.${ext}`;
  await Bun.write(dest, bytes); // Bun.write creates the parent dir
  chmodSync(dest, 0o600); // screenshots carry secrets; keep them to this account
  return dest;
}

/**
 * A client filename made inert but still readable for Claude: no path, and only
 * [A-Za-z0-9._-] — spaces and brackets would break the `[File: …]` ref, and a leading
 * dot or dash would make a hidden file or an option-looking argument.
 */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(-100) || "file";
}

/**
 * Persist one attached file as <uploads>/<uuid>/<safe name>: the uuid dir keeps two
 * same-named files apart while Claude still sees the real name. Throws on a failed write.
 */
export async function saveUploadedFile(bytes: ArrayBuffer | Uint8Array, name: string): Promise<string> {
  const dir = `${PATHS.uploads}/${randomUUID()}`;
  const dest = `${dir}/${safeUploadName(name)}`;
  await Bun.write(dest, bytes); // Bun.write creates the parent dir
  chmodSync(dir, 0o700);
  chmodSync(dest, 0o600); // attachments can carry secrets; keep them to this account
  return dest;
}
