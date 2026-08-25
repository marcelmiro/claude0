/**
 * Image uploads — written to PATHS.uploads by the bridge (portkey attachments)
 * and by `claude0 receive-image` (Mac clipboard images), then bracketed-pasted
 * into a pane as a file path. The bridge prunes the dir after 24h.
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
