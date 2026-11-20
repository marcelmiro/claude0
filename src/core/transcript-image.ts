/**
 * Read one image back out of a session's transcript. The transcript payload carries only
 * a byte-free marker with a `ref` ("<record uuid>/<block index>", `toBlock` in
 * core/transcript.ts); Claude Code keeps the image itself base64-inlined in that record.
 */
import { jsonlLines } from "./jsonl-reader";
import { isValidSessionId, resolveTranscriptPaths } from "./last-turn";

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The JSONL fields this reader touches — everything else on the record is ignored. */
interface RawImageRecord {
  uuid?: unknown;
  message?: { content?: unknown };
}
interface RawImageBlock {
  type?: unknown;
  source?: { type?: unknown; data?: unknown; media_type?: unknown };
}

export interface TranscriptImage {
  bytes: Uint8Array<ArrayBuffer>;
  mediaType: string;
}

/** The image block at `ref` in this session's transcript files, or null when absent or not an image. */
export async function readTranscriptImage(
  sessionId: string,
  ref: string,
  projectsDir?: string,
): Promise<TranscriptImage | null> {
  const m = ref.match(/^([A-Za-z0-9-]{1,100})\/(\d{1,3})$/);
  if (!m || !isValidSessionId(sessionId)) return null;
  const uuid = m[1]!;
  const index = Number(m[2]);
  try {
    // Newest file first: an image is most often in the live file.
    for (const path of [...(await resolveTranscriptPaths(sessionId, projectsDir))].reverse()) {
      for await (const line of jsonlLines(path)) {
        if (!line.includes(uuid)) continue; // skip the parse for every other record
        let record: RawImageRecord;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.uuid !== uuid) continue; // a child naming it as parentUuid
        const content = record.message?.content;
        const block: RawImageBlock | undefined = Array.isArray(content) ? content[index] : undefined;
        const src = block?.type === "image" ? block.source : undefined;
        if (src?.type !== "base64" || typeof src.data !== "string" || typeof src.media_type !== "string") return null;
        if (!MEDIA_TYPES.has(src.media_type)) return null;
        return { bytes: new Uint8Array(Buffer.from(src.data, "base64")), mediaType: src.media_type };
      }
    }
  } catch {
    // unreadable file — same as not found
  }
  return null;
}
